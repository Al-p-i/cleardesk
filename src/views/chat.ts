import { Component, ItemView, MarkdownRenderer, Platform, Scope, WorkspaceLeaf, debounce, setIcon } from "obsidian";
import type ClearDesk from "../main";
import { Entry, fullDateLabel, isoDate, isoDateTime, queryWords, snippetParts, splitEmbeds, updatedLabel, whenLabel } from "../format";
import { CommandKind, blockOpener, parseMessage } from "../input";
import { appendLinkified, openExternal } from "./links";
import { MAIN, chatOfPath, isClosed, projectPaths } from "../store";
import { isImageName, renderAttachments } from "./attachments";
import { blocksAsText } from "../map";

export const CHAT_VIEW = "cleardesk-chat";

const BLOCK_HINT: Record<CommandKind, { icon: string; label: string }> = {
  task: { icon: "check-square", label: "Task" },
  note: { icon: "sticky-note", label: "Note" },
};

export class ChatView extends ItemView {
  private listEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private hintEl!: HTMLElement;
  private sendEl!: HTMLButtonElement;
  private headerEl!: HTMLElement;
  private busyEl!: HTMLElement;
  private block: CommandKind | null = null;
  /** Messages already drawn, kept while unchanged so maps and images don't redraw on every update. */
  private rendered = new Map<string, { key: string; el: HTMLElement; md: Component; missing: number }>();
  /** The reply being written right now (null when nothing is streaming). */
  private liveText: string | null = null;
  private liveEl: HTMLElement | null = null;
  private liveMd: Component | null = null;
  private liveTimer: number | null = null;
  private queue: Promise<void> = Promise.resolve();
  /** Messages sent and not yet answered, per `${folder}::${chat}`. */
  private pendingIn = new Map<string, number>();
  private folder = "";
  /** The open chat ("" = Main) and its title. */
  private chat = MAIN;
  private chatTitle = "";
  /** Pinned messages of the open chat: message id -> id of its copy in the notes. */
  private pinned = new Map<string, string>();
  private showAll = false;
  private missing = 0;
  private missingEl!: HTMLElement;
  /** Files waiting to be sent with the next message. */
  private files: File[] = [];
  private filesEl!: HTMLElement;
  private pickerEl!: HTMLInputElement;
  private searchEl!: HTMLElement;
  private searchInput!: HTMLInputElement;
  private resultsEl!: HTMLElement;
  private searchAll = false;

  constructor(leaf: WorkspaceLeaf, private plugin: ClearDesk) {
    super(leaf);
  }

  getViewType() { return CHAT_VIEW; }
  getDisplayText() { return this.plugin.active()?.name ?? "ClearDesk"; }
  getIcon() { return "messages-square"; }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("cleardesk", "cd-chat");
    this.headerEl = root.createDiv("cd-chat-header");
    this.missingEl = root.createDiv("cd-missing-bar");
    this.missingEl.hide();
    this.buildSearch(root);
    this.listEl = root.createDiv("cd-chat-list");
    this.busyEl = root.createDiv({ cls: "cd-busy", text: "Thinking…" });
    this.busyEl.hide();
    const composer = root.createDiv("cd-composer");
    this.hintEl = composer.createDiv("cd-hint");
    this.filesEl = composer.createDiv("cd-pending-files");
    // The input box holds the text area and, bottom right, the attach button (as in Claude).
    const box = composer.createDiv("cd-input-box");
    this.inputEl = box.createEl("textarea", { cls: "cd-input", attr: { rows: "1" } });
    const attach = box.createEl("button", { cls: "cd-attach", attr: { "aria-label": "Attach files or images", type: "button" } });
    setIcon(attach, "paperclip");
    attach.addEventListener("click", () => this.pickerEl.click());
    this.sendEl = box.createEl("button", { cls: "cd-send", attr: { type: "button" } });
    this.sendEl.addEventListener("mousedown", (ev) => ev.preventDefault()); // keep the keyboard open
    this.sendEl.addEventListener("click", () => this.submit());
    this.inputEl.addEventListener("keydown", (ev) => this.onKey(ev));
    this.inputEl.addEventListener("input", () => this.autosize());
    this.pickerEl = composer.createEl("input", { type: "file", attr: { multiple: "", style: "display:none" } });
    this.pickerEl.addEventListener("change", () => {
      this.addFiles([...(this.pickerEl.files ?? [])]);
      this.pickerEl.value = "";
    });

