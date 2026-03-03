#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { chromium } from "playwright";
import { DateTime } from "luxon";

const DEFAULT_SCHEDULE_ID = "P88SKP2";
const DEFAULT_TIMEZONE = "America/Los_Angeles";
const DEFAULT_WORKDAY_URL = "https://workday.cisco.com/";
const DEFAULT_OUTPUT_DIR = "output";
const DEFAULT_PROFILE_DIR = ".browser-profile";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function assertRequired(args, keys) {
  for (const key of keys) {
    if (!args[key]) {
      throw new Error(`Missing required argument --${key}`);
    }
  }
}

async function loadJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function fetchJson(url, token) {
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.pagerduty+json;version=2",
      Authorization: `Token token=${token}`,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PagerDuty API ${res.status}: ${text.slice(0, 500)}`);
  }
  return res.json();
}

async function fetchJsonNoAuth(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function resolvePdUserIdByEmail(token, email) {
  const url = new URL("https://api.pagerduty.com/users");
  url.searchParams.set("query", email);
  url.searchParams.set("limit", "100");
  const payload = await fetchJson(url.toString(), token);
  const users = payload.users || [];
  const matched = users.find(
    (u) => (u.email || "").toLowerCase().trim() === email.toLowerCase().trim(),
  );
  return matched?.id || null;
}

async function fetchOncalls({
  token,
  scheduleId,
  sinceIso,
  untilIso,
  timezone,
  escalationLevel,
  userId,
}) {
  const url = new URL("https://api.pagerduty.com/oncalls");
  url.searchParams.append("schedule_ids[]", scheduleId);
  url.searchParams.set("since", sinceIso);
  url.searchParams.set("until", untilIso);
  url.searchParams.set("time_zone", timezone);
  if (escalationLevel) {
    url.searchParams.set("escalation_level", String(escalationLevel));
  }
  if (userId) {
    url.searchParams.set("user_ids[]", userId);
  }
  const payload = await fetchJson(url.toString(), token);
  return payload.oncalls || [];
}

function clampOncallToDay(oncalls, localDate, timezone) {
  const dayStart = DateTime.fromISO(localDate, { zone: timezone }).startOf("day");
  const dayEnd = dayStart.plus({ days: 1 });
  const segments = [];

  for (const item of oncalls) {
    const start = DateTime.fromISO(item.start);
    const end = DateTime.fromISO(item.end);
    const overlapStart = start > dayStart ? start : dayStart;
    const overlapEnd = end < dayEnd ? end : dayEnd;
    if (overlapEnd <= overlapStart) continue;
    const hours = overlapEnd.diff(overlapStart, "hours").hours;
    segments.push({
      userId: item.user?.id || "unknown",
      userName: item.user?.summary || "unknown",
      start: overlapStart.toISO(),
      end: overlapEnd.toISO(),
      hours: Number(hours.toFixed(2)),
    });
  }

  const totalHours = Number(
    segments.reduce((sum, item) => sum + item.hours, 0).toFixed(2),
  );
  return { segments, totalHours };
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function writeJson(filePath, data) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

function toDateInput(localDate, timezone, fmt = "MM/dd/yyyy") {
  return DateTime.fromISO(localDate, { zone: timezone }).toFormat(fmt);
}

async function waitForEnter(promptText) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    await rl.question(promptText);
  } finally {
    rl.close();
  }
}

async function runUiFill({
  localDate,
  timezone,
  totalHours,
  config,
  configPath,
  profileDir,
  cdpUrl,
  useExistingTab,
  stepTimeoutMs,
  debug,
  noSave,
}) {
  const pageUrl = config.timesheetPageUrl || DEFAULT_WORKDAY_URL;
  const selectors = { ...(config.selectors || {}) };
  const entryType = config.timeType || "Standby";
  const dateFormat = config.dateInputFormat || "MM/dd/yyyy";
  const hoursText = Number(totalHours).toString();
  const dateText = toDateInput(localDate, timezone, dateFormat);
  let selectorsChanged = false;
  const log = (...parts) => {
    if (debug) console.log("[ui]", ...parts);
  };

  const captureSelectorFromActiveElement = async (fieldLabel) => {
    await waitForEnter(
      `\nSelector missing/failed for ${fieldLabel}. ` +
        `Click the ${fieldLabel} field in Workday so it is focused, then press ENTER...`,
    );
    const selector = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return null;
      const esc = (v) =>
        window.CSS && typeof window.CSS.escape === "function"
          ? window.CSS.escape(v)
          : String(v).replace(/["\\]/g, "\\$&");
      const dataId = el.getAttribute?.("data-automation-id");
      if (dataId) return `[data-automation-id="${esc(dataId)}"]`;
      const aria = el.getAttribute?.("aria-label");
      if (aria) return `[aria-label="${esc(aria)}"]`;
      if (el.id) return `#${esc(el.id)}`;
      if (el.name) return `${el.tagName.toLowerCase()}[name="${esc(el.name)}"]`;
      return el.tagName.toLowerCase();
    });
    if (!selector) {
      throw new Error(
        `Could not capture selector for ${fieldLabel}. ` +
          "After clicking the field, ensure it is focused before pressing ENTER.",
      );
    }
    log(`captured selector for ${fieldLabel}:`, selector);
    return selector;
  };

  const fillFieldWithFallback = async ({ key, label, value }) => {
    const attemptFill = async (selector) => {
      await page.locator(selector).first().fill(value, { timeout: stepTimeoutMs });
    };
    const existing = selectors[key];
    if (existing) {
      try {
        log(`fill ${label}:`, existing, "->", value);
        await attemptFill(existing);
        return;
      } catch {
        log(`selector failed for ${label}:`, existing);
      }
    }
    const captured = await captureSelectorFromActiveElement(label);
    selectors[key] = captured;
    selectorsChanged = true;
    await attemptFill(captured);
  };

  let context;
  let page;
  let cdpBrowser = null;
  let cdpMode = false;

  if (cdpUrl) {
    let endpoint = cdpUrl;
    if (!cdpUrl.startsWith("ws")) {
      const base = cdpUrl.replace(/\/$/, "");
      try {
        const version = await fetchJsonNoAuth(`${base}/json/version`);
        endpoint = version.webSocketDebuggerUrl || cdpUrl;
      } catch (err) {
        console.warn(
          `Warning: CDP probe failed (${err.message}). Trying direct attach to ${cdpUrl}...`,
        );
      }
    }

    const connected = await chromium.connectOverCDP(endpoint).catch(() => null);
    if (connected) {
      cdpMode = true;
      cdpBrowser = connected;
      context = cdpBrowser.contexts()[0] || (await cdpBrowser.newContext());
      if (useExistingTab) {
        page = context.pages()[0] || (await context.newPage());
      } else {
        page = await context.newPage();
      }
    } else {
      console.warn(
        "Could not attach to Chrome at " +
          cdpUrl +
          ". Opening a new browser window instead.",
      );
      context = await chromium.launchPersistentContext(profileDir, {
        headless: false,
      });
      page = context.pages()[0] || (await context.newPage());
    }
  } else {
    context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
    });
    page = context.pages()[0] || (await context.newPage());
  }

  const ADD_ROW_FALLBACKS = [
    ...new Set([
      selectors.addRowButton,
      'button:has-text("Add Row")',
      'button:has-text("Add")',
      '[role="button"]:has-text("Add Row")',
      '[role="button"]:has-text("Add")',
      'a:has-text("Add Row")',
    ].filter(Boolean),
  )];

  try {
    log("goto", pageUrl);
    await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
    await waitForEnter(
      "\nComplete Workday SSO + open the timesheet edit page, then press ENTER...",
    );
    log("starting fill flow");

    const addRowTimeout = stepTimeoutMs;
    let addClicked = false;
    for (const sel of ADD_ROW_FALLBACKS) {
      try {
        log("click add row selector:", sel);
        await page.locator(sel).first().click({ timeout: addRowTimeout });
        addClicked = true;
        break;
      } catch (e) {
        if (sel === selectors.addRowButton) continue;
      }
    }
    if (!addClicked) {
      await waitForEnter(
        '\nCould not auto-find Add/Add Row. Click "Add Row" manually in Workday, then press ENTER...',
      );
    }
    await fillFieldWithFallback({
      key: "dateInput",
      label: "Date",
      value: dateText,
    });
    await fillFieldWithFallback({
      key: "hoursInput",
      label: "Hours",
      value: hoursText,
    });
    await fillFieldWithFallback({
      key: "timeTypeInput",
      label: "Time Type",
      value: entryType,
    });
    log("press enter");
    await page.keyboard.press("Enter");

    if (!noSave && selectors.saveButton) {
      log("click save:", selectors.saveButton);
      await page.locator(selectors.saveButton).first().click({ timeout: stepTimeoutMs });
    }

    if (selectors.submitButton) {
      const submitVisible = await page.locator(selectors.submitButton).first().isVisible().catch(() => false);
      if (submitVisible) {
        console.log("Safety guard: submit button detected but not clicked.");
      }
    }
    if (selectorsChanged && configPath) {
      const next = { ...config, selectors };
      await fs.writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      console.log(`Updated selectors in ${configPath}`);
    }
  } finally {
    if (cdpMode) {
      // Keep existing browser/session and filled tab open for manual review/submit.
      // Process exit will drop the CDP connection.
    } else {
      await context.close();
    }
  }
}

