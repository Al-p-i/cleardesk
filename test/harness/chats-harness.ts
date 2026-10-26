// Separate chats in a project: real Store code over an in-memory vault, and the controller
// sending, filing, titling and remembering per chat.
import assert from "node:assert/strict";
import { Controller } from "../../src/controller";
import { MAIN, Store, chatOfPath, projectPaths } from "../../src/store";
import { noteLine, notesContext } from "../../src/memory";
import { mapBlock } from "../../src/map";
import { TFile, TFolder } from "./obsidian-stub";

// ---- a tiny vault: files in a map, folders implied by paths ----
const files = new Map<string, string>();
const fileObj = (path: string) =>
  Object.assign(new TFile(), { path, name: path.split("/").pop()!, extension: "md", basename: path.split("/").pop()!.replace(/\.md$/, ""), stat: { size: 1, mtime: 0, ctime: 0 } });
const folderObj = (path: string): any => {
  const f: any = Object.assign(new TFolder(), { path, name: path.split("/").pop() });
  Object.defineProperty(f, "children", {
    get: () => {
      const kids = new Map<string, any>();
      for (const p of files.keys()) {
        if (!p.startsWith(path + "/")) continue;
        const rest = p.slice(path.length + 1);
        const head = rest.split("/")[0];
        kids.set(head, rest.includes("/") ? folderObj(`${path}/${head}`) : fileObj(p));
      }
      return [...kids.values()];
    },
  });
  return f;
};
const app: any = {
  vault: {
    getAbstractFileByPath: (p: string) => (files.has(p) ? fileObj(p) : [...files.keys()].some((k) => k.startsWith(p + "/")) ? folderObj(p) : null),
    cachedRead: async (f: any) => files.get(f.path) ?? "",
    process: async (f: any, fn: (t: string) => string) => { files.set(f.path, fn(files.get(f.path) ?? "")); },
    modify: async (f: any, text: string) => { files.set(f.path, text); },
    create: async (p: string, text: string) => { files.set(p, text); },
    createFolder: async () => {},
  },
};
const P = projectPaths("APARTMENTS");
files.set(P.chat("2026-10"), "# Chat · 2026-10\n\n### 2026-10-20 10:00 · me ^m-old001\nfirst main message\n");
files.set(P.notes, "");
files.set(P.tasks, "");

const store = new Store(app);
Object.assign(store, { projectFiles: () => [] });

// ---- storage ----
assert.deepEqual(chatOfPath("APARTMENTS/_project/chats/c-k2j3a"), { folder: "APARTMENTS", chat: "c-k2j3a" });
assert.deepEqual(chatOfPath("APARTMENTS/_project/chat/2026-10.md"), { folder: "APARTMENTS", chat: MAIN });
assert.equal(chatOfPath("APARTMENTS/notes.md"), null);

let histories: any[] = [];
let replyTo = "";
const ai: any = {
  configured: true, webAccess: false,
  chatTitle: async (text: string) => (text.includes("clause") ? "Contract questions" : "Something"),
  parseTasks: async (lines: string[]) => lines.map((text) => ({ text, due: "" })),
  tagNote: async () => ({ tag: "", key_facts: [] }),
  chat: async (args: any) => { histories.push(args.history); return replyTo; },
};
const c = new Controller(store, ai, () => {});
const project: any = { folder: "APARTMENTS", name: "APARTMENTS", home: false };
const idle = () => new Promise((r) => setTimeout(r, 20)); // let the background title finish

// A new chat is created with its first message, and named from it.
replyTo = "Clause 7 says the deposit is returned within 30 days.";
await c.send({ ...project, chat: "c-k2j3a" }, "what does clause 7 mean for the deposit?");
await idle();
const chatText = files.get(P.chatFile("c-k2j3a"))!;
assert.match(chatText, /^---\n.*"title":"Contract questions".*\n---\n/s, "title saved in the chat's frontmatter");
assert.match(chatText, /· me \^m-[a-z0-9]+\nwhat does clause 7 mean/);
assert.match(chatText, /· ai \^m-[a-z0-9]+\nClause 7 says/);
assert.deepEqual(histories[0], [], "a new chat starts without Main's history");
assert.ok(!files.get(P.chat("2026-10"))!.includes("clause 7"), "Main is untouched");

// Claude sees only the current chat's history.
replyTo = "Yes.";
await c.send({ ...project, chat: "c-k2j3a" }, "and the interest?");
assert.match(JSON.stringify(histories[1]), /clause 7/);
assert.ok(!JSON.stringify(histories[1]).includes("first main message"));
await c.send(project, "back in main");
assert.match(JSON.stringify(histories[2]), /first main message/);
assert.ok(!JSON.stringify(histories[2]).includes("clause 7"));
console.log("chat isolation ok");

