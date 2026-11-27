import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { coldResumeTokens, ROTATION_BLOCK_MAX_CHARS } from "../src/core/mailbox-cold-resume";
import { ROTATION_CONTEXT_HEADER } from "../src/core/mailbox-thread-context";
import { laneOriginKey, taskOriginKey } from "../src/lanes/status";
import { monitorOrigin } from "../src/monitors/ledger";
import { recordSpawnPrompt } from "../src/ops/cache-miss-cause";
import { ColdResumeHarness, MIN, MODEL, ORIGIN, usageEvent } from "./helpers/cold-resume-harness";

let h: ColdResumeHarness;

afterEach(async () => {
	await h.close();
});

const rotationLogs = (): string[] => h.logs("epoch_new").filter((line) => line.includes("reason=cold_resume"));
const epochOf = (origin = ORIGIN): number | undefined => h.store.getOrigin(origin)?.epoch;
const promptsOf = (): string[] =>
	h.drivers.flatMap((driver) => driver.calls.filter((call) => call.startsWith("prompt:")));

/** A turn that leaves a baseline of `prefix` tokens, then `idleMin` quiet minutes. */
async function idleConversation(prefix: number, idleMin: number, origin = ORIGIN): Promise<void> {
	h.events = [usageEvent(prefix - 1_000, 1_000)];
	await h.turn("첫 질문", origin);
	h.clock.advance(idleMin * MIN);
}

/** A real omp session file of `origin` epoch 1 whose last record is an assistant call at `at`. */
function writeSessionFile(origin: string, at: number, prefix: number): string {
	const file = join(h.sessionDir(origin, 1), "2026-11-27T00-00-00-000Z_cafe0001.jsonl");
	mkdirSync(dirname(file), { recursive: true });
	const records = [
		{ type: "session", id: "cafe0001", timestamp: new Date(at - MIN).toISOString() },
		{ type: "message", timestamp: new Date(at - MIN).toISOString(), message: { role: "user", content: [] } },
		{
			type: "message",
			timestamp: new Date(at).toISOString(),
			message: {
				role: "assistant",
				content: [],
				provider: "anthropic",
				model: MODEL,
				usage: { input: 3, output: 5, cacheRead: prefix - 1_000, cacheWrite: 1_000, cost: { cacheWrite: 0.006 } },
			},
		},
	];
	writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
	return file;
}

