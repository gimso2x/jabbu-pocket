import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JabbuConfig } from "../src/config";
import { extractResetAt } from "../src/core/failure-kind";
import type { ColdCacheInfo } from "../src/core/mailbox-types";
import { normalizeInbound } from "../src/core/normalize";
import { OriginRouter, openBotStore, sessionDirFor } from "../src/core/origin";
import type { InboundRecord } from "../src/core/types";
import type { DaemonContext } from "../src/daemon/daemon-context";
import { DaemonCommandPicker } from "../src/daemon/daemon-picker";
import { DaemonQuotaGate } from "../src/daemon/daemon-quota";
import { DiscordChannel } from "../src/discord/channel";
import { createLogger } from "../src/log";
import { AgyAccountPool } from "../src/omp/agy-account-pool";
import { AgyOmpDriver, type AgyOmpDriverOptions } from "../src/omp/agy-driver";
import { finalLineQuotaNotice } from "../src/omp/agy-notice";
import { readAgyPointer, recordFinalQuotaNotice, writeAgyPointer } from "../src/omp/agy-quota";
import { OmpDriverError, type OmpEvent, type OmpFinal } from "../src/omp/driver";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { parseDialogRequest } from "../src/omp/rpc-dialog";
import { ExtensionUiTap } from "../src/omp/rpc-ui-tap";
import { checkOmpRuntime, checkOmpRuntimeSync } from "../src/omp/runtime-check";
import { parsePickerActionId } from "../src/ops/picker";
import { redact } from "../src/redact";
import { ApprovalBroker } from "../src/safety/approval";
import { answerDialog } from "../src/safety/choice";
import { askText } from "../src/safety/choice-ask";
import { ownerDocsPrompt } from "../src/safety/prompt-files";
import { BOT, CHANNEL, makeHome, OWNER, OWNER_DM } from "./helpers/bot-home";
import { registryOf } from "./helpers/channels";
import { FakeDiscordTransport } from "./helpers/discord-fake-transport";

const FAKE_AGY_SCRIPT = join(import.meta.dir, "helpers", "fake-agy.ts");
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	while (cleanups.length > 0) {
		await cleanups.pop()?.();
	}
});

class FailOncePromptDriver extends FakeOmpDriver {
	failFirst = true;
	override async prompt(text: string): Promise<string> {
		if (this.failFirst) {
			this.failFirst = false;
			throw new OmpDriverError("rpc_error", "rejected before turn start");
		}
		return super.prompt(text);
	}
}

function makeAgyTestHarness() {
	const root = mkdtempSync(join(tmpdir(), "jabbu-qa-ad-agy-"));
	const workspace = join(root, "workspace");
	const sessionDir = join(root, "sessions", "e1");
	const binDir = join(root, "bin");
	mkdirSync(workspace, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	const executable = join(binDir, "agy");
	writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_AGY_SCRIPT}" "$@"\n`);
	chmodSync(executable, 0o755);
	const logFile = join(root, "fake-agy.log");
	writeFileSync(logFile, "");
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	return {
		root,
		sessionDir,
		make(options: Partial<AgyOmpDriverOptions> = {}): AgyOmpDriver {
			return new AgyOmpDriver({
				agyExecutable: executable,
				cwd: workspace,
				sessionDir,
				...options,
				env: { FAKE_AGY_LOG: logFile, ...(options.env ?? {}) },
				baseEnv: { HOME: root, PATH: process.env.PATH ?? "/usr/bin:/bin" },
				startupTimeoutMs: 10_000,
			});
		},
	};
}

function nextFinal(driver: AgyOmpDriver): Promise<OmpFinal> {
	const { promise, resolve } = Promise.withResolvers<OmpFinal>();
	const off = driver.onFinal((final) => {
		off();
		resolve(final);
	});
	return promise;
}

function nextEvent(driver: AgyOmpDriver, match: (event: OmpEvent) => boolean): Promise<OmpEvent> {
	const { promise, resolve } = Promise.withResolvers<OmpEvent>();
	const off = driver.onEvent((event) => {
		if (match(event)) {
			off();
			resolve(event);
		}
	});
	return promise;
}

