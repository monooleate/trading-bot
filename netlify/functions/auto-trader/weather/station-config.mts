// Settlement station lookup table for Polymarket weather markets.
// Polymarket uses official airport METAR data for settlement,
// NOT city weather app values. The city_offset corrects for the
// systematic difference between station and city center temps.
//
// Verified against alteregoeth-ai/weatherbot settlement-station mapping:
//   NYC     → KLGA (LaGuardia)      — NOT KNYC, NOT KJFK
//   Chicago → KORD (O'Hare)
//   Miami   → KMIA (Miami Intl)
//   Dallas  → KDAL (Love Field)     — NOT KDFW (Dallas/Fort Worth)
//   Seattle → KSEA (Sea-Tac)
//   Atlanta → KATL (Hartsfield)
//   London  → EGLC (London City)    — NOT EGLL (Heathrow)
//   Tokyo   → RJTT (Haneda)         — NOT RJAA (Narita)

export interface StationConfig {
  icao: string;
  lat: number;
  lon: number;
  tz: string;
  city_offset: number; // °C: positive = city warmer than station
  peakHoursUTC: Record<string, number[]>; // season → peak hour(s) UTC
}

export const SETTLEMENT_STATIONS: Record<string, StationConfig> = {
  shanghai: {
    icao: "ZSPD",
    lat: 31.1443,
    lon: 121.8083,
    tz: "Asia/Shanghai",
    city_offset: -1.5,
    peakHoursUTC: {
      summer: [3, 4, 5],    // 11–13 CST
      winter: [4, 5, 6],
      autumn: [2, 3, 4],
      spring: [4, 5, 6],
    },
  },
  london: {
    // EGLC = London City Airport (inner-east London, on the Thames).
    // Polymarket settles on EGLC, not EGLL (Heathrow) — average spread ~1-2°C.
    icao: "EGLC",
    lat: 51.5053,
    lon: 0.0553,
    tz: "Europe/London",
    city_offset: -0.2,
    peakHoursUTC: {
      summer: [13, 14, 15],
      winter: [12, 13],
      autumn: [12, 13, 14],
      spring: [13, 14],
    },
  },
  "new-york": {
    // KLGA = LaGuardia. Polymarket settles on LGA, not KNYC (Central Park)
    // and not KJFK. LGA is in Queens near the harbour, slightly cooler than
    // Manhattan midday.
    icao: "KLGA",
    lat: 40.7772,
    lon: -73.8726,
    tz: "America/New_York",
    city_offset: 0.2,
    peakHoursUTC: {
      summer: [19, 20, 21],
      winter: [18, 19, 20],
      autumn: [18, 19, 20],
      spring: [19, 20],
    },
  },
  "los-angeles": {
    icao: "KLAX",
    lat: 33.9425,
    lon: -118.4081,
    tz: "America/Los_Angeles",
    city_offset: 1.0,
    peakHoursUTC: {
      summer: [21, 22, 23],
      winter: [21, 22],
      autumn: [21, 22],
      spring: [21, 22, 23],
    },
  },
  chicago: {
    icao: "KORD",
    lat: 41.9742,
    lon: -87.9073,
    tz: "America/Chicago",
    city_offset: -0.5,
    peakHoursUTC: {
      summer: [19, 20, 21],
      winter: [19, 20],
      autumn: [19, 20],
      spring: [19, 20, 21],
    },
  },
  "hong-kong": {
    icao: "VHHH",
    lat: 22.308,
    lon: 113.9185,
    tz: "Asia/Hong_Kong",
    city_offset: -1.0,
    peakHoursUTC: {
      summer: [5, 6, 7],
      winter: [5, 6, 7],
      autumn: [5, 6],
      spring: [5, 6, 7],
    },
  },
  seoul: {
    icao: "RKSS",
    lat: 37.4692,
    lon: 126.4508,
    tz: "Asia/Seoul",
    city_offset: -1.0,
    peakHoursUTC: {
      summer: [4, 5, 6],
      winter: [4, 5],
      autumn: [4, 5],
      spring: [4, 5, 6],
    },
  },
  miami: {
    icao: "KMIA",
    lat: 25.7959,
    lon: -80.287,
    tz: "America/New_York",
    city_offset: 0.0,
    peakHoursUTC: {
      summer: [19, 20, 21],
      winter: [19, 20],
      autumn: [19, 20],
      spring: [19, 20, 21],
    },
  },
  seattle: {
    icao: "KSEA",
    lat: 47.4502,
    lon: -122.3088,
    tz: "America/Los_Angeles",
    city_offset: -0.5,
    peakHoursUTC: {
      summer: [21, 22, 23],
      winter: [21, 22],
      autumn: [21, 22],
      spring: [21, 22, 23],
    },
  },
  atlanta: {
    icao: "KATL",
    lat: 33.6407,
    lon: -84.4277,
    tz: "America/New_York",
    city_offset: 0.5,
    peakHoursUTC: {
      summer: [19, 20, 21],
      winter: [19, 20],
      autumn: [19, 20],
      spring: [19, 20, 21],
    },
  },
  dallas: {
    // KDAL = Dallas Love Field. Polymarket settles on KDAL, NOT KDFW
    // (Dallas/Fort Worth International). KDAL is inside the city, minimal
    // urban-vs-airport differential.
    icao: "KDAL",
    lat: 32.8471,
    lon: -96.8518,
    tz: "America/Chicago",
    city_offset: 0.3,
    peakHoursUTC: {
      summer: [20, 21, 22],
      winter: [20, 21],
      autumn: [20, 21],
      spring: [20, 21, 22],
    },
  },
  tokyo: {
    // RJTT = Haneda. Polymarket settles on RJTT, NOT RJAA (Narita).
    // RJTT is on Tokyo Bay inside the urban area; close to city center temps.
    icao: "RJTT",
    lat: 35.5494,
    lon: 139.7798,
    tz: "Asia/Tokyo",
    city_offset: -0.5,
    peakHoursUTC: {
      summer: [5, 6, 7],
      winter: [4, 5],
      autumn: [4, 5, 6],
      spring: [5, 6, 7],
    },
  },
  // ─── Coverage extension: cities Polymarket actively lists but we previously
  // dropped silently. Coordinates are the official airport METAR station
  // Polymarket settles on. city_offset is left at 0.0 — the new default
  // behaviour (forecast at airport coords, no further correction) makes any
  // hand-tuned offset value either wrong or redundant. Tune later via the
  // Settings tab once we have closed-trade samples per city.
  madrid: {
    icao: "LEMD", lat: 40.4936, lon: -3.5668,
    tz: "Europe/Madrid", city_offset: 0.0,
    peakHoursUTC: { summer: [14, 15, 16], winter: [13, 14], autumn: [13, 14, 15], spring: [14, 15] },
  },
  paris: {
    icao: "LFPG", lat: 49.0097, lon: 2.5479,
    tz: "Europe/Paris", city_offset: 0.0,
    peakHoursUTC: { summer: [13, 14, 15], winter: [12, 13], autumn: [12, 13, 14], spring: [13, 14] },
  },
  milan: {
    icao: "LIMC", lat: 45.6306, lon: 8.7281,
    tz: "Europe/Rome", city_offset: 0.0,
    peakHoursUTC: { summer: [13, 14, 15], winter: [12, 13], autumn: [12, 13, 14], spring: [13, 14] },
  },
  munich: {
    icao: "EDDM", lat: 48.3537, lon: 11.7750,
    tz: "Europe/Berlin", city_offset: 0.0,
    peakHoursUTC: { summer: [13, 14, 15], winter: [12, 13], autumn: [12, 13, 14], spring: [13, 14] },
  },
  ankara: {
    icao: "LTAC", lat: 40.1281, lon: 32.9951,
    tz: "Europe/Istanbul", city_offset: 0.0,
    peakHoursUTC: { summer: [11, 12, 13], winter: [10, 11], autumn: [10, 11, 12], spring: [11, 12] },
  },
  lagos: {
    icao: "DNMM", lat: 6.5774, lon: 3.3212,
    tz: "Africa/Lagos", city_offset: 0.0,
    peakHoursUTC: { summer: [13, 14, 15], winter: [13, 14, 15], autumn: [13, 14, 15], spring: [13, 14, 15] },
  },
  "sao-paulo": {
    icao: "SBGR", lat: -23.4356, lon: -46.4731,
    tz: "America/Sao_Paulo", city_offset: 0.0,
    // Southern hemisphere — peak hours are local solar noon ~15-18 UTC.
    peakHoursUTC: { summer: [16, 17, 18], winter: [16, 17], autumn: [16, 17], spring: [16, 17, 18] },
  },
  austin: {
    icao: "KAUS", lat: 30.1945, lon: -97.6699,
    tz: "America/Chicago", city_offset: 0.0,
    peakHoursUTC: { summer: [20, 21, 22], winter: [20, 21], autumn: [20, 21], spring: [20, 21, 22] },
  },
  // ─── 2026-05-09 coverage extension #2 — additional cities Polymarket
  // actively lists. Coordinates are the official airport METAR station.
  guangzhou: {
    icao: "ZGGG", lat: 23.3924, lon: 113.2988,
    tz: "Asia/Shanghai", city_offset: 0.0,
    peakHoursUTC: { summer: [6, 7, 8], winter: [6, 7], autumn: [6, 7], spring: [6, 7, 8] },
  },
  denver: {
    icao: "KDEN", lat: 39.8617, lon: -104.6731,
    tz: "America/Denver", city_offset: 0.0,
    peakHoursUTC: { summer: [21, 22, 23], winter: [20, 21], autumn: [21, 22], spring: [21, 22, 23] },
  },
  warsaw: {
    icao: "EPWA", lat: 52.1657, lon: 20.9671,
    tz: "Europe/Warsaw", city_offset: 0.0,
    peakHoursUTC: { summer: [13, 14, 15], winter: [12, 13], autumn: [12, 13, 14], spring: [13, 14] },
  },
  houston: {
    icao: "KIAH", lat: 29.9844, lon: -95.3414,
    tz: "America/Chicago", city_offset: 0.0,
    peakHoursUTC: { summer: [20, 21, 22], winter: [20, 21], autumn: [20, 21], spring: [20, 21, 22] },
  },
  toronto: {
    icao: "CYYZ", lat: 43.6777, lon: -79.6248,
    tz: "America/Toronto", city_offset: 0.0,
    peakHoursUTC: { summer: [19, 20, 21], winter: [18, 19], autumn: [18, 19, 20], spring: [19, 20] },
  },
  helsinki: {
    icao: "EFHK", lat: 60.3172, lon: 24.9633,
    tz: "Europe/Helsinki", city_offset: 0.0,
    peakHoursUTC: { summer: [12, 13, 14], winter: [11, 12], autumn: [11, 12, 13], spring: [12, 13] },
  },
};

// ─── Helpers ──────────────────────────────────────────────

export function getStation(city: string): StationConfig | null {
  return SETTLEMENT_STATIONS[city.toLowerCase()] ?? null;
}

export function getSeason(date: Date, lat: number): string {
  const month = date.getMonth(); // 0-indexed
  const isNorthern = lat >= 0;
  if (isNorthern) {
    if (month >= 2 && month <= 4) return "spring";
    if (month >= 5 && month <= 7) return "summer";
    if (month >= 8 && month <= 10) return "autumn";
    return "winter";
  }
  // Southern hemisphere (not used yet, but ready)
  if (month >= 2 && month <= 4) return "autumn";
  if (month >= 5 && month <= 7) return "winter";
  if (month >= 8 && month <= 10) return "spring";
  return "summer";
}

export function getAllCities(): string[] {
  return Object.keys(SETTLEMENT_STATIONS);
}
