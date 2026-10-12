---
paths:
  - "services/worker/src/pillars/sports/**"
  - "services/worker/src/pillars/shared/sports-loss-limit-topup.test.mts"
  - "packages/core/src/devig*.mts"
  - "scripts/eval-devig.ts"
  - "apps/web/src/components/trader/SportsTrader.tsx"
---

# Sports bot

- A sports fair value fabrikált: `predicted = 0.5 + 0.55·(yesPrice − 0.5)` — annak az árnak a determinisztikus transzformációja, ami ellen fogad (0 külső adatforrás) → minden belépő longshot. A bot MANUÁLISAN leállítva marad (95. session) a B37-ig: the-odds-api (`ODDS_API_KEY`, region=eu → Pinnacle) + Polymarket↔Pinnacle event-matching → `pinnacleFairYes` Shin de-viggel (`devigShin`, `sportsUsePinnacle`).
- Két session egyszer ellentétesen döntött a sports futásáról → policy-változást a CLAUDE.md „Aktuális állapot"-ában és a drift-checkben is rögzíts.
- A `stopped` ágon a settlement a stop- és cron-kapu ELŐTT fut, különben a leállítás bennragasztja a nyitott pozíciókat.
- Tartós stop: manuális `stop` (`stoppedReason="Manual stop"`, a `paperNeverStop` sosem oldja) + `sportsCronEnabled=0` (reset és séma-bump nem törli).
- Ledger-sor minden ágon (skip is): `endDate` + irány-agnosztikus `yesProb` + `marketPrice` — nélkülük a `reconcileLedger("sports")` nem fut és a ledger taken-only lesz; NO-trade-nél P(YES)-t logolj, ne P(chosen)-t.
- A sports ki van zárva a cross-bot aggregátumból (`AGGREGATE_EXCLUDED`) — B37 után visszavonandó.
- Bankroll-invariáns: `bankroll_start + session_pnl − nyitott pozíciók cost_basis = bankroll_current` (B70). Ismert, nem hiba: a `pillar_session.trade_count` sportsnál 0 marad.
- `sportsMinPrice` (0,05) longshot-floor; `sessionLossLimitEnabled` paperben OFF, live-ban ON.
