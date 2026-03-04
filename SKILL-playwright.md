---
name: oncall-pw
description: Enter on-call time entries in Workday using Playwright automation. Fast (~1 min). Uses PagerDuty integration by default to derive actual on-call standby coverage, with manual fallback. Falls back to Chrome DevTools MCP for diagnosis on failure.
---
# Workday On-Call Time Entry (Playwright)

Fast Playwright-based automation for entering on-call standby and worked hours into Workday.
Uses the Playwright test suite in this repo (~15s per entry).
Default flow: pull on-call coverage from PagerDuty and derive actual standby periods before running Playwright.
Falls back to Chrome DevTools MCP on port 9222 for diagnosing failures.

## Default Flow: PagerDuty Integration (required unless user explicitly wants manual input)

Use this path to fetch **actual on-call standby coverage** from PagerDuty and convert it into Playwright runs.

### Step 1: Confirm target month (or range)

If not explicit, ask for the month (e.g. `March 2026`) or date range.

### Step 2: Get PagerDuty user id

Call the PagerDuty MCP tool to resolve the current user and capture `id`:

- **Tool:** `mcp__pagerduty__get_user_data`
- **Output:** use the `id` field from the response for the next step

### Step 3: Query on-call coverage

Use UTC boundaries for the target range:

- Month mode:
  - `since` = first day of month at `00:00:00Z`
  - `until` = first day of next month at `00:00:00Z`
- Custom range mode:
  - `since` = range start at `00:00:00Z`
  - `until` = day after range end at `00:00:00Z`

Call:

- **Tool:** `mcp__pagerduty__list_oncalls`
- **Input:** `query_model` JSON string including at least `since`, `until`, `user_ids`, `limit`

Example `query_model`:

```json
"{\"since\":\"YYYY-MM-01T00:00:00Z\",\"until\":\"YYYY-MM-01T00:00:00Z\",\"user_ids\":[\"<USER_ID>\"],\"limit\":100}"
```

Rules:

- Ignore rows missing `start` or `end`.
- Keep only entries where the user is on call.
- Convert intervals to the user local timezone for day/time splitting.

### Step 4: Build actual standby blocks

Create **contiguous standby blocks** from PagerDuty coverage (merge intervals where next.start == previous.end).

For each block derive:

- `ONCALL_START` = local date of block start
- `ONCALL_END` = local date of block end
- `ONCALL_SHIFT_END` = local time (`HH:MM`, 24h) of block end on `ONCALL_END`

Important behavior:

- Run Playwright **once per contiguous block**.
- If a block ends exactly at midnight (`00:00`), set:
  - `ONCALL_END` to the previous day
  - `ONCALL_SHIFT_END=23:59`
- This preserves actual standby coverage and avoids creating standby on uncovered days.

### Step 5: Optional worked incidents

If the user provides paged/worked windows, pass them as `ONCALL_INCIDENTS` (`YYYY-MM-DD HH:MM-HH:MM`, comma-separated).

If no incidents are provided, use empty incidents.

## Prerequisites

Before first use:
1. **Node.js** v18+
2. **Install dependencies**: `npm install`
3. **System Chrome** installed (Playwright uses it via `channel: 'chrome'` — no bundled browser download needed)

Auth is handled automatically. If session is expired, browser prompts for SSO + Duo MFA and resumes.

## Quick Start

**PagerDuty-first (default):**
1. Resolve user via `mcp__pagerduty__get_user_data`
2. Pull coverage via `mcp__pagerduty__list_oncalls`
3. Build contiguous blocks
4. Dry-run + confirm
5. Run Playwright once per block

**Manual fallback (only when user explicitly requests manual input):**
```
/oncall-pw
On call Mar 2-6, shift ends 5pm. Paged Mar 4 6am-8am.
```

## Step 1: Dry-Run Preview (required)

For each block, run:

```bash
npx tsx src/oncall-entries.ts \
  --start YYYY-MM-DD --end YYYY-MM-DD --shift-end HH:MM \
  --incident "YYYY-MM-DD HH:MM-HH:MM"
```

Display the generated entries table and ask for confirmation before Playwright.

## Step 2: Run Playwright

Execute as a single bash command per block:

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

**Important:** Set Bash timeout to at least `300000ms` (5 min).

## Step 3: Handle Result

Parse stdout:

### Success — stdout contains "passed"
Report success and continue to Step 4.

### Auth Expired — "Auth expired" in stdout
Stop and tell user to complete Duo SSO in browser. Test resumes automatically once login is detected.

### Other Failure — selector timeout / unexpected error
Use Chrome DevTools MCP against browser on port 9222:

1. Connect to browser on port 9222
2. `take_snapshot` for page state
3. Report exact failing step and current page state
4. Let user choose manual fix vs retry

## Step 4: Report

Tell the user:
- All entries were added to Workday
- They should review and submit manually in Workday
- Browser remains open for verification

## Error Recovery Matrix

| Playwright Error | Action |
|---|---|
| "Auth expired" in stdout | User completes SSO in browser; test continues |
| "overlaps with existing time" in logs | Already handled in code; entry skipped |
| Any other selector timeout | Browser on 9222; diagnose with MCP snapshot |
| `ONCALL_*` env var missing | Input/parse error; fix values and rerun |

## Workday-Specific Gotchas

These are relevant when diagnosing with Chrome DevTools MCP:

1. **GWT widgets** — Standard DOM clicks often fail; use MCP `click`/`fill`.
2. **Time Type resets each Quick Add** — Must switch for each standby entry.
3. **Time format** — 12-hour AM/PM in UI (`12:00 AM`, `11:59 PM`).
4. **No overlap allowed** — Standby and Worked cannot overlap same day.
5. **Prefer `take_snapshot`** — Better than screenshots for targeting elements.
6. **Delete key trick** — click selected Time Type pill, press Delete to open dropdown.

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
