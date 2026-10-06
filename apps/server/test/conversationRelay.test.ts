import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { TurnRecord } from "../src/agent/agent.js";
import type { CallEnd, CallRepository } from "../src/repositories/callRepository.js";
import type { UsageEntry, UsageRepository } from "../src/repositories/usageRepository.js";
import { handleRelayConnection, type RelayDeps } from "../src/telephony/conversationRelay.js";
import { createToolRegistry } from "../src/tools/registry.js";
import {
  baseContext,
  createFakes,
  fakeChatModel,
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
  ended: (CallEnd & { callId: string })[] = [];
  recentFromCaller = 0;
  async startCall() {
    return { id: "00000000-0000-4000-8000-000000000001" };
  }
  async endCall(callId: string, end: CallEnd) {
    this.ended.push({ callId, ...end });
  }
  async countRecentCallsFrom() {
    return this.recentFromCaller;
  }
  recordTurn(_callId: string, _seq: number, turn: TurnRecord) {
    this.turns.push(turn);
  }
  async drain() {}
}

class FakeUsage implements UsageRepository {
  entries: UsageEntry[] = [];
  usedToday = 0;
  async record(entry: UsageEntry) {
    this.entries.push(entry);
  }
  async tokensUsedToday() {
    return this.usedToday;
  }
}

function connect(
  replies: ScriptedReply[],
  overrides: Partial<RelayDeps> = {},
  transferAvailable = false,
) {
  const socket = new FakeSocket();
  const calls = new FakeCalls();
  const usage = new FakeUsage();
  const fakes = createFakes();
  const deps: RelayDeps = {
    calls,
    usage,
    clinic: fakes.repo,
    jobs: fakes.jobs,
    logger: silentLogger,
    phoneHashKey: "k".repeat(32),
    activeCalls: new Set(),
    admission: {
      maxConcurrentCalls: 5,
      maxCallsPerNumberPerHour: 6,
      dailyTokenBudget: 1_000_000,
      timeZone: "America/Toronto",
    },
    silenceMs: 50,
    agent: {
      model: fakeChatModel(replies).model,
      systemPrompt: "P",
      tools: createToolRegistry(),
      logger: silentLogger,
      toolContext: (session) => baseContext(session, fakes, { transferAvailable }),
    },
    ...overrides,
  };
  handleRelayConnection(socket as unknown as WebSocket, deps);
  return { socket, calls, usage, deps, fakes };
}

const settle = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
const setup = (socket: FakeSocket, from = "+14165550121") =>
  socket.receive({ type: "setup", sessionId: "s", callSid: "CA1", from });

afterEach(() => {
  vi.useRealTimers();
});

