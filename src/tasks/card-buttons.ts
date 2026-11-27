import type { ActionButton } from "../channel/port";
import { cutCodePointSafe } from "../channel/text";
import { redact } from "../redact";
import type { TaskRow } from "./ledger";

/**
 * A task notice as a card: `text` is the whole notice as one string (notifications, block-less clients, the dashboard
 * and logs), `title`/`body`/`fields`/`buttons`/`note` what the card shows.
 */
export interface TaskCard {
	text: string;
	title: string;
	body: string;
	fields?: ReadonlyArray<{ label: string; value: string }>;
	buttons?: readonly ActionButton[];
	/** The small grey line under the card. */
	note?: string;
}

export const hostLabelOf = (row: Pick<TaskRow, "host">): string => row.host ?? "local";

/** `local/t-20261030-01 · T-20261030-01`: where the agent runs and which task it carries. */
export const ownerTag = (row: TaskRow): string => `${hostLabelOf(row)}/${row.agent} · ${row.taskId}`;

export const branchField = (row: TaskRow) => ({ label: "브랜치", value: `\`${row.branch}\`` });
export const workerField = (row: TaskRow) => ({ label: "워커", value: ownerTag(row) });

/** Button ids of a card's `머지`, `추천대로`, and `취소` buttons; the task id carries no colon. */
const TASK_MERGE_ACTION_PREFIX = "jabbu:task:merge:";
const TASK_RECOMMEND_ACTION_PREFIX = "jabbu:task:recommend:";
const TASK_CANCEL_ACTION_PREFIX = "jabbu:task:cancel:";
const TASK_CANCEL_CONFIRM_ACTION_PREFIX = "jabbu:task:cancel-confirm:";
const TASK_CANCEL_KEEP_ACTION_PREFIX = "jabbu:task:cancel-keep:";
const TASK_ID = /^T-\d{8}-\d{2,}$/;

export const taskMergeActionId = (taskId: string): string => `${TASK_MERGE_ACTION_PREFIX}${taskId}`;
export const taskRecommendActionId = (taskId: string): string => `${TASK_RECOMMEND_ACTION_PREFIX}${taskId}`;
export const taskCancelActionId = (taskId: string): string => `${TASK_CANCEL_ACTION_PREFIX}${taskId}`;
export const taskCancelConfirmActionId = (taskId: string): string => `${TASK_CANCEL_CONFIRM_ACTION_PREFIX}${taskId}`;
export const taskCancelKeepActionId = (taskId: string): string => `${TASK_CANCEL_KEEP_ACTION_PREFIX}${taskId}`;

/** The task id behind `prefix` in a button click; `undefined` for any other action id. */
function taskIdOf(actionId: string, prefix: string): string | undefined {
	if (!actionId.startsWith(prefix)) return undefined;
	const taskId = actionId.slice(prefix.length);
	return TASK_ID.test(taskId) ? taskId : undefined;
}

/** The task id of a `머지` button click; `undefined` for any other action id. */
export const parseTaskMergeActionId = (actionId: string): string | undefined =>
	taskIdOf(actionId, TASK_MERGE_ACTION_PREFIX);

/** The task id of a `추천대로` button click; `undefined` for any other action id. */
export const parseTaskRecommendActionId = (actionId: string): string | undefined =>
	taskIdOf(actionId, TASK_RECOMMEND_ACTION_PREFIX);

export interface TaskCancelAction {
	kind: "prompt" | "confirm" | "keep";
	taskId: string;
}

/** Parses a `취소` / `취소 확정` / `유지` button click; `undefined` for any other action id. */
export function parseTaskCancelAction(actionId: string): TaskCancelAction | undefined {
	const confirmId = taskIdOf(actionId, TASK_CANCEL_CONFIRM_ACTION_PREFIX);
	if (confirmId !== undefined) return { kind: "confirm", taskId: confirmId };
	const keepId = taskIdOf(actionId, TASK_CANCEL_KEEP_ACTION_PREFIX);
	if (keepId !== undefined) return { kind: "keep", taskId: keepId };
	const promptId = taskIdOf(actionId, TASK_CANCEL_ACTION_PREFIX);
	if (promptId !== undefined) return { kind: "prompt", taskId: promptId };
	return undefined;
}

/** What one click on `머지` (`PR 올리기` where the repository lands through a PR) does: the same as answering "머지해". */
export const MERGE_NOTE = "머지 = close → ff merge → push → 정리 · 재시작은 포함 안 됨";
export const PR_MERGE_LABEL = "PR 올리기";
export const PR_MERGE_NOTE = `${PR_MERGE_LABEL} = PR → CI 초록이면 squash 머지 → 정리 · 재시작은 포함 안 됨`;
/** What one click on `추천대로` does: the same as answering "추천대로" in the thread. */
export const RECOMMEND_NOTE = "추천대로 = 위 추천 그대로 진행 · 다른 결정은 이 스레드에 답장";
/** What the `취소` button warns: cancelling stops the task while leaving its worktree and branch intact. */
export const CANCEL_NOTE = "취소 = 작업 중단(워크트리·브랜치 보존)";
/** The recommendation a `추천대로` button carries in its `value` (redacted), so the click can say what it approved. */
export const RECOMMEND_VALUE_MAX = 300;

