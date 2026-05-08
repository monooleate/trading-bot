# Paper PnL Analysis — 2026-04-21 → 2026-05-08

> **TL;DR:** a paper-mode session $150 → $3050 PnL-t mutat (1933% ROI 17 nap alatt) és 98.6% win rate-et. Ez a szám **nem realisztikus** és **nem extrapolálható élesre**. A paper szimulátor struktúrája a saját predikciónk felé tolja az exitet, és a bot a session ideje alatt $0.01-os entry áron tradelt deep-OTM piacokon, ahol valós piacon nem lett volna liquidity. Az IC = 0.0 minden szignálon megerősíti: a signal-ek **nem hoztak prediktív értéket**, a paper PnL a szimulátor műterméke.
>
> Ezt nem rejtegetni szabad, hanem szembesülni vele a Hetzner cutover előtt.

---

## A 141 nyertes + 2 vesztes trade alapadatai

Forrás: `https://mj-trading.netlify.app/.netlify/functions/edge-tracker?mode=paper&days=60` (lekérdezve 2026-05-09).

| Metrika | Érték |
|---|---|
| Session indulás | 2026-04-21 18:44 UTC |
| Session vége (utolsó trade) | 2026-05-08 15:54 UTC |
| Session hossza | ~17 nap |
| Total trades | 143 |
| Winner count | 141 |
| Loser count | 2 |
| Win rate | **98.6%** |
| Average winning PnL | $20.54 |
| Average losing PnL | −$7.46 |
| Sharpe ratio (state-ben) | 2.89 |
| Max drawdown | 6.6% |
| Bankroll start → end | $150 → $3050 |
| Net PnL | +$2900 |
| ROI (annualized naïv) | ~3500%/év |

### Per-signal IC értékek

| Signal | IC | Strength |
|---|---|---|
| funding_rate | 0.000 | noise |
| orderflow | 0.000 | noise |
| vol_divergence | 0.000 | noise |
| apex_consensus | 0.000 | noise |
| cond_prob | 0.000 | noise |

**Ez döntő:** ha minden signal IC = 0 (= zaj), akkor a 141 nyertes trade **nem a signal-ekből** ered. Marad három alternatív magyarázat: (a) a paper szimulátor torzítása, (b) a market discovery rossz piacokat választ ki, vagy (c) az edge calculation hibás. Mind a három kéz a kézben jár ebben az esetben.

### Calibration buckets (predicted prob vs actual win rate)

| Predicted prob range | Predicted avg | Actual win rate | Trade count | Well calibrated? |
|---|---|---|---|---|
| 0.50–0.55 | 0.526 | **100%** | 33 | NO (over-realization) |
| 0.55–0.60 | 0.570 | **100%** | 7 | NO |
| 0.60–0.65 | 0.604 | **100%** | 1 | NO |
| 0.75–0.80 | 0.758 | **0%** | 2 | NO (the only losers) |

Ha a 0.526-os predikció 100%-ban nyer, és a 0.758-as 0%-ban: ez **inverz kalibráció**, valós szignálnál ennek pontosan fordítva kéne lennie. Ezt a paper sim oka.

### Mintatrade-ek (utolsó 3)

| Time (UTC) | Market | Dir | Entry | Exit | PnL | Predicted | Edge |
|---|---|---|---|---|---|---|---|
| 2026-05-08 15:54 | bitcoin-above-84k-on-may-8 | YES | $0.01 | $0.2809 | +$27.09 | 0.5612 | 0.5247 |
| 2026-05-08 15:54 | bitcoin-above-82k-on-may-8 | YES | $0.01 | $0.2809 | +$27.09 | 0.5612 | 0.5247 |
| 2026-05-08 15:54 | bitcoin-above-78k-on-may-8 | NO  | $0.01 | $0.2480 | +$23.80 | 0.5045 | 0.4590 |

