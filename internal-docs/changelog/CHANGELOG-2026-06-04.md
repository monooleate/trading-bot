# CHANGELOG 2026-06-04 — Crypto 10-trade audit + `combinerConfidenceMin` 0.08 + B21

> Session-típus: trade-history audit (user-kérés) + operatív Settings-akció + backlog-felvétel. A részletes audit-metódus: [`playbooks/trade-history-audit.md`](../playbooks/trade-history-audit.md).

## Trigger

User: *"weather crypto-nél ellenőrizd az eddigi tradeket, hogy megfelelően kezelték-e a piacot és ha live trader lett volna is ezek az eredmények jöttek-e volna. ezután elemezd … egy gombot a settingsbe, hogy mindig az ellenkező irányba nyisson … a tradeket elnézve mindig az ellentétét kellett volna nyitni és akkor 60% lenne a win rate."*

## (a) Audit — 10 closed crypto trade (read-only)

5-forrásos pull (status / edge-tracker / Gamma / BTC spot / trader-settings). **A history 100% valid:**

- **Gamma cross-check 10/10**: mind a 10 piac `closed=true`, és **mind `["0","1"]` = NO nyert**. Mind a 10 bot-exit pontosan egyezik. Nincs pre-resolution close.
- **PnL bit-pontos** a 3.6% fee-modellel (pl. above-74k-may-30: −23.652 vs riport −23.65188; up-or-down-may-31: 38.048 vs 38.0481). Loserek mind −103.6% (fee-ujjlenyomat helyes).
- **Bankroll reconcile**: $350 (250 reset + $100 topup) − $38.19 closed − $42.47 open (2 poz) = **$269.34** ✓.

**Diagnózis — a bot rosszul kezelte a piacot, de a gyökérok nem az irány:**

- A teljes minta egy **BTC-lejtmenet** (~$74K → mai $64,350); **mind a 10 piac NO-ra zárult**. A bot 7× YES-t fogadott OTM „above-Nk" piacokon → mind bukott; 3× NO-t (Down) up/down piacon → mind nyert. **3W / 7L = 30% WR.**
- A `predictedProb` mind **0.42–0.45**, **K-tól függetlenül lapos** (playbook §4.1 flat-noise pattern). Élőben is aktív: a mai `recentLogs` above-62k → 0.4827, above-64k → 0.4907 — ~0.48 minden strike-ra, miközben a piac jól árazott ($62k @ 0.852). A „edge" tehát zaj, nem alpha.
- **Live-equivalencia:** az irány (W/L) **identikus** lett volna (simV3 valódi Gamma-resolution); a PnL-nagyság vékony OTM-könyveken eltérhetett volna (slippage).

## (b) „Mindig fordítva" toggle — elemzés → ELVETVE

A user megfigyelése számszerűleg igaz: a fordított irány **7W/3L = 70% WR** lett volna. **De a win rate félrevezető:** a payoff-aszimmetria miatt a fordított nettó PnL ≈ **−$30** (a 7 olcsó-longshot-bukás → drága-NO kis-nyereséggé válik, a 3 NO-nyerés → drága-YES teljes-bukássá). Vagyis **fordítva is veszteséges**, miközben a WR 70%. Ráadásul a fordítás itt = „mindig BTC-down", egyetlen lejtmenet-rezsimre illesztve (n=10 < 30 → statisztikailag érvénytelen).

**Kód-szintű megvalósíthatóság:** az irány a [`crypto/decision-engine.mts:197`](../../netlify/functions/auto-trader/crypto/decision-engine.mts) egysoros. Naiv flip **nem működik**: a `kellyForSide()` a fordított oldalon Kelly=0-t ad → a #11 gate minden fordított trade-et eldob. Korrekt invert a model-prob piaci-ár körüli tükrözését igényelné, ami elrontja a #3 noise-gate-et + a #13/#14 monotonicitás-gate-eket → közepesen invazív, finom korrektségi buktatókkal. **Nem implementálva.**

## (c) Operatív Settings-akció (auth-olt API, user-jóváhagyott)

- **`combinerConfidenceMin` 0.05 → 0.08** — a 10 buggy trade |p−0.5| mind 0.05–0.074 közt volt → 0.08 mindet blokkolta volna. A near-noise threshold-trade-ek mostantól skippelnek. **Mellékhatás:** a bot a fő piactípusán (BTC-above-Nk) jórészt **tétlen** lesz, amíg B21 nem fut.
- **`combinerKBlindDownweight`** — már **0.5** volt korábbról (05-29). NEM változott.
- Megjegyzés: a korábbi audit-jelentésben szereplő „combinerKBlindDownweight=1.0 / sessionLossLimit=20" tévedés volt — a **nem-autentikált** `trader-settings` GET üres override-ot ad; auth-oltan a valós `sessionLossLimit` **$1000** (egyezik a CLAUDE.md-vel).

