import { ToolErrorCode } from "@clinicvoice/shared";
import type { PatientAppointment } from "../repositories/risRepository.js";
import { resolveRef } from "../session/callSession.js";
import { fail, type ToolContext, type ToolResult } from "./types.js";

export const agentActor = (ctx: ToolContext) => `agent:call:${ctx.session.callId}`;

/** Resolves an appointment ref from this call to the verified patient's own appointment. */
export async function resolveAppointment(
  ctx: ToolContext,
  ref: string,
): Promise<
  { ok: true; appointment: PatientAppointment } | { ok: false; result: ToolResult<never> }
> {
  const id = resolveRef(ctx.session, ref);
  const patientId = ctx.session.verifiedPatientId;
  const appointment =
    id && patientId ? await ctx.scheduling.getPatientAppointment(patientId, id) : undefined;
  if (!appointment || appointment.status !== "booked") {
    return {
      ok: false,
      result: fail(
        ToolErrorCode.UNKNOWN_REF,
        "No matching upcoming appointment. Use find_appointments for valid refs.",
      ),
    };
  }
  return { ok: true, appointment };
}
