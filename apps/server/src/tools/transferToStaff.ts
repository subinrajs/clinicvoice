import { z } from "zod";
import { registerRef } from "../session/callSession.js";
import { defineTool } from "./defineTool.js";
import { agentActor } from "./shared.js";
import { ok } from "./types.js";

/**
 * Always allowed. With a staff line configured, marks the call for warm transfer: the relay hands
 * the call over after the current reply is spoken. Otherwise falls back to a callback task.
 */
export const transferToStaff = defineTool({
  name: "transfer_to_staff",
  description:
    "Hand the caller to a person: when they ask for one, after a medical question, or when you cannot help. Say one short sentence first, such as 'I'll connect you with our team now.'",
  input: z.object({
    reason: z.enum([
      "caller_request",
      "medical_question",
      "identity_failed",
      "screening_concern",
      "agent_unable",
    ]),
    summary: z
      .string()
      .trim()
      .min(3)
      .max(300)
      .describe("One factual sentence for staff. No advice."),
  }),
  guards: [],
  async run(input, ctx) {
    const { session } = ctx;
    if (ctx.transferAvailable) {
      session.handoff = { reason: input.reason, summary: input.summary };
      session.escalated = true;
      await ctx.audit.write({
        actor: agentActor(ctx),
        action: "transfer",
        entity: "call",
        entityId: session.callId,
        requestId: ctx.requestId,
      });
      return ok({
        transferring: true,
        next: "Say one short sentence that you are connecting them now. Ask nothing else.",
      });
    }
    const task = await ctx.repo.createTask({
      type: "callback",
      callId: session.callId,
      patientId: session.verifiedPatientId,
      reason: `${input.reason}: ${input.summary}`,
      assignedRole: input.reason === "screening_concern" ? "technologist" : "front_desk",
    });
    await ctx.audit.write({
      actor: agentActor(ctx),
      action: "create",
      entity: "task",
      entityId: task.id,
      requestId: ctx.requestId,
    });
    return ok({
      transferring: false,
      callback_created: true,
      task_ref: registerRef(session, "T", task.id),
      next: "Tell the caller no one is free right now and a team member will call them back.",
    });
  },
});
