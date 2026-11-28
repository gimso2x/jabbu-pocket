import { dirname } from "node:path";
import type { ChannelRegistry } from "../channel/registry";
import type { DispatchHostConfig } from "../config";
import { parseThreadRef, TOP_LEVEL_TS } from "../core/normalize";
import type { BoardLinkResolver } from "../dispatch/board";
import { type HerdrRunnerOptions, herdrRemoteStart, herdrStartAgent, type ProcessRunner } from "../dispatch/omp";
import { type DiskView, diskHeadroom, type HostLoadReader } from "../ops/host-resources";
import type { SessionCeilingGate } from "../ops/host-sessions";
import type { QuotaRefusalCheck } from "../ops/quota-gate";
import { type StartCapacity, startCapacity } from "../ops/start-capacity";
import { redact } from "../redact";
import { buildWorkerFloorsPrompt } from "../safety/prompt";
import type { HerdrPromptInput } from "../store/db-rows";
import { type BaseInfo, resolveTaskBase } from "./base-ref";
import { summarizeJudgement } from "./checker";
import {
	acceptanceItems,
	docsDirOf,
	type NewTaskSpec,
	renderContext,
	renderOutcome,
	renderProgress,
	renderSpec,
	type TaskDocsMeta,
} from "./docs";
import { evaluateTask } from "./evaluate";
import { buildHandoffBrief } from "./handoff";
import { resolveTaskHost, type TaskHostOps, type TaskResumeOps } from "./host";
import type { TaskLedger, TaskRow } from "./ledger";
import { buildAcceptedCard, postToThread, setStatusReaction, type TaskChatLog } from "./notify";
import { buildTaskPrompt, resumeCheckLines } from "./prompt";
import {
	agyWorkspacesOf,
	promptDocsOf,
	readResumeCheck,
	recordsRootFor,
	rollbackRecords,
	settled,
	writeTaskDocs,
} from "./records";
import { restatedHash } from "./resume-check";
import { releaseHold, runtimeFor, type TaskMailboxPort, type TaskRuntime, type TaskStartResult } from "./runtime";
import { threadLink } from "./thread-link";
import { agyModelOf, agySecretsDirs, agyWorkerArgs, type WorkerTier, withWorkerModel, workerLine } from "./worker-tier";

type HostEntry = DispatchHostConfig;

export interface TaskDispatchDeps {
	ledger: TaskLedger;
	originKey: string;
	/** The session's current conversation thread (`<channel>:<ts>`); the task thread. */
	threadRef(): string | undefined;
	/** The [TASK] root message text, from the inbound ledger. */
	rootText(threadRef: string): string | undefined;
	channels: ChannelRegistry;
	now(): number;
	/** The bot's zone (`config.timezone`): document times and the worker prompt's offset. */
	timezone: string;
	/** Config `idStart` as of now (a getter: a reload applies to the next [TASK]). */
	idStart?: () => number | undefined;
	workspaceDir: string;
	dispatchHosts?: Record<string, HostEntry>;
	/** Config `recordsRepo`: the task records go there (a remote task's to its host's `recordsDir`), never on the branch. */
	recordsRepo?: string;
	/** Config `workerOmpArgs`: extra omp arguments of a local task agent (a remote one takes its host's `ompArgs`). */
	workerOmpArgs?: string[];
	/** This bot home's secrets directory: the agy worker's floors name it and its `read_file` deny rule covers it. */
	secretsDir: string;
	run?: ProcessRunner;
	/** Test seam: host ops override. */
	hostOps?: (host: string | null) => TaskHostOps & TaskResumeOps;
	/** Test seam: free space of the filesystem holding a path (default `statfsSync`); local starts only. */
	diskHeadroom?: (path: string) => DiskView;
	/** Test seam: the start-capacity gate's memory readers (default this machine's own); local starts only. */
	hostLoad?: Partial<HostLoadReader>;
	/** The host-wide omp session ceiling the start gate judges (`hostSessionCeiling`); local starts only. */
	hostSessions?: SessionCeilingGate;
	quotaRefusal?: QuotaRefusalCheck;
	/** Owner confirmation for a forced start past a capacity/quota refusal: asked with the refusal lines; absent → force is refused. */
	confirmForce?: (reasons: readonly string[]) => Promise<boolean>;
	/** The daemon's Mailbox port: present → a new local non-agy task runs headless (`runtime='headless'`), else on herdr. */
	headless?: TaskMailboxPort;
	/** herdr board card link of a started agent (`config.herdrBoard`); absent → the card carries no link. */
	boardLink?: BoardLinkResolver;
	/** Keeps a prompt herdr took for the dashboard's 마지막 지시 (`Store.recordHerdrPrompt`); absent → nothing kept. */
	recordPrompt?: (input: HerdrPromptInput) => void;
	/** Gate a resume handoff brief before a worker switch starts it (absent → the brief goes unscanned). */
	gateBrief?: (brief: string) => Promise<{ suffix: string; approved: boolean }>;
	log: TaskChatLog & { info(event: string, fields?: Record<string, unknown>): void };
}

