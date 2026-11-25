import { gateHandoff } from "../dispatch/tool";
import { taskOriginKey } from "../lanes/status";
import { STAMP_PATTERN } from "../ops/apply-lock";
import { followupTask } from "../tasks/dispatch";
import { handleWebIpc } from "../web/ipc";
import type { DaemonContext } from "./daemon-context";
import { controlTaskFrom, noticeWebIntervention } from "./daemon-sink";
import type { DaemonTaskLanding } from "./daemon-task-land";
import { taskRuntimeOf } from "./daemon-task-resume";
import type { InjectRequest, InjectResult } from "./daemon-types";
import type { ReloadResult } from "./reload";
import type { DrainCounts, StatusReport } from "./status";

/** The daemon's own operations an IPC request reaches (the public methods of `Daemon`). */
export interface DaemonIpcHost {
	status(): StatusReport;
	reloadConfig(trigger: "ipc" | "sighup"): ReloadResult;
	setDraining(on: boolean): void;
	drainCounts(): DrainCounts;
	drainCut(applyStamp: string): Promise<{ ok: true; opRefs: number; approvals: number } | { ok: false; error: string }>;
	inject(request: InjectRequest): Promise<InjectResult>;
	notify(request: {
		origin: string;
		text: string;
		thread?: string | undefined;
		stamp?: string | undefined;
	}): { ok: true; opRef: string } | { ok: false; error: string };
	controlTask(taskId: string, control: "pause" | "resume"): Promise<{ ok: boolean; text: string }>;
}

/** `jabbu-pocket lanes attach`: hand a lane session to terminal omp (`lane_attach`) and back (`lane_detach`). */
async function laneAttachIpc(ctx: DaemonContext, request: Record<string, unknown>): Promise<unknown> {
	const lanes = ctx.lanes;
	if (lanes === undefined) return { ok: false, error: "lanes are not running" };
	const lane = request.lane;
	if (typeof lane !== "string") return { ok: false, error: `${String(request.op)} needs a lane string` };
	if (request.op === "lane_attach") {
		const pid = request.pid;
		if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
			return { ok: false, error: "lane_attach needs a pid" };
		}
		return lanes.attach(lane, { pid, wait: request.wait === true, keepPaused: request.keepPaused === true });
	}
	const { sessionFile, newFiles } = request;
	if (
		typeof sessionFile !== "string" ||
		!Array.isArray(newFiles) ||
		!newFiles.every((file): file is string => typeof file === "string")
	) {
		return { ok: false, error: "lane_detach needs sessionFile and newFiles" };
	}
	const outcome = await lanes.detach(lane, { sessionFile, newFiles, by: "cli" });
	return outcome.handled ? { ok: true, text: outcome.text } : { ok: false, error: outcome.text };
}

/** The web body limit (`MAX_POST_BODY_BYTES` of the web router): a follow-up is never longer than its request. */
const WEB_FOLLOWUP_MAX_BYTES = 64 * 1024;
/** Control characters other than newline and tab. */
const FOLLOWUP_CONTROL = /[^\P{Cc}\n\t]/u;
const HERDR_REFUSED = (taskId: string): string =>
	`${taskId}는 herdr 작업이라 웹에서 개입하지 않습니다(디스코드나 herdr에서 하세요)`;

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

/**
 * `task_followup {id, text}`: the dashboard's 지시 넣기 on a headless [TASK], the tool's own `followupTask` with
 * `source: "web"`. A frozen bot keeps the row pending (an autonomous row) and says it waits; the answer is `{ok, text}`.
 */
