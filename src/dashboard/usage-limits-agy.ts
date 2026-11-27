import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchEnv, type ProcessRunner } from "../dispatch/omp";
import { redact } from "../redact";
import { protectedDirs } from "../safety/forbidden-paths";
import { isInside } from "../safety/inside";
import type { PeerInstall } from "./peers";
import { cleanError } from "./section-cache";
import type { Section } from "./snapshot";

const AGY_ACCOUNT_TIMEOUT_MS = 30_000;
const STDOUT_CAP = 1_000_000;
const ACCOUNT_CHARS = 40;
const ACCOUNT_NAME = /^[A-Za-z0-9_-]+$/;
const DEFAULT_APP_DATA_PREFIX = "antigravity-cli-acct-";

export interface UsageRow {
	label: string;
	window: "5h" | "weekly" | "other";
	windowLabel: string;
	remainingPct: number;
	/** Epoch ms of the window's reset, when the source tells. */
	resetsAt?: number;
}

/** One Antigravity account's quota snapshot under `~/.agy-accounts` (`active`: currently selected slot). */
export type UsageAccount = { name: string; active?: boolean; blockedUntil?: number } & (
	| { ok: true; rows: UsageRow[] }
	| { ok: false; error: string }
);

/** Runtime quota-switch overlay read from `<home>/config.json` -> `agyAccounts.statePath`. */
export interface AgyBlockedOverlay {
	current?: string;
	blocked: Record<string, number>;
}

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

function mtimeMsOf(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return -1;
	}
}

/** Prefers an isolated `--app-data-dir` token or active live token over `<name>.token` when its email matches and mtime is newer. */
function pickTokenSource(
	accountsDir: string,
	name: string,
	active: boolean,
	geminiDir: string,
	appDataPrefix: string,
): string {
	const slot = join(accountsDir, `${name}.token`);
	const slotEmail = tokenEmail(slot);
	let best = slot;
	let bestMtime = mtimeMsOf(slot);
	const isolated = join(geminiDir, `${appDataPrefix}${name}`, "antigravity-oauth-token");
	if (existsSync(isolated) && slotEmail !== undefined && tokenEmail(isolated) === slotEmail) {
		const mtime = mtimeMsOf(isolated);
		if (mtime > bestMtime) {
			best = isolated;
			bestMtime = mtime;
		}
	}
	if (active) {
		const live = join(geminiDir, "antigravity-cli", "antigravity-oauth-token");
		if (existsSync(live) && slotEmail !== undefined && tokenEmail(live) === slotEmail) {
			if (best === slot || mtimeMsOf(live) > bestMtime) best = live;
		}
	}
	return best;
}

async function queryAgyAccount(
	argv: string[],
	accountsDir: string,
	name: string,
	active: boolean,
	run: ProcessRunner,
	geminiDir: string,
	appDataPrefix: string,
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
			copyFileSync(pickTokenSource(accountsDir, name, active, geminiDir, appDataPrefix), dst);
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
	options?: { geminiDir?: string; appDataPrefix?: string },
): Promise<{ account?: string; accounts: UsageAccount[] } | undefined> {
	const names = readOrderAccounts(accountsDir);
	if (names === undefined) return undefined;
	const resolvedActive = activeName ?? readCurrentFile(accountsDir);
	const geminiDir = options?.geminiDir ?? join(homedir(), ".gemini");
	const appDataPrefix = options?.appDataPrefix ?? DEFAULT_APP_DATA_PREFIX;
	const accounts = await Promise.all(
		names.map((name) =>
			queryAgyAccount(argv, accountsDir, name, name === resolvedActive, run, geminiDir, appDataPrefix),
		),
	);
	return { ...(resolvedActive === undefined ? {} : { account: resolvedActive }), accounts };
}

const currentHome = (): string => process.env.HOME || homedir();

function expandOverlayPath(raw: string, userHome = currentHome()): string | undefined {
	if (raw.includes("secrets")) return undefined;
	const resolved = raw === "~" ? userHome : raw.startsWith("~/") ? join(userHome, raw.slice(2)) : raw;
	return resolved.startsWith("/") && !resolved.includes("secrets") ? resolved : undefined;
}

