import assert from "node:assert/strict";
import { formatDateForField, formatDateRange, parseFlexibleDate } from "../src/shared/date-utils.js";
import { buildFieldMappingMessages, extractJsonFromText } from "../src/shared/llm-client.js";
import {
  buildSanitizedProfileForLLM,
  createSampleProfile,
  getProfileValue,
  normalizeProfile,
  setProfileValue,
} from "../src/shared/profile-schema.js";
import { parseResumeTextLocally } from "../src/shared/resume-parser.js";
import { matchFieldsWithRules, matchOptionValue, normalizeLabel } from "../src/shared/rule-matcher.js";

function runTests() {
  // 1. Date parsing & formatting
  assert.deepEqual(parseFlexibleDate("2024.9"), {
    isPresent: false,
    year: "2024",
    month: "09",
    day: "",
    raw: "2024.9",
  });
  assert.equal(parseFlexibleDate("至今").isPresent, true);
  assert.equal(formatDateForField("2025-06", { placeholder: "YYYY.MM" }), "2025.06");
  assert.equal(formatDateForField("2025-06", { placeholder: "YYYY年MM月" }), "2025年06月");
  assert.equal(formatDateForField("2025-06", { inputType: "date" }), "2025-06-01");
  assert.equal(formatDateForField("2025-06-15", { inputType: "month" }), "2025-06");
  assert.equal(formatDateRange("2024-09", "2026-06", "YYYY.MM"), "2024.09 - 2026.06");

  // 2. Profile schema & sanitized LLM view
  const sample = createSampleProfile();
  assert.equal(getProfileValue(sample, "education[0].school"), "复旦大学");
  assert.equal(getProfileValue(sample, "education[1].degree"), "本科");

  const sanitized = buildSanitizedProfileForLLM(sample);
  const serialized = JSON.stringify(sanitized.nonPiiContext);
  assert.ok(!serialized.includes(sample.basic.phone), "手机号不应出现在脱敏上下文中");
  assert.ok(!serialized.includes(sample.basic.idNumber), "证件号不应出现在脱敏上下文中");
  assert.ok(!serialized.includes(sample.basic.email), "邮箱不应出现在脱敏上下文中");
  assert.ok(sanitized.availablePaths.includes("basic.phone"));

  // 3. Option alias matching
  assert.equal(matchOptionValue("本科", ["大专", "大学本科", "硕士研究生"]), "大学本科");
  assert.equal(matchOptionValue("硕士", ["专科", "本科", "硕士研究生", "博士"]), "硕士研究生");
  assert.equal(matchOptionValue("上海, 北京, 杭州", ["北京市", "上海市", "深圳市"]), "上海市");
  assert.equal(matchOptionValue("全日制", ["统招全日制", "非全日制"]), "统招全日制");
  assert.equal(matchOptionValue("2026届", ["2025届", "2026届", "2027届"]), "2026届");

  // 4. Rule matcher disambiguation & security guard
  const fields = [
    { fieldId: "f1", label: "姓名", section: "basic", entryIndex: 0, inputType: "text", currentValue: "" },
    { fieldId: "f2", label: "紧急联系人姓名", section: "basic", entryIndex: 0, inputType: "text", currentValue: "" },
    { fieldId: "f3", label: "紧急联系人电话", section: "basic", entryIndex: 0, inputType: "tel", currentValue: "" },
    { fieldId: "f4", label: "短信验证码", section: "basic", entryIndex: 0, inputType: "text", currentValue: "" },
    { fieldId: "f5", label: "密码", section: "basic", entryIndex: 0, inputType: "password", currentValue: "" },
    { fieldId: "f6", label: "学校名称", section: "education", entryIndex: 1, inputType: "text", currentValue: "" },
    { fieldId: "f7", label: "公司名称", section: "internships", entryIndex: 0, inputType: "text", currentValue: "" },
    { fieldId: "f8", label: "项目名称", section: "projects", entryIndex: 0, inputType: "text", currentValue: "" },
    { fieldId: "f9", label: "你为什么想加入我们团队？", section: "skills", entryIndex: 0, inputType: "textarea", currentValue: "" },
    { fieldId: "f10", label: "手机号码", section: "basic", entryIndex: 0, inputType: "tel", currentValue: "13999999999" },
    {
      fieldId: "f11",
      label: "培养类型",
      section: "education",
      entryIndex: 0,
      controlType: "custom-select",
      options: ["统招全日制", "非全日制"],
      currentValue: "",
    },
    {
      fieldId: "f12",
      label: "是否愿意接受跨城轮岗",
      section: "intention",
      entryIndex: 0,
      controlType: "custom-select",
      options: ["愿意", "不愿意"],
      currentValue: "",
    },
  ];

  const matchRes = matchFieldsWithRules(fields, sample, { overwrite: false });
  const byId = new Map(matchRes.matched.map((m) => [m.fieldId, m]));

  assert.equal(byId.get("f1").value, "陈思远");
  assert.equal(byId.get("f2").value, "陈建国");
  assert.equal(byId.get("f3").value, "13900139000");
  assert.equal(byId.get("f6").value, "华东师范大学");
  assert.equal(byId.get("f7").value, "字节跳动");
  assert.equal(byId.get("f8").value, "高并发轻量级 API 网关");
  assert.ok(byId.get("f9").value.includes("高并发场景"));
  assert.equal(byId.get("f11").value, "统招全日制");

  // f4, f5 skipped for security; f10 skipped because already filled & overwrite=false
  const skippedIds = new Set(matchRes.skipped.map((s) => s.fieldId));
  assert.ok(skippedIds.has("f4"));
  assert.ok(skippedIds.has("f5"));
  assert.ok(skippedIds.has("f10"));

  // f12 unmatched by local rule -> goes to unmatched for LLM fallback
  assert.ok(matchRes.unmatched.some((u) => u.fieldId === "f12"));

  // 5. LLM prompt & JSON parser
  const msgs = buildFieldMappingMessages(matchRes.unmatched, sample, { allowOpenEndedDraft: false });
  assert.equal(msgs.length, 2);
  assert.ok(!msgs[1].content.includes(sample.basic.idNumber));
  assert.deepEqual(
    extractJsonFromText('```json\n{"mappings":[{"fieldId":"f12","filledValue":"愿意"}]}\n```'),
    { mappings: [{ fieldId: "f12", filledValue: "愿意" }] }
  );

  // 6. Local resume text parser
  const parsedResume = parseResumeTextLocally(`
    林小北
    手机：13712345678
    邮箱：xiaobei@test.com
    GitHub: https://github.com/xiaobei
    2022.09 - 2026.06 上海交通大学 本科 软件工程
    专业技能
    熟悉 TypeScript、React、Node.js
  `);
  assert.equal(parsedResume.basic.name, "林小北");
  assert.equal(parsedResume.basic.phone, "13712345678");
  assert.equal(parsedResume.basic.email, "xiaobei@test.com");
  assert.equal(parsedResume.education[0].school, "上海交通大学");
  assert.equal(parsedResume.education[0].degree, "本科");
  assert.equal(parsedResume.education[0].startDate, "2022-09");
  assert.ok(parsedResume.skills.summary.includes("TypeScript"));

  // Normalize & setProfileValue sanity
  const norm = normalizeProfile({ basic: { name: "测试" } });
  assert.equal(norm.education.length, 1);
  assert.equal(setProfileValue(norm, "basic.city", "杭州"), true);
  assert.equal(getProfileValue(norm, "basic.city"), "杭州");
  assert.equal(setProfileValue(norm, "education[1].school", "南京大学"), true);
  assert.equal(getProfileValue(norm, "education[1].school"), "南京大学");
  assert.equal(setProfileValue(norm, "__proto__.polluted", "bad"), false);

  // 7. Missing required detection + global/site learned rule replay
  const partialProfile = normalizeProfile({
    basic: { name: "测试员", phone: "13800001111" },
    intention: { targetRole: "" },
  });
  const reqFields = [
    { fieldId: "r1", label: "意向岗位", section: "intention", required: true, inputType: "text", currentValue: "" },
    { fieldId: "r2", label: "招聘信息来源渠道", section: "intention", required: true, inputType: "text", currentValue: "" },
  ];
  const missRes = matchFieldsWithRules(reqFields, partialProfile);
  assert.equal(missRes.matched.length, 0);
  const emptySkip = missRes.skipped.find((s) => s.fieldId === "r1");
  assert.equal(emptySkip.missingKind, "profile_empty");
  assert.equal(emptySkip.sourcePath, "intention.targetRole");
  assert.equal(emptySkip.required, true);
  assert.ok(missRes.unmatched.some((u) => u.fieldId === "r2" && u.required));

  // Record missing values and replay -> both must hit now
  setProfileValue(partialProfile, emptySkip.sourcePath, "后端开发工程师");
  const globalRules = {
    [`intention::${normalizeLabel("招聘信息来源渠道")}`]: {
      label: "招聘信息来源渠道",
      section: "intention",
      fixedValue: "牛客网",
    },
  };
  const replayRes = matchFieldsWithRules(reqFields, partialProfile, { globalLearnedRules: globalRules });
  assert.equal(replayRes.matched.length, 2);
  assert.equal(replayRes.matched.find((m) => m.fieldId === "r1").value, "后端开发工程师");
  assert.equal(replayRes.matched.find((m) => m.fieldId === "r2").value, "牛客网");

  console.log("ALL UNIT TESTS PASSED!");
}

runTests();
