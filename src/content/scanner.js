(() => {
  const ns = (globalThis.__OfferAutofill = globalThis.__OfferAutofill || {});
  if (ns._loadedScanner) return;
  ns._loadedScanner = true;

  const CUSTOM_SELECT_WRAPPER_SEL =
    '.ant-select, .atsx-select, .ud__select, .arco-select, .semi-select, .el-select, .next-select, .atsx-cascader-picker, .ud__cascader, [role="combobox"], [aria-haspopup="listbox"], [data-custom-select="true"]';

  function scanPageForm() {
    const h = ns.domHelpers;
    ns.elementRegistry = new Map();
    ns.elementRegistryMeta = new Map();
    ns.addButtonRegistry = new Map();

    const fields = [];
    const seenElements = new Set();
    const seenRadioGroups = new Set();
    const sectionBlocks = {
      education: new Set(),
      internships: new Set(),
      projects: new Set(),
    };
    let seq = 1;

    const registerField = (el, descriptor) => {
      const fieldId = `oa_f_${seq++}`;
      ns.elementRegistry.set(fieldId, el);
      ns.elementRegistryMeta.set(fieldId, {
        controlType: descriptor.controlType,
        inputType: descriptor.inputType,
        radioName: descriptor._radioName || descriptor.name || "",
      });
      fields.push({ fieldId, ...descriptor });
    };

    // 1. Custom select wrappers & radio groups first (so inner <input> isn't double-counted)
    const customWrappers = document.querySelectorAll(CUSTOM_SELECT_WRAPPER_SEL);
    for (const wrapper of customWrappers) {
      if (!h.isVisible(wrapper)) continue;
      if (seenElements.has(wrapper)) continue;
      seenElements.add(wrapper);

      // Mark any inner input/combobox as seen so we don't double-scan nested triggers
      wrapper
        .querySelectorAll('input, [role="combobox"], [aria-haspopup="listbox"]')
        .forEach((n) => seenElements.add(n));

      // Skip phone country code selector (+86) so we don't confuse it with the phone number
      if (
        wrapper.matches?.('.atsx-phone-select, [class*="phone-select" i], [class*="country-code" i]')
      ) {
        continue;
      }

      const labelInfo = h.extractLabelInfo(wrapper);
      const { section, container } = h.getSectionContainer(wrapper);
      const entryIndex = h.detectEntryIndex(wrapper, container, section);
      trackBlock(sectionBlocks, section, entryIndex);

      const innerInput = wrapper.querySelector("input");
      const searchable =
        Boolean(innerInput && !innerInput.readOnly && innerInput.type !== "hidden") ||
        wrapper.getAttribute("data-searchable") === "true";

      const currentValue = h.readCustomSelectValue(wrapper);
      const staticOptions = extractStaticListboxOptions(wrapper);

      registerField(wrapper, {
        label: labelInfo.label,
        placeholder: labelInfo.placeholder,
        required: labelInfo.required,
        section,
        entryIndex,
        controlType: searchable ? "searchable-select" : "custom-select",
        inputType: "select",
        name: innerInput?.name || wrapper.getAttribute("name") || "",
        id: wrapper.id || innerInput?.id || "",
        currentValue,
        options: staticOptions,
      });
    }

    // 2. Radio groups (native <input type="radio"> and [role="radiogroup"])
    const radioGroups = document.querySelectorAll('[role="radiogroup"]');
    for (const rg of radioGroups) {
      if (!h.isVisible(rg)) continue;
      const radios = Array.from(rg.querySelectorAll('[role="radio"], input[type="radio"]'));
      if (radios.length === 0) continue;
      radios.forEach((r) => seenElements.add(r));

      const labelInfo = h.extractLabelInfo(rg);
      const { section, container } = h.getSectionContainer(rg);
      const entryIndex = h.detectEntryIndex(rg, container, section);
      trackBlock(sectionBlocks, section, entryIndex);

      const options = radios
        .map((r) => h.cleanText(r.closest("label")?.textContent || r.textContent || r.value || ""))
        .filter(Boolean);
      const checked = radios.find(
        (r) => r.checked || r.getAttribute("aria-checked") === "true"
      );
      const currentValue = checked
        ? h.cleanText(checked.closest("label")?.textContent || checked.textContent || checked.value || "")
        : "";

      registerField(rg, {
        label: labelInfo.label,
        placeholder: "",
        required: labelInfo.required,
        section,
        entryIndex,
        controlType: "radio-group",
        inputType: "radio",
        name: radios[0]?.name || "",
        id: rg.id || "",
        currentValue,
        options,
      });
    }

    // Native radio inputs grouped by name
    const allRadios = Array.from(document.querySelectorAll('input[type="radio"]'));
    for (const radio of allRadios) {
      if (seenElements.has(radio)) continue;
      const groupName = radio.name;
      if (groupName && seenRadioGroups.has(groupName)) continue;
      const groupRadios = groupName
        ? allRadios.filter((r) => r.name === groupName)
        : [radio];
      if (!groupRadios.some((r) => h.isVisible(r) || h.isVisible(r.closest("label")))) continue;

      if (groupName) seenRadioGroups.add(groupName);
      groupRadios.forEach((r) => seenElements.add(r));

      const anchor = radio.closest(".ant-form-item, .arco-form-item, .form-item, .field, div") || radio;
      const labelInfo = h.extractLabelInfo(anchor);
      const { section, container } = h.getSectionContainer(radio);
      const entryIndex = h.detectEntryIndex(radio, container, section);
      trackBlock(sectionBlocks, section, entryIndex);

      const options = groupRadios
        .map((r) => h.cleanText(r.closest("label")?.textContent || r.value || ""))
        .filter(Boolean);
      const checked = groupRadios.find((r) => r.checked);
      const currentValue = checked
        ? h.cleanText(checked.closest("label")?.textContent || checked.value || "")
        : "";

      registerField(groupRadios[0].parentElement || groupRadios[0], {
        label: labelInfo.label,
        placeholder: "",
        required: labelInfo.required,
        section,
        entryIndex,
        controlType: "radio-group",
        inputType: "radio",
        name: groupName || "",
        id: radio.id || "",
        currentValue,
        options,
        _radioName: groupName || "",
      });
    }

    // 3. Native <input>, <textarea>, <select>
    const nativeControls = document.querySelectorAll("input, textarea, select");
    for (const el of nativeControls) {
      if (seenElements.has(el)) continue;
      if (el.disabled) continue;

      const tag = el.tagName.toLowerCase();
      const inputType = tag === "input" ? (el.type || "text").toLowerCase() : tag;
      if (["hidden", "submit", "button", "reset", "image", "checkbox"].includes(inputType)) {
        continue;
      }
      if (!h.isVisible(el)) continue;

      seenElements.add(el);

      const labelInfo = h.extractLabelInfo(el);
      const { section, container } = h.getSectionContainer(el);
      const entryIndex = h.detectEntryIndex(el, container, section);
      trackBlock(sectionBlocks, section, entryIndex);

      let controlType = tag === "textarea" ? "textarea" : tag === "select" ? "select" : "text";
      if (tag === "input" && el.readOnly) {
        // 常见日期框或只读下拉弹窗触发器
        controlType = /(date|time|年|月|日期|时间)/.test(`${labelInfo.label} ${labelInfo.placeholder}`)
          ? "date-picker"
          : "custom-select";
      } else if (tag === "input" && (inputType === "date" || inputType === "month")) {
        controlType = "native-date";
      }

      let options = [];
      let currentValue = el.value || "";
      if (tag === "select") {
        options = Array.from(el.options)
          .map((o) => o.textContent.trim())
          .filter((t) => t && !h.isPlaceholderText(t));
        const selectedOpt = el.options[el.selectedIndex];
        currentValue =
          selectedOpt && !h.isPlaceholderText(selectedOpt.textContent)
            ? selectedOpt.textContent.trim()
            : "";
      } else if (h.isPlaceholderText(currentValue)) {
        currentValue = "";
      }

      registerField(el, {
        label: labelInfo.label,
        placeholder: labelInfo.placeholder,
        required: labelInfo.required,
        section,
        entryIndex,
        controlType,
        inputType,
        name: el.name || "",
        id: el.id || "",
        currentValue,
        options,
      });
    }

    // 4. Scan section "+ 添加经历" buttons
    const addButtons = scanAddButtons(h, sectionBlocks);

    return {
      url: location.href,
      hostname: location.hostname,
      title: document.title,
      fields,
      addButtons,
      sectionCounts: {
        education: sectionBlocks.education.size,
        internships: sectionBlocks.internships.size,
        projects: sectionBlocks.projects.size,
      },
    };
  }

  function trackBlock(sectionBlocks, section, entryIndex) {
    if (sectionBlocks[section]) {
      sectionBlocks[section].add(entryIndex);
    }
  }

  function extractStaticListboxOptions(wrapper) {
    const controlledId =
      wrapper.getAttribute("aria-controls") || wrapper.getAttribute("aria-owns");
    if (controlledId) {
      const box = document.getElementById(controlledId);
      if (box) {
        return Array.from(box.querySelectorAll('[role="option"], li'))
          .map((n) => n.textContent.trim())
          .filter(Boolean);
      }
    }
    if (wrapper.dataset?.options) {
      try {
        const parsed = JSON.parse(wrapper.dataset.options);
        if (Array.isArray(parsed)) return parsed.map(String);
      } catch {
        // ignore
      }
    }
    return [];
  }

  function scanAddButtons(h, sectionBlocks) {
    const buttons = [];
    let btnSeq = 1;
    const candidates = document.querySelectorAll('button, a, [role="button"]');
    for (const btn of candidates) {
      if (!h.isVisible(btn)) continue;
      const text = h.cleanText(btn.textContent);
      if (!text || text.length > 24) continue;
      if (!/(\+|添加|新增|继续添加|再添|add)/i.test(text)) continue;

      let section = null;
      if (/(教育|学历|school|edu)/i.test(text)) section = "education";
      else if (/(实习|工作|internship|work)/i.test(text)) section = "internships";
      else if (/(项目|课题|project)/i.test(text)) section = "projects";
      else {
        const ctx = h.getSectionContainer(btn);
        if (["education", "internships", "projects"].includes(ctx.section)) {
          section = ctx.section;
        }
      }

      if (!section) continue;
      const buttonId = `oa_btn_${btnSeq++}`;
      ns.addButtonRegistry.set(buttonId, btn);
      buttons.push({
        buttonId,
        section,
        text,
        currentCount: sectionBlocks[section]?.size || 0,
      });
    }
    return buttons;
  }

  function readFieldValues(fieldIds = []) {
    const h = ns.domHelpers;
    const out = [];
    for (const fieldId of fieldIds) {
      const el = ns.elementRegistry?.get(fieldId);
      const meta = ns.elementRegistryMeta?.get(fieldId) || {};
      if (!el || !el.isConnected) continue;
      if (meta.inputType === "password" || meta.inputType === "file") continue;
      out.push({
        fieldId,
        value: h.readElementValue(el, meta.controlType, meta.radioName),
      });
    }
    return out;
  }

  ns.scanner = { scanPageForm, readFieldValues };
})();
