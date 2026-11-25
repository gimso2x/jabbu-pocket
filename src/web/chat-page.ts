import { esc } from "../dashboard/text";
import {
	threadIdForMessage,
	type WebConversationSummary,
	type WebMessageRow,
	type WebThreadSummary,
} from "../store/web-messages";
import type { WebBotSummary } from "./bots";
import { renderWebMessageHtml } from "./card-html";
import { CHAT_SCRIPT } from "./chat-client";
import { CHAT_CSS } from "./chat-style";

const CHAT_ASSET_PATTERN = /^\/(?:.*\/)?chat-([0-9a-f]{12})\.(js|css)$/;
interface ChatAsset {
	name: string;
	type: string;
	body: string;
	gzip: Uint8Array<ArrayBuffer>;
}
let cached: { css: ChatAsset; js: ChatAsset } | undefined;

function buildAsset(body: string, ext: "css" | "js", type: string): ChatAsset {
	const hash = new Bun.CryptoHasher("sha256").update(body).digest("hex").slice(0, 12);
	return { name: `chat-${hash}.${ext}`, type, body, gzip: Bun.gzipSync(body, { level: 9 }) };
}

/** Content-hashed CSS/JS assets exclusively for `?view=chat`. */
export function webChatAssets(): { css: ChatAsset; js: ChatAsset } {
	if (cached?.css.body !== CHAT_CSS || cached?.js.body !== CHAT_SCRIPT) {
		cached = {
			css: buildAsset(CHAT_CSS, "css", "text/css; charset=utf-8"),
			js: buildAsset(CHAT_SCRIPT, "js", "text/javascript; charset=utf-8"),
		};
	}
	return cached;
}

/** Serves `chat-<hash>.{css,js}` only when `webEnabled` is true (`undefined` otherwise). */
export function serveWebChatAsset(
	request: Request,
	pathname: string,
	webEnabled: boolean,
	commonHeaders: Record<string, string>,
): Response | undefined {
	const match = CHAT_ASSET_PATTERN.exec(pathname);
	if (match === null) return undefined;
	if (!webEnabled) {
		return new Response("not found\n", {
			status: 404,
			headers: { ...commonHeaders, "content-type": "text/plain; charset=utf-8" },
		});
	}
	const assets = webChatAssets();
	const found = match[2] === "css" ? assets.css : assets.js;
	if (found.name !== pathname.slice(pathname.lastIndexOf("/") + 1)) {
		return new Response("not found\n", {
			status: 404,
			headers: { ...commonHeaders, "content-type": "text/plain; charset=utf-8" },
		});
	}
	return new Response(request.method === "HEAD" ? null : found.body, {
		headers: { ...commonHeaders, "content-type": found.type, "cache-control": "public, max-age=31536000, immutable" },
	});
}

function parseButtons(raw: string | null): Array<{ actionId: string; label: string; style?: string }> {
	if (raw === null) return [];
	try {
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed) ? (parsed as Array<{ actionId: string; label: string; style?: string }>) : [];
	} catch {
		return [];
	}
}

function isDeletedStatus(row: WebMessageRow): boolean {
	if (row.role !== "status" || row.cardJson === null) return false;
	try {
		return Boolean((JSON.parse(row.cardJson) as { deleted?: unknown }).deleted);
	} catch {
		return false;
	}
}

