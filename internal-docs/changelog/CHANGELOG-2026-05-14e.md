# 2026-05-14e — Cross-market consistency gate (5 bots)

## Kontextus

Az élő paper session 2026-05-14-én demonstrált egy strukturális
hiányosságot: a Crypto bot a következő két pozíciót nyitotta egymás
után, ugyanarra a resolution-time-ra (`may-14`):

| Trade | Market | Direction | Entry | pred(YES) |
|---|---|---|---|---|
| 1 | `bitcoin-above-78k-on-may-14` | NO  | 14¢ | 52% |
| 2 | `bitcoin-above-80k-on-may-14` | YES | 34¢ | 53% |

Matematikailag `{BTC>80K} ⊂ {BTC>78K}`, tehát `P(>78K) ≥ P(>80K)`.
A model 52% < 53% **monotonicitás-sértés** — és a bot úgy
pozícionált, hogy a $79K környéki zóna mind a két pozíciónak
loser. A decision-engine **per-trade** értékel, a már nyitott
pozíciókat nem nézi — ezt a hiányt foltozzuk be.

Mind az 5 bot kap egy bot-specifikus `cross-position-consistency`
gate-et a meglévő gate-lista végére, a non-short-circuit gate-pattern
folytatásaként.

## Mit változott

### 1. Új shared helper — `netlify/functions/auto-trader/shared/cross-position-gates.mts`

Tolerant slug-parser + monotonicity violation finder. A parser
elfogadja:

- `bitcoin-above-78k-on-may-14`
- `btc-above-65k-on-may-9`
- `will-bitcoin-be-above-100k-on-2026-05-14`

A `findMonotonicityViolation` előtt az `existing` lista feltöltése a
hívó dolga (csak BTC-above-K piacokat tegyél bele) — a helper
csak a tisztán matematikai részt csinálja: `K_new > K_old ⇒
predNew ≤ predOld` és fordítva, `closingKey`-csoportonként.

### 2. Crypto bot — `crypto/decision-engine.mts`

Új gate: `"Monotonicitás (egyéb nyitott pozíciók)"` (CRYPTO_GATE_LABELS
[14]). A `makeDecision()` új opcionális paramétere `openPositions:
Position[] = []`. Az `auto-trader/index.mts` átadja a session live
open positions listáját. Ha a kandidátus slug nem BTC-above-K
mintára illik, a gate `n/a (nem BTC-above-K piac)` üzenettel
átmegy — graceful degradation.

### 3. Weather bot — `weather/decision-engine.mts`

Új gate: `"Monotonicitás (egyéb nyitott pozíciók)"` (WEATHER_GATE_LABELS
[7]). Polymarket weather event = negRisk csoport, ahol bucket-ek
kölcsönösen kizárják egymást. Ezért a gate **outcome-sum** invariánst
ellenőriz: `Σ predictedProb(YES pozíciók ugyanazon city+date csoporton)
+ candidate_predictedProb ≤ 1.0`. Ha túllép, blokk. Csak YES oldali
kandidátusoknál fut; NO oldali pozíciók nem akkumulálnak ugyanígy
(egy NO implicit lefedi az összes többi bucket-et).

### 4. HL Perp bot — `hyperliquid/index.mts`

Új gate: `"Directional-consistency (no LONG+SHORT same coin)"`
(HL_GATE_LABELS[7], az "Coin nincs már nyitva" gate UTÁN). Maga a
LONG+SHORT-blokk redundáns a meglévő `"Coin nincs már nyitva"`
gate-tel a jelenlegi 1-pozíció-per-coin rezsimben, de:

1. Explicit, néven nevezve mutatja az UI-on hogy LONG+SHORT-pár
   = unleveraged + 2× fee → strict negatív EV.
2. Defense-in-depth: ha valaha relaxáljuk a "max 1 / coin"-t a
   LONG+LONG averaging miatt, a direktion-pair-blokk megmarad.

A többi HL_GATE_LABELS indexet [7]→[8] … [13]→[14] léptettem.

### 5. F-Arb bot — `hyperliquid/funding-arb/index.mts`

Új gate: `"Coin-capacity (cross-position)"` (ARB_GATE_LABELS[5], a
"Per-coin uniqueness" gate UTÁN). Ugyanaz a predikátum
(`openCoinSet.has(coin)`), két gate-en mutatva — informational, de
expliciten kommunikálja az F-Arb sajátosságát: 1 HL-short + 1
Binance-long páros, ezért coin-szintű duplikáció = redundáns
kapacitás + korrelált exit-risk. A `eligible` ellenőrzés mostantól
`uniqOk && capacityOk` kettős AND. ARB_GATE_LABELS indexet
[5]→[6] és [6]→[7] léptettem a "Pozíció szám < max" és "Capital cap
(sizing)" gate-ekre.

### 6. Sports bot — `sports/decision-engine.mts`

