import {
  createEmptyEducation,
  createEmptyInternship,
  createEmptyProfile,
  createEmptyProject,
  createSampleProfile,
  getProfileValue,
  normalizeProfile,
} from "../shared/profile-schema.js";
import { parseResumeTextLocally } from "../shared/resume-parser.js";
import {
  clearGlobalLearnedRules,
  clearLearnedMappings,
  deleteDomainLearnedMapping,
  deleteGlobalLearnedRule,
  loadAppState,
  saveLlmConfig,
  saveProfiles,
  setActiveProfileId,
} from "../shared/storage.js";

const LLM_PRESETS = {
  deepseek: { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  qwen: {
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
  },
  kimi: { baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  ollama: { baseUrl: "http://localhost:11434/v1", model: "qwen2.5:7b" },
};

let appState = null;
let editingProfile = null;
let parsedCandidateProfile = null;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  appState = await loadAppState();
  selectEditingProfile(appState.activeProfileId);
  bindNavigation();
  bindProfileEvents();
  bindImportEvents();
  bindLlmEvents();
  renderAll();
}

function selectEditingProfile(profileId) {
  const found = appState.profiles.find((p) => p.id === profileId) || appState.profiles[0];
  editingProfile = structuredClone(normalizeProfile(found));
}

function renderAll() {
  renderProfileToolbar();
  renderStaticBindings();
  renderRepeatLists();
  renderLlmSettings();
  renderLearnedTable();
}

function bindNavigation() {
  const navBtns = document.querySelectorAll(".nav-item");
  navBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      navBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
      document.getElementById(`view-${btn.dataset.view}`)?.classList.add("active");
    });
  });
}

function renderProfileToolbar() {
  const sel = document.getElementById("profileSelect");
  sel.innerHTML = "";
  for (const p of appState.profiles) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name || "未命名资料";
    if (p.id === editingProfile.id) opt.selected = true;
    sel.appendChild(opt);
  }
  document.getElementById("profileNameInput").value = editingProfile.name || "";
}

function renderStaticBindings() {
  document.querySelectorAll("[data-bind]").forEach((el) => {
    el.value = getProfileValue(editingProfile, el.dataset.bind);
  });
}

function readStaticBindingsIntoProfile() {
  editingProfile.name =
    document.getElementById("profileNameInput").value.trim() || "未命名求职资料";
  document.querySelectorAll("[data-bind]").forEach((el) => {
    setByPath(editingProfile, el.dataset.bind, el.value.trim());
  });
}

function renderRepeatLists() {
  renderEducationList();
  renderInternshipList();
  renderProjectList();
  renderQaList();
}

function renderEducationList() {
  const wrap = document.getElementById("educationList");
  wrap.innerHTML = "";
  editingProfile.education.forEach((edu, idx) => {
    const card = createRepeatCard(`教育经历 #${idx + 1}`, () => {
      if (editingProfile.education.length <= 1) {
        editingProfile.education[0] = createEmptyEducation();
      } else {
        editingProfile.education.splice(idx, 1);
      }
      renderEducationList();
    });
    const grid = document.createElement("div");
    grid.className = "grid-3";
    grid.append(
      makeInput("学校名称", edu.school, (v) => (edu.school = v), "复旦大学"),
      makeSelect(
        "学历",
        edu.degree,
        ["", "本科", "硕士", "博士", "大专"],
        (v) => (edu.degree = v)
      ),
      makeInput("专业", edu.major, (v) => (edu.major = v), "计算机技术"),
      makeInput("学院/院系", edu.college, (v) => (edu.college = v), "计算机学院"),
      makeSelect(
        "培养方式",
        edu.studyType,
        ["全日制", "非全日制"],
        (v) => (edu.studyType = v)
      ),
      makeInput("GPA / 排名", edu.gpa, (v) => (edu.gpa = v), "3.8/4.0 (前10%)"),
      makeInput("入学时间 (YYYY-MM)", edu.startDate, (v) => (edu.startDate = v), "2024-09"),
      makeInput("毕业时间 (YYYY-MM)", edu.endDate, (v) => (edu.endDate = v), "2026-06"),
      makeInput("主修课程", edu.courses, (v) => (edu.courses = v), "分布式系统、数据库"),
      makeInput("在校荣誉/职务", edu.honors, (v) => (edu.honors = v), "一等奖学金")
    );
    card.appendChild(grid);
    wrap.appendChild(card);
  });
}

