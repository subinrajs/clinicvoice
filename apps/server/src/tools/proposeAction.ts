import { ToolErrorCode } from "@clinicvoice/shared";
import { z } from "zod";
import { CONFIRMED_WRITE_TOOLS } from "../session/state.js";
import { defineTool } from "./defineTool.js";
import { requireVerified } from "./guards.js";
import { fail, ok } from "./types.js";

/**
 * Moves the call into the confirm state. The read-back sentence is produced by the target tool's
 * describe() from the validated arguments, so the caller approves exactly what will run.
 */
export const proposeAction = defineTool({
  name: "propose_action",
  description:
    "Before any booking, cancellation or SMS, propose it here with the exact arguments. Then read the returned sentence to the caller and wait for their answer. Do not call the write tool until the system says the caller confirmed.",
  input: z.object({
    tool: z.enum(CONFIRMED_WRITE_TOOLS),
    args: z.record(z.string(), z.unknown()),
  }),
  guards: [requireVerified],
  async run(input, ctx) {
    const target = ctx.tools.get(input.tool);
    if (!target?.describe) {
      return fail(ToolErrorCode.TOOL_NOT_ALLOWED_IN_STATE, `${input.tool} is not available yet.`);
    }
    const parsed = target.input.safeParse(input.args);
    if (!parsed.success) {
      return fail(
        ToolErrorCode.INVALID_INPUT,
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      );
    }
    const args = parsed.data as Record<string, unknown>;
    const summary = await target.describe(args, ctx);
    ctx.session.pendingAction = { tool: input.tool, args, summary, confirmed: false };
    return ok({
      read_back: summary,
      next: "Read this back and ask the caller to confirm with yes or no.",
    });
  },
});