**Az entry ár konstans $0.01.** Ez paper sim artefakt: a `placeBuyOrder` paper módban azonnal "filleli" a megadott entry áron, anélkül hogy tényleges orderbook depth-et nézne. Valós piacon $0.01-os ask oldali likviditás rendkívül vékony vagy üres a deep-OTM BTC piacokon, ezekre élő tradet **nem lehetne ezeken az árakon felvenni**.

---

## Mit fed le valójában a paper PnL — három torzítási forrás

### 1. `simulatePaperExit` aszimmetrikus halfway-toward-prediction

`auto-trader/index.mts` ezt csinálja paper exit-ben:
```typescript
positionExit = marketPrice + (finalProb − marketPrice) * 0.5
```
Ha 60%-os predikciót adsz egy 50%-os marketre, a szimulátor automatikusan **55%-on** zár — vagyis a szimuláció a saját predikciót felfelé igazolja. Ha az IC = 0 (predikció = zaj), akkor a szimulátor zajos predikciókat valódi nyereséggé alakít. Ez egy **önbeteljesítő szimuláció**.

A mai commit (A.3) hozzáadott egy [SL, TP] clamp-et, de a halfway-toward-prediction alaplogika változatlan.

### 2. Market discovery $0.01-os piacokra megy

A `btc-market-finder.mts` aktív BTC up/down piacokat keres, és a `findBtcMarkets` szűrő nem zár ki olyan piacokat, ahol a top YES ask vagy NO ask már 1¢-es szinten van. A 141 trade entry ára konstans $0.01 → a bot szisztematikusan deep-OTM piacokat választ. Élő tradeben:

- A $0.01 ask gyakran üres (csak market maker bot helyez ide néha 1-2 share-t)
- A slippage a fillshez 5-10¢ lenne
- A $20.54 átlag-profit többnyire ezen az illikvid mikrostruktúrán múlik

### 3. A signal-combiner finalProb predikciója kalibrálatlan

Ha a 0.526-os predikció 100%-ban "nyer", a model **systemikusan alábecsüli a saját pozitív kimeneti rate-jét**. Egy jól kalibrált rendszer 0.526-os predikciónál ~52.6% empirikus win rate-et ad — itt 100% van. Ez olyan, mintha a predikció és a nyertes/vesztes függvények teljesen szétkapcsoltak lennének.

---

## Milyen paraméterekkel futott a bot a 141 trade alatt

A session 2026-04-21-én indult, a mai (2026-05-08) commit-jeim **több ponton megváltoztatták a működést**. Tehát a paper PnL ezekkel a régi paraméterekkel készült:

```
PAPER_MODE             = true
EDGE_THRESHOLD_CRYPTO  = 0.15        (15% net edge minimum, default)
MAX_KELLY_FRACTION     = 0.20        ← MA átállítva 0.08-ra (binary 8% hard cap)
SESSION_LOSS_LIMIT     = 20          (USD)
COOLDOWN_SECONDS       = 300         (per market slug)
ROUNDTRIP_FEE_PCT      = 0.036       (1.8% × 2)
MIN_OPEN_INTEREST      = 500         (USD)
MIN_ACTIVE_SIGNALS     = 2

Cron schedule = "*/3 * * * *" (Netlify functions UTC)
```

**Ezekkel a NEM működött:**

- **Entry-window filter (P1.2)**: a mai commit hozta be hogy csak market open + 60–180s ablakban entry. A 141 trade ezt a filtert **nem** használta.
- **TP=0.75 / SL=0.35 paper clamp**: szintén ma került a `simulatePaperExit`-be. A 141 trade az eredeti unbounded szimulált exit-tel készült.
- **OB imbalance konvergencia (P1.3)**: ma került be. A 141 trade-et csak a signal-combiner kombinált jelzés vezérelte, a Binance orderbook depth ratio nélkül.
- **Hold-to-end cutoff (<60s a resolution)**: ma került be.

**Tehát a mai deploy után a paper futás:**

