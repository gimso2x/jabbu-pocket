import { parseThreadRef, TOP_LEVEL_TS } from "../core/normalize";
import { type ChatPlatform, platformOfConversationId } from "../core/origin-key";
import { redact } from "../redact";
import type { ChannelPort, OutboundMessage, PostTarget } from "./port";

function redactMessage(msg: OutboundMessage): OutboundMessage {
	return {
		...msg,
		text: redact(msg.text),
		...(msg.buttonsNote === undefined ? {} : { buttonsNote: redact(msg.buttonsNote) }),
		...(msg.title === undefined ? {} : { title: redact(msg.title) }),
		...(msg.body === undefined ? {} : { body: redact(msg.body) }),
		...(msg.fields === undefined
			? {}
			: { fields: msg.fields.map((field) => ({ label: redact(field.label), value: redact(field.value) })) }),
		...(msg.buttons === undefined
			? {}
			: {
					buttons: msg.buttons.map((button) => ({
						...button,
						label: redact(button.label),
						...(button.value === undefined ? {} : { value: redact(button.value) }),
					})),
				}),
	};
}

// The single outbound writer: masks every text, card, button, and upload field before an adapter sees it.
function redacting(port: ChannelPort): ChannelPort {
	const openThread = port.openThread?.bind(port);
	const archiveThread = port.archiveThread?.bind(port);
	const conversationContext = port.conversationContext?.bind(port);
	const pin = port.pin?.bind(port);
	return {
		platform: port.platform,
		post: (target, msg) => port.post(target, redactMessage(msg)),
		edit: (ref, msg) => port.edit(ref, redactMessage(msg)),
		react: (ref, name, on) => port.react(ref, name, on),
		uploadFile: (target, file) =>
			port.uploadFile(target, {
				path: file.path,
				...(file.title === undefined ? {} : { title: redact(file.title) }),
				...(file.comment === undefined ? {} : { comment: redact(file.comment) }),
			}),
		permalink: (ref) => port.permalink(ref),
		mentionUser: (userId) => port.mentionUser(userId),
		...(openThread === undefined ? {} : { openThread: (ref, name) => openThread(ref, redact(name)) }),
		...(archiveThread === undefined ? {} : { archiveThread: (ref) => archiveThread(ref) }),
		...(conversationContext === undefined ? {} : { conversationContext }),
		...(pin === undefined ? {} : { pin }),
	};
}

/** One port per chat platform; what it hands out is always the redacting writer around the adapter. */
export class ChannelRegistry {
	readonly #ports = new Map<ChatPlatform, ChannelPort>();

	register(port: ChannelPort): void {
		if (this.#ports.has(port.platform)) throw new Error(`channel already registered: ${port.platform}`);
		this.#ports.set(port.platform, redacting(port));
	}

	/** The registered port of `platform`; throws when none is (a wiring error, not a runtime condition). */
	get(platform: ChatPlatform): ChannelPort {
		const port = this.#ports.get(platform);
		if (port === undefined) throw new Error(`no channel registered for ${platform}`);
		return port;
	}

	/** Port and post target of `<conversationId>:<threadId|->`; `undefined` for malformed refs or unregistered platforms. */
	forThreadRef(threadRef: string): { port: ChannelPort; target: PostTarget } | undefined {
		const ref = parseThreadRef(threadRef);
		const route = ref === undefined ? undefined : this.forConversation(ref.channel);
		if (ref === undefined || route === undefined) return undefined;
		return ref.threadTs === TOP_LEVEL_TS
			? route
			: { port: route.port, target: { ...route.target, threadId: ref.threadTs } };
	}

	/** Port of a bare conversation id (an approval card's channel, a lane's channel); `undefined` when none fits. */
	forConversation(conversationId: string): { port: ChannelPort; target: PostTarget } | undefined {
		const platform = platformOfConversationId(conversationId);
		const port = platform === undefined ? undefined : this.#ports.get(platform);
		return port === undefined ? undefined : { port, target: { conversationId } };
	}

	/** `forConversation`'s port, for callers that cannot go on without one (a wiring error, not a runtime condition). */
	portFor(conversationId: string): ChannelPort {
		const route = this.forConversation(conversationId);
		if (route === undefined) throw new Error(`no channel registered for conversation ${conversationId}`);
		return route.port;
	}
}