function renderInternshipList() {
  const wrap = document.getElementById("internshipsList");
  wrap.innerHTML = "";
  editingProfile.internships.forEach((item, idx) => {
    const card = createRepeatCard(`实习 / 工作经历 #${idx + 1}`, () => {
      if (editingProfile.internships.length <= 1) {
        editingProfile.internships[0] = createEmptyInternship();
      } else {
        editingProfile.internships.splice(idx, 1);
      }
      renderInternshipList();
    });
    const grid = document.createElement("div");
    grid.className = "grid-3";
    grid.append(
      makeInput("公司名称", item.company, (v) => (item.company = v), "字节跳动"),
      makeInput("部门", item.department, (v) => (item.department = v), "基础架构部"),
      makeInput("职位名称", item.title, (v) => (item.title = v), "后端研发实习生"),
      makeInput("工作城市", item.city, (v) => (item.city = v), "上海"),
      makeInput("开始时间 (YYYY-MM)", item.startDate, (v) => (item.startDate = v), "2025-06"),
      makeInput("结束时间 (YYYY-MM/至今)", item.endDate, (v) => (item.endDate = v), "2025-09")
    );
    const descWrap = document.createElement("div");
    descWrap.className = "stack";
    descWrap.appendChild(
      makeTextarea("工作内容与成果描述", item.description, (v) => (item.description = v), 3)
    );
    card.append(grid, descWrap);
    wrap.appendChild(card);
  });
}

function renderProjectList() {
  const wrap = document.getElementById("projectsList");
  wrap.innerHTML = "";
  editingProfile.projects.forEach((proj, idx) => {
    const card = createRepeatCard(`项目经历 #${idx + 1}`, () => {
      if (editingProfile.projects.length <= 1) {
        editingProfile.projects[0] = createEmptyProject();
      } else {
        editingProfile.projects.splice(idx, 1);
      }
      renderProjectList();
    });
    const grid = document.createElement("div");
    grid.className = "grid-3";
    grid.append(
      makeInput("项目名称", proj.name, (v) => (proj.name = v), "高并发轻量级 API 网关"),
      makeInput("担任角色", proj.role, (v) => (proj.role = v), "核心开发者"),
      makeInput("项目链接", proj.link, (v) => (proj.link = v), "https://github.com/..."),
      makeInput("开始时间 (YYYY-MM)", proj.startDate, (v) => (proj.startDate = v), "2024-11"),
      makeInput("结束时间 (YYYY-MM)", proj.endDate, (v) => (proj.endDate = v), "2025-03")
    );
    const descWrap = document.createElement("div");
    descWrap.className = "stack";
    descWrap.appendChild(
      makeTextarea("项目描述与个人成果", proj.description, (v) => (proj.description = v), 3)
    );
    card.append(grid, descWrap);
    wrap.appendChild(card);
  });
}

function renderQaList() {
  const wrap = document.getElementById("qaList");
  wrap.innerHTML = "";
  if (editingProfile.customQA.length === 0) {
    wrap.innerHTML = `<p class="desc">暂无自定义问答。可添加诸如 <code>为什么投递|加入我们</code> 的常见网申开放题。</p>`;
    return;
  }
  editingProfile.customQA.forEach((qa, idx) => {
    const card = createRepeatCard(`开放题模板 #${idx + 1}`, () => {
      editingProfile.customQA.splice(idx, 1);
      renderQaList();
    });
    const stack = document.createElement("div");
    stack.className = "stack";
    stack.append(
      makeInput(
        "问题关键词（多个用 | 分隔）",
        qa.questionKeywords,
        (v) => (qa.questionKeywords = v),
        "为什么投递|加入我们|求职动机"
      ),
      makeTextarea("标准回答模板", qa.answer, (v) => (qa.answer = v), 3)
    );
    card.appendChild(stack);
    wrap.appendChild(card);
  });
}

function createRepeatCard(title, onDelete) {
  const card = document.createElement("div");
  card.className = "repeat-card";
  const head = document.createElement("div");
  head.className = "repeat-card-head";
  const span = document.createElement("span");
  span.textContent = title;
  const delBtn = document.createElement("button");
  delBtn.className = "btn-danger-ghost";
  delBtn.type = "button";
  delBtn.textContent = "删除本段";
  delBtn.addEventListener("click", onDelete);
  head.append(span, delBtn);
  card.appendChild(head);
  return card;
}

