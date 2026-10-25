// show_map end to end: lookups (scripted OpenStreetMap answers), the per-project cache,
// the map block saved under the reply, and the text form Claude sees in the history.
import assert from "node:assert/strict";
import { Controller } from "../../src/controller";
import { Store } from "../../src/store";
import { parseMap } from "../../src/map";
import { calls, script } from "./obsidian-stub";

const files = new Map<string, string>();
const store = new Store({} as any);
const chat: any[] = [];
Object.assign(store, {
  read: async (p: string) => files.get(p) ?? "",
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
c.onStream = (_f, _t, status) => { if (status) statuses.push(status); };
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
for (const t of ["show_map", "read_file", "list_files", "search_notes", "search_chat", "read_google_doc"]) assert.ok(!strict.includes(t), `${t} isn't strict`);
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
