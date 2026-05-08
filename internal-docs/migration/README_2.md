# EdgeCalc — VPS Migration Document Pack

> **Dátum:** 2026-04-24
> **Verzió:** v1.0 — első teljes csomag a Netlify → Hetzner VPS migrációhoz

Ez a 4-dokumentum-csomag kíséri végig az EdgeCalc projekt átköltöztetését Netlify-ról saját Hetzner VPS-re, és ad keretet az új stratégiák hozzáadásához.

---

## Olvasási sorrend

### 1. `infrastructure.md` — Mit építünk fizikailag
A Hetzner CCX23 VPS layout, OS hardening, Postgres + Redis + Caddy + PM2 stack, port allokáció, env var katalógus, deploy script, monitoring, DR. **Ez a "ground truth" arra, hogy mi fut a gépen.**

**Olvasd ezt először**, ha még semmit nem ismersz a tervből.

### 2. `migration-plan.md` — Hogyan jutunk el odáig
A Netlify Functions 1:1 mapping-je VPS process-ekre, plusz a Strangler Fig pattern szerinti 9 fázisos migráció (Fázis 0–9), kockázatregiszter, és sikerkritérium.

**Olvasd ezt másodszor**, ez a cselekvési terv.

### 3. `risk-coordinator.md` — Mit *NEM* építünk és miért
A pilléres modell mellett döntöttél (saját bankroll, saját kill switch pillérenként), nem koordinált portfolio. Ez a doksi rögzíti, **mit adsz fel** ezzel, **milyen védelmeket** mindenképp építened kell (HL két wallet, globális kill switch), és **mikor** érdemes később koordinátort bevezetni.

**Olvasd ezt harmadszor**, mielőtt élesbe mész.

### 4. `new-strategies-roadmap.md` — Mit építsünk legközelebb
A korábbi 36 stratégia/bővítés ötlet + apex v2 (polyterm-inspirált) = **37 elem** rangsorolva edge potenciál × marginal value × risk asymmetry / build complexity szerint. Top 11 most-soon (0-6 hónap), 19 mid-term (6-12 hónap), 7 long-term, és anti-roadmap (mit ne csinálj).

**Olvasd ezt negyedszer**, vagy ugorj rá, ha a migrációs tervet már átláttad.

---

## Kulcsdöntések, amit ez a csomag rögzít

| Döntés | Választás | Indok |
|---|---|---|
| Hosting | Hetzner Cloud CCX23 Falkenstein | Olcsó, dedikált CPU, közel HU |
| Runtime | Bun (elsődleges) + Node.js (fallback) | TypeScript-natív, gyors WS |
| Database | Saját PostgreSQL 16 a VPS-en | Latency 0ms, full kontroll, nincs Supabase rate limit |
| Cache + event bus | Redis 7 lokális | Pub/sub alkalmas pillér-eseményekhez |
| Reverse proxy | Caddy 2 (auto HTTPS) | Egyszerűbb mint Nginx, Let's Encrypt out-of-box |
| Process manager | PM2 | Auto-restart, log rotation, monitoring TUI |
| Trading model | Pilléres (5 pillér izolált) | Egyszerűbb, paper-first, független fejleszthetőség |
| Bybit/Binance | Binance signal-feed read-only + Bybit execution + Bybit hedge | EU regulatórikus tisztaság, sharp Binance feed |
| Funding arb átírás | Opció 1: HL perp short + Bybit spot long | 1:1 átírás, ugyanaz a kockázat-profil |
| Bybit API | 1 közös kulcs (HEDGE + TRADE) | Egyszerűbb, izoláció kicsit sérül de OK induláskor |
| Risk koordinátor | NINCS most | Pilléres modell, később ha §4 trigger-ek aktiválnak |

---

## Migration timeline summary

```
Hét 1:    Fázis 0 — VPS előkészítés
Hét 2:    Fázis 1 — Frontend + Tools API (read-only)
Hét 3:    Fázis 2 — Signal layer
Hét 4:    Fázis 3 — Pillér 1 (poly-crypto) paper
Hét 5:    Fázis 4 — Pillér 1 LIVE + Pillér 2 paper
Hét 6:    Fázis 5 — Pillér 2 LIVE + Pillér 3 paper
Hét 7-8:  Fázis 6 — Pillér 3 LIVE + Pillér 4 (hl-bybit-arb) paper
Hét 9:    Fázis 7 — Pillér 4 LIVE + Netlify OFF
Hét 10-12: Fázis 8 — Pillér 5 (latency-arb) paper → live
Hét 13-14: Fázis 9 — Konszolidáció + post-mortem
```

**Reális becslés: 3 hónap** (más projektek mellett párhuzamosan), **6-8 hét** dedikáltan.

---

## Mit NEM tartalmaz ez a csomag

- **Konkrét kód** (Bun TypeScript implementation a pillérekre, signal-okra, adapter-ekre)
- **Claude Code prompt-ok** a fejlesztéshez (külön doksiba mennek, kérésre)
- **CLAUDE.md update** a VPS workflow-hoz (külön doksi, kérésre)
- **SQL migration files** (csak schema példák a doksiban, valós migrations file-ok kódoláskor)
- **Monitoring dashboard JSON** (Grafana/Prometheus, Phase 2 deliverable)

Ezeket akkor érdemes legyártani, **amikor egy konkrét fázis indul**, nem előre. Például a Fázis 6 (hl-bybit-arb) Bybit adapterhez akkor írok prompt-ot, amikor odaérünk.

---

## Mire kérdés a következő iterációban

Ha bármelyik doksi részletét **mélyebben** látnád:
- "Részletezd a Phase 6 Bybit adapter építését step-by-step Claude Code prompt-tal"
- "Adj egy konkrét SQL migration fájlt az init schema-ra"
- "Mutasd meg, hogyan néz ki egy pillér index.ts (Bun) skeleton kódja"
- "Hogyan írjam újra a `_resolution-risk.ts`-t Bun-ra Postgres state-tel"

…csak szólj, és arra a részre fókuszálok.

---

**Kapcsolódó eredeti dokumentumok** (a meglévő kódbázisban):
- `architecture.md` — jelenlegi state (v8 frontend + v0.6.0 auto-trader)
- `CLAUDE.md` — Claude Code session indító prompt
- `roadmap.md` — auto-trader sprint state
- `internal-docs/` — matematikai részletek (06-orderflow.md, 10-signal-combiner.md, stb.)

Ezekre a meglévő doksikra **továbbra is támaszkodj** a matematikai részletekért — a 4 új doksi az infrastruktúráról + migrációról + stratégia-roadmap-ről szól, nem a meglévő matek újraírásáról.
