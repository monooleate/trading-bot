# services/api/Dockerfile — Bun read/API + signal endpoints, AND it serves the
# static Astro frontend (server.ts serveStatic) so the whole site sits behind
# one origin (Caddy → edgecalc-api). Same source context as the worker (routes
# import @worker/pillars/*, @core).

# 1) Build the Astro frontend → /web/dist
FROM oven/bun:1 AS webbuild
WORKDIR /web
COPY apps/web/package.json ./
RUN bun install
COPY apps/web ./
RUN bun run build

# 2) API image (Bun runs TS natively) + baked frontend
FROM oven/bun:1 AS base
WORKDIR /app
COPY package.json ./
RUN bun install
COPY tsconfig.json ./
COPY packages/ ./packages/
COPY services/ ./services/
COPY --from=webbuild /web/dist ./dist
ENV WEB_DIST=/app/dist
USER bun
EXPOSE 7000
CMD ["bun", "run", "services/api/src/server.ts"]
