import { Component, ItemView, MarkdownRenderer, Scope, WorkspaceLeaf, debounce, setIcon } from "obsidian";
import type ClearDesk from "../main";
import { Entry, fullDateLabel, isoDate, isoDateTime, queryWords, snippetParts, splitEmbeds, updatedLabel, whenLabel } from "../format";
import { CommandKind, blockOpener, closeBlock } from "../input";
import { appendLinkified, openExternal } from "./links";
import { isClosed } from "../store";
import { isImageName, renderAttachments } from "./attachments";

export const CHAT_VIEW = "cleardesk-chat";

const BLOCK_HINT: Record<CommandKind, { icon: string; label: string }> = {
  task: { icon: "check-square", label: "Tasks · each line is a task" },
  note: { icon: "sticky-note", label: "Note" },
};

export class ChatView extends ItemView {
  private listEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private hintEl!: HTMLElement;
  private headerEl!: HTMLElement;
  private busyEl!: HTMLElement;
  private block: CommandKind | null = null;
  private md = new Component();
  /** The reply being written right now (null when nothing is streaming). */
  private liveText: string | null = null;
  private liveEl: HTMLElement | null = null;
  private liveMd: Component | null = null;
  private liveTimer: number | null = null;
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private folder = "";
  private showAll = false;
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
    this.buildSearch(root);
    this.listEl = root.createDiv("cd-chat-list");
    this.busyEl = root.createDiv({ cls: "cd-busy", text: "Thinking…" });
    this.busyEl.hide();
    const composer = root.createDiv("cd-composer");
    this.hintEl = composer.createDiv("cd-hint");
    this.filesEl = composer.createDiv("cd-pending-files");
    this.inputEl = composer.createEl("textarea", { cls: "cd-input", attr: { rows: "1" } });
    this.inputEl.addEventListener("keydown", (ev) => this.onKey(ev));
    this.inputEl.addEventListener("input", () => this.onInput());
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
      this.plugin.events.on("stream", (folder: unknown, text: unknown, status: unknown) => {
        if (folder === this.folder) this.onStream(text as string | null, String(status ?? ""));
      })
    );
    this.registerEvent(
      this.plugin.events.on("chat", (folder: unknown) => {
        if (folder === this.folder) this.reload(false);
      })
    );
    this.addChild(this.md);
    this.renderPendingFiles();
    await this.reload(true);
  }

  // ---------- rendering ----------

  private renderHeader() {
    const p = this.plugin.active();
    this.contentEl.style.setProperty("--cd-color", p?.color ?? "var(--interactive-accent)");
    this.headerEl.empty();
    this.headerEl.createSpan({ cls: "cd-chat-title", text: p ? p.name : "No project" });
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
      label.createSpan({ text: ` ${h.label} · ` });
      label.createEl("code", { text: "//" });
      label.createSpan({ text: " to finish · Esc to cancel" });
      this.inputEl.placeholder = this.block === "task" ? "one task per line" : "write your note";
    } else {
      for (const c of ["/t task", "/n note"]) this.hintEl.createEl("code", { cls: "cd-chip", text: c });
      this.inputEl.placeholder = p ? `Ask about ${p.home ? "anything" : p.name}, or type /t or /n` : "Create a project to start";
    }
    const attach = this.hintEl.createSpan({ cls: "cd-icon-btn cd-attach", attr: { "aria-label": "Attach files or images" } });
    setIcon(attach, "paperclip");
    attach.onClickEvent(() => this.pickerEl.click());
    this.inputEl.toggleClass("is-block", !!this.block);
  }

  async reload(reset: boolean) {
    const p = this.plugin.active();
    if (reset) {
      this.folder = p?.folder ?? "";
      this.showAll = false;
      this.exitBlock();
    }
    this.renderHeader();
    if (!p) {
      this.listEl.empty();
      return;
    }
    const nearBottom = this.listEl.scrollHeight - this.listEl.scrollTop - this.listEl.clientHeight < 80;
    const entries = await this.plugin.store.recentChat(p.folder, this.showAll ? 100000 : 200);
    this.render(entries);
    if (reset || nearBottom) this.listEl.scrollTop = this.listEl.scrollHeight;
  }

  private render(entries: Entry[]) {
    this.liveEl = null;
    this.removeChild(this.md);
    this.md = new Component();
    this.addChild(this.md);
    const list = this.listEl;
    list.empty();
    if (!entries.length) {
      const empty = list.createDiv("cd-empty");
      empty.createDiv({ cls: "cd-empty-title", text: "Start talking about this project" });
      empty.createDiv({
        text: "Ask questions, mention new facts, add tasks with /t and notes with /n. Everything gets filed for you.",
      });
      return;
    }
    if (!this.showAll && entries.length >= 200) {
      const more = list.createDiv({ cls: "cd-more", text: "Show older messages" });
      more.onClickEvent(() => {
        this.showAll = true;
        this.reload(false);
      });
    }
    let day = "";
    const today = isoDate();
    for (const e of entries) {
      const d = e.datetime.slice(0, 10);
      if (d !== day) {
        day = d;
        list.createDiv({ cls: "cd-day", text: d === today ? "Today" : whenLabel(e.datetime, today) });
      }
      this.renderEntry(e);
    }
    if (this.liveText) this.renderLive();
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
    if (!this.pending) {
      this.busyEl.hide();
      return;
    }
    const text = status || (this.liveText ? "" : "Thinking…");
    this.busyEl.setText(text);
    this.busyEl.toggle(!!text);
  }

  private renderEntry(e: Entry) {
    const p = this.plugin.active()!;
    if (e.kind === "me" || e.kind === "ai") {
      // A turn: the message, then a row with its time and copy, shown on hover (as in Claude).
      const turn = this.listEl.createDiv({ cls: `cd-turn cd-turn-${e.kind}`, attr: { "data-id": e.id } });
      const el = turn.createDiv(`cd-msg cd-${e.kind}`);
      let copyText = e.body;
      if (e.kind === "me") {
        const { text, files } = splitEmbeds(e.body);
        if (text) appendLinkified(el.createDiv("cd-msg-body"), text);
        renderAttachments(this.app, el, files);
        if (/^\/[tn](\s|$)/.test(e.body)) el.addClass("is-command");
        copyText = text;
      } else {
        MarkdownRenderer.render(this.app, e.body, el.createDiv("cd-msg-body"), p.folder, this.md);
      }
      const actions = turn.createDiv("cd-msg-actions");
      actions.createSpan({ cls: "cd-msg-time", text: e.datetime.slice(11, 16), attr: { title: fullDateLabel(e.datetime) } });
      if (copyText) this.copyButton(actions, copyText);
      return;
    }
    const el = this.listEl.createDiv({ cls: `cd-msg cd-${e.kind}`, attr: { "data-id": e.id, title: fullDateLabel(e.datetime) } });
    if (e.kind === "receipt") {
      const body = el.createDiv("cd-receipt-body");
      MarkdownRenderer.render(this.app, e.body, body, p.folder, this.md);
      if (e.body.startsWith("Undone: ")) el.addClass("is-undone");
      else if (this.plugin.controller.canUndo(e.id)) {
        const undo = el.createEl("a", { cls: "cd-undo", text: "undo" });
        undo.onClickEvent(() => this.plugin.controller.undo(p, e));
      }
    } else if (e.kind === "error") {
      setIcon(el.createSpan("cd-error-icon"), "alert-circle");
      el.createSpan({ text: ` ${e.body}` });
    }
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
    this.searchInput = this.searchEl.createEl("input", { type: "search", cls: "cd-search-input", attr: { placeholder: "Search this chat" } });
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
      this.searchInput.placeholder = cb.checked ? "Search all projects" : "Search this chat";
      this.runSearch();
    });
    close.onClickEvent(() => this.closeSearch());

    this.scope = new Scope(this.app.scope);
    this.scope.register(["Mod"], "f", () => {
      this.openSearch();
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
    for (const { folder, entry } of hits) {
      const row = this.resultsEl.createDiv("cd-result");
      const meta = row.createDiv("cd-result-meta");
      if (this.searchAll) {
        const p = this.plugin.projects.find((x) => x.folder === folder);
        const tag = meta.createSpan("cd-result-project");
        tag.style.setProperty("--cd-color", p?.color ?? "var(--text-faint)");
        tag.createSpan("cd-dot");
        tag.createSpan({ text: p?.name ?? folder });
      }
      meta.createSpan({ text: entry.kind === "me" ? "You" : "AI" });
      meta.createSpan({ text: whenLabel(entry.datetime) });
      const text = row.createDiv("cd-result-text");
      for (const part of snippetParts(splitEmbeds(entry.body).text, words)) {
        if (part.hit) text.createEl("mark", { text: part.text });
        else text.appendText(part.text);
      }
      row.onClickEvent(() => this.openResult(folder, entry.id));
    }
  }

  private async openResult(folder: string, id: string) {
    if (folder !== this.folder) {
      await this.plugin.setActive(folder);
      await this.reload(true);
    }
    this.scrollToMessage(id);
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
    if (ev.isComposing) return;
    const value = this.inputEl.value;
    if (ev.key === "Escape" && this.block) {
      ev.preventDefault();
      if (value.trim() && !window.confirm(`Discard ${value.trim().split("\n").length} line(s)?`)) return;
      this.exitBlock();
      return;
    }
    if (ev.key !== "Enter") return;
    if (this.block) {
      if (ev.metaKey || ev.ctrlKey) {
        ev.preventDefault();
        this.submitBlock(closeBlock(value) ?? value);
        return;
      }
      const closed = closeBlock(value);
      if (closed !== null && !ev.shiftKey) {
        ev.preventDefault();
        this.submitBlock(closed);
      }
      return; // plain Enter = new line inside a block
    }
    if (ev.shiftKey) return;
    ev.preventDefault();
    const opener = blockOpener(value);
    if (opener) {
      this.block = opener;
      this.inputEl.value = "";
      this.renderHint();
      this.autosize();
      return;
    }
    if (!value.trim() && !this.files.length) return;
    this.inputEl.value = "";
    this.autosize();
    this.enqueue(value);
  }

  private onInput() {
    if (this.block) {
      const lines = this.inputEl.value.split("\n");
      if (lines.length > 1 && lines[lines.length - 1].trim() === "//") {
        this.submitBlock(lines.slice(0, -1).join("\n"));
        return;
      }
    }
    this.autosize();
  }

  private submitBlock(content: string) {
    const kind = this.block;
    if (!kind) return;
    this.exitBlock();
    if (!content.trim() && !this.files.length) return;
    this.enqueue(`/${kind === "task" ? "t" : "n"}\n${content.replace(/\s+$/, "")}\n//`);
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
    this.pending++;
    this.busyEl.setText("Thinking…");
    this.busyEl.toggle(!/^\/[tn]\b/.test(text.trim()) || this.pending > 1);
    this.queue = this.queue
      .then(async () => this.plugin.controller.send(p, text, await uploads))
      .catch((e) => console.error("ClearDesk:", e))
      .finally(() => {
        this.pending--;
        if (!this.pending) {
          this.liveText = null;
          this.busyEl.hide();
        }
      });
  }

  async onClose() {
    this.md.unload();
  }
}
