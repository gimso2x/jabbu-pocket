import { MAX_INBOUND_FILES } from "../channel/attachments";
import { GRAMMAR } from "../core/origin-key";
import type { DaemonContext } from "../daemon/daemon-context";
import { WebAdapter } from "./adapter";
import { validateWebAttachmentPath } from "./upload";

const CONTROL_CHARS = /\p{Cc}/u;
const TITLE_MAX_LEN = 200;

/** Handles `web_new`, `web_send`, and `web_action` IPC ops from the dashboard server. */
export async function handleWebIpc(ctx: DaemonContext, request: Record<string, unknown>): Promise<unknown> {
	const adapter = ctx.adapters.get("web");
	if (!(adapter instanceof WebAdapter)) return { ok: false, error: "web_disabled" };

	if (request.op === "web_new") {
		const title = request.title;
		if (
			title !== undefined &&
			(typeof title !== "string" || title.length > TITLE_MAX_LEN || CONTROL_CHARS.test(title))
		) {
			return { ok: false, error: "invalid_title" };
		}
		return adapter.createConversation(title);
	}

	if (request.op === "web_send") {
		const { conversation, thread, text, files } = request;
		if (typeof conversation !== "string" || !GRAMMAR.web.conversation.test(conversation)) {
			return { ok: false, error: "invalid_conversation" };
		}
		if (thread !== undefined && (typeof thread !== "string" || !GRAMMAR.web.thread.test(thread))) {
			return { ok: false, error: "invalid_thread" };
		}
		if (typeof text !== "string") return { ok: false, error: "invalid_text" };
		let verifiedFiles: string[] | undefined;
		if (files !== undefined) {
			if (
				!Array.isArray(files) ||
				!files.every((file): file is string => typeof file === "string" && file !== "" && !CONTROL_CHARS.test(file))
			) {
				return { ok: false, error: "invalid_files" };
			}
			if (files.length > MAX_INBOUND_FILES) return { ok: false, error: "too_many_files" };
			verifiedFiles = [];
			for (const file of files) {
				const check = validateWebAttachmentPath(file, ctx.options.config.homeDir);
				if (!check.ok) return { ok: false, error: check.error };
				verifiedFiles.push(check.path);
			}
		}
		return await adapter.sendFromWeb({ conversation, thread, text, files: verifiedFiles });
	}

	if (request.op === "web_action") {
		const { actionId, value, messageId } = request;
		if (
			typeof actionId !== "string" ||
			actionId.trim() === "" ||
			actionId.length > 256 ||
			CONTROL_CHARS.test(actionId)
		) {
			return { ok: false, error: "invalid_action_id" };
		}
		if (value !== undefined && typeof value !== "string") return { ok: false, error: "invalid_value" };
		let resolvedMessageId: string | undefined;
		if (messageId !== undefined) {
			if (typeof messageId === "number" && Number.isInteger(messageId) && messageId > 0) {
				resolvedMessageId = String(messageId);
			} else if (typeof messageId === "string" && /^\d+$/.test(messageId)) {
				resolvedMessageId = messageId;
			} else {
				return { ok: false, error: "invalid_message_id" };
			}
		}
		return await adapter.handleWebAction({ actionId, value, messageId: resolvedMessageId });
	}

	return { ok: false, error: "unknown_web_op" };
}
