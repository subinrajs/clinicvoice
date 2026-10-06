# ADR 0006: Same-origin cookie sessions for the staff dashboard

- Status: accepted
- Date: 2026-10-05

## Context

Staff log in to see transcripts, screening answers and tasks, all of which are PHI. The dashboard is a static site (Vercel) and the API lives on the voice server (Render).

## Decision

- The dashboard calls `/api` on its own origin: a Vercel rewrite in production and the Vite proxy locally. The session cookie can then be `httpOnly`, `SameSite=Lax`, `Secure` and scoped to `/api`, with no CORS and no token in JavaScript-readable storage.
- The session is a signed JWT (8 h) in that cookie, issued after scrypt password verification. Unknown users and wrong passwords get the same response. Login is rate-limited.
- CSRF protection: SameSite=Lax, plus a required `x-clinicvoice-csrf` header on every mutation, which a cross-site form cannot send.
- Roles are enforced server-side. Only `technologist` and `admin` can record screening decisions. Staff reads of call detail and every staff write are written to `audit_log` as `staff:<id>`.
- Live updates use server-sent events fed by Postgres `LISTEN/NOTIFY`. Notifications carry only table and id; the browser refetches through the authenticated API.

## Consequences

A production version would swap password login for SSO with MFA and site scoping (see the security table in the README). The cookie and role model stays the same.
