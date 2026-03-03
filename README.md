# Workday On-Call Time Entry Automation

Playwright automation that enters on-call standby and worked hours into Workday via the Quick Add dialog. Handles week navigation, time type switching, overlap detection, and day batching automatically. Takes ~1 minute for a typical week of on-call.

## Prerequisites

- **Node.js** v18+
- **Chrome** (Playwright will install its own Chromium, but system Chrome works for debugging)

## Setup

```bash
git clone git@github.com:vutnguye-te/timesheet_hack.git
cd timesheet_hack
git checkout nga
npm install
npx playwright install chromium
```

Auth is handled automatically — if the session is expired when you run the automation, the browser will prompt for SSO + Duo MFA and continue once login is detected. No separate auth step needed.

## Usage with Claude Code

If you have [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed, copy the skill file for global access:

```bash
mkdir -p ~/.claude/skills/oncall-pw
cp SKILL-playwright.md ~/.claude/skills/oncall-pw/SKILL.md
```

Then use the `/oncall-pw` slash command from any directory:

```
/oncall-pw On call Mar 2-6, shift ends 5pm
/oncall-pw On call Mar 2-6, shift ends 5pm. Paged Mar 4 6am-8am.
```

Claude will preview the calculated entries, ask for confirmation, then run the automation.

## Manual CLI Usage

### Dry-run: preview calculated entries

```bash
npx tsx src/oncall-entries.ts \
  --start 2026-03-02 --end 2026-03-06 --shift-end 17:00
```

With incidents:

```bash
npx tsx src/oncall-entries.ts \
  --start 2026-03-02 --end 2026-03-06 --shift-end 17:00 \
  --incident "2026-03-04 06:00-08:00"
```

### Enter time in Workday

```bash
ONCALL_START=2026-03-02 \
ONCALL_END=2026-03-06 \
ONCALL_SHIFT_END=17:00 \
ONCALL_INCIDENTS="" \
npx playwright test --project=workday
```

## npm Scripts

| Script | Command | Description |
|--------|---------|-------------|
| `oncall:auth` | `npx playwright test --project=auth-setup --headed` | Authenticate with Workday (SSO + Duo MFA) |
| `oncall:enter` | `npx playwright test --project=workday --headed` | Run time entry (requires `ONCALL_*` env vars) |
| `oncall:dry-run` | `npx tsx src/oncall-entries.ts` | Preview entries (pass `--start`, `--end`, `--shift-end`) |

## Architecture

| File | Purpose |
|------|---------|
| `src/types.ts` | TypeScript interfaces for time entries, week groups, incidents |
| `src/oncall-entries.ts` | Core calculator: date range + incidents → batched weekly entries. Also runs as CLI. |
| `src/pages/enter-time.page.ts` | Page Object for Workday's Enter Time / Quick Add UI |
| `src/cdp-helpers.ts` | Chrome DevTools Protocol helpers for GWT widget interactions |
| `src/debug-quickadd.ts` | Debug script: opens Quick Add dialog and keeps browser alive for inspection |
| `tests/auth.setup.ts` | Playwright setup project for SSO authentication |
| `tests/enter-oncall-time.spec.ts` | Main test: parses env vars, calculates entries, drives Workday UI |
| `playwright.config.ts` | Playwright config: projects (auth-setup, workday), browser settings |

## Troubleshooting

### Auth expired
Auth is handled inline — when the session is expired, the browser will redirect to SSO and wait for you to complete Duo MFA. The automation continues automatically after login. You can also run `npm run oncall:auth` separately if you prefer to pre-authenticate.

### Overlapping entries
The automation detects overlaps and skips entries that already exist. You'll see "Skipping: entries already exist (overlap detected)" in the output. This is safe — it means those hours were already entered.

### Selector timeouts
If a non-auth selector times out, the browser stays alive on port 9222 (when `KEEP_BROWSER_ON_FAILURE=1`). You can connect Chrome DevTools or use Chrome DevTools MCP to inspect the page state.

### Wrong week or entries
Run the dry-run calculator first to verify the entries look correct before submitting:
```bash
npm run oncall:dry-run -- --start 2026-03-02 --end 2026-03-06 --shift-end 17:00
```
