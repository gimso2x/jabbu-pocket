// A lane that borrowed its conversation's Discord thread, through the daemon: who a message in that thread reaches
// (the lane while it is open, the conversation once it closed, a peer always the conversation), and the `작업:` trigger
// written at a channel root borrowing the reply thread the adapter opened.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Daemon } from "../src/daemon/daemon";
import type { DiscordMessageEvent } from "../src/discord/transport";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import {
	BOT,
	CHANNEL as CH,
	discordBinding,
	GUILD,
	makeHome,
	OWNER,
	type TestHome,
	WaitingDiscordTransport,
} from "./helpers/bot-home";
import { makeRepo } from "./helpers/git-fixtures";
import { removeRepoAndWorktrees } from "./helpers/lane-harness";

const PEER = "200000000000000001";
const LANE = "borrowed";
const LANE_ORIGIN = `jabbu/work/${LANE}`;

/** A snowflake-sized message id from a small number. */
const sf = (n: number): string => String(700_000_000_000_000_000n + BigInt(n));
const event = (author: DiscordMessageEvent["author"], n: number, text: string, inThread?: number) => ({
	id: sf(n),
	channel_id: inThread === undefined ? CH : sf(inThread),
	guild_id: GUILD,
	author,
	content: text,
	type: 0,
});
const owner = (n: number, text: string, inThread?: number) => event({ id: OWNER }, n, text, inThread);
const peer = (n: number, text: string, inThread: number) =>
	event({ id: PEER, bot: true }, n, `<@${BOT}> ${text}`, inThread);

let home: TestHome;
let daemon: Daemon | undefined;
let transport: WaitingDiscordTransport;
let repos: string[];
let drivers: FakeOmpDriver[];

beforeEach(() => {
	home = makeHome("jabbu-borrowed-lane-");
	daemon = undefined;
	onDriver = undefined;
	repos = [];
	drivers = [];
});

afterEach(async () => {
	for (const driver of drivers) driver.release();
	await daemon?.stop();
	home.remove();
	for (const repo of repos) removeRepoAndWorktrees(repo);
});

let onDriver: ((driver: FakeOmpDriver) => void) | undefined;

async function boot(options: { inlineReplyChannels?: string[] } = {}): Promise<Daemon> {
	transport = new WaitingDiscordTransport();
	transport.setChannel({ id: CH, type: 0, guildId: GUILD });
	const peerBots = [{ userId: PEER, name: "떡" }];
	const discord = home.config.channels.discord;
	if (discord === undefined) throw new Error("makeHome without channels.discord");
	const sessions = new FakeSessionStore();
	const clock = { now: () => Date.now() };
	daemon = new Daemon({
		config: {
			...home.config,
			channels: {
				...home.config.channels,
				discord: {
					...discord,
					mentionFreeChannels: [CH],
					peerBots,
					...(options.inlineReplyChannels === undefined ? {} : { inlineReplyChannels: options.inlineReplyChannels }),
				},
			},
			// The lane start must not depend on how many omp sessions this machine runs right now.
			hostSessionCeiling: 0,
		},
		channels: [discordBinding(transport, { peerBots })],
		clock,
		log: createLogger({ sink: () => undefined, clock, redact }),
		ompVersion: "omp-test 0",
		bootId: "boot-borrowed",
		stopDrainMs: 0,
		sweepMs: 3_600_000,
		gateSweepMs: 0,
		taskSweepMs: 0,
		driverFactory: (_origin, sessionDir) => {
			const driver = new FakeOmpDriver({ sessionDir, store: sessions, holdTurns: true });
			drivers.push(driver);
			onDriver?.(driver);
			return driver;
		},
	});
	await daemon.start();
	return daemon;
}

const row = (n: number) => daemon?.store.getInbound(`${CH}:${sf(n)}`);

