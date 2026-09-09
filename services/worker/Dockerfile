# services/worker/Dockerfile — Bun worker (all pillar loops in one container).
# Cross-imports (api routes ↔ worker pillars, @core) mean both service trees +
# packages + tsconfig (path aliases) must be present. Bun runs TS natively.
FROM oven/bun:1 AS base
WORKDIR /app

# deps layer (no bun.lockb committed → plain install, not --frozen-lockfile)
COPY package.json ./
RUN bun install

# source
COPY tsconfig.json ./
# Provenance for the prediction ledger: the box tree has no .git, so the running
# code cannot identify itself otherwise. CI overwrites this file with the
# deployed commit before rsync; the tracked placeholder reads sha=dev.
COPY BUILD_INFO ./
COPY packages/ ./packages/
COPY services/ ./services/

USER bun
CMD ["bun", "run", "services/worker/src/main.ts"]
