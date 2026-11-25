import { join } from "node:path";
import type { WebChannelConfig } from "../config-web";
import { GRAMMAR } from "../core/origin-key";
import * as route from "../dashboard/routes";
import { readWebChanges, readWebConversations, readWebMessages, readWebWatermark } from "../store/web-messages";
import {
	authenticateWebRequest,
	createWebAuthState,
	issueCsrfCookie,
	verifyWebCsrf,
	type WebAuthConfig,
	type WebAuthState,
} from "./auth";
import { renderWebMessageHtml } from "./card-html";
import { renderWebChatPage, serveWebChatAsset } from "./chat-page";
import { saveWebUpload } from "./upload";

export { serveWebChatAsset };

export interface WebDashboardOptions {
	homeDir: string;
	auth: WebAuthConfig;
	callDaemon: (request: unknown) => Promise<unknown>;
	/** Interval between `web_messages` change polls on open SSE streams (default 1000 ms). */
	streamPollMs?: number | undefined;
	/** Test seam: schedules the next stream poll and returns its cancel function. */
	streamSchedule?: ((fn: () => void, ms: number) => () => void) | undefined;
	keepAliveMs?: number | undefined;
}

export type EventStreamFn = (
	request: Request,
	keepAliveMs: number,
	subscribe: (send: (chunk: string) => void) => () => void,
) => Response;

export interface WebRouterContext {
	options: WebDashboardOptions;
	auth: WebAuthState;
}

const DEFAULT_POLL_MS = 1_000;
const DEFAULT_KEEP_ALIVE_MS = 15_000;
const MAX_POST_BODY_BYTES = 64 * 1024;

export function createWebRouterContext(options: WebDashboardOptions | undefined): WebRouterContext | undefined {
	return options === undefined ? undefined : { options, auth: createWebAuthState(options.auth) };
}

/** Builds dashboard web-chat options from config when `channels.web.enabled` is true. */
export function webDashboardOptionsFor(
	homeDir: string,
	webConfig: WebChannelConfig | undefined,
	callDaemon: (path: string, request: unknown, timeoutMs?: number) => Promise<unknown>,
): WebDashboardOptions | undefined {
	if (webConfig?.enabled !== true) return undefined;
	const sockPath = join(homeDir, "jabbu.sock");
	return {
		homeDir,
		auth: {
			ownerEmails: webConfig.ownerEmails,
			accessTeamDomain: webConfig.accessTeamDomain,
			accessAud: webConfig.accessAud,
			localTokenPath: join(homeDir, "state", "web-local.token"),
		},
		callDaemon: (request) => callDaemon(sockPath, request, 5_000),
	};
}

function jsonReply(
	body: unknown,
	status: number,
	head: boolean,
	commonHeaders: Record<string, string>,
	extraHeaders: Record<string, string> = {},
): Response {
	return new Response(head ? null : JSON.stringify(body), {
		status,
		headers: { ...commonHeaders, ...extraHeaders, "content-type": "application/json; charset=utf-8" },
	});
}

async function readJsonBody(request: Request): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> {
	let raw: string;
	try {
		raw = await request.text();
	} catch {
		return { ok: false };
	}
	if (Buffer.byteLength(raw, "utf8") > MAX_POST_BODY_BYTES) return { ok: false };
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false };
		return { ok: true, value: parsed as Record<string, unknown> };
	} catch {
		return { ok: false };
	}
}

function nonNegInt(raw: string | null): number | undefined {
	if (raw === null || raw === "") return 0;
	if (!/^\d{1,15}$/.test(raw)) return undefined;
	return Number(raw);
}

/** Compact router bundle used by the dashboard HTTP server to keep route wiring minimal. */
export function webDashboardRouter(
	options: WebDashboardOptions | undefined,
	commonHeaders: Record<string, string>,
	eventStream: EventStreamFn,
) {
	const ctx = createWebRouterContext(options);
	return {
		api: (request: Request, pathname: string, url: URL) =>
			handleWebRequest(request, pathname, url, ctx, commonHeaders, eventStream),
		asset: (request: Request, pathname: string) =>
			serveWebChatAsset(request, pathname, ctx !== undefined, commonHeaders),
		page: (request: Request, url: URL, head: boolean, csp: string) =>
			webChatPageResponse(request, url, ctx, head, commonHeaders, csp),
	};
}

