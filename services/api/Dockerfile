# services/api/Dockerfile — Bun read/API + signal endpoints. Same build as the
# worker (shared context: routes import @worker/pillars/*, @core).
FROM oven/bun:1 AS base
WORKDIR /app

COPY package.json ./
RUN bun install

COPY tsconfig.json ./
COPY packages/ ./packages/
COPY services/ ./services/

USER bun
EXPOSE 7000
CMD ["bun", "run", "services/api/src/server.ts"]
