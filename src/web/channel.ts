import { basename } from "node:path";
import type { ChannelPort, MessageRef, OutboundMessage, PostTarget } from "../channel/port";
import { WEB_OWNER_USER_ID } from "../config-web";
import type { WebMessageRole, WebMessageStore } from "../store/web-messages";

function cardPayload(msg: OutboundMessage): string | undefined {
	if (msg.title === undefined && msg.body === undefined && msg.fields === undefined && msg.buttonsNote === undefined) {
		return undefined;
	}
	return JSON.stringify({
		...(msg.title === undefined ? {} : { title: msg.title }),
		...(msg.body === undefined ? {} : { body: msg.body }),
		...(msg.fields === undefined ? {} : { fields: msg.fields }),
		...(msg.buttonsNote === undefined ? {} : { buttonsNote: msg.buttonsNote }),
	});
}

function roleOfMessage(msg: OutboundMessage): WebMessageRole {
	if (msg.buttons !== undefined || msg.title?.includes("승인")) return "approval";
	if (msg.text.startsWith("❓") || msg.text.startsWith("🔒")) return "choice";
	return "assistant";
}

/**
 * Web implementation of `ChannelPort` backed by the `web_messages` table. Every field written through `WebMessageStore`
 * passes `redact`, in addition to `ChannelRegistry`'s redacting wrapper.
 */
export class WebChannel implements ChannelPort {
	readonly platform = "web" as const;
	#store: WebMessageStore | undefined;

	/** Wires the opened ledger's `web_messages` store when `WebBinding.createAdapter` runs at daemon start. */
	attach(store: WebMessageStore): void {
		this.#store = store;
	}

	#requireStore(): WebMessageStore {
		if (this.#store === undefined) throw new Error("web channel not attached to store");
		return this.#store;
	}

	async post(target: PostTarget, msg: OutboundMessage): Promise<MessageRef> {
		const cardJson = cardPayload(msg);
		const buttonsJson = msg.buttons !== undefined && msg.buttons.length > 0 ? JSON.stringify(msg.buttons) : undefined;
		const row = this.#requireStore().insert({
			conversation: target.conversationId,
			thread: target.threadId,
			role: roleOfMessage(msg),
			text: msg.text,
			...(cardJson === undefined ? {} : { cardJson }),
			...(buttonsJson === undefined ? {} : { buttonsJson }),
		});
		return {
			platform: "web",
			conversationId: target.conversationId,
			messageId: String(row.id),
			...(target.threadId === undefined ? {} : { threadId: target.threadId }),
		};
	}

	async edit(ref: MessageRef, msg: OutboundMessage): Promise<void> {
		const id = Number(ref.messageId);
		if (!Number.isInteger(id) || id <= 0) throw new Error(`invalid web message id: ${ref.messageId}`);
		const cardJson = cardPayload(msg);
		const nextCard = cardJson !== undefined ? cardJson : msg.buttons !== undefined ? null : undefined;
		const effectiveButtons = msg.buttons ?? (cardJson !== undefined ? [] : undefined);
		const buttonsJson =
			effectiveButtons === undefined
				? undefined
				: effectiveButtons.length === 0
					? null
					: JSON.stringify(effectiveButtons);
		this.#requireStore().edit(id, {
			text: msg.text,
			...(nextCard === undefined ? {} : { cardJson: nextCard }),
			...(buttonsJson === undefined ? {} : { buttonsJson }),
		});
	}

	async react(_ref: MessageRef, _name: string, _on: boolean): Promise<void> {
		// Web UI shows status rows directly rather than message reactions.
	}

	async uploadFile(
		target: PostTarget,
		file: { path: string; title?: string; comment?: string },
	): Promise<{ fileId: string }> {
		const row = this.#requireStore().insert({
			conversation: target.conversationId,
			thread: target.threadId,
			role: "assistant",
			text: file.comment ?? file.title ?? basename(file.path),
			filesJson: JSON.stringify([
				{
					path: file.path,
					...(file.title === undefined ? {} : { title: file.title }),
					...(file.comment === undefined ? {} : { comment: file.comment }),
				},
			]),
		});
		return { fileId: String(row.id) };
	}

	async permalink(ref: MessageRef): Promise<string | undefined> {
		const base = `/?view=chat&c=${encodeURIComponent(ref.conversationId)}`;
		return ref.threadId === undefined ? base : `${base}&t=${encodeURIComponent(ref.threadId)}`;
	}

	mentionUser(userId: string): string {
		return userId === WEB_OWNER_USER_ID ? "@owner" : `@${userId}`;
	}

	/** Status tracker helper: inserts a running `status` row and returns its ref. */
	postStatus(target: PostTarget, text: string): MessageRef {
		const row = this.#requireStore().insert({
			conversation: target.conversationId,
			thread: target.threadId,
			role: "status",
			text,
			cardJson: JSON.stringify({ kind: "status", deleted: false }),
		});
		return {
			platform: "web",
			conversationId: target.conversationId,
			messageId: String(row.id),
			...(target.threadId === undefined ? {} : { threadId: target.threadId }),
		};
	}

	/** Status tracker helper: updates or soft-deletes a `status` row (soft delete bumps `edited_at` for SSE). */
	editStatus(messageId: string, text: string, deleted: boolean, final = false): void {
		const id = Number(messageId);
		if (!Number.isInteger(id) || id <= 0) return;
		this.#requireStore().edit(id, {
			text,
			cardJson: JSON.stringify({ kind: "status", deleted, ...(final ? { final: true } : {}) }),
		});
	}
}
