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



---

# 2026-05-10 (e) — Audit fixes: 6 finding implementálva

A (d) szekcióban dokumentált 6 audit-finding mostantól mind javítva,
`tsc --noEmit` zöld.

## Fix #D — `sessionSummary.simVersion`

`auto-trader/index.mts:sessionSummary` mostantól `simVersion: s.simVersion ?? null`-t
is visszaad. A `getCryptoRunStatus` stale-result invalidation elsődleges path-on
(a `liveReadiness?.summary?.simVersion` fallback is működik tovább).

## Fix #C — `SignalBreakdown` 5 → 8 mező

`shared/types.mts:SignalBreakdown` kibővítve `momentum / contrarian / pairs_spread`
mezőkkel. Az alábbi consumer-ek mind frissítve:

- `crypto/signal-aggregator.mts:extractBreakdown` — combiner primary path
  mostantól mind a 8 mezőt extracteli.
- `crypto/signal-aggregator.mts:fetchIndividualSignals` — fallback path csak
  az 5 régi signal-t tudja, a 3 új null marad (IC weight 0).
- `auto-trader/index.mts:formatSignalArrows` — Telegram alert FR/VPIN/VOL/
  APEX/CP/MOM/CTR/PRS nyilakkal.
- `edge-tracker/statistics.mts:SIGNAL_NAMES` — IC computation mind a 8
  jelzésre.
- `edge-tracker/mock-trades.mts:makeSignalBreakdown` — mock generator.
- `src/components/shared/TraderResults.tsx:SIGNAL_LABELS` — UI signal-arrow
  row.
- `src/components/trader/CryptoTrader.tsx:SIGNAL_ORDER` — crypto trader
  panel.

HL `signal-source.mts` már korábban populated mind a 8 mezőt; most a típus
is matchel any-cast-ok nélkül.

## Fix #B — Cron source label detection

`auto-trader/index.mts` body parser mostantól ellenőrzi a Netlify scheduled
function payload jellemző mezőjét (`body.next_run`). Ha jelen →
`isScheduledTick=true` → source override "cron"-ra a crypto/HL/weather
branchen is. Az auto-trader-multi-cron `?source=cron` query-je tovább
működik (legacy path), és a body-parsert nem zavarja.

UI hatás: a `/trade/crypto/` status pill ezentúl helyesen "Scanning… (cron)"-t
mutat a `*/3 min` cron tickeken.

## Fix #E — Live fill price from getOrder

Új `execution.mts:fetchOrderFillDetail(orderId)` helper, ami a CLOB `getOrder`
response-ban defensive-ul olvassa ki a `size_matched` és `price` mezőket
(több spelling: `size_matched | sizeMatched | executedSize | filledSize`).

`order-lifecycle.mts:handleBuyLifecycle` live FILLED ágban mostantól ezt
hívja, és:

```
const fillUsdc = detail?.filledUsdc ?? buyOrder.size;
const fillPx   = detail?.fillPrice  ?? buyOrder.price;
const shares   = fillUsdc / fillPx;
```

Fallback a placement értékekre ha az API hiányos. Partial fill mostantól
pontos session state-et eredményez.

Log `ORDER_FILLED` kibővítve `fillPrice`, `filledUsdc`, `usedDetail` mezőkkel.

## Fix #F — Real momentum signal via Blobs snapshot

`signal-combiner.mts:getMomentumSignal` átírva. Új `momentum-snapshots`
Netlify Blobs store, kulcs `v1:<slug>`, value `{ ts, yes }`.

Minden hívás:
1. Lekér current YES midpoint (CLOB `/midpoint`).
2. Olvas snapshot.
3. Mindig ír új snapshot a current state-re.
4. Ha snapshot age `[60s, 1h]` ablakban van → real Rcum vs snapshot.
5. Ha túl friss vagy nincs anchor → neutral 0.5 (`anchor_too_fresh` /
   `no_anchor` source label).
6. Ha túl régi (>1h) → neutral 0.5 (`anchor_stale`), a frissen mentett
   snapshot a következő call-ra hasznos lesz.

A combiner 3 perc cache-vel + cron `*/3 min` rendszeresen ad új scan-eket,
így a momentum signal effektíven 3-15 perces look-back ablakot mér. Az IC
ezáltal érdemi (várható ~0.05-0.10 a Kakushadze 3.1 alapján).

## Fix #A — Live position resolver + TP/SL exit wiring (legkomplexebb)

**3 részből áll:**

### A.1 — `Position.clobTokenIds` mező

`shared/types.mts:Position` kibővítve opcionális `clobTokenIds: [string,
string]` mezővel. `runCryptoTrader` entry flow most ezt populálja a
`market.clobTokenIds`-ből.

Régebbi, fix előtti pozíciók placeholderré válnak: a live early-exit pass
áthugolja őket "missing clobTokenIds" reasonnel; a settlement-resolver
egyébként tudja zárni őket (csak conditionId kell).

### A.2 — `resolvePendingPositions` (paper + live)

`crypto/paper-resolver.mts` általánosítva:
- Régi név `resolvePendingPaperPositions` mint backwards-compat alias
  exportálva.
- Új név `resolvePendingPositions`.
- Eltűnt a `if (!session.paperMode) return early` guard.
- `closePosition` után log:
  ```
  PAPER_RESOLVED { mode: "paper"|"live", requiresRedeem: !paperMode }
  ```
  Live módban a `requiresRedeem: true` flag jelzi az operatornak, hogy
  futtassa a `/polymarket-redeem` end-pointot (CTF on-chain redemption).

`auto-trader/index.mts:runCryptoTrader` mostantól:
```
if (session.openPositions.length > 0) {
  const r = await resolvePendingPaperPositions(session);
  ...
}
```
(a `paperMode` guard eltűnt). Telegram alert `paperMode`-tól függetlenül
megy.

### A.3 — `runLiveEarlyExits` orchestrator

Új `crypto/live-price.mts:fetchYesMidpoint(yesTokenId)` helper. A
clob-client signed API-t **nem** használja (read-only `/midpoint`
endpoint), így nem igényel `POLY_PRIVATE_KEY`-t.

Új `auto-trader/index.mts:runLiveEarlyExits(session, btcExit)`:
1. Sortolja `openPositions`-t `endDate ASC`-ra.
2. Top 3-on (`LIVE_EXIT_BUDGET_PER_TICK`) iterál (Netlify timeout védelem).
3. Skip ha hiányzik `clobTokenIds`.
4. `fetchYesMidpoint(clobTokenIds[0])` → ha null skip.
5. Build minimal `MarketInfo` a clobTokenIds + endDate-tel.
6. `checkExitConditions(pos, minimalMarket, yesMid, now, btcExit)`:
   - Hold-to-end (≤60s endDate-ig) → `RESOLUTION_IMMINENT`, skip exit.
   - TP (positionPrice ≥ 0.75) → exit.
   - SL (positionPrice ≤ 0.35) → exit.
