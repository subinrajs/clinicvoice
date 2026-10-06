import twilio from "twilio";
import type { Logger } from "../lib/logger.js";

export interface SmsSender {
  send(to: string, body: string): Promise<{ providerSid: string; status: string }>;
}

export class TwilioSmsSender implements SmsSender {
  private readonly client: ReturnType<typeof twilio>;

  constructor(
    accountSid: string,
    authToken: string,
    private readonly from: string,
  ) {
    this.client = twilio(accountSid, authToken);
  }

  async send(to: string, body: string) {
    const message = await this.client.messages.create({ to, from: this.from, body });
    return { providerSid: message.sid, status: message.status };
  }
}

/**
 * Development/test sender: records messages instead of sending them. Logs only the template
 * length, never the number or body.
 */
export class RecordingSmsSender implements SmsSender {
  readonly sent: { to: string; body: string }[] = [];

  constructor(private readonly logger?: Logger) {}

  async send(to: string, body: string) {
    this.sent.push({ to, body });
    this.logger?.info({ length: body.length }, "sms recorded (not sent)");
    return { providerSid: `local-${this.sent.length}`, status: "recorded" };
  }
}