// /t in a chat: the task goes to the shared panel, the receipt to that chat, with a source link into it.
await c.send({ ...project, chat: "c-k2j3a" }, "/t ask agency about clause 7");
assert.match(files.get(P.tasks)!, /Ask agency about clause 7|ask agency about clause 7/);
assert.match(files.get(P.tasks)!, /🔗 \[\[APARTMENTS\/_project\/chats\/c-k2j3a#\^m-[a-z0-9]+\|chat\]\]/);
assert.match(files.get(P.chatFile("c-k2j3a"))!, /· receipt \^m-[a-z0-9]+\n✓ Task added/);
const link = /\[\[([^|\]]+)\|chat\]\]/.exec(files.get(P.tasks)!)![1];
assert.deepEqual(chatOfPath(link.split("#^")[0]), { folder: "APARTMENTS", chat: "c-k2j3a" }, "source links know their chat");
console.log("filing from a chat ok");

// Undo works on a receipt inside a chat.
const receipt = (await store.recentChat("APARTMENTS", 50, "c-k2j3a")).find((e) => e.kind === "receipt")!;
await c.undo({ ...project, chat: "c-k2j3a" }, receipt);
assert.ok(!/clause 7/i.test(files.get(P.tasks)!), "task removed");
assert.match(files.get(P.chatFile("c-k2j3a"))!, /Undone: ✓ Task added/);
console.log("undo in a chat ok");

// Listing, renaming, archiving.
replyTo = "Sure.";
await c.send({ ...project, chat: "c-p9x1z" }, "moving boxes");
await idle();
let list = await store.listChats("APARTMENTS");
assert.deepEqual(list.map((x) => [x.id, x.title, x.archived]).sort(), [["c-k2j3a", "Contract questions", false], ["c-p9x1z", "Something", false]]);
await store.updateChatInfo("APARTMENTS", "c-p9x1z", { title: "Moving" });
await store.updateChatInfo("APARTMENTS", "c-k2j3a", { archived: true });
list = await store.listChats("APARTMENTS");
assert.deepEqual(list.map((x) => [x.title, x.archived]).sort(), [["Contract questions", true], ["Moving", false]]);
assert.match(files.get(P.chatFile("c-p9x1z"))!, /moving boxes/, "messages kept on rename");
assert.match(await store.mainUpdated("APARTMENTS"), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, "Main's last message time");
assert.equal(await store.mainUpdated("NOWHERE"), "");
console.log("rename and archive ok");

// The first chat is an ordinary chat: named after the project, sorted by activity, renamable, archivable.
let all = await store.allChats("APARTMENTS");
const first = all.find((x) => x.id === MAIN)!;
assert.equal(first.title, "APARTMENTS");
assert.equal(first.archived, false);
assert.ok(all.every((x, i) => i === 0 || all[i - 1].updated >= x.updated), "most recent first, the first chat included");
await store.updateChatInfo("APARTMENTS", MAIN, { title: "General" });
assert.match(files.get(P.meta)!, /"chat_title":"General"/, "its title lives in project.md");
assert.equal((await store.allChats("APARTMENTS")).find((x) => x.id === MAIN)!.title, "General");
assert.match(files.get(P.chat("2026-10"))!, /first main message/, "its messages stay where they were");
await store.updateChatInfo("APARTMENTS", MAIN, { title: "APARTMENTS" });
assert.ok(!files.get(P.meta)!.includes("chat_title"), "renaming back to the project's name clears the override");
await store.updateChatInfo("APARTMENTS", MAIN, { archived: true });
all = await store.allChats("APARTMENTS");
assert.equal(all.find((x) => x.id === MAIN)!.archived, true);
await store.updateChatInfo("APARTMENTS", MAIN, { archived: false });
assert.ok(!files.get(P.meta)!.includes("chat_archived"));
console.log("first chat is an ordinary chat ok");

// Search covers every chat, archived ones too, and says where each hit is.
const hits = await store.searchChat(["APARTMENTS"], ["clause"]);
assert.ok(hits.length >= 2 && hits.every((h) => h.chat === "c-k2j3a"));
const main = await store.searchChat(["APARTMENTS"], ["main"]);
assert.ok(main.some((h) => h.chat === MAIN && h.entry.body === "first main message"));
assert.deepEqual(store.allChatPaths("APARTMENTS").sort(), [P.chat("2026-10"), P.chatFile("c-k2j3a"), P.chatFile("c-p9x1z")].sort());
console.log("search across chats ok");

// Pinning a message copies it to the shared panel, pinned, linked back to its chat.
const reply = (await store.recentChat("APARTMENTS", 50, "c-k2j3a")).find((e) => e.kind === "ai")!;
await c.pinMessage({ ...project, chat: "c-k2j3a" }, reply);
let notes = await store.notes("APARTMENTS");
const pin = notes.find((n) => n.kind === "message")!;
assert.equal(pin.body, reply.body);
assert.equal(pin.meta.pinned, "true");
assert.match(pin.id, /^p-/);
assert.equal(pin.meta.source, `[[APARTMENTS/_project/chats/c-k2j3a#^${reply.id}|chat]]`);
assert.equal(notesContext(notes).shown[0].id, pin.id, "pinned: always in Claude's context");
assert.match(noteLine(pin), /^\[p-[a-z0-9]+\] .* message \(pinned\): Clause 7 says/);
// A pinned reply with a map reaches Claude as text, not coordinates.
const withMap = { ...pin, body: "Here.\n\n" + mapBlock({ title: "Flats", places: [{ name: "A", lat: 52.5, lng: 13.4, color: "green" }], areas: [], circles: [], lines: [], legend: [], missing: [] }) };
assert.ok(noteLine(withMap).includes("[Map: Flats") && !noteLine(withMap).includes("52.5"));
await c.unpinMessage("APARTMENTS", pin.id);
notes = await store.notes("APARTMENTS");
assert.ok(!notes.some((n) => n.kind === "message"), "unpinning removes the copy");
assert.ok((await store.recentChat("APARTMENTS", 50, "c-k2j3a")).some((e) => e.id === reply.id), "the message stays in its chat");
console.log("message pinning ok");
