// What the AI sees of a project's notes, facts and links: pinned and recent
// items always, everything else on demand through search_notes.
// Pure functions, so they can be unit-tested.

import { Entry, feedOrder, matchesAll, queryWords } from "./format";
import { blocksAsText } from "./map";

/** How many unpinned items Claude sees; the panel draws its line after them. */
export const CONTEXT_ITEMS = 30;

interface NotesContext {
  /** pinned first, then the top of the panel's feed, in the panel's order */
  shown: Entry[];
  /** how many current (not replaced) items are left out */
  older: number;
  /** topic tags of all current items with counts, most used first */
  tags: [string, number][];
}

const current = (entries: Entry[]) => entries.filter((e) => !e.meta["replaced-by"]);

/**
 * What Claude sees of the notes feed: everything pinned, then the first items of the feed
 * in the owner's order (newest first unless reordered), regardless of kind. Replaced facts
 * never count. The panel draws a line where this ends, so it shows exactly what Claude knows.
 */
export function notesContext(entries: Entry[], recent = CONTEXT_ITEMS): NotesContext {
  const live = feedOrder(current(entries));
  const pinned = live.filter((e) => e.meta.pinned === "true");
  const rest = live.filter((e) => e.meta.pinned !== "true");
  const counts = new Map<string, number>();
  for (const e of live) if (e.tag) counts.set(e.tag, (counts.get(e.tag) ?? 0) + 1);
  return {
    shown: [...pinned, ...rest.slice(0, recent)],
    older: Math.max(rest.length - recent, 0),
    tags: [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  };
}

/**
 * How many of the latest chat entries go to Claude: at least `keep`, and the window's start
 * moves in steps of `step`, so the same earlier messages stay put (and cached) for a while.
 */
export function historySize(total: number, keep = 40, step = 20): number {
  return total <= keep ? total : keep + ((total - keep) % step);
}

const cut = (text: string, max: number) => (text.length > max ? text.slice(0, max).trimEnd() + " …(cut)" : text);

/** Past this many pinned items the panel suggests unpinning: all of them go with every message. */
export const MANY_PINS = 15;

/** One line per item, as the model sees it; long bodies are cut at `max` characters. */
export function noteLine(e: Entry, max = 1500): string {
  const tag = e.tag ? ` #${e.tag.replace(/\s+/g, "-")}` : "";
  const flags = [e.meta.pinned === "true" ? "pinned" : "", e.meta["replaced-by"] ? `replaced by ${e.meta["replaced-by"]}` : ""]
    .filter(Boolean)
    .join(", ");
  return `[${e.id}] ${e.datetime} ${e.kind}${flags ? ` (${flags})` : ""}${tag}: ${cut(blocksAsText(e.body), max)}${e.meta.url ? ` <${e.meta.url}>` : ""}`;
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
  if (!words.length && !t && !k) return []; // never "everything"
  return entries
    .filter((e) => !k || e.kind === k)
    .filter((e) => !t || e.tag.toLowerCase() === t)
    .filter((e) => !words.length || matchesAll(`${e.body} ${e.tag} ${e.meta.url ?? ""}`, words))
    .sort((a, b) => b.datetime.localeCompare(a.datetime))
    .slice(0, limit);
}

/** Same statement, ignoring case, punctuation and spacing. */
export function sameStatement(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return norm(a) === norm(b);
}

/**
 * A short overview of the project's files for the AI: top-level folders with
 * how many files they hold, plus loose top-level files. The AI lists details
 * with list_files when it needs them.
 */
export function filesSummary(relPaths: string[], maxLoose = 20): string[] {
  const folders = new Map<string, number>();
  const loose: string[] = [];
  for (const p of relPaths) {
    const i = p.indexOf("/");
    if (i === -1) loose.push(p);
    else folders.set(p.slice(0, i), (folders.get(p.slice(0, i)) ?? 0) + 1);
  }
  const lines = [...folders.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([f, n]) => `- ${f}/ (${n} file${n === 1 ? "" : "s"})`);
  lines.push(...loose.sort().slice(0, maxLoose).map((f) => `- ${f}`));
  if (loose.length > maxLoose) lines.push(`- …and ${loose.length - maxLoose} more files`);
  return lines;
}
