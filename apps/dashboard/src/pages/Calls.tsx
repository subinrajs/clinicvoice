import { useQuery } from "@tanstack/react-query";
import { Flag, Languages, PhoneOff, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { MetricsStrip } from "../components/MetricsStrip.js";
import {
  Avatar,
  Badge,
  Card,
  EmptyState,
  ErrorNote,
  PageHeader,
  Segmented,
  Skeleton,
} from "../components/ui.js";
import { api } from "../lib/api.js";
import { formatDuration, formatMs, formatRelative, formatTime } from "../lib/format.js";
import { label, latencyTone, toneFor } from "../lib/status.js";
import type { CallRow } from "../lib/types.js";

type Filter = "all" | "flagged" | "escalated";

export function Calls() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const { data, isLoading, error } = useQuery({
    queryKey: ["calls"],
    queryFn: () => api.get<{ calls: CallRow[] }>("/calls?limit=100"),
  });

  const calls = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.calls ?? []).filter((c) => {
      if (filter === "flagged" && !c.flagged) return false;
      if (filter === "escalated" && !["callback_needed", "transferred"].includes(c.outcome ?? ""))
        return false;
      if (!q) return true;
      return [c.patient_name, c.summary, c.intent, c.outcome].some((v) =>
        v?.toLowerCase().includes(q),
      );
    });
  }, [data, filter, query]);

  const counts = {
    all: data?.calls.length ?? 0,
    flagged: data?.calls.filter((c) => c.flagged).length ?? 0,
    escalated:
      data?.calls.filter((c) => ["callback_needed", "transferred"].includes(c.outcome ?? ""))
        .length ?? 0,
  };

  return (
    <>
      <PageHeader
        title="Calls"
        subtitle="Everything the virtual assistant handled today, newest first."
      />
      <MetricsStrip />

      <Card
        title="Recent calls"
        padded={false}
        actions={
          <div className="toolbar">
            <label className="search">
              <Search size={15} aria-hidden />
              <input
                placeholder="Search patient, intent, summary"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search calls"
              />
            </label>
            <Segmented
              label="Filter calls"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "All", count: counts.all },
                { value: "flagged", label: "Flagged", count: counts.flagged },
                { value: "escalated", label: "Escalated", count: counts.escalated },
              ]}
            />
          </div>
        }
      >
        {error && <ErrorNote>Could not load calls. Check that the server is running.</ErrorNote>}
        {isLoading ? (
          <div className="card-body">
            <Skeleton rows={6} />
          </div>
        ) : calls.length === 0 ? (
          <EmptyState icon={PhoneOff} title="No calls match">
            {query || filter !== "all"
              ? "Try a different search or filter."
              : "Calls appear here as soon as the assistant answers one."}
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Caller</th>
                  <th>Intent</th>
                  <th>Outcome</th>
                  <th className="num">Duration</th>
                  <th className="num">Response</th>
                  <th>Summary</th>
                </tr>
              </thead>
              <tbody>
                {calls.map((call) => (
                  <tr
                    key={call.id}
                    className="clickable"
                    onClick={() => navigate(`/calls/${call.id}`)}
                  >
                    <td>
                      <div className="person">
                        <Avatar name={call.patient_name} />
                        <div>
                          <div className="person-name">
                            {call.patient_name ?? "Unverified caller"}
                            {call.flagged && (
                              <span className="flag-icon" title="Flagged for review">
                                <Flag size={13} />
                              </span>
                            )}
                          </div>
                          <div className="person-meta">
                            {formatTime(call.started_at)} · {formatRelative(call.started_at)}
                            {call.language === "fr" && (
                              <span className="lang">
                                <Languages size={12} aria-hidden /> FR
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="tag">{label(call.intent)}</span>
                    </td>
                    <td>
                      <Badge tone={toneFor(call.outcome)} dot>
                        {call.outcome
                          ? label(call.outcome)
                          : call.ended_at
                            ? "Summarizing"
                            : "Live"}
                      </Badge>
                    </td>
                    <td className="num mono">{formatDuration(call.started_at, call.ended_at)}</td>
                    <td className="num">
                      <span className={`latency tone-text-${latencyTone(call.median_latency_ms)}`}>
                        {formatMs(call.median_latency_ms)}
                      </span>
                    </td>
                    <td>
                      <div className="summary-cell">
                        {call.summary ?? <span className="muted">—</span>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
