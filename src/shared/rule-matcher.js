/**
 * 本地规则与同义词匹配引擎（零网络、毫秒级），并支持下拉选项别名对齐。
 */

import { formatDateForField, formatDateRange, parseFlexibleDate } from "./date-utils.js";
import { getProfileValue } from "./profile-schema.js";

const SKIP_SECURITY_RE =
  /(验证码|图形验证|短信验证|手机验证|邮箱验证|动态码|校验码|安全码|登录密码|确认密码|原密码|新密码|password|passwd|captcha|verify.?code|sms.?code|otp|pin码)/i;

const PLACEHOLDER_VALUE_RE =
  /^(请选择|请填写|请输入|请上传|选择|填写|select\b|please\s+(select|enter|choose))/i;

const DEGREE_ALIASES = {
  博士: ["博士", "博士研究生", "博士学位", "phd", "doctor"],
  硕士: ["硕士", "硕士研究生", "硕士学位", "研究生", "master"],
  本科: ["本科", "大学本科", "全日制本科", "学士", "bachelor"],
  大专: ["大专", "专科", "高职", "college", "associate"],
  高中: ["高中", "中专"],
};

const GENERAL_ALIASES = {
  男: ["男", "男性", "先生", "male", "m"],
  女: ["女", "女性", "女士", "female", "f"],
  身份证: ["居民身份证", "中国居民身份证", "二代身份证", "大陆居民身份证", "身份证", "id card"],
  护照: ["护照", "passport"],
  全日制: ["统招全日制", "全日制", "全日制统招", "普通全日制", "full-time"],
  非全日制: ["非全日制", "在职", "part-time"],
  是: ["是", "接受", "同意", "愿意", "可以", "yes", "true"],
  否: ["否", "不接受", "不同意", "不愿意", "no", "false"],
};

/**
 * 清理标签文本，便于规则匹配与站点缓存键生成。
 */
