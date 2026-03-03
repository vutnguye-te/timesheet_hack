import type { Incident, OnCallParams, TimeEntry, WeekGroup } from './types';

// --- Helpers ---

/** Convert 24h "HH:MM" to 12h "H:MM AM/PM" for Workday */
export function to12Hour(time24: string): string {
  var [hStr, m] = time24.split(':');
  var h = parseInt(hStr, 10);
  if (h === 0) return `12:${m} AM`;
  if (h < 12) return `${h}:${m} AM`;
  if (h === 12) return `12:${m} PM`;
  return `${h - 12}:${m} PM`;
}

/** Get the Monday of the week containing the given date */
function getWeekStart(date: Date): Date {
  var d = new Date(date);
  var dow = d.getUTCDay(); // 0=Sun, 1=Mon, ...
  var diff = dow === 0 ? 6 : dow - 1; // days since Monday
  d.setUTCDate(d.getUTCDate() - diff);
  return d;
}

/** Format Date as YYYY-MM-DD */
function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Get 3-letter day name from Date */
function getDayName(date: Date): string {
  return date.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
}

/** Parse YYYY-MM-DD to Date (UTC) */
function parseDate(s: string): Date {
  return new Date(s + 'T00:00:00Z');
}

/** Add N days to a date */
function addDays(date: Date, n: number): Date {
  var d = new Date(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

// --- Per-day entry (intermediate before batching) ---

interface RawEntry {
  date: string;   // YYYY-MM-DD
  type: 'standby' | 'worked';
  inTime: string; // HH:MM 24h
  outTime: string;
}

// --- Core calculator ---

export function calculateEntries(params: OnCallParams): WeekGroup[] {
  var { startDate, endDate, shiftEndTime, incidents } = params;
  var start = parseDate(startDate);
  var end = parseDate(endDate);

  // Build per-day raw entries
  var rawEntries: RawEntry[] = [];
  var current = new Date(start);

  while (current <= end) {
    var dayYmd = formatDate(current);
    var isLastDay = dayYmd === endDate;
    var dayStart = '00:00';
    var dayEnd = isLastDay ? shiftEndTime : '23:59';

    // Find incidents for this day, sorted by start time
    var dayIncidents = incidents
      .filter((inc) => inc.date === dayYmd)
      .sort((a, b) => a.startTime.localeCompare(b.startTime));

    if (dayIncidents.length > 0) {
      var cursor = dayStart;
      for (var inc of dayIncidents) {
        // Pre-incident standby gap
        if (cursor < inc.startTime) {
          rawEntries.push({ date: dayYmd, type: 'standby', inTime: cursor, outTime: inc.startTime });
        }
        // Incident worked hours
        rawEntries.push({ date: dayYmd, type: 'worked', inTime: inc.startTime, outTime: inc.endTime });
        cursor = inc.endTime;
      }
      // Post-incident standby
      if (cursor < dayEnd) {
        rawEntries.push({ date: dayYmd, type: 'standby', inTime: cursor, outTime: dayEnd });
      }
    } else {
      // Full standby day
      rawEntries.push({ date: dayYmd, type: 'standby', inTime: dayStart, outTime: dayEnd });
    }

    current = addDays(current, 1);
  }

  // Group by week and batch consecutive full-standby days
  var weeks: WeekGroup[] = [];
  var currentWeek: WeekGroup | null = null;

  // Track batch of consecutive full-standby days
  var batchDays: string[] = [];
  var batchWeekStart = '';

  function flushBatch() {
    if (batchDays.length === 0 || !currentWeek) return;
    currentWeek.entries.push({
      type: 'standby',
      inTime: to12Hour('00:00'),
      outTime: to12Hour('23:59'),
      days: [...batchDays],
    });
    batchDays = [];
  }

  var i = 0;
  while (i < rawEntries.length) {
    var entry = rawEntries[i];
    var entryDate = parseDate(entry.date);
    var weekStart = formatDate(getWeekStart(entryDate));
    var dayName = getDayName(entryDate);

    // Start new week if needed
    if (!currentWeek || currentWeek.weekStart !== weekStart) {
      flushBatch();
      currentWeek = { weekStart, entries: [] };
      weeks.push(currentWeek);
    }

    // Check if this is a full-standby day (batchable)
    var isFullStandby = false;
    if (entry.type === 'standby' && entry.inTime === '00:00' && entry.outTime === '23:59') {
      // Ensure it's the only entry for this date
      var nextI = i + 1;
      if (nextI >= rawEntries.length || rawEntries[nextI].date !== entry.date) {
        isFullStandby = true;
      }
    }

    if (isFullStandby) {
      // Batch consecutive full-standby days within the same week
      if (batchWeekStart === weekStart && batchDays.length > 0) {
        batchDays.push(dayName);
      } else {
        flushBatch();
        batchWeekStart = weekStart;
        batchDays = [dayName];
      }
      i++;
    } else {
      flushBatch();
      batchWeekStart = weekStart;
      currentWeek.entries.push({
        type: entry.type,
        inTime: to12Hour(entry.inTime),
        outTime: to12Hour(entry.outTime),
        days: [dayName],
      });
      i++;
    }
  }

  flushBatch();
  return weeks;
}

// --- CLI mode ---

function parseIncidentString(s: string): Incident {
  // Format: "YYYY-MM-DD HH:MM-HH:MM"
  var [date, times] = s.split(' ');
  var [startTime, endTime] = times.split('-');
  return { date, startTime, endTime };
}

function main() {
  var args = process.argv.slice(2);

  var startDate = '';
  var endDate = '';
  var shiftEndTime = '';
  var incidents: Incident[] = [];

  for (var j = 0; j < args.length; j++) {
    switch (args[j]) {
      case '--start':
        startDate = args[++j];
        break;
      case '--end':
        endDate = args[++j];
        break;
      case '--shift-end':
        shiftEndTime = args[++j];
        break;
      case '--incident':
        incidents.push(parseIncidentString(args[++j]));
        break;
      default:
        console.error(`Unknown option: ${args[j]}`);
        process.exit(1);
    }
  }

  if (!startDate || !endDate || !shiftEndTime) {
    console.error('Error: --start, --end, and --shift-end are required');
    process.exit(1);
  }

  var weeks = calculateEntries({ startDate, endDate, shiftEndTime, incidents });

  for (var week of weeks) {
    console.log(`# Week: ${week.weekStart}`);
    for (var entry of week.entries) {
      var label = entry.days.length > 1
        ? `${entry.days[0]}-${entry.days[entry.days.length - 1]}`
        : entry.days[0];
      console.log(`${week.weekStart}\t${label}\t${entry.type}\t${entry.inTime}\t${entry.outTime}\t${entry.days.join(',')}`);
    }
  }
}

// Run if executed directly
var isDirectRun = process.argv[1]?.endsWith('oncall-entries.ts') ||
  process.argv[1]?.endsWith('oncall-entries.js');
if (isDirectRun) {
  main();
}
