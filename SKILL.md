---
name: workday-api-timesheet
description: Fill Cisco Workday timesheets by calling Workday endpoints directly from an authenticated Chrome session (no UI field typing). Use when the user asks for fastest timesheet population, API-first entry, or to avoid slow/repetitive Workday UI interactions.
---

# Workday API Timesheet Fill

Use Chrome DevTools page-context `fetch` calls to submit Quick Add blocks directly through Workday endpoints.

## Workflow: Build Month Plan

### Step 1: Compute expected blocks from PagerDuty

- Query PagerDuty on-call coverage for the target month.
- Split intervals by local day and compute daily hours.
- Group by week into block entries:
  - Full day: `00:00-23:59`
  - Partial day: `00:00-HH:MM`

### Step 2: Define target block structure

Use weekday numbers aligned with Workday:
- `1=Mon ... 7=Sun`

Example:
- `[{in:"00:00", out:"23:59", days:[6,7]}, {in:"00:00", out:"07:00", days:[5]}]`

## Workflow: Capture Dynamic Flow Values

### Step 1: Open a fresh Quick Add flow for target week

Call week-specific `rel-task/2997$4817.htmld` endpoint in authenticated session.

### Step 2: Extract dynamic values from response

From JSON response payload, capture:
- `_flowExecutionKey` (example: `e41s1`)
- `Next` ref (example: `1047/wd:Next`)
- Submit container id for Next (prefix from `Start_Date` ref, example: `1047`)
- `In_Time` ref (example: `476/wd:In_Time`)
- `Out_Time` ref (example: `476/wd:Out_Time`)
- `OK` ref (example: `591/wd:OK`)
- Weekday refs prefix (example: `591/wd:Weekday_1` ... `591/wd:Weekday_7`)

From `window.workday`, capture:
- `sessionSecureToken`
- `clientVersion` (for `x-workday-client`)

Never reuse flow values across different flow instances.

## Workflow: Submit One Block via API

Use `POST /cisco/flowController.htmld` with form-urlencoded body.

### Step 1: Select time type

- `_eventId_add=<timeTypeId>` (usually `604`)
- set `2396$6` for `On Call Standby Hours`

### Step 2: Transition to detail step

- `_eventId_submit=<nextSubmitId>`
- `change-summary` containing `wd:Next Ref="<nextRef>"`

### Step 3: Set time bounds

- `_eventId_validate=<inRef>` with `<inRef>_H/_m/_Y/_M/_D`
- `_eventId_validate=<outRef>` with `<outRef>_H/_m/_Y/_M/_D`

### Step 4: Select weekdays

For each target day:
- `_eventId_validate=<weekdayRef>`
- `<weekdayRef>=1`

### Step 5: Commit block

- `_eventId_submit=<okSubmitId>` (prefix from `okRef`, example: `591`)
- `change-summary` containing `wd:OK Ref="<okRef>"`

## Idempotency and Recovery

- Prefer reading current week summary before writes; skip if already matching expected totals.
- Retry a failed API call once.
- If any step fails twice, discard flow and open a new flow for that same week.
- Do not continue a partially failed flow.

## Verification Policy

- Default: verify once per week after all blocks are submitted.
- Fast mode: skip UI verification when user explicitly asks.

## Safety

- Save draft only; never submit timesheet unless explicitly requested.
- Keep `credentials: "include"` in page-context fetch calls.
- Always generate a fresh `clientRequestID` for each API request.
