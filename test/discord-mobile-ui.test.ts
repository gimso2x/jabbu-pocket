import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactSelectMenus } from "../src/channel/components";
import { DENIED_TEXT } from "../src/channel/text";
import type { CoreSink, DeliverySource } from "../src/channel/types";
import type { JabbuConfig } from "../src/config";
import { OriginMailbox } from "../src/core/mailbox";
import { effectiveFastSetting, FAST_CURSOR_PREFIX, parseFastArg } from "../src/core/mailbox-settings";
import { openBotStore, sessionDirFor } from "../src/core/origin";
import { parseCommand } from "../src/core/types";
import { Daemon } from "../src/daemon/daemon";
import { NamespacedDriver } from "../src/daemon/opref";
import { DiscordAdapter } from "../src/discord/adapter";
import { DiscordChannel } from "../src/discord/channel";
import { buttonRows, componentRows, selectMenuRows } from "../src/discord/components";
import { renderDiscordParts } from "../src/discord/format";
import { formatStackedTable, renderStackedTables, stripTableHeaderMarkdown } from "../src/discord/table";
import { DiscordCallError } from "../src/discord/transport";
import { createLogger } from "../src/log";
import { AgyAccountPool } from "../src/omp/agy-account-pool";
import type { OmpFinal, OmpSessionDriver } from "../src/omp/driver";
import { FakeOmpDriver } from "../src/omp/fake-driver";
import { PICKER_TTL_MS, parsePickerActionId, pickerActionId, renderPickerMessage } from "../src/ops/picker";
import { ProviderQuotaGate, readQuotaLifts, writeQuotaLift } from "../src/ops/quota-gate";
import { QuotaRecoveryTracker } from "../src/ops/quota-recovery";
import { executeQuotaReset } from "../src/ops/quota-reset";
import { redact } from "../src/redact";
import { discordBinding, GUILD, makeHome, OWNER, OWNER_DM, WaitingDiscordTransport } from "./helpers/bot-home";
import { type FakeDiscordCall, FakeDiscordTransport } from "./helpers/discord-fake-transport";
import { daemonTestOptions } from "./helpers/disk";

const tempDirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	while (cleanups.length > 0) {
		const fn = cleanups.pop();
		if (fn !== undefined) await fn();
	}
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type ComponentNode = {
	type: number;
	custom_id?: string;
	label?: string;
	disabled?: boolean;
	options?: Array<{ label: string; value: string; description?: string; default?: boolean }>;
};
type ActionRowNode = { type: number; components: ComponentNode[] };

function unpackRows(components: readonly unknown[] | undefined): {
	selects: ComponentNode[];
	buttons: ComponentNode[];
} {
	const selects: ComponentNode[] = [];
	const buttons: ComponentNode[] = [];
	for (const rawRow of (components ?? []) as ActionRowNode[]) {
		for (const comp of rawRow.components ?? []) {
			if (comp.type === 3) selects.push(comp);
			else if (comp.type === 2) buttons.push(comp);
		}
	}
	return { selects, buttons };
}

function writeAgyAccountsFixture(
	root: string,
	orderText: string,
	names: readonly string[],
): {
	accDir: string;
	geminiDir: string;
} {
	const accDir = join(root, "agy-accounts");
	const geminiDir = join(root, "gemini");
	mkdirSync(accDir, { recursive: true });
	mkdirSync(geminiDir, { recursive: true });
	writeFileSync(join(accDir, "order"), orderText);
	for (const name of names) {
		writeFileSync(join(accDir, `${name}.token`), JSON.stringify({ fake: `tok-${name}` }), { mode: 0o600 });
	}
	return { accDir, geminiDir };
}

