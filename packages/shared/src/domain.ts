import { z } from "zod";

export const Modality = z.enum(["MRI", "CT"]);
export type Modality = z.infer<typeof Modality>;

export const Language = z.enum(["en", "fr"]);
export type Language = z.infer<typeof Language>;

export const SlotStatus = z.enum(["open", "held", "booked"]);
export type SlotStatus = z.infer<typeof SlotStatus>;

export const AppointmentStatus = z.enum(["booked", "cancelled", "completed"]);
export type AppointmentStatus = z.infer<typeof AppointmentStatus>;

export const CreatedVia = z.enum(["voice", "staff", "seed"]);
export type CreatedVia = z.infer<typeof CreatedVia>;

/**
 * "clear" is deliberately settable only by a technologist from the dashboard. The voice agent's
 * tools may only produce AGENT_SETTABLE_SCREENING_STATUSES.
 */
export const ScreeningStatus = z.enum([
  "in_progress",
  "clear",
  "needs_review",
  "conditional",
  "contraindicated",
]);
export type ScreeningStatus = z.infer<typeof ScreeningStatus>;
export const AGENT_SETTABLE_SCREENING_STATUSES = ["in_progress", "needs_review"] as const;

export const ScreeningAnswer = z.enum(["yes", "no", "unsure"]);
export type ScreeningAnswer = z.infer<typeof ScreeningAnswer>;

export const TaskType = z.enum(["callback", "review", "transfer_failed"]);
export type TaskType = z.infer<typeof TaskType>;

export const TaskStatus = z.enum(["open", "in_progress", "done"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const StaffRole = z.enum(["front_desk", "technologist", "admin"]);
export type StaffRole = z.infer<typeof StaffRole>;

/** Display labels for the dashboard; the server derives these from session facts. */
export const ConversationState = z.enum([
  "verify_identity",
  "handle_task",
  "confirm_action",
  "execute_tool",
  "escalate",
]);
export type ConversationState = z.infer<typeof ConversationState>;
