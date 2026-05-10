# 2026-05-10 — Paper resolvers: real Polymarket only, no simulator (simVersion 3)

## A bug

A live `mj-trading.netlify.app/trade/crypto/` paper-tracker validációja
megmutatta, hogy a 9 closed trade 88.9% WR / IC=0.453 / +$7.44 PnL **fake
szám**: két bug együttese miatt egyetlen valós Polymarket resolution sem
fut le, és minden close egy instant-trigger Brownian sim-ből származott.

A trade-detail mintázat egyértelműen mutatta a problémát: **8 trade exit
ára = exact 0.35**, 1 trade exit-e = 0.75, semmi 0 vagy 1 közelében.
Holott a may-9-2026 BTC up/down piacok mind lezárultak már 2026-05-10-re.

```
trade #5: NO entry 0.12 → exit 0.35 (+192%)   // automatic profit
trade #7: NO entry 0.35 → exit 0.35 (0%)
trade #9: NO entry 0.20 → exit 0.35 (+75%)
```

A kontrollteszt:

```
GET https://gamma-api.polymarket.com/markets?slug=bitcoin-up-or-down-on-may-9-2026
→ [{ closed: true, outcomePrices: ["1","0"], ... }]   // YES nyert
```

A valós piacon a NO @ 0.35 trade **−$1.00 (−100%)** lett volna; a paper
$0 break-event könyvelt el. **8/9 trade hasonló diszkrepancia.**

## Két bug

### Bug A — Gamma URL filter hiányos

`auto-trader/crypto/paper-resolver.mts:45` és
`auto-trader/weather/polymarket-resolver.mts:42`:

```typescript
const url = `${GAMMA_API}/markets?condition_ids=${encodeURIComponent(conditionId)}`;
```

Empirikus teszt:

```
?condition_ids=0x51d0a5feec...           → []                    (üres!)
?condition_ids=0x51d0a5feec...&closed=true → [{ outcomePrices: [...] }]   ✓
```

A Gamma API alapból csak az aktív (nem-lezárt) market-eket adja vissza.
A `closed=true` flag nélkül **egyetlen resolved market sem található meg**
condition_ids alapján — silent fail, nincs error log.

Eredmény: a `fetchMarketResolution()` mindig `null`-t ad vissza, soha nem
trigger-el a "real" path. A flow azonnal a Brownian-bridge fallback-re
megy (Bug B).

### Bug B — Brownian sim instant-trigger deep-OTM-en

`paper-resolver.mts:99-149` (v2 verzió):

```typescript
const upperYes = direction === "YES" ? cfg.tpTarget : 1 - cfg.slTarget; // 0.65
const lowerYes = direction === "YES" ? cfg.slTarget : 1 - cfg.tpTarget; // 0.25

let yesPrice = mp;     // entry yesPrice — pl. 0.80 NO entry 0.20-on
for (let i = 0; i < steps; i++) {
  /* drift + diffusion update */
  yesPrice = clamp01(sigmoid(newLogit));
  if (yesPrice >= upperYes) { /* instant SL trigger */ }
  if (yesPrice <= lowerYes) { /* instant TP trigger */ }
}
```

Ha entry yesPrice **kívül van** a `[0.25, 0.65]` tartományon, az első
iteráció kimenetele 99%+ valószínűséggel még mindig ott van (kis
perturbáció), tehát **azonnal trigger-el az i=0-n**. A path nem
szimulálódik, az exit ár fix bound-on rögzül.

Konkrét példa, NO entry 0.20:
- yesPrice = 1 − 0.20 = 0.80
- upperYes = 0.65 → 0.80 > 0.65 → instant trigger
- exit = 1 − upperYes = **0.35** (NO oldal)
- proceeds 0.35 vs cost 0.20 → **automatikus +75% profit**

Ezért 8/9 trade ugyanazon a 0.35-ön zárt. A `simulateBrownianBridgeExit`
function helyesen implementálja a kódolt logikát, de a logika maga rossz:
a `slTarget=0.35` egy fix yes-space bound, nem entry-relatív stop-loss,
így minden NO entry < 0.35 (vagy YES entry < 0.35) instant profitot
generál.

## Fix (simVersion 3)

### 1. Crypto paper-resolver teljes átírás

`auto-trader/crypto/paper-resolver.mts` v3:

- Csak `fetchMarketResolution()` + `closed=true` query a Gamma API-n
- Brownian-bridge sim, `simulateBrownianBridgeExit()` export, és a
  `BrownianExitResult` / `ResolutionConfig` típusok teljesen törölve
- A `resolvePendingPaperPositions()` szignatúrája egyszerűsödött:
  `(session) => Promise<{ session, resolutions }>` — a `cfg` paraméter
  eltűnt, nincs több tunable knob
- Pozíció **nyitva marad**, amíg a Gamma API `outcomePrices` ∈ `{0,1}`
  értéket nem ad vissza. Ha a market endDate után 6+ órát tölt UMA
  voting-ban, a paper position is nyitva marad — pont mint live.
- Új log: `PAPER_RESOLVE_SKIP / polymarket_not_resolved_yet` minden
  tickre amíg a Gamma még nem resolved.
- Exit price snap-eli a `>= 0.999` → 1, `<= 0.001` → 0 értékeket clean
  binary-re.

**Garantált**: paper PnL identikus azzal, amit live PnL lett volna.

### 2. Weather Gamma URL fix

`auto-trader/weather/polymarket-resolver.mts:42` — `&closed=true` hozzá.
A METAR fallback (6h után) **marad**: ez fizikai underlying truth (ICAO
airport station daily-max temp), és pontosan ezt használja az UMA a
Polymarket settlement-hez. Nem szimuláció — közvetlenül a market
resolution input-ja.

### 3. HL + funding-arb audit (változtatás nem szükséges)

- `hyperliquid/paper-resolver.mts`: `getAllMids()` valós HL info API,
  TP/SL crossing detection markPrice alapján, timeout fallback aktuális
  markPrice-en zár. Minden adat valós exchange. ✓
- `funding-arb/index.mts` + `fr-executor.mts`: `scanFundings()` valós
  HL `metaAndAssetCtxs` + Binance `premiumIndex`. `accrueFunding` valós
  HL hourly rate-en megy minden tickkor. ✓
- `hedge-manager.mts` `paperFill()`: a markPrice-on tölt slippage
  nélkül. Idealizálás (no-slippage), nem szimuláció. ✓

### 4. simVersion 2 → 3

`crypto/session-manager.mts`:

```typescript
//   v3: Polymarket resolution ONLY. No simulator. Positions stay open
//       until Gamma reports outcomePrices ∈ {0,1}. Paper PnL == live PnL.
export const PAPER_SIM_VERSION = 3;
```

Az auto-archive logika (`loadSession`-ben) a deploy után az első cron
tickkor archiválja a 9 v2-paper trade-et `auto-trader-session-archive-paper-v2` Blobs key-be.

### 5. Index.mts cleanup

- `paperFallbackAfterMs` + `paperBrownianSigma` env-loadolás törölve
- `resolvePendingPaperPositions(session, cfg)` →
  `resolvePendingPaperPositions(session)` egyszerűsített hívás

### 6. trader-settings SCHEMA cleanup

`paperFallbackAfterMs` és `paperBrownianSigma` field-ek kiszedve. Régi
Blobs override értékek automatikusan figyelmen kívül hagyódnak
(`if (!(k in SCHEMA)) continue;` a `loadRuntimeOverrides`-ban).

## Validációs protokoll a deploy után

1. **Első cron tick** (3 perc): a 9 v2-paper trade archiválódik.
   `totalTrades` 0-ra esik. A Telegram `auto_reset_simversion` info-log.
2. **Új paper trade-ek nyílnak** 5–60 percenként a BTC piacokon. Logok:
   `PAPER_RESOLVE_SKIP / polymarket_not_resolved_yet` minden tickre amíg
   a market endDate-en túl van de Gamma még nem publikálta a resolution-t.
3. **Egy market resolve-ja után** a paper position lezárul exit price
   ∈ `{0, 1}` értékkel. Ha exit-e bármi más a tartomány közepén → bug.
4. **24h után**: 5–15 closed trade tipikus aktivitás mellett. Az IC
   számok mostantól valós piaci kimenetelekkel korreláltak.
5. **30+ closed trade után**: live aktivációs döntés a v3 IC értékek
   alapján. A live-readiness gate automatikusan blokkol live-ot ha
   bármelyik gate elbukik.

## Érintett fájlok

```
netlify/functions/auto-trader/crypto/paper-resolver.mts             v3 átírás
netlify/functions/auto-trader/crypto/session-manager.mts            simVersion 2→3
netlify/functions/auto-trader/weather/polymarket-resolver.mts       &closed=true fix
netlify/functions/auto-trader/index.mts                             paper-resolver cfg törlés
netlify/functions/trader-settings.mts                               2 dead SCHEMA field ki
```