    // Paste a screenshot or file. Plain text pastes (even with an image alongside) stay text.
    this.inputEl.addEventListener("paste", (ev) => {
      const dt = ev.clipboardData;
      if (!dt || !dt.files.length || dt.getData("text/plain")) return;
      ev.preventDefault();
      this.addFiles([...dt.files]);
    });
    // Drag and drop files from Finder anywhere on the chat.
    root.addEventListener("dragover", (ev) => {
      if (!ev.dataTransfer?.types.includes("Files")) return;
      ev.preventDefault();
      root.addClass("is-dragging");
    });
    root.addEventListener("dragleave", (ev) => {
      if (ev.target === root || !root.contains(ev.relatedTarget as Node)) root.removeClass("is-dragging");
    });
    root.addEventListener("drop", (ev) => {
      root.removeClass("is-dragging");
      if (!ev.dataTransfer?.files.length) return;
      ev.preventDefault();
      this.addFiles([...ev.dataTransfer.files]);
    });

    this.listEl.addEventListener("click", (ev) => {
      const a = (ev.target as HTMLElement).closest("a") as HTMLAnchorElement | null;
      if (!a) return;
      const href = a.getAttr("data-href") ?? a.getAttr("href") ?? "";
      if (a.hasClass("internal-link")) {
        ev.preventDefault();
        this.app.workspace.openLinkText(href, "", "tab");
      } else if (/^(https?|mailto):/i.test(href)) {
        ev.preventDefault();
        openExternal(href);
      }
    });

