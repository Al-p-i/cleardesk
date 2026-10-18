// CSS that limits Obsidian's file explorer to one project folder.
// Display only: the files stay where they are and remain reachable via search.
// Pure function, so it can be unit-tested.

const css = (s: string) => JSON.stringify(s); // a quoted CSS string with escapes

/**
 * Hide every explorer item except the project folder, its contents, and the
 * folders above it (so a nested project stays reachable).
 */
export function explorerScopeCss(folder: string): string {
  if (!folder) return "";
  const parts = folder.split("/");
  const ancestors = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
  const keep = [
    `:not(:has(> .tree-item-self[data-path=${css(folder)}]))`,
    `:not(:has(> .tree-item-self[data-path^=${css(folder + "/")}]))`,
    ...ancestors.map((a) => `:not(:has(> .tree-item-self[data-path=${css(a)}]))`),
  ].join("");
  return (
    `.workspace-leaf-content[data-type="file-explorer"] .tree-item:not(.mod-root):has(> .tree-item-self[data-path])${keep}` +
    ` { display: none; }`
  );
}
