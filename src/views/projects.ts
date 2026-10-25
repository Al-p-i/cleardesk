import { ItemView, Menu, WorkspaceLeaf, setIcon } from "obsidian";
import type ClearDesk from "../main";
import type { ProjectState } from "../main";
import { COLORS, ChatInfo, MAIN, isClosed, projectPaths } from "../store";
import { agoLabel, openTasksLabel, updatedLabel } from "../format";

export const PROJECTS_VIEW = "cleardesk-projects";

const STATUS: Record<string, { icon: string; label: string }> = {
  "at-risk": { icon: "alert-triangle", label: "At risk" },
  blocked: { icon: "octagon-x", label: "Blocked" },
  done: { icon: "circle-check", label: "Done" },
  archived: { icon: "archive", label: "Archived" },
};

/** Chats shown under the active project before "Show all". */
const CHATS_SHOWN = 8;

export class ProjectsView extends ItemView {
  private showClosed = false;
  private showAllChats = false;
  private showArchivedChats = false;
  /** Ignores a slow chat list that a newer render has replaced. */
  private chatsToken = 0;

  constructor(leaf: WorkspaceLeaf, private plugin: ClearDesk) {
    super(leaf);
  }

  getViewType() { return PROJECTS_VIEW; }
  getDisplayText() { return "Projects"; }
  getIcon() { return "folders"; }

  async onOpen() {
    this.registerEvent(this.plugin.events.on("projects", () => this.render()));
    this.registerEvent(this.plugin.events.on("active", () => this.render()));
    this.registerEvent(this.plugin.events.on("tick", () => this.render()));
    this.registerEvent(this.plugin.events.on("chat-switch", () => this.render()));
    this.registerEvent(
      this.plugin.events.on("chat", (folder: unknown) => {
        if (folder === this.plugin.active()?.folder) this.render();
      })
    );
    this.render();
  }

  render() {
    const root = this.contentEl;
    root.empty();
    root.addClass("cleardesk", "cd-projects");
    const list = root.createDiv("cd-project-list");
    const open = this.plugin.projects.filter((p) => !isClosed(p.status));
    const closed = this.plugin.projects
      .filter((p) => isClosed(p.status))
      .sort((a, b) => b.updated - a.updated);
    for (const p of open) this.renderRow(list, p);
    const add = list.createDiv("cd-project cd-new");
    setIcon(add.createSpan("cd-new-icon"), "plus");
    add.createSpan({ text: "New project" });
    add.onClickEvent(() => this.plugin.newProject());

    if (closed.length) {
      const toggle = list.createDiv({ cls: "cd-closed-toggle", text: `${this.showClosed ? "▾" : "▸"} Done & archived (${closed.length})` });
      toggle.onClickEvent(() => {
        this.showClosed = !this.showClosed;
        this.render();
      });
      // Keep the open project visible even when the group is folded.
      const active = this.plugin.active();
      for (const p of closed) {
        if (this.showClosed || p.folder === active?.folder) this.renderRow(list, p);
      }
    }
  }

  private renderRow(list: HTMLElement, p: ProjectState) {
    const active = this.plugin.active();
    const closed = isClosed(p.status);
    const row = list.createDiv({ cls: "cd-project" + (p.folder === active?.folder ? " is-active" : "") + (closed ? " is-closed" : "") });
    row.style.setProperty("--cd-color", p.color);
    row.createSpan("cd-dot");
    row.createSpan({ cls: "cd-project-name", text: p.name });
    const st = STATUS[p.status];
    if (st) {
      const icon = row.createSpan({ cls: "cd-status is-" + p.status, attr: { "aria-label": st.label } });
      setIcon(icon, st.icon);
    }
    if (p.openTasks && !closed) {
      const label = openTasksLabel(p.openTasks) + (p.overdueTasks ? `, ${p.overdueTasks} overdue` : "");
      const badge = row.createSpan({ cls: "cd-task-badge" + (p.overdueTasks ? " is-overdue" : ""), attr: { "aria-label": label } });
      setIcon(badge.createSpan("cd-task-badge-icon"), "square-check");
      badge.createSpan({ text: String(p.openTasks) });
    }
    if (p.updated) row.createSpan({ cls: "cd-updated", text: agoLabel(p.updated), attr: { "aria-label": updatedLabel(p.updated) } });
    row.onClickEvent(() => this.plugin.setActive(p.folder));
    row.addEventListener("contextmenu", (ev) => this.menu(ev, p.folder));
    if (p.folder === active?.folder) this.renderChats(list.createDiv("cd-chats"), p);
  }

