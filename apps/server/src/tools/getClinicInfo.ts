import { ToolErrorCode } from "@clinicvoice/shared";
import { z } from "zod";
import { defineTool } from "./defineTool.js";
import { fail, ok } from "./types.js";

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** "07:00-21:00" on Mon-Fri -> "Monday to Friday, 7 AM to 9 PM". Groups consecutive equal days. */
export function speakableHours(hours: Record<string, string | null>): string {
  const groups: { from: number; to: number; window: string | null }[] = [];
  for (let day = 1; day <= 7; day++) {
    const window = hours[String(day)] ?? null;
    const last = groups.at(-1);
    if (last && last.window === window) last.to = day;
    else groups.push({ from: day, to: day, window });
  }
  return groups
    .map(({ from, to, window }) => {
      const days =
        from === to ? DAY_NAMES[from - 1] : `${DAY_NAMES[from - 1]} to ${DAY_NAMES[to - 1]}`;
      if (!window) return `closed ${days}`;
      const [open, close] = window.split("-").map(speakableClock);
      return `${days}, ${open} to ${close}`;
    })
    .join("; ");
}

function speakableClock(hhmm: string): string {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  const suffix = h < 12 ? "AM" : "PM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour12} ${suffix}` : `${hour12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** General clinic facts. Touches no patient data, so it is available before verification. */
export const getClinicInfo = defineTool({
  name: "get_clinic_info",
  description:
    "Get clinic locations, opening hours, parking and which scans each site offers. No identity check needed. Use for general questions.",
  input: z.object({
    site_code: z
      .enum(["MISS", "TOR", "OAK"])
      .optional()
      .describe("MISS = Mississauga, TOR = Toronto Downtown, OAK = Oakville"),
  }),
  guards: [],
  async run(input, ctx) {
    const sites = (await ctx.repo.listSites()).filter(
      (s) => !input.site_code || s.code === input.site_code,
    );
    if (sites.length === 0) return fail(ToolErrorCode.NONE_FOUND, "No site matches that code.");
    return ok({
      sites: sites.map((s) => ({
        code: s.code,
        name: s.name,
        address: s.address,
        scans: s.modalities.join(" and "),
        hours: speakableHours(s.hours),
        parking: s.parking,
      })),
    });
  },
});
