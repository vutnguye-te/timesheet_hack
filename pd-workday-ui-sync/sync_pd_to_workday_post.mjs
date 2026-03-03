#!/usr/bin/env node
/**
 * Fill Workday timesheet via POST to flowController.htmld (no DOM selectors).
 * Uses PagerDuty for hours, opens browser for SSO/session, extracts tokens
 * from the page, then POSTs In_Time and Out_Time. Does not click Submit.
 *
 * Requires: timesheet edit page open (you do SSO). Optionally click Add Row
 * so the form has a row; then press ENTER. Script extracts _flowExecutionKey
 * and sessionSecureToken and POSTs the time range.
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { chromium } from "playwright";
import { DateTime } from "luxon";

const DEFAULT_SCHEDULE_ID = "P88SKP2";
const DEFAULT_TIMEZONE = "America/Los_Angeles";
const DEFAULT_WORKDAY_URL = "https://workday.cisco.com/";
const DEFAULT_FLOW_CONTROLLER_URL =
  "https://wd5.myworkday.com/cisco/flowController.htmld";
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

function clientRequestId() {
  return crypto.randomUUID().replace(/-/g, "");
}

/**
 * Build form body for In_Time or Out_Time step.
 * @param {"in_time"|"out_time"} step
 * @param {DateTime} dt - start or end datetime (with zone)
 * @param {{ flowExecutionKey: string, sessionSecureToken: string, fieldPrefix: string }} tokens
 */
function buildFlowBody(step, dt, tokens) {
  const prefix = tokens.fieldPrefix;
  const timeType = step === "in_time" ? "In_Time" : "Out_Time";
  const eventId = `${prefix}/wd:${timeType}`;
  return {
    _flowExecutionKey: tokens.flowExecutionKey,
    [`${prefix}/wd:${timeType}_m`]: String(dt.minute).padStart(2, "0"),
    [`${prefix}/wd:${timeType}_H`]: String(dt.hour).padStart(2, "0"),
    [`${prefix}/wd:${timeType}_D`]: String(dt.day).padStart(2, "0"),
    [`${prefix}/wd:${timeType}_M`]: String(dt.month).padStart(2, "0"),
    [`${prefix}/wd:${timeType}_Y`]: String(dt.year),
    _eventId_validate: eventId,
    sessionSecureToken: tokens.sessionSecureToken,
    clientRequestID: clientRequestId(),
  };
}