7. Ha `shouldExit` → `handleSellLifecycle(pos, market, exitPrice, paperMode=false)`:
   - Place GTC sell, 6 × 5s polling.
   - Timeout → `emergencySell` 10 × 100ms FOK retry.
8. Enrich resulting `ClosedTrade` predictedProb / marketPriceAtEntry /
   edgeAtEntry / signalBreakdown / category mezőkkel.
9. `closePosition(session, buyOrderId, enriched)` → session frissítve.
10. Telegram alert.

A `runCryptoTrader` mostantól:
```
if (!config.paperMode && session.openPositions.length > 0) {
  const liveExitResults = await runLiveEarlyExits(session, btcExit);
  ...
}
```
Paper módban **kihagyva** (sim invariáns).

### Mit kapsz a fix után

| Eset | Pre-fix viselkedés | Post-fix viselkedés |
|------|---------------------|----------------------|
| Paper position settles → outcome 1.0 | closePosition (paper-resolver) | ugyanaz |
| Live position settles → outcome 1.0 | örökre nyitva, USDC nem visszanyerhető bot oldalról | closePosition (paper-resolver) + log requiresRedeem flag |
| Live position TP-hit (positionPrice ≥ 0.75) | semmi (dead code) | runLiveEarlyExits → handleSellLifecycle GTC sell |
| Live position SL-hit (positionPrice ≤ 0.35) | semmi | ugyanaz mint TP |
| Live position 30s endDate-ig | semmi | hold-to-end skip, settlement-resolver fogja zárni |
| Paper position TP/SL price-on | semmi (szándékos sim invariáns) | ugyanaz (továbbra is szándékos) |

## Mit kell még tudni a deploy után

- A live mode **most már funkcionálisan teljes** — de a `live-readiness`
  gate továbbra is szigorú default thresholds-szal véd. Csak akkor enged
  átállítani a `PAPER_MODE=false`-ra, ha 30+ paper trade IC ≥ 5% és
  Sharpe ≥ 0.5.
- **On-chain redemption manuális marad** — `PAPER_RESOLVED.requiresRedeem:
  true` log-bejegyzés és Telegram alert a jelzés. Ha akarod, jövőbeli
  fix: cron-on auto-redeem.
- **Cooldown map in-memory** — minor known limitation, nem fixelt. Lásd
  §9 maradó limitációk.

## Új detailed runtime walkthrough a 13-crypto-bot.md-ben

A user kérésére `internal-docs/math/13-crypto-bot.md` új §2.1 szekciót
kapott: **Részletes runtime walkthrough (egy teljes cron tick)** —
13-lépéses annotated trace amely végigmegy a `runCryptoTrader()` teljes
életciklusán Lépés 0 (cron trigger) → Lépés 13 (HTTP response).

Példa adatokkal: paper mode, $150 bankroll, 0 nyitott pozíció. Minden
lépésnél a tényleges Blobs key, kódbeli eredmény, log-bejegyzés, és UI
hatás. A végén tipikus latency budget tickenként (~3.3s paper, +33s/exit
live). 

A szekció sorrend: 1 → 2 → 2.1 (NEW) → 3 → ... → 12.

Érintett fájlok:
```
shared/types.mts                         (SignalBreakdown +3, Position +clobTokenIds)
auto-trader/index.mts                    (body.next_run, runLiveEarlyExits, sessionSummary.simVersion, formatSignalArrows +3, paper-resolver call paperMode-független, paperPosition.clobTokenIds, imports)
crypto/execution.mts                     (fetchOrderFillDetail)
crypto/order-lifecycle.mts               (handleBuyLifecycle real fill detail)
crypto/paper-resolver.mts                (resolvePendingPositions general, mode + requiresRedeem log, alias export)
crypto/signal-aggregator.mts             (extractBreakdown +3, fallback IC weights)
crypto/live-price.mts                    (NEW - fetchYesMidpoint)
signal-combiner.mts                      (getMomentumSignal Blobs snapshot)
edge-tracker/statistics.mts              (SIGNAL_NAMES +3)
edge-tracker/mock-trades.mts             (makeSignalBreakdown +3)
src/components/shared/TraderResults.tsx  (SignalBreakdown rationale type +3, SIGNAL_LABELS +3)
src/components/trader/CryptoTrader.tsx   (signalBreakdown type +3, SIGNAL_ORDER +3)
internal-docs/math/13-crypto-bot.md      (new §2.1 detailed runtime walkthrough, §9 fix history, §11 file map)
```

`tsc --noEmit` exit 0.

# 2026-05-10 (f) — HL bots full audit + paper/live parity fixes (sim v2)

## Mit auditáltam

A felhasználó kérésére a két Hyperliquid bot (directional perp + funding-arb)
end-to-end audit-ja: scan → signal → decision → entry → resolve. Összesen
9 finding (5 fix elvégezve, 4 dokumentálva).

A két új doksi `math/14-hl-directional.md` és `math/15-funding-arb.md` a
`math/13-crypto-bot.md` mintájára készült: §1 stratégia, §2 pipeline, §3
signal source, §4 gates, §5 sizing, §6 order placement, §7 paper resolver,
§8 session storage, §9 paper/live parity matrix, §10 limitációk, §11
validációs protokoll, §12 file map.

## HL Directional bot — 5 fix (2 critical + 1 major + 2 minor doc)

### 🔴 H1: TP/SL clamp (kelly-sizer.mts + types.mts + config.mts + order-manager.mts + index.mts)

A v1 sim a `signal.edge = |finalProb − 0.5| × 2` binary-prediction edge-et
**clamp nélkül** szorozta `2×`/`1×`-szel a perp price-target-távolsághoz.
Edge=0.20 esetén TP=+40%, SL=−20% — BTC-en a 4h hold-window-on belül soha
el nem érhető szintek. Eredmény: **minden trade `timeout` reason-nel
zárult**, ami megmutatkozott volna az IC=0 kalibráció-mérésen, de a paper
sessionnek még nem volt 30+ trade-je.

**Fix:**
```ts
tpPct = min(edge × 2, tpPctMax)   // default tpPctMax = 0.02 (2%)
slPct = min(edge × 1, slPctMax)   // default slPctMax = 0.01 (1%)
```

A clamp:
- Kis edge-ek (<1%) változatlan edge-multiplier scaling-et kapnak
- Nagy edge-ek a 2%/1% perp-realisztikus szinten saturálódnak
- 2:1 RR fennmarad amíg `tpPctMax = 2 × slPctMax`

Új env knob-ok: `HL_TP_PCT_MAX` (def 0.02), `HL_SL_PCT_MAX` (def 0.01).

### 🟠 H2: Vol gate paper parity (index.mts)

A v1 a `volatilityGate(coin, 120)`-at csak live módban hívta:

```ts
// before
if (!config.paperMode) {
  const volCheck = await volatilityGate(coin, config.volGateRvPct);
  if (!volCheck.pass) { results.push({skip}); continue; }
}
```

→ paper trade-elhetett 200% RV napokon át, live nem. **Paper PnL drift
a live-tól.** Most paper + live ugyanazt a gate-et látja. Ha a Binance
kline lekérés fail-el → `pass: true, reason: "vol data unavailable"`
(fail-open).

