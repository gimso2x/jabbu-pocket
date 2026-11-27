// `작업: <제목> @<절대경로>` the owner writes in a lane's thread: a sibling lane of its own (own thread, own worktree)
// opens and the core answers there; the line is never a turn of that lane's session, open or closed.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DiscordChannelConfig } from "../src/config";
import { Daemon } from "../src/daemon/daemon";
import { WEB_LANE_REFUSED } from "../src/daemon/thread-target";
import type { LaneRow } from "../src/lanes/status";
import { isClosedLaneQuestion } from "../src/lanes/trigger";
import { laneTriggerRefusal } from "../src/lanes/trigger-format";
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
import { daemonTestOptions } from "./helpers/disk";
import { git, makeRepo } from "./helpers/git-fixtures";
import { removeRepoAndWorktrees } from "./helpers/lane-harness";

const DM_ORIGIN = `discord/dm/${OWNER_DM}`;
const SIBLING = "형제";
const clock = { now: () => Date.now() };

let home: TestHome;
let repos: string[];
let daemons: Daemon[];
let drivers: Map<string, FakeOmpDriver>;
let transport: WaitingDiscordTransport;

beforeEach(() => {
	home = makeHome("jabbu-lane-sibling-");
	repos = [];
	daemons = [];
	drivers = new Map();
	// A Discord transport that knows the server channel the lanes open in.
	transport = new WaitingDiscordTransport();
	transport.setChannel({ id: CHANNEL, type: 0, guildId: GUILD });
});

afterEach(async () => {
	for (const daemon of daemons) await daemon.stop();
	home.remove();
	for (const repo of repos) removeRepoAndWorktrees(repo);
});

/** Lanes open in the server channel; a DM conversation asks for them there. */
async function startDaemon(): Promise<Daemon> {
	const daemon = new Daemon({
		...daemonTestOptions(),
		config: {
			...home.config,
			channels: { discord: { ...(home.config.channels.discord as DiscordChannelConfig), laneChannelId: CHANNEL } },
			// A lane start must not depend on how many omp sessions this machine runs right now.
			hostSessionCeiling: 0,
		},
		channels: [discordBinding(transport)],
		log: createLogger({ sink: () => undefined, clock, redact }),
		ompVersion: "omp-test 0",
		bootId: "boot",
		driverFactory: (origin, sessionDir) => {
			const driver = new FakeOmpDriver({ sessionDir, store: new FakeSessionStore() });
			drivers.set(origin, driver);
			return driver;
		},
	});
	daemons.push(daemon);
	await daemon.start();
	return daemon;
}

/** A snowflake-sized message id from a small number. */
const messageId = (n: number): string => String(710_000_000_000_000_000n + BigInt(n));
const inboundId = (n: number): string => `${CHANNEL}:${messageId(n)}`;

/** The owner writes in a Discord thread (a thread is a channel of its own, named by its root message). */
const ownerMessage = (content: string, n: number, thread: string) =>
	transport.emitMessage({
		id: messageId(n),
		channel_id: thread,
		guild_id: GUILD,
		author: { id: OWNER },
		content,
		type: 0,
	});

/** `prompt:` and `steer:` calls the omp child of `originKey` received: the turns of that conversation. */
const turnsOf = (originKey: string): string[] =>
	(drivers.get(originKey)?.calls ?? []).filter((call) => call.startsWith("prompt:") || call.startsWith("steer:"));

/** Adds one more commit, as a lane doing real work would. */
function commitMore(repo: string): void {
	writeFileSync(join(repo, `work-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`), "work\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", "work");
}

/** A working lane `title` on a new repository, started from the DM: its first turn answered, its thread rooted at `🔄 <title>`. */
async function openLane(daemon: Daemon, title: string): Promise<{ lane: LaneRow; repo: string; rootId: string }> {
	const repo = makeRepo(repos);
	await daemon.inject({ origin: DM_ORIGIN, asOwner: true, text: `작업: ${title} @${repo}` });
	await transport.waitForPosts((text) => text === `🔄 ${title}`);
	await transport.waitForPosts((text) => text.startsWith(`ECHO 작업: ${title}`));
	const lane = daemon.store.getLane(title);
	expect(lane?.status).toBe("working");
	return { lane: lane as LaneRow, repo, rootId: transport.posts((text) => text === `🔄 ${title}`)[0]?.id ?? "" };
}

