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

## Workflow: Fill Timesheet Entry

If the user asks to fill a timesheet entry, navigate to Time first (follow steps above), then:

1. `take_snapshot` to see the Enter Time grid
2. Look for "This Week" / "Last Week" buttons or "Select Week" and click as needed
3. `take_snapshot` to find the day column
4. `click` the target day cell to open the Enter Time dialog
5. `take_snapshot` to see dialog fields (Time Type, In, Out)
6. Use `fill` to populate Time Type, In time, and Out time
7. `click` the OK button
8. **Never click Submit** -- only fill and save as draft

## Tips

- Always prefer `take_snapshot` over `take_screenshot` for understanding page structure
- Use `includeSnapshot: true` on clicks when you need to see the result immediately
- Workday is slow -- if a snapshot looks empty or unchanged, wait a moment and retry
- Element UIDs change between snapshots; always use UIDs from the **most recent** snapshot
- The Workday date format is `DD/MM/YYYY`
- The config file at `workday.selectors.json` has timeType (`On Call Standby Hours`) and fixedStartTime (`09:00`)
