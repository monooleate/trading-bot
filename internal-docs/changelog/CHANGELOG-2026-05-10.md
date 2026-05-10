# 2026-05-10 — Crypto bot pending-paper-position kártya

## Mit?

A crypto bot UI-jára felkerült a `PendingPositionsCard`, ami csak akkor render,
ha van olyan paper open position aminek az `endDate`-je már elmúlt, de még nem
zárta le sem a Polymarket settle, sem a Brownian-bridge fallback. Ugyanez a
kártya-nyelv és vizuális stílus mint a weather bot 2026-05-09-i pending
kártyája — most a 4 bot között is szimmetrikus.

## Miért?

Eddig a crypto-n nem volt felülete a "stuck pending settle" állapotnak. A
`paper-resolver.mts` (2026-05-09 v2) inline fut a `*/3 *` cron tickkel, így
a pending ablak normál esetben < 3 perc, és a felület hiánya nem okozott
hibát. De a 2026-05-10-i debug szerint a weather reconciler-cron 24+ órát
nem futott le egy Shanghai pozíción — analóg incidens a crypto cron-on
nem hagyna nyomot a UI-ban. Most:

- Ha minden rendben → a kártya **nem render** (üres rendszerben nincs
  vizuális zaj).
- Ha 1+ pozíció átlépte az endDate-et és vár a settle-re → kártya
  rögtön megjelenik state hint-tel ("auto-settles next tick" vagy
  "Brownian fallback eligible" ha `paperFallbackAfterMs`-en is túl).

## Hol?

### Backend (`netlify/functions/auto-trader/index.mts`)

- Új helper `getCryptoPendingPositions(session, fallbackAfterMs)` — szűri
  a `session.openPositions`-t `endDate < now`-ra, számolja az `ageMs`-t és a
  `fallbackEligibleAt`-et, sortolja `endDate` szerint növekvően.
- A `getStatus()` crypto ágában `base.pending` mezőként visszaadja. A
  `paperFallbackAfterMs`-t a meglévő `readyOv` runtime-overrides ablakból
  húzza (default 30 min).

### Frontend (`src/components/trader/CryptoTrader.tsx`)

- `PendingPositionsCard` import + render conditional (`pending.count > 0`).
- Per-row mapping: `primary` = title vagy slug, `secondary` = "expired Xm
  ago" (új `formatAgeAgo` helper), `direction` chip, `predictionText` =
  "pred N%", `sizeText` = "$X.XX", `whenText` = state hint.

## Mit nem változtattam?

- **A bot logikája semmilyen ponton nem változott.** A `paper-resolver.mts`
  ugyanazt csinálja, a `*/3 *` cron ugyanúgy fut, a Brownian fallback
  ugyanannál az `endTs + paperFallbackAfterMs` küszöbnél éleződik.
- **Nincs új manuális reconcile gomb.** A meglévő "Run Scan" gomb már
  triggereli a resolver-t (`auto-trader/index.mts:274` minden run előtt
  hívja `resolvePendingPaperPositions`-t), tehát redundáns lenne.
- **A weather bot UI nem változott.** Az ott élő `PendingPositionsCard` és
  manuális "⟳ Reconcile pending" gomb maradt — azt indokolja a külön
  `auto-trader-weather-reconciler-cron` és a 6h-os METAR fallback ablak.

## Hova nyúlj legközelebb

- Ha a kártya gyakran megjelenik még a Brownian fallback-en is túl → a
  `*/3 *` `auto-trader` cron leállt vagy timeoutol. Netlify Functions →
  scheduled tab → execution log.
- Ha új mezőt szeretnél a sorokon (pl. live mp drift az entry óta), a
  `getCryptoPendingPositions` kibővítése + a `pending.positions.map`
  callback-be 1 új `PendingPositionLite` mező — máshol nem kell nyúlni.

---

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
