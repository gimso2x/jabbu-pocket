import { join } from "node:path";
import type { JabbuConfig } from "../config";
import type { WebChannelConfig } from "../config-web";
import { GRAMMAR } from "../core/origin-key";
import * as route from "../dashboard/routes";
import {
	parentMessageIdOfThread,
	readWebConversations,
	readWebMessageById,
	readWebMessages,
	readWebThreads,
} from "../store/web-messages";
import {
	authenticateWebRequest,
	createWebAuthState,
	issueCsrfCookie,
	verifyWebCsrf,
	type WebAuthConfig,
	type WebAuthState,
} from "./auth";
import {
	accentForBot,
	resolveBotTarget,
	resolveWebBots,
	slugOfBotHome,
	summarizeWebBots,
	WEB_IPC_TIMEOUT_MS,
	type WebBotTarget,
} from "./bots";
import { renderWebMessageHtml } from "./card-html";
import { renderWebChatPage, serveWebChatAsset } from "./chat-page";
import { serveWebFile } from "./file-serve";
import { type EventStreamFn, handleWebStream, nonNegInt } from "./stream";
import { saveWebUpload } from "./upload";

export type { EventStreamFn };
export { serveWebChatAsset };

export interface WebDashboardOptions {
	homeDir: string;
	auth: WebAuthConfig;
	callDaemon: WebBotTarget["callDaemon"];
	bots?: readonly WebBotTarget[] | undefined;
	botName?: string | undefined;
	/** Interval between `web_messages` change polls on open SSE streams (default 1000 ms). */
	streamPollMs?: number | undefined;
	/** Test seam: schedules the next stream poll and returns its cancel function. */
	streamSchedule?: ((fn: () => void, ms: number) => () => void) | undefined;
	keepAliveMs?: number | undefined;
}

export interface WebRouterContext {
	options: WebDashboardOptions;
	auth: WebAuthState;
	bots: readonly WebBotTarget[];
}

const MAX_POST_BODY_BYTES = 64 * 1024;
/**
 * `POST api/web/task/<TASK-ID>/followup|pause|resume`: the dashboard's 작업 내역 panel. The main bot's [TASK]s only
 * (the panel's `api/thread/*` reads are the main home's), each a daemon IPC op that waits like `jabbu-pocket tasks`.
 */
const WEB_TASK_OP = /^\/(?:.*\/)?api\/web\/task\/(T-\d{8}-\d{2,})\/(followup|pause|resume)$/;
/** The [TASK] ops' IPC wait (`IPC_TIMEOUT_MS` of `src/cli/tasks.ts`): a pause waits for the worker's turn to stop. */
const WEB_TASK_IPC_TIMEOUT_MS = 60_000;

export function createWebRouterContext(options: WebDashboardOptions | undefined): WebRouterContext | undefined {
	if (options === undefined) return undefined;
	const defaultId = slugOfBotHome(options.homeDir, "main");
	const bots =
		options.bots && options.bots.length > 0
			? options.bots
			: [
					{
						id: defaultId,
						name: options.botName ?? "송박",
						homeDir: options.homeDir,
						callDaemon: options.callDaemon,
						accent: accentForBot(defaultId, 0),
					},
				];
	return { options, auth: createWebAuthState(options.auth), bots };
}

