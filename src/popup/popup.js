import { createSampleProfile } from "../shared/profile-schema.js";
import {
  loadAppState,
  savePreferences,
  saveProfiles,
  setActiveProfileId,
} from "../shared/storage.js";

const LEARNABLE_PATHS = [
  { label: "记为该字段独立答案（无需绑定）", value: "__fixed__" },
  { label: "基本信息 · 姓名", value: "basic.name" },
  { label: "基本信息 · 拼音/英文名", value: "basic.pinyin" },
  { label: "基本信息 · 性别", value: "basic.gender" },
  { label: "基本信息 · 年龄", value: "basic.age" },
  { label: "基本信息 · 出生日期", value: "basic.birthday" },
  { label: "基本信息 · 手机号", value: "basic.phone" },
  { label: "基本信息 · 邮箱", value: "basic.email" },
  { label: "基本信息 · 微信号", value: "basic.wechat" },
  { label: "基本信息 · 身份证号", value: "basic.idNumber" },
  { label: "基本信息 · 现居城市", value: "basic.city" },
  { label: "基本信息 · 籍贯/户籍", value: "basic.hometown" },
  { label: "基本信息 · 政治面貌", value: "basic.politicalStatus" },
  { label: "基本信息 · 民族", value: "basic.ethnicity" },
  { label: "基本信息 · GitHub", value: "basic.github" },
  { label: "基本信息 · 个人主页", value: "basic.blog" },
  { label: "基本信息 · 紧急联系人", value: "basic.emergencyContact" },
  { label: "基本信息 · 紧急联系人电话", value: "basic.emergencyPhone" },
  { label: "求职意向 · 毕业届别", value: "intention.graduationYear" },
  { label: "求职意向 · 意向岗位", value: "intention.targetRole" },
  { label: "求职意向 · 意向城市", value: "intention.targetCities" },
  { label: "求职意向 · 到岗时间", value: "intention.availableDate" },
  { label: "求职意向 · 实习时长", value: "intention.internshipDuration" },
  { label: "求职意向 · 是否接受调剂", value: "intention.acceptAdjustment" },
  { label: "教育经历 · 学校", value: "education[0].school" },
  { label: "教育经历 · 学历", value: "education[0].degree" },
  { label: "教育经历 · 专业", value: "education[0].major" },
  { label: "教育经历 · 学院", value: "education[0].college" },
  { label: "教育经历 · 培养方式", value: "education[0].studyType" },
  { label: "教育经历 · GPA", value: "education[0].gpa" },
  { label: "实习经历 · 公司名称", value: "internships[0].company" },
  { label: "实习经历 · 职位名称", value: "internships[0].title" },
  { label: "实习经历 · 工作内容", value: "internships[0].description" },
  { label: "项目经历 · 项目名称", value: "projects[0].name" },
  { label: "项目经历 · 项目描述", value: "projects[0].description" },
  { label: "综合 · 专业技能", value: "skills.summary" },
  { label: "综合 · 英语水平", value: "skills.englishLevel" },
  { label: "综合 · 竞赛获奖", value: "skills.awards" },
  { label: "综合 · 自我评价", value: "skills.selfEvaluation" },
];

const els = {
  siteHost: document.getElementById("siteHost"),
  openOptionsBtn: document.getElementById("openOptionsBtn"),
  profileSelect: document.getElementById("profileSelect"),
  loadSampleQuickBtn: document.getElementById("loadSampleQuickBtn"),
  profileWarn: document.getElementById("profileWarn"),
  llmStatusPill: document.getElementById("llmStatusPill"),
  optUseLLM: document.getElementById("optUseLLM"),
  optAutoExpand: document.getElementById("optAutoExpand"),
  optOverwrite: document.getElementById("optOverwrite"),
  fillBtn: document.getElementById("fillBtn"),
  scanBtn: document.getElementById("scanBtn"),
  clearBtn: document.getElementById("clearBtn"),
  statusBanner: document.getElementById("statusBanner"),
  reportSection: document.getElementById("reportSection"),
  statTotal: document.getElementById("statTotal"),
  statFilled: document.getElementById("statFilled"),
  statWarn: document.getElementById("statWarn"),
  statRemain: document.getElementById("statRemain"),
  missedBadge: document.getElementById("missedBadge"),
  missedToolbar: document.getElementById("missedToolbar"),
  learnScopeSelect: document.getElementById("learnScopeSelect"),
  batchCaptureBtn: document.getElementById("batchCaptureBtn"),
  detailList: document.getElementById("detailList"),
  tabBtns: Array.from(document.querySelectorAll(".tab-btn")),
};

