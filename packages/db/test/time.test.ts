import { describe, expect, it } from "vitest";
import { zonedWallTimeToUtc } from "../src/time.js";

describe("zonedWallTimeToUtc", () => {
  it("applies EDT (UTC-4) in summer", () => {
    const utc = zonedWallTimeToUtc(
      { year: 2026, month: 7, day: 15, hour: 14, minute: 40 },
      "America/Toronto",
    );
    expect(utc.toISOString()).toBe("2026-07-15T18:40:00.000Z");
  });

  it("applies EST (UTC-5) in winter", () => {
    const utc = zonedWallTimeToUtc(
      { year: 2026, month: 12, day: 1, hour: 9, minute: 0 },
      "America/Toronto",
    );
    expect(utc.toISOString()).toBe("2026-12-01T14:00:00.000Z");
  });

  it("handles the day after the November DST change", () => {
    const utc = zonedWallTimeToUtc(
      { year: 2026, month: 11, day: 2, hour: 8, minute: 0 },
      "America/Toronto",
    );
    expect(utc.toISOString()).toBe("2026-11-02T13:00:00.000Z");
  });
});
