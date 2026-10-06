import type OpenAI from "openai";
import { z } from "zod";

export interface StructuredResult<T> {
  value: T;
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
}

/** Offline model calls that must return JSON matching a schema (summaries, extraction, grading). */
export interface StructuredModel {
  readonly model: string;
  generate<S extends z.ZodType>(request: {
    name: string;
    system: string;
    input: string;
    schema: S;
  }): Promise<StructuredResult<z.infer<S>>>;
}

/**
 * OpenAI structured outputs (json_schema, strict). Schemas must be strict-compatible: every
 * property required (use .nullable() for optional) and no additional properties.
 */
export class OpenAIStructuredModel implements StructuredModel {
  constructor(
    private readonly client: Pick<OpenAI, "chat">,
    readonly model: string,
  ) {}

  async generate<S extends z.ZodType>(request: {
    name: string;
    system: string;
    input: string;
    schema: S;
  }) {
    const { $schema: _schemaUri, ...schema } = z.toJSONSchema(request.schema) as Record<
      string,
      unknown
    >;
    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.input },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: request.name, schema, strict: true },
      },
    });
    const choice = completion.choices[0];
    if (choice?.message.refusal) throw new Error(`Model refused ${request.name}`);
    const content = choice?.message.content;
    if (!content) throw new Error(`Empty ${request.name} response`);
    return {
      // Re-validate: strict mode constrains shape, Zod also enforces value rules (enums, lengths).
      value: request.schema.parse(JSON.parse(content)) as z.infer<S>,
      usage: {
        inputTokens: completion.usage?.prompt_tokens ?? 0,
        cachedInputTokens: completion.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        outputTokens: completion.usage?.completion_tokens ?? 0,
      },
    };
  }
}
