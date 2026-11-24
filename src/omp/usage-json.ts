// Ported from dbc-hbin/omp-superagent src/omp-usage.ts (MIT).
//
// `!usage`'s account-limit block: one `omp usage --json --redact --no-extensions` call covers every configured provider,
// and its JSON is formatted into the Korean lines the chat shows. The token/cost totals stay where they are
// (src/ops/usage.ts, read from jabbu's own session files): an unsupported or failing usage response must not take them
// down, so `renderLimits` returns its own "확인 실패" line instead of throwing.
import type { ProcessRunner, RunProcessOptions } from "../dispatch/omp";
import { redact } from "../redact";

/** The ceiling of one metered window, as much of it as the formatter reads. */
export interface UsageLimit {
	label: string;
	amount: {
		unit: string;
		used?: number;
		limit?: number;
		remaining?: number;
		usedFraction?: number;
		remainingFraction?: number;
	};
	window?: {
		id: string;
		label: string;
		resetsAt?: number;
		resetLabel?: string;
	};
	status?: string;
}

/** One provider's report: every account of it contributes one entry of `limits`. */
export interface UsageReport {
	provider: string;
	limits: UsageLimit[];
}

/** The `omp usage --json` answer, cut down to what the formatter reads. */
export interface UsageResponse {
	generatedAt?: number;
	reports: UsageReport[];
	accountsWithoutUsage?: Array<{ provider: string }>;
	disabledCredentials?: Array<{ provider: string }>;
}

/** A whole run is 30 s at most (an omp child that hangs must not hold the `!usage` answer). */
export const OMP_USAGE_TIMEOUT_MS = 30_000;
/** `omp usage --json` of every provider is ~30 KB; the cap leaves room for more accounts. */
export const OMP_USAGE_STDOUT_CAP = 4 * 1024 * 1024;

const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const resetDay = new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric", weekday: "short" });
const resetTime = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** Display names the chat uses: the provider ids are the wire's, not the owner's words. */
const PROVIDER_NAMES: Record<string, string> = {
	"openai-codex": "Codex",
	anthropic: "Claude",
	zai: "ZAI",
};

const num = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

function limitAmount(value: unknown): UsageLimit["amount"] | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	const unit = str(record.unit);
	if (unit === undefined) return undefined;
	const amount: UsageLimit["amount"] = { unit };
	const used = num(record.used);
	const limit = num(record.limit);
	const remaining = num(record.remaining);
	const usedFraction = num(record.usedFraction);
	const remainingFraction = num(record.remainingFraction);
	if (used !== undefined) amount.used = used;
	if (limit !== undefined) amount.limit = limit;
	if (remaining !== undefined) amount.remaining = remaining;
	if (usedFraction !== undefined) amount.usedFraction = usedFraction;
	if (remainingFraction !== undefined) amount.remainingFraction = remainingFraction;
	return amount;
}

function limitWindow(value: unknown): UsageLimit["window"] | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	const id = str(record.id);
	const label = str(record.label);
	if (id === undefined || label === undefined) return undefined;
	const window: NonNullable<UsageLimit["window"]> = { id, label };
	const resetsAt = num(record.resetsAt);
	const resetLabel = str(record.resetLabel);
	if (resetsAt !== undefined) window.resetsAt = resetsAt;
	if (resetLabel !== undefined) window.resetLabel = resetLabel;
	return window;
}

function limitOf(value: unknown): UsageLimit | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	const label = str(record.label);
	const amount = limitAmount(record.amount);
	if (label === undefined || amount === undefined) return undefined;
	const limit: UsageLimit = { label, amount };
	const window = limitWindow(record.window);
	const status = str(record.status);
	if (window !== undefined) limit.window = window;
	if (status !== undefined) limit.status = status;
	return limit;
}

function reportOf(value: unknown): UsageReport | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	const provider = str(record.provider);
	if (provider === undefined || !Array.isArray(record.limits)) return undefined;
	const limits: UsageLimit[] = [];
	for (const entry of record.limits) {
		const limit = limitOf(entry);
		if (limit === undefined) return undefined;
		limits.push(limit);
	}
	return { provider, limits };
}

