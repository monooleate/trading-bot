# EdgeCalc – CLAUDE.md

Ez a fájl Claude Code számára készült. Minden fejlesztési session elején olvasd el.

---

## ⚠️ KÖTELEZŐ SESSION-ZÁRÓ SZABÁLY

**Minden session végén frissíteni kell a dokumentációt.** Ez nem opcionális.

Mielőtt a sessiont lezárod (utolsó válasz a usernek), végezd el az alábbi ellenőrző listát:

1. **CLAUDE.md `AKTUÁLIS ÁLLAPOT` szekció** – ha bármi élő rendszerállapot változott (működő/hibás tabok, ismert bugok, deploy státusz), frissítsd a dátummal együtt (`AKTUÁLIS ÁLLAPOT (YYYY-MM-DD)`). **Csak az aktuális állapotot tartsd benne**, ne halmozz history-t — a részletes session-history a `changelog/`-ban él.
2. **`internal-docs/` érintett fájlok** – ha egy tab/function/algoritmus logikája változott, frissítsd a hozzá tartozó markdown fájlt:
   - **`current-state/`** – ha élő rendszer-állapot változott (architecture, deploy, settings, env, trading-status, auto-claim).
   - **`math/`** – ha egy signal vagy bot algoritmusa változott (pl. `math/06-orderflow.md`, `math/13-crypto-bot.md`).
   - **`roadmap/`** – ha a jövőbeli tervek / Hetzner-migráció / új stratégiák állapota változott.
3. **`internal-docs/changelog/`** – minden nem-triviális változásnál hozz létre vagy egészíts ki egy `CHANGELOG-YYYY-MM-DD.md` fájlt: mit változtattál, miért, melyik fájl(ok)ban. **A részletes session-leírások IDE kerülnek, NEM a CLAUDE.md-be.**
4. **Új tab vagy function** – kötelezően új `internal-docs/math/NN-name.md` fájl + bejegyzés az `internal-docs/README.md`-ben + a CLAUDE.md tab-táblázat bővítése.
5. **TODO / Hiányos implementációk** – ha új technikai debt keletkezett vagy egy meglévő megoldódott, frissítsd az `Ismert limitációk és TODO-k` szekciót.

**Ha nem volt érdemi változás** (csak kérdés/olvasás történt), akkor sem kell üres commit – de mondd ki explicit a session végén: *"Nincs dokumentáció-frissítés szükséges, mert csak X történt."*

---

## 📋 Doksi SSOT-szabályok

**Minden téma egyetlen fájlban él** — a duplikációkat tudatosan kerüljük.
Az [`internal-docs/roadmap/README.md`](./internal-docs/roadmap/README.md) az SSOT-mátrix forrása.

### Új ötlet hova kerüljön?

| Ötlet típusa | Hová kerüljön |
|--------------|---------------|
| **Új signal / új trade-stratégia** | `internal-docs/roadmap/new-strategies.md` — új #N tétel a Top 11 / Mid / Long sorrend szerint, Score-számolással |
| **Új live-mode bug / TODO** | `internal-docs/roadmap/master-plan.md` "MI VAN MÉG HÁTRA" szekció (🔴/🟠/🟡/🟢 prioritás) |
| **Új VPS-process / Hetzner-feladat** | `internal-docs/roadmap/hetzner-migration.md` 7-fázisú action plan-be |
| **Új fizikai-layout-döntés** (Postgres séma, port, monitoring) | `internal-docs/roadmap/hetzner-infrastructure.md` |
| **Új env-vár / secret** | `internal-docs/current-state/env-vars.md` (NEM a roadmap-ban) |
| **Új algoritmus-leírás** | `internal-docs/math/NN-name.md` (új fájl + index frissítés) |
| **Session-by-session változás** | `internal-docs/changelog/CHANGELOG-YYYY-MM-DD.md` |

### Tilos (SSOT-sértés)

