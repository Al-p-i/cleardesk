// Copy the built plugin into a vault for testing.
// Target: $CLEARDESK_PLUGIN_DIR, or the path in .deploy-target (one line, git-ignored), e.g.
//   /path/to/your/vault/.obsidian/plugins/cleardesk
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";

const target =
  process.env.CLEARDESK_PLUGIN_DIR ?? (existsSync(".deploy-target") ? readFileSync(".deploy-target", "utf8").trim() : "");
if (!target) {
  console.error("Set CLEARDESK_PLUGIN_DIR or put your vault's .obsidian/plugins/cleardesk path in .deploy-target");
  process.exit(1);
}
mkdirSync(target, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) copyFileSync(`build/${f}`, `${target}/${f}`);
console.log(`Deployed to ${target}. Reload ClearDesk in Obsidian to pick it up.`);
