import { ToolErrorCode } from "@clinicvoice/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool } from "../src/tools/defineTool.js";
import { executeTool } from "../src/tools/executeTool.js";
import { requireConfirmed, requireVerified } from "../src/tools/guards.js";
import { createToolRegistry } from "../src/tools/registry.js";
import { ok, type ToolDefinition } from "../src/tools/types.js";
import { getClinicInfo } from "../src/tools/getClinicInfo.js";
import { verifyIdentity } from "../src/tools/verifyIdentity.js";
import { findAppointments } from "../src/tools/findAppointments.js";
import { proposeAction } from "../src/tools/proposeAction.js";
import { createTask } from "../src/tools/createTask.js";
import { makeContext, verify } from "./helpers.js";

/** A stand-in confirmed-write tool, so the confirmation path is tested before book_slot exists. */
const writes: Record<string, unknown>[] = [];
const fakeBook = defineTool({
  name: "book_slot",
  description: "test",
  input: z.object({ slot_ref: z.string(), appointment_ref: z.string().optional() }),
  guards: [requireVerified, requireConfirmed("book_slot")],
  describe: async (input) => `Book slot ${input.slot_ref}?`,
  async run(input) {
    writes.push(input);
    return ok({ booked: true });
  },
});
const registryWithWrite = createToolRegistry([
  getClinicInfo,
  verifyIdentity,
  findAppointments,
  proposeAction,
  createTask,
  fakeBook,
] as unknown as ToolDefinition[]);

const IDENTITY = { last_name: "Santos", dob: "1984-03-12", phone_last4: "0121" };

describe("executeTool pipeline", () => {
  it("rejects tools not allowed in the current state", async () => {
    const { ctx, tools } = makeContext();
    const result = await executeTool(tools, "find_appointments", {}, ctx);
    expect(result).toMatchObject({
      ok: false,
      error: { code: ToolErrorCode.TOOL_NOT_ALLOWED_IN_STATE },
    });
  });

  it("rejects unknown tools the same way (prompt injection cannot invent tools)", async () => {
    const { ctx, tools } = makeContext();
    const result = await executeTool(tools, "drop_tables", {}, ctx);
    expect(result).toMatchObject({
      ok: false,
      error: { code: ToolErrorCode.TOOL_NOT_ALLOWED_IN_STATE },
    });
  });

  it("validates input against the schema", async () => {
    const { ctx, tools } = makeContext();
    const result = await executeTool(
      tools,
      "verify_identity",
      { last_name: "Santos", dob: "March 12", phone_last4: "12" },
      ctx,
    );
    expect(result).toMatchObject({ ok: false, error: { code: ToolErrorCode.INVALID_INPUT } });
  });

  it("turns handler exceptions into INTERNAL without leaking details", async () => {
    const { ctx, tools, repo } = makeContext();
    repo.listSites = async () => {
      throw new Error("connection refused at 10.0.0.5");
    };
    const result = await executeTool(tools, "get_clinic_info", {}, ctx);
    expect(result).toMatchObject({ ok: false, error: { code: ToolErrorCode.INTERNAL } });
    expect(JSON.stringify(result)).not.toContain("10.0.0.5");
  });
});

describe("verify_identity", () => {
  it("verifies on exact DOB + last 4 and a close surname, and audits it", async () => {
    const { ctx, tools, session, audit } = makeContext();
    const result = await executeTool(
      tools,
      "verify_identity",
      { ...IDENTITY, last_name: "Santo's" },
      ctx,
    );
    expect(result).toEqual({ ok: true, data: { verified: true, first_name: "Maria" } });
    expect(session.verifiedPatientId).toBe("p-maria");
    expect(audit.events).toContainEqual(
      expect.objectContaining({ action: "verify", entityId: "p-maria" }),
    );
  });

  it("never reveals which field was wrong", async () => {
    const { ctx, tools } = makeContext();
    const result = await executeTool(
      tools,
      "verify_identity",
      { ...IDENTITY, dob: "1984-03-13" },
      ctx,
    );
    expect(result.ok).toBe(false);
    const message = JSON.stringify(result).toLowerCase();
    for (const hint of ["birth", "dob", "phone", "name", "maria"])
      expect(message).not.toContain(hint);
  });

  it("locks after three failures in one call", async () => {
    const { ctx, tools, session } = makeContext();
    const wrong = { ...IDENTITY, phone_last4: "9999" };
    await executeTool(tools, "verify_identity", wrong, ctx);
    await executeTool(tools, "verify_identity", wrong, ctx);
    const third = await executeTool(tools, "verify_identity", wrong, ctx);
    expect(third).toMatchObject({ ok: false, error: { code: ToolErrorCode.LOCKED } });
    expect(session.lockedOut).toBe(true);
    // Even correct details are refused after lockout (the tool is no longer allowed at all).
    const after = await executeTool(tools, "verify_identity", IDENTITY, ctx);
    expect(after.ok).toBe(false);
    expect(session.verifiedPatientId).toBeNull();
  });

  it("locks when recent failures across calls exceed the window limit", async () => {
    const { ctx, tools, repo, session } = makeContext();
    repo.priorFailures = 5;
    const result = await executeTool(tools, "verify_identity", IDENTITY, ctx);
    expect(result).toMatchObject({ ok: false, error: { code: ToolErrorCode.LOCKED } });
    expect(session.verifiedPatientId).toBeNull();
  });

  it("treats an ambiguous match as a failure", async () => {
    const { ctx, tools, repo, session } = makeContext();
    repo.patients.push({
      id: "p-twin",
      firstName: "Mario",
      lastName: "Santos",
      preferredLanguage: "en",
      dob: "1984-03-12",
      last4: "0121",
    });
    const result = await executeTool(tools, "verify_identity", IDENTITY, ctx);
    expect(result.ok).toBe(false);
    expect(session.verifiedPatientId).toBeNull();
  });
});

