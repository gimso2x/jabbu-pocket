import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realProcessRunner } from "../src/dispatch/omp";
import {
	formatLimits,
	ompUsageArgs,
	parseUsageResponse,
	type UsageResponse,
	usageLimitsBlock,
} from "../src/omp/usage-json";
import {
	allSessionFiles,
	conversationSessionFiles,
	renderUsage,
	summarizeSessionFiles,
	type UsageTotals,
} from "../src/ops/usage";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jabbu-usage-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const usage = (input: number, output: number, cacheRead: number, cacheWrite: number, cost: number) => ({
	input,
	output,
	cacheRead,
	cacheWrite,
	totalTokens: input + output + cacheRead + cacheWrite,
	cost: { input: 0, output: 0, total: cost },
});

function writeJsonl(path: string, lines: Array<unknown | string>): string {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n"));
	return path;
}

const ZERO: UsageTotals = {
	calls: 0,
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	costTotal: 0,
	files: 0,
	badLines: 0,
};

describe("summarizeSessionFiles", () => {
	test("(1)(2) sums assistant message usage and model_usage records, counts broken lines, ignores the rest", async () => {
		const file = writeJsonl(join(dir, "a.jsonl"), [
			{ type: "session", id: "s1" },
			{ type: "message", message: { role: "user", content: "hi", usage: usage(999, 999, 999, 999, 9) } },
			{ type: "message", message: { role: "assistant", content: [], usage: usage(100, 10, 1000, 50, 0.5) } },
			{ type: "message", message: { role: "assistant", content: [] } },
			"{ broken json",
			"",
			{ type: "message", message: { role: "assistant", content: [], usage: usage(200, 20, 0, 0, 0.25) } },
			{ type: "model_usage", model: "x/y", usage: usage(816, 39, 0, 0, 0) },
			{ type: "model_usage" },
			{ type: "custom", usage: usage(5, 5, 5, 5, 5) },
		]);
		expect(await summarizeSessionFiles([file])).toEqual({
			calls: 3,
			input: 1116,
			output: 69,
			cacheRead: 1000,
			cacheWrite: 50,
			costTotal: 0.75,
			files: 1,
			badLines: 1,
		});
	});

	test("(4) no files, a missing path and an empty file all give zero without throwing", async () => {
		expect(await summarizeSessionFiles([])).toEqual(ZERO);
		const empty = join(dir, "empty.jsonl");
		writeFileSync(empty, "");
		expect(await summarizeSessionFiles([join(dir, "nope.jsonl"), empty])).toEqual({ ...ZERO, files: 1 });
	});
});

describe("session file discovery", () => {
	test("a conversation is every epoch of its origin directory, sub-agent transcripts included", () => {
		const origin = join(dir, "sessions", encodeURIComponent("discord/dm/200000000000000001"));
		const a = writeJsonl(join(origin, "e1", "2026-11-01_a.jsonl"), []);
		const b = writeJsonl(join(origin, "e2", "2026-11-02_b.jsonl"), []);
		const nested = writeJsonl(join(origin, "e2", "2026-11-02_b", "Scout.jsonl"), []);
		writeJsonl(join(origin, "notes", "x.jsonl"), []);
		const other = writeJsonl(
			join(dir, "sessions", encodeURIComponent("discord/dm/200000000000000002"), "e1", "c.jsonl"),
			[],
		);
		expect(conversationSessionFiles(origin).sort()).toEqual([a, b, nested].sort());
		expect(allSessionFiles(join(dir, "sessions")).length).toBe(5);
		expect(allSessionFiles(join(dir, "sessions"))).toContain(other);
		expect(conversationSessionFiles(join(dir, "sessions", "missing"))).toEqual([]);
		expect(allSessionFiles(join(dir, "missing"))).toEqual([]);
	});
});

