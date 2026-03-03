export interface TimeEntry {
  type: 'standby' | 'worked';
  inTime: string;  // 12h format: "12:00 AM"
  outTime: string; // 12h format: "11:59 PM"
  days: string[];  // ["Mon", "Tue", ...]
}

export interface WeekGroup {
  weekStart: string; // YYYY-MM-DD (Monday)
  entries: TimeEntry[];
}

export interface Incident {
  date: string;      // YYYY-MM-DD
  startTime: string; // HH:MM (24h)
  endTime: string;   // HH:MM (24h)
}

export interface OnCallParams {
  startDate: string;  // YYYY-MM-DD
  endDate: string;    // YYYY-MM-DD
  shiftEndTime: string; // HH:MM (24h) — end time on last day
  incidents: Incident[];
}
