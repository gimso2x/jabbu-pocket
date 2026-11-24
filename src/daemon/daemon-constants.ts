export const MEDIA_SWEEP_INTERVAL_MS = 60 * 60_000;
/** How often the wiki note of a finished conversation day or turn is looked for (`WikiNotes.flushTurns`). */
export const WIKI_FLUSH_MS = 60_000;

/** KV-cursor prefixes of a thread's peer hop cap: the last owner message and the notice already posted. */
export const PEER_HOP_RESET_CURSOR = "peerhop-reset:";
export const PEER_HOP_NOTICE_CURSOR = "peerhop-notice:";

/** A plain message while 2+ choice cards of the conversation wait: it is not taken as an answer (`dialogs.ambiguous`). */
export const DIALOG_AMBIGUOUS_NOTICE =
	"❓ 답을 기다리는 질문 카드가 여러 개라 이 메시지는 답으로 쓰지 않았습니다 — 답할 질문 카드의 스레드에 답장해 주세요(또는 버튼)";
/** Gate sweep cadence of the self-diagnosis loop (0 disables it). */
export const DEFAULT_GATE_SWEEP_MS = 5 * 60_000;
/**
 * Consecutive closed sweeps after an alerted gate closes before its incident is resolved (15 minutes at
 * the default sweep), so a recurrence after that alerts again. A shorter flap keeps the 24h suppression. Known gap:
 * restarting before the third closed sweep resolves the incident at boot instead, so a flap spanning a restart can
 * re-alert inside 24h — rare, and one extra notice.
 */
export const GATE_RESOLVE_CLOSED_SWEEPS = 3;
/** Owner DM turns between background skill reviews (0 in config disables them). */
export const DEFAULT_SKILL_REVIEW_TURNS = 10;
/**
 * How long stop() waits for running turns to settle before stopping the omp children: a turn that finishes in
 * time records its own answer, so the restart's recovery finds it instead of reporting `interrupted_by_restart`.
 * Budget note: the waits before the drain (adapter stop, pump, monitors idle) are unbounded and the drain itself
 * is 20s. The packaged unit (packaging/ompbot.service) sets TimeoutStopSec=90 with KillMode=mixed: only the main
 * process gets SIGTERM, the daemon stops its omp children itself, and leftover processes get
 * SIGKILL as soon as the main process exits, or together with it once TimeoutStopSec expires. Check a deployed unit with `systemctl --user show ompbot -p TimeoutStopUSec -p KillMode`.
 */
export const STOP_DRAIN_MS = 20_000;

/**
 * Age of a pending inbound row that makes the sweep re-run its origin's `resumePending` — the same number is the
 * per-origin retry interval, so a stranded row is re-drained about once a minute until it moves; 0 disables the
 * retry (a test-only slim, not wired to any production config — the daemon always keeps the default).
 */
export const PENDING_RETRY_MS = 60_000;
/** Consecutive failed sweep retries before the owner is told once (24h repeat suppression via the incident machine). */
export const PENDING_ALERT_AFTER = 3;

/** Ephemeral answer to a slash command typed during a restart drain (recorded; the next process runs it). */
export const LANE_DRAIN_REFUSED_TEXT =
	"재시작 준비 중이라 작업 레인을 시작하지 않았습니다. 재시작이 끝난 뒤 같은 메시지를 다시 보내 주세요.";
export const DRAIN_DEFERRED_COMMAND_TEXT = "재시작 준비 중이라 재시작 뒤에 처리합니다. 다시 보내지 않아도 됩니다.";

/**
 * Gates that close because their evidence window elapsed (`turns_failing` 1h, `monitors_failed` 24h), not because
 * the problem was fixed: the bot may still be broken, so their close is bookkeeping only — never a recovery DM. The
 * incident row is still resolved like any other gate's, so a recurrence alerts again.
 */
export const WINDOW_GATES = new Set(["turns_failing", "monitors_failed"]);

/** Card note when a `머지` click could not reach the task thread: the owner answers by hand instead. */
export const MERGE_REJECTED_NOTE = '⚠️ 머지 요청을 넣지 못함 — 스레드에 "머지해"라고 답해 주세요';
/** Card note of a `머지` click while the task holds its landing lock (`#taskLanding`). */
export const TASK_LANDING_NOTE = "이미 착지 중";
/** Card note when a `추천대로` click could not reach the task thread. */
export const RECOMMEND_REJECTED_NOTE = '⚠️ 추천을 넣지 못함 — 스레드에 "추천대로"라고 답해 주세요';
/** The owner text and marker of an auto-merge (`taskAutoLand`): the landing starts exactly as after a typed "머지해". */
export const AUTO_LAND_TEXT = "머지해 (자동: Outcome 도달·재실행 검사 통과)";
export const AUTO_LAND_MARKER = "🤖 자동 머지";
