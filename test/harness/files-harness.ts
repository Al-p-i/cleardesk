// The AI's file tools against an in-memory vault: real Store move/folder/undo code.
import assert from "node:assert/strict";
import { Controller } from "../../src/controller";
import { Store } from "../../src/store";
import { TFile, TFolder } from "./obsidian-stub";

const items = new Map<string, any>();
const kids = (p: string) => [...items.values()].filter((x) => x.path.split("/").slice(0, -1).join("/") === p);
const mk = (path: string, folder: boolean) => {
  const o: any = folder ? new TFolder() : new TFile();
  o.path = path; o.name = path.split("/").pop();
  if (folder) Object.defineProperty(o, "children", { get: () => kids(o.path) });
  else { o.extension = o.name.split(".").pop(); o.basename = o.name.replace(/\.[^.]+$/, ""); o.stat = { size: 2048, mtime: Date.UTC(2026, 9, 18) }; }
  items.set(path, o); return o;
};
for (const f of ["APARTMENTS", "APARTMENTS/Attachments", "APARTMENTS/_project", "APARTMENTS/_project/chat", "1. PERSONAL"]) mk(f, true);
for (const f of ["APARTMENTS/Attachments/IMG_2041.jpg", "APARTMENTS/Attachments/lease.pdf", "APARTMENTS/notes about flats.md", "APARTMENTS/_project/chat/2026-10.md", "1. PERSONAL/secret.md"]) mk(f, false);

const app: any = {
  vault: {
    getAbstractFileByPath: (p: string) => items.get(p) ?? null,
    createFolder: async (p: string) => { if (items.has(p)) throw new Error("exists"); if (!items.has(p.split("/").slice(0, -1).join("/")) && p.includes("/")) throw new Error("no parent"); mk(p, true); },
    delete: async (f: any) => { items.delete(f.path); },
  },
  fileManager: {
    renameFile: async (f: any, to: string) => {
      if (items.has(to)) throw new Error("Destination exists");
      const from = f.path;
      for (const [p, o] of [...items]) if (p === from || p.startsWith(from + "/")) { items.delete(p); o.path = to + p.slice(from.length); o.name = o.path.split("/").pop(); items.set(o.path, o); }
    },
  },
};
const store = new Store(app);
const chat: any[] = [];
Object.assign(store, {
  readMeta: async () => ({ color: "", goal: "", status: "", order: 0, key_facts: [] }),
  tasks: async () => [], notes: async () => [], projectFiles: () => [], recentChat: async () => [],
  chatLink: () => "[[x]]", updateChat: async () => {},
  appendChat: async (_f: string, kind: string, body: string) => { const e = { id: `m-${chat.length}`, datetime: "2026-10-18 18:00", kind, tag: "", body, meta: {} }; chat.push(e); return e; },
});
const results: Record<string, string> = {};
const ai: any = {
  configured: true, webAccess: false,
  chat: async ({ exec }: any) => {
    results.list = await exec("list_files", { path: "" });
    results.readEscape = await exec("read_file", { path: "../1. PERSONAL/secret.md" });
    results.readSystem = await exec("read_file", { path: "_project/chat/2026-10.md" });
    results.photo = await exec("move_file", { from: "Attachments/IMG_2041.jpg", to: "Photos/Mitte/kitchen.jpg" });
    results.folder = await exec("create_folder", { path: "Docs" });
    results.intoFolder = await exec("move_file", { from: "Attachments/lease.pdf", to: "Docs" });
    results.escape = await exec("move_file", { from: "../1. PERSONAL/secret.md", to: "stolen.md" });
    results.system = await exec("move_file", { from: "_project/chat/2026-10.md", to: "chat.md" });
    results.overwrite = await exec("move_file", { from: "notes about flats.md", to: "Docs/lease.pdf" }).catch((e: Error) => "ERR " + e.message);
    // parallel moves are serialised
    const par = await Promise.all([
      exec("move_file", { from: "notes about flats.md", to: "Notes/flats.md" }),
      exec("create_folder", { path: "Notes" }),
    ]);
    results.parallel = par.join(" | ");
    return "Organised.";
  },
};
const c = new Controller(store, ai, () => {});
const project: any = { folder: "APARTMENTS", name: "APARTMENTS", home: false };
await c.send(project, "sort my photos and files");

assert.match(results.list, /Attachments\/IMG_2041\.jpg {2}\(2 KB, 2026-10-18\)/);
assert.ok(!results.list.includes("_project"), "listing hides _project");
assert.ok(items.has("APARTMENTS/Photos/Mitte/kitchen.jpg") && !items.has("APARTMENTS/Attachments/IMG_2041.jpg"));
assert.ok(items.has("APARTMENTS/Docs/lease.pdf"), "moving into an existing folder keeps the name");
assert.match(results.escape, /outside the project/);
assert.match(results.readEscape, /outside the project/, "read_file uses the same path rules");
assert.match(results.readSystem, /_project/);
assert.ok(items.has("1. PERSONAL/secret.md"));
assert.match(results.system, /_project/);
assert.ok(items.has("APARTMENTS/_project/chat/2026-10.md"));
assert.match(results.overwrite, /already exists/);
assert.ok(items.has("APARTMENTS/Notes/flats.md"), results.parallel);
const receipt = chat.find((e) => e.kind === "receipt");
assert.equal(receipt.body, "📁 Attachments/IMG_2041.jpg → Photos/Mitte/kitchen.jpg, Attachments/lease.pdf → Docs/lease.pdf, notes about flats.md → Notes/flats.md · folder Docs created");
console.log("file tools ok:", receipt.body);

// undo puts everything back and removes the folders it made
await c.undo(project, receipt);
for (const p of ["APARTMENTS/Attachments/IMG_2041.jpg", "APARTMENTS/Attachments/lease.pdf", "APARTMENTS/notes about flats.md"]) assert.ok(items.has(p), `restored ${p}`);
for (const p of ["APARTMENTS/Photos", "APARTMENTS/Photos/Mitte", "APARTMENTS/Docs", "APARTMENTS/Notes"]) assert.ok(!items.has(p), `removed ${p}`);
console.log("file tools undo ok");
