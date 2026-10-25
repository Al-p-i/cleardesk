// Finding places for maps: OpenStreetMap's Nominatim, at most one lookup per second as
// its usage policy asks, with results cached per project in _project/places.json.
import { requestUrl } from "obsidian";
import { Store, projectPaths } from "./store";
import {
  MapArea, MapCircle, MapLine, MapPlace, MapSpec, asColor, distance, parseLatLng, roundShape,
} from "./map";

export interface Found { lat: number; lng: number; shape?: unknown }
export type Find = (query: string, outline: boolean) => Promise<Found | null>;

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "ClearDesk Obsidian plugin (https://github.com/Al-p-i/cleardesk)";
let lastLookup = 0; // shared by all projects: the limit is per app

export class Geocoder {
  /** Set when the lookup service failed (not just "no such place"). */
  failed = false;
  private cache: Record<string, Found> | null = null;
  private added = false;

  constructor(private store: Store, private folder: string) {}

  find: Find = async (query, outline) => {
    const ll = parseLatLng(query);
    if (ll && !outline) return { lat: ll[0], lng: ll[1] };
    const key = `${outline ? "area" : "place"}:${query.trim().toLowerCase()}`;
    this.cache ??= parseCache(await this.store.read(projectPaths(this.folder).places));
    if (this.cache[key]) return this.cache[key];

    const params = new URLSearchParams({ q: query, format: "jsonv2", limit: "1" });
    if (outline) {
      params.set("polygon_geojson", "1");
      params.set("polygon_threshold", "0.0005"); // simplified outline, ~50 m
    }
    const wait = lastLookup + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastLookup = Date.now();
    let hit: { lat: string; lon: string; geojson?: { type: string } } | undefined;
    try {
      const res = await requestUrl({ url: `${NOMINATIM}?${params}`, headers: { "User-Agent": USER_AGENT }, throw: false });
      if (res.status !== 200) throw new Error(String(res.status));
      hit = (res.json as typeof hit[])[0];
    } catch (e) {
      console.warn("ClearDesk: place lookup failed", e);
      this.failed = true;
      return null;
    }
    if (!hit) return null;
    const found: Found = { lat: +(+hit.lat).toFixed(5), lng: +(+hit.lon).toFixed(5) };
    if (outline && /Polygon$/.test(hit.geojson?.type ?? "")) found.shape = roundShape(hit.geojson);
    this.cache[key] = found;
    this.added = true;
    return found;
  };

  async save() {
    if (!this.added || !this.cache) return;
    const cache = this.cache;
    // Merge with what's on disk, in case another turn saved places meanwhile.
    await this.store.modify(projectPaths(this.folder).places, (text) => JSON.stringify({ ...parseCache(text), ...cache }) + "\n");
    this.added = false;
  }
}

