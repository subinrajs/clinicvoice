import { describe, expect, it } from "vitest";
import { runAgentTurn, type AgentDeps, type TurnRecord } from "../src/agent/agent.js";
import { createCallSession } from "../src/session/callSession.js";
import { createToolRegistry } from "../src/tools/registry.js";
import {
  fakeAnthropic,
  FakeAuditWriter,
  FakeClinicRepository,
  silentLogger,
  type ScriptedReply,
} from "./helpers.js";

function setup(replies: ScriptedReply[]) {
  const { client, requests } = fakeAnthropic(replies);
  const repo = new FakeClinicRepository();
  const session = createCallSession({ callId: "call-1", callSid: "CA1", fromHash: null });
  const turns: TurnRecord[] = [];
  const spoken: string[] = [];
  const deps: AgentDeps = {
    client,
    model: "claude-haiku-4-5",
    systemPrompt: "STATIC PROMPT",
    tools: createToolRegistry(),
    logger: silentLogger,
    toolContext: (s) => ({
      session: s,
      repo,
      audit: new FakeAuditWriter(),
      logger: silentLogger,
      timeZone: "America/Toronto",
      now: () => new Date("2026-10-05T14:00:00Z"),
      requestId: "r",
    }),
    recordTurn: (_s, turn) => turns.push(turn),
  };
  const run = (text: string) => runAgentTurn(deps, session, text, (t) => spoken.push(t));
  return { run, session, requests, turns, spoken, repo };
}

describe("runAgentTurn", () => {
  it("streams sentences, runs tools, and feeds results back to the model", async () => {
    const { run, session, requests, spoken } = setup([
      {
        text: "Let me check that. ",
        tools: [
          {
            name: "verify_identity",
            input: { last_name: "Santos", dob: "1984-03-12", phone_last4: "0121" },
          },
        ],
      },
      { text: "Thanks Maria, you're verified. How can I help?" },
    ]);
    const metrics = await run("Santos, March 12 1984, 0121");
    expect(spoken).toEqual([
      "Let me check that.",
      "Thanks Maria, you're verified.",
      "How can I help?",
    ]);
    expect(session.verifiedPatientId).toBe("p-maria");
    expect(metrics.toolCalls).toBe(1);
    expect(metrics.firstSpeechMs).not.toBeNull();
    // Second request carries the tool result and the updated state.
    const second = requests[1]!;
    const system = second.system as { text: string }[];
    expect(system[1]!.text).toContain("Current state: handle_task");
  });

  it("keeps the cached prefix byte-identical across turns", async () => {
    const { run, requests } = setup([{ text: "Hello." }, { text: "Sure." }]);
    await run("hi");
    await run("parking?");
    const [a, b] = requests;
    expect(JSON.stringify(a!.tools)).toBe(JSON.stringify(b!.tools));
    expect((a!.system as { text: string }[])[0]).toEqual((b!.system as { text: string }[])[0]);
    expect((a!.system as { cache_control?: unknown }[])[0]!.cache_control).toEqual({
      type: "ephemeral",
    });
  });

  it("replaces clinical advice before it is spoken and scrubs it from history", async () => {
    const { run, spoken, session } = setup([
      { text: "Yes, it is safe to have contrast with your kidneys. Anything else?" },
    ]);
    const metrics = await run("Is contrast safe for my kidneys?");
    expect(metrics.filterHit).toBe(true);
    expect(spoken).toEqual([
      "I'm not able to advise on that, but I can have a member of our clinical team call you back.",
    ]);
    expect(JSON.stringify(session.history)).not.toContain("safe to have contrast");
  });

  it("confirms only on the caller's own yes, outside the model", async () => {
    const { run, session, requests } = setup([{ text: "Great, booking that now." }]);
    session.verifiedPatientId = "p-maria";
    session.pendingAction = {
      tool: "book_slot",
      args: { slot_ref: "S1" },
      summary: "Thursday at 2:40?",
      confirmed: false,
    };
    await run("yes please");
    expect(session.pendingAction?.confirmed).toBe(true);
    expect((requests[0]!.system as { text: string }[])[1]!.text).toContain("The caller CONFIRMED");
  });

  it("clears the pending action when the caller says no", async () => {
    const { run, session } = setup([{ text: "No problem, nothing was changed." }]);
    session.verifiedPatientId = "p-maria";
    session.pendingAction = {
      tool: "cancel_appointment",
      args: { appointment_ref: "APPT1" },
      summary: "Cancel?",
      confirmed: false,
    };
    await run("actually no");
    expect(session.pendingAction).toBeNull();
  });

  it("hands off to staff when the model loops on tool calls", async () => {
    const looping = { tools: [{ name: "find_appointments", input: {} }] };
    const { run, repo, spoken, session } = setup([looping, looping, looping, looping]);
    await run("what are my appointments");
    expect(repo.tasks).toHaveLength(1);
    expect(spoken.at(-1)).toContain("team member call you back");
    expect(session.history.at(-1)?.role).toBe("assistant");
  });
});
