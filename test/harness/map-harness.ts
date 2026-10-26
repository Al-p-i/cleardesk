// show_map end to end: lookups (scripted OpenStreetMap answers), the per-project cache,
// the map block saved under the reply, and the text form Claude sees in the history.
import assert from "node:assert/strict";
import { Controller } from "../../src/controller";
import { Store } from "../../src/store";
import { mapInNote, parseMap } from "../../src/map";
import { calls, script } from "./obsidian-stub";

const files = new Map<string, string>();
const store = new Store({} as any);
const chat: any[] = [];
Object.assign(store, {
  read: async (p: string) => files.get(p) ?? "",
  file: (p: string) => (files.has(p) ? { path: p, name: p.split("/").pop(), extension: p.split(".").pop(), stat: { size: files.get(p)!.length } } : null),
  modify: async (p: string, fn: (t: string) => string) => { files.set(p, fn(files.get(p) ?? "")); },
  readMeta: async () => ({ color: "", goal: "", status: "", order: 0, key_facts: [] }),
  tasks: async () => [], notes: async () => [], projectFiles: () => [], recentChat: async () => chat,
  chatLink: () => "[[x]]", updateChat: async () => {},
  appendChat: async (_f: string, kind: string, body: string) => { const e = { id: `m-${chat.length}`, datetime: "2026-10-25 12:00", kind, tag: "", body, meta: {} }; chat.push(e); return e; },
});

const input = {
  title: "Shortlisted flats",
  places: [
    { name: "Office", address: "Alexanderplatz 1, Berlin", color: "blue", details: "", note_id: "" },
    { name: "Flat A", address: "52.501, 13.418", color: "green", details: "€1,450 · 2 rooms", note_id: "n-abc123" },
    { name: "Flat B", address: "Nowhere 99", color: "red", details: "", note_id: "" },
  ],
  areas: [
    { name: "Kreuzberg, Berlin", color: "green", label: "favourite" },
    { name: "Atlantis", color: "orange", label: "" },
  ],
  circles: [{ center: "Office", radius_m: 1000, color: "blue", label: "" }],
  lines: [{ from: "Flat A", to: "Office", color: "grey", label: "20 min by bike" }],
  legend: [{ color: "green", label: "shortlisted" }, { color: "red", label: "" }],
};
const osm = {
  office: [{ lat: "52.5219184", lon: "13.4132147" }],
  kreuzberg: [{ lat: "52.4979", lon: "13.4035", geojson: { type: "Polygon", coordinates: [[[13.36812345, 52.50398765], [13.45, 52.48], [13.37, 52.48], [13.36812345, 52.50398765]]] } }],
};

let report = "";
let tools: any[] = [];
let mapInput: any = input;
const statuses: string[] = [];
const ai: any = {
  configured: true, webAccess: true,
  chat: async (args: any) => { tools = args.tools; report = await args.exec("show_map", mapInput); return "Here are the flats."; },
};
const c = new Controller(store, ai, () => {});
c.onStream = (_f, _c, _t, status) => { if (status) statuses.push(status); };
const project: any = { folder: "APARTMENTS", name: "APARTMENTS", home: false };

// First map: Office, Nowhere, Kreuzberg and Atlantis are looked up; Flat A is coordinates.
script([osm.office, [], osm.kreuzberg, []]);
const t0 = Date.now();
await c.send(project, "show the flats on a map");
const took = Date.now() - t0;
assert.equal(calls.length, 4, "one lookup per address; coordinates and known names need none");
assert.ok(took >= 3000, `at most one lookup per second (took ${took} ms)`);
assert.ok(calls.every((r) => r.url.startsWith("https://nominatim.openstreetmap.org/search?") && /ClearDesk/.test(r.headers["User-Agent"])));
assert.match(calls[0].url, /q=Alexanderplatz\+1%2C\+Berlin/);
assert.ok(!calls[0].url.includes("polygon_geojson") && calls[2].url.includes("polygon_geojson=1"), "outlines only for areas");
assert.equal(statuses[statuses.length - 1], "Finding places… 8 of 8");