function renderSsrTimeline(
	rows: WebMessageRow[],
	botId: string,
	botName: string,
	botAccent: string,
	threadsByParent: Map<number, WebThreadSummary>,
	allowThreadBtn: boolean,
): string {
	let prevRole = "";
	let prevAt = 0;
	return rows
		.map((row) => {
			if (row.role === "system") {
				prevRole = "";
				return row.text ? `<div class="wc-msg-system" data-msg-id="${row.id}">${esc(row.text)}</div>` : "";
			}
			if (row.role === "status") {
				const cls = isDeletedStatus(row) ? " is-deleted" : "";
				return `<div class="wc-msg-status${cls}" data-msg-id="${row.id}"><span class="wc-spin"></span><span>${esc(row.text)}</span></div>`;
			}
			const isSpecial = row.role === "approval" || row.role === "choice";
			const cont = !isSpecial && row.role === prevRole && Math.abs(row.createdAt - prevAt) < 300_000;
			prevRole = isSpecial ? "" : row.role;
			prevAt = row.createdAt;
			const isOwner = row.role === "owner";
			const btns = parseButtons(row.buttonsJson);
			const btnsHtml =
				btns.length > 0
					? `<div class="wc-actions">${btns
							.map((b) => {
								const cls = b.style === "primary" ? " wc-btn-primary" : b.style === "danger" ? " wc-btn-danger" : "";
								return `<button type="button" class="wc-act-btn${cls}" data-action-id="${esc(b.actionId)}" data-message-id="${row.id}">${esc(b.label)}</button>`;
							})
							.join("")}</div>`
					: "";
			const bodyHtml = renderWebMessageHtml(row, { botId });
			const tId = threadIdForMessage(row.id);
			const summary = allowThreadBtn ? threadsByParent.get(row.id) : undefined;
			const tBar =
				summary !== undefined && summary.replyCount > 0
					? `<button type="button" class="wc-thread-bar" data-open-thread="${esc(summary.thread)}" data-parent-id="${row.id}"><span>🧵 답글 ${summary.replyCount}개</span><span class="wc-thread-bar-prev">${esc(summary.lastText)}</span></button>`
					: "";
			const left = cont
				? '<span class="wc-row-time-side"></span>'
				: `<div class="wc-avatar${isOwner ? " wc-avatar-owner" : ""}" style="${isOwner ? "" : `--av-bg:${esc(botAccent)}`}">${esc(isOwner ? "나" : botName.slice(0, 1))}</div>`;
			const head = cont
				? ""
				: `<div class="wc-row-head"><span class="wc-sender">${esc(isOwner ? "나" : botName)}</span>${isOwner ? "" : '<span class="wc-bot-badge">BOT</span>'}<span class="wc-time"></span></div>`;
			const tools = allowThreadBtn
				? `<div class="wc-msg-tools"><button type="button" class="wc-tool-btn" data-open-thread="${esc(tId)}" data-parent-id="${row.id}">🧵 스레드</button><button type="button" class="wc-tool-btn" data-copy="${esc(row.text)}">복사</button></div>`
				: "";
			return `<div class="wc-row wc-msg-${row.role}${cont ? " is-cont" : ""}" data-msg-id="${row.id}">${left}<div class="wc-row-body">${head}${bodyHtml}${btnsHtml}${tBar}</div>${tools}</div>`;
		})
		.join("");
}

function renderSsrConversations(convs: WebConversationSummary[], activeConversation: string): string {
	if (convs.length === 0) return '<div class="wc-muted" style="padding:12px">대화가 없습니다</div>';
	const groups: Array<{ label: string; cls: string; items: WebConversationSummary[] }> = [
		{ label: "내 차례", cls: "is-turn", items: convs.filter((c) => c.openApprovals > 0) },
		{ label: "진행 중", cls: "is-run", items: convs.filter((c) => c.openApprovals === 0 && c.inProgress) },
		{ label: "최근 대화", cls: "", items: convs.filter((c) => c.openApprovals === 0 && !c.inProgress) },
	];
	return groups
		.filter((g) => g.items.length > 0)
		.map((g) => {
			const head = `<div class="wc-grp-head ${g.cls}"><span>${g.label}</span><span>${g.items.length}</span></div>`;
			const rows = g.items
				.map((c) => {
					const act = c.conversation === activeConversation ? " is-active" : "";
					const mark =
						c.openApprovals > 0
							? '<span class="wc-mark wc-mark-turn">!</span>'
							: c.inProgress
								? '<span class="wc-spin"></span>'
								: '<span class="wc-mark"><span class="wc-mark-idle"></span></span>';
					const tChip = c.threadCount > 0 ? `<span class="wc-tchip">🧵 ${c.threadCount}</span>` : "";
					return `<button type="button" class="wc-conv-item${act}" data-conv="${esc(c.conversation)}"><div class="wc-conv-row">${mark}<span class="wc-conv-name">${esc(c.title || c.conversation)}</span></div><div class="wc-conv-sub"><span class="wc-conv-prev">${esc(c.lastText || "대기 중")}</span>${tChip}</div></button>`;
				})
				.join("");
			return head + rows;
		})
		.join("");
}

