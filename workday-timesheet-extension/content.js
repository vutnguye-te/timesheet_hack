const DEFAULT_SELECTORS = {
  addRowButton: [
    "button[aria-label*='Add']",
    "button[data-automation-id='addRowButton']",
    "button:has(svg)",
  ],
  dateInput: [
    "input[aria-label='Date']",
    "input[data-automation-id='dateInputBox']",
    "input[id*='date']",
  ],
  hoursInput: [
    "input[aria-label='Hours']",
    "input[data-automation-id='numericInput']",
    "input[id*='hours']",
  ],
  timeTypeInput: [
    "input[aria-label*='Time Type']",
    "input[data-automation-id='promptOption']",
  ],
  memoInput: [
    "textarea[aria-label='Comment']",
    "textarea[data-automation-id='textArea']",
  ],
  saveButton: [
    "button[data-automation-id='saveButton']",
    "button[aria-label='Save']",
    "button",
  ],
  submitButton: [
    "button[data-automation-id='submitButton']",
    "button[aria-label='Submit']",
  ],
};

const PAUSE_MS = 220;
let pickerActive = false;
let pickerFieldKey = "";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isVisible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.visibility !== "hidden" &&
    style.display !== "none"
  );
}

function collectSearchRoots(root = document) {
  const roots = [root];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    let elements = [];
    try {
      elements = Array.from(current.querySelectorAll("*"));
    } catch {
      elements = [];
    }
    for (const el of elements) {
      if (el.shadowRoot) {
        roots.push(el.shadowRoot);
        queue.push(el.shadowRoot);
      }
    }
  }
  return roots;
}

function deepQueryAll(selector) {
  const roots = collectSearchRoots(document);
  const out = [];
  for (const root of roots) {
    try {
      root.querySelectorAll(selector).forEach((el) => out.push(el));
    } catch {
      // Ignore invalid selector.
    }
  }
  return Array.from(new Set(out));
}

function resolveSelectors(customSelectors = {}) {
  const merged = { ...DEFAULT_SELECTORS };
  for (const [key, value] of Object.entries(customSelectors || {})) {
    if (typeof value === "string") merged[key] = [value];
    else if (Array.isArray(value)) merged[key] = value;
  }
  return merged;
}

function findAll(selectorList) {
  const out = [];
  for (const selector of selectorList || []) {
    deepQueryAll(selector).forEach((el) => out.push(el));
  }
  return Array.from(new Set(out)).filter(isVisible);
}

function findOne(selectorList) {
  const all = findAll(selectorList);
  return all[0] || null;
}

function pickByIndex(selectorList, index) {
  const elements = findAll(selectorList);
  if (elements.length === 0) return null;
  if (index < elements.length) return elements[index];
  return elements[elements.length - 1];
}

