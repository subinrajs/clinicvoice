import { zonedWallTimeToUtc } from "@clinicvoice/db";
import { examLabel, Modality, ToolErrorCode } from "@clinicvoice/shared";
import { z } from "zod";
import { speakableDateTime } from "../lib/speakable.js";
import { registerRef, resolveRef } from "../session/callSession.js";
import { defineTool } from "./defineTool.js";
import { requireConfirmed, requireVerified } from "./guards.js";
import { agentActor, resolveAppointment } from "./shared.js";
import { fail, ok, type ToolContext } from "./types.js";

const SEARCH_DAYS = 14;
const PART_OF_DAY = { morning: [0, 12], afternoon: [12, 17], evening: [17, 24] } as const;

function localHour(instant: Date, timeZone: string): number {
  return Number(
    new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(
      instant,
    ),
  );
}

export const searchSlots = defineTool({
  name: "search_slots",
  description:
    "Find up to 5 open appointment times for the verified caller's ordered scan. Optionally narrow by site, date range and part of day. Say a short filler like 'Let me check the schedule' first.",
  input: z.object({
    modality: Modality,
    site_code: z.enum(["MISS", "TOR", "OAK"]).optional(),
    earliest: z.iso.date().optional().describe("YYYY-MM-DD"),
    latest: z.iso.date().optional().describe("YYYY-MM-DD"),
    part_of_day: z.enum(["morning", "afternoon", "evening"]).optional(),
  }),
  guards: [requireVerified],
  async run(input, ctx) {
    const patientId = ctx.session.verifiedPatientId as string;
    // The scan must match a physician's order: callers can't book a CT on an MRI requisition.
    const requisition = await ctx.scheduling.findRequisition(patientId, input.modality);
    if (!requisition) {
      return fail(
        ToolErrorCode.NO_AVAILABILITY,
        `The caller has no ${input.modality} order on file. Offer a staff callback.`,
      );
    }

    const now = ctx.now();
    const localDate = (isoDate: string, hour: number, minute: number) => {
      const [year, month, day] = isoDate.split("-").map(Number) as [number, number, number];
      return zonedWallTimeToUtc({ year, month, day, hour, minute }, ctx.timeZone);
    };
    // Never offer anything starting within the next hour.
    const soonest = now.getTime() + 60 * 60_000;
    const from = new Date(
      Math.max(soonest, input.earliest ? localDate(input.earliest, 0, 0).getTime() : 0),
    );
    const to = input.latest
      ? localDate(input.latest, 23, 59)
      : new Date(now.getTime() + SEARCH_DAYS * 864e5);
    const candidates = await ctx.scheduling.searchSlots({
      modality: input.modality,
      from,
      to,
      limit: 20,
      ...(input.site_code ? { siteCode: input.site_code } : {}),
    });
    const window = input.part_of_day ? PART_OF_DAY[input.part_of_day] : null;
    const slots = candidates
      .filter(
        (s) =>
          !window ||
          (localHour(s.startsAt, ctx.timeZone) >= window[0] &&
            localHour(s.startsAt, ctx.timeZone) < window[1]),
      )
      .slice(0, 5);
    if (slots.length === 0)
      return fail(
        ToolErrorCode.NO_AVAILABILITY,
        "No open times match. Offer a different site, day or part of day.",
      );

    return ok({
      exam: examLabel(requisition.examCode, ctx.session.language),
      slots: slots.map((s) => ({
        ref: registerRef(ctx.session, "S", s.id),
        site: s.siteName,
        when: speakableDateTime(s.startsAt, ctx.timeZone, ctx.session.language),
      })),
    });
  },
});

export const holdSlot = defineTool({
  name: "hold_slot",
  description:
    "Hold a slot from search_slots for a few minutes while the caller confirms. Holding a new slot releases the previous hold.",
  input: z.object({ slot_ref: z.string() }),
  guards: [requireVerified],
  async run(input, ctx) {
    const { session } = ctx;
    const slotId = resolveRef(session, input.slot_ref);
    if (!slotId || !input.slot_ref.toUpperCase().startsWith("S")) {
      return fail(
        ToolErrorCode.UNKNOWN_REF,
        "Unknown slot ref. Use a ref returned by search_slots.",
      );
    }
    if (session.heldSlotId && session.heldSlotId !== slotId) {
      await ctx.scheduling.releaseHold(session.heldSlotId, session.callId);
      session.heldSlotId = null;
    }
    const result = await ctx.scheduling.holdSlot(slotId, session.callId);
    if (!result.ok)
      return fail(
        ToolErrorCode.SLOT_TAKEN,
        "That time was just taken. Offer another from the search results.",
      );
    session.heldSlotId = slotId;
    await ctx.audit.write({
      actor: agentActor(ctx),
      action: "hold",
      entity: "slot",
      entityId: slotId,
      requestId: ctx.requestId,
    });
    const minutes = Math.max(
      1,
      Math.round((result.value.heldUntil.getTime() - ctx.now().getTime()) / 60_000),
    );
    return ok({
      held: true,
      held_for_minutes: minutes,
      next: "Use propose_action with book_slot to confirm with the caller.",
    });
  },
});

const BookInput = z.object({
  slot_ref: z.string(),
  appointment_ref: z
    .string()
    .optional()
    .describe("Only when rescheduling: the existing appointment being replaced"),
});

