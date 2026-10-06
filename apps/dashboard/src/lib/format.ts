const TZ = "America/Toronto";

export const formatDateTime = (iso: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));

export const formatTime = (iso: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).format(
    new Date(iso),
  );

export const formatLongDate = (iso: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date(iso));

/** "5 min ago", "2 h ago", or a date for anything older than a day. */
export const formatRelative = (iso: string) => {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} h ago`;
  return formatDateTime(iso);
};

export const formatDuration = (startIso: string, endIso: string | null) => {
  if (!endIso) return "Live";
  const seconds = Math.round((Date.parse(endIso) - Date.parse(startIso)) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

export const formatMs = (ms: number | null) => (ms === null ? "—" : `${(ms / 1000).toFixed(2)} s`);

export const humanize = (value: string | null | undefined) =>
  value ? value.replace(/_/g, " ") : "—";

/** Today's date in the clinic's time zone, as YYYY-MM-DD. */
export const clinicToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());

export const shiftDate = (isoDate: string, days: number) => {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const EXAM_LABELS: Record<string, string> = {
  MRI_KNEE: "MRI · Knee",
  MRI_BRAIN: "MRI · Brain (contrast)",
  MRI_LSPINE: "MRI · Lumbar spine",
  CT_HEAD: "CT · Head",
  CT_CHEST: "CT · Chest",
  CT_ABDO: "CT · Abdomen (contrast)",
};
export const examLabel = (code: string | null) => (code ? (EXAM_LABELS[code] ?? code) : "—");
