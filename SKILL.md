---
name: workday-navigation
description: Navigate Cisco Workday via Chrome DevTools MCP and populate Time entries from PagerDuty on-call coverage. Use when the user asks to open Workday, navigate to Workday sections (Directory, Time, Absence, Pay), or fill weekly/monthly timesheets from PagerDuty data.
---

# Workday Navigation via Chrome DevTools MCP

Control a Chrome browser to open and navigate Cisco Workday using the Chrome DevTools MCP server.

## Workflow: Open Workday and Navigate

### Step 1: Launch Chrome and connect

First, call `list_pages`. If no browser is connected, launch Chrome with remote debugging:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 &
```

If a Workday tab already exists (URL contains `myworkday.com` or `workday.cisco.com`), select it and continue.

### Step 2: Navigate to Workday

Call `navigate_page` with `url: "https://workday.cisco.com/"`.

If redirected to Duo SSO (`sso.duosecurity.com`), stop and ask the user to complete login. After confirmation, verify with `take_snapshot` that the page is Workday Home.

### Step 3: Navigate via Menu

1. `take_snapshot`
2. Click `button "MENU"`
3. Click destination link

Known labels:
- `Directory`
- `Time`
- `Absence`
- `Pay`
- `Personal Information`

### Step 4: Confirm page

Call `take_snapshot` and confirm heading/title matches the requested destination.

## Workflow: Compute PagerDuty Worked Time for a Month

Use this when filling Workday time from PagerDuty on-call coverage.

### Step 1: Confirm target month

If not explicit, ask for month (`February 2026`, etc.).

### Step 2: Get PagerDuty user id

Call `mcp__pagerduty__get_user_data` and capture `id`.

### Step 3: Query on-call coverage

Use UTC month boundaries:
- `since = YYYY-MM-01T00:00:00Z`
- `until = first day of next month at 00:00:00Z`

Call `mcp__pagerduty__list_oncalls` with `query_model` as a JSON string:

```json
"{\"since\":\"YYYY-MM-01T00:00:00Z\",\"until\":\"YYYY-MM-01T00:00:00Z\",\"user_ids\":[\"<USER_ID>\"],\"limit\":100}"
```

Ignore rows missing `start` or `end`.

### Step 4: Compute per-day hours

Split each interval by local calendar day and compute covered hours/day.

Output map:
- `YYYY-MM-DD -> hours`

Skip zero-hour days.

## Workflow: Fill Timesheet from PagerDuty Month

### Step 1: Open Time

Navigate to **Time**.

### Step 2: Open needed week(s)

Use **Select Week**, **Previous Week**, or **Next Week** to reach each week containing non-zero days.

### Step 3: Preferred entry method: Actions -> Quick Add

Prefer Quick Add over clicking day cells.

1. Click `Actions` -> `Quick Add`
2. Set `Time Type` to `On Call Standby Hours`
3. Click `Next`
4. Enter time blocks and select relevant day checkboxes
5. Click `OK`

If In/Out fields are shown:
- Full day: `00:00` to `23:59`
- Partial day `H` hours: `00:00` to `HH:MM`

Examples:
- `7h` -> `00:00-07:00`
- `17h` -> `00:00-17:00`

### Step 4: Validate each week

Use `take_snapshot` and verify:
- Day rows show expected `Hours: X`
- Summary `On Call Standby (Hours)` equals expected weekly total
- Entries show `Not Submitted`

Never submit automatically.

## Recovery Playbook (Observed in Real Run)

Use these when Workday behaves inconsistently.

### A) `Invalid response` browser alert after clicking Next

- Call `handle_dialog` with `action: "accept"`
- Re-snapshot and continue

### B) `Discard Changes?` modal appears unexpectedly

- Click `Continue` when keeping in-progress edits
- Click `Discard` only when intentionally restarting the current Quick Add flow

### C) Quick Add stuck with `Next`/`Cancel` disabled

- Re-focus `Time Type`, press `Enter` to confirm selected value
- Re-check for transient `Discard Changes?` modal and close it
- If still stuck, close Quick Add and reopen from `Actions -> Quick Add`

### D) Action click timeout or stale UIDs

- Take a fresh snapshot and retry with current UIDs
- Keep waits short and retry in small steps (prefer <=5s waits with re-check)

## Tips

- Prefer `take_snapshot` over screenshots
- Workday is slow and dynamic; re-snapshot frequently
- UIDs change often; only use UIDs from the latest snapshot
- Workday date format is `DD/MM/YYYY`
- Save as draft only; do not click submit unless the user explicitly asks
