// Path rules for the AI's file tools: everything stays inside the project
// folder, and ClearDesk's own _project/ folder is off limits.
// Pure functions, so they can be unit-tested.

const BAD_CHARS = /[\\:*?"<>|#^[\]]/;

/**
 * Turn a path relative to the project folder into a vault path, or explain
 * why it isn't allowed. "" (or ".") means the project folder itself.
 */
export function projectPath(folder: string, rel: string): { path: string } | { error: string } {
  const raw = rel.trim().replace(/\\/g, "/").replace(/^\.?\/+/, "");
  if (/^[a-z]+:/i.test(raw)) return { error: "Use a path inside the project folder, not a URL or drive path." };
  const parts = raw.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === "..")) return { error: "Paths can't go outside the project folder." };
  if (parts[0] === "_project") return { error: "ClearDesk's own _project folder can't be changed." };
  const bad = parts.find((p) => BAD_CHARS.test(p) || p.startsWith(" ") || p.endsWith(" ") || p.endsWith("."));
  if (bad !== undefined) return { error: `"${bad}" isn't a valid name. Avoid \\ : * ? " < > | # ^ [ ] and leading/trailing spaces.` };
  return { path: parts.length ? `${folder}/${parts.join("/")}` : folder };
}

/** Path relative to the project folder, for messages. */
export function relPath(folder: string, path: string): string {
  return path === folder ? "(project folder)" : path.startsWith(folder + "/") ? path.slice(folder.length + 1) : path;
}

/** If `to` names an existing folder, the item moves into it keeping its name. */
export function moveTarget(to: string, name: string, toIsFolder: boolean): string {
  return toIsFolder ? `${to}/${name}` : to;
}