const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function safeOverlayFile(raw: string, homeDir: string, userHome = currentHome()): string | undefined {
	const statePath = expandOverlayPath(raw, userHome);
	if (statePath === undefined) return undefined;
	let realPath: string;
	try {
		const stat = lstatSync(statePath);
		if (stat.isSymbolicLink() || !stat.isFile()) return undefined;
		realPath = realpathSync(statePath);
	} catch {
		return undefined;
	}
	if (realPath.includes("secrets")) return undefined;
	if (protectedDirs(homeDir, userHome).some((dir) => isInside(realPath, dir))) return undefined;
	return realPath;
}

/** Reads `agyAccounts.statePath` (`{ current, blocked }`) across primary and peer homes; rejects symlinks & protected paths. */
export function readAgyBlockedOverlay(
	homeDir: string,
	peers: readonly Pick<PeerInstall, "home">[],
	now: number,
): AgyBlockedOverlay {
	const overlay: AgyBlockedOverlay = { blocked: {} };
	for (const dir of [homeDir, ...peers.map((p) => p.home)]) {
		let stateRaw: unknown;
		try {
			const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as unknown;
			if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) continue;
			stateRaw = (cfg as { agyAccounts?: { statePath?: unknown } }).agyAccounts?.statePath;
		} catch {
			continue;
		}
		if (typeof stateRaw !== "string" || stateRaw.trim() === "") continue;
		const statePath = safeOverlayFile(stateRaw.trim(), dir);
		if (statePath === undefined) continue;
		try {
			const state = JSON.parse(readFileSync(statePath, "utf8")) as unknown;
			if (typeof state !== "object" || state === null || Array.isArray(state)) continue;
			const { current, blocked } = state as { current?: unknown; blocked?: unknown };
			if (overlay.current === undefined && typeof current === "string" && current.trim() !== "") {
				overlay.current = redact(current.trim()).slice(0, ACCOUNT_CHARS);
			}
			if (typeof blocked === "object" && blocked !== null && !Array.isArray(blocked)) {
				for (const [acct, until] of Object.entries(blocked)) {
					if (UNSAFE_OBJECT_KEYS.has(acct)) continue;
					if (typeof until === "number" && Number.isFinite(until) && until > now) {
						const prev = Object.hasOwn(overlay.blocked, acct) ? (overlay.blocked[acct] ?? 0) : 0;
						overlay.blocked[acct] = Math.max(prev, until);
					}
				}
			}
		} catch {
			// ignore unreadable or malformed quota-state file
		}
	}
	return overlay;
}

/** Shallow-copies `section` to attach active `blockedUntil` timestamps and live `current` slot without mutating cache. */
export function applyAgyBlockedOverlay<
	T extends { sources: Array<{ name: string; account?: string; accounts?: UsageAccount[] }> },
>(section: Section<T>, overlay: AgyBlockedOverlay, now: number): Section<T> {
	if (!section.ok) return section;
	if (overlay.current === undefined && Object.keys(overlay.blocked).length === 0) return section;
	let changed = false;
	const sources = section.sources.map((source) => {
		if (source.name !== "Antigravity" || source.accounts === undefined) return source;
		const hasCurrent = overlay.current !== undefined && source.accounts.some((a) => a.name === overlay.current);
		const accounts = source.accounts.map((acct): UsageAccount => {
			const rawUntil = Object.hasOwn(overlay.blocked, acct.name) ? overlay.blocked[acct.name] : undefined;
			const until = rawUntil !== undefined && rawUntil > now ? rawUntil : undefined;
			const active = hasCurrent ? acct.name === overlay.current : acct.active;
			const { active: _oldActive, blockedUntil: _oldBlk, ...rest } = acct;
			return {
				...rest,
				...(active === true ? { active: true } : {}),
				...(until === undefined ? {} : { blockedUntil: until }),
			} as UsageAccount;
		});
		changed = true;
		return {
			...source,
			...(hasCurrent && overlay.current !== undefined ? { account: overlay.current } : {}),
			accounts,
		};
	});
	return changed ? { ...section, sources } : section;
}

/** Convenience wrapper combining {@link readAgyBlockedOverlay} and {@link applyAgyBlockedOverlay}. */
export function withAgyBlockedOverlay<
	T extends { sources: Array<{ name: string; account?: string; accounts?: UsageAccount[] }> },
>(
	section: Section<T>,
	homeDir: string,
	peers: readonly Pick<PeerInstall, "home">[] | undefined,
	now: number,
): Section<T> {
	return applyAgyBlockedOverlay(section, readAgyBlockedOverlay(homeDir, peers ?? [], now), now);
}