/** The lane's own `jabbu_claim_done` on a new commit: verified by the core, the lane closes. */
async function closeLane(daemon: Daemon, lane: LaneRow): Promise<void> {
	commitMore(lane.cwd);
	const claim = daemon.hostToolsFor(lane.originKey).find((tool) => tool.name === "jabbu_claim_done");
	const signal = new AbortController().signal;
	expect(await claim?.execute({ repo: lane.cwd, commit: "HEAD", summary: "done" }, { signal })).toContain("검증 통과");
	expect(daemon.store.getLane(lane.name)?.status).toBe("closed");
}

/** The first post the parent thread gets for the sibling line: the start's answer, or the lane session's own turn. */
const siblingAnswer = (text: string): boolean =>
	text.includes(`작업 레인 \`${SIBLING}\``) || text.includes(`작업: ${SIBLING} @`);

/** The sibling lane opened by the line, once its own first turn has answered. */
async function openedSibling(daemon: Daemon, repo: string, n: number, thread: string): Promise<LaneRow> {
	ownerMessage(`작업: ${SIBLING} @${repo}`, n, thread);
	await transport.waitForPosts(siblingAnswer);
	const sibling = daemon.store.listLanes().find((lane) => lane.title === SIBLING);
	expect(sibling?.status).toBe("working");
	await transport.waitForPosts((text) => text.startsWith(`ECHO 작업: ${SIBLING}`));
	return sibling as LaneRow;
}

/** The core's own answer to owner message `n`: the delivery of the row's `lane:` op. */
const settledAnswer = (daemon: Daemon, originKey: string, n: number): string | undefined =>
	daemon.store
		.listDeliveries({ originKey })
		.find((delivery) => delivery.opRef === daemon.store.getInbound(inboundId(n))?.opRef)?.body;

describe("AC-1·AC-2: `작업:` in a lane's thread opens a sibling lane", () => {
	test("AC-1: working lane: the sibling opens, the row is settled in the thread and never routed to the lane session", async () => {
		const daemon = await startDaemon();
		const { lane: parent, repo, rootId } = await openLane(daemon, "parent");
		const turnsBefore = turnsOf(parent.originKey).length;

		const sibling = await openedSibling(daemon, repo, 100, rootId);

		const row = daemon.store.getInbound(inboundId(100));
		expect(row).toMatchObject({ originKey: parent.originKey, state: "answered", textRef: `작업: ${SIBLING} @${repo}` });
		expect(row?.opRef).toStartWith("lane:");
		expect(
			daemon.store.listDeliveries({ originKey: parent.originKey }).find((d) => d.opRef === row?.opRef),
		).toMatchObject({
			threadRef: parent.threadRef,
		});
		expect(settledAnswer(daemon, parent.originKey, 100)).toContain("작업 레인");
		// The sibling's first prompt is the only turn that carries the line: the lane session got neither prompt nor steer.
		expect(turnsOf(parent.originKey).slice(turnsBefore)).toEqual([]);
		expect(turnsOf(sibling.originKey)).toHaveLength(1);
		expect(daemon.store.getLane("parent")?.status).toBe("working");
		// A lane session still has no `jabbu_work_start`: the line is chat input to the core, not a tool.
		expect(daemon.hostToolsFor(parent.originKey).map((tool) => tool.name)).not.toContain("jabbu_work_start");
	});

	test("AC-2: closed lane: the sibling opens too and the row has no closed-lane question prefix", async () => {
		const daemon = await startDaemon();
		const { lane: parent, repo, rootId } = await openLane(daemon, "parent");
		await closeLane(daemon, parent);
		const turnsBefore = turnsOf(parent.originKey).length;

		await openedSibling(daemon, repo, 200, rootId);

		const row = daemon.store.getInbound(inboundId(200));
		expect(row).toMatchObject({ originKey: parent.originKey, state: "answered", textRef: `작업: ${SIBLING} @${repo}` });
		expect(row?.textRef !== undefined && isClosedLaneQuestion(row.textRef)).toBe(false);
		const after = daemon.store.getLane("parent");
		expect(after?.status).toBe("closed");
		expect(after?.history.at(-1)?.event).not.toBe("owner_question");
		expect(turnsOf(parent.originKey).slice(turnsBefore)).toEqual([]);
	});
});

