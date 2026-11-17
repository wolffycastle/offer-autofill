(() => {
  const ns = (globalThis.__OfferAutofill = globalThis.__OfferAutofill || {});
  if (ns._loadedDomHelpers) return;
  ns._loadedDomHelpers = true;

  const PLACEHOLDER_RE =
    /^(请选择|请填写|请输入|请上传|选择|填写|select\b|please\s+(select|enter|choose))/i;

  const OPTION_ALIASES = [
    ["博士", "博士研究生", "博士学位", "phd", "doctor"],
    ["硕士", "硕士研究生", "硕士学位", "研究生", "master"],
    ["本科", "大学本科", "全日制本科", "学士", "bachelor"],
    ["大专", "专科", "高职", "college", "associate"],
    ["男", "男性", "先生", "male"],
    ["女", "女性", "女士", "female"],
    ["居民身份证", "中国居民身份证", "二代身份证", "大陆居民身份证", "身份证"],
    ["统招全日制", "全日制", "全日制统招", "普通全日制", "full-time"],
    ["非全日制", "在职", "part-time"],
    ["是", "接受", "同意", "愿意", "可以", "yes", "true"],
    ["否", "不接受", "不同意", "不愿意", "no", "false"],
  ];

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  }

  function cleanText(raw) {
    return String(raw || "")
      .replace(/\s+/g, " ")
      .replace(/^[*＊\s]+/, "")
      .replace(/[*＊:：\s]+$/, "")
      .replace(/[(（]\s*(必填|选填)\s*[)）]/g, "")
      .trim();
  }

  function isPlaceholderText(text) {
    return !text || PLACEHOLDER_RE.test(String(text).trim());
  }

  function setNativeValue(el, value) {
    const strVal = value == null ? "" : String(value);
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;

    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    const lastValue = el.value;

    el.focus();
    if (descriptor && typeof descriptor.set === "function") {
      descriptor.set.call(el, strVal);
    } else {
      el.value = strVal;
    }

    // Reset React's internal _valueTracker so React recognizes a real value change
    const tracker = el._valueTracker;
    if (tracker && typeof tracker.setValue === "function") {
      tracker.setValue(lastValue);
    }

    try {
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: strVal,
        })
      );
    } catch {
      el.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
  }

  function normalizeOpt(s) {
    return String(s || "")
      .trim()
      .toLowerCase()
      .replace(/[\s\-_()（）·.]/g, "")
      .replace(/(省|市|自治区|特别行政区|届)$/g, "");
  }

  /**
   * 从候选项列表（元素数组或字符串数组）中匹配最贴近的项。
   */
  function findBestOptionMatch(desiredValue, items, getLabel = (x) => String(x)) {
    if (!desiredValue || !Array.isArray(items) || items.length === 0) return null;
    const candidates = String(desiredValue)
      .split(/[,，、;；/|]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    for (const cand of candidates) {
      const normCand = normalizeOpt(cand);
      if (!normCand) continue;

      // 1. Exact
      const exact = items.find((item) => {
        const txt = getLabel(item).trim();
        return txt.toLowerCase() === cand.toLowerCase() || normalizeOpt(txt) === normCand;
      });
      if (exact) return exact;

      // 2. Alias group
      for (const group of OPTION_ALIASES) {
        if (group.some((a) => normCand.includes(normalizeOpt(a)))) {
          for (const alias of group) {
            const na = normalizeOpt(alias);
            const hit = items.find((item) => normalizeOpt(getLabel(item)) === na);
            if (hit) return hit;
          }
          const fuzzy = items.find((item) => {
            const nt = normalizeOpt(getLabel(item));
            return group.some((a) => nt.includes(normalizeOpt(a))) && !nt.includes("非");
          });
          if (fuzzy) return fuzzy;
        }
      }

      // 3. Substring containment (shortest match wins)
      const partials = items
        .filter((item) => {
          const rawTxt = getLabel(item).trim();
          if (isPlaceholderText(rawTxt)) return false;
          const nt = normalizeOpt(rawTxt);
          return nt && (nt.includes(normCand) || normCand.includes(nt));
        })
        .sort((a, b) => getLabel(a).length - getLabel(b).length);

      if (partials.length > 0) return partials[0];
    }
    return null;
  }

  function extractLabelInfo(el) {
    let label = "";
    let required = Boolean(
      el.required || el.getAttribute("aria-required") === "true"
    );

    // 1. Explicit <label for="...">
    if (el.id) {
      try {
        const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lbl) {
          if (/[*＊]/.test(lbl.textContent || "")) required = true;
          label = cleanText(lbl.textContent);
        }
      } catch {
        // Ignore invalid CSS escape edge cases
      }
    }

    // 2. Ancestor <label>
    if (!label) {
      const parentLabel = el.closest("label");
      if (parentLabel) {
        const clone = parentLabel.cloneNode(true);
        clone.querySelectorAll("input,select,textarea,button").forEach((n) => n.remove());
        if (/[*＊]/.test(clone.textContent || "")) required = true;
        label = cleanText(clone.textContent);
      }
    }

    // 3. aria-labelledby / aria-label
    if (!label && el.getAttribute("aria-labelledby")) {
      const ids = el.getAttribute("aria-labelledby").split(/\s+/);
      const txt = ids
        .map((id) => document.getElementById(id)?.textContent || "")
        .join(" ");
      if (/[*＊]/.test(txt)) required = true;
      label = cleanText(txt);
    }
    if (!label && el.getAttribute("aria-label")) {
      label = cleanText(el.getAttribute("aria-label"));
    }

    // 4. Form item wrapper (AntD, Arco, Semi, Element, Fusion, generic)
    const formItem = el.closest(
      '.ant-form-item, .arco-form-item, .semi-form-field, .el-form-item, .next-form-item, [class*="form-item"], [class*="FormItem"], [class*="field-item"], [class*="form-field"], [class*="formGroup"], tr'
    );
    if (!label && formItem) {
      const lblEl = formItem.querySelector(
        '.ant-form-item-label, .arco-form-item-label, .semi-form-field-label, .el-form-item__label, .next-form-item-label, label, [class*="label"], th'
      );
      if (lblEl && !lblEl.contains(el)) {
        const rawTxt = lblEl.textContent || "";
        if (
          /[*＊]/.test(rawTxt) ||
          lblEl.className?.includes("required") ||
          lblEl.querySelector('[class*="required"]')
        ) {
          required = true;
        }
        label = cleanText(rawTxt);
      }
    } else if (formItem && !required) {
      const reqNode = formItem.querySelector(
        '.ant-form-item-required, .arco-form-item-label-required-symbol, [class*="required"]'
      );
      if (reqNode) required = true;
    }

    // 5. Previous sibling label / text
    if (!label) {
      let prev = el.previousElementSibling;
      let steps = 0;
      while (prev && steps < 2) {
        if (!prev.querySelector("input,select,textarea")) {
          const txt = cleanText(prev.textContent);
          if (txt && txt.length <= 36) {
            if (/[*＊]/.test(prev.textContent || "")) required = true;
            label = txt;
            break;
          }
        }
        prev = prev.previousElementSibling;
        steps++;
      }
    }

    const placeholder = el.getAttribute("placeholder") || el.dataset?.placeholder || "";
    if (!label && placeholder) {
      label = cleanText(placeholder.replace(/^(请输入|请选择|请填写)/, ""));
    }

    return {
      label,
      placeholder: cleanText(placeholder),
      required,
    };
  }

  function classifySectionFromText(text) {
    const t = String(text || "").toLowerCase();
    if (!t) return null;
    if (/(教育经历|教育背景|学历信息|学习经历|education)/.test(t)) return "education";
    if (/(实习经历|工作经历|实习\/工作|工作\/实习|任职经历|internship|work experience)/.test(t)) {
      return "internships";
    }
    if (/(项目经历|项目经验|科研项目|project)/.test(t)) return "projects";
    if (/(求职意向|应聘意向|投递意向|职位偏好|intention)/.test(t)) return "intention";
    if (/(技能|获奖|荣誉|语言|自我评价|个人简介|附加信息|skills|awards)/.test(t)) return "skills";
    if (/(基本信息|个人信息|基础信息|联系方式|basic info|personal)/.test(t)) return "basic";
    return null;
  }

  function getSectionContainer(el) {
    let cur = el.parentElement;
    while (cur && cur !== document.body) {
      const heading = findOwnHeading(cur);
      const sec = heading ? classifySectionFromText(heading) : null;
      if (sec) return { section: sec, container: cur, heading };
      const attrHint = classifySectionFromText(
        `${cur.id || ""} ${typeof cur.className === "string" ? cur.className : ""} ${cur.dataset?.section || ""}`
      );
      if (attrHint && cur.querySelectorAll("input,textarea,select,[role='combobox']").length >= 2) {
        return { section: attrHint, container: cur, heading: "" };
      }
      cur = cur.parentElement;
    }
    return { section: "basic", container: document.body, heading: "" };
  }

  function findOwnHeading(container) {
    // Only look at direct or top-level header children so we don't accidentally read a nested card's heading
    const children = Array.from(container.children).slice(0, 4);
    for (const child of children) {
      if (/^H[1-6]$/.test(child.tagName) || child.tagName === "LEGEND") {
        return child.textContent?.trim() || "";
      }
      if (
        typeof child.className === "string" &&
        /(section-title|module-title|group-title|card-title|header|title)/i.test(child.className) &&
        !child.querySelector("input,textarea,select")
      ) {
        const txt = child.textContent?.trim() || "";
        if (txt.length <= 40) return txt;
      }
    }
    return "";
  }

  const SINGLE_FIELD_WRAPPER_RE =
    /(^|\s)(ant-form-item|arco-form-item|semi-form-field|el-form-item|next-form-item|form-item|form-field|field-item)(\s|$)/i;
  const CONTROL_SELECTOR =
    'input:not([type="hidden"]),textarea,select,[role="combobox"],[aria-haspopup="listbox"],.ant-select,.arco-select,.semi-select,.el-select';

  function detectEntryIndex(el, sectionContainer, section = "basic") {
    if (!["education", "internships", "projects"].includes(section)) return 0;
    if (!sectionContainer || sectionContainer === document.body) return 0;

    // 收集从 sectionContainer 直系子孙向下到 el 父节点的祖先链（自顶向下）
    const chain = [];
    let cur = el.parentElement;
    while (cur && cur !== sectionContainer) {
      chain.unshift(cur);
      cur = cur.parentElement;
    }

    for (const node of chain) {
      if (node.dataset?.entryIndex != null && !Number.isNaN(Number(node.dataset.entryIndex))) {
        return Number(node.dataset.entryIndex);
      }
      const cls = typeof node.className === "string" ? node.className : "";
      if (SINGLE_FIELD_WRAPPER_RE.test(cls)) continue;

      const parent = node.parentElement;
      if (!parent) continue;

      const sig = primaryClassSignature(node);
      const siblings = Array.from(parent.children).filter((sib) => {
        if (sib.tagName !== node.tagName) return false;
        const sibCls = typeof sib.className === "string" ? sib.className : "";
        if (SINGLE_FIELD_WRAPPER_RE.test(sibCls)) return false;
        if (sig && primaryClassSignature(sib) !== sig) return false;
        return sib.querySelectorAll(CONTROL_SELECTOR).length >= 2;
      });

      if (siblings.length > 1) {
        const idx = siblings.indexOf(node);
        if (idx >= 0) return idx;
      }
    }
    return 0;
  }

  function primaryClassSignature(el) {
    if (typeof el.className !== "string") return "";
    return el.className
      .split(/\s+/)
      .filter((c) => c && !/active|focus|hover|selected|error|valid/i.test(c))
      .slice(0, 2)
      .join(".");
  }

  ns.domHelpers = {
    isVisible,
    cleanText,
    isPlaceholderText,
    setNativeValue,
    findBestOptionMatch,
    extractLabelInfo,
    classifySectionFromText,
    getSectionContainer,
    detectEntryIndex,
  };
})();
