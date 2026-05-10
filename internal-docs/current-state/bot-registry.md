# Bot Registry — Új bot rollout-pattern

> **Utolsó frissítés:** 2026-05-11
> **Bevezetve:** Huszonhatodik session (2026-05-11)
> **Első natív bot:** Sports (Polymarket NBA/NFL/EPL — paper-only)

A Bot Registry egyetlen forrás-igazságot ad a 4+ kategória-bot
nyilvántartására. Új bot hozzáadása ~3-4 óra, a meglévők érintetlenek
maradnak.

---

## Alapelvek

1. **Additív strangler-fig pattern.** A `dispatchToRegistry()` a
   `auto-trader/index.mts` dispatcher tetején fut, DE csak a nem-legacy
   kategóriákra (azaz NEM crypto / weather / hyperliquid). A 4 meglévő
   bot 100%-ban a régi switch-case-en megy keresztül — **nulla
   viselkedés-változás.**
2. **Új bot regisztrálja önmagát.** A bot folder `index.mts` top-level
   hívással meghívja a `registerBot(botDefinition)`-t. A
   `registry-bootstrap.mts` lazy-importálja az új bot modul-ját, ami a
   regisztrációt automatikusan triggereli.
3. **5 lifecycle method.** Minden BotDefinition implementálja: `run`,
   `getStatus`, `reset`, `stop`, `resume`. A `reconcile` opcionális
   (csak deferred-settlement botok).
4. **BotSessionBase kontraktum.** Minden session a Bankroll / PnL /
   Trades / Open négyest exponálja — a TraderShell UI ez alapján
   rajzolja a 4-cellás stats grid-et.

---

## File struktúra egy új bot-hoz

```
netlify/functions/auto-trader/<bot>/
├── index.mts              ← BotDefinition export + registerBot() call
├── config.mts             ← env-driven config + defaults
├── types.mts              ← session/position/trade types
├── session-manager.mts    ← Blobs storage helpers
├── market-finder.mts      ← Polymarket / data API market discovery
├── decision-engine.mts    ← gate-based entry decision
├── paper-resolver.mts     ← settlement via Gamma (UMA finality + slug check)
└── run-state.mts          ← Blobs-tárolt scan run-state (UI pillel)
```

Frontend:
```
src/components/trader/<Bot>Trader.tsx   ← TraderShell + reusable card adapter
src/components/CategoryDashboard.tsx     ← 3 sorral kibővítve
src/components/HomePage.tsx              ← READINESS_CATEGORIES + CARDS array
netlify/functions/multi-status.mts       ← read<Bot> helper + reduce array
netlify/functions/auto-trader-multi-cron.mts  ← új cron TARGETS entry
src/pages/trade/[category].astro          ← getStaticPaths bővítés
netlify/functions/edge-tracker.mts        ← STORE_SPECS új entry
```

---

## Lépésről lépésre — Hogyan adj hozzá új bot-ot

### 1. Backend (≈ 2 óra)

#### a) `<bot>/types.mts` — session + position shape

```typescript
import type { EntryDecisionSnapshot, DecisionGate } from "../shared/types.mts";

export interface MyBotSessionState {
  startedAt:        string;
  paperMode:        boolean;
  stopped:          boolean;
  stoppedReason:    string | null;
  bankrollStart:    number;
  bankrollCurrent:  number;
  sessionPnL:       number;
  sessionLoss:      number;
  openPositions:    MyBotPosition[];
  closedTrades:     MyBotClosedTrade[];
  simVersion:       number;       // bump on paper-sim semantics change
}
```

#### b) `<bot>/config.mts` — env-driven config

```typescript
export interface MyBotConfig {
  paperMode:        boolean;
  edgeThreshold:    number;
  // ... bot-specific knobs
}

export function getMyBotConfig(): MyBotConfig {
  return {
    paperMode:     process.env.MYBOT_PAPER_MODE !== "false",
    edgeThreshold: parseFloat(process.env.MYBOT_EDGE_THRESHOLD || "0.08"),
    // ...
  };
}

export const MYBOT_DEFAULT_BANKROLL = 50;
export const MYBOT_SIM_VERSION = 1;
```

Update `internal-docs/current-state/env-vars.md` with the new env vars.

#### c) `<bot>/session-manager.mts` — Blobs storage

Use the sports bot's `session-manager.mts` as a template. Auto-archive
old simVersion sessions on load.

#### d) `<bot>/market-finder.mts` — discovery

Polymarket events via Gamma API (`/events?closed=false&active=true&...`)
+ keyword filter or tag filter. Filter for liquidity, end-date, and
extreme prices.

#### e) `<bot>/decision-engine.mts` — gates

