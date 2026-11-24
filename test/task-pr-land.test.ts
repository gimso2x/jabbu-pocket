import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PR_LAND_POLL_MS } from "../src/lanes/pr-land-steps";
import { renderProgress, renderSpec } from "../src/tasks/docs";
import { evaluateTask, memoryTaskChecks } from "../src/tasks/evaluate";
import { createTaskHostOps, type TaskHostOps } from "../src/tasks/host";
import type { TaskRow } from "../src/tasks/ledger";
import { integrityBaseOf } from "../src/tasks/pr-land-task";
import { git } from "./helpers/git-fixtures";
import { PLANTED, passed, SLUG, TaskPrWorld } from "./helpers/task-pr-harness";

// A reached local [TASK] in a `lanes.land` pr repository lands through a PR: the real
// daemon, real git in temp directories, a local bare repository as GitHub's copy of the repository, a fake `gh`.

let w: TaskPrWorld;

beforeEach(async () => {
	w = await TaskPrWorld.start();
});

afterEach(async () => {
	await w.close();
});

const pushes = () => w.fake.callsOf("git", "push");
const ghCalls = () => w.fake.calls.filter((call) => call.program === "gh");
const tipOf = (row: TaskRow, ref = row.branch): string => git(w.repo, "rev-parse", ref);

/** Nothing the planted text matched is in the thread, the ledger row or the fake's records. */
function expectNoPlanted(row: TaskRow): void {
	const seen = JSON.stringify([w.row(row.taskId), w.posts(), w.fake.calls.map((call) => call.argv)]);
	expect(seen).not.toContain(PLANTED);
}

/** Lands the seeded task by auto-merge; its PR is open afterwards. */
async function open(options: Parameters<TaskPrWorld["seed"]>[0] = {}) {
	const seeded = w.seed(options);
	const outcome = await w.daemon.autoLand(seeded.row);
	expect(outcome).toMatchObject({ state: "pr-open" });
	return seeded;
}

describe("게이트: push·gh 호출 0회로 blocked, TASK는 review", () => {
	async function expectBlocked(row: TaskRow, reason: string): Promise<void> {
		const outcome = await w.daemon.autoLand(row);
		expect(outcome).toMatchObject({ state: "blocked", reason: expect.stringContaining(reason) });
		expect(pushes()).toHaveLength(0);
		expect(ghCalls()).toHaveLength(0);
		expect(w.row(row.taskId).status).toBe("review");
		expect(w.mergeInbounds()).toHaveLength(0);
		expectNoPlanted(row);
	}

	test("게이트: 재판정이 실패하면(재판정 문제·판정 오류) 아무것도 내보내지 않는다", async () => {
		const { row } = w.seed();
		w.judge = async () => passed({ problems: ["AC-1: 조건 미충족"] });
		await expectBlocked(row, "재판정 문제");
		w.judge = async () => ({ ok: false, error: "spec.md를 읽지 못함" });
		await expectBlocked(row, "판정 오류");
		expect(w.leakInputs).toHaveLength(0);
	});

	test("게이트: dirty worktree면 blocked", async () => {
		const { row } = w.seed();
		writeFileSync(join(row.worktree, "wip.txt"), "wip\n");
		await expectBlocked(row, "커밋 안 된 변경");
		expect(w.leakInputs).toHaveLength(0);
	});

	test("게이트: 누출 검사 — denylist 줄이 diff에 있으면 blocked, 일치한 글자는 어디에도 없다", async () => {
		const { row } = w.seed({ commits: (wt) => w.commit(wt, ["a.txt"], `${PLANTED}\n`) });
		await expectBlocked(row, "누출 검사 실패 1건");
		expect(w.leakInputs).toHaveLength(1);
		const reason = (await w.daemon.autoLand(w.row(row.taskId))) as { reason: string };
		expect(reason.reason).toContain("a.txt:1 (denylist)");
	});

	test("게이트: 누출 검사 — 중간 커밋에만 있다 지운 denylist 줄도 blocked", async () => {
		const { row } = w.seed({
			commits: (wt) => {
				w.commit(wt, ["leak.txt"], `${PLANTED}\n`);
				git(wt, "rm", "-q", "--", "leak.txt");
				git(wt, "commit", "-q", "-m", "remove it again");
				w.commit(wt, ["a.txt"]);
			},
		});
		await expectBlocked(row, "leak.txt:1 (denylist)");
	});

	test("게이트: 누출 검사 — 커미터 이메일에 denylist가 있으면 blocked", async () => {
		const { row } = w.seed({
			commits: (wt) => w.commit(wt, ["a.txt"], undefined, "-c", `user.email=dev@${PLANTED}.example`),
		});
		await expectBlocked(row, "committer (denylist)");
	});

	test("게이트: 누출 검사 — recordsRepo 경로(docs/tasks/)가 diff에 있으면 blocked", async () => {
		const { row } = w.seed({
			commits: (wt) => w.commit(wt, ["a.txt", "docs/tasks/T-20270101-1/spec.md"]),
		});
		await expectBlocked(row, "docs/tasks/T-20270101-1/spec.md:0 (records path)");
	});
});