/** Keeps a prompt herdr took; a failed write is only logged, the dispatch result stays as it is. */
export function notePrompt(
	deps: { recordPrompt?: (input: HerdrPromptInput) => void; log: TaskChatLog },
	input: HerdrPromptInput,
): void {
	if (deps.recordPrompt === undefined) return;
	try {
		deps.recordPrompt(input);
	} catch (error) {
		deps.log.warn("herdr_prompt_record_failed", { host: input.host, agent: input.agent, error: String(error) });
	}
}

function hostEntryOf(deps: TaskDispatchDeps, host: string | null): HostEntry | undefined {
	if (host === null) return undefined;
	// Own keys only: `constructor`/`__proto__` are not configured hosts.
	const hosts = deps.dispatchHosts;
	const entry = hosts !== undefined && Object.hasOwn(hosts, host) ? hosts[host] : undefined;
	if (entry === undefined) {
		const known = Object.keys(deps.dispatchHosts ?? {}).join(", ") || "없음";
		throw new Error(`알 수 없는 호스트: ${host} (등록된 호스트: ${known})`);
	}
	return entry;
}

function opsFor(deps: TaskDispatchDeps, host: string | null): TaskHostOps & TaskResumeOps {
	if (deps.hostOps !== undefined) return deps.hostOps(host);
	const records = deps.recordsRepo === undefined ? {} : { recordsRepo: deps.recordsRepo };
	return resolveTaskHost(host, deps.dispatchHosts, deps.run === undefined ? records : { ...records, run: deps.run });
}

function herdrOptionsFor(deps: TaskDispatchDeps, entry: HostEntry | undefined): HerdrRunnerOptions {
	return {
		cwd: deps.workspaceDir,
		...(deps.run === undefined ? {} : { run: deps.run }),
		...(entry?.herdrBin === undefined ? {} : { herdrBin: entry.herdrBin }),
		...(entry === undefined ? {} : { sshTarget: entry.ssh }),
	};
}

/** The worker of a row by its recorded runtime (herdr: the row host's options; headless: the daemon's port). */
function runtimeOf(deps: TaskDispatchDeps, row: TaskRow): TaskRuntime {
	return runtimeFor(row, {
		herdr: (r) => herdrOptionsFor(deps, hostEntryOf(deps, r.host)),
		startHerdr: (r, prompt, close) => startHerdrAgent(deps, r, prompt, close),
		headless: deps.headless,
		warn: (event, fields) => deps.log.warn(event, fields),
	});
}

/** Starts the task's worker in its worktree with `prompt` (a herdr start keeps its prompt itself; a headless one here). */
async function startAgent(
	deps: TaskDispatchDeps,
	row: TaskRow,
	prompt: string,
	closeOnPromptFailure = false,
): Promise<TaskStartResult> {
	const started = await runtimeOf(deps, row).start(row, prompt, closeOnPromptFailure);
	if (started.ok && row.runtime === "headless")
		notePrompt(deps, { host: row.host, agent: row.agent, kind: "start", text: prompt, originKey: deps.originKey });
	return started;
}

