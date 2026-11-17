/**
 * Chrome MV3 后台协调中心（Service Worker）：
 * 负责向当前活动标签页注入扫描/填充脚本、汇总多 Frame 表单、执行“本地规则 + 可选大模型兜底”混合匹配并记录站点学习缓存。
 */

import {
  mapUnmatchedFieldsWithLLM,
  parseResumeTextWithLLM,
  testLlmConnection,
} from "../shared/llm-client.js";
import { normalizeLabel, matchFieldsWithRules } from "../shared/rule-matcher.js";
import {
  loadAppState,
  saveLearnedDomainMappings,
} from "../shared/storage.js";

const CONTENT_FILES = [
  "src/content/dom-helpers.js",
  "src/content/scanner.js",
  "src/content/filler.js",
  "src/content/overlay.js",
  "src/content/index.js",
];

// 保存最近一次各 tab 的扫描/执行报告，供 Popup 打开后回显
const lastTabReports = new Map();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleRuntimeMessage(msg)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
  return true;
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "quick-fill") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    await runAutofillWorkflow(tab.id, {});
  }
});

async function handleRuntimeMessage(msg) {
  switch (msg?.type) {
    case "RUN_SCAN": {
      const tabId = msg.tabId || (await getActiveTabId());
      return await runScanPreview(tabId, msg.options || {});
    }
    case "RUN_AUTOFILL": {
      const tabId = msg.tabId || (await getActiveTabId());
      return await runAutofillWorkflow(tabId, msg.options || {});
    }
    case "GET_LAST_REPORT": {
      const tabId = msg.tabId || (await getActiveTabId());
      return { ok: true, report: lastTabReports.get(tabId) || null };
    }
    case "CLEAR_HIGHLIGHTS": {
      const tabId = msg.tabId || (await getActiveTabId());
      await ensureContentScripts(tabId);
      await runInAllFrames(tabId, () => globalThis.__OfferAutofill?.overlay?.clearHighlights());
      return { ok: true };
    }
    case "FOCUS_FIELD": {
      const tabId = msg.tabId || (await getActiveTabId());
      await runInFrame(tabId, msg.frameId ?? 0, (fid) => {
        return globalThis.__OfferAutofill?.overlay?.focusField(fid);
      }, [msg.fieldId]);
      return { ok: true };
    }
    case "SAVE_LEARNED_MAPPING": {
      if (msg.hostname && msg.section && msg.label && msg.path) {
        const key = `${msg.section}::${normalizeLabel(msg.label)}`;
        await saveLearnedDomainMappings(msg.hostname, [{ key, path: msg.path }]);
      }
      return { ok: true };
    }
    case "TEST_LLM":
      return { ok: true, data: await testLlmConnection(msg.config) };
    case "LLM_PARSE_RESUME":
      return { ok: true, profile: await parseResumeTextWithLLM(msg.text, msg.config) };
    default:
      return { ok: false, error: `未知指令: ${msg?.type}` };
  }
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("未找到当前活动标签页");
  return tab.id;
}

async function ensureContentScripts(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: CONTENT_FILES,
    });
  } catch {
    // 某些受限子 iframe 可能不允许注入，降级为仅注入主框架
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: CONTENT_FILES,
    });
  }
}

async function runInAllFrames(tabId, func, args = []) {
  try {
    return await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func,
      args,
    });
  } catch {
    return await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      func,
      args,
    });
  }
}

async function runInFrame(tabId, frameId, func, args = []) {
  const res = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func,
    args,
  });
  return res?.[0]?.result;
}

async function scanAllFrames(tabId) {
  await ensureContentScripts(tabId);
  const frameResults = await runInAllFrames(tabId, () => {
    return globalThis.__OfferAutofill?.scanner?.scanPageForm() || null;
  });

  const frames = [];
  for (const item of frameResults || []) {
    if (!item?.result) continue;
    frames.push({
      frameId: item.frameId,
      ...item.result,
    });
  }
  return frames;
}

function countNonEmptyEntries(arr = []) {
  return arr.filter((entry) =>
    Object.values(entry || {}).some((v) => v != null && String(v).trim() !== "" && v !== "全日制")
  ).length;
}

async function expandMissingSections(tabId, frames, profile) {
  let didExpand = false;
  const targets = {
    education: countNonEmptyEntries(profile.education),
    internships: countNonEmptyEntries(profile.internships),
    projects: countNonEmptyEntries(profile.projects),
  };

  for (const frame of frames) {
    const requests = [];
    for (const btn of frame.addButtons || []) {
      const desired = targets[btn.section] || 0;
      const current = frame.sectionCounts?.[btn.section] || btn.currentCount || 0;
      const needed = Math.min(4, Math.max(0, desired - current));
      if (needed > 0 && !requests.some((r) => r.section === btn.section)) {
        requests.push({ buttonId: btn.buttonId, section: btn.section, times: needed });
      }
    }

    if (requests.length > 0) {
      await runInFrame(
        tabId,
        frame.frameId,
        (reqs) => globalThis.__OfferAutofill?.filler?.clickAddButtons(reqs),
        [requests]
      );
      didExpand = true;
    }
  }

  if (didExpand) {
    await new Promise((r) => setTimeout(r, 320));
  }
  return didExpand;
}

function getActiveProfile(state, overrideProfileId) {
  const pid = overrideProfileId || state.activeProfileId;
  return state.profiles.find((p) => p.id === pid) || state.profiles[0];
}

