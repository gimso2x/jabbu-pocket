import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { DiscordChannelConfig, JabbuConfig } from "../src/config";
import { Daemon } from "../src/daemon/daemon";
import type { ProcResult, ProcRunner, PrTools } from "../src/lanes/pr";
import {
	diffPr,
	excerpt,
	ghApiOf,
	PR_WATCH_IGNORE,
	PR_WATCH_INTERVAL_MS,
	parsePrRef,
	prWatchLine,
	prWatchPass,
} from "../src/lanes/pr-watch";
import type { LanePrWatch } from "../src/lanes/status";
import { parsePrWatchCommand } from "../src/lanes/trigger";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import {
	CHANNEL,
	discordBinding,
	GUILD,
	makeHome,
	OWNER,
	OWNER_DM,
	type TestHome,
	WaitingDiscordTransport,
} from "./helpers/bot-home";
import { makeRepo } from "./helpers/git-fixtures";
import { LANE_START, type LaneHarness, laneHarness, removeRepoAndWorktrees } from "./helpers/lane-harness";

// PR 게시 뒤 추적: gh는 가짜다. 여기서 나가는 것은 로컬 Discord fake 뿐이고 GitHub에 닿지 않는다.
// Cataly T/pr-watch.test.ts의 사례(기준선, 리뷰 철회, 강제 푸시 rewritten, 실패 체크, 머지 종료, 읽기 실패 커서 유지)를
// 가짜 `gh api` 위로 옮기고, 레인 매니저 통합(게시된 PR의 tick 패스, `!prwatch off`)을 더한다.

const UPSTREAM = "acme/app";
const PR_URL = `https://github.com/${UPSTREAM}/pull/7`;
const T0 = Date.parse("2026-11-17T00:00:00Z");
const sha = (c: string): string => c.repeat(40);

type Row = {
	id: number;
	user: { login: string } | null;
	html_url: string;
	body: string | null;
	state?: string;
	updated_at: string;
};
type FakeCommit = { sha: string; author: string | null; committer?: string; email?: string };
type FakePr = {
	state: "open" | "closed";
	merged: boolean;
	mergeSha?: string;
	head: string;
	commits: FakeCommit[];
	reviewComments: Row[];
	comments: Row[];
	reviews: Row[];
	dismissals: { id: number; review_id: number; message: string | null; actor: string }[];
	/** 메타를 읽을 때마다 부르는 훅(읽는 도중 PR이 바뀌는 상황을 흉내 낸다). */
	onMeta?: (reads: number) => void;
	metaReads: number;
	/** check-runs 응답의 total_count를 바꿔치기한다. */
	checksTotal?: number;
	checks: Record<
		string,
		{ id: number; name: string; conclusion: string | null; html_url: string; head_sha?: string }[]
	>;
	statuses: Record<string, { id: number; state: string; context: string; target_url: string }[]>;
};

const row = (id: number, login: string, body: string, state?: string): Row => ({
	id,
	user: { login },
	html_url: `${PR_URL}#c${id}`,
	body,
	updated_at: "2026-11-17T00:00:00Z",
	...(state !== undefined ? { state } : {}),
});

const openPr = (head = sha("a"), author = "me"): FakePr => ({
	state: "open",
	merged: false,
	head,
	commits: [{ sha: head, author, committer: author }],
	reviewComments: [],
	comments: [],
	reviews: [],
	dismissals: [],
	metaReads: 0,
	checks: {},
	statuses: {},
});

interface FakeGitHub {
	/** `gh api --method GET`를 흉내 내는 `PrTools.gh`. */
	gh: ProcRunner;
	/** `ghApiOf`로 감싼 읽기 함수(패스 단위 테스트가 쓴다). */
	run: (endpoint: string) => Promise<unknown>;
	calls: string[];
	/** 끝점 일부 → 오류 문구: 지울 때까지 그 읽기는 실패한다. */
	failing: Map<string, string>;
}

