// Interactive widgets Claude writes (calculators, charts, scorecards): a small self-contained
// page, shown in a sandboxed, offline frame. Saved in the reply like maps:
//
//   ```cleardesk-widget
//   {"title":"Mortgage calculator","description":"Sliders for price, rate and term","html":"<div>…</div><script>…</script>"}
//   ```

export const WIDGET_BLOCK = "cleardesk-widget";
export const WIDGET_MAX_BYTES = 100_000;

export interface WidgetSpec {
  title: string;
  /** One line on what it does: what Claude sees later instead of the code. */
  description: string;
  /** Body content: markup with inline <style> and <script>. */
  html: string;
}

export function widgetFromInput(input: Record<string, unknown>): WidgetSpec | { error: string } {
  const s = (k: string) => String(input[k] ?? "").trim();
  const html = s("html");
  if (!html) return { error: "The widget needs html." };
  if (new TextEncoder().encode(html).length > WIDGET_MAX_BYTES) return { error: "The widget is over 100 KB. Make it smaller." };
  if (/<(script|link|img|iframe)[^>]+(src|href)\s*=\s*["']?\s*(https?:)?\/\//i.test(html) || /@import\s+(url\()?["']?(https?:)?\/\//i.test(html)) {
    return { error: "Widgets run offline: inline everything (no external scripts, styles, images or fonts)." };
  }
  return { title: (s("title") || "Widget").slice(0, 120), description: s("description").slice(0, 300), html };
}

export function widgetBlock(w: WidgetSpec): string {
  return "```" + WIDGET_BLOCK + "\n" + JSON.stringify(w) + "\n```";
}

export function parseWidget(src: string): WidgetSpec | null {
  try {
    const o = JSON.parse(src);
    return o && typeof o.html === "string" ? { title: String(o.title ?? "Widget"), description: String(o.description ?? ""), html: o.html } : null;
  } catch {
    return null;
  }
}

/** A saved widget in the project: `Widgets/<title>.md`, shared by all chats. */
export const WIDGETS_DIR = "Widgets";

export function widgetFileName(title: string): string {
  const clean = title.replace(/[\\/:*?"<>|#^[\]]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return `${WIDGETS_DIR}/${clean || "Widget"}.md`;
}

/** A heading first, so a newly opened file shows the widget rather than its code. */
export function widgetFile(w: WidgetSpec): string {
  return `# ${w.title}\n\n${w.description ? w.description + "\n\n" : ""}${widgetBlock(w)}\n`;
}

/** In a chat reply: shows the saved widget's current version, wherever it's drawn. */
export function widgetRef(path: string): string {
  return "```" + WIDGET_BLOCK + "\n" + JSON.stringify({ file: path }) + "\n```";
}

export function widgetRefPath(src: string): string | null {
  try {
    const o = JSON.parse(src);
    return o && typeof o.file === "string" && typeof o.html !== "string" ? o.file : null;
  } catch {
    return null;
  }
}

/** The widget in a saved widget file. */
export function widgetInNote(text: string): WidgetSpec | null {
  const m = new RegExp("```" + WIDGET_BLOCK + "\\n([\\s\\S]*?)\\n```").exec(text);
  return m ? parseWidget(m[1]) : null;
}

/** A saved widget file (Claude reads its code to change it). */
export const isWidgetFile = (path: string) => new RegExp(`(^|/)${WIDGETS_DIR}/[^/]+\\.md$`).test(path);

/** What Claude sees later in the conversation, and what search and copy use. */
export function widgetText(w: WidgetSpec): string {
  return `Widget: ${w.title}${w.description ? ` — ${w.description}` : ""}`;
}

/** Theme values passed into the frame (it can't read Obsidian's CSS). */
export interface WidgetTheme {
  text: string;
  muted: string;
  faint: string;
  background: string;
  surface: string;
  border: string;
  accent: string;
  font: string;
  size: string;
}

/** No network of any kind: only inline scripts and styles, and data: images and fonts. */
export const WIDGET_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; " +
  "connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'";

/** The full page for the frame: offline policy, theme, the widget, and size reporting. */
export function widgetDoc(w: WidgetSpec, theme: WidgetTheme, id: string): string {
  const css = `:root{--text:${theme.text};--muted:${theme.muted};--faint:${theme.faint};--bg:${theme.background};--surface:${theme.surface};--border:${theme.border};--accent:${theme.accent};--font:${theme.font}}
*{box-sizing:border-box}html,body{margin:0;background:transparent}body{padding:10px;color:var(--text);font-family:var(--font);font-size:${theme.size};line-height:1.45}
input,select,button,textarea{font:inherit;color:inherit}button{cursor:pointer}a{color:var(--accent)}`;
  // Says it's ready (so ClearDesk knows the frame still shows this widget), reports its height,
  // and keeps links and forms from leaving the frame.
  const glue = `<script>(()=>{const id=${JSON.stringify(id)};const send=()=>parent.postMessage({cdWidget:id,height:Math.ceil(document.documentElement.scrollHeight)},"*");
parent.postMessage({cdWidget:id,ready:true},"*");new ResizeObserver(send).observe(document.documentElement);addEventListener("load",send);send();
addEventListener("click",e=>{const a=e.target.closest&&e.target.closest("a[href]");if(a&&!a.getAttribute("href").startsWith("#"))e.preventDefault();},true);
addEventListener("submit",e=>e.preventDefault(),true);})();</script>`;
  // The helper goes first, so an unclosed tag in the widget can't swallow it.
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${WIDGET_CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style>${glue}</head><body>${w.html}</body></html>`;
}
