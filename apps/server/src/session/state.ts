import type { ConversationState } from "@clinicvoice/shared";
import type { CallSession } from "./callSession.js";

/** Tools callable from any state: they touch no patient data or only create staff work. */
export const ALWAYS_ALLOWED_TOOLS = [
  "get_clinic_info",
  "create_task",
  "transfer_to_staff",
] as const;

/** Tools that write and therefore require a confirmed pending action. */
export const CONFIRMED_WRITE_TOOLS = [
  "book_slot",
  "cancel_appointment",
  "send_prep_instructions",
] as const;

const STATE_TOOLS: Record<ConversationState, readonly string[]> = {
  verify_identity: ["verify_identity"],
  handle_task: [
    "find_appointments",
    "search_slots",
    "hold_slot",
    "record_screening_answer",
    "propose_action",
  ],
  confirm_action: [],
  execute_tool: [], // filled from the pending action below
  escalate: [],
};

/**
 * The conversation state is derived from session facts rather than stored, so it cannot drift
 * from what the guards actually check. The label is what the dashboard and per-turn prompt show.
 */
export function deriveState(session: CallSession): ConversationState {
  if (session.lockedOut || session.escalated) return "escalate";
  if (!session.verifiedPatientId) return "verify_identity";
  if (session.pendingAction) {
    return session.pendingAction.confirmed ? "execute_tool" : "confirm_action";
  }
  return "handle_task";
}

export function allowedTools(session: CallSession): string[] {
  const state = deriveState(session);
  const stateTools =
    state === "execute_tool" && session.pendingAction
      ? [session.pendingAction.tool]
      : STATE_TOOLS[state];
  return [...stateTools, ...ALWAYS_ALLOWED_TOOLS];
}

export function isToolAllowed(session: CallSession, toolName: string): boolean {
  return allowedTools(session).includes(toolName);
}
