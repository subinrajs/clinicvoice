import { verifyPassword, zonedWallTimeToUtc } from "@clinicvoice/db";
import { ScreeningStatus, TaskStatus, type StaffRole } from "@clinicvoice/shared";
import fastifyCookie from "@fastify/cookie";
import fastifyJwt from "@fastify/jwt";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AuditWriter } from "../repositories/auditRepository.js";
import type { DashboardRepository } from "./dashboardRepository.js";
import type { DashboardEvents } from "./events.js";

export const SESSION_COOKIE = "cv_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;
/** Mutations must carry this header; a cross-site form post cannot set it (CSRF defence). */
export const CSRF_HEADER = "x-clinicvoice-csrf";

export interface StaffClaims {
  sub: string;
  role: StaffRole;
  name: string;
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: StaffClaims;
    user: StaffClaims;
  }
}

export interface DashboardRouteOptions {
  repo: DashboardRepository;
  audit: AuditWriter;
  events: DashboardEvents;
  sessionSecret: string;
  secureCookies: boolean;
  timeZone: string;
}

const LoginBody = z.object({ email: z.email(), password: z.string().min(1).max(200) });
const ReviewBody = z.object({
  status: ScreeningStatus.exclude(["in_progress"]),
  note: z.string().trim().max(1000).nullable().default(null),
});
const TaskPatch = z.object({ status: TaskStatus });
const IdParam = z.object({ id: z.uuid() });

const staffActor = (req: FastifyRequest) => `staff:${req.user.sub}`;

function requireRole(...roles: StaffRole[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!roles.includes(req.user.role)) return reply.code(403).send({ error: "forbidden" });
  };
}

/**
 * Staff dashboard API. Served under /api on the same origin as the dashboard (Vercel rewrite in
 * production, Vite proxy locally), so the session cookie stays SameSite=Lax and httpOnly.
 */
