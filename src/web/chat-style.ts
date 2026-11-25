const DARK_TOKENS = `color-scheme: dark;
  --c-bg: #0D0F12; --c-surface: #15181D; --c-hover: #1C2027; --c-bubble-me: #1B2D4A;
  --c-line: #262B33; --c-line-strong: #383F4B;
  --c-text-1: #F3F4F6; --c-text-2: #C2C8D0; --c-text-3: #969FA9;
  --c-brand-text: #58A6FF; --c-btn-bg: #1F6FEB; --c-btn-fg: #FFFFFF;
  --c-danger: #F87171; --c-danger-bg: #B91C1C; --c-danger-tint: #351619; --c-danger-tint-text: #FCA5A5;
  --c-ok: #2EB67D; --c-warn: #ECB22E; --c-info: #36C5F0;`;

/** Standalone CSS loaded only on `?view=chat` (keeps main dashboard style budget intact). */
export const CHAT_CSS = `:root, :root[data-theme="light"] {
  color-scheme: light;
  --c-bg: #F3F4F6; --c-surface: #FFFFFF; --c-hover: #F8F9FA; --c-bubble-me: #E8F0FE;
  --c-line: #E1E4E8; --c-line-strong: #C8CDD4;
  --c-text-1: #111315; --c-text-2: #3A3F45; --c-text-3: #525860;
  --c-brand-text: #0860CA; --c-btn-bg: #0860CA; --c-btn-fg: #FFFFFF;
  --c-danger: #B91C1C; --c-danger-bg: #B91C1C; --c-danger-tint: #FEE2E2; --c-danger-tint-text: #991B1B;
  --c-ok: #16A34A; --c-warn: #CA8A04; --c-info: #0284C7;
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
.wc-topbar { flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 14px; border-bottom: 1px solid var(--c-line); background: var(--c-surface); min-height: 52px; }
.wc-top-left, .wc-top-right { display: flex; align-items: center; gap: 8px; min-width: 0; }
.wc-title { font-size: 15px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wc-btn-icon, .wc-btn, .wc-conv-item, .wc-act-btn, .wc-copy-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  min-height: 44px; min-width: 44px; padding: 0 12px; border-radius: 8px;
  border: 1px solid var(--c-line); background: var(--c-surface); color: var(--c-text-1); font-size: 13px; font-weight: 600;
}
.wc-btn-icon:hover, .wc-btn:hover, .wc-copy-btn:hover { background: var(--c-hover); border-color: var(--c-line-strong); }
.wc-btn-primary { background: var(--c-btn-bg); color: var(--c-btn-fg); border-color: var(--c-btn-bg); }
.wc-btn-primary:hover { filter: brightness(1.08); background: var(--c-btn-bg); }
.wc-btn-danger { background: var(--c-danger-bg); color: #FFFFFF; border-color: var(--c-danger-bg); }
.wc-btn-menu { display: none; }
.wc-body { flex: 1 1 0; min-height: 0; display: grid; grid-template-columns: 280px minmax(0, 1fr); position: relative; }
.wc-sidebar { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--c-line); background: var(--c-surface); }
.wc-side-head { padding: 10px 12px; border-bottom: 1px solid var(--c-line); display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.wc-side-title { font-size: 12px; font-weight: 700; color: var(--c-text-3); text-transform: uppercase; letter-spacing: 0.04em; }
.wc-conv-list { flex: 1 1 0; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 4px; }
.wc-conv-item { width: 100%; justify-content: flex-start; flex-direction: column; align-items: stretch; gap: 4px; padding: 10px 12px; text-align: left; font-weight: 500; border-color: transparent; }
.wc-conv-item:hover { background: var(--c-hover); }
.wc-conv-item.is-active { background: var(--c-hover); border-color: var(--c-brand-text); }
.wc-conv-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.wc-conv-name { font-size: 13.5px; font-weight: 600; color: var(--c-text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wc-conv-prev { font-size: 12px; color: var(--c-text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wc-pill { display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; border-radius: 999px; font-size: 11px; font-weight: 600; flex-shrink: 0; }
.wc-pill-info { background: rgba(88, 166, 255, 0.16); color: var(--c-brand-text); }
.wc-pill-warn { background: var(--c-danger-tint); color: var(--c-danger-tint-text); }
.wc-main { display: flex; flex-direction: column; min-height: 0; background: var(--c-bg); position: relative; }
.wc-main.is-dragover::after { content: "여기에 파일을 놓아 첨부"; position: absolute; inset: 12px; border: 2px dashed var(--c-brand-text); border-radius: 12px; background: rgba(31, 111, 235, 0.12); display: flex; align-items: center; justify-content: center; font-size: 16px; font-weight: 700; color: var(--c-brand-text); pointer-events: none; z-index: 20; }
.wc-messages { flex: 1 1 0; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.wc-empty { margin: auto; text-align: center; color: var(--c-text-3); max-width: 360px; }
.wc-msg { max-width: min(820px, 92%); display: flex; flex-direction: column; gap: 6px; }
.wc-msg-owner { align-self: flex-end; }
.wc-msg-assistant, .wc-msg-approval, .wc-msg-choice { align-self: flex-start; width: 100%; max-width: min(760px, 100%); }
.wc-msg-system { align-self: center; font-size: 12px; color: var(--c-text-3); padding: 4px 10px; border-radius: 999px; background: var(--c-surface); border: 1px solid var(--c-line); }
.wc-msg-status { align-self: flex-start; font-size: 12.5px; color: var(--c-brand-text); padding: 6px 12px; border-radius: 999px; background: var(--c-surface); border: 1px solid var(--c-line); }
.wc-msg-status.is-deleted { display: none; }
.wc-bubble { padding: 11px 14px; border-radius: 12px; background: var(--c-surface); border: 1px solid var(--c-line); overflow-wrap: anywhere; }
.wc-msg-owner .wc-bubble { background: var(--c-bubble-me); border-color: transparent; }
.wc-md p + p, .wc-md ul, .wc-md ol, .wc-md pre, .wc-md blockquote, .wc-md .md-table { margin-top: 8px; }
.wc-md ul, .wc-md ol { padding-left: 20px; }
.wc-md code { font-family: var(--mono); font-size: 12.5px; background: var(--c-hover); padding: 1px 5px; border-radius: 4px; }
.md-code { font-family: var(--mono); font-size: 12.5px; padding: 10px 12px; border-radius: 8px; background: var(--c-bg); border: 1px solid var(--c-line); overflow-x: auto; }
.md-code code { background: none; padding: 0; }
.wc-copy { position: relative; margin-top: 8px; }
.wc-copy-btn { min-height: 36px; min-width: 52px; margin-top: 6px; font-size: 12px; }
.wc-card { border: 1px solid var(--c-line); border-left: 4px solid var(--c-brand-text); border-radius: 10px; background: var(--c-surface); padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
.wc-card + .wc-card, .wc-md + .wc-card, .wc-card + .wc-md { margin-top: 8px; }
.wc-tone-ok { border-left-color: var(--c-ok); }
.wc-tone-warn { border-left-color: var(--c-warn); }
.wc-tone-danger { border-left-color: var(--c-danger); }
.wc-tone-info { border-left-color: var(--c-info); }
.wc-card-title { font-size: 14.5px; font-weight: 700; }
.wc-card-sub, .wc-muted, .wc-card-note { font-size: 12.5px; color: var(--c-text-3); }
.wc-card-body { display: flex; flex-direction: column; gap: 8px; }
.wc-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; }
.wc-field { background: var(--c-bg); border: 1px solid var(--c-line); border-radius: 6px; padding: 6px 9px; }
.wc-field dt { font-size: 11px; color: var(--c-text-3); font-weight: 600; }
.wc-field dd { font-size: 13px; font-weight: 600; margin-top: 2px; font-variant-numeric: tabular-nums; }
.wc-table, .md-table { overflow-x: auto; border: 1px solid var(--c-line); border-radius: 8px; }
.wc-table table, .md-table table { width: 100%; border-collapse: collapse; font-size: 12.5px; font-variant-numeric: tabular-nums; }
.wc-table th, .wc-table td, .md-table th, .md-table td { padding: 6px 10px; border-bottom: 1px solid var(--c-line); }
.wc-table thead th, .md-table thead th { background: var(--c-hover); font-weight: 700; color: var(--c-text-2); }
.wc-table caption { padding: 6px 10px; font-size: 12px; color: var(--c-text-3); text-align: left; }
.wc-chart { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid var(--c-line); border-radius: 8px; background: var(--c-bg); }
.wc-chart-title { font-size: 12.5px; font-weight: 700; }
.wc-chart-svg { width: 100%; height: auto; max-width: 520px; display: block; }
.wc-pie-svg { max-width: 172px; }
.wc-chart-pie { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.wc-chart-leg { list-style: none; display: flex; flex-wrap: wrap; gap: 6px 12px; font-size: 12px; }
.wc-chart-pie .wc-chart-leg { flex-direction: column; }
.wc-chart-leg-item { display: inline-flex; align-items: center; gap: 6px; }
.wc-swatch { width: 10px; height: 10px; border-radius: 2px; flex-shrink: 0; }
.wc-leg-val { color: var(--c-text-3); font-variant-numeric: tabular-nums; }
.wc-divider { border: 0; border-top: 1px solid var(--c-line); }
.wc-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
.wc-files { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.wc-file-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 9px; border-radius: 6px; background: var(--c-hover); border: 1px solid var(--c-line); font-size: 12px; }
.wc-chip-x { min-width: 24px; min-height: 24px; border-radius: 4px; color: var(--c-text-3); font-weight: 700; }
.wc-composer-wrap { flex-shrink: 0; border-top: 1px solid var(--c-line); background: var(--c-surface); padding: 10px 14px max(10px, env(safe-area-inset-bottom)); display: flex; flex-direction: column; gap: 8px; }
.wc-pending-files { display: flex; flex-wrap: wrap; gap: 6px; }
.wc-composer { display: flex; align-items: flex-end; gap: 8px; }
.wc-input { flex: 1 1 0; min-height: 44px; max-height: 180px; padding: 10px 12px; border: 1px solid var(--c-line-strong); border-radius: 10px; background: var(--c-bg); color: var(--c-text-1); resize: none; }
.wc-input:focus { outline: 2px solid var(--c-brand-text); border-color: transparent; }
.wc-error { font-size: 12.5px; color: var(--c-danger); }
.wc-backdrop { display: none; }
@media (max-width: 768px) {
  .wc-btn-menu { display: inline-flex; }
  .wc-body { grid-template-columns: minmax(0, 1fr); }
  .wc-sidebar { position: fixed; top: 52px; bottom: 0; left: 0; width: min(84vw, 310px); z-index: 40; transform: translateX(-105%); transition: transform 160ms ease; }
  .wc-sidebar.is-open { transform: translateX(0); box-shadow: 4px 0 24px rgba(0, 0, 0, 0.4); }
  .wc-backdrop.is-open { display: block; position: fixed; inset: 52px 0 0 0; background: rgba(0, 0, 0, 0.5); z-index: 30; }
  .wc-messages { padding: 12px; }
  .wc-composer-wrap { padding: 8px 10px max(8px, env(safe-area-inset-bottom)); }
  .wc-copy-btn, .wc-chip-x { min-height: 44px; min-width: 44px; }
}
`;
