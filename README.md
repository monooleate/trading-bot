# EdgeCalc — Polymarket & funding-arb trading toolkit

Monorepo: **Astro 4 + React** frontend (`apps/web`), **Bun** API (`services/api`), **worker** with an internal scheduler (`services/worker`), pure core logic (`packages/core`), Python model service (`services/model`), **Postgres**. Runs as a Docker co-host on the Hetzner `analytics` box at **https://trade.jmeszaros.dev** (paper mode).

## Local development

```bash
npm install
npm run dev          # frontend only → http://localhost:4321
npm test             # core + services test suite (scripts/run-tests.mjs)
```

The API and the worker need Postgres (`DATABASE_URL`); see `.env.example` and `docker-compose.yml`.

## Deploy

Push to `main` → GitHub Actions CI (typecheck + tests + build) → `.github/workflows/deploy.yml` rsyncs the tree to the box and rebuilds the containers. There is no Netlify deploy any more (retired 2026-09-02; the old `mj-trading.netlify.app` site is deleted).

## Where to read next

- `CLAUDE.md` — project overview, safety rules, where the rules live
- `internal-docs/roadmap/sprints.md` — current focus and backlog
- `internal-docs/roadmap/migration-runbook.md` — the (completed) Netlify → Hetzner migration
