---
name: workday-navigation
description: Navigate Cisco Workday via Chrome DevTools MCP. Use when the user asks to open Workday, navigate to a Workday section (Directory, Time, Absence, Pay, etc.), or interact with the Workday UI in Chrome.
---

# Workday Navigation via Chrome DevTools MCP

Control a Chrome browser to open and navigate Cisco Workday using the `user-chrome-devtools` MCP server.

## Workflow: Open Workday and Navigate

### Step 1: Launch Chrome and connect

First, try calling `list_pages`. If it returns an error or indicates no browser is connected, launch Chrome with remote debugging via the Shell tool:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 &
```

Run this in the background (`block_until_ms: 0`), wait a couple of seconds, then call `list_pages` again to confirm the connection.

If a Workday tab already exists (URL contains `myworkday.com` or `workday.cisco.com`), use `select_page` to focus it and skip to Step 3.

### Step 2: Navigate to Workday

Call `navigate_page` with `type: "url"` and `url: "https://workday.cisco.com/"`.

The page will redirect to Duo SSO (`sso.duosecurity.com`). **Stop and tell the user to complete SSO login**, then wait for them to confirm.

After the user confirms login, call `take_snapshot` to verify the page title contains "Home - Workday" or similar. If still on SSO, ask the user to try again.

### Step 3: Navigate via Menu

Call `take_snapshot` to get the current page state.

If the user requested a specific destination, open the menu and click the matching link:

1. Call `click` on the **MENU** button (look for `button "MENU"` in the snapshot)
2. Call `take_snapshot` (with `includeSnapshot: true` on the click, or separately) to see the menu items
3. Find and `click` the requested destination link

#### Known menu structure (under "Personal" section)

| Destination | Menu label |
|-------------|-----------|
| Directory | `link "Directory"` under Organization |
| Time / Timesheet | `link "Time"` under Personal |
| Absence | `link "Absence"` under Personal |
| Pay | `link "Pay"` under Personal |
| Personal Info | `link "Personal Information"` under Personal |

### Step 4: Confirm navigation

After clicking a menu item, call `take_snapshot` to verify the page loaded correctly. Report the page heading back to the user.

## Workflow: Fill Timesheet Entry (Automatic Quick Add)

If the user asks to fill a timesheet entry, navigate to Time first (follow steps above), then use **Quick Add** as the default path:

1. `take_snapshot` on the Time page
2. If you are on the summary page with links (`This Week` / `Last Week`), click `This Week` to open the weekly Enter Time calendar
3. Click `Actions` and choose `Quick Add`
4. In Quick Add step 1, set `Time Type` and click `Next`
5. In Quick Add step 2, fill `In` and `Out`, then check the target day checkbox
6. Click `OK` to save as draft
7. Wait for `Quick Add Complete`, then `take_snapshot` and verify the new entry is present with `Not Submitted`
8. **Never click Submit** -- only fill and save as draft

### Automatic defaults when user says "yes/do it"

If the user does not provide date/time details, proceed automatically with these defaults:

- Time Type: `On Call Standby Hours` (or `timeType` from config)
- Start (`In`): `09:00` (or `fixedStartTime` from config)
- End (`Out`): start + 8 hours (for `09:00`, use `17:00`)
- Date: today in the user's current week view
- Day selection: choose the weekday checkbox for today's date (localized labels are fine, e.g. `terça-feira` for Tuesday)

When possible, read defaults from `pd-workday-ui-sync/workday.selectors.json` first; fall back to the values above if missing.

If today's entry already exists with the same type/time range, do not add a duplicate; report it back to the user.

## Tips

- Always prefer `take_snapshot` over `take_screenshot` for understanding page structure
- Use `includeSnapshot: true` on clicks when you need to see the result immediately
- Workday is slow -- if a snapshot looks empty or unchanged, wait a moment and retry
- Element UIDs change between snapshots; always use UIDs from the **most recent** snapshot
- Quick Add is more reliable than clicking day cells directly when the calendar grid is hard to target
- Weekly labels may be localized (example: Portuguese `segunda-feira`, `terça-feira`, etc.)
