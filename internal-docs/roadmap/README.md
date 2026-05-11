# Roadmap — jövőbeli rendszer + action plan

Ez a mappa azt írja le, **hova tart** a projekt: Hetzner VPS migráció, új
stratégiák, infrastructure spec. A `current-state/` ezzel szemben azt írja
le, **mi van most**.

---

## SSOT-mátrix (Single Source of Truth)

Minden téma **egy** dokumentumban van vezetve. Ha máshol felbukkan, ott
csak hivatkozás vagy 1-soros összefoglaló legyen.

| Téma | SSOT fájl | Mit NE keress máshol |
|------|-----------|----------------------|
| **Implementáció-státusz** (P1.x, Cn., plan-on kívül megvalósult) | [`master-plan.md`](./master-plan.md) | `new-strategies.md` §8-ban van az "extra-roadmap" lista, de hivatalos status tracker a master-plan |
| **Stratégia-katalógus** (#1-#37 ötlet specifikációja) | [`new-strategies.md`](./new-strategies.md) | A `master-plan.md` csak hivatkozik rájuk |
| **VPS action plan** (EdgeCalc-specifikus 7-fázisos lépéssor) | [`hetzner-migration.md`](./hetzner-migration.md) | A `migration-strangler-fig.md` az absztrakt 9-fázis, NEM action plan |
| **VPS fizikai layout** (OS, port, stack, deploy script, monitoring) | [`hetzner-infrastructure.md`](./hetzner-infrastructure.md) | A `hetzner-migration.md` csak env+Postgres séma részeket említ |
| **Netlify → VPS komponens-mapping** (function → process táblázat) | [`migration-strangler-fig.md`](./migration-strangler-fig.md) §1 | A `hetzner-migration.md` csak a Hyperliquid + Funding-Arb portolásra fókuszál |
| **Risk koordinátor — miért NINCS** (no-build trade-off) | [`risk-coordinator-considerations.md`](./risk-coordinator-considerations.md) | Sehol máshol — minden más doksi csak hivatkozik rá |
| **Env-vár katalógus** | [`../current-state/env-vars.md`](../current-state/env-vars.md) | Egyetlen roadmap doksi sem listáz teljes env-szettet, csak az új live-mode env-eket említi |
| **Élő rendszer architektúra** | [`../current-state/architecture.md`](../current-state/architecture.md) | A "Mi van most" kép, NEM keverni a roadmap "mi lesz"-ével |
| **Session-by-session változás-history** | [`../changelog/`](../changelog/) | A CLAUDE.md "AKTUÁLIS ÁLLAPOT" csak a legutolsó session-t összegzi |
| **Bot-implementation reference** (math + 4 bot belső műk.) | [`../math/`](../math/) | A `master-plan.md` csak hivatkozik az `13-crypto-bot.md`/`14-hl-directional.md`/`15-funding-arb.md`/`16-weather-bot.md`-re |

---

## Olvasási sorrend (új session beszállásnál)

### 1. `master-plan.md` — Mit kell összességében megépíteni
A teljes rendszer architektúra (Netlify signal réteg + Hetzner execution
réteg + Polymarket + Hyperliquid execution targets), prioritások P1.x →
P3.x sorrendben + **friss státusz-jelölőkkel (✅/⚠️/❌/📋)**.

**Ez a tényleges állapot SSOT-je.**

### 2. `new-strategies.md` — 37 stratégia rangsorolva
Top 11 most-soon (0-6 hónap), 19 mid-term (6-12 hónap), 7 long-term, és
anti-roadmap (mit ne csinálj). **Minden ötlet implementáció-státusz
jelölővel** (✅ megvalósult / 🟡 részben / ❌ nem / 🔵 nem tervezett, de
megvalósult). A §8 listázza azt, ami **nem szerepelt** az eredeti
roadmap-ban, de a kódban megvan.

### 3. `hetzner-migration.md` — Konkrét action plan a következő sessionnek
EdgeCalc-specifikus 7-fázisos lépéssor (VPS setup → HL execution port →
funding-arb port → divergence WS → LP refresh → webhook bridge → Telegram
bot). Minden fázishoz fájllista + Bun + PM2 parancsok + Postgres séma.

### 4. `hetzner-infrastructure.md` — Mit építünk fizikailag
Hetzner CCX23 VPS layout, OS hardening, Postgres + Redis + Caddy + PM2
stack, port allokáció, deploy script, monitoring, DR. **A "ground truth"
arra, hogy mi fut a gépen.**

### 5. `migration-strangler-fig.md` — Strangler Fig pattern, absztrakt 9-fázis
A Netlify Functions 1:1 mapping-je VPS process-ekre. **Háttér-koncepció,
NEM friss action plan** — a `hetzner-migration.md` a végrehajtható.

### 6. `risk-coordinator-considerations.md` — Mit *NEM* építünk és miért
A pilléres modell mellett döntöttünk (saját bankroll, saját kill switch
pillérenként), nem koordinált portfolio. **No-build referencia.**

---

## Új ötlet hova kerüljön?

```
                    Új ötlet típusa
                          │
       ┌──────────────────┼──────────────────┐
       │                  │                  │
  Stratégia /         Infrastruktúra      Live-mode-bug
  trade signal        / VPS architektúra   / TODO-csere
       │                  │                  │
       ▼                  ▼                  ▼
  new-strategies.md   hetzner-migration.md  master-plan.md
  §1-§3 sorba         vagy                  "MI VAN MÉG HÁTRA"
  beszúrva,           hetzner-infra.md      szekció
  scoring kapcsán
       │
       └─── master-plan.md
            "MI VAN MÉG HÁTRA"
            szekciónál linkkel
            jelölve
```

**Konkrét szabályok:**

- **Új signal / új stratégia** → `new-strategies.md` (új #N tétel a Top 11
  / Mid / Long-term valamelyikébe, Score-számolással). Csak akkor kerül a
  `master-plan.md`-be, ha live-mode előtt prioritás.
- **Új live-mode bug / TODO** → `master-plan.md` "MI VAN MÉG HÁTRA"
  szekció (P1-P4 prioritás-bekérdezés).
- **Új VPS-process / Hetzner-feladat** → `hetzner-migration.md` 7-fázisú
  action plan-be (új sor + acceptance criteria).
- **Új fizikai-layout-döntés** (Postgres séma, port, monitoring stack)
  → `hetzner-infrastructure.md`.
- **Új implementáció-státusz** (megvalósult P1.x, Cn.) → csak a
  `master-plan.md` státusz-jelölője változik, **soha máshol** ne jelöld
  a státuszt.

---

## Session-zárás dokumentáció-frissítési checklist

A CLAUDE.md "KÖTELEZŐ SESSION-ZÁRÓ SZABÁLY" itt finomítva, csak roadmap
mappára:

| Mi változott a session-ben? | Frissíteni kell |
|------------------------------|------------------|
| Implementáltál egy P1.x / Cn. / plan-on kívüli feature-t | `master-plan.md` státusz-jelölő (✅ DONE jelölés + dátum) |
| Új ötletet identifikáltál (még nem implementálva) | `new-strategies.md` új #N tétel + Score |
| Megvalósítottál egy #N stratégiát a new-strategies.md-ből | `new-strategies.md` ✅/🟡 státusz frissítés ÉS `master-plan.md` "MI VAN MÉG HÁTRA"-ból kivenni |
| VPS-fázis lépést megcsináltál (még csak terv-szinten) | `hetzner-migration.md` checkbox-ok ✅-re |
| Új live-mode env-vár vagy secret kell | `current-state/env-vars.md` (NEM a roadmap-ben) |
| Architektúra-elv változott (pilléres modell finomítása) | `risk-coordinator-considerations.md` |

**Mit NE csinálj:**
- NE duplikáld a státuszt: ha master-plan.md ✅, akkor új-stratégiák.md is ✅, és semmi több.
- NE keverj live-state-et roadmap-pel: `current-state/` snapshot ≠ `roadmap/` tervezet.
- NE írj új tervezési fájlt minden session-ben: az 6 doksi (jelenleg) elég. Csak akkor új fájl, ha új téma kategóriát nyit (pl. új venue = új migration-target).

---

## Kapcsolódó

- **`../current-state/`** — a "honnan indulunk" snapshot (architecture, env-vars, deploy, settings, trading-status, auto-claim)
- **`../math/`** — algoritmus + 4 bot implementation reference (13-crypto / 14-hl / 15-funding-arb / 16-weather)
- **`../changelog/`** — session-by-session implementációs history
- **`../../CLAUDE.md` "AKTUÁLIS ÁLLAPOT"** — a legfrissebb élő állapot összefoglaló
