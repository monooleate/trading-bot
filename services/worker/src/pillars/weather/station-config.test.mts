// netlify/functions/auto-trader/weather/station-config.test.mts
// Regression guard for the Polymarket settlement-station mapping.
// Not a Netlify function (lives in a subdirectory → treated as library code).
//
// Run directly with: npx tsx netlify/functions/auto-trader/weather/station-config.test.mts
//
// Ground truth: the station each market's own rules name. The earliest
// disruptive mistakes (alteregoeth-ai/weatherbot mapping) were:
//   - London using EGLL (Heathrow) instead of EGLC (London City)
//   - Dallas using KDFW (Fort Worth) instead of KDAL (Love Field)
// Both produced 3-8°F settlement discrepancies.
//
// B71 (2026-09-10): five more were wrong against the live rules — Hobby, not
// KIAH; Incheon, not RKSS; the Hong Kong Observatory, not VHHH; Buckley SFB,
// not KDEN; Le Bourget, not LFPG (daily-max gaps up to +1.24 °C mean). The
// settlement-key checks below pin the detector that makes the next such
// change loud instead of silent.

import {
  SETTLEMENT_STATIONS,
  getStation,
  getSeason,
  getStationById,
  settlementPhrase,
  settlementStationMismatch,
} from "./station-config.mts";

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
  { city: "shenzhen", icao: "ZGSZ",
    latApprox: [22.6393, 0.05], lonApprox: [113.8107, 0.05],
    notes: "Bao'an Intl — Pearl River Delta (2026-05-30 coverage add)" },
  // ── B71 (2026-09-10) ──
  { city: "houston",   icao: "KHOU", notIcao: "KIAH",
    latApprox: [29.6375, 0.05], lonApprox: [-95.2824, 0.05],
    notes: "William P. Hobby — NOT George Bush Intercontinental (KIAH); +0.95 °C mean gap" },
  { city: "seoul",     icao: "RKSI", notIcao: "RKSS",
    latApprox: [37.4667, 0.05], lonApprox: [126.4500, 0.05],
    notes: "Incheon — NOT Gimpo (RKSS); +1.24 °C mean gap" },
  { city: "hong-kong", icao: "HKO",  notIcao: "VHHH",
    latApprox: [22.3019, 0.05], lonApprox: [114.1742, 0.05],
    notes: "Hong Kong Observatory — NOT the airport METAR (VHHH); +0.55 °C mean gap" },
  { city: "denver",    icao: "KBKF", notIcao: "KDEN",
    latApprox: [39.7017, 0.05], lonApprox: [-104.7517, 0.05],
    notes: "Buckley Space Force Base — NOT Denver Intl (KDEN)" },
  { city: "paris",     icao: "LFPB", notIcao: "LFPG",
    latApprox: [48.9672, 0.05], lonApprox: [2.4272, 0.05],
    notes: "Paris–Le Bourget — NOT Charles de Gaulle (LFPG)" },
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

// ─── B71: the settlement-station detector ─────────────────────────────────
// Rules text as the live listings phrased it on 2026-09-10 (trimmed).
const LIVE_RULES: { city: string; rules: string }[] = [
  { city: "houston",   rules: "…the highest temperature recorded by NOAA at the William P. Hobby Airport Station in degrees Fahrenheit on 10 Sep '26." },
  { city: "seoul",     rules: "…recorded by NOAA at the Incheon Intl Airport Station in degrees Celsius on 11 Sep '26." },
  { city: "hong-kong", rules: "…the highest temperature recorded by the Hong Kong Observatory in degrees Celsius on 10 Sep '26." },
  { city: "denver",    rules: "…recorded by NOAA at the Buckley Space Force Base Station in degrees Fahrenheit on 10 Sep '26." },
  { city: "paris",     rules: "…recorded by NOAA at the Paris-Le Bourget Airport Station in degrees Celsius on 10 Sep '26." },
  { city: "chicago",   rules: "…recorded by NOAA at the Chicago O'Hare Intl Airport Station in degrees Fahrenheit on 10 Sep '26." },
  { city: "ankara",    rules: "…recorded by NOAA at the Esenboğa Intl Airport Station in degrees Celsius on 10 Sep '26." },
  { city: "madrid",    rules: "…recorded by NOAA at the Adolfo Suárez Madrid-Barajas Airport Station in degrees Celsius on 10 Sep '26." },
  { city: "shenzhen",  rules: "…recorded by NOAA at the Shenzhen Bao'an International Airport Station in degrees Celsius on 11 Sep '26." },
  { city: "london",    rules: "…recorded by NOAA at the London City Airport Station in degrees Celsius on 10 Sep '26." },
];

