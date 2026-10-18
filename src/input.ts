// Chat input grammar.
//   /t send payslips mon        -> one task
//   /n kreuzberg is loud        -> one note
//   /t  (Enter) ... //          -> block: every line is a task
//   /n  (Enter) ... //          -> block: one multi-line note
//   anything else               -> chat with the AI

export type CommandKind = "task" | "note";

export interface ParsedMessage {
  kind: CommandKind | "chat";
  /** task: one entry per task; note: a single entry; chat: a single entry */
  items: string[];
}

const OPENERS: Record<string, CommandKind> = { "/t": "task", "/n": "note" };

/** "/t" or "/n" typed alone opens a block. */
export function blockOpener(value: string): CommandKind | null {
  return OPENERS[value.trim()] ?? null;
}

/**
 * If the last line closes the block ("//" alone, or "... //"), return the
 * block content without the closer; otherwise null. "https://x" never closes.
 */
export function closeBlock(text: string): string | null {
  const lines = text.replace(/\s+$/, "").split("\n");
  const last = lines[lines.length - 1];
  if (last.trim() === "//") return lines.slice(0, -1).join("\n");
  if (/\s\/\/$/.test(last)) {
    lines[lines.length - 1] = last.replace(/\s+\/\/$/, "");
    return lines.join("\n");
  }
  return null;
}

export function blockItems(kind: CommandKind, content: string): string[] {
  if (kind === "task") {
    return content
      .split("\n")
      .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim())
      .filter(Boolean);
  }
  const note = content.replace(/^\n+|\s+$/g, "");
  return note ? [note] : [];
}

/** Parse a complete message (single line, or a pasted full block). */
export function parseMessage(text: string): ParsedMessage {
  const trimmed = text.replace(/^\s+|\s+$/g, "");
  const firstLine = trimmed.split("\n")[0];
  const opener = blockOpener(firstLine);
  if (opener) {
    const rest = trimmed.split("\n").slice(1).join("\n");
    const content = closeBlock(rest) ?? rest;
    return { kind: opener, items: blockItems(opener, content) };
  }
  const m = /^\/([tn])\s+([\s\S]*)$/.exec(trimmed);
  if (m) {
    const kind = OPENERS[`/${m[1]}`];
    const content = closeBlock(m[2]) ?? m[2];
    return { kind, items: blockItems(kind, content) };
  }
  return { kind: "chat", items: trimmed ? [trimmed] : [] };
}
