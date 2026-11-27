import type { ProcessRunner } from "../dispatch/omp";
import { isRecord } from "../omp/type-guards";
import { redact } from "../redact";
import { cleanError, sectionCache } from "./section-cache";
import type { Section } from "./snapshot";
import { clampPct, collectAgyAccounts, parseAgy, type UsageAccount, type UsageRow } from "./usage-limits-agy";

export { parseAgy, type UsageAccount, type UsageRow };

/**
 * The "모델 한도" card: config `dashboard.usageLimits` runs `omp usage --json -r -p <provider>` (Claude, GLM)
 * and `agy -p /usage` (Antigravity). Each source fails alone without leaking account identifiers or secrets.
 */

/** A run is reused this long, failed runs too: the dashboard polls every 60 seconds even from a hidden tab. */
export const USAGE_LIMITS_TTL_MS = 15 * 60_000;
const COMMAND_TIMEOUT_MS = 20_000;
const STDOUT_CAP = 1_000_000;

/** `account`: the Antigravity account label from config `agyAccount` (the agy output names none). */
export type UsageSource = { name: string; account?: string; accounts?: UsageAccount[] } & (
	| { ok: true; rows: UsageRow[] }
	| { ok: false; error: string }
);

export interface UsageLimitsInfo {
	sources: UsageSource[];
}

export interface UsageLimitsConfig {
	omp?: string[][];
	agy?: string[];
	/** A command printing the logged-in agy account's label on its first line (e.g. `cat ~/.agy-accounts/current`). */
	agyAccount?: string[];
	/** Directory containing `order` and `<name>.token` files; queries all listed accounts in parallel. */
	agyAccountsDir?: string;
}

type Kind = "omp" | "agy";

const PROVIDER_NAMES: Record<string, string> = { anthropic: "Claude", zai: "GLM" };

const cache = sectionCache<UsageLimitsInfo>(USAGE_LIMITS_TTL_MS);
/** Test only: forget every cached run. */
export const clearUsageLimitsCache = (): void => cache.clear();
/** The card's section, one run per config within {@link USAGE_LIMITS_TTL_MS}. Never rejects. */
export function readUsageLimits(
	config: UsageLimitsConfig,
	run: ProcessRunner,
	now: () => number,
): Promise<Section<UsageLimitsInfo>> {
	return cache.read(JSON.stringify(config), now, async () => ({ ok: true, sources: await collect(config, run) }));
}

async function readAgySource(config: UsageLimitsConfig, run: ProcessRunner): Promise<UsageSource | undefined> {
	if (config.agy === undefined) return undefined;
	const activeLabel = config.agyAccount === undefined ? undefined : await readAccount(config.agyAccount, run);
	if (config.agyAccountsDir !== undefined) {
		const multi = await collectAgyAccounts(config.agy, config.agyAccountsDir, activeLabel, run);
		if (multi !== undefined) {
			const primary = multi.accounts.find((entry) => entry.active) ?? multi.accounts[0];
			const account = multi.account ?? primary?.name;
			const base = { name: "Antigravity", ...(account === undefined ? {} : { account }), accounts: multi.accounts };
			return primary === undefined || !primary.ok
				? { ...base, ok: false, error: primary?.error ?? "유효한 계정 없음" }
				: { ...base, ok: true, rows: primary.rows };
		}
	}
	const source = await readSource("agy", config.agy, run);
	return activeLabel === undefined ? source : { ...source, account: activeLabel };
}

async function collect(config: UsageLimitsConfig, run: ProcessRunner): Promise<UsageSource[]> {
	const ompJobs = (config.omp ?? []).map((argv) => readSource("omp", argv, run));
	const [ompSources, agySource] = await Promise.all([Promise.all(ompJobs), readAgySource(config, run)]);
	return agySource === undefined ? ompSources : [...ompSources, agySource];
}

const ACCOUNT_CHARS = 40;

/** The first non-empty stdout line, cut to {@link ACCOUNT_CHARS}; a failed or empty run reads `계정 확인 실패`. */
async function readAccount(argv: string[], run: ProcessRunner): Promise<string> {
	const unknown = "계정 확인 실패";
	try {
		const out = await run(argv, { timeoutMs: COMMAND_TIMEOUT_MS });
		if (out.timedOut || out.code !== 0) return unknown;
		const line = out.stdout
			.split("\n")
			.find((part) => part.trim() !== "")
			?.trim();
		return line === undefined ? unknown : redact(line).slice(0, ACCOUNT_CHARS);
	} catch {
		return unknown;
	}
}

