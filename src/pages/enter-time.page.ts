import { type Page, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import type { TimeEntry, WeekGroup } from '../types';

const WORKDAY_URL = 'https://wd5.myworkday.com/cisco/d/home.htmld';
const AUTH_FILE = path.join(__dirname, '..', '..', '.auth', 'state.json');

/** Map 3-letter day abbreviations to full checkbox names */
const DAY_MAP: Record<string, string> = {
  Mon: 'Monday',
  Tue: 'Tuesday',
  Wed: 'Wednesday',
  Thu: 'Thursday',
  Fri: 'Friday',
  Sat: 'Saturday',
  Sun: 'Sunday',
};

export class EnterTimePage {
  constructor(private page: Page) {}

  /** Navigate to Workday home, handling auth inline if session expired */
  async goto() {
    await this.page.goto(WORKDAY_URL, { waitUntil: 'domcontentloaded' });

    try {
      await this.page.getByRole('button', { name: 'MENU' }).waitFor({ timeout: 15_000 });
    } catch {
      // Auth expired — wait for manual SSO in this same browser
      console.log('');
      console.log('==========================================================');
      console.log('  Auth expired. Complete SSO + Duo MFA in the browser.');
      console.log('  This will continue automatically once login is detected.');
      console.log('==========================================================');
      console.log('');

      await this.page.getByRole('button', { name: 'MENU' }).waitFor({ timeout: 2 * 60 * 1000 });

      // Save refreshed auth state
      var authDir = path.dirname(AUTH_FILE);
      if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
      await this.page.context().storageState({ path: AUTH_FILE });
      console.log('Auth state saved.');
    }

    // Let Workday home page fully load before navigating
    await this.page.waitForLoadState('networkidle');
    await this.page.waitForTimeout(2_000);
  }

  /** Open MENU sidebar and click Time link */
  async navigateToTime() {
    await this.page.getByRole('button', { name: 'MENU' }).click();
    await this.page.getByRole('link', { name: 'Time' }).waitFor({ timeout: 10_000 });
    await this.page.getByRole('link', { name: 'Time' }).click();
    // Wait for Enter Time page to load (look for This Week or Select Week)
    await this.page.getByRole('link', { name: 'Select Week' }).waitFor({ timeout: 15_000 });
  }

  /** Open date picker, fill Day/Month/Year, click OK to navigate to a specific week */
  async selectWeek(date: string) {
    // date is YYYY-MM-DD — we need day, month, year as numbers
    var [yearStr, monthStr, dayStr] = date.split('-');
    var day = parseInt(dayStr, 10).toString();
    var month = parseInt(monthStr, 10).toString();
    var year = yearStr;

    await this.page.getByRole('link', { name: 'Select Week' }).click();
    await this.page.getByRole('spinbutton', { name: 'Day' }).waitFor({ timeout: 10_000 });

    // GWT spinbuttons don't respond to fill() — click, select all, type
    for (var [name, value] of [['Day', day], ['Month', month], ['Year', year]] as const) {
      var spinbutton = this.page.getByRole('spinbutton', { name });
      await spinbutton.click();
      await this.page.keyboard.press('Meta+A');
      await this.page.keyboard.type(value);
    }

    await this.page.getByRole('button', { name: 'OK' }).click();

    // Wait for the Enter Time page to reload with the new week
    await this.page.getByRole('button', { name: 'Actions', exact: true }).waitFor({ timeout: 30_000 });
  }

  /** Click Actions → Quick Add to open the Quick Add dialog */
  async openQuickAdd() {
    await this.page.getByRole('button', { name: 'Actions', exact: true }).click();
    await this.page.getByRole('option', { name: 'Quick Add' }).waitFor({ timeout: 5_000 });
    await this.page.getByRole('option', { name: 'Quick Add' }).click();
    // Wait for the Quick Add dialog
    await this.page.getByRole('dialog', { name: 'Quick Add' }).waitFor({ timeout: 10_000 });
  }

  /**
   * Switch Time Type to standby.
   * Default is always "On Call Hours Worked" — must explicitly switch for standby.
   *
   * Verified via Chrome DevTools MCP: click the TEXTBOX (not the pill) → Backspace
   * opens the radio dropdown → click the standby option.
   * The pill overlays the textbox, so we use { force: true } to bypass Playwright's
   * overlay detection.
   */
  async selectTimeType(type: 'standby' | 'worked') {
    if (type === 'worked') {
      // Default is already "On Call Hours Worked", no action needed
      return;
    }

    var timeTypeInput = this.page.getByRole('textbox', { name: 'Time Type' });
    var standbyOption = this.page.getByRole('option', { name: /On Call Standby Hours radio button/ });

    // Click the textbox with force (pill overlays it), then Backspace opens the dropdown
    for (var attempt = 1; attempt <= 3; attempt++) {
      await timeTypeInput.click({ force: true });
      await this.page.keyboard.press('Backspace');

      try {
        await standbyOption.waitFor({ timeout: 3_000 });
        break;
      } catch {
        console.log(`  Attempt ${attempt}: dropdown did not open, retrying...`);
        await this.page.waitForTimeout(500);
      }
    }

    // Click the standby radio option
    await standbyOption.click();

    // Verify the pill changed to standby
    await expect(this.page.getByRole('option', { name: /On Call Standby Hours, Press delete/ }))
      .toBeVisible({ timeout: 5_000 });
  }

  /** Click Next to proceed from Time Type selection to time/day form */
  async clickNext() {
    // Wait for any async validation to settle after time type selection
    await this.page.waitForTimeout(1_000);
    var nextBtn = this.page.getByRole('button', { name: 'Next' });
    await nextBtn.waitFor({ state: 'visible', timeout: 5_000 });
    await nextBtn.click();
    // Wait for step 2: day checkboxes are unique to the time/day form
    await this.page.getByRole('checkbox', { name: 'Monday' }).waitFor({ timeout: 30_000 });
  }

  /** Fill In/Out times and check the appropriate day checkboxes */
  async fillTimeAndDays(entry: TimeEntry) {
    // GWT wraps inputs in custom panels that intercept pointer events.
    // Use { force: true } on all interactions to bypass overlay detection.
    var inField = this.page.getByRole('textbox', { name: 'In', exact: true });
    var outField = this.page.getByRole('textbox', { name: 'Out', exact: true });

    // Fill In time
    await inField.click({ force: true });
    await inField.fill(entry.inTime);

    // Fill Out time
    await outField.click({ force: true });
    await outField.fill(entry.outTime);

    // Check day boxes — GWT checkboxPanel wraps each checkbox
    for (var dayAbbr of entry.days) {
      var fullDay = DAY_MAP[dayAbbr];
      if (!fullDay) throw new Error(`Unknown day abbreviation: ${dayAbbr}`);
      await this.page.getByRole('checkbox', { name: fullDay }).check({ force: true });
    }
  }

  /** Verify the filled values match what we expect */
  async verifyEntry(entry: TimeEntry) {
    // Verify day checkboxes are checked
    for (var dayAbbr of entry.days) {
      var fullDay = DAY_MAP[dayAbbr];
      if (!fullDay) throw new Error(`Unknown day abbreviation: ${dayAbbr}`);
      await expect(this.page.getByRole('checkbox', { name: fullDay })).toBeChecked();
    }
  }

  /**
   * Click OK to submit the Quick Add.
   * Returns 'success' if confirmed, 'overlap' if all days already have entries.
   * Throws on non-overlap errors.
   */
  async confirmQuickAdd(): Promise<'success' | 'overlap'> {
    await this.page.getByRole('button', { name: 'OK' }).click();

    // Race: either "Quick Add Complete" text or an error badge button appears
    var quickAddComplete = this.page.getByText('Quick Add Complete').first();
    var errorBadge = this.page.getByRole('button', { name: /\d+ Error/ });

    var winner = await Promise.race([
      quickAddComplete.waitFor({ timeout: 20_000 }).then(() => 'success' as const),
      errorBadge.waitFor({ timeout: 20_000 }).then(() => 'error' as const),
    ]);

    if (winner === 'success') {
      console.log('  Quick Add Complete');
      return 'success';
    }

    // Click the error badge to open the Errors and Alerts dialog
    await errorBadge.click();
    var errorsDialog = this.page.getByRole('dialog', { name: 'Errors and Alerts' });
    await errorsDialog.waitFor({ timeout: 5_000 });

    // Read the error messages
    var errorItems = await errorsDialog.getByRole('listitem').allTextContents();
    var allOverlap = errorItems.every((e) => e.includes('overlaps with existing time'));

    // Close the error dialog
    await this.page.getByRole('button', { name: 'Close Errors and Alerts' }).click();

    if (allOverlap) {
      console.log('  Skipping: entries already exist (overlap detected)');
      // Cancel the Quick Add form
      await this.page.getByRole('button', { name: 'Cancel' }).click();
      // Wait for the Quick Add dialog to close and time grid to reappear
      await this.page.getByRole('button', { name: 'Actions', exact: true }).waitFor({ timeout: 15_000 });
      return 'overlap';
    }

    // Non-overlap errors — throw with details
    throw new Error(`Quick Add failed with errors:\n${errorItems.join('\n')}`);
  }

  /** Full Quick Add cycle for a single entry. Returns 'success' or 'overlap'. */
  async enterSingleEntry(entry: TimeEntry): Promise<'success' | 'overlap'> {
    var typeLabel = entry.type === 'standby' ? 'Standby' : 'Worked';
    console.log(`  Adding ${typeLabel}: ${entry.inTime} - ${entry.outTime} [${entry.days.join(', ')}]`);

    await this.openQuickAdd();
    await this.selectTimeType(entry.type);
    await this.clickNext();
    await this.fillTimeAndDays(entry);
    await this.verifyEntry(entry);
    return await this.confirmQuickAdd();
  }

  /** Select a week and enter all its entries */
  async enterWeek(week: WeekGroup) {
    console.log(`\nWeek: ${week.weekStart} (${week.entries.length} entries)`);
    await this.selectWeek(week.weekStart);

    var added = 0;
    var skipped = 0;
    for (var entry of week.entries) {
      var result = await this.enterSingleEntry(entry);
      if (result === 'overlap') skipped++;
      else added++;
    }
    console.log(`  Week done: ${added} added, ${skipped} skipped (already exist)`);
  }

  /** Click the Review data button */
  async clickReview() {
    await this.page.getByRole('button', { name: /Review data/ }).click();
    // Wait for review/submit page to load
    await this.page.getByRole('button', { name: 'Submit' }).waitFor({ timeout: 15_000 });
  }

  /** Click Submit */
  async clickSubmit() {
    await this.page.getByRole('button', { name: 'Submit' }).click();
  }

  /** Click Cancel on the review page */
  async clickCancel() {
    await this.page.getByRole('button', { name: 'Cancel' }).click();
  }
}