### 🟠 H3: Paper hourly funding accrual (paper-resolver.mts)

A v1 paper PnL `grossPnl − fees` képlettel számolt, de **nem könyvelte
a HL hourly funding-ot**. Live módban a HL automatikusan fizet/kap a
funding-ot minden órán. Persistent positive funding tape-en a longok
funding-ot fizetnek (eats into PnL), bear tape-en a shortok kapnak —
v1 paper egyiket sem reflektálta.

**Fix:** új `getHlFundingMap()` helper a `metaAndAssetCtxs.funding[i]`-ből,
és új `pnlOfClose` képlet:

```ts
entryNotional = sizeUSDC × leverage
exitNotional  = |sizeCoins| × exitPrice
avgNotional   = (entryNotional + exitNotional) / 2
fundingPaid   = avgNotional × hourlyFundingRate × holdHours
fundingPnl    = isLong ? −fundingPaid : +fundingPaid
pnlUSDC       = grossPnl − fees + fundingPnl
```

A midpoint notional approximáció exact rövid hold periódusra, és
néhány bp pontosságú hosszabb hold-on.

### simVersion v1 → v2 auto-archive (session-manager.mts + config.mts + types.mts)

A három paper-PnL semantic változás (TP/SL clamp + vol gate + funding
accrual) miatt új `HL_PAPER_SIM_VERSION = 2`. A `loadHlSession(paperMode)`:

1. Get raw → JSON parse → `parsed.simVersion ?? 1`
2. Ha `paperMode && persistedVer < 2` → archive `archive_paper_v1_${ts}`
   key-be, fresh session a `session_paper` key-be.
3. Az `summarize()` payloadbe is felkerült a `simVersion` mező, hogy a
   `getHlRunStatus()` invalidálni tudja a stale lastResult snapshot-ot
   (ugyanaz a pattern, mint a crypto bot 10. sessionben).

Live session SOHA nem auto-resetel.

## Funding-Arb bot — 2 fix (1 critical + 1 major)

### 🔴 F1: Mark-to-market funding accrual (fr-session.mts + index.mts)

A v1 `accrueFunding`:

```ts
const delta = p.sizeUSDC * hourlyRate * hours;   // FIXED entry sizeUSDC
```

Real HL funding **a position_size_in_coins × current_mark_price × rate**-en
fizet, NEM az entry-time dollar notional-on. BTC 5-10% drift mellett a
v1 modell 5-10% delta-t adott el a real PnL-hez képest.

**Fix:** új `AccrueSnapshot { rate, markPrice }` type, és új
`currentHlByCoin: Map<string, number | AccrueSnapshot>` polymorphic
signature (backwards-compat a régi rate-only Map-pel):

```ts
const notional = |pos.sizeCoins| × markPrice    // CURRENT
const delta    = notional × hourlyRate × hours
```

A `funding-arb/index.mts` most `hlSnapshotByCoin: Map<{rate, markPrice}>`
készít a `scanFundings()` outputjából, és az `accrueFunding`-be küldi.

### 🟠 F5: HL close slippage band 0.5% → 1.0% (fr-executor.mts)

A v1 close 0.5% slippage band-del (`closeRefPrice * 1.005` IOC limit). Ha
BTC a 3min cron-gap között 0.5%+-ot drift-elt, az IOC miss-t adott; a
következő tick re-attempt szintén miss-elt, és csak a `maxHoldDays`
safety net mentett ki. Aszimmetrikus design:

- **Entry:** továbbra is 0.5% (inkább miss mint overpay — ha a spread
  a ticken eltűnt, várható meg a következőt)
- **Close:** 1.0% (a leg-et BIZTOSAN exit-elni kell; a slippage cost
  elfogadható ár a guaranteed exit-ért)

## Open findings (dokumentálva, nem fixelve)

| ID | Sev | Probléma | Indok |
|----|-----|----------|-------|
| H4 | 🟡 | In-memory cooldown map cold-start veszteséges | Open-position gate fed le; low priority |
| H5 | 🟡 | maxLeverage silent clamp 3x-re | Konzervatív default; dokumentálva |
| §9.A | 🔴 | Live HL exit / fill / settlement reconciliation hiányzik | **Live-ra kapcsolni TILOS** amíg ez nem épül meg. Külön session task. |
| F2/F3 | 🟠 | Cross-venue execution non-atomic, slippage cost paper-ben nincs | Inherently — paper biased ~+1% upper bound. Dokumentálva. |
| F7 | 🟠 | Binance SELL `quantity.toFixed(5)` per-pair lot precision | Élesedés előtt fix kell (per-symbol `LOT_SIZE.stepSize` lookup). |
| F8 | 🟡 | totalFundingToday string format fragile | Low priority |

## Hatás a deploy után

- Az első HL paper cron-tick után a v1 sessionnek lévő nyitott pozíciók
  archiválódnak az `archive_paper_v1_${ts}` key-be, és tiszta v2 session
  indul. **Nincs explicit reset szükséges.**
- A nyitott pozíciók TP/SL targetjei a v1-es 40%-os szintekkel mentődtek;
  a v2 archive-tól kezdve az új belépők +2%/-1%-os szinttel kapnak TP/SL-t,
  ami 4h horizonton elérhető és a paper PnL eloszlás reális lesz.
- Funding-arb session változatlan marad — a fix csak az accrual képletét
  érinti, nincs sim version bump.

## tsc

```bash
cd "C:/dev/trading-bot 2" && npx tsc --noEmit
# EXIT=0
```

## Érintett fájlok

```
netlify/functions/auto-trader/hyperliquid/
  ├── types.mts             (HlTraderConfig +tpPctMax/slPctMax/paperSimVersion, HlSessionState +simVersion?)
  ├── config.mts            (env knob-ok + HL_PAPER_SIM_VERSION export)
  ├── session-manager.mts   (loadHlSession auto-archive logika)
  ├── kelly-sizer.mts       (computeTpSl clamp args + Math.min)
  ├── order-manager.mts     (PlaceEntryInput tpPctMax/slPctMax pass-through)
  ├── index.mts             (vol gate paper parity, summarize +simVersion, placeHlEntry pass)
  ├── paper-resolver.mts    (getHlFundingMap helper, pnlOfClose +funding leg)
  ├── run-state.mts         (simVersion-based lastResult invalidation)
  └── funding-arb/
      ├── fr-session.mts    (accrueFunding mark-to-market + AccrueSnapshot type)
      ├── fr-executor.mts   (close slippage 0.5% → 1.0%)
      └── index.mts         (hlSnapshotByCoin Map<{rate, markPrice}>)

internal-docs/
  ├── math/14-hl-directional.md       (NEW — 12-szekciós implementation reference)
  ├── math/15-funding-arb.md          (NEW — 12-szekciós implementation reference)
  └── README.md                       (math/ tábla bővítve 2 sorral)
```


# 2026-05-10 (g) — HL bots: 6 maradt finding closeolva