function providersOf(value: unknown): Array<{ provider: string }> | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) return undefined;
	const providers: Array<{ provider: string }> = [];
	for (const entry of value) {
		if (typeof entry !== "object" || entry === null) return undefined;
		const provider = str((entry as Record<string, unknown>).provider);
		if (provider === undefined) return undefined;
		providers.push({ provider });
	}
	return providers;
}

/**
 * The response as the formatter reads it, or undefined when it is not this shape at all (`omp usage` answers from
 * another version, or something that is not omp at all). A missing `reports` is a shape failure, never "no limits".
 */
export function parseUsageResponse(value: unknown): UsageResponse | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (!Array.isArray(record.reports)) return undefined;
	const reports: UsageReport[] = [];
	for (const entry of record.reports) {
		const report = reportOf(entry);
		if (report === undefined) return undefined;
		reports.push(report);
	}
	const response: UsageResponse = { reports };
	const generatedAt = num(record.generatedAt);
	if (generatedAt !== undefined) response.generatedAt = generatedAt;
	const withoutUsage = providersOf(record.accountsWithoutUsage);
	const disabled = providersOf(record.disabledCredentials);
	if (withoutUsage !== undefined) response.accountsWithoutUsage = withoutUsage;
	if (disabled !== undefined) response.disabledCredentials = disabled;
	return response;
}

/** `• <name>  <n% 남음 · n <unit> 남음 · 한도 도달 · 오늘 17:00 초기화>`. */
export function limitLine(limit: UsageLimit, today: string): string {
	const { amount, label, window } = limit;
	const windowLabel = window?.label;
	const shortWindow = window?.id === "5h" ? "5시간" : window?.id === "7d" || window?.id === "1w" ? "주간" : windowLabel;
	let name = label;
	if (windowLabel !== undefined && shortWindow !== undefined && windowLabel.toLowerCase() !== "quota window") {
		const labelWithoutProvider = label.replace(/^Claude /, "");
		const index = labelWithoutProvider.toLowerCase().indexOf(windowLabel.toLowerCase());
		name =
			index >= 0
				? `${labelWithoutProvider.slice(0, index)}${shortWindow}${labelWithoutProvider.slice(index + windowLabel.length)}`
				: `${shortWindow} (${labelWithoutProvider})`;
	}
	const remaining =
		amount.remaining ??
		(amount.limit !== undefined && amount.used !== undefined ? Math.max(0, amount.limit - amount.used) : undefined);
	let fraction = amount.remainingFraction;
	if (fraction === undefined) {
		if (amount.usedFraction !== undefined) fraction = 1 - amount.usedFraction;
		else if (amount.limit !== undefined && amount.limit > 0 && remaining !== undefined)
			fraction = remaining / amount.limit;
		else if (amount.unit === "percent") {
			if (remaining !== undefined) fraction = remaining / 100;
			else if (amount.used !== undefined) fraction = 1 - amount.used / 100;
		}
	}
	const parts: string[] = [];
	if (fraction !== undefined && Number.isFinite(fraction))
		parts.push(`${number.format(Math.max(0, fraction) * 100)}% 남음`);
	if (remaining !== undefined && amount.unit !== "percent" && amount.unit !== "unknown") {
		parts.push(`${number.format(remaining)} ${amount.unit} 남음`);
	}
	if (limit.status === "exhausted") parts.push("한도 도달");
	if (parts.length === 0) parts.push("남은 한도 미확인");
	const reset = window?.resetsAt === undefined ? undefined : new Date(window.resetsAt);
	if (reset !== undefined && Number.isFinite(reset.getTime())) {
		const day = reset.toDateString() === today ? "오늘" : resetDay.format(reset);
		const action =
			window?.resetLabel === "expires"
				? "만료"
				: window?.resetLabel === "tick" || window?.resetLabel === "regen"
					? "충전"
					: "초기화";
		parts.push(`${day} ${resetTime.format(reset)} ${action}`);
	}
	return `• ${name}  ${parts.join(" · ")}`;
}

/**
 * The whole limit block: one section per provider account (`Claude · 계정 2`), then the accounts omp could not read
 * ("남은 한도 미확인") and the disabled ones ("계정 비활성화됨"). Empty `accounts` means no provider reported a limit.
 */
