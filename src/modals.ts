import { Modal, Notice, Setting, TFolder } from "obsidian";
import type ClearDesk from "./main";
import type { OldTodo } from "./controller";
import { Project, SYSTEM_DIR } from "./store";

/** Create a project: a new folder, or an existing top-level folder. */
export class NewProjectModal extends Modal {
  constructor(private plugin: ClearDesk, private onDone: (folder: string, existing: boolean) => Promise<void>) {
    super(plugin.app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("cleardesk");
    this.setTitle("New project");
    const taken = new Set(this.plugin.projects.map((p) => p.folder));
    const folders = this.app.vault
      .getRoot()
      .children.filter((c): c is TFolder => c instanceof TFolder && !taken.has(c.path) && !c.name.startsWith("."))
      .map((f) => f.path)
      .sort();

    let name = "";
    let existing = "";
    new Setting(contentEl)
      .setName("Use an existing folder")
      .setDesc("Its notes stay as they are. Open todos can be imported next.")
      .addDropdown((d) => {
        d.addOption("", "— choose —");
        for (const f of folders) d.addOption(f, f);
        d.onChange((v) => (existing = v));
      });
    new Setting(contentEl)
      .setName("…or create a new one")
      .addText((t) => t.setPlaceholder("Project name").onChange((v) => (name = v)));
    new Setting(contentEl).addButton((b) =>
      b.setButtonText("Create project").setCta().onClick(async () => {
        const folder = existing || name.trim().replace(/[\\:*?"<>|#^[\]]/g, " ").trim();
        if (!folder) {
          new Notice("Choose a folder or enter a name.");
          return;
        }
        if (taken.has(folder)) {
          new Notice("That folder is already a project.");
          return;
        }
        this.close();
        await this.onDone(folder, !!existing);
      })
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** Review open checkboxes found in a project's old notes and copy them into tasks. */
export class ImportModal extends Modal {
  constructor(private plugin: ClearDesk, private project: Project, private todos?: OldTodo[]) {
    super(plugin.app);
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.addClass("cleardesk", "cd-import");
    this.setTitle(`Import todos into ${this.project.name}`);
    const todos = this.todos ?? (await this.plugin.controller.findOldTodos(this.project));
    if (!todos.length) {
      contentEl.createEl("p", { text: "No open todos found in this project's notes." });
      return;
    }
    contentEl.createEl("p", {
      cls: "cd-muted",
      text: `Found ${todos.length} open todo(s) in old notes. Ticked ones are copied into the task list, each with a link back to its note. The original notes are not changed.`,
    });
    const keep = new Set(todos.map((_, i) => i));
    const list = contentEl.createDiv("cd-import-list");
    let lastFile = "";
    todos.forEach((t, i) => {
      if (t.file.path !== lastFile) {
        lastFile = t.file.path;
        list.createDiv({ cls: "cd-import-file", text: t.file.path.slice(this.project.folder.length + 1).replace(new RegExp(`^${SYSTEM_DIR}/`), "") });
      }
      const row = list.createEl("label", { cls: "cd-import-row" });
      const cb = row.createEl("input", { type: "checkbox" });
      cb.checked = true;
      cb.addEventListener("change", () => (cb.checked ? keep.add(i) : keep.delete(i)));
      row.createSpan({ text: t.task.text + (t.task.due ? ` · ${t.task.due}` : "") });
    });
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Skip").onClick(() => this.close()))
      .addButton((b) =>
        b.setButtonText("Import ticked").setCta().onClick(async () => {
          const chosen = todos.filter((_, i) => keep.has(i));
          await this.plugin.controller.importTodos(this.project, chosen);
          new Notice(`Imported ${chosen.length} task(s).`);
          this.close();
        })
      );
  }

  onClose() {
    this.contentEl.empty();
  }
}
