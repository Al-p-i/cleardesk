import { test } from "node:test";
import assert from "node:assert/strict";
import { WIDGET_CSP, isWidgetFile, parseWidget, widgetBlock, widgetDoc, widgetFile, widgetFileName, widgetFromInput, widgetInNote, widgetRef, widgetRefPath, widgetText, type WidgetSpec } from "../src/widget.ts";
import { blocksAsText } from "../src/map.ts";

const theme = { text: "#222", muted: "#666", faint: "#999", background: "#fff", surface: "#eee", border: "#ddd", accent: "#7f6df2", font: "Inter", size: "14px" };

test("widgets from the tool: self-contained only, and not too big", () => {
  const ok = widgetFromInput({ title: "Mortgage", description: "Sliders for price, rate, term", html: "<input type=range><script>1</script>" }) as WidgetSpec;
  assert.deepEqual(ok, { title: "Mortgage", description: "Sliders for price, rate, term", html: "<input type=range><script>1</script>" });
  const err = (input: Record<string, unknown>) => (widgetFromInput(input) as { error: string }).error;
  assert.match(err({ title: "x", html: "" }), /needs html/);
  assert.match(err({ html: "x".repeat(100_001) }), /100 KB/);
  assert.match(err({ html: '<script src="https://cdn.example.com/chart.js"></script>' }), /offline/);
  assert.match(err({ html: "<link rel=stylesheet href=//fonts.example.com/a.css>" }), /offline/);
  assert.match(err({ html: "<style>@import url('https://x.example/y.css')</style>" }), /offline/);
  assert.equal((widgetFromInput({ html: "<b>hi</b>" }) as WidgetSpec).title, "Widget");
});

test("the frame's page: offline policy first, theme, the widget, size reporting", () => {
  const w: WidgetSpec = { title: "T", description: "d", html: "<div id=app>hello</div>" };
  const doc = widgetDoc(w, theme, "abc");
  assert.ok(doc.indexOf("Content-Security-Policy") < doc.indexOf("<div id=app>"), "the policy applies before any widget code");
  assert.match(WIDGET_CSP, /default-src 'none'/);
  assert.match(WIDGET_CSP, /connect-src 'none'/);
  assert.ok(!/https?:/.test(WIDGET_CSP), "no site is allowed");
  assert.match(doc, /--text:#222;.*--accent:#7f6df2;--font:Inter/);
  assert.match(doc, /cdWidget:id/);
  assert.match(doc, /parent\.postMessage\(\{cdWidget:id,ready:true\}/, "says it's ready on every load, so reloads aren't mistaken for leaving");
  assert.ok(doc.indexOf("ready:true") < doc.indexOf("<div id=app>"), "the helper comes before the widget, so a broken widget can't swallow it");
  assert.ok(doc.indexOf("Content-Security-Policy") < doc.indexOf("ready:true"), "and after the offline policy");
  assert.match(doc, /const id="abc"/);
});

test("what Claude, search and copy see of a widget", () => {
  const w: WidgetSpec = { title: "Flat scorecard", description: "Weights for price, size and commute", html: "<p>x</p>" };
  assert.equal(widgetText(w), "Widget: Flat scorecard — Weights for price, size and commute");
  const block = widgetBlock(w);
  assert.deepEqual(parseWidget(block.split("\n").slice(1, -1).join("\n")), w);
  assert.equal(blocksAsText(`Here.\n\n${block}`), "Here.\n\n[Widget: Flat scorecard — Weights for price, size and commute]");
});

test("saved widgets: a file per title, and live references from the chat", () => {
  const w: WidgetSpec = { title: "Mortgage: 2026", description: "Sliders for price, rate and term", html: "<input type=range>" };
  assert.equal(widgetFileName(w.title), "Widgets/Mortgage 2026.md");
  assert.equal(widgetFileName(""), "Widgets/Widget.md");
  const file = widgetFile(w);
  assert.ok(file.startsWith("# Mortgage: 2026\n\nSliders for price, rate and term\n\n```cleardesk-widget\n"), "heading first, so the widget shows when the file opens");
  assert.deepEqual(widgetInNote(file), w);
  const ref = widgetRef("APARTMENTS/Widgets/Mortgage 2026.md");
  assert.equal(widgetRefPath(ref.split("\n")[1]), "APARTMENTS/Widgets/Mortgage 2026.md");
  assert.equal(widgetRefPath(JSON.stringify(w)), null, "a widget itself isn't a reference");
  assert.equal(blocksAsText(`Saved.\n\n${ref}`), "Saved.\n\n[Saved widget, always current: APARTMENTS/Widgets/Mortgage 2026.md]");
  assert.ok(isWidgetFile("APARTMENTS/Widgets/Mortgage 2026.md") && !isWidgetFile("APARTMENTS/Notes/x.md"));
});
