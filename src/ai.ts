import Anthropic from "@anthropic-ai/sdk";
import { requestUrl } from "obsidian";
import { keyProblem } from "./key";

export { cleanKey, keyProblem } from "./key";

export interface AiSettings {
  apiKey: string;
  chatModel: string;
  fastModel: string;
  docModel: string;
  webAccess: boolean;
}

export const DEFAULT_AI: AiSettings = {
  apiKey: "",
  chatModel: "claude-opus-5-5",
  fastModel: "claude-haiku-5-5",
  docModel: "claude-opus-5-5",
  webAccess: true,
};

type Beta = Anthropic.Beta.Messages.BetaMessageParam;
type BetaTool = Anthropic.Beta.Messages.BetaToolUnion;
export type ToolOutput = string | NonNullable<Anthropic.Beta.Messages.BetaToolResultBlockParam["content"]>;
type BetaCreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

/**
 * Route SDK requests through Obsidian's requestUrl: no CORS involved, and it
 * works the same on desktop and mobile.
 */
const obsidianFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => {
    if (k !== "content-length") headers[k] = v;
  });
  const res = await requestUrl({
    url,
    method: init?.method ?? "GET",
    headers,
    body: typeof init?.body === "string" ? init.body : undefined,
    throw: false,
  });
  return new Response(res.status === 204 ? null : res.arrayBuffer, { status: res.status, headers: res.headers });
};

export class Ai {
  constructor(private settings: () => AiSettings) {}

  get key(): string {
    return this.settings().apiKey;
  }

  get webAccess(): boolean {
    return this.settings().webAccess !== false;
  }

  get configured(): boolean {
    return keyProblem(this.settings().apiKey) === null;
  }

  private client(): Anthropic {
    return new Anthropic({
      apiKey: this.settings().apiKey,
      dangerouslyAllowBrowser: true,
      fetch: obsidianFetch as unknown as typeof fetch,
      maxRetries: 2,
    });
  }

  /** Small structured call on the fast model. */
  private async json<T>(system: string, user: string, schema: Record<string, unknown>): Promise<T> {
    const res = await this.client().messages.create({
      model: this.settings().fastModel,
      max_tokens: 4000,
      system,
      messages: [{ role: "user", content: user }],
      output_config: { effort: "low", format: { type: "json_schema", schema } },
    });
    if (res.stop_reason === "refusal") throw new Error("The model declined this request.");
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    return JSON.parse(text) as T;
  }

