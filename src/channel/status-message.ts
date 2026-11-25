// The platform side of the status steps the chat adapters share (`StatusPlatform` callbacks): post, edit and delete the
// thread's ⏳ message and swap its reaction, each a rate-limit answer (`true`: retried by a later tick) or one log line.
import { threadRefOf } from "../core/normalize";
import type { Logger } from "../log";
import type { StatusEntry } from "./status";
import { errorText } from "./text";

/** One status step's platform side: the bound transport call, the rate-limit test and the adapter's log. */
export interface StatusStep {
	/** The transport call, already inside the adapter's call wrapper (its rate-limit route included). */
	run: () => Promise<void>;
	/** `true` for this platform's rate-limit errors: the tracker retries the step on a later tick. */
	isRateLimited(err: unknown): boolean;
	log: Logger;
}

/** Posts the thread's `⏳` line; a refused post is one `status_create_failed` warn line and leaves the thread without one. */
export async function createStatusMessage(
	entry: StatusEntry,
	log: Logger,
	create: () => Promise<{ statusChannel: string; statusId: string }>,
): Promise<void> {
	try {
		const posted = await create();
		entry.statusChannel = posted.statusChannel;
		entry.statusId = posted.statusId;
	} catch (err) {
		log.warn("status_create_failed", { thread: threadRefOf(entry.channel, entry.root), error: errorText(err) });
	}
}

/**
 * The running/final status edit the chat adapters share: the rate limit answers `true` (the tracker
 * retries on a later tick), any other error is one warn line — `status_final_failed` for the final label,
 * `status_update_failed` for a running update — and `false`. The edited text is bound inside `step.run`.
 */
export async function editStatusMessage(entry: StatusEntry, final: boolean, step: StatusStep): Promise<boolean> {
	try {
		await step.run();
		return false;
	} catch (err) {
		if (step.isRateLimited(err)) return true;
		step.log.warn(final ? "status_final_failed" : "status_update_failed", {
			thread: threadRefOf(entry.channel, entry.root),
			error: errorText(err),
		});
		return false;
	}
}

/**
 * The status delete the chat adapters share: `true` when rate limited (tick() deletes again). A refusal
 * logs `status_delete_failed` and turns the finish into an update of the final label.
 */
export async function removeStatusMessage(entry: StatusEntry, step: StatusStep): Promise<boolean> {
	try {
		await step.run();
		return false;
	} catch (err) {
		if (step.isRateLimited(err)) return true;
		step.log.warn("status_delete_failed", {
			thread: threadRefOf(entry.channel, entry.root),
			error: errorText(err),
		});
		entry.finalAction = "update";
		return false;
	}
}

/**
 * The reaction swap (👀 off, the final mark on) the chat adapters share: `true` when rate limited and the
 * step must be retried later; other errors (no_reaction, unknown reaction) are final — one `reaction_skipped` info
 * line. `method` names the call in that line when the platform has more than one.
 */
export async function swapStatusReaction(step: StatusStep, method?: string): Promise<boolean> {
	try {
		await step.run();
		return false;
	} catch (err) {
		if (step.isRateLimited(err)) return true;
		step.log.info("reaction_skipped", { ...(method === undefined ? {} : { method }), error: errorText(err) });
		return false;
	}
}
