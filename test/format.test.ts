import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendEntry, appendTasks, daysUntil, dueLabel, parseEntries, parseTaskLine, parseTasks,
  plainLinks, serializeTask, sortOpenTasks, splitFrontmatter, updateEntry, updateTask, whenLabel,
  type Entry,
} from "../src/format.ts";
import { blockItems, blockOpener, closeBlock, parseMessage } from "../src/input.ts";

const note: Entry = {
  id: "n-abc123", datetime: "2026-10-17 15:10", kind: "note", tag: "Kreuzberg",
  body: "great light\nstreet is loud", meta: {},
};
const fact: Entry = {
  id: "f-def456", datetime: "2026-10-17 14:32", kind: "fact", tag: "Mitte",
  body: "Deposit is 3 months' rent", meta: { source: "[[A/_project/chat/2026-10#^m-x1|chat]]" },
};

test("entries round-trip, including meta and multi-line bodies", () => {
  const text = appendEntry(appendEntry("# Notes\n", note), fact);
  const parsed = parseEntries(text);
  assert.deepEqual(parsed, [note, fact]);
  assert.ok(text.startsWith("# Notes\n\n### 2026-10-17 15:10 · note · Kreuzberg ^n-abc123\n"));
});

test("entry without tag, and body lines that look like headings stay in the body", () => {
  const e: Entry = { ...note, tag: "", body: "### not a heading\nprice:: 1400 stays in body" };
  const parsed = parseEntries(appendEntry("", e));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].tag, "");
  assert.equal(parsed[0].body, e.body);
  assert.deepEqual(parsed[0].meta, {});
});

test("updateEntry edits and deletes by id, keeping the preamble", () => {
  const text = appendEntry(appendEntry("# Notes", note), fact);
  const edited = updateEntry(text, "f-def456", (e) => ({ ...e, body: "Deposit is 2x" }));
  assert.equal(parseEntries(edited)[1].body, "Deposit is 2x");
  assert.ok(edited.startsWith("# Notes\n\n"));
  const deleted = updateEntry(text, "n-abc123", () => null);
  assert.deepEqual(parseEntries(deleted).map((e) => e.id), ["f-def456"]);
});

test("task lines parse and serialize in Tasks-plugin order", () => {
  const line = "- [ ] Send payslips 🔗 [[A/_project/chat/2026-10#^m-x1|chat]] 📅 2026-10-20 ^t-aa11bb";
  const t = parseTaskLine(line)!;
  assert.equal(t.text, "Send payslips");
  assert.equal(t.due, "2026-10-20");
  assert.equal(t.id, "t-aa11bb");
  assert.equal(t.source, "[[A/_project/chat/2026-10#^m-x1|chat]]");
  assert.equal(serializeTask(t), line);
  const done = parseTaskLine("- [x] Call agency ✅ 2026-10-17")!;
  assert.equal(done.done, true);
  assert.equal(done.doneDate, "2026-10-17");
  assert.equal(parseTaskLine("just text"), null);
  assert.equal(parseTaskLine("  * [X] nested star")!.done, true);
});

test("updateTask toggles by id or raw line, and deletes", () => {
  let text = appendTasks("# Tasks", [
    { raw: "", done: false, text: "A", id: "t-1a" },
    { raw: "", done: false, text: "B", due: "2026-10-19" },
  ]);
  const [a, b] = parseTasks(text);
  text = updateTask(text, a, (t) => ({ ...t, done: true, doneDate: "2026-10-17" }));
  text = updateTask(text, b, () => null);
  assert.deepEqual(parseTasks(text).map((t) => [t.text, t.done]), [["A", true]]);
  assert.ok(text.includes("- [x] A ✅ 2026-10-17 ^t-1a"));
});

