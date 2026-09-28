#!/usr/bin/env bun
// B76 — does the weather bot beat the MARKET, on the B69 σ chain?
//
// The B69 read-outs scored forecasts against the OBSERVED daily max. The bot
// only makes money if its bucket probabilities beat the market's PRICES. This
// scores the whole bucket distribution against the market's price vector at
// the same moment, bucket-selection-free:
//
//   · every (station, date, lead-day) sample of the multi-model log (the latest
//     snapshot in the bucket, lead 0–48 h) — the same samples as B69;
//   · the event's buckets + resolution from Gamma (the winning bucket = the
//     sub-market that resolved YES);
//   · each bucket's YES price at the snapshot time from CLOB prices-history
//     (hourly; the last point at or before the snapshot), normalised to sum 1;
//   · the bot's bucket probabilities from its own `matchBucket` on the chain
//     under test, with calibrations fitted ONLY on dates before the sample
//     (expanding window — as the live hourly refit would have seen them).
//
// Why not the prediction ledger: its `conditionId` is overwritten on every
// rescan (prediction-ledger.mts upsertRecords) while the first-sighting
// probability/price stay latched — when the bot's chosen bucket changed
// between scans, the first-sighting probability is scored against another
// bucket's outcome. The ledger-based "−61% vs market" is not clean evidence.
//
// Run ON THE BOX:  docker exec edgecalc-workers bun scripts/eval-weather-vs-market.ts
// Read-only (public Gamma + CLOB GETs, blob reads). Writes nothing.

import { pool } from "@core/db.ts";
import { setBlobsDb, getStore } from "@core/blobs-compat.ts";
import { emosApply, fitEmos, type EmosFit } from "@core/emos.mts";
import { inflateSigma } from "@core/weather-dispersion.mts";
import { fitPooledEmos, applyPooledEmos, type PooledCalibrationInput } from "@core/pooled-emos.mts";
import { SETTLEMENT_STATIONS, getStation } from "@worker/pillars/weather/station-config.mts";
import { loadSnapshots, type MultiModelSnapshot } from "@worker/pillars/weather/multi-model-store.mts";
import { correctForecast } from "@worker/pillars/weather/metar-simulator.mts";
import { matchBucket } from "@worker/pillars/weather/bucket-matcher.mts";
import { parseCityFromSlug, parseDateFromSlug, parseTempFromLabel, type TemperatureBucket } from "@worker/pillars/weather/market-finder.mts";

setBlobsDb(await pool());

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const GEFS_LAMBDA = 1.25;
const MULTI_LAMBDA = 1.0;
const AS_WAS_LAMBDA = 2.25;
const TRADE_THRESHOLD = 0.12 + 0.01; // weather edgeThreshold + roundtrip fee

async function getJson(url: string, tries = 3): Promise<any> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (r.status === 429) { await Bun.sleep(1500 * (i + 1)); continue; }
      if (!r.ok) return null;
      return await r.json();
    } catch { await Bun.sleep(500 * (i + 1)); }
  }
  return null;
}

// ── 1. Event slugs the bot actually scanned (from the ledger) ───────────────
const ledgerRaw = await getStore("prediction-ledger").get("ledger-weather");
const ledger: any[] = ledgerRaw ? JSON.parse(ledgerRaw as string) : [];
const eventSlug = new Map<string, string>(); // `${icao}|${date}` → slug
for (const row of ledger) {
  const slug = String(row.slug ?? "");
  const city = parseCityFromSlug(slug);
  const date = parseDateFromSlug(slug);
  const st = city ? getStation(city) : null;
  if (st && date) eventSlug.set(`${st.icao}|${date}`, slug);
}

// ── 2. Multi-model samples (same selection as B69) ──────────────────────────
interface Sample { icao: string; date: string; ts: number; snap: MultiModelSnapshot }
const icaos = [...new Set(Object.values(SETTLEMENT_STATIONS).map((s) => s.icao))].sort();
const samples: Sample[] = [];
const pooledInputs: PooledCalibrationInput[] = [];
for (const icao of icaos) {
  const snaps = await loadSnapshots(icao).catch(() => []);
  for (const s of snaps) {
    pooledInputs.push({ station: icao, ts: s.ts, date: s.date, leadHours: s.leadHours, mean: s.pooledMean, sd: s.pooledSd, obs: s.obs });
  }
  const last = new Map<string, MultiModelSnapshot>();
  for (const s of snaps) {
    if (s.obs === null || s.leadHours < 0 || s.leadHours > 48 || s.baseMean === null || s.baseSd === null) continue;
    const k = `${s.date}|${Math.floor(s.leadHours / 24)}`;
    const p = last.get(k);
    if (!p || s.ts > p.ts) last.set(k, s);
  }
  for (const s of last.values()) samples.push({ icao, date: s.date, ts: s.ts, snap: s });
}

