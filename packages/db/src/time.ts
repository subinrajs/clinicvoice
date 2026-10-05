/**
 * Converts a wall-clock time in an IANA zone to a UTC Date, without a date library.
 * Handles DST by computing the zone offset at the candidate instant.
 */
export function zonedWallTimeToUtc(
  date: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): Date {
  const guess = Date.UTC(date.year, date.month - 1, date.day, date.hour, date.minute);
  const offset = zoneOffsetMs(new Date(guess), timeZone);
  const candidate = guess - offset;
  // Re-check: the offset can differ at the corrected instant around DST transitions.
  const offset2 = zoneOffsetMs(new Date(candidate), timeZone);
  return new Date(offset2 === offset ? candidate : guess - offset2);
}

function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}
