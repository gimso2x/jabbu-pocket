import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JabbuConfig } from "../src/config";
import { openBotStore } from "../src/core/origin";
import { Daemon } from "../src/daemon/daemon";
import { createLogger } from "../src/log";
import { FakeOmpDriver, type FakeOmpDriverOptions, FakeSessionStore } from "../src/omp/fake-driver";
import type { Store } from "../src/store/db";
import { acceptanceItems } from "../src/tasks/docs";
import { turnNoteRepos } from "../src/wiki/notes";
import { discordBinding, makeHome, OWNER_DM, type TestHome, WaitingDiscordTransport } from "./helpers/bot-home";
import { daemonTestOptions } from "./helpers/disk";
import { git, makeRepo } from "./helpers/git-fixtures";
import { type WikiFixture, wikiFixture } from "./helpers/wiki-fixture";

// Notes of committing conversation turns: one per channel thread and day, one
// per DM turn, kept in their own ledger until the day is over.

/** 2027-01-15 12:00 KST. */
const NOON = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const THREAD_ORIGIN = "discord/ch/300000000000000001/t/400000000000000100";
const THREAD_REF = "300000000000000001:400000000000000100";

let home: TestHome;
let store: Store;
let wiki: WikiFixture;
let repos: string[];
let now: number;

beforeEach(() => {
	home = makeHome("jabbu-wiki-turns-home-");
	now = NOON;
	store = openBotStore(join(home.dir, "jabbu.db"), { now: () => now }, "Asia/Seoul");
	wiki = wikiFixture(store, { now: () => now });
	repos = [];
});
afterEach(() => {
	store.close();
	home.remove();
	wiki.remove();
	for (const repo of repos) rmSync(repo, { recursive: true, force: true });
});

/** A turn that committed `subject` in `repo`: its before and after heads. */
function commitTurn(
	repo: string,
	subject: string,
): { headBefore: string; headAfter: string; repo: string; endedAt: number } {
	const headBefore = git(repo, "rev-parse", "HEAD");
	git(repo, "commit", "-q", "--allow-empty", "-m", subject);
	return { repo, headBefore, headAfter: git(repo, "rev-parse", "HEAD"), endedAt: now };
}

describe("conversation turn notes", () => {
	test("AC-3: two committing turns of one channel thread and day become one note after the day", async () => {
		const repo = makeRepo(repos);
		const first = commitTurn(repo, "feat: 첫 번째");
		await wiki.notes.recordTurn({ originKey: THREAD_ORIGIN, opRef: "op1", threadRef: THREAD_REF, rows: [first] });
		now += 60_000;
		const second = commitTurn(repo, "feat: 두 번째");
		await wiki.notes.recordTurn({ originKey: THREAD_ORIGIN, opRef: "op2", threadRef: THREAD_REF, rows: [second] });
		// Same day: nothing yet.
		await wiki.notes.flushTurns();
		expect(wiki.outbox()).toEqual([]);

		now += DAY_MS;
		await wiki.notes.flushTurns();
		const ids = wiki.outbox();
		expect(ids).toHaveLength(1);
		expect(ids[0]).toMatch(/^jabbu-turns-[0-9a-f]{10}-20270115$/);
		const note = wiki.read(ids[0] as string);
		expect(note.tags).toEqual(["jabbu", "work-outcome", "turns"]);
		expect(note.summary).toContain("feat: 첫 번째");
		expect(note.summary).toContain("feat: 두 번째");
		expect(note.project).toBe(repo.split("/").pop() ?? "");
		expect(wiki.sweeps).toHaveLength(1);

		// Written once: the drained file does not come back.
		rmSync(join(wiki.config?.agentDir ?? "", "wiki-outbox", `${ids[0]}.json`));
		await wiki.notes.flushTurns();
		expect(wiki.outbox()).toEqual([]);
	});

	test("AC-3: a DM turn is its own note at the next flush, even on the same day", async () => {
		const repo = makeRepo(repos);
		const one = commitTurn(repo, "fix: 하나");
		const two = commitTurn(repo, "fix: 둘");
		await wiki.notes.recordTurn({
			originKey: "discord/dm/200000000000000001",
			opRef: "op1",
			threadRef: "200000000000000001:400000000000000001",
			rows: [one],
		});
		await wiki.notes.recordTurn({
			originKey: "discord/dm/200000000000000001",
			opRef: "op2",
			threadRef: "200000000000000001:400000000000000002",
			rows: [two],
		});
		await wiki.notes.flushTurns();
		const ids = wiki.outbox();
		expect(ids).toHaveLength(2);
		expect(ids.map((id) => wiki.read(id).summary).join("\n")).toContain("fix: 하나");
		expect(ids.map((id) => wiki.read(id).summary).join("\n")).toContain("fix: 둘");
	});

	test("AC-3: a turn in a lane's or a [TASK]'s own origin and a turn that did not commit are left out", async () => {
		const repo = makeRepo(repos);
		store.tasks.register({
			title: "t",
			risk: "L1",
			originKey: THREAD_ORIGIN,
			threadRef: THREAD_REF,
			host: null,
			repo,
			acceptance: acceptanceItems(["x"]),
		});
		await wiki.notes.recordTurn({
			originKey: THREAD_ORIGIN,
			opRef: "op1",
			threadRef: THREAD_REF,
			rows: [commitTurn(repo, "feat: task thread")],
		});
		await wiki.notes.recordTurn({
			originKey: "lane/L-20270115-01",
			opRef: "op1",
			threadRef: "200000000000000001:400000000000000001",
			rows: [commitTurn(repo, "feat: lane")],
		});
		const head = git(repo, "rev-parse", "HEAD");
		await wiki.notes.recordTurn({
			originKey: "discord/dm/200000000000000001",
			opRef: "op2",
			threadRef: "200000000000000001:400000000000000002",
			rows: [{ repo, headBefore: head, headAfter: head, endedAt: now }],
		});
		now += DAY_MS;
		await wiki.notes.flushTurns();
		expect(wiki.outbox()).toEqual([]);
	});
});

