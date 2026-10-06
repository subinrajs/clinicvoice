import type OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { OpenAIChatModel, toOpenAIMessages } from "../src/llm/openaiChatModel.js";
import type { ModelTurnRequest } from "../src/llm/types.js";

type Chunk = Record<string, unknown>;

/** Fake OpenAI client whose create() returns an async iterable of stream chunks. */
function fakeOpenAI(chunks: Chunk[]) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    chat: {
      completions: {
        async create(params: Record<string, unknown>) {
          calls.push(params);
          return (async function* () {
            yield* chunks;
          })();
        },
      },
    },
  };
  return { client: client as unknown as Pick<OpenAI, "chat">, calls };
}

const choice = (delta: Chunk, finish_reason: string | null = null) => ({
  choices: [{ index: 0, delta, finish_reason }],
});

function request(overrides: Partial<ModelTurnRequest> = {}): ModelTurnRequest {
  return {
    system: "SYSTEM",
    tools: [
      {
        name: "find_appointments",
        description: "d",
        parameters: { type: "object", properties: {} },
      },
    ],
    history: [{ role: "user", content: "hi" }],
    turnContext: "Current state: handle_task.",
    cacheKey: "call:1",
    maxOutputTokens: 300,
    onText: () => {},
    ...overrides,
  };
}

describe("OpenAIChatModel", () => {
  it("streams text deltas and reports usage, including cached tokens", async () => {
    const { client } = fakeOpenAI([
      choice({ role: "assistant", content: "Hello " }),
      choice({ content: "there." }, "stop"),
      {
        choices: [],
        usage: {
          prompt_tokens: 1800,
          completion_tokens: 4,
          prompt_tokens_details: { cached_tokens: 1536 },
        },
      },
    ]);
    const deltas: string[] = [];
    const result = await new OpenAIChatModel({ client, model: "gpt-test" }).streamTurn(
      request({ onText: (d) => deltas.push(d) }),
    );
    expect(deltas).toEqual(["Hello ", "there."]);
    expect(result).toEqual({
      text: "Hello there.",
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 1800, cachedInputTokens: 1536, outputTokens: 4 },
    });
  });

  it("assembles tool calls streamed in fragments", async () => {
    const { client } = fakeOpenAI([
      choice({ content: "Let me check. " }),
      choice({
        tool_calls: [
          {
            index: 0,
            id: "call_abc",
            type: "function",
            function: { name: "verify_identity", arguments: "" },
          },
        ],
      }),
      choice({ tool_calls: [{ index: 0, function: { arguments: '{"last_name":"San' } }] }),
      choice(
        { tool_calls: [{ index: 0, function: { arguments: 'tos","phone_last4":"0121"}' } }] },
        "tool_calls",
      ),
    ]);
    const result = await new OpenAIChatModel({ client, model: "gpt-test" }).streamTurn(request());
    expect(result.stopReason).toBe("tool_calls");
    expect(result.toolCalls).toEqual([
      {
        id: "call_abc",
        name: "verify_identity",
        input: { last_name: "Santos", phone_last4: "0121" },
      },
    ]);
  });

  it("passes malformed tool arguments through as {} so validation rejects them", async () => {
    const { client } = fakeOpenAI([
      choice(
        {
          tool_calls: [
            { index: 0, id: "c", function: { name: "verify_identity", arguments: "{not json" } },
          ],
        },
        "tool_calls",
      ),
    ]);
    const result = await new OpenAIChatModel({ client, model: "gpt-test" }).streamTurn(request());
    expect(result.toolCalls[0]?.input).toEqual({});
  });

  it("sends a latency-oriented request", async () => {
    const { client, calls } = fakeOpenAI([choice({ content: "ok" }, "stop")]);
    await new OpenAIChatModel({ client, model: "gpt-test", reasoningEffort: "none" }).streamTurn(
      request(),
    );
    expect(calls[0]).toMatchObject({
      model: "gpt-test",
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: 300,
      parallel_tool_calls: false,
      prompt_cache_key: "call:1",
      reasoning_effort: "none",
      tools: [{ type: "function", function: { name: "find_appointments" } }],
    });
  });

  it("orders messages so the cacheable prefix comes first and turn context last", () => {
    const messages = toOpenAIMessages({
      system: "SYSTEM",
      turnContext: "STATE",
      history: [
        { role: "user", content: "who am I" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "find_appointments", input: {} }],
        },
        { role: "tool", toolCallId: "c1", content: '{"ok":true}' },
        { role: "assistant", content: "You have one appointment." },
      ],
    });
    expect(messages).toEqual([
      { role: "system", content: "SYSTEM" },
      { role: "user", content: "who am I" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "find_appointments", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: '{"ok":true}' },
      { role: "assistant", content: "You have one appointment." },
      { role: "system", content: "STATE" },
    ]);
  });
});
