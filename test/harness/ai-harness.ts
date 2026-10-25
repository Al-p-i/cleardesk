import assert from "node:assert/strict";
import { Ai, DEFAULT_AI } from "../../src/ai";
import { calls, script } from "./obsidian-stub";

const msg = (content: any[], stop_reason: string) => ({
  id: "msg_1", type: "message", role: "assistant", model: "x", content, stop_reason,
  stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
});
// No streaming connection here: exercise the requestUrl path (never the real network).
(globalThis as any).fetch = async () => { throw new TypeError("Failed to fetch"); };
console.warn = () => {};
const ai = new Ai(() => ({ ...DEFAULT_AI, apiKey: "test-key" }));

// 1) chat tool loop
script([
  msg([{ type: "text", text: "Noted." }, { type: "tool_use", id: "tu_1", name: "add_fact", input: { text: "Deposit is 3x rent", tag: "Mitte" } }], "tool_use"),
  msg([{ type: "text", text: "Saved the deposit." }], "end_turn"),
]);
const executed: any[] = [];
const reply = await ai.chat({
  system: "sys", context: "<project>P</project>", history: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }],
  user: "agency said deposit is 3x rent", tools: [{ name: "add_fact", description: "d", strict: true, input_schema: { type: "object", properties: {}, additionalProperties: false } } as any],
  exec: async (name, input) => { executed.push([name, input]); return "Saved as f-1."; },
});
assert.equal(reply, "Noted.\n\nSaved the deposit.");
assert.deepEqual(executed, [["add_fact", { text: "Deposit is 3x rent", tag: "Mitte" }]]);
assert.equal(calls.length, 2);
const [first, second] = calls;
assert.equal(first.url, "https://api.anthropic.com/v1/messages?beta=true");
assert.equal(first.method, "POST");
assert.equal(first.headers["x-api-key"], "test-key");
assert.match(first.headers["anthropic-beta"], /server-side-fallback-2026-07-01/);
assert.equal(first.json.model, "claude-opus-5-5");
assert.equal(first.json.fallbacks, "default");
assert.deepEqual(first.json.output_config, { effort: "low" });
assert.equal(first.json.messages.length, 3);
const last = second.json.messages.at(-1);
assert.equal(last.role, "user");
assert.deepEqual(last.content, [{ type: "tool_result", tool_use_id: "tu_1", content: "Saved as f-1." }]);
// Prompt caching: instructions for an hour, history up to the latest message, the loop automatically.
assert.deepEqual(first.json.system, [{ type: "text", text: "sys", cache_control: { type: "ephemeral", ttl: "1h" } }]);
assert.deepEqual(first.json.cache_control, { type: "ephemeral" });
assert.deepEqual(first.json.messages[0], { role: "user", content: "hi" });
assert.deepEqual(first.json.messages[1].content, [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }]);
assert.deepEqual(first.json.messages[2].content, [{ type: "text", text: "<project>P</project>" }, { type: "text", text: "agency said deposit is 3x rent" }]);
assert.equal(JSON.stringify(second.json.messages.slice(0, 3)), JSON.stringify(first.json.messages), "the tool loop only appends");
console.log("chat loop ok:", first.url);
console.log("prompt caching ok");

// 2) structured /t parsing on the fast model
script([msg([{ type: "text", text: JSON.stringify({ tasks: [{ text: "Send payslips", due: "2026-10-19" }] }) }], "end_turn")]);
const tasks = await ai.parseTasks(["send payslips mon"], new Date(2026, 9, 17));
assert.deepEqual(tasks, [{ text: "Send payslips", due: "2026-10-19" }]);
assert.equal(calls[0].json.model, "claude-haiku-5-5");
assert.equal(calls[0].json.output_config.format.type, "json_schema");
assert.equal(calls[0].json.thinking, undefined);
console.log("task parsing ok");

// 3) refusal is surfaced, not crashed on
script([msg([], "refusal")]);
assert.equal(await ai.chat({ system: "s", history: [], user: "x", tools: [], exec: async () => "" }), "I can't help with that request.");
console.log("refusal ok");

// 4) documents: code execution tool declared, pause_turn resumed, only the final text kept
script([
  msg([{ type: "server_tool_use", id: "s1", name: "bash_code_execution", input: { command: "python -c 1" } }], "pause_turn"),
  msg([
    { type: "text", text: "Let me calculate." },
    { type: "server_tool_use", id: "s2", name: "bash_code_execution", input: { command: "python calc.py" } },
    { type: "bash_code_execution_tool_result", tool_use_id: "s2", content: { type: "bash_code_execution_result", stdout: "1234", stderr: "", return_code: 0, content: [] } },
    { type: "text", text: "# Mortgage plan\n\nMonthly payment: €1,234" },
  ], "end_turn"),
]);
const doc = await ai.writeDocument("Mortgage plan", "brief", "ctx");
assert.equal(doc, "# Mortgage plan\n\nMonthly payment: €1,234");
assert.equal(calls.length, 2);
assert.deepEqual(calls[0].json.tools, [{ type: "code_execution_20260521", name: "code_execution" }]);
assert.equal(calls[0].json.output_config.effort, "high");
assert.equal(calls[1].json.messages.at(-1).role, "assistant");
console.log("document with code execution ok");

// 5) tool results can carry a PDF document block
script([
  msg([{ type: "tool_use", id: "tu_9", name: "read_file", input: { path: "a.pdf" } }], "tool_use"),
  msg([{ type: "text", text: "It's a financial statement." }], "end_turn"),
]);
const pdf = [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" }, title: "a.pdf" }] as any;
await ai.chat({ system: "s", history: [], user: "what is in a.pdf", tools: [], exec: async () => pdf });
assert.deepEqual(calls[1].json.messages.at(-1).content[0].content, pdf);
console.log("pdf tool result ok");
