// netlify/functions/auto-trader/weather/metar-fetcher.mts
//
// Real METAR observation fetch for weather paper-trade reconciliation.
//
// Source: aviationweather.gov public API (no key required).
// Endpoint: https://aviationweather.gov/api/data/metar
//   ?ids=<ICAO>&format=json&hours=<N>
//
// Each METAR observation returns:
//   - obsTime    (epoch seconds, UTC)
//   - temp       (°C, decoded from the original Fahrenheit-rounded METAR)
//   - rawOb      (the raw METAR string, includes a trailing "T01970180" group
//                 that's the precise pre-rounding tenths-°C reading)
//
// We pull a wide window (default 36h) and filter rows by station-local date
// to compute the daily max temperature — which is exactly what Polymarket
// settles weather markets on.

const TIMEOUT  = 9000;
const ENDPOINT = "https://aviationweather.gov/api/data/metar";

export interface MetarObservation {
  obsTimeUtc: string;        // ISO UTC
  obsTimeLocal: string;      // ISO in station tz (date portion = local day)
  tempC: number;             // °C (precise, from "T-group" if available)
  tempCRounded: number;      // °C corresponding to METAR's integer °F
  raw: string;               // raw METAR string
}

export interface MetarDayResult {
  station:        string;        // ICAO
  targetDate:     string;        // YYYY-MM-DD (station-local)
  dailyMaxC:      number;        // observed daily-max in °C (settlement value)
  observationCount: number;
  earliest:       string | null; // ISO of earliest matching observation
  latest:         string | null; // ISO of latest matching observation
  observations:   MetarObservation[];
}

// ─── Local-date helpers ───────────────────────────────────────────────────

// Format a Date as YYYY-MM-DD in a given IANA tz. Uses Intl, which is
// available in the Netlify Functions runtime (Node 20+).
function localDate(date: Date, tz: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  });
  return fmt.format(date); // en-CA gives YYYY-MM-DD
}

// Format a Date as ISO with the local time portion (no offset).
function localIsoTime(date: Date, tz: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const get = (t: string) => parts.find(p => p.type === t)?.value || "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

// Decode the precise "T-group" tenths-°C reading from a raw METAR.
// Format: T<sign><tens><units><tenths>... (5 digits → integer-tenths °C)
//   T01970180 = +19.7°C / +18.0°C dewpoint
//   T10470050 = -4.7°C  / -5.0°C  dewpoint
function parseMetarTGroup(raw: string): number | null {
  // The T-group is a remark token, typically near the end. Match
  //   ' T' + 8 digits exactly, with the first being 0 or 1 (sign).
  const m = raw.match(/\sT([01]\d{3})(\d{4})/);
  if (!m) return null;
  const tempPart = m[1]; // 4 digits: sign + 3-digit tenths
  const sign = tempPart[0] === "1" ? -1 : 1;
  const tenths = parseInt(tempPart.slice(1), 10);
  if (!Number.isFinite(tenths)) return null;
  return sign * tenths / 10;
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Fetch METAR observations for the given station and compute the
 * station-local daily max temperature for `targetDate` (YYYY-MM-DD in `tz`).
 *
 * Returns null on any failure (HTTP error, malformed response, no observations
 * matching the target date). Caller decides whether to retry later or fall
 * back to a different settlement source.
 */
export async function fetchMetarDailyMax(
  icao:       string,
  targetDate: string,             // station-local YYYY-MM-DD
  tz:         string,             // IANA timezone of the station
  hoursBack:  number = 36,        // window relative to now
): Promise<MetarDayResult | null> {
  const url =
    `${ENDPOINT}?ids=${encodeURIComponent(icao)}&format=json&hours=${hoursBack}`;

  let raw: any;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT),
      headers: { Accept: "application/json", "User-Agent": "EdgeCalc-Weather/1.0" },
    });
    if (!res.ok) return null;
    raw = await res.json();
  } catch {
    return null;
  }

  if (!Array.isArray(raw)) return null;

  const observations: MetarObservation[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;

    // The API returns `obsTime` either as an epoch-seconds number or an
    // ISO string ("reportTime"). Both shapes are observed in the wild.
    const obsEpoch =
      typeof row.obsTime === "number" ? row.obsTime
      : typeof row.obsTime === "string" ? Math.floor(new Date(row.obsTime).getTime() / 1000)
      : NaN;
    if (!Number.isFinite(obsEpoch)) continue;
    const utc = new Date(obsEpoch * 1000);

    // Filter rows to the target station-local day. Days are checked in tz to
    // avoid UTC-vs-local edge cases (a 23:50 local observation could fall
    // into the next UTC day).
    if (localDate(utc, tz) !== targetDate) continue;

    // Prefer the precise T-group; fall back to the integer °C field
    const rawStr = typeof row.rawOb === "string" ? row.rawOb : "";
    const precise = parseMetarTGroup(rawStr);
    const intC    = typeof row.temp === "number" ? row.temp : NaN;
    const tempC   = Number.isFinite(precise!) ? precise! : intC;
    if (!Number.isFinite(tempC)) continue;

    observations.push({
      obsTimeUtc:   utc.toISOString(),
      obsTimeLocal: localIsoTime(utc, tz),
      tempC,
      tempCRounded: Number.isFinite(intC) ? intC : tempC,
      raw:          rawStr,
    });
  }

  if (observations.length === 0) return null;

  observations.sort((a, b) => a.obsTimeUtc.localeCompare(b.obsTimeUtc));
  const dailyMaxC = observations.reduce(
    (m, o) => o.tempC > m ? o.tempC : m,
    observations[0].tempC,
  );

  return {
    station:          icao,
    targetDate,
    dailyMaxC:        parseFloat(dailyMaxC.toFixed(2)),
    observationCount: observations.length,
    earliest:         observations[0].obsTimeUtc,
    latest:           observations[observations.length - 1].obsTimeUtc,
    observations,
  };
}

