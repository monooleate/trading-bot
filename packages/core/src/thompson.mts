// packages/core/src/thompson.mts
//
// Discounted Thompson-sampling config selector — model-discovery-training §3.C /
// #6 (+ #8 forgetting factor), sprints.md B50. Pure, portable (zero I/O).
//
// WHY: the discovery's single genuinely-new adaptive technique. The system picks
// among discrete configs (which preset / whether a knob helps) under uncertainty
// with delayed, noisy reward — a bandit problem, not a supervised one. Thompson
// sampling is the sound, sample-efficient answer: keep a Beta posterior per config
// over "does this config's forecast beat the market?", DISCOUNT old evidence
// (non-stationarity — #8's forgetting factor), and rank configs by the posterior
// probability each is best. Rewarded on a PROPER-SCORE-derived Bernoulli (model
// Brier < market Brier), never raw PnL — lower variance, harder to game.
//
// This is the "bandit PROPOSES" half: a measurement that ranks configs + reports
// the winner and the confidence. Auto-applying the winner (champion-challenger
// live loop, bounded, never touching risk limits) is a gated follow-up. It reuses
// the #4 config fingerprints as the arms, so it becomes sharper as config-labelled
// ledger data accumulates.
//
// Determinism: a fixed-seed LCG drives Box–Muller normals → Marsaglia–Tsang gamma
// → Beta samples, so prob-best is reproducible across runs (like the bootstrap CI).

// ─── #8: shared forgetting factor ────────────────────────────────────────────
/** Exponential recency weight 0.5^(age/halfLife). halfLife ≤ 0 → 1 (no decay).
 *  The one decay primitive shared by the bandit (and, as adopted, Platt / IC). */
export function forgettingWeight(ageSteps: number, halfLifeSteps: number): number {
  if (!(halfLifeSteps > 0)) return 1;
  return Math.pow(0.5, Math.max(0, ageSteps) / halfLifeSteps);
}

// ─── Deterministic RNG + Beta sampler ────────────────────────────────────────
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };
}
function normal(rng: () => number): number {
  const u1 = Math.max(1e-12, rng()), u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
/** Marsaglia–Tsang gamma sample, shape ≥ 1, scale 1. (Posteriors are Beta(≥1,≥1)
 *  from the Beta(1,1) prior, so shape < 1 never occurs.) Pure given `rng`. */
function gammaSample(shape: number, rng: () => number): number {
  const a = Math.max(1, shape);
  const d = a - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let i = 0; i < 200; i++) {
    let x: number, v: number;
    do { x = normal(rng); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
  return d; // fallback (extremely rare)
}
function betaSample(alpha: number, beta: number, rng: () => number): number {
  const ga = gammaSample(alpha, rng);
  const gb = gammaSample(beta, rng);
  return ga + gb > 0 ? ga / (ga + gb) : 0.5;
}

// ─── Posteriors + ranking ────────────────────────────────────────────────────
export interface BanditArm {
  arm: string;
  rewards: { reward: number; age: number }[];   // reward 0/1; age in steps (0 = newest)
}
export interface ArmPosterior {
  arm: string;
  alpha: number;
  beta: number;
  mean: number;     // posterior mean rate
  nEff: number;     // effective sample size Σ weight
  nRaw: number;     // raw reward count
  probBest: number; // Thompson: P(this arm's true rate is the highest)
}

/** Discounted Beta(1+Σw·r, 1+Σw·(1−r)) posteriors per arm. Pure. */
export function betaPosteriors(arms: BanditArm[], halfLifeSteps: number): Omit<ArmPosterior, "probBest">[] {
  return (arms ?? []).map((a) => {
    let sPos = 0, sNeg = 0, w = 0, nRaw = 0;
    for (const r of a.rewards ?? []) {
      if (r.reward !== 0 && r.reward !== 1) continue;
      const wt = forgettingWeight(r.age, halfLifeSteps);
      if (r.reward === 1) sPos += wt; else sNeg += wt;
      w += wt; nRaw++;
    }
    const alpha = 1 + sPos, beta = 1 + sNeg;
    return { arm: a.arm, alpha, beta, mean: alpha / (alpha + beta), nEff: w, nRaw };
  });
}

/**
 * Rank configs by Thompson prob-best: draw `samples` joint samples from each arm's
 * Beta posterior and count how often each arm is the max. Deterministic (seeded).
 * Returns posteriors + probBest, sorted by probBest desc. Pure.
 */
export function thompsonRank(
  arms: BanditArm[],
  opts: { halfLifeSteps?: number; samples?: number; seed?: number } = {},
): ArmPosterior[] {
  const halfLifeSteps = opts.halfLifeSteps ?? 75;
  const samples = Math.max(200, opts.samples ?? 2000);
  const post = betaPosteriors(arms, halfLifeSteps);
  const k = post.length;
  if (k === 0) return [];
  if (k === 1) return [{ ...post[0], probBest: 1 }];

  const rng = lcg((opts.seed ?? 12345) >>> 0);
  const wins = new Array(k).fill(0);
  for (let s = 0; s < samples; s++) {
    let bestIdx = 0, bestVal = -Infinity;
    for (let i = 0; i < k; i++) {
      const draw = betaSample(post[i].alpha, post[i].beta, rng);
      if (draw > bestVal) { bestVal = draw; bestIdx = i; }
    }
    wins[bestIdx]++;
  }
  return post
    .map((p, i) => ({ ...p, probBest: Math.round((wins[i] / samples) * 1e4) / 1e4 }))
    .sort((a, b) => b.probBest - a.probBest);
}

/**
 * Build bandit arms from config-attributed ledger records: group resolved
 * predictions by configHash, reward = model beat the market (Brier lower), age =
 * chronological rank from the newest resolved prediction (0 = newest). Pure.
 */
export function banditArmsFromRecords(
  records: Array<{
    configHash?: string | null;
    predictedProb?: unknown; marketPrice?: unknown; outcome?: unknown; resolvedAt?: unknown;
  }>,
): BanditArm[] {
  const rows: { key: string; reward: number; t: number }[] = [];
  for (const r of records ?? []) {
    if (r?.outcome === null || r?.outcome === undefined) continue;
    const y = Number(r.outcome);
    if (y !== 0 && y !== 1) continue;
    const p = Number(r.predictedProb), m = Number(r.marketPrice);
    if (!Number.isFinite(p) || p < 0 || p > 1) continue;
    if (!Number.isFinite(m) || m <= 0 || m >= 1) continue;
    const t = Date.parse(String(r.resolvedAt ?? ""));
    const brierModel = (p - y) ** 2, brierMarket = (m - y) ** 2;
    rows.push({
      key: (typeof r.configHash === "string" && r.configHash) ? r.configHash : "unlabeled",
      reward: brierModel < brierMarket ? 1 : 0,
      t: Number.isFinite(t) ? t : 0,
    });
  }
  // Chronological age: newest resolved = 0. Rows without a time sort last (oldest).
  rows.sort((a, b) => b.t - a.t);
  const byArm = new Map<string, { reward: number; age: number }[]>();
  rows.forEach((row, age) => {
    if (!byArm.has(row.key)) byArm.set(row.key, []);
    byArm.get(row.key)!.push({ reward: row.reward, age });
  });
  return [...byArm.entries()].map(([arm, rewards]) => ({ arm, rewards }));
}