describe("renderUsage", () => {
	test("two total lines and the gc caveat", () => {
		const conversation: UsageTotals = {
			calls: 3,
			input: 1116,
			output: 69,
			cacheRead: 1000,
			cacheWrite: 50,
			costTotal: 0.754,
			files: 1,
			badLines: 0,
		};
		const overall: UsageTotals = { ...conversation, calls: 4548, input: 12345678, files: 120, costTotal: 12.3 };
		expect(renderUsage(conversation, overall)).toBe(
			[
				"이 대화: 모델 호출 3회 · 입력 1,116 (캐시 읽기 46%) · 출력 69 · 비용 $0.75",
				"전체(보관 중인 세션 파일 120개): 모델 호출 4,548회 · 입력 12,345,678 (캐시 읽기 0%) · 출력 69 · 비용 $12.30",
				"보관 중인 세션 기준이라 gc로 지운 옛 세션은 빠집니다.",
			].join("\n"),
		);
		expect(renderUsage(ZERO, ZERO).split("\n")[0]).toBe(
			"이 대화: 모델 호출 0회 · 입력 0 (캐시 읽기 0%) · 출력 0 · 비용 $0.00",
		);
	});
});

/** A `usage --json` answer as omp 19 writes it, cut to the fields the formatter reads. */
const response = (over: Partial<UsageResponse> = {}): UsageResponse => ({
	generatedAt: new Date(2026, 10, 21, 3, 0, 0).getTime(),
	reports: [],
	...over,
});

/** A stand-in omp that answers `usage` with `body` (a shell script body). */
function fakeOmp(body: string): string {
	const path = join(dir, "fake-omp");
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
	return path;
}

const limits = (executable: string, run = realProcessRunner) => usageLimitsBlock({ executable, env: {}, run });

