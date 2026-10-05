import { ToolErrorCode } from "@clinicvoice/shared";
import { CONFIRMED_WRITE_TOOLS, isToolAllowed } from "../session/state.js";
import type { ToolContext, ToolDefinition, ToolResult } from "./types.js";

/**
 * The single path every model-issued tool call takes:
 * state allows tool -> schema validation -> tool guards -> handler -> pending-action cleanup.
 * Handlers never throw to the model; unexpected errors become INTERNAL with no detail leaked.
 */
export async function executeTool(
  registry: ReadonlyMap<string, ToolDefinition>,
  name: string,
  rawInput: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = registry.get(name);
  if (!tool || !isToolAllowed(ctx.session, name)) {
    return {
      ok: false,
      error: {
        code: ToolErrorCode.TOOL_NOT_ALLOWED_IN_STATE,
        message: `The tool ${name} is not available right now. Follow the current state instructions.`,
      },
    };
  }

  const parsed = tool.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: ToolErrorCode.INVALID_INPUT,
        message: parsed.error.issues
          .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
          .join("; "),
      },
    };
  }

  for (const guard of tool.guards) {
    const error = guard(ctx, parsed.data, name);
    if (error) {
      ctx.logger.info({ tool: name, code: error.code }, "tool call blocked by guard");
      return { ok: false, error };
    }
  }

  try {
    const result = await tool.run(parsed.data, ctx);
    // A confirmation authorizes exactly one write; consume it whatever the outcome.
    if ((CONFIRMED_WRITE_TOOLS as readonly string[]).includes(name)) {
      ctx.session.pendingAction = null;
    }
    return result;
  } catch (error) {
    ctx.logger.error({ err: error, tool: name }, "tool handler failed");
    return {
      ok: false,
      error: {
        code: ToolErrorCode.INTERNAL,
        message: "That didn't work. Offer to have staff call back.",
      },
    };
  }
}
