import { Events, Notice, Plugin, TAbstractFile, TFolder, WorkspaceLeaf, debounce } from "obsidian";
import { Ai, AiSettings, DEFAULT_AI, keyProblem } from "./ai";
import { Controller } from "./controller";
import { taskCounts } from "./format";
import { explorerScopeCss } from "./scope";
import { COLORS, HOME, HOME_COLOR, LEGACY_HOME, Project, Store, isClosed } from "./store";
import { CHAT_VIEW, ChatView } from "./views/chat";
import { PANEL_VIEW, PanelView } from "./views/panel";
import { PROJECTS_VIEW, ProjectsView } from "./views/projects";
import { ImportModal, NewProjectModal, RepairModal } from "./modals";
import { Candidate, MissingRef, fingerprint, planRepairs, renameInIndex } from "./relink";
import { splitEmbeds } from "./format";
import { ClearDeskSettingTab } from "./settings";

interface Settings extends AiSettings {
  active: string;
  setupDone: boolean;
  hideSystemFolders: boolean;
  textSize: "compact" | "default" | "roomy";
  font: "interface" | "text";
  /** Name (and folder) of the default project. */
  homeName: string;
  /** File explorer shows only the current project's folder. */
  explorerScope: boolean;
}

const DEFAULTS: Settings = {
  ...DEFAULT_AI,
  active: HOME,
  setupDone: false,
  hideSystemFolders: true,
  textSize: "default",
  font: "interface",
  homeName: HOME,
  explorerScope: true,
};

export interface ProjectState extends Project {
  openTasks: number;
  overdueTasks: number;
  /** ms timestamp of the most recent change in the project, 0 if none */
  updated: number;
}

export default class ClearDesk extends Plugin {
  settings: Settings = { ...DEFAULTS };
  store!: Store;
  ai!: Ai;
  controller!: Controller;
  projects: ProjectState[] = [];
  /** "projects" | "active" | ("data" | "chat", folder) */
  events = new Events();

