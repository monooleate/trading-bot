# CHANGELOG 2026-07-23 — Teljes code-review (7 sáv) + 4 P0 kódfix + operátor-knobok

> **Session típusa:** user-kérés — „nézd meg a botok teljesítményét … hol tudnánk javítani?" majd „teljes code-review kell. mi kell hogy nyereséges legyen a bot minden pilléren?" majd „alkalmazd a knobokat, implementáld a P0 kódfixeket, vezesd fel a sprints.md-be".
>
> **Auth:** operátor-jelszóval (Reka-Punci-88) auth-olt API — knob-alkalmazás + sports stop.

---

## 1. Teljes code-review — 7-sávos multi-agent workflow

Élő teljesítmény-audit (auth-olt `/multi-status` + `/edge-tracker` + `/trader-settings`) után egy 7-sávos multi-agent code-review (5 bot-pillér + shared signal-infra + economics-risk), sávonként **review → adverzariális verifikáció → path-to-profit roadmap**. Eredmény: **49 ágens, 35 találat, 33 megerősítve, 0 megcáfolva**.

### Data-quality korrekciók (fontos, a session eleji riporthoz képest)

1. **„overrides wiped" — TÉVES.** A session eleji unauthenticated `/trader-settings` GET szándékosan `overrides:{}` + defaultokat ad vissza (biztonsági feature, [trader-settings.mts:12](../../netlify/functions/trader-settings.mts)). Az auth-olt GET **24 aktív override**-ot mutat: `sessionLossLimit=1000` (nem $20), `weatherInvertDirection=1` (invert **ON**), `combinerKBlindDownweight=0.5`, `useRealizedIC=0`, HL loose-config (hlMaxLeverage 5, hlEdgeThresholdPaper 0.05) stb. A „punitive $20 default" narratíva elesik; a kód-szintű találatok viszont függetlenek ettől és állnak.
2. **Stale számok.** A session eleji `/multi-status` cache-elt (fetchedAt 10 nappal korábbi) volt. Friss (2026-07-23): crypto +$690 (stopped), **weather −$189.90 / 56 trade / $48 bankroll** (a −$68 helyett — invert ON mellett vérzik), HL −$13.19 / 188, F-Arb −$9.14 / 40, **sports −$347.57 / 122** (a −$285 helyett).

---

## 2. Alkalmazott operátor-knobok (élő, deploy nélkül — auth-olt API)

