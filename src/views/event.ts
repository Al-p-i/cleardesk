// The card for a calendar event Claude prepared: what, when, where, and a button per calendar.
import { setIcon } from "obsidian";
import { CalEvent, eventWhen } from "../calendar";

export function renderEventCard(el: HTMLElement, ev: CalEvent, add: { google: () => void; apple?: () => void }) {
  const card = el.createDiv("cd-event");
  const head = card.createDiv("cd-event-head");
  setIcon(head.createSpan("cd-event-icon"), "calendar");
  head.createSpan({ cls: "cd-event-title", text: ev.title });
  card.createDiv({ cls: "cd-event-when", text: eventWhen(ev) + (ev.location ? ` · ${ev.location}` : "") });
  if (ev.notes) card.createDiv({ cls: "cd-event-notes", text: ev.notes });
  const row = card.createDiv("cd-event-actions");
  const button = (label: string, click: () => void) => {
    const b = row.createEl("button", { cls: "cd-event-add", text: label, attr: { type: "button" } });
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      click();
    });
  };
  button("Google Calendar", add.google);
  if (add.apple) button("Apple Calendar", add.apple);
}
