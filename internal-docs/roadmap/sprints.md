# Sprints — fejlesztési feladatok ütemezése (SSOT)

> **SSOT scope:** Ez a fájl a **sprint-szintű feladatkezelés SSOT-je** — időben sorrendezett feladatok, owner, acceptance criteria. Rolling 5 sprint history + active + 3 next candidate + backlog.
>
> **Mit NEM találsz itt:**
> - Implementáció-státusz P1.x/P2.x ✅⚠️❌ — [`master-plan.md`](./master-plan.md) "MI VAN MÉG HÁTRA" szekció
> - Stratégia-spec / Score-számolás / 37 ötlet — [`new-strategies.md`](./new-strategies.md)
> - Hetzner action plan részletek — [`hetzner-migration.md`](./hetzner-migration.md)
> - Részletes session-leírás (mit változtattam, miért) — [`../changelog/CHANGELOG-YYYY-MM-DD.md`](../changelog/)
> - Algoritmus-doksi — [`../math/NN-name.md`](../math/)
>
> Ez a fájl **lokalizált, gyors operatív áttekintést** ad: "MIT csináljak most / a héten / a hónapban". A `master-plan.md` a **státusz-tracker** (✅/⚠️/❌), ez a fájl a **sprint-tracker** (active/next/backlog).
>
> **Utolsó frissítés:** 2026-09-02 (**Hetzner-migráció elindult** — Phase 0+1 kész [branch `feat/hetzner-migration`, repo → `apps/web`+`services/{api,worker,feeds}`+`packages/core` monorepo, tsc/23-teszt/build zöld]. A migráció **fázis-státusza a [`migration-runbook.md`](./migration-runbook.md)-ben él (SSOT)** — itt nem duplikáljuk. Következő: Phase 2 Blobs→Postgres adapter). Korábbi: 2026-07-23 (7-sávos code-review → B29–B32 P0 kódfixek, B33–B40 follow-upok)
>
> **Nomenklatúra-megjegyzés (2026-05-15):** a `sprints.md` ettől a frissítéstől **csak sequential integer**-eket használ (Sprint 38, 39e, 40, 41, 42 active). A CLAUDE.md "N. session" száma is ezzel szinkronban van — egyik suffix se versenyez a másikkal (előfordult korábban: "Sprint 39 active" ops vs "Sprint 39e" code-change). Ahol kétértelmű volt (Sprint 40A/B/C candidate vs 40f code-change), az új neve `40A → Sprint 42A candidate` lett.

---

## 🔥 Active sprint (Sprint 42 — 2026-05-15 → ~2026-05-22)