describe("cold-resume rotation", () => {
	test("AC-1: a 101k conversation idle 61 minutes starts its new turn in a new epoch's session dir", async () => {
		h = new ColdResumeHarness({ tokens: 100_000 });
		await idleConversation(101_000, 61);
		const record = await h.turn("돌아왔어");
		expect(h.factoryDirs).toEqual([h.sessionDir(ORIGIN, 1), h.sessionDir(ORIGIN, 2)]);
		expect(epochOf()).toBe(2);
		expect(rotationLogs()).toHaveLength(1);
		expect(rotationLogs()[0]).toMatch(/prefix=101000/);
		expect(h.rotated).toEqual([
			expect.objectContaining({ originKey: ORIGIN, threadRef: record.threadRef, prefixTokens: 101_000 }),
		]);
	});

	describe("AC-2: no rotation below the thresholds or without the option", () => {
		const cases: Array<[string, number | undefined, number, number]> = [
			["99k", 100_000, 99_000, 61],
			["59 minutes", 100_000, 101_000, 59],
			["coldResumeRotateTokens 0", 0, 101_000, 61],
			["no mailbox option", undefined, 101_000, 61],
		];
		for (const [name, tokens, prefix, idleMin] of cases) {
			test(name, async () => {
				h = new ColdResumeHarness(tokens === undefined ? {} : { tokens });
				await idleConversation(prefix, idleMin);
				await h.turn("돌아왔어");
				expect(epochOf()).toBe(1);
				expect(h.factoryDirs).toEqual([h.sessionDir(ORIGIN, 1)]);
				expect(rotationLogs()).toHaveLength(0);
				expect(h.rotated).toHaveLength(0);
			});
		}
	});

	describe("AC-3: only chat conversations rotate", () => {
		const origins: Array<[string, string]> = [
			["monitor", monitorOrigin("abc12345")],
			["TASK", taskOriginKey("worker-1")],
			["lane", laneOriginKey("login-fix")],
		];
		for (const [name, origin] of origins) {
			test(`${name} origin keeps its epoch`, async () => {
				h = new ColdResumeHarness({ tokens: 100_000 });
				await idleConversation(150_000, 120, origin);
				await h.turn("again", origin);
				expect(epochOf(origin)).toBe(1);
				expect(rotationLogs()).toHaveLength(0);
				expect(h.rotated).toHaveLength(0);
			});
		}

		test("an agy bot's daemon hands the mailbox no threshold", async () => {
			expect(coldResumeTokens({ agent: "agy" })).toBe(0);
			expect(coldResumeTokens({ agent: "agy", coldResumeRotateTokens: 50_000 })).toBe(0);
			expect(coldResumeTokens({})).toBe(100_000);
			expect(coldResumeTokens({ coldResumeRotateTokens: 0 })).toBe(0);
			expect(coldResumeTokens({ agent: "omp", coldResumeRotateTokens: 70_000 })).toBe(70_000);
			h = new ColdResumeHarness({ tokens: coldResumeTokens({ agent: "agy" }) });
			await idleConversation(150_000, 120);
			await h.turn("again");
			expect(epochOf()).toBe(1);
		});
	});

	test("AC-4: the rotated first prompt carries the previous epoch's exchanges whole, its session file, and ends with the request", async () => {
		h = new ColdResumeHarness({ tokens: 100_000 });
		const previousFile = writeSessionFile(ORIGIN, h.clock.now() - 5 * MIN, 101_000);
		const longAnswer = "가나다라마바사아자차".repeat(30); // 300 Korean characters
		h.respond = () => longAnswer;
		await idleConversation(101_000, 61);
		await h.turn("지금 요청입니다");
		const rotatedPrompt = promptsOf().at(-1) ?? "";
		expect(rotatedPrompt.startsWith(`prompt:${ROTATION_CONTEXT_HEADER}\n`)).toBe(true);
		expect(rotatedPrompt).toContain("- 받은 질문(");
		expect(rotatedPrompt).toContain(`${longAnswer}`);
		expect(rotatedPrompt).toContain(`- 이전 세션 파일(필요하면 read로 직접 열어 본다): ${previousFile}`);
		expect(rotatedPrompt.endsWith("\n\n[현재 요청]\n지금 요청입니다")).toBe(true);
		const block = rotatedPrompt.slice("prompt:".length, rotatedPrompt.indexOf("\n\n[현재 요청]\n"));
		expect(block.length).toBeLessThanOrEqual(ROTATION_BLOCK_MAX_CHARS);
		// The turn after the rotated one carries no rotation block.
		await h.turn("다음 요청");
		expect(promptsOf().at(-1)).toBe("prompt:다음 요청");
	});

	test("AC-4: a block over 8000 characters drops the oldest exchanges first", async () => {
		h = new ColdResumeHarness({ tokens: 100_000 });
		h.respond = (prompt) => `답:${prompt.at(-1)}${"긴".repeat(990)}`;
		h.events = [usageEvent(100_000, 1_000)];
		for (const tag of ["1", "2", "3", "4", "5"]) await h.turn(`질문${"길".repeat(990)}${tag}`);
		h.clock.advance(61 * MIN);
		await h.turn("지금");
		const rotatedPrompt = promptsOf().at(-1) ?? "";
		const block = rotatedPrompt.slice("prompt:".length, rotatedPrompt.indexOf("\n\n[현재 요청]\n"));
		expect(block.length).toBeLessThanOrEqual(ROTATION_BLOCK_MAX_CHARS);
		expect(block).toContain("답:5");
		expect(block).not.toContain("답:1");
	});

	test("AC-4b: the pending row survives the rotation in the new epoch, is sent once, and its delivery follows", async () => {
		h = new ColdResumeHarness({ tokens: 100_000 });
		await idleConversation(101_000, 61);
		const record = await h.turn("돌아와서 한 번만 보내야 함");
		const row = h.store.getInbound(record.platformMessageId);
		expect(row?.state).toBe("answered");
		expect(row?.epoch).toBe(2);
		expect(promptsOf().filter((prompt) => prompt.endsWith("돌아와서 한 번만 보내야 함"))).toHaveLength(1);
		const delivery = h.store.listDeliveries({ originKey: ORIGIN }).find((d) => d.opRef === row?.opRef);
		expect(delivery).toMatchObject({ threadRef: record.threadRef, state: "confirmed" });
		expect(h.store.listInbound({ originKey: ORIGIN, state: "discarded" })).toHaveLength(0);
	});

	test("AC-4c: a rotated turn calls onColdResumeRotated once and never onColdCache", async () => {
		h = new ColdResumeHarness({ tokens: 100_000 });
		await idleConversation(250_000, 120);
		await h.turn("돌아왔어");
		expect(h.rotated).toHaveLength(1);
		expect(h.coldCaches).toHaveLength(0);
	});

	test("AC-4c: a big cold turn that does not rotate still gets the cold-cache warning only", async () => {
		h = new ColdResumeHarness({ tokens: 0 });
		await idleConversation(250_000, 120);
		await h.turn("돌아왔어");
		expect(h.coldCaches).toHaveLength(1);
		expect(h.rotated).toHaveLength(0);
		expect(epochOf()).toBe(1);
	});

	describe("AC-5: without a mailbox baseline the session file decides, and no child is started for it", () => {
		test("a last assistant record 61 minutes old with 101k rotates before any child of the old epoch", async () => {
			h = new ColdResumeHarness({ tokens: 100_000 });
			writeSessionFile(ORIGIN, h.clock.now() - 61 * MIN, 101_000);
			await h.turn("데몬 재시작 뒤 첫 턴");
			expect(h.factoryDirs).toEqual([h.sessionDir(ORIGIN, 2)]);
			expect(rotationLogs()).toHaveLength(1);
		});

		test("a record 59 minutes old does not rotate", async () => {
			h = new ColdResumeHarness({ tokens: 100_000 });
			writeSessionFile(ORIGIN, h.clock.now() - 59 * MIN, 101_000);
			await h.turn("데몬 재시작 뒤 첫 턴");
			expect(h.factoryDirs).toEqual([h.sessionDir(ORIGIN, 1)]);
			expect(rotationLogs()).toHaveLength(0);
		});

		test("an unreadable session file means no rotation and a warning", async () => {
			h = new ColdResumeHarness({ tokens: 100_000 });
			h.store.ensureOrigin(ORIGIN, h.sessionDir(ORIGIN, 1));
			h.store.pinSessionFile(ORIGIN, join(h.dir, "missing-session.jsonl"));
			await h.turn("읽을 수 없는 세션");
			expect(epochOf()).toBe(1);
			expect(rotationLogs()).toHaveLength(0);
			expect(h.logs("cold_resume_baseline_failed")).toHaveLength(1);
		});

		test("an origin with no session file yet is not a failure", async () => {
			h = new ColdResumeHarness({ tokens: 100_000 });
			await h.turn("첫 대화");
			expect(epochOf()).toBe(1);
			expect(h.logs("cold_resume_baseline_failed")).toHaveLength(0);
		});
	});
});

