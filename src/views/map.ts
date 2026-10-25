// Draws a map (a cleardesk-map block) with Leaflet and OpenStreetMap tiles. A block is either
// a map itself, or a reference to a saved map file, which is drawn live as that file changes.
import { App, MarkdownRenderChild, Platform, TFile, debounce, setIcon } from "obsidian";
import * as L from "leaflet";
import { MapColor, MapSpec, distance, mapInNote } from "../map";

const HEX: Record<MapColor, string> = {
  green: "#2f9e44", red: "#e03131", blue: "#1c7ed6", orange: "#f08c00", purple: "#9c36b5", grey: "#868e96",
};

export interface MapActions {
  app: App;
  /** Show a note or fact a pin comes from. */
  openNote?: (id: string) => void;
  /** Keep a one-off map as a project map file (not offered inside a map file). */
  save?: (spec: MapSpec) => void;
}

export class MapChild extends MarkdownRenderChild {
  private map?: L.Map;
  private resize?: ResizeObserver;

  constructor(el: HTMLElement, private source: { spec: MapSpec } | { file: string }, private actions: MapActions) {
    super(el);
  }

  async onload() {
    if ("spec" in this.source) return this.draw(this.source.spec);
    // A saved map: draw the file as it is now, and again whenever it changes.
    const path = this.source.file;
    const redraw = debounce(() => this.drawFile(path), 300, true);
    this.registerEvent(this.actions.app.vault.on("modify", (f) => { if (f.path === path) redraw(); }));
    await this.drawFile(path);
  }

  private async drawFile(path: string) {
    const f = this.actions.app.vault.getAbstractFileByPath(path);
    const spec = f instanceof TFile ? mapInNote(await this.actions.app.vault.cachedRead(f)) : null;
    if (spec) return this.draw(spec, path);
    this.clear();
    this.containerEl.createDiv({ cls: "cd-map-note", text: `The saved map ${path} isn't there any more.` });
  }

  private clear() {
    this.resize?.disconnect();
    this.map?.remove();
    this.map = undefined;
    this.containerEl.empty();
  }

