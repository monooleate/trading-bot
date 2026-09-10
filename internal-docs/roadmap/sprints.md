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
- **Sprint-szintű terv:** ⚠ **Felváltva → B52** (2026-09-08): az Open-Meteo ensemble API azóta keyless
  módon szolgálja az ECMWF IFS-ENS-t (51), az ECMWF AIFS-ENS-t (51) és a Google WeatherNext 2-t (64) is,
  egyetlen kérésben — az (a)/(b)/(c) opciók (akadémiai kulcs / saját GRIB2-pull / fizetős szolgáltató)
  ezzel tárgytalanok a következő lépcsőre. Ez a tétel csak a B52 után, live-skálán merül fel újra.

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
- **⚠ Új blokkoló — joghatóság (2026-09-10, API-felmérés, élőben mérve).** A box IP-je Polymarket-oldalon **geoblockolt**: `GET https://polymarket.com/api/geoblock` a boxról → `{"blocked":true,"country":"DE","region":"SN"}` (Hetzner, Szászország). A [Polymarket geoblock-doksi](https://docs.polymarket.com/api-reference/geoblock) szerint **DE = close-only**: meglévő pozíció zárható, **új nem nyitható** — frontenden és API-n is. A Polymarket live-flip (`PAPER_MODE=false`) tehát a mostani boxról **technikailag sem működne**; a paper-mód (read-only piaci adat) nem érintett. Emellett **(a)** az SZTFH 2026 januárja óta ISP-szinten blokkoltatja a polymarket.com-ot Magyarországon, tiltott szerencsejáték gyanújával (ideiglenes intézkedés, a végleges határozat a [CMS](https://cms.law/en/hun/legal-updates/hungary-temporarily-blocks-access-to-polymarket-over-alleged-illegal-gambling) szerint függőben); **(b)** az [ESMA 2026-07-03-i statementje](https://www.esma.europa.eu/sites/default/files/2026-07/ESMA35-243228190-8148_Public_Statement_on_the_application_of_the_national_product_intervention_measures_on_binary_options_to_event_contracts.pdf) szerint a MiFID II Annex I C(4)–(10) alapmutatójú event contract pénzügyi eszköz, így a bináris-opciós retail-tilalom alá esik (a C(10) a klimatikus változókat is lefedi → a weather-piacok valószínűleg érintettek). **Új precondition:** jogi tisztázás a Polymarket live-flip előtt; a geoblock megkerülése (VPN, más régiós szerver) **nem opció**. A HL/F-Arb live-útját a Polymarket-geoblock nem érinti (külön venue). Részletek: [changelog 2026-09-10](../changelog/CHANGELOG-2026-09-10.md).
- **Élesítés előtt ellenőrizni — live-order mértékegység (2026-09-10, 93. session, kódból, NEM igazolt).** A crypto live-út a `createAndPostOrder` `size` mezőjébe `sizeUSDC`-t tesz ([`crypto/execution.mts`](../../services/worker/src/pillars/crypto/execution.mts):177). A `@polymarket/clob-client`-ben ez a mező valószínűleg részvényszám. Ha így van, a live megbízás `sizeUSDC` darab részvényt venne, vagyis ár-szorzónyira alulméretezve, és a fill-részletek a `size_matched`-et USDC-nek olvassák. A paper-út nem érintett.

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

### B36 — HL Kelly win-prob mapping fix ✅ MÁR KÉSZ (2026-09-03, `534f637`) — a tracker volt elavult

- **Megállapítva 2026-09-09 (91. session):** a fix **2026-09-03 óta a kódban van**, a tétel csak nem lett ✅-re állítva. A user „végezd el a B36-ot" kérésére a re-implementálás **duplikált, káros munka lett volna** — helyette verifikáltam.
- **A kód** ([`kelly-sizer.mts`](../../services/worker/src/pillars/hyperliquid/kelly-sizer.mts)) pontosan a specifikált driftmentes horgonyt csinálja:
  ```ts
  const baseline    = 1 / (1 + rr);                 // rr = tpPct/slPct
  const winBracket  = clamp(baseline + (dirProb - 0.5) * BRACKET_CONVICTION_SCALE);
  rawKelly          = max(0, winBracket - (1 - winBracket) / rr);
  ```
  `1/(1+RR)` **azonos** a spec `slPct/(tpPct+slPct)` alakjával (tp=0.02, sl=0.01 → RR=2 → mindkettő **1/3**). A `BRACKET_CONVICTION_SCALE=0.5` az „edge-implikált drift-tilt".
- **Az invariáns kézzel ellenőrizve:** dirProb=0.5 → winBracket=1/3, loss=2/3 → `1/3 − (2/3)/2 = 0` → **edge=0 ⇒ Kelly=0**, ahogy a spec kérte (a régi kód itt 0.25-öt adott → ~3× túlméretezés).
- **Teszt-lefedettség:** [`kelly-sizer.test.mts`](../../services/worker/src/pillars/hyperliquid/kelly-sizer.test.mts) fejléce szó szerint *„pins the B36 fix"*; külön eset a nulla-edge → nulla méret és a baseline alatti dirProb → nulla (nincs negatív Kelly).
- **Tanulság (a 9. audit-sáv osztálya):** a tracker és a valóság szétcsúszott — a `sprints.md` nyitottként mutatott egy hat napja élő fixet. Pont ezt a drift-osztályt fogja a **napi ellenőrzés** (91. session).
### B37 — Sports fair-value redesign (Pinnacle de-vig) 🔴 STRATÉGIA-ÁTÉPÍTÉS

- **Állapot:** a sports bot **leállítva** (2026-07-23, operátor) — jelenleg NINCS edge-forrás. **Becslés:** több nap (külső adat + de-vig + kalibráció).
- **Feladat:** a „fair value" jelenleg `predicted = 0.5 + (yesPrice−0.5)·0.55` ([sports/decision-engine.mts:60](../../netlify/functions/auto-trader/sports/decision-engine.mts)) — a Polymarket **saját árát** húzza 0.5 felé → strukturálisan minden olcsó longshotot túlbecsül (evGap −$2677, ~10% WR). Kell: valódi **de-viggelt Pinnacle/sharp-book** referencia, belépés csak `devigged_true − pm_price > fee` esetén. Sub-fixek: NO-oldali edge leg-mismatch (`|P(YES) − noPrice|` a helyes `|P(NO) − noPrice|` helyett, ~3× felfújt edge, [sports/decision-engine.mts:82](../../netlify/functions/auto-trader/sports/decision-engine.mts)); paper settlement fee-parity (jelenleg 0%). **Amíg ez nincs → a bot maradjon leállítva/loss-limit-capelve** (`sportsSessionLossLimitEnabled=1` már alkalmazva).

### B38 — Crypto tail-de-selection + korreláció-tudatos aggregát pozíció-cap 🟡 ELŐKÉSZÍTVE 2026-09-09 (91. session)

> **Előkészítés, NEM implementáció.** A user kérése: „a B38-at készítsd elő." Az alábbi a végrehajtható terv, frissítve azzal, ami a 2026-07-23-i eredeti felvetés óta **már megépült**.

**Eredeti feladat (2026-07-23):** a crypto profit 4 longshot-találaton ült (top-4 +$801, a maradék 33 trade −$111; evGap −$454). Három alpont: (1) `selectionShrink` a szélső bucketekre, (2) `cryptoMaxEdgeCap` + `btcMinPriceBand` szigorítás, (3) korreláció-tudatos aggregát cap.

#### Mi változott azóta — mit NE építsünk újra

- **(3) nagyrészt LEFEDVE.** A **B49 #2** [`checkBetaCap`](../../packages/core/src/portfolio-exposure.mts) él (`betaCapEnabled=1`, `betaCapFraction=0.25`): a crypto + HL **együttes** kitettséget capeli a kombinált bankroll 25%-ára. Ez **tágabb**, mint amit a B38 kért (csak crypto), és aktív.
  **Maradék rés:** nem szegmentál **rezolúciós ablak** szerint — az azonos napra lejáró piacok egyetlen korrelált fogadás, amit a beta-cap nem lát. Ez az egyetlen valóban hiányzó darab a (3)-ból.
- **Risk-overlay-ek élnek** (`riskVolTargetEnabled`, `riskDdKillEnabled`, B49 #8) — a drawdown-oldal is fedve.
- **A (2) egyik fele megvan:** a `btcMinPriceBand` **0.10** default aktív (deep-OTM kizárva). A `maxEdgeCap` szigorítás nyitva.

#### Friss bizonyíték (2026-09-09)

- **Mind az 5 megkötött crypto trade** YES volt **0.10–0.38** belépőn, és **mind 0.000-ra rezolvált** (−$7…−$10). Ugyanaz a longshot-aláírás. **n=5 — nem elég egy live-feature-höz**, ezért ez a tétel előkészítés marad.
- **A B56 kontextusa fontos:** a threshold-ág forecastja **jó** (+90.9% skill a base rate ellen, n=20), a trade-ek mégis buknak → a hiba a **szelekcióban**, nem az előrejelzésben (optimizer's curse). Ez pontosan a B38 tárgya, és megerősíti az (1) alpontot.

#### Végrehajtási terv (mérés-first)

1. **Előbb mérni, aztán építeni.** A **B56b** tanulsága: egy plauzibilis „nyilvánvaló" javítás a valós ledgeren szimulálva **rontott** (Brier 0.2696 → 0.2889). A `selectionShrink` hatását ugyanígy kell szimulálni a ledgeren, **mielőtt** kódba kerül.
2. **Precondition: tiszta adat.** 2026-09-09-én **1** olyan rezolvált sor volt az egész rendszerben, aminek a first-observationje tiszta. Az (1) alpont kalibrálása szennyezett baseline-on értelmetlen, ezért a belépő: **B53 után ≥30 tiszta crypto sor**.
   *Állás 2026-09-10 ~16 UTC: **19** tiszta crypto sor. B67-szabállyal számolva; a jelzés-alapú régi szabály túlszámolt.*
3. **Amikor van adat:** (1) `cryptoSelectionShrink` knob, **default 0 = no-op**, a grossEdge előtt, a szélső ár-bucketekre; (2) `maxEdgeCap` plateau-sweep (**nem** a csúcs — [`@core/plateau.mts`](../../packages/core/src/plateau.mts) `selectPlateau`); (3) rezolúciós-ablak-tudatos aggregát cap a meglévő `checkBetaCap` **mellé**, nem helyette.
4. **Kimenet-ellenőrzés:** a promóciós kapu (B50 #1) döntse el, nem a PnL.
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

- **#9 ENB diverzifikáció-monitor ✅ IMPLEMENTED 2026-09-03 (66. session), mérés-only.** (`tsc` exit 0 + **35/35 teszt** + build zöld). Új pure modul [`packages/core/src/enb.mts`](../../packages/core/src/enb.mts) (`pearson` + `correlationMatrix` + `jacobiEigenvalues` [ciklikus Jacobi] + `effectiveNumberOfBets` [sajátérték-entrópia: ENB=exp(−Σpᵢlnpᵢ), topFactorShare]) + 7-csoportos [teszt](../../packages/core/src/enb.test.mts) (barbell-eset: 4 bot de ENB≈2). Bekötve az [`edge-tracker.mts`](../../services/api/src/routes/edge-tracker.mts)-be: minden bot closed-trade-jéből per-bot napi-PnL sorozat → corr → ENB (`enb` response-mező + `labels`) + új **`EnbCard`** az [`EdgeTrackerPanel.tsx`](../../apps/web/src/components/EdgeTrackerPanel.tsx)-en (ENB/N, diverzifikáció %, top-faktor %, koncentráció-warning). Mérés-only, 0 trading-hatás. Igazolja/hangolja a #2 crypto-béta capet. Doksi: [`math/26-enb.md`](../math/26-enb.md). **Follow-up:** min-torsion ENB; napi-return normalizálás. **→ Ezzel a B49 A-lépcső (#1–#9) TELJES.**
- **#8 risk overlays (vol-target + DD kill-switch) ✅ IMPLEMENTED 2026-09-03 (65. session), default-OFF.** (`tsc` exit 0 + **34/34 teszt** + build zöld). Új pure modul [`packages/core/src/risk-overlay.mts`](../../packages/core/src/risk-overlay.mts) (`realisedVol`, `volTargetMultiplier` [clamp cél/realizált-vol], `drawdownKill` [peak-to-current, fail-open]) + 4-csoportos [teszt](../../packages/core/src/risk-overlay.test.mts). Bekötve a crypto runnerbe ([`pillars/index.mts`](../../services/worker/src/pillars/index.mts)): DD-kill gate (peak a closed-trade equity-görbéből → halt új belépő) + vol-target skálázza a `sizeUSDC`-t (a beta-cap/#1-fill/entry-snapshot/alert konzisztensen a skálázott méretet használja). Knobok `riskVolTargetEnabled`/`riskVolTarget`/`riskDdKillEnabled`/`riskMaxDdFraction` (common, „Portfolio risk"). OFF → bit-azonos. Doksi: [`math/25-risk-overlay.md`](../math/25-risk-overlay.md). **Follow-up:** HL + portfólió-szint (a #9-cel közös kombinált equity-görbe); a DD-kill kiválthatja B33-at.
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

### B50 — Training / paraméter-optimalizáció discovery (a bot „trainelése") 🟠 TRACKER

- **#9 ledger-lefedettség (sports-ledger + deferred infra) ✅ IMPLEMENTED 2026-09-03 (77. session).** (`tsc` exit 0 + 44/44 teszt + build zöld). A #9 három részének **őszinte scope-ja:** **(a) sports prediction-ledger BEKÖTVE** — a sports bináris Polymarket-piac, ami rezolvál (mint crypto/weather), eddig semmi ledger nem volt rá; [`sports/index.mts`](../../services/worker/src/pillars/sports/index.mts)-ben `appendPredictions("sports",...)` + `reconcileLedger("sports")` a `saveSportsSession` után, config-fingerprinttel stampelve (#4), best-effort; a [`edge-tracker.mts`](../../services/api/src/routes/edge-tracker.mts) `LEDGER_CATEGORIES` += `"sports"` → a sports is kap ledger-stats/walk-forward/config-attrib/bandit szubsztrátumot. **(b) ledger → normalizált Postgres-tábla: DEFERRED (B12)** — a ledger MÁR Postgres-en van (blob_kv KV-shim), a normalizált `prediction_ledger` tábla csak SQL-nicety (koordinált worker+api + adat-shape kockázat). **(c) HL/F-arb ledger-baseline: NOT-APPLICABLE** — F-arb delta-neutrális (nincs P(YES)); HL perp (nincs bináris ár/rezolúció → a market-baseline walk-forward nem alkalmazható, a HL ledger természeténél fogva taken-only). **Állapot:** a sports leállítva (B37-ig) → a ledger a sports újraindulásáig nem tölt, de az infra kész. **Korlát (follow-up):** a fő edge-skip ág nem hordoz `predictedProb`-ot → a sports-ledger egyelőre taken-heavy (a teljes unbiasedness a decision-engine-exponálást + B37-et igényli). Doksi: [`math/35-ledger-coverage.md`](../math/35-ledger-coverage.md). **→ A B50 A-lépcső (#1–#9) TELJES** (a deferred/N-A részek indokolva).
- **#7 regularizáció-budget (holt-knob audit + plateau-not-peak) ✅ IMPLEMENTED 2026-09-03 (76. session).** (`tsc` exit 0 + teszt + build zöld). **Audit-eredmény:** a ~96 SCHEMA-knob mind bekötve fogyasztódik → **0 teljesen holt knob** (nincs törölnivaló; a korábbi egyetlen holt knobot a 67. session-audit már javította). **De 96 dimenzió túl sok a mintához** (False Strategy Theorem / MBTL) → a regularizáció **fegyelem, nem törlés.** Knob-osztályozás: **A. risk-guardrail** (SOHA nem tuning — Kelly/loss-limit/DD-kill/lev/cap; a #6 bandit sem érinti), **B. tunable** (kevés, nagy-karú — confidence-min/edge-threshold/Kelly-scale/domén-metódus-flagek → plateau-sweep szabad), **C. fix theory-default** (a hosszú farok — bonferroni/ob-imbalance/cooldown/min-price → NE sweepeld). Új pure fegyelem-eszköz [`packages/core/src/plateau.mts`](../../packages/core/src/plateau.mts): `selectPlateau` (a legszélesebb near-best futam közepe, nem a csúcs; `isPeak`-jelzés izolált tüskére) + `ensembleWeights` (softmax → ensemble a plateau fölött) + 5-csoportos [teszt](../../packages/core/src/plateau.test.mts). Munkafolyamat: B-knob sweep → #4 config-attribúció score → `selectPlateau` robusztus érték → #1 kapu + #3 DSR a promócióhoz. Doksi: [`math/34-regularization-budget.md`](../math/34-regularization-budget.md).
- **#6 diszkontált Thompson-sampling config-választó + #8 egységes felejtési faktor ✅ IMPLEMENTED 2026-09-03 (75. session), mérés-only.** (`tsc` exit 0 + **43/43 teszt** + build zöld). A discovery egyetlen erős új adaptív technikája. Új pure modul [`packages/core/src/thompson.mts`](../../packages/core/src/thompson.mts): **#8** `forgettingWeight(age, halfLife)`=`0.5^(age/halfLife)` (a megosztott decay-primitív); `betaPosteriors` (config-onként diszkontált `Beta(1+Σw·r, 1+Σw·(1−r))`); `thompsonRank` (**prob-best Monte Carlóval** — fix-seed LCG → Box-Muller → Marsaglia-Tsang gamma → Beta-minta, reprodukálható); `banditArmsFromRecords` (a config-attribuált ledgerből, reward = model-Brier < piac-Brier, age = kronológiai rang). 6-csoportos [teszt](../../packages/core/src/thompson.test.mts) (forgetting, diszkontált nEff, 80%-arm prob-best>0.95 + determinizmus, egyenlő ~50/50, ledger→arm, üres). Bekötve az [`edge-tracker.mts`](../../services/api/src/routes/edge-tracker.mts)-be (`banditEval`; a #8 fél-életidő az `icHalfLifeTrades` knobból >0, különben 75) + új **`BanditEvalCard`** ([`EdgeTrackerPanel.tsx`](../../apps/web/src/components/EdgeTrackerPanel.tsx), prob-best sávok + favorit-jelzés ≥90%). **A bandit JAVASOL** — a győztes alkalmazása (champion-challenger, bounded, risk-limitek kívül) gated follow-up. A #4 config-stampek forward-töltenek → kezdetben az „unlabeled" arm dominál. 0 trading-hatás. Kiegészíti az AdaHedge-et (jel-súlyok ↔ config-választás, ortogonális). Doksi: [`math/33-thompson-bandit.md`](../math/33-thompson-bandit.md). **Follow-up (#8 továbbvitel):** a Platt-kalibráció + realized-IC ugyanezt a `forgettingWeight`-et átvéve; **(#6 live):** champion-challenger shadow-promóció a #1 kapun át.
- **#5 offline kalibrációs harness — SPORTS + CRYPTO ág ✅ IMPLEMENTED 2026-09-03 (74. session), validáció-only.** (`tsc` exit 0 + teszt + build zöld). A weathertől eltérően a Shin (per-market z) + a HAR (fogadja a súlyokat) állapotmentes → nincs store-seed; a harness valós adaton **igazolja a metódust** (mérés-first, a `sportsUsePinnacle` / a fittelt-HAR élesítése előtt). **Sports:** [`packages/core/src/devig-eval.mts`](../../packages/core/src/devig-eval.mts) (`parseFootballData` [Pinnacle CLOSING `PSC*`-preferencia + fallback] + `scoreDevigMethods` [multiclass Brier+log-loss, N-way]) + 5-csoportos [teszt](../../packages/core/src/devig-eval.test.mts); script [`scripts/eval-devig.ts`](../../scripts/eval-devig.ts) (football-data.co.uk, no-DB). **Élő-verifikált** (2023/24 PL 380 meccs: power 0.5249 ≈ shin 0.5252 < mult 0.5258 — a Pinnacle-close ~hatékony a marginig, a rés kicsi = a discovery jóslata; az edge a lag, nem a de-vig). **Crypto:** [`packages/core/src/har-fit.mts`](../../packages/core/src/har-fit.mts) (`olsFit` + `fitHarWeights` [Corsi HAR OLS] + `evaluateHarForecast` [OOS MSE fitted vs equal vs RW]) + 5-csoportos [teszt](../../packages/core/src/har-fit.test.mts); script [`scripts/fit-har.ts`](../../scripts/fit-har.ts) (Binance napi klina, no-DB). **Élő-verifikált** (BTC 1000 bar: βD=0.098/βW=0.185/βM=0.175, R²=0.044, fitted ≈ equal de veri az RW-t — a napi RV nehezen jósolható, a rés kicsi → live-wiring csak konzisztens pozitív rés után). Doksi: [`math/32-offline-calibration-sports-crypto.md`](../math/32-offline-calibration-sports-crypto.md). **Follow-up:** sports edge = CLV/lag (B37 odds-feed); crypto fittelt-Corsi bekötése a `harRvSigma`-ba + per-coin együttható-store (gated). **→ A #5 mind a 3 doménje (weather/sports/crypto) kész.**
- **#5 offline kalibrációs harness — WEATHER-ág ✅ IMPLEMENTED 2026-09-03 (73. session), manuális backfill, mérés-only.** (`tsc` exit 0 + teszt + build zöld). A weather EMOS-kalibrátor (B49 #6) csak ≥20 forward-residual után fittel → a `weatherUseEmos` a deploy után hetekig tétlen. A historikus seed a bias-t + a valós forecast-hiba-szórást (underdispersion-fix) MOST becsüli. Új pure parserek [`packages/core/src/emos-seed.mts`](../../packages/core/src/emos-seed.mts) (`parseDailySeries` [null-guard], `buildSeedSamples` [multi-modell inter-modell mean/std], `seedDateWindow`) + 4-csoportos [teszt](../../packages/core/src/emos-seed.test.mts). Store-inject [`emos-store.mts`](../../services/worker/src/pillars/weather/emos-store.mts) `injectSeedResiduals` (csak új dátum, `seed:true`, sosem ír felül forward-residualt, cap+refit). Orchestrator [`weather/emos-seed.mts`](../../services/worker/src/pillars/weather/emos-seed.mts) (Open-Meteo Historical Forecast multi-modell + ERA5, keyless, ~2 hívás/állomás; **élő-verifikált**: London/3hó → 91 seed-sample). Trigger [`scripts/seed-emos.ts`](../../scripts/seed-emos.ts) (Bun, a boxon: `docker compose exec workers bun scripts/seed-emos.ts [months]`). A seed le van súlyozva (régi dátum → kiöregszik, ahogy a forward METAR-residualok jönnek). Doksi: [`math/31-emos-seed.md`](../math/31-emos-seed.md). **⚠ Operatív:** egyszer futtatni a boxon; a hatás `weatherUseEmos=1` mellett él. **Follow-up (#5 többi doménje):** sports Shin kalibráció (football-data.co.uk/the-odds-api), crypto HAR-RV fit (Binance-klinák); weather: METAR-obs a seedhez az ERA5 helyett + rank-histogram.
- **#4 per-trade config-címkézés + A/B-attribúció ✅ IMPLEMENTED 2026-09-03 (72. session), mérés-only, nincs migráció.** (`tsc` exit 0 + **39/39 teszt** + build zöld). A hiányzó A/B-plumbing: minden ledger-rekord az aktív config-fingerprintjével stampelve → per-config forecast-minőség. Új pure modul [`packages/core/src/config-fingerprint.mts`](../../packages/core/src/config-fingerprint.mts) (`hash32` FNV-1a + `configFingerprint` [rendezett override-`k=v` hash, nincs override→`"default"`] + `computeConfigAttribution` [configHash-csoportosítás → Brier-skill vs piac, explicit null-guard a `Number(null)===0` ellen]) + 4-csoportos [teszt](../../packages/core/src/config-fingerprint.test.mts). Ledger-stamp ([`prediction-ledger.mts`](../../packages/core/src/prediction-ledger.mts) `configHash?` a `PredictionRecord`/`IncomingPrediction`-ön + `buildIncoming`/`upsertRecords` [latest-wins] + `appendPredictions` param) — **blob_kv-JSON → nincs séma-migráció**; `trader-settings.mts` új `currentConfigFingerprint()`; a 3 runner (crypto/weather/HL) tickenként stampel (best-effort). UI: [`edge-tracker.mts`](../../services/api/src/routes/edge-tracker.mts) `configAttribution` mező + új **`ConfigAttributionCard`** ([`EdgeTrackerPanel.tsx`](../../apps/web/src/components/EdgeTrackerPanel.tsx), per-config Brier-skill tábla). A stamp a deploytól forward-tölt (régi rekordok `unlabeled`). **Feloldja a #3 két follow-upját** (valódi ONC a per-config forecast-sorozaton + cross-trial σ_SR). Doksi: [`math/30-config-attribution.md`](../math/30-config-attribution.md). **Follow-up:** PnL-oldali A/B (configHash az OpenPosition→ClosedTrade-re, residual JSONB → nincs migráció).
- **#3 effektív-trial DSR (klaszterezett trial-szám) ✅ IMPLEMENTED 2026-09-03 (71. session), advisory.** (`tsc` exit 0 + **38/38 teszt** + build zöld). A literál trial-DSR őszintévé tétele: a közel-duplikátum knob-tweakek (ugyanaz a knob újranyomva) ne számítsanak független túlillesztési esélyként. Új pure modul [`packages/core/src/trial-cluster.mts`](../../packages/core/src/trial-cluster.mts) (`jaccard` + `effectiveTrialCount`: a trial-gráf összefüggő komponensei `Jaccard(changed-keys) ≥ threshold`-on, N_eff = klaszterek száma ≤ literál N; threshold 0.5 korlátozza a láncolást) + 6-csoportos [teszt](../../packages/core/src/trial-cluster.test.mts). `trader-settings.mts` új `effectiveTrials()` → `{literal, effective}` (a `countTrials` `loadTrialLog`-ra DRY-olva). A 3 DSR-fogyasztó N_eff-re váltva (literál-fallback): worker crypto+status live-readiness ([`pillars/index.mts`](../../services/worker/src/pillars/index.mts)) + a #1 promóciós-kapu DSR-je ([`edge-tracker.mts`](../../services/api/src/routes/edge-tracker.mts)). N_eff < N → **kevesebb** (pontosabb, nem szigorúbb) defláció; a DSR advisory maradt → 0 trading-hatás. Doksi: [`math/29-effective-trials.md`](../math/29-effective-trials.md). **Follow-up:** valódi ONC a per-trial hozam-korreláción + cross-trial σ_SR — mindkettő #4-függő (per-trial hozam-sorozat kell).
- **#2 log-forward market-data recorderek ✅ IMPLEMENTED 2026-09-03 (70. session), default-OFF env-gated, mérés-only.** (`tsc` exit 0 + **37/37 teszt** + build zöld). A nem-visszatölthető tréning-adat forward-logja (Binance OI ~30-nap-cap; PM book-mélységnek nincs historikus endpointja). Új pure modul [`packages/core/src/market-recorder.mts`](../../packages/core/src/market-recorder.mts) (`capSnapshots` gördülő-ablak + `dueForSnapshot` per-stream throttle + `parseBinanceOiHist` + `compactBook` top-N best-first) + 4-csoportos [teszt](../../packages/core/src/market-recorder.test.mts). Worker recorder [`services/worker/src/recorders/index.mts`](../../services/worker/src/recorders/index.mts) (`runRecorders` a tick végén, a pillérek UTÁN, best-effort → sosem töri a ticket; `market-recorder` KV-store): **OI** (`RECORD_OI`, BTC/ETH/SOL, 15-perc/5000-cap ≈ 52 nap → veri a 30-napos retenciót) + **CLOB book** (`RECORD_CLOB_BOOK`, a nyitott crypto+weather pozíciók `/book`-ja a reset-mentes `loadSession`-ből, `fetchClobBook` #1-helper újrahasznosítva). **Mind default-OFF** (env `"true"`/`"1"` + deploy → indul). Fogyasztók: OI→#5 OI-Δ, book→#1 fill-modell + Kyle-λ/VPIN. Env katalogizálva ([env-vars.md](../current-state/env-vars.md)), doksi [`math/28-market-recorder.md`](../math/28-market-recorder.md). **Follow-up (ugyanez a #2):** Deribit IV-felület snapshot (surface-redukció), Pinnacle live-close (odds-api key), HL l2Book/OI (WS-worker, Hetzner). **⚠ Operatív:** a capture csak akkor indul, ha a user beállítja `RECORD_OI=1`/`RECORD_CLOB_BOOK=1`-et + deploy — addig minden nap elveszett adat.
- **#1 proper-score promóciós kapu ✅ IMPLEMENTED 2026-09-03 (69. session), mérés-only.** (`tsc` exit 0 + **36/36 teszt** + build zöld). Új pure modul [`packages/core/src/promotion-gate.mts`](../../packages/core/src/promotion-gate.mts) (`evaluatePromotionGate` + `PROMOTION_THRESHOLDS`): a proper-scoring + walk-forward-vs-market + PSR/MinTRL/DSR mérést egyetlen **előre-regisztrált** `PROMOTE / HOLD / INSUFFICIENT_DATA` verdikté fűzi — a **proper-score-kapuk hard** (sample≥30, Brier-skill>0, beats-market OOS, consistency≥0.6, cluster≤0.5), a **Sharpe-oldal (PSR/DSR/MinTRL) advisory** (sosem blokkol). Vékony ledger / nincs baseline (F-arb/sports) → a walk-forward kapuk advisory-vá fokozódnak (nincs hamis HOLD). Opcionális **challenger-mód** (Platt/AdaHedge `brierImprovement` → „flippeljük-e ON-ra?"). 11-csoportos [teszt](../../packages/core/src/promotion-gate.test.mts). Bekötve az [`edge-tracker.mts`](../../services/api/src/routes/edge-tracker.mts)-be (DSR `deflatedSharpe`-fal, σ_SR=bootstrap-CI-félszélesség, `nTrials=countTrials()`; `promotionGate` response-mező) + új **`PromotionGateCard`** az [`EdgeTrackerPanel.tsx`](../../apps/web/src/components/EdgeTrackerPanel.tsx)-en (a `SummaryCards` alatt). **0 trading-hatás** — semmi nem flippel automatikusan; a kapu az operátornak mondja meg, mikor SZABAD. Doksi: [`math/27-promotion-gate.md`](../math/27-promotion-gate.md). **Follow-up:** #4 per-trade config-címkézés (valódi A/B); UI challenger-selektor; #3 effektív-trial DSR (ONC); #6 champion-challenger shadow-automatizálás.
- **Forrás:** [`model-discovery-training.md`](./model-discovery-training.md) — 68. session (2026-09-03). User-kérés: „a botot trainelni kellene, sok paramétere változtatható → optimális kereskedő; mi a jó gyakorlat, honnan a valós adat, hogyan fusson." 1 read-only kód-katalógus (~96 knob + a teljes mérési/tanuló infra) + 3 webes kutató-ág (anti-overfit tuning; valós historikus adatforrások 6 doménben; online/adaptív + RL). A [`model-discovery-forecasting.md`](./model-discovery-forecasting.md) (B41) + [`model-discovery-expansion.md`](./model-discovery-expansion.md) (B49) **harmadik testvér-doksija**.
- **Központi tanulság:** a „training" itt NEM grid-search/Bayes-opt/RL a paper-PnL-en (mind a 3 ág csapdának jelöli) — hanem (A) a hangolási **célfüggvény** PnL→proper-score váltása, (B) **offline kalibráció valós historikus adaton** ott, ahol nagy-N nem-pénzügyi cél van (weather EMOS / sports Shin / HAR-RV), (C) egy fegyelmezett **online adaptív réteg** (AdaHedge megvan + diszkontált Thompson-sampling preset-választó). A mérő/tanuló infra MÁR épített és fut, de gyakorlatilag semmi nincs a live-ra kötve (kivéve `useRealizedIC`) → a fő kar a **meglévő advisory réteg élesítése**, nem új kód.
- **Két blokkoló infra-lyuk:** (1) a ledger **NEM címkézi, melyik knob-config termelte a trade-et** → nincs A/B-attribúció (csak trial-szám-DSR); (2) a legértékesebb adatok egy része **nem visszatölthető** (PM könyv-mélység, OI-history, Deribit-felület, Pinnacle live-close) → **log-forward MOST kell — minden nem-logolt nap véglegesen elveszett tréning-adat.**
- **Jelöltek (jóváhagyásra, discovery §5–§6 pontozott sorrend, mind TS-now hacsak nem jelölt):**
  - **#1 proper-score promóciós CÉLFÜGGVÉNY** (PnL helyett) — a meglévő mérés élesítése döntéssé; **először ezt** (legolcsóbb, legerősebb kar). ÚJ.
  - **#2 log-forward recorderek** (PM `/book`, crypto OI, Deribit chain, Pinnacle snapshot; HL `l2Book` WS a Hetzner-fázisban) — nem halasztható. ÚJ.
  - **#3 effektív-trial DSR** (ONC-klaszterezés + cross-trial SR-var + embargo + korrelált-predikció de-dup) — a meglévő literál-trial-DSR őszintévé tétele.
  - **#4 per-trade config-címkézés a ledgeren** — a hiányzó A/B-plumbing. ÚJ.
  - **#5 offline kalibrációs harness historikus adaton** (weather EMOS / sports Shin / HAR-RV — nagy-N cél) → a #B49 default-OFF knobok (`weatherUseEmos`/`sportsUsePinnacle`/`useHarRv`) élesítésének adat-alapja.
  - **#6 diszkontált Thompson-sampling preset-választó** (proper-score-jutalom) + champion-challenger shadow-promóció + **#8 egységes felejtési faktor** (Platt+IC+bandit, set-not-learn). AdaHedge marad.
  - **#7 regularizáció-budget** (holt-knob audit + plateau-sweep + ensemble-over-configs).
  - **#9 ledger→Postgres + F-arb/sports ledger + HL piaci-ár baseline** (→ B12).
  - **B-lépcső (Hetzner):** #10 foundation-modell mint KALIBRÁLT combiner-input; #11 kontextuális bandit (LinUCB, ≥ pár száz rezolúció); isotonic/beta kalibráció (≥500); stacking/GBM; offline orderflow-IC a tick-dumpokból; RL CSAK execution-re (live + HF-szimulátor után).
- **Skeptikus mentések (NE építsd):** end-to-end RL alfára/sizingra (reward-hacking a fill-modellen, 4–7 nagyságrend minta-hiány, seed-irreprodukálhatóság); a felejtési faktor / learning-rate online tanulása; bármely risk-guardrail auto-tuningja; Bayes-opt a live-PnL-en; CPCV/backtest-motor; foundation-modell nyers kvantilise a Kelly-be.
- **Kapcsolat:** B11 (walk-forward framework) a #3-mal jórészt **redundáns** → átcímkézni „ledger-scoring + honest-DSR"-re. B12 ← #9. B49 default-OFF knobok ← #1/#5 adja a tréning/élesítési protokollt. B41 ← #1/#6/#8 a végrehajtási fegyelme.
- **Precondition:** operátor-jóváhagyás a §6 A-lépcső sorrendre; a #2 log-forward recorderek indítása a többi munka ELŐTT javasolt (adat-vesztés).

### B51 — Crypto multi-coin scan-bővítés (BTC-only → BTC/ETH/SOL) ✅ IMPLEMENTED 2026-09-08 (81. session)

- **Trigger:** a user kérdése „állítsuk lejebb a küszöböt hogy több trade legyen?" → élő diagnózis (81. session): a crypto azért kereskedik alig, mert **piac-kínálat-szűke**, nem tight-küszöb — a scan BTC-only, és BTC a 78k strike-on ült → mind coinflip (a `resolution-risk` gate + a `combiner confidence` gate helyesen fogták). A küszöb-lazítás NEM segített volna (a gate-ek blokkolnak / coinflip-zaj). A **helyes kar: piac-szélesség** — több coin (a discovery B49 #5 „BTC-hardcode leváltása" célja). A Gamma- n ETH-nek is sok napi above-K + up-or-down piaca van (`ethereum-above-1900…3000-on-…`), SOL/others jövőre.
- **Implementáció** (`tsc` exit 0 + **45/45 teszt** + build zöld, `main`):
  - **SSOT új pure modul** [`packages/core/src/coin.mts`](../../packages/core/src/coin.mts): `coinFromText` (slug/kérdés → CoinInfo: binance/coingecko/fsym/deribit), `coinByBase`, `parseCryptoAboveStrike` (a **3 korábban duplikált** strike-regex — combiner `parseThresholdK` + gates `parseBtcAboveSlug` + a teszt lokális másolata — egyetlen forrásba vonva; kezeli a **BTC „k"-konvenciót** [78k→78000] ÉS az **ETH literált** [3000→3000], K USD-ben, `closingKey` **coin-scoped** → cross-coin sosem hasonlítódik). Új 7-csoportos [teszt](../../packages/core/src/coin.test.mts). Élő-verifikált slug-formátumok a Gamma-ról.
  - **Finder** [`btc-market-finder.mts`](../../services/worker/src/pillars/crypto/btc-market-finder.mts): `isBtcUpDown` → `detectCryptoUpDown` (coinFromText + `CRYPTO_COINS` env-allowlist, default `BTC,ETH,SOL`); minden `MarketInfo` `coin`-tag-et kap (új opcionális `MarketInfo.coin`).
  - **Combiner** [`signal-combiner.mts`](../../services/api/src/routes/signal-combiner.mts): a **7 BTC-hardcode-olt fetch coin-aware** (`coinOf(market)`, default BTC): `fetchCloses`/`fetchDailyOHLC`/`fetchBtcPriceAt` (spot+σ), `getFundingSignal(coin)`, Deribit `currency` + per-currency cache (csak BTC/ETH — másnak nincs option-chain → model-σ fallback), `getCondProbSignal` related-match coin+K identitásra, `parseThresholdK`/`parseCoinSymbol` a shared SSOT-ra delegálva.
  - **Aggregator** [`signal-aggregator.mts`](../../services/worker/src/pillars/crypto/signal-aggregator.mts): az order-book imbalance a piac saját coinjára (`coinFromText(slug).binance`, fallback BTC).
  - **Gates** [`cross-position-gates.mts`](../../services/worker/src/pillars/shared/cross-position-gates.mts): `parseBtcAboveSlug` delegál (K USD + coin-scoped closingKey); a decision-engine monotonicity/overlap display `$X` formátumra (K már USD).
- **BTC-viselkedés bit-azonos** (minden fetch default BTC, a BTC slug-ok ugyanúgy parse-olnak) → 0 regresszió a meglévő BTC-trade-ekre. Az ETH/SOL a deploy után élesedik (a `CRYPTO_COINS` env szűkíthető `BTC`-re, ha kell). Új env: `CRYPTO_COINS` ([env-vars.md](../current-state/env-vars.md)). Doksi: [`math/36-multi-coin.md`](../math/36-multi-coin.md).
- **Follow-up (Backlog):** ETH/SOL Deribit-IV (#7) tesztelése ETH-chainen; per-coin realized-IC (a calibration jelenleg kategória-szintű, nem coin-szintű) → ha az ETH-edge eltér a BTC-től, coin-particionált IC kellhet; SOL-markets megjelenésekor a scan automatikusan felveszi.

### B52 — Weather multi-model ensemble (GEFS-only → GEFS + IFS-ENS + AIFS-ENS + WeatherNext 2) — **1. lépcső ✅ IMPLEMENTED 2026-09-08 (82. session)**, 2-4. lépcső nyitva

- **Trigger (82. session, 2026-09-08):** a user kérdése — „be tudnánk integrálni weather api-kat vagy modelleket? elvileg a Gemini is pontosított a modelljén". **Élő API-felmérés + offline mérés** (kód NEM változott ebben a sessionben).
- **A dokumentált weather-patológia** (`2026-07-23`): `forecast_edge` **IC +0.393** (az irány JÓ), de **payoffRatio 0.44** — „jó irány, rossz sizing". A B49 #6 EMOS/NGR ezt az **ensemble-underdispersion**t célozza *kalibrációval*. **Ez a tétel a forrásnál javítja ugyanazt.**
- **A tény, amit a bot ma használ:** [`ensemble-forecast.mts`](../../services/worker/src/pillars/weather/ensemble-forecast.mts) `models=gfs_seamless` — **egyetlen modellcsalád**, 31 tag, `MAX_MEMBERS=31` cap. A deterministic ág ([`forecast-engine.mts`](../../services/worker/src/pillars/weather/forecast-engine.mts)) GFS+ECMWF-IFS+NOAA, DEB-súlyozva.
- **Élő-verifikált (2026-09-08, keyless, ugyanaz az `ensemble-api.open-meteo.com/v1/ensemble` endpoint):** `models=gfs_seamless,ecmwf_ifs025,ecmwf_aifs025,google_weathernext2_ensemble` **egyetlen kérésben 197 tagot** ad (31+51+51+64), a kulcsok modell-szuffixummal (`temperature_2m_member01_ncep_gefs_seamless`). Nincs +1 HTTP-hívás/piac. További elérhető: `icon_eu` (40), `gem_global` (21), `ukmo_global_ensemble_20km` (18), `bom_access_global_ensemble` (18), `icon_d2_eps` (20, EU 2 km).
- **A mért indok (T+0/T+1 daily-max, a bot saját állomásain, 2026-09-08):**

  | Állomás | nap | GEFS-only (ma) | Multi-model (197) | σ-arány |
  |---|---|---|---|---|
  | RJTT Tokyo | T+0 | μ 32.3 σ **0.49** | μ **29.3** σ **1.58** | **×3.2** |
  | RJTT Tokyo | T+1 | μ 34.0 σ 1.00 | μ **30.3** σ 1.96 | ×2.0 |
  | VHHH Hong Kong | T+1 | μ 31.9 σ **0.43** | μ 30.3 σ 1.07 | ×2.5 |
  | KORD Chicago | T+0 | μ 29.8 σ 0.70 | μ 27.9 σ 1.64 | ×2.3 |
  | EGLC London | T+0 | μ 18.8 σ 0.89 | μ 18.1 σ 0.63 | ×0.7 |

  A GEFS-only σ **2–3×-osan alulbecsli** a valós bizonytalanságot Ázsiában/USA-ban pont a bot lead-time-ján (T+2-re a hatás elhal), és a **μ akár 3.0–3.7 °C-kal** elcsúszik (Tokyo). Európában a multi-model σ *szűkebb* → nem uniform tágítás, hanem **helyesebb** σ. Ez pontosan a Kelly-túlméretezés gyökér-oka.
- **Kód-hatás (kicsi):** `models` string + a member-parser regex (`/^temperature_2m(_member\d+)?$/` → modell-szuffix-tűrő) + `MAX_MEMBERS` cap feloldása + per-modell tagolás az `EnsembleResult`-ban (a `deb.mts` per-modell hibáját már így is tudja súlyozni). A `bucket-matcher` és a B49 #6 EMOS változatlanul fogyaszt (μ, σ).
- **Kockázatok / amit MÉRNI kell, mielőtt default-ON:**
  - **A WeatherNext 2 és az AIFS-ENS natívan 6-órás** (az API hourly-ra interpolál) → a napi **max** csúcsa simulhat ⇒ hideg-bias. Az AI-modellek dokumentáltan **hideg-biasosak hőhullám-csúcsokon** (arXiv 2504.21195) — a max-hőmérséklet-bucketek pont ilyenek. **A meglévő EMOS (a+b·μ) + DEB ezt korrigálni tudja**, de csak mérés után.
  - **Nincs offline backfill:** a `historical-forecast-api` a `google_weathernext2_ensemble`-t csak **~2026-09-04-től** adja (előtte `null`), az `ecmwf_aifs025` ensemble-nek nincs archívuma. ⇒ **B50 #2-doktrína: log-forward MOST.** A [`emos-store.mts`](../../services/worker/src/pillars/weather/emos-store.mts) `logForecast` már minden scannelt állomást naplóz METAR-reconcile-lal → **elég a per-modell μ/σ-t is belerakni**, és 2-3 hét múlva a DEB/EMOS bizonyítékkal választ.
  - **Open-Meteo free tier = non-commercial + 10 000 hívás/nap**, és a hívás-súly nő a változószámmal (>10 változó → törtrészes többszörös). 197 tag ≈ 197 „változó" → a jelenlegi ~6 piac/tick × 20 tick/óra mellett ez **újraszámolandó**; élesedés (B10) előtt fizetős tier vagy saját GRIB-pull kell.
- **Lépcsők:**
  - **(1) ✅ Log-forward recorder + a flip-knob bekötve — IMPLEMENTED 2026-09-08** (`tsc` 0 + **48/48 teszt** + build zöld, `main`). Részletek: [`math/37-multi-model-ensemble.md`](../math/37-multi-model-ensemble.md).
    - **Pure core:** [`packages/core/src/multi-model-ensemble.mts`](../../packages/core/src/multi-model-ensemble.mts) — `parseModelList`, `splitEnsembleKeys` (a modell-taget a **válasz-kulcsból** olvassa, mert az Open-Meteo a belső domain-nevet adja vissza: `gfs_seamless` → `ncep_gefs_seamless`), `modelStatsForDate` (**modellenként egyenlő súlyú** keverék: σ² = modellen belüli variancia átlaga + a modell-átlagok varianciája — tagonkénti súly a 64-tagú WN2-nek kétszeres szavazatot adna a 31-tagú GEFS fölött) + [47 pinelt állítás](../../packages/core/src/multi-model-ensemble.test.mts).
    - **Fetch:** [`ensemble-forecast.mts`](../../services/worker/src/pillars/weather/ensemble-forecast.mts) `fetchMultiModelEnsemble` — `daily=temperature_2m_max` (numerikusan azonos a hourly-ből derivált maxszal, töredék payload), 1 kérés / 197 tag / ~30 KB / **~0,2 s**, `EnsembleResult`-alakban (minden meglévő fogyasztó változatlanul működik) + `perModel` bontás.
    - **Store:** [`multi-model-store.mts`](../../services/worker/src/pillars/weather/multi-model-store.mts) — (állomás, céldátum) párra **~3 órás** throttle (`dueForSnapshot`, ugyanaz a primitív, mint a B50 #2 recordereknél), gördülő 400 snapshot/állomás. Rögzíti a per-rendszer μ/σ-t **ÉS azt, amit a bot azon a tickben ténylegesen használt** (`baseMean`/`baseSd`) → azonos pillanatban vett fej-fej összehasonlítás. Az `obs` az **EMOS-store-ból** másolódik (`loadResolvedObs`) → **nincs második METAR-kör**. [13 integrációs assert valós Postgres (PGlite) ellen](../../services/worker/src/pillars/weather/multi-model-store.test.mts).
    - **Read-out:** [`scripts/eval-multimodel.ts`](../../scripts/eval-multimodel.ts) + [`packages/core/src/multi-model-eval.mts`](../../packages/core/src/multi-model-eval.mts) (+[31 assert](../../packages/core/src/multi-model-eval.test.mts)) — CRPS-skill + **var-ratio** (`mean(hiba²)/mean(σ²)`: >1 = underdispersed) + ±1σ/±2σ coverage, per állomás és összesítve, explicit PROMOTE/HOLD verdikttel. A teszt pineli a lényeget: *azonos pont-hiba mellett a becsületes σ jobb CRPS-t kap* — egy változat rosszabb MAE-vel is nyerhet.
    - **Knobok:** `weatherMultiModelRecord` (default **1** — csak logol; azért ON, mert a összehasonlítás **nem** backfillelhető: a WN2 historikus archívum csak ~2026-09-04-től él, az AIFS-ENS-nek nincs) + `weatherUseMultiModel` (default **0** — a flip). Env: `WEATHER_MULTIMODEL_RECORD`, `WEATHER_ENSEMBLE_MODELS`, `WEATHER_MULTIMODEL_INTERVAL_MIN`, `WEATHER_USE_MULTIMODEL` ([env-vars.md §13](../current-state/env-vars.md)).
    - **0 trading-hatás, élőben verifikálva** 4 állomáson: a recorder bekapcsolt fetch-csel a `predictedMaxC`/`confidence`/`modelUsed` **bit-azonos** a recorder nélküli hívással. Élő mérés Tokióra (2026-09-09 célnap): GEFS μ 33.97 σ 1.02 · IFS-ENS 30.80 · AIFS-ENS 28.78 · WN2 29.16 → keverék μ 30.68 **σ 2.21** (inter-modell 2.05). A GEFS **5.2 °C**-kal az AIFS fölött ül, miközben ±1.02 °C-ot állít magáról.
  - **(2) ⏳ Deploy + 2-3 hét adatgyűjtés**, majd `bun scripts/eval-multimodel.ts`.
  - **(3) ⏳ Flip** (`weatherUseMultiModel=1`) — **csak** ≥30 címkézett snapshot + pozitív CRPS-skill mellett.
    ⚠ **DUPLA-SZÁMOLÁS-VESZÉLY (2026-09-09):** a `weatherSigmaInflation` **2.25-ön ÉL**, és ugyanazt az alul-diszperziót korrigálja *utólag*, amit a multi-model keverék a *forrásnál* (az inter-modell tag). A flip előtt a σ-inflációt **újra kell mérni** a keverék σ-ján (`dispersionDiagnostics` a forward METAR-párokon), és nagy valószínűséggel **lejjebb kell venni vagy kikapcsolni** — különben a σ kétszer szélesedik, a confidence (`1 − σ/4`) beomlik, és a bot gyakorlatilag nem köt trade-et. A recorder `baseSd` mezője a **nyers** GEFS-szórást rögzíti (infláció előtt), tehát a B52 forecast-mérése maga NEM szennyezett — csak a trading-út. ⚠ Kevesebb trade lesz: a szélesebb σ lejjebb viszi a confidence-t (`1 − σ/4`), így a `weatherConfidenceMin` (0.65) több piacot blokkol — ez a szándék (Tokió a fenti példában kiesne: conf 0.745 → 0.448).
  - **(4) ✅ Regionális nagyfelbontás + további globális centrumok — IMPLEMENTED 2026-09-09 (85. session).** A lista **4 → 8 rendszer**: + `gem_global` (CMC, 21) és `ukmo_global_ensemble_20km` (MOGREPS-G, 18) mindenhol, + `icon_eu` (40 @ **13 km**) és `icon_d2` (20 @ **2 km**) Európában.
    - **Nem kellett per-régió lista** (ez volt a nyitott kérdés): a domainjén kívüli regionális modellt az API **némán elhagyja** a multi-model válaszból — verifikálva: Tokió `gfs_seamless,icon_eu` → **HTTP 200, 31 tag**, se hiba, se null-oszlop. Csak **önmagában** kérve ad 400-at, amit ez a kód sosem tesz. Egy lista tehát minden állomásra jó, és egy regionális modell hozzáadása nem tud elrontani egy általa nem fedett állomást.
    - **Mért** (2026-09-09, **egy** kérés, ~42 KB, **~0,2 s** — változatlan költség): Európa (London/München) **8 rendszer / 296 tag**, Madrid 7/276 (`icon_d2` kiesik), US/Ázsia/Dél-Amerika/Afrika 6/236.
    - **Kihagyva:** `bom_access_global_ensemble` (18 tagot hirdet, de minden tesztelt állomáson csupa **null** hőmérséklet-oszlop) és `ukmo_uk_ensemble_2km` (3 tag — modellenként egyenlő súlyú keverékben túl kevés használható modellen-belüli σ-hoz; egyetlen állomást fed).
    - **Élő-verifikálva:** London 8 rendszer / 296 tag (a két ICON ~1 °C-kal melegebb a globálisoknál — pont az a lokális jel, amit a 25 km-es rács elsimít), Tokió 6/236; a legacy trading-út mindkettőn **bit-azonos**.
    - A **US-regionális** (`gfs_hrrr`, `ncep_nbm_conus`) marad kint: azok **determinisztikusak** (forecast API), nincs ensemble-tagságuk → a keverékbe nem illenek; a determinisztikus DEB-ág bővítése külön tétel.
- **Kapcsolat:** felváltja a régi **B4** (a) ECMWF-kulcs / (b) GFS GRIB2 / (c) kereskedelmi opciókat egy keyless, ma elérhető (d) úttal. Kötődik: **B15** (weather σ kalibráció), **B35** (`weatherKellyScale`), **B40** (invert re-audit), **B49 #6** (EMOS), **B50 #2** (log-forward recorder).

### B53 — Prediction-ledger: first-sighting (μ, ár, config) hármas latch-elése ✅ IMPLEMENTED 2026-09-09 (85. session)

- **Trigger (84. session, 2026-09-08):** a user kérte a 09-04-én bekapcsolt 10 knob Edge-Tracker-kiértékelését. A read-out **nem volt elvégezhető**, és közben előkerült egy P1 mérési hiba.
- **A hiba:** a [`prediction-ledger.mts`](../../packages/core/src/prediction-ledger.mts) rescan-enként **felülírja** a `predictedProb`-ot és a `marketPrice`-t (`prev.marketPrice = inc.marketPrice`, :164; a mező doc-ja is „market YES price at the **latest** scan", :41), a `firstTs`-t viszont megőrzi. A weather ledger **minden** sora `scans > 1`. Így a tárolt (μ, ár) pár a **rezolúcióhoz legközelebbi** scan-ből való, nem a belépéskoriból.
- **Következmény:** a „veri-e a modell a piaci árat" mérés **nem azt méri, amit állít.** Az ár a lejárat felé mechanikusan a kimenetre konvergál — a weather ledgerben **43-ból 17 sor ára > 0.98, és ezek 94%-a YES-re rezolvált**; 43-ból 18 sor ára a kimenettől 0.02-n belül van. A bot viszont **belépéskor** kereskedik, nem az utolsó scan-en → a metrika nem a döntést tükrözi, és rendszerszinten a piacnak kedvez.
- **Mit érint (mind a 4 a szennyezett baseline-t olvassa):** `computeWalkForward` (Walk-forward kártya) · `computeConfigAttribution` (Config A/B kártya) · `banditArmsFromRecords` (a reward = „a modell verte a piacot") · a **promóciós kapu HARD gate-je** („beats market OOS"). A jelenlegi számok (crypto −98.7%, weather −233.6% Brier-skill) **nem alkalmasak döntésre**.
- **Fix ✅ (`tsc` 0 + 48/48 teszt + build zöld):** a `PredictionRecord` **írás-egyszer** hármast kapott — `firstPredictedProb`, `firstMarketPrice`, **`firstConfigHash`** —, amit az `upsertRecords` az első látáskor rögzít. A latch a frissítés **ELŐTT** fut, így egy pre-B53 rekordnál a frissítés előtti (régebbi) értéket kapja, onnantól immutábilis. A `predictedProb`/`marketPrice`/`configHash` marad „latest" (a UI azt mutatja).
  - A **config** is a hármas része, és ez szándékos: a pontozott predikciót ahhoz a confighoz kell kötni, amelyik **készítette** — ez oldja fel a B54 kar-kiéheztetését.
  - **4 fogyasztó** vált, mind `?? latest` fallbackkel: [`ledgerPointsFromRecords`](../../packages/core/src/walk-forward.mts) (walk-forward) · [`computeConfigAttribution`](../../packages/core/src/config-fingerprint.mts) · [`banditArmsFromRecords`](../../packages/core/src/thompson.mts) · a promóciós kapu hard „beats market" gate-je (a walk-forwardon át).
  - **18 új regressziós assert** a [`prediction-ledger.test.mts`](../../packages/core/src/prediction-ledger.test.mts)-ben: a latch write-once, a pre-B53 back-fill a frissítés ELŐTTI értéket veszi, és a végponti bizonyíték — az utolsó árral (0.99, YES-kimenet) a piac tökéletesnek látszik, a first-árral (0.25) a modell (0.30) a jobb előrejelzés, és az attribúció a forecastot **készítő** confighoz írja.
  - **Élőben verifikálva:** a jelenlegi (mind pre-B53) ledgeren a walk-forward számok **bit-azonosak** a fix előttivel → a fallback ép, a fix tisztán forward-tölt.
- **Nem-ok:** ez **nem** trading-hiba — a bot belépéskor a valós árral dolgozik; kizárólag a *mérési* réteg olvasott rossz mezőt.
- **Forward-only:** a már felülírt belépéskori árak **nem visszaállíthatók** (B50 #2 doktrína) → a tiszta mérés a deploytól indul. Doksi: [`math/21` §6](../math/21-walk-forward.md).

### B54 — A 10 bekapcsolt knob kiértékelése ⏸ BLOKKOLVA (B53 + minta-hiány)

- **Trigger:** a 80. session terve: „pár nap múlva Edge Tracker → a knobokat egyesével meghagyni/visszavenni."
- **Miért nem megy most (2 független ok):**
  1. **Nincs pre-flip kar.** A config-fingerprint helyesen elválasztja a 09-03 22:09-es flippet (`101cde4d` = előtte, `3683673b` = utána), de a rescan-enkénti stamp-felülírás miatt a flip előtti sorok átcímkéződtek: **n=3 vs n=214**. A Thompson-bandit „101cde4d 58% prob-best"-je a **priorból** jön (nEff **0.4**), nem bizonyíték.
  2. **A metrika maga sérült** → B53.
- **Precondition:** ~~B53~~ ✅ (2026-09-09) → **B53 deploy** + ≥2-3 hét friss adat, és a knobok egyesével (vagy legalább csoportonként) flippelve, hogy legyen valódi kontraszt. A B53 óta egy knob-flip már NEM címkézi át a még nyitott piacokat, tehát a két kar valóban szét fog válni.
- **Amit addig is tudunk (a szennyezéstől független):** a crypto modell **nem-informatív** — átlagos `|p − 0.5|` = **0.119**, miközben a piacé **0.296**; a modell Brier-je 0.213, a triviális „mindig 0.5" 0.25. Vagyis a combiner a 0.5 körül lebeg, míg a piac határozottan és helyesen áraz. Ez a dokumentált „lapos finalProb" patológia (Sprint 41-42A), és **nem** knob-hangolási kérdés. → külön vizsgálat, ha a B53 után is megmarad.

### B55 — Sports: kizárva a cross-bot aggregátumból + session-reset ✅ IMPLEMENTED 2026-09-09 (86. session)

- **Trigger:** a user kérdése — „miért baj, ha kereskedik a sports bot? nem a rendszer filozófiája szerint kereskedik?" majd: „állítsd vissza a sport botot nullára és úgy működjön ahogy kigondoltuk."
- **A kódból igazolt ok.** Odds-feed (B37) nélkül a sports élő fair-value-ja a [`decision-engine.mts`](../../services/worker/src/pillars/sports/decision-engine.mts)-ben: `predicted = 0.5 + (yesPrice − 0.5) × 0.55` — **annak az árnak a determinisztikus transzformációja, ami ellen fogad**; a pillérben **nulla külső adatforrás** van. Ebből az edge `= 0.45 × |ár − 0.5|`, ami a szélsőségeken maximális, a kapu pedig csak `≤15¢` / `≥85¢`-en nyílik → **minden belépő longshot, aritmetikából, nem felfedezésből** (a kód saját kommentje is „fabricated — no real edge").
- **Miért mérési probléma:** a sports **118/236 rezolvált ledger-sort** adott (2026-09-08) — a promóciós kapu bizonyítékának **fele** —, miközben a Brier-skillje **konstrukcióból ≈0** (mért −0,6%): nem tud érdemben eltérni az ártól, viszont a súlyával a „nincs edge" felé húzza az aggregátumot és **elfedi a másik három bot valódi jelét**.
- **Fix:** új `AGGREGATE_EXCLUDED` az [`edge-tracker.mts`](../../services/api/src/routes/edge-tracker.mts)-ben — a `category="all"` pool (walk-forward · config-attribution · Thompson-bandit · rajtuk át a promóciós kapu hard gate-je) kihagyja a sportsot. **A sports saját fülje változatlanul működik** (single-category kérés a saját ledgerét kapja), és a ledger **tovább gyűlik** (B50 #9) — csak nem hígít. A pool címkéje explicit: `all (excl. sports)`.
- **⚠ A fix rosszabbnak mutatja az aggregátumot, és ez a helyes:** a valós ledgeren ALL Brier-skill **−52,78% → −135,31%**. A sports a 0 körüli skilljével **érzéstelenítette** a mutatót; kivéve látszik, mennyire rosszul áll valójában a crypto+weather. (A −135% maga is még pre-B53-szennyezett — a valódi szám a tiszta forward-adattal jön.)
- **Session-reset:** a sports paper-session nullázva (bankroll $50, 0 trade); a **ledger NEM lett törölve** — az a mérési adat, és a reset a rendszerben sem érinti.
- **B37-nél visszavonandó:** amint a `pinnacleFairYes` fel van töltve, a forecast független lesz a Polymarket ártól → a sportsot ki kell venni az `AGGREGATE_EXCLUDED`-ből.

### B56 — Crypto: a „lapos predikció" diagnózisa → a directional ág az, ami nem működik 🟠 (87. session, 2026-09-09)

- **Trigger:** a 84. session aggregált megállapítása („a crypto modell nem-informatív, `|p−0.5|`=0.119 vs a piac 0.296"). A user: „csináld a crypto diagnózist."
- **⚠ Az aggregátum FÉLREVEZETETT — két ellentétes rezsimet fedett el.** Piac-típusonként bontva (98 ledger-sor, 91 rezolvált):

  | piac-típus | n | `|final−0.5|` | jel-szórás | `|ár−0.5|` | Brier | skill a base rate ellen |
  |---|---|---|---|---|---|---|
  | **threshold** (`above-K`) | 26 | **0.371** | 0.162 | 0.372 | **0.0226** | **+90.9%** (n=20) |
  | **up-or-down** | 49 | **0.037** | 0.113 | 0.267 | 0.2645 | **−6.5%** (n=48) |
  | other | 23 | 0.049 | 0.123 | 0.262 | 0.2790 | **−17.1%** (n=23) |

  A threshold-ág **kiváló** (a döntésképessége megegyezik a piacéval, a Brier-je a triviális 0.25 helyett 0.023); az up-or-down ág **rosszabb, mint a „mindig 0.5"** — és a kimenete gyakorlatilag konstans 0.5.
  *(Caveat: a threshold-minta részben „könnyű" — sok piac messze van a strike-tól —, tehát a +90.9% nem tiszta alfa. De a kontraszt valós.)*
- **Mechanizmus (kódból):** a threshold-ágnak van **strukturális horgonya** — a `combinerKAnchorStrength` (default 1.0) a `vol_divergence` Black–Scholes digitális fair-value-jához horgonyoz, a többi jel csak igazít rajta. A directional ágnak **nincs horgonya**: 9 gyenge, egymásnak ellentmondó jel súlyozott átlaga, ami matematikailag 0.5 köré esik. A `combinerLogOddsStrength=1` ott **aktív** (a threshold-ágon [`signal-combiner.mts:1518`](../../services/api/src/routes/signal-combiner.mts) szándékosan kihagyja), de nem segít: egymásnak ellentmondó logitok súlyozott **átlaga** is 0 körül marad.
- **Ráadás: a combiner súlyának ~⅓-a halott jelekre megy.** Mért `|s−0.5|` a 98 soron:

  | jel | `|s−0.5|` | tartomány | IC-súly |
  |---|---|---|---|
  | `cond_prob` | **0.001** | 0.500–0.613 | 0.07 |
  | `funding_rate` | **0.002** | 0.498–0.505 | 0.05 |
  | `oi_delta` | **0.007** | 0.352–0.533 | 0.07 |

  Együtt **0.19 / 0.60 = a pool-súly ~32%-a**, gyakorlatilag konstans 0.5-tel — ez mechanikusan a 0.5 felé húzza az eredményt. (A `cond_prob` a B27 strike-szűrés óta csak azonos-strike párnál tüzel → ritkán; a `funding_rate` a ~0 funding mellett strukturálisan semleges; az `oi_delta` 09-03 óta él, eddig alig mozdul.)
- **A 5 megkötött trade:** mind **YES**, 0.10–0.38 belépőn, **mind 0.000-ra rezolvált** (−$7…−$10). Vagyis a bot longshotot vesz és bukja — ugyanaz az aláírás, mint a weathernél/sportsnál. n=5, nem konkluzív, de egybevág a júliusi 37-trade audittal (a profit 4 longshoton ült). **A feszültség érdekes:** a forecast a threshold-ágon kiváló, a trade-ek mégis buknak → a hiba a **szelekcióban/méretezésben** van, nem az előrejelzésben (optimizer's curse — ott kereskedik, ahol a modell a legjobban eltér a piactól, azaz ahol a legvalószínűbb, hogy téved). A weathernek van erre `selectionShrink`-je, a cryptónak **nincs**.
- **Mellék-lelet:** a 5 trade ledger-sora az élő bizonyíték a **B53**-ra — a ledger 0.001–0.004 árat mutat, miközben a tényleges belépők 0.10–0.38 voltak (utolsó-scan-ár).
- **Jelölt lépések (jóváhagyásra, egyik sincs implementálva):**
  1. **Directional piacok kapuzása vagy kihagyása** a scanből — 72/98 sor, 0 edge, közben hígítja a ledgert és az IC-kalibrációt. A `combinerConfidenceMin` (0.05) ma is kiszűri a legtöbbet (`|final−0.5|`=0.037), tehát a scan-idő és az adat-hígítás a valódi költség, nem a rossz trade.
  2. **A 3 halott jel súlyának nullázása** (vagy kivezetése) amíg konstans 0.5-öt adnak — a ~32% súly felszabadítása magától élesíti a poolt.
  3. **Selection-shrink a cryptóra** (a weather B23 mintájára), az optimizer's-curse ellen.
  4. **Több threshold-piac** — pont ezt adja a **B51** (ETH/SOL `above-K`), tehát az már fut.

### B56b — A B56 javaslatok LEMÉRVE: #2 rontana, helyette `combinerLogOddsStrength` visszavonva ✅ 2026-09-09 (88. session)

- **Trigger:** a user: „a B56 javaslatokat is csináld meg, **ha jobb lesz tőle minden bot**." A feltételt komolyan véve a javaslatokat **előbb leszimuláltam a valós ledgeren** (72 directional sor, 71 rezolvált), a `combine()` súlyozásának hű újraimplementálásával.
- **Hitelesség-ellenőrzés:** a szimulált „mai" variáns `|p−0.5|`=0.041 / Brier 0.2692 ≈ a **ténylegesen logolt** finalProb 0.041 / 0.2692 → a modell hű, az összehasonlítás érvényes.

  | variáns | `|p−0.5|` | Brier | skill a base rate ellen |
  |---|---|---|---|
  | mai (log-odds ON, minden jel) | 0.041 | 0.2696 | −7.9% |
  | **+ semleges jelek kihagyva (a #2 javaslat)** | 0.079 | **0.2889** | **−15.6%** |
  | **lineáris pool (log-odds OFF)** | 0.032 | **0.2630** | **−5.2%** |
  | lineáris + semleges kihagyva | 0.062 | 0.2760 | −10.4% |

- **#2 (halott jelek súlyának felszabadítása) — ELVETVE, mérés alapján.** Rosszabbá tenné (Brier 0.2696 → 0.2889). **Ok:** a directional ág élő jelei *tévednek*, tehát a 3 semleges jel 0.5 felé húzása **véletlenül védelmet adott** — a határozottabbá tétel (0.041 → 0.079) csak a hibát nagyítja. Tanulság: egy „nyilvánvaló" tisztítás negatív-skillű ágon árt.
- **Helyette: `combinerLogOddsStrength` 1 → 0 (default) ✅ ALKALMAZVA.** A knobot 2026-09-03-án a B50-batch része kapcsolta ON-ra **bizonyíték nélkül**; az első mérés szerint **ront**: a lineáris pool Brier-je 0.2630 vs a log-oddsé 0.2696 (skill −5.2% vs −7.9%). Ráadásul kevésbé döntésképes kimenetet ad (0.032 vs 0.041), ami a `combinerConfidenceMin`=0.05 kapun **több rossz directional trade-et blokkol** — azaz implicit módon teljesíti a **#1** javaslatot (directional kapuzás) kódváltozás nélkül.
- **#1 (directional piacok kihagyása a scanből) — NEM implementálva, szándékosan.** A knob-visszavonás elérte a lényegét (több blokkolás), a scan-sorok viszont **értékes unbiased ledger-adatot** adnak (B50 doktrína) — a kihagyásuk információt semmisítene meg.
- **#3 (selection-shrink a cryptóra) — NEM implementálva.** Elvileg támogatja ugyanez a lelet (a 0.5 felé húzás segít ezen az ágon), de **n=5 trade** nem elég egy új live-feature bevezetéséhez. Marad javaslat.
- **Korlát, amit tudni kell:** a mérés **crypto** directional sorokon készült; a knob **globális**, tehát a HL-t is érinti, ahol viszont mindössze **2 ledger-sor** van → ott mérhetetlen. Ezért ez **nem új fogadás, hanem visszaállás a kód-defaultra** a rendelkezésre álló egyetlen bizonyíték alapján. A minta pre-B53 (szennyezett piaci ár), de a modell-oldali `|p−0.5|` és a base-rate-skill ettől független.

### B57 — Crypto scan: coin-diverzifikált slotok, ablak 3 → 5 ✅ IMPLEMENTED 2026-09-09 (89. session)

- **Trigger:** a user: „a threshold piacokra fókuszáljunk, mit tehetünk még? mi kell hogy a BTC is szállítsa amit az ETH/SOL már szállít?" — **a premissza fordítva volt**, és a mérés ezt mutatta meg.
- **A lelet.** A B51 (multi-coin) óta eltelt 26 órában a ledger: **BTC threshold 25 sor, ETH threshold 1, SOL 0.** Nem a BTC-vel van baj — az ETH/SOL **soha nem került a scan-ablakba**. Ok: [`pillars/index.mts`](../../services/worker/src/pillars/index.mts) `markets.slice(0, 3)` — top-3 nyers 24h-volumen szerint.
- **Az élő rangsor (2026-09-09, Gamma):** **171 crypto piac, ebből 154 threshold** (bitcoin 77 · ethereum 44 · solana 33; up-or-down mindössze **6**). A BTC birtokolja az **első ötöt**; az ETH legjobbja a **#6**, a SOL a top 12-ben sem szerepel. Vagyis a B51 helyesen coin-aware-ré tette a kódot, de a volumen-rangsor minden slotot a BTC-nek adott.
- **Fix:** új pure modul [`@core/scan-slots.mts`](../../packages/core/src/scan-slots.mts) `selectScanSlots(markets, {windowSize, minPerCoin})` — a volumen marad az elsődleges rangsor (likviditás-proxy, amitől a B49 #1 fill-modell függ), de **minden jelen lévő coin kap egy fenntartott slotot**, a maradékot szigorúan volumen tölti. Round-robin, hogy több coin mint slot esetén se egyen fel egy coin az egész tartalékot; a kimenet volumen-sorrendben marad. **Egyetlen coin / `minPerCoin=0` esetén bit-azonos a régi `slice(0,N)`-nel.** [24 pinelt assert](../../packages/core/src/scan-slots.test.mts), köztük a valós 2026-09-09-es rangsor regressziója.
- **Ablak 3 → 5**, új Settings-knob **`cryptoScanWindow`** (default 5, 1–12) + env `CRYPTO_SCAN_WINDOW`. Azért Settings-tunable, mert **ez a bot fő külső-API tárcsája**: minden slot egy TELJES signal-combiner futás ~8 külső fetch-csel, tehát 3 → 5 ≈ **+67% külső hívás**. Rate-limit esetén deploy nélkül visszavehető.
- **Élő szimuláció a valós rangsoron:** RÉGI = `BTC:82k, BTC:74k, BTC:72k`; ÚJ = `BTC:82k, BTC:74k, BTC:72k, ETH:2600, SOL:110`. **A 3 BTC slot változatlan** → nulla regresszió a bot egyetlen működő ágán.
- **Amit szándékosan NEM csináltam:**
  - **„Okosabb" rangsor a volumen helyett (a saját #3 javaslatom) — ELVETVE.** Egy bizonyíték nélküli opportunity-score pontosan az a fajta plauzibilis heurisztika, amiről a **B56b** mérése kimutatta, hogy árt (a „nyilvánvaló" combiner-tisztítás Brier 0.2696 → 0.2889). A slot-fenntartás **lefedettségi** döntés, nem új alfa-állítás.
  - **SOL-kizárás a gyengébb σ miatt (#4).** A Deribit-opció csak BTC/ETH-re van, a SOL-nak nincs → ott a horgony modell-σ-ra épül. De ez **nem ok a kizárásra**: a `combinerConfidenceMin` + `resolution-risk` kapuk kezelik a gyenge predikciót, a logolt sor pedig értékes adat. A kvótát viszont **1-en** hagytam coinonként, hogy a SOL ne kapjon aránytalan súlyt.
- **⚠ Őszinte korlát a fókuszhoz.** A threshold-ág a base rate-et fényesen veri (**+90.9%**, n=20), **de a piaci árat nem** (Brier modell 0.0226 vs piac 0.0166; a nem-konvergált 17 soron −23.9%). A piaci baseline B53-szennyezett, tehát a valós szám ennél jobb — **de bizonyítottan pozitív edge NINCS**. Ezért a bővítés indoka elsősorban a **bizonyíték-gyűjtés üteme**, nem egy ismert profit; a B53 tiszta mérése ezen fog eldőlni.


---

## 🔧 Rendszer-audit fix-fázis (2026-09-09, 90. session)

> A [rendszer-audit charta](../playbooks/system-audit.md) szerint lefuttatott teljes audit **16 leletet** adott (P0×3, P1×5, P2×5, P3×3). A fixek prioritási sorrendben, egyenként saját commitban, mindegyik mellé a **mérést** pinelő regressziós teszt.

### B58 — Weather σ-diszperzió korrekció (audit P0-1) ✅ IMPLEMENTED 2026-09-09 (90. session), default OFF

- **Lelet (adat-first, nem kódolvasásból).** Az EMOS-residual-store **forward** felén (élő METAR obs vs. a bot által ténylegesen használt GEFS-átlag, **n = 35**): `mean(err²/σ²)` = **10,04**, ahol 1,0 lenne a kalibrált; medián-ratio **1,44** vs. a χ²₁ 0,455-e → a σ **~1,8×** (medián, outlier-robusztus) … **~3,2×** (átlag) **túl kicsi**. Átlagos torzítás **+0,497 °C**. Ok: az ensemble szórása a saját perturbációit méri, a strukturális modellhibát nem; a `Math.max(0.5, …)` padló pedig pont a legegyoldalúbb hibájú állomásokon harap (ZSPD +1,7…+2,8 n=5; RKSS +2,3…+2,8 n=3).
- **Miért fájt.** Nem rossz irány, hanem téves magabiztosság: σ = 0,5 mellett egy μ-től 1,55 °C-ra lévő bucket ~1,6%-ot kap, és a bot erre méretez ¼-Kelly-t. A valós belépőkön (n = 28, `pillar_closed_trade` — ez befagyasztja a belépési értékeket, tehát **B53-tól mentes**): a `[0 – 0,15)` predikció-sáv (n=7, átlag 0,104) **71,4%-ban YES-re rezolvált** és **−$20,68**-t vitt a −$11,82-os összesből.
- **Fix:** új pure modul [`@core/weather-dispersion.mts`](../../packages/core/src/weather-dispersion.mts) — `inflateSigma` (clamp [1,4], λ=1 **bit-azonos**, σ-t soha nem zsugorít) + `dispersionDiagnostics` (var-ratio / medián-ratio / CRPS / log-score / PIT-KS / bias) + `suggestSigmaInflation` (**`selectPlateau`**-val, B50 #7). Alkalmazás [`weather/index.mts`](../../services/worker/src/pillars/weather/index.mts)-ben **EMOS UTÁN**, a `matchBucket` előtt. Knob **`weatherSigmaInflation`** default **1.0 = KI** + env `WEATHER_SIGMA_INFLATION`.
- **λ megválasztása — plató, nem csúcs.** Három független metrika a nyers adaton: log-score → plató 2,5; CRPS → plató 2,0; trading PnL (n=28) → plató 2,0. λ ≥ 3,5-nél a var-ratio 1,0 **alá** megy → „több" nem „jobb".
- **⚠ λ PATH-FÜGGŐ, és a mérés menet közben megfordította a saját premisszámat.** Élesben `weatherUseEmos=1`, a szorzó pedig EMOS UTÁN hat → a releváns sweep a kalibrált (μ,σ)-n fut. Ott `selectPlateau` **mindkét** metrikán **2,25**-öt ad → **ez a shippelt ajánlás**. Az irány a nem-nyilvánvaló rész: az élő út **kevesebb** inflációt kér, mint a nyers, mert az EMOS a túl-magabiztosság egy részét már elnyeli.
- **A P0-2 audit-megfogalmazása RÉSZBEN CÁFOLVA — mérve.** Az eredeti tétel („az EMOS rossz eloszláson illesztve, nem megbízható") túlbecsülte a kárt. A forward adaton az élő, seed-illesztett EMOS **javít**: var-ratio 10,04 → **5,96**, log-score 5,61 → **3,58**, CRPS 1,164 → **1,077**. Az „27-ből 17 állomás SZŰKÍTI a σ-t" megfigyelés igaz, de nem a domináns hatás — az átlag-korrekció többet nyer. **Amit az EMOS viszont tényleg NEM javít: a torzítást** (+0,497 °C nyersen → **+0,55 °C** EMOS után), mert az `a,b` a seed −0,03 °C-os biasára illeszkedett és nem transzferál. **Ez a P0-2 valódi, mért tartalma** — és a σ-tágítás definíció szerint nem segít rajta.
- **Szimulált hatás a 28 valós belépőn (λ=2,0 proxy):** Brier 0,3513 → **0,2969**, realizált PnL −$11,82 → **−$2,96**, 26/28 trade marad.
- **⚠ Kár-csökkentés, NEM edge.** Monoton transzformáció → matematikailag **nem tudja** megfordítani a `corr(predikció, kimenet)` = **−0,316** előjelét, és a Brier **minden λ-nál 0,25 fölött marad**. A naiv „flippeljük meg" **szintén nem működik** (Brier(1−p) = 0,2753 > 0,2500) — ugyanaz a csapda, mint a B56b-nél. Az előjel-probléma nyitva marad.
- **Teszt:** [`weather-dispersion.test.mts`](../../packages/core/src/weather-dispersion.test.mts) — 8 csoport, a fixture a **valós** 35 forward-residual a boxról. A **mérést** pineli (var-ratio 10,04, bias +0,50, plató-szélesség), nem a függvény-szignatúrát. Külön assert arra, hogy a bias **invariáns** a σ-ra — kifejezetten az ellen, hogy valaki a kettőt összemossa.
- **Doksi:** [`math/38-weather-dispersion.md`](../math/38-weather-dispersion.md).
- **Élesítés:** deploy (0 viselkedés-változás) → Settings → Weather → *Forecast σ inflation* → **2.25** → 20-30 rezolvált trade után újramérni. Ha a **P0-2** (EMOS seed-dominancia) rendeződik, ezt a szorzót **újra kell mérni** — különben a két korrekció egymásra halmozódna.

### B59 — EMOS seed-dominancia: súlyozott illesztés (audit P0-2) ✅ IMPLEMENTED 2026-09-09 (90. session), default OFF

- **Lelet.** Az `EmosResidual.seed` komment a B50 #5 óta azt állítja, hogy a seedelt sorok „down-weighted" — **soha nem voltak**. Minden élő állomás **~181 seedelt** (ERA5 obs + inter-modell szórás) és **0–5 forward** (METAR + GEFS σ) residualon illeszkedik. Két külön eloszlás: seed bias **−0,03 °C**, forward bias **+0,50 °C** → a seedelt átlag-korrekció **nem transzferál**, viszont ~40:1-ben leszavazza az élő adatot. Mérve: forward bias +0,497 °C nyersen → **+0,55 °C EMOS után** (az EMOS a torzítást nem viszi el).
- **⚠ Az audit első megfogalmazása RÉSZBEN TÉVES volt, és a mérés cáfolta.** A „rossz eloszlás → az EMOS nem megbízható" túlbecsülte a kárt: a forward adaton az élő EMOS **javít** (var-ratio 10,04 → **5,96**, log-score 5,61 → **3,58**). A „27-ből 17 állomás szűkíti a σ-t" igaz, de nem a domináns hatás. **A pontos hiba szűkebb: csak a torzítás-korrekció nem transzferál.**
- **Fix:** [`fitEmos`](../../packages/core/src/emos.mts) **súlyozott OLS** (`EmosSample.weight`; hiányzó/érvénytelen ⇒ 1 → a súlyozatlan hívás **bit-azonos**, pinelve), `EmosFit.nEffective` = Σ súly. Az [`emos-store`](../../services/worker/src/pillars/weather/emos-store.mts) a seedelt sorokra `weatherEmosSeedWeight`-et tesz (default **1.0 = KI**) + env `WEATHER_EMOS_SEED_WEIGHT`.
- **Mérés — leave-one-out a 35 forward residualon** (a kihagyott pontot az illesztés nem látja, tehát OOS): seed súly **1,0** → CRPS 1,0767 / logS 3,5778; **0,3** → 1,0499 / 3,5745; **0,1** → **0,9681 / 3,1933**; **0,03** → 0,8623 / 2,9527; **0,01** → 0,8016 / 2,8457. Monoton javulás mindkét proper score-on. Az „seed átlag + forward-súlyozott spread" változat gyengébb (1,0603) → elvetve.
- **⚠ A két knob PÁRBAN áll a B58-cal.** A jobban illesztett EMOS **kevesebb** σ-tágítást kíván: seed 1,0 → λ 2,25–2,5; seed **0,1 → λ 1,75–2,25**; seed 0,03 → λ 1,5–2,0. **Ajánlott pár: seed 0.1 + λ 2.0.** Ne hangold az egyiket a másik újramérése nélkül.
- **Konzervatív default-ajánlás.** A mért optimum 0,01–0,03, de ott az effektív mintaméret állomásonként **~10-re esik** → valós, de nagy szórású nyereség. Ezért **0,1** az ajánlás, nem a mért optimum. Ahogy a forward-residualok gyűlnek, a súly emelhető (a seed magától kiöregszik a `CAP=400` gördülő ablakból).
- **Teszt:** [`emos.test.mts`](../../packages/core/src/emos.test.mts) 6. csoport — a súlyozatlan hívás **bit-azonossága** (a,b,c,d), a súly-monotonitás valós forward sorokkal, az `nEffective` mint összeomlás-őr, és hogy NaN/0/negatív súly **1-re degradál** (nem mérgezi a nevezőt).
- **Doksi:** [`math/23 §6`](../math/23-emos.md) · [`math/38`](../math/38-weather-dispersion.md) (a párja).

### B60 — HL: a perp irány threshold-piacból jött (audit P0-3) ✅ IMPLEMENTED 2026-09-09 (90. session)

- **Lelet.** A HL pillér a Polymarket P(YES)-t `edge = |p − 0.5| × 2`-vel perp-konvikcióvá alakítja. Ez **csak directional (up-or-down) piacra** értelmes. A piac-kereső viszont **puszta coin-névre** (`"bitcoin"`) esett vissza, és a *globális* top-80 volumen-listából az első substring-találatot adta vissza → a gyakorlatban egy **threshold** piacot. Élő bizonyíték: **2412 egymás utáni scanben** a feloldott slug `bitcoin-above-82k-on-september-9-2026` (YES **0,0365**, mély OTM) → a combiner helyes `p ≈ 0,0156`-ja **96,9%-os hamis edge-dzsé** vált, amit a 40%-os sanity cap blokkolt. **A bot 2026-09-05 óta nem tudott kereskedni** (0 trade / 7 nap).
- **A LONG-bias forrása is ez (B18).** Az irányt a Polymarket **volumen-rangsora** döntötte el: ha egy ITM strike került előre, `p ≈ 0,9995` → „LONG". A ledger `hyperliquid/BTC` sora egyben mutatja: `firstMarketPrice 0,9995` és `marketPrice 0,0355` — **két teljesen különböző piac egyetlen sorban**.
- **Miért csak BTC-t látott a log.** A 80 elemű globális proxy-listában (mérve 2026-09-09) **5 bitcoin piac volt, mind threshold**, és **egyetlen ethereum/solana piac sem** → ETH/SOL a „no signal" ágon esett ki a SIGNAL-log előtt.
- **Fix (egyértelmű bugfix → nincs knob).** Új pure [`isDirectionalCryptoMarket`](../../packages/core/src/coin.mts) — szigorú: (a) a threshold-parser **ne** fogja meg, ÉS (b) pozitívan up-or-down mintájú legyen; minden ismeretlen input **nem** directional (a hiba épp néma téves-osztályozás volt). A [`signal-source.mts`](../../services/worker/src/pillars/hyperliquid/signal-source.mts) mostantól a **crypto-tag Gamma univerzumot** használja (amit a crypto pillér is), nem a globális top-80-at, és a találatnak át kell mennie a directional teszten. **Defence-in-depth**: a `getHlSignalForCoin` a felhasználás helyén újra ellenőriz. A coin-kulcsszó-lista **törölve** (a coin-identitás a `@core/coin.mts`-ből jön) → nincs mit elcsúsztatni.
- **Élő verifikáció (2026-09-09, a boxról, valós Gamma):** a crypto-tag univerzum **351 piac** (vs. 80 a régi proxyban). **BTC** — RÉGI: `bitcoin-above-82k-…` (a törött), ÚJ: **`bitcoin-up-or-down-on-september-9-2026`**. **ETH** — RÉGI: `ethereum-above-2600-…` (szintén threshold), ÚJ: **`ethereum-up-or-down-on-september-9-2026`** — az ETH ezzel **egyáltalán kap jelet**, eddig nem. **SOL** — 0 directional piac → **helyesen leáll** (`null`).
- **Számszerű hatás:** a mai `bitcoin-up-or-down` finalProb 0,5223 → edge **4,5%** (a régi 96,9% helyett) — józan konvikció, a sanity cap alatt, a normál kapukon megy tovább. A 12%-os paper edge-küszöb miatt ma még nem nyit — ez a helyes viselkedés, nem hiba.
- **Teszt:** [`coin.test.mts`](../../packages/core/src/coin.test.mts) — a **valós incidens** pinelve: mind az 5 élőben megfigyelt `bitcoin-above-*` slug + a SOL/ETH threshold elutasítva; a 4 up-or-down elfogadva; ismeretlen input **default: nem directional**; „above/below" szöveg a **kérdésben** is elutasít; és a klasszifikátor egyezik a meglévő strike-parserrel.
- **Maradó (nem ebben a commitban):** a HL `SCAN_COINS` hardcode-olt `["BTC","ETH","SOL"]` (nincs env/knob, szemben a crypto `CRYPTO_COINS`-szal) → **P3, külön tétel**. A `polymarket-proxy` limit-független cache-kulcsa (egy `limit=30`-as UI-hívás egy órára leszűkíti a listát minden fogyasztónak) szintén **külön tétel** — a HL-t ez a commit már kivonta alóla.

### B61 — A B53 back-fill „mosott" adatot ad ki elsőnek (audit P1-4) ✅ IMPLEMENTED 2026-09-09 (90. session)

- **Lelet.** A B53 write-once-szá tette a first-tuple-t, de a `??=` **a MÁR LÉTEZŐ sorokra is rábélyegez** — azzal az értékkel, amit az **előző scan** hagyott ott. A deploy után mérve: **36 latchelt sorból 32-t már 10-nél többször scanneltek** a latch előtt (max **2412** scan, `firstTs` akár **6 nappal** korábbi). A legrosszabb eset, `hyperliquid/BTC`: `firstMarketPrice` **0,9995** vs `outcome` 1 → |first − outcome| = **0,0005**, azaz egy tökéletesen konvergált ár viseli a „first" nevet. Ráadásul a `firstTs` **nem frissül**, tehát a rekord olyan időpontot állít, amikor a tuple-t sosem mérték.
- **Miért ez P1.** A 4 fogyasztó (walk-forward, config-attribúció, Thompson-bandit, és rajtuk át a promóciós kapu hard „beats market" gate-je) mind csak `first ?? latest`-et tesztel — **jelenlét, nem eredet**. A back-fill után a mező mindig jelen van, tehát a tiszta és a mosott sor **megkülönböztethetetlen**. Élő állapot: **0/91 crypto, 0/52 weather, 0/136 sports** rezolvált sor hordoz valódi first-observationt → a mérési réteg **100%-ban** szennyezett baseline-on fut.
- **Fix — nem törlés, hanem PROVENANCIA.** Új `firstBackfilled?: boolean` a rekordon, amit a `??=` ág állít be, ha a sor már létezett. Az érték **marad** a legjobb elérhető (a back-fill idején befagyasztva jobb, mint hagyni, hogy a `latest` a rezolúcióig csússzon) — de mostantól **meg lehet mondani**, melyik sor mit ér. Két új pure fn: [`isCleanFirstObservation`](../../packages/core/src/prediction-ledger.mts) és `firstObservationCoverage` (clean / backfilled / missing / cleanFraction bontás).
- **Felszínre hozva ott, ahol dönteni kell.** Az [`edge-tracker`](../../services/api/src/routes/edge-tracker.mts) új `firstObsCoverage` mezője a walk-forward pool eredetét adja, és a `WalkForwardCard` fölött megjelenik egy figyelmeztetés: *„Baseline only N% clean … treat the skill number above as a LOWER bound"*. Eddig a kártya magabiztos százalékot mutatott, semmi nem minősítette.
- **Teszt:** [`prediction-ledger.test.mts`](../../packages/core/src/prediction-ledger.test.mts) — új sor **nem** kap flaget; rescan **nem** teszi utólag piszkossá; egy 2412-scanes pre-B53 sor back-fillje **kötelezően flagelt**, miközben az érték a refresh ELŐTTI marad; a flag maga is write-once; és a coverage a **három valós állapotot** külön bontja.
- **Következmény, amit tudni kell:** a jelenlegi `cleanFraction` gyakorlatilag **0** — a tiszta mérés csak az innen induló, újonnan nyíló piacoktól tölt fel. A promóciós kapu addig **nem** hozhat érvényes „beats market" verdiktet.

### B62 — HL realized-IC strukturálisan 0 + a `useRealizedIC` default inert (audit P1-5 + P1-6) ✅ IMPLEMENTED 2026-09-09 (90. session)

**P1-5 — a mérés törött volt.** Az élő `signal-calibration-v1` store a hyperliquidre **mind a 8 jelnél pontosan `{"ic":0,"n":10}`**-t tartalmazott — miközben a 10 HL trade **6 nyerő / 4 vesztő**. Nyolc független jelnél a *pontosan* 0,0 nem mérés, hanem törött cső.

- **Ok:** a [`HlClosedTrade`](../../services/worker/src/pillars/hyperliquid/types.mts) `pnlUSDC`-t hordoz, **`pnl` mezője nincs**; a [`computeRealizedICs`](../../services/worker/src/pillars/shared/signal-calibration.mts) viszont `t.pnl > 0`-t értékel → `undefined > 0` = false → **minden trade veszteségnek címkézve** → konstans outcome-vektor → Pearson nevezője 0. A runner `genericTrades` mappingje (`{...t, direction, category}`) csak az irányt fordította le. **Ugyanez a hiba-osztály**, amit a fölötte lévő komment már egyszer javított a `t.side`-ra — ugyanabban a függvényben, élőben.
- **Fix:** `pnl: Number(t.pnlUSDC ?? 0)` a mappingbe.
- **+ Új „degenerate" jelzés.** A `computeRealizedICs` mostantól megkülönbözteti a **„mértük, nincs korreláció"**-t a **„nem tudtuk mérni"**-től: ha az outcome- VAGY a score-vektor konstans, `{ic: 0, n, degenerate: true}`. Eddig mindkettő tiszta 0-ként jött ki, amit a downstream „ennek a jelnek nincs skillje"-ként olvas — jóval erősebb és teljesen más állítás.
- **+ Az `effectiveICs` nem kever be degenerate rekordot** → egy akadémiai priort nem húz a nullába **bizonyíték nélkül**. Pont ez történt volna mind a 8 jellel, amint a `useRealizedIC` bekapcsol.

**P1-6 — a knob dokumentált defaultja soha nem érvényesült.** A `loadRuntimeOverrides()` a **NYERS** mentett mapet adja vissza, defaultok nélkül; a fogyasztók viszont `ov.useRealizedIC === 1`-et teszteltek → mentett override hiányában `undefined === 1` = **false**. Élőben a 15 override között **nincs** `useRealizedIC`, tehát a B34 (2026-09-01) óta „ON (default)"-ként dokumentált realized-IC blend **egyszer sem futott le**.

- **Fix:** új `effectiveKnob` / `effectiveFlag` a [`trader-settings`](../../services/api/src/routes/trader-settings.mts)-ben (mentett override → különben a SCHEMA default), és mindkét olvasóhely (`signal-combiner`, `edge-tracker`) erre vált.
- **⚠ Miért biztonságos MOST bekapcsolni.** A P1-5 degenerate-őre miatt a mai hatás **nulla**: a HL-rekord degenerate (a törött pnl miatt), a crypto pedig 5/5 vesztő trade → szintén konstans outcome → degenerate. Mindkettő kimarad a blendből, tehát a helyes default érvényesítése **ma no-op**, és csak akkor kezd hatni, amikor valódi IC-adat keletkezik. E nélkül az őr nélkül ugyanez a változtatás mind a 8 jel súlyát a nullába lapította volna.
- **Teszt:** új [`signal-calibration-pnl.test.mts`](../../services/worker/src/pillars/shared/signal-calibration-pnl.test.mts) — a **valós** 10 HL PnL-lel: a régi mapping bizonyítottan 0-t ad (és most **flagelve**), a javított erősen nem-nulla IC-t; a konstans `cond_prob` **is** degenerate (score-oldali variancia-hiány — ez külön valós lelet, nem szabad összemosni a törött pnl-lel); és a degenerate rekord **nem** módosítja a priort, míg egy valódi mérés igen.

### B63 — Sports-kizárás félig alkalmazva + HL-ledger két halhatatlan sora (audit P1-7 + P1-8) ✅ IMPLEMENTED 2026-09-09 (90. session)

**P1-7 — a promóciós kapu két összeférhetetlen populációt kevert.** A B55 kizárta a sportsot a **ledger**-poolból, de a **trade**-poolból nem. Így a kapu `wfBrierSkill`-je sports nélkül számolt, miközben a **saját minta-küszöbe** (`properScores.n`) és a base-rate-skillje sportsostul. A sports a domináns closed-trade-termelő, és a „fair value"-ja bizonyítottan (n=161, 0 eltérés) annak az árnak determinisztikus affin transzformációja, ami ellen fogad → **nulla forecasting-információ, viszont felduzzasztja a mintaszámot**, ami a verdiktet feloldja.
- **Fix:** új `scoringTrades` az [`edge-tracker`](../../services/api/src/routes/edge-tracker.mts)-ben — `category="all"` esetén az `AGGREGATE_EXCLUDED` a trade-poolra is érvényes; a `properScores` és a `tradeN` innen jön. A portfólió-szintű `summary` **szándékosan** továbbra is mindent tartalmaz (az valós dollár) — ez a **bizonyíték**-pool, nem a P&L.

**P1-8 — a HL-ledgerben 2 sor volt 2879 scanre.** Két hiba találkozott: **(1)** a ledger `r.market ?? r.coin`-ra kulcsol, a HL-sorok viszont **csak `coin`-t** hordoztak → a BTC minden scanje **EGYETLEN halhatatlan rekordba** olvadt (2412 scan egy soron, aminek a first- és latest-tuple-ja utóbb **két teljesen különböző piacot** írt le). **(2)** a HL volt az **egyetlen** bot, ami sosem hívott `reconcileLedger`-t, és `[]`-t adott át markets-nek → egy sor sem kapott `conditionId`-t → a kimenet **kizárólag** a `fillOutcomesFromClosedTrades`-ből jöhetett, azaz **csak a megkötött trade-ekből**. Pontosan az a szelekciós torzítás, aminek a kiküszöbölésére a ledger létezik.
- **Fix (a P0-3 tette lehetővé):** mivel a kereső mostantól valódi **directional Polymarket-piacot** ad vissza, a `HlSignalResult` hordozza a `conditionId`-t és `endDate`-et; a runner `scannedMarkets` térképe alapján a ledger-sorok **piacra kulcsolódnak**, és lefut a `reconcileLedger("hyperliquid")`.
- **Miért helyes a Gamma mint kimenet-forrás perp-nél:** a *pontozott predikció* P(ár emelkedik), és egy up-or-down piac YES-re rezolválása **épp azt jelenti, hogy emelkedett** — a pozíció perp volta ezen nem változtat.
- **Várható hatás:** a HL-ledger 2 sorról napi több sorra nő, és a **nem megkötött** scanek is pontozhatóvá válnak (unbiased) — ez az első alkalom, hogy a HL-nek egyáltalán értelmezhető forecast-track-recordja lesz.

### B64 — P2 batch: sports-állapot, DD-deadlock, weather-shrink, fill-plauzibilitás ✅ IMPLEMENTED 2026-09-09 (90. session)

**P2-9 — a sports az operátor dokumentált stopja ellenére fut.** Élő: a session **2026-09-09 06:00:19-kor újra létrejött**, `stopped=false`, és 06:01:25-kor **3 pozíciót nyitott** (NO@0.10, NO@0.06, YES@0.09). A worker `pillars=…,sports interval=180s` — a registry-ág **nem tartalmazott cron-gate-et** (csak a legacy weather-ág), tehát a leállítás egyetlen módja a `session.stopped` flag volt.
- **A flag viszont törékeny.** A [`loadSportsSession`](../../services/worker/src/pillars/sports/session-manager.mts) `catch` ága egy **átmeneti olvasási/parse-hibára** friss, `stopped:false` sessiont **KIÍRT** a régi fölé → egy egytickes hiba eltörölte az operátor manuális stopját (és a bankrollt, és a trade-történetet). A simVersion-bump ugyanígy. **Fix:** hiba esetén már **nem ír** (memóriában ad friss objektumot, a tárolt érték érintetlen, a következő sikeres olvasás visszaállítja); a simVersion-bump pedig **átviszi a MANUÁLIS stopot** (az auto-stop helyesen törlődik, mert az új sim érvényteleníti az odométert).
- **Új `sportsCronEnabled` knob (default 1 = mai viselkedés).** Tartós operátor-szándék, amit a reset, a séma-bump és az olvasási hiba **nem** töröl. Generikus: bármely registry-bot `<category>CronEnabled`-je hat.
- **⚠ Rendezés a stop ELŐTT (ugyanebben a sprintben, a leállítás előtt felfedezve).** A `session.stopped` ág **a `resolvePendingSportsPositions` ELŐTT** tért vissza → egy leállított bot **soha nem rendezte** a nyitott pozícióit: a cost basis örökre lekötve, rezolúció nélkül. Élőben ez 3 pozíciót / $7,50-t érintett volna. A „stopped" jelentése **„ne nyiss újat"**, nem „hagyd sorsára, amit tartasz". Fix: a settlement a stop- ÉS a cron-kapu elé került, és a leállított bot válasza is hordozza a `resolutions` tömböt (a könyvét lezáró bot így látható, nem néma). A `sportsCronEnabled` ellenőrzése emiatt a **dispatcherből a pillérbe** költözött — a dispatcher-szintű kapu ugyanígy megkerülte volna a rendezést.

**P2-10 — a sports nem foglalta le a nyitott pozíciók tőkéjét.** Élő rekonciliáció: crypto 150 − 45,70 − 0 = **104,30 ✓**; weather 100 − 11,82 − 20,05 = **68,13 ✓**; sports 50 − 0 − 7,50 = 42,50 **de 50,00-t mutatott ✗**. A Kelly erre a felduzzasztott számra méretezett (a 3-pozíciós capnél **15%** túl-állítás). **Fix:** `addOpenPosition` levonja a `costBasis`-t, `closeOpenPosition` visszaadja + a nettó PnL-t — pontosan a crypto aritmetikája (bruttó bevétel helyett `pnl + costBasis`, különben a roundtrip-fee kimaradna). Új [teszt](../../services/worker/src/pillars/sports/session-invariants.test.mts) pineli a `bankrollStart + sessionPnL === bankrollCurrent` invariánst.

**P2-11 — a crypto drawdown-kill egyirányú deadlock.** Élő: peak $150, current $104,30 → **30,5% ≥ 25%** limit, `riskDdKillEnabled=1`. Még nem tüzelt (0 `DECISION_TRADE`), mert a crypto korábban kiesik a kapukon — de az **első** trade-re permanensen leállítaná: a `peak` monoton a bankrollStart-tól, a limit alá csak nyerő trade vinné vissza, amit maga a kapu tilt. **Fix:** paper + `paperNeverStop` mellett a DD-kill **naplóz, de nem blokkol** (a valve már ugyanezt teszi a loss-limittel; a DD-kill per-tick skip, ezért nem látta). LIVE-ban változatlanul kemény stop.
- **+ Őszinte címkék:** a `riskVolTargetEnabled` / `riskDdKillEnabled` / `betaCapFraction` `common` kategóriában ült, holott **csak a crypto runnerbe** van bekötve — a weather (élőben −31,9% drawdown mellett is kereskedik), HL, F-Arb, sports **nem védett**. A label és a help ezt most kimondja.

**P2-12 — a `weatherSelectionShrink` sosem érte el a Kellyt.** Az optimizer-curse büntetés csak a trade/nem-trade **kaput** mozgatta; a Kelly utána a **nyers** valószínűségre méretezett → egy épp hogy átcsúszó trade teljes konvikcióval ment. Belsőleg inkonzisztens. **Fix:** új `weatherShrinkSizing` knob (**default 0 = KI, bit-azonos**) levonja a büntetést a fogadott oldal valószínűségéből is. A help kimondja azt is, amit az operátor gyakran félreért: a `selectionShrink` a **gyakoriságot** állítja, a méret-knob a `weatherKellyScale`.

**P2-13 — a fill-modell nem vetette össze a könyvet a jegyzett árral.** Élőben egy crypto trade **0,10-en könyvelt belépőt 0,375-ös jegyzett ár mellett** — egy VÉTEL 27,5 centtel a piac ALATT, ami nem lehetséges. A két szám külön feedből jön (Gamma `outcomePrices` vs. külön lekért CLOB-könyv), és semmi nem hasonlította össze őket; a `simulateDepthFill` **meg sem kapja** a limitárat. A dollár-költség helyes volt, de **~3,75× annyi share-t** könyvelt → YES-rezolúció esetén ~275%-kal túlfizetett volna. Pont az a phantom-share mód, aminek a kiküszöbölésére a B49 #1 készült, egy őrizetlen csatornán visszatérve. **Fix:** `isFillValid` opcionális `referencePrice` + sáv (0,10 abszolút — **plauzibilitás-ellenőrzés, nem slippage-limit**; a 4 ép fill +0,013…+0,015 volt). [Teszt](../../packages/core/src/fill-model.test.mts) pineli a valós incidenst és azt, hogy a 4 ép fill átmegy.

### B65 — P3 batch ✅ IMPLEMENTED 2026-09-09 (90. session)

**P3-14 — a `marketsConsidered` a B57 előtti 3-as ablakot hardcode-olta.** `Math.min(markets.length, 3)` → élőben „23 scanned, **3 considered**, 5 results". A dashboard alul-jelentette azt a scant, amit a B57 épp kibővített. Fix: `topN.length`.

**P3-15 — az ENB két torzítása ugyanabba az irányba mutatott.** A sorozatok minden bot kereskedési napjainak **UNIÓJÁN** épülnek, nulla-kitöltéssel: egy 40-ből 5 napon aktív bot **35 strukturális nullát** kap, és a majdnem-csupa-nulla vektorok korrelálása kitalál egy közös „lapos" faktort. Ráadásul a variancia nélküli sorozat NaN-t ad, amit a kód **0-ra** képezett = „korrelálatlan", azaz **több** függetlenség, mint amit az adat alátámaszt. **Mindkettő felfelé tolja az ENB-t — pont a modul céljának ellenkezője** (arra való, hogy figyelmeztessen: a crypto + HL + F-Arb egyetlen crypto-béta fogadás). **Fix:** pairwise-complete korreláció azokon a napokon, amikor **mindkét** bot aktív volt; elégtelen átfedésnél az érték **ismeretlen → korreláltnak (1) feltételezve**, ami a konzervatív irány egy koncentráció-figyelmeztetésnél (lefelé viszi az ENB-t). [7 új assert](../../packages/core/src/enb.test.mts).

**P3-16 — nincs log-megőrzés deployok között. 🔵 BACKLOG (nem implementálva).** A `docker compose logs workers` a konténer-újraindítástól kezdődik (mérve: 199 sor, ~25 perc). A `json-file` driver (10m × 3) rendben van, de a `docker compose up -d --build` **lecseréli a konténert**, és a régi loggal együtt a history is eldobódik. Mivel `main`-re pusholva **minden deploy** automatikus, a művelet-történet folyamatosan eltűnik — ez tette tönkre az audit első 7-napos skip-reason eloszlását is (valójában 25 perc volt). **Nem javítottam:** valós fix vagy log-shipping, vagy `/opt/edgecalc/logs` bind-mount + fájl-logger a tick-hurokban — infra-döntés, és I/O-t tenne a forró útra. Operátor-döntést kér.

### B66 — A ledger nem rögzíti, MELYIK KÓD készítette a predikciót ✅ IMPLEMENTED 2026-09-09 (90. session)

- **Forrás:** egy párhuzamos Claude-session (a charta szerzője) adta át lane 7 / lane 9 leletként. **Függetlenül reprodukálva** az élő adaton, mielőtt hozzányúltam.
- **Lelet.** A [`currentConfigFingerprint()`](../../services/api/src/routes/trader-settings.mts) a **futásidejű KNOB-override-okat** hasheli és semmi mást — nincs benne commit, build-id. A `PredictionRecord` sem hordozott verzió-mezőt. A `configHash` tehát azt jelenti, hogy *„ezek a knobok voltak beállítva"*, miközben minden fogyasztó úgy olvassa: *„ez a konfiguráció készítette a predikciót"*. **Ugyanaz az osztály, mint a B53:** a mező nem azt jelenti, amit a fogyasztója hisz róla.
- **Élő mérés (crypto ledger, n=101).** A `3683673b` arm **2026-09-04 → 09-09** között él, sok deployon át. Élesebben: az **`e03b4835`** arm **10:45:41 → 11:07:11** — ez az ablak **tartalmazza a 11:03-as audit-deployt**, ami átírta a HL signal-source-ot, a ledger provenancia-szabályait, a realized-IC blendet és a fill-ellenőrzést. **Két lényegesen különböző kód-rezsim, egy arm.** (A saját 11:07-es knob-váltásom véletlenül elvágta a folytatást — a 11:04–11:07 közti sorok viszont megkülönböztethetetlenek a deploy előttiektől.)
- **Miért NEM a SHA-t hasheltem bele a `configHash`-be.** A deploy gyakori (2026-09-09-en négy), a knob-váltás ritka. Együtt hashelve **minden push új armot nyitna**, szétaprózva a config-attribúciót és a Thompson-banditot egysoros armokra, amik sosem gyűjtenek bizonyítékot — egy néma torzítást cserélnénk egy hangosabbra. Külön tartva megmarad a kérdés: *„ugyanaz a knob-készlet, más kód?"* — pont az, amit eddig nem lehetett feltenni.
- **Fix.** Új pure [`@core/build-info.mts`](../../packages/core/src/build-info.mts): `buildInfo()` / `currentCodeVersion()` (feloldás: `EDGECALC_CODE_VERSION` env → `BUILD_INFO` fájl a gyökérben → `"dev"` konstans) + `codeVersionSpread()`, ami armonként megmondja, **hány kód-rezsimet kever**. A ledger új `codeVersion` mezője a first-sighting tuple-lel együtt latch-el. A [deploy workflow](../../.github/workflows/deploy.yml) új lépése a rsync ELŐTT `BUILD_INFO`-t ír a deployolt commit SHA-jával (a box fáján nincs `.git`, tehát a futó kód másképp nem tudja azonosítani magát); a két Dockerfile bemásolja. Egy **verziókövetett placeholder** (`sha=dev`) biztosítja, hogy a `COPY` lokálisan is működjön. Az [`edge-tracker`](../../services/api/src/routes/edge-tracker.mts) új `codeSpread` mezője jelenti a kevert armokat — a `firstObsCoverage` mintájára: nem automatikus szétvágás (azzal ma alig maradna összehasonlítható adat), hanem **megnevezett bizonytalanság**.
- **⚠ Egy fogás menet közben, ugyanabból az osztályból.** Az első implementáció `eval("require")`-rel töltötte be lustán a `node:fs`-t. ESM alatt ez **dob**, tehát minden hívás a catch-be esett és `"dev"`-et adott — **ami történetesen ugyanaz, mint a placeholder értéke**, így a hiba láthatatlan volt: egy hihető érték állt egy meg nem történt olvasás helyén. Statikus importra váltva javítva, és a teszt most **valódi fájl-olvasást pinel** ideiglenes könyvtárban.
- **Forward-only**, mint a B53 — a már kiírt sorok nem attribuálhatók újra. A `codeVersionSpread` a **címkézetlen** sort is `mixed`-nek számolja egy címkézett mellett: a kódja genuinely ismeretlen, és a hallgatást egyetértésnek olvasni pontosan az a csapda, amiről a lelet szól.
- **Teszt:** [`build-info.test.mts`](../../packages/core/src/build-info.test.mts) — az élő kevert arm pinelve, a címkézetlen sor `mixed`, az arm-kulcs a `firstConfigHash`, a verzió stabil egy processzen belül (nem nyit armot restartonként), és a fájl-olvasás **tényleg megtörténik**.

### B67 — A tiszta first-observation számláló túlszámolt: a B53→B61 ablak back-filljei jelöletlenek ✅ IMPLEMENTED 2026-09-10 (93. session)

- **Forrás.** A napi `edgecalc-drift-check` első ütemezett futása (2026-09-10 06:03 UTC) — a 9. sáv automatizált változata. A javítás előtt a boxról lehúzott ledgeren függetlenül reprodukálva.
- **Lelet.** A B61 `firstBackfilled` jelzés csak a **saját deployjától** (09-09 11:04 UTC) jelöl, és csak akkor, ha a first-tuple az upsertkor még **üres**. A B53 viszont már 05:25-kor élesedett, és az addig újrascannelt pre-B53 sorokat a `??=` kitöltötte. Ezek **soha nem kaphatnak jelzést**, a régi `isCleanFirstObservation` (tuple jelen van + nincs jelzés) pedig tisztának mondta őket. **Ugyanaz az osztály, mint a B53 és a B66:** a mező hiánya nem azt jelenti, amit a fogyasztója hisz róla.
- **Mérés** (élő ledger-dump, 2026-09-10 15:44 UTC). A szállított függvény és egy független inline-újraimplementáció számra egyezik:

| | rezolvált | tiszta (csak jelzés) | tiszta (provenancia) | rés |
|---|---|---|---|---|
| crypto | 108 | 16 | 13 | 3 |
| weather | 64 | 7 | **2** | 5 |
| sports | 167 | 31 | 15 | 16 |
| hyperliquid | 10 | 9 | 8 | 1 |
| **össz.** | **349** | **63** | **38** | **25** |

  A rés-sorok a befagyasztáskor mediánban **14–32 órásak** voltak; a HL-sor 150 órás (a B61-ben leírt `hyperliquid/BTC`). ~16 UTC-kor egy további crypto-sor rezolvált, és 3 sports-sor még nyitott. A rés tehát legfeljebb **29** lesz, utána a ledger-cap kiöregíti.
- **⚠ Mekkora a hatás: provenancia- és számlálási hiba, nem nagy pontszám-torzítás.**
  - A 25 rés-sorból csak **2** ára volt a kimenettől 0,02-n belül; a valódi soroknál ez 1/38.
  - A fogyasztók továbbra is **minden** sort pontoznak (`first ?? latest`), tehát a walk-forward, a config-attribúció és a bandit **számai nem változnak**.
  - Egy dolog változik: a walk-forward kártya bannerje (`category=all`, sports nélkül, 216 sor) **30% → 25%** tisztát mutat.
- **Fix — tiszta függvény, adatmigráció nélkül** ([`prediction-ledger.mts`](../../packages/core/src/prediction-ledger.mts)):
  - Új `FIRST_TUPLE_EPOCH` = `2026-09-09T05:25:24Z`. Ez a B53-at (`89fccc4`) vivő deploy-run vége (`0ed3f93`, `gh run list`).
  - Új `firstObservationProvenance()` → `clean | backfilled | missing`. `clean` csak akkor, ha van tuple, nincs jelzés, **és** `firstTs ≥ epoch`. A `firstTs` a létrehozáskor íródik, és soha nem íródik felül, ezért minden sorra eldönti az eredetet.
  - Az `isCleanFirstObservation` és a `firstObservationCoverage` erre vált. Az edge-tracker és a UI változtatás nélkül követi.
- **Robusztusság.**
  - Élőben **0** jelzett sor jött létre az epoch után, tehát az epoch egyedül is elválasztja a két populációt.
  - Az epoch ±10 percében egyetlen sor sem jött létre, így a deploy pár másodperces bizonytalansága semmit nem dönt el.
  - A `firstBackfilled` doc-ja („Absent/false ⇒ genuine") **hamis volt** — javítva.
- **Teszt** ([`prediction-ledger.test.mts`](../../packages/core/src/prediction-ledger.test.mts)):
  - Egy élő rés-sor pontos mása. A mai upsert **nem** tudja jelölni (maga a hiba pinelve), és a sor **nem** tiszta.
  - Határeset: az epochkor elsőként látott sor tiszta, az 1 ms-mal korábbi nem.
  - Hiányzó vagy olvashatatlan `firstTs` → nem tiszta.
  - A coverage a négy élő alakot külön bontja.
  - Az epoch-konstans pinelve.
  - A meglévő „friss sor" fixture a deploy elé volt dátumozva. Áttettem utánra, mert a jelenlegi kód élesben ilyen sort sosem hoz létre.
- **A drift-check promptja** erre a szabályra állt át, és négy további pontosítást kapott → [changelog 2026-09-10](../changelog/CHANGELOG-2026-09-10.md).

### B68 — Fill-modell kalibráció külső, teljes-piacos Polymarket könyv-archívumból 🔵 JELÖLT (2026-09-10, API-felmérés)

- **Lelet (élőben mérve).** A saját `clob-book` recorder (B50 #2) csak a **saját nyitott** crypto+weather pozíciók könyvét rögzíti, és az 5000-es rolling cap miatt gyakorlatilag **~2 napos ablak**: 2026-09-10-én 5000 snapshot / 15 token, 09-07 15:05 → 09-09 18:59. A 09-03 óta rögzített korábbi részt a cap már felülírta, és 09-09 19:00 óta nincs nyitott crypto/weather pozíció, így új snapshot sincs. A B50 doktrína („minden nem-logolt nap elveszett") erre a streamre így nem teljesül.
- **Közben van ingyenes, teljes-piacos archívum.** A [Pendulum Flow](https://archive.pendulumflow.com/) **minden** Polymarket-könyvet rögzít 2026-02-21 óta (CC BY 4.0, regisztráció nélkül); a [Tardis.dev](https://docs.tardis.dev/historical-data-details/polymarket) 2026-05-25 óta viszi (`book_snapshot_5/25` + incremental L2).
- **Javaslat:** a B49 #1 fill-modell (participáció-cap, slippage) és a Kyle-λ/VPIN kalibrációja ebből készüljön, ne a saját szűk streamből. A saját recorder élő-kontrollnak maradhat, de a cap-et és a hatókört ehhez kell igazítani.
- **Precondition:** operátor-döntés. A CC BY 4.0 forrásmegjelölést kér.
- **Felderítés (2026-09-10, 93. session — primer forráson ellenőrizve):**
  - **Formátum:** a v3 archívum (2026-08-18T06-tól) óránkénti Parquet, ~1,1 GiB/óra (~22–29 GiB/nap). Benne teljes mélységű könyv-snapshotok, szintenkénti változások (`price_change`) és trade-ek, tranzakció-hash-sel. A fájl eseménytípus, majd condition id szerint rendezett, így egy (token, perc) lekérés ~17 MB range-olvasás; 100 lekérés ~1–2,5 GB.
  - **Lyukak:** 2026-08-15T10 és 08-18T05 között (68 óra) nincs adat. A 08-10–15 közti AG6-tükörnek nincs licence, ezért nem használjuk. Az Aug 1–9 közti rész PMXT v2, más sémával.
  - **Azonosítók:** `market` = condition id, `asset_id` = token id; mindkettő 32 bájtos bináris, hex-kódolni kell. Egy snapshot érvényességi idejét a `timestamp_received` adja; az exchange-timestamp hónapokkal régebbi lehet.
  - **A saját trade-jeink nem jók alapnak.** A zárt trade-eken nincs token-id: a crypto és a sports a slugból visszanyerhető, a weathernél a fogadott bucket sem. Összesen 8 köthető trade marad, ezért a kalibráció az archívumból vett mintán fut: ~200 (piac, perc) a mi piactípusainkból.
  - **Mit mér:** mélység a legjobb árnál, VWAP-csúszás $5/$15/$50-ra, a kijelzett mélység tartóssága 1/5/30 s múlva. Ezt vetjük össze a 20%-os részvételi plafonnal, a +2%-os tartalékkal és a 0,10-es plauzibilitási sávval.
- **Előfeltételek (kódhibák, 2026-09-10 igazolva):**
  - **(a) A weather ág eldobja a fill-modell eredményét.** A pozíció a kért USDC-t és a jegyzett árat (+1¢) könyveli, nem a VWAP-ot és a teljesült összeget ([`weather/index.mts`](../../services/worker/src/pillars/weather/index.mts):614-616). 33 zárt trade-ből 6-nál tér el a könyvelt költség a részvény × belépő szorzattól (arány 1,09–1,49).
  - **(b) A pozíció és a zárt trade nem őrzi a token-id-t és a fill-részleteket** (VWAP, teljesült USDC, részleges-e), így a fill-ek utólag nem auditálhatók.
- **Státusz:** felderítve; az operátor 2026-09-10-én még nem indította (a B71-et választotta előbb).

### B69 — B52 offline előkiértékelés historikus ensemble-archívumon 🔵 JELÖLT (2026-09-10, API-felmérés)

- **Lelet.** A B52 flip-döntése (`weatherUseMultiModel`) ma 2-3 hét forward-adatra vár, mert az Open-Meteo historical-forecast API-ban nincs AIFS-ENS archívum, a WN2 pedig csak ~2026-09-04-től érhető el. A [dynamical.org](https://dynamical.org/catalog/) viszont ingyen adja az **ECMWF IFS-ENS**-t 2024-04-01 óta és az **AIFS-ENS**-t 2025-07-02 óta (51 tag, `temperature_2m`, Icechunk Zarr az AWS Open Data-n, CC BY 4.0 + ECMWF Terms of Use), és a GEFS-t is.
- **Javaslat:** a GEFS vs IFS-ENS vs AIFS-ENS összevetés (CRPS, var-ratio, coverage a megfigyelt napi max ellen) már most elvégezhető ~14 hónapon × a bot állomásain; Python + xarray kell hozzá. A forward log a WN2 miatt ettől még kell, mert az nincs benne.
- **Caveat:** a `temperature_2m` 3/6-órás pillanatérték, nem napi max, ezért a csúcsot alulbecsli (ugyanaz a caveat, amit a B52 a WN2/AIFS 6-órás felbontásánál jelzett). A torzítást (bias) az EMOS korrigálja, a szórás-szerkezetet csak részben.
- **Precondition:** operátor-döntés.
- **Felderítés (2026-09-10, 93. session — primer forráson ellenőrizve):**
  - **Elérés:** csak Icechunk 2-vel (Python ≥ 3.12; a gépen 3.14, minden csomaghoz van Windows-wheel). A régi `data.dynamical.org` Zarr-URL-ek 2026-09-30-tól leállnak.
  - **Adatkészletek:**
    - GEFS: 00z, 31 tag, 3 órás lépés. **Van `maximum_temperature_2m`**, azaz valódi intervallum-maximum, így a GEFS-nél nincs csúcs-alulbecslés.
    - IFS-ENS: 00z, 51 tag, 3 órás lépés, 2024-04-01-től.
    - AIFS-ENS: 6 óránként, 51 tag, 6 órás lépés, 2025-07-02-től.
    - Az ECMWF-eknél csak `temperature_2m` van. Ezért két változatban pontozunk: közös 6 órás mintavétellel, és a legjobb elérhető felbontással.
  - **Költség:** a közös ablakra (2025-07-től, 00z) ~74 GB olvasás, ebből <0,5 GB marad. **Operátor-döntés: ez a kör**; 2024-04-től ~124 GB lenne.
  - **Megfigyelés:** IEM METAR (`asos.py`, `report_type=3,4`) a **rezolúciós** állomásokra (→ B71), Hongkongnál a HKO. Az ERA5 −0,7…−1,4 °C-kal hidegebb a METAR-nál, megfigyelésnek nem jó.
  - **Pontozás:** a `multi-model-eval.mts` definícióival, állomás-naponként egy mintával. A live `eval-multimodel.ts` három hibáját nem örökli:
    - az elavult „POOLED (4 systems)" címkét;
    - a negatív lead beengedését;
    - a korrelált snapshotok külön mintaként számolását.
  - **Korlát:** a live keverék 6–8 modelljével szemben itt csak 3 van, így a B52-flipre csak részleges választ ad.
- **Státusz:** felderítve, a kör eldöntve. A futtatás (csomagtelepítés + ~74 GB) indításra vár.

### B70 — Sports: a bankroll +$7,50 fantomot hordoz (a P2-10 fix átmenete) ✅ KORRIGÁLVA 2026-09-10 (operátor-jóváhagyással)

- **Tünet (élő, 2026-09-10 ~16 UTC).** A sports session `bankroll_current` **43,00**, de az invariáns (`bankrollStart + sessionPnL − nyitott költség`) szerint **35,50** kellene: 50 − 7,5 − 7,0. A különbség pontosan **+$7,50**.
- **Mechanizmus (adatból és kódból igazolva).**
  - A session 2026-09-09 06:00:19-kor indult (a 86. session resetje). A [`freshSession`](../../services/worker/src/pillars/sports/session-manager.mts) ekkor írja a `startedAt`-ot, azóta nem volt reset.
  - 06:01:25-kor 3 pozíció nyílt ($7,50) a **P2-10 fix előtti** kóddal, ami a költséget nem vonta le a bankrollból. Az audit ezt mérte: 50,00 látszott 7,50 lekötött tőke mellett.
  - A P2-10 fix 11:04-kor élesedett; azóta a zárás `costBasis + pnl`-t ír jóvá.
  - A 3 pozíció 18:56–21:17 UTC között 0-ra rezolvált (3 × −2,50). A jóváírás 2,50 − 2,50 = **0**, tehát a veszteség sosem terhelte a bankrollt. A fix a már nyitott, régi könyvelésű pozíciókat nem kezelte.
- **⚠ Korrekció.** A drift-check kiértékelésekor (93. session) ezt „a reset előtti pozíciók átszivárogtak az új sessionbe" formában írtam le, és a bankrollt helyesnek mondtam. **Mindkettő téves volt**: nem volt reset, a −7,5 ennek a sessionnek a valódi vesztesége, és a bankroll a hibás.
- **Hatás.** A sports Kelly **~21%-kal** túlbecsült bankrollra méretez (43,00 vs 35,50). Paper, és a sports ki van zárva a cross-bot aggregátumból, ezért alacsony. A `session_pnl` (−7,5) és a `session_loss` (7,5) helyes.
- **Mellék-tünet (nem igazolt).** A `pillar_session.trade_count` sportsnál 0, miközben 3 zárt trade van; a többi botnál az oszlop egyezik. A runner a `tradeCount`-ot a `closedTrades` hosszából számolja ([`sports/index.mts`](../../services/worker/src/pillars/sports/index.mts), ~392. sor), tehát valószínűleg csak a normalizált oszlop nem töltődik.
- **Javítás — elvégezve 2026-09-10 18:06 UTC.** Kódváltozás nem kellett, mert a P2-10 óta nyitott pozíciókra a könyvelés helyes. Egyszeri, védett UPDATE futott, ami csak akkor ír, ha a rés pontosan 7,50: 43,00 → 35,50. A következő sports tick (18:08:42) után is tartós, az invariáns-rés 0,0000. A `trade_count` mellék-tünet nyitva marad (nem igazolt, alacsony).

### B71 — Weather: 5 városban nem azon az állomáson mértünk, amelyiken a piac rezolvál ✅ IMPLEMENTED 2026-09-10 (93. session)

- **Forrás.** A B69 felderítése: az offline értékeléshez a rezolúciós állomások kellettek. Minden piac szabálya név szerint megadja az állomást („recorded by NOAA at the X Station"). Mind a 26 aktív várost ellenőriztem, a boxról, mert a Gamma helyben blokkolt.
- **Lelet.** Mérve 2026-08-01 és 09-09 között, IEM METAR napi maximummal, helyi napra; Hongkongnál HKO open data:

| város | volt | a piac szerint | átlag (volt − piac) | ≥1 °C eltérés |
|---|---|---|---|---|
| Houston | KIAH | KHOU (William P. Hobby) | **+0,95 °C** | 28/41 nap |
| Szöul | RKSS (Gimpo) | RKSI (Incheon) | **+1,24 °C** | 28/41 nap |
| Hongkong | VHHH (reptér) | Hong Kong Observatory | +0,55 °C | 14/31 nap |
| Denver | KDEN | KBKF (Buckley SFB) | −0,43 °C | 13/41 nap |
| Párizs | LFPG (CDG) | LFPB (Le Bourget) | −0,20 °C | 12/41 nap |

- **Mit érintett:**
  - az előrejelzés helyét Houstonban, Denverben, Párizsban és Hongkongban (Szöulnál a koordináta már Incheoné volt);
  - az EMOS megfigyelt adatát;
  - a METAR-os rendezési tartalékot.
  - A trade-ek elszámolása a Gamma kimenetéből jön, az helyes volt.
  - 33 zárt weather trade-ből 14 esett ezekre a városokra (Párizs 6, Hongkong 5, Szöul 3); ennyiből a PnL-hatás nem mondható meg.
  - Mellékes: a math/38 „egyoldalú" RKSS-hibájának (+2,3…+2,8 °C) részben ez volt az oka.
- **Fix:**
  - [`station-config.mts`](../../services/worker/src/pillars/weather/station-config.mts): az 5 állomás ICAO-ja és koordinátája, az IEM állomás-metaadataiból. Hongkong azonosítója `HKO`, a HKO-székház koordinátáival, `obsSource: "hko"`.
  - Új [`station-obs.mts`](../../services/worker/src/pillars/weather/station-obs.mts): `fetchStationDailyMax` METAR-t, Hongkongnál pedig a HKO `RYES` napi riport `HKOReadingsMaxTemp` mezőjét adja. A D-napi riport D maximumát tartalmazza; 5/5 augusztusi napon egyezett a hivatalos CLMMAXT-tal. A havi CLMMAXT szeptemberre még üres volt, ezért nem az a forrás. Erre vált az EMOS-reconcile és a reconciler METAR-tartaléka.
  - **Visszaesés elleni őr:** minden ellenőrzött város `settlementKey`-t kapott (a szabályszöveg normalizált állomásnév-töredéke). A market-finder minden szkennelt listingnél összeveti, és eltérésnél `SETTLEMENT_STATION_MISMATCH` logot ír, városonként naponta egyszer, blokkolás nélkül. A napi drift-check ezt is figyeli.
  - A seed-szkript opcionális állomás-listát kap (`seed-emos.ts 6 KHOU,RKSI,HKO,KBKF,LFPB`), így a többi 22 állomás illesztése érintetlen marad.
- **Teszt:**
  - [`station-config.test.mts`](../../services/worker/src/pillars/weather/station-config.test.mts): az 5 új elvárás a tiltott régi ICAO-val; a detektor a valós szabályszövegeken; a „William P. Hobby" eset, ahol pont van a névben; lefedettség; egyedi azonosítók.
  - [`station-obs.test.mts`](../../services/worker/src/pillars/weather/station-obs.test.mts): a HKO-mezőt olvassa, nem a reptérit.
  - Élő próba a deploy előtt: HKO 09-09 → 32,2 °C, 09-10 → 31,9 °C; a METAR RKSI-re, KHOU-ra és LFPB-re rendben.
- **Operatív — elvégezve 2026-09-10.**
  - Deployolva: `a6c47e5`, 18:30 UTC.
  - Az 5 új állomás EMOS-előzménye újratöltve (`seed-emos.ts 6 KHOU,RKSI,HKO,KBKF,LFPB`): 905 seed-sor, mind az 5 illesztve. A többi 22 állomás érintetlen.
  - Élőben: 0 `SETTLEMENT_STATION_MISMATCH`, 0 valódi hiba. A runner már az új azonosítókkal logol (az RKSI első élő sora). A seedelt sorok a következő tick után is megvannak.
  - A régi store-kulcsok (`v1:KDEN` stb.) árván maradnak, ártalmatlanok.
  - A HKO-megfigyelés élesben az első lezárult hongkongi dátumnál fut először.
- **Nyitva:** a `lagos` állomás nem ellenőrizhető (nincs aktív piac), ezért nincs `settlementKey`-e.

### B72 — EMOS: a megfigyelt napi maximum begyűjtése nem robusztus 🟡 BACKLOG (mérés-first)

- **Kódból igazolva** ([`emos-store.mts`](../../services/worker/src/pillars/weather/emos-store.mts) `reconcileEmosObs` + [`metar-fetcher.mts`](../../services/worker/src/pillars/weather/metar-fetcher.mts)):
  1. A dátum UTC-éjfélkor lesz esedékes. UTC-től nyugatra ezért részleges helyi napot kér le: Los Angelesben és Seattle-ben 17:00, Chicagóban 19:00, New Yorkban 20:00 helyi időig.
  2. Egyetlen METAR-riport is elég egy értékhez.
  3. Az érték egyszer íródik, és soha nem frissül. A 36 órás ablak után pótolni sem lehet.
- **Mérve (2026-09-10, a tárolt megfigyelés vs. az IEM teljes napi maximuma):**
  - nyugat: n=6 állomás-nap, 1 napon ≥0,5 °C-kal alacsony (KLGA 09-06 −3,3 °C);
  - kelet (kontroll): n=39, 2 napon (EDDM 09-09 −3,0, VHHH 09-06 −2,0).
  - A hiba tehát nem csak a nyugati időzítésből jön, van más kiesés is, és n kicsi.
- **Javaslat:**
  - az esedékesség legyen a helyi nap vége + puffer;
  - legyen minimális riportszám;
  - a 36 órás ablakon belül legyen újraellenőrzés.
  - Az EMOS élesben be van kapcsolva (`weatherUseEmos` = 1), ezért a javítás előtt meg kell mérni a hatását.
- **A seed megfigyelési oldala is torzít (2026-09-10, a B69 felderítéséből).**
  - A seed ([`emos-seed.mts`](../../services/worker/src/pillars/weather/emos-seed.mts)) az ERA5 napi maximumát használja megfigyelésként. Ez a METAR-hoz képest hideg: 2026 augusztusában EGLC −0,67, RJTT −1,37, VHHH −0,84 °C (31 nap/állomás).
  - Amíg egy állomásnak kevés az élő sora, az EMOS átlag-korrekciója ezt a hideg torzítást tanulja. A B71 5 új állomásánál ez most teljes egészében így van, mert csak seedjük van.
  - **Javaslat:** a seed megfigyelése IEM METAR legyen (`asos.py`, `report_type=3,4`, helyi nap), Hongkongnál HKO. Utána újra-seedelés, és lemérni, változik-e a CRPS.

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
