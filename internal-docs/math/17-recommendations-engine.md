# Recommendations Engine — Coach mode

> **Hatókör.** Ez a dokumentum a 2026-05-14-i 35. session-ben bevezetett Coach-mode rendszer matematikai és működési hátterét írja le. A rendszer **csak javaslatokat ad** az operátornak a closed trade history alapján — **soha nem módosít automatikusan paramétert** (autopilot mode tudatosan kihagyva, lásd 1.4. szekció).
>
> A pipeline 4 új komponensből áll: time-decay IC (`signal-calibration.mts`), per-bot recommendations engine (`shared/recommendations.mts`), auth-protected API endpoint (`recommendations-api.mts`), és React UI kártya (`shared/RecommendationsCard.tsx`).

---

## Tartalomjegyzék

1. [A rendszer célja és tervezési elvei](#1-a-rendszer-célja-és-tervezési-elvei)
2. [Time-decay IC matematikája](#2-time-decay-ic-matematikája)
3. [Per-bot szabályrendszer](#3-per-bot-szabályrendszer)
4. [Apply flow + audit trail](#4-apply-flow--audit-trail)
5. [Confidence és severity rendszer](#5-confidence-és-severity-rendszer)
6. [Edge cases és failure modes](#6-edge-cases-és-failure-modes)
7. [Integráció a meglévő pipeline-nal](#7-integráció-a-meglévő-pipeline-nal)
8. [Tesztelési protokoll](#8-tesztelési-protokoll)

---

## 1. A rendszer célja és tervezési elvei

A 4 bot eddig **memory-less** volt a closed trade-ekre nézve a weather DEB kivételével. Az operator manuálisan állította a Settings tab Loose/Normal/Strict preset-jeit, anélkül hogy a bot saját track-record-ja kvantitatívan informálta volna a döntést.

A Coach-mode rendszer **2 réteget vezet be**:

1. **Read-only IC tracker (🟢)** — minden closed trade után újraszámolja a per-signal realized IC-t, opcionális time-decay-jel (exponenciális recency weighting). Csak adatgyűjtés, semmilyen gate-et nem nyit/zár.
2. **Recommendations engine (🟡)** — a closed trade history + jelenlegi Settings alapján generál egy javaslat-listát (`combinerConfidenceMin lower`, `weatherEdgeThreshold raise`, stb.) magyarázattal és Apply-gombbal. A gomb a meglévő `trader-settings` POST endpoint-ot hívja meg → operator-in-the-loop sanity check.

### 1.1 Miért NEM autopilot

| Szempont | Coach mode (választott) | Autopilot (elvetett) |
|----------|-------------------------|----------------------|
| Regime-shift drift védelem | ✅ Operator szűri | ❌ Bot követi a noise-t |
| Domain context (Fed, halving, exploit) | ✅ Operator tud róla | ❌ Bot vak |
| Audit trail | ✅ Minden change explicit operator-aktus | ⚠️ Nehéz visszanyomozni |
| Reakcióidő | ⚠️ 1-3 nap latency | ✅ Real-time |
| Operátor terhelés | ⚠️ Naponta ránéz | ✅ Zero |
| Black-swan robustness | ✅ Operator stop-button | ❌ Bot tovább "tanul" rossz adatból |

A live trading-ben a **black-swan-robustness vs. real-time reakcióidő tradeoff**-ban a black-swan oldal sokkal súlyosabb: egy rossz auto-tuning iteráció napokig árthat, míg a 1-3 nap operator-latency csak alpha-eltolódás (kihagyott opportunity, nem realizált veszteség).

### 1.2 Hard guardrail-ek soha nem javaslat-tárgyak

Az engine **explicit kihagyja** a következő mezőket:

- `maxKellyFraction` — ¼-Kelly + 8% cap operátor-döntés
- `cryptoMaxEdgeCap` / `hlMaxEdgeCap` / `weatherMaxEdgeCap` — sanity cap (40%), manuális
- `sessionLossLimit` — hard stop, kockázat-kezelés
- `liveReadyOverrideEnabled` — gate-bypass kapcsoló, dedikált audit

Ezek a tételek **paramétereibe a bot soha nem nyúl** — ha valamelyik anomáliásan kalibrálva van, az engine `info` severity-vel jelez, de Apply-gomb nélkül.

### 1.3 Operator-flow

```
1. Operator betölti /trade/<bot>/
2. RecommendationsCard automatikusan fetcheli a /recommendations-api?category=<bot>
3. API a closedTrades-ből + Settings-ből legenerálja a listát (max ~5-8 javaslat)
4. Operator átolvassa, "Why?"-ra kattint → látja a statisztikákat
5. Operator dönt: Apply / Dismiss
   - Apply → trader-settings POST → runtime override Blobs frissül
   - Dismiss → csak az aktuális nézetből rejti el (re-load után visszajön ha még érvényes)
```

### 1.4 Mit NEM csinál

- ❌ Nem ír át parameter-t magától, semmilyen körülmény között
- ❌ Nem küld Telegram alert-et (a Calibration-noise alarm külön komponens)
- ❌ Nem szól a cron loop-nak (read-only endpoint, mellékhatás-mentes)
- ❌ Nem tárol "dismissed" állapotot Blobs-ban (csak a kliens React state-ben)
- ❌ Nem javasol hard guardrail-eket (lásd 1.2)

---

## 2. Time-decay IC matematikája

A jelenlegi `computeRealizedICs` uniform weighting-tel számolt: minden closed trade ugyanúgy számít a Pearson(signal_score, win_outcome) korrelációba. Ez **regime-shift bias**-ra érzékeny: ha a piac vol-rezsim megváltozik, a régi rezsimben hatékony signalok továbbra is "good" IC-t mutatnak, miközben a friss adat ezt cáfolja.

### 2.1 Exponenciális decay súlyozás

A `halfLifeTrades` paraméter (új Settings knob `icHalfLifeTrades`, default 0 = uniform):

$$
w_i = \left( \frac{1}{2} \right)^{(N-1-i) / H}
$$

ahol:
- $i \in [0, N-1]$ a chronological index (oldest = 0, newest = $N-1$)
- $H$ a `halfLifeTrades` érték
- $w_i = 1$ a legújabb trade-re, $w_i = 0.5$ a $H$-edik legutóbbira, $w_i = 0.25$ a $2H$-edikre, stb.

### 2.2 Weighted Pearson

$$
\rho_w = \frac{\sum_i w_i (x_i - \bar{x}_w)(y_i - \bar{y}_w)}{\sqrt{\sum_i w_i (x_i - \bar{x}_w)^2 \cdot \sum_i w_i (y_i - \bar{y}_w)^2}}
$$

ahol $\bar{x}_w = \frac{\sum_i w_i x_i}{\sum_i w_i}$ (weighted mean).

### 2.3 Half-life kalibráció

| `icHalfLifeTrades` | Recency profile | Mikor érdemes |
|---|---|---|
| 0 (default) | Uniform — minden trade egyformán számít | Stabil rezsim, alacsony piac-volatilitás |
| 50 | Recent ~3-7 nap a jelenlegi tempónál | Default ajánlott élesedés után |
| 100 | Recent ~1-2 hét | Konzervatív, lassan reagál |
| 200 | Recent ~3-4 hét | Csak hosszú stabil time-series-en |
| <20 | Túl agresszív | Kerülendő (IC zaj-szenzitív) |

### 2.4 Interakció a Bayes-shrinkage-zel

A meglévő `effectiveICs(priors, calibration, k)` Bayes-shrinkage-zel kombinálja a realized IC-t a statikus akadémiai priorokkal:

$$
\text{effective}[s] = \frac{n_s}{n_s + k} \cdot \text{realized}[s] + \frac{k}{n_s + k} \cdot \text{prior}[s]
$$

A time-decay **csak a `realized[s]` számolását módosítja**, a shrinkage változatlan. Vagyis:
- Kis $n_s$ + nagy $H$ → továbbra is a prior dominál (shrinkage helyes pull)
- Nagy $n_s$ + kis $H$ → a recent realized dominál, a régi adatból csak a tail

---

## 3. Per-bot szabályrendszer

Minden bot saját adapter-en megy (`recommendPrediction`, `recommendWeather`, `recommendFundingArb`), mert a parameter-térük és a relevánsstatisztikák különbözőek.

### 3.1 Crypto + HL Perp (8-signal pipeline)

| Szabály ID | Trigger | Suggested action | Severity | Min N |
|------------|---------|------------------|----------|-------|
| `rec-use-realized-ic` | maxAbsIC ≥ Bonferroni-good küszöb ÉS `useRealizedIC=OFF` | `useRealizedIC` → 1 | action | 20 |
| `rec-disable-realized-ic` | minden signal noise tartományban ÉS `useRealizedIC=ON` | `useRealizedIC` → 0 | warn | 20 |
| `rec-signal-negative-<name>` | per-signal IC < 0 statisztikailag szignifikáns | info (no Apply) | info | 20 |
| `rec-confidence-lower` | n ≥ 30, WR ≥ 55%, current ≥ 0.05 | `combinerConfidenceMin` -= 0.02 | action | 15 |
| `rec-confidence-raise` | n ≥ 30, WR < 45% | `combinerConfidenceMin` += 0.03 | warn | 15 |
| `rec-edge-threshold` | First-profitable-bucket eltér ≥ 3% az aktuálistól | `edgeThreshold` ← first profitable | info/warn | 15 |
| `rec-drawdown-attention` | maxDrawdown ≥ 70% × sessionLossLimit | info (no Apply) | warn/info | 10 |

### 3.2 Weather (forecast_edge single-signal)

| Szabály ID | Trigger | Suggested action | Severity | Min N |
|------------|---------|------------------|----------|-------|
| `rec-weather-edge-threshold` | First-profitable-bucket eltér ≥ 3% | `weatherEdgeThreshold` ← first profitable | info/warn | 10 |
| `rec-weather-ensemble-on` | `useEnsemble=OFF` ÉS n ≥ 10 | `weatherUseEnsemble` → 1 | action | 10 |
| `rec-weather-confidence-raise` | n ≥ 25, WR < 45%, current ≤ 0.70 | `weatherConfidenceMin` += 0.05 | warn | 15 |

A weather **DEB** komponens (per-city GFS/ECMWF/NOAA súlyok) **ortogonális** a recommendations engine-nel — a DEB már aktívan auto-tuningol per-city, a Coach-mode csak a gate knobokat javasolja.

### 3.3 F-Arb (rate-driven, no IC)

| Szabály ID | Trigger | Suggested action | Severity | Min N |
|------------|---------|------------------|----------|-------|
| `rec-farb-min-spread-raise` | n ≥ 10, WR < 50%, current < 0.03% | `frMinSpreadHourly` += 0.01% | warn | 10 |
| `rec-farb-min-spread-lower` | n ≥ 20, WR ≥ 65%, current ≥ 0.01% | `frMinSpreadHourly` -= 0.003% | action | 20 |
| `rec-farb-max-hold-lower` | átlag hold-idő < cap / 2, cap > 3d | `frMaxHoldDays` ← max(3, 2×avgHold) | info | 10 |

F-Arb-on **per-signal IC szabályok N/A**, mert a stratégia rate-driven (nem prediction-driven).

### 3.4 Edge bucket analízis

A `rec-edge-threshold` szabály (crypto + HL + weather) az edge-eloszlást 5%-os bucket-ekre osztja, és minden bucketben átlag PnL-t számol:

```
bucket[0..5%):    átlag PnL = ...  (n=N₁)
bucket[5..10%):   átlag PnL = ...  (n=N₂)
bucket[10..15%):  átlag PnL = ...  (n=N₃)
...
```

A javaslat = a legalacsonyabb bucket ahol $\bar{\text{PnL}} > 0$ ÉS $n \geq 5$. Ez **per-bin reliability diagram** light verziója — a Tier 2 master-plan tételének előkészítője.

---

## 4. Apply flow + audit trail

```
[Operator clicks Apply on rec-confidence-lower]
        ↓
RecommendationsCard.applyRec(rec)
        ↓
POST /.netlify/functions/trader-settings
   body: { combinerConfidenceMin: 0.03 }
   credentials: include  (JWT cookie)
        ↓
trader-settings.mts:validate(body)
   → clamp to SCHEMA range (min/max)
   → merge with existing overrides
        ↓
Netlify Blobs: trader-settings/runtime-overrides-v1
        ↓
Next cron tick: getEffectiveCryptoConfig() olvassa
        ↓
RecommendationsCard auto-refresh → új state
```

### 4.1 Audit trail

- A `trader-settings` POST endpoint **változatlan** (létező, 2026-05-09 óta). Coach-mode csak hozzáad új call-site-okat.
- Netlify deploy log + Blobs versioning lehetővé teszi a változások visszakövetését.
- A Coach-mode **nem ír saját audit log-ot** — a meglévő `log("TRADE_OPENED", ...)` és a Settings tab `overrides` view az audit forrás.

### 4.2 Hibakezelés

| Failure | UI állapot |
|---------|-----------|
| Network error | "✗ Hálózati hiba: ..." |
| Auth lejárt | 401 → "✗ Sikertelen: unauthorized" |
| Validation fail | 400 → "✗ Sikertelen: <reason>" |
| Server config error | 500 → "✗ Sikertelen: server_config" |
| Successful apply | "✓ Alkalmazva: <field> → <value>" + auto-refresh |

---

## 5. Confidence és severity rendszer

### 5.1 Confidence (statisztikai megbízhatóság)

| Label | Meaning | UI tone |
|-------|---------|---------|
| `low`  | N < 30 vagy nem-szignifikáns minta | muted, tone: szürke |
| `medium` | N ∈ [30, 60), szignifikáns | tone: kék (accent2) |
| `high` | N ≥ 60 (vagy ≥ 50 stabil signal-re), nagy konfidencia | tone: zöld (accent) |

A confidence az operátor figyelmét irányítja: `high` confidence javaslatot általában érdemes alkalmazni, `low` confidence csak figyelmeztetés.

### 5.2 Severity (cselekvés-prioritás)

| Label | Meaning | UI border |
|-------|---------|-----------|
| `info` | Megfigyelés, esetleges későbbi cselekvésre | kék bal-border |
| `warn` | Anomália, figyelendő | narancs bal-border |
| `action` | Konkrét tuning lehetőség, alacsony kockázat | zöld bal-border |

A `severity` nem keverendő a `confidence`-szel: egy `action`/`low` javaslat = "kis adatból, de érdemes kipróbálni", míg `info`/`high` = "biztosan értelmes, de még nem kell cselekedni".

---

## 6. Edge cases és failure modes

### 6.1 Insufficient data

```
trades.length < MIN_TRADES_FOR_ANY_REC (5)
→ returns single `rec-insufficient-data` info item
→ "Túl kevés closed trade a javaslatokhoz (3 / 5 min.)"
→ Apply gomb nincs
```

### 6.2 Anonymous user (unauth)

```
checkAuth() → ok: false
→ returns single `rec-auth-required` info item
→ "Bejelentkezés szükséges a javaslatok megtekintéséhez"
```

### 6.3 Blobs read failure

```
loadTrades soft-fail → trades = []
→ engine returns insufficient-data item
→ UI render: nincs error message
```

### 6.4 Conflicting recommendations

Pl. ha n=30, WR=58%, és egy aláírás (signal X) -0.05 IC-t mutat: `rec-confidence-lower` (action) és `rec-signal-negative-X` (info) együtt jelenik meg. **Ez OK** — a kettő nem ellentmondó: a confidence-küszöb csökkentése megnöveli a trade volument, a negative-IC signal kikapcsolása orthogonally javítja a quality-t.

### 6.5 Apply-after-stop

Ha a session stopped, az Apply gomb is működik (a Settings tab logika ugyanígy működik). A javaslat alkalmazása nem indítja újra a session-t — az operátor kell a Resume gombbal kézzel csinálja.

---

## 7. Integráció a meglévő pipeline-nal

### 7.1 Adatfolyam

```
Cron tick → trade opens/closes → session.closedTrades grows
                                        ↓
                            persistCalibration(category, trades, {halfLifeTrades})
                                        ↓
                       Blobs: signal-calibration-v1/calibration-<cat>-v1
                                        ↓
                       (signal-combiner reads if useRealizedIC=ON)
                                        ↓
                       (Recommendations engine reads on UI request)
```

### 7.2 Új Settings knob

- `icHalfLifeTrades` (common group, "Signal calibration" section)
  - Default: 0 (uniform — bit-azonos a pre-2026-05-14 viselkedéssel)
  - Range: [0, 500]
  - Step: 5
  - Egyszerre alkalmazódik mind a 3 prediction-driven botra (crypto, weather, hyperliquid)

### 7.3 Új API endpoint

- `GET /.netlify/functions/recommendations-api?category=<cat>&halfLife=<N>&windowDays=<D>`
- Auth-required (JWT cookie). Anonymous → `rec-auth-required` placeholder.
- Response: `RecommendationsResponse` JSON

### 7.4 Nincs új cron

A Coach-mode **pure read-on-demand** — minden UI-fetch a friss adat alapján számol. Cron-trigger nincs, ami nem véletlen: nem akarunk Telegram alarmot a javaslatokra (a Calibration-noise alarm már megvan külön), és a Blobs-write-ot is elkerüljük (read-only endpoint).

---

## 8. Tesztelési protokoll

### 8.1 Smoke test (manuális)

1. Build verify: `npm run build` ✅
2. Type check: `npx tsc --noEmit` ✅
3. Localhost test (`netlify dev`):
   - `/trade/crypto/` → RecommendationsCard render, "5 trade alatt" placeholder (3 closed)
   - Login → JWT cookie → re-render
   - "Why?" gomb → expand statistics
   - Mock 30+ trade-et (manuális Blobs write) → confidence-lower javaslat megjelenik
   - Apply → trader-settings frissül → recommendations re-fetch

### 8.2 Per-bot smoke

| Bot | URL | Min trade | Várt elem |
|-----|-----|-----------|-----------|
| Crypto | `/trade/crypto/` | 3 (current) | "insufficient-data" item |
| Weather | `/trade/weather/` | 2 (current) | "insufficient-data" item |
| HL Perp | `/trade/hyperliquid/` | 4 (current) | "insufficient-data" item |
| F-Arb | `/trade/funding-arb/` | 0 | "insufficient-data" item |

Az 5+ küszöb átlépése után a per-bot szabályok aktiválódnak (lásd 3. szekció).

### 8.3 Time-decay validáció

Manuális teszt:
1. Settings tab → `icHalfLifeTrades` → 50
2. Várj egy cron tick-et (3 perc crypto, 5 perc weather)
3. Edge Tracker tab → check `calibrationHealth.computedAt` időbélyeg
4. Realized IC számolódjon `halfLifeTrades=50`-nel
5. Visszaállítás → `icHalfLifeTrades` → 0
6. Várj egy tick-et → IC újraszámolva uniformmal

### 8.4 Periodic audit

Havonta egyszer:
- Operator átnézi az aktív javaslat-listát mind a 4 botra
- "Why?" view-val verify-olja a statisztikákat
- Apply-eli amit indokoltnak tart
- Dismiss-eli a többit (regime-context tudás alapján)

---

## Hivatkozások

- `netlify/functions/auto-trader/shared/recommendations.mts` — per-bot engine
- `netlify/functions/auto-trader/shared/signal-calibration.mts` — realized-IC + Bayes shrinkage + time-decay
- `netlify/functions/edge-tracker/statistics.mts` — `weightedPearsonCorrelation`
- `netlify/functions/recommendations-api.mts` — auth-protected GET endpoint
- `src/components/shared/RecommendationsCard.tsx` — React UI
- `netlify/functions/trader-settings.mts` — Apply target (POST endpoint, létező)
- `internal-docs/changelog/CHANGELOG-2026-05-14.md` — session implementáció leírása