/**
 * Determine the *settlement bucket* for a given observed daily-max
 * temperature, given the bucket lineup from the market.
 *
 * Polymarket settles weather markets on °F-rounded METAR data, so we
 * convert to °F first, round, and then check which bucket label that
 * °F (back-converted to °C) falls into. Each bucket label declares its
 * center temp via parseTempFromLabel — we pick the bucket whose center
 * is closest to the settlement °C, with explicit edge handling for
 * "X°C or below" and "X°C or higher" lower/upper-tail buckets.
 */
export function bucketFromDailyMax(
  dailyMaxC: number,
  buckets:   { label: string; tempC: number | null }[],
): { winningLabel: string; settlementC: number } {
  // METAR-style rounding: °C → °F → integer → °C
  const f = dailyMaxC * 9 / 5 + 32;
  const fInt = Math.round(f);
  const settlementC = parseFloat((((fInt - 32) * 5) / 9).toFixed(2));

  // Sort buckets by tempC ascending so we can find the right slot
  const valid = buckets
    .filter(b => b.tempC !== null)
    .map(b => ({ label: b.label, tempC: b.tempC! }))
    .sort((a, b) => a.tempC - b.tempC);

  if (valid.length === 0) {
    return { winningLabel: "", settlementC };
  }

  // Tail buckets: "X or below" / "X or higher". Detect via the original label.
  const lowerBucket = valid[0];
  const upperBucket = valid[valid.length - 1];
  const isLowerTail = /\bor\s+below\b|\bor\s+lower\b/i.test(lowerBucket.label);
  const isUpperTail = /\bor\s+(higher|above|more)\b/i.test(upperBucket.label);

  if (isLowerTail && settlementC <= lowerBucket.tempC) {
    return { winningLabel: lowerBucket.label, settlementC };
  }
  if (isUpperTail && settlementC >= upperBucket.tempC) {
    return { winningLabel: upperBucket.label, settlementC };
  }

  // For interior buckets, pick the one whose center is nearest. Buckets are
  // 1°C wide on Polymarket weather markets, so within ±0.5°C of the center
  // counts as that bucket.
  let best = valid[0];
  let bestDist = Math.abs(settlementC - best.tempC);
  for (const b of valid) {
    const d = Math.abs(settlementC - b.tempC);
    if (d < bestDist) { bestDist = d; best = b; }
  }
  return { winningLabel: best.label, settlementC };
}
