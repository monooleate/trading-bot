# CHANGELOG 2026-07-04

## Weather + crypto trade-history audit + flip-elemzés → Weather Invert ON döntés (B22)

A user kérte mindkét bot élő trade-jeinek ellenőrzését, a „ha élő lett volna" kimenet-elemzést,
és a kérdést: *„a win rate a weathernél nem indokolja, hogy mindig az ellenkezőre tegyen?"*
Read-only audit a [`playbooks/trade-history-audit.md`](../playbooks/trade-history-audit.md) szerint;
kód **nem** változott, a döntés operatív (auth-gated Settings + reset, operátor alkalmazza).

> **Megjegyzés:** a CLAUDE.md AKTUÁLIS ÁLLAPOT 2.5 hetes (06-15) volt — az élő számok drasztikusan eltérnek.

### 1. Crypto — nyerő, NEM flip ✅

- **Élő:** 30 closed, 40% WR, **+$817.55** (+545%), profitFactor 2.12, payoffRatio 3.17. Bankroll $350 → $974.36.
- **Rekonciliáció ✓:** 350 + 817.55 − $193.19 open (3 poz) = $974.36.
- A B27 cond_prob-fix + 06-14 reset **működik**: `cond_prob` már nem telít 0.2-re, `apex_consensus` IC +0.248. A profit ~4 hatalmas longshot-nyerőn (+281 @0.12, +234 @0.12, +160, +125).
- **Flip = −$108.91** (számolva) → a flip itt katasztrófa. **Ne nyúlj hozzá.**
- Fenntartás: n=30, Sharpe 0.36 CI **[−0.05, 0.68]** átfogja a nullát; magas variancia (maxDD 195%). Hagyni futni 50+ trade-ig, tétet nem emelni.

### 2. Weather — valódi inverz anti-edge (≠ crypto regime-artifact)

- **Élő:** 78 closed, 32.1% WR, **−$202.95**, profitFactor 0.55. Bankroll $250 → **$43.84** (majdnem elfogyott). Rekonciliál ✓.
- **`forecast_edge` IC = −0.359** (n=78, strong) — strukturális anti-jel.
- **Fordított kalibráció** (a döntő bizonyíték): modell 63% → realizált **18%** (n=11); modell 7% → realizált **35%** (n=20). Ez inverzió, nem szórás.
- **Flip (n=50 minta):** 40% WR / −$34.45 → **60% WR / +$29.55**; **mindkét** direkció flippel pozitívba (NO→+22.32, YES→+7.23).
- **Gamma cross-check:** Guangzhou júl-1 a 34°C bucketre resolvolt (YES nyert) — a bot YES-t fogadott, jogosan nyert; a resolutions valósak (konzisztens a 06-15 audittal).
- **DE**: a flip NEM szimmetrikus — az ár-aszimmetria (a modell longshotokon bukik → tükörben favoritra fogad, kis payoff) a felső határt befogja. A „szigorítsd a confidence-küszöböt" **visszaütne**, mert a magabiztosság fordítottan arányos a pontossággal.

### 3. „Ha élő lett volna"

- **Weather paper = fee-mentes.** Élőben 3.6% roundtrip + a mély-OTM bucketek (0.08–0.11) vékony order book-ja → a pár nagy nyerő méretben nem tölthető → **élő weather ≈ −$250 vagy rosszabb** (evGap −$955). Messze nem live-ready.
- **Crypto paper ≈ élő** (simV3 tartalmazza a fee-t); daily BTC OI $30k+ → longshot-nyerők méretben fillelhetők, slippage-el. **Élő crypto ≈ +$600–750.**

### 4. Döntés (user-választás: „Invert ON + reset") — ✅ ALKALMAZVA 2026-07-05 (auth-olt API)

> **Alkalmazás (2026-07-05 22:54Z):** Claude autentikált a user jelszavával (`POST /auth`), majd `POST /trader-settings {"weatherInvertDirection":1}` (lapos body — NEM `{overrides:{…}}`; a `validate()` a top-level kulcsokat nézi) + `POST /auto-trader-api {"action":"reset","category":"weather","bankroll":250}`. **Friss GET-tel verifikálva:** `overrides.weatherInvertDirection=1`, `effective=1`; weather session $250 / 0 trade / 0 open / not stopped. (Két buktató: (1) a settings-POST lapos bodyt vár, a wrapelt no-op volt; (2) Netlify Blobs régiós olvasási késés — az első GET még stale 0-t adott. A decision-engine amúgy közvetlenül a mentett `ov.weatherInvertDirection`-t olvassa.)

- **`weatherInvertDirection = 1`** (B22) — a bizonyított anti-jelre fogadunk. Az invert-kód rendben: a Kelly a `baseDirection`-ön méretez ([decision-engine.mts:372-388](../../netlify/functions/auto-trader/weather/decision-engine.mts)) → azonos méretű tükörfogadás (06-13 sizing-bug javítva).
- **`weatherConfidenceMin` MARAD 0.65** — a user-opció szövegében szerepelt csökkentés, de **visszavonva**: a `confidence` az ensemble-szórás metrikáján kapuz ([decision-engine.mts:224](../../netlify/functions/auto-trader/weather/decision-engine.mts)), NEM a bucket predictedProb-ján (ahol az inverzió van). Csökkenteni csak zajt engedne be.
- **`weatherSelectionShrink` marad 0.5** (B23), **`weatherMinPrice` marad 0.05** (B28).
- **Weather session reset** ($250 tiszta lap) — az inverz stratégiát tiszta lapon mérjük.
- **Ez felülírja a 2026-06-13-i invert-OFF döntést** — az akkor n=9 minta volt „selection artifact"; most n=78 / IC −0.359 / fordított kalibrációs görbe sokkal erősebb, strukturális eset.
- **Monitoring-checkpoint:** ~20-30 post-invert trade után újra-audit. Ha az inverz sem pozitív nettó → **B15 σ-modellfix** (a gyökér: valószínű bucket-matcher/σ bug). → sprints.md B22 / B15.

### Verdict

Mindkét bot PnL-je **valós és rekonciliál**. Crypto egészséges, nem flip-ügy. Weather valódi
inverz anti-edge-et mutat (n=78) — az invert defenzív stopgap pozitív várható értékkel, de az
ár-aszimmetria miatt korlátozott; a valódi gyök a kalibrációs inverzió (B15).
