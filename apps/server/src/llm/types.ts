/**
 * Vendor-neutral conversation model boundary. The agent loop, session and tests depend only on
 * these types; src/llm/openaiChatModel.ts adapts them to a specific provider.
 */

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed JSON arguments. Malformed JSON from the model arrives as {} and fails validation. */
  input: unknown;
}

export type ConversationMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool's input object. */
  parameters: Record<string, unknown>;
}

export interface ModelTurnRequest {
  /** Static instructions. Identical on every request so the provider's prompt cache can reuse it. */
  system: string;
  tools: readonly ToolSpec[];
  history: readonly ConversationMessage[];
  /**
   * Per-turn context (state, allowed tools, confirmation outcome). Sent after the history so the
   * cacheable prefix (system + tools + history) stays stable from one turn to the next.
   */
  turnContext: string;
  /** Groups a call's requests for provider-side prompt-cache routing. */
  cacheKey?: string;
  maxOutputTokens: number;
  signal?: AbortSignal;
  /** Receives spoken text as it streams. */
  onText: (delta: string) => void;
}

export interface ModelTurnResult {
  text: string;
  toolCalls: ToolCall[];
  stopReason: "end" | "tool_calls" | "max_tokens" | "other";
  usage?: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
}

export interface ChatModel {
  readonly provider: string;
  readonly model: string;
  streamTurn(request: ModelTurnRequest): Promise<ModelTurnResult>;
}
