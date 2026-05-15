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
> **Utolsó frissítés:** 2026-05-15 (sprint 41 zárás Outcome-overlap gate + 7-trade audit + vol_divergence K-extrakció fix; ops sprint 42 indítás)
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

---

## ✅ Completed sprints (rolling 5 utolsó)

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
