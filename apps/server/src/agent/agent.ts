import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Logger } from "../lib/logger.js";
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
  client: Pick<Anthropic, "messages">;
  model: string;
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
}

const anthropicToolCache = new WeakMap<ReadonlyMap<string, ToolDefinition>, Anthropic.Tool[]>();

/** Converts the registry into Anthropic tool definitions once; the list is static so it caches. */
export function toAnthropicTools(tools: ReadonlyMap<string, ToolDefinition>): Anthropic.Tool[] {
  const cached = anthropicToolCache.get(tools);
  if (cached) return cached;
  const list = [...tools.values()].map((tool) => {
    const { $schema: _schemaUri, ...schema } = z.toJSONSchema(tool.input) as Record<
      string,
      unknown
    >;
    return {
      name: tool.name,
      description: tool.description,
      input_schema: schema as Anthropic.Tool.InputSchema,
    } satisfies Anthropic.Tool;
  });
  // A cache breakpoint on the last tool caches the whole tool list.
  const last = list.at(-1);
  if (last) Object.assign(last, { cache_control: { type: "ephemeral" } });
  anthropicToolCache.set(tools, list);
  return list;
}

/**
 * Applies the deterministic confirmation check to the caller's words before the model sees them,
 * and returns a note for the per-turn system block describing what happened.
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

function stateBlock(session: CallSession, note: string | null): string {
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
 * Runs one caller turn: confirmation check, then the streaming Claude tool loop. Spoken text is
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

  const note = applyConfirmation(session, callerText);
  deps.recordTurn(session, { role: "caller", text: callerText, state: deriveState(session) });
  session.history.push({ role: "user", content: callerText });

  const anthropicTools = toAnthropicTools(deps.tools);
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

    const stream = deps.client.messages.stream(
      {
        model: deps.model,
        max_tokens: MAX_REPLY_TOKENS,
        system: [
          { type: "text", text: deps.systemPrompt, cache_control: { type: "ephemeral" } },
          { type: "text", text: stateBlock(session, iteration === 0 ? note : null) },
        ],
        tools: anthropicTools,
        messages: session.history,
      },
      { signal },
    );
    stream.on("text", (delta) => buffer.push(delta).forEach(release));

    const message = await stream.finalMessage();
    release(buffer.flush());
    // If the filter fired, the model's own history must not keep the blocked wording either.
    const content = filterHit
      ? message.content.map((b) =>
          b.type === "text" ? { ...b, text: ESCALATION_LINE[session.language] } : b,
        )
      : message.content;
    session.history.push({ role: "assistant", content });

    const spoken = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim();
    if (spoken) {
      deps.recordTurn(session, {
        role: "agent",
        text: filterHit ? ESCALATION_LINE[session.language] : spoken,
        state: deriveState(session),
        ...(firstSpeechMs !== null ? { latencyMs: firstSpeechMs } : {}),
      });
    }

    if (message.stop_reason !== "tool_use") break;

    const toolUses = message.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUses) {
      toolCalls++;
      const result = await executeTool(deps.tools, block.name, block.input, ctx);
      deps.recordTurn(session, {
        role: "tool",
        toolName: block.name,
        toolInput: block.input,
        toolResult: result,
        state: deriveState(session),
      });
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(result.ok ? result.data : { error: result.error }),
        ...(result.ok ? {} : { is_error: true }),
      });
    }
    session.history.push({ role: "user", content: results });

    if (iteration === MAX_TOOL_ITERATIONS - 1) {
      // The model is looping (usually on guard errors). Hand off rather than keep the caller waiting.
      const apology =
        session.language === "fr"
          ? "Je suis désolée, j'ai du mal à terminer cela. Un membre de l'équipe vous rappellera."
          : "Sorry, I'm having trouble completing that. I'll have a team member call you back.";
      release(apology);
      // Close the exchange with an assistant message so history stays user/assistant alternating.
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
  };
}
