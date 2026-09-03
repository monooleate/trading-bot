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

## AKTUÁLIS ÁLLAPOT (2026-09-03)

**Élő deploy:** **`https://trade.jmeszaros.dev`** — a Hetzner `analytics` Docker co-host (workers+api+model), **ÉL paper módban** (2026-09-02, Phase 5 kész). **Deploy módja (2026-09-03 frissítve):** a box **AUTO-DEPLOYOL** a GitHub Actions-ön át — push `main`-re → `ci.yml` (tsc+teszt+build) zöld → `deploy.yml` (workflow_run) **rsync-eli** a CI-validált commitot a runnerről a boxra (`rsync -rlptz --delete`, a box-lokális `.env`/`data`/`logs`/`dist`/`.git`/`.claude` kizárva) → `docker compose up -d --build` (+`.env`-őr). Ez leváltotta a box-oldali `git pull`-t (az anonim-HTTPS git rate-limit néha 401-elt). Kézi fallback: `ssh analytics` → `git pull --ff-only && docker compose up -d --build` (de utána a fa „dirty" lehet a rsync-hez képest → inkább a Deploy workflow újrafuttatása). **A teljes B49 A-lépcső (#1–#9) + a 67. session audit-fixek (`d2143f5`) DEPLOYOLVA és élnek** (2026-09-03, paper, verifikálva: publikus HTTP 200, workers tick 5s), a knobok default-OFF (0 viselkedés-változás). Memória: `hetzner-box-deploy`. A régi `mj-trading.netlify.app` Netlify-build a `main`-en törött (a monorepo-restruktúra óta), a Netlify **nyugdíjazásra vár** (a user törli — Phase 6 — de előbb a Phase 4 adat-export döntés). Paper mode végig.

### Legutóbbi munka (79. session, 2026-09-03) — a B50 training-commitok (#1–#9) audit-passza → 5 fix

A user: **validáld és auditáld az előző audit (67. session, `d2143f5`) óta eltelt commitokat** (a „trading bot optimization" = B50 training) megvalósításra + biztonságra, a hibákat javítsd, push a `main`-re. **4 párhuzamos read-only audit-ágens** a `d2143f5..HEAD` diffen (50 fájl, ~3700 sor). **Verdikt: 0 P0/P1** — a security + UI/contract tiszta, a core-math textbook-helyes; **1 P2** (sports-ledger) + 4 P3 javítva (`tsc` 0 + **44/44 teszt** + build zöld, `main`, **push-olva → deploy**). **Fő fix:** a **sports-ledger (B50 #9) gyakorlatilag inert volt** — a result-rowok nem hordoztak `endDate`-et (→ a `reconcileLedger("sports")` sosem futott) sem `predictedProb`-ot a skip-ágakon (→ `buildIncoming` eldobta → taken-only), a traded-row pedig P(chosen)-t logolt P(YES) helyett (hibás Brier NO-trade-nél). Fix: direction-agnosztikus `yesProb` + `marketPrice` + `endDate` minden row-ra → a ledger valóban unbiased + a reconcile funkcionális (regressziós pin a `prediction-ledger.test.mts`-ben). Kisebb: `devig-eval` sort-guard (`Number.isFinite`), a devig-teszt most pin-eli a Shin≠multiplicative FLB-irányt, `config-fingerprint` numerikus-string-tolerancia (kollízió-guard), `har-fit` `trainFrac`-clamp. **NEM javítva (tudatosan):** a `har-fit` OLS-kollinearitás (measure-only, OOS-guarded, dokumentált) + a kozmetikai P3-ak. 0 trading-hatás (a sports leállítva marad → a fix a újraindításkor él; a fabrikált fair-value minősége → B37). Doksi: [math/35](internal-docs/math/35-ledger-coverage.md) · [changelog](internal-docs/changelog/CHANGELOG-2026-09-03.md).

### Korábbi munka (78. session, 2026-09-03) — B50 operatív aktiválás: recorderek ON + weather EMOS seed a boxon

A user: „csináld meg A-t." **Élesben a boxon (`ssh analytics`), verifikálva:** **A1** — `RECORD_OI=1`+`RECORD_CLOB_BOOK=1` a `.env`-be (backup + deploy-rsync kizárja → túléli a deployokat), `workers` recreate; az első tick valós adatot írt (`oi-BTC` 112k kontraktus ~$9.16B, `oi-ETH/SOL`, `clob-book` valós L2). **A2** — `scripts/seed-emos.ts` a konténerbe másolva + futtatva: **mind a 27 állomás fittelve**, 4887 residual, EGLC CRPS 0.330→0.307. **A default-OFF forecasting-knobok maradnak OFF** (élesítés a promóciós-kapu #1 / bandit #6 pozitív bizonyítéka után). Box `git HEAD` rsync-deploy miatt látszik elavultnak (3ff6646), a fájlok/konténer a legújabb kódot futtatják. Memória: `hetzner-box-deploy`. Részletek: [changelog](internal-docs/changelog/CHANGELOG-2026-09-03.md).

### Korábbi munka (77. session, 2026-09-03) — B50 #9: ledger-lefedettség (sports-ledger + deferred infra) → az A-lépcső TELJES

A user: „menj a #7-re, aztán a #9-re." A #9 három részének őszinte scope-ja: **(a) sports prediction-ledger BEKÖTVE** (a sports bináris Polymarket-piac, ami rezolvál — mint crypto/weather; eddig semmi ledger nem volt rá): [`sports/index.mts`](services/worker/src/pillars/sports/index.mts) `appendPredictions("sports",...)` + `reconcileLedger` a `saveSportsSession` után, config-stamppel (#4); `LEDGER_CATEGORIES` += `"sports"`. **(b) ledger → normalizált Postgres-tábla DEFERRED (B12)** — a ledger MÁR Postgres-en van (blob_kv), a normalizált tábla csak SQL-nicety. **(c) HL/F-arb NOT-APPLICABLE** — F-arb delta-neutrális (nincs P(YES)); HL perp (nincs bináris ár/rezolúció → taken-only). Sports leállítva → a ledger B37 után tölt (infra kész). Korlát: a fő edge-skip nem hordoz `predictedProb`-ot → taken-heavy (follow-up). `tsc` exit 0 + **44/44 teszt** + build zöld, `main`, NEM deployolva. Doksi: [math/35-ledger-coverage.md](internal-docs/math/35-ledger-coverage.md). **🎉 A B50 A-lépcső (#1–#9) TELJES** (a deferred/N-A részek indokolva).

### Korábbi munka (76. session, 2026-09-03) — B50 #7: regularizáció-budget (holt-knob audit + plateau)

A user: „menj a #7-re, aztán a #9-re." **Audit:** a ~96 SCHEMA-knob mind bekötve fogyasztódik → **0 teljesen holt knob** (nincs törölnivaló). **De 96 dimenzió túl sok a mintához** → a regularizáció **fegyelem, nem törlés.** Knob-osztályozás: **A. guardrail** (SOHA nem tuning; a #6 sem érinti), **B. tunable** (kevés, nagy-karú → plateau-sweep szabad), **C. fix theory-default** (a hosszú farok → NE sweepeld). Új pure fegyelem-eszköz [`packages/core/src/plateau.mts`](packages/core/src/plateau.mts): `selectPlateau` (a legszélesebb near-best futam közepe, nem a csúcs; `isPeak`-jelzés) + `ensembleWeights` (softmax → ensemble a plateau fölött) + 5-csoportos [teszt](packages/core/src/plateau.test.mts). Munkafolyamat: B-knob sweep → #4 config-attribúció score → `selectPlateau` → #1 kapu + #3 DSR. **Nincs kód-törlés** (a felszín bekötött). `tsc` exit 0 + **44/44 teszt** + build zöld, `main`, NEM deployolva. Doksi: [math/34-regularization-budget.md](internal-docs/math/34-regularization-budget.md).

### Korábbi munka (75. session, 2026-09-03) — B50 #6 + #8: diszkontált Thompson-sampling config-választó

A user: „menj a #6-ra." A discovery egyetlen erős új adaptív technikája: diszkrét config-választás bizonytalanság + zajos reward mellett = bandit-probléma → Thompson-sampling. **Implementálva** (`tsc` exit 0 + **43/43 teszt** + build zöld, `main`, **NEM deployolva**): új pure modul [`packages/core/src/thompson.mts`](packages/core/src/thompson.mts) — **#8** `forgettingWeight` (megosztott decay-primitív), `betaPosteriors` (diszkontált Beta), `thompsonRank` (**prob-best determinisztikus MC-vel:** LCG→Box-Muller→Marsaglia-Tsang gamma→Beta), `banditArmsFromRecords` (a #4 config-attribuált ledgerből, reward=model-Brier<piac-Brier). 6-csoportos [teszt](packages/core/src/thompson.test.mts). Bekötve az [`edge-tracker.mts`](services/api/src/routes/edge-tracker.mts)-be (`banditEval`; a #8 fél-életidő `icHalfLifeTrades`-ből, különben 75) + új **`BanditEvalCard`** ([EdgeTrackerPanel.tsx](apps/web/src/components/EdgeTrackerPanel.tsx)). **A bandit JAVASOL** (a győztes alkalmazása = gated champion-challenger follow-up); a #4-stampek forward-töltenek → kezdetben „unlabeled" dominál. 0 trading-hatás; ortogonális az AdaHedge-hez. Doksi: [math/33-thompson-bandit.md](internal-docs/math/33-thompson-bandit.md). **Follow-up:** #8 továbbvitel (Platt+IC), #6 live champion-challenger.

### Korábbi munka (74. session, 2026-09-03) — B50 #5 (sports + crypto ág): offline kalibráció-validáció

A user: „menj sorban a #5 sports/crypto doménekkel." A weathertől eltérően a Shin (per-market z) + a HAR (fogadja a súlyokat) állapotmentes → nincs store-seed; a harness valós adaton **igazolja a metódust** (mérés-first, az élesítés előtt). **Implementálva** (`tsc` exit 0 + **42/42 teszt** + build zöld, `main`, **NEM deployolva**, mindkét ág **élő-verifikált**): **Sports** [`devig-eval.mts`](packages/core/src/devig-eval.mts) (`parseFootballData` [Pinnacle-close `PSC*`] + `scoreDevigMethods` [multiclass Brier N-way]) + script [`scripts/eval-devig.ts`](scripts/eval-devig.ts); élő: 2023/24 PL 380 meccs → power 0.5249 ≈ shin 0.5252 < mult 0.5258 (a close ~hatékony a marginig, az edge a lag). **Crypto** [`har-fit.mts`](packages/core/src/har-fit.mts) (`olsFit` + `fitHarWeights` Corsi-OLS + `evaluateHarForecast` OOS) + script [`scripts/fit-har.ts`](scripts/fit-har.ts); élő: BTC 1000 bar → R²=0.044, fitted ≈ equal de veri az RW-t (a napi RV nehezen jósolható). Validáció-only (nincs store-írás/live-wiring); 0 trading-hatás. Doksi: [math/32-offline-calibration-sports-crypto.md](internal-docs/math/32-offline-calibration-sports-crypto.md). **→ A #5 mind a 3 doménje kész.** **Follow-up:** sports CLV/lag (B37); crypto fittelt-Corsi bekötés (gated).

### Korábbi munka (73. session, 2026-09-03) — B50 #5 (weather-ág): offline EMOS seed (manuális backfill)

A user: „menj rá a #5-re, kezdd a weatherrel." A weather EMOS-kalibrátor (B49 #6) csak ≥20 forward-residual után fittel → a `weatherUseEmos` a deploy után hetekig tétlen; a historikus seed a bias-t + a valós forecast-hiba-szórást (underdispersion-fix) MOST becsüli. **Implementálva** (`tsc` exit 0 + **40/40 teszt** + build zöld, `main`, **NEM deployolva**, **élő-verifikált** Open-Meteo ellen: London/3hó → 91 seed-sample): új pure parserek [`packages/core/src/emos-seed.mts`](packages/core/src/emos-seed.mts) (`parseDailySeries` [null-guard], `buildSeedSamples` [multi-modell inter-modell mean/std], `seedDateWindow`) + 4-csoportos [teszt](packages/core/src/emos-seed.test.mts). Adat keyless: Open-Meteo Historical Forecast `models=…` (inter-modell spread = ensemble-proxy) × ERA5 Archive. Store-inject [`emos-store.mts`](services/worker/src/pillars/weather/emos-store.mts) `injectSeedResiduals` (csak új dátum, `seed:true`, sosem ír felül forward-residualt, cap+refit); orchestrator [`weather/emos-seed.mts`](services/worker/src/pillars/weather/emos-seed.mts) (`seedStationEmos`/`seedAllStations`); trigger [`scripts/seed-emos.ts`](scripts/seed-emos.ts) (Bun, a boxon: `docker compose exec workers bun scripts/seed-emos.ts [months]`). A seed le van súlyozva (kiöregszik a forward METAR-residualok mellett); 0 trading-hatás (a hatás `weatherUseEmos=1` mellett él). Doksi: [math/31-emos-seed.md](internal-docs/math/31-emos-seed.md). **⚠ Operatív:** egyszer futtatni a boxon. **Follow-up (#5):** sports Shin + crypto HAR-RV fit historikus adaton.

### Korábbi munka (72. session, 2026-09-03) — B50 #4: per-trade config-címkézés + A/B-attribúció (mérés-only, nincs migráció)

A user: „jó így, csináld" (a #3-commit + #4-ritmus). A hiányzó A/B-plumbing: a ledger nem rögzítette, melyik config termelte a forecastot → nincs slice-olhatóság, és ez blokkolta a #3 follow-upjait. **Implementálva** (`tsc` exit 0 + **39/39 teszt** + build zöld, `main`, **NEM deployolva**): új pure modul [`packages/core/src/config-fingerprint.mts`](packages/core/src/config-fingerprint.mts) (`hash32` FNV-1a + `configFingerprint` [rendezett override-hash] + `computeConfigAttribution` [per-config Brier-skill; explicit null-guard]) + 4-csoportos [teszt](packages/core/src/config-fingerprint.test.mts). Ledger-stamp ([`prediction-ledger.mts`](packages/core/src/prediction-ledger.mts) `configHash?` + `buildIncoming`/`upsertRecords`/`appendPredictions`) — **blob_kv-JSON → nincs migráció**; `trader-settings.mts` új `currentConfigFingerprint()`; a 3 runner tickenként stampel. UI: [`edge-tracker.mts`](services/api/src/routes/edge-tracker.mts) `configAttribution` mező + új **`ConfigAttributionCard`** ([EdgeTrackerPanel.tsx](apps/web/src/components/EdgeTrackerPanel.tsx)). A stamp a deploytól forward-tölt (régi rekord `unlabeled`); 0 trading-hatás. **Feloldja a #3 follow-upjait** (valódi ONC + cross-trial σ_SR). Doksi: [math/30-config-attribution.md](internal-docs/math/30-config-attribution.md). **Follow-up:** PnL-oldali A/B (configHash az OpenPosition→ClosedTrade-re, residual JSONB).

### Korábbi munka (71. session, 2026-09-03) — B50 #3: effektív-trial DSR (klaszterezett trial-szám)

A user: „commit + push, aztán mehetsz a #3-ra." A literál trial-DSR őszintévé tétele: a `trader-trials` sok közel-duplikátumot logol (ugyanaz a knob újranyomva) → mindegyiket független trial-ként számolva a DSR túl-deflál. **Implementálva** (`tsc` exit 0 + **38/38 teszt** + build zöld, `main`, **NEM deployolva**): új pure modul [`packages/core/src/trial-cluster.mts`](packages/core/src/trial-cluster.mts) (`jaccard` + `effectiveTrialCount`: a trial-gráf összefüggő komponensei `Jaccard(changed-keys) ≥ 0.5`-en → N_eff = klaszter-szám ≤ literál N; ONC-proxy per-trial-hozam nélkül) + 6-csoportos [teszt](packages/core/src/trial-cluster.test.mts). `trader-settings.mts` új `effectiveTrials()` → `{literal, effective}`; a 3 DSR-fogyasztó (worker crypto+status live-readiness + a #1 promóciós-kapu) N_eff-re váltva (literál-fallback). N_eff < N → **kevesebb** (pontosabb) defláció; a DSR advisory maradt → 0 trading-hatás. Doksi: [math/29-effective-trials.md](internal-docs/math/29-effective-trials.md). **Follow-up:** valódi ONC per-trial hozam-korreláción + cross-trial σ_SR — #4-függő.

### Korábbi munka (70. session, 2026-09-03) — B50 #2: log-forward market-data recorderek (default-OFF)

A user: „2. aztán sorban" → a #2 recorderek. A discovery szerint a legértékesebb tréning-adat egy része **nem visszatölthető** (Binance OI ~30-nap-cap; PM book-mélységnek nincs historikus endpointja) → minden nem-logolt nap véglegesen elveszett; ez indítja a forward-logot. **Implementálva** (`tsc` exit 0 + **37/37 teszt** + build zöld, `main`, **NEM deployolva**): új pure modul [`packages/core/src/market-recorder.mts`](packages/core/src/market-recorder.mts) (`capSnapshots` gördülő-ablak + `dueForSnapshot` per-stream throttle + `parseBinanceOiHist` + `compactBook`) + 4-csoportos [teszt](packages/core/src/market-recorder.test.mts). Worker recorder [`services/worker/src/recorders/index.mts`](services/worker/src/recorders/index.mts): `runRecorders` a [`main.ts`](services/worker/src/main.ts) tickjében a **pillérek UTÁN**, best-effort (sosem töri a ticket), `market-recorder` KV-store. Két recorder: **OI** (`RECORD_OI`, Binance BTC/ETH/SOL, 15-perc/5000-cap ≈ 52 nap → veri a 30-napos retenciót → #5 OI-Δ) + **CLOB book** (`RECORD_CLOB_BOOK`, a nyitott crypto+weather pozíciók `/book`-ja a reset-mentes `loadSession`-ből → #1 fill-modell + Kyle-λ/VPIN). **Mind default-OFF** (env `"true"`/`"1"` + deploy → indul); 0 trading-hatás. Env katalogizálva ([env-vars.md](internal-docs/current-state/env-vars.md)), doksi [math/28-market-recorder.md](internal-docs/math/28-market-recorder.md). **⚠ Operatív:** a capture csak `RECORD_OI=1`/`RECORD_CLOB_BOOK=1` + deploy után indul. **Follow-up (#2):** Deribit IV-felület, Pinnacle live-close, HL l2Book/OI (WS→Hetzner).

### Korábbi munka (69. session, 2026-09-03) — B50 #1: proper-score promóciós kapu implementálva (mérés-only)

A user: „Kezdd a #1-gyel, a proper-score promóciós kapuval." A B50-discovery legolcsóbb, legerősebb kara. **Implementálva** (`tsc` exit 0 + **36/36 teszt** + build zöld, `main`, **NEM deployolva**): új pure modul [`packages/core/src/promotion-gate.mts`](packages/core/src/promotion-gate.mts) (`evaluatePromotionGate` + `PROMOTION_THRESHOLDS`) — a MÁR kiszámolt advisory metrikákat (proper-scoring + walk-forward-vs-market + PSR/MinTRL/DSR) **egyetlen, előre-regisztrált** `PROMOTE / HOLD / INSUFFICIENT_DATA` verdikté fűzi. **Célfüggvény-váltás:** a proper-score-kapuk (sample≥30, Brier-skill>0, beats-market OOS, consistency≥0.6, cluster≤0.5) **hard**; a Sharpe-oldal (PSR/DSR/MinTRL) **advisory** — sosem blokkol, csak konzervatív méretre int. Vékony ledger / nincs baseline (F-arb/sports) → advisory-fokozás (nincs hamis HOLD). Opc. **challenger-mód** (Platt/AdaHedge → „flippeljük-e ON-ra?"). 11-csoportos [teszt](packages/core/src/promotion-gate.test.mts). Bekötve az [`edge-tracker.mts`](services/api/src/routes/edge-tracker.mts)-be (DSR `deflatedSharpe`-fal, `nTrials=countTrials()`; `promotionGate` mező) + új **`PromotionGateCard`** az [`EdgeTrackerPanel.tsx`](apps/web/src/components/EdgeTrackerPanel.tsx)-en. **0 trading-hatás** — semmi nem flippel automatikusan; a kapu az operátornak mondja meg, mikor SZABAD promótálni. Doksi: [math/27-promotion-gate.md](internal-docs/math/27-promotion-gate.md) · [changelog](internal-docs/changelog/CHANGELOG-2026-09-03.md) · [sprints B50](internal-docs/roadmap/sprints.md). **Follow-up:** #4 per-trade config-címkézés (valódi A/B); UI challenger-selektor; #3 effektív-trial DSR.

### Korábbi munka (68. session, 2026-09-03) — Training / paraméter-optimalizáció discovery („a bot trainelése") — kód NEM változott

A user kérdése: a bot sok állítható paraméterrel bír → hogyan „traineljük" optimális kereskedővé, mi a jó gyakorlat, honnan a valós piaci adat a finomításhoz, és hogyan fusson a training. **Alapos, több-ágenses discovery, csak kutatás + doksi — kód érintetlen, nincs deploy.** 1 read-only kód-katalógus-ágens (a teljes `trader-settings` SCHEMA + presetek + env-ek → **~96 knob** + a `packages/core` mérési/tanuló infra állapota) + 3 párhuzamos webes kutató-ág (anti-overfit tuning; valós historikus adatforrások 6 doménben; online/adaptív + RL). Kimenet: [`model-discovery-training.md`](internal-docs/roadmap/model-discovery-training.md), a forecasting (B41) + expansion (B49) **harmadik testvére**. Tracker: **sprints.md B50**.

**Központi tanulság:** a „training" ebben a forward-native, DSR-trial-trackelt, kis-mintás rendszerben **NEM** grid-search/Bayes-opt/RL a paper-PnL-en (mind a 3 ág csapdának jelöli) — hanem **(A)** a hangolási **célfüggvény** PnL→proper-score/kalibráció váltása (nagy effektív N, skippeltekkel); **(B)** **offline kalibráció valós historikus adaton** (weather EMOS / sports Shin / HAR-RV — az EGYETLEN biztonságos optimalizálási hely, csak nem-pénzügyi célon); **(C)** fegyelmezett **online adaptív réteg** (a meglévő AdaHedge + Bayes-IC + Platt fölé diszkontált **Thompson-sampling** preset-választó + champion-challenger). A mérő/tanuló infra MÁR épített és fut, de semmi nincs a live-ra kötve (kivéve `useRealizedIC`) → a fő kar a meglévő advisory élesítése. **Két blokkoló lyuk:** (1) a ledger nem címkézi, melyik knob-config termelte a trade-et → nincs A/B-attribúció; (2) a legértékesebb adat (PM könyv-mélység, OI-history, Deribit-felület, Pinnacle-close) **nem visszatölthető → log-forward MOST kell.** **RL alfára/sizingra = csapda** (reward-hacking a fill-modellen, minta-hiány, seed-irreprodukálhatóság). Részletek: [changelog 2026-09-03](internal-docs/changelog/CHANGELOG-2026-09-03.md) · [sprints B50](internal-docs/roadmap/sprints.md).

### Korábbi munka (67. session, 2026-09-03) — a nap commitjainak audit-passza → 9 fix (default-OFF-safe)

A user kérése: auditáld a teljes mai commitolt kódot (hatékonyság/biztonság/megvalósítás), a hibákat javítsd, majd push a mainre. **4 párhuzamos read-only audit-ágens** a `3dcc24e..HEAD` diffen (88 fájl, B49 #1–#9 + CI + provider-wiring). **Verdikt: 0 P0/P1** — a default-OFF gating bit-azonos, a fill-retry idempotens, az auth-hardening ép. **9 P2/P3-fix implementálva** (`tsc` 0 + **35/35 teszt** + build zöld, `main`): weather EMOS reconcile per-station dedup (fan-out); migration atomicitás (a pool valódi `tx()`-ét használja); edge-tracker ENB dupla-load + mode-fix (a szűrés-előtti mode-aware listát csoportosítja); DSR σ_SR |SR|-fallback + PSR-degenerált guard (+pinned tesztek); `appendTrial` pruned-vs-pruned diff; login rate-limit Map-cap; session-delete tranzakció; deploy.yml secret env-en át. Verifikált téves riasztás: az `ANTHROPIC_MODEL` default `claude-sonnet-4-6` érvényes modell-id. Részletek: [changelog 2026-09-03](internal-docs/changelog/CHANGELOG-2026-09-03.md).

### Korábbi munka (65-66. session, 2026-09-03) — B49 #8 (risk overlays) + #9 (ENB) → az A-lépcső TELJES

A user sorban a maradékot kérte. **#8 risk overlays** (default-OFF): új [`packages/core/src/risk-overlay.mts`](packages/core/src/risk-overlay.mts) (`volTargetMultiplier` + `drawdownKill`) + 4 teszt, bekötve a crypto runnerbe (a DD-kill halt-ol, a vol-target skálázza a `sizeUSDC`-t; a beta-cap/#1-fill/alert konzisztens). Knobok `riskVolTargetEnabled`/`riskVolTarget`/`riskDdKillEnabled`/`riskMaxDdFraction`. A DD-kill a B33 elvi változata. **#9 ENB monitor** (mérés-only): új [`packages/core/src/enb.mts`](packages/core/src/enb.mts) (`correlationMatrix` + `jacobiEigenvalues` + `effectiveNumberOfBets` sajátérték-entrópia) + 7 teszt, bekötve az [`edge-tracker.mts`](services/api/src/routes/edge-tracker.mts)-be (per-bot napi-PnL → corr → ENB + `EnbCard`) — megmondja, hány független tét valójában a 6 bot (a #2 cap igazolása). `tsc` exit 0 + **35/35 teszt** + build zöld. Doksi: [math/25-risk-overlay.md](internal-docs/math/25-risk-overlay.md) · [math/26-enb.md](internal-docs/math/26-enb.md). **🎉 A B49 A-lépcső (#1–#9) TELJES** — mind pure-core + teszt + bekötés + doksi (math/18–26), default-OFF/mérés-first.

### Korábbi munka (64. session, 2026-09-03) — B49 #7: sports Shin de-vig (matek kész, odds-feed a maradó adat-task)

A user sorban #7. A sports fair-value fabrikált (PM-árat 0.5 felé húz → FLB-t őriz → ~90% bukás); a Shin a legjobb kalibrált de-vig (Štrumbelj 2014). **Implementálva** (`tsc` exit 0 + **33/33 teszt** + build zöld): új `devigShin` a meglévő [`packages/core/src/devig.mts`](packages/core/src/devig.mts)-ben (insider-frakció z, bisekció Σp=1-re, fallback power) + `DevigMethod += "shin"` + `twoWayFairYes(...,"shin")` + Shin-teszt-blokk. A [sports/decision-engine](services/worker/src/pillars/sports/decision-engine.mts) fogyasztója (`market.pinnacleFairYes`, `sportsUsePinnacle`) a #9 óta megvan, **de semmi nem tölti fel** → a #7 kód-része a Shin-matek; a **live tüzeléshez a B37 adat-task kell:** the-odds-api (`ODDS_API_KEY`, region=eu=Pinnacle) + Polymarket↔Pinnacle event-matching → `pinnacleFairYes` Shin-nel. Amíg nincs odds-feed, a sports maradjon leállítva. Doksi: [math/24-sports-devig.md](internal-docs/math/24-sports-devig.md). **B49 A-lépcső: #1–#7 ✅ (a #7 odds-feed-gated); hátra #8–#9.**

### Korábbi munka (63. session, 2026-09-03) — B49 #6: weather EMOS/NGR kalibráció (apply default-OFF, log mindig-on)

A user: „aztán mehetsz az 5-ös csomagra" → #5 után #6. A weather „jó irány (IC +0.39), rossz sizing" gyökér-oka az ensemble-underdispersion. **Implementálva** (`tsc` exit 0 + **33/33 teszt** + build zöld): új pure modul [`packages/core/src/emos.mts`](packages/core/src/emos.mts) (`gaussianCrps` + `emosApply` [σ-infláció] + `fitEmos` two-step OLS + `observationRank`) + 6-csoportos teszt. Adat-pipeline [`weather/emos-store.mts`](services/worker/src/pillars/weather/emos-store.mts): `logForecast` (minden scannelt állomás+dátum) + `reconcileEmosObs` (**METAR-alapú** obs-fill, nem trade-függő → unbiased) + refit. Bekötve a [`weather/index.mts`](services/worker/src/pillars/weather/index.mts)-be: log+reconcile MINDIG fut (adat-óra, best-effort), az EMOS-apply a `matchBucket` előtt csak `weatherUseEmos` ON + fittelt (≥20 residual) esetén. **A trading OFF-nál változatlan** (nyers μ,σ). Knob `weatherUseEmos` (default 0). Kötődik B15/B35/B40. Doksi: [math/23-emos.md](internal-docs/math/23-emos.md). **B49 A-lépcső: #1–#6 ✅; hátra #7–#9.**

### Korábbi munka (62. session, 2026-09-03) — B49 #5: OI-Δ × price signal (9. combiner-signal, default-OFF)

A user: „aztán mehetsz az 5-ös csomagra". A discovery TOP új **korrelálatlan** signalja: open-interest-változás × ármozgás (leverage-flow kvadráns), ortogonális az orderflow-val, natívan multi-coin. **Implementálva** (`tsc` exit 0 + **32/32 teszt** + build zöld, **default-OFF**): új pure modul [`packages/core/src/oi-delta.mts`](packages/core/src/oi-delta.mts) (`classifyOiQuadrant` + `oiDeltaProb`: emelkedő OI megerősíti, csökkenő gyengíti) + 5-csoportos teszt. Bekötve a [`signal-combiner.mts`](services/api/src/routes/signal-combiner.mts)-be 9. signalként (`getOiDeltaSignal`, coin a slug-ból → multi-coin, Binance OI-hist+kline; knob-gate → **null OFF-nál → combine elejti → 8-signal bit-azonos**) + `SIGNAL_ICS` + **K_BLIND_SIGNALS** (strike-blind) + `SignalBreakdown.oi_delta?` opcionális. Knob `oiDeltaEnabled` (default 0, common). Anti-overfit tiszteletben (combiner nem nő 200 trade előtt → measure-first). Doksi: [math/22-oi-delta.md](internal-docs/math/22-oi-delta.md). **B49 A-lépcső: #1–#5 ✅; hátra #6–#9.**

### Korábbi munka (61. session, 2026-09-03) — B49 #4: walk-forward scoring a ledgeren (model vs market, OOS)

A user: „menj tovább a #4-el". A #3 párja — a validációs réteg másik fele; a kérdés: a bot valószínűségei verik-e a **piaci árat** out-of-sample, konzisztensen? **Implementálva** (`tsc` exit 0 + **31/31 teszt** + build zöld, **mérés-only**, 0 live-változás): új pure modul [`packages/core/src/walk-forward.mts`](packages/core/src/walk-forward.mts) (`computeWalkForward`: rezolúciós-idő szerint rendez → kronológiai blokkok → **Brier skill vs piaci ár** + log-loss + konzisztencia + korrelációs caveat) + 7-csoportos teszt. Bekötve az [`edge-tracker.mts`](services/api/src/routes/edge-tracker.mts) `walkForward` response-mezőbe + új **`WalkForwardCard`** az Edge Trackeren. Scoring-only → nincs leakage; a **B11 Hetzner-mentes verziója.** Nincs új knob/env. Doksi: [math/21-walk-forward.md](internal-docs/math/21-walk-forward.md). **B49 A-lépcső: #1-#4 ✅; hátra #5-#9.**

### Korábbi munka (60. session, 2026-09-03) — B49 #3: robust Sharpe (PSR / MinTRL / DSR) validációs réteg

A user: „go ahead with #3 és mondjad, hogy mit csináljak amikor én jövök". A discovery #3: a rendszer forward-recordon validál; a kis-minta/fat-tail + config-hunting torzítás forward-native eszközökkel korrigálható (nincs backtest-motor).

**Implementálva** (`tsc` exit 0 + **30/30 teszt** + build zöld, **NEM deployolva**, `main`): új pure modul [`packages/core/src/sharpe-robust.mts`](packages/core/src/sharpe-robust.mts) (PSR, MinTRL, expectedMaxSharpe, DSR, skewness/kurtosis, normalInv) + 6-csoportos teszt. `computeSummary` új mezők `returnSkew`/`returnKurtosis`/`psr`/`minTrl` → **2 új Edge Tracker KPI-kártya** (PSR, MinTRL). [`live-readiness.mts`](services/worker/src/pillars/shared/live-readiness.mts): summary mindig hordozza psr/minTrl/**dsr**/trialsCount; két **opt-in** kapu `liveReadyMinPsr` + `liveReadyUseMinTrl` (az önkényes fix 30-trade helyett elvi paper→live küszöb). **Honest-trial DSR:** [`trader-settings.mts`](services/api/src/routes/trader-settings.mts) minden knob-változást trial-ként logol (`appendTrial`/`countTrials`), a runner tickenként betölti. Advisory + gates default-OFF (a live-flip B10-blokkolt). Maradó (B49): valódi cross-config σ_SR, per-kategória trials, HL status-út readiness, #4 walk-forward scoring. Doksi: [math/20-robust-sharpe.md](internal-docs/math/20-robust-sharpe.md) · [changelog](internal-docs/changelog/CHANGELOG-2026-09-03.md) · [sprints B49](internal-docs/roadmap/sprints.md).

### Korábbi munka (59. session, 2026-09-03) — B49 #2: crypto-beta exposure cap (portfólió-réteg, default-OFF)

A user: „go ahead with #2, the crypto-beta exposure cap" (+ a fill-modell password-jét adta élesítésre). A discovery #2 strukturális találata: a per-bot 8%-os capek nem látják, hogy a **crypto + HL directional mind crypto-béta** → 6 „független" tét egyetlen korrelált BTC-pozíció (barbell). **A password-öt NEM használtam fel** (credential-szabály — az operátornak kell a Settings-ben flippelnie a fill-modellt; ráadásul az deploy-precondition, a box a régi kódot futtatja).

**Implementálva** (`tsc` exit 0 + **29/29 teszt** + build zöld, **NEM deployolva**, `main`): új pure modul [`packages/core/src/portfolio-exposure.mts`](packages/core/src/portfolio-exposure.mts) (`cryptoExposureUsd` Σ costBasis; `hlExposureUsd` Σ sizeUSDC/leverage = **margin, nem levered notional**; `checkBetaCap` fail-open) + 5-csoportos teszt; cross-bot loader [`shared/portfolio-exposure.mts`](services/worker/src/pillars/shared/portfolio-exposure.mts) (**F-arb kizárva** — delta-neutrális; weather kizárva); bekötve a crypto + HL runner belépő-előtti check-jébe (saját bot LIVE session-ből → intra-tick opens is számítanak, másik a tick-eleji snapshotból; átlépés → skip). **Common knobok** `betaCapEnabled` (default **0**) + `betaCapFraction` (default **0,25**); env `BETA_CAP_ENABLED`/`BETA_CAP_FRACTION`. NEM mond ellent Sprint-45-nek (cap-réteg, nem bankroll-újraegyesítés). Maradó (B49): multi-status UI-utilization, signed-net exposure, #8 vol-target/max-DD, #9 ENB-monitor. Doksi: [math/19-portfolio-exposure-cap.md](internal-docs/math/19-portfolio-exposure-cap.md) · [changelog](internal-docs/changelog/CHANGELOG-2026-09-03.md) · [sprints B49](internal-docs/roadmap/sprints.md).

### Korábbi munka (58. session, 2026-09-03) — B49 #1: depth-aware fill-modell (T1–T7) implementálva (default-OFF)

A user: „start with #1, the depth-aware fill model … a többivel is mehetsz". A discovery (B49) #1 konvergens találata: a paper-motor a vékony/longshot piacokon **teljes méretben, könyv-ellenőrzés nélkül** tölt (`filledShares = sizeUSDC/price`), majd a fantom share-ök settlementkor $1-t kapnak → a dokumentált +157%-típusú hamis paper-PnL. **Kódból dolgozva** (grounding: [`crypto/execution.mts`](services/worker/src/pillars/crypto/execution.mts) `placeBuyOrder` + [`crypto/paper-resolver.mts`](services/worker/src/pillars/crypto/paper-resolver.mts); a weather ugyanezt hívja, a sports saját inline fill-t).

**Implementálva T1–T7** (`tsc` exit 0 + **28/28 teszt** + build zöld, **NEM deployolva**, `main`): **T1** új pure modul [`packages/core/src/fill-model.mts`](packages/core/src/fill-model.mts) (`simulateDepthFill` ask-book walk + participáció-cap + VWAP + partial + `fallbackFill` √-law + tick/min-size helperek); **T2** [`fill-model.test.mts`](packages/core/src/fill-model.test.mts) 8 csoport (5¢-longshot $200→100 share, nem 4000); **T3** keyless [`shared/clob-book.mts`](services/worker/src/pillars/shared/clob-book.mts); **T4** bekötve a `placeBuyOrder`-be (crypto+weather) új `fillOpts` mögött — **OFF → bit-azonos legacy**, min-size alatt → REJECTED; **T5** min-size gate (`isFillValid`); **T6** a paper-resolver ON-nál **exit-only** fee-t számol (`settlementFeePctFillModel` 0,015 — a belépő slippage már a VWAP-ban → dupla-számolás elkerülve), a net-edge gate változatlan (tiszta A/B); **T7** sports saját fill-út is depth-aware. **Knobok:** `fillModelEnabled` (default **0**) + `fillParticipationCap` (0,20) [common SCHEMA]; env `FILL_MODEL_ENABLED`/`FILL_PARTICIPATION_CAP`/`SETTLEMENT_FEE_PCT_FILL_MODEL` → [env-vars.md](internal-docs/current-state/env-vars.md). **Measure-first:** knob ON → proper-scoring/ledger raw-vs-fill összehasonlítás → pozitív igazolás után default-ON (a várt eredmény a túl-jóváírt PnL eltűnése, NEM új edge). Maradó (B49): T6 fee-finomhangolás méréssel, élő per-market `/tick-size`, crypto korai TP/SL exit bid-walk, weather reconciler fee-parity (B35). Doksi: [math/18-fill-model.md](internal-docs/math/18-fill-model.md) · [changelog](internal-docs/changelog/CHANGELOG-2026-09-03.md) · [sprints B49](internal-docs/roadmap/sprints.md).

### Korábbi munka (57. session, 2026-09-03) — rendszer-bővítés discovery (execution / portfólió / új edge-források)

A user kérése: alapos webes discovery a legjobb gyakorlatokra + „mivel lehet még bővíteni a bot rendszert", a kóddal összevetve, a kódból dolgozva. **Módszer:** 1 read-only kód-katalógus-ágens (a teljes monorepo-fa: `services/worker/pillars` + `packages/core` + `services/api/routes`) + **8 párhuzamos webes kutató-ág** primer forrásokkal (arXiv/hivatalos docs/GitHub); minden állítás kódra + forrásra verifikálva, skeptikus alapállással. **Csak kutatás + doksi — kód NEM változott, nincs deploy.** Kimenet: új discovery-doksi [`model-discovery-expansion.md`](internal-docs/roadmap/model-discovery-expansion.md), a [`model-discovery-forecasting.md`](internal-docs/roadmap/model-discovery-forecasting.md) (B41, predikciós réteg) testvére.

**Központi tanulság:** a signalok telítve; a maradék profit **három NEM-signal rétegben** van — **(A) execution/fill-realizmus** (a paper-motor a vékony longshot-könyveket a kijelzett áron + teljes méretben tölti; a Polymarketen fordított favorite-longshot bias van, arXiv 2606.04217 — **két független kutató-ág egymástól függetlenül ezt tette #1-re; amíg nem valós, minden downstream stat fikció**); **(B) a mérés-only kalibráció élesítése** (Platt/AdaHedge/proper-scoring MEGVAN, de nincs live-re kötve) + PSR/MinTRL/DSR + walk-forward scoring a prediction-ledgeren (a B11 Hetzner-mentes verziója); **(C) portfólió-szintű crypto-béta koncentráció** (crypto+HL+F-arb mind crypto-béta → 6 „független" 8%-os tét = 1 nagy korrelált BTC-pozíció, ENB ~2-3 nem 6 → shared-bankroll exposure-cap + ENB-monitor + vol-target/max-DD). **Egyetlen erős új korrelálatlan signal:** OI-Δ × ár (multi-coin → a BTC-hardcode leváltása is). **Domén-fixek** (weather EMOS/NGR-kalibráció az underdispersion ellen; sports Shin de-vig + the-odds-api $30/hó feed) valósak de szűk plafonúak. **Skeptikus mentések (NE építsd):** negRisk/Σ-arb (3,6s korrekció), Kalshi cross-arb (semantic non-fungibility → csak read-only scanner), settlement-sniping, on-chain flows, **LLM likvid piacra = csapda**. **Új üzletág-jelölt:** market-making/reward-farming (a meglévő orderflow/VPIN toxicitás-gate-ként; live-infra kell). Tracker + pontozott jelöltek (jóváhagyásra): [`sprints.md` B49](internal-docs/roadmap/sprints.md). Részletek: [changelog 2026-09-03](internal-docs/changelog/CHANGELOG-2026-09-03.md).

### Korábbi munka (56. session, 2026-09-03) — külső API-audit (provider-doksik) + up-to-date fixek

A user kérdése: a botok által hívott API-k hatékonyan működnek-e, adtak-e ki a szolgáltatók a bekötést érintő frissítést, és a doksijuk szerint helyesen vannak-e bekötve — a kódból. Majd: a fixek elvégzése + minden API up-to-date-re. **2 párhuzamos read-only katalógus-ágens** (minden külső `fetch` endpoint/param/aláírás) + a provider-changelogok webes ellenőrzése; minden állítás kódra+doksira verifikálva. **Verdikt:** a bekötés túlnyomórészt helyes és aktuális. **Implementálva** (`tsc` exit 0 + **26/26 teszt** zöld, NEM deployolva — a `main`-en): **P0** retired Claude-modell csere (`claude-sonnet-4-20250514` → env-felülírható `ANTHROPIC_MODEL`, default **`claude-sonnet-4-6`**) mind a 3 hívóhelyen (`llm-dependency`, `_resolution-risk` a crypto-combineren át, `apex_wallet_profiler.py`); **P1** Binance Futures `/fapi/v2/{balance,positionRisk}` → **v3** (a v3 a v2 szuperhalmaza, biztonságos); **latens fix** apex-profiler hiányzó `x-api-key` fejléc pótlása. **Egészséges/változatlan:** Binance spot `/api/v3/*` (nincs retired legacy endpoint), Bybit v5, Hyperliquid EIP-712, Polymarket `&closed=true`-kvirk, Deribit, Open-Meteo/NOAA. **Follow-up (user-kérésre, ugyanaznap, `tsc` + 27/27 teszt zöld):** **B47 ✅** HL SDK (`@nktkas/hyperliquid@^0.33.3` + `viem@^2.47.12`) deklarálva a `package.json`-ben (export-verifikálva; a live adapter tisztán resolvál) — végső live-signing check B10-nél; **B48 ✅** új shared `fetchWithRetry` ([packages/core/src/fetch-retry.mts](packages/core/src/fetch-retry.mts)) 429/5xx/network backoff-fal (idempotencia-biztos: POST order csak 429-re), bekötve a 3 signed live-útba (binance/bybit-trade + hedge-manager) + 9-esetes teszt; **B46 ⚪** not-applicable (nincs offset-lapozás a kódban). Az `ANTHROPIC_MODEL` katalogizálva: [env-vars.md](internal-docs/current-state/env-vars.md). Részletek: [changelog 2026-09-03](internal-docs/changelog/CHANGELOG-2026-09-03.md).

### Korábbi munka (55. session, 2026-09-03) — teljes audit (5 bot + infra + security) + prio-fixek

A user kérte mind az 5 bot teljes auditját (helyes implementáció + a beállítások tényleg módosítanak-e), + security auditot, prio-listát és a fixek indítását, + az oldal rejtését AI/kereső-botok elől. **5 párhuzamos read-only audit-ágens**, minden találat kódra verifikálva. **0 valós P0 a botlogikában; 1 P0 az infrában.** Implementálva (mind zöld, boxra deployolva): **P0** HL session sosem perzisztált (`coin`/`sizeCoins`/`pnlUSDC` vs `NOT NULL market` → néma adatvesztés) → migration 007 + `rebuild` null-skip + valódi-HL round-trip teszt. **P1:** sports NO-edge frame-hiba; crypto `icHalfLifeTrades` holt knob; HL Kelly túl-konfidencia (B36, driftmentes-baseline horgony); HL paper testnet-adat → mainnet; llm/resolution-risk auth-gate (Anthropic-budget). **P2/P3:** user-settings/trade-logger auth-gate, login timingSafeEqual+rate-limit, JWT HS256-pin + secret-length, static-path containment, scheduler-drain, migrate atomi, compat-delete session-routing, crypto/weather max-open cap. **Crawler-rejtés:** Caddy `trade.` blokk `X-Robots-Tag noindex` + `robots.txt Disallow:/` + 403 ~25 AI-UA-ra. Deferred: **sprints B42–B45** (login KDF, mély sign-aware IC, sports Pinnacle-snapshot, HL conviction-knob). Részletek: [changelog 2026-09-03](internal-docs/changelog/CHANGELOG-2026-09-03.md).

### Korábbi munka (54. session, 2026-09-02) — Hetzner-migráció Phase 1→4 (a teljes kód kész, main-en)

A user kérte a [migration-runbook.md](internal-docs/roadmap/migration-runbook.md) végrehajtását (Netlify+Blobs → `analytics` Docker co-host), majd: minden branch szinkronba a main-nel + push main-re; session-séma **normalizált**; a live-oldal leállása OK; **„folytasd a teljes implementálást"**. **Minden a `main`-en** (a forecasting A-lépcső 12 commitja + a migráció; a 3 feature-branch törölve; `origin/main` @ `612058d`). Minden lépésnél `tsc` exit 0 + **25/25 teszt zöld**.

- **Phase 0/1:** monorepo-restruktúra — `apps/web` (Astro, 0 churn) + `services/{api,worker,feeds}` + `packages/core`; import-repair `@core`/`@worker`/`@api` path-aliasokkal (176 git-rename, history megőrizve). `.env.example` (secret-leltár), `.dockerignore`, `scripts/run-tests.mjs`.
- **Phase 2 (Postgres-alap, valós SQL-en tesztelve PGlite-tal):** `packages/core/{db,env,migrate,ledger,session-store,settings-store}.ts` + `migrations/001..006`. Session-séma **normalizált** (`pillar_session`/`_open_position`/`_closed_trade`, mode-aware). A pure logika változatlan; a ledger pure fn-jei 1:1 re-export.
- **Phase 3a — runnability:** `blobs-compat.ts` = Netlify Blobs drop-in (durable→Postgres `blob_kv`, `*-cache`→in-process); `tsconfig` **aliasolja `@netlify/blobs`→compat** → az egész worker/api **változatlanul** fut Bun+Postgres-en. A compat **maga dispatch-eli** a session-store-okat a normalizált táblákra → a managerek (write) és az edge-tracker/multi-status (read) 0 churn-nel, konzisztensen.
- **Phase 3 — services:** `worker/src/{main,scheduler}.ts` (belső ütemező, a meglévő dispatchert hívja), `api/src/server.ts` (`Bun.serve` router, a Fetch-handlereket név szerint dispatch-eli, `/.netlify/functions/*`+`/api/*`), `services/model` FastAPI skeleton (load-on-demand Chronos, súly nélkül bootol). Dockerfile-ok + `docker-compose.yml` (§18.3 co-host) + Caddy-snippet.
- **Phase 4 — tooling kész:** `scripts/export-blobs.mjs` + `services/api/src/import-blobs.ts` (idempotens, a compat-on át).

- **Phase 5 (deploy) ✅ 2026-09-02:** a stack ÉL `https://trade.jmeszaros.dev`-en (paper). LE-cert, umami érintetlen. Deploy-fixek: api-image `COPY migrations/`, az `api` szolgálja a frontendet is (egy origin, nulla umami-módosítás), `workers` a `edge` hálóra (egress). Verifikálva: normalizált Postgres-írás + valódi paper-order-ök + 0 swap.

- **Phase 4 (adat-migráció):** a user **tiszta indulást** választott (2026-09-02) — a Netlify Blobs history (paper-trade + IC-kalibráció + ledger) NEM lett átemelve; a box üres sessionökkel fut. Az `export-blobs.mjs`/`import-blobs.ts` tooling megvan, ha később mégis kellene (de a Netlify törlésével a forrás elvész).
- **Phase 6 (Netlify-nyugdíjazás):** zöld jelzés a user-nek a **trading SITE** törlésére (a box Netlify-független). ⚠ A **DNS-zóna maradjon** (a `stats.` [umami] ÉS a `trade.` is Netlify-DNS-en van).

**HÁTRA (opcionális, nem blokkoló):** ledger a normalizált `prediction_ledger` táblára (jelenleg blob_kv, koordinált worker+api follow-up); **Phase 7** Chronos-súly (16 GB rescale után). Részletek: [changelog 2026-09-02](internal-docs/changelog/CHANGELOG-2026-09-02.md).

### Korábbi munka (53. session, 2026-09-01) — forecasting discovery + a TELJES A-lépcső (#1–#9) implementálva + szerver-audit

A user kérte egy **discovery**-t „a legjobb modell megtalálására" (mint az opticut 2D-nesting discovery), a **meglévő botok fejlesztésére** (trading / ár-előrejelzés), majd: *„kezdd el a #1-et, a proper-scoring eval harness-t"*. **Discovery** (3 párhuzamos web-kutató-ágens, primer források): új doksi [`roadmap/model-discovery-forecasting.md`](internal-docs/roadmap/model-discovery-forecasting.md) — forrásolt survey + pontozott mátrix + prioritált roadmap (A-lépcső TS-now / B-lépcső Hetzner-precondition). **Fő tanulság:** a profit a valószínűség-becslés **kalibrációján** múlik, nem új signalon; a foundation modellek (Chronos/TimesFM, Apache-2.0) tail-túlbizonyosak → csak kalibrálva. **#1 IMPLEMENTED (NEM deployolva):** új `computeProperScores` ([`edge-tracker/statistics.mts`](netlify/functions/edge-tracker/statistics.mts)) — log-score + Brier-Murphy dekompozíció (Reliability−Resolution+Uncertainty) + Brier/Log skill-score + full-[0,1] reliability-diagram; bekötve az [`edge-tracker.mts`](netlify/functions/edge-tracker.mts) response-ba (`properScores`) + `ProperScoresCard` az [`EdgeTrackerPanel.tsx`](src/components/EdgeTrackerPanel.tsx)-en. Minden kategórián működik (HL-perp is). Új [`shared/proper-scores.test.mts`](netlify/functions/auto-trader/shared/proper-scores.test.mts) (10+ pin) + `tsc`+build zöld; mock-adat próba önkonzisztens (Murphy-identitás OK). **Ez validálja az összes további discovery-tételt** (proper-score-on hasonlít, nem zajos PnL-en). **Prediction ledger (§2 adat-alap) ✅** (hibrid-döntés: adatgyűjtés MOST, nehéz ML Hetzner után): új `shared/prediction-ledger.mts` — minden scannelt piac (taken+skipped) predikcióját logolja, YES-kimenettel tölti (closedTrades + Gamma-reconcile), **bekötve mind a 3 forecasting-botba** (crypto/weather Gamma-reconcile-lal, HL append-only) + `LedgerStatsCard` az Edge Trackeren. **A ledger-óra a deploy-jal indul.** **Hetzner Docker deployment terv (user-kérés):** új [`hetzner-docker-setup.md`](internal-docs/roadmap/hetzner-docker-setup.md) — teljes konténer-setup (compose, Dockerfile-ok, Python ML model-service, könyvtárfák, Blobs→Postgres), az infra-doksi §14 „Docker=overengineering" **megfordítva**. `tsc`+build+2 új teszt-suite (proper-scores + prediction-ledger) zöld, **NEM deployolva**. Follow-up: sprints.md **B41**. Részletek: [changelog 2026-09-01 (b)](internal-docs/changelog/CHANGELOG-2026-09-01.md). A párhuzamos „52. session" (never-stop valve) időközben **commitolva** (`57be7e5`).

**A TELJES A-lépcső (#1–#9) implementálva** — branch **`feat/forecasting-harness-and-ledger`** (10 commit `57be7e5` fölött), mind **pure-TS, mérés-first / default-off, zéró regresszió, NEM deployolva**, `tsc`+build+**10 új teszt-suite** zöld:
- **#1** proper-scoring harness · **#2** post-hoc kalibráció (Platt, walk-forward — mérés) · **#3** log-odds pool (directional, default-off) · **#4** online AdaHedge súlyozás (mérés) · **#5** HAR-RV vol-motor (`useHarRv`) · **#6** first-passage/one-touch routing touch-piacokra (`useFirstPassage`) · **#7** Deribit SSVI+BL piac-implikált árazás (`useDeribitIV`, élő API verifikálva) · **#8** disagreement-gated extremizing (`combinerExtremizeStrength`) · **#9** sports Pinnacle de-vig (B37, `sportsUsePinnacle`).
- Új shared modulok: `proper-scores`/`prediction-ledger` + `edge-tracker/{calibration,online-weights}` + `shared/{har-rv,first-passage,deribit-rnd,devig}` + a combiner `combine()` log-odds/extremize ágai. Az Edge Trackeren 4 új mérési kártya (proper-scores, calibration-gain, online-weights, ledger-stats).
- **Szerver-audit (SSH, read-only):** az `analytics` gép (91.99.218.165, Debian 13, 2 vCPU/**3.7 GB**/0 swap) **már futtatja** a umami-t Docker Compose-ban (caddy+umami+postgres:17) → a tervem stackje. **Verdikt:** az A-lépcső elfér a umami mellett (2 GB swap + mem_limitek kellenek), a B-lépcső Python ML nem (16 GB rescale, CX42 ~€16/hó). Új [`hetzner-docker-setup.md` §18](internal-docs/roadmap/hetzner-docker-setup.md): box-ra szabott `edgecalc` compose (co-host, Postgres-újrahasznosítás, konszolidált workers).

**Két operatív kapu HÁTRA:** (1) **deploy** → indul a ledger-óra + a mérések (#1/#2/#4) valós adaton; (2) **repo-port** (Blobs→Postgres, `apps/services/packages`) az `analytics` co-hostra. A LIVE bekapcsolások (#2–#9 default-off knobjai) a mérés + pozitív gain után. **Nyitott data-task:** sports odds-feed (ODDS_API_KEY) a #9 aktiválásához. Follow-up: sprints.md **B41**. Részletek: [changelog 2026-09-01](internal-docs/changelog/CHANGELOG-2026-09-01.md).

### Korábbi munka (52. session, 2026-09-01) — 5-bot elemzés + paper „never-stop" valve + B34/B35

A user kérte az összes bot teljesítmény-elemzését, majd: B29-deploy + crypto-restart, egy „demo-ban soha ne álljon le" kapcsolót minden botra (bekapcsolva), és a többi javaslat implementálását. **Read-only elemzés (friss `/multi-status`+`/edge-tracker`):** portfólió $1450→$1287,80 (−11,2%), nettó realizált −$111; barbell (crypto +$445 fedezi a másik 4 −$556-ját); crypto „+445" NEM valódi edge (Sharpe CI a 0-t átlépi, evGap −$1534). **B29 már deployolva** (`d1f4e93` az origin/main-en; a crypto csak Blobs-`stopped` maradt).

**Új: paper „never-stop" safety valve** (branch `main`, **DEPLOYOLVA push-sal**; `tsc`+build+13 teszt zöld). Új shared helper [`paper-never-stop.mts`](netlify/functions/auto-trader/shared/paper-never-stop.mts) + `paperNeverStop` Settings-knob (common, default **1 = ON**). Csak `paperMode && paperNeverStop`-nál (LIVE inaktív): (1) **self-heal** minden tick elején az AUTO-stopolt sessiont (resume + odométer-null, history megmarad); (2) **loss/consecutive-limit → +Infinity**, így sem az auto-stop set-site, sem a decision-engine loss-gate-je nem halt → a bot TRADE-el. **Scope: csak auto-stop** — a MANUÁLIS stop marad (sports leállítva marad). Crypto+HL a deploy utáni cron-tick-en **magától újraindul** (auth nélkül), sports manual stop marad. Weather+F-Arb: nincs auto-stop → eleve fedve. **B34:** `useRealizedIC` default 0→1 (sign-aware realized-IC crypto+HL-re; ha mentett `=0` override van, az operátornak Settings-ben kell 1-re váltani). **B35:** új `weatherKellyScale` knob (default 0,5) — uniform Kelly de-risk (nem payoff-fix, a vérzést korlátozza). Részletek: [changelog 2026-09-01](internal-docs/changelog/CHANGELOG-2026-09-01.md) · sprints.md B34/B35/B41.

### Korábbi munka (51. session, 2026-07-23) — teljes code-review (7 sáv) + 4 P0 kódfix + operátor-knobok

A user kérte a botok teljesítmény-ellenőrzését, majd egy **teljes code-review**-t („mi kell hogy nyereséges legyen minden pilléren?"), majd: knobok alkalmazása + P0 kódfixek + sprints.md felvezetés. **7-sávos multi-agent review** (5 bot + shared signal-infra + economics-risk): **49 ágens, 33 megerősített találat**. **Data-quality korrekció:** a session eleji „overrides wiped" megállapítás TÉVES volt — az unauth `/trader-settings` GET szándékosan `{}`-t ad; auth-olt GET-en **24 aktív override** ép (`sessionLossLimit=1000`, `weatherInvertDirection=1`, `useRealizedIC=0`). A session eleji `/multi-status` is cache-elt (10 napos) volt. **Friss számok lentebb.**

**4 P0 kódfix** (branch `fix/p0-profitability-fixes`, `tsc`+build+12 teszt-suite zöld, **NEM deployolva**): **B29** gross-loss unbrick (`resumeSession`/`resumeHlSession` nullázza a `sessionLoss` odométert — a crypto +$690 mégis-stopped patológia); **B30** combiner [0,1] clamp + totalW-guard (a `useRealizedIC` biztonságos bekapcsolásának előfeltétele); **B31** F-Arb forward-carry proxy (HL-funding, nem spread) + churn close-logic; **B32** edge-tracker under-report fix (all-time headline + valós bankroll-denominátor). **Operátor-knobok (élő MOST):** sports **STOPPED** + loss-limit ON @ $50; weather `selectionShrink` 0.5→1.0 + `maxPositionUSD` 25→15; F-Arb `frMinSpreadHourly` 0.00002→0.00005. Weather invert **nem** flippelve (IC-ellentmondás → B40). Follow-upok: sprints.md **B33–B40**. Részletek: [changelog 2026-07-23](internal-docs/changelog/CHANGELOG-2026-07-23.md). **Crypto újraindítás:** a B29-fix deploy-ja után `POST /auto-trader-api {action:"resume", category:"crypto"}`.

### Korábbi munka (50. session, 2026-07-04) — weather+crypto audit + flip-elemzés → Weather Invert ON döntés (B22)

A user kérte mindkét bot élő trade-jeinek ellenőrzését + a „ha élő lett volna" elemzést + a kérdést: *„a win rate a weathernél nem indokolja, hogy mindig az ellenkezőre tegyen?"* Read-only audit (kód nem változott). **A CLAUDE.md állapot 2.5 hetes volt — az élő számok drasztikusan eltértek.** **Crypto:** 30 closed, 40% WR, **+$817.55** (+545%), profitFactor 2.12, payoffRatio 3.17, bankroll $350→$974.36; a B27-fix működik, flip = −$108.91 → **NEM flip**, hagyni futni. **Weather:** 78 closed, 32% WR, **−$202.95**, bankroll $250→**$43.84** (majdnem elfogyott); `forecast_edge` **IC = −0.359** (n=78) + **fordított kalibráció** (modell 63%→realizált 18%; 7%→35%). A flip a mintán 60% WR / **+$29.55** (mindkét direkció pozitívba flippel) — valódi strukturális inverz anti-edge, **≠ a crypto regime-artifact**. Gamma cross-check: a resolutions valósak. **DE** a flip ár-aszimmetria miatt korlátozott (csak a vérzést állítja meg), és élőben a fee + vékony order book tovább ront. **Döntés (user: „Invert ON + reset") — ✅ ALKALMAZVA 2026-07-05 (auth-olt API, verifikálva: override+effective=1, weather $250/0 trade):** `weatherInvertDirection=1`, `weatherConfidenceMin` **marad** 0.65 (a user-opció csökkentése visszavonva — a confidence az ensemble-szórást kapuzza, nem a bucket predictedProb-ját), selectionShrink 0.5 + minPrice 0.05 marad, weather session **reset**. Felülírja a 06-13 invert-OFF döntést (akkor n=9 artifact; most n=78 strukturális). Monitoring: 20-30 post-invert trade után újra-audit; ha az sem pozitív → B15 σ-modellfix. Részletek: [changelog 2026-07-04](internal-docs/changelog/CHANGELOG-2026-07-04.md) · sprints.md B22/B15.

### Korábbi munka (49. session, 2026-06-15) — weather trade-history audit + B28 longshot floor

A user kérte a weather history ellenőrzését + a nagy nyeremények azonosítását. **Audit:** a 06-13-i reset óta 11 closed trade, +$392.33; PnL bit-pontosan reprodukálható (fee-mentes weather modell, eltérés +0.000), bankroll rekonciliál ($542.33). **Polymarket Gamma cross-check: a két nagy nyeremény VALÓS** — a Hong Kong 29°C bucket jún-14 ÉS jún-15 is YES-re resolvolt (+$335.94 @ ~5.6¢ és +$146.53 @ ~5.6¢ = a profit ~98%-a). **DE figyelmeztetés:** ezek mély-OTM tail-bucketek, amik paper-ben tökéletesen töltődnek, de élesben a vékony order book miatt nem fillelhetők méretben → a paper PnL (+157%) felfelé torzul (`evGap −$486` is jelzi). **Fix (B28, commit pusholva):** új `minPrice` longshot-floor a weather decision-engine-ben (gate a Kelly-cap után) — a megfogadott oldal market-ára < floor → blokk (szimmetrikus YES/NO). Új `weatherMinPrice` Settings-knob (default 0.05; loose 0.03 / normal 0.05 / strict 0.08) + `WEATHER_MIN_PRICE` env. A sports `sportsMinPrice` (B24) weather-megfelelője. +4 teszt-case, `tsc`+build zöld. A meglévő session **NEM** resetelve (a már realizált nyeremények valósak; a floor csak a JÖVŐBELI belépőkre hat). Részletek: [changelog 2026-06-15](internal-docs/changelog/CHANGELOG-2026-06-15.md) · sprints.md B28.

### Korábbi munka (48. session, 2026-06-14) — crypto audit + flip-analízis + `cond_prob` strike-fix (B27) + reset

A user kérte a `/trade/crypto/` ellenőrzését („itt tényleg az ellenkezőjére kellene fogadni"). **Validáció:** 12 closed trade, PnL bit-pontosan reprodukálható (−$120.38, eltérés +0.000), bankroll rekonciliál; de **17% WR, evGap −$234, 80% maxDD**. **Flip-analízis:** azonos tét ellentétes oldalon **+$80.57** (83% WR) — DE **regime-műtermék, nem stabil anti-edge**: a jel-szintű diagnózis kimutatta, hogy a modell MOST bullish (above-66k finalProb 0.39 vs market 0.19, az emelkedéssel összhangban), a 12 veszteség a jún-8…13-i bearish/counter-trend hétre esik. **A flip a visszapillantó-tükörre fogadna** (a weather B22-csapda). **Valódi bug (B27, commit pusholva):** a `cond_prob` jel a 3 nyitott snapshotban pontosan 0.200-ra telített (= −0.3 bearish cap), mert a related-piac monotonicity-check **kulcsszó alapján, strike-szűrés nélkül** húzott be piacokat → KÜLÖNBÖZŐ strike-okat hasonlított hamis violation-ökkel (~0.17 combiner-súly, konstans bearish lökés). **Fix:** csak azonos parsed strike K-t hasonlít; up-or-down piacon a monotonicity kimarad. **Jó hír:** a `vol_divergence` MOST K-aware és működik (B21 harap). **Crypto session RESET** ($350 tiszta lap) a deploy után. Maradó (fix B → backlog): a WATCH/LOW-IR trade-ek átcsúsznak a kapun. Részletek: [changelog 2026-06-14](internal-docs/changelog/CHANGELOG-2026-06-14.md) · sprints.md B27.

### Korábbi munka (47. session, 2026-06-13) — weather invert-mode (B22) sizing bug fix + invert KIKAPCSOLVA + reset

A user élesítette a weather `weatherInvertDirection` toggle-t (ellentétes oldal nyitása), és jelezte, hogy **a P&L rosszul számolódik ebben a módban**. Élő edge-tracker pull: **9 invert-trade, mind `shares:0` / `pnl:0`**, 0% WR — köztük 2 ténylegesen nyerő bucket is „loss"-ként. **Gyökérok:** a B22-implementáció a Kelly `probSide`-ot a **flippelt** (anti-edge) oldalon számolta → `rawKelly=0` → `positionSizeUSDC=0` → `shares=costBasis=0` → a reconciler minden inverted trade-et `pnl=0×exit−0=0`-val zárt, nyerő/vesztő egyaránt. **Fix (commit `70feab6`, pusholva):** a Kelly mostantól a `baseDirection` (modell-preferált, +edge) oldalon méretez → az invert egy *azonos méretű tükörfogadás* (pontosan amit a flip-audit mért); `invertDirection=OFF` esetén szigorú no-op. 2 új sizing-teszt (összesen 10 case) + `tsc`+build+regresszió zöld.

**Counterfactual (user-kérés):** ha a 9 trade jól méreteződött volna, az aggregált eredmény **≈ −$130…−$160** (7 veszteség, 2 apró nyerés, 22% WR) — az invert NEM keresett volna, mert a modell 7/9-ben jól tippelt (a B23 selection-shrink @0.5 javította a picket → fade visszaüt). **Ezért operátor-döntés (auth-olt API):** `weatherInvertDirection` **OFF** (override törölve → effective 0; élő scan igazolta: mind az 5 piac „normal", nem inverted) + weather session **RESET tiszta lapra** ($250 / 0 trade / 0 open). Részletek: [changelog 2026-06-13](internal-docs/changelog/CHANGELOG-2026-06-13.md) · sprints.md B22.

### Korábbi munka (46. session, 2026-06-07) — flip-audit + 4 adverse-selection fix

A user kérte mind az 5 bot flip-elemzését („jobban járnánk-e az ellentétes oldalon?"). Friss post-reset paper-adat (06-04 óta). **Flip-eredmény:** Weather −$87.88 → **+$32.38** (erős, de 2 confident-NO trade-ben koncentrált); Sports −$32.29 → −$9.55 (jobb, de **még mindig mínusz** — longshot-túlbecslés, nem flip-ügy); HL ≈ nulla (LONG-bias, B18); Crypto n=1; **F-Arb valójában rendben kereskedik** (+$0.22 net funding, a 0-érték csak edge-tracker display-bug volt). **4 fix implementálva:** B22 weather invert-toggle (OFF), **B23 weather selection-bias shrink AKTÍV @ 0.5**, sports `sportsMinPrice` longshot-floor **AKTÍV @ 0.05**, F-Arb edge-tracker mezőnév-fix. Új follow-up: **B26** (F-Arb ~$26.8 bankroll-gap). `tsc`+build+8-case új teszt+regresszió zöld. **Push `main` → Netlify CD deploy; reset auth-gated (operátor-credential kell).** Részletek: [changelog 2026-06-07](internal-docs/changelog/CHANGELOG-2026-06-07.md) · sprints.md B22/B23/B24/B25/B26.

### 5 bot státusz (2026-07-23 — friss auth-olt élő snapshot)

> **2026-07-23 friss `/multi-status` + `/edge-tracker` (auth-olt).** Barbell: a crypto (+$690, stopped) viszi a portfóliót; a többi 4 együtt −$560. Nettó realizált ≈ **+$130**. A `winRate` a summary-ben tört (0.378 = 37.8%).

| Bot | Bankroll | PnL | Trades | Open | Megjegyzés |
|-----|---------|-----|--------|------|-------|
| **Crypto** | $350 → **$1040.07** | **+$690.07** | 37 closed | 0 open | 🛑 **STOPPED** („Session loss limit reached"). 37.8% WR, profitFactor 1.67, payoffRatio 2.74. **A profit 4 longshoton ül** (top-4 +$801, a maradék 33 trade −$111) → n=37-en nem stabil edge. `apex_consensus` +0.195 / `momentum` +0.175 jó; `orderflow` **−0.165 ront**. evGap −$454, maxDD 227%. **Unbrick: B29 kódfix (deploy + resume) — a gross-loss odométer lőtte le a nyerőt.** |
| **Weather** | $250 → **$48.07** | **−$189.90** | 56 closed | 3 open | 51.8% WR, profitFactor 0.47, **payoffRatio 0.44** (win small, lose big). `forecast_edge` **IC +0.393** (megfordult a 07-04-i −0.359-ről) — az irány JÓ, a **sizing** a baj (a Kelly az ensemble-egyetértésre méretez → a legmagabiztosabban téves tétre rakja a legtöbbet). `weatherInvertDirection=1` **ON** — IC-ellentmondás → **B40 re-audit** (nem flippelve). Knobok alkalmazva: `selectionShrink` 1.0, `maxPositionUSD` 15. Fix-follow-up: **B35**. |
| **HL Perp** | $200 → **$186.81** | **−$13.19** | 188 closed | 0 open | ≈ breakeven, Sharpe −0.21. `orderflow` **+0.20 jó**, de `vol_divergence` **−0.32** + `pairs_spread` **−0.13** pozitív súllyal ront (a jelek kioltják egymást) → **B34** (sign-aware IC + `useRealizedIC`). Kelly win-prob mapping hibás (~13pp túlbizonyosság) → **B36**. LONG-bias → B18. |
| **F-Arb** | $200 → **$190.86** | **−$9.14** | 40 closed | 0 open | Delta-neutrális carry, mégis mínusz: 2 kódbug — forward-carry `spread` a `hlFunding` helyett + nyit-zár churn → **B31 kódfix** (deploy). Knob alkalmazva: `frMinSpreadHourly` 0.00005 (churn-sáv kiiktatva). Reális kimenet: ~breakeven / enyhén +; a vonzó reverse-láb B20-ig paper-only. |
| **Sports** | $450 → **$102.43** | **−$347.57** | 122 closed | 3 open | 🛑 **STOPPED (2026-07-23, operátor)**. ~10% WR, evGap **−$2677**. **Nincs edge-forrás:** a „fair value" = a Polymarket saját árának 0.5 felé húzása (fabrikáció) → 100% longshot-túlbecslés. Loss-limit **ON @ $50** alkalmazva. **Csak Pinnacle de-vig átépítéssel (B37) lehet nyereséges** — addig maradjon leállítva. |

### Mit fix utoljára (45. session, 2026-05-29 (c))

- **Crypto deploy-gap audit + build-fix** ✅: a user kérte a crypto trade-history validálását (`/trade/crypto/`). 45-trade audit a [`playbooks/trade-history-audit.md`](internal-docs/playbooks/trade-history-audit.md) 5-step szerint: **minden trade valid** (Gamma 16/16 cross-check, PnL 45/45 bit-pontos a 3.6% fee modellel, bankroll-rekonciliáció 0.0000), DE a teljesítmény katasztrofális (22% WR, −$109.75, evGap −$742, max DD 152%). **Gyökérok**: a 2026-05-15-i Sprint 41-42B deploy **elbukott a Netlify-on** — a top-level, handler nélküli `signal-combiner-threshold.test.mts`-t a Netlify functionként próbálta bundle-elni, és a `.test` pont érvénytelen függvénynév ("change the function names to contain only alphanumeric characters, hyphens or underscores"). Ezért a vol_div K-fix + outcome-overlap gate #16 + K-blind downweight **2 hétig nem volt élben**; a bot a régi 15-gate, lapos-predikció kódot futtatta (Loose preset 0.02 + $1000 loss-limit → nem állt le, $250→$109). **Fix**: a test fájl áthelyezve `auto-trader/shared/`-be (a Netlify nem kezeli külön functionként, mert az `auto-trader/` mappának van `index.mts`-e → egyetlen function; az ott élő 3 másik `.test.mts` ezt bizonyítja). Push (`5d910c8`) → deploy **zöld**, új kód él (16 gate + `combinerKBlindDownweight` a schemában verifikálva). **Operatív akciók (user-jóváhagyott, auth-olt API)**: `combinerKBlindDownweight=0.5`, `combinerConfidenceMin` 0.02→0.05 (Loose→Normál preset), `sessionLossLimit` marad $1000 (user explicit választása), crypto session **reset** tiszta lapra ($250 / 0 trade). A 45 buggos-kód trade + a rájuk épült IC-kalibráció törölve. (changelog 2026-05-29 (c))

- **Bidirekcionális F-Arb (Sprint 44)** ✅ IMPLEMENTÁLVA: a 4. bot auditja kimutatta, hogy az F-Arb **egyirányú** volt (`arb-detector.mts`: csak pozitív spread → HL-short), így a nagy negatív spreadeket (BTC −0.11%/h ≈ 968%/yr fordítva) strukturálisan kihagyta → 0 trade 2026-04-21 óta. A detektor + accrual + 8 gate + close-check + entryDecision mind **irány-tudatos** lett: **reverse** = HL-long + Binance-short, carry = `binanceRate − hlRate = −spread`. A reverse hedge Binance shortot igényelne, amit a live `hedge-manager.mts` szándékosan nem tud (spot-only), ezért a reverse **paper-only** (live-ban detektálva + explicit skippelve „needs Binance futures short → B20"). Új `shared/funding-arb-reverse.test.mts` (8 case) + `tsc`/build zöld. A live-élesítés (futures-short adapter) → **B20** (precondition: 10+ pozitív reverse paper-trade). (changelog 2026-05-29 (d) · sprints.md Sprint 44 + B20)

- **F-Arb saját bankroll (Sprint 45)** ✅ IMPLEMENTÁLVA: a user rámutatott, hogy a HL-directional (spekulatív irányított perp) és az F-Arb (delta-neutrális funding harvester) **két külön stratégia**, így nincs értelme a közös HL bankrollnak. Az `ArbSessionState` mostantól saját `bankrollStart` + `bankrollCurrent` mezőt visz (default $200); a méretezés a saját bankrollra megy (nem `loadHlSession`), a realizált funding-PnL záráskor a saját `bankrollCurrent`-be folyik (`creditArbPnl`), a `reset`/`topup` a saját tőkét állítja (nem ír a HL sessionbe). A `multi-status` + `FundingArbPanel` a saját bankrollt mutatja (`bankrollShared` → false, a „(shared)" címke eltűnik). A korábban felvetett B21 (cross-reconciliation) ezzel **tárgytalan** — a szétválasztás megszünteti a megosztott-tőke túl-foglalás kockázatát. `tsc`/build/12-case teszt zöld. (changelog 2026-05-29 (e) · sprints.md Sprint 45)

- **Sports loss-limit kikapcsolható + topup (Sprint 46)** ✅ IMPLEMENTÁLVA: a sports bot `stopped` volt a $30 napi loss-limit miatt ($250 → $214.93 paperben). Új `sessionLossLimitEnabled` config (**OFF paperben, ON live-ban**; `sportsSessionLossLimitEnabled` 0/1 Settings-knob override-olja); a guard csak engedélyezve tüzel; **auto-recovery** (a limit kikapcsolása a következő cron-tickkel feloldja a limit-stopot → a bot magától elindul). Topup bevezetve a registry-native botokra: `BotDefinition.topup` + dispatcher + `topupSportsSession` + `SportsTrader` 💰 gomb. A 3 sports preset bővült (Lazább/Normál OFF, Szigorú ON). Új `shared/sports-loss-limit-topup.test.mts` (4 case) + `tsc`/build zöld. (changelog 2026-05-29 (f) · sprints.md Sprint 46)

### Mit fix korábban (44. session, 2026-05-29 (b))

- **Sprint 43 Weather cron életre keltése** ✅ IMPLEMENTÁLVA: a user jelezte, hogy a weather bot „nagyon régen nyitott pozíciót". Élő státusz-pull: a weather `runStatus.source` **soha** nem volt `cron`, csak `manual`, utolsó futás **2026-05-21** (≈8 napja) — miközben a crypto/HL cron 3 percenként rendben fut. **Gyökérok**: a két weather cron (`auto-trader-weather-cron` */5 + `auto-trader-weather-reconciler-cron` */15) a legacy `export const handler = schedule(...)` wrappert használta, ami az esbuild/.mts build alatt **nem regisztrálódik** a Netlify scheduler-ben; a tüzelő cronok (`auto-trader`, `auto-trader-multi-cron`) mind sima `export default handler` + netlify.toml schedule mintát használnak. **Fix**: weather `run` + `reconcile` befűzve a bizonyítottan tüzelő `auto-trader-multi-cron` */3 fan-out-ba (`FanOutTarget.action` → `"run" | "reconcile"`). A dispatcher weather `run` ága `cronEnabled`-guardot kapott (a `weatherCronEnabled` pause-toggle cron-tick-eken megmarad; manuális Scan változatlan). A két halott wrapper fájl + netlify.toml entry **kivezetve**, UI/Settings label `5 min → 3 min`. `tsc --noEmit` + `npm run build` zöld; manuális run igazolta a kódutat (12:51 UTC-kor mind a 3 ázsiai piac expired 12:00 UTC után — a napi ablak ≈ 00:00–12:00 UTC). Élesedés: a következő `netlify deploy --prod` után `runStatus.source` weather-en `cron`-ra vált. (changelog 2026-05-29 (b) · sprints.md Sprint 43)

### Mit fix korábban (43. session, 2026-05-29 (a))

- **Sprint 42G HL consecutive-loss deadlock fix** ✅ IMPLEMENTÁLVA: a 2026-05-29 HL performance-audit feltárta, hogy a HL bot **12 napja (2026-05-17 óta) nem kereskedett**, miközben a cron futott. Gyökérok: `consecutiveLosses` (5) ≥ `consecutiveLossLimit` (3), és a [`decision-engine.mts:108`](netlify/functions/auto-trader/hyperliquid/decision-engine.mts) minden tick-en blokkol amíg a counter ≥ limit; a counter csak **nyertes** trade-en nullázódik → nincs trade → nincs win → permanens block. A "design intent 1h pause" valójában örökös leállás volt. **Fix 1**: új `clearElapsedConsecutiveLossPause()` pure helper a [`hyperliquid/session-manager.mts`](netlify/functions/auto-trader/hyperliquid/session-manager.mts)-ben, a runner a stopped- és pause-check között hívja — lejárt `pausedUntil` + counter ≥ limit → slate wipe → a bricked session **deploy után a következő cron-tick-en magától felépül** reset nélkül. **Fix 2**: `resumeHlSession` most a countert is nullázza (eddig csak `pausedUntil=null`, így a `resume` nem oldotta fel a deadlockot). Új `PAUSE_AUTORECOVER` LogEvent, 6 új unit test (`shared/hl-consec-loss-recovery.test.mts`), `tsc`+build+tesztek zöld. A HL **long-bias** (22/22 LONG, 27.3% WR, 32.7% calib-dev) **nem** kód-bug → **B18** backlog-vizsgálat (precondition 30+ trade). (changelog 2026-05-29 · sprints.md Sprint 42G + B18)

### Mit fix korábban (42. session, 2026-05-15)

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