/** Starts the task's herdr agent in its worktree; `closeOnPromptFailure` tears down on initial failure. */
async function startHerdrAgent(
	deps: TaskDispatchDeps,
	row: TaskRow,
	prompt: string,
	closeOnPromptFailure: boolean,
): Promise<TaskStartResult> {
	const entry = hostEntryOf(deps, row.host);
	const options = herdrOptionsFor(deps, entry);
	// An agy worker is local only (the trial's bound, `resolveAgyWorker`). agy takes no system prompt flag: its floors go
	// ahead of the first prompt of every start, a new one and a restart by resume alike.
	const agy = agyModelOf(row.workerModel);
	const task = agy === undefined ? prompt : `${buildWorkerFloorsPrompt(deps.secretsDir, row)}\n\n${prompt}`;
	// The model fixed at registration, on a start and on every restart by resume alike.
	const agentArgs =
		agy === undefined
			? withWorkerModel(entry === undefined ? deps.workerOmpArgs : entry.ompArgs, row.workerModel)
			: agyWorkerArgs(agy, agyWorkspacesOf(row), agySecretsDirs(deps.secretsDir));
	const base = {
		name: row.agent,
		task,
		cwd: row.worktree,
		options,
		closeOnPromptFailure,
		// The worker's session note would repeat the brief; the result note (`src/wiki`) is written by the core instead.
		env: { OMP_WIKI_NOTE_DISABLE: "1" },
		...(agentArgs ? { agentArgs } : {}),
	};
	const started =
		entry === undefined
			? await herdrStartAgent(agy === undefined ? base : { ...base, kind: "agy" })
			: await herdrRemoteStart({ ...base, sshTarget: entry.ssh });
	if (started.ok)
		notePrompt(deps, { host: row.host, agent: row.agent, kind: "start", text: task, originKey: deps.originKey });
	return started.ok ? { ok: true, paneId: started.paneId } : { ok: false, error: started.error };
}

/** The agy worker trial runs one task at a time: the agy task (other than `except`) still working or blocked, if any. */
export function agyOccupant(ledger: TaskLedger, except?: string): string | undefined {
	return ledger.listActive().find((row) => row.taskId !== except && agyModelOf(row.workerModel) !== undefined)?.taskId;
}

/** The board card of a just-started agent; `undefined` when no board is configured. */
async function cardLink(deps: TaskDispatchDeps, row: TaskRow, paneId: string): Promise<string | undefined> {
	return deps.boardLink === undefined || row.runtime === "headless" ? undefined : deps.boardLink(row.host, paneId);
}

