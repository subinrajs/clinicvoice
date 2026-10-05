import type { Language } from "@clinicvoice/shared";

/**
 * Last line of defence before text is spoken. Runs per sentence so streaming still works:
 * tokens are buffered to a sentence boundary, checked, then released to text-to-speech.
 */
const CLINICAL_ADVICE_PATTERNS: RegExp[] = [
  /\bsafe (for you )?to\b/i,
  /\b(you('| a)re|you will be|you'll be) (fine|safe|cleared|ok(ay)?) (for|to have)\b/i,
  /\bcleared for (the |your )?mri\b/i,
  /\byou should (take|stop|start|skip|avoid taking)\b/i,
  /\b\d+\s?(mg|milligrams?|ml|millilit(er|re)s?)\b/i,
  /\b(dosage|dose of)\b/i,
  /\b(sans danger|sans risque) pour vous\b/i,
  /\bvous (devez|devriez) (prendre|arrêter|arreter)\b/i,
];

export const ESCALATION_LINE: Record<Language, string> = {
  en: "I'm not able to advise on that, but I can have a member of our clinical team call you back.",
  fr: "Je ne peux pas vous conseiller à ce sujet, mais un membre de notre équipe clinique peut vous rappeler.",
};

export function isClinicalAdvice(sentence: string): boolean {
  return CLINICAL_ADVICE_PATTERNS.some((pattern) => pattern.test(sentence));
}

/** Accumulates streamed tokens and yields complete sentences. */
export class SentenceBuffer {
  private buffer = "";

  push(token: string): string[] {
    this.buffer += token;
    const sentences: string[] = [];
    // A boundary is ., ! or ? followed by whitespace; avoids splitting "2.5" or "Dr.Smith".
    const boundary = /[.!?]["')\]]?\s+/g;
    let consumed = 0;
    for (const match of this.buffer.matchAll(boundary)) {
      const end = (match.index ?? 0) + match[0].length;
      sentences.push(this.buffer.slice(consumed, end));
      consumed = end;
    }
    this.buffer = this.buffer.slice(consumed);
    return sentences;
  }

  flush(): string {
    const rest = this.buffer;
    this.buffer = "";
    return rest;
  }
}
