import type { FastifyPluginAsync, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import type { ClinicRepository } from "../repositories/clinicRepository.js";
import type { RelayDeps } from "../telephony/conversationRelay.js";
import { handleRelayConnection } from "../telephony/conversationRelay.js";
import {
  buildConversationRelayTwiml,
  buildDialStaffTwiml,
  buildHangupTwiml,
  buildSayAndHangupTwiml,
} from "../telephony/twiml.js";

export interface VoiceRouteOptions {
  publicBaseUrl: string;
  verifyTwilio: preHandlerAsyncHookHandler;
  relay: RelayDeps;
  staffTransferNumber: string;
  clinic: Pick<ClinicRepository, "createTask">;
}

const Handoff = z.object({
  callId: z.uuid(),
  reason: z.string(),
  summary: z.string(),
});

const TRANSFER_FAILED_LINE =
  "Sorry, no one is available right now. A team member will call you back shortly. Goodbye.";

export const voiceRoutes =
  (options: VoiceRouteOptions): FastifyPluginAsync =>
  async (app) => {
    const base = options.publicBaseUrl.replace(/\/$/, "");
    const wsUrl = `${base.replace(/^http/, "ws")}/ws`;
    const rateLimit = { rateLimit: { max: 20, timeWindow: "1 minute" } };

    /** Twilio "a call comes in" webhook: hands the call to ConversationRelay. */
    app.post(
      "/voice",
      { preHandler: options.verifyTwilio, config: rateLimit },
      async (_req, reply) => {
        return reply
          .type("text/xml")
          .send(buildConversationRelayTwiml({ wsUrl, actionUrl: `${base}/voice/relay-ended` }));
      },
    );

    /** ConversationRelay session ended. With handoff data, warm-transfer to staff; else hang up. */
    app.post<{ Body: Record<string, string> }>(
      "/voice/relay-ended",
      { preHandler: options.verifyTwilio },
      async (req, reply) => {
        reply.type("text/xml");
        const raw = req.body?.HandoffData;
        if (!raw) return reply.send(buildHangupTwiml());
        let handoff: z.infer<typeof Handoff>;
        try {
          handoff = Handoff.parse(JSON.parse(raw));
        } catch {
          req.log.warn("relay ended with malformed handoff data");
          return reply.send(buildHangupTwiml());
        }
        const statusUrl = `${base}/voice/transfer-status?callId=${encodeURIComponent(handoff.callId)}`;
        if (!options.staffTransferNumber) {
          await options.clinic.createTask({
            type: "transfer_failed",
            callId: handoff.callId,
            patientId: null,
            reason: `${handoff.reason}: ${handoff.summary}`,
            assignedRole: "front_desk",
          });
          return reply.send(buildSayAndHangupTwiml(TRANSFER_FAILED_LINE));
        }
        return reply.send(
          buildDialStaffTwiml({
            staffNumber: options.staffTransferNumber,
            statusUrl,
            language: "en",
          }),
        );
      },
    );

    /** Outcome of the staff dial. Anything but an answered call becomes a callback task. */
    app.post<{ Body: Record<string, string>; Querystring: { callId?: string } }>(
      "/voice/transfer-status",
      { preHandler: options.verifyTwilio },
      async (req, reply) => {
        reply.type("text/xml");
        const status = req.body?.DialCallStatus;
        const callId = z.uuid().safeParse(req.query.callId);
        if (status === "completed" || !callId.success) return reply.send(buildHangupTwiml());
        await options.clinic.createTask({
          type: "transfer_failed",
          callId: callId.data,
          patientId: null,
          reason: `Warm transfer not answered (${status ?? "unknown"})`,
          assignedRole: "front_desk",
        });
        return reply.send(buildSayAndHangupTwiml(TRANSFER_FAILED_LINE));
      },
    );

    app.get("/ws", { websocket: true, preHandler: options.verifyTwilio }, (socket) => {
      handleRelayConnection(socket, options.relay);
    });
  };
