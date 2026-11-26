import { AsyncLocalStorage } from "node:async_hooks";
import { gateHandoff } from "../dispatch/tool";
import { taskOriginKey } from "../lanes/status";
import type { LogFields } from "../log";
import { redact } from "../redact";
import { followupTask } from "../tasks/followup";
import type { TaskRow } from "../tasks/ledger";
import { postToThread } from "../tasks/notify";
import { handleWebIpc } from "../web/ipc";
import type { DaemonContext } from "./daemon-context";
import type { DaemonIpcHost } from "./daemon-ipc";
import { taskRuntimeOf } from "./daemon-task-resume";

/**
 * The dashboard's 작업 내역 panel on the daemon side: IPC `task_followup {id, text}` and `tasks_pause|tasks_resume
 * {id, source: "web"}` — the same `followupTask` and `controlTask` a chat uses, marked as the web's and told to the
 * task's report thread. Headless rows only (a herdr row is not intervened in from the web).
 */

/** The web body limit (`MAX_POST_BODY_BYTES` of the web router): a follow-up is never longer than its request. */
const WEB_FOLLOWUP_MAX_BYTES = 64 * 1024;
/** Control characters other than newline and tab. */
const FOLLOWUP_CONTROL = /[^\P{Cc}\n\t]/u;
const HERDR_REFUSED = (taskId: string): string =>
	`${taskId}는 herdr 작업이라 웹에서 개입하지 않습니다(디스코드나 herdr에서 하세요)`;
/** How much of a dashboard follow-up the thread notice quotes (redacted first, then cut). */
const WEB_NOTICE_QUOTE_CHARS = 80;

/** The source of the `controlTask` call in progress: `Daemon.controlTask` keeps its two arguments, the IPC sets this. */
const controlSource = new AsyncLocalStorage<"web">();

/** `fields` of a pause/resume log line, with `source: "web"` while the dashboard's call runs. */
export function withControlSource(fields: LogFields): LogFields {
	const source = controlSource.getStore();
	return source === undefined ? fields : { ...fields, source };
}

/** Whether an IPC request is one of the panel's: `task_followup`, or a pause/resume marked `source: "web"`. */
function isWebTaskRequest(request: object): boolean {
	const { op, source } = request as Record<string, unknown>;
	return op === "task_followup" || ((op === "tasks_pause" || op === "tasks_resume") && source === "web");
}

/**
 * One line in the [TASK]'s report thread for an intervention made on the dashboard: sent without waiting (the HTTP
 * answer never waits for it), a failure only logged as `task_web_notice_failed`.
 */
function noticeWebIntervention(
	ctx: DaemonContext,
	row: TaskRow,
	what: { kind: "followup"; text: string } | { kind: "pause" | "resume" },
): void {
	const line =
		what.kind === "followup"
			? `🌐 웹에서 ${row.taskId} 지시 넣음: ${redact(what.text).replace(/\s+/g, " ").trim().slice(0, WEB_NOTICE_QUOTE_CHARS)}`
			: `🌐 웹에서 ${row.taskId} ${what.kind === "pause" ? "멈춤" : "재개"}`;
	const failed = (error?: unknown): void =>
		ctx.log.warn("task_web_notice_failed", {
			task: row.taskId,
			kind: what.kind,
			...(error === undefined ? {} : { error: String(error) }),
		});
	void postToThread(ctx.channels, ctx.log, row.threadRef, line).then((posted) => {
		if (!posted) failed();
	}, failed);
}

/** Why a dashboard follow-up text cannot go to a worker as it is; undefined when it can. */
function followupTextProblem(text: unknown): { error: string; text: string } | undefined {
	if (typeof text !== "string" || text.trim() === "") return { error: "empty_text", text: "빈 지시는 보내지 않습니다" };
	if (FOLLOWUP_CONTROL.test(text))
		return { error: "control_chars", text: "지시에 제어문자가 들어 있습니다(개행·탭만 됩니다)" };
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes > WEB_FOLLOWUP_MAX_BYTES)
		return { error: "text_too_long", text: `지시가 너무 깁니다(${bytes}바이트, 상한 ${WEB_FOLLOWUP_MAX_BYTES})` };
	return undefined;
}

