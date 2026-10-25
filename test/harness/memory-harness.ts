// What the AI receives from a big project, and that search_notes / add_fact dedupe work end to end.
import assert from "node:assert/strict";
import { Controller } from "../../src/controller";

const notes: any[] = Array.from({ length: 60 }, (_, i) => ({
  id: `n-${String(i).padStart(6, "0")}`, datetime: `2026-09-${String(1 + (i % 28)).padStart(2, "0")} ${String(8 + (i % 12)).padStart(2, "0")}:00`,
  kind: i % 2 ? "fact" : "note", tag: i % 3 ? "Mitte" : "Budget", body: `observation number ${i}`, meta: {},
}));
notes[2].body = "Mitte heating system is from 1998";
notes[5].meta = { pinned: "true" };
const chat: any[] = [];
const store: any = {
  readMeta: async () => ({ color: "", goal: "Lease by Nov 1", status: "", order: 0, key_facts: [] }),
  tasks: async () => [], notes: async () => notes, projectFiles: () => [], recentChat: async () => [],
  chatLink: () => "[[x]]",
  addNote: async (_f: string, e: any) => { const n = { id: `f-new${notes.length}`, datetime: "2026-10-18 20:00", ...e }; notes.push(n); return n; },
  appendChat: async (_f: string, kind: string, body: string) => { const e = { id: `m-${chat.length}`, datetime: "2026-10-18 20:00", kind, tag: "", body, meta: {} }; chat.push(e); return e; },
};
let system = "";
const out: Record<string, any> = {};
const ai: any = {
  configured: true, webAccess: false,
  chat: async (args: any) => {
    system = `${args.system}\n${args.context}`;
    out.search = await args.exec("search_notes", { query: "heating", tag: "", kind: "" });
    out.tag = await args.exec("search_notes", { query: "", tag: "Budget", kind: "fact" });
    out.dup = await args.exec("add_fact", { text: "Mitte heating system is from 1998.", tag: "Mitte" });
    out.fresh = await args.exec("add_fact", { text: "Deposit is 3 months of rent", tag: "Mitte" });
    return "ok";
  },
};
await new Controller(store, ai, () => {}).send({ folder: "A", name: "A", home: false } as any, "what about the heating?");

const shown = system.split("\n").filter((l) => /^\[n-\d{6}\]/.test(l));
console.log(`context: ${shown.length} of 60 items shown (1 pinned + 30 recent)`);
assert.equal(shown.length, 31);
assert.ok(shown[0].includes("(pinned)"), "pinned first");
assert.ok(!system.includes("Mitte heating system"), "old item not in context");
assert.match(system, /29 older notes\/facts\/links are not shown here/);
assert.match(system, /Topics in this project's notes: #Mitte \(40\), #Budget \(20\)/);
assert.match(out.search, /\[n-000002\] .*Mitte heating system is from 1998/);
assert.ok(out.tag.split("\n").every((l: string) => /fact .*#Budget/.test(l)), "tag + kind filter");
assert.match(out.dup, /Already saved as n-000002/);
assert.match(out.fresh, /^Saved as f-new60/);
assert.equal(notes.length, 61, "only the new fact was added");
console.log("search_notes ok · duplicate fact skipped · new fact saved");
