import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { previewLine } from "../core/preview-line";
import { type FlowTransition, taskFlowStatus, taskStage } from "../flow/task-flow";
import { redact } from "../redact";
import { laneDurationSamples, TURN_SAMPLE_LIMIT, TURN_SAMPLE_WINDOW_MS } from "../store/lane-duration";
import { type TypicalDuration, typicalDuration } from "../store/turn-duration";
import { evaluateTask } from "../tasks/evaluate";
import type { TaskHostOps } from "../tasks/host";
import { type ReadTask, readTaskSql, type TaskRow, type TaskSql } from "../tasks/ledger";
import { headlessStatusFromLedger } from "../tasks/runtime";
import { localIso } from "../time";
import type { PeerInstall } from "./peers";
import { taskTurnFields } from "./turn";
import {
	discordThreadHref,
	extractRepoName,
	FLOW_WINDOW_MS,
	type FlowChainInfo,
	type FlowStepInfo,
	type LaneInfo,
	originLabel,
	type TaskInfo,
	withTimeout,
} from "./work-types";

export { originLabel, withTimeout };

const ACTIVE_LAND_STATES = "'pending','pr-open','blocked','merged-not-pushed'";
const FLOW_NOW_MSG_CHARS = 70;

function tryRows<T>(db: Database, sql: string, ...params: Array<string | number>): T[] {
	try {
		return db.query(sql).all(...params) as T[];
	} catch (error) {
		if (error instanceof Error && /no such table/.test(error.message)) return [];
		throw error;
	}
}

const safeHttpsUrl = (raw: unknown): string | undefined =>
	typeof raw === "string" && raw.startsWith("https://") ? raw : undefined;

/** `origin_key -> redacted title` map for `turn-board` to display lane titles instead of initial prompts. */
export function readLaneTitleMap(db: Database): Map<string, string> {
	const map = new Map<string, string>();
	for (const row of tryRows<{ origin_key: string; title: string }>(db, "SELECT origin_key, title FROM lanes")) {
		const title = redact(row.title);
		if (title !== "") map.set(row.origin_key, title);
	}
	return map;
}

/** Registration to first `working → review` move (ms) of every TASK in the last 30 days, newest first, up to 200. */
export function taskDurationSamples(db: Database, now: number): number[] {
	return tryRows<{ ms: number }>(
		db,
		`SELECT MIN(tr.at) - t.created_at AS ms FROM task_transitions tr JOIN tasks t ON t.task_id = tr.task_id
		WHERE tr.from_status = 'working' AND tr.to_status = 'review'
		GROUP BY tr.task_id HAVING MIN(tr.at) >= ? ORDER BY MIN(tr.at) DESC LIMIT ?`,
		now - TURN_SAMPLE_WINDOW_MS,
		TURN_SAMPLE_LIMIT,
	).map((row) => row.ms);
}

function withPeerDb<T>(peer: PeerInstall, fn: (db: Database) => T): T | undefined {
	const dbPath = join(peer.home, "jabbu.db");
	if (!existsSync(dbPath)) return undefined;
	let peerDb: Database | undefined;
	try {
		peerDb = new Database(dbPath, { readonly: true, strict: true });
		return fn(peerDb);
	} catch {
		return undefined;
	} finally {
		peerDb?.close();
	}
}

interface LaneQueryRow {
	name: string;
	origin_key: string;
	title: string;
	status: string;
	cwd: string;
	created_at: number;
	updated_at: number;
	uncertain_count: number;
	evidence_file: string | null;
	evidence_sha256: string | null;
	land_state: string | null;
	pr_url: string | null;
	repo: string | null;
}

