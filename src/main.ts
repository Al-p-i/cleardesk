import { Events, Notice, Plugin, TAbstractFile, TFolder, WorkspaceLeaf, debounce } from "obsidian";
import { Ai, AiSettings, DEFAULT_AI, keyProblem } from "./ai";
import { Controller } from "./controller";
import { taskCounts } from "./format";
import { explorerScopeCss } from "./scope";
import { COLORS, HOME, HOME_COLOR, Project, Store, isClosed } from "./store";
import { CHAT_VIEW, ChatView } from "./views/chat";
import { PANEL_VIEW, PanelView } from "./views/panel";
import { PROJECTS_VIEW, ProjectsView } from "./views/projects";
import { ImportModal, NewProjectModal, RepairModal } from "./modals";
import { LinkKeeper } from "./linkkeeper";
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
  explorerScope: false, // opt-in: it changes Obsidian's file explorer
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
  links!: LinkKeeper;
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
    this.links = new LinkKeeper(this.store, () => this.projects, this.events);

    this.registerView(PROJECTS_VIEW, (leaf) => new ProjectsView(leaf, this));
    this.registerView(CHAT_VIEW, (leaf) => new ChatView(leaf, this));
    this.registerView(PANEL_VIEW, (leaf) => new PanelView(leaf, this));

    this.addRibbonIcon("messages-square", "Open ClearDesk", () => this.openWorkspace());
    this.addCommand({ id: "open", name: "Open workspace", callback: () => this.openWorkspace() });
    this.addCommand({ id: "open-chat", name: "Open chat", callback: () => this.openChat() });
    this.addCommand({
      id: "toggle-explorer-scope",
      name: "Toggle file explorer focus on the current project",
      callback: async () => {
        this.settings.explorerScope = !this.settings.explorerScope;
        await this.saveSettings();
        this.applyExplorerFocus();
        new Notice(this.settings.explorerScope ? "File explorer: focused on the current project" : "File explorer: whole vault");
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
    this.addSettingTab(new ClearDeskSettingTab(this.app, this));
    // keep relative "updated" labels fresh
    this.registerInterval(window.setInterval(() => this.events.trigger("tick"), 60_000));
    this.applyBodyClasses();
    this.syncExplorerHooks();
    this.register(() => this.explorerHooks.splice(0).forEach((undo) => undo()));

    this.app.workspace.onLayoutReady(async () => {
      await this.ensureHome();
      await this.refreshProjects();
      const onFile = (f: TAbstractFile, oldPath?: string) => this.onFileChange(f.path, oldPath);
      this.registerEvent(this.app.vault.on("modify", onFile));
      this.registerEvent(this.app.vault.on("create", onFile));
      this.registerEvent(this.app.vault.on("delete", onFile));
      this.registerEvent(this.app.vault.on("rename", onFile));
      this.registerEvent(this.app.vault.on("rename", (f, oldPath) => this.links.followRename(oldPath, f.path)));
      this.registerEvent(this.app.vault.on("delete", (f) => this.links.followDelete(f.path)));
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

  /** Undo functions for the explorer hooks; empty while explorer focus is off. */
  private explorerHooks: (() => void)[] = [];

  /**
   * Explorer focus (opt-in): while a project is open, new notes and folders
   * go into the project folder instead of Obsidian's default location. The
   * hooks are only installed while the setting is on, and removed otherwise.
   */
  syncExplorerHooks() {
    if (!this.settings.explorerScope) {
      this.explorerHooks.splice(0).forEach((undo) => undo());
      return;
    }
    if (this.explorerHooks.length) return;
    const fm = this.app.fileManager;
    const original = fm.getNewFileParent;
    fm.getNewFileParent = (sourcePath: string, newFilePath?: string) => {
      const parent = original.call(fm, sourcePath, newFilePath);
      const p = this.active();
      if (!p || p.home) return parent;
      if (parent.path === p.folder || parent.path.startsWith(p.folder + "/")) return parent; // already inside
      const folder = this.app.vault.getAbstractFileByPath(p.folder);
      return folder instanceof TFolder ? folder : parent;
    };
    this.explorerHooks.push(() => {
      fm.getNewFileParent = original;
    });

    // The explorer's "New folder" button skips getNewFileParent and asks Obsidian's
    // (internal) createNewFolder for a folder at the root; send it to the project instead.
    const internal = fm as unknown as { createNewFolder?: (parent: TFolder | null) => Promise<TFolder> };
    const originalFolder = internal.createNewFolder;
    if (typeof originalFolder !== "function") return;
    internal.createNewFolder = (parent: TFolder | null) => {
      const p = this.active();
      const atRoot = !parent || parent.isRoot();
      const project = p && !p.home ? this.app.vault.getAbstractFileByPath(p.folder) : null;
      return originalFolder.call(fm, atRoot && project instanceof TFolder ? project : parent);
    };
    this.explorerHooks.push(() => {
      internal.createNewFolder = originalFolder;
    });
  }

  /** Apply the explorer focus setting: hooks plus the explorer filter. */
  applyExplorerFocus() {
    this.syncExplorerHooks();
    this.applyExplorerScope();
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

  /** Make sure the default project exists. */
  async ensureHome() {
    const home = this.store.home;
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
  private soonFns = new Map<string, () => void>();

  /** Trigger an event for a folder once a burst of file changes has settled. */
  private soon(event: "chat" | "data", folder: string) {
    const key = `${event}::${folder}`;
    let fn = this.soonFns.get(key);
    if (!fn) {
      fn = debounce(() => this.events.trigger(event, folder), 250, true);
      this.soonFns.set(key, fn);
    }
    fn();
  }

  /**
   * Any change inside a project, or a new/renamed project, refreshes the project list (counts, "updated").
   * Changes to tasks/notes refresh the panel; chat files reload the chat, which
   * also covers messages that arrive by sync from another device.
   */
  private onFileChange(path: string, oldPath?: string) {
    for (const p of [path, oldPath]) {
      if (!p) continue;
      const known = this.projects.some((x) => p === x.folder || p.startsWith(x.folder + "/"));
      if (!known && !/(^|\/)_project(\/|$)/.test(p)) continue; // new projects show up via their _project folder
      this.refreshSoon();
      const sys = /^(.+)\/_project\/(?:(tasks|notes)\.md|(chat)\/[^/]+\.md)$/.exec(p);
      if (sys?.[2]) this.soon("data", sys[1]);
      if (sys?.[3]) this.soon("chat", sys[1]);
    }
  }

  async setActive(folder: string) {
    if (!this.projects.some((p) => p.folder === folder)) return;
    this.settings.active = folder;
    await this.saveSettings();
    this.events.trigger("active");
    this.applyExplorerScope();
    if (this.settings.explorerScope && folder !== this.store.home) this.followExplorer(folder);
    await this.openChat();
  }

  /** Set a project's status ("" | at-risk | blocked | done | archived). */
  async setStatus(folder: string, status: string) {
    if (folder === this.store.home && isClosed(status)) return; // the default project always stays open
    await this.store.writeMeta(folder, (m) => ({ ...m, status }));
    await this.refreshProjects();
  }

  // ---------- attachment links (see linkkeeper.ts) ----------

  async openRepair() {
    const p = this.active();
    if (!p) return;
    const plan = await this.links.plan(p.folder);
    if (!plan.repairs.length && !plan.unresolved.length) {
      new Notice("ClearDesk: all attachment links in this project work.");
      return;
    }
    new RepairModal(this, p, plan).open();
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
    ws.revealLeaf(projects);
    ws.revealLeaf(panel);
    await this.openChat();
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