test("sorting and date labels", () => {
  const tasks = parseTasks("- [ ] none\n- [ ] late 📅 2026-10-10\n- [ ] soon 📅 2026-10-18");
  assert.deepEqual(sortOpenTasks(tasks).map((t) => t.text), ["late", "soon", "none"]);
  assert.equal(daysUntil("2026-10-10", "2026-10-17"), -7);
  assert.equal(dueLabel("2026-10-16", "2026-10-17"), "-1d");
  assert.equal(dueLabel("2026-10-17", "2026-10-17"), "today");
  assert.equal(dueLabel("2026-10-18", "2026-10-17"), "tmrw");
  assert.equal(dueLabel("2026-10-23", "2026-10-17"), "Fri");
  assert.equal(dueLabel("2026-11-02", "2026-10-17"), "Nov 2");
  assert.equal(whenLabel("2026-10-17 14:32", "2026-10-17"), "today 14:32");
  assert.equal(whenLabel("2026-10-12 09:00", "2026-10-17"), "Oct 12");
});

test("plainLinks and frontmatter split", () => {
  assert.equal(plainLinks("see [[a/b/Note|Label]] and [[x/Other#^id]]"), "see Label and Other");
  assert.deepEqual(splitFrontmatter("---\ngoal: x\n---\nbody\n"), { yaml: "goal: x", body: "body\n" });
  assert.deepEqual(splitFrontmatter("no fm"), { yaml: "", body: "no fm" });
});

test("command parsing: single lines, blocks, closers", () => {
  assert.deepEqual(parseMessage("/t send payslips mon"), { kind: "task", items: ["send payslips mon"] });
  assert.deepEqual(parseMessage("/n kreuzberg is loud"), { kind: "note", items: ["kreuzberg is loud"] });
  assert.deepEqual(parseMessage("/t\n- a\n2. b\n\nc\n//"), { kind: "task", items: ["a", "b", "c"] });
  assert.deepEqual(parseMessage("/n\nline one\nline two //"), { kind: "note", items: ["line one\nline two"] });
  assert.deepEqual(parseMessage("what is the rent?"), { kind: "chat", items: ["what is the rent?"] });
  assert.deepEqual(parseMessage("/tomorrow is a word"), { kind: "chat", items: ["/tomorrow is a word"] });
  assert.equal(blockOpener(" /t "), "task");
  assert.equal(blockOpener("/t x"), null);
  assert.equal(closeBlock("a\nhttps://x.com"), null);
  assert.equal(closeBlock("a\nb //"), "a\nb");
  assert.equal(closeBlock("a\n//\n"), "a");
  assert.deepEqual(blockItems("note", "\n\n"), []);
});

import { cleanKey, keyProblem } from "../src/key.ts";

test("API key checks", () => {
  assert.equal(keyProblem("sk-ant-test-abcDEF_123-xyz"), null);
  assert.match(keyProblem("")!, /Add your Anthropic API key/);
  assert.match(keyProblem("I don’t have a key yet")!, /spaces or special characters/);
  assert.match(keyProblem("abc123")!, /start with sk-ant-/);
  assert.equal(cleanKey(" sk-ant-abc​\n"), "sk-ant-abc");
});

import { cleanExport, googleExportUrl, looksLikeLoginPage } from "../src/google.ts";