/** Server-rendered `?view=chat` 3-pane Slack/Discord + Hide UI loading only `chat-<hash>.{css,js}`. */
export function renderWebChatPage(options: {
	conversations: WebConversationSummary[];
	activeConversation: string;
	messages: WebMessageRow[];
	csrfToken: string;
	theme?: "dark" | "light" | undefined;
	bots?: WebBotSummary[] | undefined;
	activeBot?: string | undefined;
	threads?: WebThreadSummary[] | undefined;
	activeThread?: string | undefined;
	threadMessages?: WebMessageRow[] | undefined;
	parentMessage?: WebMessageRow | undefined;
}): string {
	const assets = webChatAssets();
	const bots: WebBotSummary[] =
		options.bots && options.bots.length > 0
			? options.bots
			: [
					{
						id: "songbak",
						name: "송박",
						accent: "#58A6FF",
						conversationCount: options.conversations.length,
						openApprovals: 0,
						inProgress: false,
					},
				];
	const activeBot = options.activeBot ?? bots[0]?.id ?? "songbak";
	const botInfo = bots.find((b) => b.id === activeBot) ?? bots[0] ?? { id: "songbak", name: "송박", accent: "#58A6FF" };
	const threads = options.threads ?? [];
	const threadsByParent = new Map<number, WebThreadSummary>();
	for (const t of threads) {
		if (t.parentMessageId !== undefined) threadsByParent.set(t.parentMessageId, t);
	}
	const activeSummary = options.conversations.find((c) => c.conversation === options.activeConversation);
	const title = activeSummary?.title || options.activeConversation || "새 대화";
	const turnCount = options.conversations.filter((c) => c.openApprovals > 0).length;
	const runCount = options.conversations.filter((c) => c.inProgress).length;
	const sigHtml = [
		turnCount > 0 ? `<span class="wc-sig wc-sig-turn">내 차례 ${turnCount}</span>` : "",
		runCount > 0 ? `<span class="wc-sig wc-sig-run">진행 중 ${runCount}</span>` : "",
	].join("");
	const botItems = bots
		.map((b) => {
			const act = b.id === activeBot ? " is-active" : "";
			const badges = [
				b.openApprovals > 0 ? `<span class="wc-pill wc-pill-warn">! ${b.openApprovals}</span>` : "",
				b.inProgress ? '<span class="wc-spin"></span>' : "",
			].join("");
			return `<button type="button" class="wc-bot-item${act}" data-bot="${esc(b.id)}" style="--bot-accent:${esc(b.accent)}"><span class="wc-bot-left"><span class="wc-bot-dot" style="background:${esc(b.accent)}"></span><span>#${esc(b.name)}</span></span><span class="wc-bot-meta">${badges}<span>${b.conversationCount}</span></span></button>`;
		})
		.join("");
	const enriched = options.messages.map((m) => ({ ...m, html: renderWebMessageHtml(m, { botId: activeBot }) }));
	const enrichedThread = (options.threadMessages ?? []).map((m) => ({
		...m,
		html: renderWebMessageHtml(m, { botId: activeBot }),
	}));
	const messagesHtml =
		options.activeConversation === ""
			? '<div class="wc-empty">왼쪽에서 대화를 고르거나 새 대화를 여세요.</div>'
			: options.messages.filter((m) => !(m.role === "system" && !m.text)).length === 0
				? '<div class="wc-empty">대화를 시작해 보세요. 파일 첨부나 이미지 붙여넣기도 됩니다.</div>'
				: renderSsrTimeline(options.messages, activeBot, botInfo.name, botInfo.accent, threadsByParent, true);
	const activeThread = options.activeThread ?? "";
	const threadHtml = renderSsrTimeline(
		options.threadMessages ?? [],
		activeBot,
		botInfo.name,
		botInfo.accent,
		threadsByParent,
		false,
	);
	const parentHtml = options.parentMessage
		? `<div class="wc-thread-parent-meta">${esc(options.parentMessage.role === "owner" ? "나" : botInfo.name)}</div><div>${renderWebMessageHtml(options.parentMessage, { botId: activeBot })}</div>`
		: activeThread
			? `<div class="wc-thread-parent-meta">스레드 ${esc(activeThread)}</div>`
			: "";
	const initPayload = JSON.stringify({
		activeBot,
		bots,
		activeConversation: options.activeConversation,
		conversations: options.conversations,
		messages: enriched,
		threads,
		activeThread,
		threadMessages: enrichedThread,
		parentMessage: options.parentMessage
			? { ...options.parentMessage, html: renderWebMessageHtml(options.parentMessage, { botId: activeBot }) }
			: null,
	}).replace(/</g, "\\u003c");
	const themeAttr = options.theme ? ` data-theme="${options.theme}"` : "";

	return `<!doctype html>
<html lang="ko"${themeAttr}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="jabbu-csrf" content="${esc(options.csrfToken)}">
<title>${esc(title)} · #${esc(botInfo.name)} · jabbu 웹 대화</title>
<link rel="stylesheet" href="${assets.css.name}">
</head>
<body>
<div class="wc-app">
  <header class="wc-topbar">
    <div class="wc-top-left">
      <button type="button" id="wc-menu" class="wc-btn-icon wc-btn-menu" aria-label="대화 목록">☰</button>
      <span class="wc-brand"><span class="wc-brand-dot" style="background:${esc(botInfo.accent)}"></span><span>jabbu 대화</span></span>
      <span id="wc-sig-summary" class="wc-top-left">${sigHtml}</span>
      <span id="wc-sse-state" class="wc-sig wc-sig-sse is-wait"><i></i><span>연결 중</span></span>
    </div>
    <div class="wc-top-right">
      <button type="button" id="wc-cmdk" class="wc-btn wc-btn-ghost">이동 <span class="wc-kbd">⌘K</span></button>
      <a class="wc-btn wc-btn-ghost" href="./">현황판</a>
      <button type="button" id="wc-theme" class="wc-btn">테마</button>
    </div>
  </header>
  <div id="wc-body" class="wc-body${activeThread ? " has-thread" : ""}">
    <div id="wc-backdrop" class="wc-backdrop"></div>
    <aside id="wc-sidebar" class="wc-sidebar" aria-label="에이전트 및 웹 대화 목록">
      <div class="wc-rail-sec">
        <div class="wc-rail-head"><span>에이전트</span></div>
        <div id="wc-bot-list" class="wc-bot-list">${botItems}</div>
      </div>
      <div class="wc-search-wrap">
        <input type="search" id="wc-search" class="wc-search" placeholder="대화 찾기" aria-label="대화 검색">
        <button type="button" id="wc-new" class="wc-btn wc-btn-primary">+ 새 대화</button>
      </div>
      <div id="wc-conv-list" class="wc-conv-list">${renderSsrConversations(options.conversations, options.activeConversation)}</div>
    </aside>
    <main id="wc-main" class="wc-main">
      <div class="wc-chan-head">
        <div class="wc-chan-left"><span class="wc-chan-hash">#</span><h1 id="wc-conv-title" class="wc-title">${esc(title)}</h1><span id="wc-chan-bot" class="wc-bot-tag"><span class="wc-bot-dot" style="background:${esc(botInfo.accent)}"></span><span>${esc(botInfo.name)}</span></span></div>
        <button type="button" id="wc-threads-toggle" class="wc-btn wc-btn-ghost"${threads.length > 0 ? "" : " hidden"}>🧵 스레드 ${threads.length}</button>
      </div>
      <div id="wc-messages" class="wc-messages">${messagesHtml}</div>
      <div class="wc-composer-wrap">
        <div id="wc-error" class="wc-error" role="alert" hidden></div>
        <div class="wc-composer-box">
          <div id="wc-pending-files" class="wc-pending-files" hidden></div>
          <div class="wc-composer">
            <input type="file" id="wc-file-input" multiple hidden>
            <button type="button" id="wc-attach" class="wc-btn-icon wc-btn-ghost" aria-label="파일 첨부">📎</button>
            <textarea id="wc-input" class="wc-input" rows="1" placeholder="${esc(botInfo.name)}에게 메시지 보내기" aria-label="메시지 입력"></textarea>
            <button type="button" id="wc-send" class="wc-btn wc-btn-primary">전송</button>
          </div>
        </div>
      </div>
    </main>
    <aside id="wc-thread-pane" class="wc-thread-pane" aria-label="스레드">
      <div class="wc-thread-head">
        <span id="wc-thread-title" class="wc-thread-title">🧵 스레드</span>
        <button type="button" id="wc-thread-close" class="wc-btn wc-btn-ghost" aria-label="스레드 닫기">닫기</button>
      </div>
      <div id="wc-thread-parent" class="wc-thread-parent"${parentHtml ? "" : " hidden"}>${parentHtml}</div>
      <div id="wc-thread-messages" class="wc-thread-messages">${threadHtml}</div>
      <div class="wc-composer-wrap">
        <div id="wc-thread-error" class="wc-error" role="alert" hidden></div>
        <div class="wc-composer-box">
          <div id="wc-thread-pending" class="wc-pending-files" hidden></div>
          <div class="wc-composer">
            <input type="file" id="wc-thread-file-input" multiple hidden>
            <button type="button" id="wc-thread-attach" class="wc-btn-icon wc-btn-ghost" aria-label="스레드 파일 첨부">📎</button>
            <textarea id="wc-thread-input" class="wc-input" rows="1" placeholder="스레드에 답글 쓰기" aria-label="스레드 입력"></textarea>
            <button type="button" id="wc-thread-send" class="wc-btn wc-btn-primary">답글</button>
          </div>
        </div>
      </div>
    </aside>
  </div>
</div>
<div id="wc-pal-modal" class="wc-modal" hidden>
  <div class="wc-palette" role="dialog" aria-label="빠른 이동">
    <input type="text" id="wc-pal-input" class="wc-palette-in" placeholder="봇 또는 대화 이름으로 이동…">
    <div id="wc-pal-list" class="wc-palette-list"></div>
  </div>
</div>
<div id="wc-lb-modal" class="wc-modal wc-lightbox" hidden>
  <div class="wc-lb-bar"><button type="button" id="wc-lb-close" class="wc-btn">닫기 (Esc)</button></div>
  <img id="wc-lb-img" alt="">
</div>
<script type="application/json" id="wc-init">${initPayload}</script>
<script src="${assets.js.name}"></script>
</body>
</html>`;
}