- **Sokkal kevesebb tradet csinál** (entry-window + OB imbalance konvergencia → ~85% skip rate a master-plan szerint)
- A **PnL profilja megváltozik** mert a TP/SL clamp [SL, TP]-re vágja a paper exit-et — egyenletesebb, kisebb átlag-PnL várható
- A win rate **nem feltétlenül csökken**, mert a halfway-toward-prediction alaplogika változatlan; csak kevesebb minta lesz

---

## Mit jelent ez élesre váltás szempontjából

**NE VÁLTS LIVE-RA** (`PAPER_MODE=false`) ezen paper PnL alapján. A paper sim artefakt-jai miatt a 98.6% win rate **élesben várhatóan 50% alá esne** azonnal. A master-plan minimum 20+ paper trade-et javasol live előtt, **de** ez csak akkor érvényes ha:

1. Az IC értékek > 0.05 minden aktív signal-en
2. A calibration scatter a 45° átlón van (predikció ≈ tényleges win rate)
3. Az entry ár disztribúció realisztikus (nem $0.01 cluster)
4. A signal-aggregator OB imbalance + edge filter után **valódi** trade-eket szül, nem csak deep-OTM artefaktokat

**Valódi live test workflow** (a Hetzner cutover előtt is megcsinálható szervered nélkül):

1. **Reset session** → `POST /auto-trader { action: "reset" }` → bankroll vissza alapra, history törlődik
2. **Paper mode újra futtatás 100+ trade-ig** az új filterekkel — ez most realisztikusabb mintát ad
3. **Calibration ellenőrzés**: ha a paper IC értékek továbbra is 0.0 → a signal-ek strukturálisan rosszak (vagy a kalibrációs metric maga buggy a kis mintánál)
4. **Live testnet-szerű első élesítés**: $10–20 USDC hot wallettel, 5-10 trade, kézi monitoring
5. Csak utána skálázás

A paper PnL **tanulságos arra**, hogy az infrastruktúra él (cron fut, signal-combiner válaszol, edge-tracker rögzít), de **NEM** arra, hogy a stratégia profitábilis-e.

---

## Mit javítok ennek tükrében (későbbi sessionek)

A teendők, mostantól priorizálva:

1. **`simulatePaperExit` realisztikusabbá tétele** — a halfway-toward-prediction helyett egy random-walk modellt vagy historikus ár-elmozdulást kell használni, ami a `finalProb`-tól független. Ezzel az IC értékek **valódi** prediktív erőt tükröznek.
2. **`btc-market-finder` szűrőjének szigorítása** — top YES + top NO ask együttes árának > $0.10 kell lennie (különben deep-OTM artefakt), és minimum top-of-book depth > $50.
3. **Calibration alarm a signal-combiner-ben** — ha 30+ trade után a IC < 0.02 minden signalon, a system Telegram alertet ad és felfüggeszti a live tradeleket.
4. **Edge tracker UI bővítés** — a Tab 12-n már látszanak a buckets, de a Home page-en is jelenjen meg "calibration health" badge: zöld ha az IC > 0.05 minimum egy signalra, narancs ha 0.02–0.05, piros ha 0 alatt.

A pontok 1-2 ennek a sessionnek a folytatása lehet (nem nagy munka), 3-4 a következő session anyaga.

---

## Mit látsz jelenleg a Tab 12-n (Edge Tracker)

A `/trade/crypto/` URL alatt a `CategoryDashboard` komponens van, ami egy összevont "Crypto trader" view (TraderStatus + EdgeTrackerPanel embedded). A Tab 12 (`/tools#autotrader`) a `TraderStatus` komponens, ami:

- Session metadata (bankroll, paperMode, stopped)
- Last 20 log entries (SIGNAL / DECISION_TRADE / ORDER_PLACED stb.)
- Closed trades list

Az **Edge Tracker** (`EdgeTrackerPanel`) ettől különálló, a Tab 12-n belül egy aldobozban: 6 chart (cumulative PnL, calibration scatter, signal IC bars, edge decay, win-rate heatmap, PnL histogram). Ez fetcheli a `/edge-tracker?mode=paper&days=...`-ot, és a fenti táblázatok megfelelőit mutatja vizuálisan.