/** New task: ID → worktree → four docs → agent → card and ⏳; rolls back on pre-agent failure. */
export async function startTask(
	deps: TaskDispatchDeps,
	input: {
		spec: NewTaskSpec;
		task: string | undefined;
		host: string | null;
		worker: WorkerTier;
		/** The owner ordered forcing past a tight host: a refusal passes only on an owner-card confirmation (the load warning still shows). */
		force?: boolean;
	},
): Promise<string> {
	const { spec, host, worker } = input;
	if (input.task === undefined || input.task === "") throw new Error("신규 taskSpec에는 task(지시문)가 필요합니다");
	const threadRef = deps.threadRef();
	const parsed = threadRef === undefined ? undefined : parseThreadRef(threadRef);
	if (threadRef === undefined || parsed === undefined || parsed.threadTs === TOP_LEVEL_TS) {
		throw new Error("taskSpec은 [TASK] 요청이 온 채팅 스레드 안에서만 쓸 수 있습니다(현재 스레드를 알 수 없음)");
	}
	hostEntryOf(deps, host); // unknown host fails before anything is reserved
	// `force` is the model's claim the owner ordered it: each refusal asks the owner on a card; without a confirmer the force is refused.
	const forceConfirmed = (reasons: readonly string[]): Promise<boolean> =>
		input.force === true && deps.confirmForce !== undefined ? deps.confirmForce(reasons) : Promise.resolve(false);
	const quotaHold = deps.quotaRefusal?.(worker.model ?? undefined);
	// Quota and capacity are refused together: one owner card covers both, instead of asking twice.
	let capacity: StartCapacity | undefined;
	let disk: DiskView | undefined;
	if (host === null) {
		disk = (deps.diskHeadroom ?? diskHeadroom)(dirname(spec.repo));
		capacity = startCapacity(deps.hostLoad, [disk], deps.hostSessions);
	}
	const refusals = [...(quotaHold === undefined ? [] : [quotaHold]), ...(capacity?.refusals ?? [])];
	if (refusals.length > 0 && !(await forceConfirmed(refusals))) {
		if (quotaHold !== undefined)
			deps.log.warn("task_start_refused_quota", { repo: spec.repo, model: worker.model, refusal: quotaHold });
		if (capacity !== undefined && capacity.refusals.length > 0 && disk !== undefined) {
			const fields = { repo: spec.repo, path: disk.path, freeBytes: disk.freeBytes, refusals: [...capacity.refusals] };
			deps.log.warn("task_start_refused_capacity", fields);
		}
		return `시작 거부: ${refusals.join(", ")}`;
	}
	if (quotaHold !== undefined) deps.log.info("task_start_forced", { repo: spec.repo, reason: "quota" });
	if (capacity !== undefined && capacity.refusals.length > 0) deps.log.info("task_start_forced", { repo: spec.repo });
	const baseRef = resolveTaskBase(hostEntryOf(deps, host)?.branchRules, spec.repo, spec.base); // unsafe: refused before anything is reserved
	const ops = opsFor(deps, host);
	const recordsRoot = recordsRootFor(deps.recordsRepo, host, hostEntryOf(deps, host));
	const row = deps.ledger.register({
		...(recordsRoot ? { recordsRoot } : {}),
		idStart: deps.idStart?.(),
		title: spec.title,
		risk: spec.risk,
		originKey: deps.originKey,
		threadRef,
		host,
		repo: spec.repo,
		...(spec.branch === undefined ? {} : { branch: spec.branch }),
		// Local tasks (agy ones too: the agy print driver) run headless on the daemon's Mailbox; remote ones on herdr.
		runtime: host === null && deps.headless !== undefined ? "headless" : "herdr",
		acceptance: acceptanceItems(spec.acceptance),
		worker: {
			tier: worker.tier,
			tierReason: worker.tierReason,
			model: worker.model,
			...(spec.tierConfidence === undefined ? {} : { tierConfidence: spec.tierConfidence }),
		},
	});
	const git = { repo: row.repo, worktree: row.worktree, branch: row.branch };
	let worktreeCreated = false,
		recorded = false;
	let paneId = "";
	let base: BaseInfo | undefined;
	const fail = async (error: string): Promise<string> => {
		if (worktreeCreated) await ops.removeWorktree(git).catch(() => undefined);
		await rollbackRecords(row, ops, deps.recordsRepo, recorded).catch(() => undefined);
		deps.ledger.discard(row.taskId);
		deps.log.warn("task_start_failed", { task: row.taskId, error });
		return `시작 실패: ${error} (${row.taskId} 등록을 되돌렸습니다)`;
	};

	try {
		if (recordsRoot === null) return await fail(`${host}에 recordsDir 없음`);
		const exists = await ops.pathExists(row.worktree);
		if (!exists.ok) return await fail(exists.error);
		if (exists.value) return await fail(`워크트리 경로가 이미 있습니다: ${row.worktree}`);
		const created = await ops.createWorktree({ ...git, base: baseRef });
		if (!created.ok) return await fail(created.error);
		worktreeCreated = true;
		const baseSha = (await ops.headOf(row.worktree)).sha;
		deps.ledger.setBaseSha(row.taskId, baseSha);
		base = { ref: baseRef, sha: baseSha };

		const meta: TaskDocsMeta = {
			taskId: row.taskId,
			hostLabel: row.host ?? "local",
			repo: row.repo,
			worktree: row.worktree,
			branch: row.branch,
			base,
			agent: row.agent,
			threadLink: await threadLink(deps.channels, deps.log, threadRef),
			registeredAt: row.createdAt,
			timezone: deps.timezone,
		};
		const docs: Array<[string, string]> = [
			["context.md", renderContext(meta, spec, redact(deps.rootText(threadRef) ?? input.task))],
			["spec.md", renderSpec(meta, spec, row.acceptance)],
			["PROGRESS.md", renderProgress(row.taskId, row.createdAt, deps.timezone)],
			["outcome.md", renderOutcome(row.taskId)],
		];
		// The documents are the task's evidence trail: the branch's first commit, or (records mode) a records commit.
		const written = await writeTaskDocs(row, ops, { docs, recordsRepo: deps.recordsRepo, log: deps.log });
		if (!written.ok) return await fail(written.error);
		recorded = written.recorded;
		const prompt = buildTaskPrompt({
			mode: "new",
			taskId: row.taskId,
			plans: written.plans,
			...promptDocsOf(row),
			worktree: row.worktree,
			branch: row.branch,
			instruction: input.task,
			timezone: deps.timezone,
			now: deps.now(),
		});
		const started = await startAgent(deps, row, prompt, true);
		if (!started.ok) return await fail(started.error);
		paneId = started.paneId;
	} catch (error) {
		return await fail(error instanceof Error ? error.message : String(error));
	}

	deps.log.info("task_started", { task: row.taskId, host: row.host, agent: row.agent });
	const link = await cardLink(deps, row, paneId);
	const posted = await postToThread(deps.channels, deps.log, threadRef, buildAcceptedCard(row, spec, link, base));
	await setStatusReaction(deps.channels, deps.log, threadRef, "working", []);
	const where = `${row.host ?? "local"}:${row.worktree}`;
	const workerText = workerLine(row);
	return [
		`${row.taskId} 등록·시작했습니다 (워크트리 ${where}, branch ${row.branch}, 에이전트 ${row.agent}, 기준 문서 ${docsDirOf(row)}).`,
		...(workerText === undefined ? [] : [workerText]),
		...(worker.note === undefined ? [] : [worker.note]),
		...(capacity?.warning === undefined ? [] : [capacity.warning]),
		...(link === undefined ? [] : [`진행 보기: ${link}`]),
		posted
			? "접수 카드(맡았습니다·진행 보기·[목표]·[가정])를 이 스레드에 이미 올렸습니다. 답에서 카드 내용을 되풀이하지 말고, 카드에 없는 것(오너가 지금 알아야 할 위험·확인 못 한 것)만 한두 줄로 씁니다."
			: "접수 카드를 스레드에 올리지 못했습니다. 답 첫 줄에 '`<호스트>`에서 `<에이전트>`(<제목>)가 맡았습니다', 다음 줄에 진행 보기 링크, 그 아래 [목표]·[가정] 두 줄을 직접 씁니다.",
		`진행 확인: jabbu_dispatch ${row.host === null ? '{mode:"worker"' : `{host:"${row.host}"`}, name:"${row.agent}"}. 재개·오너 결정 전달: jabbu_dispatch {taskSpec:{id:"${row.taskId}"}, task:<오너 답 원문>}. 완료 처리는 오너만 합니다.`,
	].join("\n");
}

/** Resume: a live agent gets the PROGRESS prompt, a missing one restarts in its worktree; the check never refuses it. */
export async function resumeTask(
	deps: TaskDispatchDeps,
	input: {
		id: string;
		task: string | undefined;
		host: string | null | undefined;
		/** Resume on this worker instead of the registered one (`tier`/`worker` of the resume spec, resolved by the caller). */
		switchTo?: WorkerTier;
	},
): Promise<string> {
	const row = deps.ledger.get(input.id);
	if (row === undefined) throw new Error(`등록된 작업이 아닙니다: ${input.id}`);
	if (row.status === "done" || row.status === "cancelled")
		throw new Error(`${row.taskId}는 이미 ${row.status}로 닫힌 작업입니다`);
	if (input.host !== undefined && input.host !== row.host) {
		throw new Error(`${row.taskId}는 ${row.host ?? "로컬"}에서 실행되는 작업입니다(host 불일치)`);
	}
	const runtime = runtimeOf(deps, row);
	const ops = opsFor(deps, row.host);
	const { check, restated } = await readResumeCheck(ops, row);
	deps.log.info("task_resume_check", { task: row.taskId, findings: check.findings.length, notes: check.notes.length });
	const alive = await runtime.exists(row);
	if (!alive.ok) return `재개 실패: ${alive.error}`;
	const w = input.switchTo;
	const switchTo = w !== undefined && (w.model !== row.workerModel || w.tier !== row.tier) ? w : undefined;
	const promptFor = (handoff?: string): string =>
		buildTaskPrompt({
			mode: "resume",
			taskId: row.taskId,
			...promptDocsOf(row),
			worktree: row.worktree,
			branch: row.branch,
			...(input.task === undefined || input.task === "" ? {} : { instruction: input.task }),
			resumeFindings: check.findings,
			resumeNotes: check.notes,
			...(handoff === undefined ? {} : { handoff }),
			timezone: deps.timezone,
			now: deps.now(),
		});
	releaseHold(deps.ledger, row); // lift an owner hold on the task before sending the resume
	let how: string;
	let link: string | undefined;
	let switched: string | undefined;
	let suffix = "";
	if (switchTo !== undefined) {
		const outcome = await resumeOnOtherWorker(deps, { row, ops, runtime, alive: alive.exists, switchTo, promptFor });
		if (typeof outcome === "string") return outcome;
		({ how, link, switched, suffix } = outcome);
	} else if (alive.exists) {
		const prompt = promptFor();
		const sent = await runtime.prompt(row, prompt);
		// Unconfirmed: herdr took the text but saw no start; the resume goes on (the sweep watches what follows).
		if (!sent.ok && sent.unconfirmed !== true) return `재개 실패: ${sent.error ?? "unknown"}`;
		notePrompt(deps, { host: row.host, agent: row.agent, kind: "followup", text: prompt, originKey: deps.originKey });
		how = `살아 있는 에이전트에 재개 프롬프트를 보냈습니다${sent.ok ? "" : "(시작 확인 안 됨)"}`;
	} else {
		// A dead agy worker comes back as agy or not at all: one task never mixes worker kinds.
		const busy = agyModelOf(row.workerModel) === undefined ? undefined : agyOccupant(deps.ledger, row.taskId);
		if (busy !== undefined)
			return `재개 안 함: agy 워커는 동시 1개만 — ${busy}가 점유 중입니다(working·blocked). 그 작업이 끝나거나 닫힌 뒤 다시 재개하세요.`;
		const present = await ops.pathExists(row.worktree);
		if (!present.ok) return `재개 실패: ${present.error}`;
		if (!present.value) return `재개 실패: 워크트리가 없습니다: ${row.worktree}`;
		const started = await startAgent(deps, row, promptFor());
		if (!started.ok) return `재개 실패: ${started.error}`;
		how = "같은 워크트리에서 새 에이전트를 시작했습니다";
		link = await cardLink(deps, row, started.paneId);
	}
	if (row.status !== "working") {
		deps.ledger.transition(row.taskId, "working", "bot", "resume dispatch");
		await setStatusReaction(deps.channels, deps.log, row.threadRef, "working");
	}
	// A resumed task gets a fresh staleness baseline: the agent has not had a chance to update PROGRESS.md yet.
	const now = deps.now();
	deps.ledger.setProgressAt(row.taskId, now);
	// ... and a fresh nudge count (the sweep counts unmet nudges since the latest mark).
	deps.ledger.recordNotice(row.taskId, `resume:${now}`);
	// What `restated` said before this resume: the sweep warns when the agent goes on without writing a new one.
	if (restated !== undefined) deps.ledger.recordNotice(row.taskId, `restated-before:${now}:${restatedHash(restated)}`);
	deps.log.info("task_resumed", { task: row.taskId, alive: alive.exists });
	return [
		`${row.taskId}: ${how} (${row.status} → working).${link === undefined ? "" : ` 진행 보기: ${link}.`} 진행 확인: jabbu_dispatch ${row.host === null ? '{mode:"worker"' : `{host:"${row.host}"`}, name:"${row.agent}"}`,
		...(switched === undefined ? [] : [switched]),
		...(suffix === "" ? [] : [suffix.replace(/^\n/, "")]),
		...resumeCheckLines(check.findings, check.notes),
	].join("\n");
}

/**
 * Resume on another worker model: the old agent's last screen and PROGRESS.md become a handoff brief, the old agent
 * is closed, the row takes the new worker and a new agent starts with the resume prompt carrying the brief. A failed
 * start puts the row's worker back and says so (nothing runs until the next resume). Returns the reply text of a
 * refusal/failure, or what the caller needs to finish the resume.
 */
async function resumeOnOtherWorker(
	deps: TaskDispatchDeps,
	input: {
		row: TaskRow;
		ops: TaskHostOps & TaskResumeOps;
		runtime: TaskRuntime;
		alive: boolean;
		switchTo: WorkerTier;
		promptFor(handoff: string): string;
	},
): Promise<string | { how: string; link: string | undefined; switched: string; suffix: string }> {
	const { row, ops, runtime, switchTo } = input;
	if (agyModelOf(switchTo.model) !== undefined) {
		const busy = agyOccupant(deps.ledger, row.taskId);
		if (busy !== undefined) return `재개 안 함: agy 워커는 동시 1개만 — ${busy}가 점유 중입니다(working·blocked).`;
	}
	const present = await ops.pathExists(row.worktree);
	if (!present.ok) return `재개 실패: ${present.error}`;
	if (!present.value) return `재개 실패: 워크트리가 없습니다: ${row.worktree}`;
	const docsDir = docsDirOf(row);
	const progress = await settled(() => ops.readFile(`${docsDir}/PROGRESS.md`));
	const screen = input.alive ? await runtime.read(row) : undefined;
	const from = `${row.tier ?? "?"}(${row.workerModel ?? "기본 모델"})`;
	const to = `${switchTo.tier}(${switchTo.model ?? "기본 모델"})`;
	const brief = buildHandoffBrief({
		from,
		to,
		specPath: `${docsDir}/spec.md`,
		progress: progress.ok ? progress.value : undefined,
		screen: screen?.ok === true ? screen.output : undefined,
	});
	const gate = deps.gateBrief === undefined ? undefined : await deps.gateBrief(brief);
	if (input.alive) {
		const closed = await runtime.close(row);
		if (!closed.ok) return `재개 실패: 이전 워커를 닫지 못했습니다: ${closed.error}`;
	}
	const { tier, tierReason, workerModel: model, tierConfidence } = row;
	const before = { tier, tierReason, model, tierConfidence };
	const worker = { tier: switchTo.tier, tierReason: switchTo.tierReason, tierConfidence: null };
	deps.ledger.setWorker(row.taskId, { ...worker, model: switchTo.model });
	const next: TaskRow = { ...row, ...worker, workerModel: switchTo.model };
	const started = await startAgent(deps, next, input.promptFor(brief));
	if (!started.ok) {
		deps.ledger.setWorker(row.taskId, before);
		deps.log.warn("task_resume_model_switch_failed", { task: row.taskId, from, to, error: started.error });
		return `재개 실패: ${started.error} (${row.taskId} 워커는 원래 ${from}로 되돌렸습니다. 이전 워커는 이미 닫혔으니 다시 재개하면 원래 설정으로 뜹니다)`;
	}
	deps.ledger.recordNotice(row.taskId, `model-change:${deps.now()}:${from}->${to}`);
	deps.log.info("task_resume_model_switched", { task: row.taskId, from, to });
	return {
		how: `워커를 ${from} → ${to}로 바꿔 새 에이전트를 시작했습니다(인계 브리프 포함)`,
		link: await cardLink(deps, next, started.paneId),
		switched: workerLine(next) ?? `워커: ${to}`,
		suffix: gate?.suffix ?? "",
	};
}

/** The one-line judgement summary appended to an output read of an agent bound to a task; `undefined` when unbound. */
export async function taskSummaryLine(
	deps: TaskDispatchDeps,
	agent: string,
	host: string | null,
): Promise<string | undefined> {
	const row = deps.ledger.getByAgent(agent, host);
	if (row === undefined) return undefined;
	const evaluation = await evaluateTask(row, opsFor(deps, row.host));
	if (!evaluation.ok) return `▸ ${row.taskId} 판정 읽기 실패: ${evaluation.error}`;
	return `▸ ${row.taskId} ${summarizeJudgement(evaluation.judgement, row.status)}`;
}
