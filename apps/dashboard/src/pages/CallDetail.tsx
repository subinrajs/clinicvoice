import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  CheckCircle2,
  ChevronRight,
  Clock,
  FileText,
  Gauge,
  Languages,
  ListTodo,
  PhoneIncoming,
  ShieldAlert,
  Wrench,
  XCircle,
} from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { Avatar, Badge, Card, ErrorNote, Skeleton } from "../components/ui.js";
import { api } from "../lib/api.js";
import { formatDuration, formatLongDate, formatMs, formatTime } from "../lib/format.js";
import { label, latencyTone, toneFor } from "../lib/status.js";
import type { CallDetail as CallDetailData, CallTurn } from "../lib/types.js";

function ToolEvent({ turn }: { turn: CallTurn }) {
  const ok = turn.tool_result?.ok;
  return (
    <li className={`event ${ok ? "event-ok" : "event-err"}`}>
      <details>
        <summary>
          <span className="event-icon">
            {ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
          </span>
          <Wrench size={13} aria-hidden className="muted" />
          <code>{turn.tool_name}</code>
          {!ok && turn.tool_result?.error && (
            <Badge tone="danger">{turn.tool_result.error.code}</Badge>
          )}
          <ChevronRight size={14} className="chevron" aria-hidden />
        </summary>
        <div className="event-payload">
          <div>
            <div className="payload-label">Input</div>
            <pre>{JSON.stringify(turn.tool_input, null, 2)}</pre>
          </div>
          <div>
            <div className="payload-label">Result</div>
            <pre>{JSON.stringify(turn.tool_result, null, 2)}</pre>
          </div>
        </div>
      </details>
    </li>
  );
}

function Message({ turn }: { turn: CallTurn }) {
  const caller = turn.role === "caller";
  return (
    <li className={`message ${caller ? "message-caller" : "message-agent"}`}>
      <span className="message-avatar" aria-hidden>
        {caller ? <PhoneIncoming size={14} /> : <Bot size={14} />}
      </span>
      <div className="message-body">
        <div className="message-meta">
          <span>{caller ? "Caller" : "Assistant"}</span>
          <span>{formatTime(turn.created_at)}</span>
          {turn.latency_ms !== null && (
            <Badge tone={latencyTone(turn.latency_ms)}>{formatMs(turn.latency_ms)}</Badge>
          )}
        </div>
        <div className="bubble">{turn.text}</div>
      </div>
    </li>
  );
}

export function CallDetail() {
  const { id = "" } = useParams();
  const { data, isLoading, error } = useQuery({
    queryKey: ["call", id],
    queryFn: () => api.get<CallDetailData>(`/calls/${id}`),
  });

  if (isLoading) return <Skeleton rows={8} />;
  if (error || !data) return <ErrorNote>Call not found.</ErrorNote>;

  const toolCount = data.turns.filter((t) => t.role === "tool").length;
  const flagged = data.flagged || data.summary?.flag_for_review;

  return (
    <>
      <Link to="/calls" className="back-link">
        <ArrowLeft size={15} /> All calls
      </Link>

      <header className="detail-header">
        <Avatar name={data.patient_name} size="lg" />
        <div className="detail-title">
          <h1>{data.patient_name ?? "Unverified caller"}</h1>
          <p className="page-subtitle">
            {formatLongDate(data.started_at)} at {formatTime(data.started_at)}
          </p>
        </div>
        <div className="detail-badges">
          {flagged && (
            <Badge tone="danger">
              <AlertTriangle size={12} /> Flagged
            </Badge>
          )}
          <Badge tone={toneFor(data.outcome)} dot>
            {label(data.outcome ?? "summarizing")}
          </Badge>
        </div>
      </header>

      <div className="detail-grid">
        <Card
          title="Transcript"
          icon={FileText}
          actions={
            <span className="muted small">
              {data.turns.length} events · {toolCount} tool calls
            </span>
          }
        >
          <ol className="conversation">
            {data.turns.map((turn) =>
              turn.role === "tool" ? (
                <ToolEvent key={turn.seq} turn={turn} />
              ) : turn.role === "system" ? (
                <li key={turn.seq} className="event event-system">
                  <ShieldAlert size={14} aria-hidden /> Output filter replaced a reply before it was
                  spoken
                </li>
              ) : (
                <Message key={turn.seq} turn={turn} />
              ),
            )}
          </ol>
        </Card>

        <div className="detail-side">
          {data.summary && (
            <Card title="AI summary" icon={Bot} className={flagged ? "card-alert" : ""}>
              <p className="summary-text">{data.summary.summary}</p>
              {data.summary.actions.length > 0 && (
                <ul className="check-list">
                  {data.summary.actions.map((a) => (
                    <li key={a}>
                      <CheckCircle2 size={14} aria-hidden /> {a}
                    </li>
                  ))}
                </ul>
              )}
              {data.summary.flag_reason && (
                <div className="callout callout-danger">
                  <AlertTriangle size={14} aria-hidden /> {data.summary.flag_reason}
                </div>
              )}
            </Card>
          )}

          <Card title="Call details" icon={Clock}>
            <dl className="details">
              <div>
                <dt>Duration</dt>
                <dd className="mono">{formatDuration(data.started_at, data.ended_at)}</dd>
              </div>
              <div>
                <dt>
                  <Gauge size={13} aria-hidden /> Median response
                </dt>
                <dd>
                  <Badge tone={latencyTone(data.median_latency_ms)}>
                    {formatMs(data.median_latency_ms)}
                  </Badge>
                </dd>
              </div>
              <div>
                <dt>
                  <Languages size={13} aria-hidden /> Language
                </dt>
                <dd>{data.language === "fr" ? "French" : "English"}</dd>
              </div>
              <div>
                <dt>Ended by</dt>
                <dd>{label(data.end_reason)}</dd>
              </div>
              <div>
                <dt>Intent</dt>
                <dd>{label(data.summary?.intent)}</dd>
              </div>
            </dl>
          </Card>

          {data.tasks.length > 0 && (
            <Card title="Follow-up tasks" icon={ListTodo}>
              <ul className="stack-list">
                {data.tasks.map((t) => (
                  <li key={t.id}>
                    <div className="stack-row">
                      <span className="tag">{label(t.type)}</span>
                      <Badge tone={toneFor(t.status)} dot>
                        {label(t.status)}
                      </Badge>
                    </div>
                    <p>{t.reason}</p>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
