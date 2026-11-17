/**
 * OpenAI 兼容大模型客户端：
 * 1) 对未命中本地规则的网页字段做隐私脱敏语义映射；
 * 2) 可选辅助解析用户粘贴的纯文本简历。
 */

import { buildSanitizedProfileForLLM, getProfileValue, normalizeProfile } from "./profile-schema.js";
import { prepareFieldValue } from "./rule-matcher.js";

export const DEFAULT_LLM_CONFIG = {
  enabled: false,
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "",
  model: "deepseek-chat",
  allowOpenEndedDraft: false,
};

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || DEFAULT_LLM_CONFIG.baseUrl).trim().replace(/\/+$/, "");
}

/**
 * 从模型输出中稳健提取 JSON（兼容 ```json 代码块）。
 */
export function extractJsonFromText(text) {
  if (!text) return null;
  const trimmed = String(text).trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    // Try finding first { ... } or [ ... ]
    const objStart = candidate.indexOf("{");
    const arrStart = candidate.indexOf("[");
    const start =
      objStart === -1 ? arrStart : arrStart === -1 ? objStart : Math.min(objStart, arrStart);
    if (start === -1) return null;
    const endChar = candidate[start] === "[" ? "]" : "}";
    const end = candidate.lastIndexOf(endChar);
    if (end <= start) return null;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

async function callChatCompletion(config, messages, { temperature = 0.1 } = {}) {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  if (!baseUrl) {
    throw new Error("未配置大模型 Base URL");
  }
  const headers = { "Content-Type": "application/json" };
  if (config.apiKey && String(config.apiKey).trim()) {
    headers.Authorization = `Bearer ${String(config.apiKey).trim()}`;
  }

  const endpoint = baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl}/chat/completions`;
  const resp = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: config.model || DEFAULT_LLM_CONFIG.model,
      temperature,
      messages,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`大模型请求失败 (${resp.status}): ${errText.slice(0, 240)}`);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("大模型返回内容为空");
  }
  return content;
}

/**
 * 测试大模型连通性。
 */
export async function testLlmConnection(config) {
  const reply = await callChatCompletion(config, [
    { role: "system", content: "你是一个连接检测助手，只需回复 OK。" },
    { role: "user", content: "请回复 OK" },
  ]);
  return { ok: true, reply: String(reply).trim().slice(0, 80) };
}

/**
 * 构造未匹配字段语义映射提示词（仅传递脱敏上下文与可用路径列表）。
 */
export function buildFieldMappingMessages(unmatchedFields, profile, llmConfig) {
  const sanitized = buildSanitizedProfileForLLM(profile);
  const simplifiedFields = unmatchedFields.map((f) => ({
    fieldId: f.fieldId,
    label: f.label || "",
    placeholder: f.placeholder || "",
    section: f.section || "basic",
    entryIndex: Number.isInteger(f.entryIndex) ? f.entryIndex : 0,
    controlType: f.controlType || "text",
    options: Array.isArray(f.options) ? f.options.slice(0, 60) : [],
  }));

  const systemPrompt = [
    "你是中国互联网校招/社招网申表单字段映射助手。",
    "任务：根据候选人资料结构（含隐私脱敏上下文与可用字段路径）和网页表单字段元数据，输出最合理的映射 JSON。",
    "严格规则：",
    "1. 只能输出一个 JSON 对象：{\"mappings\": [...]}，不要附加任何解释文字。",
    "2. 每条映射格式：{\"fieldId\": string, \"sourcePath\": string|null, \"filledValue\": string|null, \"confidence\": number, \"reason\": string}。",
    "3. 如果字段对应隐私信息（如 basic.name, basic.phone, basic.email, basic.idNumber 等），请只填写 sourcePath，把 filledValue 设为 null，客户端会在本地填入真实值。",
    "4. 如果字段有 options 候选列表，filledValue 必须严格等于 options 中的某一项字符串；若无法判断则跳过不要乱选。",
    llmConfig.allowOpenEndedDraft
      ? "5. 对于开放性长文本问题（如为什么加入我们），可结合候选人非隐私经历生成简洁中文草稿填入 filledValue，并把 confidence 设为 0.65 以提醒用户复核。"
      : "5. 对于没有明确依据的开放性问题、期望薪资、主观判断题，不要编造，直接忽略（不要出现在 mappings 中）。",
  ].join("\n");

  const userPrompt = JSON.stringify(
    {
      availableProfilePaths: sanitized.availablePaths,
      nonPiiContext: sanitized.nonPiiContext,
      fields: simplifiedFields,
    },
    null,
    2
  );

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
}

/**
 * 使用 LLM 为未命中规则的字段生成映射并本地还原真实值。
 */
export async function mapUnmatchedFieldsWithLLM(unmatchedFields, profile, llmConfig) {
  if (!llmConfig?.enabled || !Array.isArray(unmatchedFields) || unmatchedFields.length === 0) {
    return { matched: [], remaining: unmatchedFields || [] };
  }

  const fieldMap = new Map(unmatchedFields.map((f) => [f.fieldId, f]));
  const messages = buildFieldMappingMessages(unmatchedFields, profile, llmConfig);
  const rawReply = await callChatCompletion(llmConfig, messages, { temperature: 0.1 });
  const parsed = extractJsonFromText(rawReply);

  const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.mappings) ? parsed.mappings : [];
  const matched = [];
  const matchedIds = new Set();

  for (const item of items) {
    if (!item || !item.fieldId || !fieldMap.has(item.fieldId)) continue;
    const field = fieldMap.get(item.fieldId);

    let finalValue = item.filledValue != null ? String(item.filledValue).trim() : "";
    const sourcePath = item.sourcePath ? String(item.sourcePath).trim() : "";

    // 若提供了 sourcePath 且模型未直接给出选项值，则从本地资料安全读取真实值
    if (!finalValue && sourcePath) {
      const localRaw = getProfileValue(profile, sourcePath);
      if (localRaw) {
        finalValue = prepareFieldValue(localRaw, field, { isDate: /Date$/.test(sourcePath) }) || "";
      }
    }

    // 若控件本身带 options，校验 LLM 返回值确实在可选项中
    if (finalValue && Array.isArray(field.options) && field.options.length > 0) {
      if (!field.options.includes(finalValue)) {
        const preparedOpt = prepareFieldValue(finalValue, field);
        if (!preparedOpt) continue;
        finalValue = preparedOpt;
      }
    }

    if (!finalValue) continue;

    const confidence =
      typeof item.confidence === "number" ? Math.max(0, Math.min(1, item.confidence)) : 0.72;

    matchedIds.add(field.fieldId);
    matched.push({
      fieldId: field.fieldId,
      label: field.label || field.placeholder || field.fieldId,
      sourcePath: sourcePath || "llm-semantic",
      value: finalValue,
      confidence,
      source: "llm",
      reason: item.reason || "大模型语义匹配",
    });
  }

  const remaining = unmatchedFields.filter((f) => !matchedIds.has(f.fieldId));
  return { matched, remaining };
}

/**
 * 可选：调用 LLM 把粘贴的简历文本结构化为标准 Profile JSON。
 */
export async function parseResumeTextWithLLM(rawResumeText, llmConfig) {
  const systemPrompt = [
    "你是简历结构化解析器。将输入的中文/英文简历文本解析为严格 JSON，结构如下：",
    JSON.stringify({
      basic: {
        name: "",
        pinyin: "",
        gender: "",
        birthday: "",
        phone: "",
        email: "",
        wechat: "",
        city: "",
        hometown: "",
        politicalStatus: "",
        github: "",
        blog: "",
      },
      intention: {
        targetRole: "",
        targetCities: "",
        graduationYear: "",
      },
      education: [
        {
          school: "",
          degree: "",
          major: "",
          college: "",
          studyType: "全日制",
          startDate: "YYYY-MM",
          endDate: "YYYY-MM",
          gpa: "",
          courses: "",
          honors: "",
        },
      ],
      internships: [
        {
          company: "",
          department: "",
          title: "",
          city: "",
          startDate: "YYYY-MM",
          endDate: "YYYY-MM",
          description: "",
        },
      ],
      projects: [
        {
          name: "",
          role: "",
          startDate: "YYYY-MM",
          endDate: "YYYY-MM",
          link: "",
          description: "",
        },
      ],
      skills: {
        summary: "",
        englishLevel: "",
        languages: "",
        awards: "",
        papers: "",
        selfEvaluation: "",
      },
    }),
    "要求：只输出 JSON；缺失的字段保留空字符串，绝不虚构任何未在简历中出现的信息。",
  ].join("\n");

  const reply = await callChatCompletion(
    llmConfig,
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: rawResumeText.slice(0, 12000) },
    ],
    { temperature: 0 }
  );

  const parsed = extractJsonFromText(reply);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("大模型未能返回合法的简历 JSON");
  }
  return normalizeProfile(parsed);
}
