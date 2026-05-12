# 2026-05-12 — CLAUDE.md karcsúsítás, Settings preset rendszer, live-gate snapshot, weather audit

## (a) CLAUDE.md optimalizálás (2028 → 410 sor, ~80% csökkenés)

A user észlelte, hogy a CLAUDE.md túl nagy (2028 sor) — minden új session
elején betöltődik a Claude Code kontextusába, ez fölösleges költség.

**Mit vettem ki:** A teljes session-by-session "AKTUÁLIS ÁLLAPOT"
history-t (32. session-ig). A részletes leírások a `changelog/`-ban
amúgyis benne vannak — duplikáció + SSOT-sértés volt.

**Mit hagytam meg:**
- Session-zárási szabályok + SSOT táblázat
- Projekt leírás, mappaszerkezet, 11 tools tab + 6 bot tábla
- CSS rendszer, Netlify Functions konvenciók, cache TTL-ek, API endpointok
- Auth (rövid), env-var pointer
- Math rövid összegzés (részletek a `math/`-ban)
- Python scriptek
- Fejlesztési szabályok (új tab, új bot, új function, gate-list pattern)
- Build & deploy
- **AKTUÁLIS ÁLLAPOT (2026-05-12)**: 4 bot státusz táblázat, legutóbbi fix-ek 1 mondatban, hova-nyúlj-legközelebb pointerek, történeti tanulságok 1-sorosan a részletekhez a changelog-ban hivatkozva.

Új session-zárási szabály explicit: a session-by-session részletek a
`changelog/`-ba kerülnek, **NEM** a CLAUDE.md-be.

## (b) Weather bot 2-trade audit (live URL)

A user kérte: `mj-trading.netlify.app/trade/weather/` — a 2 lezárt trade valós-e.

**Verdict: mindkettő valós Polymarket resolution-on zárt, a PnL helyes.**

| # | Market | Side | Entry | Exit | Shares | PnL | predProb | Verdict |
|---|--------|------|-------|------|--------|-----|----------|---------|
| 1 | London May 11 max temp | NO | 0.54 | 1.00 | 20.96 | +$9.64 | 18.55% | ✅ valós, NO won |
| 2 | Seoul May 11 max temp | NO | 0.695 | 0.00 | 21.21 | -$14.74 | 1.34% | ✅ valós, NO lost |

- Closed PnL összesen: +9.64 − 14.74 = **-$5.10** — ez egyezik a session
  `sessionPnL` mezővel.
- Mindkét exit price ∈ `{0, 1}` → real Gamma `outcomePrices` resolution
  (simV3 invariáns, nincs sim fallback).
- A Seoul trade a model confidence-e ellenére (98.66% NO) elveszett — a
  model szignifikánsan eltért a valós METAR-tól. **Ez NEM bug**, hanem
  valós paper-tanulság: a Seoul forecast underconfident volt a tail-en.

A Sharpe -0.06 a 2-elemű mintán meaningless — várjuk a 30+ trade
sample-t a live-readiness gate-hez.

## (c) Crypto bot diagnosztika — miért nem nyitott napok óta

A user észlelte: a crypto bot a sessionStartedAt (2026-05-10 23:22Z) óta
nem nyitott pozíciót. Root cause analysis:

A live `mj-trading.netlify.app/.netlify/functions/auto-trader-api?action=status&category=crypto` payload utolsó 3 scan-result-ja:

```
BTC Above $80K   → SKIP "Combiner output too close to 0.5: |0.4847 − 0.5| = 1.53% < 5%"  edge +31.43% kelly $0
BTC Up/Down      → SKIP "Combiner output too close to 0.5: |0.4785 − 0.5| = 2.15% < 5%"  edge +23.75% kelly $0
BTC Above $78K   → SKIP "Combiner output too close to 0.5: |0.4902 − 0.5| = 0.98% < 5%"  edge +28.38% kelly $0
```

**Hibajelenség**: a combiner finalProb mindenhol 0.48-0.49 körül van (8 jel
átlag konvergál 0.5-höz ha nincs erős input), a market price 0.17-0.20 →
**nominálisan 25-30% edge**. Viszont a 2026-05-11 audit fix-jeként
bevezetett `combiner confidence` gate (|finalProb − 0.5| ≥ 5%) elbukik
2-3%-on → SKIP, Kelly = 0.

