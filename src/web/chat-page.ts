import { esc } from "../dashboard/text";
import type { WebConversationSummary, WebMessageRow } from "../store/web-messages";
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
	const file = pathname.slice(pathname.lastIndexOf("/") + 1);
	if (found.name !== file) {
		return new Response("not found\n", {
			status: 404,
			headers: { ...commonHeaders, "content-type": "text/plain; charset=utf-8" },
		});
	}
	return new Response(request.method === "HEAD" ? null : found.body, {
		headers: {
			...commonHeaders,
			"content-type": found.type,
			"cache-control": "public, max-age=31536000, immutable",
		},
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

function renderSsrMessage(row: WebMessageRow): string {
	const deletedCls = isDeletedStatus(row) ? " is-deleted" : "";
	if (row.role === "system") {
		if (!row.text) return "";
		return `<div class="wc-msg wc-msg-system" data-msg-id="${row.id}">${esc(row.text)}</div>`;
	}
	if (row.role === "status") {
		return `<div class="wc-msg wc-msg-status${deletedCls}" data-msg-id="${row.id}">${esc(row.text)}</div>`;
	}
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
	return `<div class="wc-msg wc-msg-${row.role}" data-msg-id="${row.id}"><div class="wc-bubble">${renderWebMessageHtml(row)}${btnsHtml}</div></div>`;
}

/** Server-rendered `?view=chat` page loading only `chat-<hash>.{css,js}` assets. */
export function renderWebChatPage(options: {
	conversations: WebConversationSummary[];
	activeConversation: string;
	messages: WebMessageRow[];
	csrfToken: string;
	theme?: "dark" | "light" | undefined;
}): string {
	const assets = webChatAssets();
	const activeSummary = options.conversations.find((c) => c.conversation === options.activeConversation);
	const title = activeSummary?.title || options.activeConversation || "웹 대화";
	const convItems =
		options.conversations.length === 0
			? '<div class="wc-muted" style="padding:10px">대화가 없습니다</div>'
			: options.conversations
					.map((c) => {
						const act = c.conversation === options.activeConversation ? " is-active" : "";
						const badges = [
							c.openApprovals > 0 ? `<span class="wc-pill wc-pill-warn">승인 ${c.openApprovals}</span>` : "",
							c.inProgress ? '<span class="wc-pill wc-pill-info">진행 중</span>' : "",
						].join("");
						return `<button type="button" class="wc-conv-item${act}" data-conv="${esc(c.conversation)}"><div class="wc-conv-row"><span class="wc-conv-name">${esc(c.title || c.conversation)}</span>${badges}</div><div class="wc-conv-prev">${esc(c.lastText || "대기 중")}</div></button>`;
					})
					.join("");

	const enrichedMessages = options.messages.map((m) => ({ ...m, html: renderWebMessageHtml(m) }));
	const messagesHtml =
		options.activeConversation === ""
			? '<div class="wc-empty">왼쪽에서 대화를 고르거나 새 대화를 여세요.</div>'
			: options.messages.filter((m) => !(m.role === "system" && !m.text)).length === 0
				? '<div class="wc-empty">대화를 시작해 보세요. 파일 첨부나 이미지 붙여넣기도 됩니다.</div>'
				: options.messages.map(renderSsrMessage).join("");

	const initPayload = JSON.stringify({
		activeConversation: options.activeConversation,
		conversations: options.conversations,
		messages: enrichedMessages,
	}).replace(/</g, "\\u003c");
	const themeAttr = options.theme ? ` data-theme="${options.theme}"` : "";

	return `<!doctype html>
<html lang="ko"${themeAttr}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="jabbu-csrf" content="${esc(options.csrfToken)}">
<title>${esc(title)} · jabbu 웹 대화</title>
<link rel="stylesheet" href="${assets.css.name}">
</head>
<body>
<div class="wc-app">
  <header class="wc-topbar">
    <div class="wc-top-left">
      <button type="button" id="wc-menu" class="wc-btn-icon wc-btn-menu" aria-label="대화 목록">☰</button>
      <h1 id="wc-conv-title" class="wc-title">${esc(title)}</h1>
    </div>
    <div class="wc-top-right">
      <a class="wc-btn" href="./">현황판</a>
      <button type="button" id="wc-theme" class="wc-btn">테마</button>
    </div>
  </header>
  <div class="wc-body">
    <div id="wc-backdrop" class="wc-backdrop"></div>
    <aside id="wc-sidebar" class="wc-sidebar" aria-label="웹 대화 목록">
      <div class="wc-side-head">
        <span class="wc-side-title">대화 목록</span>
        <button type="button" id="wc-new" class="wc-btn wc-btn-primary">+ 새 대화</button>
      </div>
      <div id="wc-conv-list" class="wc-conv-list">${convItems}</div>
    </aside>
    <main id="wc-main" class="wc-main">
      <div id="wc-messages" class="wc-messages">${messagesHtml}</div>
      <div class="wc-composer-wrap">
        <div id="wc-pending-files" class="wc-pending-files" hidden></div>
        <div id="wc-error" class="wc-error" role="alert" hidden></div>
        <div class="wc-composer">
          <input type="file" id="wc-file-input" multiple hidden>
          <button type="button" id="wc-attach" class="wc-btn-icon" aria-label="파일 첨부">📎</button>
          <textarea id="wc-input" class="wc-input" rows="1" placeholder="송박에게 메시지 보내기" aria-label="메시지 입력"></textarea>
          <button type="button" id="wc-send" class="wc-btn wc-btn-primary">전송</button>
        </div>
      </div>
    </main>
  </div>
</div>
<script type="application/json" id="wc-init">${initPayload}</script>
<script src="${assets.js.name}"></script>
</body>
</html>`;
}
