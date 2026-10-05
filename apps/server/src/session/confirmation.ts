import type { Language } from "@clinicvoice/shared";

export type ConfirmationVerdict = "yes" | "no" | "unclear";

const YES: Record<Language, string[]> = {
  en: [
    "yes",
    "yeah",
    "yep",
    "yup",
    "sure",
    "correct",
    "right",
    "ok",
    "okay",
    "please do",
    "go ahead",
    "sounds good",
    "that works",
    "perfect",
    "absolutely",
    "definitely",
    "confirm",
    "book it",
    "do it",
    "that's right",
    "thats right",
  ],
  fr: [
    "oui",
    "ouais",
    "d'accord",
    "daccord",
    "parfait",
    "exactement",
    "correct",
    "allez-y",
    "allez y",
    "c'est bon",
    "cest bon",
    "ça marche",
    "ca marche",
    "bien sûr",
    "bien sur",
    "confirme",
  ],
};

const NO: Record<Language, string[]> = {
  en: [
    "no",
    "nope",
    "nah",
    "not",
    "don't",
    "dont",
    "cancel that",
    "wait",
    "hold on",
    "actually",
    "change",
    "different",
    "wrong",
    "stop",
    "never mind",
    "nevermind",
  ],
  fr: ["non", "pas", "attendez", "attends", "en fait", "changer", "autre", "arrêtez", "arretez"],
};

/** Words that turn a "yes" into a conditional answer ("yes, but can we do later?"). */
const HEDGES: Record<Language, string[]> = {
  en: ["but", "maybe", "if", "unless", "or", "?"],
  fr: ["mais", "peut-être", "peut etre", "si", "sauf", "ou", "?"],
};

const MAX_CONFIRMATION_WORDS = 12;

function normalize(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/([?])/g, " $1 ")
    .replace(/[.,!;:]/g, " ")
    .replace(/\s+/g, " ")
    .trim()} `;
}

function containsPhrase(haystack: string, phrases: string[]): boolean {
  return phrases.some((phrase) => haystack.includes(` ${phrase} `));
}

/**
 * Decides, without the model, whether the caller approved the pending action. Errs toward
 * "unclear": a missed yes costs one re-ask, a false yes books something the caller didn't want.
 * Checks both languages because callers code-switch.
 */
export function classifyConfirmation(utterance: string, language: Language): ConfirmationVerdict {
  const text = normalize(utterance);
  const languages: Language[] = language === "fr" ? ["fr", "en"] : ["en", "fr"];

  const saysNo = languages.some((l) => containsPhrase(text, NO[l]));
  const saysYes = languages.some((l) => containsPhrase(text, YES[l]));
  const hedged = languages.some((l) => containsPhrase(text, HEDGES[l]));
  const wordCount = text.trim().split(" ").filter(Boolean).length;

  if (saysNo && !saysYes) return "no";
  if (saysYes && !saysNo && !hedged && wordCount <= MAX_CONFIRMATION_WORDS) return "yes";
  return "unclear";
}
