import { Hud } from './hud';
import { DraftView } from './draft';
import { ShopView } from './shop';
import { ChatBox, LoadingScreen, Modal, PauseMenu, ResultsView, Scoreboard } from './screens';
import { MainMenu, controlsPanel, settingsPanel, type MenuActions } from './menu';
import { LobbyView, type LobbyActions } from './lobby';
import type { AudioEngine } from '../audio/audio';

export interface UIActions {
  menu: MenuActions;
  lobby: LobbyActions;
  draftPick(i: number): void;
  buy(item: string): void;
  closeShop(): void;
  sendChat(text: string): void;
  chatClosed(): void;
  resume(): void;
  leave(): void;
  endMatch(): void;
}

/** Owns every DOM screen. Game code talks to these views directly. */
export class UI {
  readonly root: HTMLElement;
  readonly loading: LoadingScreen;
  readonly modal: Modal;
  readonly menu: MainMenu;
  readonly lobby: LobbyView;
  readonly hud: Hud;
  readonly draft: DraftView;
  readonly shop: ShopView;
  readonly scoreboard: Scoreboard;
  readonly results: ResultsView;
  readonly pause: PauseMenu;
  readonly chat: ChatBox;
  readonly clickPrompt: HTMLElement;

  constructor(root: HTMLElement, audio: AudioEngine, actions: UIActions) {
    this.root = root;
    this.hud = new Hud(root);
    this.chat = new ChatBox(root, (t) => actions.sendChat(t), () => actions.chatClosed());
    this.draft = new DraftView(root, audio, (i) => actions.draftPick(i));
    this.shop = new ShopView(root, audio, (item) => actions.buy(item), () => actions.closeShop());
    this.scoreboard = new Scoreboard(root);
    this.results = new ResultsView(root);
    this.lobby = new LobbyView(root, audio, actions.lobby);
    this.modal = new Modal(root);
    this.menu = new MainMenu(root, this.modal, audio, actions.menu);
    this.pause = new PauseMenu(
      root,
      () => actions.resume(),
      () => this.modal.open('설정', settingsPanel(audio)),
      () => this.modal.open('조작법', controlsPanel()),
      () => actions.leave(),
      () => actions.endMatch(),
    );
    this.clickPrompt = document.createElement('div');
    this.clickPrompt.id = 'click-prompt';
    this.clickPrompt.className = 'hidden';
    this.clickPrompt.innerHTML = '<div class="cp-inner"><div class="cp-mouse"></div><b>클릭하여 전투 참가</b><span>ESC로 일시정지</span></div>';
    root.append(this.clickPrompt);
    this.loading = new LoadingScreen(root);
  }

  /** True while any overlay needs the mouse cursor. */
  get needsCursor(): boolean {
    return this.modal.visible || this.pause.visible || this.draft.visible || this.shop.open || this.chat.open || !this.lobby.root.classList.contains('hidden') || !this.menu.root.classList.contains('hidden') || !this.results.root.classList.contains('hidden');
  }
}
