import { Events, FileSystemAdapter, Notice, Platform, Plugin, TAbstractFile, TFolder, WorkspaceLeaf, debounce } from "obsidian";
import { Ai, AiSettings, DEFAULT_AI, keyProblem } from "./ai";
import { Controller } from "./controller";
import { newId, taskCounts } from "./format";
import { explorerScopeCss } from "./scope";
import { COLORS, HOME, HOME_COLOR, MAIN, Project, Store, chatOfPath, isClosed, projectPaths } from "./store";
import { CHAT_VIEW, ChatView } from "./views/chat";
import { PANEL_VIEW, PanelView } from "./views/panel";
import { PROJECTS_VIEW, ProjectsView } from "./views/projects";
import { ImportModal, NewProjectModal, RepairModal } from "./modals";
import { LinkKeeper } from "./linkkeeper";
import { MAP_BLOCK, MapSpec, mapFile, mapFileName, mapRefPath, parseMap } from "./map";
import { projectPath, relPath } from "./paths";
import { MapChild } from "./views/map";
import { CalEvent, EVENT_BLOCK, googleCalendarUrl, icsFile, parseEvent } from "./calendar";
import { renderEventCard } from "./views/event";
import { openExternal } from "./views/links";
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
  /** The chat last open in each project: folder -> chat id ("" = Main). */
  chats: Record<string, string>;
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
  chats: {},
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
    this.settings.chats = { ...this.settings.chats };
    this.store = new Store(this.app);
    this.store.home = this.settings.homeName || HOME;
    this.ai = new Ai(() => this.settings);
    this.controller = new Controller(this.store, this.ai, (kind, folder) => this.events.trigger(kind, folder));
    this.controller.onStream = (folder, chat, text, status) => this.events.trigger("stream", folder, chat, text, status);
    this.links = new LinkKeeper(this.store, () => this.projects, this.events);

    this.registerView(PROJECTS_VIEW, (leaf) => new ProjectsView(leaf, this));
    this.registerView(CHAT_VIEW, (leaf) => new ChatView(leaf, this));
    this.registerView(PANEL_VIEW, (leaf) => new PanelView(leaf, this));
    // Maps Claude shows in chat; they also draw wherever the block appears in the vault.
    // Calendar events Claude prepared: a card with a button per calendar.
    this.registerMarkdownCodeBlockProcessor(EVENT_BLOCK, (src, el, ctx) => {
      const ev = parseEvent(src);
      if (!ev) {
        el.createDiv({ cls: "cd-muted", text: "This event couldn't be read." });
        return;
      }
      renderEventCard(el, ev, {
        google: () => openExternal(googleCalendarUrl(ev, Intl.DateTimeFormat().resolvedOptions().timeZone)),
        apple: Platform.isDesktopApp ? () => this.openInAppleCalendar(ctx.sourcePath, ev) : undefined,
      });
    });
    this.registerMarkdownCodeBlockProcessor(MAP_BLOCK, (src, el, ctx) => {
      const file = mapRefPath(src);
      const spec = file ? null : parseMap(src);
      if (!file && !spec) {
        el.createDiv({ cls: "cd-muted", text: "This map couldn't be read." });
        return;
      }
      const inMapFile = /\/Maps\/[^/]+\.md$/.test(ctx.sourcePath);
      ctx.addChild(new MapChild(el, file ? { file } : { spec: spec! }, {
        app: this.app,
        openNote: (id) => this.revealNote(ctx.sourcePath, id),
        save: inMapFile ? undefined : (s) => this.saveMap(ctx.sourcePath, s),
      }));
    });

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
      const sys = /^(.+)\/_project\/(?:(tasks|notes)\.md|(chats?)\/[^/]+\.md)$/.exec(p);
      if (sys?.[2]) this.soon("data", sys[1]);
      if (sys?.[3]) this.soon("chat", sys[1]);
    }
  }

  async setActive(folder: string) {
    if (!this.projects.some((p) => p.folder === folder)) return;
    if (this.pendingChat && this.pendingChat.folder !== folder) this.pendingChat = null;
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

  /** Open a calendar event in Apple Calendar (desktop): write it as an .ics file and open that. */
  async openInAppleCalendar(sourcePath: string, ev: CalEvent) {
    const p = this.projects.find((x) => sourcePath === x.folder || sourcePath.startsWith(x.folder + "/"));
    const folder = p ? `${p.folder}/_project/events` : ".cleardesk-events";
    // The same event always gets the same id, so a second click updates it instead of adding a copy.
    let h = 0x811c9dc5;
    for (const ch of JSON.stringify(ev)) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    const uid = `e-${h.toString(36)}`;
    const path = `${folder}/${uid}.ics`;
    await this.store.modify(path, () => icsFile(ev, uid));
    const adapter = this.app.vault.adapter;
    const open = (this.app as unknown as { openWithDefaultApp?: (p: string) => Promise<void> }).openWithDefaultApp;
    if (open) await open.call(this.app, path);
    else if (adapter instanceof FileSystemAdapter) {
      const electron = (window as unknown as { require?: (m: string) => { shell: { openPath(p: string): Promise<string> } } }).require?.("electron");
      await electron?.shell.openPath(adapter.getFullPath(path));
    } else new Notice("Couldn't open Apple Calendar here. Use the Google Calendar button, or add it from your Mac.");
  }

  /** "Save to project" on a map in the chat: keep it as Maps/<title>.md in its project. */
  async saveMap(sourcePath: string, spec: MapSpec) {
    const p = this.projects.find((x) => sourcePath === x.folder || sourcePath.startsWith(x.folder + "/"));
    if (!p) return;
    const at = projectPath(p.folder, mapFileName(spec.title));
    if ("error" in at) return new Notice(at.error);
    if (this.store.file(at.path) && !window.confirm(`Replace the saved map "${spec.title || "Map"}"?`)) return;
    await this.store.modify(at.path, () => mapFile(spec));
    new Notice(`Map saved: ${relPath(p.folder, at.path)}`);
  }

  /** Show a note or fact in the panel (from a map pin), switching to its project first. */
  async revealNote(sourcePath: string, id: string) {
    const p = this.projects.find((x) => sourcePath === x.folder || sourcePath.startsWith(x.folder + "/"));
    if (p && p.folder !== this.settings.active) await this.setActive(p.folder);
    const ws = this.app.workspace;
    if (!ws.getLeavesOfType(PANEL_VIEW).length) await this.openWorkspace();
    const leaf = ws.getLeavesOfType(PANEL_VIEW)[0];
    if (!leaf) return;
    await ws.revealLeaf(leaf);
    await (leaf.view as PanelView).revealNote(id);
  }

  // ---------- chats ----------

  /** A new chat with no messages yet; its file is created with the first message. */
  private pendingChat: { folder: string; id: string } | null = null;

  /** The chat open in the active project: the last one used there, Main by default. */
  activeChat(): string {
    const p = this.active();
    if (!p) return MAIN;
    const id = this.settings.chats[p.folder] ?? MAIN;
    if (id === MAIN || this.store.file(projectPaths(p.folder).chatFile(id))) return id;
    return this.pendingChat?.folder === p.folder && this.pendingChat.id === id ? id : MAIN;
  }

  isPendingChat(folder: string, id: string): boolean {
    return this.pendingChat?.folder === folder && this.pendingChat.id === id && !this.store.file(projectPaths(folder).chatFile(id));
  }

  /** Switch to a chat (and its project); an empty new chat left behind disappears. */
  async openChatIn(folder: string, chat: string) {
    if (this.pendingChat && this.pendingChat.id !== chat) this.pendingChat = null;
    this.settings.chats[folder] = chat;
    if (folder !== this.settings.active) {
      await this.setActive(folder); // saves settings and reloads everything
      return;
    }
    await this.saveSettings();
    this.events.trigger("chat-switch");
    await this.openChat();
  }

  async newChat() {
    const p = this.active();
    if (!p) return;
    const id = newId("c");
    this.pendingChat = { folder: p.folder, id };
    await this.openChatIn(p.folder, id);
  }

  async renameChat(folder: string, id: string, title: string) {
    if (!title.trim()) return;
    await this.store.updateChatInfo(folder, id, { title: title.trim().slice(0, 80) });
    this.events.trigger("chat", folder);
  }

  async archiveChat(folder: string, id: string, archived: boolean) {
    await this.store.updateChatInfo(folder, id, { archived });
    if (archived && folder === this.settings.active && this.activeChat() === id) await this.openChatIn(folder, MAIN);
    this.events.trigger("chat", folder);
  }

  /** Open a chat at one of its messages (search results, source links). */
  async showMessage(folder: string, chat: string, id: string) {
    if (folder !== this.settings.active || chat !== this.activeChat()) await this.openChatIn(folder, chat);
    const view = await this.openChat();
    await view.reload(true);
    view.scrollToMessage(id);
  }

  /** Follow a link to a chat message ("Folder/_project/chats/c-…#^m-…"); false if it isn't one. */
  async jumpToMessage(link: string): Promise<boolean> {
    const [path, block] = link.split("#^");
    const where = chatOfPath(path);
    if (!where || !block) return false;
    await this.showMessage(where.folder, where.chat, block);
    return true;
  }
}