  // ---------- the active project's chats ----------

  private renderChats(box: HTMLElement, p: ProjectState) {
    box.style.setProperty("--cd-color", p.color);
    const token = ++this.chatsToken;
    this.plugin.store.listChats(p.folder).then((chats) => {
      if (token !== this.chatsToken) return;
      const current = this.plugin.activeChat();
      const open = chats.filter((c) => !c.archived);
      const archived = chats.filter((c) => c.archived);
      this.chatRow(box, p, MAIN, "Main");
      if (this.plugin.isPendingChat(p.folder, current)) this.chatRow(box, p, current, "New chat");
      const shown = this.showAllChats ? open : open.slice(0, CHATS_SHOWN);
      // The open chat stays visible even when it's beyond the first few.
      const extra = open.find((c) => c.id === current && !shown.includes(c));
      for (const c of extra ? [...shown, extra] : shown) this.chatRow(box, p, c.id, c.title, c);
      if (open.length > CHATS_SHOWN) {
        const more = box.createDiv({ cls: "cd-chats-toggle", text: this.showAllChats ? "Show fewer" : `Show all (${open.length})` });
        more.onClickEvent(() => { this.showAllChats = !this.showAllChats; this.render(); });
      }
      const add = box.createDiv("cd-chat-row cd-chat-new");
      setIcon(add.createSpan("cd-new-icon"), "plus");
      add.createSpan({ text: "New chat" });
      add.onClickEvent(() => this.plugin.newChat());
      if (archived.length) {
        const toggle = box.createDiv({ cls: "cd-chats-toggle", text: `${this.showArchivedChats ? "▾" : "▸"} Archived (${archived.length})` });
        toggle.onClickEvent(() => { this.showArchivedChats = !this.showArchivedChats; this.render(); });
        if (this.showArchivedChats) for (const c of archived) this.chatRow(box, p, c.id, c.title, c);
      }
    });
  }

