import { useQuery } from "@tanstack/react-query";
import { CalendarX, ChevronLeft, ChevronRight, Mic } from "lucide-react";
import { useState } from "react";
import { Card, EmptyState, PageHeader, Segmented, Skeleton } from "../components/ui.js";
import { api } from "../lib/api.js";
import { clinicToday, examLabel, formatLongDate, formatTime, shiftDate } from "../lib/format.js";
import type { ScheduleSlot } from "../lib/types.js";

type Site = "MISS" | "TOR" | "OAK";

type Row =
  | { kind: "slot"; slot: ScheduleSlot }
  | { kind: "open"; first: ScheduleSlot; last: ScheduleSlot; count: number };

/** Collapses runs of available slots into one row so booked work stands out. */
function toRows(slots: ScheduleSlot[]): Row[] {
  const rows: Row[] = [];
  for (const slot of slots) {
    const previous = rows.at(-1);
    if (slot.status === "open" && previous?.kind === "open") {
      previous.last = slot;
      previous.count++;
    } else if (slot.status === "open") {
      rows.push({ kind: "open", first: slot, last: slot, count: 1 });
    } else {
      rows.push({ kind: "slot", slot });
    }
  }
  return rows;
}

const endOf = (slot: ScheduleSlot) =>
  new Date(Date.parse(slot.starts_at) + slot.duration_min * 60_000).toISOString();
const SITES = [
  { value: "MISS", label: "Mississauga" },
  { value: "TOR", label: "Toronto" },
  { value: "OAK", label: "Oakville" },
] as const;

export function Schedule() {
  const [date, setDate] = useState(shiftDate(clinicToday(), 1));
  const [site, setSite] = useState<Site>("MISS");
  const { data, isLoading } = useQuery({
    queryKey: ["schedule", date, site],
    queryFn: () => api.get<{ slots: ScheduleSlot[] }>(`/schedule?date=${date}&site=${site}`),
  });
  const byModality = new Map<string, ScheduleSlot[]>();
  for (const slot of data?.slots ?? [])
    byModality.set(slot.modality, [...(byModality.get(slot.modality) ?? []), slot]);

  return (
    <>
      <PageHeader
        title="Schedule"
        subtitle={formatLongDate(`${date}T12:00:00Z`)}
        actions={
          <div className="toolbar">
            <div className="date-stepper">
              <button
                type="button"
                className="icon-button"
                onClick={() => setDate(shiftDate(date, -1))}
                aria-label="Previous day"
              >
                <ChevronLeft size={16} />
              </button>
              <input
                type="date"
                value={date}
                onChange={(e) => e.target.value && setDate(e.target.value)}
                aria-label="Date"
              />
              <button
                type="button"
                className="icon-button"
                onClick={() => setDate(shiftDate(date, 1))}
                aria-label="Next day"
              >
                <ChevronRight size={16} />
              </button>
            </div>
            <Segmented label="Site" value={site} onChange={setSite} options={SITES} />
          </div>
        }
      />
      {isLoading ? (
        <Skeleton rows={6} />
      ) : byModality.size === 0 ? (
        <div className="card">
          <EmptyState icon={CalendarX} title="Closed">
            This site has no scanner time on this day.
          </EmptyState>
        </div>
      ) : (
        <div className="schedule-grid">
          {[...byModality.entries()]
            .sort(([a], [b]) => a.localeCompare(b) * -1)
            .map(([modality, slots]) => {
              const booked = slots.filter((s) => s.status === "booked").length;
              const pct = Math.round((booked / slots.length) * 100);
              return (
                <Card
                  key={modality}
                  title={modality === "MRI" ? "MRI scanner" : "CT scanner"}
                  actions={
                    <div className="utilization">
                      <span className="muted small">
                        {booked}/{slots.length} booked
                      </span>
                      <span className="bar" aria-hidden>
                        <span style={{ width: `${pct}%` }} />
                      </span>
                    </div>
                  }
                >
                  <ul className="slots">
                    {toRows(slots).map((row) =>
                      row.kind === "open" ? (
                        <li key={row.first.id} className="slot slot-open">
                          <span className="slot-time mono">{formatTime(row.first.starts_at)}</span>
                          <span className="slot-body muted">
                            Available until {formatTime(endOf(row.last))}
                            <span className="tag">
                              {row.count} slot{row.count === 1 ? "" : "s"}
                            </span>
                          </span>
                        </li>
                      ) : (
                        <li key={row.slot.id} className={`slot slot-${row.slot.status}`}>
                          <span className="slot-time mono">{formatTime(row.slot.starts_at)}</span>
                          {row.slot.status === "booked" ? (
                            <span className="slot-body">
                              <span className="slot-patient">{row.slot.patient_name}</span>
                              <span className="muted">{examLabel(row.slot.exam_code)}</span>
                              {row.slot.created_via === "voice" && (
                                <span className="voice-tag" title="Booked by the virtual assistant">
                                  <Mic size={11} aria-hidden /> Voice
                                </span>
                              )}
                            </span>
                          ) : (
                            <span className="slot-body muted">Held during a call</span>
                          )}
                        </li>
                      ),
                    )}
                  </ul>
                </Card>
              );
            })}
        </div>
      )}
    </>
  );
}
