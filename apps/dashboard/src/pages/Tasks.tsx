import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCheck, ClipboardCheck, ExternalLink, Phone, PhoneMissed, Play } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import {
  Avatar,
  Badge,
  Card,
  EmptyState,
  PageHeader,
  Segmented,
  Skeleton,
} from "../components/ui.js";
import { api } from "../lib/api.js";
import { formatRelative } from "../lib/format.js";
import { label, toneFor } from "../lib/status.js";
import type { TaskRow } from "../lib/types.js";

type Filter = "active" | "done";

const TYPE_META: Record<TaskRow["type"], { icon: LucideIcon; label: string }> = {
  callback: { icon: Phone, label: "Callback" },
  review: { icon: ClipboardCheck, label: "Screening review" },
  transfer_failed: { icon: PhoneMissed, label: "Missed transfer" },
};

export function Tasks() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>("active");
  const { data, isLoading } = useQuery({
    queryKey: ["tasks", filter],
    queryFn: () => api.get<{ tasks: TaskRow[] }>(`/tasks?status=${filter}`),
  });
  const update = useMutation({
    mutationFn: ({ id, status }: { id: string; status: TaskRow["status"] }) =>
      api.patch(`/tasks/${id}`, { status }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      void queryClient.invalidateQueries({ queryKey: ["metrics"] });
    },
  });
  const tasks = data?.tasks ?? [];

  return (
    <>
      <PageHeader
        title="Tasks"
        subtitle="Follow-ups the assistant handed to staff: callbacks, screening reviews and missed transfers."
        actions={
          <Segmented
            label="Filter tasks"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "active", label: "Active" },
              { value: "done", label: "Completed" },
            ]}
          />
        }
      />
      <Card padded={false}>
        {isLoading ? (
          <div className="card-body">
            <Skeleton rows={5} />
          </div>
        ) : tasks.length === 0 ? (
          <EmptyState
            icon={CheckCheck}
            title={filter === "active" ? "Inbox zero" : "No completed tasks yet"}
          >
            {filter === "active" ? "Nothing needs follow-up right now." : undefined}
          </EmptyState>
        ) : (
          <ul className="task-list">
            {tasks.map((task) => {
              const meta = TYPE_META[task.type];
              const Icon = meta.icon;
              return (
                <li key={task.id} className="task">
                  <span className={`task-icon task-${task.type}`}>
                    <Icon size={16} aria-hidden />
                  </span>
                  <div className="task-main">
                    <div className="task-title">
                      <span>{meta.label}</span>
                      <Badge tone={toneFor(task.status)} dot>
                        {label(task.status)}
                      </Badge>
                      <span className="muted small">for {label(task.assigned_role)}</span>
                    </div>
                    <p className="task-reason">{task.reason}</p>
                    <div className="task-meta">
                      <span className="person-inline">
                        <Avatar name={task.patient_name} size="sm" />
                        {task.patient_name ?? "Unknown caller"}
                      </span>
                      {task.patient_phone && <span className="mono">{task.patient_phone}</span>}
                      <span>{formatRelative(task.created_at)}</span>
                      {task.call_id && (
                        <Link to={`/calls/${task.call_id}`} className="inline-link">
                          View call <ExternalLink size={12} aria-hidden />
                        </Link>
                      )}
                    </div>
                  </div>
                  <div className="task-actions">
                    {task.status === "open" && (
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={update.isPending}
                        onClick={() => update.mutate({ id: task.id, status: "in_progress" })}
                      >
                        <Play size={14} aria-hidden /> Start
                      </button>
                    )}
                    {task.status !== "done" && (
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={update.isPending}
                        onClick={() => update.mutate({ id: task.id, status: "done" })}
                      >
                        <CheckCheck size={14} aria-hidden /> Done
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}
