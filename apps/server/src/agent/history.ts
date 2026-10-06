import type { ConversationMessage } from "../llm/types.js";

/**
 * Keeps roughly the last `maxMessages` messages, cutting only at a caller message so an
 * assistant tool call is never separated from its tool result (providers reject orphans).
 */
export function trimHistory(
  history: ConversationMessage[],
  maxMessages = 20,
): ConversationMessage[] {
  if (history.length <= maxMessages) return history;
  for (let i = history.length - maxMessages; i < history.length; i++) {
    if (history[i]?.role === "user") return history.slice(i);
  }
  return history.slice(-1);
}
