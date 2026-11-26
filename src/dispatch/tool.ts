import { join } from "node:path";
import type { DispatchHostConfig, WorkerAgyConfig } from "../config";
import { LANE_MODEL_TIERS, type LaneModelTier, type LaneModelTiers } from "../model-tiers";
import { type FreezeState, frozenMessage } from "../ops/freeze";
import { redact } from "../redact";
import type { ApprovalDetail, ApprovalResult } from "../safety/approval";
import { scanHandoffBrief } from "../safety/handoff-risk";
import type { HostToolDef } from "../safety/host-tools";
import { buildFloorsPrompt } from "../safety/prompt";
import type { HerdrPromptInput } from "../store/db-rows";
import {
	agyOccupant,
	notePrompt,
	resumeTask,
	startTask,
	type TaskDispatchDeps,
	taskSummaryLine,
} from "../tasks/dispatch";
import { parseTaskSpecInput, TASK_ID_PATTERN } from "../tasks/docs";
import { followupTask } from "../tasks/followup";
import type { TaskRow } from "../tasks/ledger";
import { applyRiskFloor } from "../tasks/risk-floor";
import { runtimeFor } from "../tasks/runtime";
import { resolveAgyWorker, resolveWorkerTier, type WorkerTier } from "../tasks/worker-tier";
import { auditContext } from "./audit";
import { type BoardLinkResolver, boardCardLink, type HerdrBoardConfig } from "./board";
import {
	herdrAgentExists,
	herdrPromptExisting,
	herdrReadAgent,
	herdrRemoteStart,
	MAX_TASK_BYTES,
	OWNER_NAME_PATTERN,
	runOmpPrint,
} from "./omp";
import { secretsCwdProblem } from "./secrets-cwd";

export interface DispatchToolDeps {
	originKey: string;
	ompExecutable: string;
	/** Config `ompProfile` of the simple `omp -p` run (absent: the inherited agent dir). */
	ompProfile?: string;
	/** Config `ompConfigOverlay`: the simple `omp -p` run's `--config` (absent: none). */
	ompConfigOverlay?: string;
	homeDir: string;
	workspaceDir: string;
	/** Remote dispatch targets (hub fleet pattern, ssh herdr), config `dispatchHosts` read at every call (live on reload). */
	dispatchHosts?: () => Record<string, DispatchHostConfig> | undefined;
	/** Config `workerOmpArgs`: extra omp arguments of local herdr workers (remote ones take their host's `ompArgs`). */
	workerOmpArgs?: string[];
	/** Config `lanes.models`, read at every new [TASK] (a reload applies to the next one); absent → no `--model`. */
	laneModels?: () => LaneModelTiers | undefined;
	/** Config `workerAgy`, read at every new [TASK] and agy start; absent → `taskSpec.worker: "agy"` runs on omp. */
	workerAgy?: () => WorkerAgyConfig | undefined;
	/** Test seam: process runner override. */
	run?: import("./omp").ProcessRunner;
	/** herdr-web-ui task board (`config.herdrBoard`): started agents get a card link; absent → no links. */
	herdrBoard?: HerdrBoardConfig;
	/** [TASK] state docs (`taskSpec`); absent → `taskSpec` is refused and dispatch is exactly the plain flow. */
	tasks?: Omit<
		TaskDispatchDeps,
		| "originKey"
		| "workspaceDir"
		| "dispatchHosts"
		| "workerOmpArgs"
		| "workerAgy"
		| "secretsDir"
		| "run"
		| "log"
		| "boardLink"
		| "recordPrompt"
	>;
	/** Freeze switch (`<home>/FROZEN`): while it returns a state every call is refused before any command runs. */
	frozen?: () => FreezeState | undefined;
	/** Config `herdr`: present → remote hosts and agy workers work (herdr is optional); local [TASK] workers run headless (`tasks.headless`). */
	herdr?: { bin?: string };
	/** Keeps every prompt herdr took for the dashboard's 마지막 지시 (`Store.recordHerdrPrompt`); absent → nothing kept. */
	recordPrompt?: (input: HerdrPromptInput) => void;
	/** Owner approval card for a high_risk brief (herdr or simple); absent → such a brief is refused (`no_approver`). */
	approve?: (summary: string, detail: ApprovalDetail, signal?: AbortSignal) => Promise<ApprovalResult>;
	log: {
		info(event: string, fields?: Record<string, unknown>): void;
		warn(event: string, fields?: Record<string, unknown>): void;
	};
}

