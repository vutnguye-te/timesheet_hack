import { test } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { calculateEntries } from '../src/oncall-entries';
import { EnterTimePage } from '../src/pages/enter-time.page';
import type { Incident, OnCallParams } from '../src/types';

const AUTH_FILE = path.join(__dirname, '..', '.auth', 'state.json');

// --- Parse env vars ---

function getRequiredEnv(name: string): string {
  var value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function parseIncidents(raw: string | undefined): Incident[] {
  if (!raw || raw.trim() === '') return [];
  // Format: "YYYY-MM-DD HH:MM-HH:MM,YYYY-MM-DD HH:MM-HH:MM,..."
  return raw.split(',').map((s) => {
    var trimmed = s.trim();
    var [date, times] = trimmed.split(' ');
    var [startTime, endTime] = times.split('-');
    return { date, startTime, endTime };
  });
}

// --- Build params from env ---

var params: OnCallParams = {
  startDate: getRequiredEnv('ONCALL_START'),
  endDate: getRequiredEnv('ONCALL_END'),
  shiftEndTime: getRequiredEnv('ONCALL_SHIFT_END'),
  incidents: parseIncidents(process.env.ONCALL_INCIDENTS),
};

var weeks = calculateEntries(params);
// --- Log summary ---

var totalEntries = weeks.reduce((sum, w) => sum + w.entries.length, 0);
console.log(`\nOn-Call Time Entry: ${params.startDate} to ${params.endDate}`);
console.log(`Shift end: ${params.shiftEndTime}, Incidents: ${params.incidents.length}`);
console.log(`Calculated: ${weeks.length} week(s), ${totalEntries} Quick Add entries\n`);

// --- Test ---

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== 'passed' && process.env.KEEP_BROWSER_ON_FAILURE === '1') {
    console.log('\n=== FAILED — browser alive on port 9222 for MCP diagnosis ===');
    await page.waitForTimeout(120_000);
  }
});

test('enter on-call time in Workday', async ({ page, context }) => {
  // Load saved cookies if available (single browser — no separate auth project needed)
  if (fs.existsSync(AUTH_FILE)) {
    var savedState = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
    await context.addCookies(savedState.cookies || []);
  }

  var timePage = new EnterTimePage(page);

  await test.step('Navigate to Time page', async () => {
    await timePage.goto();
    await timePage.navigateToTime();
  });

  for (var week of weeks) {
    await test.step(`Week ${week.weekStart} (${week.entries.length} entries)`, async () => {
      await timePage.enterWeek(week);
    });
  }

  console.log('\nDone — all entries added. Review and submit manually in Workday.');
});
