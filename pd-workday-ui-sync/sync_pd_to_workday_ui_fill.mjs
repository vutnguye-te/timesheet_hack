#!/usr/bin/env node
/**
 * Open Workday and fill the Enter Time pop-up from an existing PD plan.
 *
 * This script now follows the same UI path shown in screenshots:
 * Home -> Menu -> Time -> This Week/Last Week -> Enter Time grid -> day cell -> modal.
 * It then fills Time Type, In, Out and clicks OK. It does not submit timesheet.
 */

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { chromium } from "playwright";
import { DateTime } from "luxon";

const DEFAULT_WORKDAY_URL = "https://workday.cisco.com/";
const DEFAULT_PROFILE_DIR = ".browser-profile";
const DEFAULT_TIMEZONE = "America/Los_Angeles";
const DEFAULT_STEP_TIMEOUT_MS = 12000;
const DEFAULT_CHROME_EXECUTABLE = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

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

async function loadJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
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

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function includesByWords(source, target) {
  const src = normalizeText(source);
  const words = normalizeText(target)
    .split(" ")
    .filter(Boolean);
  return words.every((word) => src.includes(word));
}

/**
 * From plan segments, get start and end time for the day (for In/Out).
 * Returns { inTime: "09:00", outTime: "14:00" } in 24h format.
 */
function getInOutFromPlan(plan) {
  const tz = plan.timezone || DEFAULT_TIMEZONE;
  const segments = plan.segments || [];
  const totalHours = plan.totalHours ?? 0;
  if (segments.length > 0) {
    const first = segments[0];
    const start = DateTime.fromISO(first.start).setZone(tz);
    const end = DateTime.fromISO(first.end).setZone(tz);
    return {
      inTime: start.toFormat("HH:mm"),
      outTime: end.toFormat("HH:mm"),
    };
  }
  const date = DateTime.fromISO(plan.date, { zone: tz });
  const start = date.set({ hour: 0, minute: 0, second: 0, millisecond: 0 });
  const end = start.plus({ hours: Math.max(0, totalHours) });
  return {
    inTime: start.toFormat("HH:mm"),
    outTime: end.toFormat("HH:mm"),
  };
}

function getInOutFromFixedStart(plan, fixedStart) {
  const tz = plan.timezone || DEFAULT_TIMEZONE;
  const [h, m] = String(fixedStart)
    .trim()
    .split(":")
    .map((v) => Number(v));
  if (!Number.isFinite(h) || !Number.isFinite(m)) {
    throw new Error(`Invalid fixedStartTime format: ${fixedStart}`);
  }
  const totalHours = Number(plan.totalHours ?? 0);
  const start = DateTime.fromISO(plan.date, { zone: tz }).set({
    hour: h,
    minute: m,
    second: 0,
    millisecond: 0,
  });
  const end = start.plus({ hours: Math.max(0, totalHours) });
  return {
    inTime: start.toFormat("HH:mm"),
    outTime: end.toFormat("HH:mm"),
  };
}

async function isVisible(locator) {
  return locator.isVisible().catch(() => false);
}

async function clickFirst(actions, log) {
  for (const action of actions) {
    try {
      await action.run();
      log(`clicked: ${action.label}`);
      return true;
    } catch {
      // try next
    }
  }
  return false;
}

async function fillInput(locator, value, stepTimeoutMs) {
  await locator.click({ timeout: stepTimeoutMs });
  await locator.fill("", { timeout: stepTimeoutMs }).catch(() => {});
  await locator.fill(value, { timeout: stepTimeoutMs });
}

async function clickTextAncestor(page, pattern) {
  const clicked = await page.evaluate(({ pattern }) => {
    const re = new RegExp(pattern, "i");
    const isVisible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 20 &&
        rect.height > 14 &&
        rect.bottom > 0 &&
        rect.right > 0
      );
    };

    const clickableSelector = "button,a,[role='button'],[role='link'],div,span";
    const candidates = [];
    for (const el of Array.from(document.querySelectorAll(clickableSelector))) {
      if (!isVisible(el)) continue;
      const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      if (!text || !re.test(text)) continue;
      const rect = el.getBoundingClientRect();
      candidates.push({ el, area: rect.width * rect.height });
    }
    if (!candidates.length) return false;
    candidates.sort((a, b) => b.area - a.area);
    const target = candidates[0].el;
    target.scrollIntoView({ block: "center", inline: "center" });
    target.click();
    return true;
  }, { pattern });
  if (!clicked) {
    throw new Error(`No clickable text ancestor found for pattern ${pattern}`);
  }
}

