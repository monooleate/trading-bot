# Roadmap — jövőbeli rendszer + action plan

Ez a mappa azt írja le, **hova tart** a projekt: Hetzner VPS migráció, új
stratégiák, infrastructure spec. A `current-state/` ezzel szemben azt írja
le, **mi van most**.

---

## Olvasási sorrend

### 1. `master-plan.md` — Mit kell összességében megépíteni
A teljes rendszer architektúra (Netlify signal réteg + Hetzner execution
réteg + Polymarket + Hyperliquid execution targets), prioritások P1.x →
P3.x sorrendben. **Ez a legmagasabb szintű roadmap.**

**Olvasd ezt először**, hogy lásd a nagy képet.

### 2. `hetzner-migration.md` — A következő session konkrét action plan-je
EdgeCalc-specifikus 7-fázisos lépéssor (VPS setup → HL execution port →
funding-arb port → divergence WS → LP refresh → webhook bridge → Telegram
bot). Minden fázishoz konkrét fájllista + Bun + PM2 parancsok.

**Olvasd ezt másodszor**, ez a cselekvési terv.

### 3. `hetzner-infrastructure.md` — Mit építünk fizikailag
Hetzner CCX23 VPS layout, OS hardening, Postgres + Redis + Caddy + PM2
stack, port allokáció, env var katalógus, deploy script, monitoring, DR.
A "ground truth" arra, hogy mi fut a gépen.

### 4. `migration-strangler-fig.md` — Strangler Fig pattern, 9 fázisos absztrakt terv
A Netlify Functions 1:1 mapping-je VPS process-ekre, fokozatos kiváltás.
Régebbi (2026-04-24) és átfogóbb, mint a `hetzner-migration.md`. A kettő
**átfedi egymást** — a `hetzner-migration.md` a friss action-plan, ez itt
a háttér-koncepció.

### 5. `risk-coordinator-considerations.md` — Mit *NEM* építünk és miért
A pilléres modell mellett döntöttünk (saját bankroll, saját kill switch
pillérenként), nem koordinált portfolio. Ez a doksi rögzíti, **mit adunk
fel** ezzel, és **mikor** érdemes később koordinátort bevezetni. No-build
referencia.

### 6. `new-strategies.md` — 37 stratégia rangsorolva
Top 11 most-soon (0-6 hónap), 19 mid-term (6-12 hónap), 7 long-term, és
anti-roadmap (mit ne csinálj). Edge potenciál × marginal value × risk
asymmetry / build complexity szerint rangsorolva.

---

## Kapcsolódó

- **`current-state/architecture.md`** — a "honnan indulunk" snapshot
- **`changelog/`** — session-by-session implementációs history
- **CLAUDE.md "AKTUÁLIS ÁLLAPOT"** — a legfrissebb élő állapot