describe("turnNoteRepos", () => {
	const client = "/x/wiki-client";
	test("wikiNotes.repos first, then taskAutoLand.repos; nothing without wikiNotes", () => {
		expect(turnNoteRepos({ wikiNotes: { client, repos: ["/r/a"] }, taskAutoLand: { repos: ["/r/b"] } })).toEqual([
			"/r/a",
		]);
		expect(turnNoteRepos({ wikiNotes: { client, repos: [] }, taskAutoLand: { repos: ["/r/b"] } })).toEqual(["/r/b"]);
		expect(turnNoteRepos({ wikiNotes: { client } })).toEqual([]);
		expect(turnNoteRepos({ taskAutoLand: { repos: ["/r/b"] } })).toEqual([]);
		expect(turnNoteRepos({ wikiNotes: { client, turns: false }, taskAutoLand: { repos: ["/r/b"] } })).toEqual([]);
	});
});

describe("wikiNotes.turns false", () => {
	test("a committing turn records no row and a pending row is not written", async () => {
		const repo = makeRepo(repos);
		await wiki.notes.recordTurn({
			originKey: THREAD_ORIGIN,
			opRef: "op1",
			threadRef: THREAD_REF,
			rows: [commitTurn(repo, "feat: 켜진 동안")],
		});
		expect(store.listUnsentWikiTurns()).toHaveLength(1);
		wiki.config = { ...(wiki.config as NonNullable<typeof wiki.config>), turns: false };
		await wiki.notes.recordTurn({
			originKey: THREAD_ORIGIN,
			opRef: "op2",
			threadRef: THREAD_REF,
			rows: [commitTurn(repo, "feat: 꺼진 뒤")],
		});
		expect(store.listUnsentWikiTurns()).toHaveLength(1);
		now += DAY_MS;
		await wiki.notes.flushTurns();
		expect(wiki.outbox()).toEqual([]);
	});
});