describe("AC-6: messages in a borrowed lane thread", () => {
	/** The conversation thread of message 9001 and the lane that borrowed it (no worktree: routing only). */
	async function borrowedLane(): Promise<Daemon> {
		const started = await boot();
		transport.setChannel({ id: sf(9001), type: 11, parentId: CH, guildId: GUILD });
		started.store.insertLane({
			name: LANE,
			title: "lane",
			threadRef: `${CH}:${sf(9001)}`,
			originKey: LANE_ORIGIN,
			cwd: home.dir,
			sessionDir: join(home.dir, "sessions", LANE),
			meta: { startedAt: 0, lastProgressAt: 0, steerSeq: 0, borrowedThread: true },
		});
		return started;
	}
	const conversation = `discord/ch/${CH}/t/${sf(9001)}`;

	test("open: the owner reaches the lane, a peer the conversation", async () => {
		await borrowedLane();
		await transport.emitMessage(owner(9002, "레인에게", 9001));
		await transport.emitMessage(peer(9003, "검토 의견", 9001));
		expect(row(9002)?.originKey).toBe(LANE_ORIGIN);
		expect(row(9003)).toMatchObject({ originKey: conversation, peerUserId: PEER });
	});

	test("closed: plain owner text and peers reach the conversation as typed; the lane's own commands reach the lane", async () => {
		const started = await borrowedLane();
		started.store.transitionLane(LANE, "done-claimed", { event: "claimed" });
		started.store.transitionLane(LANE, "closed", { event: "closed" }, { land: { state: "pending", attempts: 0 } });
		await transport.emitMessage(owner(9004, "다음 질문", 9001));
		await transport.emitMessage(peer(9005, "닫힌 뒤 의견", 9001));
		await transport.emitMessage(owner(9006, "머지해", 9001));
		await transport.emitMessage(owner(9007, "!pr", 9001));
		await transport.emitMessage(owner(9008, "!reopen 고쳐 줘", 9001));
		expect(row(9004)).toMatchObject({ originKey: conversation, textRef: "다음 질문" });
		expect(row(9005)?.originKey).toBe(conversation);
		expect(row(9006)?.originKey).toBe(LANE_ORIGIN);
		expect(row(9007)?.originKey).toBe(LANE_ORIGIN);
		expect(row(9008)?.originKey).toBe(LANE_ORIGIN);
	});

	test("closed and no longer waiting to land: 머지해 and !pr are the conversation's", async () => {
		const started = await borrowedLane();
		started.store.transitionLane(LANE, "done-claimed", { event: "claimed" });
		started.store.transitionLane(LANE, "closed", { event: "landed" }, { land: { state: "landed", attempts: 0 } });
		await transport.emitMessage(owner(9010, "머지해", 9001));
		await transport.emitMessage(owner(9011, "!pr", 9001));
		expect(row(9010)?.originKey).toBe(conversation);
		expect(row(9011)?.originKey).toBe(conversation);
	});
});

describe("AC-4: 작업: written at a channel root", () => {
	test("the lane borrows the reply thread the adapter opened: no 🔄 root, the answer names this thread", async () => {
		await boot();
		const repo = makeRepo(repos);
		await transport.emitMessage(owner(9101, `작업: 루트에서 @${repo}`));
		await transport.waitForPosts((text) => text.includes("이 스레드에서 레인"));
		const lane = daemon?.store.listLanes()[0];
		expect(lane?.threadRef).toBe(`${CH}:${sf(9101)}`);
		expect(lane?.meta.borrowedThread).toBe(true);
		expect(transport.posts((text) => text.startsWith("🔄 루트에서"))).toEqual([]);
		expect(transport.calls.filter((call) => call.method === "startThread")).toHaveLength(1);
		const answer = transport.posts((text) => text.includes("이 스레드에서 레인"))[0];
		expect(answer?.channelId).toBe(sf(9101));
		expect(answer?.content).not.toContain("https://");
	});
});

