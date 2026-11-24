import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscordChannel } from "../src/discord/channel";
import type { ProcessRunner } from "../src/dispatch/omp";
import { IDLE_HOST_LOAD } from "../src/ops/host-resources";
import { startTask, type TaskDispatchDeps } from "../src/tasks/dispatch";
import { acceptanceItems, docsDirUnder, renderProgress, renderSpec, taskDocsCommitTitle } from "../src/tasks/docs";
import { evaluateTask, memoryTaskChecks } from "../src/tasks/evaluate";
import { createTaskHostOps, type HostResult, type TaskHostOps, type TaskResumeOps } from "../src/tasks/host";
import { TaskLedger, type TaskRow } from "../src/tasks/ledger";
import { mirrorRecords, TASK_DOC_NAMES } from "../src/tasks/records";
import type { WorkerTier } from "../src/tasks/worker-tier";
import { OWNER } from "./helpers/bot-home";
import { registryOf } from "./helpers/channels";
import { FakeDiscordTransport } from "./helpers/discord-fake-transport";
import { git } from "./helpers/git-fixtures";

// 기록 분리: with `recordsRepo` the four task documents live in the records checkout,
// never on the task branch, and `base_sha` (the worktree's HEAD at creation) is the start of the task's own commits.
// Real git throughout; the herdr side is a fake process runner and a remote host is a fake `TaskHostOps`.

const NOW = Date.parse("2026-11-24T06:00:00Z");
const DAY = "20261124";
const THREAD = "111111111111111111:222222222222222222";
const WORKER: WorkerTier = { tier: "low", tierReason: "시작", model: null };
const SPEC = {
	title: "로그 회전",
	risk: "L2" as const,
	goal: "로그 회전을 넣는다",
	scope: ["src/log.ts"],
	exclusions: ["배포"],
	acceptance: ["회전 테스트가 통과한다", "README에 설명이 있다"],
	repo: "",
};

let root: string;
let repo: string;
let recordsRepo: string;

