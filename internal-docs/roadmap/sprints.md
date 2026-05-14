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
> **Utolsó frissítés:** 2026-05-14d (sprint 38 zárás Edge Tracker Tier-1 metric expansion-nel + sprint 39 indítás)

---

## 🔥 Active sprint (Sprint 39 — 2026-05-14 → ~2026-05-21)

**Sprint cél:** Paper trade volume accumulation a kalibrációs küszöbökig — legalább 1 bot érje el a 20 closed trade-et, hogy a Coach-mode recommendations engine N≥20 szabályai (per-signal IC, realized-IC blend) aktiválódjanak.

**Status:** in_progress (2026-05-14d indítva; az Edge Tracker Tier-1 metric expansion már mögöttünk, Sprint 38)

| # | Feladat | Owner | Acceptance criteria | Prio |
|---|---------|-------|---------------------|------|
| 1 | Weather cron bekapcsolása | operator | `weatherCronEnabled = 1` Settings-ben, mentve. 24h-ban ≥3 weather scan-tick fusson és nyíljon legalább 1 új weather paper trade. | 🔴 |
| 2 | HL bot resume + monitoring | operator | A consecutiveLossLimit (3-as) miatti 1h pause feloldódott (`pausedUntil` < now()). Ha `session.stopped` → manuális Resume gomb. 24h-ban ≥1 HL trade nyíljon. | 🟠 |
| 3 | Crypto Loose preset run-tovább | bot (passive) | Folyamatosan futnia kell Loose preseten. 20+ closed crypto trade halmozódjon fel a sprint végéig. | 🟠 |
| 4 | Daily Coach mode check-in (RecommendationsCard) | operator | Naponta egyszer `/trade/<bot>/`-on átolvasni a RecommendationsCard-ot. "Why?" view → adatok ellenőrzése. Apply csak akkor, ha indokolt; dismiss a többit. | 🟡 |
| 5 | Settings tab `icHalfLifeTrades` mérlegelés | operator | Ha a sprint közepén stabil a piaci regime → 0 marad (uniform); ha vol-spike vagy regime-shift gyanu → 50-re emelni. | 🟢 |

**Sprint end-criteria (mindhárom kell):**
- ✓ Legalább 1 bot eléri a **20 closed trade-et**
- ✓ Coach mode UI látható minden bot oldalán (validálva production-ön)
- ✓ Calibration record fennáll mind a 3 prediction-driven bot Blobs-ában

**Sprint risk:**
- ⚠️ Ha weather cron nem indul el (operator forget) → sprint stuck N<5-ön weather-en, csak crypto megy.
- ⚠️ Ha HL bot újra 3 consecutive loss-t hoz be → újra pause-ba megy → csak 1 trade/2h tempóval halmoz.

---

## 📋 Next sprint candidates (ready to start, prioritised)

### Sprint 40A — Statistics-driven recommendations expansion (~1-2 nap)

**Precondition:** Sprint 39 end (legalább 1 bot ≥20 closed trade). A statisztika-mezők (Sortino, profitFactor, expectancy, sharpeCiLo/Hi, currentStreak, evGap, maxDrawdownDuration) **már elérhetők** a `computeSummary` válaszában a Sprint 38 (Edge Tracker Tier-1 metric expansion) óta, csak a recommendations engine-be kell bekötni.

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

### Sprint 40B — Sports bot stub → MVP (~3-5 nap)

**Precondition:** Sport bot integráció kérése (jelenleg `category=sports` 400-at ad a recommendations-api-on, mert a P4.2 stub még üres).

