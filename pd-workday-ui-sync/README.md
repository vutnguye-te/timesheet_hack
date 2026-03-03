# PagerDuty -> Workday UI Sync (Option 2)

This tool uses:
- PagerDuty API for on-call hours
- Playwright browser automation for Workday UI fill

Safety behavior:
- Never clicks `Submit`
- Saves draft only (unless `--no-save`)

## Files
- `sync_pd_to_workday_ui.mjs`: fill via **UI** (Playwright click/fill; table layout)
- `sync_pd_to_workday_ui_fill.mjs`: open page and fill the **grid pop-up** from an existing plan (recommended if you already have the schedule from PD)
- `sync_pd_to_workday_post.mjs`: fill via **POST** (flowController; no DOM selectors)
- `workday.selectors.sample.json`: selector + flow config template
- `workday.selectors.json`: your local config

## Setup

```bash
cd /Users/vutnguye/Work-Other/hackday-timesheet/pd-workday-ui-sync
npm install
npx playwright install chromium
cp workday.selectors.sample.json workday.selectors.json
```

## Fill from existing plan (open page + fill pop-up)

If you already have the schedule from PagerDuty (e.g. you ran dry-run or have `output/YYYY-MM-DD.workday-ui-plan.json`):

```bash
node sync_pd_to_workday_ui_fill.mjs --plan-file output/2026-02-28.workday-ui-plan.json
```

The script opens Workday. You go to **Menu > Time > Enter Time > This Week**, then **click the day** you want to fill so the "Enter Time" pop-up opens. Press ENTER in the terminal. The script fills **Time Type**, **In**, **Out** from the plan and clicks **OK**. It does not submit the timesheet. Set `timeType` in `workday.selectors.json` (e.g. `"On Call Standby"` or `"On Call Hours Worked"`) to match your tenant.

## Dry-run (recommended first)

```bash
node sync_pd_to_workday_ui.mjs \
  --date 2026-02-28 \
  --schedule-id P88SKP2 \
  --timezone America/Los_Angeles \
  --pd-token-file ../pd_token \
  --pd-user-email vutnguye@thousandeyes.com \
  --dry-run
```

Output plan:
- `output/2026-02-28.workday-ui-plan.json`

## Real UI fill

1. Update selectors in `workday.selectors.json` to match your Workday tenant UI.
2. Run without `--dry-run`.

```bash
node sync_pd_to_workday_ui.mjs \
  --date 2026-02-28 \
  --schedule-id P88SKP2 \
  --timezone America/Los_Angeles \
  --pd-token-file ../pd_token \
  --pd-user-email vutnguye@thousandeyes.com
```

The browser opens in a persistent profile (`.browser-profile`):
- Complete SSO manually
- Navigate to edit timesheet page
- Press ENTER in terminal
- Script fills Date / Hours / Time Type and clicks Save
- Script does not click Submit

## Fill via POST (no UI selectors)

If you prefer to fill by POSTing to Workday’s flowController (using the captured In_Time/Out_Time flow):

```bash
node sync_pd_to_workday_post.mjs \
  --date 2026-02-28 \
  --schedule-id P88SKP2 \
  --timezone America/Los_Angeles \
  --pd-token-file ../pd_token \
  --pd-user-email vutnguye@thousandeyes.com
```

Browser opens for SSO. Then: **Menu → Time → Enter Time → This Week** (or the week with your date). **Click the day** you want to fill so the "Enter Time" pop-up opens (Date, Time Type, In, Out, Hours, OK). With the pop-up open, press ENTER in the terminal. The script reads tokens from the pop-up (or captures them when you click In/Out) and POSTs In_Time and Out_Time. It does not click Submit. Config: `workdayFlowControllerUrl`, `flowFieldPrefix` in `workday.selectors.json`.

## Reuse existing browser session/tab

If you want to open a new tab in your existing Chrome session instead of a new window:

1. Quit all Chrome processes first, then start Chrome with remote debugging enabled:

```bash
/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222
```

2. Verify CDP is up:

```bash
curl http://127.0.0.1:9222/json/version
```

3. Run with `--cdp-url`:

```bash
node sync_pd_to_workday_ui.mjs \
  --date 2026-02-28 \
  --schedule-id P88SKP2 \
  --timezone America/Los_Angeles \
  --pd-token-file ../pd_token \
  --pd-user-email vutnguye@thousandeyes.com \
  --cdp-url http://127.0.0.1:9222
```

This attaches to the existing Chrome instance and opens a tab in that session.

If you want to reuse the currently open tab instead of creating a new one, add:

```bash
--use-existing-tab
```

## Troubleshooting

### ECONNREFUSED when using `--cdp-url`

If you see `Failed to attach to Chrome CDP endpoint ... connect ECONNREFUSED 127.0.0.1:9222`:

- **Option A (reuse existing Chrome):** Quit Chrome completely, then start it with remote debugging:  
  `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222`  
  Verify with `curl http://127.0.0.1:9222/json/version`, then run the script again with `--cdp-url http://127.0.0.1:9222`.
- **Option B (easiest):** Run the script **without** `--cdp-url` and `--use-existing-tab`; it will launch its own browser (see "Real UI fill" above).

## Notes

- You may need to tune selectors for date/hours/time type fields.
- If Workday requires extra fields (cost center/project), add selectors + fill steps.
