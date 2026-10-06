import type { Tone } from "../components/ui.js";

/** One place mapping domain statuses to badge tones and labels. */
const TONES: Record<string, Tone> = {
  resolved: "success",
  clear: "success",
  done: "success",
  callback_needed: "warning",
  needs_review: "warning",
  conditional: "warning",
  open: "warning",
  held: "warning",
  in_progress: "info",
  transferred: "info",
  booked: "brand",
  identity_failed: "danger",
  contraindicated: "danger",
  abandoned: "neutral",
  unresolved: "danger",
};

export const toneFor = (status: string | null | undefined): Tone =>
  status ? (TONES[status] ?? "neutral") : "neutral";

export const label = (value: string | null | undefined) =>
  value ? value.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "—";

export const latencyTone = (ms: number | null): Tone =>
  ms === null ? "neutral" : ms <= 1200 ? "success" : ms <= 1500 ? "warning" : "danger";
