# EdgeCalc – CLAUDE.md

Ez a fájl Claude Code számára készült. Minden fejlesztési session elején olvasd el.

---

## ⚠️ KÖTELEZŐ SESSION-ZÁRÓ SZABÁLY

**Minden session végén frissíteni kell a dokumentációt.** Ez nem opcionális.

Mielőtt a sessiont lezárod (utolsó válasz a usernek), végezd el az alábbi ellenőrző listát:

1. **CLAUDE.md `AKTUÁLIS ÁLLAPOT` szekció** – ha bármi élő rendszerállapot változott (működő/hibás tabok, ismert bugok, deploy státusz), frissítsd a dátummal együtt (`AKTUÁLIS ÁLLAPOT (YYYY-MM-DD)`).
2. **`internal-docs/` érintett fájlok** – ha egy tab/function/algoritmus logikája változott, frissítsd a hozzá tartozó markdown fájlt (pl. `06-orderflow.md`, `08-apex-wallets.md`).
3. **`internal-docs/changelog/`** – minden nem-triviális változásnál hozz létre vagy egészíts ki egy `CHANGELOG-YYYY-MM-DD.md` fájlt: mit változtattál, miért, melyik fájl(ok)ban.
4. **Új tab vagy function** – kötelezően új `internal-docs/NN-name.md` fájl + bejegyzés a `README.md`-ben + a CLAUDE.md tab-táblázat bővítése.
5. **TODO / Hiányos implementációk** – ha új technikai debt keletkezett vagy egy meglévő megoldódott, frissítsd az `Ismert limitációk és TODO-k` szekciót.

**Ha nem volt érdemi változás** (csak kérdés/olvasás történt), akkor sem kell üres commit – de mondd ki explicit a session végén: *"Nincs dokumentáció-frissítés szükséges, mert csak X történt."*

**Ha a felhasználó megszakít** (pl. új feladatra vált) a session zárása előtt: a következő érdemi commit előtt mindenképpen pótolni kell az elmaradt doc-frissítést.

---

## Mi ez a projekt?

**EdgeCalc** egy kvantitatív Polymarket trading dashboard.  
**Nem** copy-trade bot, **nem** affiliate platform.  
Matematikai alapú saját implementáció akadémiai irodalom alapján.

**Stack:** Astro 5 + React 18 + TypeScript + Netlify Functions + Tailwind CSS  
**Python:** 4 standalone CLI script lokális elemzéshez  
**Verzió:** v8

---

## Mappaszerkezet

```
edge-calc/
├── src/
│   ├── components/          ← 8 React komponens (egy tab = egy fájl)
│   │   ├── Dashboard.tsx    ← Tab router, bankroll state, auth
│   │   ├── OrderFlowPanel.tsx
│   │   ├── VolDivergencePanel.tsx
│   │   ├── ApexWalletsPanel.tsx
│   │   ├── CondProbPanel.tsx
│   │   ├── SignalCombinerPanel.tsx
│   │   ├── ArbMatrixPanel.tsx
│   │   └── TradingPanel.tsx
│   ├── styles/global.css    ← CSS variables, dark theme
│   ├── layouts/Base.astro
│   └── pages/index.astro
├── netlify/
│   └── functions/           ← 16 Netlify Function (.mts)
├── internal-docs/           ← Részletes technikai dokumentáció
│   ├── README.md            ← Főoldal, architektúra, quick start
│   ├── 06-orderflow.md      ← Kyle λ, VPIN, Hawkes, AS
│   ├── 07-vol-harvest.md    ← IV vs RV, locked profit
│   ├── 08-apex-wallets.md   ← Payout ratio, bot detector, consensus
│   ├── 09-cond-prob.md      ← Marginal polytope, violations
│   ├── 10-signal-combiner.md ← Fundamental Law, IR = IC × √N
│   ├── 11-arb-matrix.md     ← VWAP arb, LLM dep, Frank-Wolfe
│   └── roadmap.md           ← Fejlesztési útvonal
├── apex_wallet_profiler.py
├── vol_divergence.py
├── orderflow_analyzer.py
├── conditional_prob_matrix.py
├── astro.config.mjs
├── netlify.toml
└── package.json
```

---

## A 11 Tab és funkcióik

| Tab ID | Komponens | Netlify Function(s) | Fő technika |
|--------|-----------|---------------------|-------------|
| `scanner` | Dashboard inline | `polymarket-proxy` | Piac lista, EV calc |
| `ev` | Dashboard inline | – | Kelly criterion |
| `funding` | TradingPanel | `funding-rates` | Delta-neutral carry |
| `swarm` | Dashboard inline | – | Monte Carlo sim |
| `trading` | TradingPanel | `bybit-trade`, `binance-trade`, `polymarket-trade` | JWT auth, exec |
| `orderflow` | OrderFlowPanel | `orderflow-analysis` | Kyle λ, VPIN, Hawkes |
| `vol` | VolDivergencePanel | `vol-divergence` | Binance klines, IV-RV |
| `apex` | ApexWalletsPanel | `apex-wallets` | Payout ratio, bot detect |
| `condprob` | CondProbPanel | `cond-prob-matrix` | Monotonicity violations |
| `signals` | SignalCombinerPanel | `signal-combiner` | Grinold-Kahn IR=IC×√N |
| `arbmatrix` | ArbMatrixPanel | `vwap-arb`, `llm-dependency` | VWAP arb, Claude API |

---

## CSS Design System

**SOHA ne használj inline Tailwind utility class-okat** – a projekt saját CSS variable rendszert használ.

```css
/* Használandó változók (src/styles/global.css) */
var(--bg)        /* #0a0a0c – háttér */
var(--surface)   /* #101014 – kártya háttér */
var(--surface2)  /* #16161c – secondary surface */
var(--border)    /* #1e1e28 – border */
var(--text)      /* #e8e8f0 – fő szöveg */
var(--muted)     /* #6b6b80 – másodlagos szöveg */
var(--accent)    /* #c8f135 – zöld (pozitív, YES) */
var(--danger)    /* #f13535 – piros (negatív, NO) */
var(--accent2)   /* #35c8f1 – kék (neutral info) */
var(--warn)      /* #f1a035 – narancs (figyelmeztetés) */
var(--mono)      /* 'JetBrains Mono', monospace */
var(--sans)      /* 'Inter', sans-serif */
```

