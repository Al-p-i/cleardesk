import assert from "node:assert/strict";
import { Ai, DEFAULT_AI } from "../../src/ai";
import { calls, script } from "./obsidian-stub";

const sse = (events: any[]) =>
  events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const start = { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "x", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } };
const textBlock = (i: number, parts: string[]) => [
  { type: "content_block_start", index: i, content_block: { type: "text", text: "" } },
  ...parts.map((t) => ({ type: "content_block_delta", index: i, delta: { type: "text_delta", text: t } })),
  { type: "content_block_stop", index: i },
];
const end = (stop: string) => [
  { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } },
  { type: "message_stop" },
];
const turn1 = sse([
  start, ...textBlock(0, ["Noted", " the deposit."]),
  { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "add_fact", input: {} } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"text":"Deposit is 3x rent",' } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"tag":"Mitte"}' } },
  { type: "content_block_stop", index: 1 },
  ...end("tool_use"),
]);
const turn2 = sse([
  start,
  { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srv_1", name: "web_search", input: {} } },
  { type: "content_block_stop", index: 0 },
  ...textBlock(1, ["Anything ", "else?"]), ...end("end_turn"),
]);

const bodies: any[] = [];
let queue = [turn1, turn2];
(globalThis as any).fetch = async (_url: string, init: any) => {
  bodies.push(JSON.parse(init.body));
  const body = queue.shift()!;
  return new Response(new ReadableStream({
    start(c) {
      // deliver in small chunks to exercise incremental parsing
      const enc = new TextEncoder().encode(body);
      for (let i = 0; i < enc.length; i += 37) c.enqueue(enc.slice(i, i + 37));
      c.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
};

const ai = new Ai(() => ({ ...DEFAULT_AI, apiKey: "sk-ant-test" }));
let live = "";
const tools: string[] = [];
const executed: any[] = [];
const reply = await ai.chat({
  system: "s", history: [], user: "agency said deposit is 3x rent", tools: [],
  exec: async (n, input) => { executed.push([n, input]); return "ok"; },
  onText: (d) => (live += d),
  onTool: (n) => tools.push(n),
});
assert.equal(reply, "Noted the deposit.\n\nAnything else?");
assert.equal(live, reply, "streamed text matches the final reply");
assert.deepEqual(executed, [["add_fact", { text: "Deposit is 3x rent", tag: "Mitte" }]]);
assert.ok(tools.includes("add_fact"));
assert.ok(tools.includes("web_search"), "server tool use is reported as progress");
assert.equal(bodies[0].stream, true);
assert.equal(bodies[1].messages.at(-1).content[0].type, "tool_result");
console.log("streaming ok:", JSON.stringify(live));

// Fallback: a network failure (e.g. CORS) switches to complete responses via requestUrl.
(globalThis as any).fetch = async () => { throw new TypeError("Failed to fetch"); };
script([{ id: "m", type: "message", role: "assistant", model: "x", content: [{ type: "text", text: "Hi from fallback" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }]);
const ai2 = new Ai(() => ({ ...DEFAULT_AI, apiKey: "sk-ant-test" }));
let live2 = "";
const t0 = Date.now();
const r2 = await ai2.chat({ system: "s", history: [], user: "hi", tools: [], exec: async () => "", onText: (d) => (live2 += d) });
assert.equal(r2, "Hi from fallback");
assert.equal(live2, "Hi from fallback");
assert.equal(calls.length, 1);
console.log(`fallback ok (${Date.now() - t0} ms incl. retries)`);