## (d) Backlog — B21 felvéve a [`sprints.md`](../roadmap/sprints.md)-be

**B21 — Threshold-piac combiner K-anchoring (a downweight-knob nem elég) 🟠.** A `combinerKBlindDownweight=0.5` bekapcsolva sem K-aware a combiner output (lapos ~0.48). Gyökérok-hipotézis: az IC-súlyozott átlagot egyetlen K-aware tag (vol_divergence) nem tudja K-érzékennyé tenni; másodlagos gyanú σ-túlbecslés. Munka: (1) vol_div élő instrumentálás, (2) σ-kalibráció, (3) „K-anchored" combiner mód (vol_div = horgony, a többi 7 jel kiigazítás). Becslés ~1-2 nap. Ez a principled megoldás a user „fordítva" felvetésére: korrekt K-aware model OTM-en magától NO-t mond.

## Fájlok

- `internal-docs/roadmap/sprints.md` — B21 + fejléc-dátum
- `CLAUDE.md` — AKTUÁLIS ÁLLAPOT dátum + crypto sor élő számokra
- `internal-docs/changelog/CHANGELOG-2026-06-04.md` — ez a fájl

**Kód-változtatás nem történt** (audit + Settings-knob + doksi). A B21 implementáció külön sprint, explicit „mehet" után.

---

# CHANGELOG 2026-06-04 (b) — F-Arb structural sizing+threshold fix + Weather invert-analízis

> Session-típus: F-Arb diagnózis + 3 kód-fix (sizing/threshold/sanity) · Weather trade-audit + invert-toggle elemzés (implementáció elhalasztva). Külön session az (a) crypto audittól.

## Trigger

User (több feladat): *"funding rate bot be van kapcsolva, de olyan mintha nem csinálna semmit … miért nem nyit pozit. weather trader-nél ellenőrizd az eddigi tradeket … és ha live trader lett volna is ezek az eredmények jöttek-e volna. ezután elemezd … egy gombot a settingsbe, hogy mindig az ellenkező irányba nyisson … a tradeket elnézve mindig az ellentétét kellett volna nyitni és akko 80% lenne a win rate."*

## (1) F-Arb — miért nem nyit pozíciót (élő diagnózis + 3 fix)

Élő bizonyíték az F-Arb saját scan-jéből (06:42 UTC cron-tick) + élő HL/Binance funding pull. **A bot fut és helyesen gate-el, de strukturálisan képtelen volt nyitni.** Három ok:

- **🔴 Fő ok — sizing-floor ütközés.** A BTC **átment minden viability gate-en** és csak a sizingnál bukott: `"Size $40 < min $50"`. Matek: bankroll $200 × maxCapitalPct 0.40 = $80 cap, első pozíció = `headroom × 0.5 = $40 < minPositionUSDC $50` → MINDIG skip, bármilyen spread mellett. Ez a 0 trade oka 2026-04-21 óta.
- **🟠 Másodlagos — spread-küszöb ~10× túl magas.** `minSpreadHourly = 0.0001/h` = **87.6%/yr**. Élő reális spreadek: SOL 31%, XRP 15%, BTC 7.8%, AVAX 7.7%, ETH 3.6% — egy nagyságrenddel a küszöb alatt. A fee-aware valódi break-even (0.29% roundtrip / 14d) ~7.5%/yr.
- **⚠️ Rejtett kockázat — sanity-cap túl laza.** A BTC 06:42-kor **2952%/yr** (0.337%/h) glitch-spreaddel jelent meg, és a `maxSpreadHourly = 0.5%/h` (4380%/yr) **átengedte** → fix nélkül glitch-adatra nyitna.

**Fixek (mind a 3, user-jóváhagyott):**

