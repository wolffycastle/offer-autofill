/**
 * Chrome MV3 后台协调中心（Service Worker）：
 * 负责向当前活动标签页注入扫描/填充脚本、汇总多 Frame 表单、执行“本地规则 + 可选大模型兜底”混合匹配并记录站点学习缓存。
 */

import {
  mapUnmatchedFieldsWithLLM,
  parseResumeTextWithLLM,
  testLlmConnection,
} from "../shared/llm-client.js";
import {
  normalizeLabel,
  matchFieldsWithRules,
  shouldSkipSecurityField,
} from "../shared/rule-matcher.js";
import {
  loadAppState,
  saveGlobalLearnedRules,
  saveLearnedDomainMappings,
  updateProfileFieldValues,
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
        await saveLearnedDomainMappings(msg.hostname, [
          { key, label: msg.label, path: msg.path },
        ]);
      }
      return { ok: true };
    }
    case "RECORD_AND_FILL_FIELD":
      return await handleRecordAndFillField(msg);
    case "BATCH_CAPTURE_MISSED":
      return await handleBatchCaptureMissed(msg);
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
    globalLearnedRules: state.globalLearnedRules,
    overwrite,
  });

  const fieldFrameMap = new Map(allFields.map((f) => [f.fieldId, f]));
  const missedRequired = buildMissedRequiredList(
    ruleResult.unmatched,
    ruleResult.skipped,
    [],
    fieldFrameMap
  );

  const report = {
    mode: "preview",
    hostname,
    title: mainFrame?.title || "",
    profileName: profile.name,
    totalFields: allFields.length,
    matched: ruleResult.matched,
    unmatched: ruleResult.unmatched,
    skipped: ruleResult.skipped,
    missedRequired,
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
    globalLearnedRules: state.globalLearnedRules,
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

  const missedRequired = buildMissedRequiredList(
    remainingUnmatched,
    ruleResult.skipped,
    execResults,
    fieldFrameMap
  );

  // 按 frame 标注未命中必填项
  const missingByFrame = new Map();
  for (const m of missedRequired) {
    const fid = m.frameId ?? 0;
    if (!missingByFrame.has(fid)) missingByFrame.set(fid, []);
    missingByFrame.get(fid).push(m.fieldId);
  }
  for (const [frameId, missingIds] of missingByFrame.entries()) {
    await runInFrame(
      tabId,
      frameId,
      (ids) => globalThis.__OfferAutofill?.overlay?.applyHighlights([], null, ids),
      [missingIds]
    ).catch(() => {});
  }

  // 在主窗口显示汇总浮条
  const okCount = execResults.filter((r) => r.status === "filled" && r.confidence >= 0.8).length;
  const warnCount = execResults.filter((r) => r.status === "filled" && r.confidence < 0.8).length;
  const failCount = execResults.filter((r) => r.status === "failed").length;

  await runInFrame(
    tabId,
    0,
    (summary) => globalThis.__OfferAutofill?.overlay?.applyHighlights([], summary),
    [{ okCount, warnCount, failCount, missingReqCount: missedRequired.length }]
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
        toLearn.push({
          key: `${meta.section || "basic"}::${norm}`,
          label: meta?.label || norm,
          path: r.sourcePath,
        });
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
    missedRequired,
    llmError,
    results: execResults,
    unmatched: remainingUnmatched,
    skipped: ruleResult.skipped,
    timestamp: Date.now(),
  };

  lastTabReports.set(tabId, report);
  return { ok: true, report };
}

function buildMissedRequiredList(unmatched = [], skipped = [], execResults = [], fieldFrameMap) {
  const list = [];
  const seen = new Set();

  for (const f of unmatched) {
    if (!f.required || seen.has(f.fieldId)) continue;
    seen.add(f.fieldId);
    list.push({
      fieldId: f.fieldId,
      frameId: f.frameId ?? 0,
      label: f.label || f.contextHint || f.placeholder || f.fieldId,
      placeholder: f.placeholder || "",
      contextHint: f.contextHint || "",
      section: f.section || "basic",
      entryIndex: f.entryIndex ?? 0,
      controlType: f.controlType || "text",
      inputType: f.inputType || "text",
      name: f.name || "",
      options: f.options || [],
      sourcePath: "",
      missedKind: "unmatched",
      reason: "规则未识别该必填字段",
    });
  }

  for (const s of skipped) {
    if (!s.required || s.missingKind !== "profile_empty" || seen.has(s.fieldId)) continue;
    seen.add(s.fieldId);
    list.push({
      fieldId: s.fieldId,
      frameId: s.frameId ?? 0,
      label: s.label,
      placeholder: "",
      section: s.section || "basic",
      entryIndex: s.entryIndex ?? 0,
      controlType: s.controlType || "text",
      inputType: "text",
      name: "",
      options: s.options || [],
      sourcePath: s.sourcePath || "",
      missedKind: "profile_empty",
      reason: s.reason || "个人资料库中该字段为空",
    });
  }

  for (const r of execResults) {
    if (r.status !== "failed" || seen.has(r.fieldId)) continue;
    const meta = fieldFrameMap.get(r.fieldId);
    if (!meta?.required) continue;
    seen.add(r.fieldId);
    list.push({
      fieldId: r.fieldId,
      frameId: r.frameId ?? 0,
      label: meta.label || meta.placeholder || r.fieldId,
      placeholder: meta.placeholder || "",
      section: meta.section || "basic",
      entryIndex: meta.entryIndex ?? 0,
      controlType: meta.controlType || "text",
      inputType: meta.inputType || "text",
      name: meta.name || "",
      options: meta.options || [],
      sourcePath: r.sourcePath || "",
      missedKind: "fill_failed",
      reason: r.reason || "填充失败",
    });
  }

  return list;
}