/** `gh api --method GET`의 가짜: 한 저장소의 PR 하나를 Cataly 테스트의 가짜 표대로 읽는다. */
function fakeGitHub(pr: FakePr, login: string | null = "me"): FakeGitHub {
	const calls: string[] = [];
	const failing = new Map<string, string>();
	const ok = (value: unknown): ProcResult => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
	const gh: ProcRunner = async (argv) => {
		if (argv[0] !== "api" || argv[1] !== "--method" || argv[2] !== "GET" || argv.length !== 4)
			throw new Error(`argv ${argv}`);
		const endpoint = argv[3] as string;
		calls.push(endpoint);
		for (const [part, err] of failing) if (endpoint.includes(part)) return { code: 1, stdout: "", stderr: err };
		if (endpoint === "user") return login === null ? { code: 1, stdout: "", stderr: "HTTP 401" } : ok({ login });
		const [path, query = ""] = endpoint.split("?") as [string, string?];
		const page = Number(new URLSearchParams(query).get("page") ?? 1);
		const slice = <T>(rows: T[]) => rows.slice((page - 1) * 100, page * 100);
		const commitJson = (c: FakeCommit) => {
			const committer = c.committer ?? c.author;
			return {
				sha: c.sha,
				author: c.author ? { login: c.author } : null,
				committer: committer ? { login: committer } : null,
				commit: { author: { email: c.email ?? "" }, committer: { email: c.email ?? "" } },
			};
		};
		const compared = /^repos\/[^/]+\/[^/]+\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(path);
		if (compared) {
			// 선형 역사만: 두 sha를 다 가진 PR에서 무엇이 뒤따르는지, 없으면 diverged rewrite.
			const at = pr.commits.findIndex((c) => c.sha === compared[1]);
			const upto = pr.commits.findIndex((c) => c.sha === compared[2]);
			const added = at >= 0 ? pr.commits.slice(at + 1, upto + 1) : pr.commits.slice(0, upto + 1);
			return ok({ status: at >= 0 ? "ahead" : "diverged", commits: slice(added).map(commitJson) });
		}
		const m = /^repos\/([^/]+\/[^/]+)\/(pulls|issues|commits)\/([^/]+)(?:\/(.+))?$/.exec(path);
		if (!m) throw new Error(`unexpected read ${endpoint}`);
		const [, , kind, id, rest] = m;
		if (kind === "commits" && rest === "check-runs")
			return ok({
				total_count: pr.checksTotal ?? (pr.checks[id as string] ?? []).length,
				check_runs: slice(pr.checks[id as string] ?? []).map((c) => ({ head_sha: id, ...c })),
			});
		if (kind === "commits" && rest === "statuses") return ok(slice(pr.statuses[id as string] ?? []));
		if (kind === "issues" && rest === "timeline")
			return ok(
				slice([
					{ event: "labeled", id: 1 },
					...pr.dismissals.map((d) => ({
						event: "review_dismissed",
						id: d.id,
						actor: { login: d.actor },
						created_at: "2026-11-17T00:00:00Z",
						dismissed_review: { review_id: d.review_id, dismissal_message: d.message },
					})),
				]),
			);
		if (kind === "issues" && rest === "comments") return ok(slice(pr.comments));
		if (kind === "pulls" && rest === undefined) {
			pr.onMeta?.(++pr.metaReads);
			return ok({
				state: pr.state,
				merged: pr.merged,
				merge_commit_sha: pr.mergeSha ?? null,
				head: { sha: pr.head },
				html_url: PR_URL,
			});
		}
		if (kind === "pulls" && rest === "comments") return ok(slice(pr.reviewComments));
		if (kind === "pulls" && rest === "reviews") return ok(slice(pr.reviews));
		// GitHub은 PR 커밋을 최대 250개까지만 준다.
		if (kind === "pulls" && rest === "commits") return ok(slice(pr.commits.slice(0, 250)).map(commitJson));
		throw new Error(`unexpected read ${endpoint}`);
	};
	const tools: PrTools = {
		git: async () => {
			throw new Error("git is never called by pr-watch");
		},
		gh,
	};
	return {
		gh,
		run: ghApiOf(tools, { cwd: process.cwd(), signal: new AbortController().signal }),
		calls,
		failing,
	};
}

const who = (ignore: ReadonlySet<string> = new Set()): { self: string; ignore: ReadonlySet<string> } => ({
	self: "me",
	ignore,
});

/** 커서를 저장하는 한 패스(Cataly CLI처럼 줄을 내고 커서를 저장한다). */
async function pass(
	gh: FakeGitHub,
	cursor: LanePrWatch | undefined,
	now: number,
	options: { ignore?: ReadonlySet<string> } = {},
): Promise<{ events: string[]; entry?: LanePrWatch; reason?: string }> {
	const result = await prWatchPass({
		api: gh.run,
		ref: { repo: UPSTREAM, number: 7 },
		prev: cursor,
		who: who(options.ignore),
		now: new Date(now).toISOString(),
	});
	if (!result.ok) return { events: [], reason: result.reason };
	return { events: result.events.map(prWatchLine), entry: result.entry };
}