Build a `gates: DecisionGate[]` array in evaluation order. Every gate has
`label`, `passed`, `actual`, `required`. The first failing gate's
label goes into `reason`. The UI shows the full gate list as a chip-
hover popover automatically.

Kelly sizing: use the standard binary formula with quarter-Kelly + hard
cap (`MAX_KELLY_FRACTION`).

#### f) `<bot>/paper-resolver.mts` — settlement

Reuse the UMA finality gate pattern from `sports/paper-resolver.mts`:
- `condition_ids=<id>&closed=true` query
- `umaResolutionStatus === "resolved"` required (NOT "proposed" etc.)
- outcomePrices ∈ {0, 1} (with 0.001 tolerance)

#### g) `<bot>/run-state.mts` — UI status pill

Copy `sports/run-state.mts` with the bot name replaced. Blobs key:
`<bot>-runtime`.

#### h) `<bot>/index.mts` — main loop + registry export

```typescript
import { registerBot, type BotDefinition } from "../shared/bot-registry.mts";

async function runMyBotTrader(source: "manual" | "cron") {
  // 1. markRunStart()
  // 2. loadSession()
  // 3. resolvePending() — settlement pass
  // 4. findMarkets() — discovery
  // 5. for each market: makeDecision() → addOpenPosition() if shouldTrade
  // 6. session loss limit check
  // 7. saveSession()
  // 8. markRunFinish()
}

const botDefinition: BotDefinition = {
  category: "mybot",
  label:    "My Bot",
  subtitle: "What it does",
  venue:    "Polymarket",
  run:      ({ source }) => runMyBotTrader(source),
  getStatus: getMyBotStatus,
  reset:    myBotReset,
  stop:     myBotStop,
  resume:   myBotResume,
  ui: {
    showLiveReadiness: false,        // true once you have a live path
    showCalibration:   true,
    cronIntervalLabel: "3 min",
    flavor:            "prob",
  },
};

registerBot(botDefinition);
export { botDefinition };
```

#### i) Register in `registry-bootstrap.mts`

```typescript
import "./mybot/index.mts";   // one new line — triggers registration
```

### 2. Frontend (≈ 1 óra)

#### a) `src/components/trader/<Bot>Trader.tsx`

Use `SportsTrader.tsx` as a template. The TraderShell handles:
- Header (title + subtitle + paper/live mode badge + cron status pill)
- 4-cell stats grid (Bankroll / Session PnL / Trades / Open)
- Controls (Run / Stop / Resume / Refresh)
- Reset dialog (type-to-confirm) + JSON trade export
- Calibration Health badge + (optional) Live Readiness badge

You only write:
- The `stats` array (4 TraderStat entries)
- The `controls` array
- The `openRows` mapper (SportsPosition → OpenPositionRow)
- The `<ScanResultsCard>` block with chips + criteria gates

#### b) `CategoryDashboard.tsx` — 3 helyen 1 sor

```typescript
import MyBotTrader from "./trader/MyBotTrader";

const CATEGORY_TABS = {
  ...,
  mybot: [
    ["autotrader",   "My Bot"],
    ["edge-tracker", "Edge Tracker"],
    ["settings",     "⚙ Beállítások"],
  ],
};

function renderMyBotTab(tab, bankroll) { ... }

case "mybot": return renderMyBotTab(tab, bankroll);
```

#### c) `HomePage.tsx` — 2 sor

`READINESS_CATEGORIES` array + `CARDS` array bővítés (1-1 új objektum).

#### d) `multi-status.mts` — 1 új helper + reducer bővítés

`readMyBot(paperMode)` helper a Blobs-tárolt session-ből. Add the
helper into the `Promise.all` + `all` array.

#### e) `auto-trader-multi-cron.mts` — 1 új TARGETS entry

```typescript
{ label: "mybot", body: { action: "run", category: "mybot" } }
```

#### f) `[category].astro` — 1 új getStaticPaths entry

```typescript
{ params: { category: "mybot" } }
```

### 3. Edge Tracker integration

#### a) `edge-tracker.mts` — STORE_SPECS bővítés

```typescript
{ store: "auto-trader-session-mybot", paperKey: "session_paper", liveKey: "session_live", category: "mybot" },
```

#### b) Frontend category type unions

Bővítsd ki:
- `src/components/EdgeTrackerPanel.tsx:EdgeCategory`
- `src/components/shared/useTradeExport.ts:ExportCategory`
- `src/components/shared/CalibrationHealthBadge.tsx:Props.category`
- `src/components/shared/LiveReadinessBadge.tsx:Props.category`
- `src/components/shared/TraderShell.tsx:CalibrationCategory` + `LiveCategory`

