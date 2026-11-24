// Idle keep-resident (doc/plans/idle-keep-resident.md): a conversation child that rested past the idle time stays up
// unless its context use is high, the omp executable changed since it started, or the host is under session/memory
// pressure. The mailbox judges the first two for itself (`IdleKeeper`); the router judges pressure across mailboxes
// (`sweepIdleMailboxes`). Monitors, lanes and `idleKeepResident: false` keep the plain idle stop (`reason=legacy`).

import { statSync } from "node:fs";
import type { OmpbotConfig } from "../config";
import type { Logger } from "../log";
import type { OmpState } from "../omp/driver";
import { type HostLoadReader, resolvedCeiling } from "../ops/host-resources";
import { startCapacity } from "../ops/start-capacity";
import { parseChatOrigin } from "./origin-key";

/** A resting conversation child is stopped at or above this context use (percent). */
export const IDLE_CONTEXT_STOP_PERCENT = 50;

/** Why an idle child was stopped (log `idle_stop` `reason`). */
export type IdleStopReason = "context" | "omp_changed" | "host_pressure" | "legacy";

/** The file an omp path points at (`dev`, `ino`, `size`, `mtimeMs`): a newer omp installed under the same path differs. */
export interface OmpFileIdentity {
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
}

/** One idle sweep's judgment context, read once per sweep; `ompIdentity` is `undefined` when the file cannot be read. */
export interface IdleSweepContext {
	ompIdentity?: OmpFileIdentity | undefined;
}

/** The two host pressures that release resting conversation children; `undefined` = could not be read. */
export interface IdleHostPressure {
	sessionFull: boolean | undefined;
	memoryLow: boolean | undefined;
}

/** What the daemon wires for idle keep-resident; absent (or `keepResident` false) = the plain idle stop. */
export interface IdleKeepOptions {
	keepResident: boolean;
	/** The omp executable's current identity (read when a child starts and once per sweep); absent = no omp-changed check. */
	ompIdentity?: () => OmpFileIdentity | undefined;
	/** Read fresh when resting children are weighed against the host (router only). */
	hostPressure?: () => IdleHostPressure;
}

/** The identity of the file `path` points at; `undefined` when it cannot be stat'ed. */
export function ompFileIdentity(path: string): OmpFileIdentity | undefined {
	try {
		const { dev, ino, size, mtimeMs } = statSync(path);
		return { dev, ino, size, mtimeMs };
	} catch {
		return undefined;
	}
}

/** The daemon's wiring: agy has no executable whose replacement matters; pressure is `startCapacity`'s two floors. */
export function idleKeepOptions(
	config: Pick<OmpbotConfig, "idleKeepResident" | "agent" | "ompExecutable">,
	ceiling: number | undefined,
	hostLoad: Partial<HostLoadReader> | undefined,
): IdleKeepOptions {
	return {
		keepResident: config.idleKeepResident ?? true,
		...(config.agent === "agy" ? {} : { ompIdentity: () => ompFileIdentity(config.ompExecutable) }),
		hostPressure: () => {
			const { sessionFull, memoryLow } = startCapacity(hostLoad, [], { ceiling: resolvedCeiling(ceiling) });
			return { sessionFull, memoryLow };
		},
	};
}

/** What the keeper reads from and does to its mailbox (all called inside the mailbox's serial chain). */
export interface IdleHost {
	/** The child is up, no turn runs, and the origin has been quiet for the idle time (0 disables). */
	due(): boolean;
	/** When the origin's last activity was: the start of the current idle stretch. */
	since(): number;
	state(): Promise<OmpState> | undefined;
	stop(): Promise<void>;
}

/** Per-mailbox idle judgment: the executable at spawn, the context read of this idle stretch, the kept log. */
export class IdleKeeper {
	readonly #originKey: string;
	readonly #keep: IdleKeepOptions | undefined;
	readonly #log: Logger;
	readonly #now: () => number;
	readonly #host: IdleHost;
	#spawned: OmpFileIdentity | undefined;
	#read: { since: number; percent: number | null } | undefined;
	#keptSince: number | undefined;

	constructor(deps: { originKey: string; log: Logger; clock: { now(): number } } & IdleKeepDeps, host: IdleHost) {
		this.#originKey = deps.originKey;
		this.#keep = deps.idleKeep;
		this.#log = deps.log;
		this.#now = () => deps.clock.now();
		this.#host = host;
	}

	/** The executable's identity now; read right before a child starts and handed to `spawned` once it is up. */
	identity(): OmpFileIdentity | undefined {
		return this.#keep?.ompIdentity?.();
	}

	spawned(identity: OmpFileIdentity | undefined): void {
		this.#spawned = identity;
	}

	/** Stops a due child that has a reason to go (see `judge`); returns whether it stopped. */
	sweep(ctx: IdleSweepContext): Promise<boolean> {
		return this.#stop(this.#host.due() ? this.#judge(ctx) : undefined);
	}

