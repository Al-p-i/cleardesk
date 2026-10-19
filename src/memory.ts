// What the AI sees of a project's notes, facts and links: pinned and recent
// items always, everything else on demand through search_notes.
// Pure functions, so they can be unit-tested.

import { Entry, matchesAll, queryWords } from "./format";

export const RECENT_NOTES = 30;

export interface NotesContext {
  /** pinned first, then the most recent, oldest first within each group */
  shown: Entry[];
  /** how many current (not replaced) items are left out */
  older: number;
  /** topic tags of all current items with counts, most used first */
  tags: [string, number][];
}

const current = (entries: Entry[]) => entries.filter((e) => !e.meta["replaced-by"]);
const byTime = (a: Entry, b: Entry) => a.datetime.localeCompare(b.datetime);

export function notesContext(entries: Entry[], recent = RECENT_NOTES): NotesContext {
  const live = current(entries);
  const pinned = live.filter((e) => e.meta.pinned === "true").sort(byTime);
  const rest = live.filter((e) => e.meta.pinned !== "true").sort(byTime);
  const latest = rest.slice(-recent);
  const counts = new Map<string, number>();
  for (const e of live) if (e.tag) counts.set(e.tag, (counts.get(e.tag) ?? 0) + 1);
  return {
    shown: [...pinned, ...latest],
    older: rest.length - latest.length,
    tags: [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  };
}

/** One line per item, as the model sees it. */
export function noteLine(e: Entry): string {
  const tag = e.tag ? ` #${e.tag.replace(/\s+/g, "-")}` : "";
  const flags = [e.meta.pinned === "true" ? "pinned" : "", e.meta["replaced-by"] ? `replaced by ${e.meta["replaced-by"]}` : ""]
    .filter(Boolean)
    .join(", ");
  return `[${e.id}] ${e.datetime} ${e.kind}${flags ? ` (${flags})` : ""}${tag}: ${e.body.slice(0, 1500)}${e.meta.url ? ` <${e.meta.url}>` : ""}`;
}

/**
 * Search notes, facts and links: all words must appear (in the text, tag or
 * URL). Tag and kind narrow it down; an empty query lists that tag or kind.
 * Replaced facts are included (marked) so questions about history work.
 */
export function searchNotes(entries: Entry[], query: string, tag = "", kind = "", limit = 40): Entry[] {
  const words = queryWords(query);
  const t = tag.trim().toLowerCase().replace(/^#/, "").replace(/-/g, " ");
  const k = kind.trim().toLowerCase();
  return entries
    .filter((e) => !k || e.kind === k)
    .filter((e) => !t || e.tag.toLowerCase() === t)
    .filter((e) => !words.length || matchesAll(`${e.body} ${e.tag} ${e.meta.url ?? ""}`, words))
    .filter((e) => words.length || t || k) // never "everything"
    .sort((a, b) => b.datetime.localeCompare(a.datetime))
    .slice(0, limit);
}

/** Same statement, ignoring case, punctuation and spacing. */
export function sameStatement(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return norm(a) === norm(b);
}
