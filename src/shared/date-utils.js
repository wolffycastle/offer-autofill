/**
 * 日期解析与网申表单格式自适应工具。
 */

const PRESENT_RE = /^(至今|现在|目前|在读|在职|present|current|now)$/i;

/**
 * 将各种常见日期写法解析为标准结构。
 * @param {string} raw
 * @returns {{ isPresent: boolean, year: string, month: string, day: string, raw: string } | null}
 */
export function parseFlexibleDate(raw) {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text) return null;

  if (PRESENT_RE.test(text)) {
    return { isPresent: true, year: "", month: "", day: "", raw: text };
  }

  // Match YYYY-MM-DD / YYYY.MM.DD / YYYY/MM/DD / YYYY年MM月DD日
  const fullMatch = text.match(/(\d{4})\s*[-./年]\s*(\d{1,2})\s*[-./月]\s*(\d{1,2})日?/);
  if (fullMatch) {
    return {
      isPresent: false,
      year: fullMatch[1],
      month: fullMatch[2].padStart(2, "0"),
      day: fullMatch[3].padStart(2, "0"),
      raw: text,
    };
  }

  // Match YYYY-MM / YYYY.MM / YYYY/MM / YYYY年MM月 / YYYYMM
  const ymMatch = text.match(/(\d{4})\s*[-./年]\s*(\d{1,2})月?/);
  if (ymMatch) {
    return {
      isPresent: false,
      year: ymMatch[1],
      month: ymMatch[2].padStart(2, "0"),
      day: "",
      raw: text,
    };
  }

  const compactYm = text.match(/^(\d{4})(\d{2})$/);
  if (compactYm) {
    return {
      isPresent: false,
      year: compactYm[1],
      month: compactYm[2],
      day: "",
      raw: text,
    };
  }

  // Year only (e.g. "2026" or "2026届")
  const yMatch = text.match(/(19\d{2}|20\d{2})/);
  if (yMatch) {
    return {
      isPresent: false,
      year: yMatch[1],
      month: "",
      day: "",
      raw: text,
    };
  }

  return null;
}

/**
 * 根据目标控件的类型与提示文本（placeholder / label）格式化日期。
 * @param {string} rawDate
 * @param {{ inputType?: string, placeholder?: string, label?: string, part?: 'full'|'year'|'month' }} hint
 * @returns {string}
 */
export function formatDateForField(rawDate, hint = {}) {
  const parsed = parseFlexibleDate(rawDate);
  if (!parsed) return rawDate ? String(rawDate).trim() : "";

  if (parsed.isPresent) {
    return "至今";
  }

  const { inputType = "", placeholder = "", label = "", part = "full" } = hint;
  const combinedHint = `${placeholder} ${label}`.toLowerCase();

  if (part === "year" || /(年份|届别|\byear\b)/.test(combinedHint)) {
    return parsed.year;
  }

  if (part === "month" || /(月份|\bmonth\b)/.test(combinedHint)) {
    return parsed.month ? String(Number(parsed.month)) : "";
  }

  if (inputType === "date") {
    if (!parsed.month) return `${parsed.year}-01-01`;
    return `${parsed.year}-${parsed.month}-${parsed.day || "01"}`;
  }

  if (inputType === "month") {
    return parsed.month ? `${parsed.year}-${parsed.month}` : `${parsed.year}-01`;
  }

  // Inspect placeholder format cues
  if (/yyyy\s*\.\s*mm\s*\.\s*dd/i.test(placeholder) && parsed.month) {
    return `${parsed.year}.${parsed.month}.${parsed.day || "01"}`;
  }
  if (/yyyy\s*\/\s*mm\s*\/\s*dd/i.test(placeholder) && parsed.month) {
    return `${parsed.year}/${parsed.month}/${parsed.day || "01"}`;
  }
  if (/yyyy\s*-\s*mm\s*-\s*dd/i.test(placeholder) && parsed.month) {
    return `${parsed.year}-${parsed.month}-${parsed.day || "01"}`;
  }
  if (/yyyy\s*\.\s*mm/i.test(placeholder) && parsed.month) {
    return `${parsed.year}.${parsed.month}`;
  }
  if (/yyyy\s*\/\s*mm/i.test(placeholder) && parsed.month) {
    return `${parsed.year}/${parsed.month}`;
  }
  if (/yyyy\s*年\s*mm\s*月/i.test(placeholder) && parsed.month) {
    return `${parsed.year}年${parsed.month}月`;
  }

  if (parsed.day) {
    return `${parsed.year}-${parsed.month}-${parsed.day}`;
  }
  if (parsed.month) {
    return `${parsed.year}-${parsed.month}`;
  }
  return parsed.year;
}

/**
 * 在日期区间字段（如 "2023.09 - 2027.06"）中组合起止时间。
 */
export function formatDateRange(startDate, endDate, placeholder = "") {
  const start = formatDateForField(startDate, { placeholder });
  const end = formatDateForField(endDate, { placeholder });
  if (start && end) return `${start} - ${end}`;
  return start || end || "";
}
