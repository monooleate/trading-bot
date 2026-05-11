# EdgeCalc Auto-Trader — Internal Docs

> Quantitative Polymarket + Hyperliquid auto-trading system built on EdgeCalc signal infrastructure.

---

## Hogyan navigálj ebben a mappában

| Mappa | Mit tartalmaz | Mikor olvasd |
|-------|---------------|--------------|
| **`current-state/`** | Élő rendszer snapshot — mi van most | Új session elején: "mi működik, mi a deploy state, milyen env-ek kellenek" |
| **`math/`** | Signal math + bot implementation reference | Algoritmus-szintű kérdéseknél: "hogy számol a Kyle λ", "mi a 8-gates HL-en" |
| **`roadmap/`** | Jövőbeli rendszer + action plan | "Mit építsünk legközelebb", "Hetzner-migráció lépései" |
| **`changelog/`** | Session-by-session history | "Mit változtattam tegnap" |
| **`archive/`** | Elkészült promptok + historikus tanulságok | Ritkán; csak ha egy régi döntés indokát keresed |

A **CLAUDE.md** a repo gyökerében az **AKTUÁLIS ÁLLAPOT** szekcióval — minden sessionben kötelezően frissítjük. Az itt található doksik a részletek.

---

## current-state/ — Élő rendszer

| Fájl | Topic |
|------|-------|
| `current-state/architecture.md` | **Full current-state snapshot** (kódbázis, mappa, 11 tab, 16 function) |
| `current-state/trading-status.md` | **Mit tudsz most szerver nélkül vs mit Hetznerrel** (olvasd, ha kereskedni akarsz) |
| `current-state/settings-reference.md` | Minden Settings tab paraméter referenciája (4 bot × 5-11 knob) |
| `current-state/env-vars.md` | **61 env-változó** kategorizálva 13 csoportba, minimum env-szettek 5 deploy szcenárióhoz |
| `current-state/auto-claim.md` | Polymarket auto-claim (intent + lokális redeem flow) |
| `current-state/deploy.md` | Netlify deploy workflow + lokális paper-mode teszt |

---

## math/ — Signal math + bot implementation reference

| Fájl | Téma | Math / impl |
|------|------|-------------|
| `math/02-ev-kelly.md` | EV + Kelly criterion | f* = (pb-q)/b |
| `math/06-orderflow.md` | Order flow analysis | Kyle λ, VPIN, Hawkes |
| `math/07-vol-harvest.md` | Volatility divergence | IV vs RV spread |
| `math/08-apex-wallets.md` | Smart money tracking | Payout ratio, bot detect |
| `math/09-cond-prob.md` | Conditional probability | Marginal polytope violations |
| `math/10-signal-combiner.md` | Signal combination | Grinold-Kahn IR = IC × √N |
| `math/11-arb-matrix.md` | Arbitrage detection | VWAP scanner, LLM dependency |
| `math/12-realtime-websocket.md` | WebSocket architecture | Phase 3 — math leírva, deploy planned |
| `math/13-crypto-bot.md` | **Crypto auto-trader implementation** | 8 gate, Kelly sizing, paper-vs-live invariants, runtime walkthrough |
| `math/14-hl-directional.md` | **HL directional perp bot** | 8 gate, ¼-Kelly + 3x lev cap, TP/SL clamps, paper funding accrual |
| `math/15-funding-arb.md` | **Funding-rate arb bot** | 5 gate, atomic 2-leg open, mark-to-market accrual, asymmetric close slippage |
| `math/16-weather-bot.md` | **Weather bot** (ensemble forecast + bucket matching) | Gauss PDF allokáció, METAR settlement, bug audit |
| `math/151-Trading-Strategies.pdf` | Academic reference (Kakushadze) | 151 strategies anthology |

---

## roadmap/ — Hova tart a projekt

**SSOT-mátrix és új-ötlet-routing**: lásd [`roadmap/README.md`](./roadmap/README.md).
A 6 fájl mindegyikéhez SSOT-fejléc tartozik, ami megmondja **mit találsz
ott és mit NEM**, hogy duplikáció ne keletkezzen.

| Fájl | SSOT scope (egy téma → egy hely) |
|------|----------------------------------|
| `roadmap/README.md` | SSOT-mátrix · új-ötlet-routing · session-zárás dokumentáció-checklist |
| `roadmap/master-plan.md` | **Implementáció-státusz SSOT** (P1.x → P4.x + plan-on kívüli, ✅/⚠️/❌/📋 jelölőkkel) |
| `roadmap/new-strategies.md` | **Stratégia-katalógus SSOT** (#1-#37 ötlet részletes spec + Score) |
| `roadmap/hetzner-migration.md` | **VPS action plan SSOT** (EdgeCalc-specifikus 7-fázis) |
| `roadmap/hetzner-infrastructure.md` | **VPS fizikai layout SSOT** (OS, port, deploy, monitoring) |
| `roadmap/migration-strangler-fig.md` | **Komponens-mapping SSOT** (Netlify Function → VPS process táblázat, absztrakt 9-fázis) |
| `roadmap/risk-coordinator-considerations.md` | **Pilléres-vs-koordinátor trade-off SSOT** (no-build referencia) |

---

## changelog/ — Session-by-session history

| Fájl | Scope |
|------|-------|
| `changelog/CHANGELOG.md` | Régi főeredmény-changelog (~v0.4 előtti) |
| `changelog/CHANGELOG-2026-04-21.md` | Resolution-risk → HL → funding-arb → weather sprint |
| `changelog/CHANGELOG-2026-05-08.md` | Master-plan A.1–A.6, runtime settings UI, Hetzner migration plan |
| `changelog/CHANGELOG-2026-05-09.md` | Weather bot 6 bugfix + Settings tab + crypto paper sim v2 + UI unification + HL split |
| `changelog/CHANGELOG-2026-05-10.md` | Sim v3 (real Polymarket only), audit fixek, HL+F-Arb finding closeolva, gate UI uniform |
| `changelog/CHANGELOG-2026-05-11.md` | Crypto Reconcile + Gamma diagnostic, env-vars doksi, "Unknown error" timeout fix |

---

## archive/ — Elkészült promptok + historikus tanulságok

| Fájl | Indok |
|------|-------|
| `archive/prompts/autotrader-prompt.md` | Eredeti Sprint 1 design prompt (Crypto Execution Core) — implementálva |
| `archive/prompts/hyperliquid-prompt.md` | HL execution sprint design prompt — implementálva |
| `archive/prompts/funding-arb-patch.md` | Funding-rate arb patch prompt — implementálva |
| `archive/prompts/resolution-risk-prompt.md` | Resolution risk scorer design prompt — implementálva |
| `archive/prompts/weather-patch-prompt.md` | Weather bug fix prompt — implementálva |
| `archive/paper-pnl-v2-bug.md` | 2026-05-09 paper PnL fake szám analízis — fixelve sim v3-mal |
| `archive/grabit-vps-setup.md` | Másik projekt VPS setup tanulságai (referencia a Hetzner setup-hoz) |
| `archive/matekmegoldasok-content-roadmap.md` | Másik projekt cikk-roadmap, nem trading bot |

---

## Quick start a kódhoz

A teljes kódbázis-snapshot a [`current-state/architecture.md`](./current-state/architecture.md)-ben.
A jelenleg élő funkcionalitás (mit tudsz tradelni szerver nélkül) a
[`current-state/trading-status.md`](./current-state/trading-status.md)-ben.

A repo gyökerében a **CLAUDE.md** kötelező olvasmány minden session elején — az
**AKTUÁLIS ÁLLAPOT** szekció a legfrissebb élő statusszal.