test("Google links map to export URLs", () => {
  const id = "1AbCdEfGhIjKlMnOpQrStUv";
  assert.deepEqual(googleExportUrl(`https://docs.google.com/document/d/${id}/edit?tab=t.abc123def#heading=h.8t6c`), {
    kind: "doc", id, url: `https://docs.google.com/document/d/${id}/export?format=md&tab=t.abc123def`, part: "tab t.abc123def",
  });
  assert.equal(googleExportUrl(`https://docs.google.com/document/d/${id}/edit`)!.url, `https://docs.google.com/document/d/${id}/export?format=md`);
  assert.equal(googleExportUrl(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=42`)!.url, `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=42`);
  assert.equal(googleExportUrl(`https://docs.google.com/presentation/d/${id}/edit#slide=id.p`)!.url, `https://docs.google.com/presentation/d/${id}/export/txt`);
  assert.equal(googleExportUrl(`https://drive.google.com/file/d/${id}/view?usp=sharing`)!.url, `https://drive.google.com/uc?export=download&id=${id}`);
  assert.equal(googleExportUrl("https://example.com/doc"), null);
  assert.equal(googleExportUrl("not a url"), null);
});

test("export cleanup and sign-in detection", () => {
  const md = "# T\n\n![][image1]\n\ntext\n\n[image1]: <data:image/png;base64,AAAA>\n";
  assert.equal(cleanExport(md), "# T\n\n![][image1]\n\ntext");
  assert.equal(cleanExport("a ![logo](data:image/png;base64,AAA) b"), "a [image: logo] b");
  assert.ok(looksLikeLoginPage("text/html; charset=utf-8", '<a href="https://accounts.google.com/signin">'));
  assert.ok(!looksLikeLoginPage("text/x-markdown", "accounts.google.com"));
});

import { splitUrls } from "../src/format.ts";

test("URLs are split out of plain text", () => {
  assert.deepEqual(splitUrls("see https://docs.google.com/document/d/abc/edit?tab=t.1#h=2, ok"), [
    { text: "see " },
    { text: "https://docs.google.com/document/d/abc/edit?tab=t.1#h=2", url: "https://docs.google.com/document/d/abc/edit?tab=t.1#h=2" },
    { text: ", ok" },
  ]);
  assert.deepEqual(splitUrls("(https://en.wikipedia.org/wiki/Foo_(bar))."), [
    { text: "(" },
    { text: "https://en.wikipedia.org/wiki/Foo_(bar)", url: "https://en.wikipedia.org/wiki/Foo_(bar)" },
    { text: ")." },
  ].map((x: any) => x));
  assert.deepEqual(splitUrls("no links here"), [{ text: "no links here" }]);
});

import { splitEmbeds, withEmbeds } from "../src/format.ts";

test("attachments as trailing embeds", () => {
  const body = withEmbeds("what is this?", ["A/Attachments/shot.png", "A/Attachments/lease.pdf"]);
  assert.equal(body, "what is this?\n![[A/Attachments/shot.png]]\n![[A/Attachments/lease.pdf]]");
  assert.deepEqual(splitEmbeds(body), { text: "what is this?", files: ["A/Attachments/shot.png", "A/Attachments/lease.pdf"] });
  assert.deepEqual(splitEmbeds("![[x.png]]"), { text: "", files: ["x.png"] });
  assert.deepEqual(splitEmbeds("see ![[x.png]] inline"), { text: "see ![[x.png]] inline", files: [] });
  assert.equal(withEmbeds("", []), "");
});

import { hostOf, linkLabel, moveEntry, pageTitle, shiftEntry } from "../src/format.ts";

test("reordering entries", () => {
  const mk = (id: string): Entry => ({ id, datetime: "2026-10-17 10:00", kind: "note", tag: "", body: id, meta: {} });
  let text = ["n-aaaaaa", "n-bbbbbb", "n-cccccc"].map(mk).reduce((t, e) => appendEntry(t, e), "# Notes");
  const order = (t: string) => parseEntries(t).map((e) => e.id[2]);
  assert.deepEqual(order(moveEntry(text, "n-aaaaaa", "n-cccccc", "after")), ["b", "c", "a"]);
  assert.deepEqual(order(moveEntry(text, "n-cccccc", "n-aaaaaa", "before")), ["c", "a", "b"]);
  assert.deepEqual(order(moveEntry(text, "n-bbbbbb", "n-bbbbbb", "after")), ["a", "b", "c"]);
  assert.deepEqual(order(shiftEntry(text, "n-bbbbbb", 1)), ["a", "c", "b"]);
  assert.deepEqual(order(shiftEntry(text, "n-aaaaaa", -1)), ["a", "b", "c"]);
  assert.ok(moveEntry(text, "n-aaaaaa", "n-cccccc", "after").startsWith("# Notes\n\n"));
});

test("link entries and page titles", () => {
  const e: Entry = { id: "l-abc123", datetime: "2026-10-17 10:00", kind: "link", tag: "Mitte", body: "Mitte listing", meta: { url: "https://x.com/a?b=1" } };
  assert.deepEqual(parseEntries(appendEntry("", e)), [e]);
  assert.equal(pageTitle('<html><head><title>Apartment shortlist - Google Docs</title></head>'), "Apartment shortlist");
  assert.equal(pageTitle('<meta property="og:title" content="2BR in Mitte &amp; garden"><title>ignored</title>'), "2BR in Mitte & garden");
  assert.equal(pageTitle("<p>no title</p>"), "");
  assert.equal(linkLabel("https://www.immobilienscout24.de/expose/123"), "immobilienscout24.de/expose/123");
  assert.equal(hostOf("https://www.zillow.com/x"), "zillow.com");
});

import { agoLabel, updatedLabel } from "../src/format.ts";

test("last-update labels", () => {
  const now = new Date(2026, 9, 17, 23, 0).getTime(); // Sat Oct 17 2026, 23:00
  const at = (...a: number[]) => new Date(...(a as [number, number, number, number, number])).getTime();
  assert.equal(agoLabel(now - 20_000, now), "now");
  assert.equal(agoLabel(now - 5 * 60_000, now), "5m");
  assert.equal(agoLabel(at(2026, 9, 17, 8, 0), now), "15h");
  assert.equal(agoLabel(at(2026, 9, 16, 23, 30), now), "yesterday");
  assert.equal(agoLabel(at(2026, 9, 12, 9, 0), now), "Mon");
  assert.equal(agoLabel(at(2026, 8, 30, 9, 0), now), "Sep 30");
  assert.equal(agoLabel(at(2025, 11, 1, 9, 0), now), "Dec 1 2025");
  assert.equal(updatedLabel(now - 3 * 3_600_000, now), "Updated 3h ago");
  assert.equal(updatedLabel(now, now), "Updated just now");
  assert.equal(updatedLabel(at(2026, 9, 16, 9, 0), now), "Updated yesterday");
  assert.equal(updatedLabel(at(2026, 8, 30, 9, 0), now), "Updated Sep 30");
});

import { matchesAll, queryWords, snippetParts } from "../src/format.ts";

test("chat search matching and snippets", () => {
  const w = queryWords('  Deposit "Mitte" ');
  assert.deepEqual(w, ["deposit", "mitte"]);
  assert.ok(matchesAll("The deposit for Mitte is 3x rent", w));
  assert.ok(!matchesAll("The deposit for Kreuzberg", w));
  assert.ok(!matchesAll("anything", []));
  const parts = snippetParts("The deposit for Mitte is 3x rent", w);
  assert.deepEqual(parts, [
    { text: "The ", hit: false }, { text: "deposit", hit: true }, { text: " for ", hit: false },
    { text: "Mitte", hit: true }, { text: " is 3x rent", hit: false },
  ]);
  const long = "word ".repeat(60) + "needle " + "word ".repeat(60);
  const p2 = snippetParts(long, ["needle"], 20);
  assert.equal(p2[0].text, "…");
  assert.equal(p2[p2.length - 1].text, "…");
  assert.ok(p2.some((x) => x.hit && x.text === "needle"));
  assert.ok(p2.map((x) => x.text).join("").length < 60);
  assert.deepEqual(snippetParts("a+b (c)", ["+b", "(c)"]).filter((x) => x.hit).map((x) => x.text), ["+b", "(c)"]);
});

import { feedOrder } from "../src/format.ts";

test("pinned entries come first, then newest first", () => {
  const mk = (id: string, pinned = false): Entry => ({ id, datetime: "2026-10-17 10:00", kind: "note", tag: "", body: id, meta: pinned ? { pinned: "true" } : {} });
  const file = [mk("n-1", true), mk("n-2"), mk("n-3", true), mk("n-4")];
  assert.deepEqual(feedOrder(file).map((e) => e.id), ["n-3", "n-1", "n-4", "n-2"]);
  const round = parseEntries(appendEntry("", mk("n-9", true)));
  assert.equal(round[0].meta.pinned, "true");
});

import { openTasksLabel, taskCounts } from "../src/format.ts";

test("open and overdue task counts", () => {
  const tasks = parseTasks("- [ ] a 📅 2026-10-10\n- [ ] b 📅 2026-10-18\n- [ ] c\n- [x] d 📅 2026-10-01");
  assert.deepEqual(taskCounts(tasks, "2026-10-18"), { open: 3, overdue: 1 });
  assert.equal(openTasksLabel(0), "No open tasks");
  assert.equal(openTasksLabel(1), "1 open task");
  assert.equal(openTasksLabel(3), "3 open tasks");
});

import { fullDateLabel } from "../src/format.ts";

test("full date label for message times", () => {
  assert.equal(fullDateLabel("2026-10-17 14:32"), "Sat, Oct 17 2026, 14:32");
});

import { explorerScopeCss } from "../src/scope.ts";

test("explorer scope CSS", () => {
  assert.equal(explorerScopeCss(""), "");
  const css = explorerScopeCss("Work/Atlas");
  assert.ok(css.includes('[data-path="Work/Atlas"]'));
  assert.ok(css.includes('[data-path^="Work/Atlas/"]'));
  assert.ok(css.includes('[data-path="Work"]'), "ancestor stays visible");
  assert.ok(css.endsWith("{ display: none; }"));
});

import { moveTarget, projectPath, relPath } from "../src/paths.ts";

test("file tools stay inside the project folder", () => {
  const ok = (rel: string) => (projectPath("APARTMENTS", rel) as { path: string }).path;
  const err = (rel: string) => (projectPath("APARTMENTS", rel) as { error: string }).error;
  assert.equal(ok("Photos/Mitte/kitchen.jpg"), "APARTMENTS/Photos/Mitte/kitchen.jpg");
  assert.equal(ok("./Photos//a.png"), "APARTMENTS/Photos/a.png");
  assert.equal(ok("/Attachments/x.pdf"), "APARTMENTS/Attachments/x.pdf");
  assert.equal(ok(""), "APARTMENTS");
  assert.equal(ok("."), "APARTMENTS");
  assert.match(err("../1. PERSONAL/secret.md"), /outside the project/);
  assert.match(err("Photos/../../x"), /outside the project/);
  assert.match(err("_project/chat/2026-10.md"), /_project/);
  assert.match(err("a/b?.png"), /isn't a valid name/);
  assert.match(err("file:///etc/passwd"), /not a URL/);
  assert.match(err("C:/x"), /not a URL/);
  assert.equal(relPath("APARTMENTS", "APARTMENTS/Photos/a.png"), "Photos/a.png");
  assert.equal(moveTarget("APARTMENTS/Photos", "a.png", true), "APARTMENTS/Photos/a.png");
  assert.equal(moveTarget("APARTMENTS/Photos/b.png", "a.png", false), "APARTMENTS/Photos/b.png");
});

import { fingerprint, parseIndex, planRepairs, renameInIndex, rewriteLinks } from "../src/relink.ts";

test("links follow moved files", () => {
  const chat = "x\n![[A/Attachments/p 1.jpg]]\n![[A/Attachments/p 1.jpg|alt]] [[A/Attachments/p 1.jpg#^b]] ![[A/Attachments/p 10.jpg]]";
  assert.equal(
    rewriteLinks(chat, "A/Attachments/p 1.jpg", "A/Photos/kitchen.jpg"),
    "x\n![[A/Photos/kitchen.jpg]]\n![[A/Photos/kitchen.jpg|alt]] [[A/Photos/kitchen.jpg#^b]] ![[A/Attachments/p 10.jpg]]"
  );
  assert.equal(rewriteLinks("![[A/Att/x.png]] ![[A/Attic.png]]", "A/Att", "A/Files"), "![[A/Files/x.png]] ![[A/Attic.png]]");
  assert.deepEqual(renameInIndex({ "A/Att/x.png": "1:a", "A/y.png": "2:b" }, "A/Att", "A/Files"), { "A/Files/x.png": "1:a", "A/y.png": "2:b" });
  assert.deepEqual(parseIndex("not json"), {});
  const fp = fingerprint(new TextEncoder().encode("hello").buffer);
  assert.equal(fp, "5:4f9f2cab");
  assert.notEqual(fingerprint(new TextEncoder().encode("hellp").buffer), fp);
});

test("repairing broken attachment links by batch", () => {
  const at = (hm: string, s = 0) => new Date(2026, 9, 18, +hm.slice(0, 2), +hm.slice(3, 5), s).getTime();
  const old = (n: string) => `A/Attachments/${n}`;
  const missing = [
    ...[1, 2, 3, 4].map((i) => ({ path: old(`Pasted image 2026-10-18 1137 ${i}.jpg`), sent: "2026-10-18 11:37" })),
    ...[1, 2, 3, 4].map((i) => ({ path: old(`Pasted image 2026-10-18 1225 ${i}.jpg`), sent: "2026-10-18 12:25" })),
    { path: old("81403343620__15EF.mov"), sent: "2026-10-18 12:25" },
    { path: old("81404198864__AFD9.mov"), sent: "2026-10-18 14:47" }, // kept its name
    { path: old("Pasted image 2026-10-18 1447 1.jpg"), sent: "2026-10-18 14:47" },
    { path: old("me.jpg"), sent: "2026-10-17 21:10" }, // nothing to match
    { path: old("Pasted image 2026-10-18 1559.jpg"), sent: "2026-10-18 16:00" }, // file saved at 15:59:59
  ];
  const c = (path: string, ms: number) => ({ path, ctime: ms });
  const candidates = [
    c("A/Attachments/219 St Johns Pl/Kitchen.jpg", at("11:37", 2)),
    c("A/Attachments/219 St Johns Pl/Bedroom.jpg", at("11:37", 2)),
    c("A/Attachments/219 St Johns Pl/Second bedroom.jpg", at("11:37", 2)),
    c("A/Attachments/219 St Johns Pl/Living room.jpg", at("11:37", 2)),
    c("A/Attachments/87 Smith St/Video.mov", at("12:25", 37)),
    ...["Bathroom", "Kitchen", "Entry", "Second bedroom"].map((n) => c(`A/Attachments/87 Smith St/${n}.jpg`, at("12:25", 37))),
    c("A/Attachments/179 N 10th St/81404198864__AFD9.mov", at("14:47", 43)),
    c("A/Attachments/179 N 10th St/N 10th St 01.jpg", at("14:47", 42)),
    c("A/Attachments/Late.jpg", at("15:59", 59)),
  ];
  const { repairs, unresolved } = planRepairs(missing, candidates);
  const pairs = Object.fromEntries(repairs.flatMap((r) => r.pairs.map((p) => [p.from.split("/").pop(), p.to.split("/").slice(2).join("/")])));
  assert.equal(pairs["81404198864__AFD9.mov"], "179 N 10th St/81404198864__AFD9.mov", "same name wins");
  assert.equal(pairs["81403343620__15EF.mov"], "87 Smith St/Video.mov", "video pairs with video");
  assert.equal(pairs["Pasted image 2026-10-18 1447 1.jpg"], "179 N 10th St/N 10th St 01.jpg");
  assert.equal(pairs["Pasted image 2026-10-18 1559.jpg"], "Late.jpg", "minute before the message counts");
  assert.deepEqual(
    [1, 2, 3, 4].map((i) => pairs[`Pasted image 2026-10-18 1137 ${i}.jpg`]).sort(),
    ["219 St Johns Pl/Bedroom.jpg", "219 St Johns Pl/Kitchen.jpg", "219 St Johns Pl/Living room.jpg", "219 St Johns Pl/Second bedroom.jpg"]
  );
  assert.deepEqual(unresolved.map((u) => u.path), [old("me.jpg")]);
  assert.equal(repairs.length, 4); // 11:37, 12:25, 14:47, 16:00
});

import { fingerprintSize, fpOf, isRemoved, markRemoved } from "../src/relink.ts";

test("deleted attachments are marked, not forgotten", () => {
  const ix = { "A/Att/x.png": "10:aaaa", "A/Att/y.png": "20:bbbb", "A/z.png": "30:cccc" };
  const after = markRemoved(ix, "A/Att");
  assert.deepEqual(after, { "A/Att/x.png": "removed:10:aaaa", "A/Att/y.png": "removed:20:bbbb", "A/z.png": "30:cccc" });
  assert.deepEqual(markRemoved(after, "A/Att/x.png")["A/Att/x.png"], "removed:10:aaaa", "no double prefix");
  assert.ok(isRemoved(after["A/Att/x.png"]) && !isRemoved(after["A/z.png"]) && !isRemoved(undefined));
  assert.equal(fpOf("removed:10:aaaa"), "10:aaaa");
  assert.equal(fingerprintSize("removed:10:aaaa"), 10);
});

import { notesContext, noteLine, sameStatement, searchNotes } from "../src/memory.ts";

test("AI memory: pinned and recent always, the rest on demand", () => {
  const mk = (i: number, extra: Partial<Entry> = {}): Entry => ({
    id: `n-${String(i).padStart(6, "0")}`, datetime: `2026-10-${String(1 + (i % 28)).padStart(2, "0")} 10:${String(i % 60).padStart(2, "0")}`,
    kind: i % 3 === 0 ? "fact" : "note", tag: i % 2 ? "Mitte" : "Budget", body: `item ${i}`, meta: {}, ...extra,
  });
  const entries = Array.from({ length: 50 }, (_, i) => mk(i));
  entries[3] = mk(3, { meta: { pinned: "true" } }); // old but pinned
  entries[4] = mk(4, { meta: { "replaced-by": "f-x" } }); // replaced: never counted
  const ctx = notesContext(entries, 10);
  assert.equal(ctx.shown.length, 11);
  assert.equal(ctx.shown[0].id, "n-000003", "pinned first");
  assert.equal(ctx.older, 50 - 1 - 1 - 10);
  assert.deepEqual(ctx.tags, [["Mitte", 25], ["Budget", 24]], "replaced items not counted");
  assert.ok(!ctx.shown.some((e) => e.id === "n-000004"));
  assert.equal(noteLine(entries[3]), "[n-000003] 2026-10-04 10:03 fact (pinned) #Mitte: item 3");

  const notes: Entry[] = [
    { id: "f-1", datetime: "2026-10-12 10:00", kind: "fact", tag: "Mitte", body: "Heating is from 1998", meta: {} },
    { id: "n-2", datetime: "2026-10-14 10:00", kind: "note", tag: "Mitte", body: "old heating, ask about bills", meta: {} },
    { id: "l-3", datetime: "2026-10-15 10:00", kind: "link", tag: "Kreuzberg", body: "2BR listing", meta: { url: "https://immo.example/kreuzberg-42" } },
    { id: "f-4", datetime: "2026-10-10 10:00", kind: "fact", tag: "Budget", body: "Budget €1,400", meta: { "replaced-by": "f-5" } },
  ];
  assert.deepEqual(searchNotes(notes, "heating").map((e) => e.id), ["n-2", "f-1"], "newest first");
  assert.deepEqual(searchNotes(notes, "heating", "", "fact").map((e) => e.id), ["f-1"]);
  assert.deepEqual(searchNotes(notes, "", "#mitte").map((e) => e.id), ["n-2", "f-1"]);
  assert.deepEqual(searchNotes(notes, "kreuzberg").map((e) => e.id), ["l-3"], "matches tag and URL");
  assert.deepEqual(searchNotes(notes, "budget").map((e) => e.id), ["f-4"], "replaced facts are searchable");
  assert.deepEqual(searchNotes(notes, ""), [], "never everything");
  assert.ok(sameStatement("Deposit is 3x rent.", "deposit is 3x  rent"));
  assert.ok(!sameStatement("Deposit is 3x rent", "Deposit is 2x rent"));
});