1. **Sizing-floor** — (a) `computeArbPositionSize()` pure helper az [`arb-detector.mts`](../../netlify/functions/auto-trader/hyperliquid/funding-arb/arb-detector.mts)-ben: bump-to-min, ha `headroom×0.5 < min` **de** headroom ÉS oiCap ≥ min → méret a minimumra emelve (különben skip, OI-osztály-védelem marad). (b) `minPositionUSDC` env default $50 → **$25**. Az [`index.mts`](../../netlify/functions/auto-trader/hyperliquid/funding-arb/index.mts) sizing-blokk a helpert hívja.
2. **Spread-küszöb** — `minSpreadHourly` env default 0.0001 → **0.00002** (0.002%/h ≈ 17.5%/yr). Presetek: loose 0.00001 (8.8%/yr), normal 0.00002 (17.5%/yr), strict 0.00005 (44%/yr). Séma default + step (0.00005→0.00001) frissítve.
3. **Sanity-cap** — `maxSpreadHourly` env default 0.005 → **0.0005** (0.05%/h ≈ 438%/yr, ~14× a legszélesebb reális spread felett, elkapja a glitch-osztályt). Presetek: loose 0.001, normal 0.0005, strict 0.0003. Séma min 0.001 → 0.0002, default + step frissítve.

**Verifikáció:** `tsc --noEmit` + `npm run build` zöld. `funding-arb-reverse.test.mts` bővült 5 sizing-case-szel (bump-to-min, no-bump, oiCap-blocks, headroom-blocks, oiCap-binds) — mind zöld. Új-config szimuláció az élő spreadekre: **SOL most $40-on nyitna** (forward, 31.1%/yr), a többi helyesen skippel a 17.5%/yr küszöb alatt.

**⚠️ Deploy-megjegyzés:** ha a Blobs-ban tárolt `normal` preset override aktív (a régi 0.0001/0.005 értékekkel), a kód-default-ok nem érvényesülnek amíg a user **újra rá nem nyom a Normál presetre** a Settings-ben (1 kattintás). A `minPositionUSDC` env-only → deploy után automatikusan él. → Sprint 47.

## (2) Weather — trade-audit + live-parity + invert-elemzés

**⚠️ Doksi-drift:** a CLAUDE.md „7 trade / 57.1% WR / −$8.50"-t mutatott; az élő edge-tracker **25 lezárt trade, 32% WR, −$150.17, PF 0.39, evGap −$620, calibrationDeviation 0.398**. A bot aktívan kereskedik (utolsó: Paris jún-3) és **folyamatosan veszít**.

- **Live-parity:** a simV3 a tényleges Polymarket-rezolúcióra zár (Gamma `&closed=true`, nincs sim) → a 25 kimenetel **valós**, live-ban ugyanezek a veszteségek jöttek volna — sőt valószínűleg **rosszabbak** (a vékony weather-piacokon a 0.07–0.10 entry-ű YES-longshotokon slippage + részleges fill). A veszteség nem paper-artefakt.
- **Gyökérok:** a [`bucket-matcher.mts:187`](../../netlify/functions/auto-trader/weather/bucket-matcher.mts) **a max-|edge| bucketet** választja = maximális eltérés a (jól kalibrált) piactól = tankönyvi **adverse selection** (a bot a saját forecast-hibáira szelektál). Bizonyíték: a 4 legnagyobb veszteségben a modell 1–14%-ot jósolt egy bekövetkező bucketre (piac ~35–45%) — túl vékony tail / túl magabiztos pont-forecast.
- **Invert-elemzés (flippelt PnL, azonos dolláros tét):** eredeti 32% WR / −$150 → **flippelt 68% WR / +$87** (júniusi regime ~86% — egyezik a user 80% intuíciójával). A flip **nem csak win-rate illúzió** (valódi anti-edge: +$87 vs −$150), de a profit nagy része 4 trade-ből jön → kis minta, regime-függő, és **band-aid** (egy törött modellt fordít; ha a forecast-ot javítjuk, elromlik).
- **Döntés:** user → *"weathert hagyd most ki"*. Sem invert-toggle, sem gyökérok-fix **nem implementálva** ebben a sessionben. → Backlog **B22** (invert-toggle, kísérleti) + **B23** (bucket-matcher max-disagreement gyökérok-fix).

## Fájlok

- `netlify/functions/auto-trader/hyperliquid/funding-arb/config.mts` — 3 env default (minSpread, minPosition, maxSpread)
- `netlify/functions/auto-trader/hyperliquid/funding-arb/arb-detector.mts` — új `computeArbPositionSize()` helper
- `netlify/functions/auto-trader/hyperliquid/funding-arb/index.mts` — sizing-blokk a helpert hívja
- `netlify/functions/trader-settings.mts` — frMinSpreadHourly + frMaxSpreadHourly séma + 3 preset recalibrálva
- `netlify/functions/auto-trader/shared/funding-arb-reverse.test.mts` — +5 sizing-case
- `internal-docs/roadmap/sprints.md` — Sprint 47 + B22 + B23
- `internal-docs/math/15-funding-arb.md` — sizing + threshold szekció frissítve
- `CLAUDE.md` — AKTUÁLIS ÁLLAPOT (F-Arb + Weather sor + dátum)

