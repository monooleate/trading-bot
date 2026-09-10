// Settlement station lookup table for Polymarket weather markets.
//
// Each market's rules name the station whose daily maximum settles it — almost
// always "recorded by NOAA at the <X> Station" (an airport METAR). Hong Kong is
// the exception: it settles on the Hong Kong Observatory's own reading, which
// has no METAR. The city_offset corrects for the systematic difference between
// station and city-centre temps (inactive by default — weatherApplyCityOffset).
//
// B71 (2026-09-10): checked against the live rules of all 26 active cities.
// Five entries pointed at the wrong station. Daily-max gap ours − market over
// 2026-08-01…09-09 (IEM METAR, station-local day; HKO open data for Hong Kong):
//   Houston   KIAH → KHOU (William P. Hobby)         +0.95 °C mean, ≥1 °C on 28/41 days
//   Seoul     RKSS → RKSI (Incheon)                   +1.24 °C mean, ≥1 °C on 28/41 days
//   Hong Kong VHHH → HKO  (Hong Kong Observatory)     +0.55 °C mean, ≥1 °C on 14/31 days
//   Denver    KDEN → KBKF (Buckley Space Force Base)  −0.43 °C mean, ≥1 °C on 13/41 days
//   Paris     LFPG → LFPB (Paris–Le Bourget)          −0.20 °C mean, ≥1 °C on 12/41 days
// On 1 °C buckets a 1 °C bias decides the bucket. `settlementKey` lets the
// market finder notice the next time a listing names a different station.
//
// Earlier verified mapping (alteregoeth-ai/weatherbot):
//   NYC     → KLGA (LaGuardia)      — NOT KNYC, NOT KJFK
//   Chicago → KORD (O'Hare)
//   Miami   → KMIA (Miami Intl)
//   Dallas  → KDAL (Love Field)     — NOT KDFW (Dallas/Fort Worth)
//   Seattle → KSEA (Sea-Tac)
//   Atlanta → KATL (Hartsfield)
//   London  → EGLC (London City)    — NOT EGLL (Heathrow)
//   Tokyo   → RJTT (Haneda)         — NOT RJAA (Narita)

