import type { ToolDefinition } from "./types.js";
import { createTask } from "./createTask.js";
import { findAppointments } from "./findAppointments.js";
import { getClinicInfo } from "./getClinicInfo.js";
import { proposeAction } from "./proposeAction.js";
import { verifyIdentity } from "./verifyIdentity.js";
import { bookSlot, cancelAppointment, holdSlot, searchSlots } from "./scheduling.js";
import { recordScreeningAnswer } from "./screening.js";
import { sendPrepInstructions } from "./sendPrepInstructions.js";
import { transferToStaff } from "./transferToStaff.js";

/** Every tool the voice agent can call, in a fixed order so the provider-side prompt cache holds. */
export const ALL_TOOLS = [
  getClinicInfo,
  verifyIdentity,
  findAppointments,
  searchSlots,
  holdSlot,
  proposeAction,
  bookSlot,
  cancelAppointment,
  recordScreeningAnswer,
  sendPrepInstructions,
  createTask,
  transferToStaff,
] as unknown as readonly ToolDefinition[];

export function createToolRegistry(
  tools: readonly ToolDefinition[] = ALL_TOOLS,
): ReadonlyMap<string, ToolDefinition> {
  const registry = new Map<string, ToolDefinition>();
  for (const tool of tools) {
    if (registry.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
    registry.set(tool.name, tool);
  }
  return registry;
}
