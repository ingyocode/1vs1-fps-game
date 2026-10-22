import Peer, { type DataConnection } from 'peerjs';
import { NET, makeRoomCode } from '../core/config';
import { customIceServers } from '../core/settings';
import type { ClientMsg, HostMsg } from './protocol';

/**
 * Serverless star topology over WebRTC data channels.
 *
 * - Signalling uses the free public PeerJS broker (no server of our own, no cost).
 *   After the handshake all traffic is peer-to-peer.
 * - The host is one of the players. Every client opens two channels to it:
 *   'rel' (reliable, ordered) for game events and 'fast' (unordered) for
 *   high-frequency state. The host relays/aggregates for everyone.
 * - The host's own client talks to the host logic through an in-memory loopback,
 *   so game code is identical on every machine.
 */

const KEEPALIVE = 'ka';
/**
 * Silence that counts as a dead peer. Closed tabs and broken links are reported much sooner by
 * the data channel / ICE events; this only catches peers that went quiet, and a busy main thread
 * (first-time shader compiles, a slow frame) must not be mistaken for that. It was 12 s.
 */
const PEER_TIMEOUT_MS = 30000;

type Inbox =
  | { kind: 'toHost'; from: string; msg: ClientMsg }
  | { kind: 'toClient'; msg: HostMsg }
  | { kind: 'left'; id: string }
  | { kind: 'joined'; id: string; name: string };

interface Remote {
  id: string;
  name: string;
  rel: DataConnection | null;
  fast: DataConnection | null;
  ready: boolean;
}

export interface NetHandlers {
  toHost(from: string, msg: ClientMsg): void;
  toClient(msg: HostMsg): void;
  peerJoined(id: string, name: string): void;
  peerLeft(id: string): void;
}

function iceConfig(): RTCConfiguration {
  return {
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
      { urls: 'stun:stun.cloudflare.com:3478' },
      ...customIceServers(),
    ],
  };
}

export class Net {
  private inbox: Inbox[] = [];
  private remotes = new Map<string, Remote>();
  private hostRel: DataConnection | null = null;
  private hostFast: DataConnection | null = null;
  private closed = false;
  /** Last time anything arrived from each peer ('host' on clients). */
  private lastRecv = new Map<string, number>();
  private hostLost = false;
  /** Why the host connection ended (client side), shown on the menu. */
  lostReason = '';
  handlers: NetHandlers | null = null;
  /** Bytes sent in the last second (debug overlay). */
  stats = { sent: 0, recv: 0 };

  private constructor(
    readonly isHost: boolean,
    readonly selfId: string,
    readonly code: string,
    private readonly peer: Peer | null,
  ) {}

  static offline(): Net {
    return new Net(true, 'local-host', 'OFFLINE', null);
  }