describe("AC-3·AC-4: where the sibling opens, and a malformed line", () => {
	test("AC-3: the sibling has its own thread and worktree (the parent's thread is never borrowed); a web origin is refused", async () => {
		const daemon = await startDaemon();
		const { lane: parent, repo, rootId } = await openLane(daemon, "parent");

		const sibling = await openedSibling(daemon, repo, 300, rootId);

		const root = transport.posts((text) => text === `🔄 ${SIBLING}`)[0];
		expect(sibling.threadRef).toBe(`${CHANNEL}:${root?.id}`);
		expect(sibling.threadRef).not.toBe(parent.threadRef);
		expect(sibling.meta.borrowedThread).not.toBe(true);
		expect(sibling.cwd).toStartWith(`${repo}-l-`);
		expect(sibling.cwd).not.toBe(parent.cwd);
		expect(transport.calls.filter((call) => call.method === "startThread")).toHaveLength(2);

		// No lane can be started under a web conversation (the start refuses it before any row), so the row is written by
		// hand: a `작업:` line in its thread takes the sibling path and keeps that refusal.
		const webOrigin = "web/dm/w_abcdef1234567890";
		const webThread = messageId(900);
		transport.setChannel({ id: webThread, type: 11, parentId: CHANNEL, guildId: GUILD });
		daemon.store.insertLane({
			name: "weblane",
			title: "weblane",
			threadRef: `${CHANNEL}:${webThread}`,
			originKey: webOrigin,
			cwd: home.dir,
			sessionDir: join(home.dir, "sessions", "weblane"),
			meta: { startedAt: 0, lastProgressAt: 0, steerSeq: 0 },
		});
		const waiting = transport.waitForPosts((text) => text.includes(WEB_LANE_REFUSED));
		ownerMessage(`작업: ${SIBLING} @${repo}`, 301, webThread);
		await waiting;
		expect(
			daemon.store
				.listLanes()
				.map((lane) => lane.title)
				.sort(),
		).toEqual(["weblane", "parent", SIBLING].sort());
		expect(daemon.store.getInbound(inboundId(301))).toMatchObject({ originKey: webOrigin, state: "answered" });
		expect(turnsOf(webOrigin)).toEqual([]);
	});

	test("AC-4: `작업:` with `~` or a relative path is answered in the lane's thread with the format refusal", async () => {
		const daemon = await startDaemon();
		const { lane: parent, rootId } = await openLane(daemon, "parent");
		const turnsBefore = turnsOf(parent.originKey).length;

		const lines = [
			[400, "작업: 제목 @~/x"],
			[401, "작업: 제목 @./x"],
		] as const;
		for (const [index, [n, text]] of lines.entries()) {
			const refusal = `⚠️ ${laneTriggerRefusal(text) ?? ""}`;
			// Whatever the thread gets for the line ends the wait: the refusal (the same notice for both lines, so the
			// index-th one), or the lane session's turn on it.
			const waiting = transport.waitForPosts((post) => post.includes(text) || post.includes(refusal), index + 1);
			ownerMessage(text, n, rootId);
			await waiting;
			expect(daemon.store.getInbound(inboundId(n))).toMatchObject({
				originKey: parent.originKey,
				state: "answered",
				textRef: text,
			});
			expect(daemon.store.getInbound(inboundId(n))?.opRef).toStartWith("lane:");
			expect(settledAnswer(daemon, parent.originKey, n)).toBe(refusal);
		}

		expect(daemon.store.listLanes().map((lane) => lane.title)).toEqual(["parent"]);
		expect(turnsOf(parent.originKey).slice(turnsBefore)).toEqual([]);
	});
});
