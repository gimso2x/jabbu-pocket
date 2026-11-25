export const CHAT_UI_CSS = `
.wc-main { display: flex; flex-direction: column; min-height: 0; background: var(--c-bg); position: relative; }
.wc-main.is-dragover::after, .wc-thread-pane.is-dragover::after {
  content: "여기에 파일을 놓아 첨부"; position: absolute; inset: 12px; border: 2px dashed var(--c-brand-text);
  border-radius: 12px; background: rgba(31, 111, 235, 0.12); display: flex; align-items: center;
  justify-content: center; font-size: 15px; font-weight: 700; color: var(--c-brand-text); pointer-events: none; z-index: 25;
}
.wc-chan-head {
  flex-shrink: 0; height: 48px; padding: 0 18px; border-bottom: 1px solid var(--c-line);
  display: flex; align-items: center; justify-content: space-between; gap: 10px; background: var(--c-bg);
}
.wc-chan-left { display: flex; align-items: center; gap: 8px; min-width: 0; }
.wc-chan-hash { color: var(--c-text-3); font-weight: 700; font-size: 16px; }
.wc-title { font-size: 14.5px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wc-bot-tag {
  display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 999px;
  font-size: 11px; font-weight: 600; background: var(--c-surface); border: 1px solid var(--c-line); color: var(--c-text-2); flex-shrink: 0;
}
.wc-messages, .wc-thread-messages {
  flex: 1 1 0; overflow-y: auto; padding: 14px 20px 18px; display: flex; flex-direction: column; gap: 2px;
}
.wc-empty { margin: auto; text-align: center; color: var(--c-text-3); max-width: 360px; font-size: 13.5px; line-height: 1.6; }
.wc-row {
  position: relative; display: grid; grid-template-columns: 36px minmax(0, 1fr); gap: 10px;
  padding: 7px 10px; border-radius: 10px; margin-top: 8px; transition: background 110ms ease;
}
.wc-row.is-cont { margin-top: 0; padding-top: 2px; padding-bottom: 2px; }
.wc-row:hover { background: var(--c-hover); }
.wc-avatar {
  width: 32px; height: 32px; border-radius: 9px; display: flex; align-items: center; justify-content: center;
  font-size: 12.5px; font-weight: 700; color: #FFFFFF; background: var(--av-bg, #2B424B); margin-top: 2px;
}
.wc-avatar-owner { background: #1D3549; color: #BAE6FD; }
.wc-row-time-side { font-size: 10.5px; color: var(--c-text-3); opacity: 0; text-align: right; padding-top: 3px; font-variant-numeric: tabular-nums; }
.wc-row:hover .wc-row-time-side { opacity: 1; }
.wc-row-body { min-width: 0; display: flex; flex-direction: column; gap: 5px; overflow-wrap: anywhere; }
.wc-row-head { display: flex; align-items: baseline; gap: 7px; flex-wrap: wrap; }
.wc-sender { font-size: 13.5px; font-weight: 700; color: var(--c-text-1); }
.wc-bot-badge { font-size: 10px; font-weight: 700; padding: 1px 5px; border-radius: 4px; background: var(--c-run-bg); color: var(--c-run); }
.wc-time { font-size: 11px; color: var(--c-text-3); font-variant-numeric: tabular-nums; }
.wc-msg-tools {
  position: absolute; top: -10px; right: 10px; display: none; align-items: center; gap: 4px;
  background: var(--c-surface); border: 1px solid var(--c-line-strong); border-radius: 8px; padding: 2px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.28); z-index: 5;
}
.wc-row:hover .wc-msg-tools, .wc-row:focus-within .wc-msg-tools { display: inline-flex; }
.wc-tool-btn { padding: 4px 8px; border-radius: 6px; font-size: 11.5px; font-weight: 600; color: var(--c-text-2); min-height: 28px; }
.wc-tool-btn:hover { background: var(--c-hover); color: var(--c-text-1); }
.wc-thread-bar {
  align-self: flex-start; display: inline-flex; align-items: center; gap: 7px; margin-top: 2px;
  padding: 5px 10px; border-radius: 8px; border: 1px solid var(--c-line); background: var(--c-surface);
  font-size: 12px; color: var(--c-brand-text); font-weight: 600; max-width: 100%;
}
.wc-thread-bar span:first-child { white-space: nowrap; flex-shrink: 0; }
.wc-thread-bar:hover { background: var(--c-surface-2); border-color: var(--c-brand-text); }
.wc-thread-bar-prev { color: var(--c-text-3); font-weight: 400; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 260px; min-width: 0; }
.wc-msg-system { align-self: center; font-size: 12px; color: var(--c-text-3); padding: 4px 12px; margin: 6px 0; border-radius: 999px; background: var(--c-surface); border: 1px solid var(--c-line); }
.wc-msg-status { display: inline-flex; align-items: center; gap: 8px; align-self: flex-start; margin: 6px 0 6px 56px; font-size: 12.5px; color: var(--c-run); padding: 5px 11px; border-radius: 999px; background: var(--c-run-bg); }
.wc-msg-status.is-deleted { display: none; }
.wc-md { font-size: 14px; line-height: 1.56; color: var(--c-text-1); max-width: 82ch; }
.wc-md p + p, .wc-md ul, .wc-md ol, .wc-md pre, .wc-md blockquote, .wc-md .md-table { margin-top: 8px; }
.wc-md ul, .wc-md ol { padding-left: 20px; }
.wc-md blockquote { border-left: 3px solid var(--c-line-strong); padding-left: 10px; color: var(--c-text-2); }
.wc-md code { font-family: var(--mono); font-size: 12.5px; background: var(--c-surface-2); padding: 1px 5px; border-radius: 4px; }
.md-code { font-family: var(--mono); font-size: 12.5px; padding: 10px 12px; border-radius: 8px; background: var(--c-rail); border: 1px solid var(--c-line); overflow-x: auto; }
.md-code code { background: none; padding: 0; }
.wc-copy { position: relative; margin-top: 6px; max-width: 82ch; }
.wc-copy-btn { margin-top: 5px; font-size: 11.5px; }
.wc-card { border: 1px solid var(--c-line); border-left: 3.5px solid var(--c-brand-text); border-radius: 10px; background: var(--c-surface); padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; max-width: 780px; }
.wc-card-prompt { border-left-color: var(--c-turn); background: linear-gradient(90deg, var(--c-turn-bg) 0%, var(--c-surface) 22%); }
.wc-card + .wc-card, .wc-md + .wc-card, .wc-card + .wc-md { margin-top: 8px; }
.wc-tone-ok { border-left-color: var(--c-ok); }
.wc-tone-warn { border-left-color: var(--c-warn); }
.wc-tone-danger { border-left-color: var(--c-danger); }
.wc-tone-info { border-left-color: var(--c-info); }
.wc-card-title { font-size: 14px; font-weight: 700; }
.wc-card-sub, .wc-muted, .wc-card-note { font-size: 12.5px; color: var(--c-text-3); }
.wc-card-body { display: flex; flex-direction: column; gap: 8px; }
.wc-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; }
.wc-field { background: var(--c-bg); border: 1px solid var(--c-line); border-radius: 8px; padding: 7px 10px; }
.wc-field dt { font-size: 11px; color: var(--c-text-3); font-weight: 600; }
.wc-field dd { font-size: 13px; font-weight: 600; margin-top: 2px; font-variant-numeric: tabular-nums; }
.wc-table, .md-table { overflow-x: auto; border: 1px solid var(--c-line); border-radius: 8px; }
.wc-table table, .md-table table { width: 100%; border-collapse: collapse; font-size: 12.5px; font-variant-numeric: tabular-nums; }
.wc-table th, .wc-table td, .md-table th, .md-table td { padding: 6px 10px; border-bottom: 1px solid var(--c-line); }
.wc-table thead th, .md-table thead th { background: var(--c-surface-2); font-weight: 700; color: var(--c-text-2); }
.wc-table caption { padding: 6px 10px; font-size: 12px; color: var(--c-text-3); text-align: left; }
.wc-chart { display: flex; flex-direction: column; gap: 6px; padding: 10px; border: 1px solid var(--c-line); border-radius: 8px; background: var(--c-bg); }
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
.wc-files { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
.wc-file-chip { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 8px; background: var(--c-surface); border: 1px solid var(--c-line); font-size: 12px; color: var(--c-text-1); }
.wc-img-btn { display: inline-flex; flex-direction: column; align-items: flex-start; gap: 4px; padding: 4px; border-radius: 10px; border: 1px solid var(--c-line); background: var(--c-surface); }
.wc-img-btn:hover { border-color: var(--c-brand-text); }
.wc-img-thumb { display: block; max-width: min(320px, 72vw); max-height: 220px; border-radius: 7px; object-fit: cover; }
.wc-img-cap { font-size: 11px; color: var(--c-text-3); padding: 0 4px 2px; }
.wc-chip-x { min-width: 24px; min-height: 24px; border-radius: 4px; color: var(--c-text-3); font-weight: 700; }
.wc-composer-wrap { flex-shrink: 0; padding: 8px 18px max(12px, env(safe-area-inset-bottom)); display: flex; flex-direction: column; gap: 6px; }
.wc-composer-box { border: 1px solid var(--c-line-strong); border-radius: 14px; background: var(--c-surface); padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
.wc-composer-box:focus-within { border-color: var(--c-brand-text); box-shadow: 0 0 0 2px rgba(88, 166, 255, 0.16); }
.wc-pending-files { display: flex; flex-wrap: wrap; gap: 6px; }
.wc-composer { display: flex; align-items: flex-end; gap: 8px; }
.wc-input { flex: 1 1 0; min-height: 36px; max-height: 180px; padding: 6px 4px; border: 0; background: transparent; color: var(--c-text-1); resize: none; }
.wc-input:focus { outline: none; }
.wc-error { font-size: 12.5px; color: var(--c-danger); }
.wc-thread-pane { display: none; flex-direction: column; min-height: 0; border-left: 1px solid var(--c-line); background: var(--c-panel); position: relative; }
.wc-body.has-thread .wc-thread-pane { display: flex; }
.wc-thread-head { flex-shrink: 0; height: 48px; padding: 0 14px; border-bottom: 1px solid var(--c-line); display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.wc-thread-title { font-size: 13.5px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wc-thread-parent { margin: 12px 14px 4px; padding: 10px 12px; border-radius: 10px; background: var(--c-surface); border: 1px solid var(--c-line); border-left: 3px solid var(--c-brand-text); font-size: 13px; max-height: 220px; overflow-y: auto; flex-shrink: 0; }
.wc-thread-parent-meta { font-size: 11.5px; font-weight: 700; color: var(--c-text-2); margin-bottom: 4px; }
.wc-modal { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.62); display: flex; align-items: flex-start; justify-content: center; padding: 10vh 16px 24px; z-index: 70; }
.wc-modal[hidden] { display: none; }
.wc-palette { width: min(520px, 100%); background: var(--c-surface); border: 1px solid var(--c-line-strong); border-radius: 14px; overflow: hidden; box-shadow: 0 18px 48px rgba(0, 0, 0, 0.5); }
.wc-palette-in { width: 100%; padding: 13px 16px; border: 0; border-bottom: 1px solid var(--c-line); background: transparent; color: var(--c-text-1); font-size: 14px; }
.wc-palette-in:focus { outline: none; }
.wc-palette-list { max-height: 340px; overflow-y: auto; padding: 6px; display: flex; flex-direction: column; gap: 2px; }
.wc-pal-item { width: 100%; display: flex; align-items: center; justify-content: space-between; padding: 9px 12px; border-radius: 8px; font-size: 13px; text-align: left; }
.wc-pal-item:hover, .wc-pal-item.is-sel { background: var(--c-active); }
.wc-lightbox { align-items: center; padding: 20px; }
.wc-lightbox img { max-width: 92vw; max-height: 82dvh; border-radius: 10px; box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6); }
.wc-lb-bar { position: fixed; top: 14px; right: 16px; display: flex; gap: 8px; }
@media (max-width: 860px) {
  .wc-chan-head { padding: 0 12px; }
  .wc-messages, .wc-thread-messages { padding: 10px 10px 14px; }
  .wc-row { grid-template-columns: 30px minmax(0, 1fr); gap: 8px; padding: 6px 6px; }
  .wc-avatar { width: 28px; height: 28px; font-size: 11px; border-radius: 7px; }
  .wc-msg-tools { position: static; grid-column: 2; justify-self: start; display: inline-flex; flex-wrap: wrap; gap: 6px; box-shadow: none; margin-top: 4px; background: transparent; border: 0; padding: 0; }
  .wc-tool-btn { min-height: 44px; padding: 0 12px; white-space: nowrap; border: 1px solid var(--c-line); background: var(--c-surface); }
  .wc-thread-bar, .wc-bot-item, .wc-pal-item { min-height: 44px; }
  .wc-composer-wrap { padding: 6px 10px max(8px, env(safe-area-inset-bottom)); }
  .wc-chip-x { min-height: 44px; min-width: 44px; }
  .wc-body.has-thread .wc-thread-pane { position: fixed; top: 48px; inset-inline: 0; bottom: 0; z-index: 50; border-left: 0; }
}
`;
