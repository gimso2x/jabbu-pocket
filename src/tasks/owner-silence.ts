import type { JabbuConfig } from "../config";
import { ownerSilenceFallbackMinutes, silenceFailedNotice, silenceNotice, silencePrompt } from "../owner-silence";
import type { TaskJudgement } from "./checker";
import type { TaskLedger, TaskRow } from "./ledger";

/**
 * A reversible owner question (`needs_owner: yes` + `fallback_ok: yes` + `recommend`) the owner left unanswered for
 * `ownerSilenceFallbackMinutes` after its card went up: the agent gets one prompt to go on with the recommendation and
 * the thread one line. Keyed by the block and its reason in the ledger (marked before the prompt goes out, like the
 * retry prompt), so a restart or a repeated sweep never sends it twice. A frozen bot or a paused task waits.
 */
export async function silenceFallback(
	deps: { ledger: TaskLedger; config?: Pick<JabbuConfig, "ownerSilenceFallbackMinutes">; frozen: boolean },
	act: { remind(text: string): Promise<boolean>; post(text: string): Promise<unknown> },
	row: TaskRow,
	judgement: TaskJudgement,
	since: number,
	now: number,
): Promise<string | undefined> {
	const { ledger } = deps;
	const minutes = deps.config === undefined ? 0 : ownerSilenceFallbackMinutes(deps.config);
	const recommend = judgement.decision.recommend;
	if (minutes <= 0 || !judgement.needsOwner || !judgement.decision.fallbackOk || recommend === "") return undefined;
	const fresh = ledger.require(row.taskId);
	if (deps.frozen || ledger.isPaused(fresh)) return undefined;
	const askedAt = fresh.notices[`blocked:${since}:${judgement.blockedReason}`];
	if (askedAt === undefined || now - askedAt < minutes * 60_000) return undefined;
	if (!ledger.recordNotice(row.taskId, `silence:${since}:${judgement.blockedReason}`)) return undefined;
	const sent = await act.remind(silencePrompt(minutes, recommend));
	const subject = `TASK ${row.taskId}를 `;
	await act.post(sent ? silenceNotice(minutes, recommend, subject) : silenceFailedNotice(minutes, recommend, subject));
	return sent ? "owner silence fallback" : "owner silence fallback failed";
}
