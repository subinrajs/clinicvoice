import type { Language } from "@clinicvoice/shared";
import type { ConversationMessage } from "../llm/types.js";

export interface PendingAction {
  /** The write tool the caller is being asked to approve, e.g. "book_slot". */
  tool: string;
  /** The exact arguments the write must be called with. Any difference is NOT_CONFIRMED. */
  args: Record<string, unknown>;
  /** What was read back to the caller. Stored for the audit trail and the dashboard. */
  summary: string;
  /** Set only by the deterministic confirmation classifier, never by the model. */
  confirmed: boolean;
}

/**
 * All per-call state. The session is the only place internal ids live: the model sees opaque
 * short refs (A1001, S3) that the session maps back to database ids.
 */
export interface CallSession {
  readonly callId: string;
  readonly callSid: string;
  readonly fromHash: string | null;
  language: Language;
  history: ConversationMessage[];
  turnSeq: number;

  verifiedPatientId: string | null;
  verifiedFirstName: string | null;
  identityAttempts: number;
  lockedOut: boolean;

  pendingAction: PendingAction | null;
  heldSlotId: string | null;
  escalated: boolean;
  /** Set by transfer_to_staff; the relay hands the call to staff once the current reply is spoken. */
  handoff: { reason: string; summary: string } | null;

  /** Short ref spoken/seen by the model -> internal id. */
  refs: Map<string, string>;
}

export function createCallSession(init: {
  callId: string;
  callSid: string;
  fromHash: string | null;
  language?: Language;
}): CallSession {
  return {
    callId: init.callId,
    callSid: init.callSid,
    fromHash: init.fromHash,
    language: init.language ?? "en",
    history: [],
    turnSeq: 0,
    verifiedPatientId: null,
    verifiedFirstName: null,
    identityAttempts: 0,
    lockedOut: false,
    pendingAction: null,
    heldSlotId: null,
    escalated: false,
    handoff: null,
    refs: new Map(),
  };
}

/** Registers an internal id under a short ref and returns the ref. */
export function registerRef(session: CallSession, prefix: string, internalId: string): string {
  for (const [ref, id] of session.refs) {
    if (id === internalId && ref.startsWith(prefix)) return ref;
  }
  const count = [...session.refs.keys()].filter((r) => r.startsWith(prefix)).length;
  const ref = `${prefix}${count + 1}`;
  session.refs.set(ref, internalId);
  return ref;
}

export function resolveRef(session: CallSession, ref: string): string | undefined {
  return session.refs.get(ref.trim().toUpperCase());
}
