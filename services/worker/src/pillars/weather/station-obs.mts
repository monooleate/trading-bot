// services/worker/src/pillars/weather/station-obs.mts
//
// Realised daily maximum for a settlement station, taken from the source its
// markets actually settle on (B71). Airport stations: METAR via
// aviationweather.gov (metar-fetcher.mts). Hong Kong: the Hong Kong
// Observatory's own daily report — the rules say "recorded by the Hong Kong
// Observatory", and the airport METAR (VHHH) ran +0.55 °C warmer on average
// (Aug 2026, n=31 days).

import { fetchMetarDailyMax } from "./metar-fetcher.mts";
import { getStationById } from "./station-config.mts";

const HKO_API = "https://data.weather.gov.hk/weatherAPI/opendata/opendata.php";
const TIMEOUT = 8000;

export interface StationDailyMax {
  station:          string;
  targetDate:       string;   // station-local YYYY-MM-DD
  dailyMaxC:        number;
  source:           "metar" | "hko";
  observationCount: number;
}

/**
 * The Observatory's own daily maximum from an HKO "Weather and Radiation Level
 * Report" (opendata.php?dataType=RYES). The report dated D carries D's maximum —
 * checked against the official CLMMAXT series on 5/5 August 2026 days. The same
 * payload lists ~30 other stations (Chek Lap Kok is the airport); only
 * `HKOReadingsMaxTemp` settles the market. Null for a missing, blank or
 * implausible reading. Pure.
 */
export function parseHkoRyesMax(json: unknown): number | null {
  const raw = (json as Record<string, unknown> | null | undefined)?.HKOReadingsMaxTemp;
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const v = Number(raw);
  return Number.isFinite(v) && v > -50 && v < 60 ? v : null;
}

/** HKO daily max for `targetDate` (YYYY-MM-DD, Hong Kong time), or null. */
export async function fetchHkoDailyMax(targetDate: string): Promise<StationDailyMax | null> {
  const d = String(targetDate).replace(/-/g, "");
  if (!/^\d{8}$/.test(d)) return null;
  try {
    const res = await fetch(`${HKO_API}?dataType=RYES&lang=en&date=${d}`, {
      signal: AbortSignal.timeout(TIMEOUT),
      headers: { Accept: "application/json", "User-Agent": "EdgeCalc-Weather/1.0" },
    });
    if (!res.ok) return null;
    const v = parseHkoRyesMax(await res.json());
    return v === null
      ? null
      : { station: "HKO", targetDate, dailyMaxC: v, source: "hko", observationCount: 1 };
  } catch {
    return null;
  }
}

/** Where a station's settlement observation comes from. Unknown ids → METAR. Pure. */
export function obsSourceFor(stationId: string): "metar" | "hko" {
  return getStationById(stationId)?.obsSource ?? "metar";
}

/**
 * Realised daily max for `stationId` on the station-local `targetDate`, from the
 * source that station's markets settle on. Same null-on-failure contract as
 * fetchMetarDailyMax; `tz` is only used by the METAR path.
 */
export async function fetchStationDailyMax(
  stationId: string,
  targetDate: string,
  tz: string,
): Promise<StationDailyMax | null> {
  if (obsSourceFor(stationId) === "hko") return fetchHkoDailyMax(targetDate);
  const m = await fetchMetarDailyMax(stationId, targetDate, tz);
  return m
    ? {
        station:          m.station,
        targetDate:       m.targetDate,
        dailyMaxC:        m.dailyMaxC,
        source:           "metar",
        observationCount: m.observationCount,
      }
    : null;
}
