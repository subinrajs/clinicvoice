function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** AI and recording disclosure, spoken before anything else on every call. */
export const WELCOME_GREETING =
  "Thanks for calling Lakeshore MRI and CT, this is the virtual assistant. This call may be recorded. " +
  "Pour le service en français, dites français. How can I help you today?";

const xml = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n${body}\n</Response>`;

/**
 * Connects the call to ConversationRelay. When the session ends (hand-off or hang-up), Twilio
 * posts to `actionUrl`, which decides whether to dial staff.
 */
export function buildConversationRelayTwiml(options: {
  wsUrl: string;
  actionUrl: string;
  greeting?: string;
}): string {
  const greeting = xmlEscape(options.greeting ?? WELCOME_GREETING);
  return xml(`  <Connect action="${xmlEscape(options.actionUrl)}">
    <ConversationRelay url="${xmlEscape(options.wsUrl)}" welcomeGreeting="${greeting}" language="en-US" interruptible="any" dtmfDetection="true">
      <Language code="en-US" ttsProvider="ElevenLabs" transcriptionProvider="Deepgram" />
      <Language code="fr-CA" ttsProvider="ElevenLabs" transcriptionProvider="Deepgram" />
    </ConversationRelay>
  </Connect>`);
}

/** Warm transfer to the staff line; the dial outcome is posted to `statusUrl`. */
export function buildDialStaffTwiml(options: {
  staffNumber: string;
  statusUrl: string;
  language: "en" | "fr";
}): string {
  const line =
    options.language === "fr"
      ? "Je vous transfère à notre équipe."
      : "Connecting you to our team now.";
  const say =
    options.language === "fr" ? `<Say language="fr-CA">${line}</Say>` : `<Say>${line}</Say>`;
  return xml(`  ${say}
  <Dial timeout="25" action="${xmlEscape(options.statusUrl)}">${xmlEscape(options.staffNumber)}</Dial>`);
}

export function buildSayAndHangupTwiml(message: string, language: "en" | "fr" = "en"): string {
  const attr = language === "fr" ? ' language="fr-CA"' : "";
  return xml(`  <Say${attr}>${xmlEscape(message)}</Say>\n  <Hangup/>`);
}

export const buildHangupTwiml = () => xml("  <Hangup/>");
