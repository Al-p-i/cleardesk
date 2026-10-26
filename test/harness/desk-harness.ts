// Desk sees all projects (read-only); other projects see only themselves.
import assert from "node:assert/strict";
import { Controller } from "../../src/controller";
import { Store, projectPaths } from "../../src/store";
import { TFile, TFolder } from "./obsidian-stub";

const files = new Map<string, string>();
const fileObj = (path: string) =>
  Object.assign(new TFile(), { path, name: path.split("/").pop()!, extension: path.split(".").pop()!, basename: path.split("/").pop()!.replace(/\.[^.]+$/, ""), stat: { size: 1, mtime: 0, ctime: 0 } });
const app: any = {
  vault: {
    getAbstractFileByPath: (p: string) =>
      files.has(p)
        ? fileObj(p)
        : [...files.keys()].some((k) => k.startsWith(p + "/"))
          ? Object.assign(new TFolder(), { path: p, children: [...files.keys()].filter((k) => k.startsWith(p + "/") && !k.slice(p.length + 1).includes("/")).map(fileObj) })
          : null,
    getMarkdownFiles: () => [...files.keys()].filter((p) => p.endsWith(".md")).map(fileObj),
    getFiles: () => [...files.keys()].map(fileObj),
    cachedRead: async (f: any) => files.get(f.path) ?? "",
    process: async (f: any, fn: (t: string) => string) => { files.set(f.path, fn(files.get(f.path) ?? "")); },
    create: async (p: string, t: string) => { files.set(p, t); },
    createFolder: async () => {},
  },
};
const meta = (m: object) => `---\n${JSON.stringify({ color: "", order: 0, key_facts: [], status: "", goal: "", ...m })}\n---\n`;
for (const [folder, m, tasks, notes] of [
  ["Desk", {}, "", ""],
  ["APARTMENTS", { goal: "Find a 2-room flat in Berlin by December", key_facts: [{ label: "Budget", value: "€1,500" }] },
    "- [ ] Call agency 📅 2026-10-01 ^t-aaa111\n- [ ] Book viewing 📅 2030-01-05 ^t-bbb222\n- [ ] Ask about parking ^t-ccc333\n",
    "### 2026-10-20 10:00 · fact · Deposit ^f-aaa111\nThe deposit is three months' rent\n"],
  ["Old trip", { status: "archived" }, "", ""],
] as const) {
  const P = projectPaths(folder);
  files.set(P.meta, meta(m));
  files.set(P.tasks, tasks);
  files.set(P.notes, notes);
}
files.set(projectPaths("APARTMENTS").chat("2026-10"), "# Chat · 2026-10\n\n### 2026-10-21 09:00 · me ^m-aaa111\nthe landlord wants the deposit in cash\n");

const store = new Store(app);
store.home = "Desk";
const calls: any[] = [];
const results: Record<string, string> = {};
const ai: any = {
  configured: true, webAccess: false,
  chat: async (args: any) => {
    calls.push(args);
    if (args.tools.some((t: any) => t.name === "read_project")) {
      results.read = await args.exec("read_project", { project: "apartments" });
      results.missing = await args.exec("read_project", { project: "Nope" });
      results.search = await args.exec("search_projects", { query: "deposit", project: "" });
    }
    return "ok";
  },
};
const c = new Controller(store, ai, () => {});

await c.send({ folder: "Desk", name: "Desk", home: true } as any, "what's overdue everywhere?");
const desk = calls[0];
const names = desk.tools.map((t: any) => t.name);
assert.ok(names.includes("read_project") && names.includes("search_projects"));
assert.ok(!desk.tools.find((t: any) => t.name === "read_project").strict, "read-only lookups aren't strict");
assert.match(desk.context, /<all_projects>/);
assert.match(desk.context, /## APARTMENTS\nGoal: Find a 2-room flat in Berlin by December\nKey facts: Budget: €1,500\nTasks: 3 open, 1 overdue; next due: Call agency \(due 2026-10-01\); Book viewing \(due 2030-01-05\)/);
assert.match(desk.context, /Done or archived: Old trip \(archived\)/);
assert.ok(!/## Old trip/.test(desk.context) && !/## Desk/.test(desk.context));
assert.match(desk.context, /read-only/);
assert.match(results.read, /<project name="APARTMENTS">[\s\S]*Call agency[\s\S]*The deposit is three months' rent/);
assert.match(results.read, /Read-only from Desk/);
assert.match(results.missing, /No project called "Nope". Projects: .*APARTMENTS/);
assert.match(results.search, /\[APARTMENTS\] \[f-aaa111\].*deposit is three months/);
assert.match(results.search, /\[APARTMENTS chat\] .*owner: the landlord wants the deposit in cash/);
console.log("desk sees all projects ok");

await c.send({ folder: "APARTMENTS", name: "APARTMENTS", home: false } as any, "hi");
const apt = calls[1];
assert.ok(!apt.tools.some((t: any) => t.name === "read_project" || t.name === "search_projects"));
assert.ok(!apt.context.includes("<all_projects>"), "other projects stay focused");
console.log("projects stay focused ok");
