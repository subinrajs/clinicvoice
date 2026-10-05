import type { Language } from "@clinicvoice/shared";
import type { WebSocket } from "ws";
import { runAgentTurn, type AgentDeps } from "../agent/agent.js";
import type { Logger } from "../lib/logger.js";
import { hashPhone } from "../lib/phone.js";
import { median, type CallRepository } from "../repositories/callRepository.js";
import { createCallSession, type CallSession } from "../session/callSession.js";
import { parseInbound, RELAY_LANGUAGE_CODES, type OutboundRelayMessage } from "./relayMessages.js";

export interface RelayDeps {
  agent: Omit<AgentDeps, "recordTurn">;
  calls: CallRepository;
  logger: Logger;
  phoneHashKey: string;
  maxConcurrentCalls: number;
  /**
   * Call SIDs currently connected, shared across connections to enforce the concurrency cap.
   * Reserved synchronously on setup so simultaneous calls cannot both slip under the cap.
   */
  activeCalls: Set<string>;
}

const BUSY_MESSAGE =
  "Sorry, all of our lines are busy right now. Please call back in a few minutes. Goodbye.";
const FRENCH_REQUEST = /\b(fran[cç]ais|french)\b/i;

/**
 * One WebSocket per phone call. Owns the call's lifecycle: setup -> caller turns -> hang-up.
 * Each turn's output can be cancelled by barge-in (interrupt), and turns never overlap.
 */
export function handleRelayConnection(socket: WebSocket, deps: RelayDeps): void {
  let session: CallSession | null = null;
  let callSid: string | null = null;
  let log = deps.logger;
  let currentTurn: AbortController | null = null;
  let turnChain: Promise<void> = Promise.resolve();
  const latencies: number[] = [];
  let flagged = false;

  const send = (message: OutboundRelayMessage) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  };

  const recordTurn: AgentDeps["recordTurn"] = (s, turn) => {
    deps.calls.recordTurn(s.callId, ++s.turnSeq, turn);
  };

  const switchLanguage = (s: CallSession, language: Language) => {
    if (s.language === language) return;
    s.language = language;
    const code = RELAY_LANGUAGE_CODES[language];
    send({ type: "language", ttsLanguage: code, transcriptionLanguage: code });
  };

  const runTurn = async (s: CallSession, text: string) => {
    const controller = new AbortController();
    currentTurn = controller;
    const speak = (sentence: string) => {
      if (!controller.signal.aborted) send({ type: "text", token: `${sentence} `, last: false });
    };
    try {
      const metrics = await runAgentTurn(
        { ...deps.agent, recordTurn },
        s,
        text,
        speak,
        controller.signal,
      );
      if (metrics.firstSpeechMs !== null) latencies.push(metrics.firstSpeechMs);
      flagged ||= metrics.filterHit;
      log.info({ ...metrics, callId: s.callId }, "turn complete");
    } catch (err) {
      if (controller.signal.aborted) return;
      log.error({ err, callId: s.callId }, "agent turn failed");
      speak(
        s.language === "fr"
          ? "Désolée, un problème est survenu. Pouvez-vous répéter?"
          : "Sorry, something went wrong on my end. Could you say that again?",
      );
    } finally {
      if (!controller.signal.aborted) send({ type: "text", token: "", last: true });
      if (currentTurn === controller) currentTurn = null;
    }
  };

  socket.on("message", (raw) => {
    const message = parseInbound(raw.toString());
    if (!message) return;

    switch (message.type) {
      case "setup": {
        if (session) return;
        if (deps.activeCalls.size >= deps.maxConcurrentCalls) {
          log.warn({ active: deps.activeCalls.size }, "concurrency cap reached; rejecting call");
          send({ type: "text", token: BUSY_MESSAGE, last: true });
          send({ type: "end" });
          return;
        }
        callSid = message.callSid;
        deps.activeCalls.add(callSid);
        const fromHash = message.from ? hashPhone(message.from, deps.phoneHashKey) : null;
        turnChain = deps.calls
          .startCall({ twilioSid: message.callSid, fromHash })
          .then(({ id }) => {
            session = createCallSession({ callId: id, callSid: message.callSid, fromHash });
            log = deps.logger.child({ callId: id });
            log.info("call started");
          })
          .catch((err: unknown) => {
            deps.logger.error({ err }, "failed to start call");
            send({ type: "text", token: BUSY_MESSAGE, last: true });
            send({ type: "end" });
          });
        return;
      }
      case "prompt": {
        if (!message.last) return;
        const text = message.voicePrompt.trim();
        if (!text) return;
        // Queue behind setup and any previous turn so history is never mutated concurrently.
        turnChain = turnChain.then(async () => {
          if (!session) return;
          if (FRENCH_REQUEST.test(text) || message.lang?.startsWith("fr"))
            switchLanguage(session, "fr");
          await runTurn(session, text);
        });
        return;
      }
      case "interrupt": {
        // Barge-in: stop speaking now. The caller's words arrive as the next prompt.
        currentTurn?.abort();
        return;
      }
      case "error": {
        log.warn({ description: message.description }, "relay reported an error");
        return;
      }
      case "dtmf":
        return;
    }
  });

  socket.on("close", () => {
    currentTurn?.abort();
    if (callSid) deps.activeCalls.delete(callSid);
    void turnChain.finally(async () => {
      if (!session) return;
      try {
        await deps.calls.endCall(session.callId, { medianLatencyMs: median(latencies), flagged });
        log.info({ turns: latencies.length }, "call ended");
      } catch (err) {
        log.error({ err }, "failed to close call record");
      }
    });
  });
}