describe("AC-9: child_restart miss lines name which prompt changed", () => {
	const digestLine = (data: string): string =>
		`${JSON.stringify({ type: "custom", customType: "system-prompt-digest", data, id: "d" })}\n`;

	/** A restarted daemon: a session whose baseline is 330k and 10 minutes old; the next call misses 302k. */
	async function restartedMiss(opts: { first: string; second: string; digest: string | undefined }): Promise<string[]> {
		h = new ColdResumeHarness({ tokens: 0 });
		h.seedSession(ORIGIN, h.clock.now() - 10 * MIN, { cacheRead: 300_000, cacheWrite: 30_000 });
		const file = writeSessionFile(ORIGIN, h.clock.now() - 10 * MIN, 330_000);
		appendFileSync(file, digestLine("aaa"));
		recordSpawnPrompt(h.sessionDir(ORIGIN, 1), opts.first);
		h.spawnPrompt = opts.second;
		h.onSpawn = () => {
			if (opts.digest !== undefined) appendFileSync(file, digestLine(opts.digest));
		};
		h.events = [usageEvent(28_000, 302_000)];
		await h.turn("재시작 뒤 첫 턴");
		return h.logs("cache_miss").filter((line) => line.includes("reason=child_restart"));
	}

	test("the same spawn prompt and the same digest: both false", async () => {
		const lines = await restartedMiss({ first: "v1", second: "v1", digest: "aaa" });
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("jabbu_prompt_changed=false");
		expect(lines[0]).toContain("omp_digest_changed=false");
	});

	test("a different spawn prompt and a different digest: both true", async () => {
		const lines = await restartedMiss({ first: "v1", second: "v2", digest: "bbb" });
		expect(lines[0]).toContain("jabbu_prompt_changed=true");
		expect(lines[0]).toContain("omp_digest_changed=true");
	});

	test("no digest written after the spawn: omp_digest_changed=unknown", async () => {
		const lines = await restartedMiss({ first: "v1", second: "v1", digest: undefined });
		expect(lines[0]).toContain("omp_digest_changed=unknown");
	});

	test("other miss reasons carry neither field", async () => {
		h = new ColdResumeHarness({ tokens: 0 });
		h.events = [usageEvent(300_000, 30_000)];
		await h.turn("하나");
		h.events.splice(0, h.events.length, usageEvent(28_000, 302_000, "other-model")); // the live child reads the same array
		await h.turn("둘");
		const lines = h.logs("cache_miss").filter((line) => !line.includes("reason=child_restart"));
		expect(lines.some((line) => line.includes("reason=model_switch"))).toBe(true);
		for (const line of lines) {
			expect(line).not.toContain("jabbu_prompt_changed");
			expect(line).not.toContain("omp_digest_changed");
		}
	});
});