Új gate: `"Outcome-sum (cross-position)"`. A `SportsPosition`
megkapta a `eventSlug?: string` opcionális mezőt (backward compat:
nincsen a régi blob-okban → graceful "n/a"). Ha YES oldal +
event-slug match, a gate ellenőrzi: `Σ predictedProb(YES pozíciók
ugyanazon eventSlug-on) + candidate.predicted ≤ 1.0`. NO oldal nem
akkumulál (egy NO implicit fedi a többi outcome-ot). A meccs
outcome-sets (home/away/draw) kölcsönösen kizárók, így Σ > 100% =
garantált fee-veszteség.

### 7. Tesztek — `shared/cross-position-gates.test.mts`

Új tsx test-suite a parser + monotonicity-detector reprodukálandó
viselkedésére. Kulcs case-ek:

- 2026-05-14 live incident: 78K-NO @ 52% + 80K-YES @ 53% **flagged**.
- K_new < K_existing reverse case: 80K @ 30% + 78K @ 20% **flagged**.
- Consistent monotonic: 78K @ 60% + 80K @ 50% **pass**.
- Different closingKey groups: nem cross-flag.
- Equal K: nem monotonicitás-kérdés, pass.
- Empty existing list: pass trivially.

Futtatás: `npx tsx netlify/functions/auto-trader/shared/cross-position-gates.test.mts`
→ "all checks passed".

## Acceptance criteria — végellenőrzés

- [x] Mind az 5 bot decision-engine-jébe bekerül a megfelelő gate
- [x] A gate `non-short-circuit` (a teljes gate-listában megjelenik,
      nem tér ki azonnal)
- [x] Padded gate-listák (`padCryptoGates`, `padWeatherGates`,
      `snapGates`) is tartalmazzák (label hozzáadása a const arraybe)
- [x] A `ScanResultRow` frontend automatikusan megjeleníti
      (`Array.isArray(r.gates)` branch — nincs frontend-változás)
- [x] Crypto regressziós: a parser + violation-finder tesztelten reprodukálja
      a 2026-05-14 incidenst — 78K-NO + 80K-YES sorrend a második trade-et
      blokkolja a monotonicitás-gate-en
- [x] HL Perp regressziós: az új gate explicit LONG+SHORT-pár ellenőrzést
      végez (a meglévő "no duplicate" gate is fog), kétszintű blokk
- [x] F-Arb regressziós: ugyanazon BTC-coinra 2× F-Arb párhuzam blokk
      (Per-coin uniqueness ÉS Coin-capacity gate)
- [x] Sports regressziós: 3× YES azonos eventSlug-on a 3. trade-nél blokk
      (Σ predicted > 1.0)
- [x] `npm run build` tisztán átmegy (Astro static build OK)
- [x] `npx tsc --noEmit` 0 hibával (full type-check OK)

## Hatás

A 4 fő bot live paper session-jén ez az `5×N` új gate-evaluation
trade-tick-enként triviális overhead (mindegyik O(open_positions) =
O(<10)). Az új gate **non-short-circuit pattern**-t követ, így a
meglévő "X/Y gates" chip Y-értékei is megnőttek 1-gyel (crypto: 14→15,
weather: 7→8, HL: 14→15, F-Arb: 7→8, Sports: 5→6) — minden scan row
egységesen mutatja a teljes gate-listát.

A 2026-05-14 78K/80K incidens reprodukciója: új cron-tick után az új
Crypto-gate ezt a hint-et adná:

> `P(>80K)=53% vs P(>78K)=52% — ellentmondás`

És blokkolja a 80K-YES nyitását, megőrizve a 78K-NO pozíciót (vagy
fordítva, attól függően, melyik tüzelt először).

## Fájlok

| Fájl | Változás típusa |
|---|---|
| `netlify/functions/auto-trader/shared/cross-position-gates.mts` | új |
| `netlify/functions/auto-trader/shared/cross-position-gates.test.mts` | új |
| `netlify/functions/auto-trader/crypto/decision-engine.mts` | módosítás (új gate + új param) |
| `netlify/functions/auto-trader/index.mts` | módosítás (caller átadja openPositions) |
| `netlify/functions/auto-trader/weather/decision-engine.mts` | módosítás (új gate + új param) |
| `netlify/functions/auto-trader/weather/index.mts` | módosítás (caller átadja openPositions) |
| `netlify/functions/auto-trader/hyperliquid/index.mts` | módosítás (új gate inline + index-bump) |
| `netlify/functions/auto-trader/hyperliquid/funding-arb/index.mts` | módosítás (új gate inline + index-bump) |
| `netlify/functions/auto-trader/sports/types.mts` | módosítás (`eventSlug?` mező) |
| `netlify/functions/auto-trader/sports/decision-engine.mts` | módosítás (új gate + új param) |
| `netlify/functions/auto-trader/sports/index.mts` | módosítás (caller átadja openPositions + eventSlug) |
| `internal-docs/math/13-crypto-bot.md` | szekció bővítés (cross-position gate) |
| `internal-docs/math/14-hl-directional.md` | szekció bővítés |
| `internal-docs/math/15-funding-arb.md` | szekció bővítés |
| `internal-docs/math/16-weather-bot.md` | szekció bővítés |
| `CLAUDE.md` | AKTUÁLIS ÁLLAPOT "Mit fix utoljára" frissítés |