describe("PR 생성: origin 직접 push, 본문은 acceptance 요약", () => {
	test("PR 생성: force 없이 push하고 포크는 0회, 본문은 --body-file 임시 파일(acceptance 요약)이며 outcome.md는 읽지 않는다", async () => {
		const { row, sha } = w.seed();
		const outcomeText = "OUTCOME-ONLY-MARKER-4471";
		const docs = row.docsDir;
		writeFileSync(join(docs, "outcome.md"), `## AC-1\n- ${outcomeText}\n`);
		writeFileSync(join(row.worktree, "notes.txt"), "WORKTREE-ONLY-MARKER-9012\n");
		git(row.worktree, "add", "--", "notes.txt");
		git(row.worktree, "commit", "-q", "-m", "notes");
		const tip = tipOf(row);
		expect(await w.daemon.autoLand(w.row(row.taskId))).toMatchObject({ state: "pr-open" });
		const pushed = pushes();
		expect(pushed).toHaveLength(1);
		expect(pushed[0]?.argv.slice(-3)).toEqual(["push", "origin", `${tip}:refs/heads/${row.branch}`]);
		expect(pushed[0]?.argv.some((arg) => arg.includes("force") || arg.startsWith("+") || arg === "-f")).toBe(false);
		expect(git(w.bare, "rev-parse", `refs/heads/${row.branch}`)).toBe(tip);
		expect(tip).not.toBe(sha);
		expect(w.fake.callsOf("gh", "fork")).toHaveLength(0);
		expect(w.fake.callsOf("gh", "repo")).toHaveLength(0);
		const created = w.fake.callsOf("gh", "pr", "create");
		expect(created).toHaveLength(1);
		expect(created[0]?.argv).toContain("--body-file");
		const body = created[0]?.bodyFile?.text ?? "";
		expect(body).toContain("수락기준 2/2 재판정 통과");
		expect(body).toContain("- AC-1 하나");
		expect(body).toContain("- AC-2 둘");
		for (const absent of [outcomeText, "WORKTREE-ONLY-MARKER-9012", row.worktree, docs])
			expect(body).not.toContain(absent);
		expect(w.fake.bodyDirs).toHaveLength(1);
		expect(existsSync(w.fake.bodyDirs[0] ?? "")).toBe(false);
		expect(w.record(row.taskId)).toMatchObject({
			mode: "pr",
			state: "active",
			requestedBy: "auto",
			sha: tip,
			baseBranch: "main",
			prLand: { number: 1, step: "pr-created", pushedSha: tip },
		});
		expect(w.row(row.taskId).status).toBe("review");
	});

	test("PR 생성: 이미 열린 PR이 있으면 `gh pr create`를 부르지 않고 그 번호를 쓴다", async () => {
		const { row } = w.seed();
		const tip = tipOf(row);
		git(row.worktree, "push", "-q", "origin", `${tip}:refs/heads/${row.branch}`);
		w.fake.prs.push({
			number: 7,
			url: `https://github.com/${SLUG}/pull/7`,
			head: row.branch,
			base: "main",
			title: row.title,
			body: "",
			state: "OPEN",
			headSha: tip,
		});
		await w.daemon.autoLand(row);
		expect(w.fake.callsOf("gh", "pr", "create")).toHaveLength(0);
		expect(w.record(row.taskId)?.prLand).toMatchObject({ number: 7, step: "pr-created" });
	});

	test("PR 생성: 승인 카드(requestApproval)는 0회 — 버튼이 달린 카드가 스레드에 올라가지 않는다", async () => {
		await open();
		const cards = w.transport.calls.filter(
			(call) => call.method === "createMessage" && (call.components?.length ?? 0) > 0,
		);
		expect(cards).toHaveLength(0);
		expect(w.posts().some((text) => text.includes("PR을 열었습니다"))).toBe(true);
	});
});