- ❌ **Státuszt két helyen vezetni**: ha `master-plan.md` ✅, akkor a `new-strategies.md` is ✅ — a két jelölés mindig szinkronban.
- ❌ **Session-by-session részleteket CLAUDE.md-be írni**: csak a `changelog/` és az aktuális állapot tömör hivatkozása maradjon a CLAUDE.md-ben.
- ❌ **Új tervezési fájl minden session-ben**: a 6 roadmap-doksi elég.
- ❌ **Live-state-et roadmap-pel keverni**: `current-state/` snapshot ≠ `roadmap/` tervezet.
- ❌ **Env-vár listát roadmap-ba írni**: csak `current-state/env-vars.md` a katalógus.

---

## Mi ez a projekt?

**EdgeCalc** egy kvantitatív Polymarket trading dashboard. **Nem** copy-trade bot, **nem** affiliate platform. Matematikai alapú saját implementáció akadémiai irodalom alapján.

**Stack:** Astro 5 + React 18 + TypeScript + Netlify Functions + Tailwind CSS
**Python:** 4 standalone CLI script lokális elemzéshez
**Verzió:** v8

---

## Mappaszerkezet

```
edge-calc/
├── src/
│   ├── components/          ← React komponensek (egy tab = egy fájl)
│   │   ├── Dashboard.tsx    ← Tools tab router, bankroll state, auth
│   │   ├── HomePage.tsx     ← Főoldali mission control
│   │   ├── CategoryDashboard.tsx  ← Per-bot trader page wrapper
│   │   ├── SettingsPanel.tsx
│   │   ├── EdgeTrackerPanel.tsx
│   │   ├── shared/          ← Trader shell + 5 reusable card + AuthGate + ConfirmDialog + Badges
│   │   ├── trader/          ← Per-bot panel (Crypto/Weather/HL/F-Arb/Sports + manual venues)
│   │   └── *Panel.tsx       ← /tools/ analytical tabs (OrderFlow, VolDiv, Apex, CondProb, Signals, ArbMatrix)
│   ├── styles/global.css    ← CSS variables, dark theme
│   ├── layouts/Base.astro
│   └── pages/index.astro
├── netlify/functions/       ← Netlify Functions (.mts)
│   ├── auto-trader-api.mts  ← Top-level dispatcher (action=status/run/reset/stop/resume/reconcile)
│   ├── auto-trader/         ← Per-bot modules (crypto/weather/hyperliquid/sports/politics/macro)
│   ├── *-cron.mts           ← Scheduled wrappers
│   └── ...                  ← Signal/tool endpoints (signal-combiner, vol-divergence, apex-wallets...)
├── internal-docs/
│   ├── README.md            ← Index — itt kezdj
│   ├── current-state/       ← Élő rendszer (architecture, env-vars, deploy, settings, trading-status, auto-claim)
│   ├── math/                ← Signal math + bot implementation reference (02-ev-kelly … 16-weather-bot)
│   ├── roadmap/             ← Hetzner migráció, master-plan, új stratégiák, infrastructure
│   ├── changelog/           ← Session-by-session history (a részletes leírások IDE jönnek)
│   └── archive/             ← Elkészült promptok + historikus tanulságok
├── apex_wallet_profiler.py / vol_divergence.py / orderflow_analyzer.py / conditional_prob_matrix.py
├── astro.config.mjs / netlify.toml / package.json
```

---

## A 11 /tools/ Tab és funkcióik

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

## A 6 Auto-Trader Bot

| Kategória | Indexfájl | Cron | Strategy |
|-----------|-----------|------|----------|
| `crypto` | `auto-trader/index.mts` | */3 min (multi-cron) | 8-signal combiner BTC short-markets |
| `weather` | `auto-trader/weather/index.mts` | */5 min (own cron) | GFS ensemble → Polymarket city temp |
| `hyperliquid` | `auto-trader/hyperliquid/index.mts` | */3 min (multi-cron) | HL directional perp (signal-driven) |
| `funding-arb` | `auto-trader/hyperliquid/funding-arb/index.mts` | */3 min (multi-cron) | HL/Binance funding rate spread |
| `sports` | `auto-trader/sports/index.mts` | manual | Pinnacle vs Polymarket |
| `politics` + `macro` | `auto-trader/politics`, `/macro` | manual | Event-driven |

---

## CSS Design System

**SOHA ne használj inline Tailwind utility class-okat** – a projekt saját CSS variable rendszert használ.

