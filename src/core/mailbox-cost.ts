import type { OmpSessionDriver, OmpTurnUsage } from "../omp/driver";
import {
	EntryNotFoundError,
	ledgerDay,
	sessionWindowCost,
	subAgentWindowCost,
	TURN_STOP_RATIO,
	turnCapStopReason,
	turnCapWarnText,
	type WindowCost,
} from "../ops/cost-cap";
import { chargedCursorKey, parseChargedCursor } from "./mailbox-helpers";

/** Injected so tests use `FakeOmpDriver`; production builds an `RpcOmpDriver` for (origin, sessionDir). */
import type { ActiveTurn, MailboxDeps, MailboxHost } from "./mailbox-types";

/**
 * Applies `costCap.turnUsd` to the turn's total (its own assistant calls plus the in-window sub-agent
 * transcripts): on reaching the ceiling the thread gets one warning (the turn goes on), on reaching 3x it is
 * aborted and settled as `cost_cap`. Nothing runs without a ceiling or for a settled turn.
 */
export function judgeTurnCost(host: MailboxHost, turn: ActiveTurn): void {
	if (host.turn() !== turn) return;
	const cap = host.deps.costCap?.()?.turnUsd;
	if (cap === undefined) return;
	const spent = turn.costUsd + turn.subAgentUsd;
	if (spent <= 0 || turn.costStopReason !== undefined) return;
	if (spent >= cap * TURN_STOP_RATIO) {
		// The reason is kept on the turn: the final this abort causes settles with it (`#onFinal`).
		turn.costStopReason = turnCapStopReason(cap, spent);
		host.background("cost_cap_stop_failed", () => abortCostCap(host, turn, cap));
		return;
	}
	if (turn.costSoftSent || spent < cap) return;
	turn.costSoftSent = true;
	host.deps.log.info("cost_cap_turn_soft", {
		origin: host.deps.originKey,
		opRef: turn.opRef,
		cost: spent,
		cap,
	});
	host.deps.onTurnCostCap?.({
		originKey: host.deps.originKey,
		threadRef: turn.threadRef,
		text: turnCapWarnText(cap, spent),
	});
}

/**
 * Re-reads the turn's sub-agent transcripts and judges again. Off the actor's chain because it reads files; a
 * read failure is logged as `turn_subagent_cost_failed` and the turn keeps the sub-agent total it had.
 */
export function refreshSubAgentCost(host: MailboxHost, turn: ActiveTurn): void {
	if (host.deps.costCap?.()?.turnUsd === undefined) return;
	host.background("turn_subagent_cost_failed", async () => {
		if (host.turn() !== turn) return;
		const { originKey, log, clock } = host.deps;
		let file = turn.subAgentSessionFile;
		if (file === undefined) {
			const driver = host.driver();
			if (driver === undefined) return;
			try {
				file = (await driver.state()).sessionFile;
			} catch (error) {
				log.warn("turn_subagent_cost_failed", { origin: originKey, opRef: turn.opRef, error: String(error) });
				return;
			}
			if (file === undefined || file === "") return;
			turn.subAgentSessionFile = file;
		}
		const window = await subAgentWindowCost({
			sessionFile: file,
			from: turn.startedAt,
			to: clock.now(),
			cache: turn.subAgentCache,
			onReadError: (path, error) =>
				log.warn("turn_subagent_cost_failed", {
					origin: originKey,
					opRef: turn.opRef,
					file: path,
					error: String(error),
				}),
		});
		if (host.turn() !== turn) return;
		turn.subAgentUsd = window.cost;
		judgeTurnCost(host, turn);
	});
}

/**
 * Adds the finished turn's priced cost (its own session after the `charged:` cursor or start cursor plus in-window
 * sub-agent transcripts) to `usage_daily`. When the session file cannot be read the fallback is the turn's live
 * `costUsd`, which is its own session only: `subAgentUsd` is deliberately not added there, because the ledger read
 * that failed would have counted the sub-agent files itself — adding both would charge them twice. The miss is
 * logged as `usage_daily_failed`. A missing `sessionFile`
 * (no session yet) is not error: there is no transcript to read and nothing was spent. `wedged`: the child is being
 * stopped as unresponsive, so its state is not asked again (another RPC timeout) and the live total is charged.
 * `usage`: the final's own report from a driver without a session file (agy) — its calls are counted at cost 0 and
 * its tokens logged.
 */
