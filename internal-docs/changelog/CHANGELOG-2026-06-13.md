# CHANGELOG 2026-06-13

## Weather invert-mode (B22) sizing bug — minden inverted trade $0 PnL-lel zárt

### Tünet (user-bejelentés)

A user korábban élesítette a weather bot `weatherInvertDirection` toggle-ját (B22 —
„nyiss mindig az ellentétes oldalon"), és azt jelezte, hogy **a P&L-t rosszul
számolja ebben a módban**. Élő edge-tracker pull (`/.netlify/functions/edge-tracker?category=weather`):

- **9 closed invert-trade**, mind `shares: 0`, `pnl: 0`, `pnlPct: null`.
- Summary: `wins: 0, losses: 9, winRate: 0, totalPnl: 0`.
- **Két trade ténylegesen nyert** (Shenzhen NO `exitPrice:1`, Seoul-jún-10 YES
  `exitPrice:1`), mégis $0 PnL → „losses"-ként számolva.
- A 9 direction mind anti-edge (a recorded `edgeAtEntry` előjele igazolta, hogy a
  flip aktív volt).

### Gyökérok

A B22 invert-implementáció a Kelly `probSide`/`priceSide`-ot **a flippelt oldalon**
számolta ([`weather/decision-engine.mts`](../../netlify/functions/auto-trader/weather/decision-engine.mts)).
A flippelt oldal a modell szerint sub-fair-value (a flip pont a modell anti-edge
oldalára fogad), így:

```
rawKelly = max(0, (probSide·b − (1−probSide)) / b)   // probSide < priceSide ⇒ a számláló < 0
         = max(0, negatív) = 0
```

→ `kellyFraction = 0` → `positionSizeUSDC = Math.min(bankroll·0, maxPositionUSD) = 0`
→ `placeBuyOrder` paper-fill `filledShares = sizeUSDC/price = 0`, `costBasis = 0`
→ a [`weather/reconciler.mts`](../../netlify/functions/auto-trader/weather/reconciler.mts)
záráskor `pnl = shares·exitPrice − costBasis = 0·exit − 0 = 0` **minden** kimenetelre.

A win/loss tally downstream is romlott: a `computeSummary` `wins = pnl > 0` szerint
számol, így a 2 valós nyerő bucket is `losses`-ba esett (`pnl === 0`, nem `> 0`).

A non-invert path soha nem szenvedett ettől: ott `direction === baseDirection`, a
+edge oldalon a Kelly pozitív → valós méret (a reset előtti −$87.88/11tr történet
ezért tartalmazott valós dollár-PnL-t).

### Fix

[`weather/decision-engine.mts`](../../netlify/functions/auto-trader/weather/decision-engine.mts) —
a Kelly `probSide`/`priceSide` mostantól a **`baseDirection`** (modell-preferált,
mindig +edge) oldalon méretez, nem a végrehajtott (esetleg flippelt) `direction`-on:

```diff
- const probSide  = direction === "YES" ? probYes : 1 - probYes;
- const priceSide = direction === "YES" ? bucketPrice : 1 - bucketPrice;
+ const probSide  = baseDirection === "YES" ? probYes : 1 - probYes;
+ const priceSide = baseDirection === "YES" ? bucketPrice : 1 - bucketPrice;
```

- `baseDirection` definíció szerint a +edge oldal (`probSide > priceSide`) → `rawKelly > 0`
  garantált, ha van edge → az inverted trade **valós méretet** kap.
- Az invert így egy **azonos méretű tükörfogadás** a modell természetes tétjéhez
  képest — pontosan az apples-to-apples forgatókönyv, amit a 2026-06-04/06-06
  flip-audit mért (azonos $ tét az ellenkező oldalon).
- A `direction`/entry-price/tokenId/cross-position gate továbbra is a flippelt
  oldalon fut (a végrehajtás az ellentétes oldalon történik). Csak a **méret-számítás**
  hivatkozik a `baseDirection`-ra.
- **`invertDirection=OFF` esetén `baseDirection === direction` → szigorú no-op**
  (a normál weather path bit-azonos marad).

A `match.edge === probability − currentPrice` invariáns ([`bucket-matcher.mts:182`](../../netlify/functions/auto-trader/weather/bucket-matcher.mts))
garantálja, hogy `baseDirection` (a `match.edge` előjeléből) tényleg a +prob-edge oldal.

### Teszt

[`shared/adverse-selection-fixes.test.mts`](../../netlify/functions/auto-trader/shared/adverse-selection-fixes.test.mts) —
2 új sizing-case a meglévő 2 B22 direction-case mellé:

- `b22.flipNonZeroSize` — base YES ⇒ flip NO esetén `positionSizeUSDC > 0`.
- `b22.flipMirrorSize` — a flip mérete megegyezik a base mérettel (mindkettő a
  `baseDirection`-on méretez).
- `b22.flipYesNonZeroSize` — base NO ⇒ flip YES (self-consistent fixture,
  `probYes 0.30 < price 0.50`) szintén `> 0`.

`npx tsx adverse-selection-fixes.test.mts` (10 case) + `cross-position-gates.test.mts`
+ `npx tsc --noEmit` + `npm run build` mind zöld.

### Élesítés + utóhatás

- Deploy: push `main` → Netlify CD. A fix csak **új** trade-eket érint.
- A 9 meglévő $0-méretű junk-trade a weather paper-sessionben marad, és torzítja a
  statisztikát (0% WR, $0 PnL). Tiszta invert-adat gyűjtéséhez **a weather session
  reset ajánlott** (auth-olt API, operátor-credential kell) — a fix után minden
  invert-trade valós méretet és valós W/L PnL-t kap.

### Maradó (analytics-only, NEM a bejelentett bug)

- A pozíció `predictedProb` mezője inverted trade-en is a **YES-oldali** modell-prob
  marad (a NO bet „nyerési valószínűsége" ennek a komplementere lenne). Ez csak a
  calibration-chart bucket-besorolását érinti, a W/L PnL-t nem. A cross-position gate
  `match.probability`-re (YES-oldal) támaszkodik, ezért nem nyúltunk hozzá ebben a
  fixben. → ha az invert-adat érdemivé válik, külön follow-up (sprints.md alá).