describe("ConversationRelay handler", () => {
  it("runs a turn and ends the reply with last=true", async () => {
    const { socket, calls } = connect([
      { text: "Free parking is behind the building. Anything else?" },
    ]);
    setup(socket);
    socket.receive({ type: "prompt", voicePrompt: "Where do I park?", last: true });
    await settle();
    expect(socket.sent.slice(0, 3)).toEqual([
      { type: "text", token: "Free parking is behind the building. ", last: false },
      { type: "text", token: "Anything else? ", last: false },
      { type: "text", token: "", last: true },
    ]);
    expect(calls.turns.map((t) => t.role)).toEqual(["caller", "agent"]);
  });

  it("ignores partial transcripts", async () => {
    const { socket } = connect([]);
    setup(socket);
    socket.receive({ type: "prompt", voicePrompt: "Where do", last: false });
    await settle();
    expect(socket.sent).toEqual([]);
  });

  it("switches the relay to French when the caller asks", async () => {
    const { socket } = connect([{ text: "Bonjour, comment puis-je vous aider?" }]);
    setup(socket);
    socket.receive({ type: "prompt", voicePrompt: "Français s'il vous plaît", last: true });
    await settle();
    expect(socket.sent[0]).toEqual({
      type: "language",
      ttsLanguage: "fr-CA",
      transcriptionLanguage: "fr-CA",
    });
  });

  describe("admission control", () => {
    it("rejects calls over the concurrency cap", async () => {
      const { socket } = connect([], {
        activeCalls: new Set(["CA-other"]),
        admission: {
          maxConcurrentCalls: 1,
          maxCallsPerNumberPerHour: 6,
          dailyTokenBudget: 1e6,
          timeZone: "UTC",
        },
      });
      setup(socket);
      await settle();
      expect(socket.sent.at(-1)).toEqual({ type: "end" });
    });

    it("rate-limits a caller who keeps redialling", async () => {
      const { socket, calls } = connect([]);
      calls.recentFromCaller = 6;
      setup(socket);
      await settle();
      expect(socket.sent.at(-1)).toEqual({ type: "end" });
    });

    it("declines new calls once the daily token budget is spent", async () => {
      const { socket, usage } = connect([]);
      usage.usedToday = 1_000_000;
      setup(socket);
      await settle();
      expect(socket.sent.at(-1)).toEqual({ type: "end" });
    });
  });

  it("re-prompts once on silence, then says goodbye and ends", async () => {
    vi.useFakeTimers();
    const { socket, calls } = connect([{ text: "Hi." }]);
    setup(socket);
    socket.receive({ type: "prompt", voicePrompt: "hello", last: true });
    await vi.advanceTimersByTimeAsync(10);
    socket.sent.length = 0;
    // silenceMs (50) + estimated playback of "Hi." (~200ms)
    await vi.advanceTimersByTimeAsync(400);
    expect(socket.sent).toEqual([{ type: "text", token: "Are you still there?", last: true }]);
    // Second silence: goodbye, then end.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(socket.sent.at(-1)).toEqual({ type: "end" });
    socket.emit("close");
    await vi.advanceTimersByTimeAsync(10);
    expect(calls.ended[0]?.endReason).toBe("silence");
  });

  it("does not re-prompt when the caller speaks in time", async () => {
    vi.useFakeTimers();
    const { socket } = connect([{ text: "Hi." }, { text: "Sure." }]);
    setup(socket);
    socket.receive({ type: "prompt", voicePrompt: "hello", last: true });
    await vi.advanceTimersByTimeAsync(100);
    socket.receive({ type: "prompt", voicePrompt: "parking?", last: true });
    await vi.advanceTimersByTimeAsync(100);
    expect(socket.sent.some((m) => m.token === "Are you still there?")).toBe(false);
  });

  it("hands off to staff after the transfer sentence is spoken", async () => {
    const { socket, calls } = connect(
      [
        {
          tools: [
            {
              name: "transfer_to_staff",
              input: { reason: "caller_request", summary: "Wants to speak to a person" },
            },
          ],
        },
        { text: "I'll connect you with our team now." },
      ],
      {},
      true,
    );
    setup(socket);
    socket.receive({ type: "prompt", voicePrompt: "Can I talk to a person?", last: true });
    await settle(20);
    const end = socket.sent.at(-1) as { type: string; handoffData: string };
    expect(end.type).toBe("end");
    expect(JSON.parse(end.handoffData)).toMatchObject({
      reason: "caller_request",
      summary: "Wants to speak to a person",
    });
    socket.emit("close");
    await settle();
    expect(calls.ended[0]?.endReason).toBe("transfer");
  });

  it("records usage, closes the call and queues the post-call summary", async () => {
    const { socket, calls, usage, deps, fakes } = connect([
      { text: "Hello.", usage: { inputTokens: 1200, cachedInputTokens: 1024, outputTokens: 3 } },
    ]);
    setup(socket);
    socket.receive({ type: "prompt", voicePrompt: "hi", last: true });
    await settle();
    expect(deps.activeCalls.has("CA1")).toBe(true);
    socket.emit("close");
    await settle();
    expect(deps.activeCalls.size).toBe(0);
    expect(calls.ended[0]).toMatchObject({
      endReason: "hangup",
      medianLatencyMs: expect.any(Number),
    });
    expect(usage.entries[0]).toMatchObject({
      purpose: "live_turn",
      inputTokens: 1200,
      cachedInputTokens: 1024,
    });
    expect(fakes.jobs.jobs).toEqual([
      { type: "call_summary", payload: { callId: "00000000-0000-4000-8000-000000000001" } },
    ]);
  });
});