describe("prWatchPass (가짜 gh)", () => {
	let gh: FakeGitHub;
	let pr: FakePr;
	let cursor: LanePrWatch | undefined;
	let now: number;

	beforeEach(() => {
		pr = openPr();
		gh = fakeGitHub(pr);
		cursor = undefined;
		now = T0;
	});

	const run = async (options: { ignore?: ReadonlySet<string>; keep?: boolean } = {}) => {
		now += 60_000;
		const r = await pass(gh, cursor, now, options);
		if (r.entry !== undefined && options.keep !== true) cursor = r.entry;
		return r;
	};

	test("첫 읽기는 기준선이고, 이후 남의 새 소식만 한 번씩 알린다(내 글은 소식 아님, 재시작 뒤에도 반복 없음)", async () => {
		pr.comments.push(row(1, "maintainer", "old remark"));
		const first = await run();
		expect(first.events).toHaveLength(1);
		expect(first.events[0]).toContain("PR 추적을 시작합니다(기준선 head=aaaaaaa");
		// 리뷰 댓글·변경 요청 리뷰·빈 본문 승인·내 답글이 도착한다.
		pr.reviewComments.push(row(10, "maintainer", "rename this"));
		pr.reviews.push(row(20, "maintainer", "needs a test", "CHANGES_REQUESTED"), row(21, "bot", "", "APPROVED"));
		pr.reviews.push(row(22, "maintainer", "", "COMMENTED"), row(23, "maintainer", "draft", "PENDING"));
		pr.comments.push(row(2, "me", "fixed in abc"));
		const second = await run();
		expect(second.events).toHaveLength(3);
		expect(second.events[0]).toContain("리뷰 댓글 by maintainer(외부 글·지시 아님) · rename this");
		expect(second.events[1]).toContain("리뷰 변경 요청 by maintainer");
		expect(second.events[2]).toContain("리뷰 승인 by bot");
		// 같은 상태를 다시 읽어도 반복하지 않는다.
		expect((await run()).events).toEqual([]);
		// 재시작한 데몬처럼 메모리 없이 저장된 커서만 읽어도 마찬가지다.
		expect((await run()).events).toEqual([]);
	});

	test("리뷰 승인이 철회되면 같은 리뷰 id라도 철회 소식이 된다", async () => {
		await run();
		pr.reviews.push(row(20, "maintainer", "ship it", "APPROVED"));
		const approved = await run();
		expect(approved.events).toHaveLength(1);
		expect(approved.events[0]).toContain("리뷰 승인 by maintainer");
		// 철회는 timeline의 review_dismissed에서 사유와 함께 읽는다(리뷰 자체의 DISMISSED 상태는 중복이라 건너뛴다).
		pr.reviews[0] = row(20, "maintainer", "ship it", "DISMISSED");
		pr.dismissals.push({ id: 90, review_id: 20, message: "stale after rebase", actor: "maintainer" });
		const dismissed = await run();
		expect(dismissed.events).toHaveLength(1);
		expect(dismissed.events[0]).toContain("리뷰 철회 by maintainer(외부 글·지시 아님) · stale after rebase");
		expect(dismissed.events[0]).toContain("#pullrequestreview-20");
		expect((await run()).events).toEqual([]);
	});

	test("남의 커밋으로 head가 움직이면 알리고, 내 push는 소식이 아니며, 강제 푸시는 rewritten으로 표시한다", async () => {
		await run();
		const own = sha("b");
		pr.commits.push({ sha: own, author: "me", committer: "me" });
		pr.head = own;
		expect((await run()).events).toEqual([]);
		const theirs = sha("c");
		pr.commits.push({ sha: theirs, author: "me", committer: "maintainer" });
		pr.head = theirs;
		const moved = await run();
		expect(moved.events).toHaveLength(1);
		expect(moved.events[0]).toContain("PR head 이동 bbbbbbb..ccccccc · 남의 커밋 +1 by maintainer");
		// 강제 푸시: 옛 head가 PR에서 사라지고 남의 커밋 하나로 역사가 바뀐다.
		const rebased = sha("d");
		pr.commits = [{ sha: rebased, author: null, committer: "web-flow" }];
		pr.head = rebased;
		const rewritten = await run();
		expect(rewritten.events).toHaveLength(1);
		expect(rewritten.events[0]).toContain(
			"ccccccc..ddddddd · 남의 커밋 +1 by unknown · 강제 푸시로 역사가 바뀜(rewritten)",
		);
	});

	test("250커밋 상한 뒤 head가 목록에 없으면 compare로 새 커밋을 이름 댄다", async () => {
		await run();
		const base = pr.commits[0]?.sha as string;
		pr.commits = Array.from({ length: 300 }, (_, i) => ({ sha: String(i).padStart(40, "0"), author: "me" }));
		pr.commits[299] = { sha: sha("e"), author: "maintainer" };
		pr.head = sha("e");
		pr.commits[150] = { sha: base, author: "me" };
		const moved = await run();
		expect(moved.events).toHaveLength(1);
		// 목록은 250에서 잘리지만 compare가 알던 head 이후 149개를 이름 댄다(마지막 하나가 남의 커밋).
		expect(moved.events[0]).toContain("남의 커밋 +149 by maintainer");
		expect(moved.events[0]?.includes("rewritten")).toBe(false);
	});

	test("실패한 체크·상태는 head마다 한 번만 알리고, 다시 실패한 재실행은 새 소식이며, 성공·대기 중은 아니다", async () => {
		pr.checks[pr.head] = [{ id: 1, name: "old", conclusion: "failure", html_url: "https://github.com/x/1" }];
		await run();
		pr.checks[pr.head]?.push(
			{ id: 2, name: "test (macos)", conclusion: "timed_out", html_url: "https://github.com/x/2" },
			{ id: 3, name: "lint", conclusion: "success", html_url: "https://github.com/x/3" },
			{ id: 4, name: "e2e", conclusion: null, html_url: "https://github.com/x/4" },
		);
		pr.statuses[pr.head] = [
			{ id: 9, state: "error", context: "ci/external", target_url: "https://ci.example/9" },
			{ id: 8, state: "pending", context: "ci/slow", target_url: "https://ci.example/8" },
		];
		const fails = await run();
		expect(fails.events).toHaveLength(2);
		expect(fails.events[0]).toContain("PR 체크 실패 · test (macos)(timed_out) head=aaaaaaa");
		expect(fails.events[1]).toContain("ci/external(error)");
		const runs = pr.checks[pr.head] ?? [];
		runs[3] = { id: 4, name: "e2e", conclusion: "failure", html_url: "https://github.com/x/4" };
		runs.push({
			id: 5,
			name: "test (macos)",
			conclusion: "cancelled",
			html_url: "https://github.com/x/5",
		});
		const rerun = await run();
		expect(rerun.events).toHaveLength(2);
		expect(rerun.events[0]).toContain("e2e(failure)");
		expect(rerun.events[1]).toContain("test (macos)(cancelled)");
	});

	test("머지는 한 번 알리고 추적을 끝낸다(커서 state=merged)", async () => {
		await run();
		pr.state = "closed";
		pr.merged = true;
		pr.mergeSha = sha("f");
		const merged = await run();
		expect(merged.events).toHaveLength(1);
		expect(merged.events[0]).toContain(`PR이 머지됐습니다 (merge ${sha("f").slice(0, 12)}) · 추적을 끝냅니다.`);
		expect(merged.entry?.state).toBe("merged");
		expect(merged.entry?.closedAt).toBeDefined();
	});

	test("머지 없이 닫힌 PR은 첫 읽기에서도 기준선과 함께 닫힘을 알린다", async () => {
		pr.state = "closed";
		const closed = await run();
		expect(closed.events).toHaveLength(2);
		expect(closed.events[0]).toContain("PR 추적을 시작합니다(기준선 head=aaaaaaa, 상태=closed)");
		expect(closed.events[1]).toContain("PR이 머지 없이 닫혔습니다 · 추적을 끝냅니다.");
	});

	test("읽기 실패는 커서를 바꾸지 않고 같은 사유로는 한 번만 경고하며, 다음 성공 읽기가 새 소식을 낸다", async () => {
		const first = await run();
		const saved = cursor;
		gh.failing.set("/reviews", "HTTP 502: Bad Gateway");
		pr.comments.push(row(3, "maintainer", "ping"));
		const failed = await run();
		expect(failed.reason).toContain("HTTP 502: Bad Gateway");
		expect(cursor).toBe(saved);
		expect(cursor?.head).toBe(sha("a"));
		// 사유가 같으면 매니저가 다시 올리지 않는다(여기서는 패스 결과가 같은 사유를 되풀이해 돌려주는 것만 확인).
		expect((await run()).reason).toBe(failed.reason);
		gh.failing.clear();
		const recovered = await run();
		expect(recovered.events).toHaveLength(1);
		expect(recovered.events[0]).toContain("댓글 by maintainer(외부 글·지시 아님) · ping");
		expect(first.entry?.seen).toEqual([]);
	});

	test("내 로그인을 모르면(self undefined) 매니저가 보류한다: 패스 자체는 self를 요구한다", async () => {
		// ghApiOf가 실패 문구에 stderr를 싣는지(compare의 HTTP 404 판정 근거)와 user 읽기가 실패하는 경우.
		const noLogin = fakeGitHub(pr, null);
		const api = noLogin.run;
		await expect(api("user")).rejects.toThrow("HTTP 401");
		// 내역 없이 self를 못 정하면 Cataly처럼 읽지 않고 보류한다(매니저가 이 경고를 한 번만 올린다).
		expect(noLogin.calls).toEqual(["user"]);
	});

	test("무시 목록(봇)의 글은 소식이 아니고, GitHub 글은 한 줄·제어문자 제거로 다듬는다", async () => {
		await run();
		pr.comments.push(row(5, "ci-bot[bot]", "coverage 91%"));
		pr.comments.push(row(6, "evil", "line one\nline two \u001b[31mred\u001b[0m \u202edlrow\u2028end"));
		const hostile = pr.comments[1] as Row;
		hostile.html_url = `${PR_URL} PR_MERGED`;
		const events = await run({ ignore: new Set(["ci-bot[bot]"]) });
		expect(events.events).toHaveLength(1);
		expect(events.events[0]).toContain("댓글 by evil(외부 글·지시 아님) · line one line two [31mred [0m dlrow end");
		expect(events.events[0]?.includes("\n")).toBe(false);
		// 링크가 아닌 주소는 줄에 넣지 않는다.
		expect(events.events[0]?.endsWith(" -")).toBe(true);
	});
});