A "(f)" szekció audit-jából hat finding maradt nyitva. Mind closeolva.

## §9.A — Live HL exit/reconcile (új `live-resolver.mts`)

Eddig ha a HL TP/SL fillelt élesben, a session blob soha nem frissült —
a következő cron tick `Already have open <COIN>` reason-nel blokkolt
örökre. Ez tette a live mode-ot teljesen használhatatlanná.

**Új modul** `live-resolver.mts`. Per cron tick:

1. `tryLoadLiveAdapter()` → `wallet.address` (új `getAddress()` az
   adapter interface-en).
2. `getClearinghouseState({user})` → open positions HL-en (asset
   positions[].position.coin set).
3. Set diff a `session.openPositions` ellen → eltűnt coin = closed.
4. `getUserFillsByTime(walletAddress, oldestOpenedAt)` → closing fillek.
5. Match by `oid`: `tpOrderId === f.oid` → `closeReason: "tp"`,
   `slOrderId === f.oid` → `"sl"`, egyébként `"manual"`.
6. Size-weighted average exit price + `closedPnl` sum → `HlClosedTrade`.

Edge cases: fill not visible yet → log + retry; adapter unavailable →
skip; clearinghouseState blip → skip.

A `runHyperliquidTraderInner` a tick elején most paper/live ágat fut:
- paper: `resolveOpenHlPaperPositions(...)` (markprice TP/SL crossing)
- live:  `resolveOpenHlLivePositions(...)` (HL fill matching)

Mindkét ág után ugyanaz a post-close housekeeping (consec-loss pause,
session loss limit).

## F7 — Binance lot precision per symbol (`hedge-manager.mts`)

`exchangeInfo` cache (6h TTL) a `BINANCE_SPOT_SYMBOL` symbolok-ra. Új
`roundToStep(qty, sym)` minden SELL-en. SOL (stepSize 0.01) / AVAX (0.01)
/ DOGE (1) most korrekt precíziójú quantity-vel megy.

Cache miss → SELL refuse `LOT_SIZE rule unknown for X` reason-nel
(NEM placeolja a hibás precíziójú order-t).

## H4 — Cooldown Blobs persistence (`decision-engine.mts`)

A cooldown map most kétréteg:
- In-memory cache (avoid round-trip every read)
- Blobs `hyperliquid-runtime / cooldowns-v1` key (durable)

`setCooldown()` async — mindkettőbe ír. `isOnCooldown()` async — memory
miss esetén Blobs reload (30s TTL). A `index.mts` for loop most
`await isOnCooldown(coin)`-t hív.

A `makeHlDecision` cooldown gate-je törölve — a callere már gate-eli a
loop tetején, és a sync-async refactor egyszerűbb a duplikáció
kivételével.

## F8 — totalFundingToday typed shape (`fr-session.mts` + `types.mts`)

`ArbSessionState.totalFundingToday: { date: string; amount: number }`
typed object. Régi `"YYYY-MM-DD:N"` blobok automatikusan migrálódnak
loadArbSession-ben (`migrateTodayShape` helper). `summarize()` nyitott
`.amount` mezőre + `.date` mezőre.

## H5 — Explicit warning maxLev clamp-en (`kelly-sizer.mts`)

Új `HL_LEVERAGE_HARD_CAP = 3` const. Ha `HL_MAX_LEVERAGE > 3`, a sizer
egyszer sessiononként `log("ERROR", ...)` warning-ot ír a clamp-ról:

```
{
  configWarning: "HL_MAX_LEVERAGE=5 clamped to 3x hard cap",
  hint: "Update HL_MAX_LEVERAGE to <=3 to silence this warning, ..."
}
```

A `leverageWarningSent` flag akadályozza meg a spam-et.

## F2/F3 — Paper slippage modelling

Paper PnL most reflektálja a live IOC-bands slippage-et:

**HL directional paper-resolver:**
- TP fill: exact `tpPrice` (Gtc maker limit fillel ott)
- SL fill: `slPrice × (1 ± 0.001)` (0.1% adverse — stop-market trigger)
- Timeout exit: `markPrice × (1 ± 0.0005)` (0.05% adverse — IOC close band)

**Funding-arb hedge-manager `paperFill`:**
- BUY: `markPrice × 1.0005` (0.05% adverse)
- SELL: `markPrice × 0.9995`

**Funding-arb fr-executor open + close:**
- HL SHORT entry paper: `markPrice × 0.995` (mátchel a live IOC band-del)
- HL close paper-only cost line: `pos.sizeUSDC × 0.016` (1.6% total
  roundtrip slippage: 0.5% HL entry + 1.0% HL close + 0.1% Binance)

Healthy carry condition: `hourly_spread × hold_hours > 1.89%`
(slippage 1.6% + fees 0.29%).

## tsc

```bash
cd "C:/dev/trading-bot 2" && npx tsc --noEmit
# EXIT=0
```

## Érintett fájlok

```
netlify/functions/auto-trader/hyperliquid/
  ├── hl-client.mts                (HlExecutionAdapter.getAddress, getUserFillsByTime, HlFill type)
  ├── live-resolver.mts            (NEW — live fill reconciliation)
  ├── decision-engine.mts          (Blobs cooldown, async setCooldown/isOnCooldown)
  ├── kelly-sizer.mts              (HL_LEVERAGE_HARD_CAP + warning log)
  ├── paper-resolver.mts           (SL_SLIPPAGE 0.1% + TIMEOUT_SLIPPAGE 0.05%)
  ├── index.mts                    (paper/live resolver branch, async isOnCooldown/setCooldown)
  └── funding-arb/
      ├── types.mts                (totalFundingToday typed)
      ├── fr-session.mts           (migrateTodayShape, typed accrue + fresh)
      ├── fr-executor.mts          (HL paper entry slippage, paperSlippage cost line)
      ├── hedge-manager.mts        (exchangeInfo cache + roundToStep + paperFill slippage)
      └── index.mts                (typed totalFundingToday in summarize)

internal-docs/
  ├── math/14-hl-directional.md    ($§10 + §10.1 (§9.A) frissítés, §12 file map)
  └── math/15-funding-arb.md       ($§10 + §10.1 (F2/F3/F7/F8) frissítés)
```

## Nyitott kérdések most

A directional bot-ban egyetlen open finding maradt:

- **§9.B** (🟡): TP leg failure paper-ben silent (live-ban entry+SL marad).
  Order-manager logic — `placeHlEntry`-ben a TP fail-re entry+SL nem
  cancel-elődik. Élesedés előtt fix kell, low priority addig.

A funding-arb bot-ban minden finding closeolva.


# 2026-05-10 (h) — §9.B closed: TP leg fail rollback

A "(g)" után egyetlen finding maradt nyitva: §9.B (`placeHlEntry`-ben a TP
leg failure-re entry+SL nem cancel-elődik, tükrözve az SL fail meglévő
rollback-jét).

**Fix** (`order-manager.mts`):

