import { Events } from "obsidian";
import { splitEmbeds } from "./format";
import { Candidate, MissingRef, Repair, fingerprint, fpOf, isRemoved, markRemoved, planRepairs, renameInIndex } from "./relink";
import { Project, Store } from "./store";

const inSystemDir = (path: string) => /\/_project(\/|$)/.test(path);

/**
 * Keeps attachment links in chat, notes and tasks pointing at the right files:
 * follows renames, notes deletions, finds moved files by fingerprint, and
 * plans repairs for links that are already broken.
 */
export class LinkKeeper {
  /** Link updates run one after another, in the order the vault reported them. */
  private queue: Promise<unknown> = Promise.resolve();
  private healing = new Set<string>();

  constructor(private store: Store, private projects: () => Project[], private events: Events) {}

  private enqueue(what: string, fn: () => Promise<void>) {
    this.queue = this.queue.then(fn).catch((e) => console.warn(`ClearDesk: ${what} failed`, e));
  }

  /** A file or folder moved inside Obsidian: point links (and fingerprints) at the new place. */
  followRename(oldPath: string, newPath: string) {
    if (inSystemDir(oldPath) || inSystemDir(newPath)) return;
    this.enqueue("updating links after a move", async () => {
      for (const p of this.projects()) {
        await this.store.rewriteProjectLinks(p.folder, oldPath, newPath);
        const ix = await this.store.readIndex(p.folder);
        if (Object.keys(ix).some((k) => k === oldPath || k.startsWith(oldPath + "/"))) {
          await this.store.writeIndex(p.folder, (cur) => renameInIndex(cur, oldPath, newPath));
        }
      }
    });
  }

  /** An attached file was deleted in Obsidian: remember it as removed, so it isn't reported as broken. */
  followDelete(path: string) {
    if (inSystemDir(path)) return;
    const p = this.projects().find((x) => path.startsWith(x.folder + "/"));
    if (!p) return;
    this.enqueue("noting a deleted attachment", async () => {
      const ix = await this.store.readIndex(p.folder);
      if (Object.keys(ix).some((k) => k === path || k.startsWith(path + "/"))) {
        await this.store.writeIndex(p.folder, (cur) => markRemoved(cur, path));
        this.events.trigger("chat", p.folder);
      }
    });
  }

  /** A link points nowhere: try to find the file by its fingerprint and fix the link. */
  async heal(folder: string, link: string) {
    const key = `${folder}::${link}`;
    if (this.healing.has(key)) return;
    this.healing.add(key);
    const f = await this.store.findByFingerprint(folder, link);
    if (!f) return;
    await this.store.rewriteProjectLinks(folder, link, f.path);
    // Found again, so it wasn't really removed (e.g. moved in Finder): keep a clean fingerprint.
    await this.store.writeIndex(folder, (ix) => {
      const next = renameInIndex(ix, link, f.path);
      if (next[f.path]) next[f.path] = fpOf(next[f.path]);
      return next;
    });
  }

  /** Broken attachment links in a project (removed files excluded), and the files that are linked. */
  private async findBroken(folder: string): Promise<{ missing: MissingRef[]; linked: Set<string> }> {
    const missing: MissingRef[] = [];
    const linked = new Set<string>();
    const index = await this.store.readIndex(folder);
    const scan = (entries: { datetime: string; body: string }[], source: string) => {
      for (const e of entries) {
        for (const link of splitEmbeds(e.body).files) {
          const f = this.store.resolveLink(link, source);
          if (f) linked.add(f.path);
          else if (!isRemoved(index[link])) missing.push({ path: link, sent: e.datetime });
        }
      }
    };
    for (const m of this.store.chatMonths(folder)) scan(await this.store.chat(folder, m), `${folder}/_project/chat/${m}.md`);
    scan(await this.store.notes(folder), `${folder}/_project/notes.md`);
    return { missing, linked };
  }

  /** What a repair could do right now. */
  async plan(folder: string): Promise<{ repairs: Repair[]; unresolved: MissingRef[] }> {
    const { missing, linked } = await this.findBroken(folder);
    const candidates: Candidate[] = this.store
      .projectFiles(folder)
      .filter((f) => !linked.has(f.path) && f.extension !== "md")
      .map((f) => ({ path: f.path, ctime: f.stat.ctime }));
    return planRepairs(missing, candidates);
  }

  /** How many broken links a repair could fix (drives the chat's warning bar). */
  async repairable(folder: string): Promise<number> {
    return (await this.plan(folder)).repairs.reduce((n, r) => n + r.pairs.length, 0);
  }

  /** Apply repairs: rewrite links and record fingerprints so these files can be found again. */
  async apply(folder: string, pairs: { from: string; to: string }[]) {
    for (const { from, to } of pairs) await this.store.rewriteProjectLinks(folder, from, to);
    const prints: Record<string, string> = {};
    for (const { to } of pairs) {
      const f = this.store.file(to);
      if (f) prints[to] = fingerprint(await this.store.readBinary(f));
    }
    await this.store.writeIndex(folder, (ix) => ({ ...ix, ...prints }));
    this.events.trigger("chat", folder);
    this.events.trigger("data", folder);
  }
}
