import type { Language } from "@clinicvoice/shared";

/**
 * Formats an instant the way a receptionist would say it, in the clinic's time zone:
 * "Thursday, October 15th at 2:40 in the afternoon". Never returns raw timestamps.
 */
export function speakableDateTime(
  instant: Date,
  timeZone: string,
  language: Language = "en",
): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  const hour24 = Number(get("hour"));
  const minute = get("minute");

  if (language === "fr") {
    const fr = new Intl.DateTimeFormat("fr-CA", {
      timeZone,
      weekday: "long",
      month: "long",
      day: "numeric",
    }).format(instant);
    const time = minute === "00" ? `${hour24} heures` : `${hour24} heures ${Number(minute)}`;
    return `${fr} à ${time}`;
  }

  const day = Number(get("day"));
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const clock = minute === "00" ? `${hour12}` : `${hour12}:${minute}`;
  return `${get("weekday")}, ${get("month")} ${ordinal(day)} at ${clock} ${periodOfDay(hour24)}`;
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

function periodOfDay(hour24: number): string {
  if (hour24 < 12) return "in the morning";
  if (hour24 < 17) return "in the afternoon";
  return "in the evening";
}