describe("formatLimits / limitLine", () => {
	test("a 5-hour window is named 5시간, an exhausted one says 한도 도달, and today's reset names the hour", () => {
		const resetsAt = new Date(2026, 10, 21, 8, 30, 0).getTime();
		const text = formatLimits(
			response({
				reports: [
					{
						provider: "zai",
						limits: [
							{
								label: "ZAI 5 Hours Token Quota",
								amount: { unit: "tokens", usedFraction: 1, remainingFraction: 0 },
								window: {
									id: "5h",
									label: "5 Hours",
									resetsAt,
									resetLabel: "tick",
								},
								status: "exhausted",
							},
						],
					},
				],
			}),
		);
		// The reset time is the owner's zone (the formatter's), so the hour is matched, not pinned.
		expect(text).toMatch(
			/^OMP 사용량 · .+\n\nZAI\n• ZAI 5시간 Token Quota {2}0% 남음 · 한도 도달 · 오늘 \d{2}:\d{2} 충전$/,
		);
		expect(text).not.toContain("계정 1");
	});

	test("a passed timezone renders the reset in that zone, and names it in the header", () => {
		const resetsAt = Date.UTC(2026, 10, 21, 8, 30, 0);
		const text = formatLimits(
			response({
				generatedAt: Date.UTC(2026, 10, 21, 0, 0, 0),
				reports: [
					{
						provider: "zai",
						limits: [
							{
								label: "ZAI 5 Hours Token Quota",
								amount: { unit: "tokens", usedFraction: 1, remainingFraction: 0 },
								window: { id: "5h", label: "5 Hours", resetsAt, resetLabel: "tick" },
								status: "exhausted",
							},
						],
					},
				],
			}),
			"Asia/Seoul",
		);
		expect(text).toContain("OMP 사용량 · Asia/Seoul");
		// 08:30 UTC is 17:30 in Seoul, on the same Seoul day as the 00:00 UTC generation.
		expect(text).toContain("오늘 17:30 충전");
	});

	test("a reset past midnight in the passed zone is a date, not 오늘", () => {
		const resetsAt = Date.UTC(2026, 10, 20, 16, 30, 0);
		const text = formatLimits(
			response({
				generatedAt: Date.UTC(2026, 10, 20, 14, 0, 0),
				reports: [
					{
						provider: "zai",
						limits: [
							{
								label: "ZAI 5 Hours Token Quota",
								amount: { unit: "tokens", remainingFraction: 0.5 },
								window: { id: "5h", label: "5 Hours", resetsAt, resetLabel: "tick" },
							},
						],
					},
				],
			}),
			"Asia/Seoul",
		);
		// 14:00 UTC is 23:00 in Seoul on the 20th; the 01:30 reset is already the next Seoul day,
		// while both instants are still the 20th in UTC — the host zone would say 오늘.
		expect(text).toContain("11. 21. (토) 01:30 충전");
		expect(text).not.toContain("오늘");
	});

	test("a weekly window is 주간; a remaining count is shown; expires/tick pick 만료/충전", () => {
		const resetsAt = new Date(2026, 10, 21, 8, 30, 0).getTime();
		const text = formatLimits(
			response({
				reports: [
					{
						provider: "zai",
						limits: [
							{
								label: "ZAI Weekly Token Quota",
								amount: { unit: "tokens", remainingFraction: 0.6 },
								window: { id: "1w", label: "Weekly", resetsAt },
							},
							{
								label: "ZAI Zread Quota",
								amount: { unit: "requests", used: 0, limit: 1000, remaining: 1000 },
								window: { id: "1mo", label: "Monthly", resetsAt, resetLabel: "expires" },
							},
						],
					},
				],
			}),
		);
		expect(text).toContain("• ZAI 주간 Token Quota  60% 남음 · 오늘 ");
		expect(text).toContain("• Monthly (ZAI Zread Quota)  100% 남음 · 1,000 requests 남음 · 오늘 ");
		expect(text).toMatch(/• Monthly \(ZAI Zread Quota\).*만료/);
	});

	test("nothing readable says 남은 한도 미확인; percent is not repeated as a count", () => {
		const text = formatLimits(
			response({
				reports: [
					{
						provider: "anthropic",
						limits: [
							{ label: "Claude 5 Hours", amount: { unit: "unknown" } },
							{ label: "Claude Weekly", amount: { unit: "percent", remaining: 35 } },
						],
					},
				],
			}),
		);
		expect(text).toContain("• Claude 5 Hours  남은 한도 미확인");
		// No window on the record: the label stays as omp wrote it.
		expect(text).toContain("• Claude Weekly  35% 남음");
		expect(text).not.toContain("35 percent");
	});

	test("accounts split per provider, unreadable and disabled accounts get their own line", () => {
		const one = { label: "Claude Weekly", amount: { unit: "percent", remainingFraction: 0.5 } };
		const text = formatLimits(
			response({
				reports: [
					{ provider: "anthropic", limits: [one] },
					{ provider: "anthropic", limits: [one] },
					{ provider: "openai-codex", limits: [] },
				],
				accountsWithoutUsage: [{ provider: "google-antigravity" }],
				disabledCredentials: [{ provider: "zai" }],
			}),
		);
		expect(text).toContain("Claude · 계정 1\n• Claude Weekly  50% 남음");
		expect(text).toContain("Claude · 계정 2\n• Claude Weekly  50% 남음");
		expect(text).toContain("Codex\n• 남은 한도 미확인");
		expect(text).toContain("google-antigravity\n• 남은 한도 미확인");
		expect(text).toContain("ZAI\n• 계정 비활성화됨");
	});

	test("no account at all says so instead of printing an empty block", () => {
		expect(formatLimits(response())).toBe("OMP 사용량\n\n설정된 OMP 프로필에서 보고된 계정 한도가 없습니다.");
	});

	test("an out-of-range remaining fraction clamps to 0-100%, never 150% 남음", () => {
		const text = formatLimits(
			response({
				reports: [
					{
						provider: "zai",
						limits: [
							{ label: "Over", amount: { unit: "percent", remainingFraction: 1.5 } },
							{ label: "Under", amount: { unit: "percent", remainingFraction: -0.5 } },
						],
					},
				],
			}),
		);
		expect(text).toContain("• Over  100% 남음");
		expect(text).toContain("• Under  0% 남음");
		expect(text).not.toContain("150%");
	});
});

