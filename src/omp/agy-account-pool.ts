import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgyAccountsConfig } from "../config-agy";
import type { Logger } from "../log";
import { redact } from "../redact";
import { DEFAULT_QUOTA_BLOCK_MS, QUOTA_RESET_BUFFER_MS } from "./agy-quota";

export const DEFAULT_APP_DATA_PREFIX = "antigravity-cli-acct-";
const ACCOUNT_NAME = /^[A-Za-z0-9_-]+$/;
/** The last instant a Date holds; a block past it cannot be logged or shown. */
const MAX_DATE_MS = 8.64e15;

function tokenEmail(path: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		const email = (parsed as Record<string, unknown>).id_token_email;
		return typeof email === "string" && email !== "" ? email : undefined;
	} catch {
		return undefined;
	}
}

function shouldSyncToken(src: string, dst: string): boolean {
	if (!existsSync(src)) return false;
	if (!existsSync(dst)) return true;
	const srcEmail = tokenEmail(src);
	const dstEmail = tokenEmail(dst);
	if (srcEmail !== undefined && dstEmail !== undefined && srcEmail !== dstEmail) return true;
	try {
		return statSync(src).mtimeMs > statSync(dst).mtimeMs;
	} catch {
		return false;
	}
}

export interface AgyAccountEntry {
	name: string;
	model?: string;
	tier: "primary" | "fallback";
	appDataDir: string;
}

export interface AgyBlockedAccount {
	name: string;
	until: number;
}

export interface AgyAccountsStatus {
	current?: string;
	total: number;
	blocked: AgyBlockedAccount[];
	error?: string;
}

export interface AgyAccountPoolOptions {
	config: () => AgyAccountsConfig | undefined;
	statePath: string;
	/** Root `.gemini` directory holding per-account `--app-data-dir` subdirs (tests override). */
	geminiDir?: string;
	now?: () => number;
	log?: Logger;
}

interface QuotaStateFile {
	current?: string;
	blocked: Record<string, number>;
}

/**
 * Shared `agy` account pool for ACP children: reads `order`, keeps primary-tier rotation, demotes to fallback tier
 * when all primary accounts are blocked, promotes back upon primary reset, and isolates OAuth tokens per `--app-data-dir`.
 */
export class AgyAccountPool {
	readonly #config: () => AgyAccountsConfig | undefined;
	readonly #defaultStatePath: string;
	readonly #geminiDir: string;
	readonly #now: () => number;
	readonly #log: Logger | undefined;
	#loadedPath: string | undefined;
	#current: string | undefined;
	#blocked: Record<string, number> = {};
	#lastOrderError: string | undefined;

	constructor(options: AgyAccountPoolOptions) {
		this.#config = options.config;
		this.#defaultStatePath = options.statePath;
		this.#geminiDir = options.geminiDir ?? join(homedir(), ".gemini");
		this.#now = options.now ?? (() => Date.now());
		this.#log = options.log;
		// Defer `options.config()` until first method call: callers like `run.ts` pass a getter referencing a `const` initialized after `new AgyAccountPool(...)`.
		const disk = this.#readDiskState(options.statePath);
		if (disk !== undefined) {
			this.#blocked = disk.blocked;
			if (disk.current !== undefined) this.#current = disk.current;
		}
		this.#loadedPath = options.statePath;
	}

