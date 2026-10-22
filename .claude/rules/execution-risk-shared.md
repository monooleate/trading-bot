---
paths:
  - "services/worker/src/pillars/shared/**"
  - "services/worker/src/pillars/*/decision-engine.mts"
  - "services/worker/src/pillars/*/paper-resolver.mts"
  - "services/worker/src/pillars/crypto/execution.mts"
  - "services/worker/src/pillars/crypto/session-manager.mts"
  - "packages/core/src/fill-model*.mts"
  - "packages/core/src/risk-overlay*.mts"
  - "packages/core/src/portfolio-exposure*.mts"
  - "packages/core/src/executable-edge*.mts"
  - "packages/core/src/types.mts"
  - "services/api/src/routes/auto-trader-api.mts"
  - "services/api/src/routes/multi-status.mts"
---

# Közös végrehajtás, kockázat, gate-ek (minden pillér)

- Gate-list minta minden decision-engine-en: `gates: DecisionGate[]` non-short-circuit (`{label, passed, actual, required, hint}`), `shouldTrade = gates.every(g => g.passed)`; az early-exit ágak is padded listát adnak (`pad*Gates(evaluated)`, pl. `padCryptoGates`). Új gate = új címke a bot `*_GATE_LABELS` listájában (`CRYPTO_`/`WEATHER_`/`HL_`/`ARB_`) + padding.
- Paper PnL kizárólag valós Polymarket-rezolúcióból (Gamma `&closed=true`) — szimulált rezolúció (a régi simV3 Brownian-bridge) TILOS. Paper fee: 3,6% roundtrip (`applySettlementFee`), fill-modell módban csak kilépési díj.
- Fill-modell (`fillModelEnabled`): a `placeBuyOrder` `fillOpts` OFF → bit-azonos legacy; ON → ask-book walk + participáció-cap + VWAP, min-size alatt REJECTED, és a paper-resolver CSAK exit-fee-t számol (`settlementFeePctFillModel` 0,015) — a belépő slippage már a VWAP-ban van, ne számold duplán.
- Vol-target (`riskVolTargetEnabled`) a tőke per-trade hozamán: `equityReturnsFromTrades`, `maxMult 1`. A trade saját `pnlPct`-jének szórása binárisnál ~1+, a szorzó így mindig 0,25-re esett → minden megbízás min-size alá (B75).
- Minden `DECISION_TRADE` közvetlenül a megbízás előtt logol, és `ORDER_PLACED` vagy `ORDER_REJECTED` követi; a kötés nélküli döntés-sorozat `NO_FILL_WATCHDOG`-ot ad. Ezt a láncot ne bontsd meg (68 döntés / 0 kötés két hétig észrevétlen volt).
- Telegram (`shared/telegram.mts`): üres `TELEGRAM_BOT_TOKEN` mellett minden `alert*` némán elnyelődik (a boxon 2026-09-28-án üres volt) → monitoringot nem építhetsz rá.
- Crypto-béta cap (`betaCapEnabled`, `betaCapFraction` 0,25): crypto + HL együtt, fail-open; F-Arb (delta-neutrális) és weather kizárva; a saját bot intra-tick nyitásai is számítanak. Mellette a lejárati-ablak cap (`cryptoWindowCapEnabled`, B38, default OFF, csak crypto): az azonos ±H ablakban lejáró pozíciók egy korrelált fogadás; visszamérve nyerőket blokkolt volna → élesítés csak mérés után.
- Cross-position kapuk mind az 5 boton (crypto monotonicitás + outcome-overlap, weather Σ P(YES) ≤ 1 egy (város, dátum)-on, HL no LONG+SHORT ugyanarra a coinra, F-Arb coin-capacity, sports outcome-sum `eventSlug`-on) — új bot is kapjon ilyet.
- Live-readiness: `liveReadyOverrideEnabled` master-bypass (Telegram alarm session-enként 1×) — guardrail, sosem javaslat- vagy tuning-tárgy; `PAPER_MODE=true` marad, a live-flip B10-blokkolt.
- `paperNeverStop` (`shared/paper-never-stop.mts`) csak AUTO-stopot old; manuális stop tartós. `resumeSession`/`resumeHlSession` a gross-loss odométert is nullázza (B29).
- Topup (`topup` action) bankrollt injektál reset nélkül — a closedTrades, IC-kalibráció és nyitott pozíciók megmaradnak; reset helyett ezt ajánld, ha a paper-tőke elfogy.
- Új bot (registry-native): `services/worker/src/pillars/<bot>/index.mts` top-level `registerBot(...)` + import a `registry-bootstrap.mts`-be + payload a `services/worker/src/main.ts` `payloadsFor`-ban + ág a `multi-status.mts`-ben (crypto/weather/HL/F-Arb még a legacy dispatcher-ágon fut).