```ts
// 2. Take-profit
const tp = await adapter.placeOrder({ ... });
if (!tp.ok) {
  await adapter.cancelOrder(p.coin, entry.orderId).catch(() => {});
  return { ok: false, error: `TP placement failed — entry cancelled. ...` };
}

// 3. Stop-loss
const sl = await adapter.placeOrder({ ... });
if (!sl.ok) {
  await adapter.cancelOrder(p.coin, entry.orderId).catch(() => {});
  if (tp.orderId) await adapter.cancelOrder(p.coin, tp.orderId).catch(() => {});
  return { ok: false, error: `SL placement failed — entry cancelled. ...` };
}
```

A `tpOrderId` ternary egyszerűsítve: mivel TP fail mostantól bail előtte,
a `tp.ok` mindig true a position record-építésnél.

`internal-docs/math/14-hl-directional.md` §10 + §5 (Lev hard cap warning)
frissítve.

`tsc --noEmit` exit 0.

## Audit-state

A 16. session 9 finding-jéből most **mind closeolva**:

| Bot | ✅ |
|-----|----|
| HL Directional | H1, H2, H3, H4, H5, §9.A, F2/F3, §9.B |
| Funding-Arb | F1, F5, F2/F3, F7, F8 |


# 2026-05-10 (h) — Auto-Trader: egységes "X/Y gates" chip minden bot scan-rétegén

## Mit kért a felhasználó

A 4 bot scan-listájában (Crypto / Weather / HL Perp / Funding-Arb) eddig
két különböző mintát használtunk a gate-vizibilitásra:

- **Crypto + Weather**: a `cryptoEntryCriteria` / `weatherEntryCriteria`
  frontend mapper a row data + display.config alapján épített gate-listát,
  és a `<CriteriaSummary>` chip ("X/Y gates ✓") + hover popover működött
  minden soron.
- **HL + Funding-Arb**: a `hlEntryCriteria(r, undefined)` /
  `arbEntryCriteria(r, undefined)` hívás `cfg=undefined`-del jött, ezért
  a mapper üres tömböt adott vissza → **a chip soha nem jelent meg**.

A user kifejezetten kérte, hogy "minden bot-nál a scanned részen a
lehetséges trade-knél minddnél egységesen látszódjon, hogy hányból hány
gaten megy van nem ment át. ugyanúgy hooverrel, mint a weather éles
trade-nél". Egységes UI a 4 boton.

## Tervezés

Két architektúra-alternatíva:

- **A**: Backend ship-eli a per-row gate listát minden scan eredményen
  (HL + F-Arb új field: `r.gates: DecisionGate[]`).
- **B**: Frontend mapper kiterjesztése — backend külön shippeli a
  szükséges field-eket (`signal.edge`, `signal.activeSignals`, ...) minden
  skip soron, és a `hlEntryCriteria` / `arbEntryCriteria` ez alapján
  építi a listát.

A választás **A**: a HL/F-Arb decision-engine-ek pontosan tudják melyik
gate bukott el elsőre (short-circuit pattern), és a session-state +
config közvetlenül elérhető backend-en. Frontend-re shippelve duplikálnánk
a gate definíciókat. Crypto/Weather is **változatlanul marad**, mert a
frontend mapper-jeik már megfelelően működnek a row data-ból.

## Backend változások

### `auto-trader/hyperliquid/index.mts`

Per-coin scan loop kibővítve egy 12-elemes ordered gate listával:

1. Coin cooldown · 2. Signal forrás · 3. Volatility (RV) ≤ küszöb
4. Session loss < limit · 5. Open pozíciók < max · 6. Consecutive losses < limit
7. Coin nincs már nyitva · 8. Aktív signal források ≥ 3 · 9. Resolution risk ≠ SKIP
10. Net edge ≥ küszöb · 11. HL price elérhető · 12. Méret > 0

Minden gate **független evaluation** (nem short-circuit, mert a UI-nak
pontos pass/fail kell minden gate-en). A `makeHlDecision` továbbra is
short-circuit a tényleges trade-döntéshez, csak a gate-evaluation fut
mellette párhuzamosan.

Egy `snapGates()` helper minden `results.push()`-on egy padded snapshot-ot
csinál: a már kiértékelt gate-ek pontos pass/fail-jét szállítja, a még
ki-nem-értékelt gate-eket `passed: false, actual: "not evaluated"` mező-
értékkel tölti, hogy az Y érték (összes gate) **stabil legyen** minden
soron. Az operator szempontjából: 12/12 az ideális; 9/12 ⇒ 3 gate bukott
vagy nem futott le.

Skip soron most extra mezők is jönnek (ahol elérhetők):
`direction`, `edge` (net), `predictedProb`, `marketPrice` — így a
`ScanResultRow` chips-ek (model %, edge %, YES/NO chip) skip soron is
megjelennek, nem csak a `position_opened` soron.

### `auto-trader/hyperliquid/funding-arb/index.mts`

A loop átírva — eddig csak a viable+open-eligible coinok kerültek a
`results[]`-be, ezentúl **minden ARB_COIN egy sort kap** a teljes gate
listával:

1. Spread ≥ küszöb · 2. Break-even hold ≤ max · 3. Open interest ≥ küszöb
4. Per-coin uniqueness · 5. Pozíció szám < max · 6. Capital cap (sizing)

Egy coin akkor is megjelenik a scan-listában, ha az `arb-detector`
`isViable: false`-t adott vissza (pl. spread túl alacsony) — eddig ezeket
csak a `OpportunitiesCard` mutatta. Ennek köszönhetően a "Last Run" card
most végre a teljes scan-state-et tükrözi, gate-ekkel.

## Frontend változások

### `shared/TraderResults.tsx`

- `CriteriaGate.actual` és `CriteriaGate.required` mostantól **opcionális** —
  szinkronban a backend `DecisionGate` shape-jével (egyes "not evaluated"
  gate-ek üresen jönnek). Render side-on `?? "—"` / `?? ""` fallback.
- `CriteriaSummary` chip új trail formátum: ha nem all-pass, "X/Y gates · N✗"
  expliciten kiírja a bukott gate-ek számát (eddig csak "—" volt). Popover
  header is mutatja: "Belépési kritériumok • X / Y teljesült · N bukás".

### `trader/HyperliquidTrader.tsx` + `trader/FundingArbPanel.tsx`

Mindkét panel első helyen ellenőrzi a backend `r.gates` mezőt:

```typescript
const criteria: CriteriaGate[] = Array.isArray(r.gates) && r.gates.length > 0
  ? (r.gates as CriteriaGate[])
  : hlEntryCriteria(r, undefined);  // legacy fallback
```

Régi deploy-ok (gates nélküli payload) továbbra is renderlik a frontend
mapper-ből, csak üresen — fallback szerep.

F-Arb panel chip set bővítve: `OI $XXM` chip + `spreadAnnualized` tone-os
színkódolása (≥30%/yr zöld, ≥5%/yr narancs, alatta piros).

## Hatás a deploy után

