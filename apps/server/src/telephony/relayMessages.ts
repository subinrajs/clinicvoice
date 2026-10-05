/** Twilio ConversationRelay WebSocket protocol (subset ClinicVoice uses). */

export interface SetupMessage {
  type: "setup";
  sessionId: string;
  callSid: string;
  from?: string;
  to?: string;
  direction?: string;
  customParameters?: Record<string, unknown>;
}

export interface PromptMessage {
  type: "prompt";
  voicePrompt: string;
  lang?: string;
  last: boolean;
}

export interface InterruptMessage {
  type: "interrupt";
  utteranceUntilInterrupt?: string;
  durationUntilInterruptMs?: number;
}

export interface DtmfMessage {
  type: "dtmf";
  digit: string;
}

export interface ErrorMessage {
  type: "error";
  description?: string;
}

export type InboundRelayMessage =
  SetupMessage | PromptMessage | InterruptMessage | DtmfMessage | ErrorMessage;

export type OutboundRelayMessage =
  | { type: "text"; token: string; last: boolean; lang?: string }
  | { type: "language"; ttsLanguage: string; transcriptionLanguage: string }
  | { type: "end"; handoffData?: string };

const INBOUND_TYPES = new Set(["setup", "prompt", "interrupt", "dtmf", "error"]);

export function parseInbound(raw: string): InboundRelayMessage | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === "object" &&
      value !== null &&
      INBOUND_TYPES.has((value as { type?: string }).type ?? "")
    ) {
      return value as InboundRelayMessage;
    }
  } catch {
    // Malformed frames are ignored, never fatal.
  }
  return null;
}

export const RELAY_LANGUAGE_CODES = { en: "en-US", fr: "fr-CA" } as const;