Audit OK, nem érintett:
```
netlify/functions/auto-trader/hyperliquid/paper-resolver.mts        Real markPrice
netlify/functions/auto-trader/hyperliquid/order-manager.mts         Paper entry markPrice
netlify/functions/auto-trader/hyperliquid/funding-arb/index.mts     Live HL+Binance
netlify/functions/auto-trader/hyperliquid/funding-arb/hedge-manager.mts  paperFill markPrice
```

---

# 2026-05-10 — Crypto bot pending-paper-position kártya (UI follow-up)

## Mit?

A crypto bot UI-jára felkerült a `PendingPositionsCard`, ami csak akkor
render, ha van olyan paper open position aminek az `endDate`-je már
elmúlt, de a Polymarket Gamma még nem publikálta az `outcomePrices` ∈
`{0,1}`-et. Ugyanaz a kártya-nyelv és vizuális stílus mint a weather bot
2026-05-09-i pending kártyája — szimmetria a 4 bot között.

## Miért?

A simVersion 3 átállás után a crypto paper pozíciók szignifikánsan
tovább maradhatnak nyitva: nincs többé Brownian fallback, a UMA
resolution 5–60 min tipikus a 5m/15m BTC piacokon, occasion 6+ óra
dispute során. A user-nak kell egy felület ami megmutatja "ez a pozíció
lejárt, várom a resolution-t", nem csak egy néma "Open: 1" számláló.

- Ha minden rendben → a kártya **nem render** (üres rendszerben nincs
  vizuális zaj).
- Ha 1+ pozíció átlépte az endDate-et és vár → kártya rögtön megjelenik
  "expired Xm ago · awaiting Polymarket resolution" sorral.

## Hol?

### Backend (`netlify/functions/auto-trader/index.mts`)

- Új helper `getCryptoPendingPositions(session)` — szűri a
  `session.openPositions`-t `endDate < now`-ra, számolja az `ageMs`-t,
  sortolja `endDate` szerint növekvően. **Nincs fallback paraméter** —
  v3-ban nincs simulator path, a "pending" egyszerűen "past endDate,
  Polymarket még nem resolved".
- A `getStatus()` crypto ágában `base.pending` mezőként visszaadja.
- A shape-je megegyezik a weather pending-jével — `{ count, nextReconcileAt, positions }` — így a `PendingPositionsCard` ugyanazt a `PendingPositionLite[]` kontraktot fogadja mindkét boton.

### Frontend (`src/components/trader/CryptoTrader.tsx`)

- `PendingPositionsCard` import + render conditional (`pending.count > 0`).
- Per-row mapping: `primary` = title vagy slug, `secondary` = "expired Xm
  ago" (új `formatAgeAgo` helper), `direction` chip, `predictionText` =
  "pred N%", `sizeText` = "$X.XX", `whenText` = "awaiting Polymarket
  resolution".
- `footnote` magyarázza a v3 contract-ot: "paper positions close only on
  real Gamma outcomePrices. UMA resolution typical 5–60 min, longer
  during disputes."

## Mit nem változtattam?

- **A bot logikája semmilyen ponton nem változott.** A `paper-resolver.mts`
  v3 ugyanazt csinálja, a `*/3 *` cron ugyanúgy fut.
- **Nincs új manuális reconcile gomb.** A meglévő "Run Scan" gomb már
  triggereli a resolver-t (`auto-trader/index.mts:272-283` minden run
  előtt hívja `resolvePendingPaperPositions`-t), tehát redundáns lenne.
- **A weather bot UI nem változott.** Ott marad a meglévő manuális
  "⟳ Reconcile pending" gomb — azt indokolja a külön
  `auto-trader-weather-reconciler-cron` és a 6h-os METAR fallback ablak.

## Hova nyúlj legközelebb

- Ha egy market 1h+ ageMs-szel a kártyán marad → vagy UMA dispute fut,
  vagy a Gamma `closed=true` query nem találja a market-et. Diagnosztika:
  `curl 'https://gamma-api.polymarket.com/markets?condition_ids=0x...&closed=true'`.
- Új mező a sorokon (pl. live mp drift az entry óta):
  `getCryptoPendingPositions` + `pending.positions.map` callback. Máshol
  nem kell nyúlni.

## Érintett fájlok

```
netlify/functions/auto-trader/index.mts        +getCryptoPendingPositions, base.pending
src/components/trader/CryptoTrader.tsx         +PendingPositionsCard, +formatAgeAgo
```

---

# 2026-05-10 — HomePage navigáció: clickable per-category breakdown + Trading & Execution kategorizálás + venue badge

## Mit?

A főoldali `HomePage.tsx`-en három UX-feature:

1. **Aggregated session per-category breakdown sorai mostantól kattinthatóak**,
   közvetlenül a megfelelő bot oldalra navigálnak (`/trade/<category>/`).
   Az 5 oszlopos grid (label / bankroll / pnl / trade-count / status pill)
   változatlan, csak `<div>` → `<a>` lett, és kapott egy 6. oszlopot a hover
   nyíl arrow-nak (→). Hover-en a sor háttere kissé világosodik (`#131318`)
   és 2px-t jobbra mozdul (`translateX(2px)`); a nyíl ekkor accent-zöldre
   vált, szintén jobbra mozdul. Mobil layouton (≤600px) az arrow külön
   grid-area-ban van a jobb szélén.

