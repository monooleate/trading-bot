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
| **Új live-mode bug / TODO (státusz-tracker)** | `internal-docs/roadmap/master-plan.md` "MI VAN MÉG HÁTRA" szekció (🔴/🟠/🟡/🟢 prioritás) |
| **Sprint-szintű operatív feladat (time-boxed, owner-rel)** | `internal-docs/roadmap/sprints.md` — active / next / backlog táblák |
| **Új VPS-process / Hetzner-feladat** | `internal-docs/roadmap/hetzner-migration.md` 7-fázisú action plan-be |
| **Új fizikai-layout-döntés** (Postgres séma, port, monitoring) | `internal-docs/roadmap/hetzner-infrastructure.md` |
| **Új env-vár / secret** | `internal-docs/current-state/env-vars.md` (NEM a roadmap-ban) |
| **Új algoritmus-leírás** | `internal-docs/math/NN-name.md` (új fájl + index frissítés) |
| **Új ismétlődő procedure / runbook** (pl. trade-audit, deploy-checklist) | `internal-docs/playbooks/NN-name.md` |
| **Session-by-session változás** | `internal-docs/changelog/CHANGELOG-YYYY-MM-DD.md` |

### Tilos (SSOT-sértés)

- ❌ **Státuszt két helyen vezetni**: ha `master-plan.md` ✅, akkor a `new-strategies.md` is ✅ — a két jelölés mindig szinkronban.
- ❌ **Session-by-session részleteket CLAUDE.md-be írni**: csak a `changelog/` és az aktuális állapot tömör hivatkozása maradjon a CLAUDE.md-ben.
- ❌ **Új tervezési fájl minden session-ben**: a 6 roadmap-doksi elég.
- ❌ **Live-state-et roadmap-pel keverni**: `current-state/` snapshot ≠ `roadmap/` tervezet.
- ❌ **Env-vár listát roadmap-ba írni**: csak `current-state/env-vars.md` a katalógus.
- ❌ **Sprint-feladatot bárhol máshol felvenni mint a `sprints.md`-ben** (2026-05-15 szabály): ha egy session során azonosítasz egy új code-change feladatot, sprint-jellegű follow-up-ot, vagy backlog-tételt, az **kizárólag** a `internal-docs/roadmap/sprints.md`-be kerül (Active / Next candidates / Backlog táblákba). A többi doksiba (`math/`, `changelog/`, `current-state/`, `master-plan.md`) **csak hivatkozás** mehet a sprints.md megfelelő tételére, pl. `→ Sprint 42A` vagy `→ Backlog B9`. **Tilos**: "Maradó limitációk" listák a math/-ben, "Mit NEM tett" szekciók a changelog-ban, vagy "TODO" jegyek a master-plan-ben, ha a feladat NINCS bevezetve a sprints.md-be. A sprints.md a feladat-SSOT.

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

> **2026-05-15 szabály**: minden sprint-jellegű task `internal-docs/roadmap/sprints.md`-ben van karbantartva (SSOT). Ez a szekció csak **stabil, sprint-szinten nem trackelt környezeti tudnivalókat** tartalmazza. Konkrét feladatok / TODO-k esetén → `sprints.md`.

### Környezeti tudnivalók (nem task)

- `{src/` és `{src/{components,pages,layouts},public}/` mappák artifact-ok a build folyamatból – **ignorálandók** (nem hiba)
- A `package-lock.json` 277K – ne szerkeszd manuálisan
- **Frank-Wolfe / Gurobi cond-prob solver**: IP solver licenc nélkül nem implementálható → permanens architektúra-állapot, nem sprint-tárgy (Anti-sprint blocked-by-license)

### Sprint-trackelt limitációk (pointerek)

