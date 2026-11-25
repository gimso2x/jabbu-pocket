import { parseChatOrigin, platformOfConversationId } from "../core/origin-key";
import type { DaemonContext } from "../daemon/daemon-context";
import { redact } from "../redact";
import { slugOfBotHome } from "./bots";

export interface WebOwnerTurnInfo {
	kind: "approval" | "choice";
	channel: string;
	messageId: string;
	summary: string;
	originKey?: string | undefined;
}

/** Builds a `WebOwnerTurnInfo` payload concisely for callers with strict LOC budgets. */
export function ownerTurnInfo(
	kind: "approval" | "choice",
	channel: string,
	messageId: string,
	summary: string,
	originKey?: string,
): WebOwnerTurnInfo {
	return { kind, channel, messageId, summary, ...(originKey === undefined ? {} : { originKey }) };
}

function webChatLink(ctx: DaemonContext, info: WebOwnerTurnInfo): string {
	const host = ctx.options.config.dashboard?.allowedHosts?.[0];
	const parsed = info.originKey === undefined ? undefined : parseChatOrigin(info.originKey);
	const bot = slugOfBotHome(ctx.options.config.homeDir, "");
	const params = [`c=${encodeURIComponent(info.channel)}`];
	if (parsed?.threadId !== undefined) params.push(`t=${encodeURIComponent(parsed.threadId)}`);
	if (bot !== "") params.push(`bot=${encodeURIComponent(bot)}`);
	const query = `/?view=chat&${params.join("&")}`;
	return host ? `https://${host}${query}` : query;
}

/** Sends a best-effort one-line Discord DM when a web conversation awaits owner approval or choice. */
export function notifyWebOwnerTurn(ctx: DaemonContext, info: WebOwnerTurnInfo): void {
	if (platformOfConversationId(info.channel) !== "web") return;
	const discord = ctx.adapters.get("discord");
	if (discord === undefined || discord.connectionState()?.state === "down") {
		ctx.log.info("web_notify_skipped", { reason: "discord_unavailable", conversation: info.channel });
		return;
	}
	const dmOrigin = ctx.store?.ownerDmOrigin("discord");
	const dmRef = dmOrigin === undefined ? undefined : parseChatOrigin(dmOrigin);
	if (dmRef === undefined) {
		ctx.log.info("web_notify_skipped", { reason: "discord_dm_unknown", conversation: info.channel });
		return;
	}
	const prefix = info.kind === "approval" ? "🔐 웹 대화 승인 대기" : "❓ 웹 대화 질문 대기";
	const cleanSummary = redact(info.summary).replace(/\s+/g, " ").trim().slice(0, 120);
	const link = webChatLink(ctx, info);
	const line = cleanSummary ? `${prefix}: ${cleanSummary} — ${link}` : `${prefix} — ${link}`;
	void discord.postNotice(dmRef.conversationId, line).catch((error: unknown) => {
		ctx.log.warn("web_notify_discord_failed", { conversation: info.channel, error: String(error) });
	});
}
