// Keeping attachment links working when files move or get renamed.
// Pure functions (no Obsidian imports), so they can be unit-tested.

// ---------- fingerprints ----------

/** Fast 32-bit FNV-1a hash of a file's bytes; with the size it identifies a file within a project. */
export function fingerprint(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return `${bytes.length}:${(h >>> 0).toString(16).padStart(8, "0")}`;
}

export function fingerprintSize(fp: string): number {
  return Number(fp.split(":")[0]);
}

/** _project/attachments.json: vault path -> fingerprint, for every file attached in the chat. */
export type AttachIndex = Record<string, string>;

export function parseIndex(text: string): AttachIndex {
  try {
    const j = JSON.parse(text || "{}");
    return j && typeof j === "object" && !Array.isArray(j) ? (j as AttachIndex) : {};
  } catch {
    return {};
  }
}

/** Re-key index entries after a move (a file, or a folder and everything in it). */
export function renameInIndex(index: AttachIndex, oldPath: string, newPath: string): AttachIndex {
  const out: AttachIndex = {};
  for (const [p, fp] of Object.entries(index)) {
    if (p === oldPath) out[newPath] = fp;
    else if (p.startsWith(oldPath + "/")) out[newPath + p.slice(oldPath.length)] = fp;
    else out[p] = fp;
  }
  return out;
}

// ---------- rewriting links ----------

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Point [[links]] (and ![[embeds]]) at a moved file or folder. Only full-path
 * links to exactly `oldPath` (or inside it, for folders) are changed.
 */
export function rewriteLinks(text: string, oldPath: string, newPath: string): string {
  if (!text.includes(oldPath)) return text;
  const re = new RegExp(`\\[\\[${esc(oldPath)}(?=[\\]|#/])`, "g");
  return text.replace(re, `[[${newPath}`);
}

// ---------- repairing links that are already broken ----------

export interface MissingRef {
  /** link target as written, e.g. APARTMENTS/Attachments/Pasted image 2026-10-18 1137 1.jpg */
  path: string;
  /** when the message carrying it was sent, YYYY-MM-DD HH:MM (local) */
  sent: string;
}

export interface Candidate {
  path: string;
  /** creation time, ms */
  ctime: number;
}

export interface Repair {
  sent: string;
  pairs: { from: string; to: string }[];
}

const ext = (p: string) => (p.split("/").pop()!.match(/\.([^.]+)$/)?.[1] ?? "").toLowerCase();
const base = (p: string) => p.split("/").pop()!;

function minuteOf(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Match broken links to files that are no longer linked anywhere:
 * 1. a unique file with the same name (moved, not renamed);
 * 2. otherwise, by batch: files attached together in one message were created
 *    in the same minute. If a message's missing files and the unlinked files
 *    created in that minute have the same count per file type, they're paired
 *    up (in name order). Anything ambiguous is left alone.
 */
export function planRepairs(missing: MissingRef[], candidates: Candidate[]): { repairs: Repair[]; unresolved: MissingRef[] } {
  const free = new Map(candidates.map((c) => [c.path, c]));
  const byMessage = new Map<string, MissingRef[]>();
  const repairs = new Map<string, Repair>();
  const unresolved: MissingRef[] = [];
  const add = (sent: string, from: string, to: string) => {
    if (!repairs.has(sent)) repairs.set(sent, { sent, pairs: [] });
    repairs.get(sent)!.pairs.push({ from, to });
    free.delete(to);
  };

  for (const m of missing) {
    const same = [...free.values()].filter((c) => base(c.path) === base(m.path));
    if (same.length === 1) add(m.sent, m.path, same[0].path);
    else {
      if (!byMessage.has(m.sent)) byMessage.set(m.sent, []);
      byMessage.get(m.sent)!.push(m);
    }
  }

  const fitsPool = (refs: MissingRef[], pool: Candidate[]) => {
    const types = new Set([...refs.map((r) => ext(r.path)), ...pool.map((c) => ext(c.path))]);
    return pool.length > 0 && [...types].every(
      (t) => refs.filter((r) => ext(r.path) === t).length === pool.filter((c) => ext(c.path) === t).length
    );
  };
  for (const [sent, refs] of byMessage) {
    // Files are saved just before the message, so allow the minute before too.
    const sentMs = new Date(+sent.slice(0, 4), +sent.slice(5, 7) - 1, +sent.slice(8, 10), +sent.slice(11, 13), +sent.slice(14, 16)).getTime();
    const prev = minuteOf(sentMs - 60_000);
    let pool = [...free.values()].filter((c) => minuteOf(c.ctime) === sent);
    if (!fitsPool(refs, pool)) pool = [...free.values()].filter((c) => [sent, prev].includes(minuteOf(c.ctime)));
    if (!fitsPool(refs, pool)) {
      unresolved.push(...refs);
      continue;
    }
    const types = new Set(refs.map((r) => ext(r.path)));
    for (const t of types) {
      const from = refs.filter((r) => ext(r.path) === t).map((r) => r.path).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      const to = pool.filter((c) => ext(c.path) === t).map((c) => c.path).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      from.forEach((f, i) => add(sent, f, to[i]));
    }
  }
  return { repairs: [...repairs.values()].sort((a, b) => a.sent.localeCompare(b.sent)), unresolved };
}