Ez a gate **szándékos védelmi mechanizmus** (a 8-jeles weighted average
zaj-szintű kimenetét nem akarjuk trade-ként kezelni), DE túl szigorú a
jelenlegi signal-source minőséghez képest — minden BTC trade-et blokkol.

**Megoldás**: a Settings preset rendszerben (lásd (d)) a "Lazább" preset
2%-ra állítja a `combinerConfidenceMin`-t — a 3 BTC piacból mindhárom
átmegy, és a paper-mode-ban érdemi IC-méréshez juthatunk.

## (d) Settings preset rendszer (Loose / Normal / Strict per-bot)

A user kérése: kapcsoló gomb a Settings tabon, "laza / normál" beállítások,
egyedi per-bot, kis leiratokkal.

**Backend** (`netlify/functions/trader-settings.mts`):

- Új `PRESETS: Record<Category, CategoryPresets>` export. Minden kategóriához
  3 preset (loose/normal/strict), mindegyikhez `label` + magyar nyelvű
  `description` + `values: Record<field, number>` map.
- A GET handler kibővítve `presets: PRESETS` mezővel — a UI együtt kapja
  a schema-t, az effective-et, az overrides-et és a preset bundle-okat.
- 16 új field a SCHEMA-ban (HL + F-Arb + Sports kategóriák — eddig csak
  env-en keresztül voltak állíthatók):
  - HL: `hlEdgeThresholdPaper/Live`, `hlMaxLeverage`, `hlVolGateRvPct`,
    `hlConsecutiveLossLimit`, `hlSessionLossLimit`, `hlCooldownSeconds`,
    `hlMaxOpenPositions`
  - F-Arb: `frMinSpreadHourly`, `frMinOpenInterestUSD`, `frMaxHoldDays`,
    `frMaxCapitalPct`
  - Sports: `sportsEdgeThreshold`, `sportsMaxPositionUSD`
- `Category` type kibővítve `"funding-arb" | "sports"`-szal.

**Config-wrapping** (mindhárom bot kap `getEffective*Config()`-et):

- `auto-trader/hyperliquid/config.mts`: új `getEffectiveHlConfig()` —
  lazy import a trader-settings-re (circular dep elkerülés), 8 mező
  override-olható. `index.mts` `runHyperliquidTraderInner` átállítva
  rá. **Hatás**: Loose preset után a következő */3 cron tick-en már az új
  edge-küszöbök + leverage-cap aktív.
- `auto-trader/hyperliquid/funding-arb/config.mts`: új
  `getEffectiveFrArbConfig()` — spread/OI/hold/capital field-ek
  override. `index.mts` `runFundingArbInner` használja.
- `auto-trader/sports/config.mts`: új `getEffectiveSportsConfig()` —
  edge + max position USD. `index.mts` `runSportsAutoTraderInner` átállítva.

A crypto + weather már korábban `getEffective*Config()`-en keresztül
olvasott — változatlan.

**UI** (`src/components/SettingsPanel.tsx`):

- Új `PresetDefinition` + `CategoryPresets` típusok, a `ServerResponse`
  kapott `presets?` mezőt.
- A `SettingsPanel` filter `isAutoTraderCategory` változatban kibővítve
  `"funding-arb"` + `"sports"`-szal.
- Új `applyPreset(kind)` callback: a preset `values` map-jét beszórja
  a `draft`-ba (csak a látható schema mezőkre — defensive). Az
  állapotot a "Mentés" gomb persistálja, az alkalmazás csak draftet
  módosít → nincs accidental save.
- Új preset-selector grid a form fölött: 3 nagy kártya
  (Lazább/Normál/Szigorú), bal-szegélyes szín-kód (kék/zöld/narancs),
  descriptionek a kártyán, "→ Alkalmaz" CTA. Disabled-állapot busy-re.
- CategoryDashboard: a F-Arb settings tab `category="funding-arb"`-ot
  ad (eddig `"hyperliquid"`-et — saját preset bundle-t fog kapni így).
- Új CSS osztályok: `set-presets`, `set-preset-card`, tone-onkénti
  border-color.

