(() => {
  const ns = (globalThis.__OfferAutofill = globalThis.__OfferAutofill || {});
  if (ns._loadedDomHelpers) return;
  ns._loadedDomHelpers = true;

  const PLACEHOLDER_RE =
    /^(请选择|请填写|请输入|请上传|选择|填写|搜索|select\b|please\s+(select|enter|choose|search))/i;
  const NOISE_LABEL_RE =
    /^(请输入|请选择|请填写|请上传|必填|选填|不能为空|添加|新增|删除|移除|取消|确定|保存|展开|收起|上传|预览|下载)/;
  const FIELD_CONTROL_CHECK_SEL =
    'input:not([type="hidden"]),textarea,select,[role="combobox"],[aria-haspopup="listbox"],.ant-select,.atsx-select,.ud__select,.arco-select,.semi-select,.el-select';

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

  function hasRequiredMarker(node) {
    if (!node || node === document.body) return false;
    if (node.required || node.getAttribute?.("aria-required") === "true") return true;
    const rawTxt = node.textContent || "";
    if (/[*＊]/.test(rawTxt)) return true;
    if (
      node.matches?.('[class*="required" i]') ||
      node.querySelector?.('[class*="required" i], [data-required="true"]')
    ) {
      return true;
    }
    // Check CSS ::before / ::after content (used by AntD / Feishu Hire .atsx-form-item-required:after)
    const targets = [node, ...Array.from(node.querySelectorAll("label, span")).slice(0, 4)];
    for (const t of targets) {
      for (const pseudo of ["::before", "::after"]) {
        try {
          const content = window.getComputedStyle(t, pseudo).content;
          if (content && /[*＊]/.test(content)) return true;
        } catch {
          // ignore
        }
      }
    }
    return false;
  }

  function countDistinctFormFields(container) {
    if (!container) return 0;
    const all = Array.from(container.querySelectorAll(FIELD_CONTROL_CHECK_SEL));
    const seenRanges = new Set();
    let count = 0;
    for (const node of all) {
      if (node.matches?.('.atsx-phone-select, [class*="phone-select" i], [class*="country-code" i]')) {
        continue;
      }
      // Skip nested controls inside an outer custom select (e.g. [role="combobox"] inside .atsx-select)
      const outer = node.parentElement?.closest(FIELD_CONTROL_CHECK_SEL);
      if (outer && container.contains(outer)) continue;

      // Treat paired range inputs (.ud__picker-rangeInput) as 1 logical field
      const rangeBox = node.closest?.(
        '.ud__picker-rangeInput, .ant-picker-range, .arco-picker-range, .atsx-calendar-range-picker'
      );
      if (rangeBox && container.contains(rangeBox)) {
        if (seenRanges.has(rangeBox)) continue;
        seenRanges.add(rangeBox);
      }
      count++;
    }
    return count;
  }

  function extractCleanCandidateText(node, targetEl) {
    if (!node || node === targetEl || node.contains(targetEl)) return "";
    if (!isVisible(node)) return "";
    if (node.closest?.(FIELD_CONTROL_CHECK_SEL)) return "";
    if (
      node.matches?.(
        'button, [role="button"], .ant-form-explain, .atsx-form-explain, .ud__form-explain, [class*="explain" i], [class*="error" i], [class*="placeholder" i], [class*="help" i]'
      )
    ) {
      return "";
    }
    if (node.querySelector?.(FIELD_CONTROL_CHECK_SEL)) return "";

    const clone = node.cloneNode(true);
    clone
      .querySelectorAll?.(
        'button, [role="button"], .ant-form-explain, .atsx-form-explain, [class*="error" i], [class*="help" i], [class*="tip" i], [class*="placeholder" i]'
      )
      .forEach((n) => n.remove());

    const txt = cleanText(clone.textContent);
    if (
      !txt ||
      txt.length > 45 ||
      NOISE_LABEL_RE.test(txt) ||
      /^[\s\-~～—/\\·.,:：*＊+]+$/.test(txt) ||
      /^\+\d{1,4}$/.test(txt)
    ) {
      return "";
    }
    return txt;
  }

  function findLabelViaVisualProximity(el) {
    const elRect = el.getBoundingClientRect();
    if (!elRect || (elRect.width === 0 && elRect.height === 0)) return null;

    let scope = el.parentElement;
    for (let i = 0; i < 6 && scope && scope.parentElement && scope.parentElement !== document.body; i++) {
      if (countDistinctFormFields(scope) >= 2) break;
      scope = scope.parentElement;
    }
    if (!scope) return null;

    const elCenterY = elRect.top + elRect.height / 2;
    let best = null;
    let bestScore = Infinity;

    const nodes = scope.querySelectorAll("label, span, div, p, th, strong, h1, h2, h3, h4, h5, h6");
    for (const node of nodes) {
      if (node === el || node.contains(el) || el.contains(node)) continue;
      if (node.children.length > 3) continue;
      const txt = extractCleanCandidateText(node, el);
      if (!txt || txt.length > 32) continue;

      const r = node.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;

      const centerY = r.top + r.height / 2;
      // Case 1: Directly to the left
      const isLeft =
        r.right <= elRect.left + 20 &&
        elRect.left - r.right <= 180 &&
        Math.abs(centerY - elCenterY) <= 24;
      // Case 2: Directly above
      const isAbove =
        r.bottom <= elRect.top + 12 &&
        elRect.top - r.bottom <= 48 &&
        Math.abs(r.left - elRect.left) <= 100;

      if (!isLeft && !isAbove) continue;
      const dist = isAbove
        ? (elRect.top - r.bottom) + Math.abs(r.left - elRect.left) * 0.4
        : (elRect.left - r.right) + Math.abs(centerY - elCenterY) * 0.5;
      if (dist < bestScore) {
        bestScore = dist;
        best = { text: txt, node };
      }
    }
    return best;
  }

  function extractLabelInfo(el) {
    let label = "";
    let required = Boolean(
      el.required || el.getAttribute("aria-required") === "true"
    );

    // Special case: phone country code selector (+86)
    if (
      el.matches?.('.atsx-phone-select, [class*="phone-select" i], [class*="country-code" i]')
    ) {
      return { label: "手机区号", placeholder: "", required: false };
    }

    // 1. Explicit <label for="...">
    if (el.id) {
      try {
        const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lbl) {
          if (hasRequiredMarker(lbl)) required = true;
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
        if (hasRequiredMarker(parentLabel)) required = true;
        const clone = parentLabel.cloneNode(true);
        clone.querySelectorAll("input,select,textarea,button").forEach((n) => n.remove());
        const txt = cleanText(clone.textContent);
        if (txt && !NOISE_LABEL_RE.test(txt)) label = txt;
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
      const txt = cleanText(el.getAttribute("aria-label"));
      if (txt && !NOISE_LABEL_RE.test(txt)) label = txt;
    }

    // 4. Known form item container (case-insensitive matching for CSS Modules like formItem__xxx)
    const formItem = el.closest(
      '.ant-form-item, .atsx-form-item, .ud__form-item, .arco-form-item, .semi-form-field, .el-form-item, .next-form-item, [class*="form-item" i], [class*="formItem" i], [class*="field-item" i], [class*="fieldItem" i], [class*="form-field" i], [class*="formField" i], [class*="formGroup" i], tr'
    );
    if (formItem) {
      if (!required && hasRequiredMarker(formItem)) required = true;
      if (!label) {
        const lblEl = formItem.querySelector(
          '.ant-form-item-label, .atsx-form-item-label, .ud__form-item-label, .arco-form-item-label, .semi-form-field-label, .el-form-item__label, .next-form-item-label, label, [class*="label" i], [class*="title" i], th'
        );
        if (lblEl) {
          if (hasRequiredMarker(lblEl)) required = true;
          const txt = extractCleanCandidateText(lblEl, el);
          if (txt) label = txt;
        }
      }
    }

    // 5. Universal upward structural walk (catches CSS-module wrappers around atsx-form-item / inputs)
    if (!label) {
      let cur = el;
      for (let depth = 0; depth < 6 && cur && cur.parentElement && cur.parentElement !== document.body; depth++) {
        const parent = cur.parentElement;
        const isNarrowMultiWrap = Boolean(
          parent.matches?.(
            '.ud__picker-rangeInput, .ant-picker-range, .arco-picker-range, .atsx-calendar-range-picker, .atsx-phone, [class*="range" i], [class*="phone" i]'
          )
        );
        const siblingControls = countDistinctFormFields(parent);
        if (siblingControls >= 2 && !isNarrowMultiWrap) {
          // Stop climbing once we reach a multi-field row unless checking prev sibling of cur itself
          let prev = cur.previousElementSibling;
          while (prev) {
            const txt = extractCleanCandidateText(prev, el);
            if (txt) {
              if (hasRequiredMarker(prev)) required = true;
              label = txt;
              break;
            }
            prev = prev.previousElementSibling;
          }
          break;
        }

        if (!required && hasRequiredMarker(parent)) required = true;

        let prev = cur.previousElementSibling;
        let steps = 0;
        while (prev && steps < 3) {
          const txt = extractCleanCandidateText(prev, el);
          if (txt) {
            if (hasRequiredMarker(prev)) required = true;
            label = txt;
            break;
          }
          prev = prev.previousElementSibling;
          steps++;
        }
        if (label) break;
        cur = parent;
      }
    }

    // 6. Visual proximity fallback (left / above leaf label)
    if (!label) {
      const visualHit = findLabelViaVisualProximity(el);
      if (visualHit) {
        label = visualHit.text;
        if (!required && hasRequiredMarker(visualHit.node)) required = true;
      }
    }

    // 7. Placeholder fallback (ignoring bare "请输入" / "请选择")
    const rawPlaceholder = el.getAttribute("placeholder") || el.dataset?.placeholder || "";
    const strippedPlaceholder = cleanText(
      rawPlaceholder.replace(/^(请输入|请选择|请填写|请搜索)/, "")
    );
    if (!label && strippedPlaceholder && !NOISE_LABEL_RE.test(strippedPlaceholder)) {
      label = strippedPlaceholder;
    }

    // 8. Date-range sub-field disambiguation (e.g., Feishu Hire .ud__picker-rangeInput has Start + End inputs)
    const rangeWrap = el.closest(
      '.ud__picker-rangeInput, .ant-picker-range, .arco-picker-range, .atsx-calendar-range-picker'
    );
    if (rangeWrap) {
      const rangeInputs = Array.from(rangeWrap.querySelectorAll("input"));
      if (rangeInputs.length === 2) {
        const idx = rangeInputs.indexOf(el);
        if (idx === 0 && !/(开始|起始|入学|start|from)/i.test(label)) {
          label = label ? `${label} 开始时间` : "开始时间";
        } else if (idx === 1 && !/(结束|截止|毕业|end|to)/i.test(label)) {
          label = label ? `${label} 结束时间` : "结束时间";
        }
      }
    }

    return {
      label,
      placeholder: cleanText(rawPlaceholder),
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
    /(^|\s)(ant-form-item|atsx-form-item|ud__form-item|arco-form-item|semi-form-field|el-form-item|next-form-item|form-item|formItem|form-field|field-item)([\s_]|$)/i;

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
        return countDistinctFormFields(sib) >= 2;
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

  function readCustomSelectValue(wrapper) {
    if (!wrapper) return "";
    const valNode = wrapper.querySelector(
      '.ant-select-selection-item, .atsx-select-selection-selected-value, .atsx-select-selection-item, .ud__select-selection-item, .ud__select-view-value, .arco-select-view-value, .semi-select-selection-text, [data-selected-label="true"], .selected-value, [class*="selection-selected-value"]'
    );
    if (valNode) {
      const txt = cleanText(valNode.textContent);
      return isPlaceholderText(txt) ? "" : txt;
    }
    const placeholderNode = wrapper.querySelector(
      '.atsx-select-selection__placeholder, .ant-select-selection-placeholder, .ud__select-placeholder'
    );
    if (placeholderNode && isVisible(placeholderNode)) {
      return "";
    }
    const innerInput = wrapper.querySelector("input");
    if (innerInput && innerInput.value && !isPlaceholderText(innerInput.value)) {
      return innerInput.value.trim();
    }
    const raw = cleanText(wrapper.textContent);
    return isPlaceholderText(raw) ? "" : raw;
  }

  function readElementValue(el, controlType = "", radioName = "") {
    if (!el || !el.isConnected) return "";
    const tag = el.tagName.toLowerCase();

    if (controlType === "radio-group") {
      const inside = Array.from(el.querySelectorAll('[role="radio"], input[type="radio"]'));
      const radios =
        inside.length > 0
          ? inside
          : radioName
            ? Array.from(document.querySelectorAll(`input[type="radio"][name="${CSS.escape(radioName)}"]`))
            : [];
      const checked = radios.find(
        (r) => r.checked || r.getAttribute("aria-checked") === "true"
      );
      if (!checked) return "";
      return cleanText(
        checked.closest("label")?.textContent || checked.textContent || checked.value || ""
      );
    }

    if (controlType === "custom-select" || controlType === "searchable-select") {
      return readCustomSelectValue(el);
    }

    if (tag === "select") {
      const opt = el.options[el.selectedIndex];
      if (!opt) return "";
      const txt = opt.textContent.trim();
      return isPlaceholderText(txt) ? "" : txt;
    }

    const val = el.value != null ? String(el.value).trim() : "";
    return isPlaceholderText(val) ? "" : val;
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
    readCustomSelectValue,
    readElementValue,
  };
})();