/** Origin card state carried through the `취소` → `유지` confirmation hop so original buttons and recommendation restore cleanly. */
export type CancelCardOrigin = { kind: "blocked"; recommend: string } | { kind: "merge" } | { kind: "pr" };

const BLOCKED_ORIGIN_PREFIX = "blocked:";

/** Serializes the origin card state into a redacted button payload. */
export function encodeCancelOrigin(origin: CancelCardOrigin): string {
	if (origin.kind === "merge" || origin.kind === "pr") return origin.kind;
	return `${BLOCKED_ORIGIN_PREFIX}${cutCodePointSafe(redact(origin.recommend), RECOMMEND_VALUE_MAX)}`;
}

/** Parses a stored cancel origin payload; `undefined` when missing or unrecognized. */
export function decodeCancelOrigin(value: string | undefined): CancelCardOrigin | undefined {
	if (value === "merge") return { kind: "merge" };
	if (value === "pr") return { kind: "pr" };
	if (value?.startsWith(BLOCKED_ORIGIN_PREFIX)) {
		const recommend = value
			.slice(BLOCKED_ORIGIN_PREFIX.length)
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, RECOMMEND_VALUE_MAX);
		return { kind: "blocked", recommend };
	}
	return undefined;
}

export const mergeButton = (row: TaskRow, prMode = false): ActionButton => ({
	actionId: taskMergeActionId(row.taskId),
	label: prMode ? PR_MERGE_LABEL : "머지",
	value: row.taskId,
	style: "primary",
});

export const recommendButton = (row: TaskRow, recommend: string): ActionButton => ({
	actionId: taskRecommendActionId(row.taskId),
	label: "추천대로",
	value: cutCodePointSafe(redact(recommend), RECOMMEND_VALUE_MAX),
	style: "primary",
});

export const cancelButton = (row: TaskRow, origin: CancelCardOrigin): ActionButton => ({
	actionId: taskCancelActionId(row.taskId),
	label: "취소",
	value: encodeCancelOrigin(origin),
	style: "danger",
});

/** Step-2 confirmation card shown after clicking `취소`: requires `취소 확정` or lets the owner return via `유지`. */
export function buildCancelConfirmCard(row: TaskRow, origin: CancelCardOrigin): TaskCard {
	const title = `⚠️ 취소 확인 · ${row.title}`;
	const body =
		"이 작업을 취소할까요?\n워커는 종료되고 워크트리·브랜치는 그대로 남습니다. 취소한 작업은 다시 열 수 없습니다.";
	return {
		text: `${title}\n${body}`,
		title,
		body,
		fields: [{ label: "상태", value: row.status }, branchField(row), workerField(row)],
		buttons: [
			{ actionId: taskCancelConfirmActionId(row.taskId), label: "취소 확정", value: row.taskId, style: "danger" },
			{ actionId: taskCancelKeepActionId(row.taskId), label: "유지", value: encodeCancelOrigin(origin) },
		],
		note: "취소 확정 = 작업 중단(복구 불가) · 유지 = 원래 카드로 돌아감",
	};
}

/** Card restored after clicking `유지` on the cancel confirmation card. */
export function buildCancelRestoredCard(row: TaskRow, origin: CancelCardOrigin | undefined): TaskCard {
	if (row.status === "blocked") {
		const recommend = origin?.kind === "blocked" ? origin.recommend : "";
		const title = `🚧 막힘 · ${row.title}`;
		const note =
			recommend === ""
				? "취소를 되돌렸습니다 · 스레드에서 결정하거나 취소할 수 있습니다"
				: "취소를 되돌렸습니다 · 추천대로 진행하거나 스레드에 답장해 주세요";
		return {
			text: `${title}\n${note}`,
			title,
			body: row.title,
			fields: [branchField(row), workerField(row)],
			buttons: [
				...(recommend === "" ? [] : [recommendButton(row, recommend)]),
				cancelButton(row, { kind: "blocked", recommend }),
			],
			note,
		};
	}
	if (row.status === "review") {
		const prMode = origin?.kind === "pr";
		const title = `🔍 머지 대기 · ${row.title}`;
		const note = prMode
			? "취소를 되돌렸습니다 · PR 올리기 또는 취소를 선택해 주세요"
			: "취소를 되돌렸습니다 · 머지하거나 취소할 수 있습니다";
		return {
			text: `${title}\n${note}`,
			title,
			body: row.title,
			fields: [{ label: "수락기준", value: `${row.acceptance.length}개` }, branchField(row), workerField(row)],
			buttons: [mergeButton(row, prMode), cancelButton(row, { kind: prMode ? "pr" : "merge" })],
			note,
		};
	}
	const title = `⏳ 작업 중 · ${row.title}`;
	const note = `취소를 되돌렸습니다 · 작업이 다시 진행 중입니다 (${row.status})`;
	return {
		text: `${title}\n${note}`,
		title,
		body: row.title,
		fields: [branchField(row), workerField(row)],
		buttons: [],
		note,
	};
}

/** Terminal card shown after cancellation completes or a cancel click meets an already closed/blocked task. */
export function buildCancelSettledCard(row: TaskRow, note: string): TaskCard {
	const title = `❌ 취소 · ${row.title}`;
	return {
		text: `${title}\n${note}`,
		title,
		body: row.title,
		fields: [branchField(row), workerField(row)],
		buttons: [],
		note,
	};
}
