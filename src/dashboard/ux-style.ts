/**
 * P0–P2 UX benchmark styles layered after `STYLE` and `TASK_WORK_STYLE` in `assets.ts`.
 * Reuses `--c-*` light/dark WCAG AA tokens and keeps all animations gated by `prefers-reduced-motion`.
 */
export const UX_STYLE = `
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
.card.is-next { background: color-mix(in srgb, var(--c-warning-tint) 42%, var(--c-surface)); }
.card.trow.is-done { color: var(--c-text-2); }
.card.trow.is-done .t1 { font-weight: 500; }

@media (max-width: 1023px) {
  .hint-bar { display: none; }
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
  .sidenav > a[data-view="lanes"],
  .sidenav > a[data-view="monitors"],
  .sidenav > a[data-view="alerts"],
  .sidenav > a[data-view="system"],
  .sidenav > .nav-foot { display: none; }
  .nav-more-btn { display: inline-flex; }
  .sidenav.is-more-open > a[data-view="lanes"],
  .sidenav.is-more-open > a[data-view="monitors"],
  .sidenav.is-more-open > a[data-view="alerts"],
  .sidenav.is-more-open > a[data-view="system"] {
    display: inline-flex; flex-direction: row; justify-content: space-between;
    position: fixed; left: var(--sp-2); right: var(--sp-2); height: 40px; padding: 0 var(--sp-3);
    border: 1px solid var(--c-line); border-radius: var(--r-m); background: var(--c-surface);
    font-size: var(--fs-sub); box-shadow: 0 6px 20px rgb(0 0 0 / 0.16);
  }
  .sidenav.is-more-open > a[data-view="lanes"] .nav-count,
  .sidenav.is-more-open > a[data-view="monitors"] .nav-count,
  .sidenav.is-more-open > a[data-view="alerts"] .nav-count,
  .sidenav.is-more-open > a[data-view="system"] .nav-count { position: static; }
  .sidenav.is-more-open > a[data-view="lanes"] { bottom: calc(238px + env(safe-area-inset-bottom)); }
  .sidenav.is-more-open > a[data-view="monitors"] { bottom: calc(194px + env(safe-area-inset-bottom)); }
  .sidenav.is-more-open > a[data-view="alerts"] { bottom: calc(150px + env(safe-area-inset-bottom)); }
  .sidenav.is-more-open > a[data-view="system"] { bottom: calc(106px + env(safe-area-inset-bottom)); }
  .sidenav.is-more-open > .nav-foot {
    display: flex; position: fixed; left: var(--sp-2); right: var(--sp-2);
    bottom: calc(60px + env(safe-area-inset-bottom)); padding: var(--sp-2);
    border: 1px solid var(--c-line); border-radius: var(--r-m); background: var(--c-surface);
    box-shadow: 0 6px 20px rgb(0 0 0 / 0.16);
  }
  .sidenav.is-more-open > .nav-foot .nav-help { display: none; }
}
@media (max-width: 639px) {
  .status-pop[open] > .status-chips { top: 82px; }
}
`;