2. **Trading & Execution szekció kategorizálva: Automated bots / Manual
   execution** — eddig 7 kártya volt egy flat rácsban, most 2 alszekció:
   - **⚙ Automated bots** (cron */3 perc): Crypto, Hyperliquid Perp,
     Funding Rate Arbitrage, Weather Trader.
   - **🎯 Manual execution** (user-triggered orders): Bybit Futures,
     Binance Futures, Polymarket Manual + Auto-Claim.

   Mindkét alszekciónak saját header-pill-je van bal-szegéllyel
   (`var(--accent)`), címkével és meta sub-label-lel ("cron */3 perc · saját
   session · paper/live" / "user-triggered orders · nincs auto-session").

3. **Venue badge minden execution kártyára** — a bot kártya belsejében a
   cím alatt egy kis `venue: Polymarket` / `venue: Hyperliquid` /
   `venue: Hyperliquid + Binance` / `venue: Bybit` / `venue: Binance` chip
   jelenik meg (`var(--surface2)` háttér, `var(--accent2)` venue-name szín).

## Miért?

A user kifejezetten kérte: az Aggregated session elemeire is lehessen
kattintani (egy klikkel a bot oldalra), és a Trading & Execution dobozai
mutassák, melyik bot hol kereskedik (venue) + kategorizálva legyenek
(auto vs. manual). Eddig a per-category breakdown csak read-only
state-displayer volt, pedig pontosan az a mission-control sor, ami felett
a leggyakoribb felhasználói cselekvés a "ugorjunk a bot oldalára". A flat
7-kártyás rács pedig nem mutatta első ránézésre, melyik bot autonóm
cron-vezérelt és melyik kézi.

## Hol?

### `src/components/HomePage.tsx`

- **`Card` interface**: új opcionális mezők — `venue?: string` és
  `auto?: "auto" | "manual"`.
- **`CARDS[]`**: a 7 execution-kártya megkapta a `venue` és `auto` mezőket:
  - crypto: `Polymarket` / `auto`
  - hyperliquid: `Hyperliquid` / `auto`
  - funding-arb: `Hyperliquid + Binance` / `auto`
  - weather: `Polymarket` / `auto`
  - bybit: `Bybit` / `manual`
  - binance: `Binance` / `manual`
  - polymarket-manual: `Polymarket` / `manual`
- **Per-category breakdown**: `<div className="hp-bd-row">` →
  `<a href={`/trade/${c.category}/`} className="hp-bd-row">` + új
  `<span className="hp-bd-arrow">→</span>` 6. cellaként.
- **Execution rács**: `<SectionTitle …>` után 2 különálló blokk
  `hp-cat-head` header-rel és külön `hp-grid`-rel; filter:
  `c.group === "execution" && c.auto === "auto" | "manual"`.
- **`CapCard`**: a `hp-card-title` után új feltételes `hp-card-venue`
  blokk — `venue` label + venue name két `<span>`-ben.
- **Section subtitle frissítve**: "Aggregated session" alatt mostantól
  *"Minden bot összesítve · alább kattintható per-category lebontás → bot
  oldal"* — vizuális hint hogy a sorok klikkelhetők.

### CSS bővítés (ugyanaz a fájl `css` template literal vége)

- `hp-bd-row`: `text-decoration: none; color: inherit; cursor: pointer;` +
  `transition: background .12s, transform .08s;` + `:hover` (bg `#131318`,
  `translateX(2px)`). Grid-template-columns kibővítve 14px-es arrow
  oszloppal. Mobil grid-template-areas frissítve.
- Új `.hp-bd-arrow` selector + hover-state arrow szín/elmozdulás.
- Új `.hp-cat-head` (és `.hp-cat-head-spaced` modifier a 2. headerre 26px
  margin-top-pal): `display: flex` icon + label + meta-margin-left:auto.
  Bal oldali 3px accent border.
- Új `.hp-card-venue`, `.hp-venue-label`, `.hp-venue-name`: chip a card
  belsejében a title alatt. `--surface2` bg, `--accent2` venue-name szín.

## Tesztelés

- TypeScript: `npx tsc --noEmit` — `HomePage.tsx`-ben nincs új error
  (a 6 jelzett pre-existing más fájlokban).
- Per-category sor klikkre `/trade/crypto/`, `/trade/weather/`,
  `/trade/hyperliquid/`, `/trade/funding-arb/` oldalra navigál. A
  category string közvetlenül a `multi-status` response-ból jön
  (`multi-status.mts:66/85/104/128`), így minden helyen érvényes URL.

## Follow-up ötletek (nem ebben a session-ben)

- A venue badge nem-execution (analysis) kártyákra is felkerülhet később
  (pl. "Apex Wallets · venue: Polymarket data-api"), de most az nem volt
  kérve és elveszne a vizuális homogenitásból.
- Az `hp-cat-head` mintát lehetne az analysis szekcióban is használni
  (pl. "Order flow analytics" / "Market scanner" / "Arbitrage research"),
  ha később bővülnek az analysis kártyák.

## Érintett fájlok

```
src/components/HomePage.tsx     +venue/auto fields, +clickable bd-row,
                                 +Automated/Manual subgroups, +venue badge,
                                 +CSS for hp-bd-row hover, hp-cat-head, hp-card-venue
```

---

# 2026-05-10 (b) — Auto-Trader Tab 1 visibility pass: open positions, pending, blocker chips, weather stats

## Mit oldottunk meg

A 4 bot oldalának (Crypto, Weather, HL, Funding-Arb) első tabján (Auto-Trader)
3 láthatósági hiba volt:

1. A **scan-row** csak hover-en árulta el, hogy egy "skip" miért skipped.
   A user végigment a sorokon és nem látta szín alapján, hogy *kritérium-blokk*
   vagy *infrastruktúra-skip* miatt nem kötött a bot.
2. A **nyitott pozíciók** sehol sem jelentek meg expliciten a Tab 1-en
   (Crypto: csak "open: 2" stat; Weather: hiányzott teljesen; HL: hiányzott).
   Pending settlement is csak a Crypton+Weatheren volt, és nem volt
   szétválasztva: minden open position bekerült a "pending" listába, akkor is
   ha még a trading window-ban volt.
3. A **Weather** Tab 1-ről hiányzott a 4-cellás stats grid (bankroll, session
   pnl, trades, open) — minden más boton ott van, csak ott nem.

## Backend

### `auto-trader/index.mts`

- **getStatus** payload bővítve `openDetails` mezővel mind crypto, mind weather kategóriára:
  - `getCryptoOpenActive(session)` — csak azok a `session.openPositions`
    sorok, ahol `endDate > now` (vagy nincs endDate). Visszaadja a market
    címét, irányát, costBasist, avgEntry-t, predictedProb-ot.
  - `getWeatherOpenActive(session)` — csak azok, ahol
    `weatherMeta.reconcileAfter > now`. Visszaadja a city/date/bucket-et,
    direction-t, predictedMaxC-t.
- A `pending` lista most már SZIGORÚAN a "lejárt, settlement-re vár" sorok:
  - Crypto: változatlan (endDate < now).
  - Weather: új `getWeatherPendingForSettlement()` szűri az `isReady=true`
    sorokat (reconcileAfter ≤ now).

### `hyperliquid/index.mts`

- **getHlStatus** payload bővítve `openDetails` mezővel: minden HL perp
  pozíció (coin, direction, sizeUSDC, sizeCoins, entryPrice, leverage,
  tpPrice, slPrice, openedAt, edgeAtEntry, predictedProb).

## Frontend

### `shared/TraderResults.tsx`

- **OpenPositionsCard.OpenPositionRow** kiterjesztve direction (LONG/SHORT/
  YES/NO) + entryText + spreadText opcionális mezőkkel + a pnl/pnlValue
  most opcionális (HL-en már pnl-t mutatunk a closed-trade rowban, az open
  perpnél nem akarunk fake unreal PnL-t).
- **ScanResultRow** új tone-mező (pass/skip/fail/neutral): a `ts-row`
  bal oldali border-ja most szín-kódolt:
  - `pass` zöld (traded/position_opened/opened)
  - `skip` narancs, halvány narancs háttér (skip + ≥1 failed gate)
  - `fail` piros (failed/error)
  - `neutral` átlátszó (skip ok pl. "already has open position", closed)
- **Inline blocker line**: skip+failed-gate eseteken a sor maga megmutatja
  az **első** elbukott gate-t — ✗ jellel, label-lel, tényleges és elvárt
  értékkel, plus "+N további" ha több is van. Hover továbbra is a gate
  popoverre kattan.

### `shared/traderShellStyles.ts`

- `.ts-row-pass/.ts-row-skip/.ts-row-fail/.ts-row-neutral` border-left + bg
  tint
- `.ts-row-blocker*` chip stílus (narancs border + halvány narancs bg,
  piros ✗ és tényleges érték kiemelve)

### Per-bot panelek

- **CryptoTrader.tsx**: új OpenPositionsCard a pending fölött. Az
  openDetails sorok title/direction/avgEntry/costBasis/predictedProb-ot
  mutatnak; "ends in Xh Ym" countdown az `endDate`-ig.
- **WeatherTrader.tsx**: új stats grid (Bankroll/Session PnL/Trades/Open) +
  alerts (Stopped) + új OpenPositionsCard a pending fölött; sorok:
  `City · Bucket` / direction / @entry / size / "pred 24°C · 2026-05-10" /
  "settles in Xh".
- **HyperliquidTrader.tsx**: új OpenPositionsCard a scan-results fölött
  HL perp pozíciókkal: coin / direction / @entryPrice / `$X · Nx lev` /
  `TP $... / SL $...` / age.
- **FundingArbPanel.tsx**: változatlan — már korábban OpenPositionsCard-ot
  használt a `session.openDetails`-ből.

## Eredmény

- Tab 1-en minden boton most szín alapján egyértelmű, hogy az egyes piacok
  miért nem kerültek pozícióba — nem kell hover-elni a gates chipre.
- Mind a 4 boton ugyanaz a 4-es stats grid (Bankroll/PnL/Trades/Open).
- Mind a 4 boton ugyanaz a "Open positions" + (ahol releváns) "Pending
  settlement" kártya jelenik meg a Run Scan gombsor alatt.
- Új bot hozzáadásakor a TraderShell + a 4 mapper (criteria + stats +
  openDetails + pending) kibővítése egy helyen elegendő — a
  TraderResults.tsx most tartalmazza az összes közös vizuális blokk-ot.

## Érintett fájlok

```
netlify/functions/auto-trader/index.mts          +getCryptoOpenActive, +getWeatherOpenActive,
                                                   +getWeatherPendingForSettlement,
                                                   getStatus payload: +openDetails
netlify/functions/auto-trader/hyperliquid/index.mts  getHlStatus payload: +openDetails
src/components/shared/TraderResults.tsx          ScanResultRow tone+blocker line,
                                                   OpenPositionsCard direction/entry support
src/components/shared/traderShellStyles.ts       +ts-row tone styles, +ts-row-blocker
src/components/trader/CryptoTrader.tsx           +OpenPositionsCard render
src/components/trader/WeatherTrader.tsx          +stats grid, +alerts, +OpenPositionsCard
src/components/trader/HyperliquidTrader.tsx      +OpenPositionsCard render
```

---

# 2026-05-10 (c) — Bankroll input wired through to backend reset

## A bug

A főoldali `Bankroll: $200` input mező **egyik bot oldalon sem volt
funkcióban**. A user beírt egy számot, az `localStorage`-ba mentődött, de
a backend session bankrollját semmi nem frissítette. Minden reset a
hardcoded szerveroldali konstansokkal mintázott új sessiont:

| Bot           | DEFAULT_BANKROLL | Forrás                                              |
|---------------|------------------|-----------------------------------------------------|
| Crypto        | $150             | `auto-trader/index.mts:61`                          |
| Weather       | $100             | `auto-trader/weather/index.mts:21`                  |
| Hyperliquid   | $200             | `auto-trader/hyperliquid/session-manager.mts:15`    |
| Funding-Arb   | $200 (HL-shared) | `loadHlSession().bankrollCurrent`                    |

Két ok:

1. **DashboardShell** signature `children: (tab, bankroll) => ReactNode`
   volt, de a `CategoryDashboard` csak `(tab) => render(tab)`-ként hívta
   meg, így a bankroll prop sosem jutott el a trader komponensekhez.
2. A trader komponensek (CryptoTrader, WeatherTrader, …) nem fogadtak
   `bankroll` propot, és a `doAction("reset")` sem küldött bankroll-t a
   POST body-ban.
3. A backend reset endpointok (`handleReset`, `hlReset`, `arbReset`)
   nem fogadtak `bankroll` paramétert — mindig a hardcoded defaultot
   használták.

## Fix

**Backend (`netlify/functions/auto-trader/index.mts`):**
- A POST body parser már a `bankroll` mezőt is olvassa, finite-check +
  `[10, 1_000_000]` clamp.
- `handleReset(config, category, bankrollOverride?)`: ha van override,
  azt használja, különben kategória-specifikus default ($100 weather /
  $150 crypto).
- A dispatcher átadja a `bankrollOverride`-t mind `handleReset(...)`,
  mind `hlReset(...)`, mind `arbReset(...)` hívásnál.

**`netlify/functions/auto-trader/hyperliquid/index.mts`:**
- `hlReset(bankrollOverride?)` — átadja a `resetHlSession(paperMode,
  bankroll)` függvénynek (a default param már létezett).

**`netlify/functions/auto-trader/hyperliquid/funding-arb/index.mts`:**
- `arbReset(bankrollOverride?)`: F-Arb sessionnek nincs saját bankrollja,
  a HL session `bankrollCurrent`-ből húz. Ha az override jött:
  - **HL sessionben nincs nyitott pozíció** → frissíti a HL session
    `bankrollStart` és `bankrollCurrent` mezőit (a HL trade history
    érintetlen marad).
  - **Van nyitott HL pozíció** → silently ignore-olja a bankroll
    változást (különben a PnL accounting elromlana).
- Response payload: `bankrollApplied: number | null`,
  `bankrollSkippedReason: string | null` — UI tudja használni.

**Frontend:**
- `DashboardShell.tsx`: `children(tab, bankroll)` — most már átadja a
  bankrollt.
- `CategoryDashboard.tsx`: minden `render*Tab(tab, bankroll)`,
  trader komponensek `<CryptoTrader bankroll={bankroll} />` formában.
- 4 trader komponens (`CryptoTrader`, `WeatherTrader`, `HyperliquidTrader`,
  `FundingArbPanel`):
  - `bankroll?: number` prop fogadás.
  - `doAction("reset")` mostantól `extras = { bankroll }`-t küld.
  - `sessionSummary`-ban új sor: "Új starting bankroll a reset után:
    $X (a fejléc Bankroll mezőjéből)" — a ConfirmDialog ezt jeleníti
    meg, így a user a "RESET" gépelése előtt látja, hogy mire fog
    átállni.
- `useTraderAction.run(action, extras?)` kibővítve egy generikus
  `Record<string, unknown>` extras paraméterrel — minden további
  per-action body field ide kerülhet a jövőben.

## Mit nem változtattam

- A bankroll input továbbra is `localStorage`-ban perzisztál — nem külön
  per-bot, hanem közös. Ez OK, mert:
  - Crypto / Weather / HL: külön session, mindegyiknek külön reset →
    a user beírja amit akar és külön reset-eli mindet.
  - F-Arb: HL-lel megosztott pool, jelzem a confirm dialogban.
- A bankroll change MID-SESSION nincs kezelve — csak Reset-tel lehet.
  Ez szándékos: a Kelly sizing és a session loss limit % a `bankrollStart`
  alapján van számolva, futás közben módosítva ezeket inkonzisztenssé
  tenné.
- Az F-Arb reset nem reset-eli a HL sessiont (csak a bankroll mezőt
  frissíti, ha biztonságos) — F-Arb és HL külön sessionök.

## Ellenőrzés

```bash
# Crypto bot, $300 bankrollra reset
curl -X POST https://mj-trading.netlify.app/.netlify/functions/auto-trader-api \
  -H "Content-Type: application/json" \
  --cookie "auth=<JWT>" \
  -d '{"action":"reset","category":"crypto","bankroll":300}'

→ { "ok": true, "session": { "bankrollStart": 300, "bankrollCurrent": 300, ... } }

# F-Arb reset $500 bankrollra (HL üres):
curl -X POST ... -d '{"action":"reset","category":"hyperliquid","layer":"arb","bankroll":500}'
→ { "ok": true, "bankrollApplied": 500, "bankrollSkippedReason": null, ... }

# F-Arb reset $500-ra, de HL-ben van 1 nyitott BTC perp:
→ { "ok": true, "bankrollApplied": null,
    "bankrollSkippedReason": "HL session has 1 open perp position(s); ..." }
```

## Érintett fájlok

```
netlify/functions/auto-trader/index.mts                          parse + dispatch
netlify/functions/auto-trader/hyperliquid/index.mts              hlReset(bankroll?)
netlify/functions/auto-trader/hyperliquid/funding-arb/index.mts  arbReset(bankroll?) + HL-update
src/components/shared/DashboardShell.tsx                         (already passed bankroll)
src/components/CategoryDashboard.tsx                             render*(tab, bankroll)
src/components/shared/TraderShell.tsx                            run(action, extras?)
src/components/trader/CryptoTrader.tsx                           +bankroll prop, reset extras
src/components/trader/WeatherTrader.tsx                          +bankroll prop, reset extras
src/components/trader/HyperliquidTrader.tsx                      +bankroll prop, reset extras
src/components/trader/FundingArbPanel.tsx                        +bankroll prop, reset extras
```

---

# 2026-05-10 (c) — Stale UI: 3 fantom-trade a /trade/weather/ scan results-ben

## A jelenség

A live `mj-trading.netlify.app/trade/weather/` Tab 1-en 3 sor jelent meg
"traded" akcióval (Shanghai 24°C, Paris 18°C, London 15°C, mind NO entry),
de a **stats kártyán Trades=0** és a **LiveReadinessBadge "Trade count" gate
0/30**. A 3 trade tehát a UI-on van, de sem a session-ben, sem a live
readiness statisztikájában nem szerepel.

A felhasználó észrevette: "azt írja, hogy három traded van, de közben a
live trades 0. ez bug?"

## A két ok

### Ok #1 — `loadSession()` nem írja vissza a v3 resetet

`crypto/session-manager.mts:76-89` — amikor a `loadSession()` v2-es session-t
detektál és auto-archive-ot triggerel, a régi session-t **archive key**-be
írja (`auto-trader-session-archive-paper-v2-weather`), de a fő **session
key**-t (`auto-trader-session-weather`) NEM írja felül a fresh v3-mal.
Csak in-memory tér vissza:

```typescript
if (paperMode && v < PAPER_SIM_VERSION) {
  await store.set(archiveKey(...), JSON.stringify({ session: parsed })); // ✓ archive ír
  log("SESSION_START", ...);
  return defaultSession(...);                                              // ✗ nem persistál
}
```

Következmény: a fő blob **továbbra is v2 marad**. A következő `loadSession()`
hívás (5s-enként a UI status pollok miatt) ugyanazt a v2 blob-ot olvassa,
újra archíválja, majd újra a v3 default-tal tér vissza. A logban ez 19
darab `auto_reset_simversion / archivedTradeCount: 1` event 8 perc alatt.

A `multi-status.mts` (homepage dashboard) viszont **közvetlenül a fő
blob-ot olvassa**, nem hívja a `loadSession()`-t. Ezért lát "1 closed
trade + 3 open positions" weather-en már 2026-05-08 óta — a v2 session,
amit a deploy-kor archíválni kellett volna, valójában soha nem
archíválódott persistensen.

### Ok #2 — `runStatus.lastResult` nem invalidálódik simVersion bump-on

A `weather/index.mts` `weather-runtime` Blobs store-ja külön a session
blob-tól. A `runWeatherTrader()` minden futás után frissíti
(`saveRunState({ lastResult: result, ... })`). Az utolsó tényleges run
**2026-05-10 07:29Z**-kor futott le (még simVersion 2-vel), és 3 pozíciót
nyitott (`action: "traded"`). Azóta nem futott újra (cron OFF, manual
trigger sem). Tehát a `lastResult.results` továbbra is a 3 v2-béli
trade-et tartalmazza, miközben a session-ben már semmi nincs.

A UI a `lastResult.results`-ot rendereli a `ScanResultsCard`-ban. Innen
a 3 fantom sor.

## A két fix

### Fix A — persist a v3 reset

`netlify/functions/auto-trader/crypto/session-manager.mts:76-95` — a fresh
default session-t most a session key-be is kiírja, nem csak az archive-ba.
Ezzel az auto-reset egyszer fut le, nem végtelen ciklusban.

```typescript
const fresh = defaultSession(defaultBankroll, paperMode);
try {
  await store.set(sessionKey(paperMode, category), JSON.stringify(fresh));
} catch {}
log("SESSION_START", ..., { reason: "auto_reset_simversion", ... });
return fresh;
```

Ez automatikusan érinti **minden 4 botot, mind paper-, mind live-oldalt**,
mert a `session-manager.mts` a központi session loader (crypto, weather
egyaránt használja, és a generic shape miatt HL/funding-arb is, ha
egyszer migrálódnak ide).

A multi-status (homepage) ezután már a frissített v3 blob-ot olvassa,
azaz a weather-re `closedTrades: 0, openPositions: 0`-t fog visszaadni
azonnal a deploy + első UI poll után.

### Fix B — drop stale lastResult ha simVersion mismatch

`netlify/functions/auto-trader/weather/index.mts:51-93`
(`getWeatherRunStatus`) és `auto-trader/crypto/run-state.mts:47-83`
(`getCryptoRunStatus`) — mindkettő ellenőrzi most:

```typescript
const snapshotSimV = lastResult?.session?.simVersion
                  ?? lastResult?.liveReadiness?.summary?.simVersion
                  ?? null;
if (typeof snapshotSimV === "number" && snapshotSimV < PAPER_SIM_VERSION) {
  lastResult = null;
  await saveRunState({ ...s, lastResult: null });   // perzisztens cleanup
}
```

A `lastResult.session` nem tartalmazta közvetlenül a `simVersion` field-et
(a `summarize()` nem írta bele), de a `lastResult.liveReadiness.summary.
simVersion` mindig jelen van — ezért a fallback olvasási sorrend.

A `saveRunState` cleanup azt is biztosítja, hogy a következő pollok már
ne folytassák ugyanazt az összehasonlítást — egyszer fut, utána a blob
tisztán nullázott.

## Mit lát a felhasználó a deploy után

1. **Első UI poll** (5s-en belül): a weather oldalon a 3 "traded" row
   eltűnik, mert a `getWeatherRunStatus` lenullázza a stale lastResult-ot.
2. **Stats kártya**: változatlanul 0 trade / 0 open (mint eddig — ez már
   helyes volt).
3. **Homepage breakdown**: az első weather status poll után (manuális
   navigáció vagy 5s polling) a v2 blob v3-ra íródik. Innen a multi-status
   weather-re 0 closed / 0 open-t ad vissza. **Az "1 trade" és "3 open"
   értékek eltűnnek a homepage-ről** — ez a helyes érték a v3 paradigmában,
   mert a v2 trade egy eltört Brownian-sim artifact volt (lásd `2026-05-10
   (a)` szekció).
4. **Logok**: a `auto_reset_simversion` event-ek megszűnnek a status
   pollok közben — egy darab fut le csak, az is csak az első érintett
   bot első poll-jakor.

## Mit nem változtattam

- **HL és funding-arb session loader**: külön fájlokban élnek
  (`hyperliquid-session-v1` és `hyperliquid-arb-session-v1` Blobs
  store-okban), saját `loadSession`-jük van. Egyik sem implementál
  simVersion auto-archive logikát (mert nem prediction-driven), így a
  fix #1 ott nem alkalmazandó. A fix #2 sem szükséges: ezeknek nincs
  per-version cseréje.
- **A v2 archive**: nem írom felül. A `auto-trader-session-archive-paper-
  v2-weather` blob-ban marad az 1 closed + 3 open pozíció forensic
  célokra (lásd a CLAUDE.md-ben hivatkozott v3 paradigma).

## Files

```
netlify/functions/auto-trader/crypto/session-manager.mts     persist v3 reset
netlify/functions/auto-trader/weather/index.mts              import PAPER_SIM_VERSION + strip stale lastResult
netlify/functions/auto-trader/crypto/run-state.mts           import PAPER_SIM_VERSION + strip stale lastResult
```

## Weather bot egészségi audit (this session)

A javítás után a teljes weather pipeline-t végigellenőriztük (Explore
sub-agent). Összefoglaló:

| Modul                       | Státusz     | Megjegyzés                                                  |
|-----------------------------|-------------|-------------------------------------------------------------|
| forecast-engine.mts         | PASS        | applyCityOffset toggle, target-date filter, ensemble OK     |
| ensemble-forecast.mts       | PASS        | 31-member, DEB weights, stddev-driven confidence            |
| decision-engine.mts         | PASS        | maxEdgeCap 0.40, ¼-Kelly + 15% cap, 9/9 config field        |
| market-finder.mts           | PASS        | 8 új város mapped + dropped event diagnosztika              |
| polymarket-resolver.mts     | PASS        | `&closed=true` query, {0,1} snap                            |
| reconciler.mts              | PASS        | Polymarket → METAR 6h fallback, °F rounding (UMA quirk)     |
| metar-fetcher.mts           | PASS        | T-group parse, station-local date filter                    |
| auto-trader-weather-cron    | PASS        | weatherCronEnabled toggle respected, default OFF            |
| reconciler-cron             | PASS        | always-on, */15, paperMode hardcoded                        |
| live-readiness simVersion   | INTENTIONAL | weather METAR-driven, nem sim-driven → null gate helyes     |

A weather bot **funkcionálisan kifogástalanul fut** a v3-ban. A jelen
session-ben javított stale-UI bug pusztán prezentációs probléma volt:
a session és a settlement valós, de a UI elavult cache-ből rajzolt.

---

# 2026-05-10 (c) — Crypto bot entry decision visibility + Kelly=0 hard-skip

## Probléma (élő paper validáció)

A `mj-trading.netlify.app/trade/crypto/` 3 nyitott pozíciójának
felülvizsgálata során kiderült:

1. A signal-combiner kelly.full=0/kelly.quarter=0 értéket adott
   (recommendation = WAIT, "jelzések nem konvergálnak", IR=0.145), de
   a `decision-engine.mts:104-105` `Math.max(1, bankrollUSDC * kellyCapped)`
   sora $1-es minimum size-zal akkor is nyitott pozíciót, ha a Kelly
   éppen 0. **Konkrét eset:** 3 BTC paper trade ment ki $1-en kelly=0
   mellett, mert csak az edge ≥ 15% küszöbön mértük a konvergenciát,
   de a combiner saját Kelly verdiktjét ignoráltuk.
2. A felhasználó az UI-on csak a végeredményt látta (entry, méret, pred);
   nem volt mód utólag megnézni mire alapult a döntés (gross/net edge,
   raw signal-ok, OB imbalance, gate-ek).

## Backend változások

### `shared/types.mts`
- Új típus: `DecisionGate` (label, passed, actual, required, hint).
- Új típus: `EntryDecisionSnapshot` — frozen-at-entry kontextus minden
  signal-szel, Kelly-bontással, OB imbalance-szel és a teljes gate-listával.
- `Position.entryDecision?: EntryDecisionSnapshot` — opcionálisan tárolja
  a snapshotot a Blobs `auto-trader-state`-ben (back-compat: régebbi
  pozíciók `undefined`-dal töltődnek).
- `TradeDecision.gates?: DecisionGate[]` — a decision-engine visszaadja
  ami megegyezik a snapshot-tal.

### `crypto/decision-engine.mts` — teljes átírás (gate-list + Kelly=0 gate)
- Minden gate-et explicit `gates.push({...})`-szel ad hozzá az ordered
  listához (early exit esetén is).
- **Új gate (P2.1): "Kelly conviction (combiner)"** — `signal.kellyFraction > 0`.
  Ha 0 → `noResult("Signal-combiner Kelly=0 → no conviction")`.
  Hatás: ha az 5-8 raw signal-ból a combiner azt mondja "nincs edge"
  (kelly = 0 a 0.5 finalProb miatt, vagy a Fundamental Law IR-je
  alacsony), a bot nem nyit minimum-size $1 pozíciót se.
- A többi gate ugyanaz mint régen: session loss, active≥2, cooldown,
  open interest, entry-window, OB imbalance konvergencia, net edge ≥
  threshold, Kelly cap.

### `auto-trader/index.mts`
- `placeBuyOrder` után `entryDecision: EntryDecisionSnapshot` build és
  `paperPosition.entryDecision = entryDecision`. Minden új paper trade-en
  fagyasztva van: `decidedAt`, `finalProb`, `marketPrice`,
  `gross/netEdge`, `feePct`, `direction`, `kellyRaw/Capped/Cap`,
  `positionSizeUSDC`, `entryPrice`, `activeSignals`, `signalBreakdown`,
  `obImbalance`, `gates[]`, `reason`.
- `getCryptoOpenActive()` exposeolja az `entryDecision` mezőt a status
  payload `openDetails[]`-ben.

## Frontend változások

### `shared/TraderResults.tsx`
- Új típus: `OpenPositionRationale` (== `EntryDecisionSnapshot` UI-side).
- `OpenPositionRow.rationale?: OpenPositionRationale | null` — ha mező
  jelen van (akár null!), a sor `<details>`-elemmé alakul, expandable.
- Új belső komponens: `RationaleBlock` — render egy zöld accent-bordered
  panelt: tézis-mondat (modell vs piac, irány, méret), 4-cellás grid
  (gross edge / net edge / kelly raw→capped / aktív signal-ok), signal-
  bontás nyíl-chip-ekkel (FR/VPIN/VOL/APEX/CP + OB), gate-lista pass/fail
  jelölésekkel, és meta sorral (decidedAt + reason).
- `null` rationale (régebbi pozíció) → muted "Adat nem elérhető..."
  placeholder a panelben.

### `shared/traderShellStyles.ts`
- 100+ sor új CSS: `.ts-pos-details`, `.ts-pos-why-toggle` (chevron-os
  Why? chip), `.ts-pos-why` panel (accent2 bal-szegély), grid-cellák,
  signal-chip-ek (up/down/off/ob), gate-list (pass-zöld pipa, fail-piros
  háttér), responsive grid 600px alatt.

### `trader/CryptoTrader.tsx`
- Importálja az `OpenPositionRationale` típust.
- `openDetails` típusa bővítve `entryDecision: OpenPositionRationale | null`.
- A row mappelésnél `rationale: p.entryDecision ?? null`.

## Mit oldottunk meg / mit nem

| Probléma                                              | Állapot |
|-------------------------------------------------------|---------|
| Kelly=0 mellett $1 minimum size override              | ✅ FIX  |
| UI: "miért nyitotta a bot ezt?"                       | ✅ FIX  |
| Daily markets-en az entry-window gate idle            | unchanged (külön ticket) |
| Combined prob ~0.5-nél mechanikusan generált edge     | részben (Kelly=0 most blokkol) |
| 3 régi pozíció paper PnL                              | unchanged (v3 garantálja, real Polymarket close-ra vár) |

## Tesztelési protokoll (deploy után)

1. A 3 jelenleg nyitott pozíció (`bitcoin-up-or-down-on-may-10-2026`,
   `bitcoin-above-80k/82k-on-may-11`) entryDecision nélkül létezik —
   a "Why?" toggle muted placeholdert mutat.
2. Az új cron tick (\*/3) az új gate-szettet futtatja: ha a combiner
   még mindig kelly=0-t ad, az új trade-ek **nem nyílnak**, a sor
   "skip: Signal-combiner Kelly=0 → no conviction" lesz.
3. Ha a combiner ad végre kelly>0-t (más BTC piac, jobb signal mix),
   az új trade entryDecision-nel mentődik → a "Why?" panel teljesen
   feltöltött.

## Hova nyúlj legközelebb

- **Egyéb bot ugyanezt kapja**: a `OpenPositionsCard.rationale` props
  generikus, csak a backend (weather-meta, HL signal-mix) építi fel
  ugyanezt a snapshot shape-et. ~30 sor copy a weather/HL trader-ekbe,
  minden további bot azonnal megkapja a "Why?" panelt.
- **Closed trades**: a `ClosedTrade` is megérdemli ugyanezt a frozen
  rationale-t (most csak `signalBreakdown` van benne). Edge tracker
  per-trade view-ban szintén megjelenne.
- **Daily markets entry-window**: a `parseDurationMs` jelenleg csak
  "X minute/hour" patternt fog. Ha akarjuk, a daily piacokra ráillesztünk
  egy "morning-window" gate-et (open ~16:00 UTC előző nap → entry-window
  pl. 08:00–14:00 UTC).



---

# 2026-05-10 (d) — Crypto bot audit + math/13-crypto-bot.md

Különálló session, kód-változás nélkül: a teljes crypto trader pipeline
végigauditálva (scan → signals → decision → execute → resolve), és új
`internal-docs/math/13-crypto-bot.md` doksi készült amely **az aktuális
implementációt** dokumentálja, nem a tervet.

## Audit findings (kód NEM változott, csak megnevezve a doksiban §9)

**A. Live exit code unused** — `crypto/order-lifecycle.mts` definiál
`checkExitConditions / handleSellLifecycle / emergencySell` függvényeket,
de a `runCryptoTrader()` orchestrátor sosem hívja meg ezeket.
Következmény:
- TP/SL korai exit nincs sem paper, sem live módban. A `BTC_TP_TARGET` /
  `BTC_SL_TARGET` env-ek és a Settings UI knobjai idle.
- Live mode-ban nincs settlement reconciliation: a Polymarket on-chain
  outcome nem írja vissza a session state-et.

A `live-readiness` gate ezért szigorú default thresholds-szel jár, de még
a gate átengedése után sem szabad live-ra kapcsolni amíg ez nem épül meg.
Grep verify: `Grep "checkExitConditions|handleSellLifecycle|emergencySell"`
→ csak a saját definíciója + dokumentáció említi, nincs hívás production
kódban.

**B. Cron source label** — `netlify.toml` `auto-trader` schedule közvetlen,
nem a `multi-cron`-on át. Ezért a `?source=cron` query nem érkezik meg,
és a `runCryptoTrader()` "manual"-ként tag-eli a cron tick-eket. UX-only
bug, a homepage status pill nem mutatja a "(cron)" badge-et a crypto
botra. Funkcionális hatás nincs.

**C. SignalBreakdown shape lemarad** — a `signal-combiner` 8 jelzést
számol (vol/orderflow/apex/cond/funding/momentum/contrarian/pairs_spread),
de a `SignalBreakdown` típus csak 5 mezőt tárol. A 3 új jelzés a
`combined_probability`-be megy, de a UI "Why?" panel-én nem látszik, és
a `pearsonCorrelation` IC számítás se érinti őket. Az `active_signals`
count mind a 8-at tartalmazza — így a #2 gate (≥ 2 aktív) átmehet úgy,
hogy a UI-on egyetlen jelzés sem látszik.

**D. Session summary missing simVersion** — `sessionSummary()` helper nem
tartalmazza a `simVersion` mezőt, ezért a `getCryptoRunStatus()` a
`lastResult?.session?.simVersion` lekérdezésen nem találja. A fallback
`liveReadiness?.summary?.simVersion`-on át működik a stale-result
invalidation, csak a hierarchia első ága dead.

**E. Live entry-fill nem tükrözi a valós fill price-t** — `handleBuyLifecycle`
live ágában a `shares: buyOrder.size / buyOrder.price` a placement
price-t használja, nem a tényleges fill price-t. Ha a CLOB jobb áron
filled, a session state alulbecsüli a shares-t. Live módban kell `client.
getOrder(orderId)`-t hívni fill után.

**F. Momentum signal degenerated** — a `signal-combiner` getMomentumSignal
a "past price" referenciát ugyanazon slug `?slug=` lekéréssel veszi → ugyanazt
az aktuális ár-t kapja vissza. A `Math.abs(currentMid - pastPrice) < 0.001`
branch elsül és "distance proxy"-t használ (eltávolodás 0.5-től). A momentum
signal effektíven a market polaritását méri, nem momentum-ot.

## Validated paths (zöld)

- **Csak piaci adat alapú döntés**: a 8 signal mind real source — Gamma
  `/markets`, CLOB `/book` és `/midpoint`, Data API `/trades`, Binance
  funding, Bybit funding, Coingecko/CryptoCompare BTC OHLC. Nincs synthetic
  / sim adat a signal layer-ben.
- **Paper-vs-live parity (simV3 garantia)**: paper PnL == live PnL lett volna,
  mert mindkettő ugyanazon a `outcomePrices` ∈ {0,1} settlement-en zár. A
  `paper-resolver.mts` a `&closed=true` Gamma query-vel csak resolved
  market-eken zár; nincs simulator path.
- **Kelly conviction gate** (2026-05-10 c) működik: ha `signal.kelly.quarter
  = 0`, a #7 gate skip-elteti a trade-et — nincs többé $1-os floor pozíció.
- **simVersion auto-archive**: v2 sessionök (143 fake trade) első cron tickkor
  v3-ra íródnak a `auto-trader-session-archive-paper-v2` Blobs key-be, a fő
  session blob fresh inittel folytatódik.

## Új doksi

`internal-docs/math/13-crypto-bot.md` — 12 szekciós teljes implementáció
referencia:

1. Bot célja és stratégia (venue / cron / side / strategy)
2. Futási pipeline (ASCII flow diagram)
3. Market-finder (Gamma `tag_id=21` query, filterek, `openedAtEstimate`)
4. Decision engine (8 ordered gate, math: edge / direction / Kelly / entry price)
5. Signal aggregator (combiner primary path + 5-signal fallback + OB enrichment)
6. Position open + paper-resolver (real Polymarket settlement, no simulator)
7. Paper vs live invariants (mátrix, hol szándékos a divergencia)
8. Konfigurációs forrás-precedencia (env defaults + Settings overrides + live-readiness)
9. **Ismert limitációk és technikai debt** — 6 finding (A-F fent)
10. Paper-mode validációs protokoll (24-48h sanity checks)
11. Hivatkozott modulok (file → szerep map)
12. Kapcsolódó dokumentumok (cross-link math/, app/, changelog/)

A cél: amikor egy új session kérdést tesz fel hogy "mit használ a crypto
bot most és hogyan", elég ezt a fájlt elolvasni — nem a 8 forrásfájlt
végigtúrni.

`internal-docs/README.md` math/ tábla bővítve egy sorral.

## Hova nyúlj legközelebb (a 6 audit finding sorrendben)

1. **§9.A live exit code** — ez a legfontosabb. A live mode-ot bekapcsolni
   addig nem szabad, amíg ez nincs implementálva. Mintaként a HL
   `position-monitor` és a paper-resolver kombóját lehet használni.
2. **§9.C SignalBreakdown shape** — 8 mezőre kibővíteni hogy a UI helyesen
   mutassa az active signals-t.
3. **§9.F Momentum signal** — vagy javítani (Gamma `events?slug=...&order=startDate`-tal
   N órával ezelőtti snapshot), vagy ki venni a kombinátorból.
4. **§9.B Cron source label** — `netlify.toml`-ban `path = "/auto-trader?source=cron"`
   beállítás, vagy header detection.
5. **§9.D session simVersion** — 1 sor add-on a `sessionSummary`-be.
6. **§9.E live fill price** — `client.getOrder(orderId)` hívás a buy-lifecycle
   live ágban; csak akkor érdekes, ha §9.A meg van oldva és tényleg élesedik.

---

## 2026-05-10 (d) — HomePage Aggregated session: aktív trade-ek láthatóvá téve

**Probléma.** A főoldali "Aggregated session" szekció a 3. stat kártyán
csak a `closedTrades` számot mutatta nagy fontban; a nyitott pozíciók
csak halvány sub-line-ban szerepeltek (`"X nyitott"`). A per-category
breakdown sorok pedig egyáltalán nem írták ki a nyitott trade-eket
(csak `9 trade`).

**Fix** (`src/components/HomePage.tsx`, csak 1 fájl):

1. **Stat #3 ("Closed trades" → "Trades (closed · open)").** Két szám
   egymás mellett, középen szürke `·` separátor. Az open szám
   `var(--accent2)` (kék) glow-val, ha > 0; muted szürke, ha 0. A sub
   sor mostantól `"X lezárt + Y aktív"`.
2. **Per-category breakdown row.** A trades column eddig `9 trade`
   volt, most `9 closed · 3 open`. Az open része accent-bold, ha > 0.
3. **CapCard mini-stats** (per-bot kártya alja). Eddig `9 trade`, most
   `9c · 3o` kompakt formában; az `o` rész accent-bold, ha > 0.

**Komponens változás.** A `Stat` value paramétere kibővült
`string | ReactNode`-ra, hogy az inline split-layout (3 span egy
flexbox-ban) renderelhető legyen. Egyetlen call site használja
ki — minden más Stat továbbra is sima stringet ad át.

**Backend változás: nincs.** A `multi-status.mts` payload már
tartalmazta az `openPositions` mezőt mind a per-category snapshotokon
(L74, L93, L112, L126), mind a `totals` aggregátban (L171). A bug
pusztán prezentációs probléma volt: a UI a meglévő mezőt nem mutatta
ki elég prominensen.

**CSS hozzáadások** (`hp-stat-split`, `hp-stat-closed`, `hp-stat-divider`,
`hp-stat-open` + `.active` variant; `hp-bd-open` + `.active`;
`hp-card-open` + `.active`). Csak új osztályok, létező osztály nem
módosult.

**Hatás.** A főoldal mostantól first-glance mutatja, hogy a 4 bot
összesen hány trade-et zárt és hány van még nyitva. A nyitott trade-ek
zöld helyett kék (accent2) színt kapnak, hogy vizuálisan elváljanak a
profit/loss zöld/piros kódolástól.

---

# 2026-05-10 (e) — Unified "Why?" panel: weather + HL + funding-arb is megkapja

## A kontextus

A "(c)" CHANGELOG entry-ben a crypto bot kapott egy frozen entry-decision
snapshot-ot a nyitott pozíciókra: expandable "Why?" panel a tézis-mondattal,
gross/net edge grid-del, signal-bontással és gate-listával. A weather, HL
perp és funding-arb botok ezt akkor még nem kapták meg — a "Why?" toggle
helyett egyszerű sor látszott a nyitott pozíciókon.

A felhasználó most kérte a teljes egységesítést: **minden bot oldalán
ugyanaz a "Why?" panel jelenjen meg**.

## Audit (a fix előtt)

| Bot         | EntryDecisionSnapshot | UI rationale | Hiányzó           |
|-------------|----------------------|--------------|-------------------|
| Crypto      | ✓ van                | ✓ wired      | —                 |
| Weather     | ✗ hiányzik           | ✗ hiányzik   | mindkét oldal     |
| HL Perp     | ✗ csak edgeAtEntry   | ✗ nem rendel | snapshot + UI     |
| Funding-Arb | ✗ csak spreadEntry   | ✗ nem rendel | snapshot + UI     |

## A megoldás

### 1. `EntryDecisionSnapshot` flavor diszkriminátor

`shared/types.mts:78-117` — új `flavor: "prob" | "spread"` mező +
opcionális `entryPriceLabel` / `marketPriceLabel` / `spreadAnnualizedPct`
/ `openInterestUSD` mezők.

A "prob" flavor (default, backward compat) a crypto/weather/HL prob-mode
térrel kompatibilis: model finalProb vs. market price → bot
YES/NO/LONG/SHORT-ot vett. A "spread" flavor a funding-arb spread-mode-
ját kezeli: HL hourly funding vs. Binance hourly funding → spread.

### 2. Weather entry-decision

`weather/decision-engine.mts` — minden gate egy `DecisionGate` rekordba
kerül (5 gate: confidence, exitBefore, model boundary, edge, sanity cap),
új `kellyRaw / kellyCapped / kellyCap / grossEdge / netEdge` mezők a
`WeatherTradeDecision`-ön.

`weather/index.mts` — felépíti az `EntryDecisionSnapshot`-ot a position-
höz "prob" flavor-rel. signalBreakdown null (forecast-driven, nem signal-
aggregated), obImbalance null, activeSignals 0 — az UI ezeket
automatikusan elrejti.

`auto-trader/index.mts` `getWeatherOpenActive()` — `entryDecision: p.
entryDecision ?? null` mező hozzáadva az openDetails minden sorához.

`WeatherTrader.tsx` — `OpenPositionRationale` import + `entryDecision:
OpenPositionRationale | null` az openDetails típusban + `rationale: p.
entryDecision ?? null` minden OpenPositionRow-on.

### 3. HL Perp entry-decision

`hyperliquid/types.mts` — új `entryDecision?: EntryDecisionSnapshot`
mező a `HlPosition`-ön.

`hyperliquid/order-manager.mts` — `placeHlEntry` paraméter bővítve
(`entryDecision`), paper + live ágon is mentődik.

`hyperliquid/index.mts` — minden gate egy DecisionGate-be (8 gate:
session loss, max positions, consecutive losses, coin cooldown, active
signals, resolution risk, net edge, size). Snapshot:
- `signal.finalProb` és `signal.marketPrice` közvetlenül használódik
- `direction: "LONG" | "SHORT"` (HL natív iránya, nem "YES"/"NO" mapping)
- `entryPriceLabel: "$108,432.50"` — HL coin USD ár, nem 0..1 prob
- Minden gate "passed: true" mert sikeres trade-en vagyunk

`HyperliquidTrader.tsx` — ugyanaz a UI wiring, mint a weather-en.

### 4. Funding-Arb spread-flavor entry-decision

`funding-arb/types.mts` — új `entryDecision?: EntryDecisionSnapshot` az
`ArbPosition`-ön.

`funding-arb/fr-executor.mts` — `openArbPosition` 4. param `entryDecision`,
mentődik a position-on.

`funding-arb/index.mts` — felépíti a spread-flavor snapshot-ot:
- `flavor: "spread"`, `direction: "SHORT"` (HL leg)
- `finalProb: opp.hlFundingHourly` (amit kapunk)
- `marketPrice: opp.binanceFundingHourly` (a benchmark, nem cost)
- `grossEdge: opp.spread`, `netEdge: spread − fees`
- `kellyCap: maxCapitalPct`, kellyRaw/kellyCapped a méret-fraction
- `entryPriceLabel: "$108,432" (HL markPrice)`, `marketPriceLabel:
  "0.0028%/h"`
- 5 gate: spread ≥ küszöb, OI ≥ küszöb, per-coin uniqueness, position
  count ≤ max, capital cap

`FundingArbPanel.tsx` — ugyanaz a UI wiring.

### 5. UI: `RationaleBlock` flavor-aware rendering

`shared/TraderResults.tsx` (`RationaleBlock`):

**Tézis-line:**
- "prob" flavor: "A modell szerint a YES esélye X%, a piac Y%-ot árazott
  → bot YES/NO/LONG/SHORT-t vett @W¢ vagy @$X, $V-ért."
- "spread" flavor: "HL X%/h funding-ot fizet, a Binance Y%/h-t fogad →
  spread Z%/h (N%/yr ann.) → bot SHORT HL + LONG Binance, $V-ért
  @$markPrice."

**4-cellás grid:**
- "prob" flavor: Gross edge / Net edge / Kelly raw → capped / Aktív
  signal-ok
- "spread" flavor: Spread (h) / Net spread (− fees) / Capital % bankroll
  · cap / OI

**Signal-bontás szekció**: csak prob-flavor-on jelenik meg.

**Gate-list**: mindkét flavor-on ugyanazzal a pass/fail vizualizációval.

**Meta sor (decided + reason)**: mindkét flavor-on ugyanaz.

## Mit lát a felhasználó a deploy után

### Weather
A `/trade/weather/` Tab 1 nyitott pozícióin most "Why?" toggle: tézis-
line a forecast vs. piac probabilitással, edge grid, gate-lista (5 gate
zöld pipával), reason. signalBreakdown szekció elrejtve (weather forecast-
driven, nem aggregált).

### HL Perp
A `/trade/hyperliquid/` Tab 1 perp pozícióin "Why?" toggle: ugyanaz a
struktúra, mint cryptón, USD entry price label-lel ("$108,432"), 8
zöld gate-tel, és a HL signal-bontással (FR/VPIN/VOL/APEX/CP).

### Funding-Arb
A `/trade/funding-arb/` Tab 1 arb pozícióin "Why?" toggle: spread-flavor
tézis ("HL X%/h fizet, Binance Y%/h fogad → spread Z%/h ann."), spread-
specifikus grid (Spread/Net spread/Capital % bankroll/OI), 5 zöld gate.

A 4 bot Tab 1 most már **vizuálisan és funkcionálisan teljesen egységes**:
ugyanaz az `OpenPositionsCard` + `RationaleBlock`, ugyanaz a "Why?"
expand mintázat, ugyanaz a gate-list shape.

## Mit nem változtattam

- A már nyitott pozíciók **legacy** (entryDecision nélküliek): a UI a
  `null` rationale esetén "Adat nem elérhető" placeholder-t rajzol.
  Új pozíciók már teljes panellel nyílnak.
- HL `decision-engine.mts` — gate-eket inline építem az index.mts-ben a
  sikeres trade-en (mind passed:true). Az engine maga nem ad vissza
  gates listát, de erre most nincs is szükség (failed scan-eken
  ScanResultsCard-ban már látszik a reason).
- `signalBreakdown` rendering csak prob-flavor-on van — funding-arb
  flavor-on automatikusan rejtve.

## Files

```
netlify/functions/auto-trader/shared/types.mts                          +flavor diszkriminátor + spread mezők
netlify/functions/auto-trader/weather/decision-engine.mts               gates[] + kelly/edge mezők
netlify/functions/auto-trader/weather/index.mts                         entryDecision build + position attach
netlify/functions/auto-trader/index.mts                                 getWeatherOpenActive: +entryDecision
netlify/functions/auto-trader/hyperliquid/types.mts                     HlPosition.entryDecision
netlify/functions/auto-trader/hyperliquid/order-manager.mts             placeHlEntry: +entryDecision param
netlify/functions/auto-trader/hyperliquid/index.mts                     inline 8 gates + snapshot build
netlify/functions/auto-trader/hyperliquid/funding-arb/types.mts         ArbPosition.entryDecision
netlify/functions/auto-trader/hyperliquid/funding-arb/fr-executor.mts   openArbPosition: +entryDecision param
netlify/functions/auto-trader/hyperliquid/funding-arb/index.mts         spread-flavor snapshot build
src/components/shared/TraderResults.tsx                                 +flavor-aware RationaleBlock
src/components/trader/WeatherTrader.tsx                                 rationale wiring
src/components/trader/HyperliquidTrader.tsx                             rationale wiring
src/components/trader/FundingArbPanel.tsx                               rationale wiring
```

---

# 2026-05-10 (d) — Weather bot: 3 kritikus settlement/execution bug javítva

## Audit

Az `internal-docs/math/weather/README.md` audit 3 kritikus + 4 figyelendő
hibát tárt fel a weather pipeline-ban. Ez a patch a 3 kritikust javítja:

### 13.1 — Bucket conditionId mismatch (mis-settlement)

**Bug.** A `WeatherMarket.conditionId = evt.markets?.[0]?.conditionId`
mindig a sub-market #0 id-ját mentette. A reconciler ezt a (rossz) id-t
kérdezte le minden bucket-re. Empirikus bizonyíték: a Hong Kong May-10
event 6 buckete 6 különböző conditionId-vel rendelkezik.

Következmény (paper mód): a nem-#0 bucket-en nyitott YES bet mindig
"loss"-ként, NO bet mindig "win"-ként könyvelődött, függetlenül a tényleges
kimeneteltől.

**Fix.** A `TemperatureBucket` típus kapott egy `conditionId: string`
mezőt; a `parseBucketsFromEvent()` `m.conditionId`-ből tölti minden
sub-marketnek. A `weather/index.mts:position.conditionId` mostantól
`match.bucket.conditionId`-ból jön.

### 13.2 — NO direction-höz nincs tokenId

**Bug.** `toMarketInfo()` `clobTokenIds: [tokenId, ""]`-t adott — csak
a YES tokenId, a NO oldali üres. NO irányú bet esetén a CLOB üres
tokenId-vel ment volna élesben (REJECTED), paper módban silently
"FILLED" hamis tokenId-vel.

**Fix.** A `TemperatureBucket` kapott egy `noTokenId: string` mezőt
(`clobIds[1]`). `toMarketInfo()` mostantól `[bucket.tokenId,
bucket.noTokenId]`-t ad át. A `position.tokenId` is direction-correct:
YES → `bucket.tokenId`, NO → `bucket.noTokenId`.

### 13.3 — `negRisk: false` flag a CLOB hívásban

**Bug.** Weather event-ek negRisk csoportok, de a `crypto/execution.mts`
hard-coded `negRisk: false`-szal hívta a CLOB-ot. Routing-hiba élesben.

**Fix.** `placeBuyOrder()` kapott egy `isNegRisk: boolean = false`
opcionális paramétert. Weather hívás `true`-val megy. Crypto változatlan.

## Hatás

- **Paper PnL mostantól helyes**: a Polymarket-resolution útvonal a
  matched bucket valós kimenetét adja vissza, nem az #0 bucket-ét.
- **Live mód unblocking**: NO direction trade-ek nem REJECTED-ek többé.
- **Élesedés még nem ajánlott**: a live-readiness gate `simVersionExpected:
  null` weather-en, és kalibráció jelenleg nincs (lásd 13.5 a math doc-ban).

A fix előtti paper closed trade-ek a buggy resolverrel keletkeztek; a
következő paper sessionben (manual reset után, ha akarod) tiszta adatra
számolódik majd a kalibráció.

## Érintett fájlok

```
netlify/functions/auto-trader/weather/market-finder.mts                 +conditionId, +noTokenId per bucket
netlify/functions/auto-trader/weather/index.mts                         toMarketInfo(market, bucket); position uses bucket.conditionId; +negRisk=true
netlify/functions/auto-trader/crypto/execution.mts                      placeBuyOrder: +isNegRisk=false param
internal-docs/math/weather/README.md                                    full math + audit doc (új fájl)
```

## Hova nyúlj legközelebb (weather)

- **Manual reset** (Settings → Reset session, "RESET" begépelés). A buggy
  resolverrel keletkezett régi closed trade-ek archiválódnak, és a
  következő cron tick után a fix-elt resolution lép életbe.
- **13.4 év-defaulting**: a `parseDateFromSlug` cross-year boundary-n
  silently dropolja a "january-3" (év nélkül) slug-okat decemberben.
- **13.5 σ kalibráció**: a Gauss σ (1.0 / 1.5°C) nem mért, hanem hardcoded.
  Per-város residual-rolling-window kellene a DEB mintájára.
- **13.6 simVersion gate**: weather-en `simVersionExpected: null`. Ha a
  paper-resolution semantikája megint változik, az old trade-ek nem
  archiválódnak automatikusan.
- **13.7 DEB feedback Polymarket settle-ből**: a Polymarket settled
  trade-eknél is futtassuk a `fetchMetarDailyMax()`-t **csak a DEB
  sample-höz** (PnL-t a Polymarket adja).

