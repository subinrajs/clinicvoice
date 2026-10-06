import { ToolErrorCode } from "@clinicvoice/shared";
import { describe, expect, it } from "vitest";
import { executeTool } from "../src/tools/executeTool.js";
import { makeContext, verify } from "./helpers.js";

/** Runs the confirmation path the way the call does: propose -> caller "yes" -> write. */
async function proposeAndConfirm(
  h: ReturnType<typeof makeContext>,
  tool: string,
  args: Record<string, unknown>,
) {
  const proposed = await executeTool(h.tools, "propose_action", { tool, args }, h.ctx);
  if (!proposed.ok) throw new Error(`propose failed: ${JSON.stringify(proposed)}`);
  h.session.pendingAction!.confirmed = true;
  return proposed.data as { read_back: string };
}

function verified() {
  const h = makeContext();
  verify(h.session);
  return h;
}

describe("search_slots", () => {
  it("offers speakable times with opaque refs for the ordered modality", async () => {
    const h = verified();
    const result = await executeTool(h.tools, "search_slots", { modality: "MRI" }, h.ctx);
    expect(result.ok).toBe(true);
    const data = (result as { data: { exam: string; slots: { ref: string; when: string }[] } })
      .data;
    expect(data.exam).toBe("MRI of the knee");
    expect(data.slots[0]).toEqual({
      ref: "S1",
      site: "Lakeshore MRI & CT Mississauga",
      when: "Thursday, October 15th at 9 in the morning",
    });
    expect(JSON.stringify(data)).not.toContain("slot-1");
  });

  it("refuses a modality the patient has no order for", async () => {
    const h = verified();
    const result = await executeTool(h.tools, "search_slots", { modality: "CT" }, h.ctx);
    expect(result).toMatchObject({ ok: false, error: { code: ToolErrorCode.NO_AVAILABILITY } });
  });

  it("filters by part of day in the clinic's time zone", async () => {
    const h = verified();
    const result = await executeTool(
      h.tools,
      "search_slots",
      { modality: "MRI", part_of_day: "evening" },
      h.ctx,
    );
    const slots = (result as { data: { slots: { when: string }[] } }).data.slots;
    expect(slots).toHaveLength(1);
    expect(slots[0]!.when).toContain("6 in the evening");
  });

  it("requires verification", async () => {
    const h = makeContext();
    const result = await executeTool(h.tools, "search_slots", { modality: "MRI" }, h.ctx);
    expect(result.ok).toBe(false);
  });
});

describe("hold, book and reschedule", () => {
  it("reschedules end to end: the read-back is server-generated and the old booking is replaced", async () => {
    const h = verified();
    await executeTool(h.tools, "find_appointments", {}, h.ctx); // APPT1
    await executeTool(h.tools, "search_slots", { modality: "MRI" }, h.ctx); // S1..S3
    const held = await executeTool(h.tools, "hold_slot", { slot_ref: "S2" }, h.ctx);
    expect(held).toMatchObject({ ok: true, data: { held: true, held_for_minutes: 5 } });

    const { read_back } = await proposeAndConfirm(h, "book_slot", {
      slot_ref: "S2",
      appointment_ref: "APPT1",
    });
    expect(read_back).toBe(
      "I'll move your MRI of the knee from Thursday, October 15th at 2:40 in the afternoon to Friday, October 16th at 2:40 in the afternoon at Lakeshore MRI & CT Mississauga. Is that right?",
    );

    const booked = await executeTool(
      h.tools,
      "book_slot",
      { slot_ref: "S2", appointment_ref: "APPT1" },
      h.ctx,
    );
    expect(booked).toMatchObject({ ok: true, data: { booked: true, appointment_ref: "APPT2" } });
    expect(h.scheduling.bookings[0]).toMatchObject({
      slotId: "slot-2",
      replacesAppointmentId: "appt-1",
      heldByCall: "call-1",
      requisitionId: "req-1",
    });
    expect(h.audit.events.map((e) => e.action)).toEqual(
      expect.arrayContaining(["hold", "book", "cancel"]),
    );
    expect(h.session.pendingAction).toBeNull();
    expect(h.session.heldSlotId).toBeNull();
  });

  it("releases the previous hold when the caller picks a different time", async () => {
    const h = verified();
    await executeTool(h.tools, "search_slots", { modality: "MRI" }, h.ctx);
    await executeTool(h.tools, "hold_slot", { slot_ref: "S1" }, h.ctx);
    await executeTool(h.tools, "hold_slot", { slot_ref: "S2" }, h.ctx);
    expect(h.scheduling.slots.find((s) => s.id === "slot-1")!.status).toBe("open");
    expect(h.scheduling.slots.find((s) => s.id === "slot-2")!.status).toBe("held");
  });

  it("rejects refs the caller never heard (no guessing internal ids)", async () => {
    const h = verified();
    const held = await executeTool(h.tools, "hold_slot", { slot_ref: "slot-1" }, h.ctx);
    expect(held).toMatchObject({ ok: false, error: { code: ToolErrorCode.UNKNOWN_REF } });
    const proposed = await executeTool(
      h.tools,
      "propose_action",
      { tool: "book_slot", args: { slot_ref: "S9" } },
      h.ctx,
    );
    expect(proposed).toMatchObject({ ok: false, error: { code: ToolErrorCode.UNKNOWN_REF } });
  });

  it("reports an expired hold instead of booking", async () => {
    const h = verified();
    await executeTool(h.tools, "search_slots", { modality: "MRI" }, h.ctx);
    // Never held: the RIS refuses the booking.
    await proposeAndConfirm(h, "book_slot", { slot_ref: "S1" });
    const result = await executeTool(h.tools, "book_slot", { slot_ref: "S1" }, h.ctx);
    expect(result).toMatchObject({ ok: false, error: { code: ToolErrorCode.HOLD_EXPIRED } });
  });
});