export interface StationConfig {
  /** Station id: the ICAO code of the METAR station, or "HKO" for the Hong Kong
   *  Observatory (not a METAR station — see `obsSource`). Also the key of the
   *  per-station EMOS and multi-model stores. */
  icao: string;
  lat: number;
  lon: number;
  tz: string;
  city_offset: number; // °C: positive = city warmer than station
  peakHoursUTC: Record<string, number[]>; // season → peak hour(s) UTC
  /** Where the realised daily max comes from. Unset = "metar" (aviationweather.gov). */
  obsSource?: "metar" | "hko";
  /** Normalised (a–z0–9 only) fragment of the station name in the market rules,
   *  e.g. "hobby" for "recorded by NOAA at the William P. Hobby Airport Station".
   *  The market finder checks every listing against it (B71). Unset = unverified. */
  settlementKey?: string;
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
    settlementKey: "pudong",
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
    settlementKey: "londoncity",
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
    settlementKey: "laguardia",
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
    settlementKey: "losangelesinternational",
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
    settlementKey: "ohare",
  },
  "hong-kong": {
    // B71: the rules say "recorded by the Hong Kong Observatory" — the HKO
    // headquarters in Tsim Sha Tsui, not the airport METAR (VHHH, Chek Lap Kok),
    // which ran +0.55 °C warmer on average (Aug 2026). HKO has no METAR, so the
    // realised max comes from the HKO open-data daily report (station-obs.mts).
    // city_offset 0: the Observatory already sits in the city.
    icao: "HKO",
    lat: 22.3019,
    lon: 114.1742,
    tz: "Asia/Hong_Kong",
    city_offset: 0.0,
    peakHoursUTC: {
      summer: [5, 6, 7],
      winter: [5, 6, 7],
      autumn: [5, 6],
      spring: [5, 6, 7],
    },
    obsSource: "hko",
    settlementKey: "hongkongobservatory",
  },
  seoul: {
    // B71: Incheon (RKSI). The coordinates were already Incheon's, but the ICAO
    // was Gimpo's (RKSS), so every METAR observation came from Gimpo — +1.24 °C
    // warmer than the settlement station on average (Aug 2026).
    icao: "RKSI",
    lat: 37.4667,
    lon: 126.4500,
    tz: "Asia/Seoul",
    city_offset: -1.0,
    peakHoursUTC: {
      summer: [4, 5, 6],
      winter: [4, 5],
      autumn: [4, 5],
      spring: [4, 5, 6],
    },
    settlementKey: "incheon",
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
    settlementKey: "miamiintl",
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
    settlementKey: "seattletacoma",
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
    settlementKey: "hartsfield",
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
    settlementKey: "lovefield",
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
    settlementKey: "haneda",
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
    settlementKey: "barajas",
  },
  paris: {
    // B71: Paris–Le Bourget (LFPB), not Charles de Gaulle (LFPG).
    icao: "LFPB", lat: 48.9672, lon: 2.4272,
    tz: "Europe/Paris", city_offset: 0.0,
    peakHoursUTC: { summer: [13, 14, 15], winter: [12, 13], autumn: [12, 13, 14], spring: [13, 14] },
    settlementKey: "lebourget",
  },
  milan: {
    icao: "LIMC", lat: 45.6306, lon: 8.7281,
    tz: "Europe/Rome", city_offset: 0.0,
    peakHoursUTC: { summer: [13, 14, 15], winter: [12, 13], autumn: [12, 13, 14], spring: [13, 14] },
    settlementKey: "malpensa",
  },
  munich: {
    icao: "EDDM", lat: 48.3537, lon: 11.7750,
    tz: "Europe/Berlin", city_offset: 0.0,
    peakHoursUTC: { summer: [13, 14, 15], winter: [12, 13], autumn: [12, 13, 14], spring: [13, 14] },
    settlementKey: "munichairport",
  },
  ankara: {
    icao: "LTAC", lat: 40.1281, lon: 32.9951,
    tz: "Europe/Istanbul", city_offset: 0.0,
    peakHoursUTC: { summer: [11, 12, 13], winter: [10, 11], autumn: [10, 11, 12], spring: [11, 12] },
    settlementKey: "esenboga",
  },
  lagos: {
    // No active market on 2026-09-10, so the settlement station is unverified
    // (no settlementKey).
    icao: "DNMM", lat: 6.5774, lon: 3.3212,
    tz: "Africa/Lagos", city_offset: 0.0,
    peakHoursUTC: { summer: [13, 14, 15], winter: [13, 14, 15], autumn: [13, 14, 15], spring: [13, 14, 15] },
  },
  "sao-paulo": {
    icao: "SBGR", lat: -23.4356, lon: -46.4731,
    tz: "America/Sao_Paulo", city_offset: 0.0,
    // Southern hemisphere — peak hours are local solar noon ~15-18 UTC.
    peakHoursUTC: { summer: [16, 17, 18], winter: [16, 17], autumn: [16, 17], spring: [16, 17, 18] },
    settlementKey: "guarulhos",
  },
  austin: {
    icao: "KAUS", lat: 30.1945, lon: -97.6699,
    tz: "America/Chicago", city_offset: 0.0,
    peakHoursUTC: { summer: [20, 21, 22], winter: [20, 21], autumn: [20, 21], spring: [20, 21, 22] },
    settlementKey: "bergstrom",
  },
  // ─── 2026-05-09 coverage extension #2 — additional cities Polymarket
  // actively lists. Coordinates are the official airport METAR station.
  guangzhou: {
    icao: "ZGGG", lat: 23.3924, lon: 113.2988,
    tz: "Asia/Shanghai", city_offset: 0.0,
    peakHoursUTC: { summer: [6, 7, 8], winter: [6, 7], autumn: [6, 7], spring: [6, 7, 8] },
    settlementKey: "baiyun",
  },
  shenzhen: {
    // ZGSZ = Shenzhen Bao'an Intl. Pearl River Delta — between Hong Kong and
    // Guangzhou (ZGGG, offset 0.0); coastal, so a mild −0.5 city_offset. Same
    // UTC+8 peak band as Guangzhou.
    icao: "ZGSZ", lat: 22.6393, lon: 113.8107,
    tz: "Asia/Shanghai", city_offset: -0.5,
    peakHoursUTC: { summer: [6, 7, 8], winter: [6, 7], autumn: [6, 7], spring: [6, 7, 8] },
    settlementKey: "baoan",
  },
  denver: {
    // B71: Buckley Space Force Base (KBKF, Aurora), not Denver Intl (KDEN).
    icao: "KBKF", lat: 39.7017, lon: -104.7517,
    tz: "America/Denver", city_offset: 0.0,
    peakHoursUTC: { summer: [21, 22, 23], winter: [20, 21], autumn: [21, 22], spring: [21, 22, 23] },
    settlementKey: "buckley",
  },
  warsaw: {
    icao: "EPWA", lat: 52.1657, lon: 20.9671,
    tz: "Europe/Warsaw", city_offset: 0.0,
    peakHoursUTC: { summer: [13, 14, 15], winter: [12, 13], autumn: [12, 13, 14], spring: [13, 14] },
    settlementKey: "chopin",
  },
  houston: {
    // B71: William P. Hobby (KHOU), not George Bush Intercontinental (KIAH).
    icao: "KHOU", lat: 29.6375, lon: -95.2824,
    tz: "America/Chicago", city_offset: 0.0,
    peakHoursUTC: { summer: [20, 21, 22], winter: [20, 21], autumn: [20, 21], spring: [20, 21, 22] },
    settlementKey: "hobby",
  },
  toronto: {
    icao: "CYYZ", lat: 43.6777, lon: -79.6248,
    tz: "America/Toronto", city_offset: 0.0,
    peakHoursUTC: { summer: [19, 20, 21], winter: [18, 19], autumn: [18, 19, 20], spring: [19, 20] },
    settlementKey: "pearson",
  },
  helsinki: {
    icao: "EFHK", lat: 60.3172, lon: 24.9633,
    tz: "Europe/Helsinki", city_offset: 0.0,
    peakHoursUTC: { summer: [12, 13, 14], winter: [11, 12], autumn: [11, 12, 13], spring: [12, 13] },
    settlementKey: "vantaa",
  },
};

