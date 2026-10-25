// Maps in chat. Claude's show_map tool produces a spec; the app looks the places up and
// saves the resolved map as a fenced block in the reply, so it redraws without lookups:
//
//   ```cleardesk-map
//   {"title":"Shortlisted flats","places":[{"name":"Oranienstr. 12","lat":52.501,"lng":13.418,"color":"green"}], ...}
//   ```

import { EVENT_BLOCK, eventText, parseEvent } from "./calendar";

export const MAP_BLOCK = "cleardesk-map";

export const MAP_COLORS = ["green", "red", "blue", "orange", "purple", "grey"] as const;
export type MapColor = (typeof MAP_COLORS)[number];

export interface MapPlace { name: string; lat: number; lng: number; color: MapColor; details?: string; note?: string }
/** An area with no outline in OpenStreetMap keeps only its centre (drawn as a pin). */
export interface MapArea { name: string; lat: number; lng: number; color: MapColor; label?: string; shape?: unknown }
export interface MapCircle { lat: number; lng: number; radius: number; color: MapColor; label?: string; center: string }
export interface MapLine { from: [number, number]; to: [number, number]; color: MapColor; label?: string; ends: [string, string] }

export interface MapSpec {
  title: string;
  places: MapPlace[];
  areas: MapArea[];
  circles: MapCircle[];
  lines: MapLine[];
  legend: { color: MapColor; label: string }[];
  /** Places and areas that couldn't be found. */
  missing: string[];
}

export const asColor = (c: unknown): MapColor => (MAP_COLORS.includes(c as MapColor) ? (c as MapColor) : "blue");

export function mapBlock(spec: MapSpec): string {
  return "```" + MAP_BLOCK + "\n" + JSON.stringify(spec) + "\n```";
}

/** A saved map in the project: `Maps/<title>.md`, with the map and a readable list of what's on it. */
export const MAPS_DIR = "Maps";

export function mapFileName(title: string): string {
  const clean = title.replace(/[\\/:*?"<>|#^[\]]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return `${MAPS_DIR}/${clean || "Map"}.md`;
}

export function mapFile(spec: MapSpec): string {
  const list = mapText(spec).split("\n").slice(1).join("\n");
  // A heading first: Obsidian shows a code block's source while the cursor is in it, and a
  // newly opened file puts the cursor on the first line.
  return `# ${spec.title || "Map"}\n\n${mapBlock(spec)}\n\nOn this map (kept up to date by ClearDesk; ask Claude to change it):\n\n${list}\n`;
}

/** In a chat reply: shows the saved map's current state, wherever it's drawn. */
export function mapRef(path: string): string {
  return "```" + MAP_BLOCK + "\n" + JSON.stringify({ file: path }) + "\n```";
}

/** The vault path a map block points to, if it's a reference to a saved map. */
export function mapRefPath(src: string): string | null {
  try {
    const o = JSON.parse(src);
    return o && typeof o.file === "string" ? o.file : null;
  } catch {
    return null;
  }
}

/** The first map in a note (a saved map file). */
export function mapInNote(text: string): MapSpec | null {
  const m = new RegExp("```" + MAP_BLOCK + "\\n([\\s\\S]*?)\\n```").exec(text);
  return m ? parseMap(m[1]) : null;
}

/** A saved map block's source back into a spec (tolerant of missing fields). */
export function parseMap(src: string): MapSpec | null {
  try {
    const o = JSON.parse(src);
    if (!o || typeof o !== "object") return null;
    const arr = (v: unknown) => (Array.isArray(v) ? v : []);
    return {
      title: String(o.title ?? ""),
      places: arr(o.places),
      areas: arr(o.areas),
      circles: arr(o.circles),
      lines: arr(o.lines),
      legend: arr(o.legend),
      missing: arr(o.missing).map(String),
    };
  } catch {
    return null;
  }
}

/** The map as plain text: what Claude sees in the history, and what the copy button copies. */
export function mapText(spec: MapSpec): string {
  const lines = [`Map: ${spec.title || "untitled"}`];
  for (const p of spec.places) lines.push(`- ${p.name} (${p.color})${p.details ? `: ${p.details}` : ""}`);
  for (const a of spec.areas) lines.push(`- Area ${a.name} (${a.color}${a.label ? `, ${a.label}` : ""})${a.shape ? "" : ", no outline"}`);
  for (const c of spec.circles) lines.push(`- Within ${distance(c.radius)} of ${c.center}${c.label ? `: ${c.label}` : ""}`);
  for (const l of spec.lines) lines.push(`- Line ${l.ends[0]} → ${l.ends[1]}${l.label ? `: ${l.label}` : ""}`);
  if (spec.legend.length) lines.push(`Legend: ${spec.legend.map((g) => `${g.color} = ${g.label}`).join(", ")}`);
  if (spec.missing.length) lines.push(`Not found: ${spec.missing.join(", ")}`);
  return lines.join("\n");
}

const BLOCK_RE = new RegExp("```(" + MAP_BLOCK + "|" + EVENT_BLOCK + ")\\n([\\s\\S]*?)\\n```", "g");

/** Replace every map and calendar-event block in a message with its text form. */
export function blocksAsText(body: string): string {
  if (!body.includes("```" + MAP_BLOCK) && !body.includes("```" + EVENT_BLOCK)) return body;
  return body.replace(BLOCK_RE, (_, kind: string, src: string) => {
    if (kind === EVENT_BLOCK) {
      const ev = parseEvent(src);
      return ev ? `[${eventText(ev)}]` : "[Calendar event]";
    }
    const file = mapRefPath(src);
    if (file) return `[Saved map, always current: ${file}]`;
    const spec = parseMap(src);
    return spec ? `[${mapText(spec)}]` : "[Map]";
  });
}

export function distance(m: number): string {
  return m >= 1000 ? `${+(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

/** "52.52, 13.405" typed as an address. */
export function parseLatLng(s: string): [number, number] | null {
  const m = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(s);
  if (!m) return null;
  const lat = +m[1], lng = +m[2];
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? [lat, lng] : null;
}

/** Round GeoJSON coordinates to ~1 m to keep saved outlines small. */
export function roundShape(geo: unknown): unknown {
  const r = (v: unknown): unknown => (Array.isArray(v) ? v.map(r) : typeof v === "number" ? Math.round(v * 1e5) / 1e5 : v);
  if (!geo || typeof geo !== "object") return geo;
  const g = geo as { type: string; coordinates: unknown };
  return { type: g.type, coordinates: r(g.coordinates) };
}
