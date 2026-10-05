/**
 * Error codes returned to the model as tool results. They are stable identifiers: prompts,
 * tests and the dashboard key off them, so never rename one without a migration plan.
 */
export const ToolErrorCode = {
  TOOL_NOT_ALLOWED_IN_STATE: "TOOL_NOT_ALLOWED_IN_STATE",
  INVALID_INPUT: "INVALID_INPUT",
  NOT_VERIFIED: "NOT_VERIFIED",
  NOT_CONFIRMED: "NOT_CONFIRMED",
  NO_MATCH: "NO_MATCH",
  LOCKED: "LOCKED",
  NONE_FOUND: "NONE_FOUND",
  NO_AVAILABILITY: "NO_AVAILABILITY",
  SLOT_TAKEN: "SLOT_TAKEN",
  HOLD_EXPIRED: "HOLD_EXPIRED",
  UNKNOWN_REF: "UNKNOWN_REF",
  UNKNOWN_QUESTION: "UNKNOWN_QUESTION",
  NO_TEMPLATE: "NO_TEMPLATE",
  RATE_LIMITED: "RATE_LIMITED",
  INTERNAL: "INTERNAL",
} as const;

export type ToolErrorCode = (typeof ToolErrorCode)[keyof typeof ToolErrorCode];
