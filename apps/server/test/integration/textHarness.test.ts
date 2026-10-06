/** The text harness end to end against Postgres, with a scripted model instead of OpenAI. */
import { createDb, migrate, type Db } from "@clinicvoice/db";
import { seed } from "@clinicvoice/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TextCall } from "../../src/harness/textCall.js";
import { fakeChatModel, silentLogger } from "../helpers.js";

const appUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.TEST_DATABASE_MIGRATION_URL;

describe.skipIf(!appUrl || !ownerUrl)("text harness integration", () => {
  let db: Db;
  let owner: Db;

  beforeAll(async () => {
    await migrate(ownerUrl!);
    owner = createDb({ connectionString: ownerUrl!, maxConnections: 2 });
    await seed(owner);
    db = createDb({ connectionString: appUrl!, maxConnections: 5 });
  });

  afterAll(async () => {
    await db?.destroy();
    await owner?.destroy();
  });

  it("verifies, cancels after a spoken yes, and observes the database", async () => {
    const { model } = fakeChatModel([
      {
        text: "One moment. ",
        tools: [
          {
            name: "verify_identity",
            input: { last_name: "Santos", dob: "1984-03-12", phone_last4: "0121" },
          },
        ],
      },
      { text: "Thanks Maria. ", tools: [{ name: "find_appointments", input: {} }] },
      {
        text: "",
        tools: [
          {
            name: "propose_action",
            input: {
              tool: "cancel_appointment",
              args: { appointment_ref: "APPT1", reason: "scheduling_conflict" },
            },
          },
        ],
      },
      { text: "I'll cancel your MRI. Is that right?" },
      {
        text: "",
        tools: [
          {
            name: "cancel_appointment",
            input: { appointment_ref: "APPT1", reason: "scheduling_conflict" },
          },
        ],
      },
      { text: "Done, it's cancelled." },
    ]);
    const call = new TextCall({
      db,
      model,
      systemPrompt: "P",
      logger: silentLogger,
      timeZone: "America/Toronto",
    });
    await call.start();
    await call.say("Santos, March 12 1984, 0121, I want to cancel my MRI");
    await call.say("Yes");
    const run = await call.finish();

    expect(run.verified).toBe(true);
    expect(run.tools.map((t) => [t.name, t.ok])).toEqual([
      ["verify_identity", true],
      ["find_appointments", true],
      ["propose_action", true],
      ["cancel_appointment", true],
    ]);
    expect(run.tools[0]!.verifiedAtCall).toBe(false);
    expect(run.db.cancelledAppointments).toBe(1);
    const turns = await db
      .selectFrom("call_turns")
      .select("role")
      .where("call_id", "=", call.callId)
      .execute();
    expect(turns.length).toBeGreaterThan(4);
  });
});
