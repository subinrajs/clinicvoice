import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import type { TurnRecord } from "../src/agent/agent.js";
import type { CallRepository } from "../src/repositories/callRepository.js";
import { handleRelayConnection, type RelayDeps } from "../src/telephony/conversationRelay.js";
import { createToolRegistry } from "../src/tools/registry.js";
import {
  fakeAnthropic,
  FakeAuditWriter,
  FakeClinicRepository,
  silentLogger,
  type ScriptedReply,
} from "./helpers.js";

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  receive(message: Record<string, unknown>) {
    this.emit("message", Buffer.from(JSON.stringify(message)));
  }
}

class FakeCalls implements CallRepository {
  turns: TurnRecord[] = [];
  ended: { callId: string; medianLatencyMs: number | null }[] = [];
  async startCall() {
    return { id: "call-1" };
  }
  async endCall(callId: string, outcome: { medianLatencyMs: number | null }) {
    this.ended.push({ callId, medianLatencyMs: outcome.medianLatencyMs });
  }
  recordTurn(_callId: string, _seq: number, turn: TurnRecord) {
    this.turns.push(turn);
  }
  async drain() {}
}

function connect(replies: ScriptedReply[], overrides: Partial<RelayDeps> = {}) {
  const socket = new FakeSocket();
  const calls = new FakeCalls();
  const repo = new FakeClinicRepository();
  const deps: RelayDeps = {
    calls,
    logger: silentLogger,
    phoneHashKey: "k".repeat(32),
    maxConcurrentCalls: 5,
    activeCalls: new Set(),
    agent: {
      client: fakeAnthropic(replies).client,
      model: "m",
      systemPrompt: "P",
      tools: createToolRegistry(),
      logger: silentLogger,
      toolContext: (session) => ({
        session,
        repo,
        audit: new FakeAuditWriter(),
        logger: silentLogger,
        timeZone: "America/Toronto",
        now: () => new Date(),
        requestId: "r",
      }),
    },
    ...overrides,
  };
  handleRelayConnection(socket as unknown as WebSocket, deps);
  return { socket, calls, deps };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("ConversationRelay handler", () => {
  it("runs a turn and ends the reply with last=true", async () => {
    const { socket, calls } = connect([
      { text: "Free parking is behind the building. Anything else?" },
    ]);
    socket.receive({ type: "setup", sessionId: "s", callSid: "CA1", from: "+14165550121" });
    socket.receive({ type: "prompt", voicePrompt: "Where do I park?", last: true });
    await settle();
    expect(socket.sent).toEqual([
      { type: "text", token: "Free parking is behind the building. ", last: false },
      { type: "text", token: "Anything else? ", last: false },
      { type: "text", token: "", last: true },
    ]);
    expect(calls.turns.map((t) => t.role)).toEqual(["caller", "agent"]);
  });

  it("ignores partial transcripts", async () => {
    const { socket } = connect([]);
    socket.receive({ type: "setup", sessionId: "s", callSid: "CA1" });
    socket.receive({ type: "prompt", voicePrompt: "Where do", last: false });
    await settle();
    expect(socket.sent).toEqual([]);
  });

  it("switches the relay to French when the caller asks", async () => {
    const { socket } = connect([{ text: "Bonjour, comment puis-je vous aider?" }]);
    socket.receive({ type: "setup", sessionId: "s", callSid: "CA1" });
    socket.receive({ type: "prompt", voicePrompt: "Français s'il vous plaît", last: true });
    await settle();
    expect(socket.sent[0]).toEqual({
      type: "language",
      ttsLanguage: "fr-CA",
      transcriptionLanguage: "fr-CA",
    });
  });

  it("rejects calls over the concurrency cap", async () => {
    const { socket } = connect([], { maxConcurrentCalls: 1, activeCalls: new Set(["CA-other"]) });
    socket.receive({ type: "setup", sessionId: "s", callSid: "CA1" });
    expect(socket.sent.at(-1)).toEqual({ type: "end" });
  });

  it("records the call end with median latency and frees the slot", async () => {
    const { socket, calls, deps } = connect([{ text: "Hello." }]);
    socket.receive({ type: "setup", sessionId: "s", callSid: "CA1" });
    socket.receive({ type: "prompt", voicePrompt: "hi", last: true });
    await settle();
    expect(deps.activeCalls.has("CA1")).toBe(true);
    socket.emit("close");
    await settle();
    expect(deps.activeCalls.size).toBe(0);
    expect(calls.ended).toEqual([{ callId: "call-1", medianLatencyMs: expect.any(Number) }]);
  });
});