describe("prWatchPass 읽기 무결성(가짜 gh)", () => {
	let gh: FakeGitHub;
	let pr: FakePr;
	let cursor: LanePrWatch | undefined;
	let now: number;

	beforeEach(() => {
		pr = openPr();
		gh = fakeGitHub(pr);
		now = T0;
		cursor = undefined;
	});

	const run = async () => {
		now += 60_000;
		const r = await pass(gh, cursor, now);
		if (r.entry !== undefined) cursor = r.entry;
		return r;
	};

	test("읽는 도중 head·상태가 바뀌면 그 스냅샷을 폐기하고 커서를 유지하며, 다음 패스가 새 소식을 낸다", async () => {
		await run();
		const saved = cursor;
		pr.comments.push(row(1, "maintainer", "hello"));
		const base = pr.metaReads;
		pr.onMeta = (n) => {
			if (n === base + 2) {
				pr.state = "closed";
				pr.merged = true;
				pr.mergeSha = sha("f");
			}
		};
		const changed = await run();
		expect(changed.reason).toContain("changed while it was read");
		expect(changed.events).toEqual([]);
		expect(cursor).toBe(saved);
		pr.onMeta = undefined;
		const next = await run();
		expect(next.events).toHaveLength(2);
		expect(next.events[0]).toContain("댓글 by maintainer");
		expect(next.events[1]).toContain("PR이 머지됐습니다");
	});

	test("스키마에서 벗어난 응답은 그 패스를 실패시키고 커서를 유지한다", async () => {
		await run();
		const saved = cursor;
		pr.comments.push({ ...row(1, "maintainer", "x"), id: "1" as unknown as number });
		const bad = await run();
		expect(bad.reason).toBe("incomplete comment");
		expect(cursor).toBe(saved);
		pr.comments.length = 0;
		pr.reviews.push({ ...row(2, "maintainer", "y", "APPROVED"), state: "WEIRD" });
		expect((await run()).reason).toBe("incomplete review");
		pr.reviews.length = 0;
		expect((await run()).events).toEqual([]);
		expect(cursor).not.toBe(saved);
	});

	test("수정된 댓글·리뷰는 같은 id라도 지문이 달라 다시 알리고, 그대로면 반복하지 않는다", async () => {
		pr.comments.push(row(1, "maintainer", "first"));
		pr.reviews.push(row(20, "maintainer", "lgtm", "APPROVED"));
		await run();
		expect((await run()).events).toEqual([]);
		const edited = row(1, "maintainer", "first, edited");
		edited.updated_at = "2026-11-18T00:00:00Z";
		pr.comments[0] = edited;
		pr.reviews[0] = row(20, "maintainer", "lgtm after all", "APPROVED");
		const events = (await run()).events;
		expect(events).toHaveLength(2);
		expect(events[0]).toContain("댓글 by maintainer(외부 글·지시 아님) · first, edited");
		expect(events[1]).toContain("리뷰 승인 by maintainer(외부 글·지시 아님) · lgtm after all");
		expect((await run()).events).toEqual([]);
	});

	test("check-runs는 total_count·head와 어긋나면 실패하고, 상태는 context별 최신만 본다", async () => {
		pr.checks[pr.head] = [{ id: 1, name: "ci", conclusion: "success", html_url: "https://github.com/x/1" }];
		await run();
		pr.checksTotal = 3;
		expect((await run()).reason).toBe("incomplete check runs");
		pr.checksTotal = undefined;
		pr.checks[pr.head] = [
			{ id: 1, name: "ci", conclusion: "failure", html_url: "https://github.com/x/1", head_sha: sha("9") },
		];
		expect((await run()).reason).toBe("incomplete check runs");
		pr.checks[pr.head] = [];
		// 같은 context의 옛 실패는 새 성공에 묻히고, 최신이 실패인 context만 알린다.
		pr.statuses[pr.head] = [
			{ id: 5, state: "failure", context: "ci/a", target_url: "https://ci.example/5" },
			{ id: 7, state: "success", context: "ci/a", target_url: "https://ci.example/7" },
			{ id: 6, state: "failure", context: "ci/b", target_url: "https://ci.example/6" },
			{ id: 8, state: "error", context: "ci/b", target_url: "https://ci.example/8" },
		];
		const events = (await run()).events;
		expect(events).toHaveLength(1);
		expect(events[0]).toContain("ci/b(error)");
		expect(events[0]).toContain("https://ci.example/8");
	});

	test("머지 없이 닫힌 PR은 열린 기준선 뒤에도 닫힘을 알리고 추적을 끝낸다", async () => {
		await run();
		pr.state = "closed";
		const closed = await run();
		expect(closed.events).toHaveLength(1);
		expect(closed.events[0]).toContain("PR이 머지 없이 닫혔습니다");
		expect(closed.entry?.state).toBe("closed");
		expect(closed.entry?.closedAt).toBeDefined();
	});

	test("페이지 상한(500줄)을 넘기면 부분 스냅샷으로 알림 없이 버리고, 정확히 500줄은 전부 읽는다", async () => {
		await run();
		const saved = cursor;
		for (let i = 1; i <= 501; i++) pr.comments.push(row(i, "maintainer", `c${i}`));
		const partial = await prWatchPass({
			api: gh.run,
			ref: { repo: UPSTREAM, number: 7 },
			prev: saved,
			who: who(),
			now: new Date(now).toISOString(),
		});
		expect(partial).toMatchObject({ ok: false, partial: true });
		expect(cursor).toBe(saved);
		pr.comments.pop();
		const full = await run();
		expect(full.events).toHaveLength(500);
		// 한 번 알린 500개는 상한(400)을 넘겨도 다음 패스에 되살아나지 않는다.
		expect((await run()).events).toEqual([]);
	});
});