export function validateSettlementKeys(): Failure[] {
  const failures: Failure[] = [];
  const fail = (city: string, message: string) => failures.push({ city, message });

  // Every live rules text must agree with the corrected config.
  for (const { city, rules } of LIVE_RULES) {
    const got = settlementStationMismatch(rules, getStation(city));
    if (got !== null) fail(city, `live rules flagged as a mismatch: "${got}"`);
  }

  // A dot inside the station name must not truncate the phrase.
  const hobby = settlementPhrase(LIVE_RULES[0].rules);
  if (hobby !== "William P. Hobby Airport") fail("houston", `phrase parse: got "${hobby}"`);

  // The detector catches the class it exists for: the pre-B71 Denver entry
  // (Denver Intl) against rules that name Buckley.
  const old = settlementStationMismatch(LIVE_RULES[3].rules, { settlementKey: "denverinternational" });
  if (old !== "Buckley Space Force Base") fail("denver", `stale station not flagged: got ${JSON.stringify(old)}`);

  // No verdict without a station phrase, or without a verified key.
  if (settlementStationMismatch("Resolves per the 'Daily Observations' table.", getStation("london")) !== null) {
    fail("london", "rules without a station phrase must not be flagged");
  }
  if (settlementStationMismatch(LIVE_RULES[1].rules, getStation("lagos")) !== null) {
    fail("lagos", "an unverified station (no settlementKey) must not be flagged");
  }

  // Coverage: every city except lagos (no live market on 2026-09-10) is verified.
  for (const [city, cfg] of Object.entries(SETTLEMENT_STATIONS)) {
    if (city !== "lagos" && !cfg.settlementKey) fail(city, "settlementKey missing");
  }

  // Station ids must be unique — they key the per-station EMOS / multi-model stores.
  const ids = Object.values(SETTLEMENT_STATIONS).map((s) => s.icao);
  if (new Set(ids).size !== ids.length) fail("(all)", "duplicate station id");

  // Hong Kong settles on the Observatory's own report; everyone else on METAR.
  if (getStation("hong-kong")?.obsSource !== "hko") fail("hong-kong", "obsSource must be hko");
  if (getStationById("HKO") !== getStation("hong-kong")) fail("hong-kong", "getStationById(HKO) mismatch");
  for (const [city, cfg] of Object.entries(SETTLEMENT_STATIONS)) {
    if (city !== "hong-kong" && (cfg.obsSource ?? "metar") !== "metar") fail(city, "unexpected obsSource");
  }

  return failures;
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
  const keyFailures = validateSettlementKeys();
  const seasonFailures = validateSeasonHelper();
  const all = [...stationResult.failures, ...keyFailures, ...seasonFailures];

  const lines: string[] = [];
  lines.push(`Stations: ${stationResult.passed}/${EXPECTED.length} passed`);
  if (stationResult.failures.length) {
    lines.push("Failures:");
    for (const f of stationResult.failures) lines.push(`  ✗ ${f.city}: ${f.message}`);
  }
  if (keyFailures.length) {
    lines.push("Settlement-key failures:");
    for (const f of keyFailures) lines.push(`  ✗ ${f.city}: ${f.message}`);
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
