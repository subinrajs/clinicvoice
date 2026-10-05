import { ToolErrorCode } from "@clinicvoice/shared";
import { isDeepStrictEqual } from "node:util";
import type { Guard } from "./types.js";

export const requireVerified: Guard = (ctx) =>
  ctx.session.verifiedPatientId
    ? null
    : {
        code: ToolErrorCode.NOT_VERIFIED,
        message: "Verify the caller's identity with verify_identity before using this tool.",
      };

/**
 * The write may run only if the caller confirmed a pending action for this exact tool with these
 * exact arguments. This is what makes "booked something the caller didn't agree to" impossible
 * by construction rather than by prompt.
 */
export function requireConfirmed(toolName: string): Guard<Record<string, unknown>> {
  return (ctx, input) => {
    const pending = ctx.session.pendingAction;
    const matches =
      pending !== null &&
      pending.confirmed &&
      pending.tool === toolName &&
      isDeepStrictEqual(stripUndefined(pending.args), stripUndefined(input));
    return matches
      ? null
      : {
          code: ToolErrorCode.NOT_CONFIRMED,
          message:
            "This action was not confirmed by the caller with these exact details. Use propose_action, read it back, and wait for a clear yes.",
        };
  };
}

function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}