async function persistLearnedItem({ profileId, hostname, field, value, targetPath, scope }) {
  const cleanVal = value != null ? String(value).trim() : "";
  if (!cleanVal || shouldSkipSecurityField(field)) return false;

  const section = field.section || "basic";
  const label = field.label || field.placeholder || "";
  const norm = normalizeLabel(label);
  const pathToWrite = targetPath || field.sourcePath || "";

  if (pathToWrite && pathToWrite !== "__fixed__") {
    await updateProfileFieldValues(profileId, [{ path: pathToWrite, value: cleanVal }]);
    // 如果之前规则不认识该标签，则顺便记录标签映射，保证下次同义词直接命中
    if (norm && field.missedKind !== "profile_empty") {
      const ruleEntry = { key: `${section}::${norm}`, label, path: pathToWrite, section };
      if (scope === "site" && hostname) {
        await saveLearnedDomainMappings(hostname, [ruleEntry]);
      } else {
        await saveGlobalLearnedRules([ruleEntry]);
      }
    }
    return true;
  }

  if (norm) {
    const ruleEntry = {
      key: `${section}::${norm}`,
      label,
      section,
      fixedValue: cleanVal,
    };
    if (scope === "site" && hostname) {
      await saveLearnedDomainMappings(hostname, [ruleEntry]);
    } else {
      await saveGlobalLearnedRules([ruleEntry]);
    }
    return true;
  }
  return false;
}

async function handleRecordAndFillField(msg) {
  const tabId = msg.tabId || (await getActiveTabId());
  const state = await loadAppState();
  const profileId = msg.profileId || state.activeProfileId;
  const field = msg.field;
  const value = msg.value != null ? String(msg.value).trim() : "";

  if (!field || !value) {
    return { ok: false, error: "请先输入或选择要保存的补充内容" };
  }
  if (shouldSkipSecurityField(field)) {
    return { ok: false, error: "安全边界：密码与验证码字段不允许保存" };
  }

  await persistLearnedItem({
    profileId,
    hostname: msg.hostname || "",
    field,
    value,
    targetPath: msg.targetPath || "",
    scope: msg.scope || "global",
  });

  if (msg.fillToPage) {
    await runInFrame(
      tabId,
      field.frameId ?? 0,
      async (planItem) => {
        const res = await globalThis.__OfferAutofill?.filler?.executeFillPlan([planItem]);
        if (res?.[0]) {
          globalThis.__OfferAutofill?.overlay?.markSingleResult(res[0]);
        }
        return res;
      },
      [
        {
          fieldId: field.fieldId,
          label: field.label,
          controlType: field.controlType,
          name: field.name,
          value,
          confidence: 1,
          source: "learned",
          sourcePath: msg.targetPath || field.sourcePath || "learned-fixed",
          reason: "已补充并记忆",
        },
      ]
    );
  }

  const cached = lastTabReports.get(tabId);
  if (cached && Array.isArray(cached.missedRequired)) {
    const hit = cached.missedRequired.find((m) => m.fieldId === field.fieldId);
    if (hit) {
      hit.recorded = true;
      hit.recordedValue = value;
    }
  }

  return { ok: true };
}

async function handleBatchCaptureMissed(msg) {
  const tabId = msg.tabId || (await getActiveTabId());
  const state = await loadAppState();
  const profileId = msg.profileId || state.activeProfileId;
  const fields = Array.isArray(msg.fields) ? msg.fields : [];
  if (fields.length === 0) return { ok: true, captured: [] };

  const byFrame = new Map();
  for (const f of fields) {
    const fid = f.frameId ?? 0;
    if (!byFrame.has(fid)) byFrame.set(fid, []);
    byFrame.get(fid).push(f.fieldId);
  }

  const readValues = new Map();
  for (const [frameId, ids] of byFrame.entries()) {
    const res = await runInFrame(
      tabId,
      frameId,
      (idList) => globalThis.__OfferAutofill?.scanner?.readFieldValues(idList) || [],
      [ids]
    ).catch(() => []);
    for (const item of res || []) {
      if (item?.fieldId && item.value) {
        readValues.set(item.fieldId, item.value);
      }
    }
  }

  const captured = [];
  for (const f of fields) {
    const val = readValues.get(f.fieldId);
    if (!val) continue;
    const saved = await persistLearnedItem({
      profileId,
      hostname: msg.hostname || "",
      field: f,
      value: val,
      targetPath: f.sourcePath || "",
      scope: msg.scope || "global",
    });
    if (saved) {
      captured.push({ fieldId: f.fieldId, label: f.label, value: val });
    }
  }

  const cached = lastTabReports.get(tabId);
  if (cached && Array.isArray(cached.missedRequired)) {
    const capMap = new Map(captured.map((c) => [c.fieldId, c.value]));
    for (const item of cached.missedRequired) {
      if (capMap.has(item.fieldId)) {
        item.recorded = true;
        item.recordedValue = capMap.get(item.fieldId);
      }
    }
  }

  return { ok: true, captured };
}
