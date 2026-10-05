import type { ToolDefinition } from "./types.js";
import { createTask } from "./createTask.js";
import { findAppointments } from "./findAppointments.js";
import { getClinicInfo } from "./getClinicInfo.js";
import { proposeAction } from "./proposeAction.js";
import { verifyIdentity } from "./verifyIdentity.js";

/**
 * Every tool the voice agent can call. Later milestones add search_slots, hold_slot, book_slot,
 * cancel_appointment, record_screening_answer, send_prep_instructions and transfer_to_staff.
 */
export function createToolRegistry(
  tools: readonly ToolDefinition[] = [
    getClinicInfo,
    verifyIdentity,
    findAppointments,
    proposeAction,
    createTask,
  ] as unknown as ToolDefinition[],
): ReadonlyMap<string, ToolDefinition> {
  const registry = new Map<string, ToolDefinition>();
  for (const tool of tools) {
    if (registry.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
    registry.set(tool.name, tool);
  }
  return registry;
}