function readInstallLanes(
	db: Database,
	opts: { now: number; iso: (ms: number) => string; install?: string },
): Array<{ active: boolean; updatedAtMs: number; info: LaneInfo }> {
	const { now, iso, install } = opts;
	let laneTypical: TypicalDuration | undefined;
	try {
		laneTypical = typicalDuration(laneDurationSamples(db, now));
	} catch {
		laneTypical = undefined;
	}
	return tryRows<LaneQueryRow>(
		db,
		`SELECT name, origin_key, title, status, cwd, created_at, updated_at,
		CASE WHEN json_valid(meta) THEN json_extract(meta, '$.milestoneEvidence.file') END AS evidence_file,
		CASE WHEN json_valid(meta) THEN json_extract(meta, '$.milestoneEvidence.sha256') END AS evidence_sha256,
		CASE WHEN json_valid(meta) THEN json_extract(meta, '$.land.state') END AS land_state,
		CASE WHEN json_valid(meta) THEN COALESCE(json_extract(meta, '$.land.prLand.url'), json_extract(meta, '$.pr.url')) END AS pr_url,
		CASE WHEN json_valid(meta) THEN json_extract(meta, '$.repo') END AS repo,
		(SELECT COUNT(*) FROM inbound WHERE inbound.origin_key = lanes.origin_key AND inbound.state = 'uncertain') AS uncertain_count
		FROM lanes
		WHERE status != 'closed'
		   OR (status = 'closed' AND json_valid(meta) AND json_extract(meta, '$.land.state') IN (${ACTIVE_LAND_STATES}))
		ORDER BY (status != 'closed') DESC, updated_at DESC`,
	).map((r) => {
		const repo = extractRepoName(r.repo, r.cwd);
		const prUrl = safeHttpsUrl(r.pr_url);
		const landState =
			r.status === "closed" && typeof r.land_state === "string" && r.land_state !== "" ? r.land_state : undefined;
		return {
			active: r.status !== "closed",
			updatedAtMs: r.updated_at,
			info: {
				name: install === undefined ? r.name : `${install}:${r.name}`,
				originKey: install === undefined ? r.origin_key : `${install}:${r.origin_key}`,
				title: redact(r.title),
				status: r.status,
				cwd: r.cwd,
				updatedAt: iso(r.updated_at),
				uncertainCount: r.uncertain_count,
				...(r.evidence_file === null || r.evidence_sha256 === null
					? {}
					: { evidence: { file: redact(r.evidence_file), sha256: r.evidence_sha256 } }),
				...(laneTypical === undefined || r.status !== "working"
					? {}
					: { typical: laneTypical, elapsedMs: Math.max(0, now - r.created_at) }),
				...(install === undefined ? {} : { install }),
				...(landState === undefined ? {} : { landState }),
				...(prUrl === undefined ? {} : { prUrl }),
				...(repo === undefined ? {} : { repo }),
			},
		};
	});
}

/** Own and peer open or landing-active lanes, open lanes first then newest update first. */
export function buildLanesSection(
	ownDb: Database,
	opts: { now: number; iso: (ms: number) => string; peers?: readonly PeerInstall[] },
): { items: LaneInfo[] } {
	const entries = [
		...readInstallLanes(ownDb, opts),
		...(opts.peers ?? []).flatMap(
			(peer) =>
				withPeerDb(peer, (db) => readInstallLanes(db, { now: opts.now, iso: opts.iso, install: peer.name })) ?? [],
		),
	];
	entries.sort((a, b) => Number(b.active) - Number(a.active) || b.updatedAtMs - a.updatedAtMs);
	return { items: entries.map((entry) => entry.info) };
}

export function baseTask({ row, broken }: ReadTask, timezone: string, install?: string): TaskInfo {
	const open = row.status !== "done" && row.status !== "cancelled";
	return {
		taskId: install === undefined ? row.taskId : `${install}:${row.taskId}`,
		...(install === undefined ? {} : { install, rawTaskId: row.taskId }),
		title: redact(row.title),
		risk: row.risk,
		status: row.status,
		host: row.host ?? "local",
		agent: row.agent,
		runtime: row.runtime,
		branch: row.branch,
		open,
		updatedAt: localIso(row.updatedAt, timezone),
		...(row.closedAt === null ? {} : { closedAt: localIso(row.closedAt, timezone) }),
		acTotal: row.acceptance.length,
		...(broken.length === 0 ? {} : { error: `${broken.join("·")} 손상` }),
	};
}

export function makeDurationOf(
	getDb: () => Database,
	now: number,
): (row: TaskRow) => { typical?: TypicalDuration; elapsedMs?: number } {
	let taskTypical: { value: TypicalDuration | undefined } | undefined;
	return (row: TaskRow) => {
		if (row.status !== "working") return {};
		if (taskTypical === undefined) {
			try {
				taskTypical = { value: typicalDuration(taskDurationSamples(getDb(), now)) };
			} catch {
				taskTypical = { value: undefined };
			}
		}
		const typical = taskTypical.value;
		return typical === undefined ? {} : { typical, elapsedMs: Math.max(0, now - row.createdAt) };
	};
}

