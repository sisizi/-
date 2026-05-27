// ==UserScript==
// @name         XHS Ops Assistant - Human Review
// @namespace    https://iss7.online/
// @version      0.1.0
// @description  小红书运营辅助面板：定时提醒、线索记录、搜索入口、评论/私信/笔记草稿。只辅助人工确认，不自动发布或批量评论。
// @author       Codex
// @match        *://*.xiaohongshu.com/*
// @match        *://xiaohongshu.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const STORAGE_KEY = "xhsOpsAssistant:v1";
  const REMINDER_KEY = "xhsOpsAssistant:lastReminderDate";
  const PANEL_ID = "xhs-ops-assistant-panel";

  const DEFAULT_STATE = {
    leads: [],
    drafts: [],
    settings: {
      reminderEnabled: false,
      website: "https://iss7.online/",
      brand: "Tolesson.ai",
    },
  };

  const KEYWORDS = [
    "老师备课",
    "课件做不完",
    "明天公开课",
    "PPT 救急",
    "谁能帮我做 PPT",
    "AI 课件",
    "教案生成",
    "公开课 PPT",
    "说课 PPT",
    "PPT 课件生成",
    "今晚要交 PPT",
    "明天汇报 PPT",
    "公开课来不及",
    "备课神器",
  ];

  const SCHEDULE = [
    {
      id: "morning",
      label: "早间搜索",
      time: "08:30",
      window: "08:30-09:00",
      target: "搜索 5-8 个高意向关键词，记录 10 条候选笔记。",
      keywords: ["老师备课", "课件做不完", "明天公开课", "PPT 救急", "谁能帮我做 PPT"],
    },
    {
      id: "noon",
      label: "午间跟进",
      time: "12:30",
      window: "12:30-13:00",
      target: "查看早间回复，新增 10 条候选，处理明确需求。",
      keywords: ["AI 课件", "教案生成", "公开课 PPT", "说课 PPT"],
    },
    {
      id: "night",
      label: "晚间高峰",
      time: "21:30",
      window: "21:30-23:00",
      target: "筛选急单需求，复盘当天线索和转化状态。",
      keywords: ["今晚要交 PPT", "明天汇报 PPT", "公开课来不及", "备课神器", "PPT 课件生成"],
    },
  ];

  const COMMENT_TEMPLATES = {
    teacher:
      "如果是上课用课件，建议先把课题、年级、课时和课堂练习定下来，再生成页面。你这是公开课、常规课，还是复习课？",
    urgent:
      "如果时间很赶，先别大改内容，优先统一封面、目录、标题层级和关键页面。你现在大概多少页，截止到什么时候？",
    report:
      "这类汇报重点不是做花，重点是让对方 10 秒看懂结论。可以先把每页标题改成结论句。你是项目汇报、述职，还是答辩？",
    ai:
      "这种需求可以先用 AI 生成一版课件初稿，再人工改重点页，会比从 0 做快很多。你是什么科目、年级和课题？",
  };

  const DM_TEMPLATES = {
    teacher:
      "我先帮你判断下适合直接生成还是人工精修。你发我 4 个信息就行：年级、科目、课题、上课时长。如果只是先要课件初稿，可以先用工具生成一版，再看哪些页需要改。",
    website:
      "你这个更适合先用工具起稿。打开 {website}，输入年级、科目、课题和课时，先生成一版 PPT 课件/教案/练习。生成后如果某几页不满意，再单独精修会更省时间。",
    urgent:
      "我先帮你判断下能不能赶上。你发我 5 个信息：截止时间、页数、有没有初稿、用途、想要的风格。急单的话先做能交付版本，再补视觉细节。",
  };

  const NOTE_PROMPTS = [
    "输入一个课题，AI 生成课件 PPT 是什么效果？",
    "明天公开课，如何快速生成一版课件初稿？",
    "教案转 PPT，不要直接堆文字",
    "小学/初中/高中某科课件生成案例",
    "老师备课最耗时的 3 个环节怎么省？",
    "AI 生成课件后，老师还需要改什么？",
    "一周线索复盘和高频问题整理",
  ];

  const RISK_PATTERNS = [
    { pattern: /微信|VX|V信|手机号|电话|二维码|加我/i, message: "包含站外联系方式，容易触发平台风险。" },
    { pattern: /https?:\/\/|www\./i, message: "公开评论里包含外链，建议改到私信且确认需求后再发。" },
    { pattern: /代做|报价|价格优惠|私我报价/i, message: "表达偏硬广，建议先给具体建议和问题。" },
    { pattern: /(.)\1{6,}/, message: "包含异常重复字符，建议精简。" },
  ];

  let state = loadState();

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return structuredClone(DEFAULT_STATE);
      return mergeState(DEFAULT_STATE, JSON.parse(raw));
    } catch (error) {
      console.warn("[XHS Ops Assistant] Failed to load state", error);
      return structuredClone(DEFAULT_STATE);
    }
  }

  function mergeState(base, incoming) {
    return {
      leads: Array.isArray(incoming.leads) ? incoming.leads : base.leads,
      drafts: Array.isArray(incoming.drafts) ? incoming.drafts : base.drafts,
      settings: { ...base.settings, ...(incoming.settings || {}) },
    };
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function today() {
    return new Date().toISOString().slice(0, 10);
  }

  function nowTime() {
    return new Date().toTimeString().slice(0, 5);
  }

  function uniqueId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function getPageContext() {
    const selection = String(window.getSelection ? window.getSelection() : "").trim();
    const metaTitle =
      document.querySelector('meta[property="og:title"]')?.content ||
      document.querySelector("title")?.textContent ||
      "";
    const metaDescription =
      document.querySelector('meta[property="og:description"]')?.content ||
      document.querySelector('meta[name="description"]')?.content ||
      "";
    return {
      url: location.href,
      title: metaTitle.trim(),
      excerpt: selection || metaDescription.trim(),
    };
  }

  function getCurrentSchedule() {
    const current = nowTime();
    const sorted = [...SCHEDULE].sort((a, b) => a.time.localeCompare(b.time));
    const active = sorted.filter((item) => current >= item.time).at(-1);
    return active || sorted.at(-1);
  }

  function openSearch(keyword) {
    const url = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  function copyText(text, button) {
    const fallback = () => {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.left = "-9999px";
      document.body.appendChild(area);
      area.focus();
      area.select();
      document.execCommand("copy");
      area.remove();
    };

    const done = () => {
      if (!button) return;
      const original = button.textContent;
      button.textContent = "已复制";
      setTimeout(() => {
        button.textContent = original;
      }, 1200);
    };

    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => {
        fallback();
        done();
      });
    } else {
      fallback();
      done();
    }
  }

  function analyzeRisk(text) {
    return RISK_PATTERNS.filter((item) => item.pattern.test(text)).map((item) => item.message);
  }

  function generateComment(type, contextText) {
    const base = COMMENT_TEMPLATES[type] || COMMENT_TEMPLATES.teacher;
    const cleanContext = contextText.replace(/\s+/g, " ").trim();
    if (!cleanContext) return base;
    const shortContext = cleanContext.length > 42 ? `${cleanContext.slice(0, 42)}...` : cleanContext;
    return `看你这个场景像是「${shortContext}」。${base}`;
  }

  function generateDm(type) {
    const template = DM_TEMPLATES[type] || DM_TEMPLATES.teacher;
    return template.replace("{website}", state.settings.website);
  }

  function addLead(formValues) {
    const context = getPageContext();
    state.leads.unshift({
      id: uniqueId("lead"),
      createdAt: new Date().toISOString(),
      date: today(),
      keyword: formValues.keyword,
      user: formValues.user,
      needType: formValues.needType,
      deadline: formValues.deadline,
      status: formValues.status,
      noteUrl: formValues.noteUrl || context.url,
      noteTitle: formValues.noteTitle || context.title,
      commentDraft: formValues.commentDraft,
      notes: formValues.notes,
    });
    state.leads = state.leads.slice(0, 500);
    saveState();
    renderPanel();
  }

  function addDraft(kind, title, body) {
    state.drafts.unshift({
      id: uniqueId("draft"),
      createdAt: new Date().toISOString(),
      kind,
      title,
      body,
    });
    state.drafts = state.drafts.slice(0, 100);
    saveState();
    renderPanel();
  }

  function exportCsv() {
    const headers = [
      "date",
      "keyword",
      "noteUrl",
      "user",
      "needType",
      "deadline",
      "status",
      "commentDraft",
      "notes",
    ];
    const rows = state.leads.map((lead) => headers.map((key) => csvCell(lead[key])));
    const csv = [headers, ...rows].map((row) => row.join(",")).join("\n");
    const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `xhs-leads-${today()}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function csvCell(value) {
    const text = String(value || "");
    return `"${text.replace(/"/g, '""')}"`;
  }

  function requestReminderPermission() {
    if (!("Notification" in window)) {
      alert("当前浏览器不支持桌面提醒。");
      return;
    }
    Notification.requestPermission().then((permission) => {
      state.settings.reminderEnabled = permission === "granted";
      saveState();
      renderPanel();
    });
  }

  function maybeNotify() {
    if (!state.settings.reminderEnabled || !("Notification" in window) || Notification.permission !== "granted") return;
    const active = getCurrentSchedule();
    const key = `${today()}:${active.id}`;
    if (localStorage.getItem(REMINDER_KEY) === key) return;
    const diff = Math.abs(minutesOf(nowTime()) - minutesOf(active.time));
    if (diff > 3) return;
    localStorage.setItem(REMINDER_KEY, key);
    new Notification(`小红书${active.label}`, {
      body: `${active.window}：${active.target}`,
      tag: key,
    });
  }

  function minutesOf(value) {
    const [hour, minute] = value.split(":").map(Number);
    return hour * 60 + minute;
  }

  function dailyStats() {
    const rows = state.leads.filter((lead) => lead.date === today());
    return {
      leads: rows.length,
      replied: rows.filter((lead) => lead.status === "已回复").length,
      dm: rows.filter((lead) => lead.status === "已私信").length,
      website: rows.filter((lead) => lead.status === "已发网站").length,
      done: rows.filter((lead) => lead.status === "已成交").length,
    };
  }

  function installStyles() {
    if (document.getElementById("xhs-ops-assistant-style")) return;
    const style = document.createElement("style");
    style.id = "xhs-ops-assistant-style";
    style.textContent = `
      #xhs-ops-assistant-toggle {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 2147483646;
        width: 48px;
        height: 48px;
        border: 0;
        border-radius: 999px;
        background: #d73f4a;
        color: #fff;
        font: 700 14px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        box-shadow: 0 10px 24px rgba(0, 0, 0, .18);
        cursor: pointer;
      }
      #${PANEL_ID} {
        position: fixed;
        right: 18px;
        bottom: 78px;
        z-index: 2147483646;
        width: min(430px, calc(100vw - 28px));
        max-height: min(760px, calc(100vh - 100px));
        overflow: auto;
        border: 1px solid #dde2e8;
        border-radius: 12px;
        background: #fff;
        color: #20242a;
        box-shadow: 0 18px 48px rgba(20, 27, 39, .22);
        font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      }
      #${PANEL_ID}[hidden] { display: none; }
      #${PANEL_ID} * { box-sizing: border-box; }
      .xhs-ops-head {
        position: sticky;
        top: 0;
        display: flex;
        gap: 10px;
        align-items: center;
        justify-content: space-between;
        padding: 14px 14px 12px;
        border-bottom: 1px solid #e8ecf1;
        background: #fff;
      }
      .xhs-ops-title { font-weight: 800; font-size: 15px; }
      .xhs-ops-sub { margin-top: 2px; color: #667085; font-size: 12px; }
      .xhs-ops-close {
        border: 1px solid #d7dce3;
        background: #fff;
        border-radius: 8px;
        width: 30px;
        height: 30px;
        cursor: pointer;
      }
      .xhs-ops-tabs {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 6px;
        padding: 10px 12px;
        border-bottom: 1px solid #eef1f5;
      }
      .xhs-ops-tab,
      .xhs-ops-btn {
        border: 1px solid #d7dce3;
        border-radius: 8px;
        background: #fff;
        color: #20242a;
        min-height: 32px;
        padding: 6px 9px;
        cursor: pointer;
        font: inherit;
      }
      .xhs-ops-tab[aria-selected="true"],
      .xhs-ops-btn.primary {
        border-color: #d73f4a;
        background: #d73f4a;
        color: #fff;
      }
      .xhs-ops-body { padding: 12px; }
      .xhs-ops-section {
        padding: 12px 0;
        border-bottom: 1px solid #eef1f5;
      }
      .xhs-ops-section:last-child { border-bottom: 0; }
      .xhs-ops-h {
        margin: 0 0 8px;
        font-weight: 800;
        font-size: 14px;
      }
      .xhs-ops-muted {
        color: #667085;
        font-size: 12px;
      }
      .xhs-ops-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      .xhs-ops-row {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
      }
      .xhs-ops-input,
      .xhs-ops-select,
      .xhs-ops-textarea {
        width: 100%;
        border: 1px solid #d7dce3;
        border-radius: 8px;
        padding: 8px 9px;
        background: #fff;
        color: #20242a;
        font: inherit;
      }
      .xhs-ops-textarea {
        min-height: 86px;
        resize: vertical;
      }
      .xhs-ops-label {
        display: grid;
        gap: 4px;
        color: #4b5563;
        font-size: 12px;
      }
      .xhs-ops-label span { font-weight: 650; }
      .xhs-ops-chip {
        border: 1px solid #d7dce3;
        border-radius: 999px;
        background: #f7f9fb;
        padding: 5px 9px;
        cursor: pointer;
        font-size: 12px;
      }
      .xhs-ops-card {
        border: 1px solid #e2e7ee;
        border-radius: 8px;
        padding: 9px;
        background: #fbfcfd;
      }
      .xhs-ops-list {
        display: grid;
        gap: 8px;
      }
      .xhs-ops-risk {
        margin-top: 8px;
        padding: 8px;
        border-radius: 8px;
        background: #fff6e6;
        color: #7a4d00;
        font-size: 12px;
      }
      .xhs-ops-ok {
        margin-top: 8px;
        padding: 8px;
        border-radius: 8px;
        background: #e8f6ef;
        color: #09633c;
        font-size: 12px;
      }
      .xhs-ops-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }
      .xhs-ops-table th,
      .xhs-ops-table td {
        border-bottom: 1px solid #eef1f5;
        padding: 7px 4px;
        text-align: left;
        vertical-align: top;
      }
      .xhs-ops-table th { color: #667085; font-weight: 650; }
      .xhs-ops-footer {
        padding: 10px 12px 12px;
        color: #667085;
        font-size: 11px;
      }
    `;
    document.head.appendChild(style);
  }

  function renderPanel(activeTab = document.querySelector(`#${PANEL_ID}`)?.dataset.tab || "today") {
    installStyles();
    let toggle = document.getElementById("xhs-ops-assistant-toggle");
    if (!toggle) {
      toggle = document.createElement("button");
      toggle.id = "xhs-ops-assistant-toggle";
      toggle.type = "button";
      toggle.textContent = "运营";
      toggle.title = "打开小红书运营辅助面板";
      toggle.addEventListener("click", () => {
        const panel = document.getElementById(PANEL_ID);
        panel.hidden = !panel.hidden;
      });
      document.body.appendChild(toggle);
    }

    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement("aside");
      panel.id = PANEL_ID;
      document.body.appendChild(panel);
    }
    panel.dataset.tab = activeTab;
    panel.innerHTML = panelHtml(activeTab);
    bindPanelEvents(panel);
  }

  function panelHtml(activeTab) {
    const active = getCurrentSchedule();
    return `
      <div class="xhs-ops-head">
        <div>
          <div class="xhs-ops-title">小红书运营辅助</div>
          <div class="xhs-ops-sub">人工确认，不自动发布</div>
        </div>
        <button class="xhs-ops-close" type="button" data-action="close">×</button>
      </div>
      <div class="xhs-ops-tabs" role="tablist">
        ${tabButton("today", "今日", activeTab)}
        ${tabButton("draft", "草稿", activeTab)}
        ${tabButton("lead", "线索", activeTab)}
        ${tabButton("settings", "设置", activeTab)}
      </div>
      <div class="xhs-ops-body">
        ${activeTab === "today" ? todayHtml(active) : ""}
        ${activeTab === "draft" ? draftHtml() : ""}
        ${activeTab === "lead" ? leadHtml() : ""}
        ${activeTab === "settings" ? settingsHtml() : ""}
      </div>
      <div class="xhs-ops-footer">
        合规护栏：脚本只生成草稿、提醒和记录，不提交评论、私信或笔记。
      </div>
    `;
  }

  function tabButton(id, label, activeTab) {
    return `<button class="xhs-ops-tab" type="button" data-tab="${id}" aria-selected="${activeTab === id}">${label}</button>`;
  }

  function todayHtml(active) {
    const stats = dailyStats();
    return `
      <section class="xhs-ops-section">
        <h3 class="xhs-ops-h">${escapeHtml(active.label)} · ${escapeHtml(active.window)}</h3>
        <p class="xhs-ops-muted">${escapeHtml(active.target)}</p>
        <div class="xhs-ops-row" style="margin-top: 9px">
          ${active.keywords.map((keyword) => `<button class="xhs-ops-chip" type="button" data-search="${escapeHtml(keyword)}">${escapeHtml(keyword)}</button>`).join("")}
        </div>
      </section>
      <section class="xhs-ops-section">
        <h3 class="xhs-ops-h">今日数据</h3>
        <div class="xhs-ops-grid">
          <div class="xhs-ops-card">线索 <strong>${stats.leads}</strong></div>
          <div class="xhs-ops-card">已回复 <strong>${stats.replied}</strong></div>
          <div class="xhs-ops-card">已私信 <strong>${stats.dm}</strong></div>
          <div class="xhs-ops-card">已发网站 <strong>${stats.website}</strong></div>
        </div>
      </section>
      <section class="xhs-ops-section">
        <h3 class="xhs-ops-h">高意向关键词</h3>
        <div class="xhs-ops-row">
          ${KEYWORDS.map((keyword) => `<button class="xhs-ops-chip" type="button" data-search="${escapeHtml(keyword)}">${escapeHtml(keyword)}</button>`).join("")}
        </div>
      </section>
      <section class="xhs-ops-section">
        <h3 class="xhs-ops-h">快速记录当前笔记</h3>
        ${leadFormHtml()}
      </section>
    `;
  }

  function draftHtml() {
    const context = getPageContext();
    return `
      <section class="xhs-ops-section">
        <h3 class="xhs-ops-h">评论草稿</h3>
        <label class="xhs-ops-label"><span>场景摘录</span><textarea class="xhs-ops-textarea" id="xhs-comment-context">${escapeHtml(context.excerpt || context.title)}</textarea></label>
        <div class="xhs-ops-grid" style="margin-top: 8px">
          <label class="xhs-ops-label"><span>类型</span>
            <select class="xhs-ops-select" id="xhs-comment-type">
              <option value="teacher">老师课件</option>
              <option value="urgent">急单救火</option>
              <option value="report">汇报/答辩</option>
              <option value="ai">AI 工具引导</option>
            </select>
          </label>
          <label class="xhs-ops-label"><span>动作</span><button class="xhs-ops-btn primary" type="button" data-action="generate-comment">生成评论草稿</button></label>
        </div>
        <textarea class="xhs-ops-textarea" id="xhs-comment-output" style="margin-top: 8px"></textarea>
        <div id="xhs-comment-risk"></div>
        <div class="xhs-ops-row" style="margin-top: 8px">
          <button class="xhs-ops-btn" type="button" data-action="copy-comment">复制评论</button>
          <button class="xhs-ops-btn" type="button" data-action="save-comment-draft">保存草稿</button>
        </div>
      </section>
      <section class="xhs-ops-section">
        <h3 class="xhs-ops-h">私信草稿</h3>
        <div class="xhs-ops-row">
          <button class="xhs-ops-chip" type="button" data-dm="teacher">老师课件诊断</button>
          <button class="xhs-ops-chip" type="button" data-dm="urgent">急单诊断</button>
          <button class="xhs-ops-chip" type="button" data-dm="website">确认需求后发网站</button>
        </div>
        <textarea class="xhs-ops-textarea" id="xhs-dm-output" style="margin-top: 8px"></textarea>
        <div id="xhs-dm-risk"></div>
        <div class="xhs-ops-row" style="margin-top: 8px">
          <button class="xhs-ops-btn" type="button" data-action="copy-dm">复制私信</button>
          <button class="xhs-ops-btn" type="button" data-action="save-dm-draft">保存草稿</button>
        </div>
      </section>
      <section class="xhs-ops-section">
        <h3 class="xhs-ops-h">笔记选题</h3>
        <div class="xhs-ops-list">
          ${NOTE_PROMPTS.map((prompt) => `<div class="xhs-ops-card"><div>${escapeHtml(prompt)}</div><button class="xhs-ops-btn" type="button" data-note-prompt="${escapeHtml(prompt)}" style="margin-top: 7px">生成大纲</button></div>`).join("")}
        </div>
        <textarea class="xhs-ops-textarea" id="xhs-note-output" style="margin-top: 8px"></textarea>
        <div class="xhs-ops-row" style="margin-top: 8px">
          <button class="xhs-ops-btn" type="button" data-action="copy-note">复制笔记大纲</button>
          <button class="xhs-ops-btn" type="button" data-action="save-note-draft">保存草稿</button>
        </div>
      </section>
    `;
  }

  function leadHtml() {
    const rows = state.leads.slice(0, 30);
    return `
      <section class="xhs-ops-section">
        <h3 class="xhs-ops-h">线索记录</h3>
        <div class="xhs-ops-row">
          <button class="xhs-ops-btn primary" type="button" data-action="export-csv">导出 CSV</button>
          <button class="xhs-ops-btn" type="button" data-action="clear-old">清理 30 天前</button>
        </div>
      </section>
      <section class="xhs-ops-section">
        <table class="xhs-ops-table">
          <thead><tr><th>日期</th><th>用户/需求</th><th>状态</th></tr></thead>
          <tbody>
            ${rows.map((lead) => `
              <tr>
                <td>${escapeHtml(lead.date)}</td>
                <td>
                  <strong>${escapeHtml(lead.user || "未填用户")}</strong><br>
                  <span class="xhs-ops-muted">${escapeHtml(lead.needType || "")} ${escapeHtml(lead.keyword || "")}</span><br>
                  <a href="${escapeHtml(lead.noteUrl)}" target="_blank" rel="noreferrer">打开笔记</a>
                </td>
                <td>${escapeHtml(lead.status || "待回复")}</td>
              </tr>
            `).join("") || `<tr><td colspan="3" class="xhs-ops-muted">还没有记录。</td></tr>`}
          </tbody>
        </table>
      </section>
    `;
  }

  function settingsHtml() {
    return `
      <section class="xhs-ops-section">
        <h3 class="xhs-ops-h">基础设置</h3>
        <label class="xhs-ops-label"><span>品牌/工具名</span><input class="xhs-ops-input" id="xhs-setting-brand" value="${escapeHtml(state.settings.brand)}"></label>
        <label class="xhs-ops-label" style="margin-top: 8px"><span>网站地址</span><input class="xhs-ops-input" id="xhs-setting-website" value="${escapeHtml(state.settings.website)}"></label>
        <button class="xhs-ops-btn primary" type="button" data-action="save-settings" style="margin-top: 8px">保存设置</button>
      </section>
      <section class="xhs-ops-section">
        <h3 class="xhs-ops-h">提醒</h3>
        <p class="xhs-ops-muted">提醒时间：08:30、12:30、21:30。提醒只在打开小红书页面时生效。</p>
        <button class="xhs-ops-btn ${state.settings.reminderEnabled ? "primary" : ""}" type="button" data-action="enable-reminder" style="margin-top: 8px">
          ${state.settings.reminderEnabled ? "提醒已开启" : "开启浏览器提醒"}
        </button>
      </section>
      <section class="xhs-ops-section">
        <h3 class="xhs-ops-h">合规护栏</h3>
        <div class="xhs-ops-card">
          不自动发帖、不自动评论、不自动私信、不批量抓取用户、不绕过登录或风控。所有文案需要你人工判断后再发布。
        </div>
      </section>
    `;
  }

  function leadFormHtml() {
    const context = getPageContext();
    return `
      <div class="xhs-ops-grid">
        <label class="xhs-ops-label"><span>关键词</span><input class="xhs-ops-input" id="xhs-lead-keyword"></label>
        <label class="xhs-ops-label"><span>用户昵称</span><input class="xhs-ops-input" id="xhs-lead-user"></label>
      </div>
      <div class="xhs-ops-grid" style="margin-top: 8px">
        <label class="xhs-ops-label"><span>需求类型</span>
          <select class="xhs-ops-select" id="xhs-lead-need">
            <option value="老师课件">老师课件</option>
            <option value="急单 PPT">急单 PPT</option>
            <option value="汇报/答辩">汇报/答辩</option>
            <option value="AI 工具潜客">AI 工具潜客</option>
          </select>
        </label>
        <label class="xhs-ops-label"><span>截止时间</span><input class="xhs-ops-input" id="xhs-lead-deadline" placeholder="今晚/明天/具体日期"></label>
      </div>
      <label class="xhs-ops-label" style="margin-top: 8px"><span>笔记链接</span><input class="xhs-ops-input" id="xhs-lead-url" value="${escapeHtml(context.url)}"></label>
      <label class="xhs-ops-label" style="margin-top: 8px"><span>笔记标题</span><input class="xhs-ops-input" id="xhs-lead-title" value="${escapeHtml(context.title)}"></label>
      <label class="xhs-ops-label" style="margin-top: 8px"><span>评论草稿</span><textarea class="xhs-ops-textarea" id="xhs-lead-comment"></textarea></label>
      <div id="xhs-lead-risk"></div>
      <div class="xhs-ops-grid" style="margin-top: 8px">
        <label class="xhs-ops-label"><span>状态</span>
          <select class="xhs-ops-select" id="xhs-lead-status">
            <option value="待回复">待回复</option>
            <option value="已评论">已评论</option>
            <option value="已回复">已回复</option>
            <option value="已私信">已私信</option>
            <option value="已发网站">已发网站</option>
            <option value="已成交">已成交</option>
            <option value="无效">无效</option>
          </select>
        </label>
        <label class="xhs-ops-label"><span>备注</span><input class="xhs-ops-input" id="xhs-lead-notes"></label>
      </div>
      <button class="xhs-ops-btn primary" type="button" data-action="save-lead" style="margin-top: 8px">保存线索</button>
    `;
  }

  function bindPanelEvents(panel) {
    panel.querySelector('[data-action="close"]')?.addEventListener("click", () => {
      panel.hidden = true;
    });

    panel.querySelectorAll("[data-tab]").forEach((button) => {
      button.addEventListener("click", () => renderPanel(button.dataset.tab));
    });

    panel.querySelectorAll("[data-search]").forEach((button) => {
      button.addEventListener("click", () => openSearch(button.dataset.search));
    });

    panel.querySelector('[data-action="save-lead"]')?.addEventListener("click", () => {
      const commentDraft = valueOf("xhs-lead-comment");
      renderRisk("xhs-lead-risk", commentDraft);
      addLead({
        keyword: valueOf("xhs-lead-keyword"),
        user: valueOf("xhs-lead-user"),
        needType: valueOf("xhs-lead-need"),
        deadline: valueOf("xhs-lead-deadline"),
        noteUrl: valueOf("xhs-lead-url"),
        noteTitle: valueOf("xhs-lead-title"),
        commentDraft,
        status: valueOf("xhs-lead-status"),
        notes: valueOf("xhs-lead-notes"),
      });
    });

    panel.querySelector('[data-action="generate-comment"]')?.addEventListener("click", () => {
      const text = generateComment(valueOf("xhs-comment-type"), valueOf("xhs-comment-context"));
      setValue("xhs-comment-output", text);
      renderRisk("xhs-comment-risk", text);
    });

    panel.querySelector('[data-action="copy-comment"]')?.addEventListener("click", (event) => {
      copyText(valueOf("xhs-comment-output"), event.currentTarget);
    });

    panel.querySelector('[data-action="save-comment-draft"]')?.addEventListener("click", () => {
      addDraft("comment", "评论草稿", valueOf("xhs-comment-output"));
    });

    panel.querySelectorAll("[data-dm]").forEach((button) => {
      button.addEventListener("click", () => {
        const text = generateDm(button.dataset.dm);
        setValue("xhs-dm-output", text);
        renderRisk("xhs-dm-risk", text);
      });
    });

    panel.querySelector('[data-action="copy-dm"]')?.addEventListener("click", (event) => {
      copyText(valueOf("xhs-dm-output"), event.currentTarget);
    });

    panel.querySelector('[data-action="save-dm-draft"]')?.addEventListener("click", () => {
      addDraft("dm", "私信草稿", valueOf("xhs-dm-output"));
    });

    panel.querySelectorAll("[data-note-prompt]").forEach((button) => {
      button.addEventListener("click", () => {
        const outline = generateNoteOutline(button.dataset.notePrompt);
        setValue("xhs-note-output", outline);
      });
    });

    panel.querySelector('[data-action="copy-note"]')?.addEventListener("click", (event) => {
      copyText(valueOf("xhs-note-output"), event.currentTarget);
    });

    panel.querySelector('[data-action="save-note-draft"]')?.addEventListener("click", () => {
      addDraft("note", "笔记大纲", valueOf("xhs-note-output"));
    });

    panel.querySelector('[data-action="export-csv"]')?.addEventListener("click", exportCsv);

    panel.querySelector('[data-action="clear-old"]')?.addEventListener("click", () => {
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      state.leads = state.leads.filter((lead) => new Date(lead.createdAt).getTime() >= cutoff);
      saveState();
      renderPanel("lead");
    });

    panel.querySelector('[data-action="save-settings"]')?.addEventListener("click", () => {
      state.settings.brand = valueOf("xhs-setting-brand") || DEFAULT_STATE.settings.brand;
      state.settings.website = valueOf("xhs-setting-website") || DEFAULT_STATE.settings.website;
      saveState();
      renderPanel("settings");
    });

    panel.querySelector('[data-action="enable-reminder"]')?.addEventListener("click", requestReminderPermission);
  }

  function valueOf(id) {
    return document.getElementById(id)?.value?.trim() || "";
  }

  function setValue(id, value) {
    const element = document.getElementById(id);
    if (element) element.value = value;
  }

  function renderRisk(containerId, text) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const risks = analyzeRisk(text);
    if (!text) {
      container.innerHTML = "";
      return;
    }
    if (risks.length) {
      container.innerHTML = `<div class="xhs-ops-risk">${risks.map(escapeHtml).join("<br>")}</div>`;
    } else {
      container.innerHTML = `<div class="xhs-ops-ok">未发现明显硬广/外链/联系方式风险，仍建议人工确认上下文。</div>`;
    }
  }

  function generateNoteOutline(prompt) {
    const brand = state.settings.brand;
    return [
      `标题：${prompt}`,
      "",
      "开头：先点出一个真实场景，不夸大承诺。",
      "正文：",
      "1. 这个场景最容易卡在哪一步。",
      "2. 先用一个小例子说明解决顺序。",
      `3. 可以用 ${brand} 先生成初稿，再人工调整重点页。`,
      "4. 放一张生成前后或结构对比图。",
      "",
      "结尾互动：不确定你的课题适不适合生成，可以评论年级、科目和课题，我帮你判断先做课件、教案还是练习。",
    ].join("\n");
  }

  renderPanel();
  setInterval(maybeNotify, 60 * 1000);
})();