describe("parseUsageResponse", () => {
	test("a limit carrying only usedFraction is accepted (the dashboard parser needs more)", () => {
		const parsed = parseUsageResponse({
			reports: [{ provider: "zai", limits: [{ label: "L", amount: { unit: "tokens", usedFraction: 0.25 } }] }],
		});
		expect(parsed?.reports[0]?.limits[0]?.amount).toEqual({ unit: "tokens", usedFraction: 0.25 });
	});

	test("a shape this formatter cannot read is undefined, not an empty report list", () => {
		expect(parseUsageResponse({})).toBeUndefined();
		expect(parseUsageResponse({ reports: [{ provider: "zai", limits: [{ label: "L" }] }] })).toBeUndefined();
		expect(parseUsageResponse({ reports: [{ limits: [] }] })).toBeUndefined();
		expect(parseUsageResponse("nope")).toBeUndefined();
	});
});

describe("ompUsageArgs", () => {
	test("the overlay and profile are global flags before the subcommand", () => {
		expect(ompUsageArgs({ executable: "/b/omp" })).toEqual([
			"/b/omp",
			"usage",
			"--json",
			"--redact",
			"--no-extensions",
		]);
		expect(ompUsageArgs({ executable: "/b/omp", overlayConfig: "/h/overlay.yml", profile: "bot" })).toEqual([
			"/b/omp",
			"--config",
			"/h/overlay.yml",
			"--profile=bot",
			"usage",
			"--json",
			"--redact",
			"--no-extensions",
		]);
	});
});

describe("usageLimitsBlock (a fake omp executable)", () => {
	test("formats the limits omp prints; the token and cost totals are not this block's business", async () => {
		const payload = JSON.stringify({
			generatedAt: Date.UTC(2026, 10, 21, 3, 0, 0),
			reports: [
				{
					provider: "anthropic",
					limits: [{ label: "Claude Weekly", amount: { unit: "percent", remainingFraction: 0.42 } }],
				},
			],
		});
		const text = await limits(fakeOmp(`echo '${payload}'`));
		expect(text).toContain("• Claude Weekly  42% 남음");
		expect(text).not.toContain("확인 실패");
	});

	test("a passed timezone reaches the reset times (the !usage caller passes config.timezone)", async () => {
		const payload = JSON.stringify({
			generatedAt: Date.UTC(2026, 10, 21, 0, 0, 0),
			reports: [
				{
					provider: "zai",
					limits: [
						{
							label: "ZAI 5 Hours Token Quota",
							amount: { unit: "tokens", remainingFraction: 0.5 },
							window: { id: "5h", label: "5 Hours", resetsAt: Date.UTC(2026, 10, 21, 8, 30, 0), resetLabel: "tick" },
						},
					],
				},
			],
		});
		const text = await usageLimitsBlock({
			executable: fakeOmp(`echo '${payload}'`),
			env: {},
			timezone: "Asia/Seoul",
			run: realProcessRunner,
		});
		expect(text).toContain("OMP 사용량 · Asia/Seoul");
		expect(text).toContain("오늘 17:30 충전");
	});

	test("a failing, garbled or unsupported answer is one 확인 실패 line with the reason", async () => {
		expect(await limits(fakeOmp("exit 3"))).toBe("모델 한도: 확인 실패 (omp usage exited 3)");
		expect(await limits(fakeOmp("echo not-json"))).toBe("모델 한도: 확인 실패 (omp usage answered no JSON)");
		expect(await limits(fakeOmp(`echo '{"reports":[{"provider":"zai","limits":[{"label":"L"}]}]}'`))).toBe(
			"모델 한도: 확인 실패 (unsupported omp usage response)",
		);
	});

	test("the 30 s deadline is enforced with the real runner", async () => {
		const text = await usageLimitsBlock({
			executable: fakeOmp("exec sleep 30"),
			env: {},
			timeoutMs: 300,
			run: realProcessRunner,
		});
		expect(text).toBe("모델 한도: 확인 실패 (omp usage timed out after 0.3s)");
	});
});
