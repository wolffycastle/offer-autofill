/**
 * 真实 Chromium 端到端测试（通过 ego-browser nodejs 运行）：
 * 1. 启动临时本地静态服务挂载项目目录；
 * 2. 在真实 Chromium 中打开模拟大厂网申页 test-bench/mock-bigtech-form.html；
 * 3. 注入扩展 content/ 脚本，模拟“扫描 -> 自动点击 + 添加教育经历 -> 重扫 -> 本地规则匹配 -> 执行填充”；
 * 4. 点击“提交前状态检验”，断言 React 受控状态、Portal 自定义下拉框、日期与安全跳过边界全部正确；
 * 5. 关闭任务空间并清理临时服务器。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { createSampleProfile, setProfileValue } from "../src/shared/profile-schema.js";
import { matchFieldsWithRules, normalizeLabel } from "../src/shared/rule-matcher.js";

const PROJECT_ROOT = "/Users/mac/.gemini/antigravity/scratch/offer-autofill";
const CONTENT_FILES = [
  "src/content/dom-helpers.js",
  "src/content/scanner.js",
  "src/content/filler.js",
  "src/content/overlay.js",
  "src/content/index.js",
];

function startTempServer(port) {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1"], {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => resolve(proc), 900);
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function runE2E() {
  const port = 18923;
  const server = await startTempServer(port);
  const task = await taskSpace("e2e verify offer-autofill");
  const page = task.page("p1");

  try {
    const url = `http://127.0.0.1:${port}/test-bench/mock-bigtech-form.html`;
    await page.goto(url);
    await page.waitForSelector("#checkStateBtn", { state: "visible" });

    // Load all classic content scripts into the live Chromium page
    const combinedScript = (
      await Promise.all(
        CONTENT_FILES.map((rel) => fs.readFile(path.join(PROJECT_ROOT, rel), "utf8"))
      )
    ).join("\n;\n");

    await page.evaluate((code) => {
      const s = document.createElement("script");
      s.textContent = code;
      document.head.appendChild(s);
    }, combinedScript);

    const profile = createSampleProfile();

    // Step 1: Initial scan
    let scanRes = await page.evaluate(() => globalThis.__OfferAutofill.scanner.scanPageForm());
    assert.ok(scanRes.fields.length >= 20, `预期至少扫描到 20 个控件，实际 ${scanRes.fields.length}`);
    assert.equal(scanRes.sectionCounts.education, 1);

    // Step 2: Simulate auto-expand "+ 添加教育经历" since sample profile has 2 education entries
    const eduAddBtn = scanRes.addButtons.find((b) => b.section === "education");
    assert.ok(eduAddBtn, "应识别到「+ 添加教育经历」按钮");
    await page.evaluate(
      (btnId) => globalThis.__OfferAutofill.filler.clickAddButtons([{ buttonId: btnId, times: 1 }]),
      eduAddBtn.buttonId
    );
    await page.waitForTimeout(250);

    // Step 3: Re-scan after expanding
    scanRes = await page.evaluate(() => globalThis.__OfferAutofill.scanner.scanPageForm());
    assert.equal(scanRes.sectionCounts.education, 2, "点击添加后应有 2 段教育经历");

    // Step 4: Match fields with rules
    const matchRes = matchFieldsWithRules(scanRes.fields, profile, { overwrite: false });
    assert.ok(matchRes.matched.length >= 20, `规则命中数量不足: ${matchRes.matched.length}`);

    const plan = matchRes.matched.map((item) => {
      const meta = scanRes.fields.find((f) => f.fieldId === item.fieldId);
      return {
        ...item,
        controlType: meta.controlType,
        name: meta.name,
      };
    });

    // Step 5: Execute fill + highlight overlay in real Chromium
    const execResults = await page.evaluate(async (fillPlan) => {
      const res = await globalThis.__OfferAutofill.filler.executeFillPlan(fillPlan);
      globalThis.__OfferAutofill.overlay.applyHighlights(res);
      return res;
    }, plan);

    const failed = execResults.filter((r) => r.status === "failed");
    assert.equal(failed.length, 0, `不应有填充失败项: ${JSON.stringify(failed)}`);

    // Step 6: Click validation button & verify React controlled state
    await page.click("#checkStateBtn", { label: "Click validation button" });
    await page.waitForSelector("#validationResult", { state: "visible" });

    const state = await page.evaluate(() => window.__MOCK_CONTROLLED_STATE__);
    assert.equal(state["basic.name"], "陈思远");
    assert.equal(state["basic.pinyin"], "Siyuan Chen");
    assert.equal(state["gender"], "男");
    assert.equal(state["basic.phone"], "13800138000");
    assert.equal(state["basic.email"], "siyuan.chen@example.com");
    assert.equal(state["basic.emergencyContact"], "陈建国");
    assert.equal(state["basic.emergencyPhone"], "13900139000");
    assert.equal(state["intention.targetRole"], "后端研发工程师");
    assert.equal(state["intention.targetCity"], "上海市");
    assert.equal(state["intention.graduationYear"], "2026");
    assert.equal(state["intention.availableDate"], "2026-07-01");

    assert.equal(state["education[0].school"], "复旦大学");
    assert.equal(state["education[0].degree"], "硕士研究生");
    assert.equal(state["education[0].studyType"], "统招全日制");
    assert.equal(state["education[0].startDate"], "2024-09");
    assert.equal(state["education[0].endDate"], "2026-06");

    assert.equal(state["education[1].school"], "华东师范大学");
    assert.equal(state["education[1].degree"], "大学本科");

    assert.equal(state["internships[0].company"], "字节跳动");
    assert.equal(state["internships[0].title"], "后端研发实习生");
    assert.equal(state["internships[0].startDate"], "2025.06");
    assert.equal(state["internships[0].endDate"], "2025.09");

    assert.equal(state["projects[0].name"], "高并发轻量级 API 网关");
    assert.ok(state["qa.whyJoin"].includes("高并发场景"));

    // Security check: SMS code and password must remain untouched
    assert.equal(state["security.smsCode"], undefined);
    assert.equal(state["security.password"], undefined);

    // Check toast overlay is rendered
    const toastText = await page.evaluate(
      () => document.getElementById("oa-autofill-floating-toast")?.textContent || ""
    );
    assert.ok(toastText.includes("网申助手"), "页面右下角应出现填表汇总浮条");

    // Step 7: Missed Required Catch -> User fills on page -> Capture & Record -> Replay on fresh page
    // "招聘信息来源渠道" is marked required and wasn't matched on first run
    const missedChannel = matchRes.unmatched.find(
      (f) => f.label === "招聘信息来源渠道" && f.required === true
    );
    assert.ok(missedChannel, "应将未命中的必填项「招聘信息来源渠道」摘出");

    // Simulate user filling it directly on the webpage, then reading via readFieldValues
    await page.fill('input[data-state-key="qa.channelSource"]', "牛客网");
    const capturedValues = await page.evaluate(
      (fid) => globalThis.__OfferAutofill.scanner.readFieldValues([fid]),
      missedChannel.fieldId
    );
    assert.equal(capturedValues[0].value, "牛客网");

    // Save into globalLearnedRules and also test empty profile field recovery (e.g., basic.wechat)
    const learnedGlobalRules = {
      [`${missedChannel.section}::${normalizeLabel(missedChannel.label)}`]: {
        label: missedChannel.label,
        section: missedChannel.section,
        fixedValue: capturedValues[0].value,
      },
    };
    setProfileValue(profile, "basic.age", "22");

    // Reload fresh page and verify the previously missed required field NOW hits automatically!
    await page.reload();
    await page.waitForSelector("#checkStateBtn", { state: "visible" });
    await page.evaluate((code) => {
      const s = document.createElement("script");
      s.textContent = code;
      document.head.appendChild(s);
    }, combinedScript);

    const scan2 = await page.evaluate(() => globalThis.__OfferAutofill.scanner.scanPageForm());
    const match2 = matchFieldsWithRules(scan2.fields, profile, {
      globalLearnedRules: learnedGlobalRules,
    });
    const channelMatch = match2.matched.find((m) => m.label === "招聘信息来源渠道");
    assert.ok(channelMatch && channelMatch.value === "牛客网", "记录后下次应自动命中「招聘信息来源渠道」");

    const plan2 = match2.matched.map((item) => {
      const meta = scan2.fields.find((f) => f.fieldId === item.fieldId);
      return { ...item, controlType: meta.controlType, name: meta.name };
    });
    await page.evaluate(async (fillPlan) => {
      await globalThis.__OfferAutofill.filler.executeFillPlan(fillPlan);
    }, plan2);
    await page.click("#checkStateBtn", { label: "Verify replayed controlled state" });
    const state2 = await page.evaluate(() => window.__MOCK_CONTROLLED_STATE__);
    assert.equal(state2["qa.channelSource"], "牛客网", "重新打开页面后应自动写入受控状态");

    // Step 8: Feishu Hire (atsx / ud__ / CSS Modules) regression test
    await page.goto(`http://127.0.0.1:${port}/test-bench/mock-feishu-atsx.html`);
    await page.waitForSelector('input[data-k="name"]', { state: "visible" });
    await page.evaluate((code) => {
      const s = document.createElement("script");
      s.textContent = code;
      document.head.appendChild(s);
    }, combinedScript);

    const fsScan = await page.evaluate(() => globalThis.__OfferAutofill.scanner.scanPageForm());
    assert.equal(fsScan.fields.length, 12, `飞书沙盒应扫描到 12 个有效控件（不含+86区号），实际: ${fsScan.fields.length}`);
    assert.ok(fsScan.fields.every((f) => f.label && !f.label.startsWith("oa_f_")), "所有飞书表单控件均应提取出可读 label");

    const nameField = fsScan.fields.find((f) => f.label === "姓名");
    assert.ok(nameField && nameField.required === true, "应识别 CSS ::after 的必填星号");

    const feishuSample = structuredClone(profile);
    feishuSample.basic.age = "22";
    feishuSample.intention.targetCities = ""; // simulate empty preferredCity to test required detection

    const fsMatch = matchFieldsWithRules(fsScan.fields, feishuSample, {});
    const fsPlan = fsMatch.matched.map((item) => {
      const meta = fsScan.fields.find((f) => f.fieldId === item.fieldId);
      return { ...item, controlType: meta.controlType, name: meta.name };
    });

    const fsExec = await page.evaluate(async (p) => {
      return await globalThis.__OfferAutofill.filler.executeFillPlan(p);
    }, fsPlan);
    const fsFailed = fsExec.filter((r) => r.status === "failed");
    assert.equal(fsFailed.length, 0, `飞书控件不应填充失败: ${JSON.stringify(fsFailed)}`);

    const fsState = await page.evaluate(() => window.__FEISHU_STATE__);
    assert.equal(fsState.name, "陈思远");
    assert.equal(fsState.age, "22");
    assert.equal(fsState.mobile, "13800138000");
    assert.equal(fsState.phoneCode, undefined, "+86 电话区号不应被覆盖");
    assert.equal(fsState.email, "siyuan.chen@example.com");
    assert.equal(fsState.gender, "男");
    assert.equal(fsState.currentCity, "上海");
    assert.equal(fsState.school, "复旦大学");
    assert.equal(fsState.degree, "硕士");
    assert.equal(fsState.major, "计算机技术");
    assert.equal(fsState.eduStart, "2024-09");
    assert.equal(fsState.eduEnd, "2026-06");

    const emptyPreferred = fsMatch.skipped.find((s) => s.label === "期望工作地点");
    assert.ok(
      emptyPreferred && emptyPreferred.required === true && emptyPreferred.missingKind === "profile_empty",
      "资料为空的必填项「期望工作地点」应被摘出"
    );

    console.log("E2E CHROMIUM TEST PASSED! Filled state keys:", Object.keys(state2).length, "+ Feishu keys:", Object.keys(fsState).length);
  } finally {
    await task.finish({ keep: [] }).catch(() => {});
    server.kill("SIGTERM");
  }
}

runE2E().catch((err) => {
  console.error("E2E TEST FAILED:", err);
  process.exit(1);
});
