import { Modality } from "@clinicvoice/shared";
import { timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { RisRepository } from "../repositories/risRepository.js";

const SlotQuery = z.object({
  modality: Modality,
  site: z.string().optional(),
  from: z.coerce.date(),
  to: z.coerce.date(),
  limit: z.coerce.number().int().min(1).max(20).default(5),
});
const HoldBody = z.object({
  slot_id: z.uuid(),
  minutes: z.number().int().min(1).max(15).default(5),
});
const CancelBody = z.object({ patient_id: z.uuid(), reason: z.string().min(1).max(200) });

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Mock RIS HTTP API, standing in for the clinic's radiology information system. The voice tools
 * call RisRepository in-process; this surface exists for the dashboard and integration tests.
 */
export const risRoutes =
  (ris: RisRepository, apiKey: string): FastifyPluginAsync =>
  async (app) => {
    app.addHook("onRequest", async (req, reply) => {
      const key = req.headers["x-ris-api-key"];
      if (typeof key !== "string" || !safeEqual(key, apiKey)) {
        return reply.code(401).send({ error: "unauthorized" });
      }
    });

    app.get("/slots", async (req, reply) => {
      const query = SlotQuery.safeParse(req.query);
      if (!query.success) return reply.code(400).send({ error: query.error.issues });
      const { modality, site, from, to, limit } = query.data;
      return {
        slots: await ris.searchSlots({
          modality,
          from,
          to,
          limit,
          ...(site ? { siteCode: site } : {}),
        }),
      };
    });

    app.post("/holds", async (req, reply) => {
      const body = HoldBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const result = await ris.holdSlot(body.data.slot_id, null, body.data.minutes);
      return result.ok
        ? reply.code(201).send(result.value)
        : reply.code(409).send({ error: result.reason });
    });

    app.post<{ Params: { id: string } }>("/appointments/:id/cancel", async (req, reply) => {
      const id = z.uuid().safeParse(req.params.id);
      const body = CancelBody.safeParse(req.body);
      if (!id.success || !body.success) return reply.code(400).send({ error: "invalid request" });
      const result = await ris.cancelAppointment(id.data, body.data.patient_id, body.data.reason);
      if (result.ok) return result.value;
      return reply.code(result.reason === "NOT_FOUND" ? 404 : 409).send({ error: result.reason });
    });
  };
