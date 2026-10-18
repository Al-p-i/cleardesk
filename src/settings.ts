import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type ClearDesk from "./main";
import { DEFAULT_AI, cleanKey, keyProblem } from "./ai";

export class ClearDeskSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: ClearDesk) {
    super(app, plugin);
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();

    const keySetting = new Setting(containerEl)
      .setName("Anthropic API key")
      .setDesc("Stored in this vault's plugin data on your devices. Project content is sent to Anthropic's API when you chat.");
    const status = containerEl.createDiv({ cls: "cd-key-status" });
    const showStatus = () => {
      const problem = s.apiKey ? keyProblem(s.apiKey) : null;
      status.setText(problem ?? (s.apiKey ? "Key format looks right." : ""));
      status.toggleClass("is-error", !!problem);
    };
    keySetting.addText((t) => {
      t.inputEl.type = "password";
      t.setPlaceholder("sk-ant-…").setValue(s.apiKey).onChange(async (v) => {
        s.apiKey = cleanKey(v);
        showStatus();
        await save();
      });
    });
    showStatus();

    new Setting(containerEl)
      .setName("Web access")
      .setDesc("Let the chat search the web and read links you paste. Searches are billed per use by Anthropic.")
      .addToggle((t) =>
        t.setValue(s.webAccess !== false).onChange(async (v) => {
          s.webAccess = v;
          await save();
        })
      );

    new Setting(containerEl).setHeading().setName("Models");
    const model = (name: string, desc: string, key: "chatModel" | "fastModel" | "docModel") =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((t) =>
          t.setPlaceholder(DEFAULT_AI[key]).setValue(s[key]).onChange(async (v) => {
            s[key] = v.trim() || DEFAULT_AI[key];
            await save();
          })
        );
    model("Chat", "Answers questions and files facts from plain chat.", "chatModel");
    model("Fast", "Parses /t tasks and tags /n notes.", "fastModel");
    model("Documents", "Writes documents you ask for, running code for any calculations.", "docModel");

    new Setting(containerEl).setHeading().setName("Appearance");
    new Setting(containerEl)
      .setName("Text size")
      .setDesc("Size of chat messages and the side panel.")
      .addDropdown((d) =>
        d
          .addOptions({ compact: "Compact", default: "Default", roomy: "Roomy" })
          .setValue(s.textSize)
          .onChange(async (v) => {
            s.textSize = v as typeof s.textSize;
            this.plugin.applyBodyClasses();
            await save();
          })
      );
    new Setting(containerEl)
      .setName("Font")
      .setDesc("Interface font is cleaner for chat; reading font matches your notes.")
      .addDropdown((d) =>
        d
          .addOptions({ interface: "Interface font", text: "Reading font" })
          .setValue(s.font)
          .onChange(async (v) => {
            s.font = v as typeof s.font;
            this.plugin.applyBodyClasses();
            await save();
          })
      );

    new Setting(containerEl).setHeading().setName("Default project");
    let draft = this.plugin.store.home;
    const homeStatus = createDiv({ cls: "cd-key-status" });
    const showHome = () => {
      const problem = draft.trim() === this.plugin.store.home ? null : this.plugin.homeNameProblem(draft.trim());
      homeStatus.setText(problem ?? "");
      homeStatus.toggleClass("is-error", !!problem);
    };
    new Setting(containerEl)
      .setName("Name")
      .setDesc("The always-there project at the top of the list (Ctrl+0), for anything that isn't a project of its own. Renaming also renames its folder; links to it are updated.")
      .addText((t) =>
        t.setPlaceholder("Desk").setValue(draft).onChange((v) => {
          draft = v;
          showHome();
        })
      )
      .addButton((b) =>
        b.setButtonText("Rename").onClick(async () => {
          const name = draft.trim();
          if (name === this.plugin.store.home) return;
          try {
            b.setDisabled(true);
            await this.plugin.renameHome(name);
            new Notice(`Default project renamed to ${name}.`);
            this.display();
          } catch (e) {
            homeStatus.setText(e instanceof Error ? e.message : String(e));
            homeStatus.addClass("is-error");
            b.setDisabled(false);
          }
        })
      );
    containerEl.appendChild(homeStatus);

    new Setting(containerEl).setHeading().setName("Layout");
    new Setting(containerEl)
      .setName("File explorer shows only the current project")
      .setDesc("Hides the rest of the vault while you work in a project. Search and the quick switcher still find everything. Also available as the command \"Toggle whole vault in file explorer\".")
      .addToggle((t) =>
        t.setValue(s.explorerScope).onChange(async (v) => {
          s.explorerScope = v;
          this.plugin.applyExplorerScope();
          await save();
        })
      );
    new Setting(containerEl)
      .setName("Hide _project folders in the file explorer")
      .setDesc("They hold the tasks, notes and chat files. You can still open them through search.")
      .addToggle((t) =>
        t.setValue(s.hideSystemFolders).onChange(async (v) => {
          s.hideSystemFolders = v;
          this.plugin.applyBodyClasses();
          await save();
        })
      );
  }
}
