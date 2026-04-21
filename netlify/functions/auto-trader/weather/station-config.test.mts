// netlify/functions/auto-trader/weather/station-config.test.mts
// Regression guard for the Polymarket settlement-station mapping.
// Not a Netlify function (lives in a subdirectory → treated as library code).
//
// Run directly with: npx tsx netlify/functions/auto-trader/weather/station-config.test.mts
//
// Ground truth: alteregoeth-ai/weatherbot settlement-station mapping.
// The two most disruptive historical mistakes were:
//   - London using EGLL (Heathrow) instead of EGLC (London City)
//   - Dallas using KDFW (Fort Worth) instead of KDAL (Love Field)
// Both produced 3-8°F settlement discrepancies.

import { SETTLEMENT_STATIONS, getStation, getSeason } from "./station-config.mts";

interface Expectation {
  city:        string;
  icao:        string;
  notIcao?:    string;    // value that MUST NOT be used
  latApprox?:  [number, number];  // [lat, tolerance]
  lonApprox?:  [number, number];
  notes?:      string;
}

const EXPECTED: Expectation[] = [
  { city: "new-york", icao: "KLGA", notIcao: "KNYC",
    latApprox: [40.7772, 0.05], lonApprox: [-73.8726, 0.05],
    notes: "LaGuardia — not KNYC/Central Park, not KJFK" },
  { city: "chicago",  icao: "KORD", latApprox: [41.9742, 0.05] },
  { city: "miami",    icao: "KMIA", latApprox: [25.7959, 0.05] },
  { city: "dallas",   icao: "KDAL", notIcao: "KDFW",
    latApprox: [32.8471, 0.05], lonApprox: [-96.8518, 0.05],
    notes: "Love Field — NOT Dallas/Fort Worth (KDFW)" },
  { city: "seattle",  icao: "KSEA", latApprox: [47.4502, 0.05] },
  { city: "atlanta",  icao: "KATL", latApprox: [33.6407, 0.05] },
  { city: "london",   icao: "EGLC", notIcao: "EGLL",
    latApprox: [51.5053, 0.05], lonApprox: [0.0553, 0.05],
    notes: "London City — NOT Heathrow (EGLL)" },
  { city: "tokyo",    icao: "RJTT", notIcao: "RJAA",
    latApprox: [35.5494, 0.05], lonApprox: [139.7798, 0.05],
    notes: "Haneda — NOT Narita (RJAA)" },
];

interface Failure { city: string; message: string; }

export function validateStations(): { passed: number; failures: Failure[] } {
  const failures: Failure[] = [];
  let passed = 0;

  for (const e of EXPECTED) {
    const st = getStation(e.city);
    if (!st) {
      failures.push({ city: e.city, message: `missing from SETTLEMENT_STATIONS` });
      continue;
    }

    if (st.icao !== e.icao) {
      failures.push({
        city: e.city,
        message: `ICAO mismatch: expected ${e.icao}, got ${st.icao}` +
                 (e.notes ? ` (${e.notes})` : ""),
      });
      continue;
    }

    if (e.notIcao && st.icao === e.notIcao) {
      failures.push({
        city: e.city,
        message: `using forbidden ICAO ${e.notIcao}. ${e.notes || ""}`,
      });
      continue;
    }

    if (e.latApprox) {
      const [lat, tol] = e.latApprox;
      if (Math.abs(st.lat - lat) > tol) {
        failures.push({
          city: e.city,
          message: `lat drift: expected ~${lat}, got ${st.lat}`,
        });
        continue;
      }
    }
    if (e.lonApprox) {
      const [lon, tol] = e.lonApprox;
      if (Math.abs(st.lon - lon) > tol) {
        failures.push({
          city: e.city,
          message: `lon drift: expected ~${lon}, got ${st.lon}`,
        });
        continue;
      }
    }

    // Sanity: every station must have all 4 season peak-hour arrays
    const seasons = ["summer", "winter", "autumn", "spring"];
    for (const s of seasons) {
      if (!Array.isArray((st.peakHoursUTC as any)[s]) || (st.peakHoursUTC as any)[s].length === 0) {
        failures.push({ city: e.city, message: `peakHoursUTC.${s} missing or empty` });
      }
    }

    // city_offset must be reasonable (-3 to +3 °C)
    if (Math.abs(st.city_offset) > 3) {
      failures.push({
        city: e.city,
        message: `city_offset out of range: ${st.city_offset}°C (expected |v| ≤ 3)`,
      });
    }

    passed++;
  }

  return { passed, failures };
}

// ─── Additional sanity checks ─────────────────────────────────────────────
export function validateSeasonHelper(): Failure[] {
  const failures: Failure[] = [];

  // Northern hemisphere
  if (getSeason(new Date("2026-07-15"), 40) !== "summer")
    failures.push({ city: "(season)", message: "July @ 40°N should be summer" });
  if (getSeason(new Date("2026-01-15"), 40) !== "winter")
    failures.push({ city: "(season)", message: "Jan @ 40°N should be winter" });

  // Southern hemisphere flip
  if (getSeason(new Date("2026-07-15"), -33) !== "winter")
    failures.push({ city: "(season)", message: "July @ 33°S should be winter" });

  return failures;
}

export function validateAll(): { ok: boolean; report: string } {
  const stationResult = validateStations();
  const seasonFailures = validateSeasonHelper();
  const all = [...stationResult.failures, ...seasonFailures];

  const lines: string[] = [];
  lines.push(`Stations: ${stationResult.passed}/${EXPECTED.length} passed`);
  if (stationResult.failures.length) {
    lines.push("Failures:");
    for (const f of stationResult.failures) lines.push(`  ✗ ${f.city}: ${f.message}`);
  }
  if (seasonFailures.length) {
    lines.push("Season helper failures:");
    for (const f of seasonFailures) lines.push(`  ✗ ${f.message}`);
  }
  if (all.length === 0) lines.push("All checks passed.");

  return { ok: all.length === 0, report: lines.join("\n") };
}

// ─── CLI entry ────────────────────────────────────────────────────────────
// Intentionally guarded so `import` of this module doesn't run the check.
// Node sets `process.argv[1]` to the entry file path — compare against our own.
const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("station-config.test.mts") ||
           entry.endsWith("station-config.test.js");
  } catch { return false; }
})();

if (isMain) {
  const { ok, report } = validateAll();
  // eslint-disable-next-line no-console
  console.log(report);
  process.exit(ok ? 0 : 1);
}