async function findVisibleInFrames(page, buildLocator) {
  for (const frame of page.frames()) {
    try {
      const locator = buildLocator(frame).first();
      if (await locator.isVisible({ timeout: 150 }).catch(() => false)) {
        return { frame, locator };
      }
    } catch {
      // continue
    }
  }
  return null;
}

async function clickEnterTimeCardSelectWeek(page) {
  await page.evaluate(() => {
    const norm = (v) => (v || "").replace(/\s+/g, " ").trim().toLowerCase();
    const clickable = "button,a,[role='button'],[role='link'],div,span";
    const headings = Array.from(document.querySelectorAll("h1,h2,h3,div,span")).filter((el) =>
      norm(el.textContent).includes("enter time"),
    );
    for (const heading of headings) {
      let node = heading;
      for (let depth = 0; depth < 6 && node; depth += 1) {
        const matches = Array.from(node.querySelectorAll(clickable)).filter((el) =>
          /^select week$/i.test((el.textContent || "").replace(/\s+/g, " ").trim()),
        );
        if (matches.length) {
          matches[0].scrollIntoView({ block: "center", inline: "center" });
          matches[0].click();
          return;
        }
        node = node.parentElement;
      }
    }
    throw new Error("Select Week under Enter Time card not found");
  });
}

async function hasSelectWeekPopupByEvaluate(page) {
  return page.evaluate(() => {
    const text = (document.body?.innerText || "").toLowerCase();
    return text.includes("view time select week") || text.includes("dd/mm/yyyy");
  });
}

async function fillSelectWeekViaEvaluate(page, dateText) {
  return page.evaluate(({ dateText }) => {
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 10 &&
        rect.height > 10 &&
        rect.bottom > 0 &&
        rect.right > 0
      );
    };
    const inputs = Array.from(document.querySelectorAll("input"))
      .filter((el) => visible(el))
      .filter((el) => {
        const p = (el.getAttribute("placeholder") || "").toLowerCase();
        const a = (el.getAttribute("aria-label") || "").toLowerCase();
        return p.includes("dd/mm") || a.includes("date");
      });
    if (!inputs.length) return false;

    const input = inputs[0];
    input.focus();
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.value = dateText;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));

    const clickable = Array.from(document.querySelectorAll("button,[role='button'],a,div,span"))
      .filter((el) => visible(el))
      .find((el) => /^ok$/i.test((el.textContent || "").replace(/\s+/g, " ").trim()));
    if (clickable) clickable.click();
    return true;
  }, { dateText });
}

async function fillSelectWeekIfVisible(page, { localDate, timezone, stepTimeoutMs, log }) {
  const dateText = DateTime.fromISO(localDate, { zone: timezone }).toFormat("dd/MM/yyyy");
  if (await hasSelectWeekPopupByEvaluate(page)) {
    const okEval = await fillSelectWeekViaEvaluate(page, dateText).catch(() => false);
    if (okEval) {
      log(`select week date set via evaluate: ${dateText}`);
      await page.waitForTimeout(400);
      return true;
    }
  }

  const inputFound = await findVisibleInFrames(page, (ctx) =>
    ctx.locator('input[placeholder*="DD/MM/YYYY" i], input[aria-label*="date" i], input[placeholder*="DD" i]'),
  );
  if (!inputFound) return false;
  const scope = inputFound.frame;

  const dateInputCandidates = [
    scope.getByLabel(/date/i).first(),
    scope.locator('input[placeholder*="DD/MM/YYYY" i], input[aria-label*="date" i]').first(),
    scope.locator("input").first(),
  ];

  let filled = false;
  for (const input of dateInputCandidates) {
    if (await isVisible(input)) {
      await input.click({ timeout: stepTimeoutMs }).catch(() => {});
      await input.press("Meta+A").catch(() => {});
      await input.press("Control+A").catch(() => {});
      await input.press("Backspace").catch(() => {});
      await input.type(dateText, { delay: 25, timeout: stepTimeoutMs }).catch(() => {});
      await input.press("Enter").catch(() => {});

      const current = await input.inputValue().catch(() => "");
      if (current && normalizeText(current).includes(normalizeText(dateText))) {
        filled = true;
        log(`select week date set to: ${current}`);
        break;
      }
    }
  }
  if (!filled) return false;

  const okByRole = await findVisibleInFrames(page, (ctx) => ctx.getByRole("button", { name: /^ok$/i }));
  if (okByRole) {
    await okByRole.locator.click({ timeout: stepTimeoutMs }).catch(() => {});
    return true;
  }
  const okByText = await findVisibleInFrames(page, (ctx) => ctx.getByText(/^ok$/i));
  if (okByText) {
    await okByText.locator.click({ timeout: stepTimeoutMs }).catch(() => {});
    return true;
  }
  return false;
}

