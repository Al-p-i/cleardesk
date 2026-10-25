// What ClearDesk's Claude requests cost, estimated from each response's token counts and
// Anthropic's list prices. Anthropic's console is the source of truth; this is a guide.

/** US$ per million tokens: input, output, cache read. Cache writes cost 1.25x input (5 min) or 2x (1 h). */
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
};
/** Web searches are billed per search on top of tokens. */
const WEB_SEARCH = 10 / 1000;

/** The token counts a response reports (the fields ClearDesk uses). */
export interface UsageCounts {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null;
  server_tool_use?: { web_search_requests?: number } | null;
}

/** Estimated cost in US$ of one response; models not in the table are priced like Opus 5.5. */
export function costOf(model: string, u: UsageCounts): { usd: number; known: boolean } {
  const id = Object.keys(PRICES).find((k) => model === k || model.startsWith(k + "-"));
  let p = PRICES[id ?? "claude-opus-5-5"];
  const read = u.cache_read_input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  // Haiku 5.5 costs more for prompts over 100K tokens.
  if (id === "claude-haiku-5-5" && u.input_tokens + read + write > 100_000) p = { input: 0.5, output: 2.5, cacheRead: 0.05 };
  const usd =
    (u.input_tokens * p.input +
      u.output_tokens * p.output +
      read * p.cacheRead +
      (write - write1h) * p.input * 1.25 +
      write1h * p.input * 2) /
      1_000_000 +
    (u.server_tool_use?.web_search_requests ?? 0) * WEB_SEARCH;
  return { usd, known: !!id };
}

/** Totals for one month on one device. */
export interface MonthUsage {
  usd: number;
  requests: number;
  /** some requests used a model without a known price */
  approx?: boolean;
}
export type UsageLog = Record<string, MonthUsage>; // "YYYY-MM" -> totals

export function addUsage(log: UsageLog, month: string, cost: { usd: number; known: boolean }): UsageLog {
  const m = log[month] ?? { usd: 0, requests: 0 };
  return { ...log, [month]: { usd: m.usd + cost.usd, requests: m.requests + 1, ...(m.approx || !cost.known ? { approx: true } : {}) } };
}

/** All devices' logs added up per month. */
export function mergeUsage(logs: UsageLog[]): UsageLog {
  const out: UsageLog = {};
  for (const log of logs) {
    for (const [month, m] of Object.entries(log)) {
      const t = out[month] ?? { usd: 0, requests: 0 };
      out[month] = { usd: t.usd + m.usd, requests: t.requests + m.requests, ...(t.approx || m.approx ? { approx: true } : {}) };
    }
  }
  return out;
}

/** "$1.24 · 148 requests", "under $0.01 · 3 requests", "nothing yet". */
export function usageLabel(m: MonthUsage | undefined): string {
  if (!m || !m.requests) return "nothing yet";
  const usd = m.usd < 0.01 ? "under $0.01" : `${m.approx ? "about " : ""}$${m.usd.toFixed(2)}`;
  return `${usd} · ${m.requests} request${m.requests === 1 ? "" : "s"}`;
}