// ── 3. Events + price histories ─────────────────────────────────────────────
interface EventData { buckets: TemperatureBucket[]; winner: string | null; history: Map<string, { t: number; p: number }[]> }
const events = new Map<string, EventData | null>();
let noSlug = 0, noEvent = 0, unresolved = 0;

const byStationDay = new Map<string, Sample[]>();
for (const s of samples) {
  const k = `${s.icao}|${s.date}`;
  (byStationDay.get(k) ?? byStationDay.set(k, []).get(k)!).push(s);
}

for (const [k, group] of byStationDay) {
  const slug = eventSlug.get(k);
  if (!slug) { noSlug++; events.set(k, null); continue; }
  const ev = (await getJson(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`))?.[0];
  if (!ev?.markets?.length) { noEvent++; events.set(k, null); continue; }
  const buckets: TemperatureBucket[] = [];
  let winner: string | null = null;
  for (const m of ev.markets) {
    const label = m.groupItemTitle || "";
    const parsed = parseTempFromLabel(label);
    let ids: string[] = [];
    try { ids = typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : m.clobTokenIds ?? []; } catch {}
    let op: number[] = [];
    try { op = (typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices ?? []).map(Number); } catch {}
    if (!label || !parsed || !ids[0]) continue;
    if (op[0] === 1) winner = label;
    buckets.push({ label, tokenId: ids[0], noTokenId: ids[1] ?? "", conditionId: m.conditionId ?? "", currentPrice: 0, tempC: parsed.tempC, tail: parsed.tail });
  }
  if (!winner) { unresolved++; events.set(k, null); continue; }
  const t0 = Math.floor(Math.min(...group.map((s) => s.ts)) / 1000) - 3 * 3600;
  const t1 = Math.floor(Math.max(...group.map((s) => s.ts)) / 1000) + 600;
  const history = new Map<string, { t: number; p: number }[]>();
  for (const b of buckets) {
    const h = await getJson(`${CLOB}/prices-history?market=${b.tokenId}&startTs=${t0}&endTs=${t1}&fidelity=60`);
    history.set(b.label, Array.isArray(h?.history) ? h.history : []);
    await Bun.sleep(60);
  }
  events.set(k, { buckets, winner, history });
}

// ── 4. GEFS station-EMOS residuals (for the out-of-sample refit) ────────────
const emosRes = new Map<string, any[]>();
const emosLiveParams = new Map<string, EmosFit | null>();
for (const icao of icaos) {
  try {
    const raw = await getStore("weather-emos").get(`v1:${icao}`);
    const p = raw ? JSON.parse(raw as string) : null;
    emosRes.set(icao, p?.residuals ?? []);
    emosLiveParams.set(icao, p?.params ?? null);
  } catch { emosRes.set(icao, []); }
}

// ── 5. Score ────────────────────────────────────────────────────────────────
type Dist = Map<string, number>;
function modelDist(buckets: TemperatureBucket[], mu: number, sigma: number): Dist | null {
  const m = matchBucket(mu, buckets, sigma);
  if (!m) return null;
  return new Map(m.allProbs.map((x) => [x.label, x.prob]));
}
const brier = (d: Dist, labels: string[], win: string) => labels.reduce((s, l) => s + ((d.get(l) ?? 0) - (l === win ? 1 : 0)) ** 2, 0);
const logs = (d: Dist, win: string) => -Math.log(Math.max(0.001, d.get(win) ?? 0));

interface Row { k: string; leadDay: number; localHour: number; brier: Record<string, number>; log: Record<string, number>; trades: Record<string, number[]> }
const rows: Row[] = [];
const days = [...new Set(samples.map((s) => s.date))].sort();
let noPrice = 0;

for (const d of days) {
  const pooledModel = fitPooledEmos(pooledInputs.filter((x) => x.date < d), { transformMean: (m) => correctForecast(m, 0) });
  for (const s of samples.filter((x) => x.date === d)) {
    const ev = events.get(`${s.icao}|${s.date}`);
    if (!ev) continue;
    // Market distribution at the snapshot time.
    const tSec = Math.floor(s.ts / 1000);
    const priced: TemperatureBucket[] = [];
    let ok = true;
    for (const b of ev.buckets) {
      const pts = (ev.history.get(b.label) ?? []).filter((p) => p.t <= tSec && p.t >= tSec - 3 * 3600);
      if (!pts.length) { ok = false; break; }
      priced.push({ ...b, currentPrice: pts[pts.length - 1].p });
    }
    if (!ok) { noPrice++; continue; }
    const tot = priced.reduce((a, b) => a + b.currentPrice, 0);
    if (!(tot > 0.5)) { noPrice++; continue; }
    const market: Dist = new Map(priced.map((b) => [b.label, b.currentPrice / tot]));
    const labels = priced.map((b) => b.label);

    // GEFS + station EMOS refit on residuals before d (seed 0.1) × 1.25.
    const res = (emosRes.get(s.icao) ?? []).filter((x: any) => x.obs !== null && (x.seed || x.date < d));
    const gfit = fitEmos(res.map((x: any) => ({ ensMean: x.ensMean, ensStd: x.ensStd, obs: x.obs, ...(x.seed ? { weight: 0.1 } : {}) })), { minSamples: 20, varFloor: 0.25 });
    const g0 = correctForecast(s.snap.baseMean!, 0), gs0 = Math.max(0.5, s.snap.baseSd!);
    const gc = gfit.fitted ? emosApply(gfit, g0, gs0, gfit.varFloor) : { mu: g0, sigma: gs0 };
    // As-was (approx.): stored live params × 2.25 — what the bot ran in this window.
    const lp = emosLiveParams.get(s.icao);
    const ac = lp?.fitted ? emosApply(lp, g0, gs0, lp.varFloor) : { mu: g0, sigma: gs0 };
    // Pooled mixture + its own calibration (fit < d) × 1.0.
    const pc = applyPooledEmos(pooledModel, s.icao, correctForecast(s.snap.pooledMean, 0), Math.max(0.5, s.snap.pooledSd));

    const dists: Record<string, Dist | null> = {
      market,
      asWas: modelDist(priced, ac.mu, inflateSigma(ac.sigma, AS_WAS_LAMBDA)),
      gefs: modelDist(priced, gc.mu, inflateSigma(gc.sigma, GEFS_LAMBDA)),
      pooled: pooledModel.fit.fitted ? modelDist(priced, pc.mu, inflateSigma(pc.sigma, MULTI_LAMBDA)) : null,
    };
    if (!dists.gefs || !dists.pooled || !dists.asWas) continue;
    // 50/50 linear pool of model and market: does the model ADD information?
    dists.blend = new Map(labels.map((l) => [l, 0.5 * (dists.pooled!.get(l) ?? 0) + 0.5 * market.get(l)!]));

    const tz = Object.values(SETTLEMENT_STATIONS).find((x) => x.icao === s.icao)?.tz ?? "UTC";
    const localHour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: tz }).format(new Date(s.ts)));
    const row: Row = { k: `${s.icao}|${s.date}`, leadDay: Math.floor(s.snap.leadHours / 24), localHour, brier: {}, log: {}, trades: {} };
    for (const [name, dist] of Object.entries(dists)) {
      row.brier[name] = brier(dist!, labels, ev.winner!);
      row.log[name] = logs(dist!, ev.winner!);
    }
    // Hypothetical trades at the (mid) price, per $1 staked, for each model:
    // YES when p − price ≥ threshold, NO when price − p ≥ threshold.
    for (const name of ["asWas", "gefs", "pooled"]) {
      const out: number[] = [];
      for (const b of priced) {
        const p = dists[name]!.get(b.label) ?? 0, price = b.currentPrice, y = b.label === ev.winner ? 1 : 0;
        if (price <= 0.01 || price >= 0.99) continue;
        if (p - price >= TRADE_THRESHOLD) out.push((y - price) / price);
        else if (price - p >= TRADE_THRESHOLD) out.push(((1 - y) - (1 - price)) / (1 - price));
      }
      row.trades[name] = out;
    }
    rows.push(row);
  }
}

// ── 6. Report ───────────────────────────────────────────────────────────────
const clusters = [...new Set(rows.map((r) => r.k))];
function clusterBoot(metric: (rs: Row[]) => number, iters = 2000): [number, number] {
  let seed = 4242;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const byK = new Map(clusters.map((k) => [k, rows.filter((r) => r.k === k)]));
  const out: number[] = [];
  for (let i = 0; i < iters; i++) {
    const pick: Row[] = [];
    for (let j = 0; j < clusters.length; j++) pick.push(...byK.get(clusters[Math.floor(rnd() * clusters.length)])!);
    out.push(metric(pick));
  }
  out.sort((a, b) => a - b);
  return [out[Math.floor(iters * 0.05)], out[Math.floor(iters * 0.95)]];
}
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const skill = (rs: Row[], name: string, m: "brier" | "log") => 1 - mean(rs.map((r) => r[m][name])) / mean(rs.map((r) => r[m].market));

console.log(`samples scored=${rows.length} · station-days=${clusters.length} · dropped: no slug ${noSlug}, no event ${noEvent}, unresolved ${unresolved}, no price at snapshot ${noPrice}`);
console.log(`\nmulti-class Brier (lower = better) and skill vs the MARKET price vector (90% cluster-bootstrap CI):`);
for (const name of ["market", "asWas", "gefs", "pooled", "blend"]) {
  const b = mean(rows.map((r) => r.brier[name])), l = mean(rows.map((r) => r.log[name]));
  if (name === "market") { console.log(`  ${"MARKET".padEnd(36)} Brier ${b.toFixed(4)}  log ${l.toFixed(3)}`); continue; }
  const ci = clusterBoot((rs) => skill(rs, name, "brier"));
  const label = { asWas: `AS-WAS  GEFS+EMOS(live) ×${AS_WAS_LAMBDA}`, gefs: `GEFS    +EMOS(OOS) ×${GEFS_LAMBDA}`, pooled: `POOLED  +own EMOS(OOS) ×${MULTI_LAMBDA}`, blend: "BLEND   ½ pooled + ½ market" }[name]!;
  console.log(`  ${label.padEnd(36)} Brier ${b.toFixed(4)}  log ${l.toFixed(3)}  Brier-skill ${(skill(rows, name, "brier") * 100).toFixed(1)}% [${(ci[0] * 100).toFixed(1)}, ${(ci[1] * 100).toFixed(1)}]  log-skill ${(skill(rows, name, "log") * 100).toFixed(1)}%`);
}
console.log(`\nhypothetical trades at MID price, threshold ${(TRADE_THRESHOLD * 100).toFixed(0)}% (no spread, no fill model → optimistic):`);
for (const name of ["asWas", "gefs", "pooled"]) {
  const all = rows.flatMap((r) => r.trades[name]);
  const ci = clusterBoot((rs) => mean(rs.flatMap((r) => r.trades[name])));
  console.log(`  ${name.padEnd(8)} bets ${String(all.length).padStart(4)}  mean return/bet ${(mean(all) * 100).toFixed(1)}% [${(ci[0] * 100).toFixed(1)}, ${(ci[1] * 100).toFixed(1)}]  win ${((all.filter((x) => x > 0).length / Math.max(1, all.length)) * 100).toFixed(0)}%`);
}
// Information-horizon split: a T+0 snapshot taken in the local afternoon is
// scored against a market that has already seen most of the day's heating.
console.log("\nby information horizon (Brier; skill vs market):");
const groups: [string, (r: Row) => boolean][] = [
  ["T+1 (day before)", (r) => r.leadDay === 1],
  ["T+0, local < 11h", (r) => r.leadDay === 0 && r.localHour < 11],
  ["T+0, local ≥ 11h", (r) => r.leadDay === 0 && r.localHour >= 11],
];
for (const [name, f] of groups) {
  const rs = rows.filter(f);
  if (!rs.length) { console.log(`  ${name.padEnd(20)} n=0`); continue; }
  const m = (k: string) => mean(rs.map((r) => r.brier[k]));
  const sk = (k: string) => `${(skill(rs, k, "brier") * 100).toFixed(0)}%`;
  const ci = clusterBootOn(rs, (x) => skill(x, "pooled", "brier"));
  console.log(
    `  ${name.padEnd(20)} n=${String(rs.length).padStart(3)}  market ${m("market").toFixed(3)}  ` +
    `gefs ${m("gefs").toFixed(3)} (${sk("gefs")})  pooled ${m("pooled").toFixed(3)} (${sk("pooled")} ` +
    `[${(ci[0] * 100).toFixed(0)}, ${(ci[1] * 100).toFixed(0)}])  blend ${sk("blend")}`,
  );
}
function clusterBootOn(rs: Row[], metric: (x: Row[]) => number, iters = 1000): [number, number] {
  const ks = [...new Set(rs.map((r) => r.k))];
  const byK = new Map(ks.map((k) => [k, rs.filter((r) => r.k === k)]));
  let seed = 99;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const out: number[] = [];
  for (let i = 0; i < iters; i++) {
    const pick: Row[] = [];
    for (let j = 0; j < ks.length; j++) pick.push(...byK.get(ks[Math.floor(rnd() * ks.length)])!);
    out.push(metric(pick));
  }
  out.sort((a, b) => a - b);
  return [out[Math.floor(iters * 0.05)], out[Math.floor(iters * 0.95)]];
}
process.exit(0);
