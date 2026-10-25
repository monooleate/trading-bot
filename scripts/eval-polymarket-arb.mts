#!/usr/bin/env bun
// B81 — do Polymarket logical arbitrages survive at EXECUTABLE prices?
//
// Pre-registered in internal-docs/roadmap/sprints.md B81 before the first run.
// One run = one scan; the verdict needs 3 scans ≥ 2 h apart.
//
//   · PARTITION: negRisk (not augmented) events, every sub-market open —
//     buy-all-YES (pays 1) and buy-all-NO (pays n−1).
//   · LADDER: ≥ 3 sub-markets of a NON-negRisk event sharing a title template
//     with a number/date; direction from the template wording (rungDirection), tight-book mids only veto;
//     every nested pair: YES(wider) + NO(narrower) pays ≥ 1.
//
// Gamma best quotes give an upper bound (top of book); only candidates within
// 2¢/share of break-even get their CLOB books fetched and walked (VWAP + taker
// fee per level). Reference, not verdict: how many of the same pairs violate
// on MID prices (what the condprob tab sees).
//
// Run LOCALLY:  npx tsx scripts/eval-polymarket-arb.mts
// Read-only public GETs/POSTs (Gamma events, CLOB /books). No orders, no box.

import {
  partitionBuyYes,
  partitionBuyNo,
  nestedArb,
  parseRung,
  ladderPairs,
  rungDirection,
  type Leg,
  type Level,
  type ArbResult,
} from "@core/arb-scan.mts";

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const SIZES = [10, 100, 1000];
const COUNT_SIZE = 100;
const MIN_EDGE = 0.005;      // net profit / outlay at COUNT_SIZE
const MIN_ANNUAL = 0.20;     // annualised to the event's endDate
const PREFILTER = -0.02;     // fetch books when the top-of-book bound is within 2¢/share

interface Mkt {
  slug: string;
  question: string;
  title: string;
  yesToken: string;
  bestAsk: number;
  bestBid: number;
  mid: number;
  feeRate: number;
  /** The market's own deadline — orders a date ladder (titles omit the year). */
  endMs: number;
}
interface Ev { slug: string; endMs: number; negRisk: boolean; augmented: boolean; markets: Mkt[]; allOpen: boolean; }

const num = (x: unknown) => (typeof x === "number" ? x : parseFloat(String(x ?? "")));