/** A repository on `main` with one commit; identity comes from the repository's own config (the product's git has no fixture home). */
function initRepo(dir: string): string {
	mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.name", "t");
	git(dir, "config", "user.email", "t@example.test");
	git(dir, "config", "commit.gpgsign", "false");
	writeFileSync(join(dir, "README.md"), "hello\n");
	git(dir, "add", "--", "README.md");
	git(dir, "commit", "-q", "-m", "init");
	return dir;
}

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "jabbu-task-records-")));
	repo = initRepo(join(root, "repo"));
	recordsRepo = initRepo(join(root, "records"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

interface Rig {
	ledger: TaskLedger;
	deps: TaskDispatchDeps;
	logs: { event: string; fields?: Record<string, unknown> }[];
	/** The herdr `agent start` fails (after the documents were written and recorded). */
	failAgentStart: { value: boolean };
}

/** `startTask` deps over an in-memory ledger, a fake herdr runner and `ops` for the task's host. */
function rig(ops: TaskHostOps & TaskResumeOps, over: Partial<TaskDispatchDeps> = {}): Rig {
	const ledger = new TaskLedger(new Database(":memory:", { strict: true }), {
		timezone: "Asia/Seoul",
		clock: { now: () => NOW },
	});
	const logs: Rig["logs"] = [];
	const record = (event: string, fields?: Record<string, unknown>) =>
		logs.push({ event, ...(fields ? { fields } : {}) });
	const failAgentStart = { value: false };
	const run: ProcessRunner = async (cmd) => {
		// Over ssh every remote word is single-quoted: take what the remote shell would see.
		const unquote = (word: string): string => (word.startsWith("'") && word.endsWith("'") ? word.slice(1, -1) : word);
		const args = cmd[0] === "ssh" ? cmd.slice(cmd.indexOf("--") + 2).map(unquote) : cmd;
		const ok = (stdout = "{}") => ({ code: 0, stdout, timedOut: false });
		if (args[1] === "agent" && args[2] === "list") return ok(JSON.stringify({ result: { agents: [] } }));
		if (args[1] === "workspace" && args[2] === "list") return ok(JSON.stringify({ result: { workspaces: [] } }));
		if ((args[1] === "workspace" || args[1] === "tab") && args[2] === "create") {
			const result = { workspace: { workspace_id: "W1" }, tab: { tab_id: "T1" }, root_pane: { pane_id: "P1" } };
			return ok(JSON.stringify({ result }));
		}
		if (args[1] === "agent" && args[2] === "start" && failAgentStart.value) {
			return { code: 1, stdout: "boom", timedOut: false };
		}
		return ok();
	};
	const deps: TaskDispatchDeps = {
		ledger,
		originKey: "discord/ch/111111111111111111/t/222222222222222222",
		threadRef: () => THREAD,
		rootText: () => "[TASK] L2 로그 회전\n목표: 회전",
		channels: registryOf(new DiscordChannel(new FakeDiscordTransport(), { ownerUserId: OWNER })),
		now: () => NOW,
		timezone: "Asia/Seoul",
		workspaceDir: root,
		secretsDir: join(root, "secrets"),
		run,
		hostOps: () => ops,
		hostLoad: IDLE_HOST_LOAD,
		diskHeadroom: (path) => ({ path, freeBytes: 1e12, totalBytes: 1e12 }),
		log: { info: record, warn: record },
		...over,
	};
	return { ledger, deps, logs, failAgentStart };
}

const subjects = (dir: string, ...paths: string[]): string[] =>
	git(dir, "log", "--format=%s", ...(paths.length === 0 ? [] : ["--", ...paths]))
		.split("\n")
		.filter((line) => line !== "");

/** A remote host's `TaskHostOps` in memory: files are a map, the worktree "exists" once created; every call is recorded. */
function fakeRemote(): TaskHostOps &
	TaskResumeOps & {
		files: Map<string, string>;
		calls: string[];
		/** Reads answer this failure (an unreachable host). */
		down: { error: string | undefined };
	} {
	const files = new Map<string, string>();
	const calls: string[] = [];
	const down: { error: string | undefined } = { error: undefined };
	const unused = async (): Promise<never> => {
		throw new Error("a start never calls this");
	};
	return {
		files,
		calls,
		down,
		pathExists: async () => ({ ok: true, value: false }),
		createWorktree: async (input) => {
			calls.push(`create ${input.worktree}`);
			return { ok: true, value: null };
		},
		removeWorktree: async (input) => {
			calls.push(`remove ${input.worktree}`);
		},
		writeFile: async (path, content) => {
			files.set(path, content);
			return { ok: true, value: null };
		},
		readFile: async (path): Promise<HostResult<string | undefined>> =>
			down.error === undefined ? { ok: true, value: files.get(path) } : { ok: false, error: down.error },
		readBytes: unused,
		readPlan: async () => ({ ok: true, value: undefined }),
		removeRecords: async (dir) => {
			calls.push(`removeRecords ${dir}`);
			for (const key of [...files.keys()]) if (key.startsWith(`${dir}/`)) files.delete(key);
		},
		commitDocs: async () => {
			calls.push("commitDocs");
			return { ok: true, value: "a".repeat(7) };
		},
		commitOnTaskBranch: unused,
		branchDiff: unused,
		progressLag: unused,
		runCheck: unused,
		headOf: async () => ({ sha: "d".repeat(40), clean: true }),
	};
}

const REMOTE_DIR = "/srv/records";
const remoteHosts = (recordsDir: string | undefined) => ({
	wsl: { ssh: "wsl-ssh", workDir: "/r", ...(recordsDir === undefined ? {} : { recordsDir }) },
});
const remoteSpec = { ...SPEC, repo: "/r/repo" };
const TASK_ID = `T-${DAY}-01`;

describe("TASK 기록 분리: 로컬 기록 모드 시작 (AC-1)", () => {
	test("로컬 기록 모드 시작: four documents land in recordsRepo, none on the task branch, one records commit", async () => {
		const r = rig(createTaskHostOps({ recordsRepo }), { recordsRepo });
		const out = await startTask(r.deps, { spec: { ...SPEC, repo }, task: "회전을 구현해", host: null, worker: WORKER });
		expect(out).toContain(`${TASK_ID} 등록·시작했습니다`);
		const row = r.ledger.require(TASK_ID);
		const docsDir = docsDirUnder(recordsRepo, TASK_ID);
		expect(row.docsDir).toBe(docsDir);
		expect(row.baseSha).toBe(git(repo, "rev-parse", "main"));
		expect(out).toContain(`기준 문서 ${docsDir}`);

		for (const name of TASK_DOC_NAMES) expect(existsSync(join(docsDir, name))).toBe(true);
		expect(readFileSync(join(docsDir, "context.md"), "utf8")).toContain("[TASK] L2 로그 회전\n목표: 회전");
		expect(existsSync(join(row.worktree, "docs"))).toBe(false);

		// The branch has no commit of its own yet, and none of them touches docs/tasks.
		expect(git(row.worktree, "log", "--name-only", "--format=%s", `${row.baseSha}..HEAD`)).toBe("");
		expect(git(row.worktree, "status", "--porcelain")).toBe("");
		expect(git(repo, "rev-parse", row.branch)).toBe(row.baseSha as string);

		// The records checkout holds the one commit, path-limited to this task's four files.
		expect(subjects(recordsRepo)).toEqual([taskDocsCommitTitle(TASK_ID), "init"]);
		expect(git(recordsRepo, "show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual(
			[...TASK_DOC_NAMES].map((name) => `docs/tasks/${TASK_ID}/${name}`).sort(),
		);
		expect(r.logs.filter((entry) => entry.event === "records_commit_failed")).toEqual([]);
	});

	test("로컬 기록 모드 시작: a spec plan is copied to <docsDir>/plans and recorded with the documents", async () => {
		mkdirSync(join(recordsRepo, "doc/plans"), { recursive: true });
		writeFileSync(join(recordsRepo, "doc/plans/x.md"), "# 스펙 X\n");
		git(recordsRepo, "add", "--", "doc/plans/x.md");
		git(recordsRepo, "commit", "-q", "-m", "plan");
		const r = rig(createTaskHostOps({ recordsRepo }), { recordsRepo });
		await startTask(r.deps, {
			spec: { ...SPEC, repo, goal: "doc/plans/x.md 를 따라 로그 회전을 넣는다" },
			task: "go",
			host: null,
			worker: WORKER,
		});
		const copy = join(docsDirUnder(recordsRepo, TASK_ID), "plans/x.md");
		expect(readFileSync(copy, "utf8")).toBe("# 스펙 X\n");
		expect(git(recordsRepo, "show", "--name-only", "--format=", "HEAD")).toContain(`docs/tasks/${TASK_ID}/plans/x.md`);
	});

	test("without recordsRepo the documents stay a docs commit on the task branch, as before", async () => {
		const r = rig(createTaskHostOps());
		await startTask(r.deps, { spec: { ...SPEC, repo }, task: "go", host: null, worker: WORKER });
		const row = r.ledger.require(TASK_ID);
		expect(row.docsDir).toBe(`${row.worktree}/docs/tasks/${TASK_ID}`);
		expect(row.baseSha).toBe(git(repo, "rev-parse", "main"));
		expect(git(row.worktree, "log", "--format=%s", `${row.baseSha}..HEAD`)).toBe(taskDocsCommitTitle(TASK_ID));
		expect(subjects(recordsRepo)).toEqual(["init"]);
	});
});

describe("TASK 기록 분리: 원격 호스트 (AC-5)", () => {
	test("원격: the documents are written to the host's recordsDir and mirrored into recordsRepo with one records commit", async () => {
		const remote = fakeRemote();
		const r = rig(remote, { recordsRepo, dispatchHosts: remoteHosts(REMOTE_DIR) });
		const out = await startTask(r.deps, { spec: remoteSpec, task: "go", host: "wsl", worker: WORKER });
		expect(out).toContain(`${TASK_ID} 등록·시작했습니다`);
		const row = r.ledger.require(TASK_ID);
		const docsDir = docsDirUnder(REMOTE_DIR, TASK_ID);
		expect(row.docsDir).toBe(docsDir);
		expect(row.baseSha).toBe("d".repeat(40));
		expect([...remote.files.keys()].sort()).toEqual(TASK_DOC_NAMES.map((name) => `${docsDir}/${name}`).sort());
		// No docs commit on the remote branch: records mode never falls back to it.
		expect(remote.calls).toEqual([`create ${row.worktree}`]);

		const local = docsDirUnder(recordsRepo, TASK_ID);
		for (const name of TASK_DOC_NAMES) {
			expect(readFileSync(join(local, name), "utf8")).toBe(remote.files.get(`${docsDir}/${name}`) as string);
		}
		expect(subjects(recordsRepo)).toEqual([taskDocsCommitTitle(TASK_ID), "init"]);
	});

	test("원격: records.mirror overwrites the local copy with the host's newer text and commits only what changed", async () => {
		const remote = fakeRemote();
		const r = rig(remote, { recordsRepo, dispatchHosts: remoteHosts(REMOTE_DIR) });
		await startTask(r.deps, { spec: remoteSpec, task: "go", host: "wsl", worker: WORKER });
		const row = r.ledger.require(TASK_ID);
		const input = { recordsRepo, message: `docs(task): ${TASK_ID} working 기록` };

		expect(await mirrorRecords(row, remote, input)).toEqual({ state: "clean" });
		const progress = `${row.docsDir}/PROGRESS.md`;
		remote.files.set(progress, `${remote.files.get(progress)}\n- [x] S1: 끝\n`);
		const second = await mirrorRecords(row, remote, input);
		expect(second).toMatchObject({ state: "committed" });
		expect(readFileSync(join(docsDirUnder(recordsRepo, TASK_ID), "PROGRESS.md"), "utf8")).toContain("- [x] S1: 끝");
		expect(subjects(recordsRepo)[0]).toBe(input.message);
		expect(git(recordsRepo, "show", "--name-only", "--format=", "HEAD")).toBe(`docs/tasks/${TASK_ID}/PROGRESS.md`);
	});

	test("원격 호스트 불통: an unreadable host skips only the mirror — the start stands, the local copy is untouched", async () => {
		const remote = fakeRemote();
		remote.down.error = "host unreachable: ssh: no route";
		const r = rig(remote, { recordsRepo, dispatchHosts: remoteHosts(REMOTE_DIR) });
		const out = await startTask(r.deps, { spec: remoteSpec, task: "go", host: "wsl", worker: WORKER });
		expect(out).toContain(`${TASK_ID} 등록·시작했습니다`);
		expect(r.ledger.require(TASK_ID).status).toBe("working");
		expect(remote.files.size).toBe(TASK_DOC_NAMES.length);
		expect(existsSync(docsDirUnder(recordsRepo, TASK_ID))).toBe(false);
		expect(subjects(recordsRepo)).toEqual(["init"]);
		expect(r.logs.find((entry) => entry.event === "records_commit_failed")).toMatchObject({
			fields: { task: TASK_ID, state: "skipped", error: "host unreachable: ssh: no route" },
		});

		// The mirror itself reports skipped and writes nothing while the host stays down.
		const row = r.ledger.require(TASK_ID);
		expect(await mirrorRecords(row, remote, { recordsRepo, message: "m" })).toEqual({
			state: "skipped",
			error: "host unreachable: ssh: no route",
		});
		expect(existsSync(docsDirUnder(recordsRepo, TASK_ID))).toBe(false);
		// Once the host answers, the next mirror records the documents.
		remote.down.error = undefined;
		expect(await mirrorRecords(row, remote, { recordsRepo, message: "m" })).toMatchObject({ state: "committed" });
	});

	test("원격 호스트에 recordsDir가 없으면 시작 실패: 행과 워크트리를 만들지 않고 commitDocs를 부르지 않는다", async () => {
		const remote = fakeRemote();
		const r = rig(remote, { recordsRepo, dispatchHosts: remoteHosts(undefined) });
		const out = await startTask(r.deps, { spec: remoteSpec, task: "go", host: "wsl", worker: WORKER });
		expect(out).toBe(`시작 실패: wsl에 recordsDir 없음 (${TASK_ID} 등록을 되돌렸습니다)`);
		expect(r.ledger.list()).toEqual([]);
		expect(remote.calls).toEqual([]);
		expect(remote.files.size).toBe(0);
		expect(subjects(recordsRepo)).toEqual(["init"]);
		expect(existsSync(join(recordsRepo, "docs"))).toBe(false);
	});

	test("원격 시작 실패: a remote start failing after the records commit removes the host's copy too", async () => {
		const remote = fakeRemote();
		const r = rig(remote, { recordsRepo, dispatchHosts: remoteHosts(REMOTE_DIR) });
		r.failAgentStart.value = true;
		const out = await startTask(r.deps, { spec: remoteSpec, task: "go", host: "wsl", worker: WORKER });
		expect(out).toContain("시작 실패");
		expect(r.ledger.list()).toEqual([]);
		expect(remote.calls).toContain(`removeRecords ${docsDirUnder(REMOTE_DIR, TASK_ID)}`);
		expect(remote.files.size).toBe(0);
		expect(existsSync(docsDirUnder(recordsRepo, TASK_ID))).toBe(false);
		expect(subjects(recordsRepo)[0]).toBe(`docs(task): ${TASK_ID} 시작 실패로 기록 되돌림`);
	});
});

describe("TASK 기록 분리: 시작 실패 되돌림 (AC-14)", () => {
	test("시작 실패: an agent that fails to start after the records commit leaves no documents and a revert commit", async () => {
		const r = rig(createTaskHostOps({ recordsRepo }), { recordsRepo });
		r.failAgentStart.value = true;
		const out = await startTask(r.deps, { spec: { ...SPEC, repo }, task: "go", host: null, worker: WORKER });
		expect(out).toContain(`시작 실패`);
		expect(out).toContain(`${TASK_ID} 등록을 되돌렸습니다`);
		expect(r.ledger.list()).toEqual([]);
		expect(existsSync(docsDirUnder(recordsRepo, TASK_ID))).toBe(false);
		expect(subjects(recordsRepo)).toEqual([
			`docs(task): ${TASK_ID} 시작 실패로 기록 되돌림`,
			taskDocsCommitTitle(TASK_ID),
			"init",
		]);
		// The revert commit removes exactly the four documents; the checkout is clean afterwards.
		expect(git(recordsRepo, "show", "--name-status", "--format=", "HEAD").split("\n").sort()).toEqual(
			[...TASK_DOC_NAMES].map((name) => `D\tdocs/tasks/${TASK_ID}/${name}`).sort(),
		);
		expect(git(recordsRepo, "status", "--porcelain")).toBe("");
		// The worktree and its branch went with the registration.
		expect(existsSync(`${repo}-t-${DAY}-01`)).toBe(false);
		expect(git(repo, "branch", "--list", `task/${TASK_ID}`)).toBe("");
	});

	test("시작 실패: a failure before the documents exist makes no records commit at all", async () => {
		const r = rig(createTaskHostOps({ recordsRepo }), { recordsRepo });
		mkdirSync(`${repo}-t-${DAY}-01`);
		const out = await startTask(r.deps, { spec: { ...SPEC, repo }, task: "go", host: null, worker: WORKER });
		expect(out).toContain("워크트리 경로가 이미 있습니다");
		expect(subjects(recordsRepo)).toEqual(["init"]);
		expect(r.ledger.list()).toEqual([]);
	});
});

describe("TASK 기록 분리: base_sha 기준 증거 commit 판정 (AC-2)", () => {
	/** A task worktree with `base_sha` = its creation HEAD, one feature commit on the branch, main moved on afterwards. */
	async function branchWithFeature() {
		const ops = createTaskHostOps({ recordsRepo });
		const ledger = new TaskLedger(new Database(":memory:", { strict: true }), {
			timezone: "Asia/Seoul",
			clock: { now: () => NOW },
		});
		const registered = ledger.register({
			title: "기록 판정",
			risk: "L2",
			originKey: "discord/ch/111111111111111111/t/222222222222222222",
			threadRef: THREAD,
			host: null,
			repo,
			acceptance: acceptanceItems(["하나"]),
			recordsRoot: recordsRepo,
		});
		const { worktree, branch } = registered;
		expect(await ops.createWorktree({ repo, worktree, branch })).toEqual({ ok: true, value: null });
		const baseSha = (await ops.headOf(worktree)).sha;
		ledger.setBaseSha(registered.taskId, baseSha);
		writeFileSync(join(worktree, "feat.txt"), "feature\n");
		git(worktree, "add", "--", "feat.txt");
		git(worktree, "commit", "-q", "-m", "feat: feature");
		const feat = git(worktree, "rev-parse", "HEAD");
		// main moves on after the branch was cut: its own commit is never the task's.
		writeFileSync(join(repo, "m.txt"), "main\n");
		git(repo, "add", "--", "m.txt");
		git(repo, "commit", "-q", "-m", "feat: on main");
		const onMain = git(repo, "rev-parse", "main");
		// A commit that is on neither main nor the task branch.
		const other = git(repo, "commit-tree", "-p", baseSha, "-m", "feat: other", `${baseSha}^{tree}`);
		return { ops, ledger, row: ledger.require(registered.taskId), baseSha, feat, onMain, other };
	}

	test("기록 모드: a commit between base_sha and the branch is ok; base_sha itself, main's later commit and a stray commit are not_on_branch", async () => {
		const t = await branchWithFeature();
		const check = (hash: string) =>
			t.ops.commitOnTaskBranch({ worktree: t.row.worktree, branch: t.row.branch, baseSha: t.baseSha, hash });
		expect(await check(t.feat)).toBe("ok");
		expect(await check(t.feat.slice(0, 9))).toBe("ok");
		expect(await check(t.baseSha)).toBe("not_on_branch");
		expect(await check(t.onMain)).toBe("not_on_branch");
		expect(await check(t.other)).toBe("not_on_branch");
		expect(await check("deadbeefdeadbeef")).toBe("missing");
	});

	test("기록 모드: branchDiff is base_sha..branch — the feature commit, not main's later file", async () => {
		const t = await branchWithFeature();
		const diff = await t.ops.branchDiff({ worktree: t.row.worktree, branch: t.row.branch, baseSha: t.baseSha });
		expect(diff.ok).toBe(true);
		const text = diff.ok ? diff.value : "";
		expect(text).toContain("+++ b/feat.txt");
		expect(text).not.toContain("m.txt");
		expect(text).not.toContain("docs/tasks");
	});

	test("기록 모드: evaluateTask reads the records documents, passes an in-range commit and holds a base_sha NULL task as no_base", async () => {
		const t = await branchWithFeature();
		const dir = t.row.docsDir;
		expect(dir).toBe(docsDirUnder(recordsRepo, t.row.taskId));
		mkdirSync(dir, { recursive: true });
		const meta = {
			taskId: t.row.taskId,
			hostLabel: "local",
			repo: t.row.repo,
			worktree: t.row.worktree,
			branch: t.row.branch,
			agent: t.row.agent,
			threadLink: "x",
			registeredAt: NOW,
			timezone: "Asia/Seoul",
		};
		writeFileSync(
			join(dir, "spec.md"),
			renderSpec(
				meta,
				{ title: "t", risk: "L2", goal: "g", scope: [], exclusions: [], acceptance: [], repo: t.row.repo },
				t.row.acceptance,
			).replaceAll("- [ ] AC-", "- [x] AC-"),
		);
		writeFileSync(join(dir, "PROGRESS.md"), renderProgress(t.row.taskId, NOW, "Asia/Seoul"));
		const outcome = (hash: string): string =>
			["# outcome", "## 요약", "바뀌었습니다.", "## AC-1", `- commit: ${hash} feat: feature`, ""].join("\n");

		writeFileSync(join(dir, "outcome.md"), outcome(t.feat.slice(0, 9)));
		const reached = await evaluateTask(t.row, t.ops, memoryTaskChecks());
		expect(reached.ok && reached.judgement).toMatchObject({ reached: true, problems: [], integrityWarnings: [] });

		writeFileSync(join(dir, "outcome.md"), outcome(t.baseSha.slice(0, 9)));
		const atBase = await evaluateTask(t.row, t.ops, memoryTaskChecks());
		expect(atBase.ok && atBase.judgement.reached).toBe(false);
		expect(atBase.ok && atBase.judgement.problems).toEqual([
			expect.stringContaining(`commit ${t.baseSha.slice(0, 9)}`),
		]);

		writeFileSync(join(dir, "outcome.md"), outcome(t.feat.slice(0, 9)));
		const noBase: TaskRow = { ...t.row, baseSha: null };
		const held = await evaluateTask(noBase, t.ops, memoryTaskChecks());
		expect(held.ok && held.judgement.reached).toBe(false);
		expect(held.ok && held.judgement.problems).toEqual([expect.stringContaining(`commit ${t.feat.slice(0, 9)}`)]);
	});
});