A két nézet redundánsan mutatja a 141 trade-et, csak a `TraderStatus` szöveg + lista, az `EdgeTrackerPanel` pedig grafikon.

---

## Mit válaszolnék a "nincs vesztes kereskedés?" kérdésre

**Van 2 vesztes** (`loser_count: 2`), amelyek mindkettő a 0.75–0.80 predikció buckét-ből jön. A 98.6% win rate strukturálisan paper sim artefakt — nem azt jelenti hogy a stratégia ennyire jó, hanem hogy a szimulátor a saját predikciót automatikusan profitba tolja. **Élesben várhatóan 50% körüli win rate** lenne ezzel a signal-szettel az IC = 0.0 mellett, de még ez is optimista becslés (negatív lehet).

---

## 2026-05-09 follow-up — fixek élesítve

Az analízis 144–153. sorában listázott négy fixből háromnak kódfedezete van, és egy negyedik (UI badge) is ki lett egészítve. Részletek: `internal-docs/changelog/CHANGELOG-2026-05-09.md` "Crypto paper trader: realisztikussá tett szimulátor" szekciója.

| Eredeti probléma | Status | Hol |
|---|---|---|
| `simulatePaperExit` halfway-toward-prediction → finalProb-függő profit | ✅ KIVÉVE | `auto-trader/crypto/paper-resolver.mts` (real Polymarket resolution + Brownian-bridge fallback, mindkettő finalProb-független) |
| `btc-market-finder` deep-OTM piacokat választ ($0.01 fill artefakt) | ✅ JAVÍTVA | `MIN_PRICE_BAND = 0.10` szűrő (yes < 0.10 vagy > 0.90 → skip) |
| Calibration alarm hiánya | ✅ HOZZÁADVA | `computeCalibrationHealth` + Telegram + auto-suspend live |
| Edge tracker UI calibration badge | ✅ HOZZÁADVA | `CalibrationHealthBadge` a Tab 12 tetején |
| 143 régi (torzított) trade history | ✅ AUTO-ARCHIVE | `simVersion=2` bump, deploy után az első cron tickkor archiválódik és tiszta session indul |

### Mit várhatunk az új paper sim-től 50+ trade után

- **Win rate**: 50–58% körül (vs 98.6%) — Bernoulli(marketPrice) null + véletlen Brownian volatilitás miatt
- **Avg PnL/trade**: $0–$2 (vs $20.54) — a deep-OTM filter kizárja a $0.01 entry artefaktokat
- **Sharpe**: 0–1.0 (vs 2.89) — realisztikus, nem fizikailag-valószínűtlen
- **Per-signal IC**: ha valódi alpha van, akkor 0.02–0.10 között; ha nincs, akkor 0 körül marad — ez a teszt
- **Calibration scatter**: ha a signal-combiner kalibrált, akkor a buckets a 45° vonal körül szóródnak; ha nem, akkor láthatóvá válik az eltérés

A live váltás döntéséhez a Tab 12 calibration badge **zöld** (max |IC| ≥ 0.05) értéke + 50+ trade kell. Ha 30+ trade után minden signal IC < 0.02, akkor:

- Telegram alarm érkezik (idempotens, egyszer/session)
- Live mód automatikusan stop-ol
- Paper mód folytatódik, hogy a user iterálhasson

### Mit nem oldottak meg ezek a fixek

- Ha a Brownian-bridge fallback aktiválódik (nem érkezett vissza Polymarket resolution 30 min-en belül), az nem 100%-ban valós. De: (1) finalProb-független, (2) Bernoulli(marketPrice) ground truth, (3) csak vészforgatókönyvben fut.
- A signal-combiner IC weights még mindig priorok. Az új paper-tényleges IC mérések után (50+ trade) érdemes ezeket újrahangolni.
- A TP/SL profile paper módban most "hold-to-end vagy Brownian-fallback" — nem éles-szerű periodikus midprice polling. Ez egy következő iteráció témája.