A 4 fő bot mostantól mindegyik megkapja a saját preset bundle-t:
- **Crypto loose**: combinerConfidenceMin 0.05→0.02, edgeThreshold 0.15→0.08, minPositionSizeUSDC 0.50→0.20, Kelly cap 8%→5% (kompenzál a lazább küszöbre)
- **Crypto normal**: a 2026-05-11 audit default
- **Crypto strict**: combinerConfidenceMin 0.10, edgeThreshold 0.25, min pozíció $2
- **Weather loose**: edge 6%, confidence 50%, market-disagreement 3°C
- **Weather normal/strict**: a 12% / 20% edge küszöbök
- **HL Perp** 3 preset paper/live edge külön-külön
- **F-Arb** 3 preset spread/OI/hold floor-okra
- **Sports** 3 preset edge + max position

## (e) Live-gate snapshot open pozíciókon (mind a 4 bot)

A user kérése: "az aktív trédeknél látni akarom, hogy mi alapon nyitotta a bot
(megvan) és pillanatnyilag mik a gate értékek".

**Megközelítés**: a cron tick már elvégzi a teljes gate-evaluation-t minden
piacra (`results[]` minden `{market/coin, gates: [...]}` rekorddal). A
runStatus.lastResult.results-ben ez bent van. A getStatus-ban
slug/coin alapján felfűzöm az open pozícióra "live gate snapshot"-ként.

**Backend** (`netlify/functions/auto-trader/index.mts` + HL/F-Arb index):
- Új helper `pickLiveScanForSlug(scanResults, slug)` / `pickLiveScanForCoin(coin)`:
  visszaadja az `evaluatedAt/action/reason/edge/direction/gates` snapshot-ot.
- `getCryptoOpenActive` + `getWeatherOpenActive` + HL `openDetails` mapper
  + F-Arb `summarize` mind kap egy `liveGates: pickLive(coin) ?? null`
  mezőt minden open pozíción.
- getStatus a runStatus-t ELŐSZÖR fetcheli, aztán adja át a lastResult.results-et
  a helpernek.

**Frontend** (`src/components/shared/TraderResults.tsx`):
- Új `LiveGateSnapshot` típus.
- `OpenPositionRow.liveGates?` opcionális mező.
- Új `LiveGatesBlock` komponens — `RationaleBlock`-kal párhuzamos szerkezet:
  tézis-mondat (mit szólna a bot MOST), gate-lista pass/fail, meta sor
  (`evaluatedAt`, engine reason).
- `OpenPositionsCard.details` panel: ha rationale + liveGates is van, **mindkettő**
  renderelődik egymás alatt — a frozen entry-snapshot fent, a live gate
  snapshot alatta. A "Why?" toggle akkor is megjelenik, ha csak liveGates
  van (régi pozíció rationale nélkül is láthatja a felhasználó a current
  állapotot).
- Új CSS: `.ts-pos-why-live` — narancs (`var(--warn)`) bal-szegély, hogy
  vizuálisan elkülönüljön a kék (`var(--accent2)`) frozen-entry strip-től.

**Bekapcsolt minden 4 trader panelben**: CryptoTrader, WeatherTrader,
HyperliquidTrader, FundingArbPanel — a `openDetails` mapper minden boton
átemeli a `p.liveGates ?? null`-t a row-ra.

**Hatás deploy után**:
A felhasználó kibontja egy open pozíció "Why?" panel-jét, és látja:
1. **Frozen entry-decision** (kék strip) — pontosan mi alapján nyílt
2. **Live gates** (narancs strip) — most ugyanezen piacon mit lát a bot

Ha a frozen-entry "BUY YES @ 17%" volt 30% edge-dzsel, de a live-gates
most "SKIP, Combiner output too close to 0.5" → látja hogy az alap mögött
álló conviction elromlott, és pl. dönthet manuálisan a position close
mellett a settlement előtt.

A live-gate adat frissessége: a legutóbbi cron tick (max 3 perc) vagy a
legutóbbi manuális scan. Az `evaluatedAt` mező mutatja a UI-on.

## Egyéb (kis fix-ek)

- `CategoryDashboard.tsx`: F-Arb settings tab `category="funding-arb"`-ra
  átállítva (eddig `"hyperliquid"`-et használt — az új F-Arb-specifikus
  preset bundle-ok így a helyes tabon jelennek meg).

## TypeScript + build

`npx tsc --noEmit` exit 0. `npx astro build` 10 page generated, 3.02s.