- **Crypto + Weather**: változatlan viselkedés (frontend mapper marad).
- **HL Perp**: minden 3 scan-elt coin (BTC/ETH/SOL) sora kap egy "X/12 gates"
  chipet, hover-en a teljes pre-flight checklist `actual` és `required`
  oszloppal. Cooldown-os coin: `0/12 ✓` chip + popover első sora ✗ Coin
  cooldown.
- **Funding-Arb**: minden 5 scan-elt coin (BTC/ETH/SOL/XRP/AVAX) sor egy
  "X/6 gates" chippel. Spread<küszöb mind az 5 coinon ⇒ "0/6" chipek a
  hover-en a pontos spread × required threshold-dal.

## Mit nem változtattam

- A 4 bot Tab 1 stat grid + control row + Reset/Export gomb stb. — nem
  érintve.
- A scan-row inline blocker-line (✗ first failed gate) marad — a chip
  összegez, a blocker-line "elrontás-fókuszú".
- A `OpenPositionsCard` "Why?" panel — már korábban kapott gate-listát az
  `entryDecision` snapshot-on keresztül (15. session); most a F-Arb
  side-on a coinGates-et reuse-olja az entryDecision építésekor (eddig
  hardcoded passed:true volt).
- TS check zöld (`tsc --noEmit` exit 0), Astro build zöld (9 page).

## Hova nyúlj legközelebb

- Új scan-gate hozzáadása HL-en: `HL_GATE_LABELS` array + új
  `coinGates.push({...})` blokk a megfelelő helyen az index.mts-ben.
  A frontend automatikusan rendererel.
- Új scan-gate F-Arb-en: `ARB_GATE_LABELS` + új gate evaluation a loop-ban.
- Crypto + Weather is migrálható backend-driven gate-hez a jövőben (a
  jelenlegi frontend mapper csak a row data subset-jét látja, a backend
  gate-pipeline pontosabb és bővíthetőbb).

# 2026-05-10 (h) — Tools dashboard: per-tab "How to use" info-box + vol-divergence 15m bug

## Kontextus

A `mj-trading.netlify.app/tools/` 9 elemző-eszköze (Scanner, EV, Swarm,
Order Flow, Vol Harvest, Apex Wallets, Cond Prob, Signals, Arb Matrix)
audit. Felhasználói feedback: a tabokra rákattintva nem nyilvánvaló,
mit csinálnak és melyik Polymarket piacot/piacokat hívják. Kérés:
- minden oldalra egységes "Mire való / Hogyan kell használni" info-doboz,
- API-hívások ellenőrzése (a botoknál volt korábban Gamma/CLOB hiba),
- Polymarket market-scope láthatóvá tétele tabonként.

## Audit eredmények

| Tab | Funkció | Polymarket scope | API status |
|-----|---------|------------------|------------|
| 01 Scanner | `polymarket-proxy` | Top 30 esemény volume24hr DESC | ✅ |
| 02 EV | (none) | – pure Kelly sandbox | ✅ |
| 03 Swarm | (none) | – pure simulator | ✅ |
| 04 Order Flow | `orderflow-analysis` | Felh-választott piac CLOB book | ✅ |
| 05 Vol Harvest | `vol-divergence` | BTC 15m–48h binary kontraktok | ⚠ → fix |
| 06 Apex | `apex-wallets` | Cross-market top wallets | ✅ |
| 07 Cond Prob | `cond-prob-matrix` | Top 50 aktív piac | ✅ |
| 08 Signals | `signal-combiner` | Felh-választott / auto top piac | ✅ |
| 09 Arb Matrix | `vwap-arb` / `llm-dependency` / `pair-cost-arb` | A: top 20 / B: top 30 / C: input / D: top 60 events | ✅ |

A botok korábbi Gamma/CLOB hibái mind javítva (`closed=true` query,
`condition_ids` plural, `clobTokenIds` JSON-string parsing) és stabilak.

## Egy valódi bug: vol-divergence 15m markets filter

`netlify/functions/vol-divergence.mts:117-119`:

```typescript
if (m.endDate) {
  const hoursLeft = (new Date(m.endDate).getTime() - Date.now()) / 3600000;
  if (hoursLeft < 1) return false; // ← BUG
}
```

A komment szerint "BTC UP/DOWN kontraktok (15 perc)" a célpont — de a
`hoursLeft < 1` szűrő pontosan ezeket a 15-perces piacokat dobta el
(kevesebb mint 60 perc van hátra). A tool sosem talált 15 perces BTC
piacot, csak a hosszabb (1h+) daily kontraktokat — viszont a per-market
analízis `if (remaining < 1) timeRemainingHours = remaining` ágba sosem
lépett be, így minden piac default 15-perces IV-vel lett számolva,
függetlenül a tényleges remaining time-tól. Az IV-spread így jelentősen
rossz volt 1h+ daily BTC kontraktokon.

**Fix (2 hely):**

1. `fetchBTCMarkets` filter:
   - `hoursLeft < 1/60` → skip (settlement-hez túl közel, 1 perc alatt)
   - `hoursLeft > 48` → skip (daily/weekly, BTC 1m-RV ablakhoz nem matchel)
   - Köztes intervallum (1 perc – 48 óra) → bekerül

2. Per-market timeRemainingHours: `remaining > 0 && remaining <= 48`
   (volt: `< 1`), így 1-48h piacok is a saját remaining-jükkel kapnak
   IV-szám, nem a 15-perces default-tal.

## Új komponens: `src/components/shared/ToolInfoBox.tsx`

Egységes "info-doboz" minden tool-tab tetejére:
- **title** — pl. "01 // Polymarket Scanner"
- **what** — 1-2 mondatos magyarázat
- **howToUse** — lépéslista (ol)
- **marketScope** — melyik Polymarket piac(ok) hívva, milyen szűrőkkel
- **relatedBot** (opcionális) — link a kapcsolódó bot oldalra (pl.
  Order Flow → /trade/crypto/)
- **endpoint** (opcionális) — háttér API endpoint transparency-ért

A 9 tab-ből 8 kap saját ToolInfoBox-ot (a Polytope sub-tab és a
Pair-Cost sub-tab az Arb Matrix közös info-jában szerepel).

## Bot-eszköz mapping

A `relatedBot` mező mind az 5 megfelelő tabon a crypto bot oldalra
mutat — ez a tool-és-bot kapcsolatot vizuálisan is megjeleníti:

| Tool tab | Bot párja |
|----------|-----------|
| 04 Order Flow | Crypto bot orderflow signal |
| 05 Vol Harvester | Crypto bot vol signal |
| 06 Apex | Crypto bot apex_consensus signal |
| 07 Cond Prob | Crypto bot cond_prob signal |
| 08 Signal Combiner | Crypto bot — same combinator |
| 09 Arb Matrix (D) | Crypto bot pair_cost arb |

## Mit nem változtattam

- A botok signal-pipeline-jában nincs változás. A vol-divergence fix csak
  az analízis-tool-ot érinti (a `vol-divergence.mts` netlify function
  szigorúan a /tools/#vol oldalt szolgálja ki, nem a crypto botot — a
  crypto bot a `signal-combiner.mts:getVolSignal()`-t hívja, ami már
  külön logikával számol IV-t).
