import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchEnv, type ProcessRunner } from "../dispatch/omp";
import { redact } from "../redact";
import { cleanError } from "./section-cache";

const AGY_ACCOUNT_TIMEOUT_MS = 30_000;
const STDOUT_CAP = 1_000_000;
const ACCOUNT_CHARS = 40;
const ACCOUNT_NAME = /^[A-Za-z0-9_-]+$/;

export interface UsageRow {
	label: string;
	window: "5h" | "weekly" | "other";
	windowLabel: string;
	remainingPct: number;
	/** Epoch ms of the window's reset, when the source tells. */
	resetsAt?: number;
}

/** One Antigravity account's quota snapshot under `~/.agy-accounts` (`active`: currently selected slot). */
export type UsageAccount = { name: string; active?: boolean } & (
	| { ok: true; rows: UsageRow[] }
	| { ok: false; error: string }
);

export function clampPct(pct: number): number {
	return Math.min(100, Math.max(0, pct));
}

/**
 * `agy -p /usage` lines `group\tlimit name\tremaining %\tISO time`. Assumes non-TTY pipe output (a terminal run draws a
 * different layout). Blank lines are skipped; any other line that is not four fields with a numeric percent makes the
 * whole source a mismatch, so a changed output is never drawn wrongly.
 */
export function parseAgy(stdout: string): UsageRow[] | string {
	const rows: UsageRow[] = [];
	for (const [i, line] of stdout.split("\n").entries()) {
		if (line.trim() === "") continue;
		const cols = line.replace(/\r$/, "").split("\t");
		const [group, limit, pct, time] = cols;
		if (cols.length !== 4 || group === undefined || limit === undefined || pct === undefined || time === undefined) {
			return `${i + 1}번째 줄 칸 수`;
		}
		const match = /^(\d{1,3}(?:\.\d+)?)%$/.exec(pct.trim());
		if (match?.[1] === undefined) return `${i + 1}번째 줄 남은 %`;
		const resetsAt = Date.parse(time.trim());
		rows.push({
			label: group,
			window: /five hour/i.test(limit) ? "5h" : /weekly/i.test(limit) ? "weekly" : "other",
			windowLabel: limit,
			remainingPct: clampPct(Math.round(Number(match[1]))),
			...(Number.isNaN(resetsAt) ? {} : { resetsAt }),
		});
	}
	return rows.length === 0 ? "빈 출력" : rows;
}

function readOrderAccounts(accountsDir: string): string[] | undefined {
	let raw: string;
	try {
		raw = readFileSync(join(accountsDir, "order"), "utf8");
	} catch {
		return undefined;
	}
	const names: string[] = [];
	const seen = new Set<string>();
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		const name = trimmed.split(/\s+/)[0] ?? "";
		if (!ACCOUNT_NAME.test(name) || seen.has(name)) continue;
		if (!existsSync(join(accountsDir, `${name}.token`))) continue;
		seen.add(name);
		names.push(name);
	}
	return names.length === 0 ? undefined : names;
}

function readCurrentFile(accountsDir: string): string | undefined {
	try {
		const line = readFileSync(join(accountsDir, "current"), "utf8")
			.split(/\r?\n/)
			.find((part) => part.trim() !== "")
			?.trim();
		return line === undefined ? undefined : redact(line).slice(0, ACCOUNT_CHARS);
	} catch {
		return undefined;
	}
}

function tokenEmail(path: string): string | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		const email = (parsed as Record<string, unknown>).id_token_email;
		return typeof email === "string" && email !== "" ? email : undefined;
	} catch {
		return undefined;
	}
}

/** Uses live `~/.gemini/antigravity-cli/antigravity-oauth-token` for the active slot only when its email matches. */
function pickTokenSource(accountsDir: string, name: string, active: boolean): string {
	const slot = join(accountsDir, `${name}.token`);
	if (!active) return slot;
	const live = join(homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token");
	if (!existsSync(live)) return slot;
	const liveEmail = tokenEmail(live);
	return liveEmail !== undefined && liveEmail === tokenEmail(slot) ? live : slot;
}

async function queryAgyAccount(
	argv: string[],
	accountsDir: string,
	name: string,
	active: boolean,
	run: ProcessRunner,
): Promise<UsageAccount> {
	const fail = (error: string): UsageAccount => ({
		name,
		...(active ? { active: true } : {}),
		ok: false,
		error: cleanError(error),
	});
	const tmp = mkdtempSync(join(tmpdir(), "jabbu-agy-usage-"));
	try {
		let out: Awaited<ReturnType<ProcessRunner>>;
		try {
			chmodSync(tmp, 0o700);
			const cliDir = join(tmp, ".gemini", "antigravity-cli");
			mkdirSync(cliDir, { recursive: true, mode: 0o700 });
			chmodSync(cliDir, 0o700);
			const dst = join(cliDir, "antigravity-oauth-token");
			copyFileSync(pickTokenSource(accountsDir, name, active), dst);
			chmodSync(dst, 0o600);
			out = await run(argv, {
				timeoutMs: AGY_ACCOUNT_TIMEOUT_MS,
				stdoutCap: STDOUT_CAP,
				env: { ...dispatchEnv(process.env), HOME: tmp },
			});
		} catch (error) {
			return fail(error instanceof Error ? error.message : String(error));
		}
		if (out.timedOut) return fail(`${AGY_ACCOUNT_TIMEOUT_MS / 1000}초 안에 끝나지 않음`);
		if (out.code !== 0) {
			const reason = (out.stderr ?? "").trim().split("\n").at(-1) ?? "";
			return fail(`종료 코드 ${out.code}${reason === "" ? "" : `: ${reason}`}`);
		}
		if (out.stdout.trim() === "") return fail("빈 출력");
		const rows = parseAgy(out.stdout);
		return typeof rows === "string"
			? fail(`모양이 다름: ${rows}`)
			: { name, ...(active ? { active: true } : {}), ok: true, rows };
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

/** Queries every valid `<name>.token` listed in `<accountsDir>/order` in parallel using isolated temp `HOME` dirs. */
export async function collectAgyAccounts(
	argv: string[],
	accountsDir: string,
	activeName: string | undefined,
	run: ProcessRunner,
): Promise<{ account?: string; accounts: UsageAccount[] } | undefined> {
	const names = readOrderAccounts(accountsDir);
	if (names === undefined) return undefined;
	const resolvedActive = activeName ?? readCurrentFile(accountsDir);
	const accounts = await Promise.all(
		names.map((name) => queryAgyAccount(argv, accountsDir, name, name === resolvedActive, run)),
	);
	return { ...(resolvedActive === undefined ? {} : { account: resolvedActive }), accounts };
}