  /** Turn raw /t lines into tasks with due dates. */
  async parseTasks(lines: string[], today: Date): Promise<{ text: string; due: string }[]> {
    const out = await this.json<{ tasks: { text: string; due: string }[] }>(
      `You turn quick to-do lines into clean tasks. Today is ${today.toDateString()} (${isoDay(today)}).
For each input line return exactly one task, in the same order.
- text: the task as a short imperative phrase, keeping the owner's wording and names; remove the date words you converted. Capitalize the first letter.
- due: YYYY-MM-DD if the line names a date or relative day ("mon", "tomorrow", "next week" = next Monday, "asap" = today, "by Fri", "eom" = last day of the month); otherwise "".
Weekday names mean the next such day after today (today's own weekday means 7 days later).`,
      lines.map((l, i) => `${i + 1}. ${l}`).join("\n"),
      {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            items: {
              type: "object",
              properties: { text: { type: "string" }, due: { type: "string" } },
              required: ["text", "due"],
              additionalProperties: false,
            },
          },
        },
        required: ["tasks"],
        additionalProperties: false,
      }
    );
    return out.tasks;
  }

  /** Pick a topic tag for a note and suggest key-fact updates. */
  async tagNote(
    note: string,
    ctx: { tags: string[]; goal: string; keyFacts: { label: string; value: string }[] }
  ): Promise<{ tag: string; key_facts: { label: string; value: string }[] }> {
    return this.json(
      `You file one note in a personal project workspace.
Return:
- tag: a 1-2 word topic for the note. Reuse an existing tag when one fits: ${ctx.tags.join(", ") || "(none yet)"}. Use "" only for notes with no clear topic.
- key_facts: label/value pairs to set on the project card. Only include one when the note changes the value of a current key fact, or states a crucial constraint that clearly belongs on the card (budget, deadline, date, chosen option). Usually return [].
Project goal: ${ctx.goal || "(not set)"}
Current key facts: ${ctx.keyFacts.map((f) => `${f.label}: ${f.value}`).join("; ") || "(none)"}`,
      note,
      {
        type: "object",
        properties: {
          tag: { type: "string" },
          key_facts: {
            type: "array",
            items: {
              type: "object",
              properties: { label: { type: "string" }, value: { type: "string" } },
              required: ["label", "value"],
              additionalProperties: false,
            },
          },
        },
        required: ["tag", "key_facts"],
        additionalProperties: false,
      }
    );
  }

  /** Chat turn with tools. Runs the tool loop until the model is done. */
  async chat(args: {
    system: string;
    history: Beta[];
    user: string | Anthropic.Beta.Messages.BetaContentBlockParam[];
    tools: BetaTool[];
    exec: (name: string, input: Record<string, unknown>) => Promise<ToolOutput>;
    /** Text as it streams in (deltas). */
    onText?: (delta: string) => void;
    /** Name of the tool about to run. */
    onTool?: (name: string) => void;
  }): Promise<string> {
    const messages: Beta[] = [...args.history, { role: "user", content: args.user }];
    const texts: string[] = [];
    for (let i = 0; i < 10; i++) {
      // Separate text from consecutive model turns with a blank line, as in the final reply.
      let first = true;
      const onText = (d: string) => {
        if (!d) return;
        args.onText?.(first && texts.length ? "\n\n" + d : d);
        first = false;
      };
      const res = await this.turn(
        {
          model: this.settings().chatModel,
          max_tokens: 16000,
          system: args.system,
          messages,
          tools: args.tools,
          output_config: { effort: "low" },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        },
        onText,
        args.onTool
      );
      if (res.stop_reason === "refusal") {
        texts.push("I can't help with that request.");
        break;
      }
      for (const b of res.content) if (b.type === "text" && b.text.trim()) texts.push(b.text.trim());
      if (res.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: res.content as Beta["content"] });
        continue;
      }
      const calls = res.content.filter((b) => b.type === "tool_use");
      if (res.stop_reason !== "tool_use" || calls.length === 0) break;
      messages.push({ role: "assistant", content: res.content as Beta["content"] });
      const results = await Promise.all(
        calls.map(async (c) => {
          if (c.type !== "tool_use") throw new Error("unreachable");
          args.onTool?.(c.name);
          try {
            const out = await args.exec(c.name, (c.input ?? {}) as Record<string, unknown>);
            return { type: "tool_result" as const, tool_use_id: c.id, content: out };
          } catch (e) {
            return { type: "tool_result" as const, tool_use_id: c.id, content: String(e), is_error: true };
          }
        })
      );
      messages.push({ role: "user", content: results });
    }
    return texts.join("\n\n");
  }

  /** Whether streaming over the network works here; switched off after a connection failure. */
  private streaming = true;

  /**
   * One model call. Streams over the platform's fetch when possible so text
   * appears as it's written; falls back to a complete response via
   * requestUrl if the streaming connection can't be made.
   */
  private async turn(
    params: BetaCreateParams,
    onText: (delta: string) => void,
    onTool?: (name: string) => void
  ): Promise<Anthropic.Beta.Messages.BetaMessage> {
    if (this.streaming) {
      let received = false;
      try {
        const stream = this.streamClient().beta.messages.stream(params);
        stream.on("streamEvent", (ev) => {
          received = true;
          if (ev.type === "content_block_start" && (ev.content_block.type === "tool_use" || ev.content_block.type === "server_tool_use")) {
            onTool?.(ev.content_block.name);
          }
        });
        stream.on("text", (d) => onText(d));
        return await stream.finalMessage();
      } catch (e) {
        if (received || !(e instanceof Anthropic.APIConnectionError)) throw e;
        console.warn("ClearDesk: streaming unavailable, using complete responses", e);
        this.streaming = false;
      }
    }
    const res = await this.client().beta.messages.create(params);
    for (const b of res.content) if (b.type === "text") onText(b.text);
    return res;
  }

  private streamClient(): Anthropic {
    return new Anthropic({ apiKey: this.settings().apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
  }

  /**
   * Write a full markdown document on the strong model. It can run code for
   * calculations; only the text after its last tool use is the document.
   */
  async writeDocument(title: string, brief: string, context: string): Promise<string> {
    const client = this.client();
    const messages: Beta[] = [
      { role: "user", content: `<project_context>\n${context}\n</project_context>\n\nTitle: ${title}\n\nBrief: ${brief}` },
    ];
    let res: Anthropic.Beta.Messages.BetaMessage | null = null;
    for (let i = 0; i < 6; i++) {
      res = await client.beta.messages.create({
        model: this.settings().docModel,
        max_tokens: 16000,
        system: `You write documents for the owner's personal project workspace in Obsidian.
Write the complete document in Obsidian-flavored markdown: start with a one-line summary, then the content.
Use tables for comparisons. For any calculation (loans, budgets, totals, scenarios), compute it with the code execution tool instead of by hand, and show the inputs and assumptions in the document so the owner can change them.
Base everything on the project context. Where information is missing, say what is assumed.
Do your calculations first; then output only the finished document, with no commentary before or after it.`,
        messages,
        tools: [{ type: "code_execution_20260521", name: "code_execution" }],
        output_config: { effort: "high" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
      if (res.stop_reason !== "pause_turn") break;
      messages.push({ role: "assistant", content: res.content as Beta["content"] });
    }
    if (!res || res.stop_reason === "refusal") throw new Error("The model declined to write this document.");
    return documentText(res.content);
  }
}

/** Text after the last non-text block (tool calls and their results), or all text if none. */
export function documentText(content: { type: string; text?: string }[]): string {
  let last = -1;
  content.forEach((b, i) => {
    if (b.type !== "text") last = i;
  });
  const after = content.slice(last + 1).filter((b) => b.type === "text");
  const blocks = after.length ? after : content.filter((b) => b.type === "text");
  return blocks.map((b) => b.text ?? "").join("").trim();
}

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
