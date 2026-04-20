// Settlement station lookup table for Polymarket weather markets.
// Polymarket uses official airport METAR data for settlement,
// NOT city weather app values. The city_offset corrects for the
// systematic difference between station and city center temps.

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
    icao: "EGLL",
    lat: 51.4775,
    lon: -0.4614,
    tz: "Europe/London",
    city_offset: -0.5,
    peakHoursUTC: {
      summer: [13, 14, 15],
      winter: [12, 13],
      autumn: [12, 13, 14],
      spring: [13, 14],
    },
  },
  "new-york": {
    icao: "KNYC",
    lat: 40.7789,
    lon: -73.9692,
    tz: "America/New_York",
    city_offset: 0.0,
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