let appState = null;
let currentReport = null;
let activeTab = "filled";
let activeBrowserTab = null;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeBrowserTab = tab || null;

  if (tab?.url) {
    try {
      const u = new URL(tab.url);
      els.siteHost.textContent = u.hostname || tab.url;
    } catch {
      els.siteHost.textContent = tab.title || "当前标签页";
    }
  }

  await refreshState();

  // 回显当前页最近一次扫描/填写结果
  if (tab?.id) {
    const resp = await sendRuntime({ type: "GET_LAST_REPORT", tabId: tab.id });
    if (resp?.ok && resp.report) {
      currentReport = resp.report;
      renderReport(currentReport);
    }
  }

  bindEvents();
}

async function refreshState() {
  appState = await loadAppState();
  renderProfileSelect();
  renderPreferences();
}

function renderProfileSelect() {
  els.profileSelect.innerHTML = "";
  for (const p of appState.profiles) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name || "未命名资料";
    if (p.id === appState.activeProfileId) opt.selected = true;
    els.profileSelect.appendChild(opt);
  }

  const active =
    appState.profiles.find((p) => p.id === appState.activeProfileId) || appState.profiles[0];
  const isBlank = !active?.basic?.name && !active?.basic?.phone && !active?.basic?.email;

  if (isBlank) {
    els.profileWarn.style.display = "block";
    els.profileWarn.textContent = "当前资料还是空的：点击右侧「载入示例」体验，或去「简历与设置」填写。";
    els.loadSampleQuickBtn.style.display = "inline-block";
  } else {
    els.profileWarn.style.display = "none";
    els.loadSampleQuickBtn.style.display = "none";
  }
}

function renderPreferences() {
  const llmReady = Boolean(appState.llmConfig.enabled && appState.llmConfig.baseUrl);
  els.optUseLLM.checked = llmReady && Boolean(appState.preferences.useLLM);
  els.optUseLLM.disabled = !llmReady;
  els.optUseLLM.parentElement.title = llmReady
    ? "本地规则未命中的字段交由大模型语义匹配"
    : "已预留大模型接口，暂无 API 时默认仅使用本地规则；有 API 后可在「简历与设置」中开启";
  els.optAutoExpand.checked = Boolean(appState.preferences.autoExpandSections);
  els.optOverwrite.checked = Boolean(appState.preferences.overwrite);

  if (llmReady) {
    els.llmStatusPill.className = "pill pill-ai";
    els.llmStatusPill.textContent = `AI 兜底 · ${appState.llmConfig.model || "已启用"}`;
  } else {
    els.llmStatusPill.className = "pill pill-muted";
    els.llmStatusPill.textContent = "仅本地规则（AI已预留）";
  }
}

function bindEvents() {
  els.openOptionsBtn.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  els.profileSelect.addEventListener("change", async () => {
    await setActiveProfileId(els.profileSelect.value);
    await refreshState();
  });

  els.loadSampleQuickBtn.addEventListener("click", async () => {
    const sample = createSampleProfile();
    const existingIdx = appState.profiles.findIndex((p) => p.id === sample.id);
    if (existingIdx >= 0) {
      appState.profiles[existingIdx] = sample;
    } else {
      appState.profiles.push(sample);
    }
    await saveProfiles(appState.profiles, sample.id);
    await refreshState();
    showBanner("已载入示例求职资料，你可以直接测试填表或打开设置页替换成自己的简历。", "info");
  });

  const persistPrefs = async () => {
    await savePreferences({
      useLLM: els.optUseLLM.checked,
      autoExpandSections: els.optAutoExpand.checked,
      overwrite: els.optOverwrite.checked,
    });
  };
  els.optUseLLM.addEventListener("change", persistPrefs);
  els.optAutoExpand.addEventListener("change", persistPrefs);
  els.optOverwrite.addEventListener("change", persistPrefs);

  els.fillBtn.addEventListener("click", () => triggerAction("RUN_AUTOFILL"));
  els.scanBtn.addEventListener("click", () => triggerAction("RUN_SCAN"));

  els.clearBtn.addEventListener("click", async () => {
    if (!activeBrowserTab?.id) return;
    await sendRuntime({ type: "CLEAR_HIGHLIGHTS", tabId: activeBrowserTab.id });
    showBanner("已清除当前页面上的填表高亮提示。", "info");
  });

  for (const btn of els.tabBtns) {
    btn.addEventListener("click", () => {
      switchTab(btn.dataset.tab);
    });
  }

  els.batchCaptureBtn.addEventListener("click", async () => {
    if (!currentReport?.missedRequired?.length || !activeBrowserTab?.id) return;
    const pending = currentReport.missedRequired.filter((m) => !m.recorded);
    if (pending.length === 0) {
      showBanner("所有未命中必填项均已记录完毕。", "info");
      return;
    }

    els.batchCaptureBtn.disabled = true;
    els.batchCaptureBtn.textContent = "读取中...";
    const resp = await sendRuntime({
      type: "BATCH_CAPTURE_MISSED",
      tabId: activeBrowserTab.id,
      profileId: els.profileSelect.value,
      hostname: currentReport.hostname,
      fields: pending,
      scope: els.learnScopeSelect.value,
    });
    els.batchCaptureBtn.disabled = false;
    els.batchCaptureBtn.textContent = "📥 读取网页补填并记住";

    if (!resp?.ok) {
      showBanner(`读取失败：${resp?.error || "请刷新页面后重试"}`, "error");
      return;
    }

    const captured = resp.captured || [];
    if (captured.length === 0) {
      showBanner("网页上这几个必填项当前还是空的，请先在网页填好再点读取，或直接在下方输入保存。", "info");
      return;
    }

    const capMap = new Map(captured.map((c) => [c.fieldId, c.value]));
    for (const item of currentReport.missedRequired) {
      if (capMap.has(item.fieldId)) {
        item.recorded = true;
        item.recordedValue = capMap.get(item.fieldId);
      }
    }
    renderReport(currentReport, { preserveTab: true });
    showBanner(`已采集并记住 ${captured.length} 项补填内容，下次遇到同名字段将自动命中！`, "info");
  });
}