async function taskFollowupIpc(ctx: DaemonContext, request: Record<string, unknown>): Promise<unknown> {
	const ledger = ctx.store?.tasks;
	const id = request.id;
	const row = typeof id === "string" ? ledger?.get(id) : undefined;
	if (ledger === undefined || row === undefined)
		return { ok: false, error: "task_not_found", text: `TASK를 찾지 못했습니다: ${String(id)}` };
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

export async function handleIpc(
	ctx: DaemonContext,
	daemon: DaemonIpcHost,
	landing: DaemonTaskLanding,
	request: unknown,
): Promise<unknown> {
	if (typeof request !== "object" || request === null || !("op" in request)) {
		return { ok: false, error: "invalid request" };
	}
	if (request.op === "status") return { ok: true, status: daemon.status() };
	if (request.op === "live") {
		const origin = "origin" in request ? request.origin : undefined;
		return { ok: true, live: typeof origin === "string" ? (ctx.router?.liveView(origin) ?? null) : null };
	}
	if (request.op === "session_file") {
		// `jabbu-pocket lanes watch`: the file the origin's running child has open; null when no child runs (read-only).
		const origin = "origin" in request ? request.origin : undefined;
		if (typeof origin !== "string") return { ok: false, error: "session_file needs an origin string" };
		return { ok: true, sessionFile: (await ctx.router?.openSessionFile(origin)) ?? null };
	}
	if (request.op === "lane_attach" || request.op === "lane_detach") return laneAttachIpc(ctx, request);
	if (request.op === "web_send" || request.op === "web_action" || request.op === "web_new") {
		return handleWebIpc(ctx, request as Record<string, unknown>);
	}
	if (request.op === "reload") return daemon.reloadConfig("ipc");
	if (request.op === "drain" || request.op === "drain_status" || request.op === "drain_cancel") {
		if (request.op !== "drain_status") daemon.setDraining(request.op === "drain");
		return { ok: true, draining: ctx.router?.draining ?? false, ...daemon.drainCounts() };
	}
	if (request.op === "drain_cut") {
		const stamp = "applyStamp" in request && typeof request.applyStamp === "string" ? request.applyStamp : "";
		return daemon.drainCut(stamp);
	}
	if (request.op === "inject") {
		const text = "text" in request ? request.text : undefined;
		const origin = "origin" in request ? request.origin : undefined;
		const quoted = "quoted" in request ? request.quoted : undefined;
		const thread = "thread" in request ? request.thread : undefined;
		if (
			typeof text !== "string" ||
			typeof origin !== "string" ||
			(quoted !== undefined && typeof quoted !== "string") ||
			(thread !== undefined && typeof thread !== "string")
		) {
			return { ok: false, error: "inject needs origin and text strings" };
		}
		const asOwner = "asOwner" in request && request.asOwner === true;
		return { ok: true, ...(await daemon.inject({ origin, asOwner, text, quoted, thread })) };
	}
	if (request.op === "notify") {
		const origin = "origin" in request ? request.origin : undefined;
		const thread = "thread" in request ? request.thread : undefined;
		const text = "text" in request ? request.text : undefined;
		const stamp = "stamp" in request ? request.stamp : undefined;
		if (
			typeof origin !== "string" ||
			typeof text !== "string" ||
			(thread !== undefined && typeof thread !== "string") ||
			(stamp !== undefined && (typeof stamp !== "string" || !STAMP_PATTERN.test(stamp)))
		) {
			return { ok: false, error: "notify needs origin and text strings (thread and stamp optional)" };
		}
		return daemon.notify({ origin, text, thread, stamp });
	}
	if (request.op === "task_followup") return taskFollowupIpc(ctx, request as Record<string, unknown>);
	if (request.op === "tasks_pause" || request.op === "tasks_resume") {
		const id = "id" in request ? request.id : undefined;
		const row = typeof id === "string" ? ctx.store?.tasks.get(id) : undefined;
		if (row === undefined) return { ok: false, error: "task not found" };
		const control = request.op === "tasks_pause" ? "pause" : "resume";
		if (!("source" in request) || request.source !== "web") return daemon.controlTask(row.taskId, control);
		// The dashboard's 작업 내역 panel: headless rows only, the log lines marked and the thread told.
		if (row.runtime !== "headless") return { ok: false, error: "herdr_task", text: HERDR_REFUSED(row.taskId) };
		// A resume of a task that was not paused changes nothing: no thread notice for it.
		const changes = control === "pause" || ctx.store?.tasks.isPaused(row) === true;
		const result = await controlTaskFrom("web", () => daemon.controlTask(row.taskId, control));
		if (result.ok && changes) noticeWebIntervention(ctx, row, { kind: control });
		return result.ok ? result : { ...result, error: "task_control_refused" };
	}
	if (request.op === "tasks_check" || request.op === "tasks_sync") {
		const id = "id" in request ? request.id : undefined;
		const row = typeof id === "string" ? ctx.store?.tasks.get(id) : undefined;
		if (request.op === "tasks_sync" && row !== undefined) await ctx.wikiNotes?.taskDone(row.taskId);
		if (row === undefined || ctx.taskSweeper === undefined) return { ok: false, error: "task not found" };
		if (request.op === "tasks_sync") {
			const ok = await ctx.taskSweeper.syncReaction(row.taskId);
			const status = ctx.store?.tasks.get(row.taskId)?.status;
			if (status === "done" || status === "cancelled") await landing.closeTaskAgent(row);
			return { ok };
		}
		return { ok: true, ...(await ctx.taskSweeper.check(row)) };
	}
	return { ok: false, error: `unknown op` };
}