```css
var(--bg) #0a0a0c · var(--surface) #101014 · var(--surface2) #16161c
var(--border) #1e1e28 · var(--text) #e8e8f0 · var(--muted) #6b6b80
var(--accent) #c8f135 (zöld YES) · var(--danger) #f13535 (piros NO)
var(--accent2) #35c8f1 (kék info) · var(--warn) #f1a035 (narancs)
var(--mono) 'JetBrains Mono' · var(--sans) 'Inter'
```

**Komponens CSS pattern:** minden komponens a saját `<style>` blokkjában definiálja az osztályokat, prefix-szel (pl. `aw-`, `cp-`, `sc-`, `ts-` a shared trader shell-nél). Nem globális CSS.

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
const TTL_MS = 5 * 60 * 1000;

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
GAMMA_API  = "https://gamma-api.polymarket.com"
CLOB_API   = "https://clob.polymarket.com"
DATA_API   = "https://data-api.polymarket.com"
BINANCE    = "https://api.binance.com"
BN_FUTURES = "https://fapi.binance.com"
BYBIT      = "https://api.bybit.com"
HL_INFO    = "https://api.hyperliquid.xyz/info"
```

**FONTOS Gamma kvirk:** csak `&closed=true` query-vel találja a lezárult market-eket. Ennek hiánya volt a 2026-05-10 simV3 paper-resolver bug oka.

---

## Auth rendszer

- **SHA-256 + JWT** (jose library)
- HttpOnly Secure cookie, 8h session
- `_auth-guard.ts` helper minden védett function-ben
- Hash generálás: `node -e "console.log(require('crypto').createHash('sha256').update('jelszo').digest('hex'))"`

**Env vars (teljes katalógus:** `internal-docs/current-state/env-vars.md` — 61 változó 13 csoportba)

```
JWT_SECRET=<32+ karakter random>
AUTH_PASSWORD_HASH=<sha256 hash>
ANTHROPIC_API_KEY=<sk-ant-...>
BYBIT_API_KEY / BYBIT_API_SECRET / BYBIT_TESTNET=true
BINANCE_API_KEY / BINANCE_API_SECRET / BINANCE_TESTNET=true
HL_PRIVATE_KEY=<0x + 64 hex>
PAPER_MODE=true  ← élesedés előtt mindig
```

---

## Matematikai kontextus (rövid)

A részletes leírás az `internal-docs/math/`-ben van. Rövid összefoglaló:

**Kyle λ** – adverse selection: $\Delta p = \lambda \cdot Q$
**VPIN** – toxikus flow: $\frac{\sum |V^B - V^S|}{\sum V}$, > 0.7 → informált kereskedők
**Hawkes** – trade clustering: $\lambda^*(t) = \mu + \sum \alpha e^{-\beta(t-t_i)}$
**Grinold-Kahn** – $IR = IC \times \sqrt{N}$
**Kelly** – $f^* = \frac{pb - q}{b}$, ¼-Kelly + 8% binary cap (intézményi standard)
**Payout ratio** – $\frac{\overline{W}}{\overline{L}}$, break-even WR = $\frac{1}{1+PR}$
**Bregman projekció** – $\mu^* = \arg\min_{\mu \in M} D_{KL}(\mu \| \theta)$
**Bonferroni IC threshold** – familywise α / signal_count (multiple comparisons fix)
**Black-Scholes digital** – fairYes = N(d₂), vol_divergence T → 0 stable

---

## Python scriptek

```bash
python apex_wallet_profiler.py --demo / --consensus / --profile 0x... / --leaderboard --json
python vol_divergence.py        --demo / --watch / --json
python orderflow_analyzer.py    --demo / --token-id <id> / --list-markets
python conditional_prob_matrix.py --demo / --scan-btc / --scan-fed / --custom slug-a slug-b
```

---

## Fejlesztési szabályok

### Új tab hozzáadása

1. Komponens: `src/components/NewPanel.tsx`
2. CSS prefix: egyedi 2-3 karakteres prefix (pl. `np-`)
3. Demo data: mindig legyen DEMO konstans, `is_demo: true` flag
4. Dashboard: `Dashboard.tsx`-ben import + tab array + render bővítése
5. Function: `netlify/functions/new-panel.mts`
6. Dokumentáció: `internal-docs/math/NN-new-panel.md`

### Új auto-trader bot

1. Új mappa `netlify/functions/auto-trader/<bot>/`: `index.mts`, `decision-engine.mts`, `session-manager.mts`, stb.
2. `auto-trader/index.mts` (top dispatcher) routing kibővítése
3. UI: új trader file `src/components/trader/<Bot>Trader.tsx` (~150 LOC) a `TraderShell` + `useAutoTraderStatus(category)` + `useTraderAction(category)` hookok köré
4. `multi-status.mts`-be új ág
5. `HomePage.tsx` CARDS array bővítése
6. `internal-docs/math/NN-<bot>.md` doksi

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
}
```

