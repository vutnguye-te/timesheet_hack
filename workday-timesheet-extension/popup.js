const DEFAULT_TIME_TYPE = "Standby";

const statusEl = document.getElementById("status");
const fileInput = document.getElementById("payloadFile");
const previewBtn = document.getElementById("previewBtn");
const scanBtn = document.getElementById("scanBtn");
const pickFieldEl = document.getElementById("pickField");
const pickBtn = document.getElementById("pickBtn");
const fillBtn = document.getElementById("fillBtn");
const dryRunInput = document.getElementById("dryRun");
const customSelectorsInput = document.getElementById("customSelectors");

let loadedPayloadText = "";
let loadedFileName = "";
let parsedEntries = [];

function setStatus(text, kind = "warn") {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`;
}

async function readFileAsText(file) {
  return file.text();
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  values.push(current);
  return values;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  const rows = [];
  for (const line of lines.slice(1)) {
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((h, idx) => {
      row[h.trim()] = (values[idx] || "").trim();
    });
    rows.push(row);
  }
  return rows;
}

function asNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeDate(value) {
  if (!value) return "";
  return String(value).slice(0, 10);
}

function fromWorkdayDraftJson(doc) {
  if (!doc?.workday?.entries || !Array.isArray(doc.workday.entries)) return null;
  return doc.workday.entries.map((entry) => ({
    date: normalizeDate(entry.date),
    hours: asNumber(entry.hours),
    timeType: entry.time_type || DEFAULT_TIME_TYPE,
    memo: entry.memo || "",
  }));
}

function fromUiPlanJson(doc) {
  if (!doc?.workday || !Object.prototype.hasOwnProperty.call(doc, "totalHours")) return null;
  return [
    {
      date: normalizeDate(doc.date),
      hours: asNumber(doc.totalHours),
      timeType: DEFAULT_TIME_TYPE,
      memo: "Auto-filled from PagerDuty plan",
    },
  ];
}

function fromRpaQueueJson(doc) {
  if (!doc?.work_item) return null;
  return [
    {
      date: normalizeDate(doc.work_item.date),
      hours: asNumber(doc.work_item.hours),
      timeType: doc.work_item.time_type || DEFAULT_TIME_TYPE,
      memo: doc.work_item.memo || "",
    },
  ];
}

function fromEntriesArray(doc) {
  if (!Array.isArray(doc)) return null;
  return doc.map((entry) => ({
    date: normalizeDate(entry.date),
    hours: asNumber(entry.hours),
    timeType: entry.timeType || entry.time_type || DEFAULT_TIME_TYPE,
    memo: entry.memo || "",
  }));
}

function fromCsvRows(rows) {
  return rows.map((row) => ({
    date: normalizeDate(row.date),
    hours: asNumber(row.hours),
    timeType: row.time_type || row.timeType || DEFAULT_TIME_TYPE,
    memo: row.memo || "",
  }));
}

function sanitizeEntries(entries) {
  return entries.filter(
    (e) => e.date && Number.isFinite(e.hours) && e.hours >= 0 && e.timeType,
  );
}

function parsePayload(text, filename) {
  if ((filename || "").toLowerCase().endsWith(".csv")) {
    const csvRows = parseCsv(text);
    return sanitizeEntries(fromCsvRows(csvRows));
  }

  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    const csvRows = parseCsv(text);
    return sanitizeEntries(fromCsvRows(csvRows));
  }

  const parsers = [
    fromWorkdayDraftJson,
    fromUiPlanJson,
    fromRpaQueueJson,
    fromEntriesArray,
  ];
  for (const parser of parsers) {
    const entries = parser(doc);
    if (entries && entries.length > 0) return sanitizeEntries(entries);
  }
  return [];
}

function parseCustomSelectors(raw) {
  const text = raw.trim();
  if (!text) return {};
  const obj = JSON.parse(text);
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("Custom selectors must be a JSON object.");
  }
  return obj;
}

function mergeCustomSelector(fieldKey, selector) {
  let obj = {};
  try {
    obj = parseCustomSelectors(customSelectorsInput.value || "");
  } catch {
    obj = {};
  }
  obj[fieldKey] = selector;
  customSelectorsInput.value = JSON.stringify(obj, null, 2);
  chrome.storage.local.set({ customSelectors: obj });
}

async function getActiveWorkdayTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id || !tab.url) {
    throw new Error("No active tab found.");
  }
  if (
    !tab.url.startsWith("https://workday.cisco.com/") &&
    !tab.url.includes(".myworkday.com/")
  ) {
    throw new Error("Active tab is not a Workday page.");
  }
  return tab;
}

async function getFrameIds(tabId) {
  if (!chrome.webNavigation?.getAllFrames) return [0];
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  return (frames || []).map((f) => f.frameId).sort((a, b) => a - b);
}

async function sendToFrame(tabId, frameId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message, { frameId });
  } catch {
    return null;
  }
}

function frameScore(fields = []) {
  let score = 0;
  for (const f of fields) {
    const text = `${f.ariaLabel} ${f.placeholder} ${f.name} ${f.dataAutomationId}`.toLowerCase();
    if (text.includes("date")) score += 2;
    if (text.includes("hour")) score += 2;
    if (text.includes("time type") || text.includes("type")) score += 2;
    if (text.includes("comment") || text.includes("memo")) score += 1;
  }
  return score;
}

async function scanAllFrames(tabId) {
  const frameIds = await getFrameIds(tabId);
  const results = [];
  for (const frameId of frameIds) {
    const resp = await sendToFrame(tabId, frameId, { type: "SCAN_FIELDS" });
    if (resp?.ok) {
      results.push({ frameId, fields: resp.fields || [] });
    }
  }
  return results;
}

async function loadSelectedFile() {
  const file = fileInput.files?.[0];
  if (!file) {
    throw new Error("Choose a payload file first.");
  }
  loadedPayloadText = await readFileAsText(file);
  loadedFileName = file.name || "";
  parsedEntries = parsePayload(loadedPayloadText, loadedFileName);
  if (parsedEntries.length === 0) {
    throw new Error("No usable entries found in file.");
  }
  return parsedEntries;
}

async function previewEntries() {
  const entries = await loadSelectedFile();
  const lines = entries.slice(0, 8).map(
    (e, idx) => `${idx + 1}. ${e.date} | ${e.hours}h | ${e.timeType} | ${e.memo || "-"}`,
  );
  const more = entries.length > 8 ? `\n... +${entries.length - 8} more` : "";
  setStatus(`Loaded ${entries.length} entries:\n${lines.join("\n")}${more}`, "ok");
}

async function runFill() {
  const entries = loadedPayloadText ? parsedEntries : await loadSelectedFile();
  if (!entries.length) {
    throw new Error("No entries available to fill.");
  }
  const customSelectors = parseCustomSelectors(customSelectorsInput.value || "");
  await chrome.storage.local.set({ customSelectors });

  const tab = await getActiveWorkdayTab();
  const dryRun = Boolean(dryRunInput.checked);
  const scans = await scanAllFrames(tab.id);
  const target = scans
    .map((s) => ({ ...s, score: frameScore(s.fields) }))
    .sort((a, b) => b.score - a.score || b.fields.length - a.fields.length)[0];
  const targetFrameId = target?.frameId ?? 0;

  const response = await sendToFrame(tab.id, targetFrameId, {
    type: "FILL_TIMESHEET_DRAFT",
    payload: {
      entries,
      dryRun,
      customSelectors,
    },
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Autofill failed.");
  }
  const matched = response.matched || {};
  const line = dryRun ? "Dry run complete." : "Draft fill complete. Submit not clicked.";
  setStatus(
    `${line}
Processed: ${response.processed}
Saved: ${response.saved ? "yes" : "no"}
Target frame: ${targetFrameId}
Matched fields -> date:${matched.date || 0} hours:${matched.hours || 0} timeType:${matched.timeType || 0} memo:${matched.memo || 0}`,
    "ok",
  );
}

function buildSelectorSuggestions(scan) {
  const byDate = (scan || []).filter((x) =>
    `${x.ariaLabel} ${x.placeholder} ${x.name}`.toLowerCase().includes("date"),
  );
  const byHours = (scan || []).filter((x) =>
    `${x.ariaLabel} ${x.placeholder} ${x.name}`.toLowerCase().includes("hour"),
  );
  const byType = (scan || []).filter((x) =>
    `${x.ariaLabel} ${x.placeholder} ${x.name}`.toLowerCase().includes("type"),
  );
  const pick = (rows) => rows[0];
  const date = pick(byDate);
  const hours = pick(byHours);
  const type = pick(byType);

  const suggestion = {};
  if (date?.selector) suggestion.dateInput = date.selector;
  if (hours?.selector) suggestion.hoursInput = hours.selector;
  if (type?.selector) suggestion.timeTypeInput = type.selector;
  return suggestion;
}

async function runScan() {
  const tab = await getActiveWorkdayTab();
  const scans = await scanAllFrames(tab.id);
  if (!scans.length) {
    throw new Error("No content-script responses from any frame. Reload extension and page.");
  }
  const ranked = scans
    .map((s) => ({ ...s, score: frameScore(s.fields) }))
    .sort((a, b) => b.score - a.score || b.fields.length - a.fields.length);
  const best = ranked[0];
  const fields = best.fields || [];
  const suggestion = buildSelectorSuggestions(fields);
  const preview = fields.slice(0, 10).map(
    (f, i) =>
      `${i + 1}. ${f.tag} ${f.type || "-"} | aria=${f.ariaLabel || "-"} | dataId=${f.dataAutomationId || "-"} | selector=${f.selector}`,
  );
  if (Object.keys(suggestion).length > 0) {
    customSelectorsInput.value = JSON.stringify(suggestion, null, 2);
  }
  setStatus(
    `Frames scanned: ${ranked.length}
Best frame: ${best.frameId} (score=${best.score}, fields=${fields.length})
${preview.join("\n")}
${fields.length > 10 ? `... +${fields.length - 10} more` : ""}
${Object.keys(suggestion).length > 0 ? "\nSuggested selectors loaded into custom box." : ""}`,
    fields.length > 0 ? "ok" : "warn",
  );
}

fileInput.addEventListener("change", async () => {
  try {
    await loadSelectedFile();
    setStatus(`Loaded file: ${loadedFileName} (${parsedEntries.length} entries)`, "ok");
  } catch (err) {
    setStatus(err.message, "err");
  }
});

previewBtn.addEventListener("click", async () => {
  try {
    await previewEntries();
  } catch (err) {
    setStatus(err.message, "err");
  }
});

fillBtn.addEventListener("click", async () => {
  try {
    await runFill();
  } catch (err) {
    setStatus(err.message, "err");
  }
});

scanBtn.addEventListener("click", async () => {
  try {
    await runScan();
  } catch (err) {
    setStatus(err.message, "err");
  }
});

pickBtn.addEventListener("click", async () => {
  try {
    const tab = await getActiveWorkdayTab();
    const fieldKey = pickFieldEl.value;
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "START_PICK_SELECTOR",
      fieldKey,
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Could not start selector picker.");
    }
    setStatus(
      `Picker armed for "${fieldKey}". Click the target element on Workday page.`,
      "warn",
    );
  } catch (err) {
    setStatus(err.message, "err");
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "PICKED_SELECTOR") return;
  const fieldKey = message.fieldKey;
  const selector = message.selector;
  if (!fieldKey || !selector) return;
  mergeCustomSelector(fieldKey, selector);
  setStatus(`Captured ${fieldKey}: ${selector}`, "ok");
});

chrome.storage.local.get("customSelectors", (result) => {
  if (result?.customSelectors && Object.keys(result.customSelectors).length > 0) {
    customSelectorsInput.value = JSON.stringify(result.customSelectors, null, 2);
  }
});