/** With no worker runtime (no herdr and no headless port) the tool is simple-only: no host, name, cwd or taskSpec in what the model sees. */
const SIMPLE_ONLY_DESCRIPTION =
	"태스크를 실행 계층에 넘긴다. `omp -p`로 한 번 실행하고 최종 출력을 돌려준다(10분 상한). 판단 기준: 조사·분석·회고·체크처럼 한 번의 답으로 끝나는 일은 세션에서 직접 하거나 이 도구로 넘긴다.";
const SIMPLE_ONLY_PARAMETERS = {
	type: "object",
	properties: { task: { type: "string", description: "실행할 작업 지시(그 자체로 완결된 지시문)" } },
	required: ["task"],
	additionalProperties: false,
};
const HERDR_OFF_MESSAGE = "herdr가 꺼져 있어 simple만 쓸 수 있습니다(원격 host·agy 워커는 herdr가 필요합니다)";
/** A [TASK] agent's name (its TASKID, lowercased); an ad hoc local start never takes one. */
const TASK_AGENT_NAME = new RegExp(TASK_ID_PATTERN.source, "i");
const taskNameStartRefusal = (name: string): string =>
	`TASKID 꼴 이름(${name})으로는 새 에이전트를 시작하지 않습니다. [TASK] 작업은 taskSpec으로 등록하거나 재개하세요`;
/** A brief the handoff risk scan found nothing in (or a call with no brief): the result goes out unchanged. */
const CLEAR_GATE = { suffix: "", approved: false };

/** Why `task` cannot go to a child as one argument (a control character other than tab/newline, or too long); else undefined. */
function taskTextProblem(task: string): string | undefined {
	for (const char of task) {
		const code = char.codePointAt(0) as number;
		if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f)
			return "task에 제어문자가 들어 있습니다(NUL 등). 지시문에서 빼고 다시 보내세요";
	}
	const bytes = Buffer.byteLength(task);
	return bytes > MAX_TASK_BYTES
		? `task가 너무 깁니다(${bytes}바이트, 상한 ${MAX_TASK_BYTES}). 파일로 저장하고 경로를 넘기세요`
		: undefined;
}

/** `taskSpec.worker` taken off the raw spec (the four documents never carry it): `"agy"` or absent. */
function takeWorkerKind(raw: unknown): { worker: "agy" | undefined; rest: unknown } {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw) || !Object.hasOwn(raw, "worker"))
		return { worker: undefined, rest: raw };
	const { worker, ...rest } = raw as Record<string, unknown>;
	if (worker !== "agy") throw new Error(`taskSpec.worker는 agy만 받습니다: ${String(worker)}`);
	return { worker, rest };
}

/**
 * Handoff risk scan of a brief about to go to a worker or an `omp -p` run. clear/advisory pass (advisory adds a
 * result line); high_risk passes only on an `approved` owner card (no `approve` → refused as `no_approver`), anything
 * else throws before a worker is touched. `afterApproval` runs once a card came back approved (the freeze re-check).
 */