### ¼-Kelly számítás (egységes pattern — `src/lib/math.ts`)

```typescript
function kellyBinary(p: number, price: number, bankroll: number): number {
  const b = (1 / Math.max(price, 0.01)) - 1;
  const q = 1 - p;
  const f = Math.max(0, (p * b - q) / b);
  return (f * 0.25 * bankroll);  // ¼-Kelly + 8% hard cap kívül
}
```

### Gate-list pattern (mind a 4 bot decision-engine-jén)

Minden bot non-short-circuit gate-eket épít:
- `gates: DecisionGate[]` array, minden gate `{label, passed, actual, required, hint}`
- `shouldTrade = gates.every(g => g.passed)`
- Az early-exit ágak is padded gate-listával jönnek (`pad*Gates(evaluated)` helper)
- A frontend `criteria` builder ha `r.gates` non-empty → backend payload, egyébként legacy mapper fallback

---

## Build és deploy

```bash
npm install
npm run dev          # localhost:4321 (csak frontend)
netlify dev          # localhost:8888 (full stack)
npm run build        # dist/
netlify deploy --prod --dir=dist
```

**Fontos:** `netlify dev` szükséges a functions teszteléséhez lokálisan.

---

## Ismert limitációk és TODO-k

### Technikai debt

- `Dashboard.tsx` tab array manuálisan szinkronizálandó új tabok esetén (nem generált)
- `{src/` és `{src/{components,pages,layouts},public}/` mappák artifact-ok a build folyamatból – ignorálandók
- A `package-lock.json` 277K – ne szerkeszd manuálisan

### Hiányos implementációk

- **Signal Combiner IC becslések:** priorok, nem mért értékek. 50+ trade után kalibrálni kell.
- **CV_edge:** nem valódi Monte Carlo, IR-ből becsült proxy.
- **VWAP scanner:** 90 mp cache – real-time WebSocket kellene production-ban.
- **Frank-Wolfe / Gurobi:** nincs implementálva (IP solver licenc szükséges).
- **Trade logging:** nincs Supabase integráció – minden session stateless (Netlify Blobs).

---

## AKTUÁLIS ÁLLAPOT (2026-05-12)

**Élő deploy:** `mj-trading.netlify.app`. Paper mode, simVersion 3 (crypto), v2 (HL).

### 4 fő bot státusz

| Bot | Bankroll | PnL | Trades | Open | Megjegyzés |
|-----|---------|-----|--------|------|-------|
| **Crypto** | $250 → $250 | $0 | 0 closed | 0 open | Nem nyitott a v3 paper-resolver óta (combiner confidence gate túl szigorú — lásd 2026-05-12 session) |
| **Weather** | $250 → $216.48 | -$5.10 | 2 closed (1W/1L) | 3 open | Mindkét closed trade real Polymarket resolution-on zárt — validált |
| **HL Perp** | $200 → $200 | $0 | 0 closed | 0 open | Idle (paper) |
| **F-Arb** | $200 → $200 (shared HL) | $0 | 0 closed | 0 open | Idle (paper) |

### Mit fix utoljára (33. session, 2026-05-12)

