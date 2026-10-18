// API key checks. Pure functions, so they can be unit-tested.

/** Why a pasted API key can't be used, or null if it looks right. */
export function keyProblem(key: string): string | null {
  if (!key) return "Add your Anthropic API key in Settings → ClearDesk to chat with the AI. /t and /n already work without it.";
  if (/[^\x21-\x7e]/.test(key)) return "The API key in Settings → ClearDesk contains spaces or special characters. Paste only the key itself (one string starting with sk-ant-).";
  if (!key.startsWith("sk-ant-")) return "The API key in Settings → ClearDesk doesn't look right: Anthropic keys start with sk-ant-.";
  return null;
}

/** Keys never contain whitespace; drop any that came along with a paste. */
export function cleanKey(raw: string): string {
  return raw.replace(/[\s\u200B-\u200D\uFEFF]/g, "");
}
