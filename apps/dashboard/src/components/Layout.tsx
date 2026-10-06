import {
  CalendarDays,
  ClipboardCheck,
  ListTodo,
  LogOut,
  PhoneCall,
  ShieldCheck,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../lib/auth.js";
import { label } from "../lib/status.js";
import { useLiveUpdates } from "../lib/useLiveUpdates.js";
import { useMetrics } from "../lib/useMetrics.js";
import { Avatar } from "./ui.js";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  count?: number;
}

export function Layout() {
  const { me, logout } = useAuth();
  const { data: metrics } = useMetrics();
  useLiveUpdates(Boolean(me));

  const nav: NavItem[] = [
    { to: "/calls", label: "Calls", icon: PhoneCall },
    {
      to: "/screenings",
      label: "MRI screening",
      icon: ClipboardCheck,
      ...(metrics?.screeningsNeedingReview ? { count: metrics.screeningsNeedingReview } : {}),
    },
    {
      to: "/tasks",
      label: "Tasks",
      icon: ListTodo,
      ...(metrics?.openTasks ? { count: metrics.openTasks } : {}),
    },
    { to: "/schedule", label: "Schedule", icon: CalendarDays },
  ];

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="logo-mark" aria-hidden>
            <svg viewBox="0 0 32 32" width="20" height="20">
              <path
                d="M7 16h4l2.5-6 5 12 2.5-6h4"
                stroke="currentColor"
                strokeWidth="2.6"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <div>
            <div className="brand-name">Lakeshore</div>
            <div className="brand-sub">MRI &amp; CT · Staff</div>
          </div>
        </div>

        <nav className="sidebar-nav" aria-label="Main">
          <div className="nav-section">Workspace</div>
          {nav.map(({ to, label: text, icon: Icon, count }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}
            >
              <Icon size={18} aria-hidden />
              <span>{text}</span>
              {count !== undefined && <span className="nav-count">{count}</span>}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="assistant-status">
            <span className="pulse" aria-hidden />
            Virtual assistant online
          </div>
          <div className="user-card">
            <Avatar name={me?.name ?? null} size="sm" />
            <div className="user-meta">
              <div className="user-name">{me?.name}</div>
              <div className="user-role">{label(me?.role)}</div>
            </div>
            <button
              type="button"
              className="icon-button"
              onClick={() => void logout()}
              aria-label="Sign out"
              title="Sign out"
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>

      <div className="main">
        <div className="demo-banner">
          <ShieldCheck size={14} aria-hidden /> Synthetic demo data · Not a medical device
        </div>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
