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
