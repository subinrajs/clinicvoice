import {
  AlertTriangle,
  ClipboardCheck,
  Gauge,
  ListTodo,
  PhoneCall,
  PhoneForwarded,
  UserCheck,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { formatMs } from "../lib/format.js";
import { useMetrics } from "../lib/useMetrics.js";

interface Kpi {
  label: string;
  value: string;
  hint: string;
  icon: LucideIcon;
  tone: "brand" | "success" | "warning" | "danger" | "neutral";
}

export function MetricsStrip() {
  const { data, isLoading } = useMetrics();

  if (isLoading || !data) {
    return (
      <div className="kpis">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="kpi kpi-loading" />
        ))}
      </div>
    );
  }

  const verifiedRate = data.callsToday
    ? Math.round((data.verifiedToday / data.callsToday) * 100)
    : 0;
  const latencyOk = data.medianLatencyMs24h !== null && data.medianLatencyMs24h <= 1500;
  const kpis: Kpi[] = [
    {
      label: "Calls today",
      value: String(data.callsToday),
      hint: "Answered by the assistant",
      icon: PhoneCall,
      tone: "brand",
    },
    {
      label: "Verified callers",
      value: String(data.verifiedToday),
      hint: `${verifiedRate}% of today's calls`,
      icon: UserCheck,
      tone: "success",
    },
    {
      label: "Escalated",
      value: String(data.escalatedToday),
      hint: "Transfers and callbacks",
      icon: PhoneForwarded,
      tone: "neutral",
    },
    {
      label: "Flagged for review",
      value: String(data.flaggedToday),
      hint: "Filter hits, failed identity",
      icon: AlertTriangle,
      tone: data.flaggedToday ? "danger" : "neutral",
    },
    {
      label: "Median response",
      value: formatMs(data.medianLatencyMs24h),
      hint: latencyOk ? "Within the 1.5 s target" : "Target is 1.5 s",
      icon: Gauge,
      tone: latencyOk ? "success" : "warning",
    },
    {
      label: "Needs attention",
      value: String(data.openTasks + data.screeningsNeedingReview),
      hint: `${data.openTasks} tasks · ${data.screeningsNeedingReview} screenings`,
      icon: data.screeningsNeedingReview ? ClipboardCheck : ListTodo,
      tone: data.openTasks + data.screeningsNeedingReview ? "warning" : "success",
    },
  ];

  return (
    <div className="kpis">
      {kpis.map(({ label, value, hint, icon: Icon, tone }) => (
        <div key={label} className="kpi">
          <div className={`kpi-icon tone-${tone}`}>
            <Icon size={18} aria-hidden />
          </div>
          <div className="kpi-label">{label}</div>
          <div className="kpi-value">{value}</div>
          <div className="kpi-hint">{hint}</div>
        </div>
      ))}
    </div>
  );
}