function getDateMarkers(localDate, timezone) {
  const dt = DateTime.fromISO(localDate, { zone: timezone });
  return {
    dayMonth: dt.toFormat("dd/MM"),
    dayMonthYear: dt.toFormat("dd/MM/yyyy"),
    weekdayShort: dt.toFormat("ccc"),
  };
}

async function openSelectWeek(page, { localDate, timezone, stepTimeoutMs, log }) {
  if (await fillSelectWeekIfVisible(page, { localDate, timezone, stepTimeoutMs, log })) {
    await page.waitForTimeout(700);
    return true;
  }

  const modalTitle = page.locator("h1,h2,h3,div,span").filter({ hasText: /view time select week/i }).first();
  const modalByDate = page
    .locator('[role="dialog"], [aria-modal="true"]')
    .filter({ has: page.locator('input[placeholder*="DD/MM/YYYY" i], input[aria-label*="date" i]') })
    .first();
  const dateInputGlobal = page.locator('input[placeholder*="DD/MM/YYYY" i], input[aria-label*="date" i]').first();

  const selectWeekActions = [
    {
      label: "select week in enter time card",
      run: () => clickEnterTimeCardSelectWeek(page),
    },
    {
      label: "select week button",
      run: () => page.getByRole("button", { name: /select week/i }).first().click({ timeout: stepTimeoutMs }),
    },
    {
      label: "select week text",
      run: () => page.getByText(/^select week$/i).first().click({ timeout: stepTimeoutMs }),
    },
    {
      label: "select week text force",
      run: () => page.locator("text=Select Week").first().click({ timeout: stepTimeoutMs, force: true }),
    },
    {
      label: "select week tile force",
      run: () =>
        page
          .locator('button,div,a,span')
          .filter({ hasText: /select week/i })
          .first()
          .click({ timeout: stepTimeoutMs, force: true }),
    },
    {
      label: "select week tile via evaluate",
      run: () => clickTextAncestor(page, "\\bselect\\s*week\\b"),
    },
  ];

  const isPopupOpen = async () =>
    (await isVisible(modalTitle)) ||
    (await isVisible(modalByDate)) ||
    (await isVisible(dateInputGlobal)) ||
    (await hasSelectWeekPopupByEvaluate(page)) ||
    Boolean(
      await findVisibleInFrames(page, (ctx) =>
        ctx.locator('input[placeholder*="DD/MM/YYYY" i], input[aria-label*="date" i], input[placeholder*="DD" i]'),
      ),
    );

  let modalDetected = false;
  for (let openTry = 0; openTry < 2 && !modalDetected; openTry += 1) {
    for (const action of selectWeekActions) {
      try {
        await action.run();
        log(`clicked: ${action.label}`);
      } catch {
        continue;
      }
      for (let i = 0; i < 8; i += 1) {
        if (await isPopupOpen()) {
          modalDetected = true;
          break;
        }
        await page.waitForTimeout(200);
      }
      if (modalDetected) break;
    }
    if (!modalDetected) await page.waitForTimeout(300);
  }
  if (!modalDetected) {
    log('Failed to open "View Time Select Week" popup automatically; falling back to week navigation.');
    return false;
  }
  const ok = await fillSelectWeekIfVisible(page, { localDate, timezone, stepTimeoutMs, log });
  if (ok) await page.waitForTimeout(700);
  return ok;
}

