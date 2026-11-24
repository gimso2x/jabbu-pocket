import { cutCodePointSafe } from "../channel/text";
import { redact } from "../redact";
import type { InboundRow } from "../store/db-rows";
import { PLACE_NAME_MAX, PURPOSE_HEADER, TOPIC_MAX } from "./mailbox-thread-context";
/** Injected so tests use `FakeOmpDriver`; production builds an `RpcOmpDriver` for (origin, sessionDir). */
import type { MailboxDeps } from "./mailbox-types";
import { threadRefOfOrigin } from "./normalize";
import { parseChatOrigin } from "./origin-key";
import { PURPOSE_CLEAR_ARG, PURPOSE_COMMAND, purposeMemoError } from "./types";

/** Purpose-memo scope keys of this origin: its channel, and its thread when it is a thread session. */
export function purposeScopes(deps: MailboxDeps): { channel: string; thread?: string } | undefined {
	const ref = parseChatOrigin(deps.originKey);
	if (ref === undefined) return undefined;
	const thread = threadRefOfOrigin(deps.originKey);
	return {
		channel: `${ref.platform}:${ref.conversationId}`,
		...(thread === undefined ? {} : { thread: `${ref.platform}:${thread}` }),
	};
}

/** The memo lines (`채널: …`, `스레드: …`) that apply to this origin. */
export function purposeLines(deps: MailboxDeps): string[] {
	const scopes = purposeScopes(deps);
	if (scopes === undefined) return [];
	const channel = deps.store.getPurpose(scopes.channel);
	const thread = scopes.thread === undefined ? undefined : deps.store.getPurpose(scopes.thread);
	return [
		...(channel === undefined ? [] : [`채널: ${channel}`]),
		...(thread === undefined ? [] : [`스레드: ${thread}`]),
	];
}

/** The place lines (`자리: #<채널> › <스레드>`, `채널 설명: <토픽>`) from what the platform cached. */
export function placeLines(deps: MailboxDeps): string[] {
	const place = deps.conversationContext?.();
	if (place === undefined) return [];
	// Masked before cutting: a cut inside a PEM block would leave a BEGIN line without its END, which `redact` skips.
	const clean = (text: string, max: number): string => cutCodePointSafe(redact(text.replace(/\s+/gu, " ").trim()), max);
	const channel = place.channelName === undefined ? "" : clean(place.channelName, PLACE_NAME_MAX);
	const thread = place.threadName === undefined ? "" : clean(place.threadName, PLACE_NAME_MAX);
	const topic = place.topic === undefined ? "" : clean(place.topic, TOPIC_MAX);
	const where = [channel === "" ? "" : `#${channel}`, thread].filter((part) => part !== "").join(" › ");
	return [...(where === "" ? [] : [`자리: ${where}`]), ...(topic === "" ? [] : [`채널 설명: ${topic}`])];
}

/** The place lines and the owner's `!용도` memos as one prompt block (a new turn only, peer requests too), or null. */
export function purposeBlockOf(deps: MailboxDeps): string | null {
	const lines = [...placeLines(deps), ...purposeLines(deps)];
	return lines.length === 0 ? null : [PURPOSE_HEADER, ...lines].join("\n");
}

/** `!용도`: sets, shows or clears the purpose memo of this thread or channel; answered at once, never sent to omp. */
export function runPurposeCommand(deps: MailboxDeps, row: InboundRow, arg: string): void {
	const { store, originKey, log } = deps;
	const opRef = `purpose:${row.platformMessageId}`;
	store.markDispatched(row.platformMessageId, { opRef, entryCursor: null });
	const ref = parseChatOrigin(originKey);
	const scopes = purposeScopes(deps);
	const place = scopes?.thread === undefined ? "이 채널" : "이 스레드";
	const key = scopes?.thread ?? scopes?.channel;
	let text: string;
	if (row.peerUserId !== null) {
		text = `⚠️ \`${PURPOSE_COMMAND}\`은 오너만 쓸 수 있습니다.`;
	} else if (ref === undefined || key === undefined) {
		text = `⚠️ \`${PURPOSE_COMMAND}\`은 채팅 대화에서만 쓸 수 있습니다.`;
	} else if (arg === "") {
		const shown = purposeLines(deps);
		text =
			shown.length === 0 ? `이 방에는 용도 메모가 없습니다. \`${PURPOSE_COMMAND} <글>\`로 정합니다.` : shown.join("\n");
	} else if (arg === PURPOSE_CLEAR_ARG) {
		text = store.clearPurpose(key) ? `🗑️ ${place}의 용도 메모를 지웠습니다.` : `${place}에는 지울 용도 메모가 없습니다.`;
	} else {
		const error = purposeMemoError(arg);
		if (error === null) {
			store.setPurpose(key, arg);
			log.info("purpose_set", { origin: originKey, scope: key, chars: [...arg].length });
			text = `📌 ${place}의 용도 메모를 저장했습니다.`;
		} else {
			text = error;
		}
	}
	store.recordAnswer({ originKey, opRef, threadRef: row.threadRef, parts: [text] });
}

/** `!home`: this conversation becomes the owner's notice home; answered at once, never sent to omp. */
export function setHome(deps: MailboxDeps, row: InboundRow): void {
	const { store, originKey, log } = deps;
	const opRef = `home:${row.platformMessageId}`;
	store.markDispatched(row.platformMessageId, { opRef, entryCursor: null });
	const ref = parseChatOrigin(originKey);
	let text: string;
	if (ref === undefined) {
		text = "⚠️ `!home`은 채팅 대화에서만 쓸 수 있습니다.";
	} else {
		store.setOwnerHome({ platform: ref.platform, conversationId: ref.conversationId });
		log.info("owner_home_set", { origin: originKey, platform: ref.platform, conversation: ref.conversationId });
		text = "🏠 이 대화를 알림 받을 곳으로 정했습니다. 데몬 알림과 채널 없는 모니터 결과가 여기로 옵니다.";
	}
	store.recordAnswer({ originKey, opRef, threadRef: row.threadRef, parts: [text] });
}
