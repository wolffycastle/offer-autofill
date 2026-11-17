(() => {
  const ns = (globalThis.__OfferAutofill = globalThis.__OfferAutofill || {});
  if (ns._loadedIndex) return;
  ns._loadedIndex = true;

  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      handleMessage(msg)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
      return true;
    });
  }

  async function handleMessage(msg) {
    switch (msg?.type) {
      case "PING":
        return { ok: true };
      case "SCAN_FORM":
        return { ok: true, data: ns.scanner.scanPageForm() };
      case "CLICK_ADD_BUTTONS":
        return { ok: true, data: await ns.filler.clickAddButtons(msg.requests || []) };
      case "EXECUTE_FILL": {
        const results = await ns.filler.executeFillPlan(msg.plan || []);
        ns.overlay.applyHighlights(results);
        return { ok: true, results };
      }
      case "SHOW_SUMMARY_TOAST":
        if (window === window.top && msg.summary) {
          ns.overlay.applyHighlights([], msg.summary);
        }
        return { ok: true };
      case "CLEAR_HIGHLIGHTS":
        ns.overlay.clearHighlights();
        return { ok: true };
      case "FOCUS_FIELD":
        return { ok: ns.overlay.focusField(msg.fieldId) };
      default:
        return { ok: false, error: `Unknown message type: ${msg?.type}` };
    }
  }
})();
