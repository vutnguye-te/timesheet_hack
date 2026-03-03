import { chromium } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const AUTH_FILE = path.join(__dirname, '..', '.auth', 'state.json');
const WORKDAY_URL = 'https://wd5.myworkday.com/cisco/d/home.htmld';

async function main() {
  var browser = await chromium.launch({
    headless: false,
    args: ['--remote-debugging-port=9222'],
  });

  var context = await browser.newContext({
    storageState: AUTH_FILE,
    viewport: { width: 1440, height: 900 },
  });

  var page = await context.newPage();

  console.log('Navigating to Workday...');
  await page.goto(WORKDAY_URL, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'MENU' }).waitFor({ timeout: 30_000 });

  console.log('Opening Time page...');
  await page.getByRole('button', { name: 'MENU' }).click();
  await page.getByRole('link', { name: 'Time' }).waitFor({ timeout: 10_000 });
  await page.getByRole('link', { name: 'Time' }).click();
  await page.getByRole('link', { name: 'Select Week' }).waitFor({ timeout: 15_000 });

  console.log('Selecting week...');
  await page.getByRole('link', { name: /This Week/ }).click();
  await page.getByRole('button', { name: 'Actions', exact: true }).waitFor({ timeout: 30_000 });

  console.log('Opening Quick Add...');
  await page.getByRole('button', { name: 'Actions', exact: true }).click();
  await page.getByRole('option', { name: 'Quick Add' }).waitFor({ timeout: 5_000 });
  await page.getByRole('option', { name: 'Quick Add' }).click();
  await page.getByRole('dialog', { name: 'Quick Add' }).waitFor({ timeout: 10_000 });

  console.log('\n=== Quick Add dialog open ===');
  console.log('Browser on port 9222 — use Chrome DevTools MCP to inspect.');
  console.log('Press Ctrl+C to close.\n');

  // Keep alive
  await new Promise(() => {});
}

main().catch(console.error);
