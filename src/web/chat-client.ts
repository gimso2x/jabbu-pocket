/** Standalone browser script loaded only on `?view=chat` (keeps main dashboard script budget intact). */
export const CHAT_SCRIPT = `(() => {
  const initEl = document.getElementById("wc-init");
  if (!initEl) return;
  const state = JSON.parse(initEl.textContent || "{}");
  let csrfToken = (document.querySelector('meta[name="jabbu-csrf"]')?.getAttribute("content")) || "";
  let activeConv = state.activeConversation || "";
  let conversations = Array.isArray(state.conversations) ? state.conversations : [];
  let messages = Array.isArray(state.messages) ? state.messages : [];
  let pendingFiles = [];
  let uploading = 0;
  let es = null;

  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const side = $("wc-sidebar"), backdrop = $("wc-backdrop"), convList = $("wc-conv-list"), msgBox = $("wc-messages");
  const titleEl = $("wc-conv-title"), inputEl = $("wc-input"), sendBtn = $("wc-send"), fileInput = $("wc-file-input");
  const pendingEl = $("wc-pending-files"), errEl = $("wc-error"), mainPane = $("wc-main");

  const setError = (msg) => {
    if (!errEl) return;
    errEl.textContent = msg || "";
    errEl.hidden = !msg;
  };

  const toggleDrawer = (open) => {
    side?.classList.toggle("is-open", open);
    backdrop?.classList.toggle("is-open", open);
  };

  const applyTheme = (mode) => {
    if (mode === "dark" || mode === "light") document.documentElement.setAttribute("data-theme", mode);
    else document.documentElement.removeAttribute("data-theme");
    const btn = $("wc-theme");
    if (btn) btn.textContent = mode === "dark" ? "다크" : mode === "light" ? "라이트" : "테마";
  };
  applyTheme(localStorage.getItem("jabbu_chat_theme") || document.documentElement.getAttribute("data-theme") || "");

  const parseBtns = (raw) => {
    if (!raw) return [];
    try { const arr = JSON.parse(raw); return Array.isArray(arr) ? arr : []; } catch { return []; }
  };

  const renderMessageNode = (m) => {
    const el = document.createElement("div");
    el.dataset.msgId = String(m.id);
    let deleted = false;
    if (m.role === "status" && m.cardJson) {
      try { deleted = Boolean(JSON.parse(m.cardJson).deleted); } catch {}
    }
    el.className = "wc-msg wc-msg-" + m.role + (deleted ? " is-deleted" : "");
    if (m.role === "system") {
      el.textContent = m.text || "새 대화";
      return el;
    }
    if (m.role === "status") {
      el.textContent = m.text || "";
      return el;
    }
    const bubble = document.createElement("div");
    bubble.className = "wc-bubble";
    bubble.innerHTML = m.html || ('<div class="wc-md"><p>' + esc(m.text) + "</p></div>");
    const btns = parseBtns(m.buttonsJson);
    if (btns.length > 0) {
      const actRow = document.createElement("div");
      actRow.className = "wc-actions";
      for (const b of btns) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "wc-act-btn" + (b.style === "primary" ? " wc-btn-primary" : b.style === "danger" ? " wc-btn-danger" : "");
        btn.dataset.actionId = b.actionId;
        btn.dataset.messageId = String(m.id);
        btn.textContent = b.label;
        actRow.appendChild(btn);
      }
      bubble.appendChild(actRow);
    }
    el.appendChild(bubble);
    return el;
  };

  const renderMessages = (scrollBottom) => {
    if (!msgBox) return;
    const conv = conversations.find((c) => c.conversation === activeConv);
    if (titleEl) titleEl.textContent = conv ? conv.title : "웹 대화";
    if (!activeConv) {
      msgBox.innerHTML = '<div class="wc-empty">왼쪽에서 대화를 고르거나 새 대화를 여세요.</div>';
      return;
    }
    const visible = messages.filter((m) => !(m.role === "system" && !m.text));
    if (visible.length === 0) {
      msgBox.innerHTML = '<div class="wc-empty">대화를 시작해 보세요. 파일 첨부나 이미지 붙여넣기도 됩니다.</div>';
      return;
    }
    msgBox.innerHTML = "";
    for (const m of visible) msgBox.appendChild(renderMessageNode(m));
    if (scrollBottom) msgBox.scrollTop = msgBox.scrollHeight;
  };

  const renderConversations = () => {
    if (!convList) return;
    if (conversations.length === 0) {
      convList.innerHTML = '<div class="wc-muted" style="padding:10px">대화가 없습니다</div>';
      return;
    }
    convList.innerHTML = conversations.map((c) => {
      const badges = (c.openApprovals > 0 ? '<span class="wc-pill wc-pill-warn">승인 ' + c.openApprovals + "</span>" : "")
        + (c.inProgress ? '<span class="wc-pill wc-pill-info">진행 중</span>' : "");
      return '<button type="button" class="wc-conv-item' + (c.conversation === activeConv ? " is-active" : "") + '" data-conv="' + esc(c.conversation) + '">'
        + '<div class="wc-conv-row"><span class="wc-conv-name">' + esc(c.title || c.conversation) + "</span>" + badges + "</div>"
        + '<div class="wc-conv-prev">' + esc(c.lastText || "대기 중") + "</div></button>";
    }).join("");
  };

  const renderPendingFiles = () => {
    if (!pendingEl) return;
    pendingEl.hidden = pendingFiles.length === 0 && uploading === 0;
    const chips = pendingFiles.map((f, idx) =>
      '<span class="wc-file-chip">📎 ' + esc(f.name) + ' <button type="button" class="wc-chip-x" data-rm-file="' + idx + '" aria-label="첨부 삭제">×</button></span>'
    ).join("");
    const busy = uploading > 0 ? '<span class="wc-file-chip">업로드 중…</span>' : "";
    pendingEl.innerHTML = chips + busy;
  };

  const apiPost = async (path, body, isForm) => {
    const headers = { "x-jabbu-csrf": csrfToken };
    if (!isForm) headers["content-type"] = "application/json";
    const res = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers,
      body: isForm ? body : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
    return data;
  };

  const refreshConversations = async () => {
    const res = await fetch("api/web/conversations", { credentials: "same-origin", cache: "no-store" });
    if (!res.ok) return;
    const hdr = res.headers.get("x-jabbu-csrf");
    if (hdr) csrfToken = hdr;
    const data = await res.json();
    conversations = data.conversations || [];
    renderConversations();
  };

  const openStream = () => {
    if (es) { es.close(); es = null; }
    if (!activeConv) return;
    let maxId = 0, maxEdited = 0;
    for (const m of messages) {
      if (m.id > maxId) maxId = m.id;
      if (m.editedAt && m.editedAt > maxEdited) maxEdited = m.editedAt;
    }
    es = new EventSource("api/web/stream?c=" + encodeURIComponent(activeConv) + "&after=" + maxId + "&afterEdited=" + maxEdited);
    es.addEventListener("messages", (ev) => {
      const payload = JSON.parse(ev.data);
      const list = Array.isArray(payload.messages) ? payload.messages : [];
      if (list.length === 0) return;
      for (const next of list) {
        const i = messages.findIndex((m) => m.id === next.id);
        if (i >= 0) messages[i] = next; else messages.push(next);
      }
      renderMessages(true);
      void refreshConversations();
    });
  };

  const selectConversation = async (conv) => {
    activeConv = conv;
    toggleDrawer(false);
    history.pushState(null, "", "?view=chat&c=" + encodeURIComponent(conv));
    renderConversations();
    const res = await fetch("api/web/messages?c=" + encodeURIComponent(conv), { credentials: "same-origin", cache: "no-store" });
    const hdr = res.headers.get("x-jabbu-csrf");
    if (hdr) csrfToken = hdr;
    const data = await res.json();
    messages = data.messages || [];
    renderMessages(true);
    openStream();
  };

  const uploadFiles = async (fileList) => {
    const picked = Array.from(fileList || []);
    if (picked.length === 0) return;
    setError("");
    uploading += picked.length;
    renderPendingFiles();
    try {
      const form = new FormData();
      for (const f of picked) form.append("file", f, f.name || "paste.png");
      const out = await apiPost("api/web/upload", form, true);
      pendingFiles.push(...(out.files || []));
    } catch (err) {
      setError("업로드 실패: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      uploading = Math.max(0, uploading - picked.length);
      renderPendingFiles();
    }
  };

  const sendMessage = async () => {
    if (uploading > 0) return;
    const text = (inputEl?.value || "").trim();
    if (!text && pendingFiles.length === 0) return;
    setError("");
    if (sendBtn) sendBtn.disabled = true;
    try {
      if (!activeConv) {
        const created = await apiPost("api/web/new", {}, false);
        activeConv = created.conversation;
        history.pushState(null, "", "?view=chat&c=" + encodeURIComponent(activeConv));
        openStream();
      }
      const files = pendingFiles.map((f) => f.path);
      if (inputEl) { inputEl.value = ""; inputEl.style.height = ""; }
      pendingFiles = [];
      renderPendingFiles();
      await apiPost("api/web/send", { conversation: activeConv, text, ...(files.length ? { files } : {}) }, false);
      await refreshConversations();
    } catch (err) {
      setError("전송 실패: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      if (sendBtn) sendBtn.disabled = false;
    }
  };

  document.addEventListener("click", (ev) => {
    const target = ev.target instanceof Element ? ev.target : null;
    if (!target) return;
    const convBtn = target.closest("[data-conv]");
    if (convBtn) { void selectConversation(convBtn.getAttribute("data-conv") || ""); return; }
    const rmBtn = target.closest("[data-rm-file]");
    if (rmBtn) {
      const idx = Number(rmBtn.getAttribute("data-rm-file"));
      pendingFiles.splice(idx, 1);
      renderPendingFiles();
      return;
    }
    const actBtn = target.closest("[data-action-id]");
    if (actBtn) {
      actBtn.disabled = true;
      void apiPost("api/web/action", {
        actionId: actBtn.getAttribute("data-action-id"),
        messageId: actBtn.getAttribute("data-message-id"),
      }, false).catch((err) => {
        actBtn.disabled = false;
        setError("버튼 처리 실패: " + (err instanceof Error ? err.message : String(err)));
      });
      return;
    }
    const copyBtn = target.closest("[data-copy]");
    if (copyBtn && navigator.clipboard) {
      void navigator.clipboard.writeText(copyBtn.getAttribute("data-copy") || "").then(() => {
        const prev = copyBtn.textContent;
        copyBtn.textContent = "복사됨";
        setTimeout(() => { copyBtn.textContent = prev; }, 1200);
      });
    }
  });

  $("wc-menu")?.addEventListener("click", () => toggleDrawer(!side?.classList.contains("is-open")));
  backdrop?.addEventListener("click", () => toggleDrawer(false));
  $("wc-new")?.addEventListener("click", async () => {
    setError("");
    const created = await apiPost("api/web/new", {}, false);
    await refreshConversations();
    await selectConversation(created.conversation);
  });
  $("wc-theme")?.addEventListener("click", () => {
    const cur = localStorage.getItem("jabbu_chat_theme") || "";
    const next = cur === "dark" ? "light" : cur === "light" ? "" : "dark";
    if (next) localStorage.setItem("jabbu_chat_theme", next); else localStorage.removeItem("jabbu_chat_theme");
    applyTheme(next);
  });
  $("wc-attach")?.addEventListener("click", () => fileInput?.click());
  fileInput?.addEventListener("change", () => {
    if (fileInput.files) void uploadFiles(fileInput.files);
    fileInput.value = "";
  });
  sendBtn?.addEventListener("click", () => void sendMessage());
  inputEl?.addEventListener("keydown", (e) => {
    if (e.isComposing || e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    void sendMessage();
  });
  inputEl?.addEventListener("input", () => {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + "px";
  });
  inputEl?.addEventListener("paste", (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const imgs = items.filter((it) => it.type.startsWith("image/")).map((it) => it.getAsFile()).filter(Boolean);
    if (imgs.length > 0) { e.preventDefault(); void uploadFiles(imgs); }
  });
  mainPane?.addEventListener("dragover", (e) => { e.preventDefault(); mainPane.classList.add("is-dragover"); });
  mainPane?.addEventListener("dragleave", () => mainPane.classList.remove("is-dragover"));
  mainPane?.addEventListener("drop", (e) => {
    e.preventDefault();
    mainPane.classList.remove("is-dragover");
    if (e.dataTransfer?.files?.length) void uploadFiles(e.dataTransfer.files);
  });

  renderConversations();
  renderMessages(true);
  if (document.readyState === "complete") openStream();
  else window.addEventListener("load", openStream, { once: true });
})();`;
