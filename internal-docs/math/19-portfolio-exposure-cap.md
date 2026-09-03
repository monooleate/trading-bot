# 19 — Portfolio crypto-beta exposure cap

> **Forrás:** [`roadmap/model-discovery-expansion.md`](../roadmap/model-discovery-expansion.md) §4.C (B49 #2) — a portfólió-kutató-ág #1 strukturális találata. **Implementálva:** 2026-09-03 (59. session). **Sprint-tracker:** [`sprints.md` B49](../roadmap/sprints.md#b49).
> **Státusz:** kész, **default OFF** (measure-first / operator opt-in). `tsc` exit 0 + 29/29 teszt + build zöld.

---

## 1. A probléma (kódból)

Minden bot **külön** méretez (¼-Kelly + 8% cap) a **saját** bankrolljára, a többiről mit sem tudva. De a **crypto** (BTC-threshold Polymarket) és a **HL-perp** (BTC/ETH/SOL directional) **mindkettő crypto-béta** → hat „független" 8%-os tét együtt lehet **egyetlen nagy korrelált BTC-pozíció**, amit a per-bot nézet nem lát (a barbell-tanulság: egy BTC-mozgás egyszerre üti a crypto longokat ÉS a HL longokat). A per-bot 8%×5 slot ≈ 34% egyetlen BTC-mozgásra, plusz a HL — a discovery §4.C ~15-20%-os aggregát capet javasol.

**Scope:** crypto + HL directional. A **funding-arb KIZÁRVA** — delta-neutrális (HL short + Binance long) → directional béta ≈ 0 (a tőkéje lekötve, de hedgelve az „egy BTC-mozgás" ellen). A **weather** nem crypto. Nem mond ellent a Sprint-45 F-arb-bankroll-szétválasztásnak: ez egy **cap-réteg** a per-bot bankrollok fölé, nem bankroll-újraegyesítés.

---

## 2. A modell (pure math)

[`packages/core/src/portfolio-exposure.mts`](../../packages/core/src/portfolio-exposure.mts) — tiszta, I/O-mentes. A **lekötött tőkét** méri (nem a levered notionalt), hogy a két bot commensurate legyen egy bankroll-hányad cap alatt:

- **crypto pozíció** → `costBasis` (USD kockáztatott tőke)
- **HL perp pozíció** → **margin = `sizeUSDC / leverage`** (lekötött tőke, nem a levered notional)

```
cryptoExposureUsd = Σ costBasis
hlExposureUsd     = Σ sizeUSDC / max(leverage, 1)

checkBetaCap(current, prospective, combinedBankroll, capFraction):
  capUsd    = capFraction · combinedBankroll
  projected = current + prospective
  allowed   = projected ≤ capUsd
```

**Fail-open:** ha `combinedBankroll ≤ 0` vagy `capFraction ≤ 0` → `allowed = true` (egy risk-cap sosem brickelheti a kereskedést degenerált inputon; az aktiválást külön az `enabled` flag kapuzza).

---

## 3. Bekötés (default OFF)

| Réteg | Fájl | Mit |
|---|---|---|
| Cross-bot loader | [`shared/portfolio-exposure.mts`](../../services/worker/src/pillars/shared/portfolio-exposure.mts) | `loadPortfolioBetaSnapshot(paperMode)` — a crypto + HL session persisted `openPositions` + `bankrollCurrent`; exception-safe (F-arb NEM töltve) |
| Config | [`shared/config.mts`](../../services/worker/src/pillars/shared/config.mts) | `getEffectiveBetaCap()` → `{enabled, fraction}` env + common Blobs-override |
| Crypto runner | [`pillars/index.mts`](../../services/worker/src/pillars/index.mts) | tick-eleji snapshot; a belépő ELŐTT: crypto-oldal a **LIVE** `updatedSession`-ból (intra-tick opens is számítanak), HL-oldal a snapshotból → `checkBetaCap` → skip ha átlép |
| HL runner | [`hyperliquid/index.mts`](../../services/worker/src/pillars/hyperliquid/index.mts) | szimmetrikus; a prospective = az új pozíció **margin**-ja (`sizeUSDC/leverage`); HL-oldal a LIVE session-ból, crypto-oldal a snapshotból |

**Intra-tick pontosság:** a snapshot a tick-eleji perzisztált állapot; a saját bot új belépői a tick alatt a LIVE session `openPositions`-jából jönnek → a cap egy scan-en belüli többszörös belépőnél is helyesen kumulál. A másik bot külön cron-tickben fut → a perzisztált snapshot elég.

**Knobok** ([`trader-settings.mts`](../../services/api/src/routes/trader-settings.mts) SCHEMA, category `common`, group „Portfolio risk"): `betaCapEnabled` (0/1, default **0**), `betaCapFraction` (default **0,25**, range 0,05–1,0). Env: `BETA_CAP_ENABLED`, `BETA_CAP_FRACTION` → [`env-vars.md`](../current-state/env-vars.md).

---

## 4. Miért default OFF + miért gross-capital

- **Default OFF (measure-first):** egy blokkoló gate viselkedés-változtató → a repo mintája szerint operator opt-in. ON → a bot skippel egy belépőt, ami átlépné az aggregát capet (a per-bot 8% marad a felső korlát bot-szinten).
- **Gross committed capital, nem signed net:** a v1 a *bruttó* lekötött crypto-directional tőkét capeli (nem a signed BTC-deltát), mert (a) a crypto-threshold pozíció signed-BTC-exposure-je nem lineáris (egy NO@above-K nem tiszta short), (b) a bruttó a konzervatív, „mennyi tőkém van egyszerre crypto-irányra kötve" mérték — pontosan a barbell-aggodalom. A signed-net finomítás follow-up.

---

## 5. Maradó (follow-up — sprints.md B49)

- **UI-láthatóság:** a `multi-status`-ba egy aggregát „crypto-beta utilization" mező (jelenleg csak a skip-reason logban látszik).
- **Signed-net exposure** (a bruttó helyett/mellett) — a valódi korrelált BTC-delta, nem csak a lekötött tőke.
- **Tágabb portfólió-réteg (discovery §4.C további tételei):** vol-target + max-DD kill-switch (#8), ENB diverzifikáció-monitor (#9) — külön B49-tételek.