/** Authenticates and server-renders `?view=chat` (with SSR messages/cards and CSRF cookie). */
export async function webChatPageResponse(
	request: Request,
	url: URL,
	ctx: WebRouterContext | undefined,
	head: boolean,
	commonHeaders: Record<string, string>,
	csp: string,
): Promise<Response> {
	if (ctx === undefined) return jsonReply({ error: "web_disabled" }, 404, head, commonHeaders);
	const auth = await authenticateWebRequest(request, ctx.auth);
	if (!auth.ok) return jsonReply({ error: auth.error }, auth.status, head, commonHeaders);
	const csrf = issueCsrfCookie(request, ctx.auth);
	const conversations = readWebConversations(ctx.options.homeDir);
	const requestedConv = url.searchParams.get("c") ?? "";
	const activeConversation =
		GRAMMAR.web.conversation.test(requestedConv) && conversations.some((c) => c.conversation === requestedConv)
			? requestedConv
			: (conversations[0]?.conversation ?? "");
	const messages = activeConversation ? readWebMessages(ctx.options.homeDir, activeConversation) : [];
	const themeParam = url.searchParams.get("theme");
	const theme = themeParam === "dark" || themeParam === "light" ? themeParam : undefined;
	const html = renderWebChatPage({ conversations, activeConversation, messages, csrfToken: csrf.token, theme });
	return new Response(head ? null : html, {
		headers: {
			...commonHeaders,
			"content-type": "text/html; charset=utf-8",
			"content-security-policy": csp,
			"set-cookie": csrf.cookie,
		},
	});
}

function handleStream(
	request: Request,
	url: URL,
	ctx: WebRouterContext,
	head: boolean,
	commonHeaders: Record<string, string>,
	eventStream: EventStreamFn,
): Response {
	const conversationParam = url.searchParams.get("c");
	const conversation = conversationParam === null || conversationParam === "" ? undefined : conversationParam;
	if (conversation !== undefined && !GRAMMAR.web.conversation.test(conversation)) {
		return jsonReply({ error: "invalid_conversation" }, 400, head, commonHeaders);
	}
	const after = nonNegInt(url.searchParams.get("after"));
	const afterEdited = nonNegInt(url.searchParams.get("afterEdited"));
	if (after === undefined || afterEdited === undefined) {
		return jsonReply({ error: "invalid_cursor" }, 400, head, commonHeaders);
	}
	if (head) {
		return new Response(null, {
			headers: { ...commonHeaders, "content-type": "text/event-stream; charset=utf-8" },
		});
	}
	const schedule =
		ctx.options.streamSchedule ??
		((fn: () => void, ms: number) => {
			const timer = setTimeout(fn, ms);
			return () => clearTimeout(timer);
		});
	const pollMs = ctx.options.streamPollMs ?? DEFAULT_POLL_MS;
	const keepAliveMs = ctx.options.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS;

	return eventStream(request, keepAliveMs, (send) => {
		let open = true;
		let cancel: (() => void) | undefined;
		let lastId = after;
		let lastEditedAt = afterEdited;

		const poll = (): void => {
			cancel = undefined;
			if (!open) return;
			const mark = readWebWatermark(ctx.options.homeDir, conversation);
			if (mark.maxId > lastId || mark.maxEditedAt > lastEditedAt) {
				const changes = readWebChanges(ctx.options.homeDir, lastId, lastEditedAt, conversation, 200);
				if (changes.length < 200) {
					lastId = mark.maxId;
					lastEditedAt = mark.maxEditedAt;
				} else {
					const tail = changes.at(-1);
					if (tail !== undefined) {
						lastId = Math.max(lastId, tail.id);
						if (tail.editedAt !== null) lastEditedAt = Math.max(lastEditedAt, tail.editedAt);
					}
				}
				if (changes.length > 0) {
					const enriched = changes.map((row) => ({ ...row, html: renderWebMessageHtml(row) }));
					send(`event: messages\ndata: ${JSON.stringify({ messages: enriched })}\n\n`);
				}
			}
			if (open) cancel = schedule(poll, pollMs);
		};

		send(": web\n\n");
		cancel = schedule(poll, 0);
		return () => {
			open = false;
			cancel?.();
			cancel = undefined;
		};
	});
}

async function forwardDaemonOp(
	ctx: WebRouterContext,
	opPayload: Record<string, unknown>,
	commonHeaders: Record<string, string>,
): Promise<Response> {
	let answer: unknown;
	try {
		answer = await ctx.options.callDaemon(opPayload);
	} catch {
		return jsonReply({ error: "daemon_unreachable" }, 503, false, commonHeaders);
	}
	if (typeof answer !== "object" || answer === null || !("ok" in answer)) {
		return jsonReply({ error: "daemon_invalid_response" }, 502, false, commonHeaders);
	}
	const record = answer as { ok?: unknown; error?: unknown };
	if (record.ok !== true) {
		return jsonReply(
			{ error: typeof record.error === "string" ? record.error : "request_failed" },
			400,
			false,
			commonHeaders,
		);
	}
	return jsonReply(answer, 200, false, commonHeaders);
}