| Limitáció | sprints.md hivatkozás |
|---|---|
| Signal Combiner IC priorok kalibrálása (50+ trade) | **B1** (Tier 2 reliability) + **B13** (Brier sub-task) |
| CV_edge nem valódi Monte Carlo | **B16** (Technical-debt cluster sub-item) |
| VWAP scanner real-time WebSocket | **B14** (Hetzner-függő, 1 hét) |
| Trade logging persistence (Supabase / Postgres) | **B12** (post-Hetzner, 2-3 nap) |
| Dashboard.tsx tab-array auto-generate | **B16** (Technical-debt cluster sub-item) |
| Cooldown map Blobs-perzisztálás | **B16** (Technical-debt cluster sub-item) |
| Live early-exit Netlify timeout | **B16** (Technical-debt cluster sub-item) |
| On-chain CTF redemption automatizálás | **B6** (Polymarket auto-redeem cron, P1.4) |
| Walk-forward backtest framework | **B11** (post-Hetzner, kritikus infra) |
| Weather bot σ kalibráció | **B15** (post-50-trade) |
| Live trading infrastructure prerequisites (HL + PM) | **B10** (BLOKKOLÓ, paper-gate-függő) |
| Topup action (bankroll növelése reset nélkül) | **Sprint 42B** (READY NOW, promotálva B9-ből 2026-05-15) |

---

## AKTUÁLIS ÁLLAPOT (2026-05-15)

**Élő deploy:** `mj-trading.netlify.app`. Paper mode, simVersion 3 (crypto), v2 (HL).

### 4 fő bot státusz

| Bot | Bankroll | PnL | Trades | Open | Megjegyzés |
|-----|---------|-----|--------|------|-------|
| **Crypto** | $250 → $237.00 | +$21.96 | 7 closed (3W/4L) | 2 open (paper) | 41. session: 7-trade history Gamma-revalidálva + bit-pontos PnL rekonstrukció — minden valid. Új 16. gate (Outcome-overlap) a következő tick-től véd a 80K-NO + 82K-YES típusú kontradikciók ellen. |
| **Weather** | $250 → $216.48 | -$5.10 | 2 closed (1W/1L) | 3 open | Mindkét closed trade real Polymarket resolution-on zárt — validált |
| **HL Perp** | $200 → $199.44 | -$0.56 | 4 closed (1W/3L) | 0 open | 3 consecutive loss → 1h pause triggerelt (design intent) |
| **F-Arb** | $200 → $200 (shared HL) | $0 | 0 closed | 0 open | Idle (paper) |

### Mit fix utoljára (42. session, 2026-05-15)

- **Sprint 42B Topup action** ✅ IMPLEMENTÁLVA: új `topup` action mind a 4 boton (crypto, weather, hyperliquid, funding-arb — sports stub kihagyva), auth-protected mint a `reset`. Új `topupSession()` helper a `crypto/session-manager.mts`-ben + `topupHlSession()` a `hyperliquid/session-manager.mts`-ben (F-Arb delegál ide a shared bankroll miatt). Új `SESSION_TOPUP` LogEvent. Új `handleTopup()` + `hlTopup()` exported function. Új `alertTopup()` Telegram helper. Frontend: új `topup?` prop a `TraderShell`-en — `💰 Top up…` gomb (a Reset gomb előtt) + dialog with dynamic `Current bankroll → After topup` preview, number input (range [1, 1M], step 1), validation + inline error display, Mégse + Confirm action. 5 új unit test (`shared/topup-action.test.mts`): standard topup state-preservation, stopped-not-cleared, HL-specific (consecutiveLosses + pausedUntil unchanged), additive (2×$50 = 1×$100), decimal cent. Preview verified: gomb megjelenik (`💰 Top up…`), dialog renderelődik teljes magyarázattal + before/after preview, validáció működik (`Adj meg pozitív összeget` negatív értékre), Mégse zárja a modal-t, zero console error. Megoldja a mai user-pain "ha elfogy a bankroll paper módban folytatni akarom reset nélkül" kérdést — most 1 kattintással bankroll injektálható a closedTrades + IC kalibráció + open positions megőrzésével. (changelog 2026-05-15 · sprints.md Sprint 42B)

- **Sports `sessionLossLimit` Settings-knob**: a sports bot eddig env-only küszöbe (`SPORTS_SESSION_LOSS_LIMIT`, default $30) Blobs-tunable lett. Új `sportsSessionLossLimit` SCHEMA mező a `trader-settings.mts`-ben (range 5-500 USD, step 5, group "Risk & sizing"); mind a 3 sports preset (Lazább 50 / Normál 30 / Szigorú 20 USD) bővült. `getEffectiveSportsConfig()` olvassa az új override-ot; `sports/index.mts` :213-as session-loss guard automatikusan használja. Trigger: az operátor "Session loss limit hit" auto-stopot kapott a sports bot-on és redeploy nélkül akarta a küszöböt módosítani. A crypto (`sessionLossLimit`) + HL Perp (`hlSessionLossLimit`) már Settings-tunable volt; weather + F-Arb nem rendelkezik session-loss-limit fogalommal jelenleg (külön sprint-tárgy ha kell). (changelog 2026-05-15 "Follow-up" szekció · sprints.md Sprint 42F)

