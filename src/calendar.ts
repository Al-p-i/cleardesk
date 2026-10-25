// Calendar events Claude prepares for you to add with one click: a card in the chat with a
// Google Calendar link and an .ics file for Apple Calendar. Nothing is sent until you click.
// Times are local ("floating"), so 18:00 means 18:00 wherever your calendar is.
//
//   ```cleardesk-event
//   {"title":"Viewing","start":"2026-10-30T18:00","end":"2026-10-30T19:00","location":"Oranienstr. 12"}
//   ```

export const EVENT_BLOCK = "cleardesk-event";

export interface CalEvent {
  title: string;
  /** YYYY-MM-DD for all-day events, YYYY-MM-DDTHH:MM otherwise */
  start: string;
  /** all-day: the last day (inclusive); timed: the end time */
  end: string;
  location?: string;
  notes?: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export const isAllDay = (e: CalEvent) => DATE.test(e.start);

/** From the tool's input to an event, or a message saying what's wrong. */
export function eventFromInput(input: Record<string, unknown>): CalEvent | { error: string } {
  const s = (k: string) => String(input[k] ?? "").trim();
  const title = s("title");
  const date = s("date");
  const endDate = s("end_date") || date;
  const startTime = s("start_time");
  const endTime = s("end_time");
  if (!title) return { error: "Give the event a title." };
  if (!DATE.test(date) || !DATE.test(endDate) || !validDate(date) || !validDate(endDate)) return { error: "Dates must be YYYY-MM-DD." };
  if (startTime && !TIME.test(startTime)) return { error: "start_time must be HH:MM (24-hour), or empty for an all-day event." };
  if (endTime && !TIME.test(endTime)) return { error: "end_time must be HH:MM (24-hour), or empty." };
  if (!startTime && endTime) return { error: "An event with an end_time needs a start_time." };
  const ev: CalEvent = { title: title.slice(0, 200), start: date, end: endDate };
  if (startTime) {
    ev.start = `${date}T${startTime}`;
    if (endTime) ev.end = `${endDate}T${endTime}`;
    else if (endDate !== date) ev.end = `${endDate}T${startTime}`;
    else {
      // An hour later; after 23:00 that's on the next day.
      const h = Number(startTime.slice(0, 2)) + 1;
      ev.end = `${h === 24 ? nextDay(date) : date}T${String(h % 24).padStart(2, "0")}${startTime.slice(2)}`;
    }
  }
  if (ev.end < ev.start) return { error: "The event ends before it starts." };
  if (s("location")) ev.location = s("location").slice(0, 300);
  if (s("notes")) ev.notes = s("notes").slice(0, 2000);
  return ev;
}

function validDate(d: string): boolean {
  const [y, m, day] = d.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === day;
}

function nextDay(d: string): string {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day + 1)).toISOString().slice(0, 10);
}

export function eventBlock(ev: CalEvent): string {
  return "```" + EVENT_BLOCK + "\n" + JSON.stringify(ev) + "\n```";
}

export function parseEvent(src: string): CalEvent | null {
  try {
    const o = JSON.parse(src);
    if (!o || typeof o.title !== "string" || typeof o.start !== "string" || typeof o.end !== "string") return null;
    return o as CalEvent;
  } catch {
    return null;
  }
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayLabel(d: string, thisYear: number): string {
  const [y, m, day] = d.split("-").map(Number);
  const wd = DAYS[new Date(Date.UTC(y, m - 1, day)).getUTCDay()];
  return `${wd} ${day} ${MONTHS[m - 1]}${y === thisYear ? "" : ` ${y}`}`;
}

/** "Thu 30 Oct · 18:00–19:00", "Sat 22 – Fri 28 Nov", "Thu 30 Oct, 22:00 – Fri 31 Oct, 02:00". */
export function eventWhen(ev: CalEvent, thisYear = new Date().getFullYear()): string {
  const [sd, st] = ev.start.split("T");
  const [ed, et] = ev.end.split("T");
  if (!st) return sd === ed ? dayLabel(sd, thisYear) : `${dayLabel(sd, thisYear)} – ${dayLabel(ed, thisYear)}`;
  if (sd === ed) return `${dayLabel(sd, thisYear)} · ${st}–${et}`;
  return `${dayLabel(sd, thisYear)}, ${st} – ${dayLabel(ed, thisYear)}, ${et}`;
}

/** The event in one line: what Claude sees in the history, and what copy gives. */
export function eventText(ev: CalEvent, thisYear?: number): string {
  return `Calendar event: ${ev.title} · ${eventWhen(ev, thisYear)}${ev.location ? ` · ${ev.location}` : ""}`;
}

const compact = (s: string) => s.replace(/[-:]/g, "");

/** Opens Google Calendar with the event filled in; the owner clicks Save. */
export function googleCalendarUrl(ev: CalEvent, timeZone: string): string {
  const dates = isAllDay(ev)
    ? `${compact(ev.start)}/${compact(nextDay(ev.end))}` // Google's end date is exclusive
    : `${compact(ev.start)}00/${compact(ev.end)}00`;
  const q = new URLSearchParams({ action: "TEMPLATE", text: ev.title, dates });
  if (!isAllDay(ev) && timeZone) q.set("ctz", timeZone);
  if (ev.location) q.set("location", ev.location);
  if (ev.notes) q.set("details", ev.notes);
  return `https://calendar.google.com/calendar/render?${q}`;
}

const icsText = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** Lines longer than 75 octets continue on the next line after a space (RFC 5545). */
function fold(line: string): string {
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (bytes + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = "";
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

/** A one-event .ics file for Apple Calendar (or anything else that reads iCalendar). */
export function icsFile(ev: CalEvent, uid: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const when = isAllDay(ev)
    ? [`DTSTART;VALUE=DATE:${compact(ev.start)}`, `DTEND;VALUE=DATE:${compact(nextDay(ev.end))}`]
    : [`DTSTART:${compact(ev.start)}00`, `DTEND:${compact(ev.end)}00`];
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ClearDesk//Obsidian//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}@cleardesk`,
    `DTSTAMP:${stamp}`,
    ...when,
    `SUMMARY:${icsText(ev.title)}`,
    ...(ev.location ? [`LOCATION:${icsText(ev.location)}`] : []),
    ...(ev.notes ? [`DESCRIPTION:${icsText(ev.notes)}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}
