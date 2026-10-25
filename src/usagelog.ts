// Keeps the monthly cost estimate. Each device writes its own file in the plugin folder
// (usage-<device>.json), so devices syncing one vault don't overwrite each other's numbers.
import { App, debounce } from "obsidian";
import { monthKey, newId } from "./format";
import { UsageCounts, UsageLog, addUsage, costOf, mergeUsage } from "./usage";

export class UsageLogger {
  private own: Promise<UsageLog> | null = null;
  private dirty = false;
  private saveSoon = debounce(() => this.save(), 2000, true);

  constructor(private app: App, private dir: string) {}

  /** A random id for this device, kept in its local storage (not synced). */
  private device(): string {
    let id = this.app.loadLocalStorage("cleardesk-device") as string | null;
    if (!id) {
      id = newId("d");
      this.app.saveLocalStorage("cleardesk-device", id);
    }
    return id;
  }

  private path(): string {
    return `${this.dir}/usage-${this.device()}.json`;
  }

  private async read(path: string): Promise<UsageLog> {
    try {
      return (await this.app.vault.adapter.exists(path)) ? JSON.parse(await this.app.vault.adapter.read(path)) : {};
    } catch {
      return {};
    }
  }

  record(model: string, usage: UsageCounts) {
    const cost = costOf(model, usage);
    const month = monthKey(new Date());
    this.own = (this.own ?? this.read(this.path())).then((log) => addUsage(log, month, cost));
    this.dirty = true;
    this.saveSoon();
  }

  async save() {
    if (!this.dirty || !this.own) return;
    this.dirty = false;
    await this.app.vault.adapter.write(this.path(), JSON.stringify(await this.own) + "\n");
  }

  /** Every device's totals per month. */
  async totals(): Promise<UsageLog> {
    await this.save();
    const logs: UsageLog[] = [];
    const listed = await this.app.vault.adapter.list(this.dir).catch(() => ({ files: [] as string[] }));
    for (const f of listed.files) if (/\/usage-[a-z0-9-]+\.json$/.test(f)) logs.push(await this.read(f));
    return mergeUsage(logs);
  }
}