/** Reads open and recent closed TASKs from every configured peer DB; unreadable peers are skipped. */
export async function readPeerTasks(
	peers: readonly PeerInstall[],
	opts: {
		now: number;
		timezone: string;
		closedDays: number;
		closedLimit: number;
		evalTimeoutMs: number;
		localHostOps: () => TaskHostOps;
		message: (error: unknown) => string;
	},
): Promise<{ open: TaskInfo[]; closed: TaskInfo[] }> {
	const openAll: TaskInfo[] = [];
	const closedAll: Array<{ closedAt: number; info: TaskInfo }> = [];
	for (const peer of peers) {
		const dbPath = join(peer.home, "jabbu.db");
		if (!existsSync(dbPath)) continue;
		let peerDb: Database | undefined;
		try {
			peerDb = new Database(dbPath, { readonly: true, strict: true });
			const db = peerDb;
			const durationOf = makeDurationOf(() => db, opts.now);
			const openRows = tryRows<TaskSql>(
				db,
				"SELECT * FROM tasks WHERE status IN ('working','blocked','review') ORDER BY task_id",
			).map(readTaskSql);
			const closedRows = tryRows<TaskSql>(
				db,
				"SELECT * FROM tasks WHERE status IN ('done','cancelled') AND closed_at >= ? ORDER BY closed_at DESC LIMIT ?",
				opts.now - opts.closedDays * 86_400_000,
				opts.closedLimit,
			).map(readTaskSql);
			const described = await Promise.all(
				openRows.map(async ({ row, broken }): Promise<TaskInfo> => {
					const info: TaskInfo = { ...baseTask({ row, broken }, opts.timezone, peer.name), ...durationOf(row) };
					if (row.runtime === "headless") info.herdr = { ok: true, status: headlessStatusFromLedger(db, row) };
					const evalRes =
						row.host === null
							? await withTimeout(
									(async () => evaluateTask(row, opts.localHostOps()))(),
									opts.evalTimeoutMs,
									`${row.taskId} evaluation`,
								).catch((error: unknown) => ({ ok: false as const, error: opts.message(error) }))
							: undefined;
					if (evalRes?.ok) {
						const j = evalRes.judgement;
						Object.assign(info, {
							acChecked: j.acChecked,
							stepsDone: j.stepsDone,
							stepsTotal: j.stepsTotal,
							progress: {
								status: j.status,
								updated: j.updatedAt,
								current: redact(j.current),
								blockedReason: redact(j.blockedReason),
							},
							acceptance: j.acceptance.map((item) => ({ ...item, text: redact(item.text) })),
							steps: j.steps.map((step) => ({ ...step, text: redact(step.text) })),
						});
					} else if (evalRes !== undefined) {
						info.error = [info.error ?? [], opts.message(evalRes.error)].flat().join(" · ");
					}
					return Object.assign(info, taskTurnFields(row, evalRes?.ok ? evalRes.judgement : undefined));
				}),
			);
			openAll.push(...described);
			for (const read of closedRows)
				closedAll.push({ closedAt: read.row.closedAt ?? 0, info: baseTask(read, opts.timezone, peer.name) });
		} catch {
			// Skip unreadable peer DB so own snapshot sections remain intact.
		} finally {
			peerDb?.close();
		}
	}
	closedAll.sort((a, b) => b.closedAt - a.closedAt);
	return { open: openAll, closed: closedAll.slice(0, opts.closedLimit).map((entry) => entry.info) };
}