| Bot | Knob | Régi → Új | Indok |
|-----|------|-----------|-------|
| **Sports** | `action=stop` | fut → **STOPPED** | Nincs edge-forrás (B37), −$347.57 / −77% — a vérzés azonnali elállítása. |
| **Sports** | `sportsSessionLossLimitEnabled` + `sportsSessionLossLimit` | 0 → **1**, 30 → **50** | Circuit-breaker felfegyverzése (eddig paperben OFF → korlátlan vérzés). |
| **Weather** | `weatherSelectionShrink` | 0.5 → **1.0** | Teljes egy-szigmás szelekciós-torzítás korrekció (optimizer's curse). |
| **Weather** | `weatherMaxPositionUSD` | 25 → **15** | A nagy-veszteség tail sapkázása (payoffRatio 0.44). |
| **F-Arb** | `frMinSpreadHourly` | 0.00002 → **0.00005** | A nyit-majd-azonnal-zár churn-sáv kiiktatása (a B31 kódfix operátor-párja). |

> **Weather invert (`weatherInvertDirection`) NEM módosítva** — az IC-előjel ellentmondás (invert ON de forecast_edge IC +0.393) miatt nem flippeltünk vakon (a session eleji audit egyszer már tévesen mondta „invert OFF"). → dedikált re-audit **B40**.

---

## 3. 4 P0 kódfix (branch `fix/p0-profitability-fixes`, `tsc`+build+12 teszt-suite zöld)

### B29 — Gross-loss session-limit unbrick

A `sessionLoss` monoton **bruttó-veszteség odométer** (sosem írja vissza nyeremény), és a `resumeSession`/`topupSession` megőrizte → egy „Session loss limit reached" stop után a resume azonnal újra leállított (a knob max $1000 < a crypto $1033 bruttó vesztesége, +$690 nettó mellett). **Fix:** [crypto/session-manager.mts](../../netlify/functions/auto-trader/crypto/session-manager.mts) `resumeSession` + [hyperliquid/session-manager.mts](../../netlify/functions/auto-trader/hyperliquid/session-manager.mts) `resumeHlSession` mostantól `sessionLoss: 0`. → sprints.md **B29**; principled fix (net/peak-equity limit) → **B33**.

### B30 — Combiner [0,1] clamp + totalW guard

A `combine()` mixed-sign súlyozott átlaga kiléphet [0,1]-ből, ha bármely effektív IC negatív → a `combined` a Kelly `b = 1/p − 1`-be megy → negatív `b`, korrupt irány. **Fix:** [signal-combiner.mts](../../netlify/functions/signal-combiner.mts) `combine()`: `totalW` degeneráció-guard (equal-weight fallback) + `combined = clamp(1e-4, 1−1e-4)` a K-anchor blend után. Szigorú no-op pozitív prioroknál. Ez a **load-bearing előfeltétel** a `useRealizedIC` biztonságos bekapcsolásához. → sprints.md **B30**; sign-aware súlyozás + knob-bekapcsolás → **B34**.

### B31 — F-Arb forward-carry proxy + churn close-logic

A forward-láb (HL-short + Binance-**spot**-long) `forwardScore = spread`-del gate-elt, de a spot-láb nem fizet fundingot → a valós carry a **HL funding egyedül** (amit az `accrueFunding` már számol). Negatív Binance-fundingnál `spread > hlFunding` → veszteséges pozíciók beengedve. A záró küszöb magasabb volt a nyitónál → churn. **Fix:** [arb-detector.mts](../../netlify/functions/auto-trader/hyperliquid/funding-arb/arb-detector.mts) `forwardScore = d.hlFundingHourly`; [index.mts](../../netlify/functions/auto-trader/hyperliquid/funding-arb/index.mts) close-check accrual-konzisztens carry + a `carry < minSpreadToClose` early-close eltávolítva (zár csak maxHold VAGY carry<0) + gate-3 break-even display slippage-tudatos. Teszt: `funding-arb-reverse.test.mts` (+fwdCarry regression). → sprints.md **B31**.

### B32 — Edge-tracker under-report fix

Az Edge Tracker hamis számokat mutatott: `days` default 30 nap (sports headline −$47 a valós −$285 helyett) + `computeSummary` hardkódolt $150 bankroll (minden %-stat hibás). **Fix:** [edge-tracker.mts](../../netlify/functions/edge-tracker.mts) `days` default „all"; új `resolveBankrollStart(category, mode)` a valós per-kategória `bankrollStart`-ot adja a `computeSummary`-nak. → sprints.md **B32**.

**Új teszt:** `auto-trader/shared/p0-profitability-fixes.test.mts` (resume sessionLoss-clear crypto+HL, combiner clamp no-op/out-of-range/totalW-guard). `funding-arb-reverse.test.mts` bővítve. Összes teszt-suite (12) + `tsc --noEmit` + `npm run build` zöld.

---

## 4. Nyitott follow-upok (sprints.md B33–B40)

- **B33** 🟠 nettó/peak-equity session-loss-limit (a bruttó odométer leváltása; B29 csak interim unbrick)
- **B34** 🟠 combiner sign-aware negatív-IC + `useRealizedIC` bekapcsolás (B30 clamp után)
- **B35** 🟠 weather sizing/kalibráció overhaul (Kelly leválasztása az ensemble-egyetértésről, σ-infláció, fee-parity, favorit-cap)
- **B36** 🟠 HL Kelly win-prob mapping fix
- **B37** 🔴 sports fair-value redesign (Pinnacle de-vig) — a bot leállítva addig
- **B38** 🟡 crypto tail-de-selection + korreláció-tudatos aggregát cap
- **B39** 🟡 evGap net-of-fee baseline
- **B40** 🟡 weather invert-direction re-audit (IC-előjel ellentmondás)

---

## 5. Deploy-státusz

- **Knobok:** élő MOST (Blobs-override, a cron a következő tickre olvassa).
- **Kódfixek:** a `fix/p0-profitability-fixes` branchen commitolva, **NEM deployolva** (a user nem kért push/deploy-t). A crypto újraindítása a B29-fix **deploy-ját** igényli, utána `POST /auto-trader-api {action:"resume", category:"crypto"}`.
