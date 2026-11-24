import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Daemon } from "../src/daemon/daemon";
import type { EditMessageArgs } from "../src/discord/transport";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import { approvalActionId } from "../src/safety/approval";
import {
	discordBinding,
	GUILD,
	hasButtons,
	makeHome,
	OWNER,
	OWNER_DM,
	ownerMessage,
	type TestHome,
	WaitingDiscordTransport,
} from "./helpers/bot-home";
import type { FakeDiscordCall } from "./helpers/discord-fake-transport";

const ESCALATION = "300000000000000002";
const DM = OWNER_DM;
const ORIGIN = `discord/dm/${DM}`;
const OTHER_USER = "100000000000000999";
const clock = { now: () => Date.now() };

type Post = Extract<FakeDiscordCall, { method: "createMessage" }>;
type Update = Extract<FakeDiscordCall, { method: "editMessage" }>;

/** Resolves `shown` when approval buttons go up on a card and `finalized` when a card edit removes them. */
class CardTransport extends WaitingDiscordTransport {
	shown = Promise.withResolvers<{ channel: string; ts: string }>();
	finalized = Promise.withResolvers<Update>();

	override async editMessage(args: EditMessageArgs): Promise<void> {
		await super.editMessage(args);
		if (hasButtons(args.components)) this.shown.resolve({ channel: args.channelId, ts: args.messageId });
		else if ((args.content ?? "").startsWith("🔐")) this.finalized.resolve({ method: "editMessage", ...args });
	}
}

let home: TestHome;
let daemon: Daemon;
let transport: CardTransport;
let logs: string[];

/** The test home's config with `channels.discord` extended (a server channel needs a mention here, like in production). */
function discordConfig(overrides: { escalationChannelId?: string } = {}) {
	const discord = home.config.channels.discord;
	if (discord === undefined) throw new Error("no discord config");
	return { ...home.config, channels: { discord: { ...discord, requireMention: true, ...overrides } } };
}

async function boot(overrides: { escalationChannelId?: string } = {}): Promise<void> {
	transport = new CardTransport();
	transport.setChannel({ id: DM, type: 1 });
	transport.setChannel({ id: ESCALATION, type: 0, guildId: GUILD });
	const sessions = new FakeSessionStore();
	daemon = new Daemon({
		config: discordConfig(overrides),
		channels: [discordBinding(transport)],
		log: createLogger({ sink: (line) => logs.push(line), clock, redact }),
		ompVersion: "omp-test 0",
		bootId: "boot",
		driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
	});
	await daemon.start();
}

/** An owner DM message first, so the origin has a current thread (`<dm>:<message id>`) the approval request comes from. */
async function seedThread(): Promise<string> {
	await transport.emitMessage(ownerMessage("700000000000000001", "배포 준비해줘"));
	await transport.waitForPosts((text) => text.includes("ECHO 배포 준비해줘"));
	return "700000000000000001";
}

function ask(summary = "force push main"): Promise<string> {
	const tool = daemon.hostToolsFor(ORIGIN).find((t) => t.name === "jabbu_request_approval");
	if (!tool) throw new Error("tool missing");
	return tool.execute({ summary }, { signal: new AbortController().signal });
}

function cardPost(channel: string): Post {
	const post = transport
		.posts()
		.find(
			(p) =>
				p.channelId === channel && (p.content ?? "").startsWith("🔐 승인 요청") && p.messageReference === undefined,
		);
	if (!post) throw new Error(`no card in ${channel}`);
	return post;
}

/** A message in a card's thread (the thread id is the card's message id; the thread sits in the escalation channel). */
function threadReply(thread: string, id: string, content: string, user = OWNER) {
	transport.setChannel({ id: thread, type: 11, parentId: ESCALATION, guildId: GUILD });
	return transport.emitMessage({
		id,
		channel_id: thread,
		guild_id: GUILD,
		author: { id: user, username: "u" },
		content,
		type: 0,
	});
}

/** A click on `customId` of the card `ts` in `channel`. */
function click(customId: string, channel: string, ts: string) {
	return transport.emitInteraction({
		id: "800000000000000001",
		application_id: "600000000000000000",
		type: 3,
		token: "token-1",
		channel_id: channel,
		user: { id: OWNER },
		data: { custom_id: customId, component_type: 2 },
		message: { id: ts, channel_id: channel },
	});
}