describe("parsePrRef", () => {
	test("PR 주소와 owner/repo#N을 읽고 나머지는 거부한다", () => {
		expect(parsePrRef(PR_URL)).toEqual({ repo: UPSTREAM, number: 7 });
		expect(parsePrRef(`${PR_URL}?diff=split`)).toEqual({ repo: UPSTREAM, number: 7 });
		expect(parsePrRef("acme/app#7")).toEqual({ repo: UPSTREAM, number: 7 });
		expect(parsePrRef("https://github.com/acme/app/pull/0")).toBeUndefined();
		expect(parsePrRef("nope")).toBeUndefined();
	});
});

describe("parsePrWatchCommand", () => {
	test("`!prwatch off <레인>`만 받고 나머지 형태는 사유와 함께 거부한다", () => {
		expect(parsePrWatchCommand("!prwatch off L-20261121-01")).toEqual({ op: "off", lane: "L-20261121-01" });
		expect(parsePrWatchCommand("  !prwatch   off   ext  ")).toEqual({ op: "off", lane: "ext" });
		expect(parsePrWatchCommand("!prwatch")).toEqual({ problem: expect.stringContaining("!prwatch off <레인 이름>") });
		expect(parsePrWatchCommand("!prwatch on ext")).toMatchObject({ problem: expect.any(String) });
		expect(parsePrWatchCommand("!prwatchoff ext")).toBeUndefined();
		expect(parsePrWatchCommand("prwatch off ext")).toBeUndefined();
	});
});

