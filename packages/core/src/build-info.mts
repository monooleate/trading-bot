// packages/core/src/build-info.mts
//
// Which CODE produced a measurement.
//
// WHY THIS EXISTS
// ---------------
// `currentConfigFingerprint()` hashes the runtime knob overrides and nothing
// else — no commit, no build id. So `configHash` on a ledger row means "these
// knobs were set", while every consumer reads it as "this is the configuration
// that produced the prediction". Same class as B53: the field does not mean what
// its consumer believes.
//
// Measured on the live crypto ledger (2026-09-09, n=101): `3683673b` spans
// 2026-09-04 → 2026-09-09 and many deploys, and `e03b4835` spans 10:45:41 →
// 11:07:11 — a window containing the audit deploy at 11:03 that rewrote the HL
// signal source, the ledger provenance rules, the realized-IC blend and the fill
// validity check. Two materially different code regimes, one arm, no way to tell
// them apart after the fact.
//
// WHY NOT JUST FOLD THE SHA INTO configHash
// -----------------------------------------
// Because deploys are frequent (four on 2026-09-09 alone) and knob changes are
// rare. Hashing them together would mint a fresh arm on every push, fragmenting
// the config-attribution buckets and the Thompson bandit into single-row arms
// that can never accumulate evidence — trading one silent bias for a louder one.
// Keeping them separate preserves the question "same knobs, different code?",
// which is exactly the question that could not be asked before.
//
// Forward-only, like B53: rows already written cannot be re-attributed.

import * as fs from "node:fs";
import * as path from "node:path";

// `dev` is the value for any build that did not come through the deploy
// workflow. Deliberately a CONSTANT: a random per-process id would mint a new
// attribution arm on every restart, which is the opposite of the point.
const UNKNOWN = "dev";

let cached: { codeVersion: string; builtAt: string | null } | null = null;

/**
 * Identify the running build.
 *
 * Resolution order:
 *   1. `EDGECALC_CODE_VERSION` — an explicit override, and the only path that
 *      works when the source tree is not on disk.
 *   2. `BUILD_INFO` at the repo root, written by the deploy workflow before it
 *      rsyncs (the box's tree has no `.git`, so the commit cannot be read back
 *      out of the checkout).
 *   3. `"dev"` — local runs and tests. Deliberately a constant rather than a
 *      random id, so a developer machine does not mint a new arm per process.
 *
 * Cached after the first call: this is on the per-tick ledger path and the value
 * cannot change without a restart.
 */
export function buildInfo(): { codeVersion: string; builtAt: string | null } {
  if (cached) return cached;

  const env = typeof process !== "undefined" ? process.env?.EDGECALC_CODE_VERSION : undefined;
  if (typeof env === "string" && env.trim()) {
    cached = { codeVersion: env.trim().slice(0, 12), builtAt: null };
    return cached;
  }

  // Walk up from the working directory rather than using `__dirname`, which is
  // not defined under ESM. In the container WORKDIR is /app and BUILD_INFO sits
  // beside package.json; locally the repo root is usually cwd, but a few levels
  // of tolerance costs nothing and makes this work from a subdirectory too.
  try {
    let dir = process.cwd();
    for (let i = 0; i < 5; i++) {
      const candidate = path.join(dir, "BUILD_INFO");
      if (fs.existsSync(candidate)) {
        const raw = fs.readFileSync(candidate, "utf8");
        const sha = /^sha=([0-9a-f]{7,40})$/m.exec(raw)?.[1];
        const at = /^builtAt=(.+)$/m.exec(raw)?.[1]?.trim() ?? null;
        cached = { codeVersion: sha ? sha.slice(0, 12) : UNKNOWN, builtAt: at };
        return cached;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    cached = { codeVersion: UNKNOWN, builtAt: null };
  } catch {
    cached = { codeVersion: UNKNOWN, builtAt: null };
  }
  return cached;
}

/** Short identifier of the running build — the value stamped onto ledger rows. */
export function currentCodeVersion(): string {
  return buildInfo().codeVersion;
}

/** Test seam. Also lets a long-lived process pick up a redeploy if it ever needs to. */
export function resetBuildInfoCache(): void {
  cached = null;
}

export interface ArmCodeSpread {
  /** The config arm (knob fingerprint). */
  configHash: string;
  /** Distinct code versions observed within it, in first-seen order. */
  codeVersions: string[];
  n: number;
  /** True ⇒ this arm mixes ≥2 code regimes and cannot be read as a clean A/B. */
  mixed: boolean;
}

/**
 * Group records by config arm and report which code versions each contains.
 *
 * The point is not to split the arms automatically — with the current data that
 * would leave almost nothing comparable. It is to let a card or a verdict SAY
 * that an arm mixes code regimes, the same way `firstBackfilled` lets the
 * walk-forward card qualify its baseline. A number nobody can qualify is how
 * B53 survived for weeks. Pure.
 */
export function codeVersionSpread(
  records: readonly { configHash?: string | null; firstConfigHash?: string | null; codeVersion?: string | null }[],
): ArmCodeSpread[] {
  const byArm = new Map<string, { versions: string[]; n: number }>();
  for (const r of records ?? []) {
    const arm = (r?.firstConfigHash ?? r?.configHash) || "unlabeled";
    const ver = r?.codeVersion || "unlabeled";
    let e = byArm.get(arm);
    if (!e) { e = { versions: [], n: 0 }; byArm.set(arm, e); }
    e.n++;
    if (!e.versions.includes(ver)) e.versions.push(ver);
  }
  return [...byArm.entries()]
    .map(([configHash, e]) => ({
      configHash,
      codeVersions: e.versions,
      n: e.n,
      // "unlabeled" alongside a real version still counts as mixed: those rows
      // predate the stamp, so their code is genuinely unknown.
      mixed: e.versions.length > 1,
    }))
    .sort((a, b) => b.n - a.n);
}