describe("CI 폴링: 스위퍼가 PR_LAND_POLL_MS 간격으로만 읽고 squash 머지한다", () => {
	test("CI 폴링: 간격 안에서는 읽지 않고, success면 검사한 sha로 머지·로컬 ff·정리·done(core-land)", async () => {
		const { row } = await open();
		const sha = w.record(row.taskId)?.sha ?? "";
		w.fake.setCi(sha, "pending");
		await w.poll();
		const reads = ghCalls().length;
		expect(w.record(row.taskId)?.prLand.lastPolledAt).toBeNumber();
		// Inside the interval: the PR is not read.
		w.advance(PR_LAND_POLL_MS - 1_000);
		await w.daemon.sweepTasks();
		expect(ghCalls()).toHaveLength(reads);
		expect(w.fake.callsOf("gh", "merge")).toHaveLength(0);

		w.fake.setCi(sha, "success");
		const before = tipOf(row, "main");
		await w.poll(2_000);
		const merges = w.fake.callsOf("gh", "merge");
		expect(merges).toHaveLength(1);
		expect(merges[0]?.argv).toEqual(
			expect.arrayContaining(["--squash", "--delete-branch", "--match-head-commit", sha]),
		);
		const remoteBase = git(w.bare, "rev-parse", "refs/heads/main");
		expect(remoteBase).not.toBe(before);
		expect(git(w.repo, "rev-parse", "refs/heads/main")).toBe(remoteBase);
		expect(git(w.repo, "rev-parse", "refs/remotes/origin/main")).toBe(remoteBase);
		expect(existsSync(join(w.repo, "a.txt"))).toBe(true);
		expect(existsSync(row.worktree)).toBe(false);
		expect(git(w.repo, "branch", "--list", row.branch)).toBe("");
		expect(w.row(row.taskId).status).toBe("done");
		expect(w.daemon.store.tasks.history(row.taskId).at(-1)).toMatchObject({
			fromStatus: "review",
			toStatus: "done",
			actor: "core-land",
		});
		expect(w.posts().some((text) => text.includes(`https://github.com/${SLUG}/pull/1`))).toBe(true);
		expect(readFileSync(join(w.repo, "a.txt"), "utf8")).toBe("a.txt\n");
	});
});

describe("머지 고정: 검사한 sha에만, 머지 직전 재검사", () => {
	test("머지 고정: PR head가 바뀌었으면 머지 0회로 held, TASK는 review", async () => {
		const { row } = await open();
		const sha = w.record(row.taskId)?.sha ?? "";
		w.fake.setCi(sha, "success");
		// A foreign commit lands on the PR branch.
		const foreign = w.commit(row.worktree, ["foreign.txt"]);
		git(w.repo, "push", "-q", "origin", `${foreign}:refs/heads/${row.branch}`);
		await w.poll();
		expect(w.record(row.taskId)).toMatchObject({
			state: "held",
			reason: expect.stringMatching(/^보류: PR head가 바뀜/),
		});
		expect(w.fake.callsOf("gh", "merge")).toHaveLength(0);
		expect(w.row(row.taskId).status).toBe("review");
		expect(w.posts().some((text) => text.includes("PR 착지 보류"))).toBe(true);
		// The stop card carries the `머지` button labelled "다시 시도" (a retry is the same click).
		const card = w.transport.calls.find(
			(call) => call.method === "createMessage" && JSON.stringify(call.embeds ?? "").includes("PR 착지 보류"),
		);
		expect(JSON.stringify(card && "components" in card ? card.components : [])).toContain(
			`ompbot:task:merge:${row.taskId}`,
		);
	});

	test("머지 고정: 머지 종료코드가 0이 아니어도 PR이 MERGED면 성공으로 진행한다", async () => {
		w.fake.mergeExit = 1;
		const { row } = await open();
		w.fake.setCi(w.record(row.taskId)?.sha ?? "", "success");
		await w.poll();
		expect(w.fake.callsOf("gh", "merge")).toHaveLength(1);
		expect(w.fake.prs[0]?.state).toBe("MERGED");
		expect(w.row(row.taskId).status).toBe("done");
	});

	test("머지 고정: 머지 직전 누출 검사가 한 번 더 돈다 — 편집된 PR 본문의 denylist는 머지 0회로 blocked", async () => {
		const { row } = await open();
		const sha = w.record(row.taskId)?.sha ?? "";
		w.fake.setCi(sha, "success");
		const gateChecks = w.leakInputs.length;
		expect(gateChecks).toBe(1);
		const pr = w.fake.prs[0];
		if (pr !== undefined) pr.body += `\n${PLANTED}\n`;
		await w.poll();
		expect(w.leakInputs).toHaveLength(gateChecks + 1);
		expect(w.record(row.taskId)).toMatchObject({
			state: "blocked",
			reason: expect.stringContaining("머지 직전 누출 검사 실패"),
		});
		expect(w.fake.callsOf("gh", "merge")).toHaveLength(0);
		expectNoPlanted(row);
	});

	test("머지 고정: 머지 직전 재검사는 정상 경로에서도 한 번 더 돈다", async () => {
		const { row } = await open();
		w.fake.setCi(w.record(row.taskId)?.sha ?? "", "success");
		await w.poll();
		expect(w.leakInputs).toHaveLength(2);
		expect(w.row(row.taskId).status).toBe("done");
	});

	test("머지 고정: 동결 중 ci-green TASK는 머지하지 않고, 풀리면 이어서 머지한다", async () => {
		const { row } = await open();
		w.fake.setCi(w.record(row.taskId)?.sha ?? "", "success");
		const freeze = join(w.home.dir, "FROZEN");
		writeFileSync(freeze, JSON.stringify({ since: "2027-01-15T00:00:00.000Z", reason: "test", by: "test" }));
		w.jumpRealClock();
		await w.poll();
		expect(w.record(row.taskId)).toMatchObject({ state: "active", prLand: { step: "ci-green" } });
		expect(w.fake.callsOf("gh", "merge")).toHaveLength(0);
		rmSync(freeze);
		w.jumpRealClock();
		await w.poll();
		expect(w.fake.callsOf("gh", "merge")).toHaveLength(1);
		expect(w.row(row.taskId).status).toBe("done");
	});
});