function formEncode(obj) {
  return new URLSearchParams(obj).toString();
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`
Usage: node sync_pd_to_workday_post.mjs --date YYYY-MM-DD [options]

Fills Workday via POST to flowController (no Submit). Uses PD for hours,
opens browser for SSO, extracts tokens, POSTs In_Time and Out_Time.

Required:
  --date              Local date (e.g. 2026-02-28)
  --pd-token-file     File with PagerDuty token (e.g. ../pd_token)
  --pd-user-email     PagerDuty user email

Options:
  --schedule-id       PD schedule (default: ${DEFAULT_SCHEDULE_ID})
  --timezone          IANA timezone (default: ${DEFAULT_TIMEZONE})
  --config            Config JSON (default: workday.selectors.json)
  --profile-dir       Browser profile (default: ${DEFAULT_PROFILE_DIR})
  --cdp-url           Attach to Chrome (e.g. http://127.0.0.1:9222)
  --dry-run           Skip browser and POST; only compute plan
`);
    return;
  }
  assertRequired(args, ["date", "pd-token-file", "pd-user-email"]);

  const timezone = args.timezone || DEFAULT_TIMEZONE;
  const scheduleId = args["schedule-id"] || DEFAULT_SCHEDULE_ID;
  const token = (await fs.readFile(path.resolve(args["pd-token-file"]), "utf8")).trim();
  const userId = await resolvePdUserIdByEmail(token, args["pd-user-email"]);
  if (!userId) {
    throw new Error(`No PagerDuty user for ${args["pd-user-email"]}`);
  }

  const dayStart = DateTime.fromISO(args.date, { zone: timezone }).startOf("day");
  const dayEnd = dayStart.plus({ days: 1 });
  const oncalls = await fetchOncalls({
    token,
    scheduleId,
    sinceIso: dayStart.toUTC().toISO(),
    untilIso: dayEnd.toUTC().toISO(),
    timezone,
    escalationLevel: 1,
    userId,
  });
  const { segments, totalHours } = clampOncallToDay(oncalls, args.date, timezone);

  const startDt = dayStart.set({ hour: 0, minute: 0, second: 0, millisecond: 0 });
  const endDt = startDt.plus({ hours: totalHours });

  console.log(`Date: ${args.date}`);
  console.log(`Total standby hours: ${totalHours}`);
  console.log(`POST window: ${startDt.toISO()} -> ${endDt.toISO()}`);

  if (args["dry-run"]) {
    console.log("Dry-run. No browser or POST.");
    return;
  }

  const configPath = path.resolve(process.cwd(), args.config || "workday.selectors.json");
  const config = await loadJson(configPath);
  const pageUrl = config.timesheetPageUrl || DEFAULT_WORKDAY_URL;
  const flowControllerUrl = config.workdayFlowControllerUrl || DEFAULT_FLOW_CONTROLLER_URL;
  const fieldPrefix = config.flowFieldPrefix || "1089";

  let context;
  let page;
  if (args["cdp-url"]) {
    const cdpUrl = args["cdp-url"];
    let endpoint = cdpUrl;
    if (!cdpUrl.startsWith("ws")) {
      try {
        const base = cdpUrl.replace(/\/$/, "");
        const version = await fetch(`${base}/json/version`).then((r) => r.json());
        endpoint = version.webSocketDebuggerUrl || cdpUrl;
      } catch {
        console.warn("CDP probe failed, trying direct attach...");
      }
    }
    const browser = await chromium.connectOverCDP(endpoint).catch(() => null);
    if (!browser) {
      console.warn("CDP failed. Opening own browser.");
      context = await chromium.launchPersistentContext(
        path.resolve(process.cwd(), args["profile-dir"] || DEFAULT_PROFILE_DIR),
        { headless: false },
      );
    } else {
      context = browser.contexts()[0] || (await browser.newContext());
    }
    page = context.pages()[0] || (await context.newPage());
  } else {
    context = await chromium.launchPersistentContext(
      path.resolve(process.cwd(), args["profile-dir"] || DEFAULT_PROFILE_DIR),
      { headless: false },
    );
    page = context.pages()[0] || (await context.newPage());
  }

  await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
  await waitForEnter(
    "\n1. Go to Menu > Time > Enter Time > This Week (or the week that has your date).\n" +
    `2. Click the DAY you want to fill (for this run: ${args.date}) so the 'Enter Time' pop-up opens.\n` +
    "3. Leave the pop-up open (Date, Time Type, In, Out, Hours, OK).\n" +
    "4. Press ENTER here.",
  );

  let tokens = await page.evaluate((prefixDefault) => {
    function findInDoc(doc) {
      const flowInput = doc.querySelector('input[name="_flowExecutionKey"]');
      const sessionInput = doc.querySelector('input[name="sessionSecureToken"]');
      let prefix = prefixDefault;
      const inTimeInput = doc.querySelector('input[name*="/wd:In_Time"]');
      if (inTimeInput?.name) {
        const m = inTimeInput.name.match(/^(\d+)\//);
        if (m) prefix = m[1];
      }
      return {
        flowExecutionKey: flowInput?.value ?? "",
        sessionSecureToken: sessionInput?.value ?? "",
        fieldPrefix: prefix,
      };
    }
    let result = findInDoc(document);
    if (result.flowExecutionKey && result.sessionSecureToken) return result;
    const frames = document.frames;
    if (frames && frames.length) {
      for (let i = 0; i < frames.length; i++) {
        try {
          const f = frames[i];
          if (f?.document) {
            result = findInDoc(f.document);
            if (result.flowExecutionKey && result.sessionSecureToken) return result;
          }
        } catch (_) {}
      }
    }
    return result;
  }, fieldPrefix);

  if (!tokens.flowExecutionKey || !tokens.sessionSecureToken) {
    console.log("Tokens not in DOM. Capturing from next flowController POST...");
    const captured = { postData: null };
    const listener = (request) => {
      const u = request.url();
      if (u.includes("flowController") && request.method() === "POST" && request.postData()) {
        captured.postData = request.postData();
      }
    };
    page.on("request", listener);
    console.log("Trying to focus the In or Out field in the pop-up to trigger a request...");
    for (const label of ["In", "Out"]) {
      if (captured.postData) break;
      await page.getByLabel(label, { exact: false }).first().click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(1000);
    }
    if (!captured.postData) {
      await page.locator('[role="dialog"] input, [aria-modal="true"] input').first().click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(1000);
    }
    if (!captured.postData) {
      console.log("If nothing happened, click in the In or Out field yourself (you have ~25s).");
    }
    const deadline = Date.now() + 25000;
    while (!captured.postData && Date.now() < deadline) {
      await page.waitForTimeout(2000);
    }
    page.off("request", listener);
    if (!captured.postData) {
      throw new Error(
        "No flowController POST captured in 30s. In the pop-up, click in In/Out or press Tab, then run again.",
      );
    }
    const params = new URLSearchParams(captured.postData);
    tokens = {
      flowExecutionKey: params.get("_flowExecutionKey") ?? "",
      sessionSecureToken: params.get("sessionSecureToken") ?? "",
      fieldPrefix: fieldPrefix,
    };
    const prefixFromBody = captured.postData.match(/(\d+)\/wd:(?:In_Time|Out_Time)/);
    if (prefixFromBody) tokens.fieldPrefix = prefixFromBody[1];
  }

  if (!tokens.flowExecutionKey || !tokens.sessionSecureToken) {
    throw new Error(
      "Could not get _flowExecutionKey or sessionSecureToken. " +
        "Ensure you are on the timesheet edit page (with a row to fill).",
    );
  }
  console.log("Using tokens (field prefix:", tokens.fieldPrefix + ")");

  const cookieHeader = (await context.cookies())
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");

  const postOptions = (body) => ({
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieHeader,
      Referer: page.url(),
    },
    body: formEncode(body),
  });

  const inTimeBody = buildFlowBody("in_time", startDt, tokens);
  const outTimeBody = buildFlowBody("out_time", endDt, tokens);

  const resIn = await fetch(flowControllerUrl, postOptions(inTimeBody));
  console.log("In_Time POST:", resIn.status, resIn.statusText);
  if (!resIn.ok) {
    const text = await resIn.text();
    console.error("In_Time response (first 500 chars):", text.slice(0, 500));
  }

  const resOut = await fetch(flowControllerUrl, postOptions(outTimeBody));
  console.log("Out_Time POST:", resOut.status, resOut.statusText);
  if (!resOut.ok) {
    const text = await resOut.text();
    console.error("Out_Time response (first 500 chars):", text.slice(0, 500));
  }

  if (resIn.ok && resOut.ok) {
    console.log("Fill completed via POST. Check the browser; click Save if needed. No Submit.");
  } else {
    console.log("One or both POSTs failed. Check the page and try again.");
  }
  await waitForEnter("\nPress ENTER to close the browser...");
  await context.close();
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
