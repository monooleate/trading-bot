// services/worker/src/pillars/weather/pooled-emos-cache.mts
//
// B69 step 2 — loads the multi-model log (`weather-multimodel`), fits the
// pooled mixture's own EMOS (@core/pooled-emos.mts) and caches it in-process.
// Only read when `weatherUseMultiModel` AND `weatherUseEmos` are both ON; the
// legacy GEFS path never touches it.
//
// Refit cadence: hourly. New labels land once a target date's METAR is
// reconciled (at most a few per station per day), so an hourly refit loses
// nothing and keeps the cost at ~18 blob reads per hour. A failed load keeps
// the previous model (or null → raw mixture), never a GEFS-fitted map.

import { fitPooledEmos, type PooledEmosModel, type PooledCalibrationInput } from "@core/pooled-emos.mts";
import { loadSnapshots } from "./multi-model-store.mts";
import { SETTLEMENT_STATIONS } from "./station-config.mts";
import { correctForecast } from "./metar-simulator.mts";

const REFIT_MS = 60 * 60 * 1000;

let _model: PooledEmosModel | null = null;
let _loadedAt = 0;
let _inflight: Promise<PooledEmosModel | null> | null = null;

async function refit(): Promise<PooledEmosModel | null> {
  const icaos = [...new Set(Object.values(SETTLEMENT_STATIONS).map((s) => s.icao))];
  const rows: PooledCalibrationInput[] = [];
  for (const icao of icaos) {
    const snaps = await loadSnapshots(icao).catch(() => []);
    for (const s of snaps) {
      rows.push({
        station: icao,
        ts: s.ts,
        date: s.date,
        leadHours: s.leadHours,
        mean: s.pooledMean,
        sd: s.pooledSd,
        obs: s.obs,
      });
    }
  }
  // Mirror the live μ exactly: the runner calibrates predictedMaxC, which is the
  // mixture mean after METAR rounding (city offset is off in production).
  return fitPooledEmos(rows, { transformMean: (m) => correctForecast(m, 0) });
}

export async function getPooledEmosModel(nowMs = Date.now()): Promise<PooledEmosModel | null> {
  if (_model && nowMs - _loadedAt < REFIT_MS) return _model;
  if (_inflight) return _inflight;
  _inflight = refit()
    .then((m) => {
      if (m) { _model = m; _loadedAt = nowMs; }
      return _model;
    })
    .catch(() => _model)
    .finally(() => { _inflight = null; });
  return _inflight;
}