describe("cancel_appointment", () => {
  it("cancels only after confirmation, with a server-generated read-back", async () => {
    const h = verified();
    await executeTool(h.tools, "find_appointments", {}, h.ctx);
    const unconfirmed = await executeTool(
      h.tools,
      "cancel_appointment",
      { appointment_ref: "APPT1", reason: "caller_request" },
      h.ctx,
    );
    expect(unconfirmed.ok).toBe(false);
    expect(h.scheduling.cancellations).toEqual([]);

    const { read_back } = await proposeAndConfirm(h, "cancel_appointment", {
      appointment_ref: "APPT1",
      reason: "caller_request",
    });
    expect(read_back).toBe(
      "I'll cancel your MRI of the knee on Thursday, October 15th at 2:40 in the afternoon. Is that right?",
    );
    const done = await executeTool(
      h.tools,
      "cancel_appointment",
      { appointment_ref: "APPT1", reason: "caller_request" },
      h.ctx,
    );
    expect(done).toEqual({ ok: true, data: { cancelled: true } });
    expect(h.scheduling.cancellations).toEqual(["appt-1"]);
  });

  it("cannot reach another patient's appointment even with a valid-looking ref", async () => {
    const h = verified();
    h.scheduling.appointments.push({
      ...h.scheduling.appointments[0]!,
      id: "appt-other",
      patientId: "p-other",
    });
    h.session.refs.set("APPT9", "appt-other");
    const result = await executeTool(
      h.tools,
      "propose_action",
      { tool: "cancel_appointment", args: { appointment_ref: "APPT9", reason: "other" } },
      h.ctx,
    );
    expect(result).toMatchObject({ ok: false, error: { code: ToolErrorCode.UNKNOWN_REF } });
  });
});

