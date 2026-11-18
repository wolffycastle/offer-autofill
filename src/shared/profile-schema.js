/**
 * 个人求职资料的标准 Schema、默认值、安全脱敏视图与路径读取工具。
 */

export const PII_FIELDS = new Set([
  "basic.name",
  "basic.pinyin",
  "basic.phone",
  "basic.email",
  "basic.wechat",
  "basic.idNumber",
  "basic.birthday",
  "basic.emergencyContact",
  "basic.emergencyPhone",
]);

export function createEmptyProfile(id = "default", name = "默认求职资料") {
  return {
    id,
    name,
    updatedAt: new Date().toISOString(),
    basic: {
      name: "",
      pinyin: "",
      gender: "",
      age: "",
      birthday: "",
      phone: "",
      email: "",
      wechat: "",
      idType: "身份证",
      idNumber: "",
      city: "",
      hometown: "",
      politicalStatus: "",
      ethnicity: "",
      github: "",
      blog: "",
      linkedin: "",
      emergencyContact: "",
      emergencyPhone: "",
    },
    intention: {
      targetRole: "",
      targetCities: "",
      expectedSalary: "",
      availableDate: "",
      internshipDuration: "",
      graduationYear: "",
      acceptAdjustment: "",
    },
    education: [createEmptyEducation()],
    internships: [createEmptyInternship()],
    projects: [createEmptyProject()],
    skills: {
      summary: "",
      englishLevel: "",
      languages: "",
      awards: "",
      papers: "",
      selfEvaluation: "",
    },
    customQA: [],
  };
}

export function createEmptyEducation() {
  return {
    school: "",
    degree: "",
    major: "",
    college: "",
    studyType: "全日制",
    startDate: "",
    endDate: "",
    gpa: "",
    courses: "",
    honors: "",
  };
}

export function createEmptyInternship() {
  return {
    company: "",
    department: "",
    title: "",
    city: "",
    startDate: "",
    endDate: "",
    description: "",
  };
}

export function createEmptyProject() {
  return {
    name: "",
    role: "",
    startDate: "",
    endDate: "",
    link: "",
    description: "",
  };
}

/**
 * 合并用户输入的残缺资料对象到完整 Schema，确保结构稳定。
 */
export function normalizeProfile(raw = {}) {
  const base = createEmptyProfile(raw.id || "default", raw.name || "默认求职资料");
  return {
    id: String(raw.id || base.id),
    name: String(raw.name || base.name),
    updatedAt: raw.updatedAt || new Date().toISOString(),
    basic: { ...base.basic, ...(raw.basic || {}) },
    intention: { ...base.intention, ...(raw.intention || {}) },
    education: Array.isArray(raw.education) && raw.education.length > 0
      ? raw.education.map((item) => ({ ...createEmptyEducation(), ...item }))
      : base.education,
    internships: Array.isArray(raw.internships) && raw.internships.length > 0
      ? raw.internships.map((item) => ({ ...createEmptyInternship(), ...item }))
      : base.internships,
    projects: Array.isArray(raw.projects) && raw.projects.length > 0
      ? raw.projects.map((item) => ({ ...createEmptyProject(), ...item }))
      : base.projects,
    skills: { ...base.skills, ...(raw.skills || {}) },
    customQA: Array.isArray(raw.customQA)
      ? raw.customQA
          .filter((item) => item && (item.questionKeywords || item.answer))
          .map((item) => ({
            questionKeywords: String(item.questionKeywords || ""),
            answer: String(item.answer || ""),
          }))
      : [],
  };
}

/**
 * 根据类似 "education[0].school" 或 "basic.phone" 的路径读取字段值。
 */
export function getProfileValue(profile, path) {
  if (!profile || !path || typeof path !== "string") return "";
  const segments = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let cur = profile;
  for (const seg of segments) {
    if (cur == null || typeof cur !== "object") return "";
    cur = cur[seg];
  }
  return cur == null ? "" : String(cur).trim();
}

const ARRAY_CREATORS = {
  education: createEmptyEducation,
  internships: createEmptyInternship,
  projects: createEmptyProject,
};

/**
 * 根据路径写入个人资料字段（如 "basic.city" 或 "education[0].gpa"），返回是否写入成功。
 */
export function setProfileValue(profile, path, value) {
  if (!profile || !path || typeof path !== "string") return false;
  const segments = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  if (segments.length < 2) return false;
  if (segments.some((s) => s === "__proto__" || s === "constructor" || s === "prototype")) {
    return false;
  }

  let cur = profile;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const nextSeg = segments[i + 1];
    if (Array.isArray(cur) && /^\d+$/.test(seg)) {
      const idx = Number(seg);
      const rootKey = segments[0];
      const creator = ARRAY_CREATORS[rootKey] || (() => ({}));
      while (cur.length <= idx) {
        cur.push(creator());
      }
      cur = cur[idx];
    } else if (cur && typeof cur === "object") {
      if (cur[seg] == null || typeof cur[seg] !== "object") {
        cur[seg] = /^\d+$/.test(nextSeg) ? [] : {};
      }
      cur = cur[seg];
    } else {
      return false;
    }
  }

  const leaf = segments[segments.length - 1];
  if (!cur || typeof cur !== "object" || !(leaf in cur)) {
    // 只允许写入已知 Schema 字段，防止污染
    return false;
  }
  cur[leaf] = value == null ? "" : String(value).trim();
  return true;
}

/**
 * 生成一份仅供 LLM 语义映射使用的脱敏资料摘要：
 * - 隐藏手机号、证件号、邮箱、姓名等强隐私 PII 值的具体内容（仅告知字段路径可用），
 * - 保留学历、培养方式、届别、城市、经历标题等有助于枚举对齐的上下文。
 */
