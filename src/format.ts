// Plain-text formats for everything ClearDesk stores in the vault.
// Pure functions only (no Obsidian imports) so they can be unit-tested.

// ---------- ids and dates ----------

export function newId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function isoDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function isoDateTime(d: Date = new Date()): string {
  return `${isoDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function monthKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/** Whole days from `today` to `date` (both YYYY-MM-DD). Negative = in the past. */
export function daysUntil(date: string, today: string = isoDate()): number {
  const a = Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10));
  const b = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10));
  return Math.round((b - a) / 86400000);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Short label for a due date: "-2d", "today", "tmrw", "Fri", "Oct 24". */
export function dueLabel(date: string, today: string = isoDate()): string {
  const n = daysUntil(date, today);
  if (n < 0) return `${n}d`;
  if (n === 0) return "today";
  if (n === 1) return "tmrw";
  const d = new Date(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10));
  if (n < 7) return WEEKDAYS[d.getDay()];
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** "today 14:32", "Oct 12", "Oct 12 2025" for entry timestamps. */
export function whenLabel(datetime: string, today: string = isoDate()): string {
  const date = datetime.slice(0, 10);
  if (date === today) return `today ${datetime.slice(11, 16)}`;
  const d = new Date(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10));
  const label = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return date.slice(0, 4) === today.slice(0, 4) ? label : `${label} ${date.slice(0, 4)}`;
}

/** "Sat, Oct 17 2026, 14:32" for a YYYY-MM-DD HH:MM timestamp. */
export function fullDateLabel(datetime: string): string {
  const d = new Date(+datetime.slice(0, 4), +datetime.slice(5, 7) - 1, +datetime.slice(8, 10));
  return `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}, ${datetime.slice(11, 16)}`;
}

/** How long ago, compact: "now", "5m", "3h", "yesterday", "Mon", "Oct 12", "Oct 12 2025". */
export function agoLabel(ms: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ms);
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  const d = new Date(ms), n = new Date(now);
  const cal = daysUntil(isoDate(n), isoDate(d)); // calendar days since
  if (cal === 0) return `${Math.floor(diff / 3_600_000)}h`;
  if (cal === 1) return "yesterday";
  if (cal < 7) return WEEKDAYS[d.getDay()];
  const label = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === n.getFullYear() ? label : `${label} ${d.getFullYear()}`;
}

/** "Updated 3h ago", "Updated yesterday", "Updated Oct 12". */
export function updatedLabel(ms: number, now: number = Date.now()): string {
  const a = agoLabel(ms, now);
  if (a === "now") return "Updated just now";
  if (/^\d+[mh]$/.test(a)) return `Updated ${a} ago`;
  return a === "yesterday" ? "Updated yesterday" : `Updated ${a}`;
}

// ---------- entries (chat log, notes, facts) ----------
//
// ### 2026-10-17 14:32 · note · Mitte ^n-k3j2a
// free text, as typed
// source:: [[APARTMENTS/_project/chat/2026-10#^m-abc123|chat]]

export interface Entry {
  id: string;
  datetime: string; // YYYY-MM-DD HH:MM
  kind: string; // chat: me | ai | receipt; notes: note | fact
  tag: string;
  body: string;
  meta: Record<string, string>;
}

const HEADING = /^### (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) · ([a-z]+)(?: · (.*?))? \^([a-z]+-[a-z0-9]+)\s*$/;
const META = /^(source|replaced-by|decision|url|pinned):: (.*)$/;

export function parseEntries(text: string): Entry[] {
  const entries: Entry[] = [];
  let cur: Entry | null = null;
  let lines: string[] = [];
  const flush = () => {
    if (!cur) return;
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    while (lines.length) {
      const m = META.exec(lines[lines.length - 1]);
      if (!m) break;
      cur.meta[m[1]] = m[2];
      lines.pop();
    }
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    cur.body = lines.join("\n");
    entries.push(cur);
  };
  for (const line of text.split("\n")) {
    const m = HEADING.exec(line);
    if (m) {
      flush();
      cur = { datetime: m[1], kind: m[2], tag: (m[3] ?? "").trim(), id: m[4], body: "", meta: {} };
      lines = [];
    } else if (cur) {
      lines.push(line);
    }
  }
  flush();
  return entries;
}

export function serializeEntry(e: Entry): string {
  const tag = e.tag.replace(/[\^\n]/g, " ").trim();
  const head = `### ${e.datetime} · ${e.kind}${tag ? ` · ${tag}` : ""} ^${e.id}`;
  const meta = Object.entries(e.meta)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}:: ${v}`);
  return [head, e.body, ...meta].join("\n") + "\n\n";
}

/** Text before the first entry heading (e.g. a title line). */
function preamble(text: string): string {
  const lines = text.split("\n");
  const i = lines.findIndex((l) => HEADING.test(l));
  return i === -1 ? text : lines.slice(0, i).join("\n");
}

export function serializeEntries(entries: Entry[], previousText = ""): string {
  let head = preamble(previousText).replace(/\s+$/, "");
  head = head ? head + "\n\n" : "";
  return head + entries.map(serializeEntry).join("");
}

export function appendEntry(text: string, e: Entry): string {
  const base = text.replace(/\s+$/, "");
  return (base ? base + "\n\n" : "") + serializeEntry(e);
}

export function updateEntry(text: string, id: string, fn: (e: Entry) => Entry | null): string {
  const out: Entry[] = [];
  for (const e of parseEntries(text)) {
    if (e.id !== id) out.push(e);
    else {
      const next = fn(e);
      if (next) out.push(next);
    }
  }
  return serializeEntries(out, text);
}

/**
 * Move entry `id` next to `targetId` in file order. The feed shows entries
 * newest-first (reversed), so "above in the feed" means "after in the file".
 */
export function moveEntry(text: string, id: string, targetId: string, where: "before" | "after"): string {
  if (id === targetId) return text;
  const entries = parseEntries(text);
  const from = entries.findIndex((e) => e.id === id);
  if (from === -1 || !entries.some((e) => e.id === targetId)) return text;
  const [moved] = entries.splice(from, 1);
  const to = entries.findIndex((e) => e.id === targetId) + (where === "after" ? 1 : 0);
  entries.splice(to, 0, moved);
  return serializeEntries(entries, text);
}

/** Move an entry one step towards the start (-1) or end (+1) of the file. */
export function shiftEntry(text: string, id: string, dir: -1 | 1): string {
  const entries = parseEntries(text);
  const i = entries.findIndex((e) => e.id === id);
  const j = i + dir;
  if (i === -1 || j < 0 || j >= entries.length) return text;
  [entries[i], entries[j]] = [entries[j], entries[i]];
  return serializeEntries(entries, text);
}

/** Feed order: pinned first, then the rest; each group newest-first (reverse of file order). */
export function feedOrder<T extends Entry>(entries: T[]): T[] {
  const rev = [...entries].reverse();
  return [...rev.filter((e) => e.meta.pinned === "true"), ...rev.filter((e) => e.meta.pinned !== "true")];
}

// ---------- links ----------

/** A readable title from a page's HTML: og:title, then <title>; Google suffixes dropped. */
export function pageTitle(html: string): string {
  const decode = (s: string) =>
    s
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
      .replace(/\s+/g, " ").trim();
  const og =
    /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i.exec(html)?.[1] ??
    /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["']/i.exec(html)?.[1];
  const title = og ?? /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? "";
  return decode(title)
    .replace(/\s+[-–—]\s+Google (Docs|Sheets|Slides|Drive|Forms)$/i, "")
    .slice(0, 200);
}

/** Fallback label for a link: host plus a short path. */
export function linkLabel(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/$/, "");
    return u.hostname.replace(/^www\./, "") + (path && path.length < 40 ? path : "");
  } catch {
    return url;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// ---------- search ----------

export function queryWords(q: string): string[] {
  return q.toLowerCase().replace(/["“”]/g, " ").split(/\s+/).filter(Boolean);
}

/** Every word appears somewhere in the text (case-insensitive). */
export function matchesAll(text: string, words: string[]): boolean {
  if (!words.length) return false;
  const t = text.toLowerCase();
  return words.every((w) => t.includes(w));
}

/**
 * A short excerpt around the first match, split into plain and highlighted
 * pieces: [{ text: "…rent is ", hit: false }, { text: "1380", hit: true }, …].
 */
export function snippetParts(text: string, words: string[], radius = 70): { text: string; hit: boolean }[] {
  const flat = text.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  const first = Math.min(...words.map((w) => lower.indexOf(w)).filter((i) => i >= 0));
  let start = Number.isFinite(first) ? Math.max(0, first - radius) : 0;
  let end = Math.min(flat.length, (Number.isFinite(first) ? first : 0) + radius * 2);
  if (start > 0) {
    const sp = flat.indexOf(" ", start);
    if (sp !== -1 && sp < (Number.isFinite(first) ? first : end)) start = sp + 1;
  }
  if (end < flat.length) {
    const sp = flat.lastIndexOf(" ", end);
    if (sp > start) end = sp;
  }
  const piece = flat.slice(start, end);
  const parts: { text: string; hit: boolean }[] = [];
  if (start > 0) parts.push({ text: "…", hit: false });
  const re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi");
  let last = 0;
  for (const m of piece.matchAll(re)) {
    if (m.index! > last) parts.push({ text: piece.slice(last, m.index), hit: false });
    parts.push({ text: m[0], hit: true });
    last = m.index! + m[0].length;
  }
  if (last < piece.length) parts.push({ text: piece.slice(last), hit: false });
  if (end < flat.length) parts.push({ text: "…", hit: false });
  return parts;
}

// ---------- tasks ----------
//
// - [ ] Send payslips 🔗 [[APARTMENTS/_project/chat/2026-10#^m-abc|chat]] 📅 2026-10-20 ^t-k2j3a
// - [x] Call agency ✅ 2026-10-17 ^t-77aa1
// Field order keeps the Obsidian Tasks plugin happy (dates at the end, block id last).

export interface Task {
  raw: string;
  done: boolean;
  text: string;
  due?: string;
  doneDate?: string;
  source?: string;
  id?: string;
}

const TASK_LINE = /^\s*[-*] \[([ xX])\] (.*)$/;

export function parseTaskLine(line: string): Task | null {
  const m = TASK_LINE.exec(line);
  if (!m) return null;
  let rest = m[2];
  const t: Task = { raw: line, done: m[1] !== " ", text: "" };
  const take = (re: RegExp): string | undefined => {
    const mm = re.exec(rest);
    if (!mm) return undefined;
    rest = rest.slice(0, mm.index) + rest.slice(mm.index + mm[0].length);
    return mm[1];
  };
  t.id = take(/\s*\^([a-z]+-[a-z0-9]+)\s*$/);
  t.doneDate = take(/\s*✅ (\d{4}-\d{2}-\d{2})/);
  t.due = take(/\s*📅 (\d{4}-\d{2}-\d{2})/);
  t.source = take(/\s*🔗 (\[\[[^\]]+\]\])/);
  t.text = rest.trim();
  return t;
}

export function serializeTask(t: Task): string {
  let s = `- [${t.done ? "x" : " "}] ${t.text.replace(/\n/g, " ").trim()}`;
  if (t.source) s += ` 🔗 ${t.source}`;
  if (t.due) s += ` 📅 ${t.due}`;
  if (t.done && t.doneDate) s += ` ✅ ${t.doneDate}`;
  if (t.id) s += ` ^${t.id}`;
  return s;
}

export function parseTasks(text: string): Task[] {
  return text.split("\n").map(parseTaskLine).filter((t): t is Task => t !== null);
}

export function appendTasks(text: string, tasks: Task[]): string {
  const base = text.replace(/\s+$/, "");
  return (base ? base + "\n" : "") + tasks.map(serializeTask).join("\n") + "\n";
}

/** Replace (or delete, when fn returns null) the first line matching the task. */
export function updateTask(text: string, task: Task, fn: (t: Task) => Task | null): string {
  const lines = text.split("\n");
  let i = task.id ? lines.findIndex((l) => parseTaskLine(l)?.id === task.id) : -1;
  if (i === -1) i = lines.indexOf(task.raw);
  if (i === -1) return text;
  const parsed = parseTaskLine(lines[i]);
  if (!parsed) return text;
  const next = fn(parsed);
  if (next) lines[i] = serializeTask(next);
  else lines.splice(i, 1);
  return lines.join("\n");
}

/** Open and overdue task counts (overdue = due before today). */
export function taskCounts(tasks: Task[], today: string = isoDate()): { open: number; overdue: number } {
  const open = tasks.filter((t) => !t.done);
  return { open: open.length, overdue: open.filter((t) => t.due && t.due < today).length };
}

/** "3 open tasks", "1 open task", "No open tasks". */
export function openTasksLabel(n: number): string {
  return n === 0 ? "No open tasks" : `${n} open task${n === 1 ? "" : "s"}`;
}

/** Open first: overdue/dated by date, then undated in file order. */
export function sortOpenTasks(tasks: Task[]): Task[] {
  const dated = tasks.filter((t) => t.due).sort((a, b) => a.due!.localeCompare(b.due!));
  return [...dated, ...tasks.filter((t) => !t.due)];
}

/** Attachments are stored as trailing `![[path]]` lines of a message or note. */
export function splitEmbeds(body: string): { text: string; files: string[] } {
  const lines = body.split("\n");
  const files: string[] = [];
  while (lines.length) {
    const m = /^!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]\s*$/.exec(lines[lines.length - 1]);
    if (!m) break;
    files.unshift(m[1]);
    lines.pop();
  }
  return { text: lines.join("\n").replace(/\s+$/, ""), files };
}

export function withEmbeds(text: string, files: string[]): string {
  return [text.replace(/\s+$/, ""), ...files.map((f) => `![[${f}]]`)].filter(Boolean).join("\n");
}

/** Split plain text into text and URL pieces, leaving trailing punctuation outside the link. */
export function splitUrls(text: string): { text: string; url?: string }[] {
  const out: { text: string; url?: string }[] = [];
  const re = /\bhttps?:\/\/[^\s<>"'`]+/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    let url = m[0];
    // trailing punctuation, and a closing bracket without its opening one
    while (/[.,;:!?)\]}]$/.test(url)) {
      const c = url[url.length - 1];
      const open = { ")": "(", "]": "[", "}": "{" }[c];
      if (open && url.split(open).length > url.split(c).length - 1) break;
      url = url.slice(0, -1);
    }
    const start = m.index!;
    if (start > last) out.push({ text: text.slice(last, start) });
    out.push({ text: url, url });
    last = start + url.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** Strip wikilink syntax for display: [[a/b|Label]] -> Label, [[a/b]] -> b. */
export function plainLinks(s: string): string {
  return s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target: string, label?: string) =>
    label ?? target.split("/").pop()!.split("#")[0]
  );
}

// ---------- frontmatter ----------

export function splitFrontmatter(text: string): { yaml: string; body: string } {
  if (!text.startsWith("---\n")) return { yaml: "", body: text };
  const end = text.indexOf("\n---", 4);
  if (end === -1) return { yaml: "", body: text };
  const after = text.indexOf("\n", end + 4);
  return { yaml: text.slice(4, end), body: after === -1 ? "" : text.slice(after + 1) };
}