describe("1. Discord 모바일 stacked 표 변환", () => {
	test("한글·ASCII·이모지 다열 표를 빈 셀·빈 행을 건너뛰어 행별 블록으로 변환한다", () => {
		const md = [
			"| **항목** | `상태` | [비고](https://x.test) |",
			"|---|---|---|",
			"| bash | ✅ 10회 | ok |",
			"|   |   |   |",
			"| **read** | ⚠️ |   |",
		].join("\n");
		const out = renderStackedTables(md);
		expect(out.text).toBe("**항목**: bash\n- 상태: ✅ 10회\n- 비고: ok\n\n**항목**: **read**\n- 상태: ⚠️");
		expect(out.spans).toHaveLength(1);
	});

	test("데이터 행이 없는 헤더 전용 표와 3개 이상 백틱 셀, 펜스 안 표를 안전하게 처리한다", () => {
		expect(stripTableHeaderMarkdown("**이름** · `[링크](https://a_(b))`")).toBe("이름 · [링크](https://a_(b))");
		expect(formatStackedTable(["이름", "상태"], [])).toBe("**이름** · **상태**");
		const fenced = "```\n| a | b |\n|---|---|\n| 1 | 2 |\n```";
		expect(renderStackedTables(fenced).text).toBe(fenced);
		const ticks = renderStackedTables("| col | code |\n|---|---|\n| x | ```` |").text;
		expect(ticks).not.toContain("```");
		expect(ticks).toContain("**col**: x");
	});

	test("2000자 이하 표는 한 메시지로 유지하고 2000자를 넘는 큰 표는 행 경계에서 나눈다", () => {
		const shortRows = Array.from({ length: 12 }, (_, i) => `| 행${i} | 값${i} |`);
		const shortMd = ["| 항목 | 값 |", "|---|---|", ...shortRows].join("\n");
		const shortParts = renderDiscordParts(shortMd, false);
		expect(shortParts).toHaveLength(1);
		expect(shortParts[0]?.length).toBeLessThanOrEqual(2000);

		const longRows = Array.from(
			{ length: 65 },
			(_, i) => `| r${String(i).padStart(2, "0")} | ${"가나다라".repeat(8)} |`,
		);
		const longMd = ["| 번호 | 내용 |", "|---|---|", ...longRows].join("\n");
		const longParts = renderDiscordParts(longMd, false);
		expect(longParts.length).toBeGreaterThan(1);
		for (const part of longParts) expect(part.length).toBeLessThanOrEqual(2000);
		expect(longParts.join("\n")).toContain("**번호**: r64");
	});
});

