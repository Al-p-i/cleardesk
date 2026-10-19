import { App, TFile, TFolder, normalizePath, parseYaml, stringifyYaml } from "obsidian";
import { AttachIndex, fingerprint, fingerprintSize, fpOf, parseIndex, rewriteLinks } from "./relink";
import {
  Entry, Task, appendEntry, appendTasks, isoDateTime, matchesAll, monthKey, moveEntry, newId, parseEntries, parseTasks,
  shiftEntry, splitEmbeds, splitFrontmatter, updateEntry, updateTask,
} from "./format";

export const SYSTEM_DIR = "_project";
/** The default project: a general space for anything that isn't a project yet. */
export const HOME = "Desk"; // default; the name is a setting
const ATTACH_DIR = "Attachments";

export const COLORS = [
  "#1D9E75", "#7F77DD", "#D85A30", "#D4537E", "#378ADD", "#BA7517", "#639922", "#E24B4A",
];
export const HOME_COLOR = "#888780";

export interface KeyFact { label: string; value: string }

/** Done and archived projects are hidden from the main list. */
export function isClosed(status: string): boolean {
  return status === "done" || status === "archived";
}

export interface ProjectMeta {
  color: string;
  goal: string;
  status: string; // "" | at-risk | blocked | done | archived
  order: number;
  key_facts: KeyFact[];
}

export interface Project extends ProjectMeta {
  folder: string;
  name: string;
  /** the default project (Desk) */
  home: boolean;
}

/** Records the original content of every file a change touches, so it can be undone. */
export class Tx {
  snapshots = new Map<string, string | null>();
  /** Steps that reverse file moves and folder creation, run newest first on undo. */
  undoOps: (() => Promise<void>)[] = [];
  snap(path: string, content: string | null) {
    if (!this.snapshots.has(path)) this.snapshots.set(path, content);
  }
  get changed(): boolean {
    return this.snapshots.size > 0 || this.undoOps.length > 0;
  }
}

export function projectPaths(folder: string) {
  const sys = normalizePath(`${folder}/${SYSTEM_DIR}`);
  return {
    sys,
    meta: `${sys}/project.md`,
    tasks: `${sys}/tasks.md`,
    notes: `${sys}/notes.md`,
    attachments: `${sys}/attachments.json`,
    chatDir: `${sys}/chat`,
    chat: (month: string) => `${sys}/chat/${month}.md`,
  };
}

export class Store {
  /** Folder of the default project; set from Settings → ClearDesk. */
  home = HOME;

  constructor(private app: App) {}

  // ---------- low level ----------

  file(path: string): TFile | null {
    const f = this.app.vault.getAbstractFileByPath(normalizePath(path));
    return f instanceof TFile ? f : null;
  }

  async read(path: string): Promise<string> {
    const f = this.file(path);
    return f ? this.app.vault.cachedRead(f) : "";
  }

  async readBinary(f: TFile): Promise<ArrayBuffer> {
    return this.app.vault.readBinary(f);
  }

  async ensureFolder(path: string) {
    const p = normalizePath(path);
    if (this.app.vault.getAbstractFileByPath(p)) return;
    await this.app.vault.createFolder(p).catch(() => {});
  }

  /** Atomic read-modify-write; creates the file (and folders) if missing. */
  async modify(path: string, fn: (text: string) => string, tx?: Tx): Promise<void> {
    const p = normalizePath(path);
    const f = this.file(p);
    if (!f) {
      tx?.snap(p, null);
      const dir = p.split("/").slice(0, -1).join("/");
      if (dir) await this.ensureFolder(dir);
      await this.app.vault.create(p, fn(""));
      return;
    }
    await this.app.vault.process(f, (text) => {
      tx?.snap(p, text);
      return fn(text);
    });
  }

  async undo(tx: Tx) {
    for (const op of [...tx.undoOps].reverse()) {
      try {
        await op();
      } catch (e) {
        console.warn("ClearDesk: an undo step failed", e);
      }
    }
    for (const [path, content] of tx.snapshots) {
      const f = this.file(path);
      if (content === null) {
        if (f) await this.app.fileManager.trashFile(f);
      } else if (f) {
        await this.app.vault.modify(f, content);
      } else {
        await this.app.vault.create(path, content);
      }
    }
  }

  // ---------- projects ----------

