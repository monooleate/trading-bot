# Weather Module Patch (2026-04-21)

Three-part patch to the existing weather auto-trader, implementing
`edgecalc-weather-patch.md`. All changes are additive or in-place fixes —
the paper-trading flow and NDJSON log schema remain backwards-compatible.

---

## Fix 1 — Settlement station corrections

Polymarket weather markets settle on **airport METAR** data, not city-center
values. The following stations were wrong and have been corrected against
[alteregoeth-ai/weatherbot](https://github.com/alteregoeth-ai/weatherbot):

| City       | Was    | Now    | Note                                |
|------------|--------|--------|-------------------------------------|
| London     | EGLL   | **EGLC** | London City, not Heathrow         |
| New York   | KNYC   | **KLGA** | LaGuardia, not Central Park / JFK |
| Dallas     | *(missing)* | **KDAL** | Love Field, NOT KDFW          |
| Tokyo      | *(missing)* | **RJTT** | Haneda, NOT Narita (RJAA)      |

Unchanged (already correct): Chicago KORD, Miami KMIA, Seattle KSEA,
Atlanta KATL, Shanghai ZSPD, Los Angeles KLAX, Hong Kong VHHH, Seoul RKSS.

Coordinates, timezone, and `city_offset` updated to match the new stations
(the old values pointed at the old airports). A regression guard asserts
all critical mappings:

```bash
npx tsx netlify/functions/auto-trader/weather/station-config.test.mts
# Stations: 8/8 passed
# All checks passed.
```

Files touched:
- `netlify/functions/auto-trader/weather/station-config.mts`
- `netlify/functions/auto-trader/weather/station-config.test.mts` (new)

---

## Fix 2 — 31-member GFS ensemble (opt-in)

The original forecast engine blended GFS + ECMWF + NOAA with fixed weights.
This patch adds an optional **31-member GFS ensemble** from Open-Meteo's
`/v1/ensemble` endpoint ([suislanchez/polymarket-kalshi-weather-bot](https://github.com/suislanchez/polymarket-kalshi-weather-bot)
approach).

**Opt-in** via environment variable:

```env
USE_ENSEMBLE=true
```

When enabled, `getForecast()` fetches the ensemble in parallel with the
existing models. If ≥5 members return, the ensemble mean replaces the fixed
blend and the confidence score is computed from the ensemble's standard
deviation (tighter distribution → higher confidence).

**Graceful fallback**: every failure path (timeout, malformed response,
fewer than 5 members, `USE_ENSEMBLE=false`) returns `null` and the caller
silently falls back to the original GFS+ECMWF+NOAA blend. The ensemble
module never throws.

The ensemble distribution is exposed on the `ForecastResult` as
`ensembleDetail` so downstream code (e.g. bucket matching) can vote
directly across members if desired:

```ts
if (forecast.ensembleDetail) {
  const pAbove78C = ensembleProbAbove(forecast.ensembleDetail, 78);
  // → fraction of 31 GFS members predicting daily max ≥ 78°C
}
```

Files touched:
- `netlify/functions/auto-trader/weather/ensemble-forecast.mts` (new)
- `netlify/functions/auto-trader/weather/forecast-engine.mts`

---

## Fix 3 — Dynamic Error Balancing (DEB)

Fixed `GFS 60% / ECMWF 40%` weights don't adapt to per-city model
accuracy. DEB maintains a rolling 30-trade window per city of
`|predicted - actual|` for each model and reweights inversely proportional
to mean absolute error.

**Bootstrap guardrail**: until a city has ≥10 resolved samples, DEB returns
the original fixed defaults — so existing installs behave identically until
real feedback accumulates.

**Blend with prior**: even after DEB kicks in, weights are blended 60/40
with the defaults (`w_final = 0.6 * w_deb + 0.4 * w_default`). This
prevents overfitting to small sample windows.

**Storage**: Netlify Blobs (`weather-deb-v1`), keyed per city. Each city
has its own weight profile — ECMWF might dominate in London while GFS
dominates in Chicago.

**Feedback loop** (`index.mts` trade-close path):
1. Trade closes → we have per-model forecasts from `ForecastResult`
2. In paper mode: synthesise an "actual" ~ N(ensembleMean, 1°C) to
   exercise the DEB pipeline without biasing any model systematically
3. In live mode: TODO — replace synthetic actual with real METAR
   settlement temp via a reconciliation job (out of scope for this patch)
4. `recordDebSample()` appends to the rolling window and updates weights

Diagnostic accessor:

```ts
import { getDebDiagnostics } from "./deb.mts";
const diag = await getDebDiagnostics("london");
// { sampleCount, bootstrapping, weights, recentSamples }
```

Files touched:
- `netlify/functions/auto-trader/weather/deb.mts` (new)
- `netlify/functions/auto-trader/weather/forecast-engine.mts` (pulls
  DEB weights, passes to `computeEnsemble`)
- `netlify/functions/auto-trader/weather/index.mts` (records samples on
  trade close)

---

## Backwards compatibility

- `ForecastResult` gained two optional fields (`ensembleDetail`,
  `modelWeightsUsed`). All existing fields unchanged.
- `computeEnsemble` signature added a `debWeights` parameter, but the
  function is file-local — no external callers affected.
- `ClosedTrade` schema unchanged. DEB samples live in a separate
  Blobs store, not in the trade log.
- Without `USE_ENSEMBLE=true` and with < 10 DEB samples per city,
  forecast behaviour is identical to pre-patch.

## Environment variables

```env
# Fix 2
USE_ENSEMBLE=true     # opt-in for 31-member GFS ensemble

# Fix 3 uses no env vars — constants in deb.mts:
#   MIN_TRADES_FOR_DEB = 10
#   ROLLING_WINDOW     = 30
```

## Definition of Done ✓

- [x] Dallas = KDAL (not KDFW), London = EGLC (not EGLL)
- [x] Regression guard for critical station mappings (`station-config.test.mts`)
- [x] `USE_ENSEMBLE=true` activates ensemble path
- [x] Ensemble failure → automatic fallback to GFS+ECMWF+NOAA blend
- [x] DEB updates weights after trade close
- [x] DEB returns fixed defaults when sample count < 10
- [x] NDJSON log schema unchanged (all extensions additive / out-of-band)
- [x] Paper-mode trading flow unchanged