async function runScanPreview(tabId, opts) {
  const state = await loadAppState();
  const profile = getActiveProfile(state, opts.profileId);
  const overwrite = opts.overwrite ?? state.preferences.overwrite;
  const frames = await scanAllFrames(tabId);

  const mainFrame = frames.find((f) => f.frameId === 0) || frames[0];
  const hostname = mainFrame?.hostname || "";
  const siteLearned = state.learnedMappings[hostname] || {};

  const allFields = frames.flatMap((f) =>
    (f.fields || []).map((field) => ({ ...field, frameId: f.frameId }))
  );

  const ruleResult = matchFieldsWithRules(allFields, profile, {
    learnedMappings: siteLearned,
    overwrite,
  });

  const report = {
    mode: "preview",
    hostname,
    title: mainFrame?.title || "",
    profileName: profile.name,
    totalFields: allFields.length,
    matched: ruleResult.matched,
    unmatched: ruleResult.unmatched,
    skipped: ruleResult.skipped,
    results: [],
    timestamp: Date.now(),
  };

  lastTabReports.set(tabId, report);
  return { ok: true, report };
}

async function runAutofillWorkflow(tabId, opts) {
  const state = await loadAppState();
  const profile = getActiveProfile(state, opts.profileId);
  const overwrite = opts.overwrite ?? state.preferences.overwrite;
  const useLLM = opts.useLLM ?? state.preferences.useLLM;
  const autoExpandSections = opts.autoExpandSections ?? state.preferences.autoExpandSections;

  let frames = await scanAllFrames(tabId);
  if (autoExpandSections) {
    const expanded = await expandMissingSections(tabId, frames, profile);
    if (expanded) {
      frames = await scanAllFrames(tabId);
    }
  }

  const mainFrame = frames.find((f) => f.frameId === 0) || frames[0];
  const hostname = mainFrame?.hostname || "";
  const siteLearned = state.learnedMappings[hostname] || {};

  const allFields = [];
  const fieldFrameMap = new Map();
  for (const frame of frames) {
    for (const f of frame.fields || []) {
      const tagged = { ...f, frameId: frame.frameId };
      allFields.push(tagged);
      fieldFrameMap.set(f.fieldId, tagged);
    }
  }

  const ruleResult = matchFieldsWithRules(allFields, profile, {
    learnedMappings: siteLearned,
    overwrite,
  });

  let llmMatched = [];
  let remainingUnmatched = ruleResult.unmatched;
  let llmError = "";

  if (useLLM && state.llmConfig.enabled && remainingUnmatched.length > 0) {
    try {
      const llmRes = await mapUnmatchedFieldsWithLLM(
        remainingUnmatched,
        profile,
        state.llmConfig
      );
      llmMatched = llmRes.matched;
      remainingUnmatched = llmRes.remaining;
    } catch (err) {
      llmError = err?.message || String(err);
    }
  }

  const fullPlan = [...ruleResult.matched, ...llmMatched];

  // 按 frameId 分组派发填充任务
  const planByFrame = new Map();
  for (const item of fullPlan) {
    const fieldMeta = fieldFrameMap.get(item.fieldId);
    const fid = fieldMeta?.frameId ?? 0;
    if (!planByFrame.has(fid)) planByFrame.set(fid, []);
    planByFrame.get(fid).push({
      ...item,
      controlType: fieldMeta?.controlType,
      name: fieldMeta?.name,
    });
  }

  const execResults = [];
  for (const [frameId, framePlan] of planByFrame.entries()) {
    const res = await runInFrame(
      tabId,
      frameId,
      async (plan) => {
        const out = await globalThis.__OfferAutofill?.filler?.executeFillPlan(plan);
        globalThis.__OfferAutofill?.overlay?.applyHighlights(out || []);
        return out || [];
      },
      [framePlan]
    );
    if (Array.isArray(res)) {
      res.forEach((r) => {
        const meta = fieldFrameMap.get(r.fieldId);
        execResults.push({
          ...r,
          frameId,
          section: meta?.section || "basic",
        });
      });
    }
  }

  // 在主窗口显示汇总浮条
  const okCount = execResults.filter((r) => r.status === "filled" && r.confidence >= 0.8).length;
  const warnCount = execResults.filter((r) => r.status === "filled" && r.confidence < 0.8).length;
  const failCount = execResults.filter((r) => r.status === "failed").length;

  await runInFrame(
    tabId,
    0,
    (summary) => globalThis.__OfferAutofill?.overlay?.applyHighlights([], summary),
    [{ okCount, warnCount, failCount }]
  ).catch(() => {});

  // 记忆大模型高置信度的路径映射
  const toLearn = [];
  for (const r of execResults) {
    if (
      r.status === "filled" &&
      r.source === "llm" &&
      r.confidence >= 0.85 &&
      r.sourcePath &&
      r.sourcePath !== "llm-semantic"
    ) {
      const meta = fieldFrameMap.get(r.fieldId);
      const norm = normalizeLabel(meta?.label || "");
      if (norm) {
        toLearn.push({ key: `${meta.section || "basic"}::${norm}`, path: r.sourcePath });
      }
    }
  }
  if (hostname && toLearn.length > 0) {
    await saveLearnedDomainMappings(hostname, toLearn);
  }

  const report = {
    mode: "filled",
    hostname,
    title: mainFrame?.title || "",
    profileName: profile.name,
    totalFields: allFields.length,
    filledCount: okCount + warnCount,
    warnCount,
    failCount,
    unmatchedCount: remainingUnmatched.length,
    skippedCount: ruleResult.skipped.length,
    llmError,
    results: execResults,
    unmatched: remainingUnmatched,
    skipped: ruleResult.skipped,
    timestamp: Date.now(),
  };

  lastTabReports.set(tabId, report);
  return { ok: true, report };
}