  async onload() {
    this.settings = { ...DEFAULTS, ...(await this.loadData()) };
    this.store = new Store(this.app);
    this.store.home = this.settings.homeName || HOME;
    this.ai = new Ai(() => this.settings);
    this.controller = new Controller(this.store, this.ai, (kind, folder) => this.events.trigger(kind, folder));
    this.controller.onStream = (folder, text, status) => this.events.trigger("stream", folder, text, status);

    this.registerView(PROJECTS_VIEW, (leaf) => new ProjectsView(leaf, this));
    this.registerView(CHAT_VIEW, (leaf) => new ChatView(leaf, this));
    this.registerView(PANEL_VIEW, (leaf) => new PanelView(leaf, this));

    this.addRibbonIcon("messages-square", "Open ClearDesk", () => this.openWorkspace());
    this.addCommand({ id: "open", name: "Open workspace", callback: () => this.openWorkspace() });
    this.addCommand({ id: "open-chat", name: "Open chat", callback: () => this.openChat() });
    this.addCommand({
      id: "toggle-explorer-scope",
      name: "Toggle whole vault in file explorer",
      callback: async () => {
        this.settings.explorerScope = !this.settings.explorerScope;
        await this.saveSettings();
        this.applyExplorerScope();
        new Notice(this.settings.explorerScope ? "File explorer: current project only" : "File explorer: whole vault");
      },
    });
    this.addCommand({ id: "new-project", name: "New project", callback: () => this.newProject() });
    this.addCommand({
      id: "repair-links",
      name: "Repair broken attachment links in the current project",
      callback: () => this.openRepair(),
    });
    this.addCommand({
      id: "import-todos",
      name: "Import todos from old notes into the current project",
      callback: () => {
        const p = this.active();
        if (p) new ImportModal(this, p).open();
      },
    });
    this.addCommand({
      id: "switch-desk",
      name: "Switch to default project",
      hotkeys: [{ modifiers: ["Ctrl"], key: "0" }],
      callback: () => this.setActive(this.store.home),
    });
    for (let i = 1; i <= 9; i++) {
      this.addCommand({
        id: `switch-${i}`,
        name: `Switch to project ${i}`,
        hotkeys: [{ modifiers: ["Ctrl"], key: String(i) }],
        callback: () => {
          const p = this.projects.filter((x) => !x.home && !isClosed(x.status))[i - 1];
          if (p) this.setActive(p.folder);
        },
      });
    }

    this.addSettingTab(new ClearDeskSettingTab(this.app, this));
    // keep relative "updated" labels fresh
    this.registerInterval(window.setInterval(() => this.events.trigger("tick"), 60_000));
    this.applyBodyClasses();

    this.app.workspace.onLayoutReady(async () => {
      await this.ensureHome();
      await this.refreshProjects();
      const onFile = (f: TAbstractFile, oldPath?: string) => this.onFileChange(f.path, oldPath);
      this.registerEvent(this.app.vault.on("modify", onFile));
      this.registerEvent(this.app.vault.on("create", onFile));
      this.registerEvent(this.app.vault.on("delete", onFile));
      this.registerEvent(this.app.vault.on("rename", onFile));
      this.registerEvent(this.app.vault.on("rename", (f, oldPath) => this.followRename(oldPath, f.path)));
      if (!this.settings.setupDone) {
        await this.openWorkspace();
        this.settings.setupDone = true;
        await this.saveSettings();
      }
    });
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  applyBodyClasses() {
    const b = document.body;
    b.toggleClass("cleardesk-hide-system", this.settings.hideSystemFolders);
    b.removeClass("cd-size-compact", "cd-size-roomy", "cd-font-text");
    if (this.settings.textSize !== "default") b.addClass(`cd-size-${this.settings.textSize}`);
    if (this.settings.font === "text") b.addClass("cd-font-text");
  }

  private scopeEl: HTMLStyleElement | null = null;

  /** Limit the file explorer to the active project's folder (when the setting is on). */
  applyExplorerScope() {
    // The default project (Desk) shows the whole vault; other projects only their folder.
    const p = this.active();
    const folder = this.settings.explorerScope && p && !p.home ? p.folder : "";
    if (!this.scopeEl) this.scopeEl = document.head.createEl("style", { attr: { id: "cleardesk-explorer-scope" } });
    this.scopeEl.textContent = explorerScopeCss(folder);
  }

  onunload() {
    this.scopeEl?.remove();
    document.body.removeClass("cleardesk-hide-system", "cd-size-compact", "cd-size-roomy", "cd-font-text");
  }

  // ---------- projects ----------

  active(): ProjectState | null {
    return this.projects.find((p) => p.folder === this.settings.active) ?? this.projects[0] ?? null;
  }

  /** Make sure the default project exists; renames an earlier "Inbox" project (links are updated). */
  async ensureHome() {
    const vault = this.app.vault;
    const home = this.store.home;
    const legacy = vault.getAbstractFileByPath(LEGACY_HOME);
    if (
      home !== LEGACY_HOME &&
      legacy instanceof TFolder &&
      this.store.file(`${LEGACY_HOME}/_project/project.md`) &&
      !vault.getAbstractFileByPath(home)
    ) {
      await this.app.fileManager.renameFile(legacy, home);
      if (this.settings.active === LEGACY_HOME) {
        this.settings.active = home;
        await this.saveSettings();
      }
      new Notice(`ClearDesk: Inbox is now called ${home}.`);
    }
    if (!this.store.file(`${home}/_project/project.md`)) {
      await this.store.createProject(home, { color: HOME_COLOR, order: -1 });
    }
  }

  /** Why a name can't be used for the default project, or null. */
  homeNameProblem(name: string): string | null {
    if (!name) return "Enter a name.";
    if (/[\\/:*?"<>|#^[\]]/.test(name)) return 'Names can\'t contain \\ / : * ? " < > | # ^ [ ]';
    if (name.startsWith(".") || name === "_project") return "Pick a different name.";
    if (name === this.store.home) return null;
    if (this.app.vault.getAbstractFileByPath(name)) return `There's already a folder called "${name}" in your vault.`;
    return null;
  }

  /** Rename the default project and its folder; Obsidian updates links into it. */
  async renameHome(name: string) {
    const problem = this.homeNameProblem(name);
    if (problem) throw new Error(problem);
    const old = this.store.home;
    if (name === old) return;
    const folder = this.app.vault.getAbstractFileByPath(old);
    if (folder instanceof TFolder) await this.app.fileManager.renameFile(folder, name);
    this.store.home = name;
    this.settings.homeName = name;
    if (this.settings.active === old) this.settings.active = name;
    await this.saveSettings();
    await this.ensureHome();
    await this.refreshProjects();
    this.events.trigger("active");
  }

  async refreshProjects() {
    const list = this.store.listProjects();
    const out: ProjectState[] = [];
    for (const p of list) {
      const meta = await this.store.readMeta(p.folder);
      const tasks = await this.store.tasks(p.folder);
      const counts = taskCounts(tasks);
      out.push({ ...p, ...meta, openTasks: counts.open, overdueTasks: counts.overdue, updated: this.store.lastUpdate(p.folder) });
    }
    out.sort((a, b) =>
      a.home !== b.home ? (a.home ? -1 : 1) : a.order - b.order || a.name.localeCompare(b.name)
    );
    this.projects = out;
    this.applyExplorerScope();
    this.events.trigger("projects");
  }

  private refreshSoon = debounce(() => this.refreshProjects(), 300, true);
  private dataSoon = new Map<string, () => void>();

  private onFileChange(path: string, oldPath?: string) {
    for (const p of [path, oldPath]) {
      if (!p) continue;
      const m = /^(.+)\/_project\/(project|tasks|notes)\.md$/.exec(p);
      const chat = /^(.+)\/_project\/chat\/[^/]+\.md$/.exec(p);
      if (chat) {
        // Chat files also change by sync (e.g. messages sent from your phone): reload the chat.
        this.refreshSoon();
        this.chatChanged(chat[1]);
      } else if (m) {
        this.refreshSoon();
        if (m[2] !== "project") this.dataChanged(m[1]);
      } else if (p.endsWith("/_project") || /\/_project\/project\.md$/.test(p)) {
        this.refreshSoon();
      } else if (this.projects.some((x) => p.startsWith(x.folder + "/"))) {
        // chat, attachments, documents: refresh "last updated"
        this.refreshSoon();
      }
    }
  }

  private chatSoon = new Map<string, () => void>();

  private chatChanged(folder: string) {
    let fn = this.chatSoon.get(folder);
    if (!fn) {
      fn = debounce(() => this.events.trigger("chat", folder), 300, true);
      this.chatSoon.set(folder, fn);
    }
    fn();
  }

  private dataChanged(folder: string) {
    let fn = this.dataSoon.get(folder);
    if (!fn) {
      fn = debounce(() => this.events.trigger("data", folder), 150, true);
      this.dataSoon.set(folder, fn);
    }
    fn();
  }

  async setActive(folder: string) {
    if (!this.projects.some((p) => p.folder === folder)) return;
    this.settings.active = folder;
    await this.saveSettings();
    this.events.trigger("active");
    this.applyExplorerScope();
    if (folder !== this.store.home) this.followExplorer(folder);
    await this.openChat();
  }

  /** Set a project's status ("" | at-risk | blocked | done | archived). */
  async setStatus(folder: string, status: string) {
    if (folder === this.store.home && isClosed(status)) return; // the default project always stays open
    await this.store.writeMeta(folder, (m) => ({ ...m, status }));
    await this.refreshProjects();
  }

  // ---------- attachment links ----------

  private renameQueue: Promise<unknown> = Promise.resolve();

  /** A file or folder moved inside Obsidian: point ClearDesk's links (and fingerprints) at the new place. */
  private followRename(oldPath: string, newPath: string) {
    if (/\/_project(\/|$)/.test(oldPath) || /\/_project(\/|$)/.test(newPath)) return;
    this.renameQueue = this.renameQueue
      .then(async () => {
        for (const p of this.projects) {
          await this.store.rewriteProjectLinks(p.folder, oldPath, newPath);
          const ix = await this.store.readIndex(p.folder);
          if (Object.keys(ix).some((k) => k === oldPath || k.startsWith(oldPath + "/"))) {
            await this.store.writeIndex(p.folder, (cur) => renameInIndex(cur, oldPath, newPath));
          }
        }
      })
      .catch((e) => console.warn("ClearDesk: updating links after a move failed", e));
  }

  private healing = new Set<string>();

  /** A link points nowhere: try to find the file by its fingerprint and fix the link. */
  async heal(folder: string, link: string) {
    const key = `${folder}::${link}`;
    if (this.healing.has(key)) return;
    this.healing.add(key);
    const f = await this.store.findByFingerprint(folder, link);
    if (!f) return;
    await this.store.rewriteProjectLinks(folder, link, f.path);
    await this.store.writeIndex(folder, (ix) => renameInIndex(ix, link, f.path));
  }

  /** Broken attachment links in a project: where they are and when they were sent. */
  async findBrokenLinks(folder: string): Promise<{ missing: MissingRef[]; linked: Set<string> }> {
    const missing: MissingRef[] = [];
    const linked = new Set<string>();
    const scan = (entries: { datetime: string; body: string }[], source: string) => {
      for (const e of entries) {
        for (const link of splitEmbeds(e.body).files) {
          const f = this.store.resolveLink(link, source);
          if (f) linked.add(f.path);
          else missing.push({ path: link, sent: e.datetime });
        }
      }
    };
    for (const m of this.store.chatMonths(folder)) scan(await this.store.chat(folder, m), `${folder}/_project/chat/${m}.md`);
    scan(await this.store.notes(folder), `${folder}/_project/notes.md`);
    return { missing, linked };
  }

  async openRepair() {
    const p = this.active();
    if (!p) return;
    const { missing, linked } = await this.findBrokenLinks(p.folder);
    if (!missing.length) {
      new Notice("ClearDesk: all attachment links in this project work.");
      return;
    }
    const candidates: Candidate[] = this.store
      .projectFiles(p.folder)
      .filter((f) => !linked.has(f.path) && f.extension !== "md")
      .map((f) => ({ path: f.path, ctime: f.stat.ctime }));
    const plan = planRepairs(missing, candidates);
    new RepairModal(this, p, plan).open();
  }

  /** Apply repairs: rewrite links and record fingerprints so these files can be found again. */
  async applyRepairs(folder: string, pairs: { from: string; to: string }[]) {
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

  nextColor(): string {
    const used = new Set(this.projects.map((p) => p.color));
    return COLORS.find((c) => !used.has(c)) ?? COLORS[this.projects.length % COLORS.length];
  }

  newProject() {
    new NewProjectModal(this, async (folder, existing) => {
      await this.store.createProject(folder, {
        color: this.nextColor(),
        order: Math.max(0, ...this.projects.map((p) => p.order)) + 1,
      });
      await this.refreshProjects();
      await this.setActive(folder);
      const p = this.active();
      if (existing && p) {
        const todos = await this.controller.findOldTodos(p);
        if (todos.length) new ImportModal(this, p, todos).open();
      }
    }).open();
  }

  /** Collapse other folders in the file explorer and reveal the project's folder. */
  followExplorer(folder: string) {
    const leaf = this.app.workspace.getLeavesOfType("file-explorer")[0];
    const view = leaf?.view as any;
    if (!view) return;
    try {
      const items: Record<string, any> = view.fileItems ?? {};
      for (const [path, item] of Object.entries(items)) {
        if (!(item?.file instanceof TFolder) || typeof item.setCollapsed !== "function") continue;
        const onPath = path === folder || folder.startsWith(path + "/");
        const inside = path.startsWith(folder + "/");
        if (onPath) item.setCollapsed(false);
        else if (!inside) item.setCollapsed(true);
      }
      const f = this.app.vault.getAbstractFileByPath(folder);
      if (f && typeof view.revealInFolder === "function") view.revealInFolder(f);
    } catch (e) {
      console.warn("ClearDesk: could not update the file explorer", e);
    }
  }

  // ---------- layout ----------

  async openWorkspace() {
    const ws = this.app.workspace;
    let projects = ws.getLeavesOfType(PROJECTS_VIEW)[0];
    if (!projects) {
      const explorer = ws.getLeavesOfType("file-explorer")[0];
      projects = explorer ? ws.createLeafBySplit(explorer, "horizontal", true) : (ws.getLeftLeaf(false) as WorkspaceLeaf);
      await projects.setViewState({ type: PROJECTS_VIEW, active: false });
    }
    let panel = ws.getLeavesOfType(PANEL_VIEW)[0];
    if (!panel) {
      panel = ws.getRightLeaf(false) as WorkspaceLeaf;
      await panel.setViewState({ type: PANEL_VIEW, active: false });
    }
    let chat = ws.getLeavesOfType(CHAT_VIEW)[0];
    if (!chat) {
      chat = ws.getLeaf("tab");
      await chat.setViewState({ type: CHAT_VIEW, active: true });
    }
    ws.revealLeaf(projects);
    ws.revealLeaf(panel);
    ws.revealLeaf(chat);
    ws.setActiveLeaf(chat, { focus: true });
    if (!this.ai.configured) new Notice(`ClearDesk: ${keyProblem(this.settings.apiKey)}`);
  }

  /** Show the chat (re-creating it if it was closed) and focus its input. */
  async openChat(): Promise<ChatView> {
    const ws = this.app.workspace;
    let leaf = ws.getLeavesOfType(CHAT_VIEW)[0];
    if (!leaf) {
      leaf = ws.getLeaf("tab");
      await leaf.setViewState({ type: CHAT_VIEW, active: true });
    }
    await ws.revealLeaf(leaf);
    ws.setActiveLeaf(leaf, { focus: true });
    const view = leaf.view as unknown as ChatView;
    view.focusInput?.();
    return view;
  }

  /** Open the chat and scroll to a message (used by note/task "source" links). */
  async jumpToMessage(id: string) {
    (await this.openChat()).scrollToMessage(id);
  }
}
