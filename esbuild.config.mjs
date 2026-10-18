import esbuild from "esbuild";
import builtins from "builtin-modules";

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
if (watch) await ctx.watch();
else { await ctx.rebuild(); await ctx.dispose(); }
