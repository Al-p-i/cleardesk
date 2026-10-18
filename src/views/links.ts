import { splitUrls } from "../format";

/** Open a web link in the system browser. */
export function openExternal(url: string) {
  window.open(url, "_blank");
}

/** Append text to el, turning URLs into clickable links. */
export function appendLinkified(el: HTMLElement, text: string) {
  for (const part of splitUrls(text)) {
    if (!part.url) {
      el.appendText(part.text);
      continue;
    }
    const a = el.createEl("a", { cls: "external-link", text: part.text, href: part.url, attr: { target: "_blank", rel: "noopener" } });
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openExternal(part.url!);
    });
  }
}
