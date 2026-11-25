import { CHAT_UI_CSS } from "./chat-style-ui";

const DARK_TOKENS = `color-scheme: dark;
  --c-rail: #0B1215; --c-bg: #0F171A; --c-panel: #121D21; --c-surface: #162328; --c-surface-2: #1B2B31;
  --c-hover: rgba(255,255,255,0.045); --c-active: rgba(255,255,255,0.085);
  --c-line: rgba(255,255,255,0.075); --c-line-strong: rgba(255,255,255,0.14);
  --c-text-1: #EDF3F5; --c-text-2: #B0C0C6; --c-text-3: #6F828A;
  --c-brand-text: #58A6FF; --c-btn-bg: #1F6FEB; --c-btn-fg: #FFFFFF;
  --c-turn: #F0A93A; --c-turn-bg: rgba(240,169,58,0.14);
  --c-run: #58A6FF; --c-run-bg: rgba(88,166,255,0.14);
  --c-ok: #3FB97A; --c-warn: #F0A93A; --c-info: #36C5F0;
  --c-danger: #F07178; --c-danger-bg: #B91C1C; --c-danger-tint: rgba(240,113,120,0.15); --c-danger-tint-text: #FCA5A5;`;

const BASE_CSS = `:root, :root[data-theme="light"] {
  color-scheme: light;
  --c-rail: #F1F5F6; --c-bg: #FFFFFF; --c-panel: #F7FAFB; --c-surface: #FFFFFF; --c-surface-2: #EEF3F5;
  --c-hover: rgba(15,23,26,0.045); --c-active: rgba(15,23,26,0.08);
  --c-line: rgba(15,23,26,0.09); --c-line-strong: rgba(15,23,26,0.17);
  --c-text-1: #11191D; --c-text-2: #39484F; --c-text-3: #607078;
  --c-brand-text: #0860CA; --c-btn-bg: #0860CA; --c-btn-fg: #FFFFFF;
  --c-turn: #B45309; --c-turn-bg: rgba(217,119,6,0.12);
  --c-run: #0284C7; --c-run-bg: rgba(2,132,199,0.12);
  --c-ok: #15803D; --c-warn: #B45309; --c-info: #0284C7;
  --c-danger: #B91C1C; --c-danger-bg: #B91C1C; --c-danger-tint: #FEE2E2; --c-danger-tint-text: #991B1B;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${DARK_TOKENS} } }
:root[data-theme="dark"] { ${DARK_TOKENS} }
:root {
  --font: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Pretendard", "Noto Sans KR", system-ui, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "D2Coding", "Noto Sans KR", monospace;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100dvh; overflow: hidden; }
body { font-family: var(--font); font-size: 14px; line-height: 1.5; color: var(--c-text-1); background: var(--c-bg); }
button, input, textarea { font: inherit; color: inherit; }
button { background: none; border: 0; cursor: pointer; }
a { color: var(--c-brand-text); text-decoration: none; }
a:hover { text-decoration: underline; }
.wc-app { display: flex; flex-direction: column; height: 100dvh; }
.wc-topbar {
  flex-shrink: 0; height: 48px; display: flex; align-items: center; justify-content: space-between;
  gap: 8px; padding: 0 12px; border-bottom: 1px solid var(--c-line); background: var(--c-rail);
}
.wc-top-left, .wc-top-right { display: flex; align-items: center; gap: 6px; min-width: 0; }
.wc-brand { display: inline-flex; align-items: center; gap: 8px; font-size: 13.5px; font-weight: 700; white-space: nowrap; }
.wc-brand-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--c-brand-text); flex-shrink: 0; }
.wc-sig {
  display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 999px;
  font-size: 11.5px; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap;
}
.wc-sig-turn { background: var(--c-turn-bg); color: var(--c-turn); }
.wc-sig-run { background: var(--c-run-bg); color: var(--c-run); }
.wc-sig-sse { color: var(--c-text-3); font-size: 11px; gap: 4px; }
.wc-sig-sse.is-live i { width: 6px; height: 6px; border-radius: 50%; background: var(--c-ok); display: inline-block; }
.wc-sig-sse.is-wait i { width: 6px; height: 6px; border-radius: 50%; background: var(--c-turn); display: inline-block; }
.wc-btn-icon, .wc-btn, .wc-act-btn, .wc-copy-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  min-height: 32px; min-width: 32px; padding: 0 10px; border-radius: 7px;
  border: 1px solid var(--c-line); background: var(--c-surface); color: var(--c-text-1);
  font-size: 12.5px; font-weight: 600; transition: background 120ms ease, border-color 120ms ease;
}
.wc-btn-icon:hover, .wc-btn:hover, .wc-copy-btn:hover, .wc-act-btn:hover { background: var(--c-hover); border-color: var(--c-line-strong); }
.wc-btn-ghost { border-color: transparent; background: transparent; color: var(--c-text-2); }
.wc-btn-primary { background: var(--c-btn-bg); color: var(--c-btn-fg); border-color: transparent; }
.wc-btn-primary:hover { filter: brightness(1.08); background: var(--c-btn-bg); }
.wc-btn-danger { background: var(--c-danger-bg); color: #FFFFFF; border-color: transparent; }
.wc-btn-menu { display: none; }
.wc-kbd { font-family: var(--mono); font-size: 11px; color: var(--c-text-3); padding: 1px 5px; border: 1px solid var(--c-line); border-radius: 4px; }
.wc-body { flex: 1 1 0; min-height: 0; display: grid; grid-template-columns: 268px minmax(0, 1fr); position: relative; }
.wc-body.has-thread { grid-template-columns: 268px minmax(0, 1fr) 400px; }
.wc-sidebar {
  display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--c-line);
  background: var(--c-rail); user-select: none;
}
.wc-rail-sec { padding: 10px 10px 6px; border-bottom: 1px solid var(--c-line); }
.wc-rail-head {
  display: flex; align-items: center; justify-content: space-between; padding: 0 4px 6px;
  font-size: 11px; font-weight: 700; color: var(--c-text-3); letter-spacing: 0.04em;
}
.wc-bot-list { display: flex; flex-direction: column; gap: 2px; }
.wc-bot-item {
  width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 7px 10px; border-radius: 8px; font-size: 13px; font-weight: 600; color: var(--c-text-2);
  border-left: 2px solid transparent; transition: background 120ms ease;
}
.wc-bot-item:hover { background: var(--c-hover); color: var(--c-text-1); }
.wc-bot-item.is-active { background: var(--c-active); color: var(--c-text-1); border-left-color: var(--bot-accent, var(--c-brand-text)); }
.wc-bot-left { display: flex; align-items: center; gap: 8px; min-width: 0; }
.wc-bot-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.wc-bot-meta { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--c-text-3); font-variant-numeric: tabular-nums; }
.wc-search-wrap { padding: 8px 10px 4px; display: flex; gap: 6px; align-items: center; }
.wc-search {
  flex: 1 1 0; min-width: 0; height: 32px; padding: 0 10px; border-radius: 8px;
  border: 1px solid var(--c-line); background: var(--c-bg); color: var(--c-text-1); font-size: 12.5px;
}
.wc-search:focus { outline: none; border-color: var(--c-brand-text); }
.wc-conv-list { flex: 1 1 0; overflow-y: auto; padding: 6px 8px 14px; display: flex; flex-direction: column; gap: 2px; }
.wc-grp-head {
  display: flex; align-items: center; justify-content: space-between; padding: 10px 8px 4px;
  font-size: 11px; font-weight: 700; letter-spacing: 0.03em; color: var(--c-text-3);
}
.wc-grp-head.is-turn { color: var(--c-turn); }
.wc-grp-head.is-run { color: var(--c-run); }
.wc-conv-item {
  width: 100%; display: flex; flex-direction: column; gap: 3px; padding: 8px 10px; border-radius: 8px;
  text-align: left; border-left: 2px solid transparent; transition: background 120ms ease;
}
.wc-conv-item:hover { background: var(--c-hover); }
.wc-conv-item.is-active { background: var(--c-active); border-left-color: var(--c-brand-text); }
.wc-conv-row { display: flex; align-items: center; gap: 7px; min-width: 0; }
.wc-mark { width: 14px; height: 14px; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 800; }
.wc-mark-turn { border-radius: 50%; background: var(--c-turn-bg); color: var(--c-turn); border: 1px solid var(--c-turn); }
.wc-mark-idle { width: 9px; height: 9px; border-radius: 50%; border: 1.5px solid var(--c-text-3); opacity: 0.55; }
.wc-spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--c-run); border-top-color: transparent; animation: wc-rot 0.9s linear infinite; display: inline-block; flex-shrink: 0; }
@keyframes wc-rot { to { transform: rotate(360deg); } }
.wc-conv-name { flex: 1 1 0; font-size: 13px; font-weight: 600; color: var(--c-text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wc-conv-age { font-size: 11px; color: var(--c-text-3); font-variant-numeric: tabular-nums; flex-shrink: 0; }
.wc-conv-sub { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding-left: 21px; }
.wc-conv-prev { font-size: 12px; color: var(--c-text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wc-tchip {
  flex-shrink: 0; font-size: 10.5px; font-weight: 600; color: var(--c-text-2);
  background: var(--c-hover); padding: 1px 6px; border-radius: 999px; font-variant-numeric: tabular-nums;
}
.wc-pill { display: inline-flex; align-items: center; gap: 4px; padding: 1px 6px; border-radius: 999px; font-size: 10.5px; font-weight: 600; flex-shrink: 0; }
.wc-pill-info { background: var(--c-run-bg); color: var(--c-run); }
.wc-pill-warn { background: var(--c-turn-bg); color: var(--c-turn); }
.wc-backdrop { display: none; }
@media (max-width: 1160px) { .wc-body.has-thread { grid-template-columns: 248px minmax(0, 1fr) 350px; } }
@media (max-width: 860px) {
  .wc-btn-menu { display: inline-flex; }
  .wc-kbd, #wc-cmdk, .wc-sig-sse span { display: none; }
  .wc-topbar { padding: 0 8px; gap: 4px; }
  .wc-top-left, .wc-top-right { gap: 4px; }
  .wc-brand span:last-child { font-size: 12.5px; }
  .wc-sig { padding: 2px 7px; font-size: 11px; }
  .wc-btn { padding: 0 9px; white-space: nowrap; font-size: 12px; }
  .wc-btn-icon, .wc-btn, .wc-conv-item, .wc-act-btn, .wc-copy-btn { min-height: 44px; min-width: 44px; }
  .wc-body, .wc-body.has-thread { grid-template-columns: minmax(0, 1fr); }
  .wc-sidebar {
    position: fixed; top: 48px; bottom: 0; left: 0; width: min(86vw, 316px); z-index: 40;
    transform: translateX(-105%); transition: transform 170ms ease;
  }
  .wc-sidebar.is-open { transform: translateX(0); box-shadow: 8px 0 32px rgba(0, 0, 0, 0.45); }
  .wc-backdrop.is-open { display: block; position: fixed; inset: 48px 0 0 0; background: rgba(0, 0, 0, 0.52); z-index: 30; }
}
`;

/** Standalone CSS loaded only on `?view=chat` (keeps main dashboard style budget intact). */
export const CHAT_CSS = BASE_CSS + CHAT_UI_CSS;