/** The resume prompts the worker got for a PR landing sent back to it (a sweep's own reminders are not these). */
const prompts = () =>
	w.herdr
		.filter((cmd) => cmd[2] === "prompt")
		.map((cmd) => cmd[4] ?? "")
		.filter((text) => text.includes("PR 착지를 마치지 못했습니다"));

/** The worker's next move: a new commit on the same branch and the task reaches review again. */
function workerFixes(row: TaskRow, file: string, content?: string): string {
	const sha = w.commit(row.worktree, [file], content);
	w.daemon.store.tasks.transition(row.taskId, "review", "bot");
	return sha;
}

describe("반송: CI 빨강은 워커로, 같은 PR에서 이어 간다", () => {
	/** Opens the PR and turns its CI red (`test` and `lint` fail). */
	async function red() {
		const seeded = await open();
		const sha = w.record(seeded.row.taskId)?.sha ?? "";
		w.fake.setCi(sha, "failure", ["test", "lint"]);
		await w.poll();
		return { ...seeded, sha };
	}

	test("반송: 스레드에 실패 잡 요약이 한 번, 워커에 재개 프롬프트, TASK는 working, 레코드는 rework(step 없음)", async () => {
		const { row } = await red();
		const notices = w.posts().filter((text) => text.includes("CI가 실패했습니다"));
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("test");
		expect(notices[0]).toContain("lint");
		expect(notices[0]).toContain(`https://github.com/${SLUG}/actions/runs/`);
		expect(w.row(row.taskId).status).toBe("working");
		const record = w.record(row.taskId);
		expect(record).toMatchObject({ mode: "pr", state: "rework", prLand: { number: 1, bounces: 1 } });
		expect(record?.prLand.step).toBeUndefined();
		expect(record?.sha).toBeUndefined();
		expect(record?.baseBranch).toBeUndefined();
		expect(record?.prLand.failedSig).toBeString();
		const sent = prompts();
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain(`같은 브랜치 \`${row.branch}\``);
		expect(sent[0]).toContain("force push");
		expect(w.mergeInbounds()).toHaveLength(0);
	});

	test("반송: 스위퍼는 rework 레코드를 폴링·재개하지 않는다 — 실패 요약은 다시 올라가지 않는다", async () => {
		const { row } = await red();
		const gh = ghCalls().length;
		const sent = prompts().length;
		for (let tick = 0; tick < 3; tick++) await w.poll();
		expect(ghCalls()).toHaveLength(gh);
		expect(prompts()).toHaveLength(sent);
		expect(w.posts().filter((text) => text.includes("CI가 실패했습니다"))).toHaveLength(1);
		expect(w.record(row.taskId)?.state).toBe("rework");
	});

	test("반송: 새 커밋으로 다시 도달하면 rejudge부터 돌아 같은 브랜치·같은 PR 번호로 이어지고 누출 검사가 새 커밋에서 다시 돈다", async () => {
		const { row } = await red();
		const judged = w.judgeCalls.length;
		const checked = w.leakInputs.length;
		const fixed = workerFixes(row, "b.txt");
		const outcome = await w.daemon.autoLand(w.row(row.taskId));
		expect(outcome).toMatchObject({ state: "pr-open" });
		expect(w.judgeCalls).toHaveLength(judged + 1);
		expect(w.leakInputs).toHaveLength(checked + 1);
		expect(w.leakInputs.at(-1)?.sha).toBe(fixed);
		expect(w.record(row.taskId)).toMatchObject({
			state: "active",
			sha: fixed,
			prLand: { number: 1, step: "pr-created", pushedSha: fixed },
		});
		expect(w.fake.callsOf("gh", "pr", "create")).toHaveLength(1);
		expect(w.fake.prs).toHaveLength(1);
		expect(git(w.bare, "rev-parse", `refs/heads/${row.branch}`)).toBe(fixed);
		expect(pushes()).toHaveLength(2);
		expect(pushes().every((call) => !call.argv.some((arg) => arg.includes("force") || arg.startsWith("+")))).toBe(true);
	});

	test("반송: 반송 뒤 새 커밋에 denylist 줄이 있으면 다시 도달해도 push 0회로 blocked", async () => {
		const { row } = await red();
		workerFixes(row, "b.txt", `${PLANTED}\n`);
		const pushed = pushes().length;
		const outcome = await w.daemon.autoLand(w.row(row.taskId));
		expect(outcome).toMatchObject({ state: "blocked", reason: expect.stringContaining("누출 검사 실패") });
		expect(pushes()).toHaveLength(pushed);
		expect(w.record(row.taskId)?.state).toBe("blocked");
		expectNoPlanted(row);
	});

	test("반송: BOUNCES_MAX(3)번 반송된 뒤에도 빨강이면 blocked — 워커는 더 깨우지 않는다", async () => {
		const { row } = await open();
		for (let round = 1; round <= 3; round++) {
			const record = w.record(row.taskId);
			w.fake.setCi(record?.sha ?? "", "failure", ["test"]);
			await w.poll();
			expect(w.record(row.taskId)).toMatchObject({ state: "rework", prLand: { bounces: round } });
			workerFixes(w.row(row.taskId), `fix-${round}.txt`);
			expect(await w.daemon.autoLand(w.row(row.taskId))).toMatchObject({ state: "pr-open" });
		}
		const sent = prompts().length;
		w.fake.setCi(w.record(row.taskId)?.sha ?? "", "failure", ["test"]);
		await w.poll();
		expect(w.record(row.taskId)).toMatchObject({ state: "blocked", reason: expect.stringContaining("3번") });
		expect(w.row(row.taskId).status).toBe("review");
		expect(prompts()).toHaveLength(sent);
	});
});

