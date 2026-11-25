/** Browser UI rendering helpers concatenated into `CHAT_SCRIPT` inside `chat-client.ts`. */
export const CHAT_RENDER_SCRIPT = `
  const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const threadIdFor = (id) => "w_m" + String(id).padStart(7, "0");
  const parseBtns = (raw) => {
    if (!raw) return [];
    try { const arr = JSON.parse(raw); return Array.isArray(arr) ? arr : []; } catch { return []; }
  };
  const fmtAge = (ts) => {
    if (!ts) return "";
    const diff = Math.max(0, Date.now() - ts);
    const min = Math.floor(diff / 60000);
    if (min < 1) return "방금";
    if (min < 60) return min + "분";
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + "시간";
    return Math.floor(hr / 24) + "일";
  };
  const fmtClock = (ts) => {
    if (!ts) return "";
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, "0");
    return pad(d.getHours()) + ":" + pad(d.getMinutes());
  };

  const renderBots = (el, bots, activeBot) => {
    if (!el) return;
    el.innerHTML = bots.map((b) => {
      const act = b.id === activeBot ? " is-active" : "";
      const badges = (b.openApprovals > 0 ? '<span class="wc-pill wc-pill-warn">! ' + b.openApprovals + "</span>" : "")
        + (b.inProgress ? '<span class="wc-spin"></span>' : "");
      return '<button type="button" class="wc-bot-item' + act + '" data-bot="' + esc(b.id) + '" style="--bot-accent:' + esc(b.accent) + '">'
        + '<span class="wc-bot-left"><span class="wc-bot-dot" style="background:' + esc(b.accent) + '"></span><span>#' + esc(b.name) + "</span></span>"
        + '<span class="wc-bot-meta">' + badges + "<span>" + b.conversationCount + "</span></span></button>";
    }).join("");
  };

  const renderConversations = (el, sigEl, conversations, activeConv, query) => {
    if (sigEl) {
      const turn = conversations.filter((c) => c.openApprovals > 0).length;
      const run = conversations.filter((c) => c.inProgress).length;
      sigEl.innerHTML = (turn > 0 ? '<span class="wc-sig wc-sig-turn">내 차례 ' + turn + "</span>" : "")
        + (run > 0 ? '<span class="wc-sig wc-sig-run">진행 중 ' + run + "</span>" : "");
    }
    if (!el) return;
    const q = (query || "").trim().toLowerCase();
    const list = q ? conversations.filter((c) => (c.title + " " + c.lastText + " " + c.conversation).toLowerCase().includes(q)) : conversations;
    if (list.length === 0) {
      el.innerHTML = '<div class="wc-muted" style="padding:12px">' + (q ? "일치하는 대화가 없습니다" : "대화가 없습니다") + "</div>";
      return;
    }
    const groups = [
      { label: "내 차례", cls: "is-turn", items: list.filter((c) => c.openApprovals > 0) },
      { label: "진행 중", cls: "is-run", items: list.filter((c) => c.openApprovals === 0 && c.inProgress) },
      { label: "최근 대화", cls: "", items: list.filter((c) => c.openApprovals === 0 && !c.inProgress) },
    ];
    el.innerHTML = groups.filter((g) => g.items.length > 0).map((g) => {
      const head = '<div class="wc-grp-head ' + g.cls + '"><span>' + g.label + "</span><span>" + g.items.length + "</span></div>";
      const rows = g.items.map((c) => {
        const mark = c.openApprovals > 0
          ? '<span class="wc-mark wc-mark-turn">!</span>'
          : c.inProgress
            ? '<span class="wc-spin"></span>'
            : '<span class="wc-mark"><span class="wc-mark-idle"></span></span>';
        const tChip = c.threadCount > 0 ? '<span class="wc-tchip">🧵 ' + c.threadCount + "</span>" : "";
        return '<button type="button" class="wc-conv-item' + (c.conversation === activeConv ? " is-active" : "") + '" data-conv="' + esc(c.conversation) + '">'
          + '<div class="wc-conv-row">' + mark + '<span class="wc-conv-name">' + esc(c.title || c.conversation) + '</span><span class="wc-conv-age">' + esc(fmtAge(c.updatedAt)) + "</span></div>"
          + '<div class="wc-conv-sub"><span class="wc-conv-prev">' + esc(c.lastText || "대기 중") + "</span>" + tChip + "</div></button>";
      }).join("");
      return head + rows;
    }).join("");
  };

  const renderTimeline = (box, rows, botInfo, threadsByParent, allowThreadBtn, emptyHtml, scrollBottom) => {
    if (!box) return;
    const visible = rows.filter((m) => !(m.role === "system" && !m.text));
    if (visible.length === 0) { box.innerHTML = emptyHtml; return; }
    box.innerHTML = "";
    let prevRole = "", prevAt = 0;
    for (const m of rows) {
      if (m.role === "system") {
        prevRole = "";
        if (!m.text) continue;
        const sys = document.createElement("div");
        sys.className = "wc-msg-system";
        sys.dataset.msgId = String(m.id);
        sys.textContent = m.text;
        box.appendChild(sys);
        continue;
      }
      if (m.role === "status") {
        let deleted = false, final = false;
        if (m.cardJson) { try { const c = JSON.parse(m.cardJson); deleted = Boolean(c.deleted); final = Boolean(c.final); } catch {} }
        const st = document.createElement("div");
        st.className = "wc-msg-status" + (deleted ? " is-deleted" : "") + (final ? " is-final" : "");
        st.dataset.msgId = String(m.id);
        st.innerHTML = '<span class="wc-spin"></span><span>' + esc(m.text || "") + "</span>";
        box.appendChild(st);
        continue;
      }
      const isSpecial = m.role === "approval" || m.role === "choice";
      const cont = !isSpecial && m.role === prevRole && Math.abs((m.createdAt || 0) - prevAt) < 300000;
      prevRole = isSpecial ? "" : m.role;
      prevAt = m.createdAt || 0;
      const isOwner = m.role === "owner";
      const row = document.createElement("div");
      row.className = "wc-row wc-msg-" + m.role + (cont ? " is-cont" : "");
      row.dataset.msgId = String(m.id);
      const tStr = fmtClock(m.createdAt);
      const left = document.createElement(cont ? "span" : "div");
      if (cont) {
        left.className = "wc-row-time-side";
        left.textContent = tStr;
      } else {
        left.className = "wc-avatar" + (isOwner ? " wc-avatar-owner" : "");
        if (!isOwner) left.style.setProperty("--av-bg", botInfo.accent);
        left.textContent = isOwner ? "나" : botInfo.name.slice(0, 1);
      }
      const body = document.createElement("div");
      body.className = "wc-row-body";
      if (!cont) {
        const head = document.createElement("div");
        head.className = "wc-row-head";
        head.innerHTML = '<span class="wc-sender">' + esc(isOwner ? "나" : botInfo.name) + "</span>"
          + (isOwner ? "" : '<span class="wc-bot-badge">BOT</span>')
          + '<span class="wc-time">' + esc(tStr) + "</span>";
        body.appendChild(head);
      }
      const content = document.createElement("div");
      content.innerHTML = m.html || ('<div class="wc-md"><p>' + esc(m.text) + "</p></div>");
      body.appendChild(content);
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
        body.appendChild(actRow);
      }
      const tId = threadIdFor(m.id);
      const summary = allowThreadBtn ? threadsByParent.get(m.id) : undefined;
      if (summary && summary.replyCount > 0) {
        const bar = document.createElement("button");
        bar.type = "button";
        bar.className = "wc-thread-bar";
        bar.dataset.openThread = summary.thread;
        bar.dataset.parentId = String(m.id);
        bar.innerHTML = "<span>🧵 답글 " + summary.replyCount + '개</span><span class="wc-thread-bar-prev">' + esc(summary.lastText) + "</span>";
        body.appendChild(bar);
      }
      row.appendChild(left);
      row.appendChild(body);
      if (allowThreadBtn) {
        const tools = document.createElement("div");
        tools.className = "wc-msg-tools";
        tools.innerHTML = '<button type="button" class="wc-tool-btn" data-open-thread="' + esc(tId) + '" data-parent-id="' + m.id + '">🧵 스레드</button>'
          + '<button type="button" class="wc-tool-btn" data-copy="' + esc(m.text) + '">복사</button>';
        row.appendChild(tools);
      }
      box.appendChild(row);
    }
    if (scrollBottom) box.scrollTop = box.scrollHeight;
  };

  const renderPendingChips = (el, q, scope) => {
    if (!el) return;
    el.hidden = q.files.length === 0 && q.uploading === 0;
    const chips = q.files.map((f, idx) =>
      '<span class="wc-file-chip">📎 ' + esc(f.name) + ' <button type="button" class="wc-chip-x" data-rm-scope="' + scope + '" data-rm-idx="' + idx + '" aria-label="첨부 삭제">×</button></span>'
    ).join("");
    el.innerHTML = chips + (q.uploading > 0 ? '<span class="wc-file-chip">업로드 중…</span>' : "");
  };

  const syncHeaderUi = (els, conv, bot, threadCount, activeThread) => {
    if (els.titleEl) els.titleEl.textContent = conv ? conv.title : "새 대화";
    if (els.chanBotEl) els.chanBotEl.innerHTML = '<span class="wc-bot-dot" style="background:' + esc(bot.accent) + '"></span><span>' + esc(bot.name) + "</span>";
    if (els.inputEl) els.inputEl.placeholder = bot.name + "에게 메시지 보내기";
    if (els.tToggleBtn) {
      els.tToggleBtn.hidden = threadCount === 0 && !activeThread;
      els.tToggleBtn.textContent = "🧵 스레드 " + threadCount;
    }
    const dot = document.querySelector(".wc-brand-dot");
    if (dot) dot.style.background = bot.accent;
  };

  const renderPaletteList = (listEl, query, bots, conversations, activeBot) => {
    const q = (query || "").trim().toLowerCase();
    const items = [
      ...bots.map((b) => ({ label: "#" + b.name + " 에이전트 전환", sub: b.conversationCount + "개 대화", bot: b.id, conv: "" })),
      ...conversations.map((c) => ({ label: c.title || c.conversation, sub: c.openApprovals > 0 ? "내 차례" : c.inProgress ? "진행 중" : "최근", bot: activeBot, conv: c.conversation })),
    ].filter((it) => !q || (it.label + " " + it.sub).toLowerCase().includes(q)).slice(0, 12);
    listEl.innerHTML = items.map((it) =>
      '<button type="button" class="wc-pal-item" data-pal-bot="' + esc(it.bot) + '" data-pal-conv="' + esc(it.conv) + '"><span>' + esc(it.label) + '</span><span class="wc-muted">' + esc(it.sub) + "</span></button>"
    ).join("") || '<div class="wc-muted" style="padding:10px">결과가 없습니다</div>';
  };

  const bumpThreadInList = (threads, msg) => {
    if (!msg.thread) return;
    const hit = threads.find((t) => t.thread === msg.thread);
    if (msg.role === "status") {
      let del = false;
      if (msg.cardJson) { try { const c = JSON.parse(msg.cardJson); del = Boolean(c.deleted) || Boolean(c.final); } catch {} }
      if (hit) hit.inProgress = !del;
      return;
    }
    if (hit) {
      if (msg.role !== "system") hit.replyCount += 1;
      hit.lastText = (msg.text || "").slice(0, 120);
      hit.lastAt = msg.editedAt || msg.createdAt || Date.now();
    } else {
      const m = /^w_m0*([1-9]\\d*)$/.exec(msg.thread);
      threads.unshift({ thread: msg.thread, ...(m ? { parentMessageId: Number(m[1]) } : {}), replyCount: 1, lastText: (msg.text || "").slice(0, 120), lastRole: msg.role, lastAt: msg.createdAt || Date.now(), openApprovals: 0, inProgress: false });
    }
  };

  const applyThemeUi = (mode, btn) => {
    if (mode === "dark" || mode === "light") document.documentElement.setAttribute("data-theme", mode);
    else document.documentElement.removeAttribute("data-theme");
    if (btn) btn.textContent = mode === "dark" ? "다크" : mode === "light" ? "라이트" : "테마";
  };

  const copyWithFeedback = (btn, text) => {
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(text).then(() => {
      const prev = btn.textContent;
      btn.textContent = "복사됨";
      setTimeout(() => { btn.textContent = prev; }, 1200);
    });
  };

  const bindComposerUi = (sc, ui, attachBtn, uploadFn, sendFn) => {
    attachBtn?.addEventListener("click", () => ui.file?.click());
    ui.file?.addEventListener("change", () => { if (ui.file.files) void uploadFn(sc, ui.file.files); ui.file.value = ""; });
    ui.send?.addEventListener("click", () => void sendFn(sc));
    ui.input?.addEventListener("keydown", (e) => {
      if (e.isComposing || e.key !== "Enter" || e.shiftKey) return;
      e.preventDefault();
      void sendFn(sc);
    });
    ui.input?.addEventListener("input", () => {
      ui.input.style.height = "auto";
      ui.input.style.height = Math.min(ui.input.scrollHeight, 180) + "px";
    });
    ui.input?.addEventListener("paste", (e) => {
      const imgs = Array.from(e.clipboardData?.items || []).filter((it) => it.type.startsWith("image/")).map((it) => it.getAsFile()).filter(Boolean);
      if (imgs.length > 0) { e.preventDefault(); void uploadFn(sc, imgs); }
    });
    ui.pane?.addEventListener("dragover", (e) => { e.preventDefault(); ui.pane.classList.add("is-dragover"); });
    ui.pane?.addEventListener("dragleave", () => ui.pane.classList.remove("is-dragover"));
    ui.pane?.addEventListener("drop", (e) => {
      e.preventDefault();
      ui.pane.classList.remove("is-dragover");
      if (e.dataTransfer?.files?.length) void uploadFn(sc, e.dataTransfer.files);
    });
  };
`;
