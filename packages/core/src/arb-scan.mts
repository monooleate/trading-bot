// packages/core/src/arb-scan.mts
//
// B81 — Polymarket logical-arbitrage arithmetic at EXECUTABLE prices. Pure,
// zero I/O.
//
//   · PARTITION — a negRisk event's outcomes are mutually exclusive and
//     exhaustive: buying every YES pays exactly 1/share, buying every NO pays
//     n−1/share.
//   · NESTED — A ⊆ B (e.g. "BTC above 110k" ⊆ "above 100k", "by Oct 31" ⊆
//     "by Dec 31"): YES(B) + NO(A) pays at least 1/share in every state.
//
// Prices are the CLOB book walked to the size (VWAP), never a mid or a
// last-trade print. A NO ask is the mirror of a YES bid (price 1 − p, same
// size). Taker fee per share = rate · p · (1 − p) at every filled level
// (docs.polymarket.com/trading/fees; charged in USDC).

export interface Level { price: number; size: number; }

export interface Fill {
  shares: number;
  cost: number;
  fee: number;
  /** false when the book is too thin for the requested size. */
  complete: boolean;
}

export function takerFeePerShare(p: number, rate: number): number {
  return rate * p * (1 - p);
}

/** Walk the asks (cheapest first) for q shares; fee charged per level. */
export function buyVwap(asks: Level[], q: number, feeRate: number): Fill {
  // An ask AT 1.00 is real (a decided-but-unresolved market) — dropping it would fake a free leg.
  const sorted = [...asks].filter((l) => l.size > 0 && l.price > 0 && l.price <= 1).sort((a, b) => a.price - b.price);
  let shares = 0, cost = 0, fee = 0;
  for (const l of sorted) {
    if (shares >= q) break;
    const take = Math.min(l.size, q - shares);
    shares += take;
    cost += take * l.price;
    fee += take * takerFeePerShare(l.price, feeRate);
  }
  return { shares, cost, fee, complete: shares >= q - 1e-9 };
}

/** NO asks implied by YES bids: a YES bid at p is a NO offer at 1 − p. */
export function mirrorAsks(yesBids: Level[]): Level[] {
  return yesBids.map((b) => ({ price: 1 - b.price, size: b.size }));
}

export interface Leg {
  yesAsks: Level[];
  yesBids: Level[];
  feeRate: number;
}

export interface ArbResult {
  shares: number;
  /** Price paid, fees excluded. */
  cost: number;
  fee: number;
  payout: number;
  /** payout − cost − fee. */
  profit: number;
  complete: boolean;
}

function combine(fills: Fill[], q: number, payoutPerShare: number): ArbResult {
  const cost = fills.reduce((s, f) => s + f.cost, 0);
  const fee = fills.reduce((s, f) => s + f.fee, 0);
  const complete = fills.every((f) => f.complete);
  const payout = q * payoutPerShare;
  return { shares: q, cost, fee, payout, profit: payout - cost - fee, complete };
}

/** Buy q YES of every outcome of a mutually exclusive, exhaustive set. */
export function partitionBuyYes(legs: Leg[], q: number): ArbResult {
  return combine(legs.map((l) => buyVwap(l.yesAsks, q, l.feeRate)), q, 1);
}

/** Buy q NO of every outcome: exactly one YES wins, so n−1 NOs pay. */
export function partitionBuyNo(legs: Leg[], q: number): ArbResult {
  return combine(legs.map((l) => buyVwap(mirrorAsks(l.yesBids), q, l.feeRate)), q, legs.length - 1);
}

/** A ⊆ B: buy q YES(B) + q NO(A); pays ≥ 1/share in every state. */
export function nestedArb(subset: Leg, superset: Leg, q: number): ArbResult {
  return combine([buyVwap(superset.yesAsks, q, superset.feeRate), buyVwap(mirrorAsks(subset.yesBids), q, subset.feeRate)], q, 1);
}

// ── Ladder detection ────────────────────────────────────────────────────────

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const DATE_RE = new RegExp(`\\b(${MONTHS.join("|")})\\s+(\\d{1,2})(?:,?\\s*(\\d{4}))?\\b`, "i");
const NUM_RE = /(-?)\$?(\d[\d,]*(?:\.\d+)?)\s*([kmb])?\b/i;

/**
 * A ladder rung from a market's group title: the date or first number as a
 * sortable value, and a template = the market's QUESTION with that token
 * replaced (falling back to the title when the question lacks it). The
 * question matters: Polymarket labels both teams' spread markets "Spread
 * −3.5" — only the question ("Spread: Lakers (−3.5)") says whose (B81).
 * Null when the title carries neither a date nor a number.
 */