/** Handles all `/api/web/*` endpoints with authentication, CSRF verification on POST, and SSE streaming. */
export async function handleWebRequest(
	request: Request,
	pathname: string,
	url: URL,
	ctx: WebRouterContext | undefined,
	commonHeaders: Record<string, string>,
	eventStream: EventStreamFn,
): Promise<Response> {
	const head = request.method === "HEAD";
	if (ctx === undefined) return jsonReply({ error: "web_disabled" }, 404, head, commonHeaders);

	const auth = await authenticateWebRequest(request, ctx.auth);
	if (!auth.ok) return jsonReply({ error: auth.error }, auth.status, head, commonHeaders);

	const readMethod = request.method === "GET" || head;
	if (request.method === "POST") {
		const csrf = verifyWebCsrf(request, ctx.auth);
		if (!csrf.ok) return jsonReply({ error: csrf.error }, 403, false, commonHeaders);
		if (route.WEB_UPLOAD.test(pathname)) {
			const uploaded = await saveWebUpload(request, ctx.options.homeDir);
			return uploaded.ok
				? jsonReply(uploaded, 200, false, commonHeaders)
				: jsonReply({ error: uploaded.error }, uploaded.status, false, commonHeaders);
		}
		const body = await readJsonBody(request);
		if (!body.ok) return jsonReply({ error: "invalid_json" }, 400, false, commonHeaders);

		if (route.WEB_NEW.test(pathname)) {
			return forwardDaemonOp(ctx, { op: "web_new", title: body.value.title }, commonHeaders);
		}
		if (route.WEB_SEND.test(pathname)) {
			return forwardDaemonOp(
				ctx,
				{
					op: "web_send",
					conversation: body.value.conversation,
					thread: body.value.thread,
					text: body.value.text,
					files: body.value.files,
				},
				commonHeaders,
			);
		}
		if (route.WEB_ACTION.test(pathname)) {
			return forwardDaemonOp(
				ctx,
				{
					op: "web_action",
					actionId: body.value.actionId,
					value: body.value.value,
					messageId: body.value.messageId,
				},
				commonHeaders,
			);
		}
		return jsonReply({ error: "not_found" }, 404, false, commonHeaders);
	}

	if (!readMethod) {
		return new Response("method not allowed\n", {
			status: 405,
			headers: { ...commonHeaders, allow: "GET, HEAD, POST", "content-type": "text/plain; charset=utf-8" },
		});
	}

	if (route.WEB_CONVERSATIONS.test(pathname)) {
		const csrf = issueCsrfCookie(request, ctx.auth);
		return jsonReply(
			{ conversations: readWebConversations(ctx.options.homeDir), csrfToken: csrf.token },
			200,
			head,
			commonHeaders,
			{ "set-cookie": csrf.cookie, "x-jabbu-csrf": csrf.token },
		);
	}

	if (route.WEB_MESSAGES.test(pathname)) {
		const conversation = url.searchParams.get("c") ?? "";
		if (!GRAMMAR.web.conversation.test(conversation)) {
			return jsonReply({ error: "invalid_conversation" }, 400, head, commonHeaders);
		}
		const threadParam = url.searchParams.get("t");
		const thread = threadParam === null || threadParam === "" ? undefined : threadParam;
		if (thread !== undefined && !GRAMMAR.web.thread.test(thread)) {
			return jsonReply({ error: "invalid_thread" }, 400, head, commonHeaders);
		}
		const after = nonNegInt(url.searchParams.get("after"));
		if (after === undefined) return jsonReply({ error: "invalid_cursor" }, 400, head, commonHeaders);
		const csrf = issueCsrfCookie(request, ctx.auth);
		return jsonReply(
			{
				messages: readWebMessages(ctx.options.homeDir, conversation, { thread, after }).map((row) => ({
					...row,
					html: renderWebMessageHtml(row),
				})),
			},
			200,
			head,
			commonHeaders,
			{ "set-cookie": csrf.cookie, "x-jabbu-csrf": csrf.token },
		);
	}

	if (route.WEB_STREAM.test(pathname)) return handleStream(request, url, ctx, head, commonHeaders, eventStream);
	return jsonReply({ error: "not_found" }, 404, head, commonHeaders);
}
