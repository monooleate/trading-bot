# EdgeCalc – CLAUDE.md

Ez a fájl Claude Code számára készült. Minden fejlesztési session elején olvasd el.

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