describe("핸드오프 없음: pr 모드는 모델 턴 '머지해'를 만들지 않는다", () => {
	test("핸드오프 없음: base가 앞서 merge가 충돌하면 워커 반송, ingestOwnerText 0회, rebase 호출 0회", async () => {
		const { row } = w.seed({ commits: (wt) => w.commit(wt, ["a.txt"], "task a\n") });
		w.moveBaseAhead(["a.txt"], "main a\n");
		const tip = tipOf(row);
		const outcome = await w.daemon.autoLand(row);
		expect(outcome).toMatchObject({ state: "rework", reason: expect.stringContaining("충돌") });
		expect(w.mergeInbounds()).toHaveLength(0);
		expect(w.transport.calls.some((call) => JSON.stringify(call).includes("🤖 자동 머지"))).toBe(false);
		expect(w.daemon.store.listInbound()).toHaveLength(0);
		const all = [...w.gitCalls, ...w.fake.calls.map((call) => call.argv)];
		expect(all.some((argv) => argv.includes("rebase"))).toBe(false);
		expect(all.some((argv) => argv.includes("merge") && argv.includes("origin/main"))).toBe(true);
		expect(pushes()).toHaveLength(0);
		expect(ghCalls()).toHaveLength(0);
		expect(tipOf(row)).toBe(tip);
		expect(git(row.worktree, "status", "--porcelain")).toBe("");
		expect(w.row(row.taskId).status).toBe("working");
		expect(w.record(row.taskId)).toMatchObject({ state: "rework", prLand: { bounces: 1 } });
		const sent = prompts();
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain("git merge origin/main");
		expect(sent[0]).toContain("rebase");
	});

	test("핸드오프 없음: 오너가 봐야 하는 판정 문제는 handoff가 아니라 blocked다(재판정 문제·판정 오류·무결성 경고)", async () => {
		const { row } = w.seed();
		const cases = [
			[passed({ problems: ["AC-1: 조건 미충족"] }), "재판정 문제"],
			[{ ok: false as const, error: "읽지 못함" }, "판정 오류"],
			[passed({ integrityWarnings: ["무결성 stub_implementation: x"] }), "무결성 경고"],
		] as const;
		for (const [verdict, reason] of cases) {
			w.judge = async () => verdict;
			const outcome = await w.daemon.autoLand(w.row(row.taskId));
			expect(outcome).toMatchObject({ state: "blocked", reason: expect.stringContaining(reason) });
		}
		expect(w.mergeInbounds()).toHaveLength(0);
		expect(w.daemon.store.listInbound()).toHaveLength(0);
		expect(w.row(row.taskId).status).toBe("review");
	});

	test("핸드오프 없음: 머지 버튼도 같다 — blocked면 카드 노트만 바뀌고 '머지해'는 들어가지 않는다", async () => {
		const { row } = w.seed();
		w.judge = async () => passed({ problems: ["AC-1: 조건 미충족"] });
		await w.clickMerge(row.taskId);
		expect(w.mergeInbounds()).toHaveLength(0);
		expect(w.daemon.store.listInbound()).toHaveLength(0);
		expect(w.judgeCalls).toHaveLength(1);
	});
});

