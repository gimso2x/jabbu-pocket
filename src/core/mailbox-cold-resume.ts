/**
 * Cold-resume rotation: a chat conversation whose prompt cache expired while it was quiet starts its next turn in a
 * new epoch's empty session instead of rewriting the whole old context into the cache. The pending row keeps its place
 * (`Store.rotateEpochKeepPending`); the first prompt re-feeds the thread head and the previous epoch's latest exchanges.
 */
import { readFileSync } from "node:fs";
import { COLD_RESUME_ROTATE_DEFAULT_TOKENS, type JabbuConfig } from "../config";
import { isTaskOrigin } from "../lanes/status";
import { MONITOR_ORIGIN_PREFIX } from "../monitors/ledger";
import {
	type CacheBaseline,
	CacheMonitor,
	cacheCallOf,
	isColdCache,
	shouldRotateOnColdResume,
} from "../ops/cache-monitor";
import type { InboundRow } from "../store/db-rows";
import {
	MAX_ROTATION_EXCHANGES,
	OWN_ANSWER_LINE,
	ROTATION_CONTEXT_HEADER,
	threadHeadLines,
} from "./mailbox-thread-context";
import { type MailboxDeps, sessionToResume } from "./mailbox-types";
import { threadRefOfOrigin } from "./normalize";
import { parseChatOrigin } from "./origin-key";

/** The rotation block's ceiling in characters; the oldest exchanges go first. */
export const ROTATION_BLOCK_MAX_CHARS = 8000;
/** Characters of one question or answer in the block (the agy path keeps its own, byte-based preview). */
const EXCHANGE_PREVIEW_CHARS = 1000;

type RotationDeps = Pick<
	MailboxDeps,
	"store" | "originKey" | "clock" | "log" | "sessionDirFor" | "coldResumeRotateTokens"
>;

/** What a rotation leaves for the turn's first prompt: the old epoch and the session file it ran in. */
export interface ColdResumeRotation {
	row: InboundRow;
	previousEpoch: number;
	previousFile: string | undefined;
	prefixTokens: number;
	idleMs: number;
}

/** The token threshold the daemon hands every mailbox: the config's (default on), off for an agy bot (it rotates itself). */
export function coldResumeTokens(config: Pick<JabbuConfig, "agent" | "coldResumeRotateTokens">): number {
	return config.agent === "agy" ? 0 : (config.coldResumeRotateTokens ?? COLD_RESUME_ROTATE_DEFAULT_TOKENS);
}

/** Thread line of a rotated turn. */
export function formatColdResumeNotice(info: { prefixTokens: number }): string {
	return `-# 오래 쉰 대화라 새 세션으로 이어 갑니다(이전 문맥 ${Math.round(info.prefixTokens / 1000)}k)`;
}

/** The last assistant call of a session file as a cache baseline; throws when the file cannot be read. */
function sessionBaseline(file: string): CacheBaseline | undefined {
	const lines = readFileSync(file, "utf8").split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		let entry: { timestamp?: unknown; message?: { role?: unknown } } | undefined;
		try {
			entry = JSON.parse(lines[i] ?? "");
		} catch {
			continue;
		}
		if (entry?.message?.role !== "assistant") continue;
		const stamp = entry.timestamp;
		const at = typeof stamp === "string" ? Date.parse(stamp) : typeof stamp === "number" ? stamp : Number.NaN;
		const call = Number.isNaN(at) ? undefined : cacheCallOf(entry.message, at);
		if (call === undefined) return undefined;
		const monitor = new CacheMonitor();
		monitor.seed(call);
		return monitor.baseline;
	}
	return undefined;
}

/**
 * Rotates the origin to a new epoch when its new turn resumes a cold cache of `coldResumeRotateTokens` or more. The
 * baseline is the mailbox's own, else the session file's last assistant record (no child is started for it; an
 * unreadable file means no rotation). Chat conversations only: monitors, [TASK]s and lanes never rotate. `row` of the
 * result is the pending row after the move to the new epoch; the caller stops the idle child and resets its cache state.
 */