## Hova nyúlj legközelebb

1. **Deploy után**: nyisd meg `/trade/crypto/#settings`, kattints
   **"Lazább"** preset → **"Mentés"**. A következő */3 cron tick már a
   2%-os combiner confidence gate-tel fut → a 3 BTC piacból mindhárom
   átmegy paper-trade-en.
2. **30+ új paper trade után** (a lazább küszöbökkel várhatóan 1-2 napon
   belül) → ellenőrizd a Calibration Health badge-et a /trade/crypto/
   tetején. Ha zöld (IC > 0.05) → a signal-szett bizonyítottan
   prediktív, érdemes a Normál preset-re visszaállni. Ha narancs/piros
   (IC < 0.02) → a signal-szettet kell átnézni, nem a preset-et.
3. **HL + F-Arb preset validáció**: a 3 preset shape-je most már Settings
   tabon megjelenik, de a runtime config-wiring nem tesztelt szigorúan.
   Az első Run Scan után a runStatus-ban látszani fognak az override-ok
   alkalmazása (pl. ha Loose-zal a HL edgeThresholdPaper 0.08-ra
   csökkent).
4. **Live-gate display**: nyiss meg egy open pozíciót a /trade/weather/-en
   (jelenleg 3 nyitott Austin/HK/Seoul). Kattints a "Why?" toggle-re.
   Két panelt kell látni: a kék frozen-entry-t felül, a narancs
   live-gate snapshot-ot alatta.

---

## (i) Live-gate snapshot fix — relevant-only gates + crypto/weather full eval

User észrevétel: a Why? panel a meglévő live trade-eken **nem mutatja, hogy
most nyitná-e** — vagyis hogyan állnak az aktuális gate-ek. A pillanatnyi
gate panel csak `"Market cooldown ✗ already open"` típusú stubot mutatott,
körülötte 8-11 db `"not evaluated"` placeholderrel.

**Root cause** (két részből áll):

1. **Crypto + Weather**: az index.mts loop az `openPositions.some(market === slug)`
   ellenőrzéskor `continue`-val korai-skip-pelt egy stub gate-listával
   (`padCryptoGates([{label: "Market cooldown", actual: "already open", ...}])`
   illetve `padWeatherGates([{label: "Forecast confidence ≥ küszöb", actual: "already open", ...}])`).
   A valós gate-kiértékelés meg sem történt. A `pickLiveScanForSlug` ezt a
   stub-ot olvasta fel → a Why? Live-Gates panel csak ezt látta.

2. **HL Perp + Funding-arb**: a gate-eket inline kiértékelte, de a `snapGates()`
   helper `"not evaluated"` placeholder rows-szel padded a maradék gate-eket
   a uniform Y-szám érdekében. A scan-row chip-en ez OK, de a Live-Gates
   panelen zaj.

**Fix:**

- **`src/components/shared/TraderResults.tsx` `LiveGatesBlock`**:
  Bevezetve két szűrő (`isMeaningfulGate` + `isOpenPositionGate`):
  - `actual === "not evaluated"` rows → kiszűrve
  - Open-position-uniqueness gates (HL `"Coin nincs már nyitva"`,
    Funding-arb `"Per-coin uniqueness"`, legacy crypto `"Market cooldown"`
    `actual: "already open"`) → kiszűrve (a user már tudja, hogy van pozíciója).
  - A crypto bot legitim cooldown gate (idő-alapú) **nem szűrődik ki** —
    csak az `actual === "already open"` címkével.
  - A verdict frázis átírva: a passed/total alapján mondja meg, hogy
    `"MOST megnyitná (minden releváns gate ✓)"` vagy
    `"MOST NEM nyitná (N releváns gate ✗)"`, az `action` verb helyett
    (ami félrevezető lenne: SKIP-et mondana, mert a buy a `alreadyOpen`-en
    blokkolt, nem azért mert a gate-ek elbuktak).

- **`netlify/functions/auto-trader/index.mts` (crypto loop)**:
  Megszűnt az "Already has open position" korai-skip. Helyette:
  - `const alreadyOpen = updatedSession.openPositions.some(...)` változó
  - signal aggregation + `makeDecision` minden esetben lefut
  - `marketContext` real-gate értékekkel (12 gate)
  - `if (alreadyOpen) push skip` — a result row VALÓS gate-eket hordoz
  - `evaluatedAt: new Date().toISOString()` hozzáadva per-row.