describe("2. SelectMenu 컴포넌트 직렬화·마스킹·Interaction 처리", () => {
	test("componentRows는 SelectMenu를 버튼 위 행에 배치하고 disabled·한도·마스킹을 검증한다", async () => {
		const rows = componentRows(
			[
				{ actionId: "b1", label: "확인", style: "primary", disabled: true },
				{ actionId: "b2", label: "취소", style: "danger" },
			],
			[{ actionId: "s1", placeholder: "고르기", options: [{ label: "A", value: "a", default: true }] }],
		) as ActionRowNode[];
		expect(rows).toHaveLength(2);
		expect(rows[0]?.components[0]).toMatchObject({ type: 3, custom_id: "s1", placeholder: "고르기" });
		expect(rows[1]?.components[0]).toMatchObject({ type: 2, custom_id: "b1", label: "확인", style: 1, disabled: true });

		expect(() => selectMenuRows([{ actionId: "s0", options: [] }])).toThrow(DiscordCallError);
		const tooManyOpts = Array.from({ length: 26 }, (_, i) => ({ label: `L${i}`, value: `v${i}` }));
		const capped = selectMenuRows([{ actionId: "s26", options: tooManyOpts }]) as ActionRowNode[];
		expect(capped[0]?.components[0]?.options).toHaveLength(25);
		expect(() => selectMenuRows([{ actionId: "x".repeat(101), options: [{ label: "a", value: "1" }] }])).toThrow(
			DiscordCallError,
		);
		expect(() => selectMenuRows([{ actionId: "sv", options: [{ label: "a", value: "v".repeat(101) }] }])).toThrow(
			DiscordCallError,
		);
		const manyButtons = Array.from({ length: 21 }, (_, i) => ({ actionId: `b${i}`, label: `${i}` }));
		expect(buttonRows(manyButtons)).toHaveLength(5);
		expect(() => componentRows(manyButtons, [{ actionId: "s1", options: [{ label: "a", value: "1" }] }])).toThrow(
			DiscordCallError,
		);

		const redacted = redactSelectMenus(
			[
				{
					actionId: "secret-id-keep",
					placeholder: "토큰 SECRET_A",
					options: [{ label: "라벨 SECRET_B", value: "val-keep", description: "설명 SECRET_C" }],
				},
			],
			(s) => s.replace(/SECRET_[ABC]/g, "[REDACTED]"),
		);
		expect(redacted[0]).toEqual({
			actionId: "secret-id-keep",
			placeholder: "토큰 [REDACTED]",
			options: [{ label: "라벨 [REDACTED]", value: "val-keep", description: "설명 [REDACTED]" }],
		});

		const transport = new FakeDiscordTransport();
		const port = new DiscordChannel(transport, { ownerUserId: OWNER });
		const ref = await port.post(
			{ conversationId: OWNER_DM },
			{
				text: "선택하세요",
				selectMenus: [{ actionId: "sel:1", options: [{ label: "하나", value: "1" }] }],
				buttons: [{ actionId: "ok:1", label: "확인", style: "primary", disabled: true }],
			},
		);
		await port.edit(ref, { text: "완료", buttons: [], selectMenus: [] });
		const edits = transport.calls.filter((c) => c.method === "editMessage");
		expect(edits[0]?.components).toEqual([]);
	});

	test("DiscordAdapter.handleInteraction이 SelectMenu values를 전달하고 비오너·중복을 거른다", async () => {
		const transport = new FakeDiscordTransport();
		transport.setChannel({ id: "9001", type: 11, parentId: "3001", guildId: GUILD });
		const port = new DiscordChannel(transport, { ownerUserId: OWNER });
		const seen: Array<{ actionId: string; values?: readonly string[]; channel?: string }> = [];
		const core: CoreSink = {
			onInbound: () => undefined,
			onCommand: () => undefined,
			onAction: (action) => {
				seen.push({ actionId: action.actionId, values: action.values, channel: action.channel });
			},
		};
		const logs: string[] = [];
		const noDeliveries: DeliverySource = { claimDue: () => [], confirm: () => {}, fail: () => {}, defer: () => {} };
		const adapter = new DiscordAdapter({
			channel: port,
			core,
			deliveries: noDeliveries,
			ownerUserId: OWNER,
			clock: { now: () => 1_800_000_000_000 },
			log: createLogger({ sink: (line) => logs.push(line), clock: { now: () => 0 }, redact }),
		});
		await adapter.start();
		cleanups.push(() => adapter.stop());

		const makeSelect = (id: string, userId: string) => ({
			id,
			application_id: "600000000000000000",
			type: 3,
			token: `tok-${id}`,
			guild_id: GUILD,
			channel_id: "9001",
			member: { user: { id: userId, username: "u" } },
			data: { custom_id: "jabbu:picker:sel:abc", component_type: 3, values: ["2"] },
			message: { id: "msg-1", channel_id: "9001" },
		});

		await transport.emitInteraction(makeSelect("ix-stranger", "9999999"));
		expect(seen).toHaveLength(0);
		expect(transport.calls.find((c) => c.method === "respondInteraction" && c.interactionId === "ix-stranger")).toEqual(
			{
				method: "respondInteraction",
				interactionId: "ix-stranger",
				token: "tok-ix-stranger",
				response: { type: 4, data: { content: DENIED_TEXT, flags: 64 } },
			},
		);

		await transport.emitInteraction(makeSelect("ix-owner", OWNER));
		await transport.emitInteraction(makeSelect("ix-owner", OWNER));
		expect(seen).toEqual([{ actionId: "jabbu:picker:sel:abc", values: ["2"], channel: "3001" }]);
		expect(transport.calls.find((c) => c.method === "respondInteraction" && c.interactionId === "ix-owner")).toEqual({
			method: "respondInteraction",
			interactionId: "ix-owner",
			token: "tok-ix-owner",
			response: { type: 6 },
		});
	});
});

