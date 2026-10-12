---
name: session-close
description: EdgeCalc session-záró doksi-szinkron és SSOT-szabályok. Használd minden olyan session végén, ahol kód, knob, élő állapot vagy algoritmus változott (utolsó válasz előtt), illetve ha el kell dönteni, hova kerüljön egy új ötlet / feladat / env-vár / runbook az internal-docs-ban.
---

# EdgeCalc — session-záró szabály + doksi SSOT

> Kiegészítés (2026-10-12): a CLAUDE.md már **nem** tartalmaz session-narratívát. Az `AKTUÁLIS ÁLLAPOT` csak a ma igaz pillanatképet tartja (knob-referencia-lista + bot-státusz), a részletes leírás a `internal-docs/changelog/CHANGELOG-YYYY-MM-DD.md`-be megy. A régi narratívák: `CLAUDE-HISTORY.md` (nem töltődik be). Ha egy session-ből **tartós szabály** születik (csapda mechanizmussal, invariáns, operátor-döntés), azt a megfelelő `.claude/rules/<terület>.md`-be írd (1–2 soros, felszólító), ne a CLAUDE.md-be.
>
> **Knob-váltás után kötelező:** a CLAUDE.md „⚡ ÉLŐ knob-állapot — a drift-ellenőrzés referencia-listája" frissítése (a napi `edgecalc-drift-check` ütemezett feladat kulcsonként ehhez hasonlít, és a CLAUDE.md-t tekinti irányadónak).

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

