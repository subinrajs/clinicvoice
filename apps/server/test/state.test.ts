import { describe, expect, it } from "vitest";
import { createCallSession } from "../src/session/callSession.js";
import { allowedTools, deriveState } from "../src/session/state.js";

const newSession = () => createCallSession({ callId: "c", callSid: "s", fromHash: null });

describe("deriveState / allowedTools", () => {
  it("starts unverified with only identity and always-allowed tools", () => {
    const s = newSession();
    expect(deriveState(s)).toBe("verify_identity");
    expect(allowedTools(s)).toEqual([
      "verify_identity",
      "get_clinic_info",
      "create_task",
      "transfer_to_staff",
    ]);
  });

  it("allows task tools once verified, but never write tools", () => {
    const s = newSession();
    s.verifiedPatientId = "p";
    expect(deriveState(s)).toBe("handle_task");
    expect(allowedTools(s)).toContain("find_appointments");
    expect(allowedTools(s)).not.toContain("book_slot");
  });

  it("allows no task tools while waiting for confirmation", () => {
    const s = newSession();
    s.verifiedPatientId = "p";
    s.pendingAction = { tool: "book_slot", args: {}, summary: "", confirmed: false };
    expect(deriveState(s)).toBe("confirm_action");
    expect(allowedTools(s)).toEqual(["get_clinic_info", "create_task", "transfer_to_staff"]);
  });

  it("allows exactly the confirmed write tool", () => {
    const s = newSession();
    s.verifiedPatientId = "p";
    s.pendingAction = { tool: "cancel_appointment", args: {}, summary: "", confirmed: true };
    expect(deriveState(s)).toBe("execute_tool");
    expect(allowedTools(s)).toContain("cancel_appointment");
    expect(allowedTools(s)).not.toContain("book_slot");
  });

  it("locks everything but escalation after lockout, even if verified", () => {
    const s = newSession();
    s.verifiedPatientId = "p";
    s.lockedOut = true;
    expect(deriveState(s)).toBe("escalate");
    expect(allowedTools(s)).not.toContain("find_appointments");
  });
});
