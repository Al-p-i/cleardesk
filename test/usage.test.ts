import { test } from "node:test";
import assert from "node:assert/strict";
import { addUsage, costOf, mergeUsage, usageLabel, type UsageLog } from "../src/usage.ts";

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

test("cost of a response from its token counts", () => {
  // Opus 5.5: $4 in, $20 out, $0.20 cache reads, writes 1.25x (5 min) or 2x (1 h) per million.
  const chat = costOf("claude-opus-5-5", {
    input_tokens: 1_000, output_tokens: 500, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 3_000,
    cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 2_000 },
  });
  near(chat.usd, (1_000 * 4 + 500 * 20 + 20_000 * 0.2 + 1_000 * 5 + 2_000 * 8) / 1e6);
  assert.equal(chat.known, true);
  // Haiku 5.5 filing a /t: tiny; long prompts cost more.
  near(costOf("claude-haiku-5-5", { input_tokens: 400, output_tokens: 60 }).usd, (400 * 0.1 + 60 * 0.5) / 1e6);
  near(costOf("claude-haiku-5-5", { input_tokens: 120_000, output_tokens: 100 }).usd, (120_000 * 0.5 + 100 * 2.5) / 1e6);
  // Web searches are billed per search.
  near(costOf("claude-opus-5-5", { input_tokens: 0, output_tokens: 0, server_tool_use: { web_search_requests: 3 } }).usd, 0.03);
  // Dated or unknown model ids.
  assert.equal(costOf("claude-sonnet-5-5-20260901", { input_tokens: 1, output_tokens: 1 }).known, true);
  assert.equal(costOf("some-new-model", { input_tokens: 1, output_tokens: 1 }).known, false);
});

test("monthly totals per device, added up across devices", () => {
  let laptop: UsageLog = {};
  laptop = addUsage(laptop, "2026-10", { usd: 0.02, known: true });
  laptop = addUsage(laptop, "2026-10", { usd: 0.03, known: true });
  let phone: UsageLog = addUsage({}, "2026-10", { usd: 0.01, known: false });
  phone = addUsage(phone, "2026-09", { usd: 1, known: true });
  const all = mergeUsage([laptop, phone]);
  near(all["2026-10"].usd, 0.06);
  assert.equal(all["2026-10"].requests, 3);
  assert.equal(all["2026-10"].approx, true);
  assert.equal(usageLabel(all["2026-09"]), "$1.00 · 1 request");
  assert.equal(usageLabel(all["2026-10"]), "about $0.06 · 3 requests");
  assert.equal(usageLabel({ usd: 0.004, requests: 2 }), "under $0.01 · 2 requests");
  assert.equal(usageLabel(undefined), "nothing yet");
});