	/** `since` of a due conversation child that may be released under host pressure; `undefined` otherwise (a read). */
	candidate(): number | undefined {
		const resident = this.#keep?.keepResident === true && parseChatOrigin(this.#originKey) !== undefined;
		return resident && this.#host.due() ? this.#host.since() : undefined;
	}

	/** Stops a child that is still a candidate (a turn or message may have got there first). */
	pressureStop(): Promise<boolean> {
		return this.#stop(this.candidate() === undefined ? undefined : "host_pressure");
	}

	/** Logs `idle_stop` with its reason and stops the child; no reason = keep it. Returns whether it stopped. */
	async #stop(reason: Promise<IdleStopReason | undefined> | IdleStopReason | undefined): Promise<boolean> {
		const why = await reason;
		if (why === undefined) return false;
		this.#log.info("idle_stop", { origin: this.#originKey, reason: why });
		await this.#host.stop();
		return true;
	}

	/**
	 * Why a due child must stop now, or `undefined` to keep it. A failed or timed-out `state()` counts as unknown
	 * context use and warns once per idle stretch; the first read of a stretch is reused while the origin rests
	 * (nothing changes, so the 15-second sweep does not ask again).
	 */
	async #judge(ctx: IdleSweepContext): Promise<IdleStopReason | undefined> {
		const since = this.#host.since();
		if (this.candidate() === undefined) return "legacy";
		if (this.#spawned !== undefined && ctx.ompIdentity !== undefined && !sameFile(this.#spawned, ctx.ompIdentity))
			return "omp_changed";
		if (this.#read?.since !== since) {
			let percent: number | null = null;
			try {
				percent = (await this.#host.state())?.context?.percent ?? null;
			} catch (error) {
				this.#log.warn("idle_state_failed", { origin: this.#originKey, error: String(error) });
			}
			this.#read = { since, percent };
		}
		const percent = this.#read.percent;
		if (percent !== null && percent >= IDLE_CONTEXT_STOP_PERCENT) return "context";
		if (this.#keptSince !== since) {
			this.#keptSince = since;
			this.#log.info("idle_kept", { origin: this.#originKey, idleMs: this.#now() - since, percent });
		}
		return undefined;
	}
}

const sameFile = (a: OmpFileIdentity, b: OmpFileIdentity): boolean =>
	a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

/** The mailbox deps the daemon's idle wiring adds (`OriginRouterDeps` passes it through to every mailbox). */
export interface IdleKeepDeps {
	idleKeep?: IdleKeepOptions;
}

/** The mailbox side of a router sweep (structural, so this module needs no mailbox import). */
export interface IdleSweepable {
	sweepIdle(ctx: IdleSweepContext): Promise<boolean>;
	idleCandidate(): number | undefined;
	stopForPressure(): Promise<boolean>;
}

/**
 * One router idle sweep over `[originKey, mailbox]` pairs; returns how many stopped. Every mailbox first judges itself
 * (legacy time, high context, a changed omp executable), each caught alone so one failing `state()` never stops the
 * others. Then host pressure releases resting conversation children, longest rested first: while the host session
 * count is at the ceiling, one at a time until it falls below; else, only when nothing was stopped in this sweep, one
 * child for low memory (RSS shows late, so memory never frees more than one per sweep).
 */
export async function sweepIdleMailboxes(
	mailboxes: ReadonlyArray<readonly [string, IdleSweepable]>,
	keep: IdleKeepOptions | undefined,
	log: Logger,
): Promise<number> {
	const identity = keep?.ompIdentity?.();
	const failed = (origin: string) => (error: unknown) => {
		log.warn("idle_sweep_failed", { origin, error: String(error) });
		return false;
	};
	const judged = await Promise.all(
		mailboxes.map(([origin, mailbox]) => mailbox.sweepIdle({ ompIdentity: identity }).catch(failed(origin))),
	);
	let stopped = judged.filter(Boolean).length;
	const hostPressure = keep?.hostPressure;
	if (hostPressure === undefined) return stopped;
	const resting = mailboxes
		.flatMap(([origin, mailbox]) => {
			const since = mailbox.idleCandidate();
			return since === undefined ? [] : [{ origin, mailbox, since }];
		})
		.sort((a, b) => a.since - b.since);
	if (resting.length === 0) return stopped;
	const release = async (): Promise<boolean> => {
		for (let next = resting.shift(); next !== undefined; next = resting.shift())
			if (await next.mailbox.stopForPressure().catch(failed(next.origin))) return true;
		return false;
	};
	let pressure = hostPressure();
	while (pressure.sessionFull === true && (await release())) {
		stopped += 1;
		pressure = hostPressure();
	}
	if (stopped === 0 && pressure.memoryLow === true && (await release())) stopped += 1;
	return stopped;
}