/** The provider after `-p` in an omp argv; `omp` when there is none. */
function providerOf(argv: string[]): string {
	const i = argv.indexOf("-p");
	return (i >= 0 ? argv[i + 1] : undefined) ?? "omp";
}

const displayName = (provider: string): string => PROVIDER_NAMES[provider] ?? provider;

async function readSource(kind: Kind, argv: string[], run: ProcessRunner): Promise<UsageSource> {
	const name = kind === "agy" ? "Antigravity" : displayName(providerOf(argv));
	const failed = (error: string): UsageSource => ({ name, ok: false, error: cleanError(error) });
	let out: Awaited<ReturnType<ProcessRunner>>;
	try {
		out = await run(argv, { timeoutMs: COMMAND_TIMEOUT_MS, stdoutCap: STDOUT_CAP });
	} catch (error) {
		return failed(error instanceof Error ? error.message : String(error));
	}
	if (out.timedOut) return failed(`${COMMAND_TIMEOUT_MS / 1000}초 안에 끝나지 않음`);
	if (out.code !== 0) {
		const reason = (out.stderr ?? "").trim().split("\n").at(-1) ?? "";
		return failed(`종료 코드 ${out.code}${reason === "" ? "" : `: ${reason}`}`);
	}
	if (out.stdout.trim() === "") return failed("빈 출력");
	if (kind === "agy") {
		const rows = parseAgy(out.stdout);
		return typeof rows === "string" ? failed(`모양이 다름: ${rows}`) : { name, ok: true, rows };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(out.stdout);
	} catch {
		return failed("JSON이 아닌 출력");
	}
	const rows = parseOmp(parsed);
	if (typeof rows !== "string") return { name, ok: true, rows };
	return failed((rows === "reports" ? ompEmptyReason(parsed) : undefined) ?? `모양이 다름: ${rows}`);
}

function ompEmptyReason(value: unknown): string | undefined {
	if (!isRecord(value) || !Array.isArray(value.reports) || value.reports.length > 0) return undefined;
	if (Array.isArray(value.disabledCredentials) && value.disabledCredentials.length > 0) {
		const causes = value.disabledCredentials
			.map((item) => (isRecord(item) && typeof item.cause === "string" ? item.cause.trim() : ""))
			.filter(Boolean);
		if (causes.some((c) => /invalid_grant|refresh token expired|token refresh failed/i.test(c))) {
			return "인증 만료 (재로그인 필요)";
		}
		return causes[0] ? `인증 비활성: ${causes[0]}` : "인증 비활성 (재로그인 필요)";
	}
	return Array.isArray(value.accountsWithoutUsage) && value.accountsWithoutUsage.length > 0
		? "한도 정보 없음"
		: undefined;
}

/** Weekly `window.id`s: `7d` is Anthropic's, `1w` Zai's (2026-11-16 `omp usage --json`). */
const WEEKLY_IDS: Record<string, true> = { weekly: true, "7d": true, "1w": true };

/**
 * `omp usage --json` rows of every report (one provider per command), or the path of the first mismatching field.
 * `window.id` `5h` is the five-hour window, {@link WEEKLY_IDS} the weekly one, anything else `other`.
 */
export function parseOmp(value: unknown): UsageRow[] | string {
	if (!isRecord(value) || !Array.isArray(value.reports)) return "reports";
	const rows: UsageRow[] = [];
	for (const [r, report] of value.reports.entries()) {
		if (!isRecord(report) || !Array.isArray(report.limits)) return `reports.${r}.limits`;
		for (const [l, limit] of report.limits.entries()) {
			const at = `reports.${r}.limits.${l}`;
			if (!isRecord(limit) || typeof limit.label !== "string") return `${at}.label`;
			const window = limit.window;
			if (!isRecord(window) || typeof window.id !== "string") return `${at}.window.id`;
			const amount = limit.amount;
			if (!isRecord(amount) || typeof amount.usedFraction !== "number" || !Number.isFinite(amount.usedFraction)) {
				return `${at}.amount.usedFraction`;
			}
			if (window.resetsAt !== undefined && (typeof window.resetsAt !== "number" || !Number.isFinite(window.resetsAt))) {
				return `${at}.window.resetsAt`;
			}
			rows.push({
				label: limit.label,
				window: window.id === "5h" ? "5h" : WEEKLY_IDS[window.id] === true ? "weekly" : "other",
				windowLabel: typeof window.label === "string" ? window.label : window.id,
				remainingPct: clampPct(Math.round((1 - amount.usedFraction) * 100)),
				...(typeof window.resetsAt === "number" ? { resetsAt: window.resetsAt } : {}),
			});
		}
	}
	return rows.length === 0 ? "reports" : rows;
}
