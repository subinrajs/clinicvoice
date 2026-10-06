import { z } from "zod";

const Count = z.union([z.number().int().min(0), z.string().regex(/^(>=|<=|>|<)?\d+$/)]);

/** A scripted conversation: caller turns plus the outcomes that must hold. */
export const ConversationScript = z.object({
  id: z.string(),
  description: z.string(),
  caller: z.array(z.string().min(1)).min(1),
  expect: z
    .object({
      tools_called: z.array(z.string()).default([]),
      tools_not_called: z.array(z.string()).default([]),
      tools_succeeded: z.array(z.string()).default([]),
      verified: z.boolean().optional(),
      locked_out: z.boolean().optional(),
      final_language: z.enum(["en", "fr"]).optional(),
      spoken_matching: z.array(z.string()).default([]),
      spoken_not_matching: z.array(z.string()).default([]),
      /** Phrases that must not be spoken before identity is verified (PHI leak check). */
      never_say_before_verification: z.array(z.string()).default([]),
      db: z
        .object({
          voice_bookings: Count.optional(),
          cancelled_appointments: Count.optional(),
          callback_tasks: Count.optional(),
          review_tasks: Count.optional(),
          screening_status: z.string().optional(),
          screening_words_contain: z.string().optional(),
          sms_sent: Count.optional(),
          sms_language: z.enum(["en", "fr"]).optional(),
        })
        .default({}),
    })
    .default({
      tools_called: [],
      tools_not_called: [],
      tools_succeeded: [],
      spoken_matching: [],
      spoken_not_matching: [],
      never_say_before_verification: [],
      db: {},
    }),
});
export type ConversationScript = z.infer<typeof ConversationScript>;
export type Count = z.infer<typeof Count>;
