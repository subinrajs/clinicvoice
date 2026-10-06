import { describe, expect, it } from "vitest";
import { trimHistory } from "../src/agent/history.js";
import type { ConversationMessage } from "../src/llm/types.js";
import { isClinicalAdvice, SentenceBuffer } from "../src/agent/outputFilter.js";
import { surnamesMatch } from "../src/lib/fuzzyName.js";
import { hashPhone } from "../src/lib/phone.js";
import { speakableDateTime } from "../src/lib/speakable.js";
import { speakableHours } from "../src/tools/getClinicInfo.js";
import { buildConversationRelayTwiml } from "../src/telephony/twiml.js";

describe("speakableDateTime", () => {
  const tz = "America/Toronto";
  it("reads a time the way a person would", () => {
    expect(speakableDateTime(new Date("2026-10-15T18:40:00Z"), tz)).toBe(
      "Thursday, October 15th at 2:40 in the afternoon",
    );
    expect(speakableDateTime(new Date("2026-10-01T13:00:00Z"), tz)).toBe(
      "Thursday, October 1st at 9 in the morning",
    );
    expect(speakableDateTime(new Date("2026-10-22T22:30:00Z"), tz)).toBe(
      "Thursday, October 22nd at 6:30 in the evening",
    );
    expect(speakableDateTime(new Date("2026-10-13T16:00:00Z"), tz)).toBe(
      "Tuesday, October 13th at 12 in the afternoon",
    );
  });
  it("speaks French", () => {
    expect(speakableDateTime(new Date("2026-10-15T18:40:00Z"), tz, "fr")).toBe(
      "jeudi 15 octobre à 14 heures 40",
    );
  });
});

describe("speakableHours", () => {
  it("groups consecutive days", () => {
    const hours = {
      "1": "07:00-21:00",
      "2": "07:00-21:00",
      "3": "07:00-21:00",
      "4": "07:00-21:00",
      "5": "07:00-21:00",
      "6": "08:30-16:00",
      "7": null,
    };
    expect(speakableHours(hours)).toBe(
      "Monday to Friday, 7 AM to 9 PM; Saturday, 8:30 AM to 4 PM; closed Sunday",
    );
  });
});

describe("surnamesMatch", () => {
  it.each([
    ["Santos", "Santos"],
    ["santo's", "Santos"],
    ["Trembley", "Tremblay"],
    ["Gagnón", "Gagnon"],
  ])("%s ~ %s", (a, b) => expect(surnamesMatch(a, b)).toBe(true));
  it.each([
    ["Smith", "Santos"],
    ["", "Roy"],
    ["Ray", "Roy-Tremblay"],
  ])("%s !~ %s", (a, b) => expect(surnamesMatch(a, b)).toBe(false));
});

describe("output filter", () => {
  it.each([
    "It's safe to have the scan with your implant.",
    "You should take 500 mg before you come in.",
    "You'll be fine to have the MRI.",
    "You are cleared for the MRI.",
    "Vous devriez prendre vos médicaments.",
  ])("blocks %j", (s) => expect(isClinicalAdvice(s)).toBe(true));

  it.each([
    "Your MRI is Thursday at 2:40 in the afternoon.",
    "Parking is free behind the building.",
    "I'll have our technologist review that.",
  ])("allows %j", (s) => expect(isClinicalAdvice(s)).toBe(false));

  it("splits streamed tokens into sentences without breaking decimals", () => {
    const buffer = new SentenceBuffer();
    const out = [
      ...buffer.push("The scan takes 2."),
      ...buffer.push("5 hours. Then "),
      ...buffer.push("you go home! Ok"),
    ];
    expect(out).toEqual(["The scan takes 2.5 hours. ", "Then you go home! "]);
    expect(buffer.flush()).toBe("Ok");
  });
});

describe("trimHistory", () => {
  it("never starts on an orphaned tool result", () => {
    const history: ConversationMessage[] = [
      { role: "user", content: "one" },
      { role: "assistant", content: "", toolCalls: [{ id: "t", name: "x", input: {} }] },
      { role: "tool", toolCallId: "t", content: "{}" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "two" },
      { role: "assistant", content: "fine" },
    ];
    const trimmed = trimHistory(history, 4);
    expect(trimmed[0]).toEqual({ role: "user", content: "two" });
  });
});

describe("hashPhone", () => {
  it("is keyed and stable", () => {
    const key = "k".repeat(32);
    expect(hashPhone("+14165550121", key)).toBe(hashPhone("+14165550121", key));
    expect(hashPhone("+14165550121", key)).not.toBe(hashPhone("+14165550121", "x".repeat(32)));
    expect(hashPhone("+14165550121", key)).not.toContain("0121");
  });
});

describe("TwiML", () => {
  it("connects to the relay with the AI disclosure and both languages", () => {
    const xml = buildConversationRelayTwiml({
      wsUrl: "wss://example.test/ws",
      actionUrl: "https://example.test/voice/relay-ended",
    });
    expect(xml).toContain('url="wss://example.test/ws"');
    expect(xml).toContain("virtual assistant");
    expect(xml).toContain("may be recorded");
    expect(xml).toContain('code="fr-CA"');
    expect(xml).toContain('<Connect action="https://example.test/voice/relay-ended">');
  });
});
