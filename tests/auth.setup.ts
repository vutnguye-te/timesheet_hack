import { test as setup } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const AUTH_FILE = path.join(__dirname, '..', '.auth', 'state.json');
const WORKDAY_URL = 'https://wd5.myworkday.com/cisco/d/home.htmld';

setup('authenticate with Workday', async ({ page, context }) => {
  // Check if existing auth state is still valid
  if (fs.existsSync(AUTH_FILE)) {
    console.log('Found existing auth state, checking validity...');
    try {
      var savedState = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
      await context.addCookies(savedState.cookies || []);
      await page.goto(WORKDAY_URL, { waitUntil: 'domcontentloaded' });
      // If we can see the MENU button, auth is still valid
      await page.getByRole('button', { name: 'MENU' }).waitFor({ timeout: 15_000 });
      console.log('Existing auth state is valid, skipping login.');
      return;
    } catch {
      console.log('Existing auth state expired, need to re-authenticate.');
    }
  }

  // Navigate to Workday — will redirect to SSO
  await page.goto(WORKDAY_URL, { waitUntil: 'domcontentloaded' });

  // Wait for manual SSO + Duo MFA — no Inspector needed.
  // The user completes login in the headed browser; we poll for the MENU button.
  console.log('');
  console.log('==========================================================');
  console.log('  Complete SSO login + Duo MFA in the browser window.');
  console.log('  This will continue automatically once login is detected.');
  console.log('==========================================================');
  console.log('');

  // Poll for login completion (2 min timeout for SSO + Duo push)
  await page.getByRole('button', { name: 'MENU' }).waitFor({ timeout: 2 * 60 * 1000 });
  console.log('Login successful! Saving auth state...');

  // Save storage state
  var authDir = path.dirname(AUTH_FILE);
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }
  await context.storageState({ path: AUTH_FILE });
  console.log(`Auth state saved to ${AUTH_FILE}`);
});