async function describeBooking(
  input: z.infer<typeof BookInput>,
  ctx: ToolContext,
): Promise<string> {
  const slotId = resolveRef(ctx.session, input.slot_ref);
  const slot = slotId ? await ctx.scheduling.getSlot(slotId) : undefined;
  if (!slot) throw new Error("describe called with an unknown slot ref");
  const when = speakableDateTime(slot.startsAt, ctx.timeZone, ctx.session.language);
  const fr = ctx.session.language === "fr";
  if (input.appointment_ref) {
    const current = await resolveAppointment(ctx, input.appointment_ref);
    if (current.ok) {
      const before = speakableDateTime(
        current.appointment.startsAt,
        ctx.timeZone,
        ctx.session.language,
      );
      const exam = examLabel(current.appointment.examCode, ctx.session.language);
      return fr
        ? `Je déplace votre ${exam} du ${before} au ${when}, à ${slot.siteName}. C'est bien ça?`
        : `I'll move your ${exam} from ${before} to ${when} at ${slot.siteName}. Is that right?`;
    }
  }
  return fr
    ? `Je réserve le ${when}, à ${slot.siteName}. C'est bien ça?`
    : `I'll book ${when} at ${slot.siteName}. Is that right?`;
}

export const bookSlot = defineTool({
  name: "book_slot",
  description:
    "Book the held slot. Only after propose_action and the system confirming the caller said yes.",
  input: BookInput,
  guards: [requireVerified, requireConfirmed("book_slot")],
  describe: describeBooking,
  async run(input, ctx) {
    const { session } = ctx;
    const patientId = session.verifiedPatientId as string;
    const slotId = resolveRef(session, input.slot_ref);
    const slot = slotId ? await ctx.scheduling.getSlot(slotId) : undefined;
    if (!slot) return fail(ToolErrorCode.UNKNOWN_REF, "Unknown slot ref.");
    const modality = Modality.parse(slot.modality);

    let replaces: { id: string; requisitionId: string | null } | undefined;
    if (input.appointment_ref) {
      const current = await resolveAppointment(ctx, input.appointment_ref);
      if (!current.ok) return current.result;
      if (current.appointment.modality !== modality) {
        return fail(
          ToolErrorCode.INVALID_INPUT,
          "The new slot is a different kind of scan than the appointment being moved.",
        );
      }
      replaces = { id: current.appointment.id, requisitionId: current.appointment.requisitionId };
    }
    const requisition = await ctx.scheduling.findRequisition(patientId, modality);
    if (!requisition)
      return fail(
        ToolErrorCode.NO_AVAILABILITY,
        `No ${modality} order on file. Offer a staff callback.`,
      );

    const result = await ctx.scheduling.bookSlot({
      slotId: slot.id,
      patientId,
      examCode: requisition.examCode,
      contrast: requisition.contrast,
      requisitionId: replaces?.requisitionId ?? requisition.id,
      heldByCall: session.callId,
      createdVia: "voice",
      ...(replaces ? { replacesAppointmentId: replaces.id } : {}),
    });
    if (!result.ok) {
      session.heldSlotId = null;
      return result.reason === "SLOT_TAKEN"
        ? fail(ToolErrorCode.SLOT_TAKEN, "That time was taken. Search again.")
        : fail(ToolErrorCode.HOLD_EXPIRED, "The hold expired. Hold the slot again and re-confirm.");
    }
    session.heldSlotId = null;
    await ctx.audit.write({
      actor: agentActor(ctx),
      action: "book",
      entity: "appointment",
      entityId: result.value.appointmentId,
      requestId: ctx.requestId,
    });
    if (replaces) {
      await ctx.audit.write({
        actor: agentActor(ctx),
        action: "cancel",
        entity: "appointment",
        entityId: replaces.id,
        requestId: ctx.requestId,
      });
    }
    return ok({
      booked: true,
      appointment_ref: registerRef(session, "APPT", result.value.appointmentId),
      exam: examLabel(requisition.examCode, session.language),
      site: slot.siteName,
      when: speakableDateTime(result.value.startsAt, ctx.timeZone, session.language),
      next: "Offer to text the preparation instructions.",
    });
  },
});

const CancelInput = z.object({
  appointment_ref: z.string(),
  reason: z.enum([
    "caller_request",
    "feeling_unwell",
    "scheduling_conflict",
    "booked_elsewhere",
    "other",
  ]),
});

export const cancelAppointment = defineTool({
  name: "cancel_appointment",
  description:
    "Cancel one of the verified caller's appointments. Only after propose_action and the system confirming the caller said yes.",
  input: CancelInput,
  guards: [requireVerified, requireConfirmed("cancel_appointment")],
  async describe(input, ctx) {
    const current = await resolveAppointment(ctx, input.appointment_ref);
    if (!current.ok) throw new Error("describe called with an unknown appointment ref");
    const exam = examLabel(current.appointment.examCode, ctx.session.language);
    const when = speakableDateTime(
      current.appointment.startsAt,
      ctx.timeZone,
      ctx.session.language,
    );
    return ctx.session.language === "fr"
      ? `J'annule votre ${exam} du ${when}. C'est bien ça?`
      : `I'll cancel your ${exam} on ${when}. Is that right?`;
  },
  async run(input, ctx) {
    const current = await resolveAppointment(ctx, input.appointment_ref);
    if (!current.ok) return current.result;
    const result = await ctx.scheduling.cancelAppointment(
      current.appointment.id,
      ctx.session.verifiedPatientId as string,
      input.reason,
    );
    if (!result.ok)
      return fail(
        ToolErrorCode.UNKNOWN_REF,
        "That appointment can no longer be cancelled. Offer a staff callback.",
      );
    await ctx.audit.write({
      actor: agentActor(ctx),
      action: "cancel",
      entity: "appointment",
      entityId: current.appointment.id,
      requestId: ctx.requestId,
    });
    return ok({ cancelled: true });
  },
});