beforeEach(() => {
	home = makeHome("jabbu-routing-");
	logs = [];
});

afterEach(async () => {
	await daemon.stop();
	home.remove();
});

describe("escalation channel", () => {
	test("the card goes to the escalation channel with the owner mention and a link; its mirror with the same buttons lands in the asking thread", async () => {
		await boot({ escalationChannelId: ESCALATION });
		const thread = await seedThread();
		const result = ask("force push main\n자세히");
		const { channel, ts } = await transport.shown.promise;
		expect(channel).toBe(ESCALATION);
		const card = cardPost(ESCALATION);
		expect((card.content ?? "").split("\n")[0]).toBe(`🔐 승인 요청 <@${OWNER}>`);
		expect(card.content).toContain(`요청 위치: DM · [스레드 보기](https://discord.com/channels/@me/${DM}/${thread})`);
		// Exactly one mirror card in the requesting thread, its buttons carrying the escalation card's key; no pointer.
		await transport.waitForPosts((text) => text.startsWith("🔐 승인 요청\nforce push main"));
		const mirrors = transport.posts((text) => text.startsWith("🔐 승인 요청\nforce push main"));
		expect(mirrors).toHaveLength(1);
		expect(mirrors[0]).toMatchObject({ channelId: DM, messageReference: { messageId: thread } });
		expect(JSON.stringify(mirrors[0]?.components)).toContain(approvalActionId("approve", ESCALATION, ts));
		expect(JSON.stringify(mirrors[0])).toContain(
			`[#escalation에서 보기](https://discord.com/channels/${GUILD}/${ESCALATION}/${ts})`,
		);
		expect(transport.posts((text) => text.startsWith("🔐 승인 요청을"))).toHaveLength(0);
		// The ledger row maps the card back to the asking conversation and thread.
		expect(daemon.store.getApproval(`${ESCALATION}:${ts}`)).toMatchObject({
			status: "pending",
			originKey: ORIGIN,
			originThreadRef: `${DM}:${thread}`,
		});
		await click(approvalActionId("approve", ESCALATION, ts), ESCALATION, ts);
		expect(await result).toBe("approved");
	});

	test("the permalink failing falls back to the channel label", async () => {
		await boot({ escalationChannelId: ESCALATION });
		// No owner message through the adapter: the first channel lookups are the request's and the card's permalinks.
		daemon.store.ensureOrigin(ORIGIN, "sess/discord-dm");
		daemon.store.recordInbound({
			originKey: ORIGIN,
			platformMessageId: `${DM}:700000000000000001`,
			textRef: "푸시해",
			threadRef: `${DM}:700000000000000001`,
		});
		transport.failNext.getChannel = [new Error("boom"), new Error("boom")];
		void ask();
		await transport.shown.promise;
		await transport.waitForPosts((text) => text.startsWith("🔐 승인 요청\nforce push main"));
		expect((cardPost(ESCALATION).content ?? "").endsWith("요청 위치: DM")).toBe(true);
		const mirror = transport.posts((text) => text.startsWith("🔐 승인 요청\nforce push main"))[0];
		expect(JSON.stringify(mirror)).toContain(`정본 카드: <#${ESCALATION}>`);
	});

	test("a pending card's thread reply settles it as replied: the tool returns the text, the card says so, no session starts", async () => {
		await boot({ escalationChannelId: ESCALATION });
		await seedThread();
		const result = ask();
		const { ts } = await transport.shown.promise;
		// Not the owner: ignored, the request stays pending.
		await threadReply(ts, "700000000000000101", "승인!", OTHER_USER);
		expect(await Promise.race([result, Promise.resolve("pending")])).toBe("pending");
		// No mention in a channel that needs one: a card-thread reply still counts as addressed.
		await threadReply(ts, "700000000000000102", "네, 그 브랜치만 진행하세요");
		expect(await result).toBe("replied: 네, 그 브랜치만 진행하세요");
		const final = await transport.finalized.promise;
		expect(hasButtons(final.components)).toBe(false);
		expect(final.content).toContain("💬 답장으로 처리됨: 네, 그 브랜치만 진행하세요");
		expect(JSON.stringify(final.embeds)).toContain("💬 답장으로 처리됨: 네, 그 브랜치만 진행하세요");
		expect(daemon.store.getApproval(`${ESCALATION}:${ts}`)).toMatchObject({
			status: "replied",
			replyTs: "700000000000000102",
			replyText: "네, 그 브랜치만 진행하세요",
		});
		// Consumed: no inbound row, no thread session in the escalation channel.
		expect(daemon.store.getInbound(`${ESCALATION}:700000000000000102`)).toBeUndefined();
		expect(daemon.store.hasInboundThread(`${ESCALATION}:${ts}`)).toBe(false);
		// A backfill replay of the same reply is a no-op duplicate.
		await threadReply(ts, "700000000000000102", "네, 그 브랜치만 진행하세요");
		expect(logs.filter((line) => line.includes("event=inbound_duplicate"))).toHaveLength(1);
		expect(daemon.store.getInbound(`${ESCALATION}:700000000000000102`)).toBeUndefined();
		expect(daemon.store.getApproval(`${ESCALATION}:${ts}`)?.status).toBe("replied");
	});

	test("a reply in an already-settled card's thread reaches the asking session, answered inside the card thread", async () => {
		await boot({ escalationChannelId: ESCALATION });
		await seedThread();
		const result = ask();
		const { ts } = await transport.shown.promise;
		await click(approvalActionId("deny", ESCALATION, ts), ESCALATION, ts);
		expect(await result).toBe("denied");
		await threadReply(ts, "700000000000000201", "그럼 다음에 하자");
		const row = daemon.store.getInbound(`${ESCALATION}:700000000000000201`);
		expect(row).toMatchObject({ originKey: ORIGIN, threadRef: `${ESCALATION}:${ts}` });
		await transport.waitForPosts((text) => text.includes("ECHO 그럼 다음에 하자"));
		const answer = transport.posts((text) => text.includes("ECHO 그럼 다음에 하자"))[0];
		expect(answer).toMatchObject({ channelId: ts });
		// A second reply keeps flowing to the same session instead of starting a thread session in the channel.
		await threadReply(ts, "700000000000000202", "고마워");
		expect(daemon.store.getInbound(`${ESCALATION}:700000000000000202`)?.originKey).toBe(ORIGIN);
	});

	// T-20261111-03: an inject may not answer a card. The marker
	// still goes up as a reply in the card's thread; only the owner's own reply settles the card.
	test("inject --thread into a card's thread posts the marker there but cannot answer the card", async () => {
		await boot({ escalationChannelId: ESCALATION });
		await seedThread();
		const result = ask();
		const { ts } = await transport.shown.promise;
		transport.setChannel({ id: ts, type: 11, parentId: ESCALATION, guildId: GUILD });
		await expect(
			daemon.inject({ origin: `discord/ch/${ESCALATION}`, asOwner: true, text: "진행해", thread: ts }),
		).rejects.toThrow("approval/choice card");
		expect(transport.posts((text) => text.startsWith("🧪 inject ") && text.endsWith("\n> 진행해"))[0]).toMatchObject({
			channelId: ts,
		});
		expect(daemon.store.getApproval(`${ESCALATION}:${ts}`)?.status).toBe("pending");
		await threadReply(ts, "700000000000000302", "진행해");
		expect(await result).toBe("replied: 진행해");
	});
});

describe("approval cards without an escalation channel", () => {
	test("the card stays in the asking conversation, no pointer, and a reply to it still settles it", async () => {
		await boot();
		await seedThread();
		const result = ask();
		const { channel, ts } = await transport.shown.promise;
		expect(channel).toBe(DM);
		expect(cardPost(DM).content).toBe("🔐 승인 요청\nforce push main");
		expect(transport.posts((text) => text.startsWith("🔐 승인 요청을"))).toHaveLength(0);
		expect(daemon.store.getApproval(`${DM}:${ts}`)?.originKey).toBe(ORIGIN);
		await transport.emitMessage(
			ownerMessage("700000000000000301", "좋아요 진행", {
				type: 19,
				message_reference: { message_id: ts, channel_id: DM },
			}),
		);
		expect(await result).toBe("replied: 좋아요 진행");
		expect(daemon.store.getInbound(`${DM}:700000000000000301`)).toBeUndefined();
	});
});