  private chatRow(box: HTMLElement, p: ProjectState, id: string, title: string, info?: ChatInfo) {
    const current = this.plugin.activeChat() === id;
    const pending = this.plugin.isPendingChat(p.folder, id);
    const row = box.createDiv({
      cls: "cd-chat-row" + (current ? " is-current" : "") + (pending ? " is-pending" : "") + (info?.archived ? " is-archived" : ""),
    });
    const name = row.createSpan({ cls: "cd-chat-row-name", text: title });
    if (this.plugin.controller.isBusy(p.folder, id)) row.createSpan({ cls: "cd-chat-busy", attr: { "aria-label": "Claude is replying" } });
    if (info?.updated) {
      const ms = new Date(info.updated.replace(" ", "T")).getTime();
      row.createSpan({ cls: "cd-updated", text: agoLabel(ms), attr: { "aria-label": updatedLabel(ms) } });
    }
    row.onClickEvent(() => this.plugin.openChatIn(p.folder, id));
    if (!info) return; // Main and an unsaved new chat have no menu
    row.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      const menu = new Menu();
      menu.addItem((i) => i.setTitle("Rename").setIcon("pencil").onClick(() => this.renameInline(name, p.folder, info)));
      menu.addItem((i) =>
        i.setTitle(info.archived ? "Unarchive" : "Archive").setIcon(info.archived ? "archive-restore" : "archive")
          .onClick(() => this.plugin.archiveChat(p.folder, info.id, !info.archived))
      );
      menu.showAtMouseEvent(ev);
    });
  }

  private renameInline(name: HTMLElement, folder: string, info: ChatInfo) {
    const input = createEl("input", { type: "text", cls: "cd-chat-rename", value: info.title });
    name.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save: boolean) => {
      if (done) return;
      done = true;
      if (save && input.value.trim() && input.value.trim() !== info.title) await this.plugin.renameChat(folder, info.id, input.value);
      else this.render();
    };
    input.addEventListener("click", (ev) => ev.stopPropagation());
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") finish(true);
      if (ev.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
  }

  private menu(ev: MouseEvent, folder: string) {
    const p = this.plugin.projects.find((x) => x.folder === folder);
    if (!p) return;
    const store = this.plugin.store;
    const save = async (fn: Parameters<typeof store.writeMeta>[1]) => {
      await store.writeMeta(folder, fn);
      await this.plugin.refreshProjects();
    };
    const menu = new Menu();
    const status = (s: string) => () => this.plugin.setStatus(folder, s);
    if (isClosed(p.status)) {
      menu.addItem((i) => i.setTitle("Reopen").setIcon("rotate-ccw").onClick(status("")));
      if (p.status === "done") menu.addItem((i) => i.setTitle("Archive instead").setIcon("archive").onClick(status("archived")));
      else menu.addItem((i) => i.setTitle("Mark as done instead").setIcon("circle-check").onClick(status("done")));
    } else {
      menu.addItem((i) => i.setTitle("Status: on track").setChecked(!p.status).onClick(status("")));
      menu.addItem((i) => i.setTitle("Status: at risk").setChecked(p.status === "at-risk").onClick(status("at-risk")));
      menu.addItem((i) => i.setTitle("Status: blocked").setChecked(p.status === "blocked").onClick(status("blocked")));
      if (!p.home) {
        menu.addSeparator();
        menu.addItem((i) => i.setTitle("Mark as done").setIcon("circle-check").onClick(status("done")));
        menu.addItem((i) => i.setTitle("Archive").setIcon("archive").onClick(status("archived")));
      }
    }
    menu.addSeparator();
    const names = ["Teal", "Purple", "Coral", "Pink", "Blue", "Amber", "Green", "Red"];
    COLORS.forEach((c, k) => {
      menu.addItem((i) => {
        i.setTitle(`Color: ${names[k]}`).setChecked(p.color === c).onClick(() => save((m) => ({ ...m, color: c })));
        (i as any).dom?.style?.setProperty("--cd-swatch", c);
        (i as any).dom?.addClass?.("cd-swatch-item");
      });
    });
    if (!p.home && !isClosed(p.status)) {
      menu.addSeparator();
      const others = this.plugin.projects.filter((x) => !x.home && !isClosed(x.status));
      const idx = others.findIndex((x) => x.folder === folder);
      const swap = async (j: number) => {
        if (!others[j]) return;
        // re-number everyone so the order is stable, then swap the pair
        for (let k = 0; k < others.length; k++) {
          const order = k === idx ? j + 1 : k === j ? idx + 1 : k + 1;
          await store.writeMeta(others[k].folder, (m) => ({ ...m, order }));
        }
        await this.plugin.refreshProjects();
      };
      menu.addItem((i) => i.setTitle("Move up").setIcon("arrow-up").onClick(() => swap(idx - 1)));
      menu.addItem((i) => i.setTitle("Move down").setIcon("arrow-down").onClick(() => swap(idx + 1)));
    }
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle("Open project settings file").setIcon("file-cog").onClick(() =>
        this.app.workspace.openLinkText(projectPaths(folder).meta, "", "tab")
      )
    );
    menu.showAtMouseEvent(ev);
  }
}
