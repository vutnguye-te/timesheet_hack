---
name: oncall-pw
description: Enter on-call time entries in Workday using Playwright automation. Fast (~1 min). Falls back to Chrome DevTools MCP for diagnosis on failure.
---
# Workday On-Call Time Entry (Playwright)

Fast Playwright-based automation for entering on-call standby and worked hours into Workday.
Uses the Playwright test suite in this repo (~15s per entry).
Falls back to Chrome DevTools MCP on port 9222 for diagnosing failures.

## Prerequisites

Before first use:
1. **Node.js** v18+
2. **Install dependencies**: `npm install`
3. **Install Playwright browser**: `npx playwright install chromium`

Auth is handled automatically — if the session is expired when running, the browser will prompt for SSO + Duo MFA and continue once login is detected.

## Quick Start

```
/oncall-pw
On call Mar 2-6, shift ends 5pm. Paged Mar 4 6am-8am.
```

## Step 1: Parse User Input & Preview

The user provides:
- **Date range**: start and end dates of on-call rotation
- **Shift end time**: when the last day ends (e.g., 5pm)
- **Incidents** (optional): date + time ranges when they were paged

Run the dry-run calculator to preview entries:

```bash
npx tsx src/oncall-entries.ts \
  --start YYYY-MM-DD --end YYYY-MM-DD --shift-end HH:MM \
  --incident "YYYY-MM-DD HH:MM-HH:MM"
```

Display the generated entries table to the user and **ask for confirmation** before proceeding.

## Step 2: Run Playwright

Execute as a single bash command:

```bash
ONCALL_START=YYYY-MM-DD \
ONCALL_END=YYYY-MM-DD \
ONCALL_SHIFT_END=HH:MM \
ONCALL_INCIDENTS="YYYY-MM-DD HH:MM-HH:MM,YYYY-MM-DD HH:MM-HH:MM" \
KEEP_BROWSER_ON_FAILURE=1 \
npx playwright test --project=workday 2>&1
```

**Environment variables:**
| Variable | Format | Example | Required |
|---|---|---|---|
| `ONCALL_START` | `YYYY-MM-DD` | `2026-03-02` | Yes |
| `ONCALL_END` | `YYYY-MM-DD` | `2026-03-06` | Yes |
| `ONCALL_SHIFT_END` | `HH:MM` (24h) | `17:00` | Yes |
| `ONCALL_INCIDENTS` | Comma-separated `YYYY-MM-DD HH:MM-HH:MM` | `2026-03-04 06:00-08:00` | No |
| `KEEP_BROWSER_ON_FAILURE` | `1` | `1` | Yes (for MCP fallback) |

**Important:** Set the Bash tool timeout to at least 300000ms (5 min) since Playwright needs time for browser launch, auth, and form interactions.

## Step 3: Handle Result

Read Playwright's stdout to determine the outcome:

### Success — stdout contains "passed"
Report to user: entries added successfully. Proceed to Step 4.

### Auth Expired — "Auth expired" message in stdout
The browser will automatically prompt for SSO login. **STOP and tell the user to complete Duo SSO login in the browser.** The test detects login automatically, saves the auth state, and continues with time entry — no retry needed.

### Other Failure — any selector timeout or unexpected error
The browser stays alive on port 9222 (via `KEEP_BROWSER_ON_FAILURE=1`). Use Chrome DevTools MCP to diagnose:

1. Connect to the browser on port 9222
2. `take_snapshot` to see current page state
3. Report the failure context to the user (what step failed, what the page shows)
4. The user can decide whether to fix manually or retry

## Step 4: Report

Tell the user:
- All entries have been added to Workday
- They should **review and submit manually** in the Workday browser window
- The browser remains open for them to verify

## Error Recovery Matrix

| Playwright Error | Action |
|---|---|
| "Auth expired" in stdout | User completes SSO in browser — test continues automatically |
| "overlaps with existing time" in logs | Already handled in code — entry is skipped, continues |
| Any other selector timeout | Browser alive on 9222 — use MCP `take_snapshot` to diagnose |
| `ONCALL_*` env var missing | Parse error — check input and re-run |

## Workday-Specific Gotchas

These are relevant when using Chrome DevTools MCP for diagnosis:

1. **GWT widgets** — Workday uses Google Web Toolkit. Standard DOM clicks don't work; MCP `click`/`fill` tools are needed.
2. **Time Type resets every Quick Add** — defaults to "On Call Hours Worked". Must switch for each standby entry.
3. **Time format** — 12-hour with AM/PM: `12:00 AM` (midnight), `11:59 PM` (end of day).
4. **No overlap allowed** — Standby and Worked hours cannot overlap on the same day.
5. **`take_snapshot` over `take_screenshot`** — Accessibility tree snapshots are more reliable for element identification.
6. **Delete key trick for Time Type** — click the selected pill, press Delete to open the radio button dropdown.

## Element Reference (for MCP Diagnosis)

### Enter Time Page
| Element | Role | Notes |
|---------|------|-------|
| `"MENU"` | button | description="Global Navigation", expandable |
| `"Time"` | link | Under Personal section in menu |
| `"This Week"` | link | Opens current week Enter Time |
| `"Select Week"` | link | Opens date picker dialog |
| `"Actions"` | button | expandable, haspopup="menu" |
| `"Quick Add"` | option | In Actions dropdown listbox |

### Quick Add Dialog
| Element | Role | Notes |
|---------|------|-------|
| `"On Call Hours Worked, Press delete to clear item.."` | option | Click then Delete to change |
| `"On Call Standby Hours radio button unselected"` | option | In Time Type dropdown |
| `"Next"` | button | Proceed to time entry |
| `"In"` / `"Out"` | textbox | 12-hour format with AM/PM |
| `"Monday"` through `"Sunday"` | checkbox | Day selection |
| `"OK"` | button | Submit Quick Add |