  static createHost(onStatus: (s: string) => void): Promise<Net> {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const tryCreate = (): void => {
        attempts++;
        const code = makeRoomCode();
        onStatus('시그널링 서버에 연결 중…');
        const peer = new Peer(NET.peerPrefix + code, { config: iceConfig(), debug: 1 });
        let settled = false;
        const timer = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          peer.destroy();
          reject(new Error('시그널링 서버 응답이 없습니다. 네트워크를 확인하세요.'));
        }, 15000);
        peer.on('open', (id) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          const net = new Net(true, id, code, peer);
          net.listenAsHost();
          resolve(net);
        });
        peer.on('error', (err: Error & { type?: string }) => {
          if (settled) {
            console.warn('[net]', err.type, err.message);
            return;
          }
          if (err.type === 'unavailable-id' && attempts < 5) {
            settled = true;
            window.clearTimeout(timer);
            peer.destroy();
            tryCreate();
            return;
          }
          settled = true;
          window.clearTimeout(timer);
          peer.destroy();
          reject(new Error(`방 생성 실패: ${err.type ?? err.message}`));
        });
      };
      tryCreate();
    });
  }

  static join(rawCode: string, name: string, onStatus: (s: string) => void): Promise<Net> {
    const code = rawCode.trim().toUpperCase();
    return new Promise((resolve, reject) => {
      onStatus('시그널링 서버에 연결 중…');
      const peer = new Peer({ config: iceConfig(), debug: 1 });
      let settled = false;
      const fail = (msg: string): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        peer.destroy();
        reject(new Error(msg));
      };
      const timer = window.setTimeout(() => fail('호스트와 연결하지 못했습니다 (시간 초과). 방 코드를 확인하거나 다른 네트워크에서 시도하세요.'), 20000);
      peer.on('error', (err: Error & { type?: string }) => {
        if (err.type === 'peer-unavailable') fail(`방 ${code}을(를) 찾을 수 없습니다.`);
        else if (!settled) fail(`연결 오류: ${err.type ?? err.message}`);
        else console.warn('[net]', err.type, err.message);
      });
      peer.on('open', (id) => {
        onStatus(`방 ${code}에 P2P 연결 중…`);
        const hostId = NET.peerPrefix + code;
        const net = new Net(false, id, code, peer);
        const rel = peer.connect(hostId, { label: 'rel', reliable: true, serialization: 'json', metadata: { name } });
        const fast = peer.connect(hostId, { label: 'fast', reliable: false, serialization: 'json', metadata: { name } });
        let open = 0;
        const onOpen = (): void => {
          open++;
          if (open === 2 && !settled) {
            settled = true;
            window.clearTimeout(timer);
            net.hostRel = rel;
            net.hostFast = fast;
            net.listenAsClient();
            resolve(net);
          }
        };
        rel.on('open', onOpen);
        fast.on('open', onOpen);
        rel.on('error', (e) => fail(`데이터 채널 오류: ${e.message}`));
      });
    });
  }

  private listenAsHost(): void {
    const peer = this.peer!;
    peer.on('connection', (conn) => {
      const meta = (conn.metadata ?? {}) as { name?: string };
      let r = this.remotes.get(conn.peer);
      if (!r) {
        r = { id: conn.peer, name: String(meta.name ?? 'Player').slice(0, 16), rel: null, fast: null, ready: false };
        this.remotes.set(conn.peer, r);
      }
      const remote = r;
      const fast = conn.label === 'fast';
      conn.on('open', () => {
        if (fast) remote.fast = conn;
        else remote.rel = conn;
        if (remote.rel && remote.fast && !remote.ready) {
          remote.ready = true;
          this.lastRecv.set(remote.id, performance.now());
          this.inbox.push({ kind: 'joined', id: remote.id, name: remote.name });
        }
        // ICE failures do not always close the DataConnection; watch the peer connection too.
        const pc = conn.peerConnection;
        pc?.addEventListener('iceconnectionstatechange', () => {
          if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed') lost(`ICE ${pc.iceConnectionState}`);
        });
      });
      conn.on('data', (data) => {
        this.stats.recv++;
        this.lastRecv.set(conn.peer, performance.now());
        if ((data as { t?: string }).t === KEEPALIVE) return;
        this.inbox.push({ kind: 'toHost', from: conn.peer, msg: data as ClientMsg });
      });
      const drop = (reason: string): void => {
        if (!this.remotes.has(conn.peer)) return;
        console.warn('[net] dropping peer', conn.peer, reason);
        this.remotes.delete(conn.peer);
        try {
          remote.rel?.close();
          remote.fast?.close();
        } catch {
          // ignore
        }
        if (remote.ready) this.inbox.push({ kind: 'left', id: conn.peer });
      };
      // PeerJS gives every DataConnection its own RTCPeerConnection, so the state channel can
      // fail on its own. Only the reliable channel ends a player's session; losing 'fast'
      // just moves state/snapshot traffic onto 'rel'.
      const lost = (reason: string): void => {
        if (!fast) drop(`rel: ${reason}`);
        else if (remote.fast === conn) {
          console.warn('[net] state channel lost, falling back to reliable channel', conn.peer, reason);
          remote.fast = null;
        }
      };
      conn.on('close', () => lost('closed'));
      // Fatal errors (ICE failed/closed) are followed by 'close'; others (oversized or early
      // messages) only drop that one message and must not end the session.
      conn.on('error', (err) => console.warn('[net]', conn.label, err.type, err.message));
    });
    peer.on('disconnected', () => {
      // Lost the signalling server only — existing P2P links keep working. Try to stay reachable.
      if (!this.closed) {
        try {
          peer.reconnect();
        } catch {
          // ignore
        }
      }
    });
  }

  private listenAsClient(): void {
    this.lastRecv.set('host', performance.now());
    for (const c of [this.hostRel!, this.hostFast!]) {
      c.on('data', (data) => {
        this.stats.recv++;
        this.lastRecv.set('host', performance.now());
        if ((data as { t?: string }).t === KEEPALIVE) return;
        this.inbox.push({ kind: 'toClient', msg: data as HostMsg });
      });
      c.on('error', (err) => console.warn('[net]', c.label, err.type, err.message));
    }
    // Only the reliable channel is the session's lifeline (see listenAsHost); a dead state
    // channel falls back to it in toHost().
    this.hostRel!.on('close', () => this.loseHost('신뢰 채널이 닫힘'));
    this.hostFast!.on('close', () => console.warn('[net] state channel closed, using the reliable channel'));
    const pc = this.hostRel!.peerConnection;
    if (pc) {
      pc.addEventListener('iceconnectionstatechange', () => {
        if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed') this.loseHost(`ICE ${pc.iceConnectionState}`);
      });
    }
  }

  private loseHost(reason: string): void {
    if (this.hostLost) return;
    this.hostLost = true;
    this.lostReason = reason;
    console.warn('[net] lost host:', reason);
    this.inbox.push({ kind: 'left', id: 'host' });
  }

  /**
   * Called once per second from a timer (keeps running in background tabs):
   * sends keep-alives and drops peers that went silent (closed tab, lost network).
   */
  keepAlive(): void {
    if (this.closed || !this.peer) return;
    const now = performance.now();
    const ka = { t: KEEPALIVE };
    if (this.isHost) {
      for (const r of [...this.remotes.values()]) {
        if (!r.ready) continue;
        if (r.rel?.open) void r.rel.send(ka);
        if (now - (this.lastRecv.get(r.id) ?? now) > PEER_TIMEOUT_MS) {
          console.warn('[net] dropping peer', r.id, `no data for ${PEER_TIMEOUT_MS / 1000}s`);
          this.remotes.delete(r.id);
          try {
            r.rel?.close();
            r.fast?.close();
          } catch {
            // ignore
          }
          this.inbox.push({ kind: 'left', id: r.id });
        }
      }
    } else {
      if (this.hostRel?.open) void this.hostRel.send(ka);
      if (now - (this.lastRecv.get('host') ?? now) > PEER_TIMEOUT_MS) this.loseHost(`${PEER_TIMEOUT_MS / 1000}초 동안 응답 없음`);
    }
  }

  get peerCount(): number {
    return this.remotes.size;
  }

  /** Client → host. On the host this is a loopback. */
  toHost(msg: ClientMsg, fast = false): void {
    if (this.closed) return;
    if (this.isHost) {
      this.inbox.push({ kind: 'toHost', from: this.selfId, msg });
      return;
    }
    const c = fast && this.hostFast?.open ? this.hostFast : this.hostRel;
    if (c?.open) {
      this.stats.sent++;
      void c.send(msg);
    }
  }

  /** Host → every client (including the local one unless excluded). */
  broadcast(msg: HostMsg, fast = false, except?: string): void {
    if (this.closed || !this.isHost) return;
    for (const r of this.remotes.values()) {
      if (!r.ready || r.id === except) continue;
      const c = fast && r.fast?.open ? r.fast : r.rel;
      if (c?.open) {
        this.stats.sent++;
        void c.send(msg);
      }
    }
    if (except !== this.selfId) this.inbox.push({ kind: 'toClient', msg });
  }

  /** Host → one client. */
  sendTo(id: string, msg: HostMsg, fast = false): void {
    if (this.closed || !this.isHost) return;
    if (id === this.selfId) {
      this.inbox.push({ kind: 'toClient', msg });
      return;
    }
    const r = this.remotes.get(id);
    const c = fast && r?.fast?.open ? r.fast : r?.rel;
    if (c?.open) {
      this.stats.sent++;
      void c.send(msg);
    }
  }

  kick(id: string): void {
    const r = this.remotes.get(id);
    if (!r) return;
    this.remotes.delete(id);
    try {
      r.rel?.close();
      r.fast?.close();
    } catch {
      // ignore
    }
  }

  /** Dispatches queued messages. Called once per frame from the game loop. */
  poll(): void {
    const h = this.handlers;
    if (!h) return;
    // Messages enqueued while dispatching are handled next frame to keep ordering sane.
    const batch = this.inbox;
    this.inbox = [];
    for (const m of batch) {
      if (this.closed) return;
      switch (m.kind) {
        case 'toHost':
          if (this.isHost) h.toHost(m.from, m.msg);
          break;
        case 'toClient':
          h.toClient(m.msg);
          break;
        case 'joined':
          h.peerJoined(m.id, m.name);
          break;
        case 'left':
          h.peerLeft(m.id);
          break;
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.inbox = [];
    for (const r of this.remotes.values()) {
      try {
        r.rel?.close();
        r.fast?.close();
      } catch {
        // ignore
      }
    }
    this.remotes.clear();
    try {
      this.hostRel?.close();
      this.hostFast?.close();
    } catch {
      // ignore
    }
    this.peer?.destroy();
  }
}
