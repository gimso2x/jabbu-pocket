import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateCard } from "../src/channel/card";
import { originKeyForMessage } from "../src/core/normalize";
import { DiscordBackfill } from "../src/discord/backfill";
import { DiscordBinding } from "../src/discord/binding";
import { DiscordChannel } from "../src/discord/channel";
import { mrkdwnToDiscord, outsideCode, renderDiscordParts } from "../src/discord/format";
import { PeerParts } from "../src/discord/peer-posts";
import { DiscordCallError } from "../src/discord/transport";
import { createLogger } from "../src/log";
import { redact } from "../src/redact";
import { openStore } from "../src/store/db";
import { OWNER } from "./helpers/bot-home";
import { FakeDiscordTransport } from "./helpers/discord-fake-transport";

const tempDirs: string[] = [];
afterEach(() => {
	for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("qa-ab Discord·백필·카드·서식·선택지 수정", () => {
	test("#9: renderStackedTables neutralizes ``` runs inside cells so Discord does not open a fence", () => {
		const body = "| col | code |\n|---|---|\n| a | ``` |";
		const [part] = renderDiscordParts(body, false);
		expect(part).toBe("**col**: a\n- code: ``\u200B`");
		expect(part).not.toContain("```");
	});

	test("#27: outsideCode preserves 3-backtick lines inside a 4-backtick fence and keeps inline spans untouched", () => {
		const input = "````\n```\n*bold* &lt;@U1&gt;\n```\n````\noutside *bold* and ``*kept*``";
		expect(mrkdwnToDiscord(input)).toBe("````\n```\n*bold* &lt;@U1&gt;\n```\n````\noutside **bold** and ``*kept*``");
		const bigUnclosed = "`x ".repeat(22_000);
		const t0 = performance.now();
		outsideCode(bigUnclosed, (s) => s);
		expect(performance.now() - t0).toBeLessThan(200);
	});

	test("#26: originKeyForMessage keeps channel root !home on the channel origin", () => {
		expect(originKeyForMessage("111", "channel", "900", undefined, "!home", "discord")).toBe("discord/ch/111");
		expect(originKeyForMessage("111", "channel", "900", undefined, "hello", "discord")).toBe("discord/ch/111/t/900");
	});

	test("#28: second mentioned peer post closes the earlier wait so unmentioned follow-up attaches to the latest mention", async () => {
		const log = createLogger({ sink: () => {}, clock: { now: () => 0 }, redact });
		const peerParts = new PeerParts(150);
		const first = peerParts.gather("ch:peer", "msg1");
		const second = peerParts.gather("ch:peer", "msg2");
		expect(
			peerParts.join(
				"ch:peer",
				{ id: "700000000000000003", channel_id: "ch", author: { id: "peer" }, content: "part2", type: 0 },
				log,
			),
		).toBe(true);
		expect(await first).toBe("msg1");
		expect(await second).toBe("msg2\npart2");
	});

	test("#29: backfill skips the 8s peer split-answer wait", async () => {
		const dir = mkdtempSync(join(tmpdir(), "jabbu-qa-ab-bf-peer-"));
		tempDirs.push(dir);
		const store = openStore({
			timezone: "Asia/Seoul",
			path: join(dir, "db.sqlite"),
			clock: { now: () => 1000 },
			redact,
		});
		const BOT = "500000000000000000";
		const PEER = "200000000000000001";
		const CH = "111111111111111111";
		const GUILD = "300000000000000001";
		const transport = new FakeDiscordTransport({ botUserId: BOT });
		transport.setChannel({ id: CH, type: 0, guildId: GUILD });
		store.ensureOrigin(`discord/ch/${CH}`, join(dir, "s1"));
		store.setCursor(`dc:${CH}`, "699999999999999999");
		transport.history.set(CH, [
			{
				id: "700000000000000010",
				channel_id: CH,
				guild_id: GUILD,
				author: { id: PEER, bot: true },
				content: `<@${BOT}> p1`,
				type: 0,
			},
			{
				id: "700000000000000011",
				channel_id: CH,
				guild_id: GUILD,
				author: { id: PEER, bot: true },
				content: `<@${BOT}> p2`,
				type: 0,
			},
		]);
		const recorded: string[] = [];
		const binding = new DiscordBinding(
			new DiscordChannel(transport, { ownerUserId: OWNER, peerBots: [{ userId: PEER }] }),
			{ peerPartWaitMs: 8_000 },
		);
		const adapter = binding.createAdapter({
			core: {
				onInbound: () => undefined,
				onPeerInbound: (m) => {
					recorded.push(m.platformMessageId);
					return {};
				},
				onCommand: () => undefined,
				onAction: () => {},
			},
			deliveries: { claimDue: () => [], confirm: () => {}, fail: () => {}, defer: () => {} },
			clock: { now: () => Date.now() },
			log: createLogger({ sink: () => {}, clock: { now: () => 0 }, redact }),
			config: {
				schemaVersion: 1,
				homeDir: dir,
				configPath: join(dir, "config.json"),
				channels: {
					discord: {
						ownerUserId: OWNER,
						botTokenFile: join(dir, "tok"),
						applicationId: "6",
						peerBots: [{ userId: PEER, name: "peer" }],
					},
				},
				ompExecutable: "/bin/true",
				workspaceDir: dir,
				timezone: "Asia/Seoul",
			},
			store,
			detach: () => {},
		});
		await adapter.start();
		const t0 = performance.now();
		adapter.recover?.();
		await adapter.recoveryIdle?.();
		expect(performance.now() - t0).toBeLessThan(1_000);
		expect(recorded).toEqual([`${CH}:700000000000000010`, `${CH}:700000000000000011`]);
		await adapter.stop();
		store.close();
	});

	test("#11: backfill attempt count persists across restarts so definitive failures still dead-letter on pass 3", async () => {
		const dir = mkdtempSync(join(tmpdir(), "jabbu-qa-ab-bf-dl-"));
		tempDirs.push(dir);
		const store = openStore({
			timezone: "Asia/Seoul",
			path: join(dir, "db.sqlite"),
			clock: { now: () => 1000 },
			redact,
		});
		const CH = "111111111111111111";
		store.setCursor(`dc:${CH}`, "99999999999999999");
		const log = createLogger({ sink: () => {}, clock: { now: () => 0 }, redact });
		const make = () =>
			new DiscordBackfill({
				transport: {
					listMessages: async () => [
						{ id: "100000000000000001", channel_id: CH, author: { id: OWNER }, content: "bad", type: 0 },
					],
				},
				cursors: store,
				log,
				now: () => Date.now(),
				targets: () => [{ channelId: CH, dm: true }],
				ready: async () => true,
				locate: async () => ({ dm: true }),
				ingest: async () => {
					throw new DiscordCallError("definitive", "bad_message");
				},
			});
		const bf1 = make();
		bf1.trigger();
		await bf1.waitForIdle();
		expect(store.getCursor(`bfa:dc:${CH}:100000000000000001`)).toBe("1");

		const bf2 = make();
		bf2.trigger();
		await bf2.waitForIdle();
		expect(store.getCursor(`bfa:dc:${CH}:100000000000000001`)).toBe("2");

		const bf3 = make();
		bf3.trigger();
		await bf3.waitForIdle();
		expect(store.getCursor(`bfa:dc:${CH}:100000000000000001`)).toBeUndefined();
		expect(store.getCursor(`dc:${CH}`)).toBe("100000000000000001");
		store.close();
	});

	test("#30: card graph rejects a shared child under a repeat via a nested plain parent", () => {
		const spec = {
			root: "c",
			elements: {
				c: { type: "Card", props: { title: "T" }, children: ["a", "b"] },
				a: { type: "Section", props: {}, children: ["x"], repeat: { statePath: "/items", key: "id" } },
				b: { type: "Section", props: {}, children: ["p"], repeat: { statePath: "/items", key: "id" } },
				p: { type: "Section", props: {}, children: ["x"] },
				x: { type: "Text", props: { content: "X" } },
			},
			state: { items: [{ id: "1" }] },
		};
		const res = validateCard(JSON.stringify(spec));
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.issues.some((i) => i.includes('"x"'))).toBe(true);
	});
});
