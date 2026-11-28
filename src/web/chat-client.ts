import { CHAT_RENDER_SCRIPT } from "./chat-client-render";

/** Standalone browser script loaded only on `?view=chat` (keeps main dashboard script budget intact). */
export const CHAT_SCRIPT = `(() => {
  const initEl = document.getElementById("wc-init");
  if (!initEl) return;
  const state = JSON.parse(initEl.textContent || "{}");
  let csrfToken = document.querySelector('meta[name="jabbu-csrf"]')?.getAttribute("content") || "";
  let bots = Array.isArray(state.bots) ? state.bots : [];
  let activeBot = state.activeBot || bots[0]?.id || "songbak";
  let activeConv = state.activeConversation || "";
  let conversations = Array.isArray(state.conversations) ? state.conversations : [];
  let messages = Array.isArray(state.messages) ? state.messages : [];
  let threads = Array.isArray(state.threads) ? state.threads : [];
  let activeThread = state.activeThread || "";
  let threadMessages = Array.isArray(state.threadMessages) ? state.threadMessages : [];
  let parentMessage = state.parentMessage || null;
  let searchQuery = "";
  let es = null;
  let seenThreadIds = new Set(threadMessages.map((m) => m.id));
  const queues = { main: { files: [], uploading: 0 }, thread: { files: [], uploading: 0 } };
  const $ = (id) => document.getElementById(id);
  const bodyEl = $("wc-body"), side = $("wc-sidebar"), backdrop = $("wc-backdrop");
  const botListEl = $("wc-bot-list"), convListEl = $("wc-conv-list"), sigEl = $("wc-sig-summary"), sseEl = $("wc-sse-state");
  const msgBox = $("wc-messages"), titleEl = $("wc-conv-title"), chanBotEl = $("wc-chan-bot"), tToggleBtn = $("wc-threads-toggle");
  const tTitleEl = $("wc-thread-title"), tParentEl = $("wc-thread-parent"), tMsgBox = $("wc-thread-messages"), tPane = $("wc-thread-pane");
  const mainPane = $("wc-main"), searchEl = $("wc-search"), palModal = $("wc-pal-modal"), palInput = $("wc-pal-input"), palList = $("wc-pal-list");
  const lbModal = $("wc-lb-modal"), lbImg = $("wc-lb-img");
  const scopes = {
    main: { input: $("wc-input"), send: $("wc-send"), file: $("wc-file-input"), pending: $("wc-pending-files"), err: $("wc-error"), pane: mainPane },
    thread: { input: $("wc-thread-input"), send: $("wc-thread-send"), file: $("wc-thread-file-input"), pending: $("wc-thread-pending"), err: $("wc-thread-error"), pane: tPane },
  };
  ${CHAT_RENDER_SCRIPT}

  const botInfo = () => bots.find((b) => b.id === activeBot) || bots[0] || { id: activeBot, name: "송박", accent: "#58A6FF" };
  const botQs = () => "bot=" + encodeURIComponent(activeBot);
  const setErr = (scope, msg) => {
    const el = scopes[scope].err;
    if (!el) return;
    el.textContent = msg || "";
    el.hidden = !msg;
  };
  /** A failed request shows one fixed Korean line; the raw failure goes to the console, never the screen. */
  const showErr = (scope, err, line) => {
    console.error(err);
    setErr(scope, line);
  };
  const setSseState = (live) => {
    if (!sseEl) return;
    sseEl.className = "wc-sig wc-sig-sse " + (live ? "is-live" : "is-wait");
    if (sseEl.lastElementChild) sseEl.lastElementChild.textContent = live ? "실시간" : "재연결";
  };
  const toggleDrawer = (open) => { side?.classList.toggle("is-open", open); backdrop?.classList.toggle("is-open", open); };
  applyThemeUi(localStorage.getItem("jabbu_chat_theme") || document.documentElement.getAttribute("data-theme") || "", $("wc-theme"));

  const pushRoute = (replace) => {
    const parts = ["?view=chat", botQs()];
    if (activeConv) parts.push("c=" + encodeURIComponent(activeConv));
    if (activeThread) parts.push("t=" + encodeURIComponent(activeThread));
    const url = parts.join("&");
    if (replace) history.replaceState(null, "", url);
    else history.pushState(null, "", url);
  };

  const threadMap = () => {
    const map = new Map();
    for (const t of threads) if (t.parentMessageId) map.set(t.parentMessageId, t);
    return map;
  };

  const headerEls = { titleEl, chanBotEl, inputEl: scopes.main.input, tToggleBtn };
  const renderAllMessages = (scrollMain, scrollThread) => {
    const b = botInfo();
    const conv = conversations.find((c) => c.conversation === activeConv);
    syncHeaderUi(headerEls, conv, b, threads.length, activeThread);
    const emptyMain = !activeConv
      ? '<div class="wc-empty">왼쪽에서 대화를 고르거나 새 대화를 여세요.</div>'
      : '<div class="wc-empty">대화를 시작해 보세요. 파일 첨부나 이미지 붙여넣기도 됩니다.</div>';
    renderTimeline(msgBox, activeConv ? messages : [], b, threadMap(), true, emptyMain, scrollMain);
    bodyEl?.classList.toggle("has-thread", Boolean(activeThread));
    if (activeThread) {
      if (tTitleEl) tTitleEl.textContent = "🧵 스레드";
      if (tParentEl) {
        if (parentMessage) {
          const pName = parentMessage.role === "owner" ? "나" : b.name;
          tParentEl.innerHTML = '<div class="wc-thread-parent-meta">' + esc(pName) + "</div><div>" + (parentMessage.html || esc(parentMessage.text)) + "</div>";
          tParentEl.hidden = false;
        } else tParentEl.hidden = true;
      }
      renderTimeline(tMsgBox, threadMessages, b, new Map(), false, '<div class="wc-empty">첫 답글을 남겨 보세요.</div>', scrollThread);
    }
  };

  const renderPending = (scope) => renderPendingChips(scopes[scope].pending, queues[scope], scope);

  const apiGet = async (path) => {
    const res = await fetch(path, { credentials: "same-origin", cache: "no-store" });
    const hdr = res.headers.get("x-jabbu-csrf");
    if (hdr) csrfToken = hdr;
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  };

  const apiPost = async (path, body, isForm) => {
    const res = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: isForm ? { "x-jabbu-csrf": csrfToken } : { "x-jabbu-csrf": csrfToken, "content-type": "application/json" },
      body: isForm ? body : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
    return data;
  };

  const refreshConversations = async () => {
    const data = await apiGet("api/web/conversations?" + botQs());
    bots = data.bots || bots;
    conversations = data.conversations || [];
    renderBots(botListEl, bots, activeBot);
    renderConversations(convListEl, sigEl, conversations, activeConv, searchQuery);
    syncHeaderUi(headerEls, conversations.find((c) => c.conversation === activeConv), botInfo(), threads.length, activeThread);
  };

  const openStream = () => {
    if (es) { es.close(); es = null; }
    if (!activeConv) { setSseState(false); return; }
    let maxId = 0, maxEdited = 0;
    for (const m of [...messages, ...threadMessages]) {
      if (m.id > maxId) maxId = m.id;
      if (m.editedAt && m.editedAt > maxEdited) maxEdited = m.editedAt;
    }
    es = new EventSource("api/web/stream?" + botQs() + "&c=" + encodeURIComponent(activeConv) + "&after=" + maxId + "&afterEdited=" + maxEdited);
    es.onopen = () => setSseState(true);
    es.onerror = () => setSseState(false);
    es.addEventListener("messages", (ev) => {
      setSseState(true);
      const list = Array.isArray(JSON.parse(ev.data).messages) ? JSON.parse(ev.data).messages : [];
      if (list.length === 0) return;
      let hitMain = false, hitThread = false;
      for (const next of list) {
        if (!next.thread) {
          const i = messages.findIndex((m) => m.id === next.id);
          if (i >= 0) messages[i] = next; else { messages.push(next); hitMain = true; }
        } else {
          if (next.thread === activeThread) {
            const i = threadMessages.findIndex((m) => m.id === next.id);
            if (i >= 0) threadMessages[i] = next; else { threadMessages.push(next); hitThread = true; }
          }
          if (next.role === "status" || !seenThreadIds.has(next.id)) {
            seenThreadIds.add(next.id);
            bumpThreadInList(threads, next);
          }
        }
      }
      renderAllMessages(hitMain, hitThread);
      void refreshConversations();
    });
  };

  const openThread = async (threadId, parentId) => {
    if (!activeConv || !threadId) return;
    activeThread = threadId;
    parentMessage = messages.find((m) => m.id === Number(parentId)) || null;
    if (!parentMessage) {
      const sum = threads.find((t) => t.thread === threadId);
      if (sum?.parentMessageId) parentMessage = messages.find((m) => m.id === sum.parentMessageId) || null;
    }
    threadMessages = [];
    renderAllMessages(false, true);
    pushRoute(false);
    const data = await apiGet("api/web/messages?" + botQs() + "&c=" + encodeURIComponent(activeConv) + "&t=" + encodeURIComponent(threadId));
    threadMessages = data.messages || [];
    for (const m of threadMessages) seenThreadIds.add(m.id);
    renderAllMessages(false, true);
    scopes.thread.input?.focus();
  };

  const closeThread = () => {
    activeThread = "";
    threadMessages = [];
    parentMessage = null;
    renderAllMessages(false, false);
    pushRoute(false);
  };

  const selectConversation = async (conv, pushUrl = true) => {
    activeConv = conv;
    activeThread = "";
    threadMessages = [];
    parentMessage = null;
    toggleDrawer(false);
    renderConversations(convListEl, sigEl, conversations, activeConv, searchQuery);
    const data = conv ? await apiGet("api/web/messages?" + botQs() + "&c=" + encodeURIComponent(conv)) : { messages: [], threads: [] };
    messages = data.messages || [];
    threads = data.threads || [];
    seenThreadIds = new Set();
    if (pushUrl) pushRoute(false);
    renderAllMessages(true, false);
    openStream();
  };

  const selectBot = async (botId) => {
    if (!botId || botId === activeBot) { toggleDrawer(false); return; }
    activeBot = botId;
    activeConv = "";
    activeThread = "";
    messages = [];
    threads = [];
    threadMessages = [];
    await refreshConversations();
    const firstConv = conversations[0]?.conversation || "";
    await selectConversation(firstConv, false);
    pushRoute(false);
  };

  const uploadFiles = async (scope, fileList) => {
    const picked = Array.from(fileList || []);
    if (picked.length === 0) return;
    const q = queues[scope];
    setErr(scope, "");
    q.uploading += picked.length;
    renderPending(scope);
    try {
      const form = new FormData();
      for (const f of picked) form.append("file", f, f.name || "paste.png");
      const out = await apiPost("api/web/upload?" + botQs(), form, true);
      q.files.push(...(out.files || []));
    } catch (err) {
      showErr(scope, err, "업로드에 실패했습니다. 다시 시도해 주세요.");
    } finally {
      q.uploading = Math.max(0, q.uploading - picked.length);
      renderPending(scope);
    }
  };

  const sendMessage = async (scope) => {
    const q = queues[scope], ui = scopes[scope];
    if (q.uploading > 0) return;
    const text = (ui.input?.value || "").trim();
    if (!text && q.files.length === 0) return;
    setErr(scope, "");
    if (ui.send) ui.send.disabled = true;
    try {
      if (!activeConv) {
        const created = await apiPost("api/web/new", { bot: activeBot }, false);
        activeConv = created.conversation;
        pushRoute(false);
        openStream();
      }
      const files = q.files.map((f) => f.path);
      if (ui.input) { ui.input.value = ""; ui.input.style.height = ""; }
      q.files = [];
      renderPending(scope);
      await apiPost("api/web/send", {
        bot: activeBot,
        conversation: activeConv,
        ...(scope === "thread" && activeThread ? { thread: activeThread } : {}),
        text,
        ...(files.length ? { files } : {}),
      }, false);
      await refreshConversations();
    } catch (err) {
      showErr(scope, err, "전송에 실패했습니다. 다시 시도해 주세요.");
    } finally {
      if (ui.send) ui.send.disabled = false;
    }
  };

  const openPalette = () => {
    if (!palModal || !palInput || !palList) return;
    palModal.hidden = false;
    palInput.value = "";
    const draw = () => renderPaletteList(palList, palInput.value, bots, conversations, activeBot);
    palInput.oninput = draw;
    draw();
    palInput.focus();
  };

  document.addEventListener("click", (ev) => {
    const t = ev.target instanceof Element ? ev.target : null;
    if (!t) return;
    const botBtn = t.closest("[data-bot]");
    if (botBtn) { void selectBot(botBtn.getAttribute("data-bot") || ""); return; }
    const convBtn = t.closest("[data-conv]");
    if (convBtn) { void selectConversation(convBtn.getAttribute("data-conv") || ""); return; }
    const thBtn = t.closest("[data-open-thread]");
    if (thBtn) { void openThread(thBtn.getAttribute("data-open-thread") || "", thBtn.getAttribute("data-parent-id")); return; }
    const rmBtn = t.closest("[data-rm-scope]");
    if (rmBtn) {
      const sc = rmBtn.getAttribute("data-rm-scope") === "thread" ? "thread" : "main";
      queues[sc].files.splice(Number(rmBtn.getAttribute("data-rm-idx")), 1);
      renderPending(sc);
      return;
    }
    const actBtn = t.closest("[data-action-id]");
    if (actBtn) {
      actBtn.disabled = true;
      void apiPost("api/web/action", { bot: activeBot, actionId: actBtn.getAttribute("data-action-id"), messageId: actBtn.getAttribute("data-message-id") }, false).catch((err) => {
        actBtn.disabled = false;
        showErr("main", err, "버튼 처리에 실패했습니다. 다시 시도해 주세요.");
      });
      return;
    }
    const copyBtn = t.closest("[data-copy]");
    if (copyBtn) { copyWithFeedback(copyBtn, copyBtn.getAttribute("data-copy") || ""); return; }
    const imgBtn = t.closest("[data-img-src]");
    if (imgBtn && lbModal && lbImg) {
      lbImg.src = imgBtn.getAttribute("data-img-src") || "";
      lbImg.alt = imgBtn.getAttribute("data-img-name") || "";
      lbModal.hidden = false;
      return;
    }
    const palItem = t.closest("[data-pal-bot]");
    if (palItem && palModal) {
      palModal.hidden = true;
      const b = palItem.getAttribute("data-pal-bot") || "";
      const c = palItem.getAttribute("data-pal-conv") || "";
      if (c) void selectConversation(c); else void selectBot(b);
    }
  });

  $("wc-menu")?.addEventListener("click", () => toggleDrawer(!side?.classList.contains("is-open")));
  backdrop?.addEventListener("click", () => toggleDrawer(false));
  $("wc-cmdk")?.addEventListener("click", openPalette);
  $("wc-thread-close")?.addEventListener("click", closeThread);
  $("wc-lb-close")?.addEventListener("click", () => { if (lbModal) lbModal.hidden = true; });
  palModal?.addEventListener("click", (e) => { if (e.target === palModal) palModal.hidden = true; });
  lbModal?.addEventListener("click", (e) => { if (e.target === lbModal) lbModal.hidden = true; });
  tToggleBtn?.addEventListener("click", () => {
    if (activeThread) closeThread();
    else if (threads[0]) void openThread(threads[0].thread, threads[0].parentMessageId);
  });
  searchEl?.addEventListener("input", () => {
    searchQuery = searchEl.value || "";
    renderConversations(convListEl, sigEl, conversations, activeConv, searchQuery);
  });
  $("wc-new")?.addEventListener("click", async () => {
    setErr("main", "");
    const created = await apiPost("api/web/new", { bot: activeBot }, false);
    await refreshConversations();
    await selectConversation(created.conversation);
  });
  $("wc-theme")?.addEventListener("click", () => {
    const cur = localStorage.getItem("jabbu_chat_theme") || "";
    const next = cur === "dark" ? "light" : cur === "light" ? "" : "dark";
    if (next) localStorage.setItem("jabbu_chat_theme", next); else localStorage.removeItem("jabbu_chat_theme");
    applyThemeUi(next, $("wc-theme"));
  });
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); }
    if (e.key === "Escape") {
      if (lbModal && !lbModal.hidden) lbModal.hidden = true;
      else if (palModal && !palModal.hidden) palModal.hidden = true;
    }
  });
  window.addEventListener("popstate", () => {
    const q = new URLSearchParams(location.search);
    const b = q.get("bot") || activeBot;
    const c = q.get("c") || "";
    const t = q.get("t") || "";
    if (b !== activeBot) void selectBot(b);
    else if (c !== activeConv) void selectConversation(c, false).then(() => { if (t) void openThread(t); });
    else if (t && t !== activeThread) void openThread(t);
    else if (!t && activeThread) closeThread();
  });

  bindComposerUi("main", scopes.main, $("wc-attach"), uploadFiles, sendMessage);
  bindComposerUi("thread", scopes.thread, $("wc-thread-attach"), uploadFiles, sendMessage);

  renderBots(botListEl, bots, activeBot);
  renderConversations(convListEl, sigEl, conversations, activeConv, searchQuery);
  renderAllMessages(true, Boolean(activeThread));
  if (document.readyState === "complete") openStream();
  else window.addEventListener("load", openStream, { once: true });
})();`;
