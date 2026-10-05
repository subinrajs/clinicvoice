import { ToolErrorCode } from "@clinicvoice/shared";
import { z } from "zod";
import { surnamesMatch } from "../lib/fuzzyName.js";
import { defineTool } from "./defineTool.js";
import { fail, ok } from "./types.js";

export const MAX_ATTEMPTS_PER_CALL = 3;
/** Across calls: stops "hang up and redial" from resetting the lockout. */
export const MAX_FAILURES_PER_WINDOW = 5;
export const FAILURE_WINDOW_MS = 15 * 60 * 1000;

export const verifyIdentity = defineTool({
  name: "verify_identity",
  description:
    "Verify the caller is the patient using last name, date of birth and the last 4 digits of their phone number. Must succeed before any patient information is discussed.",
  input: z.object({
    last_name: z.string().trim().min(1).max(80),
    dob: z.iso.date().describe("Date of birth as YYYY-MM-DD"),
    phone_last4: z.string().regex(/^\d{4}$/, "four digits"),
  }),
  guards: [],
  async run(input, ctx) {
    const { session } = ctx;
    if (session.lockedOut) {
      return fail(
        ToolErrorCode.LOCKED,
        "Identity checks are locked for this call. Offer a staff callback.",
      );
    }

    const candidates = await ctx.repo.findIdentityCandidates(input.dob, input.phone_last4);
    const recentFailures = await ctx.repo.countRecentIdentityFailures({
      patientIds: candidates.map((c) => c.id),
      fromHash: session.fromHash,
      since: new Date(ctx.now().getTime() - FAILURE_WINDOW_MS),
    });
    if (recentFailures >= MAX_FAILURES_PER_WINDOW) {
      session.lockedOut = true;
      return fail(ToolErrorCode.LOCKED, "Too many recent failed checks. Offer a staff callback.");
    }

    const matches = candidates.filter((c) => surnamesMatch(input.last_name, c.lastName));
    // Exactly one match or nothing: an ambiguous match is a failure, never a guess.
    const patient = matches.length === 1 ? matches[0] : undefined;

    if (!patient) {
      session.identityAttempts++;
      await ctx.repo.recordIdentityFailure({
        patientId: candidates[0]?.id ?? null,
        fromHash: session.fromHash,
        callId: session.callId,
      });
      if (session.identityAttempts >= MAX_ATTEMPTS_PER_CALL) {
        session.lockedOut = true;
        return fail(
          ToolErrorCode.LOCKED,
          "Third failed attempt. Do not reveal anything. Offer a staff callback.",
        );
      }
      // Never say which field was wrong: that would help someone guess.
      return fail(
        ToolErrorCode.NO_MATCH,
        `Details did not match. Ask the caller to repeat them. Attempts remaining: ${MAX_ATTEMPTS_PER_CALL - session.identityAttempts}.`,
      );
    }

    session.verifiedPatientId = patient.id;
    session.verifiedFirstName = patient.firstName;

    await ctx.repo.markCallVerified(session.callId, patient.id);
    await ctx.audit.write({
      actor: `agent:call:${session.callId}`,
      action: "verify",
      entity: "patient",
      entityId: patient.id,
      requestId: ctx.requestId,
    });
    return ok({ verified: true, first_name: patient.firstName });
  },
});
