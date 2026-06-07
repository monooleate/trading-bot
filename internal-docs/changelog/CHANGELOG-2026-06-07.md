# CHANGELOG 2026-06-07

## Flip-audit (mind az 5 bot) + 4 adverse-selection fix

### Trigger
User: *"elemezd az élő oldal összes aktuális és lezárt trade-jét, mintha még mindig jobban járnék, ha az ellentétes oldalra fogadnánk. vagy finomítsunk a paramétereken."*

A 2026-06-04 reset óta (ma 06-06/07) friss paper-adat halmozódott. Minden lezárt trade-re kiszámoltuk a **flip-PnL-t** (ellentétes oldal, azonos $ tét, 3.6% fee; HL perp: fordított irány azonos fee-drag).

### Flip-eredmények (élő, 2026-06-06)

| Bot | n | Tényleges PnL | WR | Flip PnL | Flip WR | Ítélet |
|-----|---|--------------|-----|----------|---------|--------|
| Weather | 11 | −87.88 | 27% | **+32.38** | 73% | erős flip-jel (Δ +120) |
| Sports | 15 | −32.29 | 7% | −9.55 | 73% | flip jobb, de **még mindig mínusz** |
| HL Perp | 20 | −0.60 | 45% | +2.11 | 65% | ≈ nulla; LONG-oldal a baj (B18) |
| Crypto | 1 | −22.57 | 0% | +5.14 | 100% | n=1, nincs következtetés |
| F-Arb | 38 | +0.22* | — | — | — | nem irányított; display-bug (lásd B25) |

\* Az edge-tracker 0-t mutatott (mezőnév-bug); a valós sessionPnL multi-status szerint +$0.22.

**Kulcs-árnyalat (weather):** a +$120 flip-swing **2 confident-NO trade-ben** koncentrált (Seoul NO@0.765 → flip +$63, London NO@0.655 → flip +$27). A maradék 9 trade flipje ≈ nulla/kicsit rosszabb. Az ujjlenyomat: a bucket-matcher **magabiztos, drága NO-bet-jei** adverse-selectednek (= a B23 gyökérok pontos megfogalmazása). Portfólió-szinten viszont a flip 36 trade-en (06-04 +$87/25tr + 06-06 +$32/11tr) kétszer is pozitív volt.

**Kulcs (sports):** a flip a WR-t 7%→73%-ra dobja, de a PnL **így is −$9.55**, mert az egyetlen nagy nyerő (+$246 longshot YES@0.075) flippelve −$20, a 11 flip-nyerő pedig apró NO-on-longshot (~$1), amit a fee megesz. → nem flip-ügy, hanem longshot-túlbecslés.

**Kulcs (HL):** LONG n=10 W=2 (−$4.61) vs SHORT n=10 W=7 (+$4.01) — a regime (BTC 66k→61k) + a dokumentált B18 long-bias; nem flip-ügy.

---

### Implementált fixek (user mind a 4-et kérte)

#### 1. B22 — Weather invert-direction toggle (kísérleti) ✅
- `weatherInvertDirection` (0/1) knob, default OFF, „⚠️ EXPERIMENTAL: invert (fade)".
- [`weather/decision-engine.mts`](../../netlify/functions/auto-trader/weather/decision-engine.mts): a `baseDirection` a net-edge gate-nél flippel; minden downstream (Kelly `probSide`, cross-position gate) az effektív oldalon fut. Env `WEATHER_INVERT_DIRECTION`.

#### 2. B23 — Weather selection-bias (optimizer's curse) shrink ✅ [preferált]
- `weatherSelectionShrink` (0–2.0) knob. A `matchBucket` N bucketből a max-|edge|-űt választja → a kiválasztott edge felfelé torzít (winner's curse).
- Új gate a net-edge gate után: `penalty = shrink × √(2·ln N) × σ_edge`; `shrunkNet = max(0, gross − penalty) − fee` ≥ edgeThreshold kell. Degradál (shrink=0 vagy N<2 → n/a pass). Presetek: loose 0, **normal 0.5**, strict 1.0. Env `WEATHER_SELECTION_SHRINK`. A Bonferroni-IC-idioma weather-megfelelője.
- A `WEATHER_GATE_LABELS` bővült (`Szelekciós torzítás (adverse-selection)`), `padWeatherGates` automatikusan kezeli.

#### 3. Sports longshot floor (min bet-side price) ✅
- `sportsMinPrice` (0–0.5) knob + új Gate 5b a [`sports/decision-engine.mts`](../../netlify/functions/auto-trader/sports/decision-engine.mts)-ben: a megfogadott oldal Polymarket-ára ≥ küszöb, különben skip. Szimmetrikus. Default OFF; presetek loose 0.03 / normal 0.05 / strict 0.08. Env `SPORTS_MIN_PRICE`. (`SportsConfig.minPrice` + `getEffectiveSportsConfig`.)

#### 4. F-Arb edge-tracker mezőnév-fix ✅ (display bug)
- [`edge-tracker.mts`](../../netlify/functions/edge-tracker.mts) `tradesFromSession` funding-arb ága rossz mezőneveket olvasott (`hlAvgPrice`/`hlSize`/`realizedPnl`/`hlSide`) → minden zárt F-Arb trade csupa nulla. Javítva a valós `ArbPosition` shape-re (`hlEntryPrice`/`sizeCoins`/`closeFundingNet`/`direction`), `pnlPct = closeFundingNet/sizeUSDC×100`. A pozíciók **valósak** voltak — a bot rendben kereskedik. → **B25**.
- Új follow-up: **B26** — F-Arb bankroll-gap (~$26.8: current $173.41 vs várt $200.22 sessionPnL +$0.22 mellett), külön read-only diagnózis.

### Beállítások / paraméter-megfigyelés
- Az `effective` settings `combinerConfidenceMin = 0.05` (Normál) — a 2026-06-04 changelog 0.08-as crypto-szigorítása **nincs élben** (az override valószínűleg törlődött a reset során). Ha szándékos volt, vissza kell állítani.

### Validáció
- `npx tsc --noEmit` zöld; `npm run build` zöld (10 oldal).
- Új teszt: [`adverse-selection-fixes.test.mts`](../../netlify/functions/auto-trader/shared/adverse-selection-fixes.test.mts) — 8 case (2× B22, 3× B23, 4× sports min-price… összesen 8 expect-csoport), all passed.
- Regresszió: `cross-position-gates`, `sports-loss-limit-topup`, `funding-arb-reverse` tesztek mind zöld.

### Aktiválás + reset (operátor-kérés, 2026-06-07)
- A user kérésére **B23 (weatherSelectionShrink) ON @ 0.5** + **sportsMinPrice ON @ 0.05** — env- ÉS SCHEMA-default ON-ra állítva (a knob/override továbbra is állítható; `WEATHER_SELECTION_SHRINK=0` / `SPORTS_MIN_PRICE=0` kikapcsolja). **B22 (invertDirection) marad OFF** (kísérleti, a user nem kérte).
- **Push `main`-re → Netlify CD prod-deploy.** (A `netlify` CLI nincs lokálisan telepítve; a deploy a GitHub `main`-push CD-jén megy.)
- **Reset:** mind az 5 bot trade-history + bankroll vissza a `bankrollStart`-ra (friss adatgyűjtés a módosítások után). A `reset` action JWT-auth-gated (`PROTECTED_ACTIONS`) → operátor-credential szükséges (UI „Reset" gomb vagy auth-olt API). Lásd a session-záró megjegyzést.