describe("wiki turn notes from turn HEADs (daemon wiring)", () => {
	const ORIGIN = `discord/dm/${OWNER_DM}`;
	let transport: WaitingDiscordTransport;
	let daemon: Daemon | undefined;

	beforeEach(() => {
		transport = new WaitingDiscordTransport();
		daemon = undefined;
	});
	afterEach(async () => {
		await daemon?.stop();
	});

	async function boot(config: JabbuConfig, driver: FakeOmpDriverOptions = {}): Promise<Daemon> {
		const instance = new FakeOmpDriver({ ...driver, sessionDir: join(home.dir, "s"), store: new FakeSessionStore() });
		const d = new Daemon({
			...daemonTestOptions(),
			config,
			channels: [discordBinding(transport)],
			clock: { now: () => Date.now() },
			log: createLogger({ sink: () => undefined, clock: { now: () => Date.now() }, redact: (text) => text }),
			ompVersion: "omp-test 0",
			bootId: "boot",
			sweepMs: 3_600_000,
			gateSweepMs: 0,
			taskSweepMs: 0,
			driverFactory: () => instance,
		});
		daemon = d;
		await d.start();
		return d;
	}

	/** A bounded hop-by-hop wait (one macrotask per hop, no fixed delay) until `ready` holds. */
	async function until(ready: () => boolean, what: string, hops = 2000): Promise<void> {
		for (let hop = 0; hop < hops; hop += 1) {
			if (ready()) return;
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 0);
			await promise;
		}
		throw new Error(`never happened: ${what}`);
	}

	/** The fake driver's reply step commits in `repo`, between the before and after heads. */
	const committing = (repo: string): FakeOmpDriverOptions => ({
		respond: () => {
			writeFileSync(join(repo, "committed.txt"), "by the turn\n");
			git(repo, "add", "--", "committed.txt");
			git(repo, "commit", "-q", "-m", "feat: 대화 커밋");
			return "커밋했습니다";
		},
	});
	const wikiClient = () => join(home.dir, "wiki-client");

	test("wikiNotes.repos set: a committing chat turn becomes a wiki turn row", async () => {
		const repo = makeRepo(repos);
		const d = await boot({ ...home.config, wikiNotes: { client: wikiClient(), repos: [repo] } }, committing(repo));
		await d.inject({ origin: ORIGIN, asOwner: true, text: "커밋해줘" });
		await transport.waitForPosts((text) => text.startsWith("커밋했습니다"));
		await until(() => d.store.listUnsentWikiTurns().length > 0, "the turn's wiki row");
		const [row] = d.store.listUnsentWikiTurns();
		expect(row?.repo).toBe(repo);
		expect(row?.inbound).toBe("커밋해줘");
		expect(row?.commits.map((commit) => commit.subject)).toEqual(["feat: 대화 커밋"]);
	});

	test("wikiNotes without repos falls back to taskAutoLand.repos", async () => {
		const repo = makeRepo(repos);
		const d = await boot(
			{ ...home.config, wikiNotes: { client: wikiClient() }, taskAutoLand: { repos: [repo] } },
			committing(repo),
		);
		await d.inject({ origin: ORIGIN, asOwner: true, text: "커밋해줘" });
		await transport.waitForPosts((text) => text.startsWith("커밋했습니다"));
		await until(() => d.store.listUnsentWikiTurns().length > 0, "the turn's wiki row");
		expect(d.store.listUnsentWikiTurns().map((row) => row.repo)).toEqual([repo]);
	});

	test("no wikiNotes: a committing chat turn starts no git and leaves no wiki row", async () => {
		const repo = makeRepo(repos);
		let turn = 0;
		const d = await boot(
			{ ...home.config, taskAutoLand: { repos: [repo] } },
			{
				respond: () => {
					turn += 1;
					writeFileSync(join(repo, `turn-${turn}.txt`), "by the turn\n");
					git(repo, "add", "--", `turn-${turn}.txt`);
					git(repo, "commit", "-q", "-m", `feat: 턴 ${turn}`);
					return `답 ${turn}`;
				},
			},
		);
		const spawn = spyOn(Bun, "spawn");
		try {
			await d.inject({ origin: ORIGIN, asOwner: true, text: "커밋해줘" });
			// The second answer comes after the first turn's after-heads step ran: nothing of the first turn is still pending.
			await d.inject({ origin: ORIGIN, asOwner: true, text: "또 커밋해줘" });
			await transport.waitForPosts((text) => text.startsWith("답 2"));
			const gitRuns = spawn.mock.calls.filter(([cmd]) => Array.isArray(cmd) && cmd[0] === "git");
			expect(gitRuns).toEqual([]);
		} finally {
			spawn.mockRestore();
		}
		expect(d.store.listUnsentWikiTurns()).toEqual([]);
	});
});