function switchTab(tabName) {
  activeTab = tabName;
  els.tabBtns.forEach((b) => b.classList.toggle("active", b.dataset.tab === tabName));
  if (currentReport) renderDetailList(currentReport);
}

async function triggerAction(type) {
  if (!activeBrowserTab?.id) {
    showBanner("无法获取当前标签页，请刷新目标网申页面后重试。", "error");
    return;
  }
  if (/^(chrome|edge|about):/i.test(activeBrowserTab.url || "")) {
    showBanner("浏览器内置页面无法执行自动填表，请切换到具体招聘官网页面。", "error");
    return;
  }

  setBusy(true, type === "RUN_AUTOFILL" ? "正在识别并填充..." : "正在扫描表单...");
  hideBanner();

  const resp = await sendRuntime({
    type,
    tabId: activeBrowserTab.id,
    options: {
      profileId: els.profileSelect.value,
      useLLM: els.optUseLLM.checked,
      autoExpandSections: els.optAutoExpand.checked,
      overwrite: els.optOverwrite.checked,
    },
  });

  setBusy(false);

  if (!resp?.ok) {
    showBanner(`执行失败：${resp?.error || "未知错误（请尝试刷新网页后再试）"}`, "error");
    return;
  }

  currentReport = resp.report;
  renderReport(currentReport);

  if (currentReport.llmError) {
    showBanner(`本地规则已完成填充，但大模型调用失败：${currentReport.llmError}`, "error");
  } else if (currentReport.totalFields === 0) {
    showBanner("未检测到可填写的表单控件（请确认页面是否处于编辑/申请表状态）。", "info");
  } else if (currentReport.mode === "preview") {
    showBanner(
      `预览完成：共扫描 ${currentReport.totalFields} 个控件，本地规则可直接命中 ${currentReport.matched.length} 项。`,
      "info"
    );
  }
}

function setBusy(busy, label = "") {
  els.fillBtn.disabled = busy;
  els.scanBtn.disabled = busy;
  els.fillBtn.textContent = busy && label.includes("填充") ? label : "⚡ 一键智能填表";
  els.scanBtn.textContent = busy && label.includes("扫描") ? label : "🔍 扫描预览";
}

function renderReport(report, { preserveTab = false } = {}) {
  els.reportSection.style.display = "flex";
  els.statTotal.textContent = String(report.totalFields || 0);

  const missed = report.missedRequired || [];
  const pendingCount = missed.filter((m) => !m.recorded).length;

  if (pendingCount > 0) {
    els.missedBadge.style.display = "inline-block";
    els.missedBadge.textContent = String(pendingCount);
  } else {
    els.missedBadge.style.display = "none";
  }

  if (!preserveTab) {
    activeTab = pendingCount > 0 ? "missed" : "filled";
  }
  els.tabBtns.forEach((b) => b.classList.toggle("active", b.dataset.tab === activeTab));

  if (report.mode === "preview") {
    els.statFilled.textContent = String(report.matched?.length || 0);
    els.statWarn.textContent = String(pendingCount);
    els.statRemain.textContent = String(
      (report.unmatched?.length || 0) + (report.skipped?.length || 0)
    );
  } else {
    els.statFilled.textContent = String(report.filledCount || 0);
    els.statWarn.textContent = String(
      (report.warnCount || 0) + (report.failCount || 0) + pendingCount
    );
    els.statRemain.textContent = String(
      (report.unmatchedCount || 0) + (report.skippedCount || 0)
    );
  }

  renderDetailList(report);
}

