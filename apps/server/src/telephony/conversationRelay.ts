import type { Language } from "@clinicvoice/shared";
import type { WebSocket } from "ws";
import { runAgentTurn, type AgentDeps } from "../agent/agent.js";
import type { JobQueue } from "../jobs/jobQueue.js";
import type { Logger } from "../lib/logger.js";
import { hashPhone } from "../lib/phone.js";
import { median, type CallEnd, type CallRepository } from "../repositories/callRepository.js";
import type { ClinicRepository } from "../repositories/clinicRepository.js";
import type { UsageRepository } from "../repositories/usageRepository.js";
import { createCallSession, type CallSession } from "../session/callSession.js";
import { admitCall, type AdmissionPolicy } from "./admission.js";
import { parseInbound, RELAY_LANGUAGE_CODES, type OutboundRelayMessage } from "./relayMessages.js";

export interface RelayDeps {
  agent: Omit<AgentDeps, "recordTurn">;
  calls: CallRepository;
  clinic: Pick<ClinicRepository, "createTask">;
  usage: UsageRepository;
  jobs: JobQueue;
  logger: Logger;
  phoneHashKey: string;
  admission: AdmissionPolicy;
  /**
   * Call SIDs currently connected, shared across connections to enforce the concurrency cap.
   * Reserved synchronously on setup so simultaneous calls cannot both slip under the cap.
   */
  activeCalls: Set<string>;
  /** Silence after the agent finishes speaking before re-prompting. */
  silenceMs?: number;
}

const DEFAULT_SILENCE_MS = 6_000;
/** Rough text-to-speech pace, used to estimate when the agent's reply has finished playing. */
const SPOKEN_CHARS_PER_SECOND = 15;
const FRENCH_REQUEST = /\b(fran[cç]ais|french)\b/i;

const LINES = {
  busy: {
    en: "Sorry, all of our lines are busy right now. Please call back in a few minutes. Goodbye.",
    fr: "Désolée, toutes nos lignes sont occupées. Veuillez rappeler dans quelques minutes. Au revoir.",
  },
  stillThere: { en: "Are you still there?", fr: "Êtes-vous toujours là?" },
  silenceGoodbye: {
    en: "I haven't heard anything, so I'll end the call. A team member can call you back. Goodbye.",
    fr: "Je n'entends rien, je vais donc terminer l'appel. Un membre de l'équipe peut vous rappeler. Au revoir.",
  },
  failure: {
    en: "Sorry, something went wrong on my end. Could you say that again?",
    fr: "Désolée, un problème est survenu. Pouvez-vous répéter?",
  },
} as const satisfies Record<string, Record<Language, string>>;

/**
 * One WebSocket per phone call. Owns the call's lifecycle: admission -> caller turns -> hand-off
 * or hang-up -> post-call summary. Turns never overlap; barge-in cancels the current reply.
 */