export async function gateHandoff(
	deps: Pick<DispatchToolDeps, "originKey" | "approve" | "log"> & { afterApproval?: () => void },
	text: string,
	signal: AbortSignal,
): Promise<{ suffix: string; approved: boolean }> {
	const scan = scanHandoffBrief(text);
	const origin = deps.originKey;
	if (scan.verdict === "clear") return CLEAR_GATE;
	if (scan.verdict === "advisory") {
		const rules = [...new Set(scan.findings.map((finding) => finding.rule))];
		deps.log.info("dispatch_risk_advisory", { origin, rules });
		return { suffix: `\n위험 검사: advisory (${rules.join(", ")})`, approved: false };
	}
	const high = scan.findings.filter((finding) => finding.severity === "high_risk");
	const rest = scan.findings.filter((finding) => finding.severity !== "high_risk");
	const rules = [...new Set([...high.map((finding) => finding.rule), ...(scan.truncated ? ["truncated"] : [])])];
	deps.log.warn("dispatch_risk_high", { origin, rules });
	const detail: ApprovalDetail = {
		action: [...high, ...rest]
			.slice(0, 5)
			.map((finding) => `L${finding.line} ${finding.rule}: ${redact(finding.excerpt)}`)
			.join("\n"),
		impact: "승인하면 이 지시문이 사람 없이 워커에서 실행됩니다",
	};
	const summary = scan.truncated
		? "herdr 위임 지시문이 64KiB를 넘어 끝까지 검사하지 못했습니다"
		: "herdr 위임 지시문에 고위험 명령이 있습니다";
	const answer = deps.approve === undefined ? "no_approver" : await deps.approve(summary, detail, signal);
	if (answer === "approved") {
		deps.afterApproval?.();
		deps.log.info("dispatch_risk_approved", { origin, rules });
		return { suffix: `\n위험 검사: high_risk 승인됨 (${rules.join(", ")})`, approved: true };
	}
	const outcome = typeof answer === "object" ? "replied" : answer;
	deps.log.warn("dispatch_risk_refused", { origin, outcome });
	throw new Error(
		`위험 검사에서 막혔습니다(${outcome}): ${rules.join(", ")}. 지시문에서 해당 명령을 빼거나 금지 문장으로 바꾸고 다시 시도하세요`,
	);
}