- A 4 inline tabnak (Scanner / EV / Swarm) nincs külön component fájlja,
  inline maradnak a Dashboard.tsx-ben.
- TS check zöld (`tsc --noEmit` exit 0 a project files-on; a pre-existing
  `internal-docs/mathSEO_reference/` Deno-script hibák változatlanul
  maradnak — azok a build-en kívül vannak).

## Hova nyúlj legközelebb

- Ha új tool-tab kerül a /tools/ alá, csak importáld a ToolInfoBox-ot és
  add hozzá az 5 prop-pal — egységes UX automatikusan.
- A vol-divergence fix után érdemes 24h-t hagyni a paneltot futni és
  ellenőrizni, hogy a "BTC kontraktok" táblázat valóban 15 perces
  piacokat is hoz (nem csak daily-eket).
- Ha más Gamma-szűrőre is hasonló bug kerül elő (pl. egy hosszú-szál
  market kihagyva volume miatt), érdemes az audit-mintát itt
  dokumentálni.

# 2026-05-10 (i) — Crypto + Weather: backend-driven gate-list (uniform UI follow-up)

## A bug, amit a user észlelt

Az előző `(h)` szekcióban HL + F-Arb backend-shippelt gate-eket kapott;
Crypto és Weather változatlanul a frontend `*EntryCriteria` mappert
használta. **Élesben** a felhasználó látott:

- A scan-row-okon **vagy nem volt chip**, vagy "1/1 ✓" jelent meg —
  ami egyáltalán nem informatív.
- Konzisztencia hiány: HL/F-Arb pontos "X/12" / "X/6" chipet mutatott,
  Crypto/Weather meg semmit vagy 1/1-et.

Oka: a `cryptoEntryCriteria(r, cfg)` mapper csak akkor adott hozzá egy
gate-et, ha a row data tartalmazta a megfelelő mezőt. A skip soron csak
subset volt jelen (pl. csak `r.activeSignals`), ezért 1/1 ✓ jött ki —
pedig a backend decision-engine 8-9 gate-et ténylegesen kiértékelt.

## Fix

### `auto-trader/crypto/decision-engine.mts`

`makeDecision` átírva — **nem short-circuitol** többé. Minden gate
független pass/fail-ként kiértékelődik, a teljes lista visszatér.
`shouldTrade = gates.every(g => g.passed)`. A `reason` mező a *legelső*
bukott gate üzenetét hozza (változatlan UX a row footer-en).

Gate set (9 elem, +1 conditional):

1. Session loss limit · 2. Aktív signal források · 3. Market cooldown
4. Open interest · 5. Entry window (BTC short markets, conditional)
6. OB imbalance konvergencia · 7. Net edge ≥ küszöb
8. Kelly conviction · 9. Kelly méret ≤ cap

Daily piacokon (nincs `openedAtEstimate`) az 5. gate `passed: true,
actual: "n/a (daily market)"` — Y stable.

### `auto-trader/index.mts` (crypto runner)

`marketContext`-be új mező: `gates: decision.gates ?? []`. Mivel ez minden
push-ba spread-elve van (skip / failed / position_opened), a gates
automatikusan minden soron jelen van.

Két extra javítás:

- "Already has open position" early-return: most synthetic 1-gate row
  ("Market nincs nyitva", passed: false). A chip "0/1 · 1✗" rendererelhet.
- Error path: `gates: []` (üres lista, chip nem jelenik meg, ami helyes
  — nem volt mit ellenőrizni).

### `auto-trader/weather/decision-engine.mts`

`makeWeatherDecision` ugyanúgy átírva — **non-short-circuit**, teljes
gate lista visszatér.

Gate set (6 elem):

1. Forecast confidence · 2. Idő a settlementig · 3. Forecast model frissesség
4. Net edge ≥ küszöb · 5. Sanity cap (gross edge ≤ cap) · 6. Kelly méret ≤ cap

### `auto-trader/weather/index.mts`

Per-row gates push-olva minden ágon:

- Already has open position → synthetic 1-gate "Market nincs nyitva"
- Unknown city → synthetic 1-gate "Ismert station / city"
- No matching bucket → synthetic 1-gate "Bucket match"
- Decision skip → `decision.gates` (6 elem)
- Buy order failed → `decision.gates`
- Traded → `decision.gates`
- Error → `[]`

Skip soron a chip rendereléshez plusz mezők is jönnek (predictedTemp,
edge, confidence, marketPrice, modelProb, direction, bucket).

### Frontend (`CryptoTrader.tsx` + `WeatherTrader.tsx`)

`criteria` builder: ha `r.gates` non-empty → backend payload, egyébként
a régi mapper. Mostantól a backend mindig shippeli, így a fallback ritka.

## Hatás deploy után

- **Crypto scan-row**: minden 3 BTC market "X/9-10 gates" chippel jelenik
  meg, hover-en a teljes pre-flight checklist `actual` és `required`
  oszloppal. Eddig 1/1 vagy semmi volt → mostantól pl. 7/9 (2 fail, OB
  + edge), és pontosan látszik melyik gate-ek buktak.
- **Weather scan-row**: minden city "X/6 gates" chippel; HK Shanghai stb.
  most 6/6 vagy 4/6 — pontosan látható melyik bukott (sanity cap, edge).
- **HL + F-Arb**: változatlan (már a (h) session-ben kaptak backend gates).

`tsc --noEmit` exit 0 + Astro build 9 page generated.

## Megjegyzés a tsconfig-ról

A user `internal-docs/mathSEO_reference/` folder-t hozzáadta a
`.gitignore`-hoz, de a `tsconfig.json` `exclude` listájában nem szerepel,
ezért a `tsc --noEmit` továbbra is hibát dobott rá. **Nem érintettem a
tsconfig-ot** — ezt a user vagy egy későbbi session rendezi.

Mivel az említett mappa nem része a Netlify build-nek (Astro/Vite csak
a `src/` és `netlify/functions/` ágat dolgozza fel), a TS hibák nem
blokkolják a deployt.

# 2026-05-10 (j) — Crypto + Weather: chip Y-uniformity + pending diagnostics

## A user észrevett 2 problémát

1. **Chip nem jelenik meg minden trade-lehetőségen** a /trade/crypto/
   és /trade/weather/ oldalon. A 9-gates / 6-gates chip csak a teljesen
   kiértékelt sorokon (decision-skip / position_opened / traded) látszott;
   az early-exit ágakon (already-has-open-position, error, weather
   unknown city / no matching bucket) hiányzott vagy 1/1-et mutatott.

2. **"Miért vár resolutionra" — nem érthető**. A pending paper position
   card csak annyit mondott: "awaiting Polymarket resolution". Nem volt
   látható a per-position diagnostic: vajon UMA window van, vagy a
   conditionId hiányzik (legacy session pozíció).

## Fix: Y-uniform chip minden soron

### `crypto/decision-engine.mts`