export function handleRelayConnection(socket: WebSocket, deps: RelayDeps): void {
  const silenceMs = deps.silenceMs ?? DEFAULT_SILENCE_MS;
  let session: CallSession | null = null;
  let callSid: string | null = null;
  let log = deps.logger;
  let currentTurn: AbortController | null = null;
  let turnChain: Promise<void> = Promise.resolve();
  let silenceTimer: NodeJS.Timeout | null = null;
  let silencePrompts = 0;
  let endReason: CallEnd["endReason"] = "hangup";
  const latencies: number[] = [];
  let flagged = false;

  const send = (message: OutboundRelayMessage) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  };
  const say = (text: string) => {
    send({ type: "text", token: text, last: true });
  };
  const language = () => session?.language ?? "en";

  const recordTurn: AgentDeps["recordTurn"] = (s, turn) => {
    deps.calls.recordTurn(s.callId, ++s.turnSeq, turn);
  };

  const clearSilence = () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = null;
  };

  /** Re-prompt once after silence, then offer a callback and end politely. */
  const armSilence = (spokenChars: number) => {
    clearSilence();
    const playback = (spokenChars / SPOKEN_CHARS_PER_SECOND) * 1000;
    silenceTimer = setTimeout(() => {
      if (!session) return;
      silencePrompts++;
      if (silencePrompts === 1) {
        say(LINES.stillThere[language()]);
        armSilence(LINES.stillThere[language()].length);
        return;
      }
      say(LINES.silenceGoodbye[language()]);
      endReason = "silence";
      if (session.verifiedPatientId) {
        void deps.clinic
          .createTask({
            type: "callback",
            callId: session.callId,
            patientId: session.verifiedPatientId,
            reason: "Caller went silent mid-call",
            assignedRole: "front_desk",
          })
          .catch((err: unknown) => log.error({ err }, "failed to create silence callback task"));
      }
      send({ type: "end" });
    }, silenceMs + playback);
    silenceTimer.unref?.();
  };

  const switchLanguage = (s: CallSession, next: Language) => {
    if (s.language === next) return;
    s.language = next;
    const code = RELAY_LANGUAGE_CODES[next];
    send({ type: "language", ttsLanguage: code, transcriptionLanguage: code });
  };

  const runTurn = async (s: CallSession, text: string) => {
    const controller = new AbortController();
    currentTurn = controller;
    let spokenChars = 0;
    const speak = (sentence: string) => {
      if (controller.signal.aborted) return;
      spokenChars += sentence.length;
      send({ type: "text", token: `${sentence} `, last: false });
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
      log.info({ ...metrics }, "turn complete");
      if (metrics.inputTokens > 0) {
        void deps.usage
          .record({
            callId: s.callId,
            purpose: "live_turn",
            model: deps.agent.model.model,
            inputTokens: metrics.inputTokens,
            cachedInputTokens: metrics.cachedInputTokens,
            outputTokens: metrics.outputTokens,
          })
          .catch((err: unknown) => log.error({ err }, "failed to record usage"));
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      log.error({ err }, "agent turn failed");
      speak(LINES.failure[s.language]);
    } finally {
      if (!controller.signal.aborted) {
        send({ type: "text", token: "", last: true });
        if (s.handoff) {
          // Warm transfer: ConversationRelay ends the session and posts handoffData to the
          // <Connect action> URL, which dials staff (see routes/voice.ts).
          endReason = "transfer";
          clearSilence();
          send({ type: "end", handoffData: JSON.stringify({ callId: s.callId, ...s.handoff }) });
        } else {
          armSilence(spokenChars);
        }
      }
      if (currentTurn === controller) currentTurn = null;
    }
  };

  socket.on("message", (raw) => {
    const message = parseInbound(raw.toString());
    if (!message) return;

    switch (message.type) {
      case "setup": {
        if (callSid) return;
        callSid = message.callSid;
        deps.activeCalls.add(callSid);
        const activeBefore = deps.activeCalls.size - 1;
        const fromHash = message.from ? hashPhone(message.from, deps.phoneHashKey) : null;
        turnChain = admitCall(deps.admission, {
          activeCalls: activeBefore,
          fromHash,
          calls: deps.calls,
          usage: deps.usage,
        })
          .then(async (admission) => {
            if (!admission.admitted) {
              log.warn({ reason: admission.reason }, "call not admitted");
              endReason = "rejected";
              say(LINES.busy.en);
              send({ type: "end" });
              return;
            }
            const { id } = await deps.calls.startCall({ twilioSid: message.callSid, fromHash });
            session = createCallSession({ callId: id, callSid: message.callSid, fromHash });
            log = deps.logger.child({ callId: id });
            log.info("call started");
          })
          .catch((err: unknown) => {
            deps.logger.error({ err }, "failed to start call");
            endReason = "error";
            say(LINES.busy.en);
            send({ type: "end" });
          });
        return;
      }
      case "prompt": {
        if (!message.last) return;
        const text = message.voicePrompt.trim();
        if (!text) return;
        clearSilence();
        silencePrompts = 0;
        // Queue behind setup and any previous turn so history is never mutated concurrently.
        turnChain = turnChain.then(async () => {
          if (!session || session.handoff) return;
          if (FRENCH_REQUEST.test(text) || message.lang?.startsWith("fr")) {
            switchLanguage(session, "fr");
          }
          await runTurn(session, text);
        });
        return;
      }
      case "interrupt": {
        // Barge-in: stop speaking now. The caller's words arrive as the next prompt.
        clearSilence();
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
    clearSilence();
    currentTurn?.abort();
    if (callSid) deps.activeCalls.delete(callSid);
    void turnChain.finally(async () => {
      if (!session) return;
      try {
        await deps.calls.endCall(session.callId, {
          medianLatencyMs: median(latencies),
          flagged,
          endReason,
        });
        await deps.jobs.enqueue(
          "call_summary",
          { callId: session.callId },
          { dedupeKey: `summary:${session.callId}` },
        );
        log.info({ turns: latencies.length, endReason }, "call ended");
      } catch (err) {
        log.error({ err }, "failed to close call record");
      }
    });
  });
}