---

# CHANGELOG 2026-06-04 (c) — B21 diagnózis (DILÚCIÓ + σ-glitch igazolva) + mind az 5 bot reset

> Folytatás az (a) crypto audit után: a user „mehet" → B21 read-only diagnózis, majd „nullázd mindenhol a kereskedések múltbeli eredményeit és a robotok fussanak" → 5-bot reset.

## (1) B21 diagnózis — vol_divergence K-érzékenység (read-only probe)

A `signal-combiner?slug=…&category=crypto&skip_risk=1` endpointot hívtam több azonos-closing-time-ú BTC-above strike-ra (június 5, BTC≈$63,900). Eredmény a [`sprints.md` B21](../roadmap/sprints.md)-be rögzítve:

| Strike | vol_div `fairYes` | market | **combined** | σ |
|---|---|---|---|---|
| 64k (ATM) | 0.443 | 0.550 | 0.494 | **495.5%** ⚠️ |
| 66k | 0.124 | 0.212 | 0.434 | 46.2% |
| 70k (OTM) | **0.001** | 0.009 | **0.461** | 46.3% |

- **Igazolt #1 — vol_div helyesen K-aware** (`strikeSource="slug-threshold"`): fairYes 0.443→0.124→0.001. A Sprint 41 fix működik; **nem** a vol_div a hibás.
- **Igazolt #2 — primér gyökérok = DILÚCIÓ**: 70k-nál a vol_div 0.001-et mond, de a combined 0.461 → a 7 K-vak jel elnyomja az egyetlen K-aware jelet, a `combinerKBlindDownweight=0.5` **nem elég**. Ez a YES-bias mechanizmusa.
- **Igazolt #3 — szekunder σ-glitch (intermittens)**: 64k-nál σ=495.5% (a többinél 46%), hívásonként ugrál → ott a vol_div is 0.5-höz lapul.
- **Következmény**: a B21 fix-sorrend pontosítva → (a) σ sanity-clamp (gyors), (b) K-anchored combiner mód (a dilúció valódi megoldása). **Kód-változtatás nem történt** (read-only diagnózis).

## (2) Mind az 5 bot reset (user-kérés) — tiszta lap, tőke megtartva

Auth-olt `POST /auto-trader-api {action:"reset"}` mind az 5 boton; a `bankroll` override = az adott bot **meglévő** `bankrollStart`-ja (a „nullázd a *kereskedések eredményeit*" = trade-history/PnL/IC/open nullázása, tőke megtartása). F-Arb a `category=hyperliquid&layer=arb` útvonalon.

| Bot | Reset bankroll | Reset előtti PnL (törölve) | Reset után |
|---|---|---|---|
| crypto | $350 | −$38.19 (10 trade) | $350 / 0 / nem stopped |
| weather | $250 | −$150.17 (25 trade) | $250 / 0 / nem stopped |
| hyperliquid | $200 | (1 open) | $200 / 0 / nem stopped |
| funding-arb | $200 | 0 | $200 / 0 / nem stopped |
| sports | $450 | −$111.26 | $450 / 0 / nem stopped |

**Futás-ellenőrzés**: mind az 5-re kiváltottam egy manuális `run`-t (mind `ok=true`, külön kategóriával); `cronEnabled=true` mindenhol, egyik sem `stopped` → a botok futnak (cron 3 percenként). A futáskor a weather/HL/sports nyitott pozíciókat, a **crypto helyesen 0-t** (a 0.08-as `combinerConfidenceMin` kiszűri a near-noise threshold-jeleket — ez a várt viselkedés, amíg a B21 K-anchoring nem fut). A Settings reset-független: `combinerConfidenceMin=0.08`, `combinerKBlindDownweight=0.5` megmaradt.

## Fájlok (c)

- `internal-docs/roadmap/sprints.md` — B21 diagnózis-eredmény + fix-sorrend
- `CLAUDE.md` — AKTUÁLIS ÁLLAPOT: mind az 5 bot reset (tiszta lap) + crypto B21-diagnózis
- `internal-docs/changelog/CHANGELOG-2026-06-04.md` — ez a szekció

**Kód-változtatás (c)-ben nem történt** — read-only diagnózis + session-reset (auth-olt API) + doksi.