describe("inlineReplyChannels: lane opens and borrows a thread on the owner message", () => {
	test("jabbu_work_start during an inline turn opens a thread on the message and routes the turn answer inside it", async () => {
		let resolveDriver!: (driver: FakeOmpDriver) => void;
		const firstDriver = new Promise<FakeOmpDriver>((resolve) => {
			resolveDriver = resolve;
		});
		onDriver = (driver) => {
			if (drivers.length === 1) resolveDriver(driver);
		};
		await boot({ inlineReplyChannels: [CH] });
		const repo = makeRepo(repos);
		await transport.emitMessage(owner(9201, "레인 만들어줘"));
		await transport.waitForPosts((text) => text.startsWith("⏳ 작업 중"));
		const channelDriver = await firstDriver;
		expect(transport.calls.filter((call) => call.method === "startThread")).toEqual([]);
		expect(row(9201)).toMatchObject({ originKey: `discord/ch/${CH}`, threadRef: `${CH}:${sf(9201)}` });
		const statusPost = transport.posts((text) => text.startsWith("⏳ 작업 중"))[0];
		expect(statusPost?.channelId).toBe(CH);
		expect(statusPost?.messageReference).toEqual({ messageId: sf(9201) });

		const tool = daemon?.hostToolsFor(`discord/ch/${CH}`).find((candidate) => candidate.name === "jabbu_work_start");
		if (!tool) throw new Error("jabbu_work_start missing");
		const reply = String(
			await tool.execute({ title: "인라인 레인", cwd: repo }, { signal: new AbortController().signal }),
		);
		expect(transport.posts((text) => text.startsWith("🔄 인라인 레인"))).toEqual([]);
		expect(transport.calls.filter((call) => call.method === "startThread")).toEqual([
			{ method: "startThread", channelId: CH, messageId: sf(9201), name: "인라인 레인", id: sf(9201) },
		]);
		const lane = daemon?.store.listLanes()[0];
		expect(lane?.threadRef).toBe(`${CH}:${sf(9201)}`);
		expect(lane?.meta.borrowedThread).toBe(true);
		const laneStatus = transport.posts((text) => text.startsWith("⏳ 인라인 레인"))[0];
		expect(laneStatus?.channelId).toBe(sf(9201));
		expect(reply).toContain(`이 스레드에서 레인 \`${lane?.name}\`을 시작했습니다`);
		expect(reply).not.toContain("https://");

		let resolveDelete!: () => void;
		const statusDeleted = new Promise<void>((resolve) => {
			resolveDelete = resolve;
		});
		const origDelete = transport.deleteMessage.bind(transport);
		transport.deleteMessage = async (args) => {
			await origDelete(args);
			if (args.messageId === statusPost?.id) resolveDelete();
		};
		channelDriver.release();
		await transport.waitForPosts((text) => text.includes("ECHO 레인 만들어줘"));
		await statusDeleted;
		const answer = transport.posts((text) => text.includes("ECHO 레인 만들어줘"))[0];
		expect(answer?.channelId).toBe(sf(9201));
		expect(answer?.messageReference).toBeUndefined();
		expect(
			transport.calls.some(
				(call) => call.method === "deleteMessage" && call.channelId === CH && call.messageId === statusPost?.id,
			),
		).toBe(true);
	});

	test("작업: trigger in inlineReplyChannels opens and borrows the owner message's thread", async () => {
		await boot({ inlineReplyChannels: [CH] });
		const repo = makeRepo(repos);
		await transport.emitMessage(owner(9211, `작업: 인라인 @${repo}`));
		await transport.waitForPosts((text) => text.includes("이 스레드에서 레인"));
		const lane = daemon?.store.listLanes()[0];
		expect(lane?.threadRef).toBe(`${CH}:${sf(9211)}`);
		expect(lane?.meta.borrowedThread).toBe(true);
		expect(transport.posts((text) => text.startsWith("🔄 인라인"))).toEqual([]);
		expect(transport.calls.filter((call) => call.method === "startThread")).toEqual([
			{ method: "startThread", channelId: CH, messageId: sf(9211), name: "인라인", id: sf(9211) },
		]);
		const laneStatus = transport.posts((text) => text.startsWith("⏳ 인라인"))[0];
		expect(laneStatus?.channelId).toBe(sf(9211));
		const answer = transport.posts((text) => text.includes("이 스레드에서 레인"))[0];
		expect(answer?.channelId).toBe(sf(9211));
		expect(answer?.content).not.toContain("https://");

		await transport.emitMessage(owner(9212, "추가 지시", 9211));
		expect(row(9212)?.originKey).toBe(lane?.originKey);
	});
});
