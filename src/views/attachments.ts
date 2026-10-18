import { App, TFile, setIcon } from "obsidian";

const IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "heic", "avif"];

export function isImageName(name: string): boolean {
  return IMAGE_EXT.includes(name.split(".").pop()?.toLowerCase() ?? "");
}

const FILE_ICON: Record<string, string> = {
  pdf: "file-text", md: "file-text", txt: "file-text", csv: "sheet", xlsx: "sheet", docx: "file-type",
};

/** Thumbnails for images and chips for other files; clicking opens the file in Obsidian. */
export function renderAttachments(
  app: App,
  parent: HTMLElement,
  paths: string[],
  opts: { resolve?: (link: string) => TFile | null; onMissing?: (link: string) => void } = {}
): number {
  if (!paths.length) return 0;
  const row = parent.createDiv("cd-attachments");
  let missing = 0;
  for (const path of paths) {
    const f = opts.resolve ? opts.resolve(path) : app.vault.getAbstractFileByPath(path);
    if (!f) {
      missing++;
      opts.onMissing?.(path);
    }
    const name = (f instanceof TFile ? f.name : path.split("/").pop()) ?? path;
    const open = (ev: MouseEvent) => {
      ev.stopPropagation();
      if (f instanceof TFile) app.workspace.getLeaf("tab").openFile(f);
    };
    if (f instanceof TFile && isImageName(name)) {
      const img = row.createEl("img", { cls: "cd-thumb", attr: { src: app.vault.getResourcePath(f), alt: name, title: name } });
      img.addEventListener("click", open);
    } else {
      const chip = row.createDiv({
        cls: "cd-file-chip" + (f ? "" : " is-missing"),
        attr: { title: f ? name : `${name} is no longer in the vault` },
      });
      setIcon(chip.createSpan("cd-file-icon"), FILE_ICON[name.split(".").pop()?.toLowerCase() ?? ""] ?? "file");
      chip.createSpan({ cls: "cd-file-name", text: name });
      if (!f) chip.createSpan({ cls: "cd-file-removed", text: "removed" });
      chip.addEventListener("click", open);
    }
  }
  return missing;
}