### Mit fix korábban (41. session, 2026-05-15)

- **Sprint 42A K-blind downweight (speculative implementáció)**: a `signal-combiner.mts` `combine()` függvény új `marketKind: "threshold" | "directional"` paraméter + `kBlindDownweight: number = 1.0` szorzó. Új `K_BLIND_SIGNALS = {momentum, contrarian, funding_rate, pairs_spread}` Set. Új SCHEMA-knob `combinerKBlindDownweight` (range [0, 1], default 1.0 = zero behavior change). A downweight CSAK threshold (`bitcoin-above-Nk-on-...`) piacokon alkalmazódik (`parseThresholdK(slug) !== null` az ágválasztó), up-or-down + directional piacokon nincs változás → zero regression risk a meglévő bot trade-típusokra. 6 új unit test pin-eli a contract-et. Sprint 42 monitoring data alapján a knob 0.5-re átkapcsolható, ha 10+ post-fix trade-en a finalProb még flat — pillanatnyilag default-off. (changelog 2026-05-15)

- **vol_divergence K-extrakció root-cause fix**: a "lapos 0.46-os finalProb" mintázat (ami a 2026-05-14e Monotonicity-gate-et átengedte és a 2026-05-15 Outcome-overlap-gate-et triggerelte) gyökérokának javítása. A `getVolSignal` Black-Scholes digital képlete a strike K-t csak `up-or-down` piacokra állította be (openedAt BTC ár Binance kline-ból), `above-Nk` piacokra `K = S` fallback-be esett → `fair YES ≈ N(-σ√T/2) ≈ 0.5` K-tól függetlenül. Új `parseThresholdK(slug)` helper kinyeri a literal `N × 1000` USD értéket; a `getVolSignal` új Priority-1 ágban használja (`strikeSource: "slug-threshold"`). BTC $80,620 mellett a fix után: 78K → 0.98, 80K → 0.69, 82K → 0.14 — K-szerint meaningfully szétváló jel. A combiner output ezzel K-aware lesz; a Normal preset `Combiner confidence (|p − 0.5|)` gate-je automatikusan blokkolja a near-noise contrarian trade-eket. Új test `signal-combiner-threshold.test.mts` (11 case: parser-pin + BS-digital monotonicity invariáns). (changelog 2026-05-15)