	/**
	 * Picks the active unblocked account (`undefined` when pool disabled/empty; `null` when every account is blocked).
	 * Primary tier beats fallback tier, so a reset primary account promotes automatically on the next check.
	 */
	selectAvailable(now = this.#now()): AgyAccountEntry | null | undefined {
		this.#syncStateFromDisk();
		const entries = this.#entries();
		if (entries.length === 0) return undefined;
		const primary = entries.filter((entry) => entry.tier === "primary");
		const fallback = entries.filter((entry) => entry.tier === "fallback");
		const pick = (tier: readonly AgyAccountEntry[]): AgyAccountEntry | undefined => {
			if (tier.length === 0) return undefined;
			const index = this.#current === undefined ? -1 : tier.findIndex((entry) => entry.name === this.#current);
			if (index !== -1) {
				if (!this.#isBlockedMem(tier[index]?.name ?? "", now)) return tier[index];
				for (let offset = 1; offset < tier.length; offset += 1) {
					const candidate = tier[(index + offset) % tier.length];
					if (candidate && !this.#isBlockedMem(candidate.name, now)) return candidate;
				}
				return undefined;
			}
			return tier.find((entry) => !this.#isBlockedMem(entry.name, now));
		};
		const chosen = pick(primary) ?? pick(fallback);
		if (chosen === undefined) return null;
		if (this.#current !== chosen.name) {
			this.#current = chosen.name;
			this.#saveState(now);
		}
		return chosen;
	}

	soonestReset(now = this.#now()): AgyBlockedAccount | undefined {
		this.#syncStateFromDisk();
		let soonest: AgyBlockedAccount | undefined;
		for (const entry of this.#entries()) {
			const until = this.#blocked[entry.name];
			if (until === undefined || until <= now) continue;
			if (soonest === undefined || until < soonest.until) soonest = { name: entry.name, until };
		}
		return soonest;
	}

	markExhausted(name: string, untilMs: number, detail?: string): void {
		this.#syncStateFromDisk();
		const now = this.#now();
		// A reset past the Date range (agy's text is outside input) is no reset to wait for: the default block applies.
		const valid = Number.isFinite(untilMs) && untilMs <= MAX_DATE_MS;
		const nextUntil = Math.max(
			this.#blocked[name] ?? 0,
			valid ? untilMs : now + DEFAULT_QUOTA_BLOCK_MS + QUOTA_RESET_BUFFER_MS,
		);
		this.#blocked[name] = nextUntil;
		this.#saveState(now);
		this.#log?.warn("agy.account.exhausted", {
			account: name,
			until: new Date(nextUntil).toISOString(),
			...(detail === undefined ? {} : { detail: redact(detail).slice(0, 120) }),
		});
	}

	isBlocked(name: string, now = this.#now()): boolean {
		this.#syncStateFromDisk();
		return this.#isBlockedMem(name, now);
	}

	clearBlocked(account?: string, now = this.#now()): string[] {
		this.#syncStateFromDisk();
		const cleared: string[] = [];
		if (account === undefined || account === "*") {
			for (const [name, until] of Object.entries(this.#blocked)) {
				if (until > now) cleared.push(name);
			}
			this.#blocked = {};
			if (cleared.length > 0) this.#saveState(now, "*");
			return cleared.sort();
		}
		if ((this.#blocked[account] ?? 0) > now) cleared.push(account);
		delete this.#blocked[account];
		if (cleared.length > 0) this.#saveState(now, new Set([account]));
		return cleared;
	}

	#isBlockedMem(name: string, now: number): boolean {
		const until = this.#blocked[name];
		return until !== undefined && until > now;
	}

	size(): number {
		return this.#entries().length;
	}

	/**
	 * Ensures `~/.gemini/<appDataDir>` exists with mode 0700 and copies `<dir>/<name>.token` when missing, email changed,
	 * or the source token is newer (preserving in-place OAuth refreshes when the target is at least as new).
	 */
	prepareAccountDir(entry: AgyAccountEntry): string {
		const cfg = this.#config();
		const target = join(this.#geminiDir, entry.appDataDir);
		mkdirSync(target, { recursive: true, mode: 0o700 });
		chmodSync(target, 0o700);
		const dstToken = join(target, "antigravity-oauth-token");
		if (cfg !== undefined) {
			const srcToken = join(cfg.dir, `${entry.name}.token`);
			if (shouldSyncToken(srcToken, dstToken)) {
				copyFileSync(srcToken, dstToken);
				chmodSync(dstToken, 0o600);
			}
		}
		const dstSettings = join(target, "settings.json");
		const srcSettings = join(this.#geminiDir, "antigravity-cli", "settings.json");
		if (!existsSync(dstSettings) && existsSync(srcSettings)) {
			copyFileSync(srcSettings, dstSettings);
			chmodSync(dstSettings, 0o600);
		}
		return entry.appDataDir;
	}

	status(now = this.#now()): AgyAccountsStatus | undefined {
		this.#syncStateFromDisk();
		const { configured, entries, error } = this.#readEntries();
		if (!configured) return undefined;
		if (error !== undefined) {
			return {
				...(this.#current === undefined ? {} : { current: this.#current }),
				total: 0,
				blocked: [],
				error,
			};
		}
		const blocked: AgyBlockedAccount[] = [];
		for (const entry of entries) {
			const until = this.#blocked[entry.name];
			if (until !== undefined && until > now) blocked.push({ name: entry.name, until });
		}
		return {
			...(this.#current === undefined ? {} : { current: this.#current }),
			total: entries.length,
			blocked,
		};
	}

	#entries(): AgyAccountEntry[] {
		return this.#readEntries().entries;
	}

	#readEntries(): { configured: boolean; entries: AgyAccountEntry[]; error?: string } {
		const cfg = this.#config();
		if (cfg === undefined) {
			this.#lastOrderError = undefined;
			return { configured: false, entries: [] };
		}
		const orderPath = join(cfg.dir, "order");
		let raw: string;
		try {
			raw = readFileSync(orderPath, "utf8");
		} catch (error) {
			const code = (error as NodeJS.ErrnoException | undefined)?.code;
			const detail = code ?? (error instanceof Error ? error.message : String(error));
			const key = `${orderPath}:${detail}`;
			if (this.#lastOrderError !== key) {
				this.#lastOrderError = key;
				this.#log?.warn("agy.account.order_read_failed", {
					path: orderPath,
					error: redact(String(error)).slice(0, 200),
				});
			}
			return { configured: true, entries: [], error: `order 읽기 실패 (${redact(detail).slice(0, 80)})` };
		}
		const prefix = cfg.appDataPrefix ?? DEFAULT_APP_DATA_PREFIX;
		const parsed: Array<{ name: string; model?: string; appDataDir: string }> = [];
		const seen = new Set<string>();
		for (const line of raw.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (trimmed === "" || trimmed.startsWith("#")) continue;
			const parts = trimmed.split(/\s+/);
			const name = parts[0] ?? "";
			if (!ACCOUNT_NAME.test(name) || seen.has(name)) continue;
			const appDataDir = `${prefix}${name}`;
			const hasSourceToken = existsSync(join(cfg.dir, `${name}.token`));
			const hasLiveToken = existsSync(join(this.#geminiDir, appDataDir, "antigravity-oauth-token"));
			if (!hasSourceToken && !hasLiveToken) continue;
			seen.add(name);
			const rawModel = parts[1];
			const model =
				rawModel === undefined || rawModel === ""
					? undefined
					: rawModel.startsWith("agy/")
						? rawModel.slice(4)
						: rawModel;
			parsed.push({ name, ...(model === undefined ? {} : { model }), appDataDir });
		}
		if (parsed.length === 0) {
			const key = `${orderPath}:empty`;
			if (this.#lastOrderError !== key) {
				this.#lastOrderError = key;
				this.#log?.warn("agy.account.order_empty", { path: orderPath });
			}
			return { configured: true, entries: [], error: "유효한 계정 없음 (order/토큰 확인)" };
		}
		this.#lastOrderError = undefined;
		const primaryModel = parsed[0]?.model ?? "";
		return {
			configured: true,
			entries: parsed.map((entry) => ({
				...entry,
				tier: (entry.model ?? "") === primaryModel ? "primary" : "fallback",
			})),
		};
	}

	#resolveStatePath(): string {
		return this.#config()?.statePath ?? this.#defaultStatePath;
	}

	#readDiskState(path: string): QuotaStateFile | undefined {
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
				this.#log?.warn("agy.account.state_load_failed", { error: String(error) });
			}
			return undefined;
		}
		try {
			const parsed = JSON.parse(text) as unknown;
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
			const record = parsed as Record<string, unknown>;
			const current =
				typeof record.current === "string" && ACCOUNT_NAME.test(record.current) ? record.current : undefined;
			const blocked: Record<string, number> = {};
			if (typeof record.blocked === "object" && record.blocked !== null && !Array.isArray(record.blocked)) {
				for (const [name, until] of Object.entries(record.blocked as Record<string, unknown>)) {
					if (ACCOUNT_NAME.test(name) && typeof until === "number" && until > 0 && until <= MAX_DATE_MS) {
						blocked[name] = until;
					}
				}
			}
			return { ...(current === undefined ? {} : { current }), blocked };
		} catch (error) {
			this.#log?.warn("agy.account.state_load_failed", { error: String(error) });
			return undefined;
		}
	}

	#syncStateFromDisk(): void {
		const path = this.#resolveStatePath();
		const disk = this.#readDiskState(path);
		if (this.#loadedPath !== undefined && this.#loadedPath !== path) {
			this.#blocked = {};
			this.#current = undefined;
		}
		if (disk !== undefined) {
			this.#blocked = disk.blocked;
			if (disk.current !== undefined) this.#current = disk.current;
		}
		this.#loadedPath = path;
	}

	#saveState(now: number, drop?: "*" | ReadonlySet<string>): void {
		const path = this.#resolveStatePath();
		const disk = drop === "*" ? undefined : this.#readDiskState(path);
		const blocked: Record<string, number> = {};
		if (drop !== "*" && disk !== undefined) {
			for (const [name, until] of Object.entries(disk.blocked)) {
				if (until > now && !drop?.has(name)) blocked[name] = until;
			}
		}
		for (const [name, until] of Object.entries(this.#blocked)) {
			if (until > now) blocked[name] = Math.max(blocked[name] ?? 0, until);
		}
		this.#blocked = blocked;
		this.#loadedPath = path;
		const payload: QuotaStateFile = {
			...(this.#current === undefined ? {} : { current: this.#current }),
			blocked,
		};
		const tmp = `${path}.${process.pid}.tmp`;
		try {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
			chmodSync(tmp, 0o600);
			renameSync(tmp, path);
		} catch (error) {
			rmSync(tmp, { force: true });
			this.#log?.warn("agy.account.state_save_failed", { error: String(error) });
		}
	}
}
