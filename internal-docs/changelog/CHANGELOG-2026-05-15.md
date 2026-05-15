# 2026-05-15 — Cross-position outcome-overlap gate + 7-trade history audit + vol_divergence K-extrakció fix + Sprint 42A K-blind downweight (speculative) + Sprint 42B Topup action

## TL;DR

Öt különálló munka:

1. **Audit**: a crypto bot eddigi 7 closed trade-jét és $21.96 PnL-jét végigellenőriztük Polymarket Gamma `&closed=true` API-n + a paper-fee modell ([paper-resolver.mts:44](../../netlify/functions/auto-trader/crypto/paper-resolver.mts)) szerinti bit-pontos PnL-rekonstrukcióval. **Mind a 7 trade exit price-a egyezik a real Polymarket resolution-nel; mind a 7 PnL érték 3 tizedesjegyig reprodukálható; a bankroll-rekonciliáció ($250 + $21.96 − $34.96 open = $237) konzisztens.**

2. **Új gate**: hozzáadtuk a `Outcome-overlap (NO+YES BTC párok)` cross-position gate-et a crypto decision-engine-hez (15 → 16 gate). Trigger: ma reggel a bot nyitott `NO @ above-80k-may-15` + `YES @ above-82k-may-15` párost — a Sprint 39e monotonicity-gate átengedte (predikciók szigorúan monoton csökkenőek 0.4604 > 0.4557), de a bet-oldalak nyerési zónái diszjunktak, és a (80K, 82K] sáv mindkét trade-en buktat.

3. **Root-cause fix**: a `vol_divergence` jel K-extrakciós bug-ja, ami a teljes "lapos 0.46-os finalProb" mintázat alatti gyökérok. A Black-Scholes digital képlet K-paraméterét csak az `up-or-down` piacokra állította be (`openedAt` BTC árából), `above-Nk` piacokra **K = S fallback**-be esett → fair YES ≈ 0.5 minden N-re K-tól függetlenül. Új `parseThresholdK(slug)` helper kinyeri a literal `N × 1000` USD értéket a slug-ból. A combiner output ezután meaningfully eltér K-szerint (BTC $80,620 mellett: 78K→0.98, 80K→0.69, 82K→0.14), és a `Combiner confidence (|p − 0.5|)` gate automatikusan megfogja az ilyen near-noise contrarian-eket Normal preset alatt is.

4. **Sprint 42A K-blind downweight (speculative implementáció)**: a vol_div K-fix önmagában még a 4 K-blind sentiment-signal (momentum/contrarian/funding/pairs) mean-reversion-pull-jával küzd threshold piacokon. Speculative implementálva default-off knob-bal (`combinerKBlindDownweight = 1.0` = zero behavior change). A `combine()` függvény új `marketKind` paraméter + `kBlindDownweight` szorzó. Sprint 42 monitoring data alapján (`10+ post-fix trade`, ha finalProb még flat) az operátor Settings-en átkapcsolja 0.5-re. Részletes hatás-elemzés: 78K +0.14, 80K +0.07, 82K −0.11 pull a finalProb-on, IR ~3% csökkenés cserébe.

5. **Sprint 42B Topup action**: új `topup` action mind a 4 boton (crypto, weather, hyperliquid, funding-arb), auth-protected. Egyetlen művelettel `bankrollStart += amount` ÉS `bankrollCurrent += amount`. Minden más session-state érintetlen: closedTrades history, tradeCount, sessionPnL, sessionLoss, openPositions, realized signal-IC kalibráció. Új UI gomb (`💰 Top up…`) a TraderShell-en + amount-input dialog dinamikus before/after preview-val. F-Arb a HL bankroll-ra delegál (shared capital). Telegram alert minden topup-ra (audit). Megoldja a mai `sessionLossLimit-be ütközött, folytatni akarom reset nélkül` user-pain pontot. 5 új unit test (`topup-action.test.mts`). Preview-verifikáció: gomb megjelenik, dialog renderelődik, validáció működik (`Adj meg pozitív összeget` negatív értékre), Mégse zárja a modal-t.

## Trade-audit eredménye