function parseCache(text: string): Record<string, Found> {
  try {
    const o = JSON.parse(text || "{}");
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

// ---------- from the show_map tool input to a saved map ----------

export interface MapInput {
  title: string;
  places: { name: string; address: string; color: string; details: string; note_id: string }[];
  areas: { name: string; color: string; label: string }[];
  circles: { center: string; radius_m: number; color: string; label: string }[];
  lines: { from: string; to: string; color: string; label: string }[];
  legend: { color: string; label: string }[];
}

const LIMITS = { places: 40, areas: 10, circles: 10, lines: 20 };

/** Look everything up (one place at a time) and build the map to save. */
export async function resolveMap(input: MapInput, find: Find, progress: (done: number, total: number) => void): Promise<MapSpec> {
  const places = (input.places ?? []).slice(0, LIMITS.places);
  const areas = (input.areas ?? []).slice(0, LIMITS.areas);
  const circles = (input.circles ?? []).slice(0, LIMITS.circles);
  const lines = (input.lines ?? []).slice(0, LIMITS.lines);
  const spec: MapSpec = {
    title: String(input.title ?? "").trim(),
    places: [], areas: [], circles: [], lines: [],
    legend: (input.legend ?? []).filter((g) => g.label).map((g) => ({ color: asColor(g.color), label: g.label.trim() })),
    missing: [],
  };
  const total = places.length + areas.length + circles.length + lines.length * 2;
  let done = 0;
  const step = () => progress(++done, total);

  // Circle centres and line ends may name a place on the map, or be an address.
  const known = new Map<string, [number, number]>();
  const point = async (q: string): Promise<[number, number] | null> => {
    const k = q.trim().toLowerCase();
    if (known.has(k)) return known.get(k)!;
    const f = await find(q, false);
    if (!f) return null;
    known.set(k, [f.lat, f.lng]);
    return [f.lat, f.lng];
  };
  const miss = (name: string) => { if (!spec.missing.includes(name)) spec.missing.push(name); };

  for (const p of places) {
    const f = await find((p.address || p.name).trim(), false);
    step();
    if (!f) { miss(p.name); continue; }
    const place: MapPlace = { name: p.name.trim(), lat: f.lat, lng: f.lng, color: asColor(p.color) };
    if (p.details?.trim()) place.details = p.details.trim();
    if (p.note_id?.trim()) place.note = p.note_id.trim();
    spec.places.push(place);
    known.set(place.name.toLowerCase(), [f.lat, f.lng]);
  }
  for (const a of areas) {
    const f = await find(a.name.trim(), true);
    step();
    if (!f) { miss(a.name); continue; }
    const area: MapArea = { name: a.name.split(",")[0].trim(), lat: f.lat, lng: f.lng, color: asColor(a.color) };
    if (a.label?.trim()) area.label = a.label.trim();
    if (f.shape) area.shape = f.shape;
    spec.areas.push(area);
  }
  for (const c of circles) {
    const at = await point(c.center);
    step();
    const radius = Math.min(Math.max(Number(c.radius_m) || 0, 10), 200000);
    if (!at) { miss(c.center); continue; }
    const circle: MapCircle = { lat: at[0], lng: at[1], radius, color: asColor(c.color), center: c.center.trim() };
    circle.label = c.label?.trim() || `${distance(radius)} from ${circle.center}`;
    spec.circles.push(circle);
  }
  for (const l of lines) {
    const from = await point(l.from);
    step();
    const to = await point(l.to);
    step();
    if (!from) miss(l.from);
    if (!to) miss(l.to);
    if (!from || !to) continue;
    const line: MapLine = { from, to, color: asColor(l.color), ends: [l.from.trim(), l.to.trim()] };
    if (l.label?.trim()) line.label = l.label.trim();
    spec.lines.push(line);
  }
  return spec;
}

/** What the tool tells Claude after the map is made. */
export function mapReport(spec: MapSpec, failed: boolean): string {
  const shown = [
    spec.places.length && `${spec.places.length} place${spec.places.length === 1 ? "" : "s"}`,
    spec.areas.length && `${spec.areas.length} area${spec.areas.length === 1 ? "" : "s"}`,
    spec.circles.length && `${spec.circles.length} circle${spec.circles.length === 1 ? "" : "s"}`,
    spec.lines.length && `${spec.lines.length} line${spec.lines.length === 1 ? "" : "s"}`,
  ].filter(Boolean);
  if (!shown.length) {
    return failed
      ? "The map couldn't be made: the address lookup service didn't respond. Try again later."
      : "Nothing could be found, so no map was shown. Use fuller addresses with the city.";
  }
  let out = `The map (${shown.join(", ")}) appears under your reply; don't repeat coordinates.`;
  if (spec.missing.length) out += ` Not found: ${spec.missing.join("; ")}${failed ? " (the lookup service didn't respond for some)" : ""}.`;
  const flat = spec.areas.filter((a) => !a.shape).map((a) => a.name);
  if (flat.length) out += ` No outline in OpenStreetMap for: ${flat.join(", ")} (shown as a pin).`;
  return out;
}