export const dashboardRoutes =
  (options: DashboardRouteOptions): FastifyPluginAsync =>
  async (app) => {
    await app.register(fastifyCookie);
    await app.register(fastifyJwt, {
      secret: options.sessionSecret,
      cookie: { cookieName: SESSION_COOKIE, signed: false },
      sign: { expiresIn: SESSION_TTL_SECONDS },
    });

    const authenticate = async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        await req.jwtVerify({ onlyCookie: true });
      } catch {
        return reply.code(401).send({ error: "unauthenticated" });
      }
      if (req.method !== "GET" && req.headers[CSRF_HEADER] !== "1") {
        return reply.code(403).send({ error: "missing csrf header" });
      }
    };

    app.post(
      "/auth/login",
      { config: { rateLimit: { max: 10, timeWindow: "5 minutes" } } },
      async (req, reply) => {
        const body = LoginBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: "invalid credentials" });
        const staff = await options.repo.findStaffByEmail(body.data.email);
        // Same response for unknown user and wrong password.
        if (!staff || !(await verifyPassword(body.data.password, staff.passwordHash))) {
          return reply.code(401).send({ error: "invalid credentials" });
        }
        const token = await reply.jwtSign({
          sub: staff.id,
          role: staff.role,
          name: staff.displayName,
        });
        await options.audit.write({
          actor: `staff:${staff.id}`,
          action: "login",
          entity: "staff",
          entityId: staff.id,
        });
        return reply
          .setCookie(SESSION_COOKIE, token, {
            httpOnly: true,
            secure: options.secureCookies,
            sameSite: "lax",
            path: "/api",
            maxAge: SESSION_TTL_SECONDS,
          })
          .send({ name: staff.displayName, role: staff.role });
      },
    );

    app.post("/auth/logout", async (_req, reply) => {
      return reply.clearCookie(SESSION_COOKIE, { path: "/api" }).send({ ok: true });
    });

    app.register(async (secured) => {
      secured.addHook("onRequest", authenticate);

      secured.get("/auth/me", async (req) => ({ name: req.user.name, role: req.user.role }));

      secured.get("/metrics", async () => options.repo.metrics(options.timeZone));

      secured.get("/calls", async (req) => {
        const query = z
          .object({
            limit: z.coerce.number().int().min(1).max(100).default(50),
            before: z.coerce.date().optional(),
            flagged: z.enum(["true", "false"]).optional(),
          })
          .parse(req.query);
        return {
          calls: await options.repo.listCalls({
            limit: query.limit,
            ...(query.before ? { before: query.before } : {}),
            flaggedOnly: query.flagged === "true",
          }),
        };
      });

      secured.get("/calls/:id", async (req, reply) => {
        const params = IdParam.safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: "invalid id" });
        const call = await options.repo.getCall(params.data.id);
        if (!call) return reply.code(404).send({ error: "not found" });
        await options.audit.write({
          actor: staffActor(req),
          action: "read",
          entity: "call",
          entityId: call.id,
          requestId: req.id,
        });
        return call;
      });

      secured.get("/screenings", async (req) => {
        const { status } = z
          .object({ status: z.union([ScreeningStatus, z.literal("all")]).default("needs_review") })
          .parse(req.query);
        return { screenings: await options.repo.listScreenings(status) };
      });

      // Only technologists (and admins) make screening decisions; the agent never can.
      secured.post(
        "/screenings/:id/review",
        { preHandler: requireRole("technologist", "admin") },
        async (req, reply) => {
          const params = IdParam.safeParse(req.params);
          const body = ReviewBody.safeParse(req.body);
          if (!params.success || !body.success)
            return reply.code(400).send({ error: "invalid request" });
          const updated = await options.repo.reviewScreening(params.data.id, {
            status: body.data.status,
            note: body.data.note,
            staffId: req.user.sub,
          });
          if (!updated) return reply.code(404).send({ error: "not found" });
          await options.audit.write({
            actor: staffActor(req),
            action: "review",
            entity: "screening",
            entityId: params.data.id,
            requestId: req.id,
          });
          return { ok: true };
        },
      );

      secured.get("/tasks", async (req) => {
        const { status } = z
          .object({ status: z.union([TaskStatus, z.literal("active")]).default("active") })
          .parse(req.query);
        return { tasks: await options.repo.listTasks(status) };
      });

      secured.patch("/tasks/:id", async (req, reply) => {
        const params = IdParam.safeParse(req.params);
        const body = TaskPatch.safeParse(req.body);
        if (!params.success || !body.success)
          return reply.code(400).send({ error: "invalid request" });
        if (!(await options.repo.updateTask(params.data.id, body.data.status))) {
          return reply.code(404).send({ error: "not found" });
        }
        await options.audit.write({
          actor: staffActor(req),
          action: "update",
          entity: "task",
          entityId: params.data.id,
          requestId: req.id,
        });
        return { ok: true };
      });

      secured.get("/schedule", async (req, reply) => {
        const query = z
          .object({ date: z.iso.date(), site: z.enum(["MISS", "TOR", "OAK"]).optional() })
          .safeParse(req.query);
        if (!query.success) return reply.code(400).send({ error: "date=YYYY-MM-DD required" });
        const [year, month, day] = query.data.date.split("-").map(Number) as [
          number,
          number,
          number,
        ];
        const from = zonedWallTimeToUtc({ year, month, day, hour: 0, minute: 0 }, options.timeZone);
        const to = new Date(from.getTime() + 24 * 3_600_000);
        return {
          slots: await options.repo.schedule({
            from,
            to,
            ...(query.data.site ? { siteCode: query.data.site } : {}),
          }),
        };
      });

      /** Server-sent events: "something changed" pings; the client refetches what it shows. */
      secured.get("/events", (req, reply) => {
        reply.hijack();
        reply.raw.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        reply.raw.write("retry: 5000\n\n");
        const unsubscribe = options.events.subscribe((event) => {
          reply.raw.write(`event: change\ndata: ${JSON.stringify(event)}\n\n`);
        });
        const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), 25_000);
        req.raw.on("close", () => {
          clearInterval(heartbeat);
          unsubscribe();
        });
      });
    });
  };