describe("qa-ad core·omp·safety 수정", () => {
	test("#13: prompt 전송이 거부되면 식은 캐시 경고가 발사되지 않고, 다음 성공 턴에서 1회 발사된다", async () => {
		const dir = mkdtempSync(join(tmpdir(), "jabbu-qa13-"));
		const t0 = 1_795_500_000_000;
		const clock = { now: () => t0 };
		const store = openBotStore(join(dir, "jabbu.db"), clock, "Asia/Seoul");
		const sessionsRoot = join(dir, "sessions");
		const sessionStore = new FakeSessionStore();
		const origin = `discord/dm/${OWNER_DM}`;
		const sessionDir = sessionDirFor(sessionsRoot, origin, 1);
		sessionStore.open(sessionDir);
		const session = sessionStore.sessions.get(sessionDir);
		if (session === undefined) throw new Error("missing fake session");
		session.entries.push({
			id: "e3",
			parentId: "e2",
			type: "message",
			timestamp: new Date(t0 - 120 * 60_000).toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "text", text: "이전 답" }],
				stopReason: "stop",
				provider: "anthropic",
				model: "claude-opus-4-6",
				usage: { input: 3, output: 5, cacheRead: 240_000, cacheWrite: 10_000, cost: { cacheWrite: 0.0625 } },
			},
		});
		session.nextId = 4;

		const coldCaches: ColdCacheInfo[] = [];
		const driver = new FailOncePromptDriver({ sessionDir, store: sessionStore });
		const router = new OriginRouter({
			timezone: "Asia/Seoul",
			store,
			clock,
			sessionsRoot,
			log: createLogger({ sink: () => undefined, clock, redact }),
			statusProvider: () => "ok",
			onColdCache: (info) => coldCaches.push(info),
			driverFactory: () => driver,
		});
		cleanups.push(async () => {
			await router.close();
			store.close();
			rmSync(dir, { recursive: true, force: true });
		});

		const first: InboundRecord = {
			platformMessageId: "m1",
			originKey: origin,
			ownerVerified: true,
			text: "첫 시도",
			threadRef: "t1",
		};
		await router.route(first);
		expect(coldCaches).toHaveLength(0);

		const second: InboundRecord = {
			platformMessageId: "m2",
			originKey: origin,
			ownerVerified: true,
			text: "재시도",
			threadRef: "t2",
		};
		await router.route(second);
		expect(coldCaches).toHaveLength(1);
		expect(coldCaches[0]?.threadRef).toBe("t2");
		expect(coldCaches[0]?.prefixTokens).toBe(250_000);
	});

	test("#24: checkOmpRuntime/Sync가 실행 권한 상실(EACCES) 시 캐시와 무관하게 실패를 보고한다", async () => {
		const dir = mkdtempSync(join(tmpdir(), "jabbu-qa24-"));
		const exe = join(dir, "omp");
		writeFileSync(exe, '#!/bin/sh\necho "omp/1.0.0"\n');
		chmodSync(exe, 0o755);
		cleanups.push(() => {
			try {
				chmodSync(exe, 0o755);
			} catch {
				// ignore
			}
			rmSync(dir, { recursive: true, force: true });
		});

		expect(await checkOmpRuntime(exe)).toBeUndefined();
		expect(checkOmpRuntimeSync(exe)).toBeUndefined();

		if (process.getuid?.() !== 0) {
			chmodSync(exe, 0o644);
			const asyncProb = await checkOmpRuntime(exe);
			const syncProb = checkOmpRuntimeSync(exe);
			expect(asyncProb?.code).toBe("omp_executable_missing");
			expect(asyncProb?.detail).toContain("error=EACCES");
			expect(syncProb?.code).toBe("omp_executable_missing");
			expect(syncProb?.detail).toContain("error=EACCES");
		}
	});

	test("#40: 채널에서 인용과 함께 보낸 !home은 인용문을 버리고 채널 오리진으로 정규화된다", () => {
		const result = normalizeInbound({
			userId: OWNER,
			botUserId: BOT,
			ownerUserId: OWNER,
			text: "!home",
			quoted: ["인용된 메시지 본문"],
			channel: CHANNEL,
			ts: "1700000001001",
			channelType: "channel",
			platform: "discord",
		});
		expect(result.accept).toBe(true);
		if (result.accept) {
			expect(result.inbound.text).toBe("!home");
			expect(result.inbound.originKey).toBe(`discord/ch/${CHANNEL}`);
		}
	});

	test("#41: extractResetAt이 긴 입력을 40자로 잘라 안전하게 반환한다", () => {
		const longMsg = `429 resets in ${"1s ".repeat(1000)}x`;
		const resetAt = extractResetAt(longMsg);
		expect(resetAt).toBeDefined();
		expect(resetAt?.length).toBeLessThanOrEqual(43);
		expect(resetAt).toEndWith(" 뒤");
	});

	test("#50: DaemonCommandPicker가 선택(sel) 갱신 시 session.busy 안내를 유지한다", async () => {
		const home = makeHome("jabbu-qa50-");
		cleanups.push(() => home.remove());
		const now = 1_795_500_000_000;
		const log = createLogger({ sink: () => undefined, clock: { now: () => now }, redact });
		const transport = new FakeDiscordTransport();
		const channel = new DiscordChannel(transport, { ownerUserId: OWNER });
		const channels = registryOf(channel);
		const config: JabbuConfig = { ...home.config };
		const ctx = {
			options: { config },
			clock: { now: () => now },
			log,
			channels,
		} as unknown as DaemonContext;
		const picker = new DaemonCommandPicker(ctx, new DaemonQuotaGate(ctx));

		const pickerDriver = new FakeOmpDriver({ sessionDir: join(home.dir, "s"), models: ["fake/a", "fake/b"] });
		await pickerDriver.start();
		const opened = await picker.open({
			kind: "model",
			originKey: `discord/dm/${OWNER_DM}`,
			threadRef: `${OWNER_DM}:1`,
			busy: true,
			ensureDriver: async () => pickerDriver,
		});
		expect(opened).toBe(true);

		const created = transport.calls.find((c) => c.method === "createMessage");
		expect(created?.method).toBe("createMessage");
		if (created?.method !== "createMessage") throw new Error("expected createMessage");
		expect(created.content).toContain("⏳ 작업 중에는 바꿀 수 없습니다");

		const rows = (created.components ?? []) as Array<{ components?: Array<{ custom_id?: string }> }>;
		const customId = rows
			.flatMap((r) => r.components ?? [])
			.find((c) => c.custom_id?.startsWith("jabbu:picker:sel:"))?.custom_id;
		const action = customId === undefined ? undefined : parsePickerActionId(customId);
		expect(action?.op).toBe("sel");
		if (action === undefined) throw new Error("missing picker sel action");

		await picker.handleAction(action, { values: ["0"] });
		const edited = transport.calls.findLast((c) => c.method === "editMessage");
		expect(edited?.method).toBe("editMessage");
		if (edited?.method === "editMessage") {
			expect(edited.content).toContain("선택한 항목: **fake/a**");
			expect(edited.content).toContain("⏳ 작업 중에는 바꿀 수 없습니다");
		}
	});

	test("#51: AgyOmpDriver가 미전달 steer를 droppedSteers로 보고하고, pre-tool 풀 전환 시에는 유지한다", async () => {
		const h1 = makeAgyTestHarness();
		const d1 = h1.make();
		await d1.start();
		const started1 = nextEvent(d1, (e) => e.type === "tool_execution_start");
		const done1 = nextFinal(d1);
		await d1.prompt("@holdtool");
		await started1;
		await d1.steer("dropped-on-abort");
		await d1.abort();
		const f1 = await done1;
		expect(f1.status).toBe("aborted");
		expect(f1.droppedSteers).toBe(1);
		expect(f1.error).toContain("(steer 1건 미전달)");
		await d1.stop();

		// Post-tool quota on single-account pool drops queued steer with count/note.
		const clock = { t: 1_795_500_000_000 };
		const h2 = makeAgyTestHarness();
		const accDir = join(h2.root, "accounts");
		const geminiDir = join(h2.root, ".gemini");
		mkdirSync(accDir, { recursive: true });
		mkdirSync(geminiDir, { recursive: true });
		writeFileSync(join(accDir, "order"), "acct1 agy/gemini-pro-orchestrator-neon\n");
		writeFileSync(join(accDir, "acct1.token"), JSON.stringify({ fake: "tok-1" }), { mode: 0o600 });
		const log = createLogger({ sink: () => undefined, clock: { now: () => clock.t }, redact });
		const pool1 = new AgyAccountPool({
			config: () => ({ dir: accDir }),
			statePath: join(h2.root, "state.json"),
			geminiDir,
			now: () => clock.t,
			log,
		});
		const d2 = h2.make({ accounts: pool1, log, timezone: "Asia/Seoul", now: () => clock.t });
		await d2.start();
		const off = d2.onEvent((e) => {
			if (e.type === "tool_execution_start") {
				off();
				void d2.steer("lost-post-tool");
			}
		});
		const done2 = nextFinal(d2);
		await d2.prompt("@tool-quota");
		const f2 = await done2;
		expect(f2.status).toBe("error");
		expect(f2.droppedSteers).toBe(1);
		expect(f2.error).toContain("(steer 1건 미전달)");
		await d2.stop();

		// Pre-tool quota switch on 2-account pool preserves steer across account transition.
		const h3 = makeAgyTestHarness();
		const accDir3 = join(h3.root, "accounts");
		const geminiDir3 = join(h3.root, ".gemini");
		mkdirSync(accDir3, { recursive: true });
		mkdirSync(geminiDir3, { recursive: true });
		writeFileSync(
			join(accDir3, "order"),
			"acct1 agy/gemini-pro-orchestrator-neon\nacct2 agy/gemini-pro-orchestrator-neon\n",
		);
		for (const n of ["acct1", "acct2"]) {
			writeFileSync(join(accDir3, `${n}.token`), JSON.stringify({ fake: `tok-${n}` }), { mode: 0o600 });
		}
		const pool3 = new AgyAccountPool({
			config: () => ({ dir: accDir3 }),
			statePath: join(h3.root, "state3.json"),
			geminiDir: geminiDir3,
			now: () => clock.t,
			log,
		});
		const d3 = h3.make({
			accounts: pool3,
			log,
			timezone: "Asia/Seoul",
			now: () => clock.t,
			env: { FAKE_AGY_QUOTA_DIRS: "antigravity-cli-acct-acct1" },
		});
		await d3.start();
		const done3 = nextFinal(d3);
		await d3.prompt("first question");
		await d3.steer("surviving-steer");
		const f3 = await done3;
		expect(f3.status).toBe("completed");
		expect(f3.droppedSteers).toBeUndefined();
		expect(f3.text).toContain("surviving-steer");
		await d3.stop();
	});

	test("#52: readAgyPointer/writeAgyPointer가 FIFO·심링크·디렉터리를 차단하고 원자적으로 쓴다", () => {
		const root = mkdtempSync(join(tmpdir(), "jabbu-qa52-"));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));

		const fifo = join(root, "ptr-fifo.json");
		execFileSync("mkfifo", [fifo]);
		expect(readAgyPointer(fifo)).toBeUndefined();

		const dirPtr = join(root, "ptr-dir.json");
		mkdirSync(dirPtr);
		expect(readAgyPointer(dirPtr)).toBeUndefined();

		const outside = join(root, "outside.json");
		writeFileSync(outside, JSON.stringify({ conversationId: "outside-keep" }));
		const symPtr = join(root, "agy-conversation.json");
		symlinkSync(outside, symPtr);
		expect(readAgyPointer(symPtr)).toBeUndefined();

		writeAgyPointer(root, symPtr, "sess-new", "acct1");
		expect(lstatSync(symPtr).isSymbolicLink()).toBe(false);
		expect(readFileSync(outside, "utf8")).toContain("outside-keep");
		expect(readAgyPointer(symPtr)).toEqual({ conversationId: "sess-new", account: "acct1" });
	});

	test("#53/#23: 들여쓴 한도 문구와 tool-free 일반 답변 뒤 한도 문구 오탐을 막는다", () => {
		const notice =
			"Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 15m59s.";
		expect(finalLineQuotaNotice(`설명\n\n    ⚠ ${notice}`)).toBeUndefined();
		expect(finalLineQuotaNotice(`설명\n\n\t⚠ ${notice}`)).toBeUndefined();
		expect(finalLineQuotaNotice(`정상 답변입니다\n⚠ ${notice}`, { standaloneOnly: true })).toBeUndefined();
		expect(finalLineQuotaNotice(`⚠ ${notice}`, { standaloneOnly: true })).toBe(notice);

		const preToolTurn: { rateLimit?: string; hadToolCall?: boolean } = { hadToolCall: false };
		expect(recordFinalQuotaNotice(preToolTurn, "end_turn", `정상 본문\n⚠ ${notice}`)).toBe(false);
		expect(preToolTurn.rateLimit).toBeUndefined();

		const standaloneTurn: { rateLimit?: string; hadToolCall?: boolean } = { hadToolCall: false };
		expect(recordFinalQuotaNotice(standaloneTurn, "end_turn", `⚠ ${notice}`)).toBe(true);
		expect(standaloneTurn.rateLimit).toContain("agy rate limited (429)");

		const postToolTurn: { rateLimit?: string; hadToolCall?: boolean } = { hadToolCall: true };
		expect(recordFinalQuotaNotice(postToolTurn, "end_turn", `작업 중\n⚠ ${notice}`)).toBe(true);
		expect(postToolTurn.rateLimit).toContain("agy rate limited (429)");
	});

	test("#54: 빈 select 요청은 카드 없이 cancelled로 즉시 응답한다", async () => {
		expect(parseDialogRequest({ method: "select", id: "1", title: "빈 선택", options: [] })).toBeUndefined();

		const replies: unknown[] = [];
		let answered = 0;
		const tap = new ExtensionUiTap(
			() => undefined,
			(frame) => replies.push(frame),
			async () => {
				answered += 1;
				return { cancelled: true };
			},
		);
		tap.frame({ type: "extension_ui_request", id: "r1", method: "select", title: "빈 선택", options: [] });
		expect(answered).toBe(0);
		expect(replies).toEqual([{ type: "extension_ui_response", id: "r1", cancelled: true }]);

		const dir = mkdtempSync(join(tmpdir(), "jabbu-qa54-"));
		const now = 1_795_500_000_000;
		const clock = { now: () => now };
		const store = openBotStore(join(dir, "jabbu.db"), clock, "Asia/Seoul");
		const transport = new FakeDiscordTransport();
		const channel = new DiscordChannel(transport, { ownerUserId: OWNER });
		const broker = new ApprovalBroker({
			timezone: "Asia/Seoul",
			channels: registryOf(channel),
			ownerUserId: OWNER,
			log: createLogger({ sink: () => undefined, clock, redact }),
			store,
		});
		cleanups.push(() => {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		});

		const ac = new AbortController();
		const res = await answerDialog(
			broker,
			{ originKey: `discord/dm/${OWNER_DM}`, channel: OWNER_DM },
			{ method: "select", id: "r2", title: "빈 선택", options: [] },
			ac.signal,
		);
		expect(res).toEqual({ cancelled: true });
		expect(transport.calls.filter((c) => c.method === "createMessage")).toHaveLength(0);
	});

	test("#55: 긴 30문항 askText가 2850자 이내 슬라이딩 윈도우로 문항을 온전히 표시한다", () => {
		const questions = Array.from({ length: 30 }, (_, i) => ({
			id: `q${i + 1}`,
			question: `문항 ${i + 1} 상세 안내 ${"가".repeat(90)}`,
			options: [{ label: "예" }, { label: "아니오" }],
		}));
		const answers: Array<{ selectedOptions: string[] } | undefined> = new Array(30).fill(undefined);

		const initial = askText(questions, answers, new Set());
		expect(initial.length).toBeLessThanOrEqual(2850);
		expect(initial).toContain("… 외 질문");
		expect(initial).not.toContain("*30.");

		for (let i = 0; i < 25; i++) answers[i] = { selectedOptions: ["예"] };
		const slid = askText(questions, answers, new Set());
		expect(slid.length).toBeLessThanOrEqual(2850);
		expect(slid).toContain("✅ 1~25번 답변 완료");
		expect(slid).toContain("*30.");
		expect(slid).toContain("번호로 답장해 주세요");
	});

	test("#56: ownerDocsPrompt가 12KB 넘는 전각 공백 머리를 건너뛰고 1MiB 초과 시 EWHITESPACE를 보고한다", () => {
		const root = mkdtempSync(join(tmpdir(), "jabbu-qa56-"));
		const soul = join(root, "soul.md");
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));

		writeFileSync(soul, `${"\u3000".repeat(9_000)}SOUL-BODY\n`);
		const errors1: unknown[] = [];
		const okDoc = ownerDocsPrompt(`discord/dm/${OWNER_DM}`, { soul }, (err) => errors1.push(err));
		expect(okDoc).toContain("SOUL-BODY");
		expect(errors1).toEqual([]);

		writeFileSync(soul, `${"\u3000".repeat(400_000)}HIDDEN`);
		const errors2: unknown[] = [];
		const capDoc = ownerDocsPrompt(`discord/dm/${OWNER_DM}`, { soul }, (err) => errors2.push(err));
		expect(capDoc).toBe("");
		expect(errors2).toHaveLength(1);
		expect((errors2[0] as { code?: string }).code).toBe("EWHITESPACE");
	});
});
