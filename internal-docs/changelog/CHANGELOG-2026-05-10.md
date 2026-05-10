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
