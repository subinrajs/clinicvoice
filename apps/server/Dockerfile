# syntax=docker/dockerfile:1
# Build from the repo root:  docker build -f apps/server/Dockerfile -t clinicvoice-server .

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@12.4.1 --activate
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/server ./apps/server
RUN pnpm install --frozen-lockfile --filter @clinicvoice/server...
RUN pnpm --filter @clinicvoice/server... build
# Self-contained production bundle: server + built workspace packages + prod dependencies.
RUN pnpm deploy --filter @clinicvoice/server --prod --legacy /out

FROM node:22-alpine AS runtime
ENV NODE_ENV=production PROMPTS_DIR=/app/prompts
WORKDIR /app
COPY --from=build /out ./
COPY prompts ./prompts
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "dist/server.js"]
