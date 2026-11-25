import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgyAccountsConfig } from "../config-agy";
import type { Logger } from "../log";
import { redact } from "../redact";

export const DEFAULT_APP_DATA_PREFIX = "antigravity-cli-acct-";
const ACCOUNT_NAME = /^[A-Za-z0-9_-]+$/;

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
	readonly #statePath: string;
	readonly #geminiDir: string;
	readonly #now: () => number;
	readonly #log: Logger | undefined;
	#current: string | undefined;
	#blocked: Record<string, number> = {};
	#lastOrderError: string | undefined;

	constructor(options: AgyAccountPoolOptions) {
		this.#config = options.config;
		this.#statePath = options.statePath;
		this.#geminiDir = options.geminiDir ?? join(homedir(), ".gemini");
		this.#now = options.now ?? (() => Date.now());
		this.#log = options.log;
		this.#loadState();
	}

	/**
	 * Picks the active unblocked account (`undefined` when pool disabled/empty; `null` when every account is blocked).
	 * Primary tier beats fallback tier, so a reset primary account promotes automatically on the next check.
	 */
	selectAvailable(now = this.#now()): AgyAccountEntry | null | undefined {
		const entries = this.#entries();
		if (entries.length === 0) return undefined;
		const primary = entries.filter((entry) => entry.tier === "primary");
		const fallback = entries.filter((entry) => entry.tier === "fallback");
		const pick = (tier: readonly AgyAccountEntry[]): AgyAccountEntry | undefined => {
			if (tier.length === 0) return undefined;
			const index = this.#current === undefined ? -1 : tier.findIndex((entry) => entry.name === this.#current);
			if (index !== -1) {
				if (!this.isBlocked(tier[index]?.name ?? "", now)) return tier[index];
				for (let offset = 1; offset < tier.length; offset += 1) {
					const candidate = tier[(index + offset) % tier.length];
					if (candidate && !this.isBlocked(candidate.name, now)) return candidate;
				}
				return undefined;
			}
			return tier.find((entry) => !this.isBlocked(entry.name, now));
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
		let soonest: AgyBlockedAccount | undefined;
		for (const entry of this.#entries()) {
			const until = this.#blocked[entry.name];
			if (until === undefined || until <= now) continue;
			if (soonest === undefined || until < soonest.until) soonest = { name: entry.name, until };
		}
		return soonest;
	}

	markExhausted(name: string, untilMs: number, detail?: string): void {
		const now = this.#now();
		const nextUntil = Math.max(this.#blocked[name] ?? 0, untilMs);
		this.#blocked[name] = nextUntil;
		this.#saveState(now);
		this.#log?.warn("agy.account.exhausted", {
			account: name,
			until: new Date(nextUntil).toISOString(),
			...(detail === undefined ? {} : { detail: redact(detail).slice(0, 120) }),
		});
	}

	isBlocked(name: string, now = this.#now()): boolean {
		const until = this.#blocked[name];
		return until !== undefined && until > now;
	}

	size(): number {
		return this.#entries().length;
	}

	/**
	 * Ensures `~/.gemini/<appDataDir>` exists with mode 0700 and bootstraps its `antigravity-oauth-token` once from
	 * `<dir>/<name>.token` (never overwriting an already-bootstrapped file so `agy`'s OAuth refreshes stay intact).
	 */
	prepareAccountDir(entry: AgyAccountEntry): string {
		const cfg = this.#config();
		const target = join(this.#geminiDir, entry.appDataDir);
		mkdirSync(target, { recursive: true, mode: 0o700 });
		chmodSync(target, 0o700);
		const dstToken = join(target, "antigravity-oauth-token");
		if (!existsSync(dstToken) && cfg !== undefined) {
			const srcToken = join(cfg.dir, `${entry.name}.token`);
			if (existsSync(srcToken)) {
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

	#loadState(): void {
		let text: string;
		try {
			text = readFileSync(this.#statePath, "utf8");
		} catch (error) {
			const code = (error as NodeJS.ErrnoException | undefined)?.code;
			if (code !== "ENOENT") {
				this.#log?.warn("agy.account.state_load_failed", { error: String(error) });
			}
			return;
		}
		try {
			const parsed = JSON.parse(text) as unknown;
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
			const record = parsed as Record<string, unknown>;
			if (typeof record.current === "string" && ACCOUNT_NAME.test(record.current)) {
				this.#current = record.current;
			}
			if (typeof record.blocked === "object" && record.blocked !== null && !Array.isArray(record.blocked)) {
				for (const [name, until] of Object.entries(record.blocked as Record<string, unknown>)) {
					if (ACCOUNT_NAME.test(name) && typeof until === "number" && Number.isFinite(until) && until > 0) {
						this.#blocked[name] = until;
					}
				}
			}
		} catch (error) {
			this.#log?.warn("agy.account.state_load_failed", { error: String(error) });
		}
	}

	#saveState(now: number): void {
		const blocked: Record<string, number> = {};
		for (const [name, until] of Object.entries(this.#blocked)) {
			if (until > now) blocked[name] = until;
		}
		this.#blocked = blocked;
		const payload: QuotaStateFile = {
			...(this.#current === undefined ? {} : { current: this.#current }),
			blocked,
		};
		const tmp = `${this.#statePath}.${process.pid}.tmp`;
		try {
			mkdirSync(dirname(this.#statePath), { recursive: true });
			writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
			chmodSync(tmp, 0o600);
			renameSync(tmp, this.#statePath);
		} catch (error) {
			rmSync(tmp, { force: true });
			this.#log?.warn("agy.account.state_save_failed", { error: String(error) });
		}
	}
}