async function openEnterTimePage(page, { localDate, timezone, stepTimeoutMs, log }) {
  const enterTimeHeading = page.getByRole("heading", { name: /enter time/i }).first();
  if (await isVisible(enterTimeHeading)) return;

  const timeHeading = page.getByRole("heading", { name: /^time$/i }).first();
  if (!(await isVisible(timeHeading))) {
    const menuClicked = await clickFirst(
      [
        {
          label: "menu button",
          run: () => page.getByRole("button", { name: /menu/i }).first().click({ timeout: stepTimeoutMs }),
        },
        {
          label: "menu text",
          run: () => page.getByText(/^menu$/i).first().click({ timeout: stepTimeoutMs }),
        },
        {
          label: "menu automation id",
          run: () =>
            page
              .locator('[data-automation-id*="menu" i], [aria-label*="menu" i]')
              .first()
              .click({ timeout: stepTimeoutMs }),
        },
      ],
      log,
    );
    if (!menuClicked) {
      throw new Error("Could not auto-open Menu.");
    }
  }

  if (!(await isVisible(timeHeading))) {
    await clickFirst(
      [
        {
          label: "personal section",
          run: () => page.getByText(/^personal$/i).first().click({ timeout: 2500 }),
        },
      ],
      log,
    ).catch(() => {});

    const timeClicked = await clickFirst(
      [
        {
          label: "time link/button exact",
          run: () =>
            page
              .locator('a,button,[role="button"],[role="link"]')
              .filter({ hasText: /^time$/i })
              .first()
              .click({ timeout: stepTimeoutMs }),
        },
        {
          label: "time text",
          run: () => page.getByText(/^time$/i).first().click({ timeout: stepTimeoutMs }),
        },
      ],
      log,
    );
    if (!timeClicked) {
      throw new Error("Could not auto-open Time.");
    }
  }

  await Promise.race([
    page.getByText(/this week/i).first().waitFor({ state: "visible", timeout: stepTimeoutMs }).catch(() => {}),
    page.getByText(/select week/i).first().waitFor({ state: "visible", timeout: stepTimeoutMs }).catch(() => {}),
    page.getByRole("heading", { name: /enter time/i }).first().waitFor({ state: "visible", timeout: stepTimeoutMs }).catch(() => {}),
  ]);

  const selectWeekOk = await openSelectWeek(page, {
    localDate,
    timezone,
    stepTimeoutMs,
    log,
  });
  if (selectWeekOk) {
    await enterTimeHeading.waitFor({ state: "visible", timeout: stepTimeoutMs }).catch(() => {});
    if (await isVisible(enterTimeHeading)) return;
  }

  const target = DateTime.fromISO(localDate, { zone: timezone }).startOf("day");
  const today = DateTime.now().setZone(timezone).startOf("day");
  const primaryTile = target <= today ? "last week" : "this week";
  const secondaryTile = primaryTile === "last week" ? "this week" : "last week";

  const thisWeekClicked = await clickFirst(
    [
      {
        label: `${primaryTile} button`,
        run: () =>
          page
            .getByRole("button", { name: new RegExp(primaryTile, "i") })
            .first()
            .click({ timeout: stepTimeoutMs }),
      },
      {
        label: `${secondaryTile} button`,
        run: () =>
          page
            .getByRole("button", { name: new RegExp(secondaryTile, "i") })
            .first()
            .click({ timeout: stepTimeoutMs }),
      },
      {
        label: `${primaryTile} text`,
        run: () => page.getByText(new RegExp(primaryTile, "i")).first().click({ timeout: stepTimeoutMs }),
      },
      {
        label: `${secondaryTile} text`,
        run: () => page.getByText(new RegExp(secondaryTile, "i")).first().click({ timeout: stepTimeoutMs }),
      },
      {
        label: `${primaryTile} tile force`,
        run: () =>
          page
            .locator('button,div,a,span')
            .filter({ hasText: new RegExp(primaryTile, "i") })
            .first()
            .click({ timeout: stepTimeoutMs, force: true }),
      },
      {
        label: `${secondaryTile} tile force`,
        run: () =>
          page
            .locator('button,div,a,span')
            .filter({ hasText: new RegExp(secondaryTile, "i") })
            .first()
            .click({ timeout: stepTimeoutMs, force: true }),
      },
      {
        label: `${primaryTile} tile via evaluate`,
        run: () => clickTextAncestor(page, `\\b${primaryTile.replace(/\s+/g, "\\s*")}\\b`),
      },
      {
        label: `${secondaryTile} tile via evaluate`,
        run: () => clickTextAncestor(page, `\\b${secondaryTile.replace(/\s+/g, "\\s*")}\\b`),
      },
    ],
    log,
  );

  if (!thisWeekClicked && !(await isVisible(enterTimeHeading))) {
    throw new Error("Could not auto-open Enter Time grid.");
  }

  await enterTimeHeading.waitFor({ state: "visible", timeout: stepTimeoutMs }).catch(() => {});
}