// ─── Helpers ──────────────────────────────────────────────

export function getStation(city: string): StationConfig | null {
  return SETTLEMENT_STATIONS[city.toLowerCase()] ?? null;
}

/** Station config by station id (ICAO or "HKO"), for callers holding only the id. */
export function getStationById(id: string): StationConfig | null {
  for (const cfg of Object.values(SETTLEMENT_STATIONS)) {
    if (cfg.icao === id) return cfg;
  }
  return null;
}

const normalizeName = (s: string): string =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The station a market's rules name — "recorded by NOAA at the X Station",
 * "recorded at the X Station" or "recorded by the Hong Kong Observatory" — or
 * null if the text has no such phrase. Dots may sit inside the name
 * ("William P. Hobby Airport"). Pure.
 */
export function settlementPhrase(rules: string | null | undefined): string | null {
  const m = String(rules ?? "").match(
    /recorded (?:by NOAA )?(?:at|by) the ([^,;]+?)(?: Station\b| in degrees\b|[,;]|$)/i,
  );
  return m ? m[1].trim() : null;
}

/**
 * B71: null when the rules name the configured station, name no station, or the
 * city has no `settlementKey`; otherwise the station phrase the rules DO name.
 * Non-blocking by design — the caller logs it. Pure.
 */
export function settlementStationMismatch(
  rules: string | null | undefined,
  cfg: Pick<StationConfig, "settlementKey"> | null,
): string | null {
  if (!cfg?.settlementKey) return null;
  const phrase = settlementPhrase(rules);
  if (!phrase) return null;
  return normalizeName(phrase).includes(cfg.settlementKey) ? null : phrase;
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
