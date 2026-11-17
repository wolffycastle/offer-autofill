/**
 * 本地离线启发式简历文本解析器（无需联网或大模型）。
 * 用于快速从粘贴的简历文本中提取常见字段，用户可在界面继续微调。
 */

import { createEmptyEducation, normalizeProfile } from "./profile-schema.js";

export function parseResumeTextLocally(rawText = "") {
  const text = String(rawText).replace(/\r\n/g, "\n").trim();
  const profile = normalizeProfile();
  if (!text) return profile;

  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  // 1. 手机号、邮箱、GitHub、博客
  const phoneMatch = text.match(/(?:\+?86[-\s]?)?(1[3-9]\d{9})/);
  if (phoneMatch) profile.basic.phone = phoneMatch[1];

  const emailMatch = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  if (emailMatch) profile.basic.email = emailMatch[0];

  const githubMatch = text.match(/https?:\/\/github\.com\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)?/i);
  if (githubMatch) profile.basic.github = githubMatch[0];

  const urlMatches = text.match(/https?:\/\/[^\s)）>]+/gi) || [];
  const blogUrl = urlMatches.find((u) => !/github\.com|linkedin\.com/i.test(u));
  if (blogUrl) profile.basic.blog = blogUrl;

  const linkedinMatch = text.match(/https?:\/\/(?:www\.)?linkedin\.com\/in\/[^\s)）>]+/i);
  if (linkedinMatch) profile.basic.linkedin = linkedinMatch[0];

  // 2. 常见标签行提取（如 "姓名：张三"、"性别：男"、"意向岗位：后端开发"）
  const extractLabeled = (re) => {
    for (const line of lines) {
      const m = line.match(re);
      if (m && m[1]) return m[1].trim();
    }
    return "";
  };

  const labeledName = extractLabeled(/(?:姓名|Name)\s*[:：]\s*([^\s|｜/]+(?:\s+[^\s|｜/]+)?)/i);
  if (labeledName) {
    profile.basic.name = labeledName;
  } else if (lines[0] && lines[0].length <= 16 && !/简历|resume|电话|@|\d{5}/i.test(lines[0])) {
    // 很多简历第一行就是姓名
    profile.basic.name = lines[0].replace(/^#+\s*/, "").trim();
  }

  const genderVal = extractLabeled(/(?:性别)\s*[:：]\s*(男|女)/);
  if (genderVal) profile.basic.gender = genderVal;

  const cityVal = extractLabeled(/(?:现居(?:城市)?|所在城市|城市)\s*[:：]\s*([^\s|｜,，]+)/);
  if (cityVal) profile.basic.city = cityVal;

  const roleVal = extractLabeled(/(?:求职意向|意向岗位|应聘岗位|目标岗位)\s*[:：]\s*([^\n|｜]+)/);
  if (roleVal) profile.intention.targetRole = roleVal;

  const gradMatch = text.match(/(202\d)\s*届/);
  if (gradMatch) profile.intention.graduationYear = `${gradMatch[1]}届`;

  // 3. 英语水平
  const cetMatch = text.match(/(CET-?[46]|六级|四级|雅思\s*\d(?:\.\d)?|IELTS\s*\d(?:\.\d)?|托福\s*\d+|TOEFL\s*\d+)(?:\s*[(（]\s*\d+\s*[)）])?/i);
  if (cetMatch) profile.skills.englishLevel = cetMatch[0].trim();

  // 4. 简单提取学校与学历
  const eduEntries = [];
  const schoolRegex = /([\u4e00-\u9fa5A-Za-z]{2,20}(?:大学|学院|University|Institute))/g;
  const degreeRegex = /(博士|硕士|研究生|本科|学士|大专)/;
  for (const line of lines) {
    const sMatch = line.match(schoolRegex);
    if (!sMatch) continue;
    const entry = createEmptyEducation();
    entry.school = sMatch[0];
    const dMatch = line.match(degreeRegex);
    if (dMatch) {
      entry.degree = dMatch[1] === "研究生" ? "硕士" : dMatch[1] === "学士" ? "本科" : dMatch[1];
    }
    const rangeMatch = line.match(
      /(\d{4}\s*[-./年]\s*\d{1,2})月?\s*[-~至—]+\s*(\d{4}\s*[-./年]\s*\d{1,2}月?|至今|现在)/
    );
    if (rangeMatch) {
      entry.startDate = normalizeYm(rangeMatch[1]);
      entry.endDate = /至今|现在/.test(rangeMatch[2]) ? "至今" : normalizeYm(rangeMatch[2]);
    }
    if (!eduEntries.some((e) => e.school === entry.school)) {
      eduEntries.push(entry);
    }
  }
  if (eduEntries.length > 0) {
    profile.education = eduEntries;
  }

  // 5. 提取“专业技能 / 自我评价”段落
  const skillSection = extractSectionText(lines, /^(?:专业技能|技术栈|个人技能|技能清单)/);
  if (skillSection) profile.skills.summary = skillSection;

  const summarySection = extractSectionText(lines, /^(?:自我评价|个人简介|个人总结)/);
  if (summarySection) profile.skills.selfEvaluation = summarySection;

  return normalizeProfile(profile);
}

function normalizeYm(raw) {
  const m = String(raw).match(/(\d{4})\s*[-./年]\s*(\d{1,2})/);
  if (!m) return raw.trim();
  return `${m[1]}-${m[2].padStart(2, "0")}`;
}

function extractSectionText(lines, headerRe) {
  const startIdx = lines.findIndex((l) => headerRe.test(l.replace(/^#+\s*/, "")));
  if (startIdx === -1) return "";
  const collected = [];
  for (let i = startIdx + 1; i < lines.length && i <= startIdx + 6; i++) {
    const line = lines[i].replace(/^#+\s*/, "");
    if (/^(教育背景|教育经历|实习经历|工作经历|项目经历|获奖|校园经历|自我评价|专业技能)/.test(line)) {
      break;
    }
    collected.push(line);
  }
  return collected.join("\n").trim();
}