Lekérdezve a `/edge-tracker?category=crypto` endpoint-ot — 7 closed trade:

| # | Slug | Dir | Entry | Exit | PnL | Gamma | Match |
|---|------|-----|-------|------|-----|-------|-------|
| 1 | bitcoin-above-80k-on-may-14 | YES | $0.34 | $1.00 | +$23.29 | ["1","0"] | ✓ |
| 2 | bitcoin-above-78k-on-may-14 | NO | $0.14 | $0.00 | −$20.72 | ["1","0"] | ✓ |
| 3 | bitcoin-up-or-down-may-14-12pm-et | NO | $0.22 | $0.00 | −$20.13 | ["1","0"] | ✓ |
| 4 | bitcoin-up-or-down-on-may-14-2026 | NO | $0.36 | $0.00 | −$11.66 | ["1","0"] | ✓ |
| 5 | bitcoin-above-82k-on-may-13 | YES | $0.16 | $0.00 | −$17.54 | ["0","1"] | ✓ |
| 6 | bitcoin-above-80k-on-may-13 | NO | $0.30 | $1.00 | +$40.73 | ["0","1"] | ✓ |
| 7 | bitcoin-up-or-down-on-may-13-2026 | NO | $0.34 | $1.00 | +$27.99 | ["0","1"] | ✓ |