const reply = chat.find((e) => e.kind === "ai");
assert.match(reply.body, /^Here are the flats\.\n\n```cleardesk-map\n/);
const spec = parseMap(reply.body.split("\n").slice(3, -1).join("\n"))!;
assert.deepEqual(spec.places.map((p) => [p.name, p.lat, p.lng]), [["Office", 52.52192, 13.41321], ["Flat A", 52.501, 13.418]]);
assert.equal(spec.places[1].note, "n-abc123");
assert.deepEqual(spec.missing, ["Flat B", "Atlantis"]);
assert.equal(spec.areas[0].name, "Kreuzberg");
assert.deepEqual((spec.areas[0].shape as any).coordinates[0][0], [13.36812, 52.50399], "outline saved, rounded");
assert.deepEqual([spec.circles[0].lat, spec.circles[0].label], [52.52192, "1 km from Office"], "circle centre reuses the Office pin");
assert.deepEqual(spec.lines[0].to, [52.52192, 13.41321]);
assert.deepEqual(spec.legend, [{ color: "green", label: "shortlisted" }], "empty legend rows dropped");
assert.match(report, /appears under your reply/);
assert.match(report, /Not found: Flat B; Atlantis\./);
console.log("map ok:", report);

// The cache keeps what was found (not misses), so the same map needs only the misses again.
const cache = JSON.parse(files.get("APARTMENTS/_project/places.json")!);
assert.deepEqual(Object.keys(cache).sort(), ["area:kreuzberg, berlin", "place:alexanderplatz 1, berlin"]);
script([[], []]);
await c.send(project, "again");
assert.equal(calls.length, 2, "cached places aren't looked up again");
console.log("place cache ok");

// Claude's history and chat search see the map as text, never the raw block.
const history = await (c as any).history(project, { id: "none" });
const assistant = history.filter((m: any) => m.role === "assistant").map((m: any) => m.content).join("\n");
assert.ok(!assistant.includes("cleardesk-map") && !assistant.includes("13.41321"));
assert.match(assistant, /\[Map: Shortlisted flats\n- Office \(blue\)\n- Flat A \(green\): €1,450 · 2 rooms/);
console.log("map history ok");

// The lookup service failing is reported, and no empty map is saved.
const before = chat.filter((e) => e.kind === "ai").length;
input.places = [{ name: "Somewhere", address: "Somewhere new 1", color: "red", details: "", note_id: "" }];
input.areas = []; input.circles = []; input.lines = [];
script([{ __raw: { status: 503, headers: {}, text: "", json: null } }]);
await c.send(project, "map somewhere");
assert.match(report, /lookup service didn't respond/);
assert.equal(chat.filter((e) => e.kind === "ai").length, before + 1);
assert.ok(!chat[chat.length - 1].body.includes("cleardesk-map"), "no map block when nothing was found");
console.log("map lookup failure ok");

// The API compiles all strict tool schemas of a request into one grammar with a size limit
// ("compiled grammar is too large"): only the tools that change things are strict.
const strict = tools.filter((t) => t.strict).map((t) => t.name);
assert.ok(strict.length <= 15, `strict tools: ${strict.join(", ")}`);
for (const t of ["show_map", "read_file", "list_files", "search_notes", "search_chat", "read_google_doc", "add_calendar_event", "show_widget"]) assert.ok(!strict.includes(t), `${t} isn't strict`);
for (const t of tools.filter((x) => x.strict)) {
  const s = t.input_schema;
  assert.deepEqual(s.required, Object.keys(s.properties), `${t.name}: no optional parameters`);
  assert.ok(Object.values(s.properties).every((p: any) => p.type === "string"), `${t.name}: flat string parameters`);
}
console.log(`strict tools ok (${strict.length} of ${tools.filter((t) => t.input_schema).length})`);

// Without strict mode the map input can be sloppy: missing fields, numbers as text, junk entries.
mapInput = {
  title: 7,
  places: [{ name: "Home", address: "52.5, 13.4" }, null, "junk", { address: "52.51, 13.41" }],
  circles: [{ center: "Home", radius_m: "500" }],
  lines: [{ from: "Home" }],
  legend: "none",
};
script([]);
await c.send(project, "map home");
const loose = parseMap(chat[chat.length - 1].body.split("\n").slice(3, -1).join("\n"))!;
assert.equal(calls.length, 0, "coordinates and known names need no lookup");
assert.deepEqual(loose.places.map((p) => [p.name, p.color]), [["Home", "blue"], ["52.51, 13.41", "blue"]]);
assert.deepEqual([loose.circles[0].radius, loose.circles[0].label], [500, "500 m from Home"]);
assert.deepEqual([loose.title, loose.lines.length, loose.legend.length], ["7", 0, 0]);
console.log("loose map input ok");

// Calling show_map twice in one reply: the same title replaces the first map, another title adds one.
const twice: any = {
  configured: true, webAccess: false,
  chat: async ({ exec }: any) => {
    const map = (title: string, n: number) => ({ title, places: Array.from({ length: n }, (_, i) => ({ name: `P${i}`, address: `52.5${i}, 13.4` })) });
    await exec("show_map", map("Must-sees", 2));
    report = await exec("show_map", map("Must-sees", 3));
    await exec("show_map", map("Food", 1));
    return "Here.";
  },
};
const c2 = new Controller(store, twice, () => {});
await c2.send(project, "map things");
const body = chat[chat.length - 1].body;
const blocks = body.match(/```cleardesk-map\n(.*?)\n```/gs)!.map((b: string) => parseMap(b.split("\n").slice(1, -1).join("\n"))!);
assert.deepEqual(blocks.map((b: any) => [b.title, b.places.length]), [["Must-sees", 3], ["Food", 1]]);
assert.match(report, /^This replaces your earlier map/);
console.log("repeated map replaced ok");

// save: true keeps the map as a project file shared by all chats; the reply refers to it.
const saver: any = {
  configured: true, webAccess: false,
  chat: async ({ exec }: any) => {
    report = await exec("show_map", { title: "Flats", save: true, places: [{ name: "A", address: "52.50, 13.40", color: "green", details: "€1,450" }] });
    return "Saved.";
  },
};
const c3 = new Controller(store, saver, () => {});
await c3.send(project, "keep a map of the flats");
const saved = files.get("APARTMENTS/Maps/Flats.md")!;
assert.deepEqual(mapInNote(saved)!.places.map((p) => p.name), ["A"]);
assert.match(saved, /- A \(green\): €1,450/);
assert.match(report, /Saved as Maps\/Flats\.md, shared by all chats/);
const savedReply = chat.filter((e) => e.kind === "ai").pop()!.body;
assert.equal(savedReply, "Saved.\n\n```cleardesk-map\n{\"file\":\"APARTMENTS/Maps/Flats.md\"}\n```", "the reply shows the saved map live");
assert.match(chat.filter((e) => e.kind === "receipt").pop()!.body, /🗺 Map saved · \[\[APARTMENTS\/Maps\/Flats\|Flats\]\]/);
// Updating it (same title) rewrites the same file.
saver.chat = async ({ exec }: any) => {
  report = await exec("show_map", { title: "Flats", save: true, places: [{ name: "A", address: "52.50, 13.40", color: "red" }, { name: "B", address: "52.51, 13.41", color: "green" }] });
  return "Updated.";
};
await c3.send(project, "mark A as rejected and add B");
assert.deepEqual(mapInNote(files.get("APARTMENTS/Maps/Flats.md")!)!.places.map((p) => [p.name, p.color]), [["A", "red"], ["B", "green"]]);
assert.match(report, /Updated Maps\/Flats\.md/);
assert.match(chat.filter((e) => e.kind === "receipt").pop()!.body, /🗺 Map updated/);
console.log("saved project map ok");

// add_calendar_event: a card under the reply; bad input goes back to Claude to fix.
let eventReport = "", badReport = "";
const cal: any = {
  configured: true, webAccess: false,
  chat: async ({ exec }: any) => {
    badReport = await exec("add_calendar_event", { title: "Viewing", date: "Thursday", start_time: "", end_time: "", end_date: "", location: "", notes: "" });
    eventReport = await exec("add_calendar_event", { title: "Viewing", date: "2026-10-29", start_time: "18:00", end_time: "", end_date: "", location: "Oranienstr. 12", notes: "" });
    return "Here's the viewing.";
  },
};
await new Controller(store, cal, () => {}).send(project, "put the viewing on thursday at 6 in my calendar");
const calReply = chat.filter((e) => e.kind === "ai").pop()!.body;
assert.equal(calReply, 'Here\'s the viewing.\n\n```cleardesk-event\n{"title":"Viewing","start":"2026-10-29T18:00","end":"2026-10-29T19:00","location":"Oranienstr. 12"}\n```');
assert.match(badReport, /YYYY-MM-DD/);
assert.match(eventReport, /Thu 29 Oct · 18:00–19:00/);
console.log("calendar event card ok");

// show_widget: the widget goes under the reply; a widget loading from the web is sent back to Claude.
let widgetReport = "", badWidget = "";
const wid: any = {
  configured: true, webAccess: false,
  chat: async ({ exec }: any) => {
    badWidget = await exec("show_widget", { title: "Chart", description: "", html: '<script src="https://cdn.example/x.js"></script>' });
    widgetReport = await exec("show_widget", { title: "Budget", description: "Monthly costs as bars", html: "<svg></svg>" });
    return "Here's your budget.";
  },
};
await new Controller(store, wid, () => {}).send(project, "chart my budget");
assert.equal(chat.filter((e) => e.kind === "ai").pop()!.body, 'Here\'s your budget.\n\n```cleardesk-widget\n{"title":"Budget","description":"Monthly costs as bars","html":"<svg></svg>"}\n```');
assert.match(badWidget, /offline/);
assert.match(widgetReport, /sandboxed offline frame/);
console.log("widget ok");

// save: true keeps the widget as Widgets/<title>.md; the reply shows it live; read_file gives its code.
let savedWidgetReport = "", widgetCode = "";
const ws: any = {
  configured: true, webAccess: false,
  chat: async ({ exec }: any) => {
    savedWidgetReport = await exec("show_widget", { title: "Budget", description: "Monthly costs", html: "<svg id=v1></svg>", save: true });
    widgetCode = await exec("read_file", { path: "Widgets/Budget.md" });
    return "Saved it.";
  },
};
await new Controller(store, ws, () => {}).send(project, "keep a budget chart");
const wfile = files.get("APARTMENTS/Widgets/Budget.md")!;
assert.match(wfile, /^# Budget\n\nMonthly costs\n\n```cleardesk-widget\n/);
assert.equal(chat.filter((e) => e.kind === "ai").pop()!.body, 'Saved it.\n\n```cleardesk-widget\n{"file":"APARTMENTS/Widgets/Budget.md"}\n```');
assert.match(chat.filter((e) => e.kind === "receipt").pop()!.body, /🧩 Widget saved · \[\[APARTMENTS\/Widgets\/Budget\|Budget\]\]/);
assert.match(savedWidgetReport, /Saved as Widgets\/Budget\.md, shared by all chats/);
assert.match(JSON.stringify(widgetCode), /<svg id=v1><\/svg>/, "Claude reads a saved widget's code, not just its description");
ws.chat = async ({ exec }: any) => {
  savedWidgetReport = await exec("show_widget", { title: "Budget", description: "Monthly costs with notary fee", html: "<svg id=v2></svg>", save: true });
  return "Updated.";
};
await new Controller(store, ws, () => {}).send(project, "add the notary fee");
assert.match(files.get("APARTMENTS/Widgets/Budget.md")!, /id=v2/);
assert.match(savedWidgetReport, /Updated Widgets\/Budget\.md/);
assert.match(chat.filter((e) => e.kind === "receipt").pop()!.body, /🧩 Widget updated/);
console.log("saved project widget ok");