**Cél:** [P4.2 a master-plan-ből](./master-plan.md#p42--sportspoliticsmacro-kategóriák-❌-todo-stub-ok) első fázisa: NBA / NFL Polymarket markets + Pinnacle moneyline edge.

**Acceptance criteria:**
- `auto-trader/sports/index.mts` non-stub pipeline (scan + decision + session)
- Cron `*/15 * * * *` Sportsra (paper mode default)
- TraderShell-en `<RecommendationsCard category="sports" />` (új field-map)
- Új SCHEMA knob-ok dokumentálva (`sportsEdgeThreshold`, `sportsMaxPositionUSD` — már megvannak)
- math/18-sports-bot.md (új doksi)

**Becsült munka:** 3-5 nap

### Sprint 40C — Dismissed-state Blobs persistence (~0.5-1 nap)

**Precondition:** RecommendationsCard 30+ napos production-használat, az operátor jelzi hogy ugyanazt dismisszálja 3+ alkalommal hetente.

**Cél:** A `RecommendationsCard.tsx` dismiss gombja jelenleg csak React state-et frissít. Új flow: dismiss → POST `/recommendations-api?action=dismiss&id=<rec-id>` → 7-napos TTL Blobs entry → következő fetch-en az adott ID kihagyva.

**Acceptance criteria:**
- Új endpoint POST handler (auth-protected)
- Új Blobs store `recommendations-dismissed-v1`
- Frontend `dismiss()` callback async POST
- 7 nap után automatikusan visszatér (ha még érvényes szabály)

**Becsült munka:** 0.5-1 nap

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

---

## ✅ Completed sprints (rolling 5 utolsó)

### Sprint 38 (2026-05-14d) — Edge Tracker Tier-1 metric expansion

**Mit ért el:**
- `SummaryStats` 9 új mező: `sharpeCiLo`/`sharpeCiHi` (200-resample bootstrap, deterministic LCG), `sortinoRatio`, `profitFactor`, `expectancy`, `payoffRatio`, `longestWinStreak`/`longestLossStreak`, `currentStreak`, `evGap`, `maxDrawdownDuration`
- `CumulativePoint` 2 új mező: `drawdown`, `peak` (running underwater curve)
- Új `UnderwaterDrawdownChart` (Edge Tracker tab)
- Mind az 5 kategória (crypto/weather/HL/F-Arb/sports) **automatikusan** kapja az új metrikákat a `CategoryDashboard /trade/{category}/edge-tracker` routing-on át — zéró per-bot kód-duplikáció

**Changelog:** [`CHANGELOG-2026-05-14d.md`](../changelog/CHANGELOG-2026-05-14d.md)

**Mit NEM tett (szándékos sprint scope):**
- A recommendations engine **még nem használja** az új metrikákat — az a Sprint 40A feladata (Statistics-driven recommendations expansion)
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

### Sprint 36 (2026-05-14b) — Live-readiness override + Realized-IC kalibráció

**Mit ért el:**
- Új `liveReadyOverrideEnabled` Settings knob (master kapcsoló a 7-gate readiness-ellenőrzéshez)
- Új `signal-calibration.mts` Bayes-shrinkage modul (`useRealizedIC` + `calibrationShrinkageK`)
- `signal-combiner` `?category=cat` paraméter (crypto + HL külön kalibrációs útvonalak)
- Edge Tracker `CalibrationViewCard` (Prior / Realized / Effective oszlopok)
- HL Edge Tracker shape-bug fix (`coin` → `market` normalizer)

**Changelog:** `CHANGELOG-2026-05-14.md` §(a–j)

### Sprint 35 (2026-05-14a) — Weather forecast docs + paper-PnL audits

**Mit ért el:**
- math/16 §3.B új szekció: 3 weather forecast-forrás upgrade-opció (ECMWF közvetlen / NOAA GFS GRIB2 / kereskedelmi)
- master-plan 🟢 NICE-TO-HAVE #13 tétel
- Auth-clarification: mind a 4 weather forrás zéró-auth
- 3 closed crypto trade audit: Polymarket valódi resolutions verified, paper PnL = konzervatív becslés
- 4 HL paper trade audit

**Changelog:** `CHANGELOG-2026-05-14.md` (a "Weather forecast-forrás upgrade-opciók dokumentálva" + "Edge Tracker HL bug fix + 4 HL paper trade audit" szekciók)

### Sprint 34 (2026-05-13) — Mobile UI + tap-to-tooltip

**Mit ért el:**
- 100+ `title=` hover-tooltip mobilon működik (tap-to-tooltip Base.astro inline JS)
- Global `.tbl-scroll` wrapper minden táblán (12 tábla, 6 panel)
- iOS auto-zoom megelőzése (input ≥16px)
- Notch/safe-area support + theme-color meta
- Dashboard shell mobile breakpoints

**Changelog:** [`CHANGELOG-2026-05-13.md`](../changelog/CHANGELOG-2026-05-13.md)

> Korábbi sprint-ek (Sprint ≤33, 2026-05-12 és korábban) — lásd [`changelog/`](../changelog/).

---

## 🚫 Anti-sprint (mit NE csinálj most, és miért)

| Mit NE csinálj | Miért | Mikor lesz "újra elérhető" |
|----------------|-------|------------------------------|
| Új signal hozzáadása a 8-signal combinerhez | Zaj, mielőtt a meglévő 8 mért IC-vel kalibrálva nincs (jelenleg priorok, nem mért értékek) | 200+ trade után (B1 Tier 2) |
| Live-flip bármelyik boton (`PAPER_MODE=false`) | Paper validation gate még nem teljesít (≥30 trade kell). `liveReadyOverrideEnabled` opt-in **csak tudatos kockázat** | Sprint 39+ után, ha N≥30 + IC≥5% + Sharpe≥0.5 + DD<25% mind ✓ |
| Autopilot mode bekapcsolása a recommendations engine-en | Regime-shift drift kockázat sokkal nagyobb mint a 1-3 nap operator-latency | **Soha** (tudatos design) — vagy 200+ trade + 30+ nap stabil regime |
| Sports bot teljes pipeline (P4.2) | Még stub szinten — addig a stratégia-spec sem véglegesedett | Sprint 39B-re, ha az operátor explicit kéri |
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
