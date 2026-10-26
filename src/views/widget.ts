// Draws a widget in a sandboxed frame: scripts run, but it can't reach ClearDesk, Obsidian,
// the vault or the network (see WIDGET_CSP), and it can't open pop-ups or forms.
import { App, MarkdownRenderChild, Modal, TFile, debounce, setIcon } from "obsidian";
import { WidgetSpec, WidgetTheme, widgetDoc, widgetInNote } from "../widget";

const MAX_HEIGHT = 600;

function theme(): WidgetTheme {
  const css = getComputedStyle(document.body);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    text: v("--text-normal", "#222"),
    muted: v("--text-muted", "#666"),
    faint: v("--text-faint", "#999"),
    background: v("--background-primary", "#fff"),
    surface: v("--background-secondary", "#f4f4f4"),
    border: v("--background-modifier-border", "#ddd"),
    accent: v("--interactive-accent", "#7f6df2"),
    font: v("--font-interface", "system-ui, sans-serif"),
    size: v("--font-ui-medium", "14px"),
  };
}

/**
 * A sandboxed frame showing the widget. Each time the widget's own page loads, its helper
 * script says "ready" once. The frame's "load" and that "ready" can arrive in either order, so
 * they're counted: if, a moment after a load, there have been fewer readies than loads, the
 * frame is showing some other page and `onStopped` runs. (Reloads, e.g. when the frame is
 * moved in the page, are harmless: they say "ready" too.)
 */
function frameFor(w: WidgetSpec, id: string, onStopped: () => void): { frame: HTMLIFrameElement; ready: () => void } {
  const frame = createEl("iframe", { cls: "cd-widget-frame" });
  // allow-scripts only: no same-origin access, top navigation, pop-ups, forms, modals or downloads.
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("title", w.title);
  let loads = 0;
  let readies = 0;
  frame.addEventListener("load", () => {
    const expected = ++loads;
    window.setTimeout(() => {
      if (frame.isConnected && readies < expected) onStopped();
    }, 2500);
  });
  frame.srcdoc = widgetDoc(w, theme(), id);
  return { frame, ready: () => void readies++ };
}

export interface WidgetActions {
  app: App;
  /** Keep a one-off widget as a project file (not offered inside a widget file). */
  save?: (w: WidgetSpec) => void;
}

export class WidgetChild extends MarkdownRenderChild {
  private frame?: HTMLIFrameElement;
  private ready?: () => void;
  private id = Math.random().toString(36).slice(2);
  private current?: { w: WidgetSpec; file?: string };
  private themeKey = "";

  constructor(el: HTMLElement, private source: { spec: WidgetSpec } | { file: string }, private actions: WidgetActions) {
    super(el);
  }

  async onload() {
    // Light/dark or theme changes: redraw with the new colours. Obsidian announces style
    // changes often, so only when the colours or font actually differ (a redraw resets the widget).
    this.registerEvent(this.actions.app.workspace.on("css-change", () => {
      const now = JSON.stringify(theme());
      if (this.current && now !== this.themeKey) this.draw(this.current.w, this.current.file);
    }));
    this.registerDomEvent(window, "message", (ev: MessageEvent) => {
      if (!this.frame || ev.source !== this.frame.contentWindow) return;
      const data = ev.data as { cdWidget?: string; height?: number; ready?: boolean } | null;
      if (data?.cdWidget !== this.id) return;
      if (data.ready) this.ready?.();
      const h = Number(data.height);
      if (Number.isFinite(h)) this.frame.style.height = `${Math.min(Math.max(h, 40), MAX_HEIGHT)}px`;
    });
    if ("spec" in this.source) return this.draw(this.source.spec);
    // A saved widget: draw the file as it is now, and again whenever it changes.
    const path = this.source.file;
    const redraw = debounce(() => this.drawFile(path), 300, true);
    this.registerEvent(this.actions.app.vault.on("modify", (f) => { if (f.path === path) redraw(); }));
    await this.drawFile(path);
  }

  private async drawFile(path: string) {
    const f = this.actions.app.vault.getAbstractFileByPath(path);
    const w = f instanceof TFile ? widgetInNote(await this.actions.app.vault.cachedRead(f)) : null;
    if (w) return this.draw(w, path);
    this.containerEl.empty();
    this.containerEl.createDiv({ cls: "cd-widget-stopped", text: `The saved widget ${path} isn't there any more.` });
  }

  private draw(w: WidgetSpec, file?: string) {
    this.current = { w, file };
    this.themeKey = JSON.stringify(theme());
    this.containerEl.empty();
    const box = this.containerEl.createDiv("cd-widget");
    const head = box.createDiv("cd-widget-head");
    setIcon(head.createSpan("cd-widget-icon"), "app-window");
    if (file) {
      // A saved widget: its title opens the file.
      const a = head.createEl("a", { cls: "cd-widget-title internal-link", text: w.title, attr: { "data-href": file, href: file } });
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.actions.app.workspace.openLinkText(file, "", "tab");
      });
      head.createSpan({ cls: "cd-map-saved", text: "saved widget" });
    } else {
      head.createSpan({ cls: "cd-widget-title", text: w.title });
      if (this.actions.save) {
        const save = head.createSpan({ cls: "cd-map-save", attr: { "aria-label": "Keep this widget in the project's Widgets folder" } });
        setIcon(save.createSpan(), "bookmark-plus");
        save.createSpan({ text: "Save to project" });
        save.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this.actions.save!(w);
        });
      }
    }
    const big = head.createSpan({ cls: "cd-icon-btn cd-widget-open", attr: { "aria-label": "Open larger" } });
    setIcon(big, "maximize-2");
    big.addEventListener("click", (ev) => {
      ev.stopPropagation();
      new WidgetModal(this.actions.app, w).open();
    });
    const { frame, ready } = frameFor(w, this.id, () => this.stop(box));
    this.frame = frame;
    this.ready = ready;
    box.appendChild(frame);
  }

  private stop(box: HTMLElement) {
    this.frame?.remove();
    this.frame = undefined;
    box.createDiv({ cls: "cd-widget-stopped", text: "This widget tried to leave its frame, so it was stopped." });
  }
}

class WidgetModal extends Modal {
  constructor(app: App, private w: WidgetSpec) {
    super(app);
  }

  onOpen() {
    this.modalEl.addClass("cd-widget-modal");
    this.titleEl.setText(this.w.title);
    const id = `modal-${Math.random().toString(36).slice(2)}`;
    const { frame, ready } = frameFor(this.w, id, () => {
      frame.remove();
      this.contentEl.createDiv({ cls: "cd-widget-stopped", text: "This widget tried to leave its frame, so it was stopped." });
    });
    const onMessage = (ev: MessageEvent) => {
      const data = ev.data as { cdWidget?: string; ready?: boolean } | null;
      if (ev.source === frame.contentWindow && data?.cdWidget === id && data.ready) ready();
    };
    window.addEventListener("message", onMessage);
    this.stopListening = () => window.removeEventListener("message", onMessage);
    this.contentEl.appendChild(frame);
  }

  private stopListening?: () => void;

  onClose() {
    this.stopListening?.();
    this.contentEl.empty();
  }
}
