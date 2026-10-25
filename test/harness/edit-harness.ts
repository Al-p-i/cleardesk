// Claude editing and deleting tasks and notes (on request): real Store code over an
// in-memory vault, the receipt, and one-click undo of the whole turn.
import assert from "node:assert/strict";
import { Controller } from "../../src/controller";
import { Store } from "../../src/store";
import { TFile } from "./obsidian-stub";
import { dueLabel } from "../../src/format";

const files = new Map<string, string>();
const fileObj = (path: string) => Object.assign(new TFile(), { path, name: path.split("/").pop(), extension: "md" });
const app: any = {
  vault: {
    getAbstractFileByPath: (p: string) => (files.has(p) ? fileObj(p) : null),
    cachedRead: async (f: any) => files.get(f.path) ?? "",
    process: async (f: any, fn: (t: string) => string) => { files.set(f.path, fn(files.get(f.path) ?? "")); },
    modify: async (f: any, text: string) => { files.set(f.path, text); },
    create: async (p: string, text: string) => { files.set(p, text); },
  },
};
const TASKS = "APARTMENTS/_project/tasks.md";
const NOTES = "APARTMENTS/_project/notes.md";
files.set(TASKS, [
  "- [ ] Call agency 📅 2026-10-28 ^t-aaa111",
  "- [ ] Book viewing Wiener Str 📅 2026-10-27 ^t-bbb222",
  "- [ ] Ask about parking ^t-ccc333",
  "",
].join("\n"));
files.set(NOTES, [
  "### 2026-10-20 10:00 · note · Viewings ^n-aaa111",
  "Wiener Str viewing was ok, a bit dark",
  "",
  "### 2026-10-21 11:00 · fact · Budget ^f-bbb222",
  "Budget is €1,500 a month",
  "",
].join("\n"));
const before = new Map(files);

const store = new Store(app);
const chat: any[] = [];
Object.assign(store, {
  readMeta: async () => ({ color: "", goal: "", status: "", order: 0, key_facts: [] }),
  projectFiles: () => [], recentChat: async () => [], chatLink: () => "[[x]]",
  updateChat: async (_f: string, _c: string, entry: any, fn: (e: any) => any) => { const i = chat.findIndex((e) => e.id === entry.id); chat[i] = fn(chat[i]); },
  appendChat: async (_f: string, kind: string, body: string) => { const e = { id: `m-${chat.length}`, datetime: "2026-10-25 12:00", kind, tag: "", body, meta: {} }; chat.push(e); return e; },
});

const r: Record<string, string> = {};
const ai: any = {
  configured: true, webAccess: false,
  chat: async ({ exec }: any) => {
    r.reschedule = await exec("update_task", { task_id: "t-aaa111", text: "", due: "2026-10-31" });
    r.reword = await exec("update_task", { task_id: "t-ccc333", text: "Ask about parking and storage\nunderground if possible", due: "" });
    r.undate = await exec("update_task", { task_id: "t-bbb222", text: "", due: "none" });
    r.missing = await exec("update_task", { task_id: "t-nope", text: "x", due: "" });
    r.deleteTask = await exec("delete_task", { task_id: "t-bbb222" });
    r.editNote = await exec("update_note", { note_id: "n-aaa111", text: "Wiener Str viewing was ok, a bit dark, quiet street" });
    r.editFact = await exec("update_note", { note_id: "f-bbb222", text: "Budget is €1,600" });
    r.deleteFact = await exec("delete_note", { note_id: "f-bbb222" });
    return "Done.";
  },
};
const c = new Controller(store, ai, () => {});
const project: any = { folder: "APARTMENTS", name: "APARTMENTS", home: false };
await c.send(project, "move the agency call to the 31st, drop the Wiener viewing, …");

assert.equal(files.get(TASKS), [
  "- [ ] Call agency 📅 2026-10-31 ^t-aaa111",
  "- [ ] Ask about parking and storage ^t-ccc333",
  "    underground if possible",
  "",
].join("\n"));
assert.match(r.missing, /No open task/);
assert.match(r.editFact, /replace_fact/, "facts keep their history: update_note refuses them");
assert.equal(files.get(NOTES), "### 2026-10-20 10:00 · note · Viewings ^n-aaa111\nWiener Str viewing was ok, a bit dark, quiet street\n\n");
const receipt = chat.find((e) => e.kind === "receipt");
assert.equal(receipt.body, [
  `✎ Task updated · Call agency · ${dueLabel("2026-10-31")}`,
  "✎ Task updated · Ask about parking and storage",
  "✎ Task updated · Book viewing Wiener Str",
  "✕ Task deleted · Book viewing Wiener Str",
  "✎ Note updated · Viewings",
  "✕ Fact deleted · Budget is €1,500 a month",
].join("\n"));
console.log("edit tools ok");

await c.undo(project, receipt);
assert.equal(files.get(TASKS), before.get(TASKS));
assert.equal(files.get(NOTES), before.get(NOTES));
console.log("edit undo ok");