  listProjects(): Project[] {
    const out: Project[] = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      const m = /^(.+)\/_project\/project\.md$/.exec(f.path);
      if (!m) continue;
      const folder = m[1];
      out.push({ folder, name: folder.split("/").pop()!, home: folder === this.home, ...this.defaultMeta() });
    }
    return out;
  }

  defaultMeta(): ProjectMeta {
    return { color: COLORS[0], goal: "", status: "", order: 0, key_facts: [] };
  }

  async readMeta(folder: string): Promise<ProjectMeta> {
    const { yaml } = splitFrontmatter(await this.read(projectPaths(folder).meta));
    let fm: Record<string, unknown> = {};
    try {
      fm = (yaml ? parseYaml(yaml) : {}) ?? {};
    } catch {
      fm = {};
    }
    const facts = Array.isArray(fm.key_facts) ? fm.key_facts : [];
    return {
      color: typeof fm.color === "string" ? fm.color : COLORS[0],
      goal: typeof fm.goal === "string" ? fm.goal : "",
      status: typeof fm.status === "string" ? fm.status : "",
      order: typeof fm.order === "number" ? fm.order : 0,
      key_facts: facts
        .filter((x: any) => x && typeof x.label === "string")
        .map((x: any) => ({ label: String(x.label), value: String(x.value ?? "") })),
    };
  }

  async writeMeta(folder: string, fn: (m: ProjectMeta) => ProjectMeta, tx?: Tx) {
    const current = await this.readMeta(folder);
    const next = fn(current);
    await this.modify(projectPaths(folder).meta, (text) => {
      const { body } = splitFrontmatter(text);
      const fm = {
        color: next.color,
        goal: next.goal,
        status: next.status,
        order: next.order,
        key_facts: next.key_facts,
      };
      return `---\n${stringifyYaml(fm)}---\n${body || PROJECT_BODY}`;
    }, tx);
  }

  async createProject(folder: string, meta: Partial<ProjectMeta>) {
    const paths = projectPaths(folder);
    await this.ensureFolder(folder);
    await this.ensureFolder(paths.sys);
    if (!this.file(paths.meta)) {
      await this.writeMeta(folder, (m) => ({ ...m, ...meta }));
    }
    if (!this.file(paths.tasks)) await this.app.vault.create(paths.tasks, "# Tasks\n\n");
    if (!this.file(paths.notes)) await this.app.vault.create(paths.notes, "# Notes\n\n");
  }

  // ---------- tasks ----------

  async tasks(folder: string): Promise<Task[]> {
    return parseTasks(await this.read(projectPaths(folder).tasks));
  }

  async addTasks(folder: string, tasks: Omit<Task, "raw">[], tx?: Tx): Promise<Task[]> {
    const withIds = tasks.map((t) => ({ ...t, raw: "", id: t.id ?? newId("t") }));
    await this.modify(projectPaths(folder).tasks, (text) => appendTasks(text || "# Tasks\n", withIds), tx);
    return withIds;
  }

  async updateTask(folder: string, task: Task, fn: (t: Task) => Task | null, tx?: Tx) {
    await this.modify(projectPaths(folder).tasks, (text) => updateTask(text, task, fn), tx);
  }

  // ---------- notes and facts ----------

  async notes(folder: string): Promise<Entry[]> {
    return parseEntries(await this.read(projectPaths(folder).notes));
  }

  async addNote(folder: string, e: Omit<Entry, "id" | "datetime"> & Partial<Entry>, tx?: Tx): Promise<Entry> {
    const entry: Entry = {
      id: e.id ?? newId(e.kind === "fact" ? "f" : e.kind === "link" ? "l" : "n"),
      datetime: e.datetime ?? isoDateTime(),
      kind: e.kind,
      tag: e.tag,
      body: e.body,
      meta: e.meta,
    };
    await this.modify(projectPaths(folder).notes, (text) => appendEntry(text || "# Notes\n", entry), tx);
    return entry;
  }

  /** Reorder: put `id` before/after `targetId` in file order. */
  async moveNote(folder: string, id: string, targetId: string, where: "before" | "after") {
    await this.modify(projectPaths(folder).notes, (text) => moveEntry(text, id, targetId, where));
  }

  async shiftNote(folder: string, id: string, dir: -1 | 1) {
    await this.modify(projectPaths(folder).notes, (text) => shiftEntry(text, id, dir));
  }

  async updateNote(folder: string, id: string, fn: (e: Entry) => Entry | null, tx?: Tx) {
    await this.modify(projectPaths(folder).notes, (text) => updateEntry(text, id, fn), tx);
  }

  // ---------- chat log ----------

  chatMonths(folder: string): string[] {
    const dir = this.app.vault.getAbstractFileByPath(projectPaths(folder).chatDir);
    if (!(dir instanceof TFolder)) return [];
    return dir.children
      .filter((c): c is TFile => c instanceof TFile && /^\d{4}-\d{2}\.md$/.test(c.name))
      .map((c) => c.basename)
      .sort();
  }

  async chat(folder: string, month: string): Promise<Entry[]> {
    return parseEntries(await this.read(projectPaths(folder).chat(month)));
  }

  /** Most recent chat entries across months, oldest first. */
  async recentChat(folder: string, limit: number): Promise<Entry[]> {
    const months = this.chatMonths(folder).reverse();
    let out: Entry[] = [];
    for (const m of months) {
      out = [...(await this.chat(folder, m)), ...out];
      if (out.length >= limit) break;
    }
    return out.slice(-limit);
  }

  async appendChat(folder: string, kind: string, body: string, meta: Record<string, string> = {}): Promise<Entry> {
    const now = new Date();
    const e: Entry = { id: newId("m"), datetime: isoDateTime(now), kind, tag: "", body, meta };
    const month = monthKey(now);
    await this.modify(projectPaths(folder).chat(month), (text) =>
      appendEntry(text || `# Chat · ${month}\n`, e)
    );
    return e;
  }

  async updateChat(folder: string, month: string, id: string, fn: (e: Entry) => Entry | null) {
    await this.modify(projectPaths(folder).chat(month), (text) => updateEntry(text, id, fn));
  }

  /** Chat messages (yours and the AI's) containing all words, newest first. */
  async searchChat(folders: string[], words: string[], limit = 100): Promise<{ folder: string; entry: Entry }[]> {
    const out: { folder: string; entry: Entry }[] = [];
    const all: { folder: string; month: string }[] = [];
    for (const folder of folders) for (const month of this.chatMonths(folder)) all.push({ folder, month });
    all.sort((a, b) => b.month.localeCompare(a.month));
    for (const { folder, month } of all) {
      const entries = (await this.chat(folder, month)).filter((e) => e.kind === "me" || e.kind === "ai");
      for (const e of entries) {
        if (matchesAll(splitEmbeds(e.body).text, words)) out.push({ folder, entry: e });
      }
    }
    out.sort((a, b) => b.entry.datetime.localeCompare(a.entry.datetime));
    return out.slice(0, limit);
  }

  /** Wikilink to a chat message, usable from any file. */
  chatLink(folder: string, e: Entry): string {
    const month = e.datetime.slice(0, 7);
    return `[[${projectPaths(folder).chat(month).replace(/\.md$/, "")}#^${e.id}|chat]]`;
  }

  // ---------- organising project files (AI tools) ----------

  isFolder(path: string): boolean {
    return this.app.vault.getAbstractFileByPath(normalizePath(path)) instanceof TFolder;
  }

  /** Create a folder and any missing parents; undo removes the ones it created (if still empty). */
  async createFolderTx(path: string, tx: Tx): Promise<boolean> {
    const parts = normalizePath(path).split("/");
    let created = false;
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join("/");
      const existing = this.app.vault.getAbstractFileByPath(p);
      if (existing instanceof TFolder) continue;
      if (existing) throw new Error(`"${p}" is a file, not a folder.`);
      await this.app.vault.createFolder(p);
      created = true;
      tx.undoOps.push(async () => {
        const f = this.app.vault.getAbstractFileByPath(p);
        if (f instanceof TFolder && f.children.length === 0) await this.app.vault.delete(f);
      });
    }
    return created;
  }

  /** Move or rename a file or folder through Obsidian (links are updated). Never overwrites. */
  async moveTx(from: string, to: string, tx: Tx): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(normalizePath(from));
    if (!f) throw new Error("Nothing exists at that path.");
    const dest = normalizePath(to);
    if (dest === f.path) return;
    if (this.app.vault.getAbstractFileByPath(dest)) throw new Error("Something already exists at the destination; pick another name.");
    if (f instanceof TFolder && (dest + "/").startsWith(f.path + "/")) throw new Error("A folder can't be moved into itself.");
    const parent = dest.split("/").slice(0, -1).join("/");
    if (parent) await this.createFolderTx(parent, tx);
    const original = f.path;
    await this.app.fileManager.renameFile(f, dest);
    tx.undoOps.push(async () => {
      const g = this.app.vault.getAbstractFileByPath(dest);
      if (g && !this.app.vault.getAbstractFileByPath(original)) await this.app.fileManager.renameFile(g, original);
    });
  }

  /** The project's folders and files (excluding _project/), with size and date. */
  listTree(folder: string, limit = 400): string[] {
    const root = this.app.vault.getAbstractFileByPath(normalizePath(folder));
    if (!(root instanceof TFolder)) return [];
    const out: string[] = [];
    const walk = (dir: TFolder) => {
      const kids = [...dir.children].sort((a, b) => a.name.localeCompare(b.name));
      for (const c of kids) {
        if (out.length >= limit) return;
        const rel = c.path.slice(root.path.length + 1);
        if (rel === SYSTEM_DIR) continue;
        if (c instanceof TFolder) {
          out.push(`${rel}/`);
          walk(c);
        } else if (c instanceof TFile) {
          const kb = c.stat.size / 1024;
          const size = kb < 1024 ? `${Math.max(1, Math.round(kb))} KB` : `${(kb / 1024).toFixed(1)} MB`;
          out.push(`${rel}  (${size}, ${new Date(c.stat.mtime).toISOString().slice(0, 10)})`);
        }
      }
    };
    walk(root);
    return out;
  }

  // ---------- project files (documents) ----------

  /** Most recent change anywhere in the project (chat, tasks, notes, documents), in ms. */
  lastUpdate(folder: string): number {
    const prefix = normalizePath(folder) + "/";
    const meta = projectPaths(folder).meta;
    let max = 0;
    for (const f of this.app.vault.getFiles()) {
      if (f.path.startsWith(prefix) && f.path !== meta && f.stat.mtime > max) max = f.stat.mtime;
    }
    return max;
  }

  projectFiles(folder: string): TFile[] {
    const prefix = normalizePath(folder) + "/";
    const sys = projectPaths(folder).sys + "/";
    return this.app.vault
      .getFiles()
      .filter((f) => f.path.startsWith(prefix) && !f.path.startsWith(sys));
  }

  /** Save an uploaded file into the project's Attachments folder; returns its vault path. */
  async saveAttachment(folder: string, name: string, data: ArrayBuffer): Promise<string> {
    const dir = normalizePath(`${folder}/${ATTACH_DIR}`);
    await this.ensureFolder(dir);
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "bin";
    const path = await this.uniquePath(dir, base, ext);
    await this.app.vault.createBinary(path, data);
    await this.writeIndex(folder, (ix) => ({ ...ix, [path]: fingerprint(data) }));
    return path;
  }

  // ---------- keeping attachment links working ----------

  async readIndex(folder: string): Promise<AttachIndex> {
    return parseIndex(await this.read(projectPaths(folder).attachments));
  }

  async writeIndex(folder: string, fn: (ix: AttachIndex) => AttachIndex) {
    await this.modify(projectPaths(folder).attachments, (text) => JSON.stringify(fn(parseIndex(text)), null, 1) + "\n");
  }

  /** The file a link points to: exact path first, then Obsidian's own link resolution (short links). */
  resolveLink(link: string, sourcePath: string): TFile | null {
    const exact = this.file(link);
    if (exact) return exact;
    const dest = this.app.metadataCache.getFirstLinkpathDest(link.split("#")[0], sourcePath);
    return dest instanceof TFile ? dest : null;
  }

  /** Find a moved/renamed attachment by its recorded fingerprint. */
  async findByFingerprint(folder: string, link: string): Promise<TFile | null> {
    const value = (await this.readIndex(folder))[link];
    if (!value) return null;
    const fp = fpOf(value);
    const size = fingerprintSize(fp);
    for (const f of this.projectFiles(folder)) {
      if (f.stat.size !== size) continue;
      if (fingerprint(await this.readBinary(f)) === fp) return f;
    }
    return null;
  }

  /** ClearDesk's own files that hold links: chat, notes, tasks. */
  linkFiles(folder: string): TFile[] {
    const p = projectPaths(folder);
    const months = this.chatMonths(folder).map((m) => p.chat(m));
    return [...months, p.notes, p.tasks].map((x) => this.file(x)).filter((f): f is TFile => f !== null);
  }

  /** Point links in a project's chat, notes and tasks from oldPath to newPath; returns how many files changed. */
  async rewriteProjectLinks(folder: string, oldPath: string, newPath: string): Promise<number> {
    let changed = 0;
    for (const f of this.linkFiles(folder)) {
      const text = await this.app.vault.cachedRead(f);
      if (!text.includes(oldPath)) continue;
      const next = rewriteLinks(text, oldPath, newPath);
      if (next === text) continue;
      await this.app.vault.process(f, (t) => rewriteLinks(t, oldPath, newPath));
      changed++;
    }
    return changed;
  }

  async uniquePath(folder: string, title: string, ext = "md"): Promise<string> {
    const clean = title.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim() || "Untitled";
    let path = normalizePath(`${folder}/${clean}.${ext}`);
    for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) {
      path = normalizePath(`${folder}/${clean} ${i}.${ext}`);
    }
    return path;
  }
}

const PROJECT_BODY = `
ClearDesk project settings. Edit the goal and key facts from the ClearDesk panel,
or change the properties above directly.
`;
