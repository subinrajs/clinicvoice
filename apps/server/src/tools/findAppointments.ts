import { examLabel, ToolErrorCode } from "@clinicvoice/shared";
import { z } from "zod";
import { speakableDateTime } from "../lib/speakable.js";
import { registerRef } from "../session/callSession.js";
import { defineTool } from "./defineTool.js";
import { requireVerified } from "./guards.js";
import { fail, ok } from "./types.js";

export const findAppointments = defineTool({
  name: "find_appointments",
  description:
    "List the verified caller's upcoming appointments. Takes no input; it only ever returns the verified patient's own bookings.",
  input: z.object({}),
  guards: [requireVerified],
  async run(_input, ctx) {
    const { session } = ctx;
    const patientId = session.verifiedPatientId as string;
    const appointments = await ctx.repo.listUpcomingAppointments(patientId, ctx.now());

    await Promise.all(
      appointments.map((a) =>
        ctx.audit.write({
          actor: `agent:call:${session.callId}`,
          action: "read",
          entity: "appointment",
          entityId: a.id,
          requestId: ctx.requestId,
        }),
      ),
    );

    if (appointments.length === 0) {
      return fail(ToolErrorCode.NONE_FOUND, "The caller has no upcoming appointments.");
    }
    return ok({
      appointments: appointments.map((a) => ({
        ref: registerRef(session, "APPT", a.id),
        exam: examLabel(a.examCode, session.language),
        modality: a.modality,
        site: a.siteName,
        when: speakableDateTime(a.startsAt, ctx.timeZone, session.language),
      })),
    });
  },
});