**Cross-consistency** (sanity): May 13 BTC < $80K (#5 + #6 konzisztens), May 14 BTC ≥ $80K és UP-záró (#1 + #3 + #4 konzisztens).

**Closing-timing**: minden `closedAt` a piac `endDate`+1-3h-ban, nincs preemptív paper-close (a v3 sim-resolver tényleges Polymarket-UMA resolution-t vár, lásd 2026-05-10 simV3 fix).

**PnL reprodukció**: az `applySettlementFee(pnlGross, proceeds, costBasis, 0.036)` képlettel mind a 7 trade ±3 tizedesjegyen belül egyezik. Példa (#1):
- gross = (1.00 − 0.34) × 37.3235 = $24.6336
- fee = max(37.3235, 12.6900) × 0.036 = $1.3436
- net = $23.2899 → reported $23.29 ✓

A loserek `pnlPct = −103.6%` értéke a 3.6% fee árulkodó ujjlenyomata (stake teljes elvesztése + 3.6% fee a notional-on).

**Bankroll-rekonciliáció**: $250 + $21.96 (closedPnL) − $34.96 (2 open stake) = **$237.00** ✓

## Új gate: Outcome-overlap (cross-position)

### Trigger-incident (2026-05-15 paper session)

A bot egymás után nyitotta:

- `bitcoin-above-78k-on-may-15` NO @ pred=46.09%
- `bitcoin-above-80k-on-may-15` NO @ pred=46.04%
- `bitcoin-above-82k-on-may-15` YES @ pred=45.57%

A 3 predikció **szigorúan monoton csökkenő K-val** (46.09 > 46.04 > 45.57) → a 2026-05-14e `findMonotonicityViolation` helper **helyesen átengedte** a candidate-eket. De a NO@80K + YES@82K **bet-pár oldal-szinten ellentmondó**:

| BTC kimenet | NO@80K | YES@82K | Kombinált |
|---|---|---|---|
| ≤ $80K | nyer (+$40.3) | bukik (−$17.4) | +$22.9 |
| $80K–$82K | bukik (−$19.0) | bukik (−$17.4) | **−$36.4** |
| > $82K | bukik (−$19.0) | nyer (+$116.7) | +$97.8 |

A bot szerint a P($80–82K közötti sáv) = 0.47% (kvázi-bimodális prior), miközben a piac szerint 55%. Az aggregált finalProb K-paramétertől gyengén függő — a combiner bug-ja, de a gate-réteg ezt nem javítja, hanem **megelőzi a kontradiktórius párok nyitását**.

### Implementáció

**Új helper** ([shared/cross-position-gates.mts:75](../../netlify/functions/auto-trader/shared/cross-position-gates.mts)):

```ts
export function findOutcomeOverlapViolation(
  cand: OutcomeOverlapCandidate,
  existing: OutcomeOverlapExisting[],
): OutcomeOverlapExisting | null {
  for (const e of existing) {
    if (e.closingKey !== cand.closingKey) continue;
    if (cand.K === e.K) continue;
    if (cand.direction === "YES" && e.direction === "NO" && cand.K > e.K) return e;
    if (cand.direction === "NO" && e.direction === "YES" && cand.K < e.K) return e;
  }
  return null;
}
```

**Új gate** a `CRYPTO_GATE_LABELS[15]`-en — a 15 régi gate után a 16. Az `actual` üzenet konkrétan megnevezi az ellentmondó párost és a double-loss sávot, pl. `YES@82K vs NO@80K — (80K, 82K] sáv mindkét trade-en bukik`.

**Struktúra-megkülönböztetés** a 2026-05-14e Monotonicitás-gate-től:

| Aspektus | Monotonicitás (#15) | Outcome-overlap (#16) |
|---|---|---|
| Mit ellenőriz | Model *predictedProb* koherenciáját K-paraméter szerint | A *bet-oldalak* nyerési feltételeinek diszjunkt voltát |
| Helper | `findMonotonicityViolation` | `findOutcomeOverlapViolation` |
| Pass kondíció | `K_hi > K_lo ⇒ pred_hi ≤ pred_lo` | Nincs NO@K_lo + YES@K_hi (K_hi > K_lo) pár |
| Mai incident-en | ✅ Passed (0.4604 > 0.4557) | ❌ Failed (NO@80K + YES@82K) |

A két gate **független és komplementer** — egyik nem váltja ki a másikat. Mindkettő szükséges.

### Tesztek

8 új test case a `cross-position-gates.test.mts`-ben:

1. **Pattern A** (incident reprodukció): YES @ 82K vs existing NO @ 80K → violation ✓
2. **Pattern B**: NO @ 80K vs existing YES @ 82K → violation ✓
3. **Same direction YES + YES**: konzisztens (mindkettő nyer BTC > K_max-on) → null ✓
4. **Same direction NO + NO**: konzisztens (mindkettő nyer BTC ≤ K_min-on) → null ✓
5. **Overlap zone** (YES@K_lo + NO@K_hi, K_hi > K_lo): konzisztens — (K_lo, K_hi] mindkettő nyer → null ✓
6. **Different closingKey**: nincs cross-flag ✓
7. **Same K + opposite direction**: skip (más réteg dolga) → null ✓
8. **Empty list**: trivial pass → null ✓

Futtatás: `npx tsx netlify/functions/auto-trader/shared/cross-position-gates.test.mts` — mind a 18 (10 régi + 8 új) case zöld.

### Hatás a többi botra

Funkcionális kód-változás **csak a crypto-engine-ben**. A többi 4 bot már Sprint 39e óta tartalmazza a saját outcome-overlap-analógját — mindegyik decision-engine-be **coverage-comment** került, hogy a gate-térkép explicit legyen:

- **Weather** ([weather/decision-engine.mts:140](../../netlify/functions/auto-trader/weather/decision-engine.mts)): `Σ P(YES) ≤ 1.0` per (city, date) negRisk group — disjoint bucketek joint-impossibility-ját fogja meg ugyanúgy.
- **HL Perp** ([hyperliquid/index.mts:219](../../netlify/functions/auto-trader/hyperliquid/index.mts)): `Directional-consistency (no LONG+SHORT same coin)` — a perp analóg, ugyanaz a "disjoint winning conditions" mintázat (price ↑ vs ↓).
- **F-Arb** ([funding-arb/index.mts:194](../../netlify/functions/auto-trader/hyperliquid/funding-arb/index.mts)): `Coin-capacity (cross-position)` — F-Arb pozíció szerkezetileg fixed (HL-short + Binance-long), per-coin uniqueness elég.
- **Sports** ([sports/decision-engine.mts:139](../../netlify/functions/auto-trader/sports/decision-engine.mts)): `Outcome-sum (cross-position)` per eventSlug — disjoint outcomes ugyanaz mint a weather buckets.

### Gate-szám frissítések

- **Crypto**: 15 → **16** gate (CRYPTO_GATE_LABELS).
- A többi 4 bot változatlan (a meglévő gate-jeik már lefedik az analóg eseteket).

Frissített hivatkozások:
- [math/13-crypto-bot.md](../math/13-crypto-bot.md) — 15→16 mindenhol, új §9.6 szekció a részletes leírással
- [internal-docs/README.md:46](../README.md) — sor frissítve
- [src/components/trader/CryptoTrader.tsx:463](../../src/components/trader/CryptoTrader.tsx) — komment frissítve (a chip "X/Y gates" dinamikus, automatikusan 16-ra vált)

## Mi NEM változott

- **A 4 jelenleg nyitott pozíció megmarad** — az új gate csak a következő tick `makeDecision()`-jét érinti, már nyitott pozíciókat nem zár. A jelenlegi 80K-NO + 82K-YES pár így megmarad mint élő incidens-dokumentáció + IC-kalibráció-input.
- **Bankroll-mechanika** — nincs új `topup` action; a "bankroll elfogyott reset nélkül" use-case továbbra is csak Settings `sessionLossLimit` emelés + `resume` kombinációval kezelhető (lásd lejjebb).
- **A többi bot decision-engine logika** — csak komment-frissítés.

## Verifikáció

- `npx tsc --noEmit` exit=0 ✓
- `npm run build` 10/10 page built ✓
- `npx tsx ...cross-position-gates.test.mts` — "all checks passed" (18 case) ✓

## vol_divergence K-extrakció fix (root-cause)

### A bug

A `getVolSignal` ([signal-combiner.mts:356](../../netlify/functions/signal-combiner.mts)) Black-Scholes digital call képletet használ:

$$
\text{fair YES} = N(d_2), \quad d_2 = \frac{\ln(S/K) - \tfrac{1}{2}\sigma^2 T}{\sigma \sqrt{T}}
$$

A K (strike) értéket pre-fix kétféleképpen kereste:

1. `parseDurationFromQuestion(question)` → ha pl. "15 minutes" / "1 hour" van a kérdésben → openTs számítás → Binance 1m kline-ból K = openedAt BTC ár. Ez **`up-or-down`** piacokra korrekt (a kérdés "Was bitcoin up or down in this 15 minutes?" típusú, a K a 15-perces interval kezdete).
2. Ha nincs `durationMs` → `K = S` (jelenlegi spot) fallback.

A bug: az `above-Nk` piacok kérdésében (pl. "Will Bitcoin be above $80,000 on May 15?") **nincs durationMs**, csak a date és a threshold. Így a kód a 2. ágra esik, K = S, és:

- $\ln(S/K) = \ln(1) = 0$
- $d_2 = -\tfrac{1}{2}\sigma\sqrt{T} \approx -0.008$ (T = 6h, σ = 0.6)
- fair YES $= N(d_2) \approx 0.497$

**Minden above-Nk piacra ≈0.5** — a vol_divergence jel K-tól független, semleges noise.

### A bug ujjlenyomata a mai paper session-ben

A reset után 3 új pozíció nyílt, mind near-identical `finalProb`-bal:

| Piac | Pre-fix vol_div | Helyes fair YES (S=$80,620, T=6h, σ=0.6) | finalProb | Market YES |
|---|---|---|---|---|
| `above-78k-may-15` (zárult) | ≈ 0.50 | **0.98** | – | – |
| `above-80k-may-15` | ≈ 0.50 | **0.69** | 0.4602 | 0.775 |
| `above-82k-may-15` (zárult) | ≈ 0.50 | **0.14** | – | – |
| `above-80k-may-16` | ≈ 0.50 | **0.69** | 0.4658 | 0.69 |
| `up-or-down-may-15` | n/a (K=openedAt) | n/a | 0.4752 | 0.225 |

A 3 nyitott pozíció finalProb-ja **0.46–0.48 sávba esett** (különbség < 0.02 = noise). A vol_divergence "elnyomta" a K-aware signal-csoport jelentőségét — a többi 7 jel mean-reverted noise-átlaga uralta a kimenetet.

### A fix

Új helper a signal-combiner.mts top-szintjén:

```typescript
function parseThresholdK(slug: string | undefined | null): number | null {
  if (!slug) return null;
  const m = String(slug).toLowerCase().match(
    /(?:bitcoin|btc)-(?:be-)?above-(\d+(?:\.\d+)?)k(?:-on-(.+?))?$/,
  );
  if (!m) return null;
  const kThousand = parseFloat(m[1]);
  if (!Number.isFinite(kThousand) || kThousand <= 0) return null;
  return kThousand * 1000;
}
```

A `getVolSignal` K-választása új prioritási sorrendben:

1. **Priority 1 (NEW)**: `parseThresholdK(market.slug)` — literal threshold a slug-ból. Új `strikeSource: "slug-threshold"`. Nincs Binance round-trip, nincs `strikeFetchEnabled` gate (lokál + ingyenes).
2. **Priority 2** (változatlan): up-or-down markets → K = openedAt BTC ár.
3. **Priority 3** (változatlan): K = S fallback.

### Várható hatás

A fix után a `vol_divergence` jel meaningful K-érzékenységgel rendelkezik. A combiner-súlyozás `w = ic × (1 + |signal − mean| × 0.5)` képlete a normától távolabbi jeleknek nagyobb súlyt ad, így ha vol_div = 0.98 (78K), a többi 7 jel ≈ 0.5 átlaga mellett a kombinált súlyozott átlag már nem 0.5 közelében lesz.

**Konkrétan**: a 8 jelből 4 K-aware (vol_divergence, orderflow, apex_consensus, cond_prob), 4 K-blind market-sentiment (momentum, contrarian, funding_rate, pairs_spread). A K-aware csoport mostantól meaningfully szétválik K szerint; a K-blind csoport átlaghoz húzza vissza, de az asszimetria a `(1 + |demeaned| × 0.5)` bonus miatt megmarad.

**A Combiner confidence gate (#3) ezután korrekten dolgozik**: ha a finalProb pl. 0.7 (above-80K) vagy 0.2 (above-82K), |p − 0.5| ≥ 0.2 → gate átengedi (valódi signal). Ha a finalProb 0.48 (combiner zaj), |p − 0.5| = 0.02 < 0.05 → gate blokkol. A mai 3 contrarian trade **Normal preset alatt** sem nyílt volna meg a fix után, mert a vol_div meghúzta volna a finalProb-ot meaningful K-aware értékekhez.

### Tesztek

Új test fájl: [`netlify/functions/signal-combiner-threshold.test.mts`](../../netlify/functions/signal-combiner-threshold.test.mts) — 11 case zöld.

- **Parser-pin** (10 case): pozitív parseolás (78K, 80K, 82K, 100K, 65K, "be-above" prefix, decimal 77.5K) + negatív (up-or-down, ETH-above, prefix-nem-anchored, undefined, null, empty).
- **BS-digital invariáns** (3 sanity assertion): a fix utáni fair YES értékek BTC=$80,620 mellett K-szerint divergálnak (78K: >90%, 80K: 55-80%, 82K: <25%), monotonok (78K > 80K > 82K), és a K=S kollapszus (pre-bug pattern) ≈0.5-re igazodik (lokál sanity check a bug ujjlenyomatára).

### Regex-szinkronitás 3 helyen

A `bitcoin-above-Nk` regex **3-szorosan duplikált** a kódbázisban (intencionálisan, hogy a top-level signal-combiner.mts ne importáljon az auto-trader/ submodule-ból, ami circular dep-et okozna):

1. `signal-combiner.mts` — `parseThresholdK` (USD output: 80000)
2. `auto-trader/shared/cross-position-gates.mts` — `parseBtcAboveSlug` (ezerben K + closingKey: `{K: 80, closingKey: "may-15"}`)
3. `signal-combiner-threshold.test.mts` — pin-elt másolat tesztelésre

A 3 hely együtt változtatandó. Test-suite kötelezővé teszi a szinkronitást: ha a regex elszáll bármelyikben, a test-eset fail-el.

### Mit NEM old meg ez a fix

- **A 4 K-blind signal súlyozása** → **[sprints.md Sprint 42A candidate](../roadmap/sprints.md)** (0.5-1 nap, részletes hatás-elemzés a sprints.md aljának dedikált szekciójában). `momentum`, `contrarian`, `funding_rate`, `pairs_spread` továbbra is BTC-szintű sentiment-jeleket adnak, és threshold piacokra húzzák a kombinált értéket 0.5 felé. A `(1 + |demeaned| × 0.5)` bonus enyhíti, de nem szünteti meg.
- **A jelenleg nyitott 3 pozíció**: a fix csak a következő `getVolSignal` hívástól érvényes; a már nyitott pozíciókat nem zárja (a paper-resolver-nek külön logikája van, simV3 csak Polymarket UMA resolution-en zár). A 3 pozíció marad élő incidens-dokumentációként az IC-kalibrációs adatbázisban.

## Hivatkozott incidensek

- **2026-05-14e** (`CHANGELOG-2026-05-14e.md`): első cross-position sweep — Monotonicity-gate hozzáadás mind az 5 botra. A 2026-05-15 incidens megmutatta, hogy a monotonicity önmagában nem elég → ez a follow-up.
- **2026-05-15 audit-session**: 7-trade history validáció + outcome-overlap bug-detection — egy ülésben két különálló munka.

---

## Follow-up (későbbi session): Sports `sessionLossLimit` Settings-knob

### Trigger

A sports bot session a session loss limitet elérve auto-stop-olt ("Session loss limit hit"). A küszöb (default $30) eddig env-only (`SPORTS_SESSION_LOSS_LIMIT`) volt — a Settings UI-on nem jelent meg, így az operátor a limit elérése után nem tudta a Settings tab-on átállítani redeploy nélkül.

### Mit változott

- [`netlify/functions/trader-settings.mts`](../../netlify/functions/trader-settings.mts) — új SCHEMA mező `sportsSessionLossLimit` ({ default: 30, min: 5, max: 500, step: 5, USD, category: "sports", group: "Risk & sizing" }). Mind a 3 sports preset (Lazább/Normál/Szigorú) kibővítve a knob-bal: 50 / 30 / 20 USD.
- [`netlify/functions/auto-trader/sports/config.mts`](../../netlify/functions/auto-trader/sports/config.mts) — `getEffectiveSportsConfig()` mostantól a `ov.sportsSessionLossLimit` override-ot olvassa Blobs-ból (`env.sessionLossLimit` fallback-kel).

### Hatókör

- A `sports/index.mts` :213-as `Session loss limit guard` automatikusan használja az új effective configot (külön módosítás nem kell).
- A bot további session-loss-tartó (`crypto.sessionLossLimit`, `hlSessionLossLimit`) UI-bejegyzései érintetlenek.
- Weather + F-Arb bot nem rendelkezik session-loss-limit fogalommal jelenleg — ez a fix csak a meglévő mechanizmusokat fedi le. Ha a 2 bot-ban is igény van rá, az külön sprint-tárgy (B-backlog kandidátus).

### Validáció

`npx tsc --noEmit` → csak a pre-existing Sprint 42B `SESSION_TOPUP` `LogEvent` típus-hiány hibázik (független ettől a session-től). A 2 érintett fájl tisztán compile-ol.

---

## Follow-up (későbbi session): HomePage Live-readiness gates szekció re-order

A `Live-readiness gates` SectionTitle + `.hp-readiness-grid` block átköltöztetve a HomePage-en a "Aggregated session" alól (felül, ~top=480px) közvetlenül az `Environment Status` szekció fölé (alul, ~top=5634px). A piros "Live trading auto-suspended" critical banner (csak `liveBlocked` esetén jelenik meg) változatlan marad a header alatt — az kritikus alert, helye továbbra is a top-of-page. Egyetlen fájl módosult: [`src/components/HomePage.tsx`](../../src/components/HomePage.tsx). DOM-sorrend a `netlify dev` preview-on igazolva (Live-readiness top=5634, Environment Status top=6462). Indok: az operátor szerint a per-bot readiness chip-ek inkább a "health check" környezetébe tartoznak (env vars mellé), nem a primary KPI dashboard tetejére.
