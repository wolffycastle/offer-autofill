(() => {
  const ns = (globalThis.__OfferAutofill = globalThis.__OfferAutofill || {});
  if (ns._loadedOverlay) return;
  ns._loadedOverlay = true;

  const STYLE_ID = "oa-autofill-overlay-style";
  const TOAST_ID = "oa-autofill-floating-toast";
  const HIGHLIGHT_CLASSES = [
    "oa-highlight-ok",
    "oa-highlight-warn",
    "oa-highlight-fail",
    "oa-highlight-pulse",
  ];

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .oa-highlight-ok {
        outline: 2px solid #10b981 !important;
        outline-offset: 2px !important;
        box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.14) !important;
        transition: outline-color 0.2s ease;
      }
      .oa-highlight-warn {
        outline: 2px solid #f59e0b !important;
        outline-offset: 2px !important;
        box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.18) !important;
      }
      .oa-highlight-fail {
        outline: 2px dashed #ef4444 !important;
        outline-offset: 2px !important;
      }
      .oa-highlight-pulse {
        box-shadow: 0 0 0 6px rgba(37, 99, 235, 0.32) !important;
      }
      #${TOAST_ID} {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 2147483647;
        background: #111827;
        color: #f9fafb;
        font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
        font-size: 13px;
        line-height: 1.45;
        padding: 12px 14px;
        border-radius: 10px;
        box-shadow: 0 12px 28px rgba(0, 0, 0, 0.24);
        display: flex;
        align-items: center;
        gap: 12px;
        max-width: 380px;
      }
      #${TOAST_ID} button {
        border: 1px solid rgba(255, 255, 255, 0.22);
        background: rgba(255, 255, 255, 0.1);
        color: #fff;
        font-size: 12px;
        padding: 4px 10px;
        border-radius: 6px;
        cursor: pointer;
        white-space: nowrap;
      }
      #${TOAST_ID} button:hover {
        background: rgba(255, 255, 255, 0.2);
      }
    `;
    document.head.appendChild(style);
  }

  function applyHighlights(results = [], summary = null) {
    if (results.length > 0) {
      clearHighlights();
    }
    ensureStyles();

    let okCount = 0;
    let warnCount = 0;
    let failCount = 0;

    for (const r of results) {
      const el = ns.elementRegistry?.get(r.fieldId);
      if (!el || !el.isConnected) continue;

      if (r.status === "filled") {
        if (typeof r.confidence === "number" && r.confidence < 0.8) {
          el.classList.add("oa-highlight-warn");
          warnCount++;
        } else {
          el.classList.add("oa-highlight-ok");
          okCount++;
        }
      } else if (r.status === "failed") {
        el.classList.add("oa-highlight-fail");
        failCount++;
      }
    }

    if ((results.length > 0 || summary) && window === window.top) {
      showToast(summary || { okCount, warnCount, failCount });
    }
  }

  function showToast({ okCount = 0, warnCount = 0, failCount = 0 }) {
    const existing = document.getElementById(TOAST_ID);
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.id = TOAST_ID;

    const textWrap = document.createElement("div");
    const line1 = document.createElement("div");
    line1.style.fontWeight = "600";
    line1.textContent = `网申助手：已填 ${okCount + warnCount} 项`;
    const line2 = document.createElement("div");
    line2.style.fontSize = "12px";
    line2.style.color = "#d1d5db";
    line2.textContent =
      warnCount > 0 || failCount > 0
        ? `橙框 ${warnCount} 项待核对 · 红虚线 ${failCount} 项需手填（未点提交）`
        : "全部已自动对齐，请核对后自行点击提交";

    textWrap.appendChild(line1);
    textWrap.appendChild(line2);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "清除高亮";
    btn.addEventListener("click", () => clearHighlights());

    toast.appendChild(textWrap);
    toast.appendChild(btn);
    document.body.appendChild(toast);
  }

  function clearHighlights() {
    document
      .querySelectorAll(HIGHLIGHT_CLASSES.map((c) => `.${c}`).join(","))
      .forEach((el) => el.classList.remove(...HIGHLIGHT_CLASSES));
    const toast = document.getElementById(TOAST_ID);
    if (toast) toast.remove();
  }

  function focusField(fieldId) {
    ensureStyles();
    const el = ns.elementRegistry?.get(fieldId);
    if (!el || !el.isConnected) return false;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("oa-highlight-pulse");
    setTimeout(() => el.classList.remove("oa-highlight-pulse"), 1600);
    return true;
  }

  ns.overlay = { applyHighlights, clearHighlights, focusField };
})();
