import type { TeamId, HitZone } from '../core/config';
import type { WeaponId } from '../game/weapons';
import type { AbilityId, DraftCard, OwnedAbility, ThrowKind, Tier } from '../game/abilities';

export const PROTOCOL_VERSION = 3;

export type V3 = [number, number, number];
export type Phase = 'lobby' | 'draft' | 'buy' | 'live' | 'roundEnd' | 'matchEnd';

export interface MatchSettings {
  mode: '1v1' | '2v2';
  firstTo: number;
  botFill: boolean;
  botSkill: 0 | 1 | 2;
}

export interface LobbyPlayer {
  id: string;
  name: string;
  team: TeamId;
  bot: boolean;
}

/** Public, host-authoritative player record (scoreboard + HUD). */
export interface PlayerInfo {
  id: string;
  name: string;
  team: TeamId;
  bot: boolean;
  hp: number;
  armor: number;
  alive: boolean;
  gold: number;
  kills: number;
  deaths: number;
  assists: number;
  damage: number;
  primary: WeaponId | null;
  secondary: WeaponId;
  abilities: OwnedAbility[];
  ping: number;
  connected: boolean;
}

export interface CoinInfo {
  id: number;
  pos: V3;
  value: number;
  big: boolean;
}

export interface ShotHit {
  /** End point of the trace. */
  p: V3;
  /** Surface normal (world hits only). */
  n?: V3;
  /** 0 = world, 1 = player, 2 = nothing (max range), 3 = barrier */
  k: 0 | 1 | 2 | 3;
}

/** Bit flags packed into the state snapshot. */
export const F = {
  crouch: 1,
  ads: 2,
  walk: 4,
  ground: 8,
  cloak: 16,
  adrenaline: 32,
  infinite: 64,
  reload: 128,
  alive: 256,
  fired: 512,
  dash: 1024,
  throwing: 2048,
} as const;

export const WEAPON_INDEX: WeaponId[] = ['knife', 'pistol', 'magnum', 'smg', 'shotgun', 'rifle', 'sniper'];

/** [id, x, y, z, yaw, pitch, flags, weaponIndex] */
export type SnapEntry = [string, number, number, number, number, number, number, number];

export interface ThrowMsg {
  t: 'throw';
  gid: string;
  kind: ThrowKind;
  owner: string;
  team: TeamId;
  pos: V3;
  vel: V3;
  tier: Tier;
  syn: string[];
  /** Cluster bomblet: spawned locally by every simulation on detonation, never sent. */
  sub?: boolean;
}

export interface BarrierMsg {
  t: 'barrier';
  bid: string;
  owner: string;
  team: TeamId;
  pos: V3;
  yaw: number;
  width: number;
  hp: number;
  duration: number;
  regen: boolean;
}

// -----------------------------------------------------------------------------
// Host → clients
// -----------------------------------------------------------------------------
export type HostMsg =
  | { t: 'welcome'; you: string; code: string; version: number }
  | { t: 'reject'; reason: string }
  | { t: 'lobby'; players: LobbyPlayer[]; settings: MatchSettings; hostId: string }
  | { t: 'phase'; phase: Phase; round: number; endsAt: number; scores: [number, number] }
  | { t: 'players'; list: PlayerInfo[] }
  | { t: 'snap'; ht: number; s: SnapEntry[] }
  /** `bonus`: an extra card earned by losing rounds, drafted during the buy phase. */
  | { t: 'draftOffer'; pick: number; total: number; cards: DraftCard[]; endsAt: number; bonus?: boolean }
  | { t: 'draftWait'; bonus?: boolean }
  | { t: 'roundStart'; round: number; spawns: { id: string; pos: V3; yaw: number }[] }
  /** Shooting range: one player (or target) comes back mid-round. */
  | { t: 'respawn'; id: string; pos: V3; yaw: number }
  | { t: 'coins'; list: CoinInfo[] }
  | { t: 'coinTaken'; id: number; by: string; value: number }
  | { t: 'fire'; id: string; w: WeaponId; o: V3; hits: ShotHit[] }
  | { t: 'dmg'; target: string; attacker: string; amount: number; hp: number; armor: number; zone: HitZone | 'blast' | 'toxic' | 'shock'; from: V3; w: WeaponId | AbilityId }
  | { t: 'kill'; killer: string; victim: string; w: WeaponId | AbilityId; head: boolean; assister: string | null }
  | { t: 'heal'; target: string; hp: number; armor: number }
  | ThrowMsg
  | { t: 'ability'; id: string; ability: AbilityId; data?: number[] }
  | BarrierMsg
  | { t: 'barrierHp'; bid: string; hp: number }
  | { t: 'barrierGone'; bid: string }
  | { t: 'reveal'; team: TeamId; targets: string[]; duration: number; origin?: V3; kind: 'pulse' | 'mark'; vuln?: boolean }
  | { t: 'debuff'; target: string; kind: 'slow' | 'vuln'; duration: number }
  | { t: 'gold'; amount: number; reason: string }
  | { t: 'roundEnd'; winner: TeamId | -1; reason: 'elimination' | 'time' | 'forfeit'; scores: [number, number]; mvp: string | null }
  | { t: 'matchEnd'; winner: TeamId; scores: [number, number] }
  | { t: 'chat'; from: string; name: string; text: string; system?: boolean }
  | { t: 'pong'; c: number; h: number }
  | { t: 'buyResult'; ok: boolean; msg: string };

// -----------------------------------------------------------------------------
// Clients → host
// -----------------------------------------------------------------------------
export type ClientMsg =
  | { t: 'hello'; name: string; version: number }
  | { t: 'setTeam'; team: TeamId }
  | { t: 'st'; q: number; p: V3; yaw: number; pitch: number; f: number; w: number }
  | { t: 'fire'; w: WeaponId; o: V3; hits: ShotHit[] }
  | { t: 'hit'; target: string; dmg: number; zone: HitZone; w: WeaponId; dist: number }
  | { t: 'draftPick'; index: number }
  | { t: 'buy'; item: string }
  | { t: 'coin'; id: number }
  | ThrowMsg
  | { t: 'ability'; ability: AbilityId; data?: number[] }
  | BarrierMsg
  | { t: 'barrierDmg'; bid: string; dmg: number }
  | { t: 'reveal'; targets: string[]; duration: number; origin?: V3; kind: 'pulse' | 'mark' }
  | { t: 'flashed'; by: string; duration: number }
  | { t: 'chat'; text: string }
  | { t: 'ping'; c: number; rtt: number }
  | { t: 'settings'; settings: MatchSettings }
  | { t: 'start' }
  | { t: 'toLobby' }
  | { t: 'kickBot'; id: string }
  | { t: 'addBot'; team: TeamId };

export const v3 = (v: { x: number; y: number; z: number }): V3 => [Math.round(v.x * 1000) / 1000, Math.round(v.y * 1000) / 1000, Math.round(v.z * 1000) / 1000];