- **CLAUDE.md karcsúsítva** (2028 → 410 sor, session history kivéve → `changelog/`)
- **Settings preset rendszer**: Loose/Normal/Strict per-bot kapcsoló a Settings tabon, leiratokkal. 16 új knob (HL + F-Arb + Sports — eddig env-only)
- **Live-gate snapshot open pozíciókon**: a "Why?" panel mostantól nemcsak a frozen entry-decision-t mutatja, hanem a current gate-állapotot is (narancs strip, `evaluatedAt`)
- **Live-gate fix (mind a 4 bot)**: a Why? Live-Gates panel most a VALÓS jelenlegi gate-állapotot mutatja (crypto + weather loop megszűnt korai-skip-pelni "already open" stub-bal). UI filter dobja a "not evaluated" placeholdereket + open-position-uniqueness gate-eket — csak releváns gate-ek látszanak. Verdict frázis: *"MOST megnyitná"* / *"MOST NEM nyitná (N gate ✗)"*. (changelog §i)
- **Weather audit**: 2 closed trade verified, mindkettő real Polymarket resolution-on zárt, PnL helyes
- **Crypto bot diagnosztika**: a Combiner confidence gate (5%) blokkolt mindent — `Loose` preset 2%-ra állítja

### Mit fix korábban (32. session, 2026-05-11)

- Tier 1 math fix: vol_divergence Black-Scholes N(d₂), collinearity matrix, Bonferroni IC threshold (`internal-docs/math/13-crypto-bot.md` §9)
- Signal Combiner UI "Edge" javítva (50% deviation → valódi trade edge)
- Tier 1 belső konstansok exposed Settings tabon (5 új field, defaults = bit-azonos viselkedés)
- Roadmap SSOT-konszolidáció (6 fájl, scope-headers)
- Sports bot mutex + bankroll fix

### Legközelebbi prioritások

1. **Apply Crypto Loose preset** → 30+ paper trade ~1-2 nap alatt → IC validáció → vissza Normál-ra.
2. **Tier 2** — reliability diagram per-prediction bin (200+ closed trade precondition, ~2-4 hét).
3. **Tier 3** — MAE + time-based invalidation HL Perp bot-on.
4. **Hetzner migráció** — 7-fázisú action plan az `internal-docs/roadmap/hetzner-migration.md`-ben.

### Hova nyúlj legközelebb

1. **Új signal-ötlet**: új #N tétel a `new-strategies.md`-be Score-számolással
2. **Új live-mode TODO**: új sor a `master-plan.md` "MI VAN MÉG HÁTRA" 🔴/🟠/🟡/🟢 szekcióba
3. **Új VPS-feladat**: új fázis-lépés a `hetzner-migration.md`-be
4. **Új env-vár**: `current-state/env-vars.md`, NEM a roadmap
5. **Új algoritmus**: új `math/NN-name.md` + index-frissítés
6. **Session-zárás**: a "📋 Doksi SSOT-szabályok" checklist + új `changelog/CHANGELOG-YYYY-MM-DD.md`

### Történeti tanulságok (a részletek a changelog-ban)

- **simV3 paper-resolver fix (2026-05-10)** — Brownian-bridge sim kivéve, csak real Polymarket resolution (Gamma `&closed=true` kötelező). Paper PnL == live PnL.
- **6-fix crypto audit (2026-05-11)** — 12-gates decision-engine, kelly conviction gate, combiner recommendation gate, resolution-risk gate, paper fee parity.
- **8-fix crypto deep audit (2026-05-11)** — vol_divergence T→0 gate, bankroll drift fix, apex consensus signal cleanup, cond_prob direction-aware, momentum regime-aware, EV baseline direction-aware, frontend "8 signals".
- **5-fix weather audit (2026-05-11)** — bucket-matcher tail-CDF v2, market-disagreement gate, ensemble default ON, cloud avg, per-category log filter.
- **HL bot live exit + lot precision fix (2026-05-10)** — `live-resolver.mts`, Binance `exchangeInfo` cache, cooldown Blobs persistence, paper slippage modeling.
- **Auto-Trader UI unification (2026-05-09)** — 4 trader → 1 `TraderShell` + 5 reusable card, ~1500 LOC → ~778 LOC.

Mindig nézd meg a `internal-docs/changelog/`-ot a részletekért, mielőtt feltételezést teszel.
