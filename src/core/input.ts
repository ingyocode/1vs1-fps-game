export type Action =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'jump'
  | 'crouch'
  | 'walk'
  | 'reload'
  | 'ability1'
  | 'ability2'
  | 'ability3'
  | 'primary'
  | 'secondary'
  | 'melee'
  | 'lastWeapon'
  | 'shop'
  | 'scoreboard'
  | 'chat'
  | 'inspect';

export const BINDINGS: Record<Action, string[]> = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  // Ctrl is deliberately not bound: Ctrl+W would close the browser tab.
  crouch: ['KeyC'],
  walk: ['ShiftLeft', 'ShiftRight'],
  reload: ['KeyR'],
  ability1: ['KeyQ'],
  ability2: ['KeyE'],
  ability3: ['KeyF'],
  primary: ['Digit1'],
  secondary: ['Digit2'],
  melee: ['Digit3'],
  lastWeapon: ['KeyX'],
  shop: ['KeyB'],
  scoreboard: ['Tab'],
  chat: ['Enter'],
  inspect: ['KeyY'],
};

export const KEY_LABEL: Record<string, string> = {
  KeyW: 'W',
  KeyA: 'A',
  KeyS: 'S',
  KeyD: 'D',
  Space: 'SPACE',
  KeyC: 'C',
  ControlLeft: 'CTRL',
  ShiftLeft: 'SHIFT',
  KeyR: 'R',
  KeyQ: 'Q',
  KeyE: 'E',
  KeyF: 'F',
  Digit1: '1',
  Digit2: '2',
  Digit3: '3',
  KeyX: 'X',
  KeyB: 'B',
  Tab: 'TAB',
  Enter: 'ENTER',
  KeyY: 'Y',
};

/**
 * Browser function keys that reload the page or move focus out of it while playing
 * (F1 help, F3 find, F5 reload, F6 address bar, F7 caret-browsing prompt, F10 menu).
 */
const BROWSER_KEYS = new Set(['F1', 'F3', 'F5', 'F6', 'F7', 'F10', 'ContextMenu']);

/**
 * Centralised keyboard/mouse state with per-frame edge detection.
 * Game code reads it once per frame and calls endFrame() afterwards.
 */
export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();
  private released = new Set<string>();
  private mouseDown = [false, false, false];
  private mousePressed = [false, false, false];
  private mouseReleased = [false, false, false];
  private dx = 0;
  private dy = 0;
  private wheel = 0;
  /** When false all gameplay input is suppressed (menus, chat). */
  enabled = true;
  locked = false;
  private lockListeners = new Set<(locked: boolean) => void>();

  constructor(private readonly target: HTMLElement) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('wheel', this.onWheel, { passive: true });
    window.addEventListener('blur', this.clear);
    window.addEventListener('contextmenu', (e) => {
      if (this.locked) e.preventDefault();
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.target;
      if (!this.locked) this.clear();
      this.lockListeners.forEach((l) => l(this.locked));
    });
  }

  onLockChange(l: (locked: boolean) => void): () => void {
    this.lockListeners.add(l);
    return () => this.lockListeners.delete(l);
  }

  requestLock(): void {
    if (this.locked) return;
    const el = this.target as HTMLElement & { requestPointerLock(opts?: { unadjustedMovement?: boolean }): Promise<void> | void };
    try {
      // Raw mouse input (no OS acceleration) where supported.
      const r = el.requestPointerLock({ unadjustedMovement: true });
      if (r && typeof (r as Promise<void>).catch === 'function') {
        (r as Promise<void>).catch(() => {
          try {
            const r2 = el.requestPointerLock();
            if (r2 && typeof (r2 as Promise<void>).catch === 'function') (r2 as Promise<void>).catch(() => undefined);
          } catch {
            // ignore
          }
        });
      }
    } catch {
      // ignore — the user can click again
    }
  }

  exitLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  private isTyping(e: Event): boolean {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.isTyping(e)) return;
    if (e.code === 'Tab' || (this.locked && (e.code === 'Space' || e.code.startsWith('Arrow')))) e.preventDefault();
    // While playing, browser shortcuts must not fire: Ctrl/⌘+R reloads the page (a crouch-on-Ctrl
    // habit plus R to reload), Ctrl/⌘+D/F/S/E/L and Alt open UI that takes focus, which drops
    // pointer lock mid-fight. Ctrl/⌘+W/T/N/Q cannot be cancelled; the unload guard covers those.
    if (this.locked && (e.ctrlKey || e.metaKey || e.altKey || BROWSER_KEYS.has(e.code))) e.preventDefault();
    if (!this.down.has(e.code)) this.pressed.add(e.code);
    this.down.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    // A lone Alt release focuses the browser menu on Windows.
    if (this.locked && (e.code === 'AltLeft' || e.code === 'AltRight' || e.code === 'F10')) e.preventDefault();
    this.down.delete(e.code);
    this.released.add(e.code);
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (e.button > 2) return;
    if (!this.locked) return;
    this.mouseDown[e.button] = true;
    this.mousePressed[e.button] = true;
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button > 2) return;
    this.mouseDown[e.button] = false;
    this.mouseReleased[e.button] = true;
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.locked) return;
    // Guard against the occasional huge spike some browsers emit when locking.
    if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
    this.dx += e.movementX;
    this.dy += e.movementY;
  };

  private onWheel = (e: WheelEvent): void => {
    if (!this.locked) return;
    this.wheel += Math.sign(e.deltaY);
  };

  private clear = (): void => {
    this.down.clear();
    this.mouseDown = [false, false, false];
  };

  isDown(a: Action): boolean {
    if (!this.enabled) return false;
    return BINDINGS[a].some((c) => this.down.has(c));
  }

  wasPressed(a: Action): boolean {
    if (!this.enabled) return false;
    return BINDINGS[a].some((c) => this.pressed.has(c));
  }

  wasReleased(a: Action): boolean {
    return BINDINGS[a].some((c) => this.released.has(c));
  }

  /** Raw key press check that ignores the enabled flag (for UI hotkeys). */
  keyPressed(code: string): boolean {
    return this.pressed.has(code);
  }

  mouse(button: 0 | 1 | 2): boolean {
    return this.enabled && this.locked && this.mouseDown[button];
  }

  mouseWasPressed(button: 0 | 1 | 2): boolean {
    return this.enabled && this.locked && this.mousePressed[button];
  }

  consumeMouseDelta(): { x: number; y: number } {
    const r = { x: this.dx, y: this.dy };
    this.dx = 0;
    this.dy = 0;
    if (!this.enabled) return { x: 0, y: 0 };
    return r;
  }

  consumeWheel(): number {
    const w = this.wheel;
    this.wheel = 0;
    return this.enabled ? w : 0;
  }

  endFrame(): void {
    this.pressed.clear();
    this.released.clear();
    this.mousePressed = [false, false, false];
    this.mouseReleased = [false, false, false];
  }
}