function parseWeekRange(text, timezone) {
  const normalized = String(text || "").replace(/\u2013/g, "-").replace(/\s+/g, " ").trim();
  const match = normalized.match(
    /(\d{1,2})\s+([A-Za-z]{3})\s*-\s*(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/,
  );
  if (!match) return null;

  const [, startDay, startMon, endDay, endMon, endYear] = match;
  const end = DateTime.fromFormat(`${endDay} ${endMon} ${endYear}`, "d LLL yyyy", {
    zone: timezone,
    locale: "en",
  });
  if (!end.isValid) return null;

  let startYear = end.year;
  const startMonthNum = DateTime.fromFormat(startMon, "LLL", {
    zone: timezone,
    locale: "en",
  }).month;
  if (startMonthNum > end.month) {
    startYear -= 1;
  }

  const start = DateTime.fromFormat(`${startDay} ${startMon} ${startYear}`, "d LLL yyyy", {
    zone: timezone,
    locale: "en",
  });
  if (!start.isValid) return null;

  return { start: start.startOf("day"), end: end.endOf("day") };
}

async function getVisibleWeekRangeText(page) {
  const candidates = [
    page.getByText(/\d{1,2}\s+[A-Za-z]{3}\s*[–-]\s*\d{1,2}\s+[A-Za-z]{3}\s+\d{4}/).first(),
    page.locator("h2,h3,div,span").filter({
      hasText: /\d{1,2}\s+[A-Za-z]{3}\s*[–-]\s*\d{1,2}\s+[A-Za-z]{3}\s+\d{4}/,
    }).first(),
  ];
  for (const locator of candidates) {
    if (await isVisible(locator)) {
      const text = await locator.textContent();
      if (text) return text;
    }
  }
  return null;
}

function targetDayHeaderRegex(localDate, timezone) {
  const marker = getDateMarkers(localDate, timezone);
  return new RegExp(`${escapeRegex(marker.weekdayShort)}\\s*,?\\s*${escapeRegex(marker.dayMonth)}`, "i");
}

async function isTargetDayVisible(page, localDate, timezone) {
  const byHeader = page.getByText(targetDayHeaderRegex(localDate, timezone)).first();
  if (await isVisible(byHeader)) return true;
  const marker = getDateMarkers(localDate, timezone);
  const byDayText = page.getByText(new RegExp(`\\b${escapeRegex(marker.dayMonth)}\\b`)).first();
  return isVisible(byDayText);
}

async function clickWeekArrow(page, direction, stepTimeoutMs, log) {
  const isPrev = direction === "prev";
  const clicked = await clickFirst(
    [
      {
        label: isPrev ? "prev arrow near Today" : "next arrow near Today",
        run: () =>
          page.getByRole("button", { name: /today/i }).first().evaluate((todayBtn, dir) => {
            let node = todayBtn;
            for (let depth = 0; depth < 6 && node; depth += 1) {
              const buttons = Array.from(node.querySelectorAll("button"));
              const todayIndex = buttons.findIndex((b) =>
                /\btoday\b/i.test((b.textContent || "").trim()),
              );
              if (todayIndex >= 0 && buttons.length >= 3) {
                const target =
                  dir === "prev"
                    ? buttons[todayIndex + 1] || buttons[todayIndex - 1]
                    : buttons[todayIndex + 2] || buttons[todayIndex + 1];
                if (!target) break;
                target.click();
                return;
              }
              node = node.parentElement;
            }
            throw new Error("week arrows near Today not found");
          }, direction),
      },
      ...(isPrev
        ? [
            {
              label: "previous week button fallback",
              run: () =>
                page
                  .locator('button[aria-label*="previous" i], [role="button"][aria-label*="previous" i], button[aria-label*="prev" i], [role="button"][aria-label*="prev" i]')
                  .first()
                  .click({ timeout: stepTimeoutMs }),
            },
          ]
        : [
            {
              label: "next week button fallback",
              run: () =>
                page
                  .locator('button[aria-label*="next" i], [role="button"][aria-label*="next" i]')
                  .first()
                  .click({ timeout: stepTimeoutMs }),
            },
          ]),
    ],
    log,
  );
  return clicked;
}

async function alignWeekForDate(page, { localDate, timezone, stepTimeoutMs, log }) {
  const target = DateTime.fromISO(localDate, { zone: timezone }).startOf("day");
  if (!target.isValid) return;
  if (await isTargetDayVisible(page, localDate, timezone)) return;

  const rangeText = await getVisibleWeekRangeText(page);
  const range = parseWeekRange(rangeText, timezone);
  let firstDirection = target < DateTime.now().setZone(timezone).startOf("day") ? "prev" : "next";
  if (range) {
    if (target < range.start) firstDirection = "prev";
    if (target > range.end) firstDirection = "next";
    log(`week range seen: ${rangeText}`);
  } else {
    log("week range text not parsed; using day-presence navigation");
  }

  const maxJumps = 12;
  for (let i = 0; i < maxJumps; i += 1) {
    if (await isTargetDayVisible(page, localDate, timezone)) return;
    const clicked = await clickWeekArrow(page, firstDirection, stepTimeoutMs, log);
    if (!clicked) break;
    await page.waitForTimeout(450);
  }

  const secondDirection = firstDirection === "prev" ? "next" : "prev";
  for (let i = 0; i < maxJumps; i += 1) {
    if (await isTargetDayVisible(page, localDate, timezone)) return;
    const clicked = await clickWeekArrow(page, secondDirection, stepTimeoutMs, log);
    if (!clicked) break;
    await page.waitForTimeout(450);
  }

  if (!(await isTargetDayVisible(page, localDate, timezone))) {
    throw new Error(`Could not navigate to week for ${localDate}.`);
  }
}

async function openDayDialog(page, { localDate, timezone, stepTimeoutMs, log }) {
  const dialog = page.locator('[role="dialog"], [aria-modal="true"]').filter({
    hasText: /enter time/i,
  }).first();
  if (await isVisible(dialog)) return dialog;

  const marker = getDateMarkers(localDate, timezone);
  const dayRegex = new RegExp(`${escapeRegex(marker.weekdayShort)}\\s*,?\\s*${escapeRegex(marker.dayMonth)}`, "i");
  const header = page.getByText(dayRegex).first();

  let opened = false;
  if (await isVisible(header)) {
    await header.click({ timeout: stepTimeoutMs }).catch(() => {});
    await page.waitForTimeout(300);
    opened = await isVisible(dialog);
    if (!opened) {
      const box = await header.boundingBox();
      if (box) {
        const offsets = [90, 140, 190, 240];
        for (const yOffset of offsets) {
          await page.mouse.click(box.x + box.width / 2, box.y + yOffset);
          await page.waitForTimeout(300);
          if (await isVisible(dialog)) {
            opened = true;
            break;
          }
        }
      }
    }
  }

  if (!opened) {
    const fallbackDay = await clickFirst(
      [
        {
          label: `day text ${marker.dayMonth}`,
          run: () => page.getByText(new RegExp(`\\b${escapeRegex(marker.dayMonth)}\\b`)).first().click({ timeout: 3000 }),
        },
        {
          label: "enter time blue cell",
          run: () => page.getByText(/enter time/i).first().click({ timeout: 3000 }),
        },
      ],
      log,
    );

    if (fallbackDay) {
      await page.waitForTimeout(300);
      opened = await isVisible(dialog);
    }
  }

  if (!opened) {
    throw new Error(`Could not auto-open day ${marker.dayMonth}.`);
  }

  await dialog.waitFor({ state: "visible", timeout: stepTimeoutMs }).catch(() => {});
  return dialog;
}

async function setTimeType(page, dialog, timeTypeLabel, stepTimeoutMs, log) {
  if (!timeTypeLabel) return;
  const dialogText = await dialog.textContent();
  if (includesByWords(dialogText, timeTypeLabel)) {
    log(`time type already present: ${timeTypeLabel}`);
    return;
  }

  const opened = await clickFirst(
    [
      {
        label: "time type combobox by label",
        run: () => dialog.getByLabel(/time type/i).first().click({ timeout: stepTimeoutMs }),
      },
      {
        label: "time type row",
        run: () => dialog.getByText(/time type/i).first().click({ timeout: stepTimeoutMs }),
      },
      {
        label: "time type list button",
        run: () =>
          dialog
            .locator('[data-automation-id*="promptButton"], button[aria-label*="prompt" i]')
            .first()
            .click({ timeout: stepTimeoutMs }),
      },
    ],
    log,
  );
  if (!opened) return;

  const optionPicked = await clickFirst(
    [
      {
        label: `time type option ${timeTypeLabel}`,
        run: () =>
          page
            .getByRole("option", { name: new RegExp(escapeRegex(timeTypeLabel), "i") })
            .first()
            .click({ timeout: 3000 }),
      },
      {
        label: `time type text ${timeTypeLabel}`,
        run: () =>
          page
            .getByText(new RegExp(escapeRegex(timeTypeLabel), "i"))
            .first()
            .click({ timeout: 3000 }),
      },
    ],
    log,
  );

  if (!optionPicked) {
    await page.keyboard.type(timeTypeLabel).catch(() => {});
    await page.keyboard.press("Enter").catch(() => {});
  }
}

async function fillInOut(dialog, { inTime, outTime, stepTimeoutMs, log }) {
  const inByLabel = dialog.getByLabel(/^\s*in\s*$/i).first();
  const outByLabel = dialog.getByLabel(/^\s*out\s*$/i).first();

  if (await isVisible(inByLabel)) {
    await fillInput(inByLabel, inTime, stepTimeoutMs);
    log(`filled In=${inTime}`);
  } else {
    const inputs = dialog.locator("input");
    if ((await inputs.count()) > 0) {
      await fillInput(inputs.nth(0), inTime, stepTimeoutMs);
      log(`filled In (fallback)=${inTime}`);
    }
  }

  if (await isVisible(outByLabel)) {
    await fillInput(outByLabel, outTime, stepTimeoutMs);
    log(`filled Out=${outTime}`);
  } else {
    const inputs = dialog.locator("input");
    if ((await inputs.count()) > 1) {
      await fillInput(inputs.nth(1), outTime, stepTimeoutMs);
      log(`filled Out (fallback)=${outTime}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`
Usage:
  node sync_pd_to_workday_ui_fill.mjs --plan-file <path> [options]

Options:
  --plan-file          Path to plan JSON (e.g. output/2026-02-28.workday-ui-plan.json)
  --config             Config JSON (default: workday.selectors.json)
  --profile-dir        Browser profile (default: .browser-profile)
  --cdp-url            Attach to existing Chrome (e.g. http://127.0.0.1:9222)
  --step-timeout-ms    Timeout per step (default: 12000)
  --debug              Print debug logs
`);
    return;
  }

  assertRequired(args, ["plan-file"]);
  const planPath = path.resolve(process.cwd(), args["plan-file"]);
  const plan = await loadJson(planPath);
  console.log("Loaded plan:", planPath);

  const configPath = path.resolve(process.cwd(), args.config || "workday.selectors.json");
  const config = await loadJson(configPath).catch(() => ({}));
  const pageUrl = config.timesheetPageUrl || DEFAULT_WORKDAY_URL;
  const timeTypeLabel = config.timeType || "On Call Standby Hours";
  const { inTime, outTime } = config.fixedStartTime
    ? getInOutFromFixedStart(plan, config.fixedStartTime)
    : getInOutFromPlan(plan);
  const stepTimeoutMs = Number(args["step-timeout-ms"] || DEFAULT_STEP_TIMEOUT_MS);
  const debug = Boolean(args.debug);
  const log = (...parts) => {
    if (debug) {
      console.log("[fill]", ...parts);
    }
  };

  console.log("Date:", plan.date, "Hours:", plan.totalHours, "In:", inTime, "Out:", outTime);
  console.log("Time type:", timeTypeLabel);

  const launchExecutable =
    args["chrome-executable"] ||
    (fsSync.existsSync(DEFAULT_CHROME_EXECUTABLE) ? DEFAULT_CHROME_EXECUTABLE : null);

  let context;
  let page;
  if (args["cdp-url"]) {
    const cdpUrl = args["cdp-url"];
    let endpoint = cdpUrl;
    if (!cdpUrl.startsWith("ws")) {
      try {
        const v = await fetch(`${cdpUrl.replace(/\/$/, "")}/json/version`).then((r) => r.json());
        endpoint = v.webSocketDebuggerUrl || cdpUrl;
      } catch (_) {}
    }
    const browser = await chromium.connectOverCDP(endpoint).catch(() => null);
    if (!browser) {
      const launchOptions = { headless: false };
      if (launchExecutable) {
        launchOptions.executablePath = launchExecutable;
      } else {
        launchOptions.channel = "chrome";
      }
      context = await chromium.launchPersistentContext(
        path.resolve(process.cwd(), args["profile-dir"] || DEFAULT_PROFILE_DIR),
        launchOptions,
      );
    } else {
      context = browser.contexts()[0] || (await browser.newContext());
    }
    page = context.pages()[0] || (await context.newPage());
  } else {
    const launchOptions = { headless: false };
    if (launchExecutable) {
      launchOptions.executablePath = launchExecutable;
    } else {
      launchOptions.channel = "chrome";
    }
    context = await chromium.launchPersistentContext(
      path.resolve(process.cwd(), args["profile-dir"] || DEFAULT_PROFILE_DIR),
      launchOptions,
    );
    page = context.pages()[0] || (await context.newPage());
  }

  await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
  await waitForEnter(
    "\nComplete SSO login if needed, stop on any Workday page, then press ENTER. " +
      "Script will drive Menu -> Time -> Enter Time -> day -> modal fill.",
  );

  await openEnterTimePage(page, {
    localDate: plan.date,
    timezone: plan.timezone || DEFAULT_TIMEZONE,
    stepTimeoutMs,
    log,
  });
  await alignWeekForDate(page, {
    localDate: plan.date,
    timezone: plan.timezone || DEFAULT_TIMEZONE,
    stepTimeoutMs,
    log,
  });
  const dialog = await openDayDialog(page, {
    localDate: plan.date,
    timezone: plan.timezone || DEFAULT_TIMEZONE,
    stepTimeoutMs,
    log,
  });

  await setTimeType(page, dialog, timeTypeLabel, stepTimeoutMs, log);
  await fillInOut(dialog, { inTime, outTime, stepTimeoutMs, log });

  await page.waitForTimeout(300);
  const okClicked = await clickFirst(
    [
      {
        label: "OK button",
        run: () => dialog.getByRole("button", { name: /^ok$/i }).first().click({ timeout: stepTimeoutMs }),
      },
      {
        label: "OK text",
        run: () => dialog.getByText(/^ok$/i).first().click({ timeout: stepTimeoutMs }),
      },
    ],
    log,
  );
  if (!okClicked) {
    throw new Error("Could not click OK in Enter Time dialog.");
  }

  console.log("Filled pop-up and clicked OK. Entry saved as draft; not submitted.");
  await context.close();
}

function assertRequired(args, keys) {
  for (const key of keys) {
    if (!args[key]) {
      throw new Error(`Missing required argument --${key}`);
    }
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
