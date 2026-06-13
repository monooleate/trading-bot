# CHANGELOG 2026-06-14

## Crypto bot: trade-history audit + flip-analízis + jel-szintű diagnózis + `cond_prob` strike-fix (B27) + reset

A user kérte a `/trade/crypto/` ellenőrzését azzal a felvetéssel, hogy „itt tényleg az
ellenkezőjére kellene fogadni". Az audit + flip-elemzés + jel-szintű diagnózis után
kiderült, hogy **nem a flip a megoldás**, hanem egy konkrét jel-bug — ezt javítottuk.

### 1. Validáció (playbook)

- 12 closed trade, **valódi** (nem mock). PnL **bit-pontosan reprodukálható** a
  `applySettlementFee` modellel (`notional = max(proceeds, costBasis)`,
  `pnl = (proceeds − costBasis) − notional × 0.036`): reprodukált total −$120.38,
  eltérés a rögzítettől **+0.000**.
- Bankroll rekonciliál: $350 start − $120.38 PnL − ~$38 (3 open) = $191.57.
- Teljesítmény: **17% WR (2/12), evGap −$234, payoffRatio 2.07, maxDD 80%.**

### 2. Flip-analízis (azonos tét, ellentétes oldal)

A `parseThresholdK`/entry-konvenció szerint az ellentétes oldal belépő ára `1.02 −
entry` (mindkét irányban, a +0.01 slippage miatt). Eredmény:

| | WR | Total PnL |
|---|----|-----------|
| Tényleges | 17% (2/12) | −$120.38 |
| Flip (fade) | 83% (10/12) | **+$80.57** |

**DE ez regime-műtermék, nem stabil anti-edge** — lásd a diagnózist.

### 3. Jel-szintű diagnózis (a 3 nyitott pozíció befagyasztott snapshotja + friss combiner-hívás)

- **A modell MOST bullish**, az emelkedéssel összhangban: above-66k jún-15 finalProb
  0.272 vs market 0.105; jún-16 0.374 vs 0.185 (mindkettő YES). A 12 veszteség jún-8…13-ra
  esik, amikor bearish/counter-trend bets vesztettek a BTC 60k→64.5k emelkedésében.
  **→ a flip a múltbeli rossz hetet fordítaná meg, miközben a modell ma a helyes oldalon
  áll (a weather-csapda).**
- **`vol_divergence` MOST K-aware és működik**: friss detail `strikeSource:"slug-threshold",
  S=64450, K=66000, fairYes=0.396, marketYes=0.195` → a B21 K-anchoring harap. Nem ez a hibás.
- **`cond_prob` instabil, bearish-re telít**: mind a 3 snapshot `cond_prob = 0.200`
  (= −0.3 cap), friss hívás 0.5 (`monotonicity: "ok"`). Gyökérok: a related-piac
  monotonicity-check **kulcsszó alapján** húzott be piacokat strike-szűrés nélkül →
  KÜLÖNBÖZŐ strike-okat hasonlított, hamis violation-ökkel a bearish cap-re telítve a
  jelet (~0.17 combiner-súly). **Ez a fő javítandó.**
- **Low-confidence trade-ek átcsúsznak**: mind WATCH / LOW IR, mégis trade-elnek (a WATCH
  csak SKIP-en vétóz; az edge a 20%-os extrém-edge-veto alatt ül). → fix B (backlog).

### 4. Fix B27 — `cond_prob` cross-strike contamination

[`signal-combiner.mts`](../../netlify/functions/signal-combiner.mts) `getCondProbSignal`:

```diff
- const q = market.question.toLowerCase();
- const keywords = q.split(/\s+/).filter(w => w.length > 3).slice(0, 3);
- if (keywords.length > 0) {
+ const selfK = parseThresholdK(market.slug);
+ if (selfK !== null) {
      ...
      const related = all.filter((m) => {
        if (m.slug === market.slug) return false;
-       const mq = (m.question || "").toLowerCase();
-       return keywords.some(kw => mq.includes(kw));
+       return parseThresholdK(m.slug) === selfK;  // SAME strike only
      });
```

- A monotonicity-invariáns (`P(YES korábbi) ≤ P(YES későbbi)`) csak **azonos strike,
  eltérő deadline** piacokra érvényes — most ezt is kényszerítjük.
- Non-threshold (up-or-down) piacon a monotonicity-ág **kimarad** (nincs strike-család →
  cond_prob a complement-checkre esik vissza, ~0.5 neutrális).
- A `detail` mostantól kiírja a `strike` + `same_strike_related` mezőt → live-verifikálható.
- `npx tsc --noEmit` + `npm run build` zöld. (A `getCondProbSignal` network-bound és nem
  exportált → unit-teszt helyett deploy utáni live-verifikáció.)

### 5. Operátor-akció — crypto session RESET

A B27 deploy után a user kérésére a crypto session **tiszta lapra** állítva (auth-olt API,
`{action:"reset",category:"crypto",bankroll:350}`), hogy a friss adat már a javított
cond_prob-bal gyűljön. A 12 (bug-szennyezett) trade + a rájuk épült kalibráció törölve.

### Következtetés / ajánlás

- **Ne legyen blind reverse-toggle a cryptón** (a dokumentált anti-pattern, 2026-06-04;
  + a weather B22 friss bizonyítéka, hogy a flip kifelé visszaüt). A 17% WR nem stabil
  anti-edge, hanem rossz hét + a cond_prob telítődése.
- A principled fix a cond_prob (B27, kész). Másodlagos: a WATCH/LOW-IR kapu szigorítása
  (fix B → sprints.md B27 backlog-jegyzet).
- **n=12 + 1 hét** túl kevés strukturális következtetéshez — a javított K-aware modellt
  hagyni kell futni.
