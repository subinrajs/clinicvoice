import type OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { ReasoningEffort } from "openai/resources/shared";
import type {
  ChatModel,
  ConversationMessage,
  ModelTurnRequest,
  ModelTurnResult,
  ToolCall,
} from "./types.js";

export interface OpenAIChatModelOptions {
  client: Pick<OpenAI, "chat">;
  model: string;
  /** Keep low (or "none") for live voice turns: reasoning tokens are silence on the phone. */
  reasoningEffort?: ReasoningEffort;
}

/** OpenAI Chat Completions adapter with streaming text and streamed tool-call assembly. */
export class OpenAIChatModel implements ChatModel {
  readonly provider = "openai";
  readonly model: string;

  constructor(private readonly options: OpenAIChatModelOptions) {
    this.model = options.model;
  }

  async streamTurn(request: ModelTurnRequest): Promise<ModelTurnResult> {
    const stream = await this.options.client.chat.completions.create(
      {
        model: this.model,
        stream: true,
        stream_options: { include_usage: true },
        max_completion_tokens: request.maxOutputTokens,
        // One tool at a time keeps confirmation and audit ordering simple to reason about.
        parallel_tool_calls: false,
        messages: toOpenAIMessages(request),
        tools: request.tools.map(toOpenAITool),
        ...(request.cacheKey ? { prompt_cache_key: request.cacheKey } : {}),
        ...(this.options.reasoningEffort ? { reasoning_effort: this.options.reasoningEffort } : {}),
      },
      { signal: request.signal },
    );

    let text = "";
    let finishReason: string | null = null;
    let usage: ModelTurnResult["usage"];
    // Tool-call ids, names and argument JSON arrive in fragments keyed by index.
    const partial = new Map<number, { id: string; name: string; args: string }>();

    for await (const chunk of stream) {
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens,
          cachedInputTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens,
        };
      }
      const choice = chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta;
      if (delta?.content) {
        text += delta.content;
        request.onText(delta.content);
      }
      for (const fragment of delta?.tool_calls ?? []) {
        const entry = partial.get(fragment.index) ?? { id: "", name: "", args: "" };
        if (fragment.id) entry.id = fragment.id;
        if (fragment.function?.name) entry.name += fragment.function.name;
        if (fragment.function?.arguments) entry.args += fragment.function.arguments;
        partial.set(fragment.index, entry);
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    const toolCalls: ToolCall[] = [...partial.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => ({ id: call.id, name: call.name, input: parseArguments(call.args) }));

    return {
      text,
      toolCalls,
      stopReason:
        toolCalls.length > 0
          ? "tool_calls"
          : finishReason === "stop"
            ? "end"
            : finishReason === "length"
              ? "max_tokens"
              : "other",
      ...(usage ? { usage } : {}),
    };
  }
}

function parseArguments(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // Let schema validation reject it and tell the model, rather than failing the turn.
    return {};
  }
}

function toOpenAITool(tool: ModelTurnRequest["tools"][number]): ChatCompletionTool {
  return {
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  };
}

export function toOpenAIMessages(
  request: Pick<ModelTurnRequest, "system" | "history" | "turnContext">,
): ChatCompletionMessageParam[] {
  return [
    { role: "system", content: request.system },
    ...request.history.map(toOpenAIMessage),
    { role: "system", content: request.turnContext },
  ];
}

function toOpenAIMessage(message: ConversationMessage): ChatCompletionMessageParam {
  switch (message.role) {
    case "user":
      return { role: "user", content: message.content };
    case "tool":
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
    case "assistant":
      return {
        role: "assistant",
        content: message.content || null,
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
              })),
            }
          : {}),
      };
  }
}
