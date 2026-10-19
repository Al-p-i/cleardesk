import { ItemView, Menu, WorkspaceLeaf, setIcon } from "obsidian";
import type ClearDesk from "../main";
import type { ProjectState } from "../main";
import { Entry, Task, daysUntil, dueLabel, feedOrder, hostOf, isoDate, plainLinks, sortOpenTasks, splitEmbeds, whenLabel } from "../format";
import { ProjectMeta } from "../store";
import { appendLinkified, openExternal } from "./links";
import { renderAttachments } from "./attachments";

export const PANEL_VIEW = "cleardesk-panel";

type Filter = "all" | "note" | "fact" | "link";
const HIGHLIGHT_MS = 30 * 60 * 1000;

export class PanelView extends ItemView {
  private filter: Filter = "all";
  private tag = "";
  private showOlder = false;
  private showDone = false;
  /** Show facts the AI has replaced with newer ones (hidden by default). */
  private showHistory = false;
  private editing = false;
  private dirty = false;
  /** Id of the note card being dragged, if any. */
  private dragId: string | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: ClearDesk) {
    super(leaf);
  }

  getViewType() { return PANEL_VIEW; }
  getDisplayText() { return "Project"; }
  getIcon() { return "layout-list"; }

  async onOpen() {
    const rerender = () => this.refresh();
    this.registerEvent(this.plugin.events.on("active", () => {
      this.tag = "";
      this.showOlder = false;
      this.editing = false;
      rerender();
    }));
    this.registerEvent(this.plugin.events.on("projects", rerender));
    this.registerEvent(this.plugin.events.on("data", (folder: unknown) => {
      if (folder === this.plugin.active()?.folder) rerender();
    }));
    await this.render();
  }

  /** Re-render unless the user is mid-edit; then re-render when they finish. */
  private refresh() {
    if (this.editing) this.dirty = true;
    else this.render();
  }

  private doneEditing() {
    this.editing = false;
    if (this.dirty) {
      this.dirty = false;
      this.render();
    }
  }

  async render() {
    const p = this.plugin.active();
    const root = this.contentEl;
    if (!p) {
      root.empty();
      return;
    }
    const store = this.plugin.store;
    const [meta, tasks, notes] = await Promise.all([
      store.readMeta(p.folder),
      store.tasks(p.folder),
      store.notes(p.folder),
    ]);
    root.empty();
    root.addClass("cleardesk", "cd-panel");
    root.style.setProperty("--cd-color", p.color);
    this.renderCard(root, p, meta);
    this.renderTasks(root, p, tasks);
    this.renderNotes(root, p, notes);
  }

  // ---------- card ----------

  private renderCard(root: HTMLElement, p: ProjectState, meta: ProjectMeta) {
    const card = root.createDiv("cd-card");
    const goal = card.createDiv("cd-goal");
    goal.createSpan({ cls: "cd-label", text: "Goal" });
    const val = goal.createSpan({ cls: "cd-goal-text" + (meta.goal ? "" : " is-empty"), text: meta.goal || "+ Add goal" });
    val.onClickEvent(() =>
      this.inlineInput(val, meta.goal, "What does done look like?", async (v) => {
        await this.plugin.store.writeMeta(p.folder, (m) => ({ ...m, goal: v }));
        await this.plugin.refreshProjects();
      })
    );

    const facts = card.createDiv("cd-facts");
    for (const f of meta.key_facts) {
      const row = facts.createDiv("cd-keyfact");
      const changed = this.plugin.controller.changedFacts.get(`${p.folder}::${f.label.toLowerCase()}`);
      if (changed && Date.now() - changed < HIGHLIGHT_MS) row.addClass("is-changed");
      row.createSpan({ cls: "cd-label", text: f.label });
      const v = row.createSpan({ cls: "cd-keyfact-value", text: f.value });
      v.onClickEvent(() =>
        this.inlineInput(v, f.value, f.label, async (nv) => {
          await this.plugin.store.writeMeta(p.folder, (m) => ({
            ...m,
            key_facts: nv
              ? m.key_facts.map((x) => (x.label === f.label ? { ...x, value: nv } : x))
              : m.key_facts.filter((x) => x.label !== f.label),
          }));
          this.render();
        })
      );
      const x = row.createSpan({ cls: "cd-x", attr: { "aria-label": "Remove from card" } });
      setIcon(x, "x");
      x.onClickEvent(async () => {
        await this.plugin.store.writeMeta(p.folder, (m) => ({ ...m, key_facts: m.key_facts.filter((k) => k.label !== f.label) }));
        this.render();
      });
    }
    const add = facts.createDiv({ cls: "cd-add-fact", text: "+ key fact" });
    add.onClickEvent(() =>
      this.inlineInput(add, "", "Label: value", async (v) => {
        const i = v.indexOf(":");
        if (i < 1) return;
        const label = v.slice(0, i).trim(), value = v.slice(i + 1).trim();
        await this.plugin.store.writeMeta(p.folder, (m) => ({
          ...m,
          key_facts: [...m.key_facts.filter((k) => k.label.toLowerCase() !== label.toLowerCase()), { label, value }],
        }));
        this.render();
      })
    );
  }

  // ---------- tasks ----------

  private renderTasks(root: HTMLElement, p: ProjectState, tasks: Task[]) {
    const open = sortOpenTasks(tasks.filter((t) => !t.done));
    const done = tasks.filter((t) => t.done).reverse();
    const head = root.createDiv("cd-section-head");
    head.createSpan({ text: "Tasks" });
    const overdue = open.filter((t) => t.due && daysUntil(t.due, isoDate()) < 0).length;
    head.createSpan({ cls: "cd-count", text: `· ${open.length} open` });
    if (overdue) head.createSpan({ cls: "cd-count cd-overdue", text: `· ${overdue} overdue` });
    const add = head.createSpan({ cls: "cd-icon-btn", attr: { "aria-label": "Add task" } });
    setIcon(add, "plus");
    const list = root.createDiv("cd-tasks");
    add.onClickEvent(() => {
      const row = list.createDiv({ cls: "cd-task" });
      list.prepend(row);
      this.inlineInput(row, "", "Task, e.g. call agency fri", async (v) => {
        if (v) await this.plugin.controller.send(p, `/t ${v}`);
        else row.remove();
      });
    });
    if (!open.length) list.createDiv({ cls: "cd-muted", text: "No open tasks. Add one with /t in the chat." });
    for (const t of open) this.renderTask(list, p, t);
    if (done.length) {
      const toggle = root.createDiv({ cls: "cd-toggle", text: `${this.showDone ? "▾" : "▸"} Done (${done.length})` });
      toggle.onClickEvent(() => {
        this.showDone = !this.showDone;
        this.render();
      });
      if (this.showDone) {
        const dl = root.createDiv("cd-tasks is-done");
        for (const t of done.slice(0, 30)) this.renderTask(dl, p, t);
      }
    }
  }

  private renderTask(list: HTMLElement, p: ProjectState, t: Task) {
    const today = isoDate();
    const row = list.createDiv({ cls: "cd-task" + (t.done ? " is-done" : "") });
    if (!t.done && t.due && daysUntil(t.due, today) < 0) row.addClass("is-overdue");
    const box = row.createSpan({ cls: "cd-check", attr: { "aria-label": t.done ? "Mark open" : "Mark done" } });
    setIcon(box, t.done ? "check-square" : "square");
    box.onClickEvent(async () => {
      row.addClass("is-done");
      setIcon(box, "check-square");
      await this.plugin.store.updateTask(p.folder, t, (x) => ({ ...x, done: !x.done, doneDate: x.done ? undefined : today }));
    });
    const text = row.createSpan("cd-task-text");
    appendLinkified(text, plainLinks(t.text));
    if (t.due) row.createSpan({ cls: "cd-due", text: t.done ? "" : dueLabel(t.due, today) });
    if (t.source) this.sourceLink(row, t.source);
    text.onClickEvent(() => this.editTask(row, p, t));
  }

  private editTask(row: HTMLElement, p: ProjectState, t: Task) {
    row.empty();
    row.addClass("is-editing");
    const input = row.createEl("input", { type: "text", value: t.text, cls: "cd-edit" });
    const date = row.createEl("input", { type: "date", value: t.due ?? "", cls: "cd-date" });
    const edit = this.editSession(
      row,
      async () => {
        if (input.value.trim() === t.text && (date.value || undefined) === t.due) return;
        await this.plugin.store.updateTask(p.folder, t, (x) => ({ ...x, text: input.value.trim() || x.text, due: date.value || undefined }));
      },
      { parent: row, label: "Delete task", run: () => this.plugin.store.updateTask(p.folder, t, () => null) }
    );
    for (const el of [input, date]) {
      el.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") edit.save();
        if (ev.key === "Escape") edit.cancel();
      });
    }
    input.focus();
  }


  // ---------- notes and facts ----------

  private renderNotes(root: HTMLElement, p: ProjectState, all: Entry[]) {
    const head = root.createDiv("cd-section-head");
    head.createSpan({ text: "Notes" });
    head.createSpan({ cls: "cd-count", text: String(all.filter((n) => !n.meta["replaced-by"]).length) });

    const chips = root.createDiv("cd-chips");
    const chip = (label: string, on: boolean, click: () => void, icon?: string) => {
      const c = chips.createEl("button", { cls: "cd-chip" + (on ? " is-on" : "") });
      if (icon) setIcon(c.createSpan("cd-chip-icon"), icon);
      c.createSpan({ text: label });
      c.onClickEvent(click);
    };
    const set = (f: Filter) => () => { this.filter = f; this.render(); };
    chip("All", this.filter === "all", set("all"));
    chip("Notes", this.filter === "note", set("note"));
    chip("Facts", this.filter === "fact", set("fact"), "sparkles");
    chip("Links", this.filter === "link", set("link"), "link");
    const replaced = all.filter((n) => n.meta["replaced-by"]).length;
    if (replaced) {
      const h = chips.createEl("button", {
        cls: "cd-chip cd-history" + (this.showHistory ? " is-on" : ""),
        attr: { "aria-label": this.showHistory ? "Hide replaced facts" : "Show facts that were replaced by newer ones" },
      });
      setIcon(h.createSpan("cd-chip-icon"), "history");
      h.createSpan({ text: this.showHistory ? `History (${replaced})` : `${replaced}` });
      h.onClickEvent(() => {
        this.showHistory = !this.showHistory;
        this.render();
      });
    }
    const visible = this.showHistory ? all : all.filter((n) => !n.meta["replaced-by"]);
    const counts = new Map<string, number>();
    for (const n of visible) if (n.tag) counts.set(n.tag, (counts.get(n.tag) ?? 0) + 1);
    const tags = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => t);
    if (tags.length) {
      const tagRow = root.createDiv("cd-chips cd-tags");
      for (const t of tags) {
        const c = tagRow.createEl("button", { cls: "cd-tag" + (this.tag === t ? " is-on" : ""), text: t });
        c.onClickEvent(() => { this.tag = this.tag === t ? "" : t; this.render(); });
      }
    }

    const byId = new Map(all.map((n) => [n.id, n]));
    const shown = feedOrder(
      visible.filter((n) => this.filter === "all" || n.kind === this.filter).filter((n) => !this.tag || n.tag === this.tag)
    );
    const feed = root.createDiv("cd-feed");
    if (!shown.length) {
      feed.createDiv({ cls: "cd-muted", text: all.length ? "Nothing matches this filter." : "Notes you add with /n, facts the AI picks up from chat, and links you paste appear here." });
    }
    // Pinned items never fold into "older".
    const pinnedCount = shown.filter((n) => n.meta.pinned === "true").length;
    const limit = this.showOlder ? shown.length : pinnedCount + 20;
    shown.slice(0, limit).forEach((n, i) => {
      this.renderNote(feed, p, n, byId);
      if (i === pinnedCount - 1 && pinnedCount < shown.length) feed.createDiv("cd-pinned-divider");
    });
    if (shown.length > limit) {
      const more = root.createDiv({ cls: "cd-toggle", text: `▸ ${shown.length - limit} older` });
      more.onClickEvent(() => { this.showOlder = true; this.render(); });
    }
  }

  private renderNote(feed: HTMLElement, p: ProjectState, n: Entry, byId: Map<string, Entry>) {
    const replacedBy = n.meta["replaced-by"] ? byId.get(n.meta["replaced-by"]) : undefined;
    const pinned = n.meta.pinned === "true";
    const card = feed.createDiv({
      cls: `cd-note is-${n.kind}` + (n.meta["replaced-by"] ? " is-replaced" : "") + (pinned ? " is-pinned" : ""),
      attr: { "data-id": n.id },
    });
    this.makeDraggable(card, p, n);
    const body = card.createDiv("cd-note-body");
    if (n.kind === "fact") setIcon(body.createSpan("cd-sparkle"), "sparkles");
    if (n.kind === "link" && n.meta.url) {
      setIcon(body.createSpan("cd-link-icon"), "link");
      const a = body.createEl("a", { cls: "external-link cd-link-title", text: n.body || n.meta.url, href: n.meta.url });
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openExternal(n.meta.url);
      });
      body.createDiv({ cls: "cd-link-host", text: hostOf(n.meta.url) });
    } else {
      const { text, files } = splitEmbeds(n.body);
      if (text) appendLinkified(body.createSpan("cd-note-text"), text);
      renderAttachments(this.app, card, files, {
        resolve: (l) => this.plugin.store.resolveLink(l, `${p.folder}/_project/notes.md`),
        onMissing: (l) => this.plugin.links.heal(p.folder, l),
      });
    }
    if (replacedBy) body.createSpan({ cls: "cd-replaced-with", text: ` → ${replacedBy.body}` });

    const meta = card.createDiv("cd-note-meta");
    meta.createSpan({ cls: "cd-when", text: whenLabel(n.datetime) });
    if (n.kind === "fact") meta.createSpan({ cls: "cd-muted", text: "AI" });
    if (n.meta.source) this.sourceLink(meta, n.meta.source);
    meta.createSpan("cd-spacer");
    if (n.tag) meta.createSpan({ cls: "cd-tag", text: n.tag });
    const pin = meta.createSpan({ cls: "cd-icon-btn cd-pin" + (pinned ? " is-on" : ""), attr: { "aria-label": pinned ? "Unpin" : "Pin to top" } });
    setIcon(pin, "pin");
    pin.onClickEvent((ev) => {
      ev.stopPropagation();
      this.setPinned(p, n.id, !pinned);
    });
    const more = meta.createSpan({ cls: "cd-icon-btn", attr: { "aria-label": "More" } });
    setIcon(more, "more-horizontal");
    more.onClickEvent((ev) => {
      ev.stopPropagation();
      const menu = new Menu();
      for (const other of this.plugin.projects.filter((x) => x.folder !== p.folder)) {
        menu.addItem((i) =>
          i.setTitle(`Move to ${other.name}`).setIcon("folder-input").onClick(() =>
            this.plugin.controller.moveNote(p, n.id, other)
          )
        );
      }
      menu.addSeparator();
      menu.addItem((i) => i.setTitle(pinned ? "Unpin" : "Pin to top").setIcon(pinned ? "pin-off" : "pin").onClick(() => this.setPinned(p, n.id, !pinned)));
      // The feed is newest-first, so "up" moves towards the end of the file.
      menu.addItem((i) => i.setTitle("Move up").setIcon("arrow-up").onClick(() => this.plugin.store.shiftNote(p.folder, n.id, 1)));
      menu.addItem((i) => i.setTitle("Move down").setIcon("arrow-down").onClick(() => this.plugin.store.shiftNote(p.folder, n.id, -1)));
      if (n.kind === "link" && n.meta.url) {
        menu.addItem((i) => i.setTitle("Copy link").setIcon("copy").onClick(() => navigator.clipboard.writeText(n.meta.url)));
      }
      menu.addSeparator();
      menu.addItem((i) => i.setTitle("Delete").setIcon("trash-2").onClick(() => this.plugin.store.updateNote(p.folder, n.id, () => null)));
      menu.showAtMouseEvent(ev);
    });
    body.onClickEvent(() => this.editNote(card, p, n));
  }

  private editNote(card: HTMLElement, p: ProjectState, n: Entry) {
    card.empty();
    card.addClass("is-editing");
    const ta = card.createEl("textarea", { cls: "cd-edit-area" });
    ta.value = n.body;
    const size = () => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; };
    const bar = card.createDiv("cd-note-meta");
    bar.createSpan({ cls: "cd-muted", text: "⌘↵ save · Esc cancel" });
    bar.createSpan("cd-spacer");
    const edit = this.editSession(
      card,
      async () => {
        const text = ta.value.replace(/\s+$/, "");
        if (!text || text === n.body) return;
        // An edited fact becomes the owner's note: the AI won't touch it again.
        await this.plugin.store.updateNote(p.folder, n.id, (e) => ({ ...e, kind: e.kind === "fact" ? "note" : e.kind, body: text }));
      },
      { parent: bar, label: "Delete", run: () => this.plugin.store.updateNote(p.folder, n.id, () => null) }
    );
    ta.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); edit.save(); }
      if (ev.key === "Escape") { ev.preventDefault(); edit.cancel(); }
    });
    ta.addEventListener("input", size);
    ta.focus();
    size();
  }


  // ---------- drag to reorder ----------

  /** Drag by the grip handle (so text in the card stays selectable). */
  private makeDraggable(card: HTMLElement, p: ProjectState, n: Entry) {
    const grip = card.createSpan({ cls: "cd-grip", attr: { "aria-label": "Drag to reorder" } });
    setIcon(grip, "grip-vertical");
    grip.addEventListener("mousedown", () => {
      card.draggable = true;
      window.addEventListener("mouseup", () => (card.draggable = false), { once: true });
    });
    card.addEventListener("dragstart", (ev) => {
      if (!card.draggable) return;
      this.dragId = n.id;
      this.editing = true; // hold re-renders while dragging
      ev.dataTransfer?.setData("text/plain", n.body);
      if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
      window.setTimeout(() => card.addClass("is-dragging"), 0);
    });
    card.addEventListener("dragend", () => {
      card.draggable = false;
      card.removeClass("is-dragging");
      this.dragId = null;
      this.clearDropMarks();
      this.doneEditing();
    });
    card.addEventListener("dragover", (ev) => {
      if (!this.dragId || this.dragId === n.id) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
      const r = card.getBoundingClientRect();
      const above = ev.clientY < r.top + r.height / 2;
      this.clearDropMarks();
      card.addClass(above ? "drop-above" : "drop-below");
    });
    card.addEventListener("drop", async (ev) => {
      if (!this.dragId || this.dragId === n.id) return;
      ev.preventDefault();
      const above = card.hasClass("drop-above");
      const id = this.dragId;
      this.dragId = null;
      this.clearDropMarks();
      // Above in the newest-first feed = after in the file.
      await this.plugin.store.moveNote(p.folder, id, n.id, above ? "after" : "before");
      // Dropping into (or out of) the pinned group pins (or unpins) the card.
      const target = n.meta.pinned === "true";
      const dragged = (await this.plugin.store.notes(p.folder)).find((e) => e.id === id);
      if (dragged && (dragged.meta.pinned === "true") !== target) await this.setPinned(p, id, target);
    });
  }

  private async setPinned(p: ProjectState, id: string, pinned: boolean) {
    await this.plugin.store.updateNote(p.folder, id, (e) => {
      const meta = { ...e.meta };
      if (pinned) meta.pinned = "true";
      else delete meta.pinned;
      return { ...e, meta };
    });
  }

  private clearDropMarks() {
    this.contentEl.querySelectorAll(".drop-above, .drop-below").forEach((el) => el.removeClass("drop-above", "drop-below"));
  }

  // ---------- helpers ----------

  /** ↗ link to where something came from: a chat message or a note. */
  private sourceLink(parent: HTMLElement, source: string) {
    const a = parent.createSpan({ cls: "cd-source", attr: { "aria-label": "Show source" } });
    setIcon(a, "arrow-up-right");
    a.onClickEvent((ev) => {
      ev.stopPropagation();
      const m = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/.exec(source);
      if (!m) return;
      const msg = /\/_project\/chat\/\d{4}-\d{2}#\^(m-[a-z0-9]+)$/.exec(m[1]);
      if (msg) this.plugin.jumpToMessage(msg[1]);
      else this.app.workspace.openLinkText(m[1], "", "tab");
    });
  }

  private inlineInput(target: HTMLElement, value: string, placeholder: string, save: (v: string) => Promise<void>) {
    const input = createEl("input", { type: "text", cls: "cd-edit", value, attr: { placeholder } });
    target.replaceWith(input);
    const edit = this.editSession(input, async () => {
      if (input.value.trim() !== value) await save(input.value.trim());
    });
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") edit.save();
      if (ev.key === "Escape") edit.cancel();
    });
    input.focus();
  }

  /**
   * Shared lifecycle of every in-place edit: re-renders are held while editing;
   * save() / leaving the fields saves, cancel() discards, and an optional trash
   * button deletes. Each runs once, then the panel re-renders.
   */
  private editSession(
    root: HTMLElement,
    save: () => Promise<unknown>,
    remove?: { parent: HTMLElement; label: string; run: () => Promise<unknown> }
  ) {
    this.editing = true;
    let finished = false;
    const end = async (action?: () => Promise<unknown>) => {
      if (finished) return;
      finished = true;
      if (action) await action();
      this.editing = false;
      this.dirty = false;
      this.render();
    };
    if (remove) {
      const trash = remove.parent.createSpan({ cls: "cd-icon-btn", attr: { "aria-label": remove.label } });
      setIcon(trash, "trash-2");
      // mousedown + preventDefault keeps focus, so leaving the field doesn't save first
      trash.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        end(remove.run);
      });
    }
    root.addEventListener("focusout", (ev) => {
      if (!root.contains(ev.relatedTarget as Node)) end(save);
    });
    return { save: () => end(save), cancel: () => end() };
  }

}
