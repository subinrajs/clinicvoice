import { z } from "zod";
import { registerRef } from "../session/callSession.js";
import { defineTool } from "./defineTool.js";
import { ok } from "./types.js";

/** Always allowed: any boundary (medical question, failed identity) degrades into staff work. */
export const createTask = defineTool({
  name: "create_task",
  description:
    "Create a follow-up task for clinic staff. Use 'callback' when the caller needs a person (medical or contrast questions, failed identity, anything you cannot do). Use 'review' for screening concerns.",
  input: z.object({
    type: z.enum(["callback", "review"]),
    reason: z
      .string()
      .trim()
      .min(3)
      .max(500)
      .describe("Short, factual reason for staff. No advice."),
  }),
  guards: [],
  async run(input, ctx) {
    const { session } = ctx;
    const task = await ctx.repo.createTask({
      type: input.type,
      callId: session.callId,
      patientId: session.verifiedPatientId,
      reason: input.reason,
      assignedRole: input.type === "review" ? "technologist" : "front_desk",
    });
    await ctx.audit.write({
      actor: `agent:call:${session.callId}`,
      action: "create",
      entity: "task",
      entityId: task.id,
      requestId: ctx.requestId,
    });
    return ok({ task_ref: registerRef(session, "T", task.id), created: true });
  },
});