describe("낡은 sha: 새 커밋으로 다시 도달하면 게이트부터", () => {
	test("낡은 sha: 저장된 pushedSha와 다른 새 커밋이면 step을 비우고 게이트부터 돌며 sha·baseBranch는 새 값, 낡은 sha로 머지하지 않는다", async () => {
		const { row } = await open();
		const old = w.record(row.taskId)?.sha ?? "";
		// The record of the earlier landing says other values than the new landing's.
		const record = w.record(row.taskId);
		if (record === null) throw new Error("no record");
		w.daemon.store.tasks.setLand(row.taskId, { ...record, baseBranch: "stale-base" });
		w.fake.setCi(old, "success");
		const fresh = w.commit(row.worktree, ["b.txt"]);
		w.crashes.length = 0;
		const checked = w.leakInputs.length;
		expect(await w.daemon.autoLand(w.row(row.taskId))).toMatchObject({ state: "pr-open" });
		expect(w.crashes).toContain("leak-passed");
		expect(w.leakInputs).toHaveLength(checked + 1);
		expect(w.leakInputs.at(-1)?.sha).toBe(fresh);
		expect(w.record(row.taskId)).toMatchObject({
			state: "active",
			sha: fresh,
			baseBranch: "main",
			prLand: { number: 1, step: "pr-created", pushedSha: fresh },
		});
		expect(w.fake.callsOf("gh", "pr", "create")).toHaveLength(1);
		// The old commit's green CI does not merge the new one.
		await w.poll();
		expect(w.fake.callsOf("gh", "merge")).toHaveLength(0);
		w.fake.setCi(fresh, "success");
		await w.poll();
		const merges = w.fake.callsOf("gh", "merge");
		expect(merges).toHaveLength(1);
		expect(merges[0]?.argv).toContain(fresh);
		expect(merges[0]?.argv).not.toContain(old);
		expect(w.row(row.taskId).status).toBe("done");
	});
});

