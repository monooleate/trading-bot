---
paths:
  - "internal-docs/**"
---

# Belső doksik (SSOT)

- Minden téma egyetlen fájlban él; az SSOT-mátrix forrása `internal-docs/roadmap/README.md`. Hova mi kerül: új signal/stratégia → `roadmap/new-strategies.md` · élő bug/TODO státusz → `roadmap/master-plan.md` · sprint/backlog-feladat (B-szám) → **kizárólag** `roadmap/sprints.md` · env-vár/secret → `current-state/env-vars.md` · algoritmus → `math/NN-name.md` + `internal-docs/README.md` index · ismétlődő eljárás → `playbooks/<name>.md` · session-leírás → `changelog/CHANGELOG-YYYY-MM-DD.md`.
- Más doksiba (`math/`, `changelog/`, `current-state/`, `master-plan.md`) feladatból csak hivatkozás mehet (`→ Backlog B37`); „Maradó limitációk" / „Mit NEM tett" / TODO-lista sprints.md-tétel nélkül TILOS.
- Státuszt nem vezetünk két helyen (`master-plan.md` ✅ ⇔ `new-strategies.md` ✅); `current-state/` = élő snapshot, `roadmap/` = terv — ne keverd; env-lista roadmap-ba nem kerül.
- Lezárás előtt ellenőrizd, hogy a tétel tényleg nyitott-e a kódban (a B36 hat napig nyitottként szerepelt, pedig a fix élt).
- Trade-history audit kérésre („validate", „PnL valós?", „audit"): kötelező a `playbooks/trade-history-audit.md` 5-lépéses eljárása; teljes rendszer-audit: `playbooks/system-audit.md` (adat-first, read-only 1. fázis); napi üzemeltetés: `playbooks/edgecalc-ops.md`.