function buildFlowsFromDb(
	handle: Database,
	opts: {
		now: number;
		timezone: string;
		iso: (ms: number) => string;
		peerReview: boolean;
		channelNames?: Record<string, string>;
		discordGuild: string | null;
		install?: string;
	},
): Array<{ open: boolean; updatedAt: number; info: FlowChainInfo }> {
	const { now, timezone, iso, peerReview, channelNames, discordGuild, install } = opts;
	const since = now - FLOW_WINDOW_MS;
	const scope =
		"thread_ref IN (SELECT thread_ref FROM tasks WHERE created_at >= ? OR status IN ('working','blocked','review'))";
	const read = tryRows<TaskSql>(handle, `SELECT * FROM tasks WHERE ${scope} ORDER BY created_at, task_id`, since).map(
		(r) => readTaskSql(r).row,
	);
	if (read.length === 0) return [];
	const transitions = tryRows<FlowTransition>(
		handle,
		`SELECT task_id AS taskId, from_status AS fromStatus, to_status AS toStatus, actor, reason, at
		FROM task_transitions WHERE task_id IN (SELECT task_id FROM tasks WHERE ${scope}) ORDER BY transition_id`,
		since,
	);
	const statuses = taskFlowStatus(read, transitions, peerReview);
	const durationOf = makeDurationOf(() => handle, now);
	const threads = new Map<string, TaskRow[]>();
	for (const row of read) threads.set(row.threadRef, [...(threads.get(row.threadRef) ?? []), row]);
	const prefixId = (taskId: string): string => (install === undefined ? taskId : `${install}:${taskId}`);
	return [...threads].map(([rawThreadRef, list]) => {
		const steps = list.map((row): FlowStepInfo => {
			const stage = taskStage(row, statuses, timezone);
			return {
				taskId: prefixId(row.taskId),
				title: redact(row.title),
				status: row.status,
				risk: row.risk,
				host: row.host ?? "local",
				branch: row.branch,
				createdAt: iso(row.createdAt),
				...(row.closedAt === null ? {} : { closedAt: iso(row.closedAt) }),
				acTotal: row.acceptance.length,
				stage: { ...stage, msg: redact(stage.msg) },
				...durationOf(row),
			};
		});
		const open = list.filter((row) => row.status !== "done" && row.status !== "cancelled");
		const here = open.find((row) => row.status === "blocked") ?? open[0];
		const updatedAt = Math.max(...list.map((row) => row.updatedAt));
		let line: string;
		if (here === undefined) {
			const closedAt = Math.max(...list.map((row) => row.closedAt ?? row.updatedAt));
			line = `모두 끝남 · 마지막 close ${iso(closedAt).slice(5, 16).replace("T", " ")}`;
		} else {
			const stage = steps.find((step) => step.taskId === prefixId(here.taskId))?.stage;
			const msg = Array.from((stage?.msg ?? "").replace(/\s+/g, " ").trim());
			const cut = msg.length > FLOW_NOW_MSG_CHARS ? `${msg.slice(0, FLOW_NOW_MSG_CHARS - 1).join("")}…` : msg.join("");
			line = `${here.taskId} ${stage?.label ?? ""}${cut === "" ? "" : ` · ${cut}`}${open.length > 1 ? ` · 외 열림 ${open.length - 1}` : ""}`;
		}
		const request = tryRows<{ text_ref: string; created_at: number }>(
			handle,
			"SELECT text_ref, created_at FROM inbound WHERE thread_ref = ? ORDER BY inbound_id LIMIT 1",
			rawThreadRef,
		)[0];
		const text = request?.text_ref.replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2").replace(/<https?:\/\/([^>]+)>/g, "$1");
		const rawOriginKey = list[0]?.originKey ?? "";
		const originKey = install === undefined || rawOriginKey === "" ? rawOriginKey : `${install}:${rawOriginKey}`;
		const rawPlace = originLabel(rawOriginKey, channelNames);
		const place =
			install === undefined ? rawPlace : [install, rawPlace ?? ""].filter((p) => p !== "").join(" · ") || null;
		const info: FlowChainInfo = {
			threadRef: install === undefined ? rawThreadRef : `${install}:${rawThreadRef}`,
			originKey,
			place,
			title: text === undefined ? "(원문 없음)" : previewLine(text, list[0]?.title),
			requestedAt: request === undefined ? null : iso(request.created_at),
			updatedAt: iso(updatedAt),
			done: list.filter((row) => row.status === "done").length,
			total: list.length,
			here: here === undefined ? null : prefixId(here.taskId),
			now: line,
			tasks: steps,
			discordHref: discordThreadHref(discordGuild, rawOriginKey, rawThreadRef),
		};
		return { open: open.length > 0, updatedAt, info };
	});
}

/** Own and peer TASK flow chains, open chains first then newest update first. */
export function buildFlowsSection(
	ownDb: Database,
	opts: Omit<Parameters<typeof buildFlowsFromDb>[1], "install"> & { peers?: readonly PeerInstall[] },
): { items: FlowChainInfo[] } {
	const chains = [
		...buildFlowsFromDb(ownDb, opts),
		...(opts.peers ?? []).flatMap(
			(peer) => withPeerDb(peer, (db) => buildFlowsFromDb(db, { ...opts, install: peer.name })) ?? [],
		),
	];
	chains.sort((a, b) => Number(b.open) - Number(a.open) || b.updatedAt - a.updatedAt);
	return { items: chains.map((chain) => chain.info) };
}
