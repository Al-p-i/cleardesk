import esbuild from "esbuild";
import builtins from "builtin-modules";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const watch = process.argv.includes("--watch");
const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtins],
  format: "cjs",
  target: "es2020",
  platform: "browser",
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  outfile: "build/main.js",
  logLevel: "info",
});
// Obsidian loads one stylesheet: Leaflet's (for maps) followed by ours.
mkdirSync("build", { recursive: true });
writeFileSync("build/styles.css", readFileSync("node_modules/leaflet/dist/leaflet.css", "utf8") + "\n" + readFileSync("styles.css", "utf8"));

if (watch) await ctx.watch();
else { await ctx.rebuild(); await ctx.dispose(); }
