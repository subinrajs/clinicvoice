import { z } from "zod";
import type { Logger } from "../lib/logger.js";
import type { ChatModel, ToolSpec } from "../llm/types.js";
import type { CallSession } from "../session/callSession.js";
import { classifyConfirmation } from "../session/confirmation.js";
import { allowedTools, deriveState } from "../session/state.js";
import { executeTool } from "../tools/executeTool.js";
import type { ToolContext, ToolDefinition } from "../tools/types.js";
import { trimHistory } from "./history.js";
import { ESCALATION_LINE, isClinicalAdvice, SentenceBuffer } from "./outputFilter.js";

const MAX_TOOL_ITERATIONS = 4;
const MAX_REPLY_TOKENS = 300;

export interface TurnRecord {
  role: "caller" | "agent" | "tool" | "system";
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  state: string;
  latencyMs?: number;
}

export interface AgentDeps {
  model: ChatModel;
  systemPrompt: string;
  tools: ReadonlyMap<string, ToolDefinition>;
  logger: Logger;
  /** Builds the per-call tool context (repositories, clock, request id). */
  toolContext: (session: CallSession) => Omit<ToolContext, "tools">;
  /** Persists transcript/tool turns. Must not throw; failures are logged by the implementation. */
  recordTurn: (session: CallSession, turn: TurnRecord) => void;
}

export interface TurnMetrics {
  /** Caller text received -> first sentence released to text-to-speech. */
  firstSpeechMs: number | null;
  totalMs: number;
  toolCalls: number;
  filterHit: boolean;
  /** Input tokens served from the provider's prompt cache, for latency tuning. */
  cachedInputTokens: number;
  inputTokens: number;
  outputTokens: number;
}

const toolSpecCache = new WeakMap<ReadonlyMap<string, ToolDefinition>, ToolSpec[]>();

/** Converts the registry into tool specs once; the list is static so the provider can cache it. */
export function toToolSpecs(tools: ReadonlyMap<string, ToolDefinition>): ToolSpec[] {
  const cached = toolSpecCache.get(tools);
  if (cached) return cached;
  const specs = [...tools.values()].map((tool) => {
    const { $schema: _schemaUri, ...parameters } = z.toJSONSchema(tool.input) as Record<
      string,
      unknown
    >;
    return { name: tool.name, description: tool.description, parameters };
  });
  toolSpecCache.set(tools, specs);
  return specs;
}

/**
 * Applies the deterministic confirmation check to the caller's words before the model sees them,
 * and returns a note for the per-turn context describing what happened.
 */
export function applyConfirmation(session: CallSession, callerText: string): string | null {
  const pending = session.pendingAction;
  if (!pending || pending.confirmed) return null;
  const verdict = classifyConfirmation(callerText, session.language);
  switch (verdict) {
    case "yes":
      pending.confirmed = true;
      return `The caller CONFIRMED: "${pending.summary}". Call ${pending.tool} now with exactly the proposed arguments: ${JSON.stringify(pending.args)}.`;
    case "no":
      session.pendingAction = null;
      return "The caller DECLINED the proposed action. Nothing was changed. Ask what they would like instead.";
    case "unclear":
      return `The caller's answer was not a clear yes or no. Nothing was changed. Briefly ask again: "${pending.summary}" Yes or no?`;
  }
}

export function turnContext(session: CallSession, note: string | null): string {
  const lines = [
    `Current state: ${deriveState(session)}.`,
    `Tools you may call now: ${allowedTools(session).join(", ")}.`,
    `Caller language: ${session.language === "fr" ? "French" : "English"}.`,
    session.verifiedFirstName
      ? `The caller is verified as ${session.verifiedFirstName}.`
      : "The caller is NOT verified. Share no patient information.",
  ];
  if (session.lockedOut) lines.push("Identity checks are locked. Offer a staff callback only.");
  if (note) lines.push(note);
  return lines.join("\n");
}

/**
 * Runs one caller turn: confirmation check, then the streaming model tool loop. Spoken text is
 * released sentence by sentence through the clinical-advice filter via `speak`.
 */