    this.registerEvent(this.plugin.events.on("active", () => this.reload(true)));
    this.registerEvent(this.plugin.events.on("chat-switch", () => this.reload(true)));
    // On startup this view can open before the project list has loaded; load the
    // history as soon as the active project is known (or changes).
    this.registerEvent(
      this.plugin.events.on("projects", () => {
        if ((this.plugin.active()?.folder ?? "") !== this.folder) this.reload(true);
        else this.renderHeader();
      })
    );
    this.registerEvent(this.plugin.events.on("tick", () => this.renderHeader()));
    this.registerEvent(
      this.plugin.events.on("stream", (folder: unknown, chat: unknown, text: unknown, status: unknown) => {
        if (folder === this.folder && chat === this.chat) this.onStream(text as string | null, String(status ?? ""));
      })
    );
    this.registerEvent(
      this.plugin.events.on("chat", (folder: unknown) => {
        if (folder === this.folder) this.reload(false);
      })
    );
    // Pins can change from the panel too.
    this.registerEvent(
      this.plugin.events.on("data", (folder: unknown) => {
        if (folder === this.folder) this.reload(false);
      })
    );
    this.renderPendingFiles();
    await this.reload(true);
  }

  // ---------- rendering ----------

  private renderHeader() {
    const p = this.plugin.active();
    this.contentEl.style.setProperty("--cd-color", p?.color ?? "var(--interactive-accent)");
    this.headerEl.empty();
    const title = this.headerEl.createSpan({ cls: "cd-chat-title", text: p ? p.name : "No project" });
    if (p && this.chat !== MAIN) {
      title.createSpan({ cls: "cd-chat-sep", text: " › " });
      title.createSpan({ cls: "cd-chat-name", text: this.chatTitle });
    }
    if (p && isClosed(p.status)) {
      const chip = this.headerEl.createSpan({ cls: "cd-closed-chip" });
      setIcon(chip.createSpan("cd-closed-chip-icon"), p.status === "done" ? "circle-check" : "archive");
      chip.createSpan({ text: p.status === "done" ? "Done" : "Archived" });
      const reopen = this.headerEl.createEl("button", { cls: "cd-reopen", text: "Reopen" });
      reopen.onClickEvent(() => this.plugin.setStatus(p.folder, ""));
    }
    if (p?.updated) this.headerEl.createSpan({ cls: "cd-chat-updated", text: updatedLabel(p.updated) });
    this.headerEl.createSpan("cd-spacer");
    const search = this.headerEl.createSpan({ cls: "cd-icon-btn", attr: { "aria-label": "Search chat (⌘F)" } });
    setIcon(search, "search");
    search.onClickEvent(() => this.openSearch());
    (this.leaf as any).updateHeader?.();
    this.renderHint();
  }

  private renderHint() {
    this.hintEl.empty();
    const p = this.plugin.active();
    if (this.block) {
      const h = BLOCK_HINT[this.block];
      const label = this.hintEl.createSpan("cd-hint-block");
      setIcon(label.createSpan(), h.icon);
      label.createSpan({ text: ` ${h.label} · ${Platform.isMobile ? "tap ✓ to save" : `${Platform.isMacOS ? "⌘↵" : "Ctrl+↵"} to save · Esc to cancel`}` });
      const cancel = this.hintEl.createSpan({ cls: "cd-icon-btn cd-hint-cancel", attr: { "aria-label": "Cancel" } });
      setIcon(cancel, "x");
      cancel.onClickEvent(() => this.cancelBlock());
      this.inputEl.placeholder = this.block === "task" ? "the task; more lines add details" : "write your note";
    } else {
      for (const [kind, text] of [["task", "/t task"], ["note", "/n note"]] as const) {
        const chip = this.hintEl.createEl("button", { cls: "cd-chip", text, attr: { type: "button", "aria-label": `New ${kind}` } });
        chip.addEventListener("click", () => this.enterBlock(kind));
      }
      this.inputEl.placeholder = p ? `Ask about ${p.home ? "anything" : p.name}, or type /t or /n` : "Create a project to start";
    }
    this.inputEl.toggleClass("is-block", !!this.block);
    this.inputEl.parentElement?.toggleClass("is-block", !!this.block);
    this.syncSend();
  }

  async reload(reset: boolean) {
    const p = this.plugin.active();
    if (reset) {
      this.folder = p?.folder ?? "";
      this.chat = this.plugin.activeChat();
      this.showAll = false;
      this.exitBlock();
      this.liveText = null;
      this.setBusy("");
    }
    if (p && this.chat !== MAIN) {
      const info = (await this.plugin.store.listChats(p.folder)).find((c) => c.id === this.chat);
      this.chatTitle = info?.title ?? "New chat";
    }
    this.renderHeader();
    if (!p) {
      this.listEl.empty();
      return;
    }
    const nearBottom = this.listEl.scrollHeight - this.listEl.scrollTop - this.listEl.clientHeight < 80;
    const [entries, notes] = await Promise.all([
      this.plugin.store.recentChat(p.folder, this.showAll ? 100000 : 200, this.chat),
      this.plugin.store.notes(p.folder),
    ]);
    this.pinned = new Map();
    for (const n of notes) {
      if (n.kind !== "message" || !n.meta.source) continue;
      const m = /\[\[([^\]|#]+)#\^(m-[a-z0-9]+)/.exec(n.meta.source);
      if (m && (chatOfPath(m[1])?.chat ?? null) === this.chat) this.pinned.set(m[2], n.id);
    }
    this.render(entries);
    if (reset || nearBottom) this.listEl.scrollTop = this.listEl.scrollHeight;
  }

  private chatSource(e: Entry): string {
    const p = projectPaths(this.folder);
    return this.chat === MAIN ? p.chat(e.datetime.slice(0, 7)) : p.chatFile(this.chat);
  }

  /** Messages waiting for an answer in the open chat. */
  private pendingHere(): number {
    return this.pendingIn.get(`${this.folder}::${this.chat}`) ?? 0;
  }

  private render(entries: Entry[]) {
    this.liveEl = null;
    this.missing = 0;
    const old = this.rendered;
    this.rendered = new Map();
    const nodes: HTMLElement[] = [];
    if (!entries.length) {
      const empty = createDiv("cd-empty");
      const fresh = this.chat !== MAIN;
      empty.createDiv({ cls: "cd-empty-title", text: fresh ? "New chat" : "Start talking about this project" });
      empty.createDiv({
        text: fresh
          ? "Claude knows this project's card, tasks and notes, but not what was said in your other chats."
          : "Ask questions, mention new facts, add tasks with /t and notes with /n. Everything gets filed for you.",
      });
      nodes.push(empty);
    }
    if (!this.showAll && entries.length >= 200) {
      const more = createDiv({ cls: "cd-more", text: "Show older messages" });
      more.onClickEvent(() => {
        this.showAll = true;
        this.reload(false);
      });
      nodes.push(more);
    }
    let day = "";
    const today = isoDate();
    for (const e of entries) {
      const d = e.datetime.slice(0, 10);
      if (d !== day) {
        day = d;
        nodes.push(createDiv({ cls: "cd-day", text: d === today ? "Today" : whenLabel(e.datetime, today) }));
      }
      // Reuse the message as drawn unless it changed (an undo, an edit, a relinked attachment).
      const key = `${e.kind}|${e.body}|${e.kind === "receipt" && this.plugin.controller.canUndo(e.id)}|${this.pinned.has(e.id)}`;
      let r = old.get(e.id);
      if (r && r.key === key) {
        old.delete(e.id);
        this.missing += r.missing;
      } else {
        const md = this.addChild(new Component());
        const before = this.missing;
        r = { key, el: this.renderEntry(e, md), md, missing: 0 };
        r.missing = this.missing - before;
      }
      this.rendered.set(e.id, r);
      nodes.push(r.el);
    }
    for (const gone of old.values()) this.removeChild(gone.md);
    this.listEl.replaceChildren(...nodes);
    if (this.liveText) this.renderLive();
    this.renderMissingBar();
  }

  /** "N attachments can't be found · Repair" under the header. */
  /** Only shown when a repair can actually relink something; deleted files just show as "removed". */
  private renderMissingBar() {
    this.missingEl.empty();
    this.missingEl.hide();
    if (!this.missing) return;
    const folder = this.folder;
    this.plugin.links.repairable(folder).then((n) => {
      if (!n || folder !== this.folder) return;
      this.missingEl.empty();
      this.missingEl.show();
      this.missingEl.createSpan({ text: `${n} attachment${n === 1 ? "" : "s"} moved and can be relinked. ` });
      const fix = this.missingEl.createEl("a", { text: "Repair links…" });
      fix.onClickEvent(() => this.plugin.openRepair());
    });
  }

  // ---------- live (streaming) reply ----------

  private onStream(text: string | null, status: string) {
    if (text === null) {
      // Turn over: the saved reply replaces the live one on the next reload.
      this.liveText = null;
      this.setBusy("");
      return;
    }
    this.liveText = text;
    this.setBusy(status || (text ? "" : "Thinking…"));
    if (this.liveTimer === null) {
      this.liveTimer = window.setTimeout(() => {
        this.liveTimer = null;
        this.renderLive();
      }, 60);
    }
  }

  private renderLive() {
    if (!this.liveText) return;
    const nearBottom = this.listEl.scrollHeight - this.listEl.scrollTop - this.listEl.clientHeight < 120;
    if (!this.liveEl || !this.liveEl.isConnected) {
      this.liveEl = this.listEl.createDiv({ cls: "cd-msg cd-ai is-live" });
    }
    if (this.liveMd) this.removeChild(this.liveMd);
    this.liveMd = this.addChild(new Component());
    this.liveEl.empty();
    MarkdownRenderer.render(this.app, this.liveText, this.liveEl.createDiv("cd-msg-body"), this.folder, this.liveMd);
    if (nearBottom) this.listEl.scrollTop = this.listEl.scrollHeight;
  }

  private setBusy(status: string) {
    if (!this.pendingHere()) {
      this.busyEl.hide();
      return;
    }
    const text = status || (this.liveText ? "" : "Thinking…");
    this.busyEl.setText(text);
    this.busyEl.toggle(!!text);
  }

  /** Draw one entry (not yet in the list); its maps and embeds belong to md. */
  private renderEntry(e: Entry, md: Component): HTMLElement {
    const p = this.plugin.active()!;
    if (e.kind === "me" || e.kind === "ai") {
      // A turn: the message, then a row with its time and copy, shown on hover (as in Claude).
      const turn = createDiv({ cls: `cd-turn cd-turn-${e.kind}`, attr: { "data-id": e.id } });
      const el = turn.createDiv(`cd-msg cd-${e.kind}`);
      let copyText = blocksAsText(e.body);
      if (e.kind === "me") {
        const { text, files } = splitEmbeds(e.body);
        // Tasks and notes show a label instead of their /t or /n; copy gives only the text.
        const cmd = parseMessage(text);
        const shown = cmd.kind === "chat" ? text : cmd.items[0] ?? "";
        if (cmd.kind !== "chat") {
          el.addClass("is-command");
          const tag = el.createDiv("cd-msg-tag");
          setIcon(tag.createSpan(), BLOCK_HINT[cmd.kind].icon);
          tag.createSpan({ text: BLOCK_HINT[cmd.kind].label });
        }
        if (shown) {
          const body = el.createDiv("cd-msg-body");
          const [first, ...details] = cmd.kind === "task" ? shown.split("\n") : [shown];
          appendLinkified(body, first);
          if (details.length) appendLinkified(body.createDiv("cd-task-details"), details.join("\n"));
        }
        this.missing += renderAttachments(this.app, el, files, {
          resolve: (l) => this.plugin.store.resolveLink(l, this.chatSource(e)),
          onMissing: (l) => this.plugin.links.heal(this.folder, l),
        });
        copyText = shown;
      } else {
        MarkdownRenderer.render(this.app, e.body, el.createDiv("cd-msg-body"), p.folder, md);
      }
      const actions = turn.createDiv("cd-msg-actions");
      actions.createSpan({ cls: "cd-msg-time", text: e.datetime.slice(11, 16), attr: { title: fullDateLabel(e.datetime) } });
      if (copyText) this.copyButton(actions, copyText);
      this.pinButton(actions, e);
      return turn;
    }
    const el = createDiv({ cls: `cd-msg cd-${e.kind}`, attr: { "data-id": e.id, title: fullDateLabel(e.datetime) } });
    if (e.kind === "receipt") {
      const body = el.createDiv("cd-receipt-body");
      MarkdownRenderer.render(this.app, e.body, body, p.folder, md);
      if (e.body.startsWith("Undone: ")) el.addClass("is-undone");
      else if (this.plugin.controller.canUndo(e.id)) {
        const undo = el.createEl("a", { cls: "cd-undo", text: "undo" });
        undo.onClickEvent(() => this.plugin.controller.undo({ ...p, chat: this.chat }, e));
      }
    } else if (e.kind === "error") {
      setIcon(el.createSpan("cd-error-icon"), "alert-circle");
      el.createSpan({ text: ` ${e.body}` });
    }
    return el;
  }

  /** Pin a message to the panel (a copy, linked back here), or unpin it. */
  private pinButton(el: HTMLElement, e: Entry) {
    const noteId = this.pinned.get(e.id);
    const btn = el.createSpan({
      cls: "cd-copy cd-msg-pin" + (noteId ? " is-on" : ""),
      attr: { "aria-label": noteId ? "Unpin from the panel" : "Pin to the panel: Claude keeps it in mind in every chat" },
    });
    setIcon(btn, "pin");
    if (noteId) el.parentElement?.addClass("is-pinned");
    btn.onClickEvent(async (ev) => {
      ev.stopPropagation();
      const p = this.plugin.active();
      if (!p) return;
      if (noteId) await this.plugin.controller.unpinMessage(p.folder, noteId);
      else await this.plugin.controller.pinMessage({ ...p, chat: this.chat }, e);
    });
  }

  private copyButton(el: HTMLElement, text: string) {
    const btn = el.createSpan({ cls: "cd-copy", attr: { "aria-label": "Copy" } });
    setIcon(btn, "copy");
    btn.onClickEvent(async (ev) => {
      ev.stopPropagation();
      await navigator.clipboard.writeText(text);
      setIcon(btn, "check");
      window.setTimeout(() => setIcon(btn, "copy"), 1200);
    });
  }

  // ---------- search ----------

  private buildSearch(root: HTMLElement) {
    this.searchEl = root.createDiv("cd-search");
    this.searchEl.hide();
    const icon = this.searchEl.createSpan("cd-search-icon");
    setIcon(icon, "search");
    this.searchInput = this.searchEl.createEl("input", { type: "search", cls: "cd-search-input", attr: { placeholder: "Search this project's chats" } });
    const all = this.searchEl.createEl("label", { cls: "cd-search-all" });
    const cb = all.createEl("input", { type: "checkbox" });
    all.appendText(" All projects");
    const close = this.searchEl.createSpan({ cls: "cd-icon-btn", attr: { "aria-label": "Close search" } });
    setIcon(close, "x");
    this.resultsEl = root.createDiv("cd-search-results");
    this.resultsEl.hide();

    const run = debounce(() => this.runSearch(), 150, true);
    this.searchInput.addEventListener("input", run);
    this.searchInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        this.closeSearch();
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        (this.resultsEl.querySelector(".cd-result") as HTMLElement | null)?.click();
      }
    });
    cb.addEventListener("change", () => {
      this.searchAll = cb.checked;
      this.searchInput.placeholder = cb.checked ? "Search all projects" : "Search this project's chats";
      this.runSearch();
    });
    close.onClickEvent(() => this.closeSearch());

    this.scope = new Scope(this.app.scope);
    this.scope.register(["Mod"], "f", () => {
      this.openSearch();
      return false;
    });
    // Obsidian's own keymap sees these keys before the text box does, so the chat view
    // claims them in its scope, only while you're typing in its input.
    const typing = () => document.activeElement === this.inputEl;
    this.scope.register(["Mod"], "Enter", () => {
      if (!typing() || !this.block) return true;
      this.submit();
      return false;
    });
    this.scope.register([], "Escape", () => {
      if (document.activeElement === this.searchInput) {
        this.closeSearch();
        return false;
      }
      if (!typing()) return true;
      if (this.block) this.cancelBlock(); // in a chat message, Esc does nothing (and doesn't close the tab)
      return false;
    });

  }

  openSearch() {
    this.searchEl.show();
    this.searchInput.focus();
    this.searchInput.select();
    if (this.searchInput.value) this.runSearch();
  }

  private closeSearch() {
    this.searchEl.hide();
    this.resultsEl.hide();
    this.resultsEl.empty();
    this.inputEl.focus();
  }

  private async runSearch() {
    const words = queryWords(this.searchInput.value);
    this.resultsEl.empty();
    if (!words.length) {
      this.resultsEl.hide();
      return;
    }
    const folders = this.searchAll ? this.plugin.projects.map((p) => p.folder) : [this.folder];
    const hits = await this.plugin.store.searchChat(folders, words);
    if (queryWords(this.searchInput.value).join(" ") !== words.join(" ")) return; // a newer search is running
    this.resultsEl.show();
    this.resultsEl.empty();
    this.resultsEl.createDiv({
      cls: "cd-results-count",
      text: hits.length ? `${hits.length === 100 ? "100+" : hits.length} result${hits.length === 1 ? "" : "s"}` : "No messages found",
    });
    // Chat titles, for results outside Main.
    const titles = new Map<string, string>();
    for (const folder of new Set(hits.filter((h) => h.chat !== MAIN).map((h) => h.folder))) {
      for (const c of await this.plugin.store.listChats(folder)) titles.set(`${folder}::${c.id}`, c.title);
    }
    for (const { folder, chat, entry } of hits) {
      const row = this.resultsEl.createDiv("cd-result");
      const meta = row.createDiv("cd-result-meta");
      if (this.searchAll) {
        const p = this.plugin.projects.find((x) => x.folder === folder);
        const tag = meta.createSpan("cd-result-project");
        tag.style.setProperty("--cd-color", p?.color ?? "var(--text-faint)");
        tag.createSpan("cd-dot");
        tag.createSpan({ text: p?.name ?? folder });
      }
      if (chat !== MAIN) meta.createSpan({ cls: "cd-result-chat", text: titles.get(`${folder}::${chat}`) ?? "Chat" });
      meta.createSpan({ text: entry.kind === "me" ? "You" : "AI" });
      meta.createSpan({ text: whenLabel(entry.datetime) });
      const text = row.createDiv("cd-result-text");
      for (const part of snippetParts(blocksAsText(splitEmbeds(entry.body).text), words)) {
        if (part.hit) text.createEl("mark", { text: part.text });
        else text.appendText(part.text);
      }
      row.onClickEvent(() => this.plugin.showMessage(folder, chat, entry.id));
    }
  }

  focusInput() {
    this.inputEl?.focus();
  }

  scrollToMessage(id: string) {
    const find = () => this.listEl.querySelector(`[data-id="${CSS.escape(id)}"]`) as HTMLElement | null;
    const go = (el: HTMLElement) => {
      el.scrollIntoView({ block: "center" });
      el.addClass("is-flash");
      window.setTimeout(() => el.removeClass("is-flash"), 1600);
    };
    const el = find();
    if (el) return go(el);
    this.showAll = true;
    this.reload(false).then(() => {
      const again = find();
      if (again) go(again);
    });
  }

  // ---------- input ----------

  private onKey(ev: KeyboardEvent) {
    if (ev.isComposing || ev.defaultPrevented) return; // already handled by the view's scope
    if (ev.key !== "Enter") return;
    if (this.block) {
      // In a task or note, Enter adds a line; ⌘↵ / Ctrl+↵ (or the ✓ button) saves.
      if (ev.metaKey || ev.ctrlKey) {
        ev.preventDefault();
        this.submit();
      }
      return;
    }
    if (ev.shiftKey) return;
    ev.preventDefault();
    this.submit();
  }

  /** Leave task/note mode without saving (asks first if something was written). */
  private cancelBlock() {
    const value = this.inputEl.value.trim();
    if (value && !window.confirm(`Discard ${value.split("\n").length} line(s)?`)) return;
    this.exitBlock();
    this.inputEl.focus();
  }

  /** Enter or the send button: send the message, or save the open task or note. */
  private submit() {
    const value = this.inputEl.value;
    if (this.block) {
      this.submitBlock(value);
      return;
    }
    const opener = blockOpener(value);
    if (opener) {
      this.inputEl.value = "";
      this.enterBlock(opener);
      return;
    }
    if (!value.trim() && !this.files.length) return;
    this.inputEl.value = "";
    this.autosize();
    this.enqueue(value);
  }

  private syncSend() {
    if (!this.sendEl) return;
    const label = this.block ? `Save ${this.block}` : "Send";
    setIcon(this.sendEl, this.block ? "check" : "arrow-up");
    this.sendEl.setAttr("aria-label", label);
    this.sendEl.toggleClass("is-ready", !!this.inputEl.value.trim() || this.files.length > 0);
  }

  private submitBlock(content: string) {
    const kind = this.block;
    if (!kind) return;
    this.exitBlock();
    if (!content.trim() && !this.files.length) return;
    this.enqueue(`/${kind === "task" ? "t" : "n"}\n${content.replace(/\s+$/, "")}`);
  }

  /** Start a task or note; text already typed becomes its first line. */
  private enterBlock(kind: CommandKind) {
    this.block = kind;
    this.renderHint();
    this.autosize();
    this.inputEl.focus();
  }

  private exitBlock() {
    this.block = null;
    if (this.inputEl) {
      this.inputEl.value = "";
      this.renderHint();
      this.autosize();
    }
  }

  private autosize() {
    this.inputEl.style.height = "auto";
    this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 320) + "px";
    this.syncSend();
  }

  // ---------- attachments ----------

  private addFiles(files: File[]) {
    if (!files.length) return;
    this.files.push(...files);
    this.renderPendingFiles();
    this.inputEl.focus();
  }

  private renderPendingFiles() {
    this.filesEl.empty();
    this.filesEl.toggle(this.files.length > 0);
    this.syncSend();
    this.files.forEach((f, i) => {
      const chip = this.filesEl.createDiv("cd-file-chip is-pending");
      if (isImageName(f.name) && f.type.startsWith("image/")) {
        const url = URL.createObjectURL(f);
        chip.createEl("img", { cls: "cd-pending-thumb", attr: { src: url, alt: f.name } });
      } else {
        setIcon(chip.createSpan("cd-file-icon"), "file");
      }
      chip.createSpan({ cls: "cd-file-name", text: f.name || "pasted file" });
      const x = chip.createSpan({ cls: "cd-file-x", attr: { "aria-label": "Remove" } });
      setIcon(x, "x");
      x.onClickEvent(() => {
        this.files.splice(i, 1);
        this.renderPendingFiles();
      });
    });
  }

  /** Read the pending files and clear them from the composer. */
  private takeFiles(): Promise<{ name: string; data: ArrayBuffer }[]> {
    const files = this.files;
    this.files = [];
    this.renderPendingFiles();
    const stamp = isoDateTime().replace(":", "");
    return Promise.all(
      files.map(async (f, i) => {
        const ext = (f.type.split("/")[1] ?? "bin").replace("jpeg", "jpg").replace(/\+.*$/, "");
        const generic = !f.name || /^image\.\w+$/i.test(f.name);
        const name = generic ? `Pasted image ${stamp}${files.length > 1 ? ` ${i + 1}` : ""}.${ext}` : f.name;
        return { name, data: await f.arrayBuffer() };
      })
    );
  }

  private enqueue(text: string) {
    const p = this.plugin.active();
    if (!p) return;
    const uploads = this.takeFiles();
    // The message belongs to the chat it was sent in, even if you switch chats meanwhile.
    const chat = this.chat;
    const key = `${p.folder}::${chat}`;
    this.pendingIn.set(key, (this.pendingIn.get(key) ?? 0) + 1);
    this.busyEl.setText("Thinking…");
    this.busyEl.toggle(!/^\/[tn]\b/.test(text.trim()) || this.pendingHere() > 1);
    this.queue = this.queue
      .then(async () => this.plugin.controller.send({ ...p, chat }, text, await uploads))
      .catch((e) => console.error("ClearDesk:", e))
      .finally(() => {
        const left = (this.pendingIn.get(key) ?? 1) - 1;
        if (left) this.pendingIn.set(key, left);
        else this.pendingIn.delete(key);
        if (key === `${this.folder}::${this.chat}` && !left) {
          this.liveText = null;
          this.busyEl.hide();
        }
      });
  }

  async onClose() {
    this.rendered.clear(); // their components unload with the view
  }
}
