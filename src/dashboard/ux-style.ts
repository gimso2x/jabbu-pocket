/**
 * P0–P2 UX benchmark styles layered after `STYLE` and `TASK_WORK_STYLE` in `assets.ts`.
 * Reuses `--c-*` light/dark WCAG AA tokens and keeps all animations gated by `prefers-reduced-motion`.
 */
export const UX_STYLE = `
[hidden] { display: none !important; }
.status-pop { position: relative; flex: 1 1 0; min-width: 0; display: flex; align-items: center; }
.status-summary {
  display: inline-flex; align-items: center; gap: var(--sp-1); height: 28px;
  padding: 0 var(--sp-2); border: 1px solid var(--c-line); border-radius: var(--r-pill);
  background: var(--c-bg); font-size: var(--fs-caption); font-weight: 600; color: var(--c-text-2);
  cursor: pointer; list-style: none; white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis;
}
.status-summary::-webkit-details-marker { display: none; }
.status-summary:hover { border-color: var(--c-line-strong); color: var(--c-text-1); }
.status-summary.is-warn { background: var(--c-warning-tint); color: var(--c-warning-tint-text); border-color: transparent; }
.status-summary.is-danger { background: var(--c-danger-tint); color: var(--c-danger-tint-text); border-color: transparent; }
.status-pop > .status-chips { display: none; }
.status-pop[open] > .status-chips {
  display: flex; flex: 0 0 auto; flex-wrap: wrap; gap: var(--sp-1);
  position: absolute; top: calc(100% + 6px); left: 0; z-index: 28;
  min-width: 240px; max-width: min(440px, calc(100vw - 2 * var(--page-x)));
  padding: var(--sp-2); border: 1px solid var(--c-line-strong); border-radius: var(--r-l);
  background: var(--c-surface); box-shadow: 0 8px 24px rgb(0 0 0 / 0.18);
}

.view-tools { margin-left: auto; display: inline-flex; align-items: center; gap: var(--sp-2); }
.nav-foot {
  margin-top: auto; padding-top: var(--sp-2); border-top: 1px solid var(--c-line);
  display: flex; flex-direction: column; gap: var(--sp-2);
}
.nav-foot .seg { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); width: 100%; }
.nav-foot .seg-item { justify-content: center; padding: 0 var(--sp-1); }
.nav-help {
  display: inline-flex; align-items: center; justify-content: space-between; width: 100%;
  height: 28px; padding: 0 var(--sp-2); border: 1px solid var(--c-line); border-radius: var(--r-m);
  background: var(--c-bg); font-size: var(--fs-caption); font-weight: 600; color: var(--c-text-2);
}
.nav-help:hover { border-color: var(--c-line-strong); color: var(--c-text-1); }
.nav-sheet { display: contents; }
.nav-more-btn { display: none; }

.next-line.is-single { display: none; }
.group-sum { gap: var(--sp-1); padding-bottom: var(--sp-1); border-bottom: 1px solid var(--c-line); }
.group-sum .chip {
  height: 24px; padding: 0 var(--sp-2); border: 0; border-radius: var(--r-s);
  background: transparent; font-size: var(--fs-caption); color: var(--c-text-3);
}
.group-sum .chip:hover { background: var(--c-hover); color: var(--c-text-1); }
.group-sum .chip b { color: var(--c-text-2); }
.host-ok {
  display: inline-flex; align-items: center; gap: var(--sp-1);
  padding: 0 var(--sp-1); font-size: var(--fs-caption); color: var(--c-text-3); white-space: nowrap;
}
.grp[data-empty] { opacity: 0.6; }
.card.trow.is-mine { border-left: 3px solid #D97706; }
.card.trow.is-done { color: var(--c-text-2); }
.card.trow.is-done .t1 { font-weight: 500; }

.toast-act { padding: 1px var(--sp-2); border: 1px solid currentColor; border-radius: var(--r-s); font-size: var(--fs-caption); font-weight: 700; }
.toast-bar { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: currentColor; opacity: 0.65; transform-origin: 0 50%; animation: toast-shrink 5s linear forwards; }
@keyframes toast-shrink { from { transform: scaleX(1); } to { transform: scaleX(0); } }

.flow-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--sp-2); }
.flow-fold-sum { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--sp-1) var(--sp-3); cursor: pointer; list-style: none; }
.flow-fold-sum::-webkit-details-marker { display: none; }
.flow-fold-sum .flow-title::before { content: "▸"; margin-right: var(--sp-1); color: var(--c-text-3); }
.flow-fold[open] > .flow-fold-sum .flow-title::before { content: "▾"; }
.flow-fold[open] > .flow-fold-sum { margin-bottom: var(--sp-2); }
.flow-group:has(> .flow-box:nth-of-type(3)) { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.flow-group:has(> .flow-box:nth-of-type(3)) > .flow-gh { grid-column: 1 / -1; }
.flow-group:has(> .flow-box:nth-of-type(3)) > .flow-box { width: 192px; }

.say-options li { padding: var(--sp-1) var(--sp-2); border: 1px solid var(--c-line-strong); border-radius: var(--r-m); background: var(--c-bg); font-size: var(--fs-sub); cursor: pointer; }
.say-options li:hover { border-color: var(--c-focus); background: var(--c-hover); }
.appr-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-2); margin: 0; }
.appr-cell { padding: var(--sp-2) var(--sp-3); border: 1px solid var(--c-line); border-radius: var(--r-m); background: var(--c-bg); font-size: var(--fs-sub); }
.appr-cell dt { font-size: var(--fs-caption); font-weight: 700; color: var(--c-text-3); margin-bottom: 2px; }
.appr-cell dd { overflow-wrap: anywhere; }
.appr-cell.is-action dd { font-family: var(--mono); font-size: var(--fs-caption); }
.appr-cell.is-impact { border-left: 3px solid var(--c-warning-tint-text); }
.appr-cell.is-rollback { border-color: var(--c-danger); background: var(--c-danger-tint); color: var(--c-danger-tint-text); }
@container (max-width: 440px) { .appr-grid { grid-template-columns: minmax(0, 1fr); } }

.tw-filters { flex-basis: 100%; gap: var(--sp-1); }
.tw-filters .chip { height: 24px; padding: 0 var(--sp-2); font-size: var(--fs-caption); }
.tw-tok { display: flex; flex-direction: column; gap: var(--sp-1); }
.tw-tok-bar { display: flex; height: 8px; border-radius: var(--r-pill); overflow: hidden; background: var(--c-bg); }
.tk-in { background: var(--c-brand-text); }
.tk-cr { background: var(--c-success-tint-text); }
.tk-cw { background: var(--c-warning-tint-text); }
.tk-out { background: var(--c-tw-llm); }
.tw-payload-body { display: flex; flex-direction: column; gap: var(--sp-1); }
.tw-pre { margin: 0; max-height: 160px; overflow: auto; font-family: var(--mono); font-size: var(--fs-caption); white-space: pre-wrap; overflow-wrap: anywhere; }

.diff-nav { border: 1px solid var(--c-line); border-radius: var(--r-m); background: var(--c-bg); padding: var(--sp-2); }
.diff-nav-head { display: flex; align-items: center; justify-content: space-between; font-size: var(--fs-caption); font-weight: 700; color: var(--c-text-2); margin-bottom: var(--sp-1); }
.diff-nav-list { display: flex; flex-direction: column; max-height: 180px; overflow-y: auto; }
.diff-nav-item { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); padding: 2px var(--sp-1); border-radius: var(--r-s); font-size: var(--fs-caption); }
.diff-nav-item:hover { background: var(--c-hover); }
.diff-nav-item .diff-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.diff-stat { flex: none; font-variant-numeric: tabular-nums; }

.sys-strip { justify-content: space-between; }
.sys-strip .button { margin-left: auto; }
.sys-grid { align-items: start; }
.sys-card.is-bad { order: -3; border-left: 3px solid var(--c-danger); }
.sys-card.is-warn { order: -2; border-left: 3px solid var(--c-warning-tint-text); }
.sys-card[data-card="cost"] { order: -1; }
.sys-card.is-ok .sys-head .status-pill.is-success { background: transparent; color: var(--c-text-3); padding: 0; border-color: transparent; }
.sys-grid.is-compact-ok .sys-card.is-ok:not([data-card="cost"]) > :not(.sys-head) { display: none; }
.sys-grid.is-compact-ok .sys-card.is-ok:not([data-card="cost"]) .sys-head { cursor: pointer; }
@media (min-width: 1440px) {
  .limit-chip .lc-full { display: inline-flex; align-items: baseline; gap: 2px; }
}
.limit-chip .lc-full small { margin: 0 1px 0 4px; }
.limit-chip .lc-full small:first-child { margin-left: 0; }
.limit-chip .lc-full .roll-n::after { content: "%"; font-weight: 500; opacity: 0.78; }
.host-off { padding: 0 var(--sp-1); font-size: var(--fs-caption); color: var(--c-text-3); white-space: nowrap; }
.groups.is-idle-inbox { display: none; }
.inbox-pulse, .pulse-sec { display: flex; flex-direction: column; gap: var(--sp-2); }
.pulse-kpi { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--sp-2); }
.pulse-stat { display: flex; flex-direction: column; gap: 2px; padding: var(--sp-2) var(--sp-3); border: 1px solid var(--c-line); border-radius: var(--r-m); background: var(--c-surface); }
.pulse-stat:hover { border-color: var(--c-line-strong); background: var(--c-hover); }
.pulse-stat.is-warn { border-left: 3px solid var(--c-warning-tint-text); }
.pulse-stat span { font-size: var(--fs-caption); color: var(--c-text-3); }
.pulse-stat b { font-size: var(--fs-strong); font-weight: 700; color: var(--c-text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pulse-closed { border: 1px solid var(--c-line); border-radius: var(--r-m); background: var(--c-surface); padding: 0 var(--sp-3); }
.pulse-closed .closed-row:first-child, .pulse-closed .closed { border-top: 0; }
.pulse-closed .closed { padding: var(--sp-1) 0; }
.turn-filters { gap: var(--sp-1); }
.turn-filters .chip { height: 24px; padding: 0 var(--sp-2); font-size: var(--fs-caption); }
.turn-filters .chip.is-warn[aria-pressed="true"] { border-color: var(--c-warning-tint-text); color: var(--c-warning-tint-text); }
.mon-chip.is-danger { background: var(--c-danger-tint); color: var(--c-danger-tint-text); border-color: transparent; }
.ctx-hi { height: 16px; padding: 0 var(--sp-1); font-size: 10.5px; }
.peer-list { display: flex; flex-direction: column; gap: var(--sp-2); }
.peer-row + .peer-row { padding-top: var(--sp-2); border-top: 1px solid var(--c-line); }
.peer-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); }
@container (max-width: 639px) {
  .pulse-kpi { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@container (min-width: 640px) {
  .inbox:has(> #col-attention[data-empty]) { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .inbox:has(> #col-attention[data-empty]) > #col-attention { grid-column: 1 / -1; flex-direction: row; align-items: center; justify-content: space-between; padding: var(--sp-1) var(--sp-3); }
  .inbox:has(> #col-attention[data-empty]) > #col-attention :is(.col-head, .col-empty-wrap) { padding: 0; }
  .inbox:has(> #col-attention[data-empty]) > #col-attention .col-empty { font-size: var(--fs-caption); font-weight: 400; color: var(--c-text-3); }
  .inbox:has(> #col-attention[data-empty]) > #col-attention .col-empty-sub { display: none; }
}

[data-card="cost"] .limit-row { cursor: pointer; padding: 2px var(--sp-1); border-radius: var(--r-s); }
[data-card="cost"] .limit-row:hover { background: var(--c-hover); }
[data-card="cost"] .limit-row.is-active { background: var(--c-info-tint); }
[data-card="cost"] .meter { position: relative; overflow: visible; }
[data-card="cost"] .meter i { border-radius: inherit; }
.cost-avg { position: absolute; top: -2px; bottom: -2px; width: 0; border-left: 1.5px dashed var(--c-text-2); pointer-events: none; }
.cost-meta { display: flex; align-items: center; justify-content: space-between; font-size: var(--fs-caption); color: var(--c-text-3); }

@media (max-width: 1023px) {
  .hint-bar { display: none; }
  .toast, .stale { bottom: calc(64px + env(safe-area-inset-bottom)); }
  .event-stack { bottom: calc(116px + env(safe-area-inset-bottom)); }
  .topbar { gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); }
  .crumbs { order: 1; }
  .top-tools { order: 2; margin-left: auto; }
  .status-pop { order: 3; flex: 0 1 auto; position: static; }
  .limits-pop { order: 4; margin-left: auto; }
  .status-pop[open] > .status-chips {
    position: fixed; top: 76px; left: var(--page-x); right: var(--page-x); max-width: none;
  }
  .view { padding-bottom: calc(74px + env(safe-area-inset-bottom)); }
  .sidenav {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 25;
    display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 2px;
    padding: var(--sp-1) var(--sp-1) calc(var(--sp-1) + env(safe-area-inset-bottom));
    border-top: 1px solid var(--c-line); background: var(--c-surface);
  }
  body.detail-open .sidenav { display: none; }
  .sidenav > .nav-item {
    position: relative; flex-direction: column; justify-content: center; gap: 2px;
    height: 48px; padding: 4px 2px; border: 0; border-radius: var(--r-m);
    background: transparent; font-size: 11px; line-height: 1.15;
  }
  .sidenav > .nav-item > span:first-of-type { flex: 0 0 auto; }
  .sidenav > .nav-item[aria-current="page"] { background: var(--c-bg); color: var(--c-text-1); }
  .sidenav > .nav-item .nav-count {
    position: absolute; top: 3px; right: 6px; min-width: 15px; height: 15px; padding: 0 3px; font-size: 10px;
  }
  .nav-sheet { display: none; }
  .nav-more-btn { display: inline-flex; }
  .sidenav.is-more-open .nav-sheet {
    position: fixed; left: var(--sp-2); right: var(--sp-2); z-index: 26;
    bottom: calc(60px + env(safe-area-inset-bottom));
    display: flex; flex-direction: column; gap: var(--sp-1); padding: var(--sp-2);
    border: 1px solid var(--c-line-strong); border-radius: var(--r-l);
    background: var(--c-surface); box-shadow: 0 8px 24px rgb(0 0 0 / 0.18);
  }
  .nav-sheet .nav-item { justify-content: space-between; height: 38px; padding: 0 var(--sp-3); border-radius: var(--r-m); }
  .nav-sheet .nav-foot { margin-top: var(--sp-1); padding-top: var(--sp-2); border-top: 1px solid var(--c-line); }
  .nav-sheet .nav-help { display: none; }
}
@media (max-width: 639px) {
  .status-pop[open] > .status-chips { top: 82px; }
}

.dash-home, .dash-main, .dash-rail { display: flex; flex-direction: column; gap: var(--stack-m); min-width: 0; }
@container (min-width: 1120px) {
  .dash-home.has-rail { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: var(--stack-m); align-items: start; }
  .dash-rail { position: sticky; top: 0; }
}
.rail-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); font-size: var(--fs-caption); font-weight: 700; color: var(--c-text-2); }
.rail-live { display: inline-flex; align-items: center; gap: var(--sp-1); color: var(--c-text-3); font-variant-numeric: tabular-nums; }
.rail-card, .quota-card, .active-card { display: flex; flex-direction: column; gap: var(--sp-2); min-width: 0; padding: var(--sp-2) var(--sp-3); border: 1px solid var(--c-line); border-radius: var(--r-l); background: var(--c-surface); }
.rail-card-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); font-size: var(--fs-sub); }
.rail-link { font-size: var(--fs-caption); font-weight: 600; color: var(--c-brand-text); }
.rail-link:hover { text-decoration: underline; }
.rail-peers { display: flex; flex-direction: column; gap: var(--sp-1); }
.rail-peer { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); font-size: var(--fs-caption); }
.rail-peer-name { display: inline-flex; align-items: center; gap: var(--sp-1); white-space: nowrap; }
.rail-peer-meta { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-text-3); }
.res-list { display: flex; flex-direction: column; gap: var(--sp-2); }
.res-item { display: flex; flex-direction: column; gap: 3px; }
.res-top { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); font-size: var(--fs-caption); color: var(--c-text-2); font-variant-numeric: tabular-nums; }
.res-top b { color: var(--c-text-1); }
.res-item .meter { width: 100%; max-width: none; height: 6px; border-radius: var(--r-pill); }
.res-item.is-warn .meter i { background: var(--c-warning-tint-text); }
.res-item.is-danger .meter i { background: var(--c-danger); }
.res-sub { font-size: var(--fs-caption); color: var(--c-text-3); font-variant-numeric: tabular-nums; }
.quota-sec, .active-sec { display: flex; flex-direction: column; gap: var(--sp-2); }
.quota-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: var(--sp-2); }
.quota-card { border-left: 3px solid var(--c-success-tint-text); gap: var(--sp-1); }
.quota-card.is-warn { border-left-color: var(--c-warning-tint-text); }
.quota-card.is-danger { border-left-color: var(--c-danger); }
.quota-card.is-failed { border-left-color: var(--c-line-strong); color: var(--c-text-3); }
.quota-head { display: flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-sub); min-width: 0; }
.quota-head b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.quota-tag { margin-left: auto; padding: 0 var(--sp-1); border-radius: var(--r-s); background: var(--c-bg); color: var(--c-text-3); font-size: 10.5px; }
.quota-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(44px, 68px) 2.8em 3.6em; align-items: center; gap: var(--sp-1); font-size: var(--fs-caption); font-variant-numeric: tabular-nums; }
.quota-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-text-2); }
.quota-row .meter { max-width: none; height: 6px; border-radius: var(--r-pill); }
.quota-row.is-warn .meter i { background: var(--c-warning-tint-text); }
.quota-row.is-danger .meter i { background: var(--c-danger); }
.quota-pct { text-align: right; }
.quota-row.is-warn .quota-pct { color: var(--c-warning-tint-text); }
.quota-row.is-danger .quota-pct { color: var(--c-danger); }
.quota-reset { text-align: right; color: var(--c-text-3); white-space: nowrap; }
.active-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-2); }
@container (max-width: 639px) { .active-grid { grid-template-columns: minmax(0, 1fr); } }
.active-card { gap: var(--sp-1); transition: border-color var(--dur-fast) ease, background-color var(--dur-fast) ease; }
.active-card:hover { border-color: var(--c-line-strong); background: var(--c-hover); }
.active-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); }
.active-age { display: inline-flex; align-items: center; gap: var(--sp-1); flex: none; }
.active-title { font-size: var(--fs-strong); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.active-ctx { display: flex; align-items: center; gap: var(--sp-2); margin-top: 2px; font-variant-numeric: tabular-nums; }
.active-ctx .meter { flex: 1; max-width: none; height: 6px; border-radius: var(--r-pill); }
.active-ctx.is-warn .meter i { background: var(--c-warning-tint-text); }
.active-ctx.is-danger .meter i { background: var(--c-danger); }
.ctx-ratio { flex: none; font-size: var(--fs-caption); font-weight: 600; color: var(--c-text-2); white-space: nowrap; }
`;