/** The web's IPC ops: the chat's (`web_send|web_action|web_new`) and the panel's; `undefined` = not a web request. */
export async function webIpc(
	ctx: DaemonContext,
	daemon: Pick<DaemonIpcHost, "controlTask">,
	request: object,
): Promise<unknown> {
	const { op } = request as Record<string, unknown>;
	if (op === "web_send" || op === "web_action" || op === "web_new") {
		return handleWebIpc(ctx, request as Record<string, unknown>);
	}
	return isWebTaskRequest(request) ? webTaskIpc(ctx, daemon, request) : undefined;
}

/**
 * The panel's IPC ops. `task_followup`: the tool's own `followupTask` with `source: "web"`; a frozen bot keeps the row
 * pending (an autonomous row) and says it waits. Pause/resume: `controlTask` with its log lines marked. `{ok, text}`.
 */
async function webTaskIpc(
	ctx: DaemonContext,
	daemon: Pick<DaemonIpcHost, "controlTask">,
	raw: object,
): Promise<unknown> {
	const request = raw as Record<string, unknown>;
	const ledger = ctx.store?.tasks;
	const id = request.id;
	const row = typeof id === "string" ? ledger?.get(id) : undefined;
	if (ledger === undefined || row === undefined)
		return { ok: false, error: "task_not_found", text: `TASK를 찾지 못했습니다: ${String(id)}` };
	if (request.op !== "task_followup") {
		if (row.runtime !== "headless") return { ok: false, error: "herdr_task", text: HERDR_REFUSED(row.taskId) };
		const control = request.op === "tasks_pause" ? "pause" : "resume";
		// A resume of a task that was not paused changes nothing: no thread notice for it.
		const changes = control === "pause" || ledger.isPaused(row);
		const result = await controlSource.run("web", () => daemon.controlTask(row.taskId, control));
		if (result.ok && changes) noticeWebIntervention(ctx, row, { kind: control });
		// `paused` is the ledger re-read after the control, so the dashboard shows the state the server holds.
		return result.ok
			? { ...result, paused: ledger.isPaused(ledger.require(row.taskId)) }
			: { ...result, error: "task_control_refused" };
	}
	const problem = followupTextProblem(request.text);
	if (problem !== undefined) return { ok: false, ...problem };
	const text = request.text as string;
	if (row.status === "done" || row.status === "cancelled")
		return { ok: false, error: "task_closed", text: `${row.taskId}는 이미 ${row.status}로 닫힌 작업입니다` };
	if (row.runtime !== "headless") return { ok: false, error: "herdr_task", text: HERDR_REFUSED(row.taskId) };
	const origin = taskOriginKey(row.agent);
	let result: { ok: boolean; text: string };
	try {
		result = await followupTask(
			{
				ledger,
				runtime: (r) => taskRuntimeOf(ctx, r),
				// No owner card on this path: a high_risk text is refused (`no_approver`) like a tool call without one.
				gate: (brief) => gateHandoff({ originKey: origin, log: ctx.log }, brief, new AbortController().signal),
				originKey: null,
				recordPrompt: (input) => ctx.store?.recordHerdrPrompt(input),
				log: ctx.log,
			},
			{ id: row.taskId, text, source: "web" },
		);
	} catch (error) {
		return { ok: false, error: "followup_refused", text: error instanceof Error ? error.message : String(error) };
	}
	if (!result.ok) return { ok: false, error: "followup_failed", text: result.text };
	noticeWebIntervention(ctx, row, { kind: "followup", text });
	return ctx.frozen() === undefined
		? result
		: { ok: true, text: `동결 중이라 대기합니다 — 풀리면 ${row.taskId} 워커에 전달됩니다.` };
}
