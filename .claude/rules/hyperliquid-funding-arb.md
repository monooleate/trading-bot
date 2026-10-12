---
paths:
  - "services/worker/src/pillars/hyperliquid/**"
  - "services/api/src/routes/funding-rates.mts"
  - "services/worker/src/pillars/shared/funding-arb-reverse.test.mts"
  - "services/worker/src/pillars/shared/farb-breakeven.test.mts"
  - "services/worker/src/pillars/shared/hl-consec-loss-recovery.test.mts"
  - "apps/web/src/components/trader/HyperliquidTrader.tsx"
  - "apps/web/src/components/trader/FundingArbPanel.tsx"
---

# Hyperliquid directional perp + Funding-Arb

## HL directional
- `directionalHalt`=1 alatt a teljes HL ág measure-only (nem nyit, de logol).
- Az irány-jel CSAK coinonkénti up-or-down Polymarket-piacból jöhet (`signal-source.mts`); a régi kulcsszó-fallback threshold-piacra esett, és `|p−0,5|×2` hamis 96,9% edge-et gyártott (audit P0-3). Ne vezess vissza kulcsszó-listát.
- Kelly win-prob a driftmentes baseline-hoz horgonyozva: `baseline = 1/(1+RR)` → dirProb 0,5 ⇒ Kelly 0 (B36; `kelly-sizer.test.mts` pineli).
- Consecutive-loss pause: a runner a `clearElapsedConsecutiveLossPause`-t hívja a stopped- és pause-check közt, a `resumeHlSession` a countert is nullázza — különben a számláló csak nyerésen nullázódik → permanens deadlock (Sprint 42G).
- A HL trade PnL-mezője `pnlUSDC` (nem `pnl`) — aki IC-t / kalibrációt / statisztikát olvas, ezt használja (a realized-IC 0,0-ra torzult).
- A béta-capben a HL kitettség margin (`sizeUSDC/leverage`), nem levered notional.
- HL ledger-sor piacra kulcsolva + `reconcileLedger` (a „halhatatlan" sorok ellen). A HL paper mainnet-adatot használ.

## Funding-Arb (`hyperliquid/funding-arb/`)
- Saját bankroll: `ArbSessionState.bankrollStart/bankrollCurrent` (default $200), a realizált funding a `creditArbPnl`-en át; reset/topup a saját tőkét állítja, a HL sessionbe nem ír (Sprint 45).
- Az F-Arb session a `blob_kv` `hyperliquid-arb-session-v1` store-ban él, nem a `pillar_session` táblában; a `positions` tömbben a CLOSED pozíciók is benne maradnak → nyitott = `status = "OPEN"`.
- Bidirekcionális: forward = HL-short + Binance-long; reverse = HL-long + Binance-short, carry = `−spread`. A reverse **paper-only** (live-ban detektálva + explicit skip), amíg a B20 (Binance futures-short adapter; előfeltétel ≥10 pozitív reverse paper-trade) el nem készül.
- Forward-carry proxy a HL-funding, nem a spread (B31); `frMinSpreadHourly` 0.00005 a nyit-zár churn-sáv ellen.
- Az F-Arb delta-neutrális: kimarad a crypto-béta capből és a prediction-ledgerből (nincs P(YES)).