export function formatLimits(response: UsageResponse): string {
	const today = new Date(response.generatedAt ?? Date.now()).toDateString();
	const accounts = new Map<string, string[][]>();
	const addAccount = (provider: string, lines: string[]): void => {
		const entries = accounts.get(provider) ?? [];
		entries.push(lines);
		accounts.set(provider, entries);
	};
	for (const report of response.reports) {
		addAccount(
			report.provider,
			report.limits.length > 0 ? report.limits.map((limit) => limitLine(limit, today)) : ["• 남은 한도 미확인"],
		);
	}
	for (const { provider } of response.accountsWithoutUsage ?? []) addAccount(provider, ["• 남은 한도 미확인"]);
	for (const { provider } of response.disabledCredentials ?? []) addAccount(provider, ["• 계정 비활성화됨"]);
	if (accounts.size === 0) return "OMP 사용량\n\n설정된 OMP 프로필에서 보고된 계정 한도가 없습니다.";
	const sections = [...accounts].flatMap(([provider, entries]) => {
		const name = PROVIDER_NAMES[provider] ?? provider;
		return entries.map((limits, index) =>
			[`${name}${entries.length > 1 ? ` · 계정 ${index + 1}` : ""}`, ...limits].join("\n"),
		);
	});
	return `OMP 사용량 · ${resetTime.resolvedOptions().timeZone}\n\n${sections.join("\n\n")}`;
}

export interface OmpUsageOptions {
	/** The bot's omp executable (`config.ompExecutable`). */
	executable: string;
	/** `--profile=<name>` of config `ompProfile` (absent: the inherited agent dir). */
	profile?: string;
	/** `--config <overlay>` of config `ompConfigOverlay` (absent: omp's own config). */
	overlayConfig?: string;
	/** The child's whole environment (already stripped by the caller: this is not `dispatchEnv`). */
	env: Record<string, string>;
	/** The omp child's cwd; `--no-env-file` does not exist for omp, so the dir only matters for relative paths. */
	cwd?: string;
	timeoutMs?: number;
	run: ProcessRunner;
}

/**
 * The argv of `omp usage`: `--redact` keeps account emails to their shortest unique prefix, `--no-extensions` keeps an
 * extension's load time out of the 30 s. The overlay is a global flag, so it comes before the subcommand.
 */
export function ompUsageArgs(options: Pick<OmpUsageOptions, "executable" | "profile" | "overlayConfig">): string[] {
	return [
		options.executable,
		...(options.overlayConfig === undefined ? [] : ["--config", options.overlayConfig]),
		...(options.profile === undefined ? [] : [`--profile=${options.profile}`]),
		"usage",
		"--json",
		"--redact",
		"--no-extensions",
	];
}

/**
 * Runs `omp usage` and formats its limits. Rejections carry the reason only ("아직 확인하지 못했습니다" is decided by the
 * caller); nothing here reaches the chat unredacted — `formatLimits` output goes through `redact` at the boundary.
 */
export async function readOmpUsage(options: OmpUsageOptions): Promise<UsageResponse> {
	const runOptions: RunProcessOptions = {
		env: options.env,
		timeoutMs: options.timeoutMs ?? OMP_USAGE_TIMEOUT_MS,
		stdoutCap: OMP_USAGE_STDOUT_CAP,
		...(options.cwd === undefined ? {} : { cwd: options.cwd }),
	};
	const result = await options.run(ompUsageArgs(options), runOptions);
	if (result.timedOut)
		throw new Error(`omp usage timed out after ${(options.timeoutMs ?? OMP_USAGE_TIMEOUT_MS) / 1000}s`);
	if (result.code !== 0) throw new Error(`omp usage exited ${result.code ?? "without a code"}`);
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		throw new Error("omp usage answered no JSON");
	}
	const response = parseUsageResponse(parsed);
	if (response === undefined) throw new Error("unsupported omp usage response");
	return response;
}

/** The line `!usage` adds under its token/cost totals: the limits, or one "확인 실패" line with the reason (redacted). */
export async function usageLimitsBlock(options: OmpUsageOptions): Promise<string> {
	try {
		return redact(formatLimits(await readOmpUsage(options)));
	} catch (error) {
		return `모델 한도: 확인 실패 (${redact(error instanceof Error ? error.message : String(error))})`;
	}
}