describe("record_screening_answer", () => {
  async function start(h: ReturnType<typeof makeContext>) {
    await executeTool(h.tools, "find_appointments", {}, h.ctx);
    return executeTool(h.tools, "record_screening_answer", { appointment_ref: "APPT1" }, h.ctx);
  }

  it("starts with the first question in the caller's language", async () => {
    const h = verified();
    h.session.language = "fr";
    const first = await start(h);
    expect(first).toEqual({
      ok: true,
      data: {
        next_question: {
          id: "pacemaker",
          ask: "Avez-vous un stimulateur cardiaque ou un défibrillateur?",
        },
      },
    });
  });

  it("flags a pacemaker for review, creates one review task, and never clears", async () => {
    const h = verified();
    await start(h);
    const result = await executeTool(
      h.tools,
      "record_screening_answer",
      {
        appointment_ref: "APPT1",
        question_id: "pacemaker",
        answer: "yes",
        caller_words: "I have a pacemaker",
      },
      h.ctx,
    );
    expect(result).toMatchObject({ ok: true, data: { next_question: { id: "neurostimulator" } } });
    const screening = [...h.screening.screenings.values()][0]!;
    expect(screening.status).toBe("needs_review");
    expect(screening.answers.pacemaker).toMatchObject({
      answer: "yes",
      callerWords: "I have a pacemaker",
    });
    expect(h.repo.tasks).toEqual([
      expect.objectContaining({ type: "review", screeningId: screening.id }),
    ]);
    expect(h.jobs.jobs).toEqual([
      {
        type: "implant_extraction",
        payload: { screeningId: screening.id, questionId: "pacemaker" },
      },
    ]);

    // Later "no" answers never downgrade the status.
    await executeTool(
      h.tools,
      "record_screening_answer",
      { appointment_ref: "APPT1", question_id: "neurostimulator", answer: "no" },
      h.ctx,
    );
    expect([...h.screening.screenings.values()][0]!.status).toBe("needs_review");
    expect(h.repo.tasks).toHaveLength(1);
  });

  it("treats 'unsure' as a risk answer and keeps the caller's exact words", async () => {
    const h = verified();
    await start(h);
    await executeTool(
      h.tools,
      "record_screening_answer",
      {
        appointment_ref: "APPT1",
        question_id: "implants_other",
        answer: "unsure",
        caller_words: "I'm not sure, I had knee surgery",
      },
      h.ctx,
    );
    const screening = [...h.screening.screenings.values()][0]!;
    expect(screening.status).toBe("needs_review");
    expect(screening.answers.implants_other!.callerWords).toBe("I'm not sure, I had knee surgery");
  });

  it("ends in_progress (not clear) when every answer is no", async () => {
    const h = verified();
    let result = await start(h);
    while (result.ok && "next_question" in (result.data as object)) {
      const id = (result.data as { next_question: { id: string } }).next_question.id;
      result = await executeTool(
        h.tools,
        "record_screening_answer",
        { appointment_ref: "APPT1", question_id: id, answer: "no" },
        h.ctx,
      );
    }
    expect(result).toMatchObject({ ok: true, data: { done: true, flagged_for_review: false } });
    expect([...h.screening.screenings.values()][0]!.status).toBe("in_progress");
  });

  it("rejects screening for non-MRI appointments", async () => {
    const h = verified();
    h.scheduling.appointments[0]!.modality = "CT";
    const result = await start(h);
    expect(result.ok).toBe(false);
  });
});

describe("send_prep_instructions", () => {
  it("sends only the approved template, in the requested language, after confirmation", async () => {
    const h = verified();
    await executeTool(h.tools, "find_appointments", {}, h.ctx);
    const { read_back } = await proposeAndConfirm(h, "send_prep_instructions", {
      appointment_ref: "APPT1",
      language: "fr",
    });
    expect(read_back).toContain("in French");
    const result = await executeTool(
      h.tools,
      "send_prep_instructions",
      { appointment_ref: "APPT1", language: "fr" },
      h.ctx,
    );
    expect(result).toEqual({ ok: true, data: { sent: true } });
    expect(h.sms.sent).toEqual([{ to: "+14165550121", body: "Préparation IRM genou (FR)" }]);
    expect(h.messaging.messages).toEqual([
      { patientId: "p-maria", templateId: "tpl-fr", providerSid: "local-1", status: "recorded" },
    ]);
  });

  it("returns NO_TEMPLATE when no approved wording exists", async () => {
    const h = verified();
    h.messaging.templates = [];
    await executeTool(h.tools, "find_appointments", {}, h.ctx);
    await proposeAndConfirm(h, "send_prep_instructions", {
      appointment_ref: "APPT1",
      language: "en",
    });
    const result = await executeTool(
      h.tools,
      "send_prep_instructions",
      { appointment_ref: "APPT1", language: "en" },
      h.ctx,
    );
    expect(result).toMatchObject({ ok: false, error: { code: ToolErrorCode.NO_TEMPLATE } });
    expect(h.sms.sent).toEqual([]);
  });
});

describe("transfer_to_staff", () => {
  it("marks the call for warm transfer when a staff line exists", async () => {
    const h = makeContext({ transferAvailable: true });
    const result = await executeTool(
      h.tools,
      "transfer_to_staff",
      { reason: "caller_request", summary: "Asked for a person" },
      h.ctx,
    );
    expect(result).toMatchObject({ ok: true, data: { transferring: true } });
    expect(h.session.handoff).toEqual({ reason: "caller_request", summary: "Asked for a person" });
  });

  it("falls back to a callback task without a staff line", async () => {
    const h = makeContext({ transferAvailable: false });
    const result = await executeTool(
      h.tools,
      "transfer_to_staff",
      { reason: "medical_question", summary: "Contrast and kidneys" },
      h.ctx,
    );
    expect(result).toMatchObject({
      ok: true,
      data: { transferring: false, callback_created: true },
    });
    expect(h.session.handoff).toBeNull();
    expect(h.repo.tasks[0]).toMatchObject({
      type: "callback",
      reason: "medical_question: Contrast and kidneys",
    });
  });
});
