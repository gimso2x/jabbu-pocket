import { STAMP_PATTERN } from "../ops/apply-lock";
import type { DaemonContext } from "./daemon-context";
import type { DaemonTaskLanding } from "./daemon-task-land";
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

/**
 * `ompbot lanes attach`: `lane_attach {lane, pid, wait?, keepPaused?}` hands the lane's session to the CLI's terminal
 * omp and answers the file to resume; `lane_detach {lane, sessionFile, newFiles}` gives it back. The request is the
 * signal — nothing is read from marker files or mtimes.
 */
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
		// `ompbot lanes watch`: the file the origin's running child has open; null when no child runs (read-only).
		const origin = "origin" in request ? request.origin : undefined;
		if (typeof origin !== "string") return { ok: false, error: "session_file needs an origin string" };
		return { ok: true, sessionFile: (await ctx.router?.openSessionFile(origin)) ?? null };
	}
	if (request.op === "lane_attach" || request.op === "lane_detach") return laneAttachIpc(ctx, request);
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
	if (request.op === "tasks_pause" || request.op === "tasks_resume") {
		const id = "id" in request ? request.id : undefined;
		if (typeof id !== "string" || ctx.store?.tasks.get(id) === undefined) return { ok: false, error: "task not found" };
		return daemon.controlTask(id, request.op === "tasks_pause" ? "pause" : "resume");
	}
	if (request.op === "tasks_check" || request.op === "tasks_sync") {
		const id = "id" in request ? request.id : undefined;
		const row = typeof id === "string" ? ctx.store?.tasks.get(id) : undefined;
		// `tasks close --as done` changed the ledger in the CLI process: this is where the daemon learns of it.
		if (request.op === "tasks_sync" && row !== undefined) await ctx.wikiNotes?.taskDone(row.taskId);
		if (row === undefined || ctx.taskSweeper === undefined) return { ok: false, error: "task not found" };
		if (request.op === "tasks_sync") {
			const ok = await ctx.taskSweeper.syncReaction(row.taskId);
			// A task closed in the CLI (a remote task's landing, a cancel) ends its worker here too.
			const status = ctx.store?.tasks.get(row.taskId)?.status;
			if (status === "done" || status === "cancelled") await landing.closeTaskAgent(row);
			return { ok };
		}
		return { ok: true, ...(await ctx.taskSweeper.check(row)) };
	}
	return { ok: false, error: `unknown op` };
}
