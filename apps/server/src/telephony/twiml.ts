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

export function buildConversationRelayTwiml(options: { wsUrl: string; greeting?: string }): string {
  const greeting = xmlEscape(options.greeting ?? WELCOME_GREETING);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay url="${xmlEscape(options.wsUrl)}" welcomeGreeting="${greeting}" language="en-US" interruptible="any" dtmfDetection="true">
      <Language code="en-US" ttsProvider="ElevenLabs" transcriptionProvider="Deepgram" />
      <Language code="fr-CA" ttsProvider="ElevenLabs" transcriptionProvider="Deepgram" />
    </ConversationRelay>
  </Connect>
</Response>`;
}