/** Builds dashboard web-chat options from config when `channels.web.enabled` is true. */
export function webDashboardOptionsFor(
	homeDir: string,
	webConfig: WebChannelConfig | undefined,
	callDaemon: (path: string, request: unknown, timeoutMs?: number) => Promise<unknown>,
	config?: JabbuConfig,
): WebDashboardOptions | undefined {
	if (webConfig?.enabled !== true) return undefined;
	const sockPath = join(homeDir, "jabbu.sock");
	const bots = config === undefined ? undefined : resolveWebBots(homeDir, config, callDaemon);
	return {
		homeDir,
		auth: {
			ownerEmails: webConfig.ownerEmails,
			accessTeamDomain: webConfig.accessTeamDomain,
			accessAud: webConfig.accessAud,
			localTokenPath: join(homeDir, "state", "web-local.token"),
		},
		callDaemon: (request, timeoutMs = WEB_IPC_TIMEOUT_MS) => callDaemon(sockPath, request, timeoutMs),
		...(bots === undefined ? {} : { bots }),
		...(config?.channels.discord?.displayName === undefined ? {} : { botName: config.channels.discord.displayName }),
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

/** The POST body as a JSON object; `allowEmpty` reads an empty body as `{}` (a pause or resume carries nothing). */
async function readJsonBody(
	request: Request,
	allowEmpty = false,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; tooLarge: boolean }> {
	// The cap is enforced while streaming, like the upload path: a body far past 64KiB is cancelled after one chunk
	// too many instead of being buffered whole first. A lying Content-Length is caught by the same streaming check.
	const declared = Number(request.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_POST_BODY_BYTES) return { ok: false, tooLarge: true };
	const decoder = new TextDecoder();
	let raw = "";
	let total = 0;
	if (request.body !== null) {
		const reader = request.body.getReader();
		try {
			for (;;) {
				const next = await reader.read();
				if (next.done) break;
				total += next.value.byteLength;
				if (total > MAX_POST_BODY_BYTES) {
					await reader.cancel().catch(() => undefined);
					return { ok: false, tooLarge: true };
				}
				raw += decoder.decode(next.value, { stream: true });
			}
		} catch {
			return { ok: false, tooLarge: false };
		} finally {
			reader.releaseLock();
		}
	}
	raw += decoder.decode();
	if (allowEmpty && raw.trim() === "") return { ok: true, value: {} };
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false, tooLarge: false };
		return { ok: true, value: parsed as Record<string, unknown> };
	} catch {
		return { ok: false, tooLarge: false };
	}
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

/** Authenticates and server-renders `?view=chat` (with 3-pane multi-bot + thread SSR and CSRF cookie). */
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
	const target = resolveBotTarget(ctx.bots, url.searchParams.get("bot")) ?? ctx.bots[0];
	if (target === undefined) return jsonReply({ error: "web_disabled" }, 404, head, commonHeaders);
	const conversations = readWebConversations(target.homeDir);
	const requestedConv = url.searchParams.get("c") ?? "";
	const activeConversation =
		GRAMMAR.web.conversation.test(requestedConv) && conversations.some((c) => c.conversation === requestedConv)
			? requestedConv
			: (conversations[0]?.conversation ?? "");
	const messages = activeConversation ? readWebMessages(target.homeDir, activeConversation) : [];
	const threads = activeConversation ? readWebThreads(target.homeDir, activeConversation) : [];
	const reqThread = url.searchParams.get("t") ?? "";
	const activeThread = activeConversation && GRAMMAR.web.thread.test(reqThread) ? reqThread : "";
	const threadMessages = activeThread
		? readWebMessages(target.homeDir, activeConversation, { thread: activeThread })
		: [];
	const parentId = activeThread ? parentMessageIdOfThread(activeThread) : undefined;
	const rawParent = parentId !== undefined ? readWebMessageById(target.homeDir, parentId) : undefined;
	const parentMessage = rawParent?.conversation === activeConversation ? rawParent : undefined;
	const themeParam = url.searchParams.get("theme");
	const theme = themeParam === "dark" || themeParam === "light" ? themeParam : undefined;
	const html = renderWebChatPage({
		conversations,
		activeConversation,
		messages,
		csrfToken: csrf.token,
		theme,
		bots: summarizeWebBots(ctx.bots),
		activeBot: target.id,
		threads,
		...(activeThread ? { activeThread, threadMessages, parentMessage } : {}),
	});
	return new Response(head ? null : html, {
		headers: {
			...commonHeaders,
			"content-type": "text/html; charset=utf-8",
			"content-security-policy": csp,
			"set-cookie": csrf.cookie,
		},
	});
}

async function forwardDaemonOp(
	callDaemon: WebBotTarget["callDaemon"],
	opPayload: Record<string, unknown>,
	commonHeaders: Record<string, string>,
	timeoutMs: number = WEB_IPC_TIMEOUT_MS,
): Promise<Response> {
	let answer: unknown;
	try {
		answer = await callDaemon(opPayload, timeoutMs);
	} catch {
		return jsonReply({ error: "daemon_unreachable" }, 503, false, commonHeaders);
	}
	if (typeof answer !== "object" || answer === null || !("ok" in answer))
		return jsonReply({ error: "daemon_invalid_response" }, 502, false, commonHeaders);
	const record = answer as { ok?: unknown; error?: unknown; text?: unknown };
	if (record.ok !== true) {
		return jsonReply(
			{
				error: typeof record.error === "string" ? record.error : "request_failed",
				...(typeof record.text === "string" ? { text: record.text } : {}),
			},
			400,
			false,
			commonHeaders,
		);
	}
	return jsonReply(answer, 200, false, commonHeaders);
}