/** The `jabbu_dispatch` host tool for chat origins; `undefined` when the omp binary is not provided. */
export function buildDispatchTool(deps: DispatchToolDeps): HostToolDef {
	const herdrOn = deps.herdr !== undefined;
	const workerOn = herdrOn || deps.tasks?.headless !== undefined;
	const board = deps.herdrBoard;
	const boardLink: BoardLinkResolver | undefined =
		board === undefined
			? undefined
			: (host, paneId) =>
					boardCardLink(board, host, paneId, {
						onError: (error) => deps.log.warn("dispatch_board_link_failed", { host: host ?? "local", error }),
					});
	const tool: HostToolDef = {
		name: "jabbu_dispatch",
		label: "Dispatch work",
		description:
			'태스크를 실행 계층에 넘긴다. mode=simple(기본)은 단순 작업: `omp -p`로 한 번 실행하고 최종 출력을 돌려준다(10분 상한). mode=worker는 복잡·장기 작업: [TASK] 워커(omp 에이전트)에 일을 맡긴다 — 계속 실행되므로 이후 jabbu_dispatch mode=worker + name 으로 진행을 확인하거나 후속 지시를 보낸다. 로컬 워커는 taskSpec으로만 시작한다. 판단 기준: 조사·분석·회고·체크처럼 한 번의 답으로 끝나는 일은 세션에서 직접 하거나 simple. 구현은 예상 30분 초과·다단계·새 모듈·스키마 변경 중 하나라도 걸리면 무조건 worker(+taskSpec) — 세션에서 직접 구현하지 않는다(세션 안 하위 에이전트로 구현하는 것도 직접 구현이다). 직접 구현은 설정값 변경·작은 수선(오너 요청 하나에 src 4개·200줄 이내, 테스트·문서 제외), 세션 컨텍스트 없이는 판단할 수 없는 긴급 디버깅만. 추가 판단: 여러 단계이거나 하루를 넘길 작업이면 taskSpec을 채운다(대상 저장소에 워크트리·4문서(context/spec/PROGRESS/outcome)·상태 파일을 만들고 TASKID로 추적, 수락기준×증거로 jabbu가 Outcome 도달을 판정한다). 단발성 작업은 taskSpec을 비운다. 시작되면 jabbu가 스레드에 접수 카드(맡았습니다·진행 보기 링크·[목표]·[가정])를 올리므로 assumptions에 오너 말을 어떻게 해석했는지 한 줄로 적는다. 막힘·Outcome 알림에 오너가 결정을 답하면 그 원문을 taskSpec:{id}와 task로 넘겨 재개한다. taskSpec 신규는 {title,risk(L0~L4),goal,scope[],exclusions[],acceptance[](1개 이상),repo(대상 호스트의 git 저장소 절대경로),background?}와 task(지시문)를 함께 주고, 재개는 taskSpec:{id:"T-…"}만 준다. taskSpec에는 name을 주지 않는다. 워커가 글로 질문하고 멈추면 스레드에 ❓ 카드가 오고, 오너 답은 봇이 워커에게 넘긴다. 완료 처리·merge는 오너만 한다.',
		parameters: {
			type: "object",
			properties: {
				task: {
					type: "string",
					description: "실행할 작업 지시(그 자체로 완결된 지시문). herdr + name 만 있으면 생략(현재 출력 조회)",
				},
				mode: { type: "string", enum: ["simple", "worker"], description: "실행 방식(기본 simple)" },
				name: {
					type: "string",
					description:
						"[TASK] 워커 이름(TASKID 소문자). 같은 이름에 task를 다시 보내면 후속 지시가 되고, task 없이 보내면 현재 출력을 돌려준다",
				},
				host: {
					type: "string",
					description:
						"원격 실행 대상(config dispatchHosts 키, 예: wsl). 지정하면 그 호스트의 herdr로 omp 에이전트를 띄운다",
				},
				cwd: {
					type: "string",
					description:
						"원격(host) 새 에이전트의 작업 디렉터리, 기본은 호스트 설정의 workDir. 로컬 워커는 받지 않는다(taskSpec.repo)",
				},
				force: {
					type: "boolean",
					description:
						"taskSpec 신규 등록이 `시작 거부: 호스트 여유`(메모리·디스크)로 거부된 뒤 오너가 강행을 명시했을 때만 true. 다른 거부 사유나 단순 부하 경고에는 쓰지 않고 사유를 오너에게 그대로 전달한다",
				},
				taskSpec: {
					type: "object",
					description:
						"여러 단계·하루 넘는 작업의 [TASK] 상태 문서 등록. 신규: title·risk·goal·acceptance·repo 필수(+scope·exclusions·background·tier·tierReason·tierConfidence·worker). 재개: {id}(기본: 처음 등록한 모델로 뜬다). tier(·tierReason)나 worker를 함께 주면 그 모델로 바꿔 재개하고 인계 브리프(마지막 PROGRESS·이전 워커 화면 80줄·spec 경로)를 새 워커 첫 입력에 넣는다. host가 있으면 그 호스트에, 없으면 로컬에 워크트리를 만든다",
					properties: {
						id: { type: "string", description: "재개할 TASKID(T-YYYYMMDD-NN). 이것만 준다" },
						title: { type: "string" },
						risk: { type: "string", enum: ["L0", "L1", "L2", "L3", "L4"] },
						goal: { type: "string" },
						scope: { type: "array", items: { type: "string" } },
						exclusions: { type: "array", items: { type: "string" } },
						acceptance: {
							type: "array",
							items: { type: "string" },
							description: "수락기준 문구(등록 뒤 바꿀 수 없음)",
						},
						repo: { type: "string", description: "대상 호스트의 git 저장소 절대경로" },
						background: { type: "string" },
						assumptions: {
							type: "string",
							description: "오너 대신 정한 해석 한 줄(접수 카드의 [가정]). 없으면 생략",
						},
						tier: {
							type: "string",
							enum: [...LANE_MODEL_TIERS],
							description:
								"워커 모델 등급(config lanes.models). 생략하면 위험 등급으로 정한다(L0·L1 low, L2 middle, L3 이상 high) — 이유가 있을 때만 준다. high: 설계·디버깅·넓은 변경, middle: 일반 구현, low: 기계적 수선 묶음. L3 이상은 항상 high. 재개에서 주면 그 등급으로 바꿔 재개",
						},
						tierReason: {
							type: "string",
							description: "그 등급을 고른 이유 한 줄(카드에 보임). 신규 등록과 등급을 바꾸는 재개에서",
						},
						tierConfidence: {
							type: "number",
							minimum: 0,
							maximum: 1,
							description: "그 등급 판정의 확신도 0~1(judge conf가 있을 때). 신규 등록에서만",
						},
						worker: {
							type: "string",
							enum: ["agy"],
							description:
								"agy(gemini, 무료 시범): L0·L1 로컬, 동시 1개. 품질 미검증. 조건 밖이면 omp 등급 워커로 뜬다. 신규 등록과 워커를 바꾸는 재개에서",
						},
					},
					additionalProperties: false,
				},
			},
			additionalProperties: false,
		},
		async execute(params, context) {
			refuseIfFrozen();
			return auditContext.run({ origin: deps.originKey }, () => executeDispatch(params, context.signal));
		},
	};
	return workerOn ? tool : { ...tool, description: SIMPLE_ONLY_DESCRIPTION, parameters: SIMPLE_ONLY_PARAMETERS };

	/** The worker a resume with `tier` and/or `worker` asks for; an agy request outside the trial's bounds says why. */
	function resolveResumeWorker(
		row: TaskRow,
		input: { tier?: LaneModelTier; tierReason?: string },
		workerKind: "agy" | undefined,
		taskDeps: TaskDispatchDeps,
	): WorkerTier {
		const omp = resolveWorkerTier(
			row.risk,
			{ tier: input.tier ?? row.tier ?? undefined, tierReason: input.tierReason },
			deps.laneModels?.(),
		);
		return workerKind === "agy"
			? resolveAgyWorker(omp, {
					risk: row.risk,
					host: row.host,
					agy: deps.workerAgy?.(),
					busy: agyOccupant(taskDeps.ledger, row.taskId),
					runtime: row.runtime === "herdr" ? herdrOn : taskDeps.headless !== undefined, // the row keeps its runtime
				})
			: omp;
	}

	/** Throws when the bot is frozen: checked on entry and again after an owner card, which can outlast a freeze. */
	function refuseIfFrozen(): void {
		const frozen = deps.frozen?.();
		if (frozen === undefined) return;
		deps.log.warn("dispatch_refused_frozen", { origin: deps.originKey });
		throw new Error(frozenMessage(frozen));
	}

	/**
	 * The one gate every work-sending branch passes: the handoff risk scan of its brief (no brief → nothing to scan).
	 * Only a high_risk brief asks the owner; a peer bot having written in the thread asks nothing more (owner, 11-09).
	 */
	function gateWork(text: string | undefined, signal: AbortSignal): Promise<{ suffix: string; approved: boolean }> {
		return text === undefined || text === ""
			? Promise.resolve(CLEAR_GATE)
			: gateHandoff({ ...deps, afterApproval: refuseIfFrozen }, text, signal);
	}

	async function executeDispatch(params: Record<string, unknown>, signal: AbortSignal): Promise<string> {
		if (params.mode !== undefined && params.mode !== "simple" && params.mode !== "worker")
			throw new Error(`mode는 simple 또는 worker입니다: ${String(params.mode)}`);
		const workerArgs =
			params.mode === "worker" || ["name", "host", "cwd", "taskSpec"].some((key) => params[key] !== undefined);
		if (!workerOn && workerArgs) throw new Error(HERDR_OFF_MESSAGE);
		const task = typeof params.task === "string" ? params.task.trim() : undefined;
		const host = typeof params.host === "string" && params.host.trim() !== "" ? params.host.trim() : undefined;
		const name = typeof params.name === "string" && params.name.trim() !== "" ? params.name.trim() : undefined;
		const givenCwd = typeof params.cwd === "string" && params.cwd.trim() !== "" ? params.cwd.trim() : undefined;
		if (host !== undefined && !herdrOn) throw new Error(HERDR_OFF_MESSAGE);
		// A name or cwd is a worker argument: dropping it on the simple path would run `omp -p` and forget the agent name.
		if (params.mode === "simple" && (name !== undefined || givenCwd !== undefined))
			throw new Error("simple 모드는 name·cwd를 받지 않습니다. 워커는 mode=worker로 부르세요");
		const mode = params.mode === "worker" || name !== undefined || givenCwd !== undefined ? "worker" : "simple";
		// The brief's risk scan never sees the cwd: a worker opened in a secrets directory is refused here, before any process.
		const cwdProblem =
			givenCwd === undefined ? undefined : secretsCwdProblem(givenCwd, host !== undefined, deps.homeDir);
		if (cwdProblem !== undefined) throw new Error(cwdProblem);
		if (task !== undefined) {
			const problem = taskTextProblem(task);
			if (problem !== undefined) throw new Error(problem);
			// herdr's `agent prompt <name> <task>` has no `--` before the task: a leading `-` would be read as an option.
			// A taskSpec task goes inside the prompt it builds (`buildTaskPrompt`), never first, so it may start with `-`.
			if (task.startsWith("-") && params.taskSpec === undefined && (mode === "worker" || host !== undefined))
				throw new Error(
					"워커로 보내는 task는 `-`로 시작할 수 없습니다(옵션으로 읽힙니다). 첫 글자를 바꿔 다시 보내세요",
				);
		}
		// Own keys only: `constructor` or `__proto__` must not find an Object.prototype member.
		const hosts = deps.dispatchHosts?.();
		const hostEntry = host !== undefined && Object.hasOwn(hosts ?? {}, host) ? hosts?.[host] : undefined;
		const taskDeps: TaskDispatchDeps | undefined =
			deps.tasks === undefined
				? undefined
				: {
						...deps.tasks,
						originKey: deps.originKey,
						workspaceDir: deps.workspaceDir,
						...(hosts === undefined ? {} : { dispatchHosts: hosts }),
						...(deps.workerOmpArgs === undefined ? {} : { workerOmpArgs: deps.workerOmpArgs }),
						secretsDir: join(deps.homeDir, "secrets"),
						...(deps.run === undefined ? {} : { run: deps.run }),
						...(boardLink === undefined ? {} : { boardLink }),
						...(deps.recordPrompt === undefined ? {} : { recordPrompt: deps.recordPrompt }),
						log: deps.log,
					};
		if (params.taskSpec !== undefined) {
			if (taskDeps === undefined) throw new Error("이 세션에서는 taskSpec을 쓸 수 없습니다");
			if (name !== undefined)
				throw new Error("taskSpec에는 name을 줄 수 없습니다(에이전트 이름은 TASKID에서 만듭니다)");
			const { worker: workerKind, rest } = takeWorkerKind(params.taskSpec);
			const input = parseTaskSpecInput(rest);
			// The repo is the worker's working tree: it is refused inside a secrets directory like a `cwd` (qa-z #7).
			const repoProblem =
				input.kind === "resume" ? undefined : secretsCwdProblem(input.spec.repo, host !== undefined, deps.homeDir);
			if (repoProblem !== undefined) throw new Error(repoProblem);
			const briefed = task !== undefined && task !== "";
			if (input.kind === "resume") {
				const gate = await gateWork(briefed ? task : undefined, signal);
				// tier or worker given: the resume runs on that worker (handoff) instead of the registered one.
				const registered = taskDeps.ledger.get(input.id);
				const switchTo =
					registered === undefined || (input.tier === undefined && workerKind === undefined)
						? undefined
						: resolveResumeWorker(registered, input, workerKind, taskDeps);
				return (
					redact(
						await resumeTask(taskDeps, { id: input.id, task, host, ...(switchTo === undefined ? {} : { switchTo }) }),
					) + gate.suffix
				);
			}
			// Exclusions and acceptance are forbidding/checking sentences by design; they are not scanned.
			const { spec } = input;
			const topics = [
				spec.title,
				spec.goal,
				...spec.scope,
				...(spec.background === undefined ? [] : [spec.background]),
				...(spec.assumptions === undefined ? [] : [spec.assumptions]),
			];
			const gate = await gateWork(briefed ? [task, ...topics].join("\n") : undefined, signal);
			const approvedRisk = gate.approved && ["L0", "L1", "L2"].includes(spec.risk) ? "L3" : spec.risk;
			// Topic keywords put a floor under the class (raise only); `task` is the how, not the topic.
			const floored = applyRiskFloor(approvedRisk, topics);
			if (floored.note !== undefined) {
				deps.log.info("dispatch_risk_floor_raised", { origin: deps.originKey, from: approvedRisk, to: floored.risk });
			}
			// The tier follows the final risk (approval and floor applied) and the live `lanes.models` of this call.
			const tier = resolveWorkerTier(floored.risk, spec, deps.laneModels?.());
			const worker =
				workerKind === "agy"
					? resolveAgyWorker(tier, {
							risk: floored.risk,
							host: host ?? null,
							agy: deps.workerAgy?.(),
							busy: agyOccupant(taskDeps.ledger),
							runtime: herdrOn || taskDeps.headless !== undefined,
						})
					: tier;
			const started = await startTask(taskDeps, {
				spec: { ...spec, risk: floored.risk },
				task,
				host: host ?? null,
				worker,
				force: params.force === true,
			});
			return redact(started) + (floored.note === undefined ? "" : `\n${floored.note}`) + gate.suffix;
		}
		const herdrOptions = {
			cwd: deps.workspaceDir,
			...(deps.run === undefined ? {} : { run: deps.run }),
			...(hostEntry?.herdrBin === undefined ? {} : { herdrBin: hostEntry.herdrBin }),
		};

		if (host !== undefined) {
			// Remote dispatch (hub fleet pattern): the named host runs its own herdr+omp. The host implies herdr.
			if (hostEntry === undefined)
				throw new Error(`알 수 없는 호스트: ${host} (등록된 호스트: ${Object.keys(hosts ?? {}).join(", ") || "없음"})`);
			const sshOptions = { ...herdrOptions, sshTarget: hostEntry.ssh };
			if (name === undefined) throw new Error("원격 실행에는 name이 필요합니다");
			if (!OWNER_NAME_PATTERN.test(name)) throw new Error(`name은 소문자·숫자·-·_ 32자 이내여야 합니다: ${name}`);
			const cwd = givenCwd ?? hostEntry.workDir ?? "~";
			if (task === undefined || task === "") {
				const read = await herdrReadAgent(name, sshOptions);
				if (!read.ok) return `읽기 실패: ${read.error ?? "unknown"}`;
				const summary = taskDeps === undefined ? undefined : await taskSummaryLine(taskDeps, name, host);
				return `▸ ${host}/${name} 최근 출력:\n${redact(read.output ?? "")}${summary === undefined ? "" : `\n${summary}`}`;
			}
			const closedRow = taskDeps?.ledger?.getByAgent?.(name, host);
			if (closedRow !== undefined && (closedRow.status === "done" || closedRow.status === "cancelled"))
				throw new Error(`${closedRow.taskId}는 이미 ${closedRow.status}로 닫힌 작업입니다`);
			const gate = await gateWork(task, signal);
			// A name the host already runs gets the task as a follow-up, like the local herdr branch.
			const existing = await herdrAgentExists(name, sshOptions);
			if (!existing.ok) return `시작 실패: ${existing.error}`;
			if (existing.exists) {
				const follow = await herdrPromptExisting(name, task, sshOptions);
				const check = `진행 확인: jabbu_dispatch {host:"${host}", name:"${name}"}`;
				if (follow.ok || follow.unconfirmed === true) {
					notePrompt(deps, { host, agent: name, kind: "followup", text: task, originKey: deps.originKey });
				}
				if (follow.unconfirmed === true) {
					deps.log.warn("dispatch_remote_prompt_unconfirmed", { host, agent: name, error: follow.error });
					return `전달은 했지만 작업 시작이 확인되지 않았습니다(${follow.error?.replace("agent prompt unconfirmed: ", "")}). ${check}${gate.suffix}`;
				}
				if (!follow.ok) return `전달 실패: ${follow.error ?? "unknown"}`;
				deps.log.info("dispatch_remote_prompted", { host, agent: name });
				return `후속 지시를 ${host}/${name}에 전달했습니다. ${check}${gate.suffix}`;
			}
			// An ad hoc start has no [TASK] ledger, here as in the local branch; a follow-up to a running agent stays allowed.
			if (TASK_AGENT_NAME.test(name)) throw new Error(taskNameStartRefusal(name));
			const start = await herdrRemoteStart({
				sshTarget: hostEntry.ssh,
				name,
				task,
				cwd,
				...(hostEntry.ompArgs === undefined ? {} : { agentArgs: hostEntry.ompArgs }),
				closeOnPromptFailure: true,
				options: { ...sshOptions, signal },
			});
			if (!start.ok) return `시작 실패: ${start.error}`;
			notePrompt(deps, { host, agent: name, kind: "start", text: task, originKey: deps.originKey });
			deps.log.info("dispatch_remote_started", { host, agent: name, cwd });
			const link = boardLink === undefined ? undefined : await boardLink(host, start.paneId);
			return (
				[
					`${host}에서 ${name} 에이전트를 시작했습니다 (cwd ${cwd}, pane ${start.paneId}).`,
					...(link === undefined ? [] : [`진행 보기: ${link}`]),
					`오너에게는 이 모양으로 접수를 알린다: 첫 줄 '\`${host}\`에서 \`${name}\`(<제목>)가 맡았습니다. 결정이 필요하거나 끝나면 이 스레드로 알려 드립니다.'${link === undefined ? "" : ", 다음 줄 '진행 보기: <위 링크>'"}, 빈 줄 뒤 '[목표] <한 문장>'과 '[가정] <오너 대신 정한 해석, 없으면 없음>'. 그 밖의 과정은 쓰지 않는다.`,
					`후속 지시·진행 확인은 jabbu_dispatch {host:"${host}", name:"${name}"} 로.`,
				].join("\n") + gate.suffix
			);
		}

		if (mode === "worker") {
			if (name === undefined) throw new Error("worker 모드에는 name이 필요합니다");
			// A TASKID-shaped name is a [TASK] worker's; any other bad name is refused for read and follow-up alike.
			if (!OWNER_NAME_PATTERN.test(name) && !TASK_AGENT_NAME.test(name))
				throw new Error(`name은 소문자·숫자·-·_ 32자 이내여야 합니다: ${name}`);
			if (givenCwd !== undefined)
				throw new Error("cwd는 원격(host) 시작에서만 씁니다. 로컬 워커의 저장소는 taskSpec.repo로 주세요");
			// A local worker is a registered [TASK] (no ad hoc local start): its row says what runs it, herdr or headless.
			const row = taskDeps?.ledger.getByAgent(name, null);
			if (taskDeps === undefined || row === undefined)
				throw new Error(
					`등록된 로컬 작업이 아닙니다: ${name}. 로컬 워커는 taskSpec으로 등록하세요(자유 형식 시작은 없습니다)`,
				);
			const runtime = runtimeFor(row, {
				herdr: () => herdrOptions,
				headless: taskDeps.headless,
				warn: (event, fields) => deps.log.warn(event, fields),
			});
			if (task === undefined || task === "") {
				const read = await runtime.read(row);
				if (!read.ok) return `읽기 실패: ${read.error ?? "unknown"}`;
				const summary = await taskSummaryLine(taskDeps, name, null);
				return `▸ ${name} 최근 출력:\n${redact(read.output ?? "")}${summary === undefined ? "" : `\n${summary}`}`;
			}
			const follow = await followupTask(
				{
					ledger: taskDeps.ledger,
					runtime: () => runtime,
					gate: (text) => gateWork(text, signal),
					originKey: deps.originKey,
					...(deps.recordPrompt === undefined ? {} : { recordPrompt: deps.recordPrompt }),
					log: deps.log,
				},
				{ id: row.taskId, text: task, source: "tool" },
			);
			return follow.text;
		}

		if (task === undefined || task === "") throw new Error("task is required");
		const gate = await gateWork(task, signal);
		deps.log.info("dispatch_simple", { origin: deps.originKey });
		const result = await runOmpPrint({
			task,
			cwd: deps.workspaceDir,
			...(deps.run === undefined ? {} : { run: deps.run }),
			systemPromptAppendix: buildFloorsPrompt(
				join(deps.homeDir, "secrets"),
				deps.originKey,
				false,
				false,
				false,
				{},
				false,
			),
			ompBin: deps.ompExecutable,
			...(deps.ompProfile === undefined ? {} : { ompProfile: deps.ompProfile }),
			...(deps.ompConfigOverlay === undefined ? {} : { overlayConfig: deps.ompConfigOverlay }),
			inheritedEnv: process.env,
			signal,
		});
		deps.log.info("dispatch_simple_done", { ok: result.ok, code: result.code });
		// A timeout already carries its own suffix; any other non-zero end must not read as a finished run.
		const failed =
			result.ok || result.timedOut ? "" : `\n\n[실패: omp -p exit ${result.code ?? "없음"} — 위 출력은 일부일 수 있음]`;
		return redact(result.output) + failed + gate.suffix;
	}
}