describe("merge-base: base를 merge한 뒤 무결성 diff의 기준", () => {
	const TODO_FILE = "base-side.ts";
	const prConfig = () => ({ lanes: { land: { [w.repo]: { mode: "pr" as const } } }, recordsRepo: w.records });

	/** The three documents of a finished task whose one acceptance item is proven by commit `sha`. */
	function writeDocs(row: TaskRow, sha: string): void {
		const meta = {
			taskId: row.taskId,
			hostLabel: "local",
			repo: row.repo,
			worktree: row.worktree,
			branch: row.branch,
			agent: row.agent,
			threadLink: "x",
			registeredAt: w.clock.now(),
			timezone: "Asia/Seoul",
		};
		const spec = renderSpec(
			meta,
			{ title: "t", risk: "L2", goal: "g", scope: [], exclusions: [], acceptance: [], repo: row.repo },
			row.acceptance,
		).replaceAll("- [ ] AC-", "- [x] AC-");
		writeFileSync(join(row.docsDir, "spec.md"), spec);
		writeFileSync(join(row.docsDir, "PROGRESS.md"), renderProgress(row.taskId, w.clock.now(), "Asia/Seoul"));
		writeFileSync(
			join(row.docsDir, "outcome.md"),
			`# ${row.taskId} Outcome 증거\n## 요약\n바뀌었습니다.\n## AC-1\n- commit: ${sha.slice(0, 9)} feat: a\n`,
		);
	}

	/** The base branch's own commit (an unfinished-work marker line in a code file) and the task branch with it merged in by its worker. */
	function mergedTask(status: "working" | "review" = "review") {
		const { row, sha } = w.seed({ acceptance: ["하나"], status });
		writeDocs(row, sha);
		const baseSide = w.moveBaseAhead([TODO_FILE], "// TODO base side\nexport const x = 1;\n");
		git(w.repo, "fetch", "-q", "origin", "main");
		git(row.worktree, "merge", "-q", "--no-edit", "origin/main");
		return { row, feature: sha, baseSide, tip: tipOf(row) };
	}

	/** Spies on what the integrity read asks the host. */
	function spied() {
		const real = createTaskHostOps();
		const diffs: { baseSha: string; text: string }[] = [];
		const commits: { baseSha: string; hash: string; result: string }[] = [];
		const ops: TaskHostOps = {
			...real,
			branchDiff: async (input) => {
				const read = await real.branchDiff(input);
				diffs.push({ baseSha: input.baseSha, text: read.ok ? read.value : "" });
				return read;
			},
			commitOnTaskBranch: async (input) => {
				const result = await real.commitOnTaskBranch(input);
				commits.push({ baseSha: input.baseSha, hash: input.hash, result });
				return result;
			},
		};
		return { ops, diffs, commits };
	}

	test("merge-base: 코어가 base를 merge한 뒤 재판정은 merge-base sha를 integrityBase로 받고 row.baseSha는 그대로다", async () => {
		const { row } = w.seed();
		const original = row.baseSha;
		const ahead = w.moveBaseAhead(["b.txt"]);
		expect(await w.daemon.autoLand(row)).toMatchObject({ state: "pr-open" });
		expect(w.gitCalls.some((argv) => argv.includes("merge") && argv.includes("origin/main"))).toBe(true);
		expect(w.judgeCalls).toHaveLength(1);
		const call = w.judgeCalls[0];
		const merged = tipOf(row);
		expect(merged).not.toBe(row.baseSha);
		expect(call?.row.baseSha).toBe(original);
		expect(call?.options?.integrityBase).toBe(git(w.repo, "merge-base", "refs/remotes/origin/main", merged));
		expect(call?.options?.integrityBase).toBe(ahead);
		expect(call?.options?.integrityBase).not.toBe(original);
		expect(w.row(row.taskId).baseSha).toBe(original);
		expect(w.record(row.taskId)?.sha).toBe(merged);
	});

	test("merge-base: base 쪽 커밋만 건드린 파일은 무결성 diff에 없고, merge 이전 task 커밋 증거는 not_on_branch가 아니다", async () => {
		const { row, feature, baseSide } = mergedTask();
		const control = spied();
		const without = await evaluateTask(row, control.ops, memoryTaskChecks());
		// From `baseSha` alone the base's own marker line is read as the task's.
		expect(without.ok && without.judgement.problems.join("\n")).toContain("unfinished_work_marker");
		expect(control.diffs[0]?.baseSha).toBe(row.baseSha ?? undefined);

		const spy = spied();
		const lazy = async () => (await integrityBaseOf(prConfig(), row, w.fake.tools)) as string;
		const evaluation = await evaluateTask(row, spy.ops, memoryTaskChecks(), undefined, lazy);
		expect(evaluation.ok && evaluation.judgement.problems).toEqual([]);
		expect(evaluation.ok && evaluation.judgement.integrityWarnings).toEqual([]);
		expect(spy.diffs).toHaveLength(1);
		expect(spy.diffs[0]?.baseSha).toBe(baseSide);
		expect(spy.diffs[0]?.baseSha).toBe(git(w.repo, "merge-base", "refs/remotes/origin/main", tipOf(row)));
		expect(spy.diffs[0]?.text).not.toContain(TODO_FILE);
		expect(spy.diffs[0]?.text).not.toContain("TODO");
		expect(spy.commits.length).toBeGreaterThan(0);
		expect(spy.commits.every((call) => call.baseSha === row.baseSha)).toBe(true);
		expect(spy.commits.find((call) => feature.startsWith(call.hash))?.result).toBe("ok");
		expect(spy.commits.some((call) => call.result === "not_on_branch")).toBe(false);
	});

	test("merge-base: problems가 남은 판정에서는 지연 함수를 부르지 않아 git fetch·merge-base가 0회다", async () => {
		const { row, feature } = mergedTask();
		writeFileSync(join(row.docsDir, "outcome.md"), "");
		let lazyCalls = 0;
		const lazy = async () => {
			lazyCalls += 1;
			return integrityBaseOf(prConfig(), row, w.fake.tools);
		};
		const evaluation = await evaluateTask(row, spied().ops, memoryTaskChecks(), undefined, lazy);
		expect(evaluation.ok && evaluation.judgement.problems.length).toBeGreaterThan(0);
		expect(lazyCalls).toBe(0);
		expect(w.fake.callsOf("git", "fetch")).toHaveLength(0);
		// The same read without a problem asks for the base once: fetch first.
		writeDocs(row, feature);
		await evaluateTask(row, spied().ops, memoryTaskChecks(), undefined, lazy);
		expect(lazyCalls).toBe(1);
		expect(w.fake.callsOf("git", "fetch").length).toBeGreaterThan(0);
	});

	test("merge-base: 스위퍼 도달 경로의 evaluate도 같은 integrityBase를 받는다 — base 쪽 TODO가 무결성 문제를 만들지 않아 review로 도달한다", async () => {
		const { row } = mergedTask("working");
		expect(w.fake.callsOf("git", "fetch")).toHaveLength(0);
		await w.daemon.sweepTasks();
		const fetches = w.fake.callsOf("git", "fetch");
		expect(fetches.length).toBeGreaterThan(0);
		expect(fetches[0]?.argv).toEqual(["-C", w.repo, "fetch", "origin", "main"]);
		expect(w.row(row.taskId).status).toBe("review");
	});

	test("merge-base: branch가 row.baseSha의 후손이 아니면 기준을 바꾸지 않고 fetch도 하지 않는다", async () => {
		const { row } = mergedTask();
		const orphan = git(w.repo, "commit-tree", "-m", "unrelated", "HEAD^{tree}");
		w.daemon.store.tasks.setBaseSha(row.taskId, orphan);
		expect(await integrityBaseOf(prConfig(), w.row(row.taskId), w.fake.tools)).toBeUndefined();
		expect(w.fake.callsOf("git", "fetch")).toHaveLength(0);
	});
});