describe("레인 매니저 통합(가짜 gh)", () => {
	let home: TestHome;
	let repos: string[];
	let scratch: string[];

	beforeEach(() => {
		home = makeHome("jabbu-lane-prwatch-home-");
		repos = [];
		scratch = [];
	});

	afterEach(() => {
		home.remove();
		for (const repo of repos) removeRepoAndWorktrees(repo);
		for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
	});

	interface Setup {
		h: LaneHarness;
		lane: string;
		originKey: string;
		pr: FakePr;
		gh: FakeGitHub;
	}

	/** 게시된 외부 PR 레인: 레인을 띄운 뒤 registry에 published 상태를 직접 심는다(실제 publish는 lane-external-pr이 본다). */
	async function publishedLane(): Promise<Setup> {
		const repo = makeRepo(repos);
		const pr = openPr();
		const gh = fakeGitHub(pr);
		const h = laneHarness(home.dir, {
			prTools: { git: async () => ({ code: 1, stdout: "", stderr: "unused" }), gh: gh.gh },
		});
		const started = await h.manager.start({ title: "watch", cwd: repo, channel: CHANNEL });
		await h.settle();
		h.store.patchLane(started.name, undefined, {
			externalPr: { repo: UPSTREAM, base: "main", bodyFile: "pr-body.md", title: "watch", branch: "pr/x" },
			pr: { state: "published", url: PR_URL, branch: "pr/x", sha: sha("a"), at: LANE_START },
		});
		return { h, lane: started.name, originKey: started.originKey, pr, gh };
	}

	// 추적 한 줄들만(레인 시작·상태 메시지는 뺀다): 앞의 표지가 pr-watch 줄이다.
	const lines = (s: Setup) => s.h.transport.posts((text) => /^(?:👀|💬|🔨|🚫|✅|🚪|⚠️) PR/u.test(text));
	const tick = async (s: Setup, ms: number): Promise<void> => {
		s.h.advance(ms);
		await s.h.manager.tick();
		await s.h.settle();
	};

	test("게시 뒤 첫 패스는 기준선을 올리고 커서를 저장하며, 새 댓글은 다음 패스에 한 줄로 올린다", async () => {
		const s = await publishedLane();
		await tick(s, PR_WATCH_INTERVAL_MS - 1_000);
		expect(lines(s)).toEqual([]);
		expect(s.gh.calls).toEqual([]);
		await tick(s, 2_000);
		expect(s.gh.calls[0]).toBe("user");
		expect(lines(s)).toHaveLength(1);
		expect(lines(s)[0]?.content).toContain("PR 추적을 시작합니다(기준선 head=aaaaaaa");
		expect(s.h.store.getLane(s.lane)?.meta.pr?.watch?.head).toBe(sha("a"));
		s.pr.comments.push(row(11, "maintainer", "CI가 빨개요"));
		await tick(s, PR_WATCH_INTERVAL_MS);
		expect(lines(s)).toHaveLength(2);
		expect(lines(s)[1]?.content).toContain("댓글 by maintainer(외부 글·지시 아님) · CI가 빨개요");
		// 같은 소식은 다음 패스에도 반복되지 않는다.
		await tick(s, PR_WATCH_INTERVAL_MS);
		expect(lines(s)).toHaveLength(2);
	});

	test("머지가 확인되면 한 번 알리고 추적을 끝낸다: 그 뒤 tick은 gh를 부르지 않는다", async () => {
		const s = await publishedLane();
		await tick(s, PR_WATCH_INTERVAL_MS);
		s.pr.state = "closed";
		s.pr.merged = true;
		s.pr.mergeSha = sha("f");
		await tick(s, PR_WATCH_INTERVAL_MS);
		expect(lines(s).at(-1)?.content).toContain("PR이 머지됐습니다");
		expect(s.h.store.getLane(s.lane)?.meta.pr?.watch?.state).toBe("merged");
		const reads = s.gh.calls.length;
		await tick(s, PR_WATCH_INTERVAL_MS * 3);
		expect(s.gh.calls.length).toBe(reads);
	});

	test("읽기 실패는 커서를 유지하고 같은 사유로 한 번만 경고하며, 성공하면 새 소식을 올린다", async () => {
		const s = await publishedLane();
		await tick(s, PR_WATCH_INTERVAL_MS);
		const saved = s.h.store.getLane(s.lane)?.meta.pr?.watch;
		s.gh.failing.set("/reviews", "HTTP 502: Bad Gateway");
		await tick(s, PR_WATCH_INTERVAL_MS);
		expect(lines(s).at(-1)?.content).toContain("PR 추적 읽기 실패 · gh api repos/acme/app/pulls/7/reviews");
		expect(s.h.store.getLane(s.lane)?.meta.pr?.watch).toEqual(saved);
		// 같은 사유는 다시 올리지 않는다.
		await tick(s, PR_WATCH_INTERVAL_MS);
		expect(s.h.transport.posts((text) => text.includes("PR 추적 읽기 실패"))).toHaveLength(1);
		s.gh.failing.clear();
		s.pr.comments.push(row(12, "maintainer", "다시 왔어요"));
		await tick(s, PR_WATCH_INTERVAL_MS);
		expect(lines(s).at(-1)?.content).toContain("댓글 by maintainer");
	});

	test("`!prwatch off <레인>`은 추적을 끄고, 그 뒤 tick은 gh를 부르지 않는다", async () => {
		const s = await publishedLane();
		await tick(s, PR_WATCH_INTERVAL_MS);
		const reads = s.gh.calls.length;
		const outcome = await s.h.manager.stopPrWatch(s.lane);
		expect(outcome).toMatchObject({ handled: true });
		expect(outcome.text).toContain("PR 추적을 끕니다");
		expect(s.h.store.getLane(s.lane)?.meta.pr?.watchOff).toBe(true);
		expect((await s.h.manager.stopPrWatch(s.lane)).handled).toBe(false);
		await tick(s, PR_WATCH_INTERVAL_MS * 3);
		expect(s.gh.calls.length).toBe(reads);
	});

	test("추적할 PR이 없는 레인과 없는 레인은 오너에게 사유를 돌려준다", async () => {
		const s = await publishedLane();
		expect((await s.h.manager.stopPrWatch("L-19990101-99")).text).toContain("레인을 찾을 수 없습니다");
		s.h.store.patchLane(s.lane, undefined, { pr: { state: "held" } });
		expect((await s.h.manager.stopPrWatch(s.lane)).text).toContain("게시된 PR이 없는 레인입니다");
	});

	test("레인 스레드의 `!prwatch off <레인>`은 데몬이 직접 답하고 레인 세션에는 가지 않는다", async () => {
		const repo = makeRepo(repos);
		const transport = new WaitingDiscordTransport();
		transport.setChannel({ id: CHANNEL, type: 0, guildId: GUILD });
		const sessions = new FakeSessionStore();
		const drivers = new Map<string, FakeOmpDriver>();
		const clock = { now: () => Date.now() };
		const config: JabbuConfig = {
			...home.config,
			channels: { discord: { ...(home.config.channels.discord as DiscordChannelConfig), laneChannelId: CHANNEL } },
		};
		const daemon = new Daemon({
			config,
			channels: [discordBinding(transport)],
			log: createLogger({ sink: () => undefined, clock, redact }),
			ompVersion: "omp-test 0",
			bootId: "boot",
			driverFactory: (origin, sessionDir) => {
				const driver = new FakeOmpDriver({ sessionDir, store: sessions });
				drivers.set(origin, driver);
				return driver;
			},
		});
		try {
			await daemon.start();
			await daemon.inject({ origin: `discord/dm/${OWNER_DM}`, asOwner: true, text: `작업: watch @${repo}` });
			await transport.waitForPosts((text) => text.startsWith("ECHO 작업:"));
			const rootId = transport.posts((text) => text === "🔄 watch")[0]?.id ?? "";
			daemon.store.patchLane("watch", undefined, {
				pr: { state: "published", url: PR_URL, branch: "pr/x", sha: sha("a"), at: Date.now() },
			});
			const send = (content: string, id: string) =>
				transport.emitMessage({ id, channel_id: rootId, guild_id: GUILD, author: { id: OWNER }, content, type: 0 });
			await send("!prwatch off", "7200000000000000100");
			await transport.waitForPosts((text) => text.includes("!prwatch off <레인 이름>"));
			await send("!prwatch off watch", "7200000000000000200");
			await transport.waitForPosts((text) => text.includes("PR 추적을 끕니다"));
			expect(daemon.store.getLane("watch")?.meta.pr?.watchOff).toBe(true);
			// 코어가 답했으므로 레인 세션은 이 명령을 프롬프트로 받지 않는다.
			const prompts = drivers.get("jabbu/work/watch")?.calls.filter((call) => call.startsWith("prompt:")) ?? [];
			expect(prompts.some((call) => call.includes("prwatch"))).toBe(false);
		} finally {
			await daemon.stop();
		}
	});
});

