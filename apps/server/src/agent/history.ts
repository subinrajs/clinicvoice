import type Anthropic from "@anthropic-ai/sdk";

/**
 * Keeps roughly the last `maxMessages` messages, cutting only at a plain caller message so a
 * tool_use is never separated from its tool_result (the API rejects orphaned results).
 */
export function trimHistory(
  history: Anthropic.MessageParam[],
  maxMessages = 20,
): Anthropic.MessageParam[] {
  if (history.length <= maxMessages) return history;
  for (let i = history.length - maxMessages; i < history.length; i++) {
    const message = history[i];
    if (message?.role === "user" && typeof message.content === "string") return history.slice(i);
  }
  return history.slice(-1);
}
