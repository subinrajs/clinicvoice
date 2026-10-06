import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck, Lock, Mail, PhoneCall, ShieldCheck } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api.js";
import type { Me } from "../lib/types.js";

export function Login() {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const login = useMutation({
    mutationFn: () => api.post<Me>("/auth/login", { email, password }),
    onSuccess: (me) => queryClient.setQueryData(["me"], me),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    login.mutate();
  };

  return (
    <div className="login">
      <section className="login-hero">
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
            <div className="brand-sub">MRI &amp; CT</div>
          </div>
        </div>
        <div className="hero-copy">
          <h1>Every call answered. Every scan safer.</h1>
          <p>
            The virtual assistant handles routine calls end to end and hands anything clinical to
            your team.
          </p>
          <ul className="hero-points">
            <li>
              <PhoneCall size={16} aria-hidden /> Bookings, reschedules and prep texts, confirmed
              with the caller
            </li>
            <li>
              <ClipboardCheck size={16} aria-hidden /> MRI safety answers queued for technologist
              review
            </li>
            <li>
              <ShieldCheck size={16} aria-hidden /> Identity checks and a full audit trail on every
              call
            </li>
          </ul>
        </div>
        <p className="hero-foot">Portfolio demo · synthetic data only</p>
      </section>

      <section className="login-panel">
        <form onSubmit={submit} className="login-form">
          <h2>Sign in</h2>
          <p className="page-subtitle">Staff dashboard</p>
          <label className="field">
            <span>Email</span>
            <span className="input-icon">
              <Mail size={15} aria-hidden />
              <input
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </span>
          </label>
          <label className="field">
            <span>Password</span>
            <span className="input-icon">
              <Lock size={15} aria-hidden />
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </span>
          </label>
          {login.error && (
            <p role="alert" className="error-text">
              {login.error instanceof ApiError && login.error.status === 401
                ? "Email or password is incorrect."
                : "Sign-in failed. Try again."}
            </p>
          )}
          <button type="submit" className="btn btn-primary btn-block" disabled={login.isPending}>
            {login.isPending ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </section>
    </div>
  );
}
