import { test } from "node:test";
import assert from "node:assert/strict";
import { asColor, distance, mapBlock, mapText, mapsAsText, parseLatLng, parseMap, roundShape, type MapSpec } from "../src/map.ts";

const spec: MapSpec = {
  title: "Shortlisted flats",
  places: [
    { name: "Oranienstr. 12", lat: 52.501, lng: 13.418, color: "green", details: "€1,450 · 2 rooms", note: "n-abc123" },
    { name: "Office", lat: 52.52, lng: 13.41, color: "blue" },
  ],
  areas: [
    { name: "Kreuzberg", lat: 52.49, lng: 13.4, color: "green", label: "favourite", shape: { type: "Polygon", coordinates: [[[13.4, 52.5], [13.41, 52.49], [13.39, 52.48], [13.4, 52.5]]] } },
    { name: "Wrangelkiez", lat: 52.5, lng: 13.44, color: "orange" },
  ],
  circles: [{ lat: 52.52, lng: 13.41, radius: 1000, color: "blue", center: "Office", label: "1 km from Office" }],
  lines: [{ from: [52.501, 13.418], to: [52.52, 13.41], color: "grey", ends: ["Oranienstr. 12", "Office"], label: "20 min by bike" }],
  legend: [{ color: "green", label: "shortlisted" }],
  missing: ["Nowhere 99"],
};

test("map blocks round-trip through the chat file", () => {
  const block = mapBlock(spec);
  assert.match(block, /^```cleardesk-map\n\{.*\}\n```$/s);
  const src = block.split("\n").slice(1, -1).join("\n");
  assert.deepEqual(parseMap(src), spec);
  assert.equal(parseMap("not json"), null);
  // Missing fields don't break drawing an older or hand-edited block.
  assert.deepEqual(parseMap('{"title":"x"}'), { title: "x", places: [], areas: [], circles: [], lines: [], legend: [], missing: [] });
});

test("maps become plain text for Claude's history, search and copy", () => {
  assert.equal(
    mapText(spec),
    [
      "Map: Shortlisted flats",
      "- Oranienstr. 12 (green): €1,450 · 2 rooms",
      "- Office (blue)",
      "- Area Kreuzberg (green, favourite)",
      "- Area Wrangelkiez (orange), no outline",
      "- Within 1 km of Office: 1 km from Office",
      "- Line Oranienstr. 12 → Office: 20 min by bike",
      "Legend: green = shortlisted",
      "Not found: Nowhere 99",
    ].join("\n")
  );
  const body = `Here they are.\n\n${mapBlock(spec)}\n\n${mapBlock({ ...spec, title: "Second" })}`;
  const text = mapsAsText(body);
  assert.ok(!text.includes("cleardesk-map") && !text.includes("52.501"));
  assert.match(text, /^Here they are\.\n\n\[Map: Shortlisted flats\n[\s\S]*\]\n\n\[Map: Second\n/);
  assert.equal(mapsAsText("no maps here"), "no maps here");
});

test("map helpers", () => {
  assert.deepEqual(parseLatLng("52.52, 13.405"), [52.52, 13.405]);
  assert.equal(parseLatLng("Oranienstr. 12, Berlin"), null);
  assert.equal(parseLatLng("120, 13"), null);
  assert.equal(distance(1000), "1 km");
  assert.equal(distance(1500), "1.5 km");
  assert.equal(distance(450), "450 m");
  assert.equal(asColor("purple"), "purple");
  assert.equal(asColor("teal"), "blue");
  assert.deepEqual(roundShape({ type: "Polygon", coordinates: [[[13.4123456, 52.4987654]]], extra: 1 }), { type: "Polygon", coordinates: [[[13.41235, 52.49877]]] });
});