describe("3. !fast · !usage-reset 명령과 영속 상태", () => {
	test("parseCommand·parseFastArg·스레드 fast 상속·미지원 모델·agy/omp 쿼터 초기화를 검증한다", async () => {
		expect(parseCommand("!fast")).toEqual({ kind: "fast", arg: "" });
		expect(parseCommand("/fast-jabbu on")).toEqual({ kind: "fast", arg: "on" });
		expect(parseCommand("!usage-reset all")).toEqual({ kind: "usage-reset", arg: "all" });
		expect(parseCommand("/usage-reset-jabbu")).toEqual({ kind: "usage-reset", arg: "" });
		expect(parseFastArg("켜기")).toBe(true);
		expect(parseFastArg("OFF")).toBe(false);
		expect(parseFastArg("maybe")).toBeUndefined();

		const dir = makeTempDir("jabbu-fast-cmd-");
		const clockNow = 10_000;
		const store = openBotStore(join(dir, "jabbu.db"), { now: () => clockNow }, "Asia/Seoul");
		cleanups.push(() => store.close());
		const log = createLogger({ sink: () => undefined, clock: { now: () => clockNow }, redact });
		const drivers: FakeOmpDriver[] = [];
		let fastSupported = true;
		let omitFast = false;

		const makeMailbox = (originKey: string) =>
			new OriginMailbox({
				store,
				originKey,
				sessionDirFor: (k, e) => sessionDirFor(join(dir, "sessions"), k, e),
				driverFactory: (_k, sessionDir) => {
					const d = new FakeOmpDriver({ sessionDir, fastModeSupported: fastSupported });
					if (omitFast) (d as Partial<OmpSessionDriver>).setFastMode = undefined;
					drivers.push(d);
					return d;
				},
				statusProvider: () => "ok",
				timezone: "Asia/Seoul",
				clock: { now: () => clockNow },
				log,
			});

		const channelOrigin = "discord/ch/300";
		const threadOrigin = "discord/ch/300/t/900";
		const chBox = makeMailbox(channelOrigin);
		cleanups.push(() => chBox.close());
		await chBox.enqueue({
			platformMessageId: "m-fast-1",
			originKey: channelOrigin,
			ownerVerified: true,
			text: "!fast on",
			threadRef: "discord/ch/300/-",
		});
		expect(store.getCursor(`${FAST_CURSOR_PREFIX}${channelOrigin}`)).toBe("on");
		expect(effectiveFastSetting(store, threadOrigin)).toBe(true);

		const thBox = makeMailbox(threadOrigin);
		cleanups.push(() => thBox.close());
		await thBox.enqueue({
			platformMessageId: "m-th-1",
			originKey: threadOrigin,
			ownerVerified: true,
			text: "hello",
			threadRef: "discord/ch/300/900",
		});
		expect(drivers.at(-1)?.calls).toContain("setFastMode:true");
		await thBox.close();
		const thBox2 = makeMailbox(threadOrigin);
		cleanups.push(() => thBox2.close());
		await thBox2.enqueue({
			platformMessageId: "m-th-2",
			originKey: threadOrigin,
			ownerVerified: true,
			text: "after-idle",
			threadRef: "discord/ch/300/900",
		});
		expect(drivers.at(-1)?.calls).toContain("setFastMode:true");

		fastSupported = false;
		const unsupportedOrigin = "discord/dm/776";
		const unsupportedBox = makeMailbox(unsupportedOrigin);
		cleanups.push(() => unsupportedBox.close());
		await unsupportedBox.enqueue({
			platformMessageId: "m-fast-unsup",
			originKey: unsupportedOrigin,
			ownerVerified: true,
			text: "!fast on",
			threadRef: "discord/dm/776/-",
		});
		const lastAns = store.listDeliveries({ originKey: unsupportedOrigin }).at(-1)?.body;
		expect(lastAns).toContain("현재 모델에서는 fast 모드를 켤 수 없습니다");

		const withFast = new FakeOmpDriver();
		const withoutFast = new FakeOmpDriver();
		(withoutFast as Partial<OmpSessionDriver>).setFastMode = undefined;
		expect(new NamespacedDriver(withFast, "p1").setFastMode).toBeDefined();
		expect(new NamespacedDriver(withoutFast, "p2").setFastMode).toBeUndefined();

		omitFast = true;
		const noFastBox = makeMailbox("discord/dm/777");
		cleanups.push(() => noFastBox.close());
		await noFastBox.enqueue({
			platformMessageId: "m-fast-nodrv",
			originKey: "discord/dm/777",
			ownerVerified: true,
			text: "!fast on",
			threadRef: "discord/dm/777/-",
		});
		expect(store.listDeliveries({ originKey: "discord/dm/777" }).at(-1)?.body).toContain(
			"fast 모드를 지원하지 않습니다",
		);

		// AgyAccountPool.clearBlocked + persistence across reload
		const agyRoot = makeTempDir("jabbu-agy-reset-");
		const { accDir, geminiDir } = writeAgyAccountsFixture(
			agyRoot,
			"acct1 agy/gemini-4-neon\nacct2 agy/gemini-4-neon\n",
			["acct1", "acct2"],
		);
		const statePath = join(agyRoot, "agy-state.json");
		const pool = new AgyAccountPool({ config: () => ({ dir: accDir }), statePath, geminiDir, now: () => 1_000_000 });
		pool.markExhausted("acct1", 2_000_000);
		pool.markExhausted("acct2", 2_000_000);
		expect(pool.clearBlocked("acct1", 1_000_000)).toEqual(["acct1"]);
		const reloaded = new AgyAccountPool({
			config: () => ({ dir: accDir }),
			statePath,
			geminiDir,
			now: () => 1_000_000,
		});
		expect(reloaded.isBlocked("acct1")).toBe(false);
		expect(reloaded.isBlocked("acct2")).toBe(true);
		expect(reloaded.clearBlocked("*", 1_000_000)).toEqual(["acct2"]);
		const afterAll = new AgyAccountPool({
			config: () => ({ dir: accDir }),
			statePath,
			geminiDir,
			now: () => 1_000_000,
		});
		expect(afterAll.isBlocked("acct2")).toBe(false);

		// executeQuotaReset validation, runtime hold release, and clear-lifts
		const rec = new QuotaRecoveryTracker();
		rec.recordQuotaError({ provider: "anthropic", originKey: "discord/dm/1", now: 1_000_000, reason: "limit" });
		const gate = new ProviderQuotaGate();
		let polled = 0;
		const resetHome = makeTempDir("jabbu-qreset-");
		writeQuotaLift(resetHome, { provider: "openai", untilMs: 5_000_000, now: 1_000_000 });
		const runReset = (rawArg: string) =>
			executeQuotaReset({
				rawArg,
				homeDir: resetHome,
				now: 1_000_000,
				isAgy: false,
				agyPool: undefined,
				recovery: rec,
				gate,
				log,
				resetSnapshot: () => ({
					providers: [{ id: "anthropic", summary: "보류" }],
					holdCount: 1,
					liftCount: 1,
					isAgy: false,
				}),
				onClearLifts: () => undefined,
				onReleaseEvents: () => undefined,
				onSaveSnapshot: () => undefined,
				onPollNow: () => {
					polled += 1;
				},
			});
		expect(runReset("bad space!")).toContain("대상 이름이 올바르지 않습니다");
		expect(runReset("anthropic")).toContain("대기열 보류 1건 해제");
		expect(rec.listHolds()).toHaveLength(0);
		expect(readQuotaLifts(resetHome, 1_000_000).has("openai")).toBe(true);
		expect(runReset("clear-lifts")).toContain("수동 쿼터 해제");
		expect(polled).toBe(1);
		expect(readQuotaLifts(resetHome, 1_000_000).size).toBe(0);
	});
});

