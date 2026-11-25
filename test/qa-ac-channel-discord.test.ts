import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveInboundAttachment } from "../src/channel/attachments";
import { cardRuns, splitCards } from "../src/channel/card";
import { graphIssues } from "../src/channel/card-graph";
import { QUARANTINE_RETRY_MS } from "../src/discord/backfill";
import { DiscordBinding } from "../src/discord/binding";
import { DiscordChannel } from "../src/discord/channel";
import { escapeDiscordMarkdown, mrkdwnToDiscord, renderDiscordParts } from "../src/discord/format";
import { createLogger } from "../src/log";
import { redact } from "../src/redact";
import { openStore } from "../src/store/db";
import { OWNER } from "./helpers/bot-home";
import { FakeDiscordTransport } from "./helpers/discord-fake-transport";

const tempDirs: string[] = [];
afterEach(() => {
	for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("qa-ac channel·discord 수정", () => {
	test("#11: 표 바로 뒤 탭·4칸 들여쓴 코드 줄은 표 행으로 흡수되지 않는다", () => {
		const md = ["| a | b |", "| --- | --- |", "| 1 | 2 |", "\t| tab | row |", "    | space | row |"].join("\n");
		const [part] = renderDiscordParts(md, false);
		expect(part).toContain("```\na | b\n--+--\n1 | 2\n```");
		expect(part).toContain("\t| tab | row |");
		expect(part).toContain("    | space | row |");
	});

	test("#12: 표 셀에 500개 이상 백틱이 있어도 분할된 모든 파트의 코드 펜스가 정상으로 닫힌다", () => {
		const bigBackticks = "`".repeat(520);
		const rows = Array.from({ length: 45 }, (_, i) => `| ${i === 0 ? bigBackticks : `item-${i}`} | v-${i} |`);
		const md = ["| col1 | col2 |", "| --- | --- |", ...rows].join("\n");
		const parts = renderDiscordParts(md, false);
		expect(parts.length).toBeGreaterThan(1);
		for (const part of parts) {
			const fenceLines = part.split("\n").filter((line) => /^`{3,}$/.test(line));
			expect(fenceLines.length % 2).toBe(0);
		}
	});

	test("#13: splitCards가 닫힌·미닫힌 ```copy 펜스 수천 개를 선형 시간에 처리한다", () => {
		const closed = Array.from({ length: 5000 }, () => "```copy\nhello\n```").join("\n");
		const unclosed = Array.from({ length: 5000 }, () => "```copy\nhello").join("\n");
		const t0 = performance.now();
		expect(splitCards(closed)).toHaveLength(5000);
		expect(splitCards(unclosed)).toHaveLength(1);
		expect(performance.now() - t0).toBeLessThan(150);
	});

	test("#14: cardRuns가 수십만 개 카드 이슈에서도 RangeError 없이 상한(50)만 수집한다", () => {
		const issues: string[] = [];
		const bigIssues = Array.from({ length: 1_000_000 }, (_, i) => `issue-${i}`);
		const runs = cardRuns('```card\n{"root":"c"}\n```', issues, () => bigIssues, 4000);
		expect(runs).toHaveLength(1);
		expect(issues).toHaveLength(50);
	});

	test("#31/#33: escapeDiscordMarkdown은 []()# 를 이스케이프하고 mrkdwnToDiscord는 멘션 엔티티를 풀지 않는다", () => {
		expect(escapeDiscordMarkdown("[클릭](https://x.test)\n# 제목\n  ## 부제")).toBe(
			"\\[클릭\\]\\(https://x.test\\)\n\\# 제목\n  \\## 부제",
		);
		const converted = mrkdwnToDiscord("&lt;@U123&gt; &lt;!here&gt; &lt;#9&gt;");
		expect(converted).toBe("\\<@U123> \\<!here> \\<#9>");
		expect(converted).not.toMatch(/(?<!\\)<[@!#]/);
	});

	test("#35: 채널 404 음수 캐시가 있더라도 24시간 격리 만료 뒤 백필은 remember404=false로 재조회해 복구한다", async () => {
		const dir = mkdtempSync(join(tmpdir(), "jabbu-qa-ac-404-"));
		tempDirs.push(dir);
		const store = openStore({
			timezone: "Asia/Seoul",
			path: join(dir, "db.sqlite"),
			clock: { now: () => 1_000 },
			redact,
		});
		const BOT = "500000000000000000";
		const CH = "111111111111111111";
		const GUILD = "300000000000000001";
		let now = 1_000_000_000;
		const transport = new FakeDiscordTransport({ botUserId: BOT });
		const channel = new DiscordChannel(transport, { ownerUserId: OWNER });
		// Populate negative 404 cache in channelInfo(CH) before recovery runs.
		expect(await channel.channelInfo(CH)).toBeUndefined();
		expect(await channel.channelInfo(CH)).toBeUndefined();
		expect(transport.count("getChannel")).toBe(1);

		const recorded: string[] = [];
		const binding = new DiscordBinding(channel);
		const adapter = binding.createAdapter({
			core: {
				onInbound: (m) => {
					recorded.push(m.text);
					return {};
				},
				onCommand: () => undefined,
				onAction: () => {},
			},
			deliveries: { claimDue: () => [], confirm: () => {}, fail: () => {}, defer: () => {} },
			clock: { now: () => now },
			log: createLogger({ sink: () => {}, clock: { now: () => now }, redact }),
			config: {
				schemaVersion: 1,
				homeDir: dir,
				configPath: join(dir, "config.json"),
				channels: {
					discord: {
						ownerUserId: OWNER,
						botTokenFile: join(dir, "tok"),
						applicationId: "6",
						mentionFreeChannels: [CH],
						requireMention: false,
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
		store.ensureOrigin(`discord/ch/${CH}`, join(dir, "s1"));
		store.setCursor(`dc:${CH}`, "699999999999999999");
		transport.history.set(CH, [
			{ id: "700000000000000010", channel_id: CH, guild_id: GUILD, author: { id: OWNER }, content: "hi", type: 0 },
		]);

		// Pass 1: still 404 -> quarantined.
		adapter.recover?.();
		await adapter.recoveryIdle?.();
		expect(recorded).toEqual([]);

		// Channel recovers after quarantine expiry; pass 2 must bypass negative cache.
		transport.setChannel({ id: CH, type: 0, guildId: GUILD });
		now += QUARANTINE_RETRY_MS + 1;
		adapter.recover?.();
		await adapter.recoveryIdle?.();
		expect(transport.count("getChannel")).toBe(3);
		expect(recorded).toEqual(["hi"]);
		await adapter.stop();
		store.close();
	});

	test("#37: 첨부 mimetype이 constructor여도 프로토타입 값을 확장자로 쓰지 않고 bin으로 저장한다", async () => {
		const dir = mkdtempSync(join(tmpdir(), "jabbu-qa-ac-mime-"));
		tempDirs.push(dir);
		const log = createLogger({ sink: () => {}, clock: { now: () => 0 }, redact });
		let savedDest = "";
		const note = await saveInboundAttachment({
			file: { id: "f1", name: "doc", mimetype: "constructor", url: "https://cdn.example/f1" },
			dir,
			where: { origin: "test" },
			log,
			download: async ({ destPath }) => {
				savedDest = destPath;
			},
		});
		expect(savedDest).toEndWith(".bin");
		expect(savedDest).not.toContain("function");
		expect(note).toContain(".bin (constructor)");
	});

	test("#38: 백필 중 분할된 피어 답장의 무멘션 후속 조각들을 첫 멘션 메시지와 함께 합친다", async () => {
		const dir = mkdtempSync(join(tmpdir(), "jabbu-qa-ac-bf-split-"));
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
				content: `<@${BOT}> part-one`,
				type: 0,
			},
			{
				id: "700000000000000011",
				channel_id: CH,
				guild_id: GUILD,
				author: { id: PEER, bot: true },
				content: "part-two",
				type: 0,
			},
			{
				id: "700000000000000012",
				channel_id: CH,
				guild_id: GUILD,
				author: { id: PEER, bot: true },
				content: "part-three",
				type: 0,
			},
		]);

		const texts: string[] = [];
		const binding = new DiscordBinding(
			new DiscordChannel(transport, { ownerUserId: OWNER, peerBots: [{ userId: PEER }] }),
		);
		const adapter = binding.createAdapter({
			core: {
				onInbound: () => undefined,
				onPeerInbound: (m) => {
					texts.push(m.text);
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
		adapter.recover?.();
		await adapter.recoveryIdle?.();
		expect(texts).toHaveLength(1);
		expect(texts[0]).toContain("part-one\npart-two\npart-three");
		expect(store.getCursor(`dc:${CH}`)).toBe("700000000000000012");
		await adapter.stop();
		store.close();
	});

	test("#39: graphIssues는 plain 1회 + repeat 2회 이상 공유 자식을 거부하고 plain 1회 + repeat 1회는 허용한다", () => {
		const specBad = {
			root: "root",
			elements: {
				root: { type: "Card", props: {}, children: ["a", "r1", "r2"] },
				a: { type: "Section", props: {}, children: ["leaf"] },
				r1: { type: "Section", props: {}, repeat: { statePath: "/a" }, children: ["leaf"] },
				r2: { type: "Section", props: {}, repeat: { statePath: "/b" }, children: ["leaf"] },
				leaf: { type: "Text", props: { text: "hi" }, children: [] },
			},
		};
		expect(graphIssues(specBad)).toEqual(['element "leaf" is referenced more than once (cycle or shared child)']);

		const specOk = {
			root: "root",
			elements: {
				root: { type: "Card", props: {}, children: ["a", "r1"] },
				a: { type: "Section", props: {}, children: ["leaf"] },
				r1: { type: "Section", props: {}, repeat: { statePath: "/a" }, children: ["leaf"] },
				leaf: { type: "Text", props: { text: "hi" }, children: [] },
			},
		};
		expect(graphIssues(specOk)).toEqual([]);
	});
});
