import type { ChannelRegistry } from "../channel/registry";
import { parseThreadRef } from "../core/normalize";
import type { TaskChatLog } from "./notify";

/** Permalink of the task thread root; the bare thread ref when the platform cannot resolve it. */
export async function threadLink(channels: ChannelRegistry, log: TaskChatLog, threadRef: string): Promise<string> {
	const target = parseThreadRef(threadRef);
	if (target === undefined) return threadRef;
	try {
		const port = channels.portFor(target.channel);
		const root = { platform: port.platform, conversationId: target.channel, messageId: target.threadTs };
		return (await port.permalink(root)) ?? threadRef;
	} catch (error) {
		log.warn("task_permalink_failed", { thread: threadRef, error: String(error) });
		return threadRef;
	}
}
