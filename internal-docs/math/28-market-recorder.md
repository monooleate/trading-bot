# 28 — Log-forward market-data recorders

> **Forrás:** [`roadmap/model-discovery-training.md`](../roadmap/model-discovery-training.md) §3.B + §6 (B50 #2) — „log-forward MOST kell; minden nem-logolt nap véglegesen elveszett tréning-adat." **Implementálva:** 2026-09-03 (70. session). **Sprint-tracker:** [`sprints.md` B50](../roadmap/sprints.md#b50).
> **Státusz:** kész, **default-OFF (env-gated)**, mérés-only (0 trading-hatás). `tsc` exit 0 + 37/37 teszt + build zöld.

---

## 1. A kérdés

A legértékesebb tréning-adat egy része **nem visszatölthető**: a Binance open-interest history csak ~30 napig él, a Polymarket book-mélységnek pedig **egyáltalán nincs historikus endpointja**. Ha nem logoljuk, örökre elvész. A recorderek **most** indítják a forward-logot, hogy legyen mire a #1 (depth-aware fill-modell) és a #5 (OI-Δ signal) kalibrálódjon.

---

## 2. A pure logika

[`packages/core/src/market-recorder.mts`](../../packages/core/src/market-recorder.mts) — tiszta, I/O-mentes (a fetch + persistence a workerben; a shaping/cap/throttle/parse itt, hogy tesztelt legyen):

- `capSnapshots(records, max)` — gördülő append-only ablak: a **legújabb `max`** darab `ts` szerint (defenzív rendezés → out-of-order append is a legrégebbit dobja).
- `dueForSnapshot(records, nowMs, minIntervalMs)` — per-stream throttle: a legújabb rekord kora ≥ intervallum → esedékes. Így egy stream cadence-e (OI 15 perc) coarser lehet a tick-nél (3 perc) → fix cap több napot fed.
- `parseBinanceOiHist(raw)` — a `futures/data/openInterestHist` tömbből a legutolsó `{oi = sumOpenInterest, oiValue = sumOpenInterestValue}` (price ≈ oiValue/oi).
- `compactBook(book, topN)` — a teljes CLOB-könyvet a top-N szintre redukálja best-first (asks növekvő, bids csökkenő), `[price,size]` tuple-ökként.

4-csoportos [teszt](../../packages/core/src/market-recorder.test.mts): cap (legújabb-tartás, out-of-order, cap 0), throttle (üres/belül/határon/newest-wins), OI-parse (latest/üres/null/zero/hiányzó-value), book (best-first ordering, topN, size-carry, malformed→üres).

---

## 3. A worker recorder (I/O + ütemezés)

[`services/worker/src/recorders/index.mts`](../../services/worker/src/recorders/index.mts) — `runRecorders(nowMs)` a worker-tick végén (a pillérek UTÁN, hogy ne késleltessen trade-döntést), teljesen best-effort (egy recorder-hiba SOSEM töri a ticket). Perzisztencia: dedikált `market-recorder` KV-store (→ blob_kv).

| Recorder | Env-flag | Forrás | Stream | Default cadence / cap |
|---|---|---|---|---|
| **OI** | `RECORD_OI` | Binance `openInterestHist` (`RECORDER_OI_COINS`=BTC,ETH,SOL) | `oi-<coin>` | 15 perc / 5000 (~52 nap → veri a 30-napos API-retenciót) |
| **CLOB book** | `RECORD_CLOB_BOOK` | PM `/book` a nyitott crypto+weather pozíciókra (session-read a pool-on át, reset-mentes) | `clob-book` (rolling, összes token) | minden tick / 5000 (~25h) |

**Mind default-OFF:** flip ON (env `"true"`/`"1"`) + deploy → indul a capture. A CLOB-recorder a nyitott pozíciók `tokenId`-jét a normalizált session-ből olvassa (`loadSession(pool, cat, mode)`), reset-mentesen; `fetchClobBook` (a #1 keyless helper) újrahasznosítva.

---

## 4. Kapcsolat + follow-up

- **Fogyasztók:** OI → [`oi-delta.mts`](../../packages/core/src/oi-delta.mts) (#5, B49); book → [`fill-model.mts`](../../packages/core/src/fill-model.mts) (#1, B49) + Kyle-λ/VPIN. A recorder az ő historikus tréning-szubsztrátumuk.
- **Follow-up (ugyanez a #2, még nincs bekötve):** Deribit IV-felület snapshot (near-the-money surface-redukció kell — a DVOL backfillelhető, a felület nem); Pinnacle live-close (the-odds-api key + sports-live kell); HL `l2Book`/OI (perzisztens WS-worker → Hetzner-fázis). A framework ezeket kis PR-ral bővíthetővé teszi.
- **Adat-hasznosítás (later):** offline kalibrációs harness (#5 doc §3.C) a `market-recorder` streamekből + a `prediction_ledger`-be portolás (B12).
