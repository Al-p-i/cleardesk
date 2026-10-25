import { test } from "node:test";
import assert from "node:assert/strict";
import { eventBlock, eventFromInput, eventText, eventWhen, googleCalendarUrl, icsFile, parseEvent, type CalEvent } from "../src/calendar.ts";
import { blocksAsText } from "../src/map.ts";

const ok = (input: Record<string, string>): CalEvent => {
  const ev = eventFromInput(input);
  if ("error" in ev) throw new Error(ev.error);
  return ev;
};

test("events from the tool: timed, default hour, all-day, multi-day, and mistakes", () => {
  assert.deepEqual(ok({ title: "Viewing", date: "2026-10-30", start_time: "18:00", end_time: "19:30", location: "Oranienstr. 12" }),
    { title: "Viewing", start: "2026-10-30T18:00", end: "2026-10-30T19:30", location: "Oranienstr. 12" });
  assert.equal(ok({ title: "Call", date: "2026-10-30", start_time: "09:15" }).end, "2026-10-30T10:15", "an hour by default");
  assert.equal(ok({ title: "Late", date: "2026-10-30", start_time: "23:30" }).end, "2026-10-31T00:30", "an hour past 23:30 is the next day");
  assert.deepEqual(ok({ title: "Camp", date: "2026-11-22", end_date: "2026-11-28" }), { title: "Camp", start: "2026-11-22", end: "2026-11-28" });
  assert.deepEqual(ok({ title: "Trip", date: "2026-10-30", end_date: "2026-10-31", start_time: "22:00", end_time: "02:00" }),
    { title: "Trip", start: "2026-10-30T22:00", end: "2026-10-31T02:00" });
  const err = (input: Record<string, string>) => (eventFromInput(input) as { error: string }).error;
  assert.match(err({ title: "", date: "2026-10-30" }), /title/);
  assert.match(err({ title: "x", date: "30/10/2026" }), /YYYY-MM-DD/);
  assert.match(err({ title: "x", date: "2026-02-30" }), /YYYY-MM-DD/, "no such day");
  assert.match(err({ title: "x", date: "2026-10-30", start_time: "6pm" }), /HH:MM/);
  assert.match(err({ title: "x", date: "2026-10-30", start_time: "18:00", end_time: "17:00" }), /ends before/);
});

test("how events read in the card, in Claude's history and in copy", () => {
  const ev = ok({ title: "Viewing", date: "2026-10-30", start_time: "18:00", end_time: "19:00", location: "Oranienstr. 12" });
  assert.equal(eventWhen(ev, 2026), "Fri 30 Oct · 18:00–19:00");
  assert.equal(eventWhen(ok({ title: "Camp", date: "2026-11-22", end_date: "2026-11-28" }), 2026), "Sun 22 Nov – Sat 28 Nov");
  assert.equal(eventWhen(ok({ title: "NY", date: "2027-01-01" }), 2026), "Fri 1 Jan 2027", "the year when it isn't this year");
  assert.equal(eventText(ev, 2026), "Calendar event: Viewing · Fri 30 Oct · 18:00–19:00 · Oranienstr. 12");
  const block = eventBlock(ev);
  assert.deepEqual(parseEvent(block.split("\n")[1]), ev);
  assert.match(blocksAsText(`Booked.\n\n${block}`), /^Booked\.\n\n\[Calendar event: Viewing · Fri 30 Oct/);
});

test("Google Calendar link: local times with the time zone, all-day end is exclusive", () => {
  const timed = new URL(googleCalendarUrl(ok({ title: "Viewing & keys", date: "2026-10-30", start_time: "18:00", location: "Oranienstr. 12" }), "Europe/Berlin"));
  assert.equal(timed.origin + timed.pathname, "https://calendar.google.com/calendar/render");
  assert.equal(timed.searchParams.get("action"), "TEMPLATE");
  assert.equal(timed.searchParams.get("text"), "Viewing & keys");
  assert.equal(timed.searchParams.get("dates"), "20261030T180000/20261030T190000");
  assert.equal(timed.searchParams.get("ctz"), "Europe/Berlin");
  assert.equal(timed.searchParams.get("location"), "Oranienstr. 12");
  const allDay = new URL(googleCalendarUrl(ok({ title: "Camp", date: "2026-11-22", end_date: "2026-11-28" }), "Europe/Berlin"));
  assert.equal(allDay.searchParams.get("dates"), "20261122/20261129");
  assert.equal(allDay.searchParams.get("ctz"), null);
});

test(".ics for Apple Calendar: valid lines, escaping, folding, all-day dates", () => {
  const ev = ok({ title: "Viewing; bring ID, payslips", date: "2026-10-30", start_time: "18:00", notes: "Ring twice\nThird floor " + "x".repeat(80) });
  const ics = icsFile(ev, "e-abc", new Date(Date.UTC(2026, 9, 25, 12, 0, 0)));
  const lines = ics.split("\r\n");
  assert.equal(lines[0], "BEGIN:VCALENDAR");
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
  assert.ok(lines.includes("UID:e-abc@cleardesk"));
  assert.ok(lines.includes("DTSTAMP:20261025T120000Z"));
  assert.ok(lines.includes("DTSTART:20261030T180000") && lines.includes("DTEND:20261030T190000"), "floating local times");
  assert.ok(lines.includes("SUMMARY:Viewing\\; bring ID\\, payslips"));
  assert.ok(lines.every((l) => new TextEncoder().encode(l).length <= 75), "folded at 75 octets");
  assert.match(ics.replace(/\r\n /g, ""), /DESCRIPTION:Ring twice\\nThird floor x{80}/, "unfolds back to the text");
  const camp = icsFile(ok({ title: "Camp", date: "2026-11-22", end_date: "2026-11-28" }), "e-1").split("\r\n");
  assert.ok(camp.includes("DTSTART;VALUE=DATE:20261122") && camp.includes("DTEND;VALUE=DATE:20261129"));
});