export function rotateOnColdResume(
	deps: RotationDeps,
	baseline: CacheBaseline | undefined,
	row: InboundRow,
): ColdResumeRotation | undefined {
	const { store, originKey, clock, log } = deps;
	const tokens = deps.coldResumeRotateTokens?.() ?? 0;
	if (tokens <= 0 || parseChatOrigin(originKey) === undefined) return undefined;
	if (originKey.startsWith(MONITOR_ORIGIN_PREFIX) || isTaskOrigin(originKey)) return undefined;
	const origin = store.getOrigin(originKey);
	if (origin === undefined) return undefined;
	const now = clock.now();
	let previousFile: string | undefined;
	let known = baseline;
	try {
		previousFile = sessionToResume(origin);
		if (known === undefined && previousFile !== undefined) known = sessionBaseline(previousFile);
		if (known === undefined || !shouldRotateOnColdResume(known, now, tokens)) return undefined;
	} catch (error) {
		log.warn("cold_resume_baseline_failed", { origin: originKey, error: String(error) });
		return undefined;
	}
	const rotated = store.rotateEpochKeepPending(originKey, deps.sessionDirFor(originKey, origin.epoch + 1));
	const idleMs = now - known.at;
	log.info("epoch_new", {
		origin: originKey,
		epoch: rotated.epoch,
		reason: "cold_resume",
		prefix: known.prefix,
		idleSec: Math.round(idleMs / 1000),
	});
	return {
		row: store.getInbound(row.platformMessageId) ?? row,
		previousEpoch: origin.epoch,
		previousFile,
		prefixTokens: known.prefix,
		idleMs,
	};
}

/** `text` on one line, cut to `EXCHANGE_PREVIEW_CHARS` characters (not bytes: a Korean answer survives whole). */
const preview = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, EXCHANGE_PREVIEW_CHARS);

/**
 * The first prompt's context of a rotated omp session: the thread head, the previous epoch's latest exchanges (oldest
 * dropped first to stay within `ROTATION_BLOCK_MAX_CHARS`) and the previous session file, which the model may `read`.
 */
export function coldResumeContextBlock(
	deps: Pick<RotationDeps, "store" | "originKey">,
	current: InboundRow,
	previous: Pick<ColdResumeRotation, "previousEpoch" | "previousFile">,
): string | null {
	const { store, originKey } = deps;
	const threadRef = threadRefOfOrigin(originKey);
	const head = threadRef === undefined ? [] : threadHeadLines(store, threadRef, originKey, current);
	const pairs = store
		.listOriginExchanges(originKey, previous.previousEpoch, MAX_ROTATION_EXCHANGES)
		.map((exchange) => [
			`- 받은 질문(${new Date(exchange.askedAt).toISOString()}): ${preview(exchange.question)}`,
			`${OWN_ANSWER_LINE}(${new Date(exchange.answeredAt).toISOString()}): ${preview(exchange.answer)}`,
		]);
	const tail =
		previous.previousFile === undefined
			? []
			: [`- 이전 세션 파일(필요하면 read로 직접 열어 본다): ${previous.previousFile}`];
	if (head.length + pairs.length + tail.length === 0) return null;
	const render = (dropped: number): string =>
		[ROTATION_CONTEXT_HEADER, ...head, ...pairs.slice(dropped).flat(), ...tail].join("\n");
	let dropped = 0;
	while (dropped < pairs.length && render(dropped).length > ROTATION_BLOCK_MAX_CHARS) dropped++;
	return render(dropped).slice(0, ROTATION_BLOCK_MAX_CHARS);
}

/** One line to the new turn's thread when it resumes a large conversation whose cache has expired; returns the baseline noticed. */
export function warnColdCache(
	deps: Pick<MailboxDeps, "originKey" | "clock" | "log" | "onColdCache">,
	cache: CacheMonitor,
	warned: CacheBaseline | undefined,
	threadRef: string,
): CacheBaseline | undefined {
	const { originKey, clock, log } = deps;
	const baseline = cache.baseline;
	const now = clock.now();
	if (originKey.startsWith(MONITOR_ORIGIN_PREFIX) || baseline === undefined || baseline === warned) return warned;
	if (!isColdCache(baseline, now)) return warned;
	const price = cache.writeCostPerToken;
	const idleMs = now - baseline.at;
	deps.onColdCache?.({
		originKey,
		threadRef,
		prefixTokens: baseline.prefix,
		idleMs,
		...(price === undefined ? {} : { estimatedCost: price * baseline.prefix }),
	});
	log.info("cold_cache_warned", { origin: originKey, prefix: baseline.prefix, idleSec: Math.round(idleMs / 1000) });
	return baseline;
}
