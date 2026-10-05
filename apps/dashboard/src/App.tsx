import { useEffect, useState } from "react";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

/** Milestone 3 builds these out: calls, call detail, screening queue, tasks, schedule, metrics. */
const SECTIONS = ["Calls", "Screening queue", "Tasks", "Schedule"] as const;

type ApiStatus = "checking" | "ok" | "down";

export function App() {
  const [status, setStatus] = useState<ApiStatus>("checking");

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${API_BASE}/healthz`, { signal: controller.signal })
      .then((res) => setStatus(res.ok ? "ok" : "down"))
      .catch(() => {
        if (!controller.signal.aborted) setStatus("down");
      });
    return () => controller.abort();
  }, []);

  return (
    <div className="shell">
      <header>
        <h1>Lakeshore MRI &amp; CT · Staff</h1>
        <span className={`status status-${status}`}>API {status}</span>
      </header>
      <nav>
        {SECTIONS.map((section) => (
          <span key={section}>{section}</span>
        ))}
      </nav>
      <main>
        <p>Synthetic demo data only. Dashboard views arrive in milestone 3.</p>
      </main>
    </div>
  );
}
