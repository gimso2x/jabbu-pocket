import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { splitCards } from "../src/channel/card";
import { fenceCloses, fenceOpen, findLinkSpans } from "../src/channel/fence";
import { chunkText, inlineSpans, tableEndAt, tableSpans } from "../src/channel/text";
import type { CoreSink, DeliverySource, InboundMessage } from "../src/channel/types";
import { DiscordAdapter } from "../src/discord/adapter";
import { downloadDiscordAttachment } from "../src/discord/attachments";
import { DiscordChannel } from "../src/discord/channel";
import { mrkdwnToDiscord, renderDiscordParts } from "../src/discord/format";
import { DiscordGateway, type GatewayTimers } from "../src/discord/gateway";
import { renderStackedTables, stripTableHeaderMarkdown } from "../src/discord/table";
import type { DiscordAttachment, DiscordHandlers, DiscordMessageEvent } from "../src/discord/transport";
import { createLogger } from "../src/log";
import { redact } from "../src/redact";
import { OWNER } from "./helpers/bot-home";
import { FakeDiscordTransport } from "./helpers/discord-fake-transport";

const tempDirs: string[] = [];
const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const stop of cleanups.splice(0)) stop();
	for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

describe("qa-ad channel·discord 회귀", () => {
	test("#16: DM·스레드·채널 루트 무인자 명령(!stop·!new·!status·!home)은 첨부 다운로드·노트 없이 실행되고 인자 명령은 첨부를 받는다", async () => {
		const dir = makeTempDir("jabbu-qa-ad-16-");
		const mediaRoot = join(dir, "media");
		mkdirSync(mediaRoot, { recursive: true });
		const BOT = "500000000000000000";
		const GUILD = "300000000000000001";
		const CH = "111111111111111111";
		const THREAD = "222222222222222222";
		const DM = "123456789012345678";
		const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
		const transport = new FakeDiscordTransport({ botUserId: BOT });
		transport.setChannel({ id: CH, type: 0, guildId: GUILD });
		transport.setChannel({ id: THREAD, type: 11, parentId: CH, guildId: GUILD });
		transport.setChannel({ id: DM, type: 1 });
		const fileUrl = "https://cdn.discordapp.com/attachments/1/2/shot.png";
		transport.downloads.set(fileUrl, PNG);
		const file: DiscordAttachment = {
			id: "400000000000000001",
			filename: "shot.png",
			size: PNG.byteLength,
			url: fileUrl,
			content_type: "image/png",
		};
		const inbound: InboundMessage[] = [];
		const core: CoreSink = {
			onInbound: (m) => {
				inbound.push(m);
				return undefined;
			},
			onCommand: () => undefined,
			onAction: () => {},
			knowsThread: () => true,
		};
		const deliveries: DeliverySource = { claimDue: () => [], confirm: () => {}, fail: () => {}, defer: () => {} };
		const adapter = new DiscordAdapter({
			channel: new DiscordChannel(transport, { ownerUserId: OWNER }),
			core,
			deliveries,
			ownerUserId: OWNER,
			clock: { now: () => 1_800_000_000_000 },
			log: createLogger({ sink: () => {}, clock: { now: () => 0 }, redact }),
			mediaRoot,
		});
		await adapter.start();
		cleanups.push(() => void adapter.stop());

		const send = (overrides: Partial<DiscordMessageEvent>) =>
			transport.emitMessage({
				id: "700000000000000001",
				channel_id: DM,
				author: { id: OWNER },
				content: "!stop",
				type: 0,
				attachments: [file],
				...overrides,
			});

		await send({ id: "700000000000000001", channel_id: DM, content: "!stop" });
		await send({ id: "700000000000000002", channel_id: DM, content: "!home" });
		await send({ id: "700000000000000003", channel_id: THREAD, guild_id: GUILD, content: "!new" });
		await send({ id: "700000000000000004", channel_id: THREAD, guild_id: GUILD, content: "!status" });
		await send({ id: "700000000000000005", channel_id: THREAD, guild_id: GUILD, content: "!home" });
		await send({ id: "700000000000000006", channel_id: CH, guild_id: GUILD, content: `<@${BOT}> !home` });

		expect(inbound.map((m) => m.text)).toEqual(["!stop", "!home", "!new", "!status", "!home", "!home"]);
		expect(transport.calls.filter((c) => c.method === "downloadAttachment")).toHaveLength(0);
		expect(transport.calls.filter((c) => c.method === "startThread")).toHaveLength(0);

		await send({ id: "700000000000000007", channel_id: DM, content: "!followup 확인해줘" });
		expect(transport.calls.filter((c) => c.method === "downloadAttachment")).toHaveLength(1);
		expect(inbound.at(-1)?.text).toMatch(/^!followup 확인해줘\n\[첨부: .+\.png \(image\/png\)\]$/);
	});

	test("#17: 잘못된 redirect Location 헤더는 재시도 없이 1회 요청 후 invalid_redirect_url로 끝난다", async () => {
		const dir = makeTempDir("jabbu-qa-ad-17-");
		let fetches = 0;
		const badRedirect = (async (_input: string | URL | Request, _init?: RequestInit) => {
			fetches += 1;
			return new Response(null, { status: 302, headers: { location: "http://[invalid" } });
		}) as typeof fetch;

		const res = await downloadDiscordAttachment({
			url: "https://cdn.discordapp.com/attachments/1/2/x.png",
			destPath: join(dir, "x.png"),
			maxBytes: 1024,
			retries: 2,
			fetchImpl: badRedirect,
		});
		expect(res).toEqual({ ok: false, error: "invalid_redirect_url" });
		expect(fetches).toBe(1);
		expect(readdirSync(dir)).toEqual([]);

		let badInitFetches = 0;
		const badInit = await downloadDiscordAttachment({
			url: "not a url",
			destPath: join(dir, "y.png"),
			maxBytes: 1024,
			fetchImpl: (async (_input: string | URL | Request, _init?: RequestInit) => {
				badInitFetches += 1;
				return new Response("ok");
			}) as typeof fetch,
		});
		expect(badInit).toEqual({ ok: false, error: "invalid_url" });
		expect(badInitFetches).toBe(0);
	});

	test("#19: 표 헤더 칸의 3개 이상 백틱이 무력화되어 긴 답 분할 시 가짜 코드펜스가 생기지 않는다", () => {
		expect(stripTableHeaderMarkdown("```")).toBe("``\u200B`");
		expect(stripTableHeaderMarkdown("````")).toBe("``\u200B``");
		expect(stripTableHeaderMarkdown("**```**")).toBe("``\u200B`");
		expect(stripTableHeaderMarkdown("` ``` `")).toBe("``\u200B`");

		const rows = Array.from({ length: 40 }, (_, i) => `| v${i} | ${"내용".repeat(15)} |`);
		const parts = renderDiscordParts(["| ``` | 설명 |", "| --- | --- |", ...rows].join("\n"), false);
		expect(parts.length).toBeGreaterThan(1);
		for (const part of parts) {
			expect(part).not.toContain("```");
		}
		expect(parts[0]).toContain("**``\u200B`**: v0");
	});

	test("#20: 링크 URL 안의 *a*·~a~는 굵게/취소선으로 훼손되지 않고 라벨 서식과 &amp; 복원은 유지된다", () => {
		expect(mrkdwnToDiscord("<https://example.com/~a~/b|docs>")).toBe("[docs](https://example.com/~a~/b)");
		expect(mrkdwnToDiscord("<https://example.com/~a~/b|*bold* ~strike~>")).toBe(
			"[**bold** ~~strike~~](https://example.com/~a~/b)",
		);
		expect(mrkdwnToDiscord("<https://example.com/*a*/b?x=1&amp;y=2>")).toBe("https://example.com/*a*/b?x=1&y=2");
		expect(mrkdwnToDiscord("https://example.com/*a*/b 과 mailto:a*b*~c~@x.test *강조* ~취소~")).toBe(
			"https://example.com/*a*/b 과 mailto:a*b*~c~@x.test **강조** ~~취소~~",
		);
		expect(mrkdwnToDiscord("[wiki](https://en.wikipedia.org/wiki/Foo_(bar)/*a*~b~)")).toBe(
			"[wiki](https://en.wikipedia.org/wiki/Foo_(bar)/*a*~b~)",
		);
		expect(mrkdwnToDiscord("*https://example.com/~a~*")).toBe("**https://example.com/~a~**");
		expect(mrkdwnToDiscord("https://example.com/$1/$$?k=1")).toBe("https://example.com/$1/$$?k=1");
		expect(mrkdwnToDiscord("\uE0000\uE001 https://example.com/*a*")).toBe("\uE0000\uE001 https://example.com/*a*");
	});

	test("#46: <!subteam^...|@team>·<!date^...|label> 라벨을 유지하고 @here/@channel/@everyone 핑은 막는다", () => {
		expect(mrkdwnToDiscord("<!subteam^S123|@team>")).toBe("@team");
		expect(mrkdwnToDiscord("<!date^1392734382^{date_short}|Feb 18, 2014>")).toBe("Feb 18, 2014");
		expect(mrkdwnToDiscord("<!subteam^S123|  @ops  >")).toBe("@ops");
		expect(mrkdwnToDiscord("<!subteam^S123> <!subteam^S123|> <!subteam^S123|   >")).toBe("subteam subteam subteam");
		expect(mrkdwnToDiscord("<!here|@here> <!channel|@channel> <!everyone|@everyone>")).toBe("here channel everyone");
		expect(mrkdwnToDiscord("<!subteam^S123|@here> <!subteam^S123|@everyone> <!date^1| @here >")).toBe(
			"subteam subteam date",
		);
	});

	test("#47: Gateway close 4006 이후 RESUME(op 6) 대신 새 세션 IDENTIFY(op 2)로 연결한다", async () => {
		class FakeTimers implements GatewayTimers {
			now = 0;
			#seq = 0;
			readonly pending = new Map<number, { fn: () => void; due: number }>();
			set(fn: () => void, ms: number): unknown {
				this.#seq += 1;
				this.pending.set(this.#seq, { fn, due: this.now + ms });
				return this.#seq;
			}
			clear(handle: unknown): void {
				this.pending.delete(handle as number);
			}
			advance(ms: number): void {
				const target = this.now + ms;
				for (;;) {
					let next: [number, { fn: () => void; due: number }] | undefined;
					for (const entry of this.pending)
						if (entry[1].due <= target && (!next || entry[1].due < next[1].due)) next = entry;
					if (next === undefined) break;
					this.pending.delete(next[0]);
					this.now = next[1].due;
					next[1].fn();
				}
				this.now = target;
			}
		}

		const waiters: Array<() => void> = [];
		const notify = () => {
			for (const w of waiters.splice(0)) w();
		};
		const until = async (cond: () => boolean): Promise<void> => {
			const deadline = Date.now() + 5_000;
			while (!cond()) {
				const left = deadline - Date.now();
				if (left <= 0) throw new Error("timed out waiting for gateway condition");
				const { promise, resolve } = Promise.withResolvers<void>();
				const t = setTimeout(resolve, left);
				waiters.push(() => {
					clearTimeout(t);
					resolve();
				});
				await promise;
			}
		};

		const conns: Array<{ ws: ServerWebSocket<{ path: string }>; path: string; ops: number[] }> = [];
		let sessions = 0;
		const server = Bun.serve<{ path: string }>({
			port: 0,
			fetch(req, s) {
				const url = new URL(req.url);
				return s.upgrade(req, { data: { path: url.pathname } })
					? undefined
					: new Response("upgrade required", { status: 426 });
			},
			websocket: {
				open(ws) {
					conns.push({ ws, path: ws.data.path, ops: [] });
					ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1_000 } }));
					notify();
				},
				message(ws, raw) {
					const frame = JSON.parse(String(raw)) as { op: number };
					const conn = conns.find((c) => c.ws === ws);
					conn?.ops.push(frame.op);
					if (frame.op === 1) ws.send(JSON.stringify({ op: 11 }));
					if (frame.op === 2) {
						sessions += 1;
						ws.send(
							JSON.stringify({
								op: 0,
								t: "READY",
								s: 1,
								d: {
									v: 10,
									session_id: `sess-${sessions}`,
									resume_gateway_url: `ws://localhost:${server.port}/resume`,
									user: { id: "500000000000000001", bot: true },
									application: { id: "600000000000000001" },
								},
							}),
						);
					}
					notify();
				},
			},
		});
		cleanups.push(() => void server.stop(true));

		const timers = new FakeTimers();
		const readyEvents: Array<{ resumed: boolean }> = [];
		const reconnects: string[] = [];
		const handlers: DiscordHandlers = {
			message: async () => {},
			messageUpdate: async () => {},
			interaction: async () => {},
			roles: () => {},
			channel: () => {},
			channelGone: () => {},
		};
		const gw = new DiscordGateway({
			token: ["TEST", "gateway", "token"].join("."),
			url: `ws://localhost:${server.port}/gateway`,
			handlers,
			timers,
			now: () => timers.now,
			random: () => 0.25,
			backoffBaseMs: 100,
			backoffMaxMs: 1_000,
			identifyGapMs: 0,
			onReady: (info) => {
				readyEvents.push(info);
				notify();
			},
			onReconnect: (reason) => {
				reconnects.push(reason);
				notify();
			},
		});
		cleanups.push(() => gw.stop());

		await gw.start();
		expect(readyEvents).toEqual([{ resumed: false }]);

		conns[0]?.ws.close(4006, "Invalid session");
		await until(() => reconnects.length === 1);
		expect(reconnects[0]).toBe("closed 4006");
		timers.advance(100);
		await until(() => conns.length === 2 && readyEvents.length === 2);
		expect(conns[1]?.path).toBe("/gateway");
		expect(conns[1]?.ops).toContain(2);
		expect(conns[1]?.ops).not.toContain(6);
		expect(readyEvents).toEqual([{ resumed: false }, { resumed: false }]);
	});

	test("#48: ~~~ 틸드 코드펜스 안의 card·표·링크는 건드리지 않고 chunkText는 ~~~로 닫고 다시 연다", () => {
		expect(fenceOpen("~~~markdown")).toEqual({ char: "~", len: 3 });
		expect(fenceOpen("```bash cmd```")).toBeUndefined();
		expect(fenceCloses("```", { char: "~", len: 3 })).toBe(false);
		expect(fenceCloses("~~~", { char: "~", len: 3 })).toBe(true);
		expect(fenceCloses("~~~~", { char: "~", len: 3 })).toBe(true);

		const cardInTilde =
			'~~~markdown\n```card\n{"root":"c","elements":{"c":{"type":"Card","props":{"title":"T"},"children":[]}}}\n```\n~~~';
		expect(splitCards(cardInTilde)).toEqual([{ kind: "text", text: cardInTilde }]);
		const nestedTilde = '~~~~\n~~~\n```card\n{"root":"c"}\n```\n~~~~';
		expect(splitCards(nestedTilde)).toEqual([{ kind: "text", text: nestedTilde }]);
		const closedThenCard = '~~~\nhi\n~~~\n```card\n{"root":"c"}\n```';
		expect(splitCards(closedThenCard).map((s) => s.kind)).toEqual(["text", "card"]);

		const tableInTilde = "~~~\n| a | b |\n| --- | --- |\n| 1 | 2 |\n~~~";
		expect(renderStackedTables(tableInTilde).text).toBe(tableInTilde);
		expect(tableSpans(tableInTilde)).toEqual([]);

		const afterTilde = `${tableInTilde}\n\n| c | d |\n| --- | --- |\n| 3 | 4 |`;
		expect(renderStackedTables(afterTilde).text).toBe(`${tableInTilde}\n\n**c**: 3\n- d: 4`);

		const linksInTilde = "~~~\n[ignored](https://a.test) ||secret|| <t:1764057600:R>\n~~~\n[kept](https://b.test)";
		expect(inlineSpans(linksInTilde).map(([s, e]) => linksInTilde.slice(s, e))).toEqual(["[kept](https://b.test)"]);

		const tildeCode = [
			"~~~ts",
			...Array.from({ length: 20 }, (_, i) => `const x${i} = "${"a".repeat(20)}";`),
			"~~~",
			`산문 끝 ${"설명 ".repeat(80)}`,
		].join("\n");
		const chunks = chunkText(tildeCode, 200);
		expect(chunks.length).toBeGreaterThan(2);
		const proseIdx = chunks.findIndex((c) => c.includes("산문 끝"));
		expect(proseIdx).toBeGreaterThan(1);
		for (const chunk of chunks.slice(0, proseIdx)) {
			expect(chunk.startsWith("~~~")).toBe(true);
			expect(chunk.endsWith("~~~")).toBe(true);
		}
		expect(chunks[proseIdx]?.startsWith("~~~")).toBe(false);
		expect(chunks.at(-1)?.startsWith("~~~")).toBe(false);
	});

	test("#44: 500개 초과(600개) 백틱·틸드 펜스도 lineHead 펜스로 추적되어 청크 경계마다 닫고 열리고 실제 닫기 줄에서만 닫힌다", () => {
		const f600 = "`".repeat(600);
		const codeLines = Array.from({ length: 240 }, (_, i) => `let v${i} = ${i};`);
		const body = `${f600}ts\n${codeLines.join("\n")}\n\`\`\`\nstill_inside_600\n${f600}\n\n${"뒤 산문 ".repeat(450)}`;
		const parts = chunkText(body, 2000);
		expect(parts.length).toBeGreaterThan(2);
		for (const part of parts) expect(part.length).toBeLessThanOrEqual(2000);
		expect(parts[0]?.startsWith(`${f600}ts`)).toBe(true);
		expect(parts[0]?.endsWith("\n```")).toBe(true);
		expect(parts[1]?.startsWith("```\n")).toBe(true);
		expect(parts[1]?.endsWith("\n```")).toBe(true);
		const tail = parts.at(-1) ?? "";
		expect(tail).toContain("뒤 산문");
		expect(tail.startsWith("```")).toBe(false);
		expect(tail.endsWith("```")).toBe(false);
		expect(parts.some((p) => p.includes("still_inside_600"))).toBe(true);

		const t600 = "~".repeat(600);
		const tBody = `${t600}\n${codeLines.join("\n")}\n~~~\nstill_inside_tilde\n${t600}\n\n${"틸드 뒤 산문 ".repeat(400)}`;
		const tParts = chunkText(tBody, 2000);
		expect(tParts.length).toBeGreaterThan(2);
		for (const part of tParts) expect(part.length).toBeLessThanOrEqual(2000);
		expect(tParts[0]?.startsWith(t600)).toBe(true);
		expect(tParts[0]?.endsWith("\n~~~")).toBe(true);
		expect(tParts[1]?.startsWith("~~~\n")).toBe(true);
		const tTail = tParts.at(-1) ?? "";
		expect(tTail).toContain("틸드 뒤 산문");
		expect(tTail.startsWith("~~~")).toBe(false);
		expect(tTail.endsWith("~~~")).toBe(false);
	});

	test("#43: 중첩 대괄호 라벨 링크가 inlineSpans에 포함되어 2000자 청크 경계에서 쪼개지지 않고 O(n) 시간에 처리된다", () => {
		const nested = "[a [b] c](https://e.test/nested/path)";
		const body = `${"가".repeat(1980)} ${nested} ${"나".repeat(200)}`;
		expect(inlineSpans(body).map(([s, e]) => body.slice(s, e))).toEqual([nested]);
		const parts = renderDiscordParts(body, false);
		expect(parts).toHaveLength(2);
		expect(parts[0]?.length).toBeLessThanOrEqual(2000);
		expect(parts[1]?.length).toBeLessThanOrEqual(2000);
		expect(parts.some((p) => p.includes(nested))).toBe(true);

		const multi = "![alt [1]](https://e.test/a_(b).png) [[x]](https://e.test/ok) \\[esc\\](https://e.test/no)";
		expect(inlineSpans(multi).map(([s, e]) => multi.slice(s, e))).toEqual([
			"![alt [1]](https://e.test/a_(b).png)",
			"[[x]](https://e.test/ok)",
		]);

		expect(findLinkSpans(`[${"a".repeat(513)}](https://x.test)`, 0)).toEqual([]);
		expect(findLinkSpans(`[ok](https://x.test/${"a".repeat(1020)})`, 0)).toEqual([]);

		for (const unit of ["[a](", "[a [b ", "[[[["]) {
			const hostile = unit.repeat(Math.ceil(65_536 / unit.length));
			const t0 = performance.now();
			findLinkSpans(hostile, 0);
			expect(performance.now() - t0).toBeLessThan(100);
		}
	});

	test("#49: 탭·4칸 들여쓰기 2열·3열 표는 부분 변환되지 않고 원문 그대로 남는다", () => {
		const tab2 = "\t| a | b |\n\t| --- | --- |\n\t| 1 | 2 |";
		const sp4_2 = "    | a | b |\n    | --- | --- |\n    | 1 | 2 |";
		const mixedDelim = "| a | b |\n\t| --- | --- |\n| 1 | 2 |";
		for (const md of [tab2, sp4_2, mixedDelim]) {
			expect(tableEndAt(md.split("\n"), 0)).toBeUndefined();
			expect(tableSpans(md)).toEqual([]);
			expect(renderStackedTables(md).text).toBe(md);
			expect(renderDiscordParts(md, false)).toEqual([md]);
		}

		const sp3 = "   | a | b |\n   | --- | --- |\n   | 1 | 2 |";
		expect(renderDiscordParts(sp3, false)).toEqual(["**a**: 1\n- b: 2"]);
	});
});
