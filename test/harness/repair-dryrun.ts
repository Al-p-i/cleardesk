// Dry run of the attachment-link repair on a real project folder. Read-only.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseEntries, splitEmbeds } from "../../src/format.ts";
import { planRepairs, type MissingRef } from "../../src/relink.ts";

const [vault, project] = process.argv.slice(2);
const chatDir = join(vault, project, "_project/chat");
const missing: MissingRef[] = [];
const linked = new Set<string>();
for (const f of readdirSync(chatDir).filter((n) => /^\d{4}-\d{2}\.md$/.test(n))) {
  for (const e of parseEntries(readFileSync(join(chatDir, f), "utf8"))) {
    for (const link of splitEmbeds(e.body).files) {
      if (existsSync(join(vault, link))) linked.add(link);
      else missing.push({ path: link, sent: e.datetime });
    }
  }
}
const files: { path: string; ctime: number }[] = [];
const walk = (rel: string) => {
  for (const n of readdirSync(join(vault, rel))) {
    const r = `${rel}/${n}`;
    if (r === `${project}/_project` || n.startsWith(".")) continue;
    const st = statSync(join(vault, r));
    if (st.isDirectory()) walk(r);
    else if (!n.endsWith(".md") && !linked.has(r)) files.push({ path: r, ctime: st.birthtimeMs });
  }
};
walk(project);
const { repairs, unresolved } = planRepairs(missing, files);
console.log(`broken links: ${missing.length} · unlinked files: ${files.length}`);
for (const r of repairs) console.log(`  ${r.sent}: ${r.pairs.length} → ${[...new Set(r.pairs.map((p) => p.to.split("/").slice(-2, -1)[0]))].join(", ")}`);
console.log(`would repair: ${repairs.reduce((n, r) => n + r.pairs.length, 0)} · left alone: ${unresolved.map((u) => u.path.split("/").pop()).join(", ") || "none"}`);