- **`netlify/functions/auto-trader/weather/index.mts`**:
  Ugyanaz a pattern: `alreadyOpen` változó, korai-skip megszűnt, `rowContext`
  spread-elve a `traded` / `failed` / `skip` ágakra is, `evaluatedAt`
  per-row.

- **`pickLiveScanForSlug` / `pickLiveScanForCoin` / funding-arb `pickLive`**:
  Új `tickFinishedAt` paraméter (a `lastResult.finishedAt` vagy
  `runStatus.lastRunAt` fallback) — ha a row nem stamp-elt saját
  `evaluatedAt`-ot, ezzel hidalódik át. A status endpoint
  (`getStatus`, `getHlStatus`, `getArbStatus`) átadja a tick timestamp-et
  a helper-eknek.

**Eredmény:**

- A Why? panel "Pillanatnyi gate állapot" most a valós kiértékelés
  alapján mondja meg, hogy a bot megnyitná-e most a pozíciót, ha még nem
  lenne nyitott.
- A "not evaluated" placeholderek és a "Coin nincs már nyitva" / "Per-coin
  uniqueness" gate-ek nem zajolnak be a listát.
- Mind a 4 bot (crypto, weather, HL perp, funding-arb) ugyanazt a viselkedést
  mutatja a UI-on.

**Mellékhatás / költség:**

- A crypto + weather loop mostantól már nyitott market-ekre is megfuttatja
  a signal aggregation-t (és a forecast pipeline-t). Plusz ~1-2 API call
  set per tick per open position (ha a top-N-ben van) — a perf-hit
  elhanyagolható (a Polymarket-proxy 1h cache + a signal-combiner 3min
  cache amúgyis fedi).

## (j) Follow-up: open-position markets that drifted out of top-N scan window

User észrevétel: a /trade/crypto/ oldalon az open pozíciókon a Why? Live-Gates
panel "nincs friss gate-adat"-ot mutatott — mert a 2 open pozíció
(`bitcoin-above-82k-on-may-13`, `bitcoin-above-78k-on-may-13`) **nem volt**
a top-3 scan-ben (a price-band [0.10, 0.90] szűrő kiejtette őket, miután
a piac mozgott az entry óta).

**Fix (mind crypto, mind weather):**

- **`findBtcMarkets` új paraméter**: `includeSlugs: string[]` — a megadott
  slug-okra megkerüli az OI minimum és a deep-OTM/deep-ITM price-band szűrőt.
  Így a Gamma response-ban szereplő összes open-position market mindig
  bekerül a `markets` listába, akkor is, ha közben drift-elt out-of-band-ra.

- **Crypto + Weather index.mts scan list bővítés**:
  ```ts
  const scanList = [...top3, ...extraOpenPositions];
  ```
  ahol az `extraOpenPositions` a `markets`-ben szereplő open-position
  market-ek, amelyek nem voltak a top-3-ban (illetve weather-nél top-5-ben).
  Vagyis a normál entry universe (top-N) ÉS a már nyitott pozíciók is
  mindenképp kiértékelődnek.

- **Max-open cap bypass open-position-ön**: a `activeOpenCount >= cap`
  check is csak NEW entry-ket blokkol. Ha a market már nyitott, a cap
  nem alkalmazható, ezért a teljes gate-eval lefut — különben az
  egyetlen "Max open positions ✗" gate jelenne meg a Why? panelen.

**Eredmény:**

- A Why? Live-Gates panel mostantól minden open pozíción mutatja a teljes
  gate-listát (a max-open cap-be ütköző esetekben is).
- A drifted-out-of-band open positions (típikusan winning paper trade-ek
  amik közelítik a $0.99-et) is kapnak fresh gate adatot — a user látja,
  hogy "Net edge -X%" most már nem teljesül, magyarázva, hogy a bot most
  nem nyitná meg újra.

**Mellékhatás:**

- A `droppedMarkets` listából kihagyjuk a már bevett open-position market-eket
  (mert mostantól a scan-ben vannak, nem dropped). Az op-pos market-ek
  scan-eredménye a normál `results` listában jelenik meg, `action: "skip"`,
  `reason: "Already has open position"`.