function makeInput(label, value, onInput, placeholder = "") {
  const lbl = document.createElement("label");
  lbl.className = "field";
  const sp = document.createElement("span");
  sp.textContent = label;
  const inp = document.createElement("input");
  inp.value = value || "";
  inp.placeholder = placeholder;
  inp.addEventListener("input", () => onInput(inp.value.trim()));
  lbl.append(sp, inp);
  return lbl;
}

function makeTextarea(label, value, onInput, rows = 3) {
  const lbl = document.createElement("label");
  lbl.className = "field";
  const sp = document.createElement("span");
  sp.textContent = label;
  const ta = document.createElement("textarea");
  ta.rows = rows;
  ta.value = value || "";
  ta.addEventListener("input", () => onInput(ta.value));
  lbl.append(sp, ta);
  return lbl;
}

function makeSelect(label, value, options, onChange) {
  const lbl = document.createElement("label");
  lbl.className = "field";
  const sp = document.createElement("span");
  sp.textContent = label;
  const sel = document.createElement("select");
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = o;
    opt.textContent = o || "请选择";
    if (o === value) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener("change", () => onChange(sel.value));
  lbl.append(sp, sel);
  return lbl;
}

function bindProfileEvents() {
  document.getElementById("profileSelect").addEventListener("change", async (e) => {
    await setActiveProfileId(e.target.value);
    appState.activeProfileId = e.target.value;
    selectEditingProfile(e.target.value);
    renderAll();
  });

  document.getElementById("newProfileBtn").addEventListener("click", async () => {
    const id = `profile_${Date.now()}`;
    const p = createEmptyProfile(id, `求职资料 ${appState.profiles.length + 1}`);
    appState.profiles.push(p);
    await saveProfiles(appState.profiles, id);
    appState.activeProfileId = id;
    selectEditingProfile(id);
    renderAll();
    showToast("已新建一套求职资料。");
  });

  document.getElementById("deleteProfileBtn").addEventListener("click", async () => {
    if (appState.profiles.length <= 1) {
      showToast("至少保留一套求职资料。", true);
      return;
    }
    appState.profiles = appState.profiles.filter((p) => p.id !== editingProfile.id);
    const nextId = appState.profiles[0].id;
    await saveProfiles(appState.profiles, nextId);
    appState.activeProfileId = nextId;
    selectEditingProfile(nextId);
    renderAll();
    showToast("已删除该资料版本。");
  });

  document.getElementById("saveProfileBtn").addEventListener("click", async () => {
    readStaticBindingsIntoProfile();
    editingProfile.updatedAt = new Date().toISOString();
    const idx = appState.profiles.findIndex((p) => p.id === editingProfile.id);
    if (idx >= 0) appState.profiles[idx] = normalizeProfile(editingProfile);
    else appState.profiles.push(normalizeProfile(editingProfile));

    await saveProfiles(appState.profiles, editingProfile.id);
    appState.activeProfileId = editingProfile.id;
    renderProfileToolbar();
    showToast("资料已保存到本机浏览器！");
  });

  document.getElementById("loadSampleBtn").addEventListener("click", () => {
    const sample = createSampleProfile();
    sample.id = editingProfile.id;
    sample.name = editingProfile.name === "默认求职资料" ? sample.name : editingProfile.name;
    editingProfile = sample;
    renderAll();
    showToast("已填充示例资料，请记得点击右上角「保存资料」（并将个人信息改为你自己的）。");
  });

  document.getElementById("exportJsonBtn").addEventListener("click", () => {
    readStaticBindingsIntoProfile();
    const blob = new Blob([JSON.stringify(editingProfile, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${editingProfile.name || "offer-profile"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  const fileInput = document.getElementById("importFileInput");
  document.getElementById("importJsonBtn").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = normalizeProfile(JSON.parse(text));
      parsed.id = editingProfile.id;
      editingProfile = parsed;
      renderAll();
      showToast("已导入 JSON，请确认内容后点击「保存资料」。");
    } catch (err) {
      showToast(`导入失败：${err.message}`, true);
    } finally {
      fileInput.value = "";
    }
  });

  document.getElementById("addEduBtn").addEventListener("click", () => {
    editingProfile.education.push(createEmptyEducation());
    renderEducationList();
  });
  document.getElementById("addInternBtn").addEventListener("click", () => {
    editingProfile.internships.push(createEmptyInternship());
    renderInternshipList();
  });
  document.getElementById("addProjectBtn").addEventListener("click", () => {
    editingProfile.projects.push(createEmptyProject());
    renderProjectList();
  });
  document.getElementById("addQaBtn").addEventListener("click", () => {
    editingProfile.customQA.push({ questionKeywords: "", answer: "" });
    renderQaList();
  });
}

function bindImportEvents() {
  const textarea = document.getElementById("rawResumeTextarea");
  const previewCard = document.getElementById("parsePreviewCard");
  const previewPre = document.getElementById("parsePreviewJson");

  document.getElementById("localParseBtn").addEventListener("click", () => {
    const raw = textarea.value.trim();
    if (!raw) return;
    parsedCandidateProfile = parseResumeTextLocally(raw);
    previewCard.style.display = "block";
    previewPre.textContent = JSON.stringify(parsedCandidateProfile, null, 2);
  });

  document.getElementById("llmParseBtn").addEventListener("click", async () => {
    const raw = textarea.value.trim();
    if (!raw) return;
    const cfg = collectLlmConfigFromUi();
    if (!cfg.baseUrl || !cfg.model) {
      showToast("请先在「大模型与站点记忆」填写 Base URL 与 Model。", true);
      return;
    }
    const btn = document.getElementById("llmParseBtn");
    btn.disabled = true;
    btn.textContent = "解析中...";
    const resp = await sendRuntime({ type: "LLM_PARSE_RESUME", text: raw, config: cfg });
    btn.disabled = false;
    btn.textContent = "🤖 AI 智能解析整份简历";

    if (!resp?.ok) {
      alert(`AI 解析失败：${resp?.error || "未知错误"}`);
      return;
    }
    parsedCandidateProfile = resp.profile;
    previewCard.style.display = "block";
    previewPre.textContent = JSON.stringify(parsedCandidateProfile, null, 2);
  });

  document.getElementById("applyParsedBtn").addEventListener("click", () => {
    if (!parsedCandidateProfile) return;
    editingProfile = mergeParsedIntoProfile(editingProfile, parsedCandidateProfile);
    renderAll();
    document.querySelector('.nav-item[data-view="profile"]').click();
    showToast("已将解析结果写入当前表单，请核对细节后点击「保存资料」。");
  });
}

function mergeParsedIntoProfile(target, parsed) {
  const merged = structuredClone(target);
  for (const k of Object.keys(parsed.basic || {})) {
    if (parsed.basic[k]) merged.basic[k] = parsed.basic[k];
  }
  for (const k of Object.keys(parsed.intention || {})) {
    if (parsed.intention[k]) merged.intention[k] = parsed.intention[k];
  }
  for (const k of Object.keys(parsed.skills || {})) {
    if (parsed.skills[k]) merged.skills[k] = parsed.skills[k];
  }
  if (parsed.education?.some((e) => e.school)) {
    merged.education = parsed.education;
  }
  if (parsed.internships?.some((e) => e.company)) {
    merged.internships = parsed.internships;
  }
  if (parsed.projects?.some((e) => e.name)) {
    merged.projects = parsed.projects;
  }
  return normalizeProfile(merged);
}

function renderLlmSettings() {
  const cfg = appState.llmConfig;
  document.getElementById("llmEnabled").checked = Boolean(cfg.enabled);
  document.getElementById("llmBaseUrl").value = cfg.baseUrl || "";
  document.getElementById("llmModel").value = cfg.model || "";
  document.getElementById("llmApiKey").value = cfg.apiKey || "";
  document.getElementById("llmAllowDraft").checked = Boolean(cfg.allowOpenEndedDraft);
}

function collectLlmConfigFromUi() {
  return {
    enabled: document.getElementById("llmEnabled").checked,
    baseUrl: document.getElementById("llmBaseUrl").value.trim(),
    model: document.getElementById("llmModel").value.trim(),
    apiKey: document.getElementById("llmApiKey").value.trim(),
    allowOpenEndedDraft: document.getElementById("llmAllowDraft").checked,
  };
}

function bindLlmEvents() {
  document.getElementById("llmPresetSelect").addEventListener("change", (e) => {
    const preset = LLM_PRESETS[e.target.value];
    if (!preset) return;
    document.getElementById("llmBaseUrl").value = preset.baseUrl;
    document.getElementById("llmModel").value = preset.model;
  });

  document.getElementById("saveLlmBtn").addEventListener("click", async () => {
    const cfg = collectLlmConfigFromUi();
    appState.llmConfig = cfg;
    await saveLlmConfig(cfg);
    document.getElementById("llmTestStatus").textContent = "已保存大模型配置 ✓";
  });

  document.getElementById("testLlmBtn").addEventListener("click", async () => {
    const cfg = collectLlmConfigFromUi();
    const statusEl = document.getElementById("llmTestStatus");
    statusEl.textContent = "正在连接测试...";
    const resp = await sendRuntime({ type: "TEST_LLM", config: cfg });
    if (resp?.ok) {
      statusEl.textContent = `连接成功：${resp.data?.reply || "OK"}`;
      statusEl.style.color = "#059669";
    } else {
      statusEl.textContent = `连接失败：${resp?.error || "请检查 URL / Key / 模型名"}`;
      statusEl.style.color = "#dc2626";
    }
  });

  document.getElementById("clearAllGlobalBtn").addEventListener("click", async () => {
    await clearGlobalLearnedRules();
    appState.globalLearnedRules = {};
    renderLearnedTable();
  });

  document.getElementById("clearAllLearnedBtn").addEventListener("click", async () => {
    await clearLearnedMappings();
    appState.learnedMappings = {};
    renderLearnedTable();
  });
}

function renderLearnedTable() {
  renderGlobalRulesTable();

  const wrap = document.getElementById("learnedTableWrap");
  const entries = [];
  for (const [host, siteMap] of Object.entries(appState.learnedMappings || {})) {
    for (const [key, val] of Object.entries(siteMap || {})) {
      entries.push({
        host,
        key,
        label: val?.label || key,
        target: val?.path ? `绑定字段: ${val.path}` : `固定回答: ${val?.fixedValue || ""}`,
      });
    }
  }
  if (entries.length === 0) {
    wrap.innerHTML = `<p class="desc">暂无按域名记忆的字段记录。</p>`;
    return;
  }

  const table = document.createElement("table");
  table.className = "learned-table";
  table.innerHTML = `
    <thead>
      <tr><th>网站域名</th><th>区块 :: 字段名</th><th>记忆内容</th><th>操作</th></tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector("tbody");
  for (const row of entries) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(row.host)}</td>
      <td>${escapeHtml(row.label)}</td>
      <td><code>${escapeHtml(row.target)}</code></td>
      <td><button class="btn-danger-ghost">删除</button></td>
    `;
    tr.querySelector("button").addEventListener("click", async () => {
      await deleteDomainLearnedMapping(row.host, row.key);
      if (appState.learnedMappings[row.host]) {
        delete appState.learnedMappings[row.host][row.key];
      }
      renderLearnedTable();
    });
    tbody.appendChild(tr);
  }
  wrap.innerHTML = "";
  wrap.appendChild(table);
}

function renderGlobalRulesTable() {
  const wrap = document.getElementById("globalLearnedWrap");
  if (!wrap) return;
  const entries = Object.entries(appState.globalLearnedRules || {}).map(([key, val]) => ({
    key,
    label: val?.label || key,
    section: val?.section || "basic",
    target: val?.path ? `绑定字段: ${val.path}` : `固定回答: ${val?.fixedValue || ""}`,
  }));

  if (entries.length === 0) {
    wrap.innerHTML = `<p class="desc">暂无跨网站通用记忆记录。</p>`;
    return;
  }

  const table = document.createElement("table");
  table.className = "learned-table";
  table.innerHTML = `
    <thead>
      <tr><th>区块</th><th>网页字段名</th><th>记忆内容</th><th>操作</th></tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector("tbody");
  for (const row of entries) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(row.section)}</td>
      <td>${escapeHtml(row.label)}</td>
      <td><code>${escapeHtml(row.target)}</code></td>
      <td><button class="btn-danger-ghost">删除</button></td>
    `;
    tr.querySelector("button").addEventListener("click", async () => {
      await deleteGlobalLearnedRule(row.key);
      delete appState.globalLearnedRules[row.key];
      renderLearnedTable();
    });
    tbody.appendChild(tr);
  }
  wrap.innerHTML = "";
  wrap.appendChild(table);
}

function setByPath(obj, path, value) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur[parts[i]];
    if (!cur) return;
  }
  cur[parts[parts.length - 1]] = value;
}

function showToast(msg, isError = false) {
  const el = document.getElementById("profileToast");
  el.textContent = msg;
  el.className = isError ? "toast error" : "toast";
  el.style.display = "block";
  setTimeout(() => {
    el.style.display = "none";
  }, 4000);
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