export async function recordDailyCost(
	deps: MailboxDeps,
	driver: OmpSessionDriver,
	turn: ActiveTurn,
	wedged = false,
	usage?: OmpTurnUsage,
): Promise<void> {
	if (turn.costRecorded) return;
	turn.costRecorded = true;
	const { store, originKey, log } = deps;
	if (usage !== undefined) {
		addDailyUsage(deps, turn.opRef, 0, usage.calls);
		log.info("agy_usage", {
			origin: originKey,
			opRef: turn.opRef,
			calls: usage.calls,
			input: usage.input,
			cacheRead: usage.cacheRead,
			output: usage.output,
			contextTokens: usage.contextTokens,
			rotated: usage.rotated,
		});
		return;
	}
	if (wedged) {
		log.info("usage_daily_live", { origin: originKey, opRef: turn.opRef, reason: "child_stopped" });
		if (addDailyUsage(deps, turn.opRef, turn.costUsd, 1)) store.deleteCursor(chargedCursorKey(originKey));
		return;
	}
	await chargeSessionWindow(deps, {
		driver,
		opRef: turn.opRef,
		fallbackAfterEntryId: turn.entryCursor,
		from: turn.startedAt,
		fallbackCost: turn.costUsd,
	});
}

/**
 * Writes one `usage_daily` increment and logs `usage_daily_failed` instead of throwing so a ledger failure never
 * blocks an answer or queued work. Returns whether the write succeeded.
 */
export function addDailyUsage(deps: MailboxDeps, opRef: string, cost: number, calls: number): boolean {
	const { store, originKey, log, clock } = deps;
	try {
		store.addDailyUsage({ day: ledgerDay(clock.now(), deps.timezone), originKey, cost, calls });
		return true;
	} catch (error) {
		log.warn("usage_daily_failed", { origin: originKey, opRef, cost, calls, error: String(error) });
		return false;
	}
}

/**
 * Reads the session file from the saved `charged:<originKey>` cursor (when its file matches and its entry id is
 * still in the file) or `fallbackAfterEntryId` (`turn.entryCursor` or pre-compact `leafId`) and adds the cost to
 * `usage_daily`. Advances the cursor only when both reading and `addDailyUsage` succeed and `lastEntryId` exists;
 * clears the cursor on window-read or `driver.state()` failure (after a successful fallback charge when provided) so
 * the next charge starts from `fallbackAfterEntryId` instead of recounting from a stale marker.
 */
export async function chargeSessionWindow(
	deps: MailboxDeps,
	input: {
		driver: OmpSessionDriver;
		opRef: string;
		fallbackAfterEntryId: string | null;
		from: number;
		fallbackCost?: number;
	},
): Promise<void> {
	const { store, originKey, log, clock } = deps;
	const key = chargedCursorKey(originKey);
	const chargeFallback = (): void => {
		if (input.fallbackCost === undefined) {
			store.deleteCursor(key);
			return;
		}
		if (addDailyUsage(deps, input.opRef, input.fallbackCost, 1)) store.deleteCursor(key);
	};
	let file: string | undefined;
	try {
		file = (await input.driver.state()).sessionFile;
	} catch (error) {
		log.warn("usage_daily_failed", { origin: originKey, opRef: input.opRef, error: String(error) });
		chargeFallback();
		return;
	}
	if (file === undefined || file === "") return;
	const to = clock.now();
	const saved = parseChargedCursor(store.getCursor(key));
	const preferred = saved !== undefined && saved.sessionFile === file ? saved.entryId : undefined;
	const readWindow = (afterEntryId: string | null): Promise<WindowCost> =>
		sessionWindowCost({ sessionFile: file, afterEntryId, from: input.from, to });
	let window: WindowCost;
	try {
		if (preferred !== undefined) {
			try {
				window = await readWindow(preferred);
			} catch (error) {
				if (error instanceof EntryNotFoundError && preferred !== input.fallbackAfterEntryId) {
					window = await readWindow(input.fallbackAfterEntryId);
				} else {
					throw error;
				}
			}
		} else {
			window = await readWindow(input.fallbackAfterEntryId);
		}
	} catch (error) {
		log.warn("usage_daily_failed", { origin: originKey, opRef: input.opRef, file, error: String(error) });
		chargeFallback();
		return;
	}
	if (addDailyUsage(deps, input.opRef, window.cost, window.calls) && window.lastEntryId !== undefined) {
		store.setCursor(key, `${file}\t${window.lastEntryId}`);
	}
}

/**
 * Aborts a turn that passed 3x its ceiling and settles it through the normal final path with the `cost_cap`
 * reason (a failure notice to the thread, but no failure count: `#onFinal` skips `#noteTurnFailure`). A final that
 * settled the turn first wins; this then does nothing.
 */
export async function abortCostCap(host: MailboxHost, turn: ActiveTurn, cap: number): Promise<void> {
	const driver = host.driver();
	if (!driver || host.turn() !== turn) return;
	const { originKey, log } = host.deps;
	const spent = turn.costUsd + turn.subAgentUsd;
	const reason = turn.costStopReason ?? turnCapStopReason(cap, spent);
	log.warn("cost_cap_turn_stop", { origin: originKey, opRef: turn.opRef, cost: spent, cap });
	try {
		await driver.abort();
	} catch (error) {
		log.warn("cost_cap_abort_failed", { origin: originKey, opRef: turn.opRef, error: String(error) });
	}
	if (host.turn() !== turn || host.driver() !== driver) return;
	await host.onFinal(driver, { opRef: turn.opRef, status: "aborted", text: "", error: reason });
}
