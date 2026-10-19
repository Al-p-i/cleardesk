// Google Docs/Sheets/Slides/Drive links -> export URLs that return the full
// content without JavaScript. Works for anything shared "Anyone with the link".
// Pure functions, so they can be unit-tested.

interface GoogleExport {
  kind: "doc" | "sheet" | "slides" | "file";
  id: string;
  url: string;
  /** e.g. "tab t.abc" or "sheet gid 123", for the model's context */
  part?: string;
}

export function googleExportUrl(link: string): GoogleExport | null {
  let u: URL;
  try {
    u = new URL(link.trim());
  } catch {
    return null;
  }
  const id = /\/d\/([A-Za-z0-9_-]{10,})/.exec(u.pathname)?.[1] ?? u.searchParams.get("id") ?? "";
  if (!id) return null;
  if (u.hostname === "docs.google.com") {
    if (u.pathname.startsWith("/document/")) {
      // No tab -> the whole document (all tabs). A tab in the link -> just that tab.
      const tab = u.searchParams.get("tab");
      return {
        kind: "doc",
        id,
        url: `https://docs.google.com/document/d/${id}/export?format=md${tab ? `&tab=${encodeURIComponent(tab)}` : ""}`,
        part: tab ? `tab ${tab}` : undefined,
      };
    }
    if (u.pathname.startsWith("/spreadsheets/")) {
      const gid = u.searchParams.get("gid") ?? /gid=(\d+)/.exec(u.hash)?.[1];
      return {
        kind: "sheet",
        id,
        url: `https://docs.google.com/spreadsheets/d/${id}/export?format=csv${gid ? `&gid=${gid}` : ""}`,
        part: gid ? `sheet gid ${gid}` : "first sheet",
      };
    }
    if (u.pathname.startsWith("/presentation/")) {
      return { kind: "slides", id, url: `https://docs.google.com/presentation/d/${id}/export/txt` };
    }
  }
  if (u.hostname === "drive.google.com") {
    return { kind: "file", id, url: `https://drive.google.com/uc?export=download&id=${id}` };
  }
  return null;
}

/** Drop embedded base64 images from a markdown export; they're huge and unreadable as text. */
export function cleanExport(text: string): string {
  return text
    .replace(/^\[image\d+\]:\s*<data:image\/[^>]+>\s*$/gm, "")
    .replace(/!\[([^\]]*)\]\(data:image\/[^)]+\)/g, "[image: $1]")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

/** True when Google answered with a sign-in or error page instead of the content. */
export function looksLikeLoginPage(contentType: string, text: string): boolean {
  return /text\/html/i.test(contentType) && /accounts\.google\.com|<title>[^<]*(Sign in|Google Docs|Error)/i.test(text);
}
