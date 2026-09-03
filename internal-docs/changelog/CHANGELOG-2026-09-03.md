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
