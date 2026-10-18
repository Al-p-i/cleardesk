import assert from "node:assert/strict";
import { Controller } from "../../src/controller";
import { TFile } from "./obsidian-stub";

const files = new Map<string, Uint8Array>();
const chat: any[] = [];
const mkFile = (path: string) => Object.assign(new TFile(), {
  path, name: path.split("/").pop(), basename: path.split("/").pop()!.replace(/\.[^.]+$/, ""),
  extension: path.split(".").pop(), stat: { size: files.get(path)!.byteLength },
});
const store: any = {
  saveAttachment: async (folder: string, name: string, data: ArrayBuffer) => {
    const path = `${folder}/Attachments/${name}`; files.set(path, new Uint8Array(data)); return path;
  },
  appendChat: async (folder: string, kind: string, body: string) => {
    const e = { id: `m-${chat.length}`, datetime: "2026-10-17 23:00", kind, tag: "", body, meta: {} }; chat.push(e); return e;
  },
  file: (p: string) => (files.has(p) ? mkFile(p) : null),
  resolveLink: (p: string) => (files.has(p) ? mkFile(p) : null),
  readBinary: async (f: any) => files.get(f.path)!.buffer,
  read: async (p: string) => new TextDecoder().decode(files.get(p)!),
  readMeta: async () => ({ color: "", goal: "", status: "", order: 0, key_facts: [] }),
  tasks: async () => [], notes: async () => [], projectFiles: () => [],
  recentChat: async () => chat, chatLink: () => "[[x]]",
};
let sent: any = null;
const ai: any = { configured: true, webAccess: false, chat: async (args: any) => { sent = args; return "It's a floor plan."; } };
const c = new Controller(store, ai, () => {});
const project: any = { folder: "APARTMENTS", name: "APARTMENTS", inbox: false };

const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
const csv = new TextEncoder().encode("rent,1380\n");
await c.send(project, "what is this?", [
  { name: "Pasted image 2026-10-17 2300.png", data: png.buffer },
  { name: "costs.csv", data: csv.buffer },
]);
assert.equal(chat[0].kind, "me");
assert.equal(chat[0].body, "what is this?\n![[APARTMENTS/Attachments/Pasted image 2026-10-17 2300.png]]\n![[APARTMENTS/Attachments/costs.csv]]");
const blocks = sent.user;
assert.equal(blocks[0].type, "image");
assert.equal(blocks[0].source.media_type, "image/png");
assert.equal(blocks[0].source.data, Buffer.from(png).toString("base64"));
assert.equal(blocks[1].type, "text");
assert.match(blocks[1].text, /Attached file Attachments\/costs\.csv:\n\nrent,1380/);
assert.match(blocks[2].text, /^what is this\?\n\n\[Attached: Attachments\/Pasted image 2026-10-17 2300\.png, Attachments\/costs\.csv\./);
assert.equal(chat[chat.length - 1].body, "It's a floor plan.");
console.log("attachment to model ok");

// image-only message, no text
chat.length = 0;
await c.send(project, "", [{ name: "x.jpg", data: png.buffer }]);
assert.equal(chat[0].body, "![[APARTMENTS/Attachments/x.jpg]]");
assert.equal(sent.user[0].source.media_type, "image/jpeg");
assert.match(sent.user[1].text, /^\(See the attached file\.\)/);
console.log("image-only message ok");

// ---- links: saved with page title, deduplicated, tagged ----
import { script } from "./obsidian-stub";
(globalThis as any).window = { setTimeout };
const notes: any[] = [];
store.notes = async () => notes;
store.addNote = async (_f: string, e: any) => { const n = { id: `l-${notes.length}`, datetime: "2026-10-17 23:10", ...e }; notes.push(n); return n; };
store.updateNote = async (_f: string, id: string, fn: any) => { const i = notes.findIndex((n) => n.id === id); notes[i] = fn(notes[i]); };
ai.tagNote = async () => ({ tag: "Listings", decision: false, key_facts: [] });
const html = (t: string) => ({ __raw: { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" }, text: `<html><head><title>${t}</title></head></html>` } });
script([html("2BR in Mitte &amp; garden - Immo")]);
chat.length = 0;
await c.send(project, "/n check https://example.com/listing/42, looks good");
await new Promise((r) => setTimeout(r, 50));
assert.equal(notes.filter((n) => n.kind === "link").length, 1);
const link = notes.find((n) => n.kind === "link");
assert.equal(link.body, "2BR in Mitte & garden - Immo");
assert.equal(link.meta.url, "https://example.com/listing/42");
assert.equal(link.tag, "Listings");
assert.ok(chat.some((e) => e.kind === "receipt" && /Link saved · 2BR in Mitte/.test(e.body)));
// same link again: not duplicated; unreachable page falls back to a label
script([{ __raw: { status: 500, headers: {}, text: "" } }]);
await c.send(project, "again https://example.com/listing/42 and https://www.zillow.com/homedetails/9");
await new Promise((r) => setTimeout(r, 50));
const links = notes.filter((n) => n.kind === "link");
assert.equal(links.length, 2);
assert.equal(links[1].body, "zillow.com/homedetails/9");
console.log("link capture ok");
