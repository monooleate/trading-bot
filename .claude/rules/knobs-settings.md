---
paths:
  - "services/api/src/routes/trader-settings.mts"
  - "services/api/src/routes/recommendations-api.mts"
  - "services/worker/src/pillars/shared/config.mts"
  - "services/worker/src/pillars/shared/paper-never-stop.mts"
  - "services/worker/src/pillars/shared/recommendations.mts"
  - "packages/core/src/settings-store.ts"
  - "packages/core/src/plateau.mts"
  - "packages/core/src/thompson.mts"
  - "packages/core/src/trial-cluster.mts"
  - "apps/web/src/components/SettingsPanel.tsx"
---

# Knobok / Settings (operátor-kapcsolók)

- Új viselkedés = új knob a `trader-settings.mts` `SCHEMA`-ban (+ env-default a `shared/config.mts`-ben), **default-OFF**, és OFF-nál **bit-azonos** a régi úttal. Élesíteni csak mérés (promóciós kapu / tisztességes OOS összevetés) után, operátor-döntéssel szabad.
- Élő knob-váltás operátor-döntés. A `blob_kv` / `trader-settings` / `runtime-overrides-v1` írását a harness classifier blokkolja → adj kész SQL-t, az operátor futtatja. Utána KÖTELEZŐ: a CLAUDE.md „⚡ ÉLŐ knob-állapot" listájának frissítése (a napi `edgecalc-drift-check` kulcsonként ehhez hasonlít) + DSR-trial naplózás (`appendTrial`).
- Knobot mindig az effektív getteren olvass (`effectiveFlag(ov, "…")`, `getEffective*Config()`), SOHA a nyers override-map + `=== 1`-gyel — így a `useRealizedIC` SCHEMA-defaultja évekig nem érvényesült (audit P1-6).
- Az unauth `GET /trader-settings` szándékosan üres override-ot ad (`auth.ok ? loadRuntimeOverrides() : {}`) → override-állapotot csak auth-olt hívásból vagy a DB-ből állíts; „wiped overrides" következtetés unauth válaszból tilos.
- Knob-osztályok (math/34): **A guardrail** (Kelly, sanity cap, session-loss-limit, `liveReadyOverrideEnabled`) SOHA nem tuning- és SOHA nem javaslat-tárgy (a recommendations-engine sem javasolhatja); **B tunable** → plateau-sweep, a legszélesebb near-best futam közepe (`selectPlateau`), nem a csúcs; **C theory-default** → ne sweepeld.
- A hangolás nem teremt edge-et: ha a modell a piaci ár ellen negatív Brier-skillű, a küszöb-lazítás / halt-kikapcsolás csak gyorsítja a paper-veszteséget — TILOS (B56b, 95. session döntése: „NINCS lazítás").
- „Plauzibilis" javítást előbb ledger-szimulációval mérj: a B56 #2 (semleges jelek kihagyása) és a `combinerLogOddsStrength=1` mérve rontott.
- `paperNeverStop` (default 1) paper módban csak az AUTO-stopot oldja fel (self-heal + loss-limit → ∞); a MANUÁLIS stop (`stoppedReason="Manual stop"`) tartós. LIVE módban hatástalan.
- Bot tartós leállítása: manuális `stop` action; a `session.stopped`-ot reset, simVersion-bump vagy olvasási hiba törölheti, ezért a sportsnál a `sportsCronEnabled=0` a tartós szándék. A Phase-4 tiszta indulás így vesztett el egy operátor-stopot és minden júliusi override-ot → migráció/reset után ellenőrizd a knob-listát.
- `riskDdKillEnabled` csak a crypto runnerbe van bekötve, és paperben `paperNeverStop=1` mellett csak naplóz (egyirányú ajtó lenne).
- Knob-hatást csak valódi A/B-karokkal (`firstConfigHash`, config-attribution) értékelj; pre-flip kar nélkül (n≈0) a bandit „prob-best"-je a priorból jön, nem bizonyíték.