---

## Sports bot — referencia implementáció

A teljes file struktúra konkrét példája:

```
netlify/functions/auto-trader/sports/
├── index.mts              ← runSportsTrader + botDefinition + registerBot()
├── config.mts             ← getSportsConfig() — 12 env-knob
├── types.mts              ← SportsSessionState, SportsPosition, SportsClosedTrade
├── session-manager.mts    ← loadSportsSession, saveSportsSession, simVersion archive
├── market-finder.mts      ← findSportsMarkets(): Polymarket sports tag → flatten markets
├── decision-engine.mts    ← makeSportsDecision(): 5 gate (open count, fan-extreme,
│                            net edge, kelly conviction, min position size)
├── paper-resolver.mts     ← resolvePendingSportsPositions() + UMA finality gate
└── run-state.mts          ← markRunStart/Finish, getSportsRunStatus
```

Frontend:
```
src/components/trader/SportsTrader.tsx  ← 165 LOC, TraderShell adapter
```

12 env-var a Sports bot-hoz (mind `SPORTS_*` prefixszel):
- `SPORTS_PAPER_MODE` (default true)
- `SPORTS_FAN_EXTREME_HIGH` / `SPORTS_FAN_EXTREME_LOW` (0.85 / 0.15)
- `SPORTS_EDGE_THRESHOLD` (0.08)
- `SPORTS_MAX_KELLY` (0.05)
- `SPORTS_MAX_POSITION_USD` (20)
- `SPORTS_MIN_POSITION_USD` (1)
- `SPORTS_SESSION_LOSS_LIMIT` (30)
- `SPORTS_MIN_VOLUME_24H` (5000)
- `SPORTS_MIN_HOURS_TO_END` (2)
- `SPORTS_MAX_OPEN_POSITIONS` (3)
- `SPORTS_ROUNDTRIP_FEE` (0.04)

---

## Migráció a legacy bot-okból

A jelenlegi 4 bot (crypto / weather / hyperliquid / funding-arb)
**továbbra is a régi switch-case-en megy keresztül** — semmi sem
sérült a registry bevezetésekor.

Migrálás egy adott bot-hoz (jövőbeli session):
1. Adj `bot-def.mts`-t a bot folderébe ami exportálja a `BotDefinition`-t.
2. A definíció `run/getStatus/reset/stop/resume` mezője a már exportált
   handlereket hívja (`runCryptoTrader`, `getStatus`, etc. — előbb
   exportálni kell a `auto-trader/index.mts`-ből).
3. Add a `bot-def.mts` import-ot a `registry-bootstrap.mts`-be.
4. A `LEGACY_CATEGORIES` set-ből vedd ki a bot kategóriáját.
5. Smoke teszt: a registry path most kezeli a bot-ot.

A migráció során a legacy switch-case ágat **nem** szabad rögtön
törölni — fallback-ként marad amíg ki nem derül, hogy a registry path
mindent helyesen kezel. Egy session erejéig hagyni érdemes.

---

## Új bot tervezési séma — ellenőrzőlista

Mielőtt egy új bot kódot kezdesz írni, gondold át:

- [ ] **Mi az "edge"?** Mit ad mit a piac nem tud? (Statistical model,
      smart money tracking, microstructure, etc.)
- [ ] **Honnan jön a signal?** Polymarket-saját adat? Külső API
      (Binance, NOAA, ESPN)? Saját ML modell?
- [ ] **Milyen piacokat scan-elsz?** Gamma tag? Keyword filter?
      Gondolj a `findMarkets()` lekérés méretére és cache-elésére.
- [ ] **Gate-ek listája.** Tipikusan 4-7 gate: market filter,
      edge-after-fees, Kelly conviction, position-count cap,
      session-loss limit, per-asset cooldown.
- [ ] **Settlement.** Polymarket-saját (Gamma resolution) vagy külső
      adat (METAR mintát mintázzuk a weather-nél)?
- [ ] **Paper vs Live.** Live trade endpoint kell-e? Vagy CTF redeem?
- [ ] **Telegram alertek.** ORDER_FILLED / TRADE_CLOSED / SESSION_STOP
      mind működjenek.

---

## Csak nézd meg a "Hová nyúlj legközelebb" listát

A `internal-docs/roadmap/master-plan.md` `MI VAN MÉG HÁTRA` szekciójában
maradt nagy sprintek:
- P4.2 Politics bot (LLM news sentiment)
- P4.2 Macro bot (Fed calendar + NOAA)
- P3.3 LP Refresh Window (igényli a Hetzner WebSocket-et)

Mindegyikre a fenti pattern alkalmazható.