**Komponens CSS pattern:** minden komponens a saját `<style>` blokkjában definiálja az osztályokat, prefix-szel (pl. `aw-`, `cp-`, `sc-`). Nem globális CSS.

---

## Netlify Functions konvenciók

### Fájl struktúra (.mts)

```typescript
import type { Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
};

export default async function handler(req: Request, _ctx: Context) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  // ...
  return new Response(JSON.stringify(payload), { status: 200, headers: CORS });
}
```

### Cache pattern (Netlify Blobs)

```typescript
const store  = getStore("cache-name");
const cKey   = "unique-key";
const TTL_MS = 5 * 60 * 1000; // 5 perc

const cached = await store.getWithMetadata(cKey);
if (cached?.metadata && Date.now() - ((cached.metadata as any).ts || 0) < TTL_MS) {
  return new Response(cached.data as string, { status: 200, headers: CORS });
}
// ... fetch és számítás ...
await store.set(cKey, payload, { metadata: { ts: Date.now() } });
```

### Cache TTL-ek (meglévő functions)

| Function | TTL |
|----------|-----|
| `vol-divergence` | 2 perc |
| `orderflow-analysis` | 5 perc |
| `cond-prob-matrix` | 5 perc |
| `signal-combiner` | 3 perc |
| `vwap-arb` | 90 mp |
| `apex-wallets` (leaderboard) | 10 perc |
| `apex-wallets` (consensus) | 10 perc |
| `apex-wallets` (profile) | 5 perc |
| `llm-dependency` | 30 perc |
| `funding-rates` | 8 óra |
| `polymarket-proxy` | 1 óra |

---

## API végpontok

```
# Polymarket
GAMMA_API  = "https://gamma-api.polymarket.com"
CLOB_API   = "https://clob.polymarket.com"
DATA_API   = "https://data-api.polymarket.com"

# Binance
BINANCE    = "https://api.binance.com"
BN_FUTURES = "https://fapi.binance.com"

# Bybit
BYBIT      = "https://api.bybit.com"
```

---

## Auth rendszer

- **SHA-256 + JWT** (jose library)
- HttpOnly Secure cookie, 8h session
- `_auth-guard.ts` helper minden védett function-ben
- Hash generálás: `node -e "console.log(require('crypto').createHash('sha256').update('jelszo').digest('hex'))"`

**Env vars:**
```
JWT_SECRET=<32+ karakter random>
AUTH_PASSWORD_HASH=<sha256 hash>
ANTHROPIC_API_KEY=<sk-ant-...>   # llm-dependency function-höz
BYBIT_API_KEY=...
BYBIT_API_SECRET=...
BYBIT_TESTNET=true               # éles előtt mindig true!
BINANCE_API_KEY=...
BINANCE_API_SECRET=...
BINANCE_TESTNET=true
```

---

## Matematikai kontextus (rövid)

A részletes leírás az `internal-docs/` mappában van. Rövid összefoglaló:

**Kyle λ** – adverse selection: $\Delta p = \lambda \cdot Q$, ahol Q = net order flow  
**VPIN** – toxikus flow: $\frac{\sum |V^B - V^S|}{\sum V}$, ha > 0.7 → informált kereskedők  
**Hawkes** – trade clustering: $\lambda^*(t) = \mu + \sum \alpha e^{-\beta(t-t_i)}$  
**Grinold-Kahn** – $IR = IC \times \sqrt{N}$, 5 jelzés IC≈0.07 → IR≈0.157  
**Kelly** – $f^* = \frac{pb - q}{b}$, ¼-Kelly az intézményi standard  
**Payout ratio** – $\frac{\overline{W}}{\overline{L}}$, break-even WR = $\frac{1}{1+PR}$  
**Bot detector** – focus ratio + sleep gap + inter-trade CV + 24h coverage  
**Bregman projekció** – $\mu^* = \arg\min_{\mu \in M} D_{KL}(\mu \| \theta)$  

---

## Python scriptek

```bash
# apex_wallet_profiler.py
python apex_wallet_profiler.py --demo
python apex_wallet_profiler.py --consensus --window 7d
python apex_wallet_profiler.py --consensus --claude   # Claude API elemzéssel
python apex_wallet_profiler.py --profile 0x...
python apex_wallet_profiler.py --leaderboard --json

# vol_divergence.py
python vol_divergence.py --demo
python vol_divergence.py --watch      # 2 perces loop
python vol_divergence.py --json

# orderflow_analyzer.py
python orderflow_analyzer.py --demo
python orderflow_analyzer.py --token-id <TOKEN_ID>
python orderflow_analyzer.py --list-markets

# conditional_prob_matrix.py
python conditional_prob_matrix.py --demo
python conditional_prob_matrix.py --scan-btc
python conditional_prob_matrix.py --scan-fed
python conditional_prob_matrix.py --cli --scan-btc   # Polymarket CLI-vel
python conditional_prob_matrix.py --custom slug-a slug-b
```

---

## Fejlesztési szabályok

### Új tab hozzáadása

1. Komponens: `src/components/NewPanel.tsx`
2. CSS prefix: egyedi 2-3 karakteres prefix (pl. `np-`)
3. Demo data: mindig legyen DEMO konstans, `is_demo: true` flag
4. Dashboard: `Dashboard.tsx`-ben import + tab array + render bővítése
5. Function: `netlify/functions/new-panel.mts`
6. Dokumentáció: `internal-docs/NN-new-panel.md`

### Új Netlify Function

- Fájlnév: `kebab-case.mts`
- CORS headers minden response-ban
- Cache minden GET endpoint-on
- Error handling: `{ ok: false, error: err.message }` + 502
- Timeout: `AbortSignal.timeout(8000)` minden külső hívásban

### Komponens pattern