/** Handles all `/api/web/*` endpoints with authentication, multi-bot selection, CSRF verification on POST, and SSE. */
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

	if (request.method === "POST") {
		const csrf = verifyWebCsrf(request, ctx.auth);
		if (!csrf.ok) return jsonReply({ error: csrf.error }, 403, false, commonHeaders);
		if (route.WEB_UPLOAD.test(pathname)) {
			const target = resolveBotTarget(ctx.bots, url.searchParams.get("bot"));
			if (target === undefined) return jsonReply({ error: "invalid_bot" }, 400, false, commonHeaders);
			const uploaded = await saveWebUpload(request, target.homeDir);
			return uploaded.ok
				? jsonReply(uploaded, 200, false, commonHeaders)
				: jsonReply({ error: uploaded.error }, uploaded.status, false, commonHeaders);
		}
		const taskOp = WEB_TASK_OP.exec(pathname);
		const body = await readJsonBody(request, taskOp !== null);
		if (!body.ok) {
			const error = body.tooLarge ? "body_too_large" : "invalid_json";
			return jsonReply({ error }, body.tooLarge ? 413 : 400, false, commonHeaders);
		}
		const rawBot = typeof body.value.bot === "string" ? body.value.bot : url.searchParams.get("bot");
		const target = resolveBotTarget(ctx.bots, rawBot);
		if (target === undefined) return jsonReply({ error: "invalid_bot" }, 400, false, commonHeaders);

		if (taskOp !== null) {
			// A peer bot's [TASK] is not intervened in from here (its sessions are not this dashboard's to show).
			if (target !== ctx.bots[0]) return jsonReply({ error: "invalid_bot" }, 400, false, commonHeaders);
			const [, id, action] = taskOp;
			const payload =
				action === "followup"
					? { op: "task_followup", id, text: body.value.text }
					: { op: action === "pause" ? "tasks_pause" : "tasks_resume", id, source: "web" };
			return forwardDaemonOp(target.callDaemon, payload, commonHeaders, WEB_TASK_IPC_TIMEOUT_MS);
		}

		if (route.WEB_NEW.test(pathname)) {
			return forwardDaemonOp(target.callDaemon, { op: "web_new", title: body.value.title }, commonHeaders);
		}
		if (route.WEB_SEND.test(pathname)) {
			return forwardDaemonOp(
				target.callDaemon,
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
				target.callDaemon,
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

	if (request.method !== "GET" && !head) {
		return new Response("method not allowed\n", {
			status: 405,
			headers: { ...commonHeaders, allow: "GET, HEAD, POST", "content-type": "text/plain; charset=utf-8" },
		});
	}

	const target = resolveBotTarget(ctx.bots, url.searchParams.get("bot"));
	if (target === undefined) return jsonReply({ error: "invalid_bot" }, 400, head, commonHeaders);

	if (route.WEB_CONVERSATIONS.test(pathname)) {
		const csrf = issueCsrfCookie(request, ctx.auth);
		return jsonReply(
			{
				bot: target.id,
				bots: summarizeWebBots(ctx.bots),
				conversations: readWebConversations(target.homeDir),
				csrfToken: csrf.token,
			},
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
		const msgs = readWebMessages(target.homeDir, conversation, { thread, after }).map((row) => ({
			...row,
			html: renderWebMessageHtml(row, { botId: target.id }),
		}));
		return jsonReply(
			{
				bot: target.id,
				messages: msgs,
				...(thread === undefined ? { threads: readWebThreads(target.homeDir, conversation) } : {}),
			},
			200,
			head,
			commonHeaders,
			{ "set-cookie": csrf.cookie, "x-jabbu-csrf": csrf.token },
		);
	}
	if (route.WEB_FILE.test(pathname)) return serveWebFile(target.homeDir, url, head, commonHeaders);
	if (route.WEB_STREAM.test(pathname)) {
		return handleWebStream(request, url, ctx.options, target, head, commonHeaders, eventStream);
	}
	return jsonReply({ error: "not_found" }, 404, head, commonHeaders);
}