  private draw(spec: MapSpec, file?: string) {
    this.clear();
    const root = this.containerEl.createDiv("cd-map");
    const head = root.createDiv("cd-map-title");
    if (file) {
      // A saved map: its title opens the file.
      const a = head.createEl("a", { cls: "internal-link", text: spec.title || "Map", attr: { "data-href": file, href: file } });
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.actions.app.workspace.openLinkText(file, "", "tab");
      });
      head.createSpan({ cls: "cd-map-saved", text: "saved map" });
    } else {
      head.createSpan({ text: spec.title });
      if (this.actions.save) {
        const save = head.createSpan({ cls: "cd-map-save", attr: { "aria-label": "Keep this map in the project's Maps folder" } });
        setIcon(save.createSpan(), "bookmark-plus");
        save.createSpan({ text: "Save to project" });
        save.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this.actions.save!(spec);
        });
      }
    }
    const box = root.createDiv("cd-map-box");

    // Inactive until clicked, so scrolling the chat never zooms or drags the map by accident.
    const map = (this.map = L.map(box, { scrollWheelZoom: false, dragging: !Platform.isMobile, zoomSnap: 0.25 }));
    const offline = box.createDiv("cd-map-offline");
    offline.createDiv({ cls: "cd-map-popup-name", text: "Map needs internet" });
    for (const p of spec.places) offline.createDiv({ text: p.details ? `${p.name} · ${p.details}` : p.name });
    for (const a of spec.areas) offline.createDiv({ text: a.label ? `${a.name} · ${a.label}` : a.name });
    offline.hide();
    map.attributionControl.setPrefix(false);
    const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    });
    let loaded = false;
    tiles.on("tileload", () => { loaded = true; offline.hide(); });
    tiles.on("tileerror", () => { if (!loaded) offline.show(); });
    if (!navigator.onLine) offline.show();
    box.addEventListener("click", () => {
      map.scrollWheelZoom.enable();
      map.dragging.enable();
      root.addClass("is-active");
    });
    box.addEventListener("mouseleave", () => {
      map.scrollWheelZoom.disable();
      root.removeClass("is-active");
    });

    // The view has to be set before shapes are added; it's refitted once the box has a size.
    const bounds = mapBounds(spec);
    const fit = () => {
      map.invalidateSize();
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 16 });
      else map.setView([20, 0], 2);
    };
    if (bounds.isValid()) map.setView(bounds.getCenter(), 13);
    else map.setView([20, 0], 2);
    tiles.addTo(map);
    let fitted = false;
    this.resize = new ResizeObserver(() => {
      if (!box.clientWidth) return;
      if (!fitted) { fitted = true; fit(); } else map.invalidateSize();
    });
    this.resize.observe(box);

    for (const a of spec.areas) {
      const c = HEX[a.color];
      if (a.shape) {
        L.geoJSON(a.shape as GeoJSON.GeoJsonObject, { style: { color: c, weight: 2, fillColor: c, fillOpacity: 0.15 } }).addTo(map);
      } else {
        L.circleMarker([a.lat, a.lng], { radius: 9, color: c, weight: 2, dashArray: "3 3", fillOpacity: 0.1 }).addTo(map);
      }
      L.tooltip({ permanent: true, direction: "center", className: "cd-map-label" })
        .setLatLng([a.lat, a.lng])
        .setContent(a.label ? `${a.name} · ${a.label}` : a.name)
        .addTo(map);
    }
    for (const c of spec.circles) {
      L.circle([c.lat, c.lng], { radius: c.radius, color: HEX[c.color], weight: 1.5, dashArray: "5 5", fillOpacity: 0.06 })
        .bindTooltip(c.label || `${distance(c.radius)} from ${c.center}`)
        .addTo(map);
    }
    for (const l of spec.lines) {
      const line = L.polyline([l.from, l.to], { color: HEX[l.color], weight: 2.5, dashArray: "6 6" }).addTo(map);
      line.bindTooltip(l.label || `${l.ends[0]} → ${l.ends[1]}`);
    }
    for (const p of spec.places) {
      const pin = L.circleMarker([p.lat, p.lng], { radius: 7, color: "#fff", weight: 2, fillColor: HEX[p.color], fillOpacity: 1 }).addTo(map);
      pin.bindTooltip(p.name, { direction: "top", offset: [0, -6] });
      pin.bindPopup(() => {
        const el = createDiv("cd-map-popup");
        el.createDiv({ cls: "cd-map-popup-name", text: p.name });
        if (p.details) el.createDiv({ text: p.details });
        if (p.note && this.actions.openNote) {
          const link = el.createEl("a", { text: "Open note", href: "#" });
          link.addEventListener("click", (ev) => { ev.preventDefault(); this.actions.openNote!(p.note!); });
        }
        return el;
      });
    }

    if (spec.legend.length) {
      const legend = new L.Control({ position: "topright" });
      legend.onAdd = () => {
        const el = createDiv("cd-map-legend");
        for (const g of spec.legend) {
          const row = el.createDiv();
          row.createSpan({ cls: "cd-map-dot", attr: { style: `background:${HEX[g.color]}` } });
          row.appendText(g.label);
        }
        return el;
      };
      legend.addTo(map);
    }

    const flat = spec.areas.filter((a) => !a.shape).map((a) => a.name);
    const notes = [
      spec.missing.length ? `Not found: ${spec.missing.join(", ")}` : "",
      flat.length ? `No outline for ${flat.join(", ")} (shown as a pin)` : "",
    ].filter(Boolean);
    if (notes.length) root.createDiv({ cls: "cd-map-note", text: notes.join(" · ") });
  }

  onunload() {
    this.resize?.disconnect();
    this.map?.remove();
  }
}

/** Everything on the map, from the saved coordinates (no Leaflet view needed). */
function mapBounds(spec: MapSpec): L.LatLngBounds {
  const b = L.latLngBounds([]);
  for (const p of spec.places) b.extend([p.lat, p.lng]);
  for (const a of spec.areas) {
    b.extend([a.lat, a.lng]);
    if (a.shape) eachPoint((a.shape as { coordinates: unknown }).coordinates, (lng, lat) => b.extend([lat, lng]));
  }
  for (const c of spec.circles) {
    const dLat = c.radius / 111320;
    const dLng = dLat / Math.max(Math.cos((c.lat * Math.PI) / 180), 0.01);
    b.extend([c.lat - dLat, c.lng - dLng]).extend([c.lat + dLat, c.lng + dLng]);
  }
  for (const l of spec.lines) b.extend(l.from).extend(l.to);
  return b;
}

function eachPoint(coords: unknown, fn: (lng: number, lat: number) => void) {
  if (!Array.isArray(coords)) return;
  if (typeof coords[0] === "number") fn(coords[0], coords[1] as number);
  else for (const c of coords) eachPoint(c, fn);
}