Új export: `CRYPTO_GATE_LABELS` (9 elemű ordered array) + `padCryptoGates(
evaluated)` helper. Az evaluated lista bármilyen részhalmaz lehet, a
helper kitölti a hiányzó label-eket `passed: false, actual: "not
evaluated"`-del. Eredmény: minden sor pontosan 9 gate-tel jön.

### `auto-trader/index.mts` (crypto runner)

- "Already has open position" early-exit: `padCryptoGates([{ Market
  cooldown … already open … }])` — Y=9 az 1 evaluated + 8 not-evaluated
  gate-tel.
- catch err ágon ugyanaz: 1 gate `Session loss limit … error: <msg> …`
  + 8 not-evaluated → Y=9.

### `weather/decision-engine.mts`

Ugyanaz: új `WEATHER_GATE_LABELS` (6) + `padWeatherGates`.

### `weather/index.mts`

- Already has open position → `padWeatherGates([{ Forecast confidence … }])`
- Unknown city → `padWeatherGates([{ Forecast confidence … unknown city }])`
- No matching bucket → padded 2 evaluated + 4 not-evaluated
- catch err → padded 1 evaluated + 5 not-evaluated

## Fix: pending-card diagnostic

### `getCryptoPendingPositions(session)` kiterjesztve

Per-position 2 új mező:

- `hasConditionId: boolean` — `true` ha a position rendelkezik
  conditionId-vel (új, post-resolver-wiring pozíciók); `false` ha legacy
  pozíció — ezek **soha nem fognak auto-zárni**, csak session reset
  után kerülnek ki a listából.
- `waitReason: string` — emberbarát szöveg az `ageMs` alapján:
  - < 5 min → "UMA settlement window — typical 5–15 min after endDate"
  - 5–60 min → "extended UMA window — Polymarket not yet reporting closed"
  - > 1h → "long wait (>1h) — possible UMA dispute / market not finalised"
  - missing conditionId → "missing conditionId (legacy position — predates
    resolver wiring)"

### `CryptoTrader.tsx` PendingPositionsCard

Kibővített secondary line: `expired Xm ago · <waitReason>`. A whenText
most "⚠ missing conditionId" ha legacy, egyébként "awaiting Polymarket
resolution". Footnote frissítve: legacy positions need session reset.

## Hatás deploy után

- **Crypto scan**: minden 3 BTC market / minden ag (skip / error / open)
  most "X/9 gates" chippel. Akár 9/9 ✓ (open), 7/9 (decision-skip 2 fail),
  vagy 0/9 (already-has-position).
- **Weather scan**: ugyanaz "X/6 gates" formátum.
- **Crypto pending card**: minden várakozó pozíció megmondja
  hogy mikor és **miért** vár — UMA window vs missing conditionId.

## Megjegyzés a "vár resolutionra" jelenségre

A simVersion 3 contract: paper PnL **csak** valós Polymarket resolution
után zár (Gamma `closed: true` + `outcomePrices` ∈ {0, 1}). Tipikus
UMA settlement window 5–60 min az endDate után; vita esetén órák. **Ez
nem bug — ez a v3 invariáns**: paper PnL == live PnL. A bot nem
szimulál.

Ha egy pozíció >1h-ja vár és a `hasConditionId: true`, akkor:
- Polymarket UMA még szavaz (gyakori daily / nagy bet markets-en).
- Vagy a Gamma még nem flippelte a `closed` flag-et (timeout).

Ha `hasConditionId: false`, az egy legacy pozíció (a session manager
simVersion bump-ja előttről). Reset oldja meg.

`tsc --noEmit` exit 0 a project files-on. Astro build 9 page generated.

# 2026-05-10 (k) — Stop/Resume gombok: Weather + Crypto backend handler hiányzott

## A user észrevett bug

A Weather bot Stop gomb működött, de a "Stopped: Manual stop" után **nem
lehetett visszaindítani** — a Weather UI-ban nem volt Resume gomb.
Sőt: a Crypto UI-on volt Resume gomb, de **a backend nem ismerte fel a
"resume" action-t** crypto+weather kategóriára → 400 "Unknown action:
resume" rejtett hibába futott.

## Root cause

1. **`auto-trader/index.mts` dispatcher** (crypto + weather ágban):
   `case "stop"` jelen, **`case "resume"` hiányzik**. Csak HL és F-Arb
   ágakban volt resume case (külön dispatcher branch).
2. **`crypto/session-manager.mts`**: `stopSession` jelen,
   **`resumeSession` nem volt definiálva**.
3. **`WeatherTrader.tsx`**: `controls` array-ben **nincs Resume gomb**.
   Csak Run / Reconcile / Stop.

## Fix

### `crypto/session-manager.mts`

Új helper: `resumeSession(session)` — clears `stopped: false`,
`stoppedReason: null`, `calibrationAlertSentAt: null`. Mirror-je a HL
`resumeHlSession`-nek. Logol "SESSION_START" event-tel a session_resume
trail miatt.

### `auto-trader/index.mts`

- Új `handleResume(config, category)` symmetric a `handleStop`-pal.
  Loadolja a sessiont, hívja a `resumeSession`-t, mentés.
- Új dispatcher case: `case "resume": return await handleResume(config, cat);`
  — futás a HL/F-Arb resume case-ek alatt, a crypto+weather közös
  switch-ben.

### `WeatherTrader.tsx`

Symmetric Stop/Resume gombok a Crypto / HL / F-Arb mintára:

```tsx
{ label: "Resume", kind: "secondary", onClick: () => doAction("resume"),
  disabled: isRunning, when: isStopped },
{ label: "Stop",   kind: "danger",    onClick: () => doAction("stop"),
  disabled: isRunning, when: !isStopped },
```

A `session` változót feljebb húzva a controls deklaráció elé. Az `isStopped`
flag az `!!session?.stopped` alapján.

## Hatás deploy után

- A "Stopped: Manual stop" alert mostantól **eltüntethető** a Resume
  gombbal — csak akkor látszik, ha a session stopped, és ezzel egy időben
  a Stop gomb eltűnik (helyette Resume jelenik meg).
- Crypto Resume már korábban megjelent a UI-on, de 400-zal failt — most
  helyesen működik.
- HL + F-Arb: változatlan (saját resume case eddig is működött).

## Egységesség checklist (mind a 4 bot)

| Bot | Run | Reconcile | Resume (when stopped) | Stop (when running) | Refresh |
|------|------|-----------|----------------------|---------------------|---------|
| Crypto | ✓ | — | ✓ | ✓ | ✓ |
| Weather | ✓ | ✓ | ✓ (ÚJ) | ✓ | — |
| HL Perp | ✓ | — | ✓ | ✓ | ✓ |
| F-Arb | ✓ | — | ✓ | ✓ | ✓ |

A Resume gomb mind a 4 boton most ugyanazt a logikát követi: csak akkor
látható, ha a session `stopped: true` (HL-en pluszban a `pausedUntil`).
Stop gomb csak akkor látszik, ha NINCS stopped/paused.

`tsc --noEmit` exit 0 + Astro build 9 page generated.
