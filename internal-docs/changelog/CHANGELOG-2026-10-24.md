# CHANGELOG — 2026-10-24

## B80 — Forex offline teszt: FX-prémiumok + gépiesített Spártai módszer → mind FAIL

User-kérdés: lehet-e forex botot építeni (nyílt forrású stratégia, a Spartan Trader / Nikos Mermigas módszer). Döntés: előbb offline, előre regisztrált teszt, infrastruktúra csak pozitív eredmény után. Élő rendszer, knob, box: **nem változott**.

### Mi készült

- [`packages/core/src/fx-backtest.mts`](../../packages/core/src/fx-backtest.mts) (pure): havonta újrasúlyozott több-devizás portfólió (oldalankénti költség + éves swap-felár a bruttó kitettségen), ex-ante vol-skálázás, gépiesített Spártai EMA-36 pullback-bounce szimulátor (belépés a következő nyitón, stop-first, gap a nyitón), hozam-statisztika.
- [`packages/core/src/fx-backtest.test.mts`](../../packages/core/src/fx-backtest.test.mts): a no-lookahead szerződés (pozitív kontroll: csak a jövőbe nézés nyer; a becsületes momentum alternáló soron veszít), költség/carry/felár elszámolás, Spártai cél / stop-first / gap.
- [`scripts/eval-fx-premia.mts`](../../scripts/eval-fx-premia.mts): lokálisan fut (`npx tsx scripts/eval-fx-premia.mts`); FRED H.10 + OECD 3 havi kamat + Yahoo napi OHLC; ítélet, költség-érzékenység, kontrollok. `.mts`, mert a tsx a gyökér `package.json` alatt a `.ts`-t CJS-ként fordítja (top-level await hiba).

### Eredmény

Az előregisztráció, a számok és a döntés: → Backlog **B80** ([`sprints.md`](../roadmap/sprints.md)). Röviden: 2013 óta egyik stratégia sem pozitív a költségek után (Sharpe −0,22 … −1,27), és költség nélkül sem lépi át a szerencse-sávot; nincs forex pillér.

### Csapda (tartós szabályként rögzítve)

A Yahoo chart API `range=max&interval=1d` csendben havi gyertyát ad vissza; az első futásban emiatt a Spártai szabály havi bárokon futott. Javítva, és a szabály bekerült a [`.claude/rules/prediction-ledger-measurement.md`](../../.claude/rules/prediction-ledger-measurement.md)-be.

Kapu: `tsc` exit 0 · **59/59** teszt · build zöld.

## 2026-10-25 kiegészítés — B80 6. trial: SWITCH (stratégia-váltogatás)

User-kérdés: nem lehet-e időszakosan mindig a jól menő stratégiára váltani. Előre regisztrálva (→ Backlog B80), a scriptben `SWITCH` sorként: havonta a záró 252 napon legjobb láb fut, ha az is ≤ 0, akkor készpénz. **2013–: Sharpe −0,37, FAIL**; költség nélkül −0,02. N = 6-ra emelve, a többi ítélet változatlan.