async function fetchEvents(): Promise<Ev[]> {
  const out: Ev[] = [];
  // Offset paging caps out around 2 000 events (HTTP 422); the keyset endpoint walks them all.
  let cursor = "";
  for (let pageNo = 0; pageNo < 500; pageNo++) {
    const res = await fetch(`${GAMMA}/events/keyset?active=true&closed=false&limit=100${cursor ? `&after_cursor=${encodeURIComponent(cursor)}` : ""}`,
      { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Gamma events/keyset HTTP ${res.status} @page ${pageNo}`);
    const body = await res.json() as { events?: any[]; next_cursor?: string };
    const page = body.events ?? [];
    if (page.length === 0) break;
    cursor = body.next_cursor ?? "";
    for (const e of page) {
      const raw: any[] = Array.isArray(e.markets) ? e.markets : [];
      const open = (m: any) => m.active !== false && m.closed !== true && m.acceptingOrders !== false && m.enableOrderBook !== false;
      const markets: Mkt[] = [];
      for (const m of raw.filter(open)) {
        let tokens: string[] = [];
        try { tokens = typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : m.clobTokenIds ?? []; } catch { /* skip */ }
        if (!tokens[0]) continue;
        const bestAsk = num(m.bestAsk), bestBid = num(m.bestBid);
        const mid = Number.isFinite(bestAsk) && Number.isFinite(bestBid) && bestAsk > 0 && bestBid > 0 ? (bestAsk + bestBid) / 2 : num(m.lastTradePrice);
        const sched = typeof m.feeSchedule === "string" ? (() => { try { return JSON.parse(m.feeSchedule); } catch { return null; } })() : m.feeSchedule;
        markets.push({
          slug: m.slug ?? "", question: m.question ?? "", title: (m.groupItemTitle ?? "").trim(),
          yesToken: tokens[0], bestAsk, bestBid, mid,
          feeRate: m.feesEnabled ? num(sched?.rate) || 0 : 0,
          endMs: Date.parse(m.endDate ?? ""),
        });
      }
      out.push({
        slug: e.slug ?? "", endMs: Date.parse(e.endDate ?? ""), negRisk: e.negRisk === true,
        augmented: e.negRiskAugmented === true, markets, allOpen: raw.length > 0 && raw.every(open) && markets.length === raw.length,
      });
    }
    if (!cursor) break;
  }
  return out;
}

async function fetchBooks(tokens: string[]): Promise<Map<string, { asks: Level[]; bids: Level[] }>> {
  const out = new Map<string, { asks: Level[]; bids: Level[] }>();
  const uniq = [...new Set(tokens)];
  for (let i = 0; i < uniq.length; i += 50) {
    const res = await fetch(`${CLOB}/books`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(uniq.slice(i, i + 50).map((token_id) => ({ token_id }))),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`CLOB /books HTTP ${res.status}`);
    const parse = (arr: any[]): Level[] => (arr ?? []).map((l) => ({ price: num(l.price), size: num(l.size) }))
      .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.size > 0);
    for (const b of await res.json() as any[]) out.set(b.asset_id, { asks: parse(b.asks), bids: parse(b.bids) });
  }
  return out;
}

// ── scan ────────────────────────────────────────────────────────────────────
const t0 = Date.now();
const events = await fetchEvents();
const days = (e: Ev) => Math.max(1, (Number.isFinite(e.endMs) ? e.endMs - t0 : 0) / 86_400_000);

interface Cand { family: "PARTITION-YES" | "PARTITION-NO" | "LADDER"; ev: Ev; legs: Mkt[]; bound: number; label: string; }
const cands: Cand[] = [];
let partitions = 0, ladders = 0, pairs = 0, midPartition = 0, midLadder = 0;

for (const ev of events) {
  if (ev.negRisk) {
    if (ev.augmented || !ev.allOpen || ev.markets.length < 2) continue;
    if (!ev.markets.every((m) => Number.isFinite(m.bestAsk) && Number.isFinite(m.bestBid))) continue;
    partitions++;
    const n = ev.markets.length;
    const sumMid = ev.markets.reduce((s, m) => s + m.mid, 0);
    if (Math.abs(sumMid - 1) > 0.025) midPartition++;
    const yesBound = (1 - ev.markets.reduce((s, m) => s + m.bestAsk, 0)) / n;
    const noBound = (ev.markets.reduce((s, m) => s + m.bestBid, 0) - 1) / n;
    if (yesBound > PREFILTER) cands.push({ family: "PARTITION-YES", ev, legs: ev.markets, bound: yesBound, label: `${n} kimenet` });
    if (noBound > PREFILTER) cands.push({ family: "PARTITION-NO", ev, legs: ev.markets, bound: noBound, label: `${n} kimenet` });
    continue;
  }
  const groups = new Map<string, Array<{ value: number; mid: number; tight: boolean; item: Mkt }>>();
  for (const m of ev.markets) {
    const r = parseRung(m.title, m.question);
    if (!r || !Number.isFinite(m.mid)) continue;
    // One event can hold an ↑ and a ↓ ladder under the same question wording — the arrow lives only in the title.
    const arrow = m.title.includes("↑") ? " ↑" : m.title.includes("↓") ? " ↓" : "";
    const key = r.template + arrow;
    if (!groups.has(key)) groups.set(key, []);
    const tight = Number.isFinite(m.bestAsk) && Number.isFinite(m.bestBid) && m.bestBid > 0 && m.bestAsk - m.bestBid <= 0.05;
    // "March 31" after "October 31" is next year: a date rung sorts by its market's own deadline.
    const value = r.template.includes("{D}") && Number.isFinite(m.endMs) ? m.endMs : r.value;
    groups.get(key)!.push({ value, mid: m.mid, tight, item: m });
  }
  for (const [template, rungs] of groups) {
    const ps = ladderPairs(rungs, rungDirection(template));
    if (!ps) continue;
    ladders++;
    for (const { subset, superset } of ps) {
      pairs++;
      if (subset.mid - superset.mid > 0.03) midLadder++;
      const bound = subset.item.bestBid - superset.item.bestAsk; // NO(sub) ask = 1 − bid; YES(sup) ask
      if (Number.isFinite(bound) && bound > PREFILTER) {
        cands.push({ family: "LADDER", ev, legs: [subset.item, superset.item], bound,
          label: `${template}: ${subset.item.title} ⊆ ${superset.item.title}` });
      }
    }
  }
}

const books = await fetchBooks(cands.flatMap((c) => c.legs.map((m) => m.yesToken)));
const toLeg = (m: Mkt): Leg => ({ yesAsks: books.get(m.yesToken)?.asks ?? [], yesBids: books.get(m.yesToken)?.bids ?? [], feeRate: m.feeRate });
const evaluate = (c: Cand, q: number): ArbResult => {
  const legs = c.legs.map(toLeg);
  if (c.family === "PARTITION-YES") return partitionBuyYes(legs, q);
  if (c.family === "PARTITION-NO") return partitionBuyNo(legs, q);
  return nestedArb(legs[0], legs[1], q);
};

interface Row { c: Cand; bySize: ArbResult[]; edge: number; annual: number; counts: boolean; }
const rows: Row[] = cands.map((c) => {
  const bySize = SIZES.map((q) => evaluate(c, q));
  const r = bySize[SIZES.indexOf(COUNT_SIZE)];
  const outlay = r.cost + r.fee;
  const edge = outlay > 0 ? r.profit / outlay : -1;
  const annual = edge * 365 / days(c.ev);
  return { c, bySize, edge, annual, counts: r.complete && edge >= MIN_EDGE && annual >= MIN_ANNUAL };
});

// ── report ──────────────────────────────────────────────────────────────────
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const usd = (x: number) => `${x >= 0 ? "+" : "−"}$${Math.abs(x).toFixed(2)}`;
console.log(`B81 szkennelés ${new Date(t0).toISOString()} — ${events.length} aktív esemény (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
console.log(`Partíció: ${partitions} esemény · középáron |Σ−1| > 2,5¢: ${midPartition}`);
console.log(`Létra: ${ladders} létra, ${pairs} beágyazott pár · középáron > 3¢ sértés: ${midLadder}`);
console.log(`Könyv-lekérésre jelölt (top-of-book korlát > −2¢/részvény): ${cands.length}`);

const families = ["PARTITION-YES", "PARTITION-NO", "LADDER"] as const;
for (const f of families) {
  const fr = rows.filter((r) => r.c.family === f);
  const pos = SIZES.map((q, i) => fr.filter((r) => r.bySize[i].complete && r.bySize[i].profit > 0).length);
  console.log(`  ${f.padEnd(14)} jelölt ${String(fr.length).padStart(4)} · nyereséges díj után q=${SIZES.join("/")}: ${pos.join("/")} · SZÁMÍT: ${fr.filter((r) => r.counts).length}`);
}

const shown = rows.filter((r) => { const x = r.bySize[SIZES.indexOf(COUNT_SIZE)]; return x.complete && x.profit > 0; }).sort((a, b) => b.edge - a.edge).slice(0, 25);
if (shown.length) {
  console.log(`\nNyereséges q=${COUNT_SIZE}-nál (legfeljebb 25):`);
  for (const r of shown) {
    const x = r.bySize[SIZES.indexOf(COUNT_SIZE)];
    console.log(`  ${r.counts ? "✔" : " "} ${r.c.family.padEnd(13)} ${r.c.ev.slug.slice(0, 50).padEnd(50)} ${usd(x.profit).padStart(8)} / $${(x.cost + x.fee).toFixed(2)} díj $${x.fee.toFixed(2)} · ${pct(r.edge)} · ${days(r.c.ev).toFixed(0)} nap · évesítve ${pct(r.annual)} · ${r.c.label.slice(0, 70)}`);
  }
}
const counted = rows.filter((r) => r.counts);
console.log(`\nÖSSZEGZÉS: ${counted.length} számító arb, ${new Set(counted.map((r) => r.c.ev.slug)).size} különböző eseményen` +
  ` (szabály: nettó ≥ ${pct(MIN_EDGE)} q=${COUNT_SIZE}-nál és évesítve ≥ ${pct(MIN_ANNUAL)}).`);
console.log(`SUMMARY_JSON ${JSON.stringify({ ts: new Date(t0).toISOString(), events: events.length, partitions, ladders, pairs, midPartition, midLadder, candidates: cands.length, counted: counted.length, countedEvents: [...new Set(counted.map((r) => r.c.ev.slug))] })}`);
