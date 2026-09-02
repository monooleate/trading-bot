// packages/core/env.ts
//
// Zod-validated environment for the Postgres-backed services (worker, api,
// migrate runner). Only the infra + mode vars are validated here — the ~100
// pillar tuning knobs keep their code defaults and are read where used.
//
// Import `env` for the parsed, typed values. Call `loadEnv()` to re-parse
// (tests). Fails fast with a readable message if DATABASE_URL is missing in a
// context that needs it.

import { z } from "zod";

const Schema = z.object({
  DATABASE_URL: z.string().min(1).optional(),
  PAPER_MODE: z
    .string()
    .optional()
    .transform((v) => v !== "false"), // default true unless explicitly "false"
  // Worker scheduler (Netlify cron replacement). Comma-separated pillar list +
  // per-loop interval. Optional — the worker entrypoint (Phase 3) supplies
  // defaults.
  PILLARS: z.string().optional(),
  LOOP_INTERVAL_SEC: z.coerce.number().positive().optional(),
  PORT: z.coerce.number().positive().optional(),
  NODE_ENV: z.string().optional(),
});

export type Env = z.infer<typeof Schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = Schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
}

export const env: Env = loadEnv();

/** Assert DATABASE_URL is present (call in DB-backed entrypoints). */
export function requireDatabaseUrl(source: Env = env): string {
  if (!source.DATABASE_URL) {
    throw new Error("DATABASE_URL is required (see .env.example / migration-runbook Phase 5).");
  }
  return source.DATABASE_URL;
}