function renderDetailList(report) {
  els.detailList.innerHTML = "";
  els.missedToolbar.style.display = activeTab === "missed" ? "flex" : "none";

  if (activeTab === "missed") {
    const missed = report.missedRequired || [];
    if (missed.length === 0) {
      els.detailList.innerHTML = `<div class="detail-item"><div class="detail-sub">太棒了！当前页面所有必填项均已命中 🎉</div></div>`;
      return;
    }

    for (const item of missed) {
      const div = document.createElement("div");
      div.className = "detail-item";

      const kindTag = item.recorded
        ? `<span class="badge badge-ok">已记住 ✓</span>`
        : `<span class="badge badge-req">* 必填 · ${
            item.missedKind === "profile_empty" ? "资料为空" : "未识别"
          }</span>`;

      div.innerHTML = `
        <div class="detail-top">
          <span class="detail-name">${escapeHtml(item.label || item.fieldId)}</span>
          ${kindTag}
        </div>
        <div class="detail-sub">${escapeHtml(
          item.recorded ? `已记录值：${item.recordedValue || ""}` : item.reason || ""
        )}</div>
      `;

      if (!item.recorded) {
        const formRow = document.createElement("div");
        formRow.className = "missed-form-row";

        // 若网页字段已知可选项，展示下拉框，否则提供输入框
        let valueCtrl;
        if (Array.isArray(item.options) && item.options.length > 0) {
          valueCtrl = document.createElement("select");
          valueCtrl.className = "missed-input";
          const emptyOpt = document.createElement("option");
          emptyOpt.value = "";
          emptyOpt.textContent = "请选择或补填内容...";
          valueCtrl.appendChild(emptyOpt);
          for (const optText of item.options) {
            const o = document.createElement("option");
            o.value = optText;
            o.textContent = optText;
            valueCtrl.appendChild(o);
          }
        } else {
          valueCtrl = document.createElement("input");
          valueCtrl.className = "missed-input";
          valueCtrl.placeholder = item.placeholder || "输入补充值（记住后下次自动填）";
        }
        valueCtrl.addEventListener("click", (e) => e.stopPropagation());

        const actionRow = document.createElement("div");
        actionRow.className = "learn-row";

        const pathSel = document.createElement("select");
        pathSel.className = "learn-select";
        for (const optDef of LEARNABLE_PATHS) {
          const o = document.createElement("option");
          o.value = optDef.value;
          o.textContent = optDef.label;
          if (item.sourcePath && optDef.value === item.sourcePath) {
            o.selected = true;
          }
          pathSel.appendChild(o);
        }
        // 若 sourcePath 不在预置列表中（如 education[1].gpa），额外插入选项并选中
        if (
          item.sourcePath &&
          !LEARNABLE_PATHS.some((p) => p.value === item.sourcePath)
        ) {
          const customOpt = document.createElement("option");
          customOpt.value = item.sourcePath;
          customOpt.textContent = `写入资料字段 (${item.sourcePath})`;
          customOpt.selected = true;
          pathSel.prepend(customOpt);
        }
        pathSel.addEventListener("click", (e) => e.stopPropagation());

        const saveBtn = document.createElement("button");
        saveBtn.className = "btn-small";
        saveBtn.textContent = "记住并填入";
        saveBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          const val = valueCtrl.value.trim();
          if (!val) {
            showBanner(`请先为「${item.label}」输入要记住的内容。`, "error");
            return;
          }
          saveBtn.disabled = true;
          saveBtn.textContent = "保存中...";
          const resp = await sendRuntime({
            type: "RECORD_AND_FILL_FIELD",
            tabId: activeBrowserTab?.id,
            profileId: els.profileSelect.value,
            hostname: report.hostname,
            field: item,
            value: val,
            targetPath: pathSel.value,
            scope: els.learnScopeSelect.value,
            fillToPage: true,
          });
          if (resp?.ok) {
            item.recorded = true;
            item.recordedValue = val;
            renderReport(report, { preserveTab: true });
            showBanner(`已记住「${item.label} = ${val}」并填入网页，下次将自动命中！`, "info");
          } else {
            saveBtn.disabled = false;
            saveBtn.textContent = "记住并填入";
            showBanner(resp?.error || "保存失败", "error");
          }
        });

        actionRow.append(pathSel, saveBtn);
        formRow.append(valueCtrl, actionRow);
        div.appendChild(formRow);
      }

      div.addEventListener("click", () => focusPageField(item.fieldId, item.frameId ?? 0));
      els.detailList.appendChild(div);
    }
    return;
  }

  if (activeTab === "filled") {
    const items = report.mode === "preview" ? report.matched || [] : report.results || [];
    if (items.length === 0) {
      els.detailList.innerHTML = `<div class="detail-item"><div class="detail-sub">暂无已匹配/已填充字段</div></div>`;
      return;
    }

    for (const item of items) {
      const div = document.createElement("div");
      div.className = "detail-item";

      let badgeClass = "badge-ok";
      let badgeText = report.mode === "preview" ? "待填充" : "已填充";
      if (item.status === "failed") {
        badgeClass = "badge-fail";
        badgeText = "填写失败";
      } else if (typeof item.confidence === "number" && item.confidence < 0.8) {
        badgeClass = "badge-warn";
        badgeText = "待核对";
      }

      const shownVal = item.appliedValue || item.value || "";
      div.innerHTML = `
        <div class="detail-top">
          <span class="detail-name">${escapeHtml(item.label || item.fieldId)}</span>
          <span class="badge ${badgeClass}">${badgeText}</span>
        </div>
        <div class="detail-sub">${escapeHtml(shownVal)}</div>
        <div class="detail-sub">${escapeHtml(item.reason || item.sourcePath || "")}</div>
      `;

      div.addEventListener("click", () => focusPageField(item.fieldId, item.frameId ?? 0));
      els.detailList.appendChild(div);
    }
    return;
  }

  // unmatched & skipped tab
  const unmatched = (report.unmatched || []).map((f) => ({ ...f, _kind: "unmatched" }));
  const skipped = (report.skipped || []).map((f) => ({ ...f, _kind: "skipped" }));
  const combined = [...unmatched, ...skipped];

  if (combined.length === 0) {
    els.detailList.innerHTML = `<div class="detail-item"><div class="detail-sub">所有识别字段均已处理完毕</div></div>`;
    return;
  }

  for (const item of combined) {
    const div = document.createElement("div");
    div.className = "detail-item";

    const isUnmatched = item._kind === "unmatched";
    div.innerHTML = `
      <div class="detail-top">
        <span class="detail-name">${escapeHtml(item.label || item.placeholder || item.fieldId)}</span>
        <span class="badge ${isUnmatched ? "badge-warn" : "badge-skip"}">${
          isUnmatched ? "未匹配" : "已跳过"
        }</span>
      </div>
      <div class="detail-sub">${escapeHtml(
        isUnmatched ? `区块：${item.section || "basic"} · 点击可定位该输入框` : item.reason || ""
      )}</div>
    `;

    if (isUnmatched && report.hostname && item.label) {
      const learnRow = document.createElement("div");
      learnRow.className = "learn-row";
      const sel = document.createElement("select");
      sel.className = "learn-select";
      for (const optDef of LEARNABLE_PATHS) {
        const o = document.createElement("option");
        o.value = optDef.value;
        o.textContent = optDef.label;
        sel.appendChild(o);
      }
      const saveBtn = document.createElement("button");
      saveBtn.className = "btn-small";
      saveBtn.textContent = "记住映射";
      saveBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!sel.value) return;
        await sendRuntime({
          type: "SAVE_LEARNED_MAPPING",
          hostname: report.hostname,
          section: item.section || "basic",
          label: item.label,
          path: sel.value,
        });
        saveBtn.textContent = "已记住 ✓";
        saveBtn.disabled = true;
      });
      sel.addEventListener("click", (e) => e.stopPropagation());
      learnRow.appendChild(sel);
      learnRow.appendChild(saveBtn);
      div.appendChild(learnRow);
    }

    div.addEventListener("click", () => focusPageField(item.fieldId, item.frameId ?? 0));
    els.detailList.appendChild(div);
  }
}

async function focusPageField(fieldId, frameId) {
  if (!activeBrowserTab?.id || !fieldId) return;
  await sendRuntime({ type: "FOCUS_FIELD", tabId: activeBrowserTab.id, fieldId, frameId });
}

function showBanner(msg, kind = "info") {
  els.statusBanner.style.display = "block";
  els.statusBanner.className = `banner ${kind}`;
  els.statusBanner.textContent = msg;
}

function hideBanner() {
  els.statusBanner.style.display = "none";
}

function sendRuntime(payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(payload, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(resp);
      }
    });
  });
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