- **Cross-position outcome-overlap gate (crypto, #16) + 7-trade history audit** — kettős munka egy ülésben.
  - **Audit**: a `/edge-tracker?category=crypto` 7 closed trade-jét végigellenőriztük Polymarket Gamma `&closed=true` API-n — mind a 7 exit egyezik a real resolution-nel. A paper-fee modell (`applySettlementFee`, 3.6% roundtrip) szerint mind a 7 PnL érték ±3 tizedesjegyen belül reprodukálható. Bankroll-rekonciliáció ($250 + $21.96 − $34.96 open = $237.00) konzisztens. **A history valid és a PnL reális.**
  - **Új gate**: ma reggel a bot nyitott egy `NO@above-80k-may-15` (pred=46.04%) + `YES@above-82k-may-15` (pred=45.57%) párost. A predikciók szigorúan monoton csökkenőek (a Sprint 39e Monotonicitás-gate helyesen átengedte), de a bet-oldalak nyerési zónái diszjunktak — a (80K, 82K] sáv **mindkét pozíción** bukik. Új `findOutcomeOverlapViolation` shared helper + új gate `CRYPTO_GATE_LABELS[15]` pozíción: NO@K_lo + YES@K_hi (K_hi > K_lo) pár blokk. **Strukturálisan különbözik** a #15 Monotonicitás-gate-től: a #15 a predikció-koherenciát ellenőrzi, a #16 a side-bet kontradikciókat. Mindkét gate független és komplementer.
  - **A többi 4 bot változatlan** — már Sprint 39e óta tartalmazzák a saját outcome-overlap-analógjukat (Weather Σ P(YES) ≤ 1, HL Directional-consistency, F-Arb Coin-capacity, Sports Outcome-sum). Mindegyik decision-engine-be coverage-comment került, hogy a gate-térkép explicit legyen.
  - 8 új test case (összesen 18) a `cross-position-gates.test.mts`-ben. `npx tsc --noEmit` + `npm run build` + test suite mind zöld. (changelog 2026-05-15)

### Mit fix korábban (40. session, 2026-05-14f)

- **HL Perp consecutive-loss pause UX + Settings**: két UX-hiányosság a HL pause-rendszerben fixelve.
  - **Inline action a pause/stopped alerten**: a `TraderAlert` interface kapott egy opcionális `action: { label, onClick, disabled?, title? }` mezőt. A HL pause alert most `Cancel pause` gombbal renderelődik, a stopped alert pedig `Resume`-mal. Az operátornak már nem kell külön gombot keresnie a kontroll-panelen — a warning mellett azonnali action. `display: flex; gap: 12px` layout, gomb a tone-color öröklődéssel (`border: 1px solid currentColor`).
  - **Új Settings knob `hlConsecutiveLossPauseHours`**: korábban env-only (`HL_CONSEC_LOSS_PAUSE_HOURS=1`), most Settings-tunable. Default 1h, range 0.0833h (~5 perc tesztre) — 24h. A 3 HL preset is bővült (loose 0.5h, normál 1h, szigorú 2h). A `getEffectiveHlConfig()` korábban kihagyta a `consecutiveLossPauseHours` override-ot — most már olvassa a Blobs-ot.
  - Hatás: az operátor 1 kattintással törli a pause-t (vagy a Settings-ben átállítja az időt rövidebbre tesztre). A többi 4 bot változatlan — az `action?` field opcionális. (changelog 2026-05-14f)

### Mit fix korábban (39. session, 2026-05-14e)

- **Cross-market consistency gate — mind az 5 botra**: új shared helper (`auto-trader/shared/cross-position-gates.mts`) + bot-specifikus gate-ek a decision-engine non-short-circuit gate-listák végén. Trigger: 2026-05-14 paper session — a Crypto bot nyitott egy `bitcoin-above-78k-on-may-14` NO @ pred=52% pozíciót, majd egymás után egy `bitcoin-above-80k-on-may-14` YES @ pred=53% pozíciót. Matematikailag `P(>78K) ≥ P(>80K)` kötelező (monotonicitás), a model 52% < 53% ellentmondás → BTC $79K körüli zóna mindkét pozíciónak loser. Az új gate ezt blokkolja.
  - **Crypto**: új `Monotonicitás (egyéb nyitott pozíciók)` gate (CRYPTO_GATE_LABELS[14]). Slug parser `bitcoin-above-(\d+)k-on-(.+)$`. Ha K_new > K_old (azonos closingKey) és pred_new > pred_old → blokk (és fordítva).
  - **Weather**: új `Monotonicitás (egyéb nyitott pozíciók)` gate (WEATHER_GATE_LABELS[7]). NegRisk bucket-ek kölcsönösen kizárók → Σ P(YES) ≤ 100% ugyanazon (city, date) csoporton. Csak YES kandidátusokon fut.
  - **HL Perp**: új `Directional-consistency (no LONG+SHORT same coin)` gate (HL_GATE_LABELS[7]). A meglévő "Coin nincs már nyitva" gate stricter; az új gate explicit LONG+SHORT-pár ellenőrzés (unleveraged + 2× fee → strict negatív EV) defense-in-depth.
  - **F-Arb**: új `Coin-capacity (cross-position)` gate (ARB_GATE_LABELS[5]). A meglévő "Per-coin uniqueness" mellé layered — F-Arb pozíció = 1 HL-short + 1 Binance-long, coin-szintű duplikáció = redundáns kapacitás + korrelált exit-risk.
  - **Sports**: új `Outcome-sum (cross-position)` gate. SportsPosition kapott `eventSlug?: string` mezőt (backward compat). Ha YES kandidátus, Σ P(YES) ugyanazon eventSlug-on + new candidate ≤ 1.0 — különben 3 YES = garantált fee-veszteség.
  - Új tsx test suite (`shared/cross-position-gates.test.mts`) ellenőrzi a parsert + violation-finder-t a 2026-05-14 incident reprodukálással. `npm run build` + `npx tsc --noEmit` tisztán átmegy. (changelog 2026-05-14e)

### Mit fix korábban (38. session, 2026-05-14d)

- **Edge Tracker — Tier-1 metric expansion (mind az 5 kategórián automatikusan)**: a `computeSummary` 9 új mezővel bővült — **Profit Factor, Sortino, Expectancy, Payoff Ratio, longest/current Win-Loss streak, EV-gap (Σactual − ΣEV)**, valamint **Sharpe 95% bootstrap CI** (200 resample, determinisztikus LCG-seed) és **Max DD duration**. A SummaryCards mostantól két soros (6+6 kártya), az extended sor `surface2` háttéren válik el. Új `UnderwaterDrawdownChart` (area-fill loss-color) közvetlenül a CumulativePnlChart alatt — running underwater curve + worst-DD annotation + DD duration text. A `CumulativePoint` is bővült `drawdown` + `peak` mezővel, így a frontendnek elég egyetlen response-objektum. Direction-aware EV (LONG/SHORT/YES/NO), HL-perp esetén `tradeEv → t.pnl` (binary collapse) hogy az EV-gap ne hazudjon perp piacokon. **Minden bot (crypto/weather/HL/F-arb/sports) automatikusan kap minden új metrikát** a meglévő `CategoryDashboard /trade/{category}/edge-tracker` routingon át — nincs per-bot kód-duplikáció. (changelog 2026-05-14d)
- **CryptoPriceTicker — live spot reference a 3 crypto trader oldalon**: új shared komponens (`src/components/shared/CryptoPriceTicker.tsx`) + új Netlify Function (`binance-price.mts`, Bybit primary / Binance fallback, 15s Blobs cache). A Crypto bot oldalán BTC (Polymarket BTC short-markets reference), HL Perp + F-Arb oldalon BTC/ETH/SOL. UX best practices: 30s frontend poll (cache-koherens), `visibilitychange` → tab-hidden pause, "stale" badge ha >2.5× pollMs nincs friss válasz, ár-flash up/down színes background-villanás max 800ms-ig, mobil horizontal scroll-snap (≤640px). Auto-fill grid (NEM auto-fit) — single-coin Crypto-n a kártya ~180px marad. Desktop verified: BTC card 206px wide; mobile verified (375×812): BTC 158px + scroll-snap row működik (rowScrollW=490 > rowClientW=295 HL-en, BTC fully in view). (changelog 2026-05-14d)

### Mit fix korábban (37. session, 2026-05-14c)

- **Coach-mode Recommendations engine** (mind a 4 botra): per-bot Apply-able javaslat-lista a closed trade history alapján. Nem auto-tuning — operator-in-the-loop sanity check. Új RecommendationsCard a 4 TraderShell tetején; lista a `/recommendations-api?category=<cat>` endpoint-ról jön (auth-protected). Apply gomb a meglévő `trader-settings` POST-on keresztül módosít. 8 szabálycsoport: realized-IC toggle, per-signal noise warning, confidence-min tuning, edge-bucket reliability, F-Arb min-spread tuning, weather ensemble bekapcsolás, drawdown attention. Hard guardrail-ek (Kelly, sanity cap, session-loss-limit, liveReadyOverride) **soha nem javaslat-tárgyak**.
- **Time-decay IC**: új `icHalfLifeTrades` Settings knob (default 0 = uniform, ajánlott 50). Exponenciális recency weighting a realized-IC Pearson korrelációra → regime-shift drift védelem. Új `weightedPearsonCorrelation` helper az `edge-tracker/statistics.mts`-ben.
- **Weather signal-calibration**: a `persistCalibration` mostantól weather-re is fut (synthetic `forecast_edge` signal) — eddig csak crypto + HL volt. (changelog 2026-05-14c · részletes spec: `internal-docs/math/17-recommendations-engine.md`)

### Mit fix még korábban (36. session, 2026-05-14b)

- **Live-readiness override + Realized-IC kalibráció**: két új Settings-mechanizmus.
  - **Override**: új `liveReadyOverrideEnabled` (bool) knob, ami bypassolja a 4 bot 7-gate readiness-ellenőrzését — `PAPER_MODE=false` esetén közvetlenül live-ra megy. Új piros "OVERRIDE — LIVE" jelzés a LiveReadinessBadge-en + Telegram alarm session-enként 1× audit-célból.
  - **Realized-IC**: új modul `auto-trader/shared/signal-calibration.mts` — minden cron-tick záráskor lementi a closedTrades per-signal Pearson IC-jét Blobs-ba (crypto + HL). A signal-combiner új `?category=` paramétert kap; ha `useRealizedIC=1` toggle ON, Bayes-shrinkage-zel keveri a realized IC-t a statikus priorokba: `effective_ic = n/(n+k) × realized + k/(n+k) × prior`, K alapból 30. Edge Tracker új "Signal IC calibration" kártyája mutatja a Prior / Realized / Effective oszlopokat. (changelog 2026-05-14b)

### Mit fix régebben (35. session, 2026-05-14)

- **Weather forecast-forrás upgrade-opciók dokumentálva** (doksi-only, kód nem érintve): a math/16-weather-bot.md §3.B új szekciója részletezi a 3 lehetséges upgrade-utat — (a) ECMWF közvetlen 51-tagú ensemble, (b) NOAA GFS GRIB2 közvetlen S3 pull, (c) kereskedelmi szolgáltatók. Master-plan 🟢 NICE-TO-HAVE 13. tételével keresztezve. A §3 táblázat alatt explicit megjegyzés: **mind a 4 jelenlegi forrás zéró-auth, egyetlen API-kulcs sem kell**. (changelog 2026-05-14)

### Mit fix legrégebben (34. session, 2026-05-13)

- **Mobile UI optimalizálás + tap-to-tooltip rendszer**: a 100+ `title=` HTML hover-tooltip mostantól mobilon is működik (touch-tap-re custom popup `Base.astro`-ban inline JS-sel). Global `.tbl-scroll` wrapper class minden táblán (Apex/ArbMatrix/SignalCombiner/OrderFlow/VolDivergence/TradingPanel — 12 tábla). iOS auto-zoom megelőzése (input font-size ≥16px), notch/safe-area support, `theme-color` meta. Dashboard shell mobile breakpoints (`ec-header`, `ec-tabs`, `ec-card`). (changelog 2026-05-13)

> Régebbi session-ök (≤ 33. session, 2026-05-12 és korábban) — lásd `internal-docs/changelog/`.

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
7. **Trade history audit user-kérésre** ("validate", "PnL valós?", "audit", "ellenőrizd", URL: `mj-trading.netlify.app/trade/<cat>/`): kötelezően kövesd a [`internal-docs/playbooks/trade-history-audit.md`](./internal-docs/playbooks/trade-history-audit.md) 5-step procedure-ét — 5 adatforrás párhuzamos lekérdezés, Gamma cross-check, 3.6% paper-fee PnL-reprodukció, bankroll-rekonciliáció, cross-position konzisztencia, statisztikai sanity. A playbook tartalmazza az ismert bug-patternek ujjlenyomatait + a Settings-knob és Sprint-promotion javaslatokat.

### Történeti tanulságok (a részletek a changelog-ban)

- **simV3 paper-resolver fix (2026-05-10)** — Brownian-bridge sim kivéve, csak real Polymarket resolution (Gamma `&closed=true` kötelező). Paper PnL == live PnL.
- **6-fix crypto audit (2026-05-11)** — 12-gates decision-engine, kelly conviction gate, combiner recommendation gate, resolution-risk gate, paper fee parity.
- **8-fix crypto deep audit (2026-05-11)** — vol_divergence T→0 gate, bankroll drift fix, apex consensus signal cleanup, cond_prob direction-aware, momentum regime-aware, EV baseline direction-aware, frontend "8 signals".
- **5-fix weather audit (2026-05-11)** — bucket-matcher tail-CDF v2, market-disagreement gate, ensemble default ON, cloud avg, per-category log filter.
- **HL bot live exit + lot precision fix (2026-05-10)** — `live-resolver.mts`, Binance `exchangeInfo` cache, cooldown Blobs persistence, paper slippage modeling.
- **Auto-Trader UI unification (2026-05-09)** — 4 trader → 1 `TraderShell` + 5 reusable card, ~1500 LOC → ~778 LOC.

Mindig nézd meg a `internal-docs/changelog/`-ot a részletekért, mielőtt feltételezést teszel.
