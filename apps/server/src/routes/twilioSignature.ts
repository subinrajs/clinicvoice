import type { FastifyReply, FastifyRequest } from "fastify";
import twilio from "twilio";

/**
 * Rejects requests not signed by Twilio. The signature covers the full public URL plus, for
 * form posts, the body parameters, so it must be computed against PUBLIC_BASE_URL rather than
 * the internal address the proxy forwards to.
 */
export function twilioSignatureGuard(options: {
  authToken: string;
  publicBaseUrl: string;
  enforce: boolean;
}) {
  const base = options.publicBaseUrl.replace(/\/$/, "");
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!options.enforce) return;
    const signature = req.headers["x-twilio-signature"];
    const isWebSocket = req.headers.upgrade?.toLowerCase() === "websocket";
    const url = `${isWebSocket ? base.replace(/^http/, "ws") : base}${req.url}`;
    const params = (req.body && typeof req.body === "object" ? req.body : {}) as Record<
      string,
      string
    >;
    const valid =
      typeof signature === "string" &&
      twilio.validateRequest(options.authToken, signature, url, params);
    if (!valid) {
      req.log.warn("rejected request with invalid Twilio signature");
      return reply.code(403).send({ error: "invalid signature" });
    }
  };
}
