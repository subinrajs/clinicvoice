import type { z } from "zod";
import type { ToolDefinition } from "./types.js";

/** Identity helper that preserves the input schema's inferred type through to `run`. */
export function defineTool<S extends z.ZodObject, O>(
  definition: ToolDefinition<S, O>,
): ToolDefinition<S, O> {
  return definition;
}