**Sprint cél:** Post-fix paper trade volume accumulation a vol_divergence K-extrakció root-cause javítás validálására — legalább 10 closed trade gyűlni a fix után, hogy a finalProb K-érzékeny mértékét és a `Combiner confidence (|p − 0.5|)` gate (#3) blokk-arányát mérni tudjuk.

**Status:** in_progress (2026-05-15 indítva, post-Sprint-41 K-extrakció fix után)

| # | Feladat | Owner | Acceptance criteria | Prio |
|---|---------|-------|---------------------|------|
| 1 | Post-K-fix vol_divergence validáció | operator | A reset után 10+ új closed trade-ben a vol_div `prob` mező **eltérése K szerint** (78K vs 80K vs 82K markets) ≥ 0.15. Edge Tracker calibration-view-ben látható a változás. | 🟠 |
| 2 | Combiner confidence gate blokk-arány mérése | operator + bot | A K-fix után a 3. gate (`Combiner confidence`) blokk-rate-je növekedjen ≥30%-kal Normal preset alatt (a near-noise trade-ek kiestek). Ha nem nő → a fix nem érvényesül a 4 K-blind signal mean-reversion-je miatt → Sprint 42A trigger. | 🟠 |
| 3 | Crypto Loose → Normal preset tervezett váltás | operator | A K-fix validálása után (10+ trade) → Settings → Normal. A combinerConfidenceMin 0.02 → 0.05 lépés meg kell maradjon production-ban a valódi noise-szűrésre. | 🟡 |
| 4 | HL bot consecutive-loss pause tesztelés | operator | A 2026-05-14f Settings knob (`hlConsecutiveLossPauseHours`) validációja — ha trigger, az inline `Cancel pause` gomb működik (UI smoke test). | 🟢 |
| 5 | Daily Coach mode check-in (RecommendationsCard) | operator | Naponta egyszer `/trade/<bot>/`-on átolvasni. Apply csak indokolt esetben, dismiss a többit. | 🟢 |

**Sprint end-criteria (mindhárom kell):**
- ✓ 10+ post-K-fix closed crypto trade gyűlt (combiner K-érzékenysége valós-time validálva)
- ✓ vol_divergence `prob` mező eltérése piaconként K szerint ≥ 0.15 (a fix után 78K vs 82K piacon >70% eltérés várt)
- ✓ Gate-3 blokk-arány Normal preset-en ≥30%-os növekedés a Sprint 41 előtti állapothoz képest (a near-noise contrarian-ek kiszűrve)

**Sprint risk:**
- ⚠️ Ha a 4 K-blind signal mean-reversion-je elnyomja a vol_div K-érzékenységét (combiner súlyozás `w = ic × (1 + |demeaned| × 0.5)` szerint a vol_div 12-15% súlyú) → finalProb még mindig 0.45-0.50 sávban marad → trigger a **Sprint 42A K-blind re-weighting** candidate-re.
- ⚠️ Ha 24h alatt < 5 új closed trade → cron lassú vagy nincs piac → operator intervention.

---

## 📋 Next sprint candidates (ready to start, prioritised)

> **Sorrend-logika (2026-05-15 re-order):** A candidate-ek mostantól **implementation readiness** szerint sorrendezve, nem alfabetikusan. Sorrend: (1) high-impact + speculative-OK; (2) quick-win zero-precondition; (3) low-impact small scope; (4) data-conditional; (5) big-scope operator-driven.

### Sprint 42A — K-blind signal re-weighting threshold piacokon ✅ IMPLEMENTED 2026-05-15 (speculative, default-off)

**Status:** ✅ **Implemented speculative** 2026-05-15-én default-off konfigurációval. A `signal-combiner.mts` `combine()` függvény kapott egy `marketKind` paramétert + a `combinerKBlindDownweight` Settings-knob default 1.0 (= zero behavior change). Az operátor 1 kattintással kapcsolja át (Settings → Crypto → "K-blind signal downweight"), amikor Sprint 42 monitoring confirms need-et.

**Bekapcsolás-kritérium (Sprint 42 ops feladat):** Ha 10+ post-Sprint-41 trade-en a finalProb még mindig 0.45-0.50 sávban ragad threshold piacokon (a `signal-combiner` `/edge-tracker` calibration-view-ban a `vol_divergence` per-K eltérése ≥ 0.15, de a finalProb K-szerinti eltérése < 0.10) → Settings → `combinerKBlindDownweight = 0.5`. **A kód-rész kész**, csak a knob átállítása szükséges.

**Mit kapcsoltunk implementáltra:**

- `signal-combiner.mts` új `K_BLIND_SIGNALS` Set (momentum, contrarian, funding_rate, pairs_spread)
- `combine()` 2 új paraméter: `marketKind: "threshold" | "directional"` + `kBlindDownweight: number = 1.0`
- A downweight csak **threshold piacokon** alkalmazódik (a `parseThresholdK(slug) !== null` az ágválasztó)
- Új helper `loadKBlindDownweight()` Blobs-ból olvas, safe-fallback 1.0
- Új SCHEMA-knob `combinerKBlindDownweight` (range [0, 1], step 0.05) Settings UI-ba bekerült
- 6 új unit test (`signal-combiner-threshold.test.mts`): default=no-op, downweight=0.5 pull-magasabbra K-aware lean-en, downweight=0 full suppression, directional-piacon ignored, kBlind-share-csökkenés, clamping [-0.5, 2.5] → [0, 1]
- Build + typecheck + 17 case tests mind zöld
- math/10 doksi + changelog frissítve

**Hatás-elemzés:** lásd "Hatás-elemzés" szekció a fájl alján (numerikus szimuláció post-fix BTC=$80,620 állapotra: 78K +0.14 pull, 80K +0.07 pull, 82K −0.11 pull → finalProb K-érzékenysége ~28%-kal nő, Grinold-Kahn IR-veszteség ~3%).

**Cél:** A `combine()` függvény bővítése egy `marketKind` paraméterrel (`"threshold" | "directional" | "other"`). Threshold piacokon a 4 K-blind signal IC-jét struktúrális priori downweight-szorzóval csökkenteni (pl. `× 0.5` vagy `× 0.3`). A K-aware 4 signal (vol_divergence, orderflow, apex_consensus, cond_prob) súlya változatlan marad.

**Implementációs vázlat:**

```typescript
// signal-combiner.mts
const K_BLIND_SIGNALS = new Set(["momentum", "contrarian", "funding_rate", "pairs_spread"]);
const THRESHOLD_DOWNWEIGHT = 0.5; // tuning knob — Settings-tunable

function isThresholdMarket(slug: string): boolean {
  return parseThresholdK(slug) !== null;
}

function combine(signals, icMap, marketKind) {
  // ...
  const icFor = (k) => {
    const baseIC = (icMap?.[k] ?? SIGNAL_ICS[k]) || 0.05;
    if (marketKind === "threshold" && K_BLIND_SIGNALS.has(k)) {
      return baseIC * THRESHOLD_DOWNWEIGHT;
    }
    return baseIC;
  };
  // ... rest unchanged
}
```

**Acceptance criteria:**
- A `combine()` kap új `marketKind` paramétert (default `"directional"` a backwards-compat-hoz)
- A `signal-combiner.mts` `getMarketKind(slug)` helper bevezetése + a fő handler-ben hívva
- Új Settings knob `combinerKBlindDownweight` (default 0.5, range [0, 1])
- Regression: up-or-down + standard piacokon a finalProb **nem változik** (a `marketKind !== "threshold"` ágon a régi IC-k)
- Threshold piacon a vol_div pred-eltérése 0.15+ → finalProb-ot meaningfully (>0.10) pull-olja K-aware irányba
- Build + typecheck zöld, új test eset a `signal-combiner-threshold.test.mts`-ben

**Becsült munka:** 0.5-1 nap (lokál; nem érinti a `weighted_pearsonCorrelation` calibration path-ot, mert az realized IC-t számol és ott Bayes-shrinkage természetesen lekezeli az alacsony-IC signal-eket)

**Hatás-becslés:** lásd "Hatás-elemzés" szekció a fájl alján (új 2026-05-15 entry).

### Sprint 42B — Topup action (bankroll növelése reset nélkül) ✅ IMPLEMENTED 2026-05-15

**Status:** ✅ **Implementálva** 2026-05-15-én. Új `topup` action mind a 4 boton (crypto, weather, hyperliquid, funding-arb — sports stub kihagyva), auth-protected. UI gomb a TraderShell-en + amount-input dialog with real-time before/after preview, validation (≥1 USD, ≤$1M), inline error display. Telegram alert minden topup-ra. F-Arb delegál a HL bankroll-ra (shared capital).

**Mit kapcsoltunk implementáltra:**

| Layer | Fájl | Mit |
|---|---|---|
| Session-manager | `crypto/session-manager.mts` | Új `topupSession()` helper + `SESSION_TOPUP` LogEvent |
| Session-manager | `hyperliquid/session-manager.mts` | Új `topupHlSession()` helper |
| Type-rendszer | `shared/types.mts` | `LogEvent` típus bővítve `SESSION_TOPUP`-pal |
| Dispatcher | `auto-trader/index.mts` | `PROTECTED_ACTIONS` + `"topup"`; `body.amount` extraction (clamp [1, 1M]); `case "topup"` mind a 3 switch-ben (crypto/weather, HL, F-Arb) |
| Handler | `auto-trader/index.mts` | Új `handleTopup()` (crypto + weather közös) — load → topupSession → save → alert |
| Handler | `hyperliquid/index.mts` | Új `hlTopup()` export — F-Arb dispatcher delegál ide |
| Alert | `shared/telegram.mts` | Új `alertTopup()` — paper/live tag + category + before/after + new start basis |
| Frontend shell | `shared/TraderShell.tsx` | Új `topup?` prop interface + state (Open/busy/amount/error) + `💰 Top up…` gomb + dialog (modal overlay, dynamic preview, validáció, inline error, Mégse + Confirm action) |
| Frontend wire-up | `trader/{Crypto,Weather,Hyperliquid,FundingArb}.tsx` | `topup={{ onTopup, currentBankroll, disabled, categoryLabel }}` prop átadva mind a 4-en |
| Tests | `shared/topup-action.test.mts` | 5 új unit test (crypto+HL helper, stopped-not-cleared, additive 2×50=1×100, decimal cent, HL-specific fields) |

**Acceptance criteria (mind ✓):**
- ✅ `topup` action 4 boton, auth-protected
- ✅ `💰 Top up…` gomb a TraderShell-en + dialog (number input + before/after preview)
- ✅ Telegram alert minden topup-ra
- ✅ Build + typecheck + all 3 test suite zöld
- ✅ Preview verifikáció: gomb megjelenik, dialog renderelődik, validáció működik (`Adj meg pozitív összeget` negatív értékre), Mégse zárja a modal-t, zero console error

**Mit NEM csinál (intencionálisan):**
- Nem törli a `stopped` flaget → ha az operátor `sessionLossLimit`-be ütközött, **külön `resume` kell** topup után
- Nem nyúl a closedTrades / IC kalibráció / open positions Blobs-okhoz → a `realized-IC` calibration az meglevő trade-eken folytatódik
- Nem futtat scan-t → a következő cron-tick végzi (paper mode `*/3 min`)

**Hatás-elemzés:**
- **A mai 2026-05-15 use-case megoldódik**: ha a Crypto bot újra `sessionLossLimit`-be ütközik, az operátor 1 kattintással bankrollt tud injektálni a 7-trade history elvesztése nélkül
- **Live trade-flip workflow**: post-paper-validation, ha az operátor +$500 injektál live módban, az új bankroll automatikusan beépül a Kelly sizing-ba, drawdown%-be, live-readiness gate-be
- **Edge Tracker drawdown%**: a `maxDrawdownPct = sessionLoss / bankrollStart`, és topup után az új `bankrollStart` a denominator → új tőke = új high-water mark része (konzisztens)
- **Audit-trail**: minden topup-ra Telegram alert + `SESSION_TOPUP` log entry — operátor utólag rekonstruálhatja mikor és mennyit injektált

### Sprint 42C — Statistics-driven recommendations expansion (~1-2 nap)

**Precondition:** Sprint 42 end (legalább 1 bot ≥20 closed trade). A statisztika-mezők (Sortino, profitFactor, expectancy, sharpeCiLo/Hi, currentStreak, evGap, maxDrawdownDuration) **már elérhetők** a `computeSummary` válaszában a Sprint 38 (Edge Tracker Tier-1 metric expansion) óta, csak a recommendations engine-be kell bekötni.

**Cél:** A 2026-05-14-i statistics.mts bővülés (`bootstrapSharpeCi`, `sortinoRatio`, `profitFactor`, `expectancy`, `currentStreak`, `evGap`, `maxDrawdownDuration`) bekötése a recommendations engine-be 5 új szabállyal.

| Új szabály | Trigger | Severity | Bot scope |
|------------|---------|----------|-----------|
| `rec-sortino-low` | Sortino < 0.3 (≥20 trade) | warn | crypto + HL + weather |
| `rec-profit-factor-poor` | Σwins/\|Σlosses\| < 1.2 (≥20 trade) | warn | mind a 4 |
| `rec-sharpe-ci-wide` | CI band width > 2 × Sharpe érték (≥30 trade) | info | mind a 4 |
| `rec-loss-streak-attention` | currentStreak ≤ −3 | info (no Apply) | mind a 4 |
| `rec-ev-gap-divergence` | \|evGap\| > 20% × sessionPnL (≥30 trade) | warn | crypto + HL + weather |

**Acceptance criteria:**
- `recommendations.mts` 5 új szabály-funkció hozzáadva, mind szigorúan a `RecommendationsCard.tsx` API-jával kompatibilis
- math/17 §3.1, §3.2 frissítve a táblázatokban
- Build verify zöld (`npm run build` + `tsc --noEmit`)
- Sprint 38 end utáni production sample-on tesztelve: legalább 2 új szabály aktiválódik valid adattal

**Becsült munka:** 1-2 nap

### Sprint 42D — Dismissed-state Blobs persistence (~0.5-1 nap)

**Precondition:** RecommendationsCard 30+ napos production-használat, az operátor jelzi hogy ugyanazt dismisszálja 3+ alkalommal hetente. **2026-05-15 megjegyzés**: a 30-napos precondition pre-emptive — coding-ready ma is, de production-impact alacsony (1 db UX-nice-to-have a 4 bot oldalán).

**Cél:** A `RecommendationsCard.tsx` dismiss gombja jelenleg csak React state-et frissít. Új flow: dismiss → POST `/recommendations-api?action=dismiss&id=<rec-id>` → 7-napos TTL Blobs entry → következő fetch-en az adott ID kihagyva.

**Acceptance criteria:**
- Új endpoint POST handler (auth-protected)
- Új Blobs store `recommendations-dismissed-v1`
- Frontend `dismiss()` callback async POST
- 7 nap után automatikusan visszatér (ha még érvényes szabály)

**Becsült munka:** 0.5-1 nap

### Sprint 42E — Sports bot stub → MVP (~3-5 nap)

**Precondition:** Sport bot integráció kérése (jelenleg `category=sports` 400-at ad a recommendations-api-on, mert a P4.2 stub még üres). Sorrend végén mert ez a legnagyobb scope (3-5 nap) és operator-driven decision.

**Cél:** [P4.2 a master-plan-ből](./master-plan.md#p42--sportspoliticsmacro-kategóriák-❌-todo-stub-ok) első fázisa: NBA / NFL Polymarket markets + Pinnacle moneyline edge.

**Acceptance criteria:**
- `auto-trader/sports/index.mts` non-stub pipeline (scan + decision + session)
- Cron `*/15 * * * *` Sportsra (paper mode default)
- TraderShell-en `<RecommendationsCard category="sports" />` (új field-map)
- Új SCHEMA knob-ok dokumentálva (`sportsEdgeThreshold`, `sportsMaxPositionUSD` — már megvannak)
- math/18-sports-bot.md (új doksi)

**Becsült munka:** 3-5 nap

---

## 🔮 Backlog (blocked vagy nagyobb sprint)

### B1 — Tier 2 reliability diagram (per-prediction bin Brier)

- **Precondition:** ≥200 closed trade egy boton (jelenleg 3-4 trade/bot)
- **Becslés:** 2-4 hét
- **Doksi:** `master-plan.md` "Legközelebbi prioritások #2" + `math/17-recommendations-engine.md` §3.4
- **Mit ad:** Per-bin reliability score (Brier-alapú) → tényleges Bayes-frissítés a `signal-combiner` súlyozásban
- **Sprint-szintű terv:** csak 200 trade küszöb átlépése után. Becslés szerint Sprint 44+ körüli.

### B2 — Hetzner VPS migráció (7-fázisú action plan)

- **Precondition:** Operátor explicit zöld jelzése + paper bot stabilan fut 30+ napon át
- **Becslés:** 1-2 hét
- **Doksi:** [`hetzner-migration.md`](./hetzner-migration.md)
- **Mit ad:** WebSocket feedek (P2.2 + P3.3), 24/7 execution réteg, Postgres trade-log
- **Sprint-szintű terv:** ha valami fenti sprint pre-conditionje "Hetzner kell hozzá" → akkor halasztva. Jelenleg nincs ilyen.

### B3 — TradingAgents debate pattern (P4.3)

- **Precondition:** ANTHROPIC_API_KEY budget bővítés + stabil paper rendszer
- **Becslés:** 1 hét (kísérleti)
- **Doksi:** `master-plan.md` P4.3
- **Mit ad:** Bull/Bear/Risk Manager Claude agent triumvirate a decision engine fölé
- **Sprint-szintű terv:** csak experimental, nem fő-prioritás.

### B4 — Weather forecast-forrás upgrade (a / b / c opció)

- **Precondition:** Operátor döntés a 3 opcióból (ECMWF közvetlen / NOAA GFS GRIB2 / kereskedelmi)
- **Becslés:** (a) 3 nap akadémiai kulcsra való várás után, (b) Hetzner-függő, (c) skála-függő
- **Doksi:** [`../math/16-weather-bot.md` §3.B](../math/16-weather-bot.md#3b-opcionális-adatforrás-upgrade-ek-jövőbeli-fejlesztés)
- **Sprint-szintű terv:** sprint 38-39 után, prioritás (a) ECMWF közvetlen — ha az akadémiai kulcs megjön

### B5 — LP Refresh Window execution (P3.3)

- **Precondition:** B2 (Hetzner) ✅ + P2.4 follow-up (LP subgroup feedback)
- **Becslés:** 1 hét
- **Doksi:** `master-plan.md` P3.3
- **Sprint-szintű terv:** Hetzner megléte után, kombinálható B2 sprint-tel

### B6 — Polymarket auto-redeem cron (P1.4 follow-up)

- **Precondition:** Live trading flip → akkor kritikus (jelenleg paper mode-ban a redeem kézi gomb is OK)
- **Becslés:** 2 óra
- **Doksi:** `master-plan.md` P1.4
- **Sprint-szintű terv:** P1.4 még PARTIAL — live trade-flip előtti kötelező feladat

### B7 — Edge Tracker hiányzó chartok (P3.4 follow-up)

- **Tartalom:** Random baseline overlay, Calibration scatter, Edge decay timeseries, Win-rate heatmap (napszak × kategória)
- **Becslés:** 3 nap
- **Doksi:** `master-plan.md` P3.4 (jelenleg ⚠️ PARTIAL)
- **Sprint-szintű terv:** 30+ closed trade után érdemes (különben üres chart-ok)

### B8 — Apex LP subgroup feedback a signal-combiner-be (P2.4 follow-up)

- **Becslés:** 1 nap
- **Doksi:** `master-plan.md` P2.4
- **Sprint-szintű terv:** alacsony prioritás, csak akkor ha apex_consensus IC realized data alapján indokolt

### B9 — *(promotálva Sprint 42B-re 2026-05-15-én — Topup action)*

A korábbi B9 (Topup action) átkerült a "📋 Next sprint candidates" szekcióba mint Sprint 42B (READY NOW, zero precondition). A B9 slot **üres**, hogy a B10-B17 numbering ne csússzon — új backlog tételhez új B-szám érdemes ha B9-et újra szabaddá akarod tenni.

### B10 — Live trading infrastructure prerequisites (HL + Polymarket) 🔴 BLOKKOLÓ

- **Precondition:** Mind a 4 bot eléri a 30+ closed trade + IC≥5% + Sharpe≥0.5 + DD<25% paper-validation gate-eket. Operator explicit "ready for live" jelzése.
- **Becslés:** 0.5 nap setup + 1 nap audit + 0.5 nap canary deploy
- **Doksi:** master-plan.md P1.1 / P1.2 (HL + Polymarket live deps)
- **Mit ad:** HL live trade-flip enabler — `HL_PRIVATE_KEY` env, `@nktkas/hyperliquid` npm install + audit, `HL_PAPER_MODE=false`. Polymarket live trade-flip enabler — `POLY_PRIVATE_KEY`, `POLY_FUNDER_ADDRESS`, `@polymarket/clob-client` audit, `PAPER_MODE=false`. **Erre live trade nem indítható** — minden live módra váltás előfeltétele ez a setup.
- **Anti-sprint védőháló**: a meglévő anti-sprint lista tiltja a live-flip-et amíg a paper validation gate-ek nem teljesülnek; ez a backlog tétel **csak akkor megy "Next candidates"-be**, ha a gate-ek mind ✓.

### B11 — Walk-forward backtest framework 🟠 KRITIKUS INFRA

- **Precondition:** B2 (Hetzner) ✅ + Postgres séma — paper-history Blobs-ban tartani nem skálázódik historikus backteszteléshez.
- **Becslés:** 1-2 hét
- **Doksi:** `new-strategies.md #5` (Score: 8.5, ❌ NEM MEGVALÓSULT)
- **Mit ad:** Walk-forward (rolling-window) backtest engine a closedTrades history-n + új signal-konfigurációk historikus IC-mérése. **Blokkolja minden új signal/strat live-flip-jét**, mert a paper-period (30+ trade) önmagában nem elég statistical power-t ad signal-tuning-ra.
- **Sprint-szintű terv:** Hetzner phase 4 (Postgres trade log) után közvetlenül; az új stratégiák validációjához kötelező pre-requisite.

### B12 — Trade logging persistence (Supabase / Postgres) 🟠 POST-HETZNER

- **Precondition:** B2 (Hetzner) ✅ — Postgres elérhetősége
- **Becslés:** 2-3 nap
- **Doksi:** CLAUDE.md `Ismert limitációk` (eredetileg, most pointer); master-plan.md C1 phase 4
- **Mit ad:** Cross-restart closedTrades persistence — Netlify Blobs jelenleg session-bound, cold-start után state-ben marad de hosszú távon nem rekonciliálható multi-bot között. Postgres trade-log → Edge Tracker SQL-queries → custom dashboard, walk-forward backtest input (B11 előfeltétele).

### B13 — Brier score + reliability diagram explicit metrics (B1 sub-task) 🟠

- **Precondition:** ≥200 closed trade egy boton (B1 azonos pre-conditionje); a `computeSummary` summary mezője már tartalmaz `calibrationDeviation`-t és `isWellCalibrated`-et, de **per-prediction-bin Brier score** + reliability-diagram plot hiányzik.
- **Becslés:** 1-2 nap (B1 nagyobb scope-ja után)
- **Doksi:** `new-strategies.md #6` (🟡 RÉSZBEN MEGVALÓSULT — calibration deviation megvan, Brier score + per-bin reliability hiányzik)
- **Mit ad:** Per-bin Brier ($\frac{1}{N}\sum_i (p_i − o_i)^2$), reliability-diagram chart Edge Tracker tab-on, Bayes-update input a signal-combiner IC-ihez. Részben átfedi a B1 Tier-2 reliability work-ot, de azon belül egy konkrét sub-feature.

### B14 — VWAP real-time WebSocket scanner 🟠

- **Precondition:** B2 (Hetzner) ✅ — Netlify Function-on nem futtatható WebSocket-feliratkozás (Anti-sprint "Soha" Netlify-on)
- **Becslés:** 1 hét
- **Doksi:** `new-strategies.md #4` (Score: 8.5, ❌ NEM MEGVALÓSULT); CLAUDE.md `Hiányos implementációk` (eredetileg, most pointer)
- **Mit ad:** A jelenlegi `vwap-arb` endpoint 90s cache-szel hív Polymarket CLOB-ot — real-time WebSocket-feliratkozás per-block VWAP recompute-tal sokkal nagyobb time-resolution-t ad. Hetzner-függő (24/7 WS connection kell).

### B15 — Weather bot σ calibration refinement 🟡

- **Precondition:** ≥50 closed weather trade (jelenleg 2)
- **Becslés:** 2-3 nap
- **Doksi:** `math/16-weather-bot.md` line 269 TODO ("Kalibráció TODO. A bucket-matcher σ paramétere nincs historikus residual-eloszlásból mérve.")
- **Mit ad:** Per-város / per-évszak residual-eloszlás → empirikus σ kalibráció a Gauss-PDF allokációhoz (helyettesíti a jelenlegi forecast-confidence-alapú σ-becslést). DEB-hez hasonló utófrissítés-pattern.

### B16 — Technical-debt cluster (math/ + Netlify limitations) 🟡

- **Precondition:** Operator-driven (egy konkrét sub-item ha élővé válik)
- **Becslés:** 1 nap / sub-item
- **Doksi-források:** `math/13-crypto-bot.md` "Maradó limitációk", `math/09-cond-prob.md` "Limitációk", CLAUDE.md `Ismert limitációk` (most pointer)
- **Sub-itemek:**
  - **Dashboard.tsx tab-array auto-generate** (jelenleg manuálisan szinkronizált új tabok esetén)
  - **CV_edge real Monte Carlo** (10,000 path → ténylegesen, jelenleg IR-proxy)
  - **Cooldown map Blobs-perzisztálás** (Netlify cold-start után in-memory elvész; `addOpenPosition` post-check enyhíti)
  - **Live early-exit Netlify timeout** (`LIVE_EXIT_BUDGET_PER_TICK = 3`, worst case 90s — pre-live arch-review)
  - **On-chain CTF redemption automatizálás** (cross-ref B6, jelenleg manuális hogy security-conscious)
  - **VWAP correction Tab 11** + **CLOB execution risk** (cond-prob non-atomic batch)
- **Sprint-szintű terv:** ha bármelyik sub-item operatórikus blokkolóvá válik (pl. live trade-flip előtt a "Live early-exit timeout" felmerül), önálló sprint indítható abból.

### B17 — Strategy backlog → `new-strategies.md` pointer 🟢

- **Precondition:** Sprint capacity szabad + 30+ closed trade meglevő stratégiákon (signal-IC stabilizáció előtt új stratégia hozzáadás Anti-sprint listán)
- **Becslés:** stratégiánként 3 nap – 3 hét, lásd `new-strategies.md` Score-számolást
- **Doksi:** `internal-docs/roadmap/new-strategies.md` — Top 11 / Mid / Long lista
- **Mit ad:** Új trade-stratégia integrálása a meglévő bot-keretbe. **Pointer-only** ebben a sprints.md-ben, mert a stratégia-katalógus SSOT-je `new-strategies.md`. Sprint indításkor onnan kell előhozni a konkrét stratégiát, ellenőrizve az Anti-sprint listát (8-signal combiner nem nőhet 200 trade előtt).
- **Top 5 candidate stratégiák** (lásd `new-strategies.md` részletekért):
  - #7 Liquidation cascade detection (1-2 hét, Hetzner-függő)
  - #8 GARCH(1,1) volatility forecasting (3-5 nap, vol_div enhancement)
  - #9 Cross-platform arb Polymarket↔Kalshi (2-3 hét, EU-access függő)
  - #10 Twitter/X sentiment scoring (2-3 hét, ~$200/hó cost)
  - #12 Cointegration BTC/ETH pairs (~2 hét, pairs_spread pillar completion)
- **Sprint-szintű terv:** prioritás-sorrend kizárólag a `new-strategies.md` Score alapján.

### B18 — HL Perp directional long-bias vizsgálat 🟠

- **Trigger:** 2026-05-29 HL performance-audit. A 22 closed trade **mind LONG** (21× BTC, 1× ETH), win rate 27.3%, calibration-deviation 32.7%, profit factor 0.31. A `getHlSignalForCoin` iránya = `finalProb >= 0.5 ? LONG : SHORT`, és a combiner `combined_probability`-ja a teljes 2026-05-12…17 ablakban > 0.5 maradt, miközben a BTC ~$81K → $73K esett.
- **Precondition:** 30+ closed HL trade (n=22 most statisztikailag elégtelen IC/Sharpe következtetéshez) — a deadlock-fix (Sprint 42G) után gyűlhet újra.
- **Becslés:** 1-2 nap (vizsgálat + esetleges fix).
- **Mit kell eldönteni:** valódi strukturális combiner-bias-e (a 8 jel directional-output szimmetriája HL coin-okon), vagy csak regime-artefakt (a momentum/trend jelek legitim módon long-ra álltak egy choppy tetőn). Ha bias → a combiner directional-leágazás auditja; ha regime → nincs kód-teendő, csak kalibráció (`useRealizedIC=1`, calib-dev > 7%).
- **Várt hatás:** ha bias-fix, a HL win-rate a 27% noise-floor fölé kerülhet; ha regime, a realized-IC blend csökkenti a 32.7% deviation-t.
- **NEM most:** a playbook §8.2/§8.9 szerint spekulatív irány-kényszerítés (pl. "néha shortolj") tilos — adat-vezérelt vizsgálat kell.

---

### B19 — Deploy-guard: top-level `.test.mts` ne tudja megbuktatni a Netlify buildet 🟡

- **Trigger:** 2026-05-29 crypto deploy-gap audit. A Sprint 41-ben hozzáadott `signal-combiner-threshold.test.mts` a `netlify/functions/` **top-level**-jén volt → a Netlify functionként bundle-elte, a `.test` pont érvénytelen függvénynév → a **2026-05-15-i deploy elbukott**, és a Sprint 41-42B fixek **2 hétig élesítetlenek** maradtak (a bot a régi 15-gate, lapos-predikció kódot futtatta, $250→$109). Az **azonnali fix kész** (`5adf152`→ test áthelyezve `auto-trader/shared/`-be, commit `5d910c8`, deploy zöld) — ez a tétel a **megelőzés**.
- **Becslés:** 1-2 óra.
- **Mit ad (opciók):** (a) pre-commit / pre-deploy lint, ami fail-el, ha bármely fájl közvetlenül a `netlify/functions/` top-level-jén `.` -ot tartalmaz a basename-ben (a `.mts` kiterjesztésen kívül); VAGY (b) `netlify.toml` `[functions]` exclusion a `**/*.test.*` mintára; VAGY (c) konvenció-doksi + a `npm run build` után egy záró ellenőrzés. Az (a) a legrobosztusabb (CI-szinten fog).
- **Precondition:** nincs — bármikor megcsinálható.
- **Várt hatás:** egy elgépelt/rossz-helyre tett test fájl soha többé nem tud csendben 2 hetes deploy-blokádot okozni.

---

### B20 — Reverse F-Arb élesítése (Binance futures-short adapter) 🟠

- **Trigger:** 2026-05-29 F-Arb audit + Sprint 44. A bidirekcionális F-Arb **paperben kész** (reverse = HL-long + Binance-perp-short, carry = −spread), de a reverse hedge Binance shortot igényel, amit a live `hedge-manager.mts` **nem tud** (szándékosan spot-only, „never enable futures or withdrawal"). Ezért a reverse jelenleg **paper-only** (live-ban detektálva de skippelve).
- **Mit kell hozzá:** (1) Binance USDM futures-short adapter (HMAC, lot-precision, funding accrual a Binance lábra is); (2) explicit operator-döntés a Binance API-kulcs **futures** permjének engedélyezéséről (biztonsági posture-változás — jelenleg tudatosan tiltott); (3) a `fr-executor` reverse live-ágának kiépítése (nyit + zár + emergency-unwind a futures lábon).
- **Precondition:** **paper-validáció** — 10+ zárt reverse paper-trade pozitív realized carry-vel (a Sprint 44 most kezd ilyet gyűjteni), MIELŐTT a futures perm + valódi tőke szóba jön.
- **Becslés:** 1-2 nap (adapter + teszt), a perm-döntés után.
- **Várt hatás:** a jelenlegi negatív-spread regime-ben (BTC −0.11%/h) a reverse arb élesben is futna; a 0-trade idle állapot megszűnik, ha a paper validálja a carry-t.
- **NEM most:** futures perm engedélyezése paper-validáció + explicit operator-zöld nélkül tilos (a spot-only posture szándékos).

---

### B21 — Threshold-piac combiner K-anchoring (a downweight-knob nem elég) ✅ IMPLEMENTED 2026-06-04 🟠

> **Status:** ✅ **Implementálva** 2026-06-04 (diagnózis → kód → tesztek, build zöld). **Deploy szükséges** a production-élesedéshez (`netlify deploy --prod`). Mit: (1) **σ-glitch guard** a [`getVolSignal`](../../netlify/functions/signal-combiner.mts)-ben — per-perc log-return winsorize ±2.5% + ha az annualizált σ kívül esik a [10%, 200%] sávon → `prob: null` (a glitch-tick kihagyja a vol_div jelet, semmint flat-előrejelzést adjon). (2) **K-anchored combiner mód** a `combine()`-ban — threshold piacon log-odds térben a vol_divergence a horgony, a többi 7 jel max ±1.5 logit bounded tiltet ad. Új `combinerKAnchorStrength` Settings-knob (default **1.0 = ON**, range [0,1]; mind a 3 crypto preset 1.0). Új 11 teszt-case (anchoring + σ-guard) a [`signal-combiner-threshold.test.mts`](../../netlify/functions/auto-trader/shared/signal-combiner-threshold.test.mts)-ben; `tsc` + build + mind a 7 shared-teszt zöld. **Maradó (follow-up):** a 20-mintás minutely σ inherens zajos → egy ≥~1%/perc mozgás már null-ozhatja a jelet (konzervatív, de a crypto-aktivitást csökkenti); robusztusabb σ-becslő (hosszabb ablak / EWMA / MAD) külön finomítás, ha a deploy utáni adat indokolja. (changelog 2026-06-04 (d))

- **Trigger:** 2026-06-04 crypto audit (10 closed trade a reset után). A combiner output **lapos marad (~0.48) erősen eltérő moneyness mellett is**, miközben a `combinerKBlindDownweight` **már 0.5-ön áll** (a Sprint 42A knob bekapcsolva). Élő bizonyíték (BTC=$64,350): above-62k → 0.4827 (mély ITM, BS-digital ~0.80+), above-64k → 0.4907 (ATM, ~0.55). A 10 trade **mind a 10 piaca NO-ra zárult** (lejtmenet, BTC ~$74K → $64K); a bot 7/10-et bukott YES-bias miatt az OTM „above" piacokon. A predikciók |p−0.5| értéke mind **0.05–0.074** közt → ezért operátor-akcióként a `combinerConfidenceMin`-t **0.05 → 0.08**-ra emeltük (a near-noise trade-ek mostantól skippelnek, de a bot a fő piactípusán emiatt **jórészt tétlen**).
- **Gyökérok-hipotézis:** a combiner IC-súlyozott **átlag**; egyetlen K-aware tag (vol_divergence) nem tudja K-érzékennyé tenni az átlagot, mert a maradék 7 jel (downweightolva is) visszahúzza 0.5 felé. Másodlagos gyanú: a BS-digital σ (implied vol) **túlbecslés** → minden K-t 0.5-höz lapít (magas vol → érme-feldobás).
- **✅ DIAGNÓZIS IGAZOLVA (2026-06-04, read-only `signal-combiner?slug=…` probe, június-5 strike-sorozat):** mindkét hipotézis bizonyítva. (1) **A vol_divergence MAGA helyesen K-aware** — `strikeSource="slug-threshold"` aktív, `fairYes`: 64k→0.443, 66k→0.124, **70k→0.001** (a piac is 0.009-et árazott) → **NEM a vol_div a hibás**. (2) **Primér gyökérok = DILÚCIÓ**: a `combined` ugyanezeken 0.494 / 0.434 / **0.461** — 70k-nál a vol_div 0.001-et mond, de a combined 0.461, mert a 7 K-vak jel elnyomja az egyetlen K-aware jelet (a 0.5-downweight nem elég). (3) **Szekunder σ-glitch IGAZOLT, intermittens**: 64k-nál `sigmaAnnual=495.5%` (66k/70k-nál sane 46%), ugyanazon piacra hívásonként ugrál (46.9%→495.5%) → ott a vol_div is 0.5-höz lapul. → Fix-sorrend: **(a) σ sanity-clamp** (gyors, glitch-osztály) + **(b) K-anchored mód** (a dilúció valódi megoldása).
- **Mit kell:** (1) ✅ **Diagnózis kész** (lásd fent). (2) **σ sanity-clamp/-kalibráció** a `getVolSignal`-ban (clamp pl. [10%, 200%] + per-piac stabilizálás). (3) **Strukturális fix — „K-anchored" combiner mód:** threshold-piacon a vol_divergence legyen a horgony-valószínűség, a többi 7 jel csak **kiigazítás** rá (nem egyenrangú átlag-tag).
- **Precondition:** nincs — azonnal kezdhető (a diagnózis read-only). A strukturális fix validálása a meglévő 10 + új paper trade-en.
- **Becslés:** ~1-2 nap (diagnózis + K-anchored mód + σ-kalibráció + tesztek).
- **Várt hatás:** threshold-predikciók a `[0.05, 0.95]` sávot fedik moneyness szerint a mai `[0.43, 0.51]` helyett → a bot újra **valódi-edge threshold-trade-eket** nyit helyes iránnyal, ahelyett hogy vagy zaj-tradel, vagy a 0.08-as gate miatt néma.
- **NEM ez (2026-06-04 user-felvetés):** blanket „reverse direction" toggle a Settingsbe. Az audit kimutatta: a fordítás 70% WR-t adna, **DE PnL-ben még mindig veszteséges (~−$30, payoff-aszimmetria miatt)**, és csak egyetlen lejtmenet-rezsimre illesztett szerencse (n=10). A principled megoldás a modell K-érzékennyé tétele — egy korrekt K-aware model OTM-en magától NO-t mond (a nyerő irány), vak megfordítás nélkül. Lásd a playbook §8.2/§8.9 spekulatív-irány-tiltását (vö. B18).

### B22 — Weather invert-direction toggle (kísérleti) ✅ IMPLEMENTED 2026-06-07 · ON döntés 2026-07-04 🟡

- **🟢 INVERT ON — ✅ ALKALMAZVA 2026-07-05 (auth-olt API, verifikálva override+effective=1, weather reset $250/0):** a 78-trade audit (`forecast_edge` IC **−0.359**, fordított kalibráció: modell 63%→realizált 18%; flip a mintán 60% WR / +$29.55, mindkét direkció pozitívba flippel) **strukturális** inverz anti-edge-et igazolt — **felülírja a 06-13 invert-OFF döntést** (az n=9 „artifact" volt; ez n=78). Akció: `weatherInvertDirection=1` + weather reset. `weatherConfidenceMin` **marad 0.65** (NEM csökkentjük — a confidence az ensemble-szórást kapuzza, nem a bucket predictedProb-ját), selectionShrink 0.5 + minPrice 0.05 marad. **Fenntartás:** az ár-aszimmetria befogja a felső határt (a flip csak a vérzést állítja meg); élőben a fee + vékony order book tovább ront. **Monitoring:** 20-30 post-invert trade → újra-audit; ha az sem pozitív nettó → **B15 σ-modellfix** (a gyökér: valószínű bucket-matcher/σ kalibrációs inverzió). Lásd [changelog 2026-07-04](../changelog/CHANGELOG-2026-07-04.md).
- **Implementálva (2026-06-07):** `weatherInvertDirection` (0/1) Settings-knob, default **OFF**, „⚠️ EXPERIMENTAL: invert (fade)" címke. A [`decision-engine.mts`](../../netlify/functions/auto-trader/weather/decision-engine.mts) `direction`-választása a net-edge gate-nél flip-el (`baseDirection` → invert), a cross-position gate a flippelt oldalon fut. Env: `WEATHER_INVERT_DIRECTION`. 2026-06-06 friss flip-audit (n=11) megerősítette: **−$87.88 → +$32.38** (de a swing 2 confident-NO trade-ben koncentrált — lásd changelog). **Default OFF marad** — B23 a preferált; csak akkor kapcsold ON, ha tudatos kísérleti hedge. Teszt: `adverse-selection-fixes.test.mts` (2 B22 direction-case + 2 sizing-case).
- **🔴 SIZING BUG FIX (2026-06-13):** az eredeti implementáció a Kelly `probSide`-ot **a flippelt oldalon** számolta. A flippelt oldal a modell szerint sub-fair-value (anti-edge) → `(probSide·b − q) < 0` → `rawKelly = 0` → `positionSizeUSDC = 0` → `shares = costBasis = 0` → a reconciler **minden** inverted trade-et `pnl = 0×exit − 0 = 0`-val zárt, nyerő/vesztő egyaránt. Élő tünet: 9 invert-trade, mind $0 PnL, 0% WR (köztük 2 ténylegesen nyerő bucket is „losses"-ként). **Fix:** a Kelly mostantól a `baseDirection` (modell-preferált, +edge) oldalon méretez → az invert egy *azonos méretű tükörfogadás* a modell természetes tétjéhez képest (pontosan az, amit a flip-audit mért). `invertDirection=OFF` esetén `baseDirection === direction` → szigorú no-op. Lásd changelog 2026-06-13.
- **Trigger:** 2026-06-04 weather-audit (25 closed trade). Eredeti 32% WR / **−$150.17**; flippelt (azonos dolláros tét) **68% WR / +$87** (júniusi regime ~86%). A user kérte: Settings-gomb, ami mindig a modell ELLENKEZŐJÉT nyitja.
- **Crypto-tól ELTÉRŐEN itt a flip PnL-POZITÍV in-sample** (+$87 vs a crypto B21 −$30-a) — valódi anti-edge, nem csak win-rate illúzió. OK: a [`bucket-matcher.mts:187`](../../netlify/functions/auto-trader/weather/bucket-matcher.mts) max-|edge| (= max-disagreement) bucket-választása adverse selection → a piacot fade-elni (flip) profitált.
- **Mit kell:** `weatherInvertDirection` (0/1) Settings-knob, default OFF, explicit „EXPERIMENTAL / fade-the-model" címke. Megfordítja a [`decision-engine.mts:223`](../../netlify/functions/auto-trader/weather/decision-engine.mts) `direction`-választást + a Kelly `probSide` oldalt + a cross-position (Σ P(YES) ≤ 1) gate-et. ~30 LOC + 1 séma-mező + teszt.
- **Fenntartások:** kis minta (n=25, profit 4 trade-ben koncentrált); regime-függő; **band-aid** — ha B23 (gyökérok) megoldódik, a flip elromlik (jó tippet fade-elne). → B23 a preferált irány; B22 csak gyors kísérleti hedge.
- **Precondition:** nincs (paper). **Becslés:** ~fél nap. **Státusz:** 2026-06-04 user → „weathert hagyd most ki" — nem indítva.

### B23 — Weather bucket-matcher: max-disagreement adverse-selection fix ✅ IMPLEMENTED 2026-06-07 🟠

- **Implementálva (2026-06-07):** `weatherSelectionShrink` (0–2.0) Settings-knob — optimizer's-curse korrekció. A `matchBucket` N bucketből a max-|edge|-űt választja → a kiválasztott edge felfelé torzít. Új gate a [`decision-engine.mts`](../../netlify/functions/auto-trader/weather/decision-engine.mts)-ben (a net-edge gate után): a `√(2·ln N)·σ_edge × shrink` szelekciós-zaj-becslést levonja a gross edge-ből, és a maradék net edge-nek is el kell érnie a küszöböt. **AKTÍV default 0.5 (2026-06-07 operátor-kérés)**; presetek: loose 0, normal 0.5, strict 1.0. Env: `WEATHER_SELECTION_SHRINK=0` kikapcsolja. A Bonferroni-IC-idioma weather-megfelelője. **Degradál:** shrink=0 vagy N<2 → pass (n/a). A B22 (flip) ezt feleslegessé teszi, de a kettő komponálható (B23 kevesebbet tradel, B22 flippel). Teszt: `adverse-selection-fixes.test.mts` (3 B23 case: no-op, kills-noise, survives-standout).
- **Trigger:** ugyanaz a 2026-06-04 audit. A `matchBucket` a **legnagyobb |edge|-ű** (= a piactól leginkább eltérő) bucketet választja, és arra fogad, hogy a modellnek van igaza — de a next-day temp piaca jól kalibrált, így a max-eltérés tipikusan **modell-hiba**, nem alfa. Ez a 32% WR strukturális oka.
- **Mit kell:** (1) NE a max-|edge| bucketet válassza vakon — pl. modal-közeli + edge-súlyozott szelekció, vagy a disagreement-gate (jelenleg 2°C) szigorítása. (2) Szélesebb σ (a tail-ek túl vékonyak: a modell 1–14%-ot adott bekövetkező bucketekre). (3) Esetleg forecast-bias korrekció. A B22 (flip) ezt **feleslegessé teszi**, ha jól sikerül.
- **Precondition:** nincs (read-only diagnózis + paper-validáció). **Becslés:** ~1-2 nap. **Kapcsolat:** B15 (σ-kalibráció) sub-task-ja részben.

### B24 — Sports longshot floor (min bet-side price) ✅ IMPLEMENTED 2026-06-07 🟠

- **Trigger:** 2026-06-06 sports-audit (n=15, 7% WR, −$32.29). A bot extrém longshotokra fogad (bet-side ár 0.016–0.135), modell ~25%-ot jósol de a realizált ~7% (≈ piaci ár → efficient book). A flip sem segít (−$9.55), mert a 3.6-4% roundtrip fee a tiny-payoff oldalon felemészti a nyereséget; az egyetlen nyerő (+$246 longshot) flippelve −$20 lenne.
- **Implementálva:** `sportsMinPrice` (0–0.5) Settings-knob + új gate a [`sports/decision-engine.mts`](../../netlify/functions/auto-trader/sports/decision-engine.mts)-ben (Gate 5b): a megfogadott oldal (`marketPriceForSide`) Polymarket-ára ≥ küszöb, különben skip. Szimmetrikus (longshot-YES ÉS upset-NO). **AKTÍV default 0.05 (2026-06-07 operátor-kérés)**; presetek: loose 0.03, normal 0.05, strict 0.08. Env: `SPORTS_MIN_PRICE=0` kikapcsolja. Teszt: `adverse-selection-fixes.test.mts` (4 sports case). **Megj.:** a 0.05 floor a 15 trade-ből 10-et szűrt volna, de a 3 survivor is bukott + a nyerőt is kizárta → **risk-lever, nem garantált profit-fix**; n=15 kis minta.

### B25 — F-Arb edge-tracker mezőnév-fix (display bug) ✅ IMPLEMENTED 2026-06-07 🟢

- **Trigger:** 2026-06-06 audit — a `/trade/funding-arb` 38 zárt trade-je **csupa nullát** mutatott (entryPrice/shares/pnl=0). Gyökérok: az [`edge-tracker.mts`](../../netlify/functions/edge-tracker.mts) `tradesFromSession` funding-arb ága **nem létező mezőneveket** olvasott (`hlAvgPrice`/`hlSize`/`realizedPnl`/`hlSide`) — az `ArbPosition` valós mezői `hlEntryPrice`/`sizeCoins`/`closeFundingNet`/`direction`. A pozíciók **valósak** voltak (multi-status: bankroll 200→173.41, sessionPnL +$0.22, 38 closed) — a bot rendben kereskedik (Sprint 47 működött), csak a megjelenítés volt hibás.
- **Implementálva:** mezőnevek javítva + `pnlPct = closeFundingNet/sizeUSDC×100`, direction `forward→NO / reverse→YES` (mint a `funding-arb/index.mts` projekció). Read-only display fix, nincs trade-logika változás.

### B26 — F-Arb fee-negatív gyökérok + sessionPnL nettó-fix ✅ IMPLEMENTED 2026-06-07 🟠

- **Diagnózis (a B25 edge-tracker-fix után):** az edge-tracker most a valós `closeFundingNet` összeget mutatja: **−$26.60** 38 trade-en, ami pontosan rekonciliál a bankroll-droppal ($200 − $26.60 = $173.41). A bot **fee-negatív** volt.
- **Gyökérok (megtalálva):** a break-even gate [`arb-detector.mts`](../../netlify/functions/auto-trader/hyperliquid/funding-arb/arb-detector.mts) `totalFees = feeHl + feeBin` (0.29%) — **teljesen kihagyta a paper-slippage-et**, amit a `closeArbPosition` ténylegesen leszámol. A gate 0.29%-on számolt break-event, de a valós paper-költség 1.89% volt → a bot olyan trade-eket nyitott, amiket nem tudott profitábilisan zárni. Másodlagos: a **1.6% paper-slippage** maga is túl pesszimista volt (az IOC limit-band worst-case-t összegezte, nem a várható fillt).
- **Implementálva:** (1) **break-even gate slippage-aware** — `totalCost = fees + (paper ? paperSlippageRoundtrip : 0)`, a `closeArbPosition`-nal **azonos** értékkel (új `FrArbConfig.paperSlippageRoundtrip`, közös). (2) **paper-slippage rekalibrálva 0.016 → 0.004** (0.4% reális IOC-fill liquid coinokon; live-ban 0). Új `frPaperSlippage` Settings-knob + `FR_PAPER_SLIPPAGE` env. (3) **multi-status sessionPnL = bankrollCurrent − bankrollStart** (nettó), a bruttó `totalFundingAllTime` helyett. Teszt: `farb-breakeven.test.mts` (4 case: thin-rejected, wide-viable, live-viable, boundary) + `funding-arb-reverse` regresszió zöld.
- **Hatás:** a bot mostantól **csak olyan spreadeken nyit, ahol a carry × hold fedezi a teljes roundtrip-költséget** (paper: 0.69%; ~18%/yr floor 14d holdnál). A reális HL↔Binance spreadek (3.6–31%/yr) közül csak a széles vége (pl. SOL) megy át → **ritkábban, de profitábilisan** kereskedik a korábbi „mindig fee-negatív" helyett.

### B27 — Crypto `cond_prob` cross-strike contamination fix ✅ IMPLEMENTED 2026-06-14 🟠

- **Trigger:** crypto flip-analízis + jel-szintű diagnózis (changelog 2026-06-14). A 12-trade post-reset minta 17% WR / **−$120.38** volt; a flip in-sample +$80.57-et adott (de regime-műtermék, lásd changelog). A jel-bontás kimutatta: a `cond_prob` mind a 3 nyitott pozíció befagyasztott snapshotjában **pontosan 0.200** (= a −0.3-as bearish cap), miközben egy friss combiner-hívásban 0.5 → **időszakos bearish-telítődés**.
- **Gyökérok ([`signal-combiner.mts`](../../netlify/functions/signal-combiner.mts) `getCondProbSignal`):** a „related markets" monotonicity-check **kulcsszó alapján** (`bitcoin`, `above`) húzott be piacokat, **strike-szűrés nélkül**. Így a `P(YES korábbi deadline) ≤ P(YES későbbi deadline)` invariánst KÜLÖNBÖZŐ strike-okra alkalmazta (pl. above-60k @ ~0.84 vs az above-66k @ ~0.10) → hamis „violation"-ök telítették a signed shift-et a −0.3 cap-en → `cond_prob = 0.2`, egy konstans bearish lökés ~0.17 combiner-súllyal → minden BTC threshold-piacot NO felé húzott.
- **Fix:** a related-szűrő mostantól csak **azonos parsed strike K** piacokat hasonlít (`parseThresholdK(m.slug) === selfK`); non-threshold (up-or-down) piacon a monotonicity-ág teljesen kimarad (nincs strike-család → cond_prob a complement-checkre esik vissza, ~0.5 neutrális). Detail mostantól kiírja a `strike` + `same_strike_related` mezőt (live-verifikálható). `tsc`+build zöld; live-verifikáció deploy után.
- **Maradó (fix B → backlog candidate):** a WATCH / LOW-IR (alacsony combiner-bizalom) trade-ek átcsúsznak a kapun (a WATCH csak SKIP-en vétóz, az edge a 20%-os extrém-edge-veto alatt ül). Javaslat: a LOW-confidence trade blokkolódjon vagy erősen leméreteződjön. **Nincs még bevezetve** — külön sprint, ha az adat indokolja.

### B28 — Weather longshot floor (min bet-side price) ✅ IMPLEMENTED 2026-06-15 🟠

- **Trigger:** weather trade-history audit (changelog 2026-06-15). A post-reset 11-trade minta +$392.33-at hozott (PnL bit-pontosan validált, Polymarket Gamma cross-check: a Hong Kong 29°C bucket jún-14 ÉS jún-15 is YES-re resolvolt — valós). **DE** a profit ~98%-át **két mély-OTM tail-bucket** hajtotta: Hong Kong 29°C YES @ ~4.6¢ → +$335.94 és +$146.53.
- **Probléma:** ezek a 4–6¢-os tail-bucketek paper-ben tökéletesen töltődnek a jegyzett áron, teljes mérettel (355 ill. 155 share), de **élesben a vékony order book miatt nem fillelhetők méretben** → a paper PnL (+157%) felfelé torzul nem-realizálható tail-találatoktól. Szimmetrikus probléma a NO-oldalon is (Seoul jún-13 NO @ 1.4¢ egy 99.6%-os bucketre — bukott). `evGap = −$486` is jelzi: a modell túlbecsüli a tail-edge-et.
- **Fix:** új `minPrice` floor a [`weather/decision-engine.mts`](../../netlify/functions/auto-trader/weather/decision-engine.mts)-ben (új gate „Min bet-side price (longshot floor)", a Kelly-cap után): a megfogadott (executed `direction`) oldal market-ára < `minPrice` → blokk. Szimmetrikus (YES + NO). 0 = OFF. Új `weatherMinPrice` Settings-knob (default 0.05) + `WEATHER_MIN_PRICE` env; presetek: loose 0.03 / normal 0.05 / strict 0.08. A sports `sportsMinPrice` floor (B24) weather-megfelelője. Teszt: `adverse-selection-fixes.test.mts` (+4 B28 case: blocks-longshot-YES, blocks-upset-NO, off-noop, passes-sane). `tsc`+build zöld.

---

> **2026-07-23 — teljes 7-sávos code-review (crypto/weather/HL/F-Arb/sports + shared signal-infra + economics-risk), 33 megerősített találat.** A P0 kódfixek (B29–B32) ebben a session-ben implementálva; a P1/P2 follow-upok (B33–B40) nyitottak. Részletek: [changelog 2026-07-23](../changelog/CHANGELOG-2026-07-23.md). Data-quality korrekció: a session eleji „overrides wiped" megállapítás **téves** volt (a `/trader-settings` GET auth nélkül szándékosan `{}`-t ad vissza) — az override-ok épek (24 aktív, `sessionLossLimit=1000`, `weatherInvertDirection=1`).

### B29 — Gross-loss session-limit unbrick: `resumeSession` nullázza a `sessionLoss`-t ✅ IMPLEMENTED 2026-07-23 🔴

- **Trigger:** a crypto bot **+$690 nettó** (37 trade), mégis `stopped: "Session loss limit reached"`, mert a `sessionLoss` egy **monoton bruttó-veszteség odométer** (csak a vesztes trade-ek |pnl|-je, sosem írja vissza nyeremény — [crypto/session-manager.mts:135](../../netlify/functions/auto-trader/crypto/session-manager.mts)), és a $1033 bruttó veszteség > a knob max ($1000). A `resumeSession`/`topupSession` **megőrizte** a `sessionLoss`-t → resume/topup után a következő tick azonnal újra leállított → **nincs settings-only újraindítás**. Egy nyerő longshot-book (sok kis veszteség, kevés nagy nyerő) elkerülhetetlenül átlépi a bruttó limitet.
- **Fix:** a `resumeSession` (crypto) és `resumeHlSession` (HL) mostantól `sessionLoss: 0`-t állít → az explicit operátor-resume valódi, history-őrző unbrick (mirror a HL consecutive-loss recovery mintájára). Teszt: `p0-profitability-fixes.test.mts` (crypto+HL resume). `tsc`+build+9 teszt-suite zöld.
- **Élesítés:** deploy után `POST /auto-trader-api {action:"resume", category:"crypto"}` → a bot a +$690 track record + IC kalibráció megtartásával indul újra. → a principled fix (nettó/peak-equity limit): **B33**.

### B30 — Combiner [0,1] clamp + totalW sign-cancellation guard ✅ IMPLEMENTED 2026-07-23 🔴

- **Trigger:** a `combine()` súlyozott átlaga (`Σ weights[k]·valid[k]`, `weights[k] = ic·(...)/totalW`) **kiléphet [0,1]-ből**, ha bármely effektív IC negatív (mixed-sign súlyok, `totalW`→0 vagy negatív). A `combined` közvetlenül a Kelly `b = 1/p − 1`-be megy → negatív `b`, korrupt edge/irány. Ez a load-bearing ok, amiért a `useRealizedIC` **nem kapcsolható be biztonságosan** (a realized-IC ad negatív súlyt a tartósan rossz jeleknek: crypto `orderflow` −0.165, HL `vol_divergence` −0.32, `pairs_spread` −0.13).
- **Fix:** [signal-combiner.mts](../../netlify/functions/signal-combiner.mts) `combine()`: (1) `totalW` degeneráció-guard (|totalW| < 1e-9 → equal-weight fallback); (2) `combined = clamp(1e-4, 1−1e-4)` a K-anchor blend után, mielőtt Kelly/IR fogyasztja. Szigorú no-op amíg minden IC pozitív prior. Teszt: `p0-profitability-fixes.test.mts` (no-op pozitív, out-of-range negatív-IC, totalW-guard). → sign-aware log-odds súlyozás directional piacon + a knob bekapcsolása: **B34**.

### B31 — F-Arb forward-carry proxy (HL-funding, nem spread) + churn close-logic + gate-3 display ✅ IMPLEMENTED 2026-07-23 🔴

- **Trigger:** delta-neutrális carry-harvester **nettó −$9.14** (40 trade), holott pluszban kéne lennie. Két strukturális bug: (1) a forward-láb (HL-short + Binance-**spot**-long) `forwardScore = spread`-del gate-elt, de a spot-láb **nem fizet fundingot** → a valós carry a **HL funding egyedül** — pontosan amit az `accrueFunding` már számol ([fr-session.mts:170](../../netlify/functions/auto-trader/hyperliquid/funding-arb/fr-session.mts)). Negatív Binance-fundingnál `spread > hlFunding` → veszteséges pozíciókat is beengedett. (2) a záró küszöb (`minSpreadToClose` 0.00005/h) **magasabb** volt a nyitó floornál → nyit-majd-azonnal-zár churn, minden ciklus egy bebetonozott roundtrip-veszteség.
- **Fix:** [arb-detector.mts](../../netlify/functions/auto-trader/hyperliquid/funding-arb/arb-detector.mts) `forwardScore = d.hlFundingHourly` (reverse `−spread` változatlan); [index.mts](../../netlify/functions/auto-trader/hyperliquid/funding-arb/index.mts) close-check forward carry = HL funding (accrual-konzisztens), a `carry < minSpreadToClose` early-close **eltávolítva** (zárás csak maxHold VAGY `carry < 0` esetén); gate-3 break-even display most tartalmazza a paper-slippage-et (a detektor gatejével egyezik). Teszt: `funding-arb-reverse.test.mts` (fwd.score = hlFunding + új „fwdCarry" regression: tiny-HL/nagy-negatív-Binance → REJECTED). Operátor-knob (már alkalmazva): `frMinSpreadHourly` 0.00002→0.00005 (a churn-sáv kiiktatása deploy nélkül).

### B32 — Edge-tracker under-report fix: all-time headline + valós bankroll-denominátor ✅ IMPLEMENTED 2026-07-23 🟠

- **Trigger:** az Edge Tracker **hamis számokat** mutat az operátornak: (1) a `days` default **30 nap** → a headline `totalPnl` csak a trailing szeletet mutatta (sports **−$47** a valós **−$285** helyett, nem rekoncilál a bankroll-deltával); (2) a `computeSummary` **hardkódolt $150** bankrollt használt → minden %-os stat (`totalPnlPct`, `maxDrawdownPct`, `kellyUsed`) hibás a $200–$450 botokra.
- **Fix:** [edge-tracker.mts](../../netlify/functions/edge-tracker.mts) `days` default „30" → „all" (windowing opt-in `&days=`); új `resolveBankrollStart(category, mode)` a `STORE_SPECS`-ből olvassa a valós per-kategória `bankrollStart`-ot (all → összeg), és átadja a `computeSummary`-nak. Mock-adaton kihagyva. `tsc`+build zöld.

### B33 — Nettó / peak-equity session-loss-limit (a bruttó odométer leváltása) 🟠

- **Precondition:** B29 (interim unbrick) élesítve. **Becslés:** ~1 nap + teszt.
- **Feladat:** a `sessionLossLimit` guard **bruttó-veszteség** helyett **peak-equity drawdown**-t figyeljen (`peakEquity − bankrollCurrent ≥ limit`), szimmetrikusan crypto/HL/sports session-managereken. Ez a principled fix, ami megszünteti a „nettó +$690 de stopped" patológiát; B29 csak feloldja. A gate-1 hint szövege is javítandó (jelenleg tévesen „nettó vesztesége", valójában bruttó — [crypto/decision-engine.mts:219](../../netlify/functions/auto-trader/crypto/decision-engine.mts)).

### B34 — Combiner sign-aware negatív-IC kezelés + `useRealizedIC` bekapcsolása 🟠 RÉSZBEN KÉSZ (2026-09-01)

- **2026-09-01 kész:** `useRealizedIC` schema **default 0→1** ([trader-settings.mts](../../netlify/functions/trader-settings.mts)). A sign-awareness **már benne van** a súly-alapú combinerben: negatív effektív IC → negatív súly → a jel hozzájárulása invertálódik (`combined += w·p`), a B30 clamp/totalW-guard biztonságossá teszi. HL `&category=hyperliquid`, crypto `&category=crypto` — mindkettő persistál realized-IC-t. ⚠️ **Ha mentett `useRealizedIC=0` override van, a default-change NEM írja felül** → operátornak Settings-ben 1-re kell váltania (auth).
- **Marad (opcionális mélyítés):** dedikált **log-odds sign-aware** tilt directional/HL piacon (a threshold K-anchor tilt-ág mintájára [signal-combiner.mts:1229](../../netlify/functions/signal-combiner.mts)) — a súly-invert helyett explicit `1−p` hozzájárulás; + n≥30 gate jelenként. **Várt hatás:** HL ~breakeven → enyhén pozitív; crypto evGap csökken. Monitoring: deploy után az edge-tracker „Signal IC calibration" Effective oszlopa.

### B35 — Weather sizing/kalibráció overhaul (payoffRatio 0.44 gyökérok) 🟠 RÉSZBEN (2026-09-01)

- **2026-09-01 kész (interim de-risk):** új `weatherKellyScale` knob (default **0,5**) — a végső ¼-Kelly-frakció uniform szorzója ([weather/decision-engine.mts](../../netlify/functions/auto-trader/weather/decision-engine.mts)). Korlátozza a downside-t/vérzést, **NEM** payoff-fix. A teljes overhaul (lentebb) marad.
- **Precondition:** friss 20–30 trade a knob-változtatások után (selectionShrink 1.0 + maxPos $15 már alkalmazva). **Becslés:** 2–3 nap.
- **Feladat:** (1) a Kelly méret **leválasztása az ensemble-egyetértésről** — skill-alapú (realized reliability/Brier) shrinkage, hogy a legmagabiztosabban téves előrejelzés ne kapja a legnagyobb tétet; (2) σ-infláció ([B15](#b15--weather-bot-σ-calibration-refinement-)) — az alul-diszperz GFS σ nyersen megy a bucket-matcherbe; (3) **fee-modell parity**: a weather reconciler 0%, a gate 1% fee-t számol a 3.6% helyett → a paper-PnL felfelé torzul, javítandó az `applySettlementFee` mintára; (4) drága-favorit sapka (`weatherMaxPrice` vagy ár-skálázott edge-gate) — a ~0.68-áras favoritok a 2× nagyobb veszteségek forrása. Az irány JÓ (forecast_edge IC +0.393), a sizing a probléma.

### B36 — HL Kelly win-prob mapping fix 🟠

- **Becslés:** ~1 nap + walk-forward. **Feladat:** a [kelly-sizer.mts:60](../../netlify/functions/auto-trader/hyperliquid/kelly-sizer.mts) a Polymarket YES-resolution valószínűséget adja a perp **TP-before-SL** win-valószínűségének — ezek különböző események → ~13pp túlbizonyosság (pred 0.54 → realized 0.40), ~3× túlméretezés. Fix: geometria-tudatos `P(TP before SL) ≈ slPct/(tpPct+slPct)` driftless alap, edge-implikált drift-tilttel; edge=0 → Kelly≈0. Interim de-risk (már alkalmazható knob): `hlMaxLeverage` / `hlEdgeThresholdPaper` szigorítás.

### B37 — Sports fair-value redesign (Pinnacle de-vig) 🔴 STRATÉGIA-ÁTÉPÍTÉS

- **Állapot:** a sports bot **leállítva** (2026-07-23, operátor) — jelenleg NINCS edge-forrás. **Becslés:** több nap (külső adat + de-vig + kalibráció).
- **Feladat:** a „fair value" jelenleg `predicted = 0.5 + (yesPrice−0.5)·0.55` ([sports/decision-engine.mts:60](../../netlify/functions/auto-trader/sports/decision-engine.mts)) — a Polymarket **saját árát** húzza 0.5 felé → strukturálisan minden olcsó longshotot túlbecsül (evGap −$2677, ~10% WR). Kell: valódi **de-viggelt Pinnacle/sharp-book** referencia, belépés csak `devigged_true − pm_price > fee` esetén. Sub-fixek: NO-oldali edge leg-mismatch (`|P(YES) − noPrice|` a helyes `|P(NO) − noPrice|` helyett, ~3× felfújt edge, [sports/decision-engine.mts:82](../../netlify/functions/auto-trader/sports/decision-engine.mts)); paper settlement fee-parity (jelenleg 0%). **Amíg ez nincs → a bot maradjon leállítva/loss-limit-capelve** (`sportsSessionLossLimitEnabled=1` már alkalmazva).

### B38 — Crypto tail-de-selection + korreláció-tudatos aggregát pozíció-cap 🟡

- **Feladat:** a crypto profit 4 longshot-találaton ül (top-4 +$801, a maradék 33 trade −$111; evGap −$454). (1) `selectionShrink` a szélső bucketekre (marketPrice <0.20 / >0.80) a grossEdge előtt; (2) `cryptoMaxEdgeCap` 0.40→~0.22 + `btcMinPriceBand` >0.10 (a 12¢-os szerződésen a 40%-os „edge" ne legyen kereskedhető); (3) **korreláció-tudatos aggregát cap**: az azonos-underlying/azonos-resolution-window nyitott pozíciók összes költségalapja ≤ ~15–20% bankroll (jelenleg 8%×5 slot ≈ 34% egyetlen BTC-mozgásra). Precondition a tétemelésre: [B11](#b11--walk-forward-backtest-framework--kritikus-infra) walk-forward.

### B39 — evGap net-of-fee baseline 🟡

- **Feladat:** a `tradeEv()` ([edge-tracker/statistics.mts](../../netlify/functions/edge-tracker/statistics.mts)) EV-baseline-ja **bruttó** a fee-re, miközben a realizált PnL nettó → az evGap fix ≈ −Σfee biast hordoz, ami összemossa a „modell-optimizmust" a puszta fee-drag-gel (a crypto/HL evGap-riasztások részben ez az artefakt). Fix: a fee levonása a `tradeEv`-ben (`max(proceeds,costBasis)·feePct` mintára), vagy a bias explicit dokumentálása a mezőn.

### B40 — Weather invert-direction re-audit (IC-előjel ellentmondás) 🟡

- **Feladat:** a `weatherInvertDirection=1` (invert ON, a 2026-07-04 B22-döntés) mellett a `forecast_edge` realized IC **+0.393** (pozitív), miközben az invert bekapcsolásának indoka az akkori **−0.359** volt. A jelenlegi állapot: 56 trade, −$189.90, 51.8% WR, payoffRatio 0.44 (a veszteség sizing-eredetű, nem irány). Az IC-előjel vs invert-beállítás **ellentmondásos** — a signal-calibration IC-számítás szemantikáját (signal-vs-outcome vs signal-vs-bot-PnL invert mellett) tisztázni kell, majd dönteni: invert OFF + reset tiszta mintára, vagy marad. **Ne** flippeljük vakon (a session eleji audit már egyszer tévesen mondta „invert OFF"). Kapcsolódik: [B15](#b15--weather-bot-σ-calibration-refinement-), B35, **B41/#1 (proper-scoring: reliability-diagram teszi objektívvé az invert-döntést)**.

### B41 — Forecasting/kalibrációs réteg fejlesztése (model-discovery) 🟠

- **Forrás:** [`model-discovery-forecasting.md`](./model-discovery-forecasting.md) — 3-pilléres research discovery (2026-09-01), forrásolt survey + pontozott ajánlás. A botok profitja a valószínűség-becslés **kalibrációján** múlik; a discovery A-lépcsője pure-math, `.mts`-be portolható, **új infra nélkül**.
- **Ütemezés-döntés (2026-09-01): HIBRID.** Adatgyűjtés + olcsó TS-javítások MOST (Netlify); nehéz ML (foundation/GARCH/GBM) + walk-forward backtest framework (B11) + ledger→Postgres (B12) Hetzner UTÁN. Indok: a point-in-time predikció (CLOB-mikrostruktúra) **nem pótolható visszamenőleg** → a ledger-óra azonnal indul; a Blobs→Postgres átöltés triviális.
- **#1 — Proper-scoring eval harness ✅ IMPLEMENTED 2026-09-01.** `computeProperScores` (`edge-tracker/statistics.mts`): log-score + Brier-Murphy dekompozíció (Reliability−Resolution+Uncertainty) + Brier/Log skill-score + full-[0,1] reliability-diagram binek. Bekötve az `edge-tracker.mts` response-ba (`properScores`) + `ProperScoresCard` az `EdgeTrackerPanel`-en. Új `shared/proper-scores.test.mts` (10+ pin) + `tsc`+build zöld. **Ez validálja az összes többi #-t** (a combiner/kalibráció-változásokat proper-score-on hasonlítja, nem zajos PnL-en).
- **Prediction ledger (§2 adat-alap) ✅ IMPLEMENTED 2026-09-01 (mind a 3 forecasting-bot + panel).** Új `shared/prediction-ledger.mts`: minden scannelt piac (taken+skipped) predikcióját logolja, YES-kimenettel tölti (closedTrades taken-re + Gamma-reconcile skipped-re — torzításmentes add-on). Upsert per-piac, cap 3000/kat, Blobs (→Postgres B12). **Bekötve: crypto + weather (Gamma-reconcile) + HL (append-only, perp → nincs Gamma; skipped-coin outcome = jövőbeli price-based reconcile).** Bot-agnosztikus (`market??coin`, `pnl??pnlUSDC`). **B) Ledger stats panel** az Edge Trackeren (`ledgerStats` + `LedgerStatsCard`: Logged/Resolved/Taken/Skipped+resolved). Új `shared/prediction-ledger.test.mts` (7 csoport) + `tsc`/build zöld. **A ledger-óra a deploy-jal indul.** Follow-up: HL price-based skipped-reconcile; funding-arb/sports nincs bekötve (F-Arb nem forecasting).
- **#2 — Post-hoc kalibráció (MÉRÉSI lépés) ✅ IMPLEMENTED 2026-09-01.** `edge-tracker/calibration.mts`: Platt-skálázás + **walk-forward** eval (`computeCalibrationEval`) → raw vs kalibrált Brier/log-score az Edge Trackeren (`CalibrationEvalCard`), zéró leakage, **live döntést nem érint**. Isotonic/Venn-Abers = ≥1000-kimenet follow-up. Új `shared/calibration.test.mts` (6 csoport) zöld. **Live coach-mode bekötés (finalProb kalibrálása a decision-engine-ben) csak elég adat + pozitív walk-forward gain után** — kötődik **B35/B36/B40**.
- **#3 — Log-odds pool (directional) ✅ IMPLEMENTED 2026-09-01 (default-OFF).** `signal-combiner.mts` `combine()` új log-odds pool mód directional piacokra (`sigmoid(Σ wₖ·logit(pₖ))`, decizívebb-de-bounded); új `combinerLogOddsStrength` knob (default 0 = változatlan lineáris). Threshold piacon nincs hatása (K-anchor). Új `shared/log-odds-pool.test.mts` (6 csoport) zöld. Az operátor a #1 gain után kapcsolja.
- **#4 — Online AdaHedge súlyozás (MÉRÉSI lépés) ✅ IMPLEMENTED 2026-09-01.** `edge-tracker/online-weights.mts`: paraméter-mentes AdaHedge (inherensen walk-forward, zéró leakage) → statikus-IC vs adaptív súlyozott forecast Brier az Edge Trackeren (`OnlineWeightsCard`, per-jel prior↔adaptív sávok). **Live súly-váltás nem történik** — a dokumentált IC-előjel-flippekre (B34) a legnagyobb live-érték, de mérés-first. Új `shared/online-weights.test.mts` (5 csoport) zöld.
- **#5 — HAR-RV vol-motor ✅ IMPLEMENTED 2026-09-01 (default-OFF).** `shared/har-rv.mts`: Rogers–Satchell napi RV + Yang–Zhang + HAR blend (nap/hét/hónap). Bekötve a `getVolSignal`-ba `useHarRv` knob mögött (default 0); ON-nál napi OHLC-ból stabilabb σ a BS-digital horgonyhoz, fetch-hiba → legacy fallback. Új `shared/har-rv.test.mts` (5 csoport) zöld. Bekapcsolás #1 threshold-Brier gain után.
- **#6 — First-passage (touch) routing ✅ IMPLEMENTED 2026-09-01 (default-OFF).** `shared/first-passage.mts`: `oneTouchProbability` (drifted first-passage, up+down barrier) + `classifyBarrierMarket` (konzervatív touch-ige osztályozó). Bekötve a `getVolSignal`-ba `useFirstPassage` knob mögött (default 0); touch-piacon (valódi strike + touch-ige) one-touch a `N(d₂)` helyett (~2× helyes). A terminal piac-mixre nincs hatása. Új `shared/first-passage.test.mts` (6 csoport, ~2× reflexiós pin) zöld.
- **#7 — Deribit SSVI+BL piac-implikált árazás ✅ IMPLEMENTED 2026-09-01 (default-OFF).** `shared/deribit-rnd.mts`: Breeden–Litzenberger skew-aware digitális (`blDigitalAbove`, flat-smile→N(d₂) pin) + smile-interpoláció. Bekötve a `getVolSignal`-ba `useDeribitIV` knob mögött (default 0); terminal piacon a Deribit BL piac-implikált P(>K) a `N(d₂)` helyett (5-perc cache, fetch-hiba→fallback). Élő API-alak verifikálva. Új `shared/deribit-rnd.test.mts` (6 csoport) zöld. A RN→fizikai gap-et #2 korrigálja. SSVI+term-structure = Hetzner-follow-up.
- **#8 — Disagreement-gated extremizing ✅ IMPLEMENTED 2026-09-01 (default-OFF).** `combine()` új extremizing lépés: `sigmoid(a·logit(p))`, a = 1 + strength·0.7·disagreement (a jel-log-odds szórására kapuzva → nem túl-extremizálja a redundáns jeleket). `combinerExtremizeStrength` knob (default 0 = változatlan). A #3 log-odds pool élesítő párja. Új `shared/extremize.test.mts` (6 csoport) + math-doksi. Rollout #1 gain után.
- **#9 — Sports Pinnacle de-vig ✅ IMPLEMENTED 2026-09-01 (default-OFF, B37 modell-fix).** `shared/devig.mts`: multiplicative + power de-vig (favorite-longshot korrekció) + `twoWayFairYes` + american-konverzió. Bekötve a `makeSportsDecision`-be a `pinnacleFairYes` inputon + `usePinnacleFairValue`/`sportsUsePinnacle` knob mögött (default 0); a fabrikált shrink helyett valódi de-viggelt fair value, odds-feed nélkül shrink-fallback (zéró regresszió). Új `shared/devig.test.mts` (7 csoport) zöld. **Nyitott data-task: az odds-feed** (ODDS_API_KEY, pl. the-odds-api; Polymarket↔Pinnacle event-matching a `pinnacleFairYes` feltöltéséhez) — enélkül a #9 matek él, de nem tüzel.
- **Nyitott jelöltek (jóváhagyásra, discovery §7 A-lépcső):** #2–#9 LIVE bekapcsolása (a mérés + pozitív gain után); a sports **odds-feed** data-task (a #9 aktiválásához); #4 online AdaHedge + ADWIN/BOCPD regime-reset — kötődik **B34**; #5 HAR-RV (Yang–Zhang) vol-motor; #6 first-passage routing touch-piacokra; #7 Deribit SSVI+BL benchmark-signal; #8 disagreement-gated extremizing; #9 sports Pinnacle de-vig — **= B37**.
- **B-lépcső (Hetzner-precondition):** foundation model (Chronos-Bolt/TimesFM) mint *kalibrált* distribution-estimator; Realized-GARCH; logisztikus/GBM stacking; LLM-signal sportra. → a `hetzner-migration.md`-be új modell-service fázisként promotálandó, amikor odaérünk.
- **Acceptance (#1, kész):** az Edge Tracker minden kategórián mutatja a Brier/Log-score/skill KPI-ket + reliability-diagramot; a Murphy-identitás önkonzisztens (unit-tesztben pinned).

### B42–B45 — teljes-audit follow-upok (2026-09-03) 🟡

A 2026-09-03 teljes audit (5 bot + infra + security) implementált fixei: [changelog 2026-09-03](../changelog/CHANGELOG-2026-09-03.md). A NEM-azonnal-implementált maradékok:
- **B42 — login KDF-upgrade.** A jelszó jelenleg sótlan SHA-256 (a doc bcrypt-et ír). Bevezetni bcrypt/scrypt/argon2-t + az operátornak új `AUTH_PASSWORD_HASH`-t generálni (breaking → operátor-feladat). A timingSafeEqual + per-IP rate-limit már él.
- **B43 — mély sign-aware realized-IC.** A `computeRealizedICs` (`shared/signal-calibration.mts`) csak `pnl>0`-val korrelál, iránytól függetlenül → HL SHORT-trade-eken zavaros IC. Korrelálja a signalt a direkcionális kimenettel. (A `t.side`→`t.direction` typo már javítva.) Shared-infra, óvatosan.
- **B44 — sports snapshot Pinnacle fair value.** A `sports/index.mts` a `predictedProb`/snapshot-ot a shrink-képletből re-deriválja a döntést vezérlő `pinnacleFairYes` helyett. Csak `sportsUsePinnacle`/B37 bekapcsolásakor releváns (akkor P1).
- **B45 — HL Kelly conviction-scale knob.** A B36-fix `BRACKET_CONVICTION_SCALE` konstans (0.5); tegyük Settings-knobbá (`hlKellyConvictionScale`) a mérés utáni hangoláshoz.

### B46–B48 — API-frissítés follow-upok (2026-09-03, 56. session)

> A 56. session API-auditjának follow-upjai. A user kérésére **B47 + B48 implementálva**, **B46 kód-verifikáltan nem alkalmazható**. Részletek: [changelog 2026-09-03](../changelog/CHANGELOG-2026-09-03.md).

- **B46 — Polymarket keyset-lapozás migráció ⚪ NOT APPLICABLE (2026-09-03).** A feltételezett gyökérok (offset-lapozás deprecation) **nem áll fenn**: a `grep -ri "offset" services/**/*.mts` kizárólag weather `city_offset`-et talál — **egyetlen Gamma-hívás sem használ `offset` paramétert**. A `/markets` és `/events` hívások mind **egyoldalas, `order=volume24hr` szerinti top-N** lekérdezések (nem lapoznak túl az 1. oldalon) → nincs mit keyset-re migrálni; egy cursor-refaktor tiszta churn lenne 0 haszonnal. A base-endpointok stabilak. (Ha később valódi lapozás kell, akkor nyílik újra.)
- **B47 — HL SDK (`@nktkas/hyperliquid`) deklarált függőség ✅ DONE (2026-09-03).** Felvéve a gyökér `package.json`-be: `@nktkas/hyperliquid@^0.33.3` + `viem@^2.47.12` (`npm install`, lockfile frissítve). Futásidejű export-verifikáció: `HttpTransport`/`ExchangeClient` + `viem/accounts` `privateKeyToAccount` mind létezik → a live HL adapter (`hl-client.mts` dinamikus import) mostantól tisztán resolvál a korábbi néma import-hiba helyett. A konstruktor-alakok (`{isTestnet}`, `{transport,wallet}`) a jelenlegi SDK API-ja. **Végső live-signing verifikáció** valós kulccsal → B10 (live-infra) bekapcsolásakor.
- **B48 — Külső API 429/rate-limit backoff ✅ DONE (2026-09-03).** Új shared helper [`packages/core/src/fetch-retry.mts`](../../packages/core/src/fetch-retry.mts) (`fetchWithRetry`): korlátozott exponenciális backoff + full jitter 429/5xx/network-hibára, `Retry-After` fejléc-tisztelettel, per-attempt friss `AbortSignal.timeout`. **Idempotencia-biztos:** order-placement (POST) csak 429-re retry-zik (pre-execution reject), 5xx/network SOSEM (double-fill ellen). Bekötve a 3 signed live-útba: `binance-trade.mts`/`bybit-trade.mts` wrapperek (GET teljes retry, POST 429-only) + `hedge-manager.mts` (exchangeInfo GET teljes; spot MARKET order 429-only). Új `fetch-retry.test.mts` (9 eset) zöld. A HL `/info` saját 1-retry-ját meghagytuk.

### B49 — Rendszer-bővítés discovery (execution / portfólió / új edge-források) 🟠 TRACKER

- **#7 sports Shin de-vig ✅ IMPLEMENTED 2026-09-03 (64. session) — a matek kész; a live odds-feed a maradó adat-task (B37).** (`tsc` exit 0 + **33/33 teszt** + build zöld). A discovery/sports-kutatás szerint a Shin a legjobban kalibrált de-vig (Štrumbelj 2014); a multiplicative pont a bot bukás-módját (favorite-longshot bias) őrizné meg. Új `devigShin` a meglévő [`packages/core/src/devig.mts`](../../packages/core/src/devig.mts)-ben (insider-frakció z modell, bisekció Σp=1-re, fallback power-re) + `DevigMethod` bővítés `"shin"`-nel + `twoWayFairYes(...,"shin")`; a [devig.test.mts](../../packages/core/src/devig.test.mts) Shin-blokkal bővült (összeg=1, no-vig fallback, FLB-korrekció, 3-way, heavy-fav). A sports decision-engine fogyasztója (`market.pinnacleFairYes`, `sportsUsePinnacle` knob) a #9 óta megvan. **Maradó (B37 adat-task, a #7 tüzeléséhez):** odds-feed (the-odds-api + `ODDS_API_KEY` + Polymarket↔Pinnacle event-matching) → `pinnacleFairYes` feltöltése Shin-nel; + CLV-KPI; + NO-oldali leg-mismatch + fee-parity (B44). Amíg az odds-feed nincs bekötve, a sports maradjon leállítva. Doksi: [`math/24-sports-devig.md`](../math/24-sports-devig.md).
- **#6 weather EMOS/NGR kalibráció ✅ IMPLEMENTED 2026-09-03 (63. session), apply default-OFF / log mindig-on.** (`tsc` exit 0 + **33/33 teszt** + build zöld). A weather „jó irány (IC +0.39), rossz sizing" gyökér-fixe: ensemble-underdispersion → σ-kalibráció. Új pure modul [`packages/core/src/emos.mts`](../../packages/core/src/emos.mts) (`gaussianCrps` zárt-alak + `emosApply` [μ=a+b·ensMean, σ²=c+d·ensVar, varFloor] + `fitEmos` two-step OLS + `observationRank`) + 6-csoportos [teszt](../../packages/core/src/emos.test.mts). Adat-pipeline [`weather/emos-store.mts`](../../services/worker/src/pillars/weather/emos-store.mts): `logForecast` (minden scannelt állomás+dátum → torzításmentes) + `reconcileEmosObs` (**METAR-alapú** obs-fill a lejárt dátumokra, nem trade-függő → unbiased) + refit + `loadStationEmosParams`. Bekötve a [`weather/index.mts`](../../services/worker/src/pillars/weather/index.mts)-be: log+reconcile mindig fut (adat-óra indul, best-effort), az EMOS-apply a `matchBucket` előtt csak `weatherUseEmos` ON + fittelt (≥20 residual) esetén. Knob `weatherUseEmos` (0/1 default 0). **A trading-viselkedés OFF-nál változatlan** (nyers μ,σ); csak háttér-adatlogolás fut. Doksi: [`math/23-emos.md`](../math/23-emos.md). Kötődik B15/B35/B40. **Follow-up:** full CRPS-min estimation; rank-histogram az Edge Trackerre; per-évszak fit; Open-Meteo multi-model blend.
- **#5 OI-Δ × price signal ✅ IMPLEMENTED 2026-09-03 (62. session), default-OFF.** (`tsc` exit 0 + **32/32 teszt** + build zöld). A discovery TOP új korrelálatlan signalja. Új pure modul [`packages/core/src/oi-delta.mts`](../../packages/core/src/oi-delta.mts) (`classifyOiQuadrant` + `oiDeltaProb`: emelkedő OI megerősíti az ármozgást, csökkenő OI gyengíti → P(up)) + 5-csoportos [teszt](../../packages/core/src/oi-delta.test.mts). Bekötve a [`signal-combiner.mts`](../../services/api/src/routes/signal-combiner.mts)-be 9. signalként: `getOiDeltaSignal` (coin a slug-ból → multi-coin; Binance OI-hist + kline 5m×7; knob-gate → null OFF-nál → combine elejti → **8-signal output bit-azonos**) + `SIGNAL_ICS.oi_delta=0.07` + **K_BLIND_SIGNALS** (strike-blind → threshold downweight) + `raw_signals.oi_delta` + `SignalBreakdown.oi_delta?` opcionális. Knob `oiDeltaEnabled` (0/1 default 0, common/„Signal toggles"). Tiszteletben tartja az anti-sprint szabályt (combiner nem nő 200 trade előtt — default-OFF, measure-first). Doksi: [`math/22-oi-delta.md`](../math/22-oi-delta.md). **Follow-up:** a BTC-hardcode teljes leváltása (vol_div/funding a threshold-combinerben, → new-strategies #3); funding cross-section percentilis (#17); window-tuning.
- **#4 walk-forward scoring a ledgeren ✅ IMPLEMENTED 2026-09-03 (61. session), mérés-only.** (`tsc` exit 0 + **31/31 teszt** + build zöld). Új pure modul [`packages/core/src/walk-forward.mts`](../../packages/core/src/walk-forward.mts) (`ledgerPointsFromRecords` + `computeWalkForward`: rezolúciós-idő szerint rendez, kronológiai blokkok, blokkonként **Brier skill = 1 − Brier_model/Brier_market** [>0 ⇒ a model veri az árat] + log-loss + konzisztencia + korrelációs caveat `effectiveDays`/`maxDayShare`) + 7-csoportos [teszt](../../packages/core/src/walk-forward.test.mts). Bekötve az [`edge-tracker.mts`](../../services/api/src/routes/edge-tracker.mts) response-ba (`walkForward`, a ledger-rekordokból amit a ledgerStats amúgy is betölt) + új **`WalkForwardCard`** az [`EdgeTrackerPanel.tsx`](../../apps/web/src/components/EdgeTrackerPanel.tsx)-en (overall skill + per-blokk sávok + caveat). **Scoring-only → nincs train/test leakage; a B11 Hetzner-mentes verziója.** Nincs új knob/env/live-döntés. Doksi: [`math/21-walk-forward.md`](../math/21-walk-forward.md). **Follow-up:** purge/embargo a korrelált klaszterekre; anchored-fit walk-forward a #2 Platt-kalibrációval; per-kategória UI-bontás.
- **#3 robust Sharpe (PSR/MinTRL/DSR) ✅ IMPLEMENTED 2026-09-03 (60. session), advisory + gates default-OFF.** (`tsc` exit 0 + **30/30 teszt** + build zöld, NEM deployolva). Új pure modul [`packages/core/src/sharpe-robust.mts`](../../packages/core/src/sharpe-robust.mts) (PSR, MinTRL, expectedMaxSharpe, DSR, skewness/kurtosis, normalInv) + 6-csoportos [teszt](../../packages/core/src/sharpe-robust.test.mts). `computeSummary` új mezők: `returnSkew`/`returnKurtosis`/`psr`/`minTrl` (a nyers per-trade Sharpe-ból; minTrl 999999 sentinel = ∞) → 2 új Edge Tracker KPI-kártya (PSR, MinTRL). [`live-readiness.mts`](../../services/worker/src/pillars/shared/live-readiness.mts): a summary mindig hordozza psr/minTrl/**dsr**/trialsCount; két opt-in kapu `minPsr` + `useMinTrl` (σ_SR proxy = bootstrap-CI félszélesség). **Honest-trial DSR:** [`trader-settings.mts`](../../services/api/src/routes/trader-settings.mts) minden knob-változást trial-ként logol (`appendTrial`/`countTrials`), a runner tickenként betölti. Common knobok `liveReadyMinPsr` (default 0) + `liveReadyUseMinTrl` (0/1 default 0). Doksi: [`math/20-robust-sharpe.md`](../math/20-robust-sharpe.md). **Follow-up:** valódi cross-config σ_SR; per-kategória trials; HL saját status-út readiness; a #4 walk-forward scoring (a validációs réteg másik fele).
- **#2 crypto-beta exposure cap ✅ IMPLEMENTED 2026-09-03 (59. session), default-OFF.** T1–T4 kész (`tsc` exit 0 + **29/29 teszt** + build zöld, NEM deployolva). Új pure modul [`packages/core/src/portfolio-exposure.mts`](../../packages/core/src/portfolio-exposure.mts) (`cryptoExposureUsd` = Σ costBasis; `hlExposureUsd` = Σ sizeUSDC/leverage [margin, nem levered notional]; `checkBetaCap` fail-open degenerált inputon) + 5-csoportos [`portfolio-exposure.test.mts`](../../packages/core/src/portfolio-exposure.test.mts). Cross-bot loader [`shared/portfolio-exposure.mts`](../../services/worker/src/pillars/shared/portfolio-exposure.mts) (crypto + HL persisted session; **F-arb kizárva** — delta-neutrális; weather kizárva). Bekötve a crypto ([`pillars/index.mts`](../../services/worker/src/pillars/index.mts)) + HL ([`hyperliquid/index.mts`](../../services/worker/src/pillars/hyperliquid/index.mts)) runner belépő-előtti check-jébe: a saját bot LIVE session-ből (intra-tick opens is számítanak) + a másik a tick-eleji snapshotból; átlépés → skip a cap-reason-nel. **Common knobok** `betaCapEnabled` (0/1, default **0**) + `betaCapFraction` (default **0,25**), env `BETA_CAP_ENABLED`/`BETA_CAP_FRACTION`. Doksi: [`math/19-portfolio-exposure-cap.md`](../math/19-portfolio-exposure-cap.md). NEM mond ellent Sprint-45-nek (cap-réteg, nem bankroll-újraegyesítés). **Follow-up:** multi-status UI-utilization mező; signed-net exposure (a bruttó helyett); a §4.C további tételei (#8 vol-target/max-DD, #9 ENB-monitor) külön B49-tételek.
- **#1 depth-aware fill-modell ✅ IMPLEMENTED 2026-09-03 (58. session), default-OFF.** T1–T7 kész (`tsc` exit 0 + **28/28 teszt** + build zöld, NEM deployolva). Új pure modul [`packages/core/src/fill-model.mts`](../../packages/core/src/fill-model.mts) (`simulateDepthFill` ask-book walk + participáció-cap + partial + `fallbackFill` √-law + tick/min-size helperek) + 8-esetes [`fill-model.test.mts`](../../packages/core/src/fill-model.test.mts). Keyless [`shared/clob-book.mts`](../../services/worker/src/pillars/shared/clob-book.mts). Bekötve a `placeBuyOrder`-be (crypto+weather) + sports saját fill-útjába, a `fillModelEnabled`/`fillParticipationCap` **common** knobok mögött (default OFF → bit-azonos legacy). T6: a paper-resolver fee ON-nál exit-only (`settlementFeePctFillModel` 0,015 — a belépő slippage már a VWAP-ban → dupla-számolás elkerülve). Doksi: [`math/18-fill-model.md`](../math/18-fill-model.md), env: [`env-vars.md`](../current-state/env-vars.md). **Élesítés:** a knob ON → proper-scoring/ledger raw-vs-fill összehasonlítás → pozitív igazolás után default-ON. **Follow-up (ugyanitt B49 alatt):** T6 fee-finomhangolás méréssel; élő per-market `/tick-size` fetch (live-út, B10); crypto korai TP/SL exit bid-walk (`handleSellLifecycle`); weather reconciler fee-parity → B35.
- **Forrás:** [`model-discovery-expansion.md`](./model-discovery-expansion.md) — 57. session (2026-09-03), 8-pilléres webes research + teljes read-only kód-katalógus. A [`model-discovery-forecasting.md`](./model-discovery-forecasting.md) (B41) **testvér-doksija**: az a predikciós réteget, ez az **execution/portfólió/validáció/új-signal/domén** rétegeket vizsgálja.
- **Központi tanulság:** a signalok telítve; a maradék profit három NEM-signal rétegben van — (A) execution/fill-realizmus (a paper-PnL hazudik a longshotokon), (B) a mérés-only kalibráció élesítése + walk-forward, (C) portfólió-szintű crypto-béta koncentráció-kezelés.
- **Jelöltek (jóváhagyásra, discovery §5-§6 pontozott sorrend, mind TS-now hacsak nem jelölt):**
  - **#1 depth-aware fill-modell** (walk L2 + participáció-cap + partial + √-law) — **először ezt, ez validál mindent** (a hamis paper-PnL nélkül minden statisztika hazudik). ÚJ, nincs meglévő tétel.
  - **#2 shared-bankroll crypto-béta exposure-cap** — nulla becslés, a legnagyobb strukturális lyuk (crypto+HL+F-arb mind crypto-béta). ÚJ. NEM mond ellent Sprint-45-nek (nézet/cap-réteg, nem bankroll-újraegyesítés).
  - **#3 PSR/MinTRL live-gate + honest-trial DSR** + **#4 walk-forward scoring a prediction-ledgeren** (a B11 Hetzner-mentes verziója). ÚJ.
  - **#5 OI-Δ × ár signal** (+ a BTC-hardcode leváltása, → new-strategies #3). ÚJ signal, az egyetlen erős korrelálatlan.
  - **#6 weather EMOS/NGR kalibráció** (→ B15/B35/B40) + **#7 sports Shin de-vig + the-odds-api feed + CLV-KPI** (→ B37 + odds-data task).
  - **#8 vol-target + max-DD kill-switch** + **#9 ENB diverzifikáció-monitor**. ÚJ.
  - **#10 CTF auto-redeem cron** (→ B6). **#11 liq-cascade fade ETH/SOL** (→ new-strategies #7, Hetzner-WS). **#12 neglected-market scanner** (politics/macro MVP, NEM LLM). **#13 market-making/reward-farming** (ÚJ üzletág, live-infra). **#14 meta-labeling** (≥300-500 trade/bot).
- **Skeptikus mentések (NE építsd):** negRisk/Σ-arb mint alfa (3,6s korrekció, likviditás-cap); Kalshi cross-arb mint executor (semantic non-fungibility — read-only scannerként OK); settlement-sniping (dispute-risk-prémium); on-chain flows (gyenge+drága); LLM likvid piacra (a piaci ár veri).
- **Precondition:** operátor-jóváhagyás a §6 A-lépcső sorrendre; a B-lépcső (auto-redeem/liq-cascade/MM) Hetzner+live-infra-blokkolt (B10).

---

## ✅ Completed sprints (rolling 5 utolsó)

### Sprint 47 (2026-06-04) — F-Arb structural sizing+threshold fix

**Trigger:** user — „funding rate bot … fut, nem nyit semmit … miért nem nyit pozit". Élő diagnózis: a bot helyesen gate-el, de strukturálisan képtelen volt nyitni (0 trade 2026-04-21 óta).

**3 fix (changelog 2026-06-04 (b)):**
- **Sizing-floor** (fő ok): új `computeArbPositionSize()` bump-to-min helper ([`arb-detector.mts`](../../netlify/functions/auto-trader/hyperliquid/funding-arb/arb-detector.mts)) + `minPositionUSDC` $50→$25. A $200×40%×0.5=$40 első pozíció soha nem érte el a $50 floor-t → „Size $40 < min $50" minden tickre.
- **Spread-küszöb**: `minSpreadHourly` 0.0001→0.00002/h (87.6%→17.5%/yr); a reális spreadek 3.6–31%/yr.
- **Sanity-cap**: `maxSpreadHourly` 0.005→0.0005/h (4380%→438%/yr) — elkapja a 2952%/yr glitch-osztályt.
- Presetek + séma (loose/normal/strict) recalibrálva. `tsc`+build+teszt (+5 sizing-case) zöld.

**Maradó operatív lépés:** ha aktív Blobs-override van a `normal` preseten, a user **újra rányom a Normál presetre** a Settingsben (1 katt) hogy a kód-defaultok éljenek. A `minPositionUSDC` env-only → deploy után automatikus.


### Sprint 46 (2026-05-29) — Sports loss-limit kikapcsolható (paper OFF) + topup

**Mit ért el:**
- **Trigger**: a sports bot `stopped` volt a $30 napi loss-limit miatt ($250 → $214.93 paperben). A user: paperben ne legyen ilyen limit (vagy legyen kikapcsolható, alapból OFF), és vezessünk be topupot a sportsra is.
- **Loss-limit toggle**: új `sessionLossLimitEnabled` a sports configban — **OFF paperben, ON live-ban** (env-default `!paperMode`), `sportsSessionLossLimitEnabled` 0/1 Settings-knob override-olja. A guard csak akkor tüzel, ha engedélyezve. **Auto-recovery**: ha a session a loss-limit miatt állt le és a limit most OFF → a következő cron-tick magától resume-ol (HL Sprint 42G mintájára) → a bot **magától elindul** deploy után.
- **Topup a registry-native botokra**: a `BotDefinition` + dispatcher + `DispatchInput` kibővült `topup`-pal (eddig csak a legacy crypto/HL/F-Arb tudott). Új `topupSportsSession` + `sportsTopup` + `topup` prop a `SportsTrader`-en (💰 gomb).
- **Presetek**: a 3 sports preset bővült (Lazább/Normál loss-limit **OFF**, Szigorú **ON**).
- **Teszt**: új `shared/sports-loss-limit-topup.test.mts` (4 case) zöld; `tsc` + build zöld.

**Changelog:** [`CHANGELOG-2026-05-29.md`](../changelog/CHANGELOG-2026-05-29.md) (f szekció)

### Sprint 45 (2026-05-29) — F-Arb saját bankroll (HL-tól szétválasztva)

**Mit ért el:**
- **Trigger**: a user rámutatott, hogy a HL-directional (spekulatív irányított perp) és az F-Arb (delta-neutrális funding harvester) **két külön stratégia** — nincs értelme egyetlen közös HL bankrollon osztozniuk (az F-Arb eddig `loadHlSession().bankrollCurrent`-et kölcsönzött méretezési referenciaként).
- **Fix**: az `ArbSessionState` saját `bankrollStart` + `bankrollCurrent` mezőt kapott (`DEFAULT_ARB_BANKROLL = 200`). A `loadArbSession` migrálja a régi blobokat (default seed). A méretezés a **saját** bankrollra megy (`session.bankrollCurrent`, nem HL). A realizált funding-PnL záráskor a saját bankrollba folyik (`creditArbPnl` — nyitáskor nincs margin-debit, a lekötés a `deployedCapital` × cap-en keresztül korlátozott). A `reset` saját bankrollra állít (override-olható), új `arbTopup` a saját tőkét növeli (a dispatcher már nem `hlTopup`-ra delegál). A `multi-status` + `getArbStatus` + `FundingArbPanel` a saját bankrollt jelenti (`bankrollShared` → false, a „(shared)" címke eltűnik, és a home-page totals-ba bekerül).
- **Mellékhatás**: a korábban felvetett **B21** (shared-bankroll cross-reconciliation, live-prereq) **tárgytalanná vált** — a szétválasztás gyökerestül megszünteti a megosztott-tőke túl-foglalás kockázatát, így B21 nem került felvételre.
- **Teszt**: a `funding-arb-reverse.test.mts` +4 case-szel bővült (reset default/override, creditArbPnl nyereség/veszteség, topup additív). `tsc --noEmit` + `npm run build` + 12-case teszt zöld.

**Changelog:** [`CHANGELOG-2026-05-29.md`](../changelog/CHANGELOG-2026-05-29.md) (e szekció)

### Sprint 44 (2026-05-29) — Bidirekcionális F-Arb (reverse arb, paper)

**Mit ért el:**
- **Trigger**: a 2026-05-29 F-Arb audit kimutatta, hogy a bot **egyirányú** (`arb-detector.mts`: `spread < minSpread → skip`), így a **nagy negatív spreadeket** (most BTC −0.11%/h ≈ annualizált 968% fordított irányban) strukturálisan kihagyja → 2026-04-21 óta 0 trade.
- **Fix (irány-tudatos detektor + economics)**: a `detectArbOpportunity` mostantól `direction: "forward" | "reverse"` + `score` (= `|spread|`) mezőt ad. **FORWARD** (HL-short + Binance-spot-long): viable pozitív spreaden, carry = hlFunding. **REVERSE** (HL-long + Binance-perp-short): viable negatív spreaden, carry = `binanceRate − hlRate = −spread`. Az `accrueFunding` irány-tudatos (a snapshot most a Binance rátát is hordozza); a close-check, a 8 gate (score-alapú), a break-even, a ranking és az `entryDecision` (LONG/SHORT) mind irány-tudatos.
- **Biztonsági gate**: a reverse hedge Binance shortot igényelne, de a live `hedge-manager.mts` **szándékosan spot-only** (nincs futures/withdrawal perm). Ezért a reverse **paper-only**: live-ban a `detectArbOpportunity` + `openArbPosition` + `closeArbPosition` mind explicit blokkol (skip + ok, „needs Binance futures short — B20"). A paper modellezi mindkét lábat (a PnL funding-only, a delta-neutrális ár-lábak kiejtik egymást) → a stratégia **most paperben validálható**.
- **Teszt**: új `shared/funding-arb-reverse.test.mts` (8 case): forward/reverse direction + score, live-gate, küszöb-alatti skip, sanity-cap magnitude, és az accrual mindkét irányra (forward = hlRate; reverse = binanceRate − hlRate). `tsc --noEmit` + `npm run build` + teszt zöld.
- **Megmaradó (live) rész → B20**: Binance USDM futures-short adapter + perm-döntés, hogy a reverse élesben is fusson.

**Changelog:** [`CHANGELOG-2026-05-29.md`](../changelog/CHANGELOG-2026-05-29.md) (d szekció)

### Sprint 43 (2026-05-29) — Weather cron életre keltése (multi-cron fan-out)

**Mit ért el:**
- **Root-cause fix** egy „cron futott, a bot mégsem kereskedett" osztályú bugra (a Sprint 42G HL-deadlock testvére, de **eltérő ok**): a weather bot **≈8 napja (2026-05-21 óta) nem nyitott pozíciót**. A `runStatus.source` weather-en **soha** nem volt `cron`, csak `manual` → a Netlify egyszer sem hívta meg az `auto-trader-weather-cron`-t.
- **Gyökérok**: a két weather cron (`auto-trader-weather-cron` */5, `auto-trader-weather-reconciler-cron` */15) a legacy `export const handler = schedule(...)` wrappert használta, ami az esbuild/.mts build alatt **nem regisztrálódik**. A tüzelő cronok (`auto-trader`, `auto-trader-multi-cron`) mind sima `export default handler` + netlify.toml schedule mintát használnak.
- **Fix**: weather `run` + `reconcile` befűzve a bizonyítottan tüzelő `auto-trader-multi-cron` */3 fan-out-ba (`FanOutTarget.action` szélesítve `"run" | "reconcile"`-ra). A dispatcher weather `run` ága `cronEnabled`-guardot kapott, hogy a `weatherCronEnabled` pause-toggle cron-tick-eken megmaradjon (manuális Scan változatlanul fut). A két halott wrapper fájl + netlify.toml entry **kivezetve**. UI/Settings label `5 min → 3 min`.
- `npx tsc --noEmit` + `npm run build` zöld. Élesedés: a következő `netlify deploy --prod` után `runStatus.source` weather-en `cron`-ra vált.

**Másodlagos megfigyelés (nem bug):** a weather temp-piacok (ázsiai városok) `endDate = 12:00 UTC`, így a napi kereskedési ablak ≈ 00:00–12:00 UTC — a fix utáni `*/3` cron ezen belül fog automatikusan nyitni.

**Changelog:** [`CHANGELOG-2026-05-29.md`](../changelog/CHANGELOG-2026-05-29.md) (b szekció)

### Sprint 42G (2026-05-29) — HL consecutive-loss deadlock fix

**Mit ért el:**
- **Root-cause fix** egy 🔴 deadlock-bug-ra, amit a 2026-05-29 HL performance-audit tárt fel: a HL bot **12 napja (2026-05-17 óta) nem kereskedett**, miközben a cron futott. Ok: a `consecutiveLosses` counter (5) ≥ `consecutiveLossLimit` (3), és a [`decision-engine.mts:108`](../../netlify/functions/auto-trader/hyperliquid/decision-engine.mts) minden tick-en blokkol amíg a counter ≥ limit. A counter **csak nyertes trade-en** nullázódik → nincs trade → nincs win → permanens block. A "design intent 1h pause" valójában örökös leállás volt.
- **Fix 1 — auto-recovery**: új pure helper `clearElapsedConsecutiveLossPause()` a [`hyperliquid/session-manager.mts`](../../netlify/functions/auto-trader/hyperliquid/session-manager.mts)-ben; a [`index.mts`](../../netlify/functions/auto-trader/hyperliquid/index.mts) runner a stopped-check és a pause-check között hívja. Lejárt `pausedUntil` + counter ≥ limit → slate wipe (counter→0, pausedUntil→null). A meglévő bricked session **deploy után a következő cron-tick-en magától felépül**, reset nélkül.
- **Fix 2 — `resumeHlSession`**: eddig csak `pausedUntil=null`-t állított, a countert nem → a `resume` action **nem oldotta fel** a deadlockot (a raw-count gate továbbra is blokkolt). Most a countert is nullázza → a `resume` valódi, history-megőrző unbrick.
- Új `PAUSE_AUTORECOVER` LogEvent (audit-trail). 6 új unit test ([`shared/hl-consec-loss-recovery.test.mts`](../../netlify/functions/auto-trader/shared/hl-consec-loss-recovery.test.mts)). `tsc --noEmit` + `npm run build` zöld.

**Mit NEM tett (szándékos scope — lásd B18):** a HL bot **long-bias** (22/22 trade LONG, 27.3% WR, 32.7% calibration-deviation) **nem** deterministikus kód-bug, hanem signal-quality / regime-kérdés (n=22 kicsi) → külön vizsgálati tétel **B18**, nem ad-hoc kód-változtatás.

**Changelog:** [`CHANGELOG-2026-05-29.md`](../changelog/CHANGELOG-2026-05-29.md)

### Sprint 42F (2026-05-15) — Sports `sessionLossLimit` Settings-knob

**Mit ért el:**
- A sports bot `SPORTS_SESSION_LOSS_LIMIT` env-only küszöbe Blobs-tunable lett: új `sportsSessionLossLimit` SCHEMA mező a [`trader-settings.mts`](../../netlify/functions/trader-settings.mts)-ben (default 30 USD, range 5-500). Mind a 3 sports preset bővült (Lazább 50 / Normál 30 / Szigorú 20 USD).
- [`getEffectiveSportsConfig()`](../../netlify/functions/auto-trader/sports/config.mts) olvassa az új override-ot. A `sports/index.mts` :213-as session-loss guard automatikusan használja — külön módosítás nem kellett.

**Trigger:** Az operátor a sports bot session-jén "Session loss limit hit" auto-stopot kapott, és redeploy nélkül akarta beállítani a küszöböt. A crypto + HL bot már Settings-tunable volt, a sports nem. Weather + F-Arb nem rendelkezik session-loss-limit fogalommal — ha kell, B-backlog kandidátus.

**Changelog:** [`CHANGELOG-2026-05-15.md`](../changelog/CHANGELOG-2026-05-15.md) "Follow-up" szekció.

### Sprint 41 (2026-05-15) — Outcome-overlap gate + 7-trade audit + vol_divergence K-extrakció fix

**Mit ért el:**
- **Audit**: a 7 closed crypto trade Polymarket Gamma `&closed=true` ellenőrzése — minden exit price egyezik, paper-fee modell ±3 tizedesjegyig reprodukál, bankroll-rekonciliáció pontos ($250 + $21.96 − $34.96 = $237).
- **Új gate #16** a crypto/decision-engine.mts-ben: `Outcome-overlap (NO+YES BTC párok)` — blokk NO@K_lo + YES@K_hi pár ha K_hi > K_lo same closingKey. Strukturálisan különbözik a #15 Monotonicitás-gate-től (predikció vs side-bet kontradikció).
- **Új shared helper** `findOutcomeOverlapViolation` + 8 új test case (összesen 18 a `cross-position-gates.test.mts`-ben).
- **Root-cause fix**: `getVolSignal` Black-Scholes K-extrakció bővítve `above-Nk` piacokra (új `parseThresholdK` helper). Pre-fix K=S fallback → fair YES ≈ 0.5 K-tól függetlenül; post-fix BTC=$80,620 mellett 78K→0.98, 80K→0.69, 82K→0.14.
- 4 másik bot decision-engine-jébe coverage-comment (HL Directional-consistency, F-Arb Coin-capacity, Weather Σ P(YES) ≤ 1, Sports Outcome-sum már lefedi az outcome-overlap esetet).
- math/13 § + math/10 § frissítve; README.md + CryptoTrader.tsx komment 15→16; CLAUDE.md 41. session bejegyzés.

**Changelog:** [`CHANGELOG-2026-05-15.md`](../changelog/CHANGELOG-2026-05-15.md)

**Mit NEM tett (szándékos sprint scope):**
- A 4 K-blind signal súlyozása threshold piacokon — átkerült Sprint 42A candidate-re.
- Új `topup` action (bankroll növelése reset nélkül) — backlog B9.

### Sprint 40 (2026-05-14f) — HL Perp consecutive-loss pause UX + Settings

**Mit ért el:**
- `TraderAlert` interface bővítve opcionális `action: { label, onClick, disabled?, title? }` mezővel → inline `Cancel pause` gomb a HL pause alerten, `Resume` gomb a stopped alerten.
- Új Settings knob `hlConsecutiveLossPauseHours` (Blobs-tunable, default 1h, range 0.0833-24h). 3 HL preset bővült (loose 0.5h, normál 1h, szigorú 2h).
- `getEffectiveHlConfig()` mostantól olvassa a Blobs override-ot a `consecutiveLossPauseHours`-re.

**Changelog:** [`CHANGELOG-2026-05-14f.md`](../changelog/CHANGELOG-2026-05-14f.md)

### Sprint 39e (2026-05-14e) — Cross-market consistency gate (Monotonicity, mind az 5 botra)

**Mit ért el:**
- Új shared helper `auto-trader/shared/cross-position-gates.mts` (`parseBtcAboveSlug` + `findMonotonicityViolation`).
- 5 bot mindegyike kapott bot-specifikus cross-position gate-et a non-short-circuit gate-lista végére:
  - **Crypto** `Monotonicitás (egyéb nyitott pozíciók)` (CRYPTO_GATE_LABELS[14], later [14] of 15)
  - **Weather** `Monotonicitás` (Σ P(YES) ≤ 1 per (city, date) negRisk)
  - **HL Perp** `Directional-consistency (no LONG+SHORT same coin)`
  - **F-Arb** `Coin-capacity (cross-position)`
  - **Sports** `Outcome-sum (cross-position)` per eventSlug (SportsPosition `eventSlug?` mező hozzáadva, backward-compat)
- Új test suite `cross-position-gates.test.mts` (10 case: parser + violation-finder + 2026-05-14 incident reprodukció).

**Changelog:** [`CHANGELOG-2026-05-14e.md`](../changelog/CHANGELOG-2026-05-14e.md)

**Mit NEM tett (kiderült Sprint 41-ben):**
- A monotonicity-gate csak a model-predikciók koherenciáját ellenőrzi, a side-bet kontradikciókat NEM. A 2026-05-15-i incidens (80K-NO + 82K-YES, predikciók monotonok de bet-oldalak diszjunktak) → Sprint 41 új outcome-overlap-gate (#16).

### Sprint 38 (2026-05-14d) — Edge Tracker Tier-1 metric expansion

**Mit ért el:**
- `SummaryStats` 9 új mező: `sharpeCiLo`/`sharpeCiHi` (200-resample bootstrap, deterministic LCG), `sortinoRatio`, `profitFactor`, `expectancy`, `payoffRatio`, `longestWinStreak`/`longestLossStreak`, `currentStreak`, `evGap`, `maxDrawdownDuration`
- `CumulativePoint` 2 új mező: `drawdown`, `peak` (running underwater curve)
- Új `UnderwaterDrawdownChart` (Edge Tracker tab)
- Mind az 5 kategória (crypto/weather/HL/F-Arb/sports) **automatikusan** kapja az új metrikákat a `CategoryDashboard /trade/{category}/edge-tracker` routing-on át — zéró per-bot kód-duplikáció

**Changelog:** [`CHANGELOG-2026-05-14d.md`](../changelog/CHANGELOG-2026-05-14d.md)

**Mit NEM tett (szándékos sprint scope):**
- A recommendations engine **még nem használja** az új metrikákat — az a Sprint 42B feladata (Statistics-driven recommendations expansion)
- Per-trade reliability diagram (Tier 2) — 200+ trade kell, backlog B1

### Sprint 37 (2026-05-14c) — Coach-mode Recommendations + time-decay IC

**Mit ért el:**
- Új `recommendations.mts` per-bot engine (8 szabálycsoport, hard guardrail-ek explicit skip)
- Új `recommendations-api.mts` GET endpoint (auth-protected)
- Új `RecommendationsCard.tsx` React UI (Apply gomb a `trader-settings` POST-on)
- 4 trader oldal wire-up (Crypto/Weather/HL/F-Arb)
- Új `icHalfLifeTrades` Settings knob + `weightedPearsonCorrelation` helper
- HL `combinerConfidenceMin` mis-target bug fix (post-audit)
- math/17 + master-plan + CLAUDE.md + changelog update

**Changelog:** [`CHANGELOG-2026-05-14.md` §(c) + §(k–p)](../changelog/CHANGELOG-2026-05-14.md)

**Commits:** `217fd64`, `3206696`, `62ea74f`, `ed05bf7`

> Korábbi sprint-ek (Sprint ≤36, 2026-05-14b és korábban) — lásd [`changelog/`](../changelog/).

---

## 🚫 Anti-sprint (mit NE csinálj most, és miért)

| Mit NE csinálj | Miért | Mikor lesz "újra elérhető" |
|----------------|-------|------------------------------|
| Új signal hozzáadása a 8-signal combinerhez | Zaj, mielőtt a meglévő 8 mért IC-vel kalibrálva nincs (jelenleg priorok, nem mért értékek) | 200+ trade után (B1 Tier 2) |
| Live-flip bármelyik boton (`PAPER_MODE=false`) | Paper validation gate még nem teljesít (≥30 trade kell). `liveReadyOverrideEnabled` opt-in **csak tudatos kockázat** | Sprint 39+ után, ha N≥30 + IC≥5% + Sharpe≥0.5 + DD<25% mind ✓ |
| Autopilot mode bekapcsolása a recommendations engine-en | Regime-shift drift kockázat sokkal nagyobb mint a 1-3 nap operator-latency | **Soha** (tudatos design) — vagy 200+ trade + 30+ nap stabil regime |
| Sports bot teljes pipeline (P4.2) | Még stub szinten — addig a stratégia-spec sem véglegesedett | Sprint 42C-re, ha az operátor explicit kéri |
| Macro / Politics bot | Sport-tól is távolabb, hosszú lejáratú események, low-confidence | Sprint 50+ valószínű |
| Kelly fraction auto-tuning Sharpe alapján | Hard guardrail, operator-only door | **Soha** |
| Sanity cap (40%) felemelése | Model-error védőháló, ne mozdítsd | **Soha** kódból; csak operator manuálisan |
| Session loss limit auto-tuning | Hard stop, kockázat-kezelés | **Soha** |
| TradingAgents (P4.3) | Kísérleti, csak budget-bővítés után | B3 backlog |
| LP wallet whitelist generation (P2.4 + C3) | Apex consensus signal jelenleg null IC → felesleges optimalizálni | B8-ban gyűjtve, alacsony prioritás |

---

## Sprint workflow & szabályok

### Sprint indítás

1. **Active sprint zárása** — a `Sprint NN` szekció átkerül a "✅ Completed sprints" elejére (rolling 5 utolsó).
2. **Új active sprint** — egy "Next sprint candidates" tétel előléptetve a "🔥 Active" szekcióba.
3. **Sprint frissítés dátuma** — `Utolsó frissítés:` mező frissítve a fájl tetején.

### Új feladat felvétele

| Feladat típus | Hova kerüljön |
|---------------|---------------|
| Operator-akció (Settings change, login, button click) | Active sprint táblázatba új sor |
| Kód-fejlesztés a meglévő rendszerben | Next sprint candidates szekció |
| Új signal / stratégia | `new-strategies.md`-be ÉS sprint candidates §3-as referenciával |
| Új Netlify function / cron | Next sprint candidates VAGY backlog (precondition függő) |
| Új doksi / refactor | Active sprint vagy next, ha standalone |
| Hetzner VPS-feladat | Backlog B2 vagy `hetzner-migration.md`-ba új fázis-lépés |

### Sprint completion criteria

Minden sprint **legalább 1 mérhető acceptance criterion**-nal zárul. Soft kritérium ("javítva", "stabilabb") nem elég — konkrétan számszerűsített ("20+ closed trade", "build verify zöld", "math/NN doksi frissítve").

### Anti-sprint update

Ha egy "🚫 Anti-sprint" tétel pre-conditionje teljesül (pl. 200 trade megvan), a sor átkerül "📋 Next sprint candidates" alá és törlődik az anti-listából. Soha NE töröld silently — az anti-lista history értékes.

---

## Hivatkozások

- **Implementáció-státusz SSOT:** [`master-plan.md`](./master-plan.md)
- **Stratégia-katalógus:** [`new-strategies.md`](./new-strategies.md)
- **Session-by-session leírás:** [`../changelog/`](../changelog/)
- **Math/algoritmus reference:** [`../math/`](../math/)
- **Sprint workflow filozófia:** ez a fájl (SSOT)

---

## Hatás-elemzés — Sprint 42A K-blind signal re-weighting (2026-05-15)

A Sprint 41 vol_divergence K-extrakció fix után a 4 K-aware signal (vol_div, orderflow, apex_consensus, cond_prob) meaningfully K-érzékenységgel rendelkezik threshold piacokon. A 4 K-blind signal (`momentum`, `contrarian`, `funding_rate`, `pairs_spread`) viszont továbbra is BTC-szintű directional sentiment-jeleket ad, és a kombinált finalProb-ot mean-reversion-szerűen 0.5 felé húzza. Ez a szekció a re-weighting implementálásának várható hatását mennyiségileg vizsgálja.

### A combiner súlyozás jelenleg

```
w_k = ic_k × (1 + |signal_k − mean| × 0.5)
combined = Σ (w_k / Σw_k) × signal_k
```

A `(1 + |demeaned| × 0.5)` bonus a normától távolabbi jeleknek nagyobb súlyt ad, de a `ic_k` mindenkire 0.05-0.09 priorra van állítva. Ha egy K-blind signal 0.50 értéket ad és a K-aware vol_div 0.69-et, a combiner felé pull-erő:

- vol_div súly: `0.06 × (1 + 0.19 × 0.5) / total = 0.0657 / total`
- mom/contr/fund/pair (K-blind, mind 0.5): `(0.06+0.05+0.05+0.07) × 1.0 / total = 0.23 / total`
- of/apex/cond (K-aware, tegyük fel mind 0.5 értéket adnak ha nincs market-specifikus signal): `(0.09+0.08+0.07) × 1.0 / total = 0.24 / total`

A normálás után **vol_div súlya ~13%**, miközben a 4 K-blind signal **összesen ~45%** súllyal "húzza vissza" a kombinált értéket 0.5-höz. Innen jön a "0.46-os finalProb minden K-ra" mintázat.

### A javasolt fix matematikailag

Új tuning knob `combinerKBlindDownweight ∈ [0, 1]` (default 0.5). Threshold piacokon (`parseThresholdK(slug) !== null`) a 4 K-blind signal IC-je megszorozódik ezzel:

```
ic_k_effective = ic_k × (slug-is-threshold AND k in K_BLIND ? downweight : 1.0)
```

Default `0.5` mellett a fenti példa új súlyozása:

- vol_div: `0.06 × 1.0 × bonus / total_new`
- K-blind 4: `(0.06+0.05+0.05+0.07) × 0.5 = 0.115 / total_new`
- K-aware 3: `0.24 / total_new`

A K-blind csoport hozzájárulása **45% → 26%**-ra csökken. A K-aware csoport (4 signal) hozzájárulása **~50% → ~64%**-ra nő. **A combiner output K-érzékenysége ~28%-kal megnő.**

### Numerikus szimuláció — Sprint 41 incidensre alkalmazva

BTC = $80,620, T = 6h, σ = 0.6, post-K-fix:

| Piac | vol_div (új) | of, apex, cond (becslés) | K-blind (mean) | Combined pre-Sprint-42A | Combined post-Sprint-42A | Δ |
|---|---|---|---|---|---|---|
| `above-78k` | 0.98 | ~0.85 (markup-side jel) | 0.50 | ~0.61 | ~0.75 | +0.14 |
| `above-80k` | 0.69 | ~0.65 | 0.50 | ~0.55 | ~0.62 | +0.07 |
| `above-82k` | 0.14 | ~0.20 | 0.50 | ~0.37 | ~0.26 | −0.11 |

A finalProb-ok |Δ| ≥ 0.10 elmozdulás várt — ami **a `Combiner confidence gate (|p − 0.5|)` küszöbnek elegendő** (Normal 5%, Loose 2%). A 2026-05-15 incidens 3 contrarian trade-je esetében:

- `above-80k` (today): pre-Sprint-42A pred ≈ 0.55 → `|0.55 − 0.5| = 0.05` → épphogy átmegy Normal gate-en. Post-Sprint-42A pred ≈ 0.62 → `|0.62 − 0.5| = 0.12` → gate átengedi **valódi K-aware jellel** (nem noise).
- `above-82k` (today): pre-Sprint-42A pred ≈ 0.37 → `|0.37 − 0.5| = 0.13` → Normal gate átengedi. Post-Sprint-42A pred ≈ 0.26 → `|0.26 − 0.5| = 0.24` → erősebb signal, **a bot már NEM YES-t fogad** (0.26 < market 0.13 → bot szerint YES overvalued → NO bet helyes).

### Grinold-Kahn IR hatás (statisztikai)

A re-weighting csökkenti a 4 K-blind signal IC hozzájárulását, ami **csökkenti a kombinált IR-t** Grinold-Kahn szerint. De ez akkor súlyos, ha a K-blind signal-eknek **lenne** valós IC-je threshold piacokon — kérdés, hogy van-e.

A `momentum` és `contrarian` signal **BTC-átlagos directional bias-t** ad, ami threshold piacon (pl. `above-80k`) **közvetett information** — ha BTC bullish, akkor P(>80K) növekszik. **De a vol_divergence már explicit fair-yes-t számol**, ami magában foglalja ezt is (BTC spot vs K). Tehát a K-blind signal-ek a threshold piacon **double-count-ot** adnak — ugyanazt az "információt" duplikálva.

Konkrét IR-becslés:

- **Pre-Sprint-42A**: 8 signal, átlag IC 0.066, `effN = 8 × 0.6 = 4.8` (cov-aware), `IR = 0.066 × √4.8 = 0.145`
- **Post-Sprint-42A (threshold piacon)**: vol_div + 3 K-aware (0.4 IC összesen) + 4 K-blind × 0.5 = 0.115 effective IC → átlag IC ≈ 0.064, `effN = 4.8` (same), `IR ≈ 0.140`

**Az IR alig változik (~3%-os csökkenés)**, de a finalProb K-érzékenysége megnő ~28%-kal. Ez egy **kedvező trade-off**: kevesebb double-count, jobb signal-to-noise.

### Mit veszítünk

1. **K-blind signal hozzájárulás up-or-down piacokon érintetlen**: ott a `marketKind !== "threshold"` ágon a default IC-k mennek tovább, **zéró regression**.
2. **K-blind signal hozzájárulás threshold piacokon 50%-kal csökken**, ami legrosszabb esetben (ha a K-blind signal-nek valós nem-redundáns IC-je van) **~3%-os IR-veszteség**. Cserébe a finalProb 28%-kal K-érzékenyebb.
3. **Settings-tunable downweight** (`combinerKBlindDownweight` default 0.5) — az operátor visszaállíthatja 1.0-ra ha az IC-kalibráció kimutatja hogy a K-blind signal-eknek tényleg van valós IC-je threshold piacokon.

### Hosszú távú konvergencia

Ha a `useRealizedIC` toggle aktív (Settings → Signal calibration → Use realized IC), a Bayes-shrinkage `effective_IC = n/(n+k) × realized + k/(n+k) × prior` természetesen lecsökkenti az alacsony-IC signal-ek súlyát. **Tehát ~50-100 trade után a realized-IC mechanizmus magától elvégzi a fix-et statikus prior-update nélkül**. A Sprint 42A értelme: **most azonnal megoldani, amit a realized-IC kalibráció ~30-50 trade múlva automatikusan megoldana**.

Cserébe Sprint 42A nem zár ki a realized-IC mechanizmus későbbi alkalmazását — a kettő egymásra épül (a downweight = strukturális prior, a realized-IC = mért utófrissítés).

### Implementációs kockázat

- **Alacsony**: 30 LOC change a `combine()` függvényben + 1 új helper + 1 Settings knob.
- **Test coverage könnyen biztosítható**: a `signal-combiner-threshold.test.mts` bővíthető 2-3 új unit-teszttel (regression: up-or-down piacon nincs változás, threshold piacon downweight érvényesül).
- **Live deploy regression**: zéró, mert default `downweight=0.5` csak threshold piacokra hat, és up-or-down piacokon (a HL bot fő use-case-ek) nincs változás.
- **Calibration-ütközés**: nincs — a realized-IC blend egy másik réteg (Bayes-shrinkage az IC-n), nem a `marketKind` szerinti súly-szorzó.

### Mikor kell indítani

A Sprint 42 közepén/végén ha a vol_div fix önmagában nem javítja eléggé a Gate-3 blokk-arányt. Ha 10+ post-Sprint-41 trade-en a finalProb még mindig 0.45-0.50 sávban ragad → Sprint 42A trigger.

Ha a finalProb meaningfully szétválik K-szerint (78K → >0.7, 80K → ~0.6, 82K → <0.3), Sprint 42A halasztható **B10 backlog**-ba — a vol_div fix önmagában elég volt.
