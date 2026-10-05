import type { FastifyPluginAsync, preHandlerAsyncHookHandler } from "fastify";
import type { RelayDeps } from "../telephony/conversationRelay.js";
import { handleRelayConnection } from "../telephony/conversationRelay.js";
import { buildConversationRelayTwiml } from "../telephony/twiml.js";

export interface VoiceRouteOptions {
  publicBaseUrl: string;
  verifyTwilio: preHandlerAsyncHookHandler;
  relay: RelayDeps;
}

export const voiceRoutes =
  (options: VoiceRouteOptions): FastifyPluginAsync =>
  async (app) => {
    const wsUrl = `${options.publicBaseUrl.replace(/^http/, "ws").replace(/\/$/, "")}/ws`;

    /** Twilio "a call comes in" webhook: hands the call to ConversationRelay. */
    app.post(
      "/voice",
      {
        preHandler: options.verifyTwilio,
        config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      },
      async (_req, reply) => {
        return reply.type("text/xml").send(buildConversationRelayTwiml({ wsUrl }));
      },
    );

    app.get("/ws", { websocket: true, preHandler: options.verifyTwilio }, (socket) => {
      handleRelayConnection(socket, options.relay);
    });
  };
