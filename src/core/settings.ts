export type Quality = 'low' | 'medium' | 'high' | 'ultra';

export interface Settings {
  playerName: string;
  sensitivity: number;
  adsSensitivity: number;
  fov: number;
  invertY: boolean;
  masterVolume: number;
  quality: Quality;
  renderScale: number;
  showFps: boolean;
  crosshairColor: string;
  crosshairGap: number;
  crosshairDynamic: boolean;
  adsToggle: boolean;
  iceServers: string;
}

const KEY = 'dusk-protocol-settings-v1';

const DEFAULTS: Settings = {
  playerName: '',
  sensitivity: 1,
  adsSensitivity: 0.85,
  fov: 103,
  invertY: false,
  masterVolume: 0.75,
  quality: 'high',
  renderScale: 1,
  showFps: true,
  crosshairColor: '#7dffb6',
  crosshairGap: 4,
  crosshairDynamic: true,
  adsToggle: false,
  iceServers: '',
};

type Listener = (s: Settings) => void;

class SettingsStore {
  private data: Settings;
  private listeners = new Set<Listener>();

  constructor() {
    this.data = { ...DEFAULTS };
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) Object.assign(this.data, JSON.parse(raw) as Partial<Settings>);
    } catch {
      // Storage may be unavailable (private mode); defaults are fine.
    }
    if (!this.data.playerName) this.data.playerName = `Operator${Math.floor(100 + Math.random() * 900)}`;
  }

  get value(): Readonly<Settings> {
    return this.data;
  }

  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    this.data[key] = value;
    this.persist();
    this.listeners.forEach((l) => l(this.data));
  }

  onChange(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  reset(): void {
    const name = this.data.playerName;
    this.data = { ...DEFAULTS, playerName: name };
    this.persist();
    this.listeners.forEach((l) => l(this.data));
  }

  private persist(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      // ignore
    }
  }
}

export const settings = new SettingsStore();

/** Parses the optional custom ICE server list (one URL per line, `turn:` lines may use `url|user|pass`). */
export function customIceServers(): RTCIceServer[] {
  const out: RTCIceServer[] = [];
  for (const line of settings.value.iceServers.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const [urls, username, credential] = t.split('|');
    out.push(username ? { urls, username, credential } : { urls });
  }
  return out;
}
