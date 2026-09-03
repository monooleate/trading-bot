# 25 — Risk overlays: vol-target + drawdown kill-switch

> **Forrás:** [`roadmap/model-discovery-expansion.md`](../roadmap/model-discovery-expansion.md) §4.C (B49 #8). **Implementálva:** 2026-09-03 (65. session). **Sprint-tracker:** [`sprints.md` B49](../roadmap/sprints.md#b49).
> **Státusz:** kész, **default-OFF** (measure-first). `tsc` exit 0 + 34/34 teszt + build zöld.

---

## 1. Miért

A ¼-Kelly a log-növekedést maximalizálja, de **néma a realizált volatilitásra és a drawdownra** — a full-Kelly ~60% átlag maxDD, és a ¼-Kelly is vérzik, ha egy bot realizált hozam-vol-ja felpörög (regime-shift) vagy egy vesztő sorozat kumulálódik. Két olcsó, robusztus overlay a ¼-Kelly TETEJÉRE:

- **Vol-target:** a méretet a `cél-vol / realizált-vol` aránnyal skálázza (clamp) — levágja, ha a vol forró, visszaállítja, ha nyugodt.
- **Drawdown kill-switch:** leállítja az ÚJ belépőket, amint a peak-to-current equity a limit alá esik (a nyitottakat nem érinti). Elvi peak-equity stop a bruttó-veszteség odométer helyett (vö. B33).

---

## 2. A matek (pure)

[`packages/core/src/risk-overlay.mts`](../../packages/core/src/risk-overlay.mts) — tiszta, I/O-mentes.

- `realisedVol(returns)` — minta-szórás (< 2 pont → 0).
- `volTargetMultiplier(realisedVol, targetVol, {maxMult=1.5, minMult=0.25, volFloor})` → `clamp(targetVol/realisedVol, min, max)`; no-op (1), ha a realizált vol ismeretlen vagy targetVol ≤ 0.
- `drawdownKill(peak, current, maxDdFraction)` → `{kill, ddFraction, peak, current}`; `kill` ha `(peak−current)/peak ≥ maxDdFraction`; fail-open nem-pozitív peak-en.

4-csoportos [teszt](../../packages/core/src/risk-overlay.test.mts): realisedVol, vol-target (==→1, forró→0.5, nyugodt→clamp 1.5, extrém→floor 0.25, no-op), DD-kill (20%<25% nincs kill, 30%≥25% kill, új-csúcs, fail-open).

---

## 3. Bekötés (crypto runner, default-OFF)

[`pillars/index.mts`](../../services/worker/src/pillars/index.mts), tickenként `getEffectiveRiskOverlay()`:
- **DD-kill** (a belépő gate-ek közt): a peak-et a closed-trade equity-görbéből számolja (`bankrollStart + Σpnl` futó maximuma), a current a `bankrollCurrent`; `kill` → skip a reason-nel. OFF → kihagyva.
- **Vol-target:** a `decision.positionSizeUSDC`-t szorozza `volTargetMultiplier(realisedVol(utolsó 30 trade pnl%), targetVol)`-lal → `sizeUSDC`. A `sizeUSDC` megy a beta-cap-be (#2), a `placeBuyOrder`-be (#1 fill), az entry-snapshotba és az alertbe (konzisztens). OFF → `sizeUSDC = decision.positionSizeUSDC` (bit-azonos).

**Knobok** (SCHEMA, `common`, „Portfolio risk"): `riskVolTargetEnabled` (0/1 def 0), `riskVolTarget` (0.10), `riskDdKillEnabled` (0/1 def 0), `riskMaxDdFraction` (0.25). Env `RISK_VOL_TARGET_ENABLED`/`RISK_VOL_TARGET`/`RISK_DD_KILL_ENABLED`/`RISK_MAX_DD_FRACTION`.

---

## 4. Maradó (follow-up — sprints.md B49)

- **HL + portfólió-szint:** jelenleg per-bot (crypto). A discovery portfólió-szintű overlay-t kért — a kombinált equity-görbe (a #9 ENB-vel közös „align per-bot PnL to a common daily series" előfeltétel) kell hozzá.
- **DD-kill = B33 elvi fix:** a peak-equity stop principled változata a bruttó odométer helyett; a B33-at ez kiválthatja (a sessionLossLimit gross → peak-DD).
- **Vol-target per-tick realizált vol** finomítás (jelenleg per-trade pnl%-szórás).