export async function runAgentTurn(
  deps: AgentDeps,
  session: CallSession,
  callerText: string,
  speak: (text: string) => void,
  signal?: AbortSignal,
): Promise<TurnMetrics> {
  const startedAt = performance.now();
  let firstSpeechMs: number | null = null;
  let filterHit = false;
  let toolCalls = 0;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;

  const note = applyConfirmation(session, callerText);
  deps.recordTurn(session, { role: "caller", text: callerText, state: deriveState(session) });
  session.history.push({ role: "user", content: callerText });

  const tools = toToolSpecs(deps.tools);
  const ctx: ToolContext = { ...deps.toolContext(session), tools: deps.tools };

  const release = (sentence: string) => {
    const text = sentence.trim();
    if (!text || filterHit) return;
    if (isClinicalAdvice(text)) {
      filterHit = true;
      deps.logger.warn({ callId: session.callId }, "output filter replaced a reply");
      deps.recordTurn(session, {
        role: "system",
        text: "output_filter_hit",
        state: deriveState(session),
      });
      speak(ESCALATION_LINE[session.language]);
      return;
    }
    firstSpeechMs ??= Math.round(performance.now() - startedAt);
    speak(text);
  };

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    session.history = trimHistory(session.history);
    const buffer = new SentenceBuffer();

    const result = await deps.model.streamTurn({
      system: deps.systemPrompt,
      tools,
      history: session.history,
      turnContext: turnContext(session, iteration === 0 ? note : null),
      cacheKey: `call:${session.callId}`,
      maxOutputTokens: MAX_REPLY_TOKENS,
      ...(signal ? { signal } : {}),
      onText: (delta) => buffer.push(delta).forEach(release),
    });
    release(buffer.flush());
    inputTokens += result.usage?.inputTokens ?? 0;
    cachedInputTokens += result.usage?.cachedInputTokens ?? 0;
    outputTokens += result.usage?.outputTokens ?? 0;

    // If the filter fired, the model's own history must not keep the blocked wording either.
    const spoken = filterHit ? ESCALATION_LINE[session.language] : result.text.trim();
    session.history.push({
      role: "assistant",
      content: spoken,
      ...(result.toolCalls.length ? { toolCalls: result.toolCalls } : {}),
    });
    if (spoken) {
      deps.recordTurn(session, {
        role: "agent",
        text: spoken,
        state: deriveState(session),
        ...(firstSpeechMs !== null ? { latencyMs: firstSpeechMs } : {}),
      });
    }

    if (result.toolCalls.length === 0) break;

    for (const call of result.toolCalls) {
      toolCalls++;
      const outcome = await executeTool(deps.tools, call.name, call.input, ctx);
      deps.recordTurn(session, {
        role: "tool",
        toolName: call.name,
        toolInput: call.input,
        toolResult: outcome,
        state: deriveState(session),
      });
      session.history.push({
        role: "tool",
        toolCallId: call.id,
        content: JSON.stringify(outcome.ok ? outcome.data : { error: outcome.error }),
      });
    }

    if (iteration === MAX_TOOL_ITERATIONS - 1) {
      // The model is looping (usually on guard errors). Hand off rather than keep the caller waiting.
      const apology =
        session.language === "fr"
          ? "Je suis désolée, j'ai du mal à terminer cela. Un membre de l'équipe vous rappellera."
          : "Sorry, I'm having trouble completing that. I'll have a team member call you back.";
      release(apology);
      // Close the exchange with an assistant message so every tool result is answered.
      session.history.push({ role: "assistant", content: apology });
      await executeTool(
        deps.tools,
        "create_task",
        { type: "callback", reason: "Agent hit the tool-iteration limit" },
        ctx,
      );
    }
  }

  return {
    firstSpeechMs,
    totalMs: Math.round(performance.now() - startedAt),
    toolCalls,
    filterHit,
    inputTokens,
    cachedInputTokens,
    outputTokens,
  };
}