describe("find_appointments", () => {
  it("returns speakable times and opaque refs, never internal ids", async () => {
    const { ctx, tools, session, audit } = makeContext();
    verify(session);
    const result = await executeTool(tools, "find_appointments", {}, ctx);
    expect(result).toEqual({
      ok: true,
      data: {
        appointments: [
          {
            ref: "APPT1",
            exam: "MRI of the knee",
            modality: "MRI",
            site: "Lakeshore MRI & CT Mississauga",
            when: "Thursday, October 15th at 2:40 in the afternoon",
          },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain("appt-1");
    expect(session.refs.get("APPT1")).toBe("appt-1");
    expect(audit.events).toContainEqual(
      expect.objectContaining({ action: "read", entity: "appointment", entityId: "appt-1" }),
    );
  });
});

describe("confirmation flow (propose_action -> yes -> write)", () => {
  it("blocks a write that was never proposed", async () => {
    const { ctx, session } = makeContext({ tools: registryWithWrite });
    verify(session);
    const result = await executeTool(registryWithWrite, "book_slot", { slot_ref: "S1" }, ctx);
    expect(result.ok).toBe(false);
  });

  it("requires the caller's confirmation before the write", async () => {
    const { ctx, session } = makeContext({ tools: registryWithWrite });
    verify(session);
    const proposed = await executeTool(
      registryWithWrite,
      "propose_action",
      { tool: "book_slot", args: { slot_ref: "S1" } },
      ctx,
    );
    expect(proposed).toEqual({
      ok: true,
      data: expect.objectContaining({ read_back: "Book slot S1?" }),
    });
    // Model tries to write before the caller said yes: not even allowed in confirm state.
    const early = await executeTool(registryWithWrite, "book_slot", { slot_ref: "S1" }, ctx);
    expect(early).toMatchObject({
      ok: false,
      error: { code: ToolErrorCode.TOOL_NOT_ALLOWED_IN_STATE },
    });
  });

  it("rejects a confirmed write whose arguments differ from what the caller approved", async () => {
    const { ctx, session } = makeContext({ tools: registryWithWrite });
    verify(session);
    await executeTool(
      registryWithWrite,
      "propose_action",
      { tool: "book_slot", args: { slot_ref: "S1" } },
      ctx,
    );
    session.pendingAction!.confirmed = true; // what the classifier does on "yes"
    const swapped = await executeTool(registryWithWrite, "book_slot", { slot_ref: "S2" }, ctx);
    expect(swapped).toMatchObject({ ok: false, error: { code: ToolErrorCode.NOT_CONFIRMED } });
  });

  it("runs the exact confirmed write once and consumes the confirmation", async () => {
    const { ctx, session } = makeContext({ tools: registryWithWrite });
    verify(session);
    writes.length = 0;
    await executeTool(
      registryWithWrite,
      "propose_action",
      { tool: "book_slot", args: { slot_ref: "S1" } },
      ctx,
    );
    session.pendingAction!.confirmed = true;
    const first = await executeTool(registryWithWrite, "book_slot", { slot_ref: "S1" }, ctx);
    expect(first).toEqual({ ok: true, data: { booked: true } });
    const replay = await executeTool(registryWithWrite, "book_slot", { slot_ref: "S1" }, ctx);
    expect(replay.ok).toBe(false);
    expect(writes).toHaveLength(1);
    expect(session.pendingAction).toBeNull();
  });
});

describe("create_task", () => {
  it("is allowed before verification and routes reviews to technologists", async () => {
    const { ctx, tools, repo } = makeContext();
    const result = await executeTool(
      tools,
      "create_task",
      { type: "callback", reason: "Asks about contrast and kidneys" },
      ctx,
    );
    expect(result).toEqual({ ok: true, data: { task_ref: "T1", created: true } });
    expect(repo.tasks[0]).toMatchObject({ type: "callback", patientId: null });
  });
});
