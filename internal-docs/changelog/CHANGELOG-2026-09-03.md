# CHANGELOG — 2026-09-03

## Teljes audit (5 bot + infra + security) → prioritált fixek implementálva

A user kérése: minden botra teljes audit (helyes-e az implementáció, a beállítások tényleg módosítanak-e), + security audit, + prio-lista + a megvalósítás indítása, + a teljes oldal rejtése AI/kereső-botok elől, + push a végén.

**Módszer:** 5 párhuzamos read-only audit-ágens (crypto+combiner, weather+sports, HL+funding-arb, új infra-réteg, security). Minden találat kódra verifikálva; a magas-súlyúakat magam is ellenőriztem. **0 valós P0 a botlogikában; 1 P0 az új infra-rétegben.**

### Implementálva (mind: `tsc` exit 0 + teljes suite zöld)

**Batch 1 — korrektség (P0/P1):**
- **P0 — HL session sosem perzisztált:** a HL pozíciók/trade-ek `coin`/`sizeCoins`/`pnlUSDC`-t használnak, `market` mező nélkül → a `NOT NULL market` oszlop minden HL `saveSession`-t eldobott (a catch elnyelte → néma adatvesztés). Fix: **migration 007** (market DROP NOT NULL; a HL-mezők a JSONB payloadban round-trip-elnek); `session-store.rebuild()` null-oszlop-skip pozíciókra/trade-ekre (a #18-at is fixeli). `pg-roundtrip` most **valódi HlSessionState-et** pin-el (pozíció + closed trade). *(A korábbi tesztem üres HL-sessiont használt → ezért csúszott át.)*
- **P1 sports:** a NO-oldali edge kevert valószínűség-frame-ben számolt (YES-frame `predicted` mínusz NO-ár) → túlbecsült NO-edge → küszöb-alatti/negatív-EV trade. Fix: `fairForSide − marketPriceForSide`.
- **P1 crypto:** `icHalfLifeTrades` a rossz objektumról olvasva (readyOv whitelist kihagyta) → holt knob; felvéve a whitelistre.
- **P1 HL:** a perp-Kelly a direkcionális prob-ot közvetlenül TP-before-SL win-rate-ként használta (0-edge-nél 0.25 Kelly → túl-méretezés, B36). Fix: a bracket win-prob a driftmentes `1/(1+RR)` baseline-hez horgonyozva + korlátos konviction-tilt → 0.5 prob = 0 Kelly. Új `kelly-sizer.test.mts` (5 pin).
- **P1 HL:** paper módban a HL-adat (ár/funding/OI) **testnetről** jött, míg a signalok + Binance mainnetről → torz paper-PnL + cross-env F-arb spread. Fix: `hlInfoPost` mindig **mainnet** (az Info publikus piaci adat; az order-placement külön úton).
- **P2 HL:** a realized-IC mapping nem létező `t.side`-ot olvasott → minden trade „YES"; javítva `t.direction`-re.

**Batch 2 — security + crawler-rejtés:**
- **P1:** `llm-dependency` + `resolution-risk` auth-gate (ANTHROPIC_API_KEY-t költenek attacker-inputra, cache-bypass-olható).
- **P2:** `user-settings` POST + `trade-logger` POST/resolve auth-gate; Supabase-filter id `encodeURIComponent` (latens).
- **P2:** login konstans-idejű hash-összevetés (`timingSafeEqual`) + per-IP rate-limit (8/15p → 429). *(KDF-upgrade [bcrypt/argon2] operátor-feladat — új hash kell → sprints B42.)*
- **P3:** `_auth-guard` HS256-pin + `JWT_SECRET ≥32` kényszer; `server.ts` explicit static-path containment + generikus hibaüzenet.
- **Crawler/AI-rejtés (user-kérés):** Caddy `trade.` blokk — `X-Robots-Tag noindex`, `robots.txt Disallow: /`, és **403 ~25 AI/scraper user-agentre** (GPTBot/ClaudeBot/CCBot/Google-Extended/PerplexityBot/Bytespider/…); `server.ts` is szolgál `/robots.txt`-t (defense-in-depth).

**Batch 3 — robusztusság:**
- `scheduler.stop()` bevárja a folyamatban lévő tick-et; a worker SIGTERM ≤10s-ig drain-el (redeploy nem öl meg mentés közben).
- `migrate` fájlonként atomi (per-migration tranzakció).
- `blobs-compat.delete()` a session-kulcsokat a normalizált `pillar_*` sorokra irányítja (eddig no-op volt).
- crypto max-open cap élő per-tick számlálóval (eddig stale → túllépés); weather scan-ablak ≥ `maxOpenPositions` (eddig hardcode 5).

### Deferred → sprints.md (B42–B45)
- **B42** login KDF-upgrade (bcrypt/argon2 + operátor új `AUTH_PASSWORD_HASH`).
- **B43** B34 mély sign-aware realized-IC (a `computeRealizedICs` korrelálja a signalt az irány-kimenettel, ne csak `pnl>0`-val) — shared-infra.
- **B44** sports snapshot a Pinnacle fair value-t rögzítse (nem a shrink-et) — csak B37/`usePinnacle` bekapcsolásakor releváns.
- **B45** HL Kelly conviction-scale Settings-knob (jelenleg konstans 0.5).

**Deploy:** a fixek + migration 007 + Caddy-crawler-blokk a boxra (paper). Push a `main`-re.

### Deploy (boxra, paper) — kész + deploy-közbeni extra find
A fixek + migration 007 + Caddy-crawler-blokk deployolva. **Deploy-közben felszínre jött egy addig rejtett integrációs bug** (az auditágensek logikát néztek, nem a cross-service URL-t): a crypto `signal-aggregator` + HL `signal-source` a `signal-combiner`/`polymarket-proxy`-t `EDGECALC_BASE = process.env.URL || localhost:8888`-on hívta → a konténerben `URL` üres → `localhost:8888` → ConnectionRefused → **mindkét bot signal nélkül futott** (finalProb 0.5, activeSignals 0). Fix: `EDGECALC_INTERNAL_URL` (→ `http://edgecalc-api:7000`) a worker env-be. Utána: crypto activeSignals **8**, HL **7**, 0 worker-hiba. **Verifikáció:** market oszlop nullable; `llm-dependency` unauth POST → 401; browser → 200 + `X-Robots-Tag noindex`; GPTBot/ClaudeBot/CCBot/PerplexityBot → **403**; `robots.txt` Disallow:/; umami érintetlen (200). RAM 1.3/7.6 GB, 0 swap. Commitok: `534f637` (batch1) → `7b7e79c` (batch2+3) → `664e945` (internal-url) → `83c76bf` (caddy-fix).

---

## Külső API-audit (provider-doksik szerint) + up-to-date fixek — 56. session

A user kérése: a botok által hívott API-k hatékonyan működnek-e, adtak-e ki a szolgáltatók olyan frissítést, ami érinti a bekötést, és a doksijuk szerint helyesen vannak-e bekötve — a kódból dolgozva. Majd: a fixek elvégzése + minden API up-to-date-re hozása.

**Módszer:** 2 párhuzamos read-only katalógus-ágens (tőzsdék: Binance spot+futures, Bybit, Hyperliquid; illetve Polymarket Gamma/CLOB/Data, Anthropic, Deribit, weather/NOAA, sports) — minden külső `fetch` endpoint/param/aláírás file:line-nal kigyűjtve. Párhuzamosan a provider-changelogok webes ellenőrzése (Anthropic model-deprecations, Binance derivatives change-log, Bybit V5 changelog, Polymarket changelog, Deribit JSON-RPC changelog). Minden állítás kódra + doksira verifikálva.

**Verdikt:** a bekötés túlnyomórészt helyes és aktuális (HMAC/EIP-712 aláírások, `&closed=true` Gamma-kvirk, endpoint-verziók). **1 ténylegesen törött** (retired Claude-modell) + **1 elavuló** (Binance fapi v2) + **1 latens** (apex-profiler hiányzó `x-api-key`).

### Implementálva (mind: `tsc --noEmit` exit 0 + **26/26 teszt** zöld)

- **P0 — retired Claude-modell (3 hívóhely).** A kód `claude-sonnet-4-20250514`-et hívott, amit az Anthropic **2026-06-15-én kivezetett** → a `/v1/messages` hívás retired modellre hibázik. Hatás: `llm-dependency` (arbmatrix tab) **halott**; `_resolution-risk` (crypto bot resolution-risk gate a combineren át) **csendben** a `fallbackScore` heurisztikára esett (nem crash, de az LLM-elemzés soha nem futott); `apex_wallet_profiler.py` CLI hibázott. **Fix:** env-felülírható `ANTHROPIC_MODEL` (default **`claude-sonnet-4-6`**, a hivatalos pótlás) mindhárom helyen — így a következő kivezetés csak konfig-váltás. Az `anthropic-version: 2023-06-01` fejléc továbbra is érvényes, változatlan. Fájlok: [llm-dependency.mts](../../services/api/src/routes/llm-dependency.mts) (+ félrevezető „DeepSeek-R1" komment javítva), [_resolution-risk.ts](../../services/api/src/routes/_resolution-risk.ts), [apex_wallet_profiler.py](../../apex_wallet_profiler.py).
- **P1 — Binance Futures fapi v2 → v3.** A [binance-trade.mts](../../services/api/src/routes/binance-trade.mts) `/fapi/v2/balance` + `/fapi/v2/positionRisk`-et használt — a Binance mindkettőt **deprecalta** (→ `/fapi/v3/*`). Web/doksi-verifikáció: a v3 válasz a v2 **szuperhalmaza**, minden olvasott mező (`positionAmt`/`entryPrice`/`markPrice`/`unRealizedProfit`/`leverage`/`balance`/`availableBalance`/`crossUnPnl`) megvan; a `positionAmt !== 0` szűrő kezeli a viselkedésbeli eltérést → biztonságos csere. (Csak LIVE-on aktív; paper short-circuit.)
- **Latens bekötési hiba — apex-profiler `x-api-key` hiány.** A `claude_analyze` Python-hívás soha nem küldött `x-api-key` fejlécet (az Anthropic doksi szerint kötelező) → a modelltől függetlenül 401-be futott. **Fix:** `os.environ` olvasás + `x-api-key` fejléc + korai visszatérés ha nincs kulcs (`import os` hozzáadva).

### Egészséges (verifikálva, változatlan)
Binance spot `/api/v3/*` (nem használ egy retired legacy `/api/v1/*`/userDataStream endpointot sem); Binance futures `/fapi/v1/{klines,premiumIndex,fundingInfo,order}`; Bybit v5 (endpoint + aláírási séma pontosan a spec, a 2026-os XAU/XAG/IP-whitelist/txn-log változások a crypto-perpeket nem érintik); Hyperliquid `/info` type-ok + `/exchange` SDK-delegált EIP-712; Polymarket Gamma/CLOB/Data (a `&closed=true` a resolution-úton, `closed=false` a scan-eken — helyes); Deribit (additív mezők); Open-Meteo/NOAA (zero-auth).

### Tudatosan NEM auto-javítva → sprints.md **B46–B48**
- **B46** — Polymarket offset→keyset lapozás (kivezetési pályán, de teljesen támogatott; sok hívóhelyet + cursor-refaktort érintő kockázatos változtatás).
- **B47** — HL SDK (`@nktkas/hyperliquid`) nincs deklarált függőségként (dinamikus import; LIVE-only, paper short-circuit fedi).
- **B48** — közös 429/rate-limit backoff helper (jelenleg csak HL `/info` retry-zik).

**Deploy:** nincs auto-deploy ebben a sessionben (a fixek a `main`-en; a boxra a következő deploy viszi). Az `ANTHROPIC_MODEL` env opcionális (default aktív modell), külön beállítás nélkül is helyesre vált.

### Follow-up (ugyanaznap) — B47 + B48 implementálva, B46 lezárva (user-kérés)

A user kérte a B46/B47/B48 elvégzését is (majd egy közös commitot). Eredmény (`tsc` exit 0 + **27/27 teszt** zöld):

- **B47 ✅ HL SDK deklarált függőség.** `npm install @nktkas/hyperliquid@^0.33.3 viem@^2.47.12 --save` → gyökér `package.json` + lockfile. A live HL adapter (`hl-client.mts`) eddig dinamikus `new Function("return import(...)")`-tel töltötte a signer SDK-t, deklaráció nélkül → LIVE-on néma import-hiba lett volna (paper short-circuit fedte). Futásidejű export-check: `HttpTransport`/`ExchangeClient` + `viem/accounts` `privateKeyToAccount` mind létezik; a konstruktor-alakok (`{isTestnet}`, `{transport,wallet}`) a jelenlegi API. Végső live-signing verifikáció → B10.
- **B48 ✅ 429/rate-limit backoff helper.** Új [`packages/core/src/fetch-retry.mts`](../../packages/core/src/fetch-retry.mts) — `fetchWithRetry`: exponenciális backoff + full jitter 429/5xx/network-hibára, `Retry-After`-tisztelet, per-attempt friss `AbortSignal.timeout`. **Idempotencia-biztos:** POST order csak 429-re retry-zik (pre-execution reject), 5xx/network SOSEM (double-fill ellen). Bekötve: `binance-trade.mts` + `bybit-trade.mts` wrapperek (GET teljes retry, POST 429-only) + `hedge-manager.mts` (exchangeInfo GET teljes; spot MARKET order 429-only). Új `fetch-retry.test.mts` (9 eset, injektált `_fetch`/`_sleep` — nincs valós hálózat/timer). A HL `/info` saját 1-retry-ja maradt.
- **B46 ⚪ NOT APPLICABLE.** A feltételezett offset-lapozás-deprecation nem áll fenn: `grep -ri "offset" services/**/*.mts` csak weather `city_offset`-et talál — egyetlen Gamma-hívás sem `offset`-lapoz; mind egyoldalas `order=volume24hr` top-N. Nincs mit keyset-re migrálni; cursor-refaktor tiszta churn lenne. Lezárva (később újranyílik, ha valódi lapozás kell).

**Commit:** a P0/P1/latens fixek + B47 + B48 + a teljes doksi egy commitban.

---

## 57. session — Rendszer-bővítés discovery (execution / portfólió / új edge-források)

A user kérése: *„discovery a netről alaposan legjobb gyakorlatok arra, ami alapján kereskedni akarok, mivel lehet még bővíteni a bot rendszert — alapos munka, vesd össze a kódommal és a kódból dolgozz."*

**Módszer:** 1 read-only kód-katalógus-ágens (a teljes `services/worker/pillars` + `packages/core` + `services/api/routes` fa — a monorepo-restruktúra utáni pontos leltár) + **8 párhuzamos webes kutató-ág** (Polymarket market-making/reward-farming, CLOB order-book/fill-realizmus, negRisk-arb, UMA-resolution-edge, cross-platform-arb, crypto-signal-források, portfólió/meta-labeling, backtest/execution-szigor, + sports/odds-data/weather/politics-LLM). Primer források (arXiv, hivatalos exchange/API-docs, GitHub, peer-reviewed); minden állítás kódra + forrásra verifikálva; skeptikus alapállás (hype explicit megjelölve). **Csak kutatás + doksi — kód nem változott, nincs deploy.**

**Kimenet:** új discovery-doksi [`roadmap/model-discovery-expansion.md`](../roadmap/model-discovery-expansion.md) — a [`model-discovery-forecasting.md`](../roadmap/model-discovery-forecasting.md) (B41) testvére. Míg az a predikciós/valószínűség-réteget vizsgálta (A-lépcső #1-#9 kész), ez a **maradék edge-t**: execution/portfólió/validáció/új-signal/domén.

**Központi tanulság:** a rendszer signalokat halmozott, de a bizonyítékok szerint a maradék profit három NEM-signal rétegben van:
- **(A) execution/fill-realizmus** — a paper-motor a vékony longshot-könyveket a kijelzett áron + teljes méretben tölti, holott a Polymarketen fordított favorite-longshot bias van (arXiv 2606.04217: 0,00-0,10 bucket átlaghozam −0,0023, Gini 0,970). **Két független ág egymástól függetlenül ezt tette #1-re.** Amíg ez nem valós, minden downstream statisztika fikció.
- **(B) a mérés-only kalibráció élesítése + walk-forward** — a Platt/AdaHedge/proper-scoring MEGVAN, de nincs live-re kötve; + PSR/MinTRL/DSR a valós track-recordon (honest trial-count!) + walk-forward scoring a prediction-ledgeren (a B11 Hetzner-mentes verziója).
- **(C) portfólió-szintű crypto-béta koncentráció** — crypto+HL+F-arb mind crypto-béta → hat „független" 8%-os tét = egy nagy korrelált BTC-pozíció (ENB valószínűleg ~2-3, nem 6). Shared-bankroll exposure-cap + ENB-monitor + vol-target/max-DD.

**Egyetlen erős új korrelálatlan signal:** OI-Δ × ár (natívan multi-coin → a BTC-hardcode leváltása is). **Domén-fixek** (weather EMOS/NGR-kalibráció az underdispersion ellen; sports Shin de-vig a fabrikált fair-value helyett + the-odds-api $30/hó feed) valósak de szűk plafonúak. **Skeptikus mentések:** negRisk/Σ-arb (3,6s korrekció, likviditás-cap), Kalshi cross-arb (semantic non-fungibility → csak read-only scanner), settlement-sniping (dispute-prémium), on-chain flows (gyenge+drága), **LLM likvid piacra = csapda** (a piaci ár veri az LLM-et; ugyanaz a fabrikált-fair-value hiba, ami a sportsot megölte). **Új üzletág-jelölt:** market-making/reward-farming (subsidy-harvesting, a meglévő orderflow/VPIN toxicitás-gate-ként újrahasznosítva; live-infra kell).

**Tracker:** [`sprints.md` B49](../roadmap/sprints.md#b49--rendszer-bővítés-discovery-execution--portfólió--új-edge-források--tracker) — a §5-§6 pontozott jelöltek operátor-jóváhagyásra várnak; az A-lépcső mind TS-now, a B-lépcső (auto-redeem/liq-cascade/MM) Hetzner+live-infra-blokkolt (B10).

---

## 58. session — B49 #1: depth-aware fill-modell (T1–T7) implementálva (default-OFF)

A user: *„start with #1, the depth-aware fill model … a többivel is mehetsz a javaslataid szerint. a feladatok után dokumentálás."* A discovery #1 konvergens találata (a hamis paper-PnL a vékony/longshot piacokon — a paper belépő teljes méretben, könyv-ellenőrzés nélkül tölt, majd a fantom share-ök settlementkor $1-t kapnak).

**Grounding (kódból):** [`crypto/execution.mts`](../../services/worker/src/pillars/crypto/execution.mts) `placeBuyOrder` paper-ág `filledShares = sizeUSDC/price` (teljes, cap nélkül) → [`crypto/paper-resolver.mts`](../../services/worker/src/pillars/crypto/paper-resolver.mts) `shares × outcome($1/$0)` − 3,6% lapos fee. A weather ugyanezt a `placeBuyOrder`-t hívja; a sports saját inline fill-t (`positionSizeUSDC/entryPrice`).

**Implementálva (mind: `tsc` exit 0 + 28/28 teszt + build zöld, NEM deployolva, `main`):**
- **T1 — pure fill-modell** [`packages/core/src/fill-model.mts`](../../packages/core/src/fill-model.mts): `simulateDepthFill(asks, requestedUsdc, {participationCap})` (ask-book walk, participáció-cap szintenként, VWAP entry, részleges fill, a nem-tölthető maradék eldobva); `fallbackFill` (√-law/flat haircut az adverse oldalon, ha nincs könyv — soha nem ingyen-teljes-fill); `sqrtLawImpact`; tick/min-size helperek (`defaultTickForPrice`, `snapDownToTick`, `isPriceOnTick`, `isFillValid`).
- **T2 — tesztek** [`fill-model.test.mts`](../../packages/core/src/fill-model.test.mts): 8 csoport (teljes fill, 2-szintű VWAP, partial, 5¢-longshot $200→100 share [nem 4000], üres könyv, fallback-haircut, √-law, tick/min-size).
- **T3 — keyless book-fetch** [`shared/clob-book.mts`](../../services/worker/src/pillars/shared/clob-book.mts): public CLOB `/book`, 5s timeout, hiba→null (a signal-combiner orderflow mintája).
- **T4 — bekötés** `placeBuyOrder`-be új `fillOpts` param mögött; ON-nál book→`simulateDepthFill`→(thin/nincs) fallback→min-size gate; a `record.price=VWAP`, `size=filledUsdc`, `filledShares` a valós fill; min alatt → `REJECTED` (a runner „failed"). **OFF → bit-azonos legacy.** Crypto ([`pillars/index.mts`](../../services/worker/src/pillars/index.mts)) + weather ([`weather/index.mts`](../../services/worker/src/pillars/weather/index.mts)) átadja a knobokat; új shared `getEffectiveFillOpts()`.
- **T5 — tick/min-size:** a min-order-size gate a `placeBuyOrder`-ben (`isFillValid`, default 5 share); a per-market élő `/tick-size` fetch a live-útra follow-up (jelenleg hardcode `0.01`).
- **T6 — fee dupla-számolás fix:** a paper-resolver ON-nál **exit-only** fee-t számol (`settlementFeePctFillModel` default **0,015**), mert a belépő slippage már a VWAP costBasis-ban van; OFF → a legacy 0,036 roundtrip. A decision-engine net-edge gate-je változatlan (3,6% hurdle) → az entry-döntések ON/OFF alatt azonosak → tiszta A/B a fill-realizmusra.
- **T7 — sports** ([`sports/index.mts`](../../services/worker/src/pillars/sports/index.mts)): a saját inline fill a book+`simulateDepthFill`-lel felülírja a `shares/avgEntry/costBasis`-t; thin→skip. (HL/F-arb kimarad — mély perpek.)

**Knobok:** `fillModelEnabled` (0/1, default **0**) + `fillParticipationCap` (default **0,20**) a `trader-settings` SCHEMA-ban (category `common`, group „Execution (paper fill)"). Env: `FILL_MODEL_ENABLED`, `FILL_PARTICIPATION_CAP`, `SETTLEMENT_FEE_PCT_FILL_MODEL` → [`env-vars.md`](../current-state/env-vars.md).

**Measure-first / default-OFF:** OFF = 0 regresszió. Élesítés: knob ON → prediction-ledger + proper-scoring (Edge Tracker) raw-vs-fill Brier/log-score + a < 0,10 bucket realizált hozam összehasonlítása; a várt eredmény a túl-jóváírt PnL eltűnése (NEM új edge — a longshot strukturálisan veszít, arXiv 2606.04217), a modell értéke a HŰ PnL.

**Maradó (B49 alatt):** T6 fee-finomhangolás méréssel; élő per-market `/tick-size`; crypto korai TP/SL exit bid-walk (`handleSellLifecycle`); weather reconciler fee-parity → B35. Doksi: [`math/18-fill-model.md`](../math/18-fill-model.md).

---

## 59. session — B49 #2: crypto-beta exposure cap (portfólió-réteg) implementálva (default-OFF)

A user: „go ahead with #2, the crypto-beta exposure cap". A discovery #2 strukturális találata: a per-bot 8%-os capek nem látják, hogy a **crypto + HL directional mind crypto-béta** → 6 „független" tét egyetlen korrelált BTC-pozíció (barbell). A user password-jét (fill-modell élesítés) **nem** használtam fel (credential-szabály — az operátornak kell a Settings-ben flippelnie), + a fill-modell amúgy is deploy-precondition (a box a régi kódot futtatja).

**Grounding (kódból):** minden bot külön `loadSession`/`loadHlSession` + saját ¼-Kelly; nincs portfólió-réteg. HL pozíció `sizeUSDC` (notional) + `leverage`; crypto pozíció `costBasis`.

**Implementálva (mind: `tsc` exit 0 + 29/29 teszt + build zöld, NEM deployolva, `main`):**
- **Pure modul** [`packages/core/src/portfolio-exposure.mts`](../../packages/core/src/portfolio-exposure.mts): `cryptoExposureUsd` (Σ costBasis), `hlExposureUsd` (Σ sizeUSDC/leverage = **margin, nem levered notional** → a két bot commensurate egy bankroll-hányad cap alatt), `checkBetaCap` (fail-open degenerált inputon). 5-csoportos [teszt](../../packages/core/src/portfolio-exposure.test.mts) (crypto/HL exposure, under/at/over cap, fail-open, barbell-eset).
- **Cross-bot loader** [`shared/portfolio-exposure.mts`](../../services/worker/src/pillars/shared/portfolio-exposure.mts): crypto + HL persisted session snapshot. **F-arb KIZÁRVA** (delta-neutrális → directional béta ≈ 0), weather kizárva.
- **Config** [`shared/config.mts`](../../services/worker/src/pillars/shared/config.mts) `getEffectiveBetaCap()` + SCHEMA common knobok `betaCapEnabled` (0/1 default **0**) + `betaCapFraction` (default **0,25**, range 0,05–1,0), group „Portfolio risk". Env `BETA_CAP_ENABLED`/`BETA_CAP_FRACTION`.
- **Bekötés:** crypto ([`pillars/index.mts`](../../services/worker/src/pillars/index.mts)) + HL ([`hyperliquid/index.mts`](../../services/worker/src/pillars/hyperliquid/index.mts)) runner belépő-előtti check. A saját bot exposure-je a **LIVE** session-ből (intra-tick opens is számítanak), a másiké a tick-eleji snapshotból; prospective = crypto costBasis / HL margin; átlépés → skip a cap-reason-nel. **OFF → no-op.**

**Miért gross-capital + default OFF:** a v1 a bruttó lekötött crypto-directional tőkét capeli (nem a signed BTC-deltát — a NO@above-K nem lineáris short; a bruttó a konzervatív, „mennyi tőke van egyszerre crypto-irányra kötve" mérték, pontosan a barbell-aggodalom). Blokkoló gate → measure-first / operator opt-in. **NEM mond ellent Sprint-45-nek** (cap-réteg a per-bot bankrollok fölé, nem bankroll-újraegyesítés).

**Maradó (B49):** multi-status UI crypto-beta utilization mező; signed-net exposure; a §4.C további tételei (#8 vol-target/max-DD kill-switch, #9 ENB diverzifikáció-monitor). Doksi: [`math/19-portfolio-exposure-cap.md`](../math/19-portfolio-exposure-cap.md).

---

## 60. session — B49 #3: robust Sharpe (PSR / MinTRL / DSR) validációs réteg (advisory + gates default-OFF)

A user: „go ahead with #3 és mondjad, hogy mit csináljak amikor én jövök". A discovery #3: a rendszer forward-recordon validál; a két torzítás (kis-minta/fat-tail + config-hunting) forward-native eszközökkel korrigálható — nem kell backtest-motor.

**Grounding (kódból):** `computeSummary` már ad per-trade `returns` + Sharpe + bootstrap-CI-t, de nincs PSR/skew/kurtosis; a `live-readiness` fix „30 trade" küszöböt használ; a knob-változásoknak nincs nyoma (DSR N-je).

**Implementálva (mind: `tsc` exit 0 + 30/30 teszt + build zöld, NEM deployolva, `main`):**
- **Pure modul** [`packages/core/src/sharpe-robust.mts`](../../packages/core/src/sharpe-robust.mts): `probabilisticSharpe` (PSR = Φ[(SR−SR*)·√(n−1)/√(1−skew·SR+((kurt−1)/4)·SR²)]), `minTrackRecordLength` (∞ ha SR≤benchmark), `expectedMaxSharpe` (best-of-N luck), `deflatedSharpe`, `skewness`/`kurtosis` (nyers, normál=3), `normalCdf`/`normalInv` (Acklam). 6-csoportos [teszt](../../packages/core/src/sharpe-robust.test.mts). Kurtózis-konvenció ellenőrizve: `(kurt−1)/4` nyers kurtózissal (Bailey/LdP).
- **`computeSummary`** ([statistics.mts](../../packages/core/src/statistics.mts)) új mezők: `returnSkew`, `returnKurtosis`, `psr` (P(SR>0)), `minTrl` (95%-hoz kellő trade-szám; 999999 = ∞, JSON-biztos). A nyers per-trade Sharpe-ból (nem a kerekített display-ből).
- **Edge Tracker UI** ([EdgeTrackerPanel.tsx](../../apps/web/src/components/EdgeTrackerPanel.tsx)): 2 új KPI-kártya (PSR, MinTRL vs a meglévő trade-szám), szín-kódolva (PSR ≥95% zöld; MinTRL zöld ha elég trade van, piros ha ∞).
- **Live-readiness** ([live-readiness.mts](../../services/worker/src/pillars/shared/live-readiness.mts)): a summary mindig hordozza `psr`/`minTrl`/**`dsr`**/`trialsCount`; két **opt-in** kapu — `minPsr` (PSR ≥ küszöb) + `useMinTrl` (trade-szám ≥ MinTRL, az önkényes fix 30 helyett). σ_SR proxy = a bootstrap-CI félszélessége. DSR a honest-trial N-nel.
- **Honest-trial DSR** ([trader-settings.mts](../../services/api/src/routes/trader-settings.mts)): minden knob-változás egy „trial" → `appendTrial(changedKeys)` a POST-ban (`trader-trials` store, cap 1000), `countTrials()` adja az N-t; a crypto runner + a status-út tickenként betölti és átadja a readiness-nek. Common knobok `liveReadyMinPsr` (default 0) + `liveReadyUseMinTrl` (0/1 default 0).

**Miért advisory / opt-in:** a PSR/MinTRL mindig látszik (mérés), de a live-kapuk default OFF (blokkoló gate = viselkedés-változtató, + live-flip B10-blokkolt). A MinTRL a helyes „kész-e?" szám (fat-tailű longshot-botnál több száz trade). A honest N rendszer-szintű (a knobok cross-bot) — egy közelítő N a helyes korrekció.

**Maradó (B49):** valódi cross-config σ_SR (a Sharpe mentése trial-határokon); per-kategória trials; HL saját status-út readiness; a **#4 walk-forward scoring a ledgeren** (a validációs réteg másik fele). Doksi: [`math/20-robust-sharpe.md`](../math/20-robust-sharpe.md).

### Deploy + CI/CD (2026-09-03, ugyanaznap)

- **A B49 #1–#3 + a discovery DEPLOYOLVA a Hetzner boxra** (`trade.jmeszaros.dev`, paper). A box NEM auto-deployol (a régi „push→deploy" a **Netlify** volt, ami a main-en törött) → **kézi deploy SSH-n**: `ssh analytics` (root@91.99.218.165, `analytics_ed25519` kulcs) → `cd /opt/edgecalc && git pull --ff-only && docker compose up -d --build`. A box `83c76bf`→`51885a4`-re fast-forwardolt; api+workers újraépítve+újraindítva, model healthy. Verifikálva: mind az 5 új knob él a live schema-ban (`fillModelEnabled`/`fillParticipationCap`/`betaCapEnabled`/`liveReadyMinPsr`/`liveReadyUseMinTrl`), a knobok **default-OFF** → 0 viselkedés-változás. Memória: `hetzner-box-deploy`.
- **Új CI/CD:** [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) — tsc + 30/30 teszt + build minden push/PR-en (első futás zöld); megelőzi a B19-osztályú néma deploy-gap-et. [`.github/workflows/deploy.yml`](../../.github/workflows/deploy.yml) — SSH auto-deploy (workflow_run CI-siker után) — **ÉL (2026-09-03)**: `DEPLOY_HOST`/`DEPLOY_USER=root`/`DEPLOY_KNOWN_HOSTS`/`DEPLOY_SSH_KEY` secretek beállítva + a `edgecalc_deploy.pub` felvéve a box root `authorized_keys`-ébe → **end-to-end verifikálva** egy sikeres `workflow_dispatch` futással (SSH → git pull → compose up → success). **Mostantól: push main-re → CI zöld → a box magától deployol.** A kézi `ssh analytics` deploy fallbackként megmarad.
- **Operátor-teendő a méréshez:** Settings (bejelentkezve) → *Execution (paper fill)* → `fillModelEnabled=1`, opcionálisan *Portfolio risk* → `betaCapEnabled=1`. A PSR/MinTRL magától látszik az Edge Trackeren.

### 61. session — B49 #4: walk-forward scoring a prediction-ledgeren (model vs market, OOS, mérés-only)

A user: „menj tovább a #4-el". A #3 párja — a validációs réteg másik fele. A kérdés: a bot valószínűségei verik-e a **piaci árat** out-of-sample, konzisztensen az időben? (Ha nem, az edge illúzió — a leakage-aware kutatás szerint a puszta ár veri az LLM-et a likvid piacokon.)

**Grounding:** a prediction-ledger a helyes szubsztrátum — minden szkennelt piac P(YES)-ét logolja (taken+skipped, torzításmentes) `outcome` (0/1) + `resolvedAt`-tal; a `marketPrice` a baseline.

**Implementálva (mind zöld, NEM deployolva a doksi-írásakor):**
- **Pure modul** [`packages/core/src/walk-forward.mts`](../../packages/core/src/walk-forward.mts): `ledgerPointsFromRecords` (feloldott rekordok kiszűrése; `Number(null)===0` csapda kivédve) + `computeWalkForward` (rezolúciós-idő szerint rendez → kronológiai blokkok → blokkonként+poololva **Brier skill vs piaci ár** + log-loss + konzisztencia [hány blokk veri a piacot] + korrelációs caveat `effectiveDays`/`maxDayShare`). Scoring-only → nincs train/test leakage. 7-csoportos [teszt](../../packages/core/src/walk-forward.test.mts).
- **Bekötés:** [`edge-tracker.mts`](../../services/api/src/routes/edge-tracker.mts) `walkForward` mező (a ledgerStats-hoz amúgy is betöltött rekordokból; `category=all`-nál poololt) + új **`WalkForwardCard`** az [`EdgeTrackerPanel.tsx`](../../apps/web/src/components/EdgeTrackerPanel.tsx)-en (overall Brier skill + per-blokk skill-sávok + caveat).
- **Nincs új knob/env/live-döntés** — tisztán diagnosztika. A **B11 (walk-forward backtest) Hetzner-mentes, backtest-motor-mentes verziója.**

**Hogyan olvasd:** Brier skill > 0 + magas konzisztencia → a bot valószínűségei valóban jobbak a piaci árnál OOS (valid stratégia-mag); skill ≤ 0 → a piac a jobb előrejelző (a profit nem a predikcióból jön); magas `maxDayShare` → korrelált nap dominál, óvatosan.

**Maradó (B49):** purge/embargo korrelált klaszterekre; anchored-fit walk-forward a #2 Platt-kalibrációval; per-kategória UI-bontás. Doksi: [`math/21-walk-forward.md`](../math/21-walk-forward.md).

**B49 A-lépcső állás:** #1 ✅ · #2 ✅ · #3 ✅ · #4 ✅ — hátra: #5 OI-Δ signal, #6 weather EMOS, #7 sports Shin de-vig, #8 vol-target/max-DD, #9 ENB monitor.

### 62. session — B49 #5: OI-Δ × price signal (a 9. combiner-signal, default-OFF)

A user: „aztán mehetsz az 5-ös csomagra". A discovery TOP új **korrelálatlan** signalja: az open-interest változása × ármozgás (leverage-flow kvadráns) — ortogonális az orderflow-val (pozíció-életciklus vs passzív könyv), natívan multi-coin.

**Implementálva (mind zöld):**
- **Pure modul** [`packages/core/src/oi-delta.mts`](../../packages/core/src/oi-delta.mts): `classifyOiQuadrant` (fresh_longs/short_covering/fresh_shorts/long_unwind/neutral) + `oiDeltaProb` (emelkedő OI megerősíti a mozgást → teljes tilt; csökkenő OI gyengíti → `confDampen` 0.3×; clamp [0.05,0.95]). 5-csoportos [teszt](../../packages/core/src/oi-delta.test.mts).
- **Combiner-bekötés** ([signal-combiner.mts](../../services/api/src/routes/signal-combiner.mts)): `parseCoinSymbol` (multi-coin: BTC/ETH/SOL/XRP/DOGE/AVAX/BNB), `getOiDeltaSignal` (Binance `openInterestHist` 5m×7 + `klines` → oiChange/priceReturn → oiDeltaProb; knob-gate `oiDeltaEnabled` → **null OFF-nál → combine elejti → 8-signal output bit-azonos**), `SIGNAL_ICS.oi_delta=0.07`, **K_BLIND_SIGNALS** bővítés (strike-blind → threshold-downweight), `raw_signals.oi_delta`, `SignalBreakdown.oi_delta?` opcionális ([types.mts](../../packages/core/src/types.mts)).
- **Knob:** `oiDeltaEnabled` (0/1 default 0, common/„Signal toggles"). Settings-only.

**Anti-overfit tiszteletben tartva:** a `new-strategies.md` szabálya szerint a combiner nem nő live-ban 200 trade előtt → default-OFF, measure-first. Élesítés: knob ON → Edge Tracker realized-IC + #4 walk-forward igazolja a korrelálatlan edge-et.

**Maradó (B49):** BTC-hardcode teljes leváltása (vol_div/funding a threshold-combinerben → new-strategies #3); funding cross-section percentilis (#17); window-tuning. Doksi: [`math/22-oi-delta.md`](../math/22-oi-delta.md).

**B49 A-lépcső: #1–#5 ✅; hátra #6 weather EMOS, #7 sports Shin de-vig, #8 vol-target/max-DD, #9 ENB monitor.**

### 63. session — B49 #6: weather EMOS/NGR kalibráció (apply default-OFF, residual-log mindig-on)

A user: „aztán mehetsz az 5-ös csomagra" → #5 után #6. A weather „jó irány (forecast_edge IC +0.39), rossz sizing" gyökér-oka az ensemble-**underdispersion** (túl kicsi σ → tail-túlbizakodottság → a Kelly a legmagabiztosabb téves tétre méretez). Fix: σ-kalibráció (EMOS/NGR, Gneiting 2005).

**Implementálva (mind zöld):**
- **Pure modul** [`packages/core/src/emos.mts`](../../packages/core/src/emos.mts): `gaussianCrps` (zárt-alak CRPS), `emosApply` (μ=a+b·ensMean, σ²=c+d·ensVar, varFloor → σ-infláció), `fitEmos` (two-step OLS: átlag-regresszió + reziduál-variancia-regresszió; identity fallback <20 minta; rawCrps→calibratedCrps a nyereség-mérésre), `observationRank`. 6-csoportos [teszt](../../packages/core/src/emos.test.mts).
- **Adat-pipeline** [`weather/emos-store.mts`](../../services/worker/src/pillars/weather/emos-store.mts): `logForecast` (minden scannelt állomás+dátum → torzításmentes), `reconcileEmosObs` (**METAR-alapú** obs-fill a lejárt residualokra + refit — NEM trade-függő → unbiased), `loadStationEmosParams`. Blobs `weather-emos`, per-állomás, cap 400.
- **Bekötés** [`weather/index.mts`](../../services/worker/src/pillars/weather/index.mts): a `matchBucket` előtt log+reconcile MINDIG fut (adat-óra, best-effort, non-throwing); az EMOS-apply csak `config.useEmos` ON + fittelt map esetén cseréli a (μ,σ)-t. Config `useEmos` + env `WEATHER_USE_EMOS` + `weatherUseEmos` SCHEMA-knob (0/1 default 0, weather).

**Fontos:** a trading-viselkedés OFF-nál **változatlan** (a bucket-matcher a nyers μ,σ-t kapja); csak a háttér-residual-logolás + METAR-reconcile fut (mint a prediction-ledger — a point-in-time forecast/obs pár nem rekonstruálható később, ezért indul most). Élesítés: `weatherUseEmos=1` + ≥20 feloldott residual/állomás után; a fit `rawCrps→calibratedCrps` + a #4 walk-forward mutatja a nyereséget.

**Maradó (B49):** full CRPS-minimum estimation; rank-histogram az Edge Trackerre; per-évszak fit; Open-Meteo multi-model blend. Kötődik B15/B35/B40. Doksi: [`math/23-emos.md`](../math/23-emos.md).

**B49 A-lépcső: #1–#6 ✅; hátra #7 sports Shin de-vig, #8 vol-target/max-DD, #9 ENB monitor.**

### 64. session — B49 #7: sports Shin de-vig (a legjobb FLB-kalibráció; a matek kész, az odds-feed a maradó adat-task)

A user: „aztán mehetsz az 5-ös csomagra" → sorban #7. A sports „fair value" fabrikált (a PM-árat 0.5 felé húzza → megőrzi a favorite-longshot bias-t → ~90% bukás). A sports-kutatás szerint a **Shin** a legjobban kalibrált de-vig (Štrumbelj 2014); a multiplicative a legrosszabb (FLB-t őriz).

**Implementálva (mind zöld):**
- **`devigShin`** a meglévő [`packages/core/src/devig.mts`](../../packages/core/src/devig.mts)-ben: insider-frakció z modell, `p_i(z) = [√(z²+4(1−z)·q_i²/B) − z]/(2(1−z))`, bisekció z-re (Σp=1); fallback power-re, ha nincs margin/gyök. `DevigMethod += "shin"`, `twoWayFairYes(...,"shin")`.
- **Teszt:** a [devig.test.mts](../../packages/core/src/devig.test.mts) Shin-blokkal (összeg=1, no-vig fallback 50/50, FLB-korrekció favorite>multiplicative, 3-way, heavy-fav).

**A fogyasztó kész, a termelő hiányzik:** a [sports/decision-engine.mts](../../services/worker/src/pillars/sports/decision-engine.mts) már használja a `market.pinnacleFairYes`-t (`sportsUsePinnacle` knob) a #9 óta — de **semmi nem tölti fel** (nincs odds-feed). Ezért a #7 kód-része a Shin-matek; a **live tüzeléshez a B37 adat-task kell**: the-odds-api (`region=eu`=Pinnacle, `ODDS_API_KEY`, $30/hó) + Polymarket↔Pinnacle **event-matching** (a nehéz 80%) → `twoWayFairYes(...,"shin")` → `pinnacleFairYes`. Ez külső kulcsot + matching-motort igényel → nem tesztelhető live nélkül, ezért adat-taskként tracked (B37/B44).

**Skeptikus:** a de-viggelt Pinnacle-close a marginig hatékony → nincs residual edge Pinnacle ellen; az edge csak a laggos PM-ár rése (szűk, likviditás-cap). A Shin megállítja a ~90% vérzést, de nem gyárt nagy edge-t. Amíg az odds-feed nincs, a sports maradjon leállítva.

**Maradó (B49/B37/B44):** odds-feed + event-matching; CLV-KPI; NO-oldali leg-mismatch + fee-parity; freshness-gate. Doksi: [`math/24-sports-devig.md`](../math/24-sports-devig.md).

**B49 A-lépcső: #1–#7 ✅ (a #7 matek-kész, odds-feed-gated); hátra #8 vol-target/max-DD, #9 ENB monitor.**

### 65-66. session — B49 #8 (risk overlays) + #9 (ENB monitor) → az A-lépcső TELJES

A user: „aztán mehetsz az 5-ös csomagra" → sorban a maradék. Két portfólió-szintű tétel.

**#8 — risk overlays (vol-target + DD kill-switch), default-OFF.** Új pure modul [`packages/core/src/risk-overlay.mts`](../../packages/core/src/risk-overlay.mts) (`realisedVol`, `volTargetMultiplier` [clamp cél/realizált-vol], `drawdownKill` [peak-to-current, fail-open]) + 4-csoportos teszt. Bekötve a crypto runnerbe: a DD-kill (peak a closed-trade equity-görbéből) halt-olja az új belépőt; a vol-target skálázza a `sizeUSDC`-t (a beta-cap/#1-fill/entry-snapshot/alert konzisztensen a skálázott méretet kapja). Knobok `riskVolTargetEnabled`/`riskVolTarget`/`riskDdKillEnabled`/`riskMaxDdFraction` (common). OFF → bit-azonos. A DD-kill a B33 (peak-equity stop) elvi változata. Doksi: [`math/25-risk-overlay.md`](../math/25-risk-overlay.md).

**#9 — ENB diverzifikáció-monitor, mérés-only.** Új pure modul [`packages/core/src/enb.mts`](../../packages/core/src/enb.mts) (`correlationMatrix` + `jacobiEigenvalues` + `effectiveNumberOfBets` = sajátérték-entrópia effektív rang) + 7-csoportos teszt (barbell: 4 bot de ENB≈2). Bekötve az [`edge-tracker.mts`](../../services/api/src/routes/edge-tracker.mts)-be: minden bot napi-PnL sorozata → korreláció → ENB (`enb` mező) + `EnbCard` (ENB/N, diverzifikáció %, top-faktor %, koncentráció-warning). Megmondja, hány **független** tét valójában a 6 bot (a crypto-béta koncentráció mérőszáma → igazolja a #2 capet). 0 trading-hatás. Doksi: [`math/26-enb.md`](../math/26-enb.md).

`tsc` exit 0 + **35/35 teszt** + build zöld.

### UX — dedikált „Közös beállítások" felület + de-dup (operátor-kérés)

A user észrevette: a `common` (minden botra kiterjedő) knobok **minden bot Settings-fülén** megjelentek (duplikáció → úgy nézett ki, mintha per-bot lenne). Fix: **de-dup** — a [`SettingsPanel.tsx`](../../apps/web/src/components/SettingsPanel.tsx) szűrője (interaktív + read-only nézet) mostantól **csak a saját kategória** knobjait mutatja (a `common`-on-minden-auto-trader-fülön logika törölve); + **dedikált felület**: új `global` pseudo-kategória ([`CategoryDashboard.tsx`](../../apps/web/src/components/CategoryDashboard.tsx) + [`trade/[category].astro`](../../apps/web/src/pages/trade/[category].astro) statikus út) egyetlen „⚙ Közös beállítások" füllel, ami a `SettingsPanel category="common"`-t rendereli; + HomePage-kártya (`/trade/global/`). Így a fill-modell / portfólió-risk / risk-overlay / OI-Δ / live-readiness / Bonferroni egy helyen, egyetlen értékként állítható; a bot-specifikus knobok (weather EMOS, crypto edge-threshold, HL leverage…) a bot-füleken maradnak. `tsc` exit 0 + 35/35 teszt + build zöld (11 oldal).

**🎉 B49 A-lépcső (#1–#9) TELJES:** #1 depth-aware fill · #2 crypto-béta cap · #3 PSR/MinTRL/DSR · #4 walk-forward scoring · #5 OI-Δ signal · #6 weather EMOS · #7 sports Shin de-vig · #8 vol-target/DD-kill · #9 ENB monitor. Mind pure-core + teszt + bekötés + doksi (math/18–26), default-OFF/mérés-first. **Maradó a méréshez:** a knobok élesítése + adat-gyűjtés (fill/beta/OI ON → Edge Tracker realized-IC/proper-score/walk-forward/ENB összevetés); sports odds-feed (B37); a B-lépcső Hetzner/live-precondition.

## A nap commitjainak audit-passza (hatékonyság + biztonság + megvalósítás) → 9 fix

A user kérése: **auditáld a teljes mai commitolt kódot** (hatékonyság / biztonság / megvalósítás), a hibákat javítsd, majd commit + push a mainre. **Módszer:** 4 párhuzamos read-only audit-ágens a `3dcc24e..HEAD` diffen (88 fájl, ~4800 sor: B49 #1–#9 + CI/deploy + provider-wiring + session-audit-batch): (A) security (auth/trade-endpointok/CI/fetch-retry), (B) új pure-core matek (fill/oi/portfolio/risk/sharpe/walk-forward/enb/emos/devig), (C) worker-pillér integráció (default-OFF → bit-azonos garancia), (D) API-route-ok + infra. Minden találat kódra verifikálva. **Verdikt: 0 P0/P1** — a default-OFF gating helyesen bit-azonos, a fill-retry idempotens (order POST csak 429-re, execution előtt), az auth-hardening ép. A találatok P2/P3 hatékonyság/robusztusság; a talált **9-et javítottam** (`tsc` exit 0 + **35/35 teszt** + build zöld):

- **P2 hatékonyság — weather EMOS reconcile fan-out** ([`weather/index.mts`](../../services/worker/src/pillars/weather/index.mts)): a `reconcileEmosObs` (per-hívás ≤6 METAR-fetch) a per-market ciklusban futott minden scannelt piacra, EMOS-OFF esetén is → N piac ≈ 6·N hálózati kör. Fix: per-tick `Set<icao>` guard → állomásonként **egyszer** reconcile-el (a `logForecast` inline marad, olcsó upsert; a residual-log adat-óra szándékosan mindig fut).
- **P2 korrektség — migration atomicitás** ([`migrate.ts`](../../packages/core/src/migrate.ts)): az `asTxDb(db)` a production `pool()` valódi client-checkout `tx()`-ét eldobta és Pool-on futtatott BEGIN/COMMIT-ot (külön kliensek → nem atomi). Fix: ha a `db` már hordoz `.tx`-et, azt használja; csak sima Db-t (PGlite-teszt) wrappel.
- **P2 hatékonyság + korrektség — edge-tracker ENB** ([`edge-tracker.mts`](../../services/api/src/routes/edge-tracker.mts)): az ENB-kártya mind a 6 store-t **újra** betöltötte (a summary-load duplikációja, ~12 session-load/kérés), és mindig `paperKey`-t olvasott a `mode` figyelmen kívül hagyásával (live/both nézetben paper-korrelációt mutatott). Fix: a szűrés előtt snapshotolt, **mode-tudatos** `unfilteredTrades`-et kategóriánként csoportosítja → nulla plusz store-olvasás + konzisztens paper/live/both.
- **P3 korrektség — DSR σ_SR fallback** ([`sharpe-robust.mts`](../../packages/core/src/sharpe-robust.mts)): a `deflatedSharpe` docstringje ígérte az |SR|-frakció fallbacket, de a kód nem valósította meg → rövid rekordon (degenerált bootstrap-CI → σ_SR proxy 0) a DSR némán sima PSR-vs-0-ra esett. Fix: σ_SR≤0 → `0.5·|SR|` konzervatív spread. + PSR-degenerált guard: a nyers variancia-tag ≤ 0 (extrém skew/kurtosis kis mintán) → semleges **0.5**, nem telített hamis-magabiztos ~0/~1. +2 pinned teszt (E[maxSR] referencia + fallback/guard).
- **P3 korrektség — appendTrial túl-számolás** ([`trader-settings.mts`](../../services/api/src/routes/trader-settings.mts)): a DSR trial-számláló a nyers submitet a pruned store-hoz hasonlította → default-értékre állított knobok is trialnak számítottak (preset újra-alkalmazása felfújta a deflation-count-ot). Fix: pruned-vs-pruned szimmetrikus diff.
- **P3 biztonság — login rate-limit Map-cap** ([`auth.mts`](../../services/api/src/routes/auth.mts)): az X-Forwarded-For-rotáció korlátlanul növelte a `LOGIN_ATTEMPTS` Map-et (memória-DoS). Fix: 10k-cap fölött lejárt-entry sweep + legrégebbi eviction. (Az XFF-forrás megbízhatóvá tétele Caddy `trusted_proxies` — infra-feladat.)
- **P3 robusztusság — session-delete tranzakció** ([`blobs-compat.ts`](../../packages/core/src/blobs-compat.ts)): a 3 normalizált DELETE (reset) tranzakció nélkül futott → köztes hibán részleges állapot. Fix: atomi `tx()` ha elérhető, egyébként szekvenciális fallback.
- **P3 biztonság — deploy.yml secret env-en át** ([`.github/workflows/deploy.yml`](../../.github/workflows/deploy.yml)): a „check secrets" lépés `${{ secrets.DEPLOY_HOST }}`-ot közvetlenül a shellbe interpolálta; env-változóra átvezetve.

**Verifikált téves riasztás:** az `ANTHROPIC_MODEL` default `claude-sonnet-4-6` a claude-api referencia szerint **érvényes, aktuális modell-id** (nem kell javítani — a mai `857949a` helyesen cserélte a retired `claude-sonnet-4-20250514`-et). **Szándékos, nem-hiba:** a B36 kelly-remap / sports edge-frame / HL calibration-mapping / HL mainnet-read fixek default-gate nélkül élesednek — ezek a session-audit-batch korrektség-fixei (paper + leállított sports → alacsony blast-radius). **Follow-up (sprints):** paper-resolver fee-mode a pozíció nyitáskori állapotára stampelve (A/B-tisztaság toggle-váltáskor), XFF trusted-proxy Caddy-config.

## Deploy pipeline: box-side git pull → rsync-from-runner (B opció)

A doc-commit (`3ff6646`) Deploy-ja piros lett: a box `git pull`-ja **GitHub anonim-HTTPS git rate-limitbe** futott (a repo publikus, de a mai ~6 deploy/óra túllökte a box IP anonim limitjét → HTTP 401 „could not read Username"). A CI végig **zöld** volt — csak a Deploy job bukott. A pull kézzel újrafutott (a limit lecsengett → box HEAD `3ff6646`, docs-only → nincs rebuild).

**Tartós fix (user: „Option B"):** a [`deploy.yml`](../../.github/workflows/deploy.yml) mostantól a runneren `actions/checkout`-ol (a CI-validált `head_sha`) és **rsync-eli** a fát a boxra (`rsync -rlptz --delete`), majd SSH `docker compose up -d --build`. Nincs box-oldali GitHub-auth → nincs anon-limit. A `--delete` a commit tükre, de a box-lokális git-ignorált állapotot **kizárja átvitelből ÉS törlésből** (`.env`/`.env.save` titkok, `data/` = model-cache bind-mount, `logs/`, `dist/`, `.git/`, `.claude/`); + post-rsync `.env`-exists őr (titok nélkül nem indít újra). **Verifikálva end-to-end** (`80f6caf` push → CI zöld → Deploy **success**; `.env` byte-azonos/érintetlen, `data`/`logs` megőrizve, publikus HTTP 200). Memória: `hetzner-box-deploy` frissítve.
