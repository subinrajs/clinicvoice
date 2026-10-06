import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, ClipboardCheck, Cpu, Lock, MapPin, Quote, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Avatar, Badge, EmptyState, PageHeader, Segmented, Skeleton } from "../components/ui.js";
import { api } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { examLabel, formatDateTime, formatRelative } from "../lib/format.js";
import { label, toneFor } from "../lib/status.js";
import type { ScreeningRow } from "../lib/types.js";

type Filter = "needs_review" | "in_progress" | "clear" | "all";
const DECISIONS = [
  { value: "clear", label: "Clear", tone: "success" },
  { value: "conditional", label: "Conditional", tone: "warning" },
  { value: "contraindicated", label: "Contraindicated", tone: "danger" },
] as const;

const QUESTION_LABELS: Record<string, string> = {
  pacemaker: "Pacemaker or defibrillator",
  neurostimulator: "Neurostimulator, cochlear implant or pump",
  aneurysm_clip: "Brain or heart surgery (clips, valves)",
  metal_fragments: "Metal in eyes, grinding or welding",
  implants_other: "Other implants (joints, plates, screws, stents)",
  pregnant: "Possible pregnancy",
  kidney: "Kidney problems",
  contrast_allergy: "Previous contrast reaction",
  claustrophobia: "Uncomfortable in small spaces",
};

function ReviewForm({ screening }: { screening: ScreeningRow }) {
  const queryClient = useQueryClient();
  const [decision, setDecision] = useState<(typeof DECISIONS)[number]["value"] | null>(null);
  const [note, setNote] = useState("");
  const review = useMutation({
    mutationFn: () =>
      api.post(`/screenings/${screening.id}/review`, {
        status: decision,
        note: note.trim() || null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["screenings"] });
      void queryClient.invalidateQueries({ queryKey: ["metrics"] });
    },
  });

  return (
    <form
      className="review-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (decision) review.mutate();
      }}
    >
      <div className="decision-group" role="radiogroup" aria-label="Decision">
        {DECISIONS.map((d) => (
          <button
            key={d.value}
            type="button"
            role="radio"
            aria-checked={decision === d.value}
            className={`decision decision-${d.tone}${decision === d.value ? " selected" : ""}`}
            onClick={() => setDecision(d.value)}
          >
            {d.label}
          </button>
        ))}
      </div>
      <textarea
        placeholder="Note for the care team: device model, scanner, instructions…"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
      />
      <div className="form-row">
        {review.error && <span className="error-text">Could not save. Try again.</span>}
        <button type="submit" className="btn btn-primary" disabled={!decision || review.isPending}>
          {review.isPending ? "Saving…" : "Record decision"}
        </button>
      </div>
    </form>
  );
}

function ScreeningCard({ screening, canDecide }: { screening: ScreeningRow; canDecide: boolean }) {
  const answers = Object.entries(screening.answers);
  const risks = answers.filter(([, a]) => a.answer !== "no");
  const reviewable = screening.status === "needs_review" || screening.status === "in_progress";

  return (
    <article
      className={`card screening ${screening.status === "needs_review" ? "screening-attention" : ""}`}
    >
      <header className="screening-head">
        <Avatar name={screening.patient_name} />
        <div className="screening-who">
          <div className="person-name">{screening.patient_name}</div>
          <div className="person-meta">{examLabel(screening.exam_code)}</div>
        </div>
        <Badge tone={toneFor(screening.status)} dot>
          {label(screening.status)}
        </Badge>
      </header>

      <div className="meta-row">
        <span>
          <CalendarClock size={13} aria-hidden /> {formatDateTime(screening.starts_at)}
        </span>
        <span>
          <MapPin size={13} aria-hidden /> {screening.site_name.replace("Lakeshore ", "")}
        </span>
      </div>

      <div className="screening-section">
        <div className="section-label">
          Risk answers <span className="muted">· {answers.length} answered</span>
        </div>
        {risks.length === 0 ? (
          <p className="muted small">No risk answers so far.</p>
        ) : (
          <ul className="answer-list">
            {risks.map(([id, a]) => (
              <li key={id}>
                <div className="answer-head">
                  <span>{QUESTION_LABELS[id] ?? label(id)}</span>
                  <Badge tone={a.answer === "yes" ? "danger" : "warning"}>
                    {a.answer === "yes" ? "Yes" : "Unsure"}
                  </Badge>
                </div>
                {a.callerWords && (
                  <blockquote className="verbatim">
                    <Quote size={12} aria-hidden /> {a.callerWords}
                  </blockquote>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {screening.implants.length > 0 && (
        <div className="screening-section">
          <div className="section-label">
            <Cpu size={13} aria-hidden /> Devices identified
          </div>
          <ul className="device-list">
            {screening.implants.map((d, i) => (
              <li key={i}>
                <span className="device-name">{d.device}</span>
                {d.bodyLocation && <span className="tag">{d.bodyLocation}</span>}
                {d.needsFollowUp && <Badge tone="warning">Verify model</Badge>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {screening.review_note && (
        <div className="callout callout-success">
          <ShieldCheck size={14} aria-hidden />
          <div>
            <strong>Technologist note</strong>
            {screening.reviewed_at && (
              <span className="muted"> · {formatRelative(screening.reviewed_at)}</span>
            )}
            <p>{screening.review_note}</p>
          </div>
        </div>
      )}

      {reviewable &&
        (canDecide ? (
          <ReviewForm screening={screening} />
        ) : (
          <p className="locked-note">
            <Lock size={13} aria-hidden /> Only technologists can record screening decisions.
          </p>
        ))}
    </article>
  );
}

export function Screenings() {
  const { me } = useAuth();
  const [filter, setFilter] = useState<Filter>("needs_review");
  const { data, isLoading } = useQuery({
    queryKey: ["screenings", "all"],
    queryFn: () => api.get<{ screenings: ScreeningRow[] }>("/screenings?status=all"),
  });
  const all = data?.screenings ?? [];
  const count = (s: Filter) =>
    s === "all" ? all.length : all.filter((x) => x.status === s).length;
  const visible = filter === "all" ? all : all.filter((s) => s.status === filter);
  const canDecide = me?.role === "technologist" || me?.role === "admin";

  return (
    <>
      <PageHeader
        title="MRI safety screening"
        subtitle="Answers collected by the assistant. Only a technologist can clear a patient for MRI."
        actions={
          <Segmented
            label="Filter screenings"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "needs_review", label: "Needs review", count: count("needs_review") },
              { value: "in_progress", label: "In progress", count: count("in_progress") },
              { value: "clear", label: "Cleared", count: count("clear") },
              { value: "all", label: "All", count: count("all") },
            ]}
          />
        }
      />
      {isLoading ? (
        <Skeleton rows={4} />
      ) : visible.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={ClipboardCheck}
            title={filter === "needs_review" ? "All caught up" : "Nothing here"}
          >
            {filter === "needs_review"
              ? "No screenings are waiting for a technologist."
              : "No screenings with this status."}
          </EmptyState>
        </div>
      ) : (
        <div className="screening-grid">
          {visible.map((s) => (
            <ScreeningCard key={s.id} screening={s} canDecide={canDecide} />
          ))}
        </div>
      )}
    </>
  );
}