```tsx
export default function NewPanel({ bankroll }: { bankroll: number }) {
  const [data,    setData]    = useState<any>(DEMO);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${FN}/new-endpoint`);
      const j = await r.json();
      if (j.ok) setData({ ...j, is_demo: false });
    } catch {}
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, []);
  // ...
}
```

### ¼-Kelly számítás (egységes pattern)

```typescript
function kellySize(p: number, price: number, bankroll: number): number {
  const b = (1 / Math.max(price, 0.01)) - 1;
  const q = 1 - p;
  const f = Math.max(0, (p * b - q) / b);
  return (f * 0.25 * bankroll);
}
```

---

## Ismert limitációk és TODO-k

### Technikai debt

- `Dashboard.tsx` tab array és render szekció manuálisan szinkronizálandó új tabok esetén (nem generált)
- `{src/` és `{src/{components,pages,layouts},public}/` mappák artifact-ok a build folyamatból – ignorálandók
- A `package-lock.json` 277K – ne szerkeszd manuálisan

### Hiányos implementációk

- **Signal Combiner IC becslések:** priorok, nem mért értékek. 50+ trade után kalibrálni kell.
- **CV_edge:** nem valódi Monte Carlo, IR-ből becsült proxy.
- **VWAP scanner:** 90 mp cache – real-time WebSocket kellene production-ban.
- **Frank-Wolfe / Gurobi:** nincs implementálva (IP solver licenc szükséges).
- **Trade logging:** nincs Supabase integráció – minden session stateless.

### Következő prioritások (roadmap.md alapján)

1. Deploy + Polymarket fiók + első éles tesztek ($50-100 USDC)
2. Trade logging Supabase-be
3. IC kalibráció 50+ trade után
4. mac-code integráció lokális LLM-hez (ha Apple Silicon van)
5. Real-time WebSocket VWAP scanner

---

## Build és deploy

```bash
npm install
npm run dev          # localhost:4321 (csak frontend, functions nélkül)
netlify dev          # localhost:8888 (full stack, functions-szel)
npm run build        # dist/ mappa
netlify deploy --prod --dir=dist
```

**Fontos:** `netlify dev` szükséges a functions teszteléséhez lokálisan.  
`npm run dev` csak a frontend-et indítja, a `/.netlify/functions/` hívások 404-et adnak.

---

## AKTUÁLIS ÁLLAPOT (2026-05-10) – Claude Code folytatáshoz

### Nyolcadik session (2026-05-10) – Auto-Trader Tab 1 visibility pass: blocker chips + open positions + weather stats parity

A 4 bot Tab 1-én (Auto-Trader) ugyanaz a 3 láthatósági hiba volt:
1. A "skip" sorokról csak hover-en derült ki **mi szűrte ki őket** — a user
   az élő gridet végignézve nem látta szín alapján a kritérium-blokkokat.
2. A **nyitott pozíciók** csak counterként szerepeltek (Crypton); a Weatheren
   és HL-en hiányoztak teljesen, és a Crypto pending-listája összemosta a
   "még tradel" és "settlement-re vár" sorokat.
3. A Weather Tab 1-ről **hiányzott a 4-cellás stats grid** (Bankroll/PnL/
   Trades/Open) — minden más boton ott van.

**Backend (`auto-trader/index.mts` + `hyperliquid/index.mts`):**
- `getStatus` payload bővítve `openDetails` mezővel mind crypto/weather/HL-re.
  Crypto+weather: csak az **aktív** (még nem-settlement) pozíciók; HL: minden
  open perp position.
- `pending` lista most már szigorúan a "lejárt, settlement-re vár" sorokat
  tartalmazza — Crypto: endDate < now; Weather: új
  `getWeatherPendingForSettlement()` szűri az `isReady=true`-t.

**Frontend (`shared/TraderResults.tsx` + `traderShellStyles.ts`):**
- **`ScanResultRow`**: új tone (pass/skip/fail/neutral) → bal-szegélyes
  szín-kódolás (zöld/narancs/piros/transzparens) + halvány bg-tint.
- **Inline blocker line**: skip+failed-gate sorokon a sor maga megmutatja
  az **első** elbukott gate-t — ✗ jellel, label-lel, tényleges és elvárt
  értékkel, "+N további" ha több bukás van. Hover továbbra is a teljes
  popoverre kattan.
- **`OpenPositionsCard.OpenPositionRow`** kibővítve direction/entryText/
  spreadText opcionális mezőkkel + opcionális pnlText/pnlValue.

**Per-bot panelek:**
- **CryptoTrader**: új OpenPositionsCard a pending fölött, "ends in Xh Ym"
  countdown-nal.
- **WeatherTrader**: új stats grid (Bankroll/PnL/Trades/Open) + alerts
  (Stopped) + OpenPositionsCard "City · Bucket / pred X°C / settles in Yh"
  formátumban.
- **HyperliquidTrader**: új OpenPositionsCard a perp pozíciókkal
  (`@$entryPrice / $X · Nx lev / TP/SL`).
- **FundingArbPanel**: változatlan, már korábban OpenPositionsCard-ot
  használt.

Részletes leírás: `internal-docs/changelog/CHANGELOG-2026-05-10.md` —
"2026-05-10 (b)" szekció.

### Hova nyúlj legközelebb (Tab 1 UI)

- **Új scan-sor szín**: a tone-mapping a `ScanResultRow`-ban van, action verb
  alapján — új akció hozzáadásakor ott kell egy ágat felvenni (pl. "queued"
  → neutral).
- **Új blocker row** automatikusan jön — a `criteria` array minden új
  gate-jét a sor szintjén kiemeli az inline blocker line, ha az volt az
  első elbukott gate.
- **HL live PnL chip a nyitott pozíción**: jelenleg az OpenPositionsCard
  pnlText opcionális; ha a getHlStatus is fetcheli a markPrice-t, futtatható
  egy unrealized PnL számítás és a `OpenPositionRow.pnlText/pnlValue`
  kitölthető a frontend-en módosítás nélkül.

### Hetedik session (2026-05-10) – HomePage: clickable per-category breakdown + Trading & Execution kategorizálás + venue badge

A főoldali mission control 3 új UX-feature-t kapott:

1. **Aggregated session per-category breakdown sorai kattinthatóak** —
   `<div className="hp-bd-row">` → `<a href={`/trade/${c.category}/`}>`,
   hover-en háttér-világosodás + 2px-es jobbra-elmozdulás + accent-szín
   nyíl. A `multi-status.mts` által visszaadott category stringek
   (`crypto`/`weather`/`hyperliquid`/`funding-arb`) közvetlenül URL-re
   mappolnak.

2. **Trading & Execution szekció 2 alszekcióra bomlik:**
   - **⚙ Automated bots** (cron */3): Crypto, HL Perp, Funding-Arb, Weather
   - **🎯 Manual execution** (user-triggered): Bybit, Binance, Polymarket Manual

   Mindkét alszekció saját `hp-cat-head` header-pill-t kap bal-szegélyű
   accent-keretttel + meta sub-label-lel.

3. **Venue badge minden execution kártyára** — a cím alatt egy `venue:
   <Polymarket | Hyperliquid | Hyperliquid + Binance | Bybit | Binance>`
   chip mutatja, hogy melyik bot hol kereskedik.

Implementáció részletei: `internal-docs/changelog/CHANGELOG-2026-05-10.md`
"HomePage navigáció" szekciója. Egyetlen érintett fájl: `src/components/HomePage.tsx`.

### Hova nyúlj legközelebb (HomePage)
- Új execution-kártya: `CARDS[]`-be új objektum, `venue` és `auto` mezők
  kötelezően — az alszekciós filter automatikusan a helyes csoportba teszi.
- Venue badge analysis kártyákra: a `CapCard` már `card.venue && (...)` -nel
  conditionally rendereli, csak `venue` mezőt kell írni.

### Hatodik session (2026-05-10) – Paper resolvers: real Polymarket only, no simulator (simVersion 3)

A live `mj-trading.netlify.app/trade/crypto/` paper-tracker validációja megmutatta, hogy a 9 closed trade-en kimutatott 88.9% WR / IC=0.453 / +$7.44 PnL **fake szám**: két bug együttese miatt egyetlen valós Polymarket resolution sem fut le, és minden close egy instant-trigger Brownian sim-ből származott.

**Bug A — Gamma URL filter hiányos** (`paper-resolver.mts:45`, `weather/polymarket-resolver.mts:42`):
```
?condition_ids=0xABC...           → []     (Gamma filterezi a closed market-eket!)
?condition_ids=0xABC...&closed=true → [{ outcomePrices: ["1","0"] }]
```
A `closed=true` flag nélkül egyetlen lezárult market sem található meg → `info.resolved` mindig `false` → soha nem trigger-el a "real" branch.

**Bug B — Brownian sim instant-trigger deep-OTM-en** (`paper-resolver.mts:99-149` v2):
A bound-ok fixek (tpTarget=0.75, slTarget=0.35), entry-független. Ha entry yesPrice a `[0.25, 0.65]` tartományon kívül van, az első iteráció után triggerel — a path nem szimulálódik. NO entry 0.20 → yesPrice 0.80 → upperYes=0.65 felett → instant exit NO=0.35 → garantált +75% profit minden NO < 0.35-nél.

**Empirikus bizonyíték** a 9 trade-en: 8/9 exit price = 0.35 (slTarget bound), 1/9 = 0.75 (tpTarget bound). A `bitcoin-up-or-down-on-may-9-2026` valós outcome = YES ([1,0]); paper NO entry 0.35-ön $0 break-event könyvelt el a valós −$1.00 helyett.

**Fix (simVersion 3):**

1. **Crypto** `paper-resolver.mts` teljes átírás: csak `fetchMarketResolution()` + `closed=true` query. Brownian-bridge sim és a `simulateBrownianBridgeExit()` export törölve. A pozíció nyitva marad amíg Gamma `outcomePrices` ∈ `{0,1}`-et nem ad vissza. **Paper PnL == live PnL.**
2. **Weather** `polymarket-resolver.mts:42` `&closed=true` hozzá. A METAR fallback (6h után) marad — fizikai mérés, nem szimuláció, és pontosan ezt használja az UMA settlement-hez.
3. **HL directional + funding-arb** auditálva, **változtatás nem szükséges**: `getAllMids()` valós markPrice, `scanFundings()` valós HL+Binance funding rate. Az hedge-manager paper `paperFill()` a markPrice-on tölt slippage nélkül (idealizálás, nem szimuláció).
4. `PAPER_SIM_VERSION` 2 → 3. A live deploy után az első cron tickkor a 9 v2-paper trade automatikusan archiválódik az `auto-trader-session-archive-paper-v2` Blobs key-be, és tiszta crypto session indul.
5. `auto-trader/index.mts` paper-resolver hívás egyszerűsítve (cfg paraméter törölve), `paperFallbackAfterMs`/`paperBrownianSigma` env-loadolás törölve.
6. `trader-settings.mts` SCHEMA: `paperFallbackAfterMs` + `paperBrownianSigma` field-ek kiszedve. Régi Blobs override-ok automatikusan ignorálva (`if (!(k in SCHEMA)) continue` a `loadRuntimeOverrides`-ban).

Részletes leírás: `internal-docs/changelog/CHANGELOG-2026-05-10.md`.

### Hova nyúlj legközelebb (paper validáció)

- **Crypto**: a deploy utáni első cron tickkor a 9 fake trade archiválódik. Új paper trade-ek innentől csak akkor zárulnak, ha a market Polymarketen resolve-olt → 5–60 perc tipikusan a 5m/1h BTC piacokon. Nyitott trade-ek "PAPER_RESOLVE_SKIP/polymarket_not_resolved_yet" log-bejegyzéssel várják a Gamma update-et.
- **Weather**: ugyanezt a fix-et kapta. A METAR fallback 6h után aktiválódik, ha az UMA késik.
- **Tesztelési protokoll** új paper sessionre: hagyni a botot 24-48h-t nyugiban futni → ellenőrizni hogy a closedTrades exit-ei mind 0 vagy 1 (real resolution) vagy 0/1 (METAR fallback weather-en). Ha bármelyik trade exit-e a [0.01, 0.99] tartományban van (kivéve weather METAR-fallback resolved 1.0/0.0-t), bug.

### Hatodik session follow-up (2026-05-10) – Crypto bot pending-paper-position kártya

A simVersion 3 átállás utáni follow-up: a paper pozíciók most szignifikánsan tovább maradhatnak nyitva (5–60 min UMA resolution, vagy 6+ óra dispute során), mivel nincs többé Brownian fallback. A weather bot 2026-05-09-i `PendingPositionsCard`-jával szimmetrikusan a crypto botra is felkerült egy "past endDate, awaiting Polymarket resolution" kártya.

- **Backend** `auto-trader/index.mts`: új `getCryptoPendingPositions(session)` helper, szűri `session.openPositions`-t `endDate < now`-ra, ageMs számítással. A `getStatus()` crypto ágában `base.pending` mezővel visszaadja. **Nincs fallback paraméter** (v3 contract).
- **Frontend** `CryptoTrader.tsx`: `PendingPositionsCard` conditional render (`pending.count > 0`), új `formatAgeAgo` helper, `whenText: "awaiting Polymarket resolution"`. Footnote magyarázza a v3 garanciát.
- **Mit nem változtattam**: a bot logikája 0 byte-ot se változott. Nincs új manuális reconcile gomb sem — a meglévő "Run Scan" gomb már triggereli (`auto-trader/index.mts:272-283`).
- **Mit nem változtattam #2**: a weather bot UI érintetlen — ott marad a meglévő "⟳ Reconcile pending" gomb (külön `auto-trader-weather-reconciler-cron` + 6h METAR fallback indokolja).

Részletes leírás: `internal-docs/changelog/CHANGELOG-2026-05-10.md` "Crypto bot pending-paper-position kártya (UI follow-up)" szekciója.

### Hova nyúlj legközelebb (crypto pending UI)

- Ha egy market 1h+ ageMs-szel a kártyán marad → vagy UMA dispute fut, vagy Gamma `closed=true` query nem találja. Diagnosztika: `curl 'https://gamma-api.polymarket.com/markets?condition_ids=0x...&closed=true'`.
- Új mező a sorokon (pl. live mp drift az entry óta): `getCryptoPendingPositions` + `pending.positions.map` callback. Máshol nem kell nyúlni.

### Ötödik session (2026-05-09) – Auto-Trader UX: reset safety + trade export + per-row criteria gates

3 üzemeltető-orientált feature minden bot oldalra:

1. **Type-to-confirm Reset dialog** (új `shared/ConfirmDialog.tsx`).
   A "Reset" gomb most `Reset…` lett és modális dialógot nyit:
   - Session summary bullet list (bankroll, trade count, PnL, open positions, started)
   - Default-checked checkbox: "Letöltöm a JSON backup-ot reset előtt"
   - Type-to-confirm: a "RESET" szó begépelése kell (case-sensitive)
   - Esc + backdrop-click cancel; auto-focus; busy-state disabled
   - Backup checkbox bekapcsolva: a reset POST előtt lefut az export
2. **JSON trade export** (új `shared/useTradeExport.ts` hook).
   - Új standalone "💾 Export Trades" gomb minden boton
   - Hív `/.netlify/functions/edge-tracker?mode=paper&category=…&days=all`
   - Self-describing JSON envelope (`$schema`, `category`, `mode`, `exportedAt`, `summary`, `signalIC`, `trades`, `sourceNote`)
   - Letöltési fájlnév: `trades-{category}-{mode}-{ISO-ts}.json`
3. **Per-row entry-criteria gates** (új `CriteriaSummary` + 4 mapper a `TraderResults`-ban).
   - Minden scan-row egy "X/Y gates ✓" chip-et kap
   - Hover/focus → CSS-only popover a teljes pass/fail bontással
   - Per-bot mapper: `cryptoEntryCriteria` (5 gate), `weatherEntryCriteria` (3 gate), `hlEntryCriteria` (3 gate), `arbEntryCriteria` (2 gate)

A 4 bot panel **nem** add hozzá Reset-et a `controls` arrayhez — a TraderShell maga rendereli, mert a confirm-dialog + backup-flow közös. A Reset slot + Export slot tisztán deklaratív callback-ek.

Részletes leírás: `internal-docs/changelog/CHANGELOG-2026-05-09.md`
"Auto-Trader UI: reset safety + trade export + per-row criteria gates" szekciója.

### Hova nyúlj legközelebb (UX)

- **Új entry-gate hozzáadása**: 1 sor a megfelelő `*EntryCriteria` mapper-be a `TraderResults.tsx`-ben, és minden boton + minden jövőbeli boton azonnal megjelenik a popover-ben.
- **Server-side auto-archive Reset-nél**: a kliensoldali backup már védi az adatokat, de ha akarjuk a server-oldali sticky archive-ot is (timestamp-elt Blobs key minden Reset-nél), az 1 patch a `handleReset()`-be — a snapshot infra már megvan a v1→v2 migration-höz.
- **Stop is gateolható**: a ConfirmDialog reusable, ha jövőben egy "Stop" is destruktívnak számít (pl. nyitott pozíciók close-olása), ugyanezzel a komponenssel "STOP" szóval gateolható.

### Negyedik session (2026-05-09) – HL split: 1 doboz → 2 doboz + API audit

A `/trade/hyperliquid/` egy "Hyperliquid Perp" doboz alá rejtett **két
külön botot**: directional perp trader + funding-rate arbitrage. A főoldalon
mostantól **két különálló kártya** látszik (`/trade/hyperliquid/` és
`/trade/funding-arb/`), és minden HL/Binance API hívás végig lett ellenőrizve
a hivatalos doksi alapján.

**UI split:**
- `[category].astro` static path bővítve `funding-arb`-bal.
- `CategoryDashboard.tsx` — két top-level kategória (`hyperliquid` és
  `funding-arb`), külön 3-tabos layout (autotrader / edge-tracker / settings).
- `HomePage.tsx` — execution-grid-en két kártya `Hyperliquid Perp` +
  `Funding Rate Arbitrage`. Live-readiness banner anchor a megfelelő
  oldalra ugrik (Funding-Arb sora már nem visszairányít HL-re).

**API audit (a hivatalos doksi alapján):**
- HL Info: `allMids`, `metaAndAssetCtxs`, `clearinghouseState` mind POST+JSON.
  `funding` HOURLY decimal string. `openInterest` COIN UNITS. ✅ konformnak
  találva, viszont validáció szigorítva (Number.isFinite + range guards) +
  1× retry network/5xx-en, 4xx permanent.
- HL Exchange (SDK): trigger orderhez `positionTpsl` grouping, entry-nél
  `na`. Order ID extraction `resting.oid ?? filled.oid`. `HL_PRIVATE_KEY`
  formátum-ellenőrzés (0x + 64 hex). Adapter cache + `liveAdapterError()`
  helper a hibák diagnosztikájára.
- Binance USDT-M `premiumIndex`: **kritikus bug**. `lastFundingRate` per
  cycle (8h alapért., DE BTC/ETH/SOL és pár másik major 4h cycle-en megy
  2023 óta). Eddig hard-kódolt `/8` 2× alulbecsülte az hourly rate-et a
  4h-s symbol-okon → bogus arb-belépéseket triggerelhetett. Most új
  `fundingInfo` cache (6h TTL) — symbol-onként valós interval.
- Binance Spot order: `data.price` MARKET-nél mindig "0", helyette
  `fills[]` weighted average + `cummulativeQuoteQty / executedQty` fallback.
  `newOrderRespType=FULL` explicit. `executedQty=0` ok=false.

**Trade-logikai bugfixek:**
- **Paper-resolver elveszti a signal metadatát**: HlPosition kapott opc.
  `predictedProb / edgeAtEntry / signalBreakdown` mezőket; placeHlEntry
  rögzíti, paper-resolver átemeli a closed trade-be → IC-szám most
  működik.
- **Funding-arb accrueFunding logikai hiba**: spot hedge nem fizet
  funding-ot, az `entrySpread × hours` képlet kétszeresen büntette a
  Binance funding-ot. Most `entryHlFunding × hours` + per-tick
  legfrissebb HL rate (paper realizmus + spread decay reflektálódik).
- **fr-scanner operator-precedence bug** (`!x == null` → mindig false):
  explicit Number.isFinite check.
- **Funding-arb live close IOC limit `pos.hlEntryPrice`-on**: volatilis
  ticken sosem fillel; most fresh markPrice ±0.5% slippage band.
- **Funding-arb hiányzó run-state**: új `arb-run-state.mts`, dispatcher
  `?source=cron`-t átadja, panel pill cluster (`Scanning…/cron ON/last`)
  most működik.
- `simulatePaperPnl` dead code törölve.

Részletes leírás: `internal-docs/changelog/CHANGELOG-2026-05-09.md`
"Hyperliquid: split into 2 separate bots + atomic API audit + bugfixes" szekciója.

### Hova nyúlj legközelebb (HL + Funding-Arb)

- **Két külön kártya a főoldalon**: külön klikk, külön session, külön
  edge-tracker. Funding-Arb most live-readiness banner-en is külön sor.
- **`@nktkas/hyperliquid` továbbra sincs telepítve** — paper-only.
  Élesítéshez: `npm i @nktkas/hyperliquid viem` + `HL_PRIVATE_KEY` (0x +
  64 hex hosszúság ellenőrizve). Adapter ekkor pontos hibaüzenetet ad,
  ha valami hiányzik.
- **fundingInfo cache TTL**: 6h hard-coded — ha kell, env-en keresztül
  override-olni lehet később (jelenleg nincs Settings knob rá).

### Harmadik session (2026-05-09) – Auto-Trader UI unification (4 bots → 1 shell)

Egységesítés: a 4 trader (Crypto, Weather, Hyperliquid, Funding-Arb) eddig
4 különálló komponensben élt — saját CSS prefixszel, saját polling loop-pal,
saját button stílussal és inkonzisztens validálási chip-ekkel. Egyetlen
megosztott shell + 5 reusable card alá kerültek. Ugyanaz a "Run Scan" gomb
mostantól minden boton ugyanúgy néz ki, ugyanazt a chip-szettet használja,
és minden boton kötelezően megjelenik a `LiveReadinessBadge` +
`CalibrationHealthBadge` (eddig csak Cryptón volt).

**Új közös modulok** (`src/components/shared/`):
- `TraderShell.tsx` — 1 wrapper + `useAutoTraderStatus(category, layer?)` +
  `useTraderAction(category, layer?)` hook. Kezeli a 5s status pollot, az
  1s relativ-time tickert, a header pill clustert (live/cron/last) és a 2
  badge-et.
- `TraderResults.tsx` — `ScanResultsCard`, `ScanResultRow` (rich chips +
  signal arrows + action chip + extra/pnl + reason footer),
  `PendingPositionsCard`, `OpenPositionsCard`, `OpportunitiesCard`,
  `DroppedCard`. Egyetlen `ResultChip` API (label + tone + outline + title).
- `traderShellStyles.ts` — `ts-` prefix CSS.

**Eredmény LOC-ban:** Crypto 532 → 248, Weather 429 → 196, HL 304 → 161,
F-Arb 250 → 173. ~1500 → ~778 LOC, miközben minden bot megkapta a hiányzó
feature-eket (status cluster F-Arb-on, cal+readiness badge mindenhol, rich
validation chips mindenhol).

**Future-proof:** új trader hozzáadása mostantól ~150 LOC adapter +
TraderShell. Új feature (modal, sparkline) egyetlen helyre kerül és minden
bot megkapja.

Részletes leírás: `internal-docs/changelog/CHANGELOG-2026-05-09.md` -
"Auto-Trader UI unification (4 bots → 1 shell)" szekciója.

### Hova nyúlj legközelebb (UI)

- Új trader category hozzáadása: új trader file ~150 LOC, ami `TraderShell`
  + `useAutoTraderStatus(category)` + `useTraderAction(category)` köré épül,
  és a `ScanResultsCard` / megfelelő cards-okat tölti.
- Új validation chip mindenhol (pl. spread, liquidity score): a `ResultChip`
  API kibővítése (új tone? új ikon?) → minden bot azonnal megjeleníti.
- A `traderShellStyles.ts` az egyetlen forrás a `ts-` osztályokhoz; minden
  vizuális tweak ott egy helyen van.

### Második session (2026-05-09) – Crypto paper trader v2 sim + calibration alarm

A `paper-pnl-analysis.md` által leírt 4 strukturális hibát kódfedezetbe vontam:

- **`simulatePaperExit` halfway-toward-prediction kivéve.** Új modul:
  `auto-trader/crypto/paper-resolver.mts`. Két finalProb-független útvonal:
  - **Real Polymarket resolution (gold standard):** paper position nyitva
    marad amíg a market le nem zárul, utána a Gamma API `outcomePrices`
    `[1,0]`/`[0,1]` alapján zár. Innentől az IC valós piaci kimeneteleken
    mér.
  - **Brownian-bridge fallback:** ha 30+ perc után sincs resolution,
    logit-tér Brownian híd `Bernoulli(marketPriceAtEntry)` terminallal
    (efficient-market null), TP/SL crossing check a path mentén. Tunable
    σ (`paperBrownianSigma`).

- **`btc-market-finder` deep-OTM filter.** `MIN_PRICE_BAND = 0.10`: yes < 0.10 vagy > 0.90 → skip. Ez kizárja a $0.01 fill artefaktokat.

- **Calibration alarm.** Új `computeCalibrationHealth(trades, 30)` az
  `edge-tracker/statistics.mts`-ben. 30+ trade után, ha minden signal
  |IC| < 0.02:
  - Paper: Telegram alarm egyszer/session (`calibrationAlertSentAt` flag).
  - Live: session auto-stop + Telegram.
  - UI: új `CalibrationHealthBadge` a Tab 12 Edge Tracker tetején (zöld
    `good` ≥ 0.05 / narancs `weak` ≥ 0.02 / piros `noise` < 0.02 / szürke
    `insufficient` < 30 trade).

- **Session simVersion auto-reset.** `PAPER_SIM_VERSION = 2`. A
  `loadSession()` ha `simVersion < 2`-t lát, archiválja a régi
  `closedTrades`-t (`auto-trader-session-archive-paper-v1` Blobs key) és
  tiszta sessiont ad vissza. Az élőben futó 143 régi (halfway-sim) trade
  deploy után az első cron tickkor automatikusan archiválódik — explicit
  reset hívás nem kell.

- **Új tunable knobok** a `trader-settings.mts` SCHEMA-ban:
  - `paperFallbackAfterMs` (1.8M ms = 30 min default)
  - `paperBrownianSigma` (0.45 σ/√min default)
  - `btcMinPriceBand` (0.10 default)

Részletes leírás: `internal-docs/changelog/CHANGELOG-2026-05-09.md`
"Crypto paper trader: realisztikussá tett szimulátor (v2)" szekciója.

### Hova nyúlj legközelebb (crypto paper)

- **Tab 12 Edge Tracker (`/trade/crypto/`)** → tetején Calibration Health
  badge színe azonnal megmondja a paper signal-szett egészségét.
- **30+ trade után** ha a badge piros (`noise`): a Telegram alarm már
  elment, és a config: live váltás tilos. Iterálj a signal-combiner
  IC weights-en, vagy a signal-aggregator-on.
- **50+ trade és zöld badge után** lehet élesedést fontolóra venni
  (továbbra is csak $10–20 USDC kezdő tét).
- **Settings tab (Tab 13) → Paper resolver group:** `paperBrownianSigma`,
  `paperFallbackAfterMs`, `btcMinPriceBand` finomhangolása.

### Első session (2026-05-09) – Weather trader 6 bugfix + Settings tab + live status

**Bugok kivizsgálása:** élő `mj-trading.netlify.app/trade/weather/` scan
megmutatta, hogy a Hong Kong May 9 piacon a modell 24.4°C-t jósolt 85.5%-os
`26°C` konszenzussal álló piac ellen, eredmény: 70%-os hamis edge. Részletes
elemzés: `internal-docs/changelog/CHANGELOG-2026-05-09.md`.

**Javított hibák:**
- **A**: `city_offset` mis-application — Open-Meteo airport koordinátán adja
  vissza a forecast-ot, már station-relatív. A `correctForecast` mégis hozzáadta
  az offsetet → ~1°C-os szisztematikus alulbecslés. Új `applyCityOffset` opció,
  default `false`. HK predikció: 23.9°C → 25°C.
- **B**: `forecast_days=2` global max → target dátum prefix szűrő.
- **C**: `dallas` + `tokyo` hozzáadva a `CITY_PATTERNS`-hez.
- **D**: 8 új város a station listában: madrid, paris, milan, munich, ankara,
  lagos, sao-paulo, austin (mind a Polymarket Gamma által aktívan szállított).
  Dropoltak diagnosztika a UI-on: `findWeatherMarketsDetailed()` + `DroppedEvent`.
- **E**: `maxEdgeCap` (default 0.40) — ha a gross edge nagyobb, no-trade
  "likely model error" reason-nel. Smoke teszt: HK -60% edge mostantól blokkolva.
- **F**: paper-mode self-validation dokumentálva (változatlan, TODO live METAR
  reconciliation).

**Új tunable Settings paraméterek (`netlify/functions/trader-settings.mts`):**
9 weather-kategóriás field — `weatherEdgeThreshold`, `weatherConfidenceMin`,
`weatherExitBeforeMin`, `weatherMaxPositionUSD`, `weatherMaxEdgeCap`,
`weatherForecastDays`, plus 3 boolean toggle: `weatherApplyCityOffset`,
`weatherUseEnsemble`, `weatherCronEnabled`. `getEffectiveWeatherConfig()`
mergel env defaults + Blobs runtime overrides.

**UI változások:**
- `/trade/weather/` oldalon új **⚙ Beállítások** tab a generikus
  `SettingsPanel`-lel (kategória-szűrt, bool toggle UI).
- `WeatherTrader.tsx` status cluster: 🟢 **Scanning... (manual/cron)** pulse,
  **cron ON · 5 min** vagy **cron OFF**, **last (manual/cron): X ago**.
  Pollol szervert 5s-enként, lokálisan 1s-enként frissül.
- A futás eredménye mostantól megjeleníti a kihagyott eseményeket (collapsible).

**Új scheduled function:** `auto-trader-weather-cron.mts` (`*/5 * * * *`).
Csak akkor csinál bármit, ha a Settings tabon a `weatherCronEnabled` toggle ON.

**Új state:** `weather-runtime` Blobs store — `startedAt` (90s stale guard),
`lastRunAt`, `lastResult`, `source`. Az `auto-trader-api?action=status&category=weather`
visszaadja `runStatus` mezőben.

### Hova nyúlj legközelebb (weather)
- **Settings tab** → weather knobs állítása. `weatherCronEnabled=ON` után
  ~5 perc múlva a következő cron tick lefut.
- **`weatherApplyCityOffset` toggle** → ha valaki vissza akarja állítani a régi
  bugos viselkedést, ott tudja. Default OFF (helyes).
- **`weatherMaxEdgeCap`** → 40% default; ha a felhasználó nagyobb edge-eket is
  látni akar (pl. paper kísérletezés), feljebb húzhatja.

### Régi mai session változások (2026-05-08)
- **A.1 Kelly egységesítés:** új `src/lib/math.ts` `kellyBinary()` (¼-Kelly + 8% hard cap), Dashboard.tsx 3 call site-ja átállítva, `MAX_KELLY_FRACTION` env default 0.20→0.08.
- **A.2 Polymarket Auto-Claim:** új `netlify/functions/polymarket-redeem.mts` (auth-protected, intent-only mintázat) + `RedeemSection` a TradingPanel Polymarket sub-paneljében.
- **A.3 Korai Exit (BTC 5m/15m):** TP/SL clamp + entry-window filter (60-180s), hold-to-end (<60s). `MarketInfo.openedAtEstimate` mező + `getBtcExitConfig()` env-ekkel + új `checkExitConditions()` pure függvény.
- **A.4 Order Book Imbalance:** Binance top-10 depth ratio mint konvergencia szignál a decision-engine-ben. Új `obImbalance` mező az `AggregatedSignal`-ben.
- **A.5 LP Subgroup A/B/C:** apex-wallets bővítve `lp_profile` (maker_ratio, two_sided, top-5 concentration) + `classifySubgroup` (FADE A/B, COPY C). Új `LPSubgroupCard` az ApexWalletsPanel-ben.
- **A.6 Pair-Cost Arb scanner:** új `pair-cost-arb.mts` + Tab 11 D chip — VWAP-validált YES+NO redeem arb.
- **SETTINGS rendszer:** új `trader-settings.mts` (auth-protected, Blobs runtime override store, range-clamp validáció) + új `SettingsPanel.tsx` komponens („⚙ Beállítások" 13. tab) saját login overlay-jel. `getEffectiveTraderConfig()` async wrapper merge-eli env+Blobs.
- **B (külön MD):** `internal-docs/migration/hetzner-migration-plan.md` 7-fázisos action plan a következő sessionnek (HL+funding-arb+P2.2+P3.3 Hetzner-re költözés).

### Hova nyúlj legközelebb
- Settings tabon paraméter állítás → 3 perc múlva a következő cron tick már az új értékekkel fut (env override redeploy nélkül)
- Trading panel → Polymarket → új „Auto-Claim" section: wallet 0x… cím beírása + Ellenőriz → claimable USDC
- Tab 11 D — Pair-Cost Arb: GET hívás `/.netlify/functions/pair-cost-arb?minProfit=0.03&notional=50` → table
- Tab 8 (Apex) → profil betöltés → új LP Subgroup card jelenik meg ha 2000+ trade és 30+ active day a wallet-en

### Mi marad a régi AKTUÁLIS ÁLLAPOT-ból (2026-04-08)

### Mi működik élőben
- Tab 06: Vol harvest fut, BTC szűrő javítva (deploy után él)
- Tab 07: OrderFlow fut, de 1 trade → Kyle λ/VPIN null
- Tab 08: Apex Consensus fut, piac nevek HIBÁSAK (lásd alább)
- Tab 09: Cond Prob fut, Iran violation valódi (17.5¢ edge)
- Tab 10: Signal Combiner fut, WAIT/50% mert kevés aktív signal

### Legfontosabb bug – apex-wallets.mts

A `getLeaderboard()` a Data API `/trades` endpointot hívja.
A trades response-ban BENNE VAN a `title` és `slug` mező!
Ezeket kell eltárolni az aggregációban, nem külön Gamma lookup-ot csinálni.

```typescript
// JELENLEGI HIBÁS MEGKÖZELÍTÉS:
// 1. /trades lekérés → wallet aggregáció (market conditionId-val)
// 2. consensus detection → conditionId lista
// 3. Gamma API lookup conditionId alapján → ROSSZ PIAC NÉV

// HELYES MEGKÖZELÍTÉS:
// 1. /trades lekérés → wallet aggregáció (conditionId + title + slug eltárolás)
// 2. consensus detection → conditionId lista + beépített title/slug
// 3. NINCS szükség Gamma lookupra
```

A `/trades` response mezői:
```json
{
  "proxyWallet": "0x...",
  "side": "BUY",
  "price": 0.54,
  "size": 100,
  "title": "Will X happen?",     ← EZT KELL HASZNÁLNI
  "slug": "will-x-happen",       ← ÉS EZT
  "conditionId": "0x...",
  "timestamp": 1234567890
}
```

### Signal Combiner – mikor ad valódi jelzést?

Jelenlegi állapot: 2/5 signal aktív, combined = 0.5, WAIT
Valódi BUY/SELL akkor lesz ha:
1. Az apex consensus javítva → helyes piac + BUY jelzés
2. Funding rate signal elérhető
3. Legalább 3 signal konvergál egy irányba

### Deploy workflow
```bash
git add -A && git commit -m "fix" && git push
```
Netlify auto-deploy ~1-2 perc után.
