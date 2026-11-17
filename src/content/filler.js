(() => {
  const ns = (globalThis.__OfferAutofill = globalThis.__OfferAutofill || {});
  if (ns._loadedFiller) return;
  ns._loadedFiller = true;

  const OPTION_SELECTORS = [
    '[role="option"]',
    ".ant-select-item-option",
    ".arco-select-option",
    ".semi-select-option",
    ".el-select-dropdown__item",
    ".next-menu-item",
    '[data-dropdown-option="true"]',
    ".oa-dropdown-option",
  ].join(",");

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function simulateClick(el) {
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    el.click();
  }

  function pressEscape(target = document.activeElement || document.body) {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true })
    );
  }

  function pressEnter(target) {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })
    );
    target.dispatchEvent(
      new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })
    );
  }

  async function fillFieldItem(planItem) {
    const h = ns.domHelpers;
    const el = ns.elementRegistry?.get(planItem.fieldId);
    if (!el || !el.isConnected) {
      return { fieldId: planItem.fieldId, status: "failed", reason: "页面元素已失效或被重绘" };
    }

    const value = planItem.value;
    if (value == null || String(value).trim() === "") {
      return { fieldId: planItem.fieldId, status: "skipped", reason: "目标值为空" };
    }

    const tag = el.tagName.toLowerCase();

    try {
      // 1. Native <select>
      if (tag === "select") {
        const opts = Array.from(el.options).filter((o) => !h.isPlaceholderText(o.textContent));
        const hit = h.findBestOptionMatch(value, opts, (o) => o.textContent);
        if (!hit) {
          return {
            fieldId: planItem.fieldId,
            status: "failed",
            reason: `原生下拉框未找到匹配选项: ${value}`,
          };
        }
        h.setNativeValue(el, hit.value);
        return {
          fieldId: planItem.fieldId,
          status: "filled",
          appliedValue: hit.textContent.trim(),
        };
      }

      // 2. Radio group
      if (planItem.controlType === "radio-group") {
        const radios = findRadiosForElement(el, planItem);
        const hit = h.findBestOptionMatch(value, radios, (r) =>
          h.cleanText(r.closest("label")?.textContent || r.textContent || r.value || "")
        );
        if (!hit) {
          return {
            fieldId: planItem.fieldId,
            status: "failed",
            reason: `单选框组未找到匹配项: ${value}`,
          };
        }
        const clickTarget = hit.closest("label") || hit;
        simulateClick(clickTarget);
        return {
          fieldId: planItem.fieldId,
          status: "filled",
          appliedValue: h.cleanText(clickTarget.textContent || hit.value || value),
        };
      }

      // 3. Custom dropdown / searchable combobox
      if (
        planItem.controlType === "custom-select" ||
        planItem.controlType === "searchable-select"
      ) {
        return await fillCustomDropdown(el, value, planItem.controlType === "searchable-select", h);
      }

      // 4. Native date / month / readonly date-picker
      if (planItem.controlType === "native-date" && tag === "input") {
        const formatted = normalizeNativeDateInput(el.type, value);
        h.setNativeValue(el, formatted);
        return { fieldId: planItem.fieldId, status: "filled", appliedValue: formatted };
      }

      if (planItem.controlType === "date-picker" && tag === "input") {
        // 尝试先直接设置或点击触发后写入
        if (!el.readOnly) {
          h.setNativeValue(el, value);
          pressEnter(el);
          return { fieldId: planItem.fieldId, status: "filled", appliedValue: value };
        }
        // readonly 日期框：尝试移除只读标记临时注入并触发事件，若存在弹窗也尝试点击年月
        const popupResult = await tryFillReadonlyDatePicker(el, value, h);
        if (popupResult.ok) {
          return { fieldId: planItem.fieldId, status: "filled", appliedValue: popupResult.appliedValue };
        }
        return { fieldId: planItem.fieldId, status: "failed", reason: popupResult.reason };
      }

      // 5. Standard <input> / <textarea>
      h.setNativeValue(el, String(value));
      return { fieldId: planItem.fieldId, status: "filled", appliedValue: String(value) };
    } catch (err) {
      return {
        fieldId: planItem.fieldId,
        status: "failed",
        reason: err?.message || "填充执行异常",
      };
    }
  }

  function normalizeNativeDateInput(type, val) {
    const s = String(val).trim();
    if (type === "month") {
      const m = s.match(/(\d{4})[-./年](\d{1,2})/);
      return m ? `${m[1]}-${m[2].padStart(2, "0")}` : s;
    }
    if (type === "date") {
      const full = s.match(/(\d{4})[-./年](\d{1,2})[-./月](\d{1,2})/);
      if (full) return `${full[1]}-${full[2].padStart(2, "0")}-${full[3].padStart(2, "0")}`;
      const ym = s.match(/(\d{4})[-./年](\d{1,2})/);
      if (ym) return `${ym[1]}-${ym[2].padStart(2, "0")}-01`;
    }
    return s;
  }

  function findRadiosForElement(wrapper, planItem) {
    const inside = Array.from(wrapper.querySelectorAll('[role="radio"], input[type="radio"]'));
    if (inside.length > 0) return inside;
    if (planItem.name) {
      return Array.from(document.querySelectorAll(`input[type="radio"][name="${CSS.escape(planItem.name)}"]`));
    }
    return [];
  }

  async function fillCustomDropdown(wrapper, value, searchable, h) {
    const existingVisible = new Set(
      Array.from(document.querySelectorAll(OPTION_SELECTORS)).filter((n) => h.isVisible(n))
    );

    const trigger =
      wrapper.querySelector(
        '.ant-select-selector, .arco-select-view, .semi-select-selection, .el-input__wrapper, [role="button"]'
      ) || wrapper;

    simulateClick(trigger);
    await sleep(80);

    // 若是可搜索下拉框，且存在可输入 <input>，尝试输入值进行过滤
    const searchInput = wrapper.querySelector("input:not([readonly])");
    if (searchable && searchInput) {
      h.setNativeValue(searchInput, String(value));
      await sleep(160);
    }

    let optionNodes = await waitForVisibleOptions(existingVisible, h, 550);

    // 如果弹窗没用常规 role/class，但在 wrapper 内部或附近出现列表项
    if (optionNodes.length === 0) {
      optionNodes = Array.from(document.querySelectorAll(OPTION_SELECTORS)).filter((n) =>
        h.isVisible(n)
      );
    }

    const matchNode = h.findBestOptionMatch(value, optionNodes, (n) => n.textContent || "");
    if (matchNode) {
      const chosenText = h.cleanText(matchNode.textContent);
      simulateClick(matchNode);
      await sleep(50);
      return { fieldId: "", ok: true, status: "filled", appliedValue: chosenText };
    }

    // 没匹配到则关闭浮层防止遮挡页面
    pressEscape(searchInput || wrapper);
    return {
      ok: false,
      status: "failed",
      reason:
        optionNodes.length === 0
          ? "未检测到展开的下拉选项列表，请手动选择"
          : `下拉候选项中未找到「${value}」`,
    };
  }

  async function waitForVisibleOptions(beforeSet, h, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const all = Array.from(document.querySelectorAll(OPTION_SELECTORS)).filter((n) =>
        h.isVisible(n)
      );
      const newlyAppeared = all.filter((n) => !beforeSet.has(n));
      if (newlyAppeared.length > 0) return newlyAppeared;
      if (all.length > 0 && beforeSet.size === 0) return all;
      await sleep(50);
    }
    return [];
  }

  async function tryFillReadonlyDatePicker(el, value, h) {
    // 某些组件允许点击后在弹出层选择年份/月份
    simulateClick(el);
    await sleep(80);

    // 如果未出现常见日期弹窗，尝试兼容写入（部分表单仅靠 readonly 防误触但监听 input/change）
    const popup = document.querySelector(
      '.ant-picker-dropdown:not(.ant-picker-dropdown-hidden), .arco-picker-container, .el-picker-panel, [data-date-popup="true"]'
    );
    if (!popup || !h.isVisible(popup)) {
      el.readOnly = false;
      h.setNativeValue(el, value);
      pressEnter(el);
      el.readOnly = true;
      return { ok: true, appliedValue: value };
    }

    const m = String(value).match(/(\d{4})[-./年](\d{1,2})/);
    if (m) {
      const targetYear = m[1];
      const targetMonthNum = String(Number(m[2]));
      const cells = Array.from(popup.querySelectorAll("td, button, [data-month], [data-year]"));
      const monthHit = cells.find((c) => {
        const txt = h.cleanText(c.textContent);
        return txt === `${targetMonthNum}月` || txt === targetMonthNum.padStart(2, "0");
      });
      const yearTextMatch = (popup.textContent || "").includes(targetYear);
      if (yearTextMatch && monthHit) {
        simulateClick(monthHit);
        return { ok: true, appliedValue: value };
      }
    }

    pressEscape(el);
    return {
      ok: false,
      reason: "日期弹窗为复杂自定义日历，请手动确认起止日期",
    };
  }

  async function executeFillPlan(planItems = []) {
    const results = [];
    for (const item of planItems) {
      const res = await fillFieldItem(item);
      results.push({
        fieldId: item.fieldId,
        label: item.label,
        sourcePath: item.sourcePath,
        confidence: item.confidence,
        source: item.source,
        reason: res.reason || item.reason || "",
        status: res.status,
        appliedValue: res.appliedValue || item.value || "",
      });
      await sleep(30);
    }
    return results;
  }

  async function clickAddButtons(requests = []) {
    let clicked = 0;
    for (const req of requests) {
      const btn = ns.addButtonRegistry?.get(req.buttonId);
      if (btn && btn.isConnected) {
        for (let i = 0; i < (req.times || 1); i++) {
          simulateClick(btn);
          clicked++;
          await sleep(160);
        }
      }
    }
    return { clicked };
  }

  ns.filler = { executeFillPlan, clickAddButtons };
})();