function dispatchValue(el, value) {
  el.focus();
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function highlight(el, label) {
  if (!el) return;
  el.style.outline = "2px solid #f08c00";
  el.title = `[Workday Autofill] ${label}`;
}

function toDateInput(dateIso) {
  // Workday commonly accepts MM/DD/YYYY in text date fields.
  const date = new Date(`${dateIso}T00:00:00`);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const year = date.getFullYear();
  return `${month}/${day}/${year}`;
}

function escapeCss(value) {
  if (window.CSS && typeof window.CSS.escape === "function") {
    return window.CSS.escape(value);
  }
  return String(value).replace(/["\\]/g, "\\$&");
}

function stableSelectorFor(el) {
  const dataId = el.getAttribute("data-automation-id");
  if (dataId) return `[data-automation-id="${escapeCss(dataId)}"]`;
  const aria = el.getAttribute("aria-label");
  if (aria) return `[aria-label="${escapeCss(aria)}"]`;
  if (el.id) return `#${escapeCss(el.id)}`;
  if (el.name) return `${el.tagName.toLowerCase()}[name="${escapeCss(el.name)}"]`;
  if (el.classList && el.classList.length > 0) {
    const classes = Array.from(el.classList).slice(0, 2).map(escapeCss).join(".");
    if (classes) return `${el.tagName.toLowerCase()}.${classes}`;
  }
  return el.tagName.toLowerCase();
}

function scanFields() {
  const nodes = deepQueryAll(
    "input, textarea, [role='textbox'], [contenteditable='true']",
  ).filter(isVisible);
  return nodes.slice(0, 200).map((el) => ({
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute("type") || "",
    ariaLabel: el.getAttribute("aria-label") || "",
    placeholder: el.getAttribute("placeholder") || "",
    name: el.getAttribute("name") || "",
    id: el.id || "",
    dataAutomationId: el.getAttribute("data-automation-id") || "",
    selector: stableSelectorFor(el),
  }));
}

function pickerHandler(event) {
  if (!pickerActive) return;
  const el = event.target;
  if (!el) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  const selector = stableSelectorFor(el);
  highlight(el, `picked ${pickerFieldKey}`);
  chrome.runtime.sendMessage({
    type: "PICKED_SELECTOR",
    fieldKey: pickerFieldKey,
    selector,
  });
  pickerActive = false;
  pickerFieldKey = "";
  window.removeEventListener("click", pickerHandler, true);
}

async function fillEntry(entry, idx, selectors, dryRun) {
  const addBtn = findOne(selectors.addRowButton);
  if (addBtn && !dryRun) {
    addBtn.click();
    await sleep(PAUSE_MS);
  }

  const dateEl = pickByIndex(selectors.dateInput, idx);
  const hoursEl = pickByIndex(selectors.hoursInput, idx);
  const typeEl = pickByIndex(selectors.timeTypeInput, idx);
  const memoEl = pickByIndex(selectors.memoInput, idx);
  const found = {
    date: Boolean(dateEl),
    hours: Boolean(hoursEl),
    timeType: Boolean(typeEl),
    memo: Boolean(memoEl),
  };

  if (dryRun) {
    highlight(dateEl, `date=${entry.date}`);
    highlight(hoursEl, `hours=${entry.hours}`);
    highlight(typeEl, `timeType=${entry.timeType}`);
    highlight(memoEl, `memo=${entry.memo || "-"}`);
    return found;
  }

  if (dateEl) dispatchValue(dateEl, toDateInput(entry.date));
  await sleep(PAUSE_MS);
  if (hoursEl) dispatchValue(hoursEl, String(entry.hours));
  await sleep(PAUSE_MS);
  if (typeEl) {
    dispatchValue(typeEl, entry.timeType);
    typeEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }),
    );
  }
  await sleep(PAUSE_MS);
  if (memoEl && entry.memo) dispatchValue(memoEl, entry.memo);
  return found;
}

async function fillTimesheetDraft(entries, dryRun, customSelectors) {
  const selectors = resolveSelectors(customSelectors);
  let processed = 0;
  const matched = {
    date: 0,
    hours: 0,
    timeType: 0,
    memo: 0,
  };
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const found = await fillEntry(entry, i, selectors, dryRun);
    if (found.date) matched.date += 1;
    if (found.hours) matched.hours += 1;
    if (found.timeType) matched.timeType += 1;
    if (found.memo) matched.memo += 1;
    processed += 1;
    await sleep(PAUSE_MS);
  }

  const coreMatches = matched.date + matched.hours + matched.timeType;
  if (coreMatches === 0) {
    throw new Error(
      "No Workday input fields were detected. Update custom selectors, then try Dry run again.",
    );
  }

  let saved = false;
  if (!dryRun) {
    const saveBtn = findOne(selectors.saveButton);
    if (saveBtn) {
      const text = (saveBtn.innerText || saveBtn.textContent || "").toLowerCase();
      if (text.includes("save") || saveBtn.getAttribute("aria-label") === "Save") {
        saveBtn.click();
        saved = true;
      }
    }
  }

  // Hard no-submit rule: detect submit presence, never click.
  const submitBtn = findOne(selectors.submitButton);
  if (submitBtn) {
    highlight(submitBtn, "Submit detected (not clicked)");
  }

  return { processed, saved, matched };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "START_PICK_SELECTOR") {
    try {
      pickerActive = true;
      pickerFieldKey = String(message.fieldKey || "");
      window.addEventListener("click", pickerHandler, true);
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
    return true;
  }

  if (message?.type === "SCAN_FIELDS") {
    try {
      const fields = scanFields();
      sendResponse({ ok: true, fields });
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
    return true;
  }

  if (message?.type !== "FILL_TIMESHEET_DRAFT") return;

  const entries = message?.payload?.entries || [];
  const dryRun = Boolean(message?.payload?.dryRun);
  const customSelectors = message?.payload?.customSelectors || {};

  fillTimesheetDraft(entries, dryRun, customSelectors)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));

  return true;
});