export function normalizeLabel(text = "") {
  return String(text)
    .replace(/[*＊:：()（）【】\[\]]/g, " ")
    .replace(/(必填|选填|required|optional)/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function isEffectivelyEmptyValue(val) {
  if (val == null) return true;
  const s = String(val).trim();
  if (!s) return true;
  return PLACEHOLDER_VALUE_RE.test(s);
}

export function shouldSkipSecurityField(field) {
  const inputType = String(field.inputType || "").toLowerCase();
  if (inputType === "password" || inputType === "file" || inputType === "hidden") {
    return true;
  }
  const text = `${field.label || ""} ${field.placeholder || ""} ${field.name || ""} ${field.id || ""}`;
  return SKIP_SECURITY_RE.test(text);
}

/**
 * 在给定的下拉选项数组中寻找与期望值最匹配的选项文本。
 * @param {string} desiredValue
 * @param {string[]} options
 * @returns {string | null}
 */
export function matchOptionValue(desiredValue, options = []) {
  if (!desiredValue || !Array.isArray(options) || options.length === 0) return null;
  const cleanOptions = options.map((o) => String(o).trim()).filter(Boolean);
  if (cleanOptions.length === 0) return null;

  // 支持逗号/顿号分隔的多候选值（如意向城市 "上海, 北京, 杭州"）
  const candidates = String(desiredValue)
    .split(/[,，、;；/|]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const candidate of candidates) {
    const matched = matchSingleCandidate(candidate, cleanOptions);
    if (matched) return matched;
  }
  return null;
}

function normalizeOptionText(s) {
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/[\s\-_()（）·.]/g, "")
    .replace(/(省|市|自治区|特别行政区|届)$/g, "");
}

function matchSingleCandidate(candidate, cleanOptions) {
  const normCandidate = normalizeOptionText(candidate);
  if (!normCandidate) return null;

  // 1. Exact or normalized exact match
  for (const opt of cleanOptions) {
    if (opt.toLowerCase() === candidate.toLowerCase()) return opt;
    if (normalizeOptionText(opt) === normCandidate) return opt;
  }

  // 2. Degree alias group match
  for (const [, aliases] of Object.entries(DEGREE_ALIASES)) {
    const inGroup = aliases.some((a) => normCandidate.includes(normalizeOptionText(a)));
    if (inGroup) {
      for (const alias of aliases) {
        const normAlias = normalizeOptionText(alias);
        const exactAlias = cleanOptions.find((o) => normalizeOptionText(o) === normAlias);
        if (exactAlias) return exactAlias;
      }
      const fuzzyAlias = cleanOptions.find((o) => {
        const no = normalizeOptionText(o);
        return aliases.some((a) => no.includes(normalizeOptionText(a))) && !no.includes("非");
      });
      if (fuzzyAlias) return fuzzyAlias;
    }
  }

  // 3. General alias table
  for (const [, aliases] of Object.entries(GENERAL_ALIASES)) {
    if (aliases.some((a) => normCandidate === normalizeOptionText(a))) {
      for (const alias of aliases) {
        const hit = cleanOptions.find((o) => normalizeOptionText(o) === normalizeOptionText(alias));
        if (hit) return hit;
      }
    }
  }

  // 4. Date year/month option match (e.g., "2026届" vs "2026" or "09" vs "9月")
  const parsedDate = parseFlexibleDate(candidate);
  if (parsedDate && parsedDate.year && !parsedDate.month) {
    const yearOpt = cleanOptions.find((o) => o.includes(parsedDate.year));
    if (yearOpt) return yearOpt;
  }
  if (/^\d{1,2}$/.test(candidate.trim())) {
    const num = String(Number(candidate.trim()));
    const numOpt = cleanOptions.find(
      (o) => normalizeOptionText(o) === num || normalizeOptionText(o) === `${num}月`
    );
    if (numOpt) return numOpt;
  }

  // 5. Substring containment (prefer shortest matching option)
  const containsMatches = cleanOptions
    .filter((opt) => {
      if (PLACEHOLDER_VALUE_RE.test(opt)) return false;
      const no = normalizeOptionText(opt);
      return no && (no.includes(normCandidate) || normCandidate.includes(no));
    })
    .sort((a, b) => a.length - b.length);

  if (containsMatches.length > 0) {
    return containsMatches[0];
  }

  return null;
}

/**
 * 规则表：按优先级排序，每条规则定义：
 * - pathFn(section, entryIndex): 返回资料路径
 * - match(text, field): 是否命中
 * - datePart?: 'full' | 'year' | 'month' | 'range'
 */
const FIELD_RULES = [
  // ---- 明确防歧义字段优先 ----
  {
    name: "紧急联系人电话",
    pathFn: () => "basic.emergencyPhone",
    match: (t) => /(紧急联系人|备用联系人|联系人).*(电话|手机|tel|phone|mobile)/.test(t),
  },
  {
    name: "紧急联系人",
    pathFn: () => "basic.emergencyContact",
    match: (t) => /(紧急联系人|备用联系人)(姓名)?/.test(t) && !/(电话|手机|关系)/.test(t),
  },
  {
    name: "GitHub",
    pathFn: () => "basic.github",
    match: (t) => /\bgithub\b/.test(t),
  },
  {
    name: "LinkedIn",
    pathFn: () => "basic.linkedin",
    match: (t) => /\blinkedin\b|领英/.test(t),
  },
  {
    name: "个人主页/作品集",
    pathFn: (sec, idx) => (sec === "projects" ? `projects[${idx}].link` : "basic.blog"),
    match: (t) => /(个人主页|个人网站|博客|作品集|blog|portfolio|homepage|项目链接|代码仓库|演示地址|repo)/.test(t),
  },

  // ---- 教育经历专属字段 ----
  {
    name: "学校名称",
    pathFn: (_sec, idx) => `education[${idx}].school`,
    match: (t) =>
      /(学校|院校|毕业院校|高校|大学|school|university|college)/.test(t) &&
      !/(学院|院系|分院|department|faculty)/.test(t),
  },
  {
    name: "学院/院系",
    pathFn: (_sec, idx) => `education[${idx}].college`,
    match: (t) => /(学院|院系|所在院系|department|faculty)/.test(t) && !/(部门|事业部)/.test(t),
  },
  {
    name: "学历",
    pathFn: (_sec, idx) => `education[${idx}].degree`,
    match: (t) => /(学历|最高学历|学位|degree|education level)/.test(t),
  },
  {
    name: "专业",
    pathFn: (_sec, idx) => `education[${idx}].major`,
    match: (t) => /(专业|所学专业|主修专业|major|discipline)/.test(t) && !/(专业技能)/.test(t),
  },
  {
    name: "培养方式",
    pathFn: (_sec, idx) => `education[${idx}].studyType`,
    match: (t) =>
      /(培养方式|培养类型|学习形式|学制类型|学历类型|学历性质|是否全日制|教育类型|study type)/.test(
        t
      ),
  },
  {
    name: "GPA/成绩排名",
    pathFn: (_sec, idx) => `education[${idx}].gpa`,
    match: (t) => /(gpa|绩点|成绩排名|排名|平均分)/.test(t),
  },
  {
    name: "主修课程",
    pathFn: (_sec, idx) => `education[${idx}].courses`,
    match: (t) => /(主修课程|核心课程|课程描述|courses)/.test(t),
  },
  {
    name: "在校荣誉",
    pathFn: (_sec, idx) => `education[${idx}].honors`,
    match: (t) => /(在校经历|校内职务|在校荣誉|学生工作)/.test(t),
  },

  // ---- 实习/工作经历专属字段 ----
  {
    name: "公司名称",
    pathFn: (_sec, idx) => `internships[${idx}].company`,
    match: (t) => /(公司|企业|单位|雇主|实习单位|company|employer|organization)/.test(t),
  },
  {
    name: "所在部门",
    pathFn: (_sec, idx) => `internships[${idx}].department`,
    match: (t) => /(部门|所在部门|事业部|团队|department)/.test(t) && !/(学院|院系)/.test(t),
  },
  {
    name: "职位名称",
    pathFn: (sec, idx) => {
      if (sec === "internships") return `internships[${idx}].title`;
      if (sec === "projects") return `projects[${idx}].role`;
      return "intention.targetRole";
    },
    match: (t) =>
      /(职位|岗位|职务|头衔|title|position|role)/.test(t) && !/(是否接受|调剂)/.test(t),
    customResolver: (t, _field, sec, idx) => {
      if (sec === "internships" || /(实习|任职|担任)/.test(t)) return `internships[${idx}].title`;
      if (sec === "projects" || /(角色|职责)/.test(t)) return `projects[${idx}].role`;
      return "intention.targetRole";
    },
  },

  // ---- 项目经历专属字段 ----
  {
    name: "项目名称",
    pathFn: (_sec, idx) => `projects[${idx}].name`,
    match: (t) => /(项目名称|项目名|课题名称|project name|project title)/.test(t),
  },
  {
    name: "担任角色",
    pathFn: (_sec, idx) => `projects[${idx}].role`,
    match: (t) => /(担任角色|项目角色|职责|role)/.test(t),
  },

  // ---- 求职意向字段 ----
  {
    name: "意向城市",
    pathFn: (sec, idx) => (sec === "internships" ? `internships[${idx}].city` : "intention.targetCities"),
    match: (t, _f, sec) =>
      sec !== "basic" &&
      (/(意向城市|期望城市|工作城市|意向地点|期望地点|工作地点|preferred city|location)/.test(t) ||
        (sec === "internships" && /(城市|地点|city)/.test(t))),
  },
  {
    name: "期望薪资",
    pathFn: () => "intention.expectedSalary",
    match: (t) => /(期望薪资|薪资要求|期望月薪|期望年薪|salary)/.test(t),
  },
  {
    name: "到岗时间",
    pathFn: () => "intention.availableDate",
    match: (t) => /(到岗时间|可入职时间|最早入职|入职时间|available date)/.test(t),
  },
  {
    name: "实习时长",
    pathFn: () => "intention.internshipDuration",
    match: (t) => /(实习时长|可实习|实习周期|duration)/.test(t),
  },
  {
    name: "毕业届别/年份",
    pathFn: () => "intention.graduationYear",
    match: (t) => /(届别|毕业年份|毕业届|graduation year)/.test(t),
  },
  {
    name: "是否接受调剂",
    pathFn: () => "intention.acceptAdjustment",
    match: (t) => /(调剂|服从分配)/.test(t),
  },

  // ---- 日期类字段（按区块上下文严格区分） ----
  {
    name: "入学时间",
    pathFn: (_sec, idx) => `education[${idx}].startDate`,
    match: (t) => /(入学时间|入学年月|入学日期)/.test(t),
    isDate: true,
  },
  {
    name: "毕业时间",
    pathFn: (_sec, idx) => `education[${idx}].endDate`,
    match: (t) => /(毕业时间|毕业年月|毕业日期|预计毕业)/.test(t),
    isDate: true,
  },
  {
    name: "出生日期",
    pathFn: () => "basic.birthday",
    match: (t) => /(出生日期|出生年月|生日|birth)/.test(t),
    isDate: true,
  },
  {
    name: "起止时间区间",
    pathFn: (sec, idx) => `${sec === "projects" ? "projects" : sec === "internships" ? "internships" : "education"}[${idx}]`,
    match: (t, _f, sec) =>
      ["education", "internships", "projects"].includes(sec) &&
      /(起止时间|时间段|在读时间|实习时间|工作时间|项目时间)/.test(t) &&
      !/(开始|结束|起始|截止)/.test(t),
    datePart: "range",
  },
  {
    name: "开始时间",
    pathFn: (sec, idx) => {
      if (sec === "internships") return `internships[${idx}].startDate`;
      if (sec === "projects") return `projects[${idx}].startDate`;
      return `education[${idx}].startDate`;
    },
    match: (t, _f, sec) =>
      ["education", "internships", "projects"].includes(sec) &&
      /(开始时间|起始时间|开始年月|起始日期|入职时间|start\s*date|from)/.test(t),
    isDate: true,
  },
  {
    name: "结束时间",
    pathFn: (sec, idx) => {
      if (sec === "internships") return `internships[${idx}].endDate`;
      if (sec === "projects") return `projects[${idx}].endDate`;
      return `education[${idx}].endDate`;
    },
    match: (t, _f, sec) =>
      ["education", "internships", "projects"].includes(sec) &&
      /(结束时间|截止时间|结束年月|终止时间|离职时间|end\s*date|\bto\b)/.test(t),
    isDate: true,
  },

  // ---- 描述 / 技能 / 评价 ----
  {
    name: "经历描述",
    pathFn: (sec, idx) => {
      if (sec === "projects") return `projects[${idx}].description`;
      if (sec === "internships") return `internships[${idx}].description`;
      return "skills.selfEvaluation";
    },
    match: (t, _f, sec) =>
      ["internships", "projects"].includes(sec) &&
      /(工作内容|工作描述|实习内容|实习描述|工作职责|主要职责|项目描述|项目内容|项目简介|主要成果|成果业绩|description|responsibilities)/.test(
        t
      ),
  },
  {
    name: "专业技能",
    pathFn: () => "skills.summary",
    match: (t) => /(专业技能|技能清单|技能特长|技术栈|个人技能|掌握技能|skills)/.test(t),
  },
  {
    name: "英语等级",
    pathFn: () => "skills.englishLevel",
    match: (t) => /(英语等级|英语水平|外语等级|四六级|cet|ielts|toefl|英语成绩)/.test(t),
  },
  {
    name: "语言能力",
    pathFn: () => "skills.languages",
    match: (t) => /(语言能力|外语能力|语种|language)/.test(t),
  },
  {
    name: "竞赛获奖",
    pathFn: () => "skills.awards",
    match: (t) => /(获奖|奖项|竞赛|荣誉|奖励|awards|honors)/.test(t),
  },
  {
    name: "论文专利",
    pathFn: () => "skills.papers",
    match: (t) => /(论文|专利|发表|科研成果|publications|patents)/.test(t),
  },
  {
    name: "自我评价",
    pathFn: () => "skills.selfEvaluation",
    match: (t) => /(自我评价|个人简介|个人总结|自我介绍|个人优势|亮点|self.?evaluation|summary|about me)/.test(t),
  },

  // ---- 基本个人信息 ----
  {
    name: "姓名拼音/英文名",
    pathFn: () => "basic.pinyin",
    match: (t) => /(拼音|英文名|english name|pinyin|first.?name|last.?name)/.test(t),
  },
  {
    name: "姓名",
    pathFn: () => "basic.name",
    match: (t) =>
      /(^姓名$|^真实姓名$|^中文姓名$|^候选人姓名$|\bfull\s*name\b|\byour name\b|姓名)/.test(t) &&
      !/(公司|学校|项目|联系人|推荐人|拼音|英文|导师|企业|部门)/.test(t),
  },
  {
    name: "性别",
    pathFn: () => "basic.gender",
    match: (t) => /(性别|gender|sex)/.test(t),
  },
  {
    name: "年龄",
    pathFn: () => "basic.age",
    match: (t) => /(^年龄$|年龄|\bage\b)/.test(t) && !/(工龄|工作年限)/.test(t),
  },
  {
    name: "手机号",
    pathFn: () => "basic.phone",
    match: (t) =>
      /(手机|联系电话|移动电话|电话号码|\bphone\b|\bmobile\b|\btel\b)/.test(t) &&
      !/(紧急|联系人|固定|验证码)/.test(t),
  },
  {
    name: "电子邮箱",
    pathFn: () => "basic.email",
    match: (t) => /(邮箱|电子邮件|\be-?mail\b)/.test(t) && !/(验证码)/.test(t),
  },
  {
    name: "微信号",
    pathFn: () => "basic.wechat",
    match: (t) => /(微信|wechat|wx)/.test(t),
  },
  {
    name: "证件类型",
    pathFn: () => "basic.idType",
    match: (t) => /(证件类型|身份证明类型|id type)/.test(t),
  },
  {
    name: "证件号码",
    pathFn: () => "basic.idNumber",
    match: (t) => /(证件号|身份证|证件号码|id number|identity)/.test(t) && !/(类型)/.test(t),
  },
  {
    name: "现居城市",
    pathFn: () => "basic.city",
    match: (t) =>
      /(现居|现居住|居住地|居住城市|所在城市|常驻城市|目前所在城市|当前城市|通讯地址|现住址|current city)/.test(
        t
      ) && !/(意向|期望|目标)/.test(t),
  },
  {
    name: "籍贯/户籍",
    pathFn: () => "basic.hometown",
    match: (t) => /(籍贯|户籍|户口|生源地|hometown)/.test(t),
  },
  {
    name: "政治面貌",
    pathFn: () => "basic.politicalStatus",
    match: (t) => /(政治面貌|political)/.test(t),
  },
  {
    name: "民族",
    pathFn: () => "basic.ethnicity",
    match: (t) => /(^民族$|民族|ethnicity|nationality)/.test(t),
  },
];

/**
 * 执行本地规则匹配：对每个字段返回命中方案或加入未匹配列表。
 * @param {Array} fields - 页面扫描出的字段列表
 * @param {object} profile - 标准化求职资料
 * @param {{ learnedMappings?: Record<string, object>, globalLearnedRules?: Record<string, object>, overwrite?: boolean }} options
 */
export function matchFieldsWithRules(fields, profile, options = {}) {
  const { learnedMappings = {}, globalLearnedRules = {}, overwrite = false } = options;
  const matched = [];
  const unmatched = [];
  const skipped = [];

  for (const field of fields) {
    if (shouldSkipSecurityField(field)) {
      skipped.push({
        fieldId: field.fieldId,
        frameId: field.frameId ?? 0,
        label: field.label || field.placeholder || field.fieldId,
        required: false,
        section: field.section || "basic",
        entryIndex: field.entryIndex ?? 0,
        missingKind: "security",
        reason: "安全边界：跳过密码/验证码/文件上传字段",
      });
      continue;
    }

    if (!overwrite && !isEffectivelyEmptyValue(field.currentValue)) {
      skipped.push({
        fieldId: field.fieldId,
        frameId: field.frameId ?? 0,
        label: field.label || field.placeholder || field.fieldId,
        required: Boolean(field.required),
        section: field.section || "basic",
        entryIndex: field.entryIndex ?? 0,
        missingKind: "already_filled",
        reason: "已有填写内容，保留现状",
      });
      continue;
    }

    const section = field.section || "basic";
    const entryIndex = Number.isInteger(field.entryIndex) ? field.entryIndex : 0;
    const normLabel = normalizeLabel(field.label || field.placeholder || "");
    const searchText = normalizeLabel(
      `${field.label || ""} ${field.placeholder || ""} ${field.name || ""}`
    );

    // 1. Learned domain-specific & global rules (supporting both profile path and fixedValue)
    const learnedCandidate = findLearnedCandidate(
      normLabel,
      section,
      learnedMappings,
      globalLearnedRules
    );
    if (learnedCandidate) {
      const resolved = resolveLearnedCandidate(
        learnedCandidate.entry,
        field,
        profile,
        entryIndex,
        learnedCandidate.scopeLabel
      );
      if (resolved?.match) {
        matched.push(resolved.match);
        continue;
      }
      if (resolved?.emptyProfilePath) {
        skipped.push({
          fieldId: field.fieldId,
          frameId: field.frameId ?? 0,
          label: field.label || field.placeholder || field.fieldId,
          required: Boolean(field.required),
          section,
          entryIndex,
          controlType: field.controlType,
          options: field.options || [],
          sourcePath: resolved.emptyProfilePath,
          missingKind: "profile_empty",
          reason: `已记住映射字段，但当前资料库中（${resolved.emptyProfilePath}）为空`,
        });
        continue;
      }
    }

    // 2. Custom Q&A match (mostly textarea / open-ended questions)
    const qaHit = matchCustomQA(searchText, profile.customQA);
    if (qaHit) {
      matched.push({
        fieldId: field.fieldId,
        label: field.label || field.placeholder || field.fieldId,
        sourcePath: "customQA",
        value: qaHit.answer,
        confidence: 0.9,
        source: "rule-qa",
        reason: `命中自定义问答关键词 (${qaHit.questionKeywords})`,
      });
      continue;
    }

    // 3. Built-in rule matching
    let ruleMatched = false;
    for (const rule of FIELD_RULES) {
      if (!rule.match(searchText, field, section)) continue;

      const sourcePath = rule.customResolver
        ? rule.customResolver(searchText, field, section, entryIndex)
        : rule.pathFn(section, entryIndex);

      let rawVal = "";
      if (rule.datePart === "range") {
        const entryPrefix = sourcePath;
        const start = getProfileValue(profile, `${entryPrefix}.startDate`);
        const end = getProfileValue(profile, `${entryPrefix}.endDate`);
        rawVal = formatDateRange(start, end, field.placeholder || "");
      } else {
        rawVal = getProfileValue(profile, sourcePath);
      }

      if (!rawVal) {
        // 规则命中了语义，但用户的资料卡这一项本身为空（比如期望薪资留空）
        skipped.push({
          fieldId: field.fieldId,
          frameId: field.frameId ?? 0,
          label: field.label || field.placeholder || field.fieldId,
          required: Boolean(field.required),
          section,
          entryIndex,
          controlType: field.controlType,
          options: field.options || [],
          sourcePath,
          missingKind: "profile_empty",
          reason: `匹配到「${rule.name}」，但个人资料中该项为空，不作猜测`,
        });
        ruleMatched = true;
        break;
      }

      const prepared = prepareFieldValue(rawVal, field, { isDate: Boolean(rule.isDate) });
      if (prepared === null) {
        // 下拉选项未能通过本地规则对齐，交给 LLM 语义兜底
        unmatched.push(field);
        ruleMatched = true;
        break;
      }

      matched.push({
        fieldId: field.fieldId,
        label: field.label || field.placeholder || field.fieldId,
        sourcePath,
        value: prepared,
        confidence: 0.95,
        source: "rule",
        reason: `本地规则命中「${rule.name}」`,
      });
      ruleMatched = true;
      break;
    }

    if (!ruleMatched) {
      unmatched.push(field);
    }
  }

  return { matched, unmatched, skipped };
}

function findLearnedCandidate(normLabel, section, learnedMappings, globalLearnedRules) {
  if (!normLabel) return null;
  const keys = [`${section}::${normLabel}`, `*::${normLabel}`, normLabel];
  for (const k of keys) {
    if (learnedMappings?.[k]) {
      return { entry: learnedMappings[k], scopeLabel: "复用本站点记忆" };
    }
  }
  for (const k of keys) {
    if (globalLearnedRules?.[k]) {
      return { entry: globalLearnedRules[k], scopeLabel: "复用跨站通用记忆" };
    }
  }
  return null;
}

function resolveLearnedCandidate(entry, field, profile, entryIndex, scopeLabel) {
  if (!entry) return null;
  if (entry.path) {
    const learnedPath = resolveEntryIndex(entry.path, entryIndex);
    const rawVal = getProfileValue(profile, learnedPath);
    if (!rawVal) {
      // 若同时存了 fixedValue 作兜底，可回退；否则标记资料为空
      if (!entry.fixedValue) {
        return { emptyProfilePath: learnedPath };
      }
    } else {
      const prepared = prepareFieldValue(rawVal, field, { isDate: /Date$/.test(learnedPath) });
      if (prepared === null) return null;
      return {
        match: {
          fieldId: field.fieldId,
          label: field.label || field.placeholder || field.fieldId,
          sourcePath: learnedPath,
          value: prepared,
          confidence: 0.96,
          source: "learned",
          reason: `${scopeLabel}（${learnedPath}）`,
        },
      };
    }
  }

  if (entry.fixedValue) {
    const prepared = prepareFieldValue(entry.fixedValue, field);
    if (prepared === null) return null;
    return {
      match: {
        fieldId: field.fieldId,
        label: field.label || field.placeholder || field.fieldId,
        sourcePath: "learned-fixed",
        value: prepared,
        confidence: 0.94,
        source: "learned",
        reason: `${scopeLabel}（已记录回答）`,
      },
    };
  }
  return null;
}

function resolveEntryIndex(pathTemplate, entryIndex) {
  return String(pathTemplate).replace(/\[\d+\]/, `[${entryIndex}]`);
}

function matchCustomQA(searchText, customQA = []) {
  if (!searchText || !Array.isArray(customQA)) return null;
  for (const item of customQA) {
    if (!item?.questionKeywords || !item?.answer) continue;
    const parts = item.questionKeywords
      .split("|")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (parts.some((kw) => searchText.includes(kw))) {
      return item;
    }
  }
  return null;
}

/**
 * 结合控件类型准备最终填充值：
 * - 日期字段按 placeholder/inputType 转换格式
 * - 下拉/单选框从候选项中匹配最贴近的选项文本；若无法匹配则返回 null（留给 LLM 兜底）
 */
export function prepareFieldValue(rawVal, field, { isDate = false } = {}) {
  let formatted = rawVal;
  if (isDate) {
    formatted = formatDateForField(rawVal, {
      inputType: field.inputType,
      placeholder: field.placeholder,
      label: field.label,
    });
  }

  if (Array.isArray(field.options) && field.options.length > 0) {
    const optHit = matchOptionValue(formatted, field.options) || matchOptionValue(rawVal, field.options);
    return optHit;
  }

  return formatted;
}
