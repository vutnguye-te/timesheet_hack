# Workday Timesheet Chrome Extension (PD Upload)

This extension lets you:
1. Open Workday and complete SSO manually.
2. Upload PagerDuty-derived output file (`json`/`csv`).
3. Autofill timesheet draft rows.
4. Save draft only (never submit).

## Supported input formats

- `pd-workday-api-sync/output/*.workday-draft.json`
- `pd-workday-ui-sync/output/*.workday-ui-plan.json`
- `pd-workday-rpa-sync/output/*.rpa-queue.json`
- CSV with columns: `date,hours,time_type,memo` (or `timeType`)

## Install (unpacked)

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select:
   `/Users/vutnguye/Work-Other/hackday-timesheet/workday-timesheet-extension`

## Use

1. Open your Workday timesheet page.
2. Open the extension popup.
3. Upload your payload file.
4. Click **Preview Entries**.
5. Keep **Dry run** checked and click **Fill Draft** once.
6. If highlighting looks correct, uncheck **Dry run** and click **Fill Draft** again.

## If nothing changes

1. Go to `chrome://extensions`, click **Reload** on this extension.
2. Refresh the Workday tab.
3. Click **Scan Page** in popup.
4. Check popup status for detected input fields and auto-suggested selectors.
5. Run **Dry run** again and check popup status:
   - If it says `No Workday input fields were detected`, your tenant selectors differ.
6. Paste/adjust custom selectors in popup and retry.

### Manual selector picker (works even when scan fails)

1. In popup, choose a field key (`dateInput`, `hoursInput`, `timeTypeInput`, etc.).
2. Click **Pick Selector**.
3. Click the matching element on Workday page.
4. Repeat for required fields.
5. Run **Dry run** again.

## Safety

- The content script never clicks Submit.
- If a submit button is detected, it is highlighted with a warning outline.

## Selector tuning

Workday UI differs across tenants. If fields are not found:
1. Inspect element selectors in your tenant.
2. Paste custom selector JSON in popup:

```json
{
  "dateInput": "input[data-automation-id='dateInputBox']",
  "hoursInput": "input[data-automation-id='numericInput']",
  "timeTypeInput": "input[data-automation-id='promptOption']",
  "memoInput": "textarea[data-automation-id='textArea']",
  "saveButton": "button[data-automation-id='saveButton']"
}
```

The extension stores this JSON in local Chrome extension storage for reuse.