describe("excerpt", () => {
	test("여러 줄·제어문자를 한 줄 공백으로 접고 길이에서 자른다", () => {
		expect(excerpt("a\nb\tc", 10)).toBe("a b c");
		expect([...excerpt("x".repeat(300))].length).toBe(160);
		expect(excerpt("y".repeat(300)).endsWith("…")).toBe(true);
		expect(PR_WATCH_IGNORE.has("github-actions")).toBe(true);
	});
});

// diffPr는 prWatchPass가 쓰는 하위 함수다: 커서 모양(seen·commits·closedAt)을 직접 검사한다.
describe("diffPr", () => {
	test("seen은 다시 읽어도 늘지 않고, 닫힌 상태는 closedAt을 남긴다", () => {
		const snap = {
			state: "closed" as const,
			head: sha("a"),
			url: PR_URL,
			feedback: [{ key: "ic:1", kind: "comment", by: "x", url: "", body: "b" }],
			failed: [],
		};
		const first = diffPr(undefined, snap, who(), "2026-11-17T00:00:00.000Z");
		expect(first.events.map((e) => e.kind)).toEqual(["baseline", "closed"]);
		expect(first.entry.seen).toEqual(["ic:1"]);
		expect(first.entry.closedAt).toBe("2026-11-17T00:00:00.000Z");
		const again = diffPr(first.entry, snap, who(), "2026-11-17T00:10:00.000Z");
		expect(again.entry.seen).toEqual(["ic:1"]);
	});
});