function printUsage() {
  console.log(`Usage:
  node sync_pd_to_workday_ui.mjs --date YYYY-MM-DD [options]

Required:
  --date                      Local date (example: 2026-02-28)

PagerDuty:
  --pd-token                  PagerDuty API token
  --pd-token-file             File containing PagerDuty token
  --pd-user-email             PagerDuty user email filter
  --schedule-id               PagerDuty schedule id (default: ${DEFAULT_SCHEDULE_ID})
  --timezone                  IANA timezone (default: ${DEFAULT_TIMEZONE})
  --escalation-level          On-call level (default: 1)

Workday UI:
  --config                    Selector config JSON (default: ./workday.selectors.json)
  --profile-dir               Browser profile dir (default: ./${DEFAULT_PROFILE_DIR})
  --cdp-url                   Attach to existing Chrome via CDP (example: http://127.0.0.1:9222)
  --use-existing-tab          In CDP mode, reuse first existing tab instead of creating a new tab
  --step-timeout-ms           Timeout per UI step in milliseconds (default: 15000)
  --debug                     Print step-level UI logs
  --no-save                   Fill only, do not click Save
  --dry-run                   Do not open browser; only produce output plan
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  assertRequired(args, ["date"]);

  const timezone = args.timezone || DEFAULT_TIMEZONE;
  const scheduleId = args["schedule-id"] || DEFAULT_SCHEDULE_ID;
  const escalationLevel = Number(args["escalation-level"] || 1);
  const outputDir = path.resolve(process.cwd(), DEFAULT_OUTPUT_DIR);
  const planPath = path.join(outputDir, `${args.date}.workday-ui-plan.json`);

  let token = args["pd-token"] || null;
  if (!token && args["pd-token-file"]) {
    token = (await fs.readFile(path.resolve(args["pd-token-file"]), "utf8")).trim();
  }
  if (!token) {
    throw new Error("Provide --pd-token or --pd-token-file");
  }

  let userId = null;
  if (args["pd-user-email"]) {
    userId = await resolvePdUserIdByEmail(token, args["pd-user-email"]);
    if (!userId) {
      throw new Error(`No PagerDuty user id found for email ${args["pd-user-email"]}`);
    }
  }

  const dayStart = DateTime.fromISO(args.date, { zone: timezone }).startOf("day");
  const dayEnd = dayStart.plus({ days: 1 });

  const oncalls = await fetchOncalls({
    token,
    scheduleId,
    sinceIso: dayStart.toUTC().toISO(),
    untilIso: dayEnd.toUTC().toISO(),
    timezone,
    escalationLevel,
    userId,
  });
  const { segments, totalHours } = clampOncallToDay(oncalls, args.date, timezone);

  const plan = {
    generatedAt: new Date().toISOString(),
    date: args.date,
    timezone,
    scheduleId,
    escalationLevel,
    pdUserEmail: args["pd-user-email"] || null,
    pdUserId: userId,
    segments,
    totalHours,
    workday: {
      mode: "ui_automation",
      submit: false,
      save: !args["no-save"],
    },
  };
  await writeJson(planPath, plan);

  console.log(`Date: ${args.date}`);
  console.log(`Timezone: ${timezone}`);
  console.log(`Schedule: ${scheduleId}`);
  console.log(`Total standby hours: ${totalHours}`);
  console.log(`Plan file: ${planPath}`);

  if (args["dry-run"]) {
    console.log("Dry-run enabled. Browser automation skipped.");
    return;
  }

  const configPath = path.resolve(process.cwd(), args.config || "workday.selectors.json");
  const config = await loadJson(configPath);
  await runUiFill({
    localDate: args.date,
    timezone,
    totalHours,
    config,
    configPath,
    profileDir: path.resolve(process.cwd(), args["profile-dir"] || DEFAULT_PROFILE_DIR),
    cdpUrl: args["cdp-url"] || null,
    useExistingTab: Boolean(args["use-existing-tab"]),
    stepTimeoutMs: Number(args["step-timeout-ms"] || 15000),
    debug: Boolean(args.debug),
    noSave: Boolean(args["no-save"]),
  });
  console.log("Workday UI fill completed. Submit was not clicked.");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
