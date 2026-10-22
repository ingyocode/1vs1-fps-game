import type { AbilityId } from '../game/abilities';
import type { WeaponId } from '../game/weapons';

const stroke = (inner: string, vb = '0 0 24 24'): string =>
  `<svg viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

export const ABILITY_ICONS: Record<AbilityId, string> = {
  flash: stroke(
    '<circle cx="12" cy="12" r="3.2" fill="currentColor"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4M5.3 5.3l2.8 2.8M15.9 15.9l2.8 2.8M18.7 5.3l-2.8 2.8M8.1 15.9l-2.8 2.8"/>',
  ),
  smoke: stroke('<path d="M6.5 18.5a4 4 0 0 1-.6-7.96A5.5 5.5 0 0 1 16.6 8.6a4.2 4.2 0 0 1 1.2 8.2"/><path d="M8 15.5h8M6.5 18.5h11"/><path d="M10 12.2c.8-.9 2.2-.9 3 0"/>'),
  infinite: stroke('<path d="M6.2 15.6a3.6 3.6 0 1 1 0-7.2c3.1 0 8.5 7.2 11.6 7.2a3.6 3.6 0 1 0 0-7.2c-3.1 0-8.5 7.2-11.6 7.2z"/>'),
  dash: stroke('<path d="M4 7h7M2.5 12h9M4 17h7"/><path d="M13 5.5 19.5 12 13 18.5"/>'),
  heal: stroke('<path d="M12 21s-7.5-4.4-7.5-10.2A4.3 4.3 0 0 1 12 8a4.3 4.3 0 0 1 7.5 2.8C19.5 16.6 12 21 12 21z"/><path d="M12 11v5M9.5 13.5h5"/>'),
  recon: stroke('<circle cx="12" cy="12" r="2"/><path d="M12 4.5a7.5 7.5 0 0 1 7.5 7.5M12 8a4 4 0 0 1 4 4"/><circle cx="12" cy="12" r="9.5" stroke-dasharray="2.5 2.5"/>'),
  barrier: stroke('<path d="M12 2.8 19.5 5.6v5.6c0 4.6-3.2 8.3-7.5 9.9-4.3-1.6-7.5-5.3-7.5-9.9V5.6z"/><path d="M8.5 11.2h7M8.5 14.6h7M12 7.8v10"/>'),
  frag: stroke('<circle cx="12" cy="14" r="6.2"/><path d="M10 7.8V5.2h4v2.6M14 5.2l3.2-1.8M9 11.5l6 5M15 11.5l-6 5"/>'),
  cloak: stroke('<path d="M5.5 20V10.5a6.5 6.5 0 0 1 13 0V20l-2.2-1.6L14 20l-2-1.6L10 20l-2.3-1.6z"/><circle cx="9.5" cy="10.5" r="1" fill="currentColor"/><circle cx="14.5" cy="10.5" r="1" fill="currentColor"/>'),
  adrenaline: stroke('<path d="M13.5 2.5 5.5 13.5h6l-1 8 8-11h-6z"/>'),
};

const solid = (inner: string): string => `<svg viewBox="0 0 120 40" fill="currentColor">${inner}</svg>`;

export const WEAPON_ICONS: Record<WeaponId, string> = {
  knife: solid('<path d="M18 22h22l4-3h2l3 3 52-6c6-1 10 0 12 2-2 2-6 4-12 5l-54 4-3 3h-2l-4-3H18a3 3 0 0 1 0-5z"/><rect x="10" y="21" width="10" height="7" rx="2"/>'),
  pistol: solid('<path d="M30 12h56v4h4v6H66l-2 3h-8l-3 12H40l4-15H30z"/><rect x="52" y="22" width="8" height="5" rx="1" opacity=".6"/><rect x="82" y="10" width="3" height="3"/>'),
  magnum: solid('<path d="M22 12h72v3h6v8H64l-3 4h-9l-4 11H35l4-17H22z"/><rect x="88" y="9" width="4" height="4"/><rect x="70" y="12" width="12" height="2" opacity=".5"/>'),
  smg: solid('<path d="M8 15h10l6-3h58v3h14v6H82l-2 4H70l4 13h-9l-5-13h-6l-2 6h-8l2-6H40l-4 4H22l-3-4H8z"/><rect x="40" y="7" width="14" height="5" rx="1"/><rect x="62" y="21" width="5" height="14" opacity=".9"/>'),
  shotgun: solid('<path d="M4 18l14-6h30v2h66v4H48v3h42v4H48l-4 2h-6l-3 7h-8l3-9H18L6 25z"/><circle cx="112" cy="13" r="1.5"/>'),
  rifle: solid('<path d="M4 15l14-1 4-3h26V8h14v3h34v3h18v4H96v4H60l-1 3h-7l-4 13h-8l3-13h-9l-3 4H18L4 22z"/><path d="M60 22l3 14h7l-4-14z" opacity=".9"/><rect x="50" y="4" width="14" height="5" rx="1"/>'),
  sniper: solid('<path d="M2 17l18-3h22V11h12v3h66v3h-6v3h-54l-2 3h-6l-4 12h-8l3-12H30l-6 4H2z"/><rect x="40" y="3" width="30" height="7" rx="3"/><rect x="36" y="5" width="6" height="4" rx="1"/><rect x="68" y="4" width="6" height="5" rx="1"/><path d="M78 22l-4 14h2l5-14z"/>'),
};

export const ICONS = {
  crown: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 18h18l-1.5-10-5 4L12 5l-2.5 7-5-4z"/></svg>',
  bot: stroke('<rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01M9.5 16.5h5"/>'),
  copy: stroke('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>'),
  link: stroke('<path d="M10 14a4 4 0 0 0 5.6 0l3-3a4 4 0 0 0-5.6-5.6l-1 1"/><path d="M14 10a4 4 0 0 0-5.6 0l-3 3a4 4 0 0 0 5.6 5.6l1-1"/>'),
  skull: stroke('<path d="M12 3a7 7 0 0 0-7 7v3l2 2v3h10v-3l2-2v-3a7 7 0 0 0-7-7z"/><circle cx="9.5" cy="11" r="1.5" fill="currentColor"/><circle cx="14.5" cy="11" r="1.5" fill="currentColor"/>'),
  head: stroke('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>'),
  coin: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="#f2b632" stroke="#a8650c" stroke-width="2"/><text x="12" y="16.2" font-size="11" font-weight="900" text-anchor="middle" fill="#7a4300" font-family="Rajdhani, sans-serif">G</text></svg>',
  shield: stroke('<path d="M12 3 19 6v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/>'),
  plus: stroke('<path d="M12 5v14M5 12h14"/>'),
  close: stroke('<path d="M6 6l12 12M18 6 6 18"/>'),
  gear: stroke('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l12-7.5z"/></svg>',
  users: stroke('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14a5 5 0 0 1 5.5 5"/>'),
  login: stroke('<path d="M10 17l5-5-5-5M15 12H3M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5"/>'),
  keyboard: stroke('<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>'),
  exit: stroke('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>'),
  swap: stroke('<path d="M7 7h12l-3-3M17 17H5l3 3"/>'),
  target: stroke('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3"/>'),
};