export function parseRung(title: string, question = ""): { template: string; value: number } | null {
  const t = title.trim();
  const keyed = (raw: string, placeholder: string) =>
    question && question.includes(raw) ? question.replace(raw, placeholder) : t.replace(raw, placeholder);
  const d = DATE_RE.exec(t);
  if (d) {
    const month = MONTHS.indexOf(d[1].toLowerCase()) + 1;
    const year = d[3] ? Number(d[3]) : 0;
    return { template: keyed(d[0], "{D}"), value: year * 10_000 + month * 100 + Number(d[2]) };
  }
  const n = NUM_RE.exec(t);
  if (n) {
    const mult = { k: 1e3, m: 1e6, b: 1e9 }[(n[3] ?? "").toLowerCase() as "k" | "m" | "b"] ?? 1;
    const value = (n[1] === "-" ? -1 : 1) * Number(n[2].replace(/,/g, "")) * mult;
    if (!Number.isFinite(value)) return null;
    return { template: keyed(n[0].trim(), "{N}"), value };
  }
  return null;
}

function ranks(xs: number[]): number[] {
  const idx = xs.map((x, i) => ({ x, i })).sort((a, b) => a.x - b.x);
  const r = new Array(xs.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1].x === idx[i].x) j++;
    for (let k = i; k <= j; k++) r[idx[k].i] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}

/** Spearman rank correlation (average ranks for ties); 0 when degenerate. */
export function spearman(xs: number[], ys: number[]): number {
  const rx = ranks(xs), ry = ranks(ys);
  const n = xs.length;
  const mx = rx.reduce((s, x) => s + x, 0) / n, my = ry.reduce((s, x) => s + x, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (rx[i] - mx) * (ry[i] - my);
    sxx += (rx[i] - mx) ** 2;
    syy += (ry[i] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}

/**
 * Does a LARGER rung value make the event narrower (+1) or wider (−1)? From
 * the template's wording; 0 when unknown or contradictory (the ladder is then
 * skipped). Mid prices are NOT used for the direction: thin rungs with empty
 * books carry junk mids that flipped a real ladder in the B81 third scan.
 */
export function rungDirection(template: string): 1 | -1 | 0 {
  const t = template.toLowerCase();
  if (t.includes("{d}")) {
    const later = /\b(by|before)\b/.test(t) ? -1 : 0;           // "by <date>": later = wider
    const holds = /\b(through|continues?|until|remains?|still)\b/.test(t) ? 1 : 0; // "through <date>": later = narrower
    return later && holds ? 0 : ((later || holds) as 1 | -1 | 0);
  }
  if (/\bspread\b/.test(t)) return -1;                            // −1.5 is wider than −2.5
  // "reach 2.75% or lower" — the qualifier decides, whatever verb precedes it.
  const orDown = /\bor (lower|less|below|fewer)\b/.test(t), orUp = /\bor (higher|more|above|greater)\b/.test(t);
  if (orDown !== orUp) return orDown ? -1 : 1;
  const up = /\b(above|reach|exceed|greater than|more than|at least)\b|o\/u|↑/.test(t);
  const down = /\b(below|dip|drop to|fall to|less than|fewer than|at most)\b|↓/.test(t);
  return up && !down ? 1 : down && !up ? -1 : 0;
}

export interface Rung<T> {
  value: number;
  mid: number;
  /** Book is tight enough (ask − bid small) for its mid to mean something. */
  tight: boolean;
  item: T;
}

/**
 * Nested pairs of a ladder whose direction is given (see rungDirection). A
 * sanity check only: when ≥ 3 tight-book rungs order STRONGLY against the
 * stated direction (|ρ| ≥ minRho, wrong sign), the ladder is skipped as a
 * probable template misread. Null for < 3 rungs or an unknown direction.
 */
export function ladderPairs<T>(rungs: Rung<T>[], direction: 1 | -1 | 0, minRho = 0.8): Array<{ subset: Rung<T>; superset: Rung<T> }> | null {
  if (rungs.length < 3 || direction === 0) return null;
  const tight = rungs.filter((r) => r.tight);
  if (tight.length >= 3) {
    const rho = spearman(tight.map((r) => r.value), tight.map((r) => r.mid));
    // direction +1 (larger = narrower) predicts ρ < 0.
    if (rho * direction >= minRho) return null;
  }
  const out: Array<{ subset: Rung<T>; superset: Rung<T> }> = [];
  for (const a of rungs) {
    for (const b of rungs) {
      if (a.value === b.value) continue;
      const aNarrower = direction === 1 ? a.value > b.value : a.value < b.value;
      if (aNarrower) out.push({ subset: a, superset: b });
    }
  }
  return out;
}