export function buildSanitizedProfileForLLM(profile) {
  const normalized = normalizeProfile(profile);
  const availablePaths = [];

  const collectPaths = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj)) {
      const path = `${prefix}.${k}`;
      if (v != null && String(v).trim() !== "") {
        availablePaths.push(path);
      }
    }
  };

  collectPaths(normalized.basic, "basic");
  collectPaths(normalized.intention, "intention");
  collectPaths(normalized.skills, "skills");

  normalized.education.forEach((edu, i) => collectPaths(edu, `education[${i}]`));
  normalized.internships.forEach((intern, i) => collectPaths(intern, `internships[${i}]`));
  normalized.projects.forEach((proj, i) => collectPaths(proj, `projects[${i}]`));

  return {
    availablePaths,
    nonPiiContext: {
      gender: normalized.basic.gender,
      city: normalized.basic.city,
      hometown: normalized.basic.hometown,
      politicalStatus: normalized.basic.politicalStatus,
      idType: normalized.basic.idType,
      intention: normalized.intention,
      education: normalized.education.map((e) => ({
        school: e.school,
        degree: e.degree,
        major: e.major,
        college: e.college,
        studyType: e.studyType,
        startDate: e.startDate,
        endDate: e.endDate,
        gpa: e.gpa,
      })),
      internships: normalized.internships.map((item) => ({
        company: item.company,
        department: item.department,
        title: item.title,
        city: item.city,
        startDate: item.startDate,
        endDate: item.endDate,
      })),
      projects: normalized.projects.map((p) => ({
        name: p.name,
        role: p.role,
        startDate: p.startDate,
        endDate: p.endDate,
      })),
      skills: {
        summary: normalized.skills.summary,
        englishLevel: normalized.skills.englishLevel,
        languages: normalized.skills.languages,
        awards: normalized.skills.awards,
      },
    },
  };
}

/**
 * 提供一份示例资料（仅作测试/快速体验，用户可一键载入并修改成自己的信息）。
 */
export function createSampleProfile() {
  return normalizeProfile({
    id: "sample_swe_2026",
    name: "示例简历（2026届后端/全栈）",
    basic: {
      name: "陈思远",
      pinyin: "Siyuan Chen",
      gender: "男",
      birthday: "2003-05-18",
      phone: "13800138000",
      email: "siyuan.chen@example.com",
      wechat: "chensy_dev",
      idType: "身份证",
      idNumber: "31010120030518001X",
      city: "上海",
      hometown: "浙江杭州",
      politicalStatus: "共青团员",
      ethnicity: "汉族",
      github: "https://github.com/example-chensy",
      blog: "https://chensy.example.dev",
      linkedin: "",
      emergencyContact: "陈建国",
      emergencyPhone: "13900139000",
    },
    intention: {
      targetRole: "后端研发工程师",
      targetCities: "上海, 北京, 杭州",
      expectedSalary: "",
      availableDate: "2026-07-01",
      internshipDuration: "6个月",
      graduationYear: "2026届",
      acceptAdjustment: "是",
    },
    education: [
      {
        school: "复旦大学",
        degree: "硕士",
        major: "计算机技术",
        college: "计算机科学技术学院",
        studyType: "全日制",
        startDate: "2024-09",
        endDate: "2026-06",
        gpa: "3.82/4.0 (前10%)",
        courses: "分布式系统、高级数据库、编译原理、机器学习系统",
        honors: "研究生一等奖学金",
      },
      {
        school: "华东师范大学",
        degree: "本科",
        major: "软件工程",
        college: "软件工程学院",
        studyType: "全日制",
        startDate: "2020-09",
        endDate: "2024-06",
        gpa: "3.76/4.0",
        courses: "数据结构与算法、操作系统、计算机网络",
        honors: "校级优秀毕业生、ACM 区域赛铜牌",
      },
    ],
    internships: [
      {
        company: "字节跳动",
        department: "基础架构部",
        title: "后端研发实习生",
        city: "上海",
        startDate: "2025-06",
        endDate: "2025-09",
        description:
          "参与分布式任务调度平台核心链路开发，使用 Go 优化调度队列与热点分片策略，将高峰期 P99 调度延迟降低 32%，编写单元测试与压测报告保障上线稳定性。",
      },
    ],
    projects: [
      {
        name: "高并发轻量级 API 网关",
        role: "核心开发者",
        startDate: "2024-11",
        endDate: "2025-03",
        link: "https://github.com/example-chensy/mini-gateway",
        description:
          "基于 Go + Redis 实现限流熔断、动态路由热更新与 JWT 鉴权模块，单机压测 QPS 达 4.5 万，支持 Prometheus 指标采集。",
      },
    ],
    skills: {
      summary: "熟练掌握 Go、Java、Python，熟悉 MySQL、Redis、Kafka、Kubernetes 与 Linux 网络编程。",
      englishLevel: "CET-6 (585)",
      languages: "中文（母语）、英语（CET-6，可流畅阅读英文技术文档）",
      awards: "ACM-ICPC 区域赛铜牌、全国大学生软件创新大赛二等奖",
      papers: "",
      selfEvaluation:
        "具备扎实的计算机基础与高并发后端工程实践经验，对分布式系统与性能调优有浓厚兴趣，代码风格严谨，乐于团队协作。",
    },
    customQA: [
      {
        questionKeywords: "为什么投递|加入我们|求职动机",
        answer:
          "贵司在核心业务规模化高并发场景下的工程积累非常深厚，与我过往在分布式任务调度和后端架构方面的实习与项目经历高度契合，希望能加入团队深入一线实战并创造价值。",
      },
    ],
  });
}