describe("4. E2E Daemon SelectMenu 피커 흐름", () => {
	async function bootPickerDaemon(opts?: {
		models?: readonly string[];
		holdTurns?: boolean;
		configPatch?: Record<string, unknown>;
		agyPool?: AgyAccountPool;
		clockNow?: () => number;
		failNextModel?: string;
	}) {
		const home = makeHome("jabbu-picker-e2e-");
		cleanups.push(() => home.remove());
		const transport = new WaitingDiscordTransport();
		const drivers: FakeOmpDriver[] = [];
		const promptWaiters: Array<() => void> = [];
		const waitForPromptCount = async (count: number) => {
			if (drivers.reduce((n, d) => n + d.calls.filter((c) => c.startsWith("prompt:")).length, 0) >= count) return;
			await new Promise<void>((resolve) => {
				const check = () => {
					if (drivers.reduce((n, d) => n + d.calls.filter((c) => c.startsWith("prompt:")).length, 0) >= count) {
						resolve();
						return;
					}
					promptWaiters.push(check);
				};
				promptWaiters.push(check);
			});
		};
		const config = { ...home.config, ...(opts?.configPatch ?? {}) } as JabbuConfig;
		const daemon = new Daemon({
			...daemonTestOptions(),
			config,
			channels: [discordBinding(transport)],
			agyPool: opts?.agyPool,
			clock: opts?.clockNow === undefined ? undefined : { now: opts.clockNow },
			driverFactory: (_originKey, sessionDir) => {
				const base = new FakeOmpDriver({
					sessionDir,
					models: opts?.models ?? ["fake/alpha", "fake/beta"],
					holdTurns: opts?.holdTurns,
				});
				const origPrompt = base.prompt.bind(base);
				base.prompt = async (text: string) => {
					const opRef = await origPrompt(text);
					for (const waiter of promptWaiters.splice(0)) waiter();
					return opRef;
				};
				if (opts?.failNextModel !== undefined) {
					const origOnFinal = base.onFinal.bind(base);
					let seenFail = false;
					base.onFinal = (fn: (final: OmpFinal) => void) =>
						origOnFinal((f) => {
							if (!seenFail) {
								seenFail = true;
								fn({ opRef: f.opRef, status: "error", text: "", error: opts.failNextModel });
								return;
							}
							fn(f);
						});
				}
				drivers.push(base);
				return base;
			},
			log: createLogger({ sink: () => undefined, clock: { now: opts?.clockNow ?? (() => Date.now()) }, redact }),
			ompVersion: "0.0.0-test",
			bootId: "picker-test",
			sweepMs: 3_600_000,
			gateSweepMs: 0,
			taskSweepMs: 0,
			pendingRetryMs: 1,
		});
		await daemon.start();
		cleanups.push(() => daemon.stop());
		return { home, transport, daemon, drivers, waitForPromptCount };
	}

	async function sendDmAndWaitPicker(
		transport: WaitingDiscordTransport,
		id: string,
		text: string,
		match: string,
	): Promise<Extract<FakeDiscordCall, { method: "createMessage" }>> {
		const before = transport.calls.length;
		await transport.emitMessage({
			id,
			channel_id: OWNER_DM,
			author: { id: OWNER, username: "owner" },
			content: text,
			type: 0,
		});
		const call = await transport
			.waitForCall(
				(c) =>
					transport.calls.indexOf(c) >= before && c.method === "createMessage" && (c.content ?? "").includes(match),
				1_500,
			)
			.catch((err: unknown) => {
				const tail = transport.calls
					.slice(before)
					.map((c) => `${c.method}:${"content" in c ? (c.content ?? "") : ""}`)
					.join(" | ");
				throw new Error(`sendDm(${id},${text},${match}): ${String(err)} [after: ${tail}]`);
			});
		return call as Extract<FakeDiscordCall, { method: "createMessage" }>;
	}

	async function interactAndWaitEdit(
		transport: WaitingDiscordTransport,
		msgId: string,
		customId: string,
		values: readonly string[] | undefined,
		match: string,
		interactionId: string,
	): Promise<Extract<FakeDiscordCall, { method: "editMessage" }>> {
		const before = transport.calls.length;
		await transport.emitInteraction({
			id: interactionId,
			application_id: "600000000000000000",
			type: 3,
			token: `tok-${interactionId}`,
			channel_id: OWNER_DM,
			user: { id: OWNER, username: "owner" },
			data: {
				custom_id: customId,
				component_type: values === undefined ? 2 : 3,
				...(values === undefined ? {} : { values }),
			},
			message: { id: msgId, channel_id: OWNER_DM },
		});
		const call = await transport
			.waitForCall(
				(c) =>
					transport.calls.indexOf(c) >= before &&
					c.method === "editMessage" &&
					c.messageId === msgId &&
					(c.content ?? "").includes(match),
				1_500,
			)
			.catch((err: unknown) => {
				const tail = transport.calls
					.slice(before)
					.map((c) => `${c.method}:${"content" in c ? (c.content ?? "") : ""}`)
					.join(" | ");
				throw new Error(`waitEdit(${interactionId},${match}): ${String(err)} [after: ${tail}]`);
			});
		return call as Extract<FakeDiscordCall, { method: "editMessage" }>;
	}

	test("!model 30개 페이지 이동·선택·확인·취소·작업중 거절·만료 정리와 !thinking·!fast 피커를 처리한다", async () => {
		let now = 2_000_000_000;
		const models = Array.from({ length: 30 }, (_, i) => `fake/m${String(i + 1).padStart(2, "0")}`);
		const { transport, drivers } = await bootPickerDaemon({ models, clockNow: () => now });

		// 1. Bare !model -> 25 options, confirm disabled, next enabled -> page 2 -> select m27 -> confirm
		const opened = await sendDmAndWaitPicker(transport, "dm-1", "!model", "🔀 모델 선택");
		const r0 = unpackRows(opened.components);
		expect(r0.selects[0]?.options).toHaveLength(25);
		expect(r0.buttons.find((b) => b.label === "확인")?.disabled).toBe(true);
		expect(r0.buttons.find((b) => b.label === "◀ 이전")?.disabled).toBe(true);
		expect(r0.buttons.find((b) => b.label === "다음 ▶")?.disabled).toBeUndefined();

		const nextId = r0.buttons.find((b) => b.label === "다음 ▶")?.custom_id ?? "";
		const paged = await interactAndWaitEdit(transport, opened.id, nextId, undefined, "페이지 2/2", "ix-p2");
		const r1 = unpackRows(paged.components);
		expect(r1.selects[0]?.options).toHaveLength(5);

		const selId = r1.selects[0]?.custom_id ?? "";
		const selected = await interactAndWaitEdit(
			transport,
			opened.id,
			selId,
			["26"],
			"선택한 항목: **fake/m27**",
			"ix-sel27",
		);
		const r2 = unpackRows(selected.components);
		const okBtn = r2.buttons.find((b) => b.label === "확인");
		expect(okBtn?.disabled).toBeUndefined();

		const applied = await interactAndWaitEdit(
			transport,
			opened.id,
			okBtn?.custom_id ?? "",
			undefined,
			"fake/m27",
			"ix-ok27",
		);
		expect(applied.components).toEqual([]);
		expect((await drivers[0]?.state())?.model).toBe("fake/m27");

		// 2. Cancel keeps current model
		const opened2 = await sendDmAndWaitPicker(transport, "dm-2", "!model", "🔀 모델 선택");
		const cancelId = unpackRows(opened2.components).buttons.find((b) => b.label === "취소")?.custom_id ?? "";
		const cancelled = await interactAndWaitEdit(
			transport,
			opened2.id,
			cancelId,
			undefined,
			"선택을 취소했습니다",
			"ix-cancel",
		);
		expect(cancelled.components).toEqual([]);
		expect((await drivers[0]?.state())?.model).toBe("fake/m27");

		// 3. !thinking & !fast pickers
		const thOpen = await sendDmAndWaitPicker(transport, "dm-3", "!thinking", "🧠 thinking 선택");
		const thSel = await interactAndWaitEdit(
			transport,
			thOpen.id,
			unpackRows(thOpen.components).selects[0]?.custom_id ?? "",
			["3"],
			"선택한 항목: **high**",
			"ix-th-sel",
		);
		const thDone = await interactAndWaitEdit(
			transport,
			thOpen.id,
			unpackRows(thSel.components).buttons.find((b) => b.label === "확인")?.custom_id ?? "",
			undefined,
			"high(으)로 바꿨습니다",
			"ix-th-ok",
		);
		expect(thDone.components).toEqual([]);
		expect((await drivers[0]?.state())?.thinking).toBe("high");

		const fastOpen = await sendDmAndWaitPicker(transport, "dm-4", "!fast", "⚡ fast 모드 선택");
		const fastSel = await interactAndWaitEdit(
			transport,
			fastOpen.id,
			unpackRows(fastOpen.components).selects[0]?.custom_id ?? "",
			["0"],
			"선택한 항목: **켜기 (on)**",
			"ix-fast-sel",
		);
		const fastDone = await interactAndWaitEdit(
			transport,
			fastOpen.id,
			unpackRows(fastSel.components).buttons.find((b) => b.label === "확인")?.custom_id ?? "",
			undefined,
			"fast 모드를 켰습니다(on)",
			"ix-fast-ok",
		);
		expect(fastDone.components).toEqual([]);
		expect((await drivers[0]?.state())?.fastModeEnabled).toBe(true);

		// 4. TTL expiration & unknown post-restart token
		const expOpen = await sendDmAndWaitPicker(transport, "dm-5", "!model", "🔀 모델 선택");
		now += PICKER_TTL_MS + 1000;
		const expCancel = unpackRows(expOpen.components).buttons.find((b) => b.label === "취소")?.custom_id ?? "";
		const expired = await interactAndWaitEdit(transport, expOpen.id, expCancel, undefined, "만료되었습니다", "ix-exp");
		expect(expired.components).toEqual([]);

		expect(parsePickerActionId(pickerActionId("ok", "restarted-tok"))).toEqual({ op: "ok", token: "restarted-tok" });
		const unknownMsg = renderPickerMessage({ token: "t", kind: "fast", currentLabel: "off", options: [], page: 0 });
		expect(unknownMsg.buttons?.find((b) => b.label === "확인")?.disabled).toBe(true);
	});

	test("작업 중 확인 시 ephemeral 안내 후 피커 유지, release 뒤 적용 성공 및 !usage-reset 피커 복구", async () => {
		const { transport, drivers, waitForPromptCount } = await bootPickerDaemon({
			holdTurns: true,
			models: ["anthropic/claude-opus-5-5", "zai/glm-5.4"],
		});
		await transport.emitMessage({
			id: "dm-busy",
			channel_id: OWNER_DM,
			author: { id: OWNER, username: "owner" },
			content: "오래 걸리는 작업",
			type: 0,
		});
		await waitForPromptCount(1);

		const opened = await sendDmAndWaitPicker(transport, "dm-m", "!model", "🔀 모델 선택");
		const selEdit = await interactAndWaitEdit(
			transport,
			opened.id,
			unpackRows(opened.components).selects[0]?.custom_id ?? "",
			["1"],
			"선택한 항목: **zai/glm-5.4**",
			"ix-b-sel",
		);
		const okId = unpackRows(selEdit.components).buttons.find((b) => b.label === "확인")?.custom_id ?? "";
		const busyEdit = await interactAndWaitEdit(
			transport,
			opened.id,
			okId,
			undefined,
			"작업 중에는 바꿀 수 없습니다",
			"ix-b-try",
		);
		expect(unpackRows(busyEdit.components).buttons.length).toBeGreaterThan(0);
		expect(
			transport.calls.some(
				(c) => c.method === "followupInteraction" && (c.content ?? "").includes("작업 중에는 바꿀 수 없습니다"),
			),
		).toBe(true);

		const beforeFinish = transport.calls.length;
		drivers[0]?.release();
		await transport.waitForCall(
			(c) =>
				transport.calls.indexOf(c) >= beforeFinish &&
				c.method === "createMessage" &&
				(c.content ?? "").includes("ECHO 오래 걸리는 작업"),
		);

		const okAfter = await interactAndWaitEdit(transport, opened.id, okId, undefined, "zai/glm-5.4", "ix-b-ok");
		expect(okAfter.components).toEqual([]);
		expect((await drivers[0]?.state())?.model).toBe("zai/glm-5.4");

		// !usage-reset picker in agy mode clears blocked account
		const agyRoot = makeTempDir("jabbu-e2e-agy-");
		const { accDir, geminiDir } = writeAgyAccountsFixture(agyRoot, "acct1 agy/gemini-4-neon\n", ["acct1"]);
		const agyPool = new AgyAccountPool({
			config: () => ({ dir: accDir }),
			statePath: join(agyRoot, "state.json"),
			geminiDir,
			now: () => 5_000_000,
		});
		agyPool.markExhausted("acct1", 6_000_000);
		const agyBoot = await bootPickerDaemon({
			configPatch: { agent: "agy", agyAccounts: { dir: accDir } },
			agyPool,
			clockNow: () => 5_000_000,
		});
		const uOpen = await sendDmAndWaitPicker(agyBoot.transport, "dm-u1", "!usage-reset", "🔄 사용량·쿼터 초기화");
		const uSel = await interactAndWaitEdit(
			agyBoot.transport,
			uOpen.id,
			unpackRows(uOpen.components).selects[0]?.custom_id ?? "",
			["1"],
			"선택한 항목: **acct1**",
			"ix-u-sel",
		);
		const uOk = await interactAndWaitEdit(
			agyBoot.transport,
			uOpen.id,
			unpackRows(uSel.components).buttons.find((b) => b.label === "확인")?.custom_id ?? "",
			undefined,
			"agy 계정 차단을 해제했습니다: acct1",
			"ix-u-ok",
		);
		expect(uOk.components).toEqual([]);
		expect(agyPool.isBlocked("acct1")).toBe(false);

		// !usage-reset picker in omp mode clears runtime quota hold and auto-resumes pending turn
		const ompBoot = await bootPickerDaemon({
			holdTurns: false,
			models: ["anthropic/claude-opus-5-5", "zai/glm-5.4"],
			configPatch: { model: "anthropic/claude-opus-5-5" },
			failNextModel: "429 Usage limit reached. resets in 15m",
		});
		const beforeFail = ompBoot.transport.calls.length;
		await ompBoot.transport.emitMessage({
			id: "dm-omp-fail",
			channel_id: OWNER_DM,
			author: { id: OWNER, username: "owner" },
			content: "첫 한도 요청",
			type: 0,
		});
		await ompBoot.transport.waitForCall(
			(c) =>
				ompBoot.transport.calls.indexOf(c) >= beforeFail &&
				c.method === "createMessage" &&
				(c.content ?? "").includes("Usage limit reached"),
		);
		await ompBoot.transport.emitMessage({
			id: "dm-omp-held",
			channel_id: OWNER_DM,
			author: { id: OWNER, username: "owner" },
			content: "재개될 요청",
			type: 0,
		});
		const ompOpen = await sendDmAndWaitPicker(
			ompBoot.transport,
			"dm-omp-reset",
			"!usage-reset",
			"🔄 사용량·쿼터 초기화",
		);
		const ompSel = await interactAndWaitEdit(
			ompBoot.transport,
			ompOpen.id,
			unpackRows(ompOpen.components).selects[0]?.custom_id ?? "",
			["1"],
			"선택한 항목: **anthropic**",
			"ix-omp-sel",
		);
		const beforeResume = ompBoot.transport.calls.length;
		const ompOk = await interactAndWaitEdit(
			ompBoot.transport,
			ompOpen.id,
			unpackRows(ompSel.components).buttons.find((b) => b.label === "확인")?.custom_id ?? "",
			undefined,
			"대기열 보류 1건 해제",
			"ix-omp-ok",
		);
		expect(ompOk.components).toEqual([]);
		await ompBoot.transport.waitForCall(
			(c) =>
				ompBoot.transport.calls.indexOf(c) >= beforeResume &&
				c.method === "createMessage" &&
				(c.content ?? "").includes("ECHO 재개될 요청"),
		);
	});
});