describe("레코드 상태: blocked·held·rework는 스위퍼가 만지지 않고 오너의 머지 버튼만 되돌린다", () => {
	const DAY = 24 * 60 * 60_000;
	type Waiting = "blocked" | "held" | "rework";

	/** A task with its PR open, then its record turned into `state` (TASK stays in review). */
	async function waiting(state: Waiting) {
		const { row } = await open();
		const record = w.record(row.taskId);
		if (record === null) throw new Error("no record");
		const prLand = state === "rework" ? reworked(record.prLand) : record.prLand;
		w.daemon.store.tasks.setLand(row.taskId, {
			...record,
			state,
			...(state === "rework" ? { sha: undefined, baseBranch: undefined } : {}),
			reason: `${state} 시험`,
			prLand,
		});
		return row;
	}

	function reworked(prLand: NonNullable<TaskRow["land"]>["prLand"]) {
		const { step: _step, ci: _ci, ...rest } = prLand;
		return rest;
	}

	for (const state of ["blocked", "held", "rework"] as const) {
		test(`레코드 상태: ${state} 레코드는 스위퍼가 폴링·runPrLanding을 하지 않는다(gh·git 호출 0회)`, async () => {
			const row = await waiting(state);
			w.fake.setCi(w.record(row.taskId)?.prLand.pushedSha ?? "", "success");
			const gh = w.fake.calls.length;
			const git = w.gitCalls.length;
			const crashes = w.crashes.length;
			const checks = w.leakInputs.length;
			const sent = prompts().length;
			await w.poll();
			await w.poll();
			expect(w.fake.calls).toHaveLength(gh);
			expect(w.gitCalls).toHaveLength(git);
			expect(w.crashes).toHaveLength(crashes);
			expect(w.leakInputs).toHaveLength(checks);
			expect(prompts()).toHaveLength(sent);
			expect(w.fake.callsOf("gh", "merge")).toHaveLength(0);
			expect(w.record(row.taskId)?.state).toBe(state);
			expect(w.row(row.taskId).status).toBe("review");
		});
	}

	for (const state of ["blocked", "held"] as const) {
		test(`레코드 상태: ${state} 레코드의 24시간 재알림은 평소대로 한 번 나간다`, async () => {
			const row = await waiting(state);
			const gh = w.fake.calls.length;
			const alerts = () => w.posts().filter((text) => text.includes("리뷰 대기"));
			await w.poll();
			expect(alerts()).toHaveLength(0);
			w.advance(DAY);
			await w.daemon.sweepTasks();
			expect(alerts()).toHaveLength(1);
			await w.daemon.sweepTasks();
			expect(alerts()).toHaveLength(1);
			expect(w.fake.calls).toHaveLength(gh);
			expect(w.record(row.taskId)?.state).toBe(state);
		});
	}

	for (const state of ["blocked", "held", "rework"] as const) {
		test(`레코드 상태: 오너의 머지 버튼만 ${state} 레코드를 rejudge부터 다시 돌려 active로 되돌린다`, async () => {
			const row = await waiting(state);
			const judged = w.judgeCalls.length;
			const checks = w.leakInputs.length;
			await w.clickMerge(row.taskId);
			expect(w.judgeCalls).toHaveLength(judged + 1);
			expect(w.record(row.taskId)).toMatchObject({ mode: "pr", state: "active", requestedBy: "owner" });
			expect(w.record(row.taskId)?.sha).toBeString();
			expect(w.record(row.taskId)?.baseBranch).toBe("main");
			expect(w.record(row.taskId)?.reason).toBeUndefined();
			// A rework record starts at the gate again; a record with a step goes on from it.
			expect(w.leakInputs).toHaveLength(state === "rework" ? checks + 1 : checks);
			expect(w.fake.callsOf("gh", "pr", "create")).toHaveLength(1);
		});
	}

	test("레코드 상태: held의 poll 단계 재개는 pushedAt을 다시 잡는다", async () => {
		const { row } = await open();
		const sha = w.record(row.taskId)?.sha ?? "";
		const startedAt = w.record(row.taskId)?.prLand.pushedAt ?? 0;
		w.fake.setCi(sha, "success");
		// A foreign commit lands on the PR branch (the local branch stays at `sha`): the landing is held.
		const foreign = w.commit(row.worktree, ["foreign.txt"]);
		git(w.repo, "push", "-q", "origin", `${foreign}:refs/heads/${row.branch}`);
		git(row.worktree, "reset", "-q", "--hard", sha);
		await w.poll(10 * 60_000);
		expect(w.record(row.taskId)?.state).toBe("held");
		expect(w.record(row.taskId)?.prLand.pushedAt).toBe(startedAt);
		w.advance(5 * 60_000);
		await w.clickMerge(row.taskId);
		expect(w.record(row.taskId)).toMatchObject({ state: "active", prLand: { step: "pr-created", pushedSha: sha } });
		expect(w.record(row.taskId)?.prLand.pushedAt).toBe(w.clock.now());
		expect(w.record(row.taskId)?.prLand.pushedAt).toBeGreaterThan(startedAt);
		expect(w.fake.callsOf("gh", "pr", "create")).toHaveLength(1);
	});
});
