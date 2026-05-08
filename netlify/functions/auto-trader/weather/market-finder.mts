import { SETTLEMENT_STATIONS, getStation } from "./station-config.mts";

const GAMMA_API = "https://gamma-api.polymarket.com";

export interface WeatherMarket {
  slug: string;
  conditionId: string;
  title: string;
  city: string;
  date: string;              // YYYY-MM-DD
  clobTokenIds: string[];    // one per bucket outcome
  outcomes: TemperatureBucket[];
  volume24h: number;
  endDate: string;
  active: boolean;
}

// Diagnostics: events that look like weather markets but were dropped before
// reaching the trader. Useful for surfacing coverage gaps in the Settings tab.
export interface DroppedEvent {
  slug:   string;
  title:  string;
  reason: "no-city-mapped" | "no-station" | "no-date" | "no-buckets" | "expired";
  vol24h: number;
}

export interface TemperatureBucket {
  label: string;             // e.g. "18°C" or "65°F or higher"
  tokenId: string;
  currentPrice: number;
  tempC: number | null;      // parsed center temp in °C, null if unparseable
}

// ─── Slug parsing ─────────────────────────────────────────

// Patterns are matched as hyphen-delimited tokens so short aliases like "la"
// don't accidentally hit "kua-la-lumpur".
const CITY_PATTERNS: Record<string, string[]> = {
  shanghai:      ["shanghai"],
  london:        ["london"],
  "new-york":    ["new-york", "nyc", "new-york-city"],
  "los-angeles": ["los-angeles", "la"],
  chicago:       ["chicago"],
  "hong-kong":   ["hong-kong"],
  seoul:         ["seoul"],
  miami:         ["miami"],
  seattle:       ["seattle"],
  atlanta:       ["atlanta"],
  // Newly mapped — were configured in station-config but missing from the
  // pattern list, so their slugs were silently dropped.
  dallas:        ["dallas"],
  tokyo:         ["tokyo"],
  // Coverage extension — see station-config.mts.
  madrid:        ["madrid"],
  paris:         ["paris"],
  milan:         ["milan", "milano"],
  munich:        ["munich", "muenchen"],
  ankara:        ["ankara"],
  lagos:         ["lagos"],
  "sao-paulo":   ["sao-paulo", "são-paulo"],
  austin:        ["austin"],
  // 2026-05-09 coverage extension #2
  guangzhou:     ["guangzhou"],
  denver:        ["denver"],
  warsaw:        ["warsaw", "warszawa"],
  houston:       ["houston"],
  toronto:       ["toronto"],
  helsinki:      ["helsinki"],
};

function parseCityFromSlug(slug: string): string | null {
  const s = `-${slug.toLowerCase()}-`;
  for (const [city, patterns] of Object.entries(CITY_PATTERNS)) {
    if (patterns.some((p) => s.includes(`-${p}-`))) return city;
  }
  return null;
}

function parseDateFromSlug(slug: string): string | null {
  // Match patterns like "april-12", "on-april-12", "april-12-2026"
  const months: Record<string, string> = {
    january: "01", february: "02", march: "03", april: "04",
    may: "05", june: "06", july: "07", august: "08",
    september: "09", october: "10", november: "11", december: "12",
  };

  for (const [name, num] of Object.entries(months)) {
    const re = new RegExp(`${name}-(\\d{1,2})(?:-(\\d{4}))?`);
    const match = slug.match(re);
    if (match) {
      const day = match[1].padStart(2, "0");
      const year = match[2] || new Date().getFullYear().toString();
      return `${year}-${num}-${day}`;
    }
  }
  return null;
}

// ─── Parse temperature from outcome label ─────────────────

function parseTempFromLabel(label: string): number | null {
  // Supported formats:
  //   "18°C"                 → 18
  //   "15°C or below"        → 15
  //   "22°C or higher"       → 22
  //   "46-47°F"              → midpoint 46.5, converted to °C
  //   "Between 15°C and 20°C"→ midpoint 17.5

  // Hyphen-range: "46-47°F" or "14-15°C" → midpoint, then unit convert
  const rangeMatch = label.match(/(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)\s*°?\s*([CF])/i);
  if (rangeMatch) {
    const mid = (parseFloat(rangeMatch[1]) + parseFloat(rangeMatch[2])) / 2;
    if (rangeMatch[3].toUpperCase() === "F") {
      return Math.round(((mid - 32) * 5 / 9) * 10) / 10;
    }
    return mid;
  }

  const celsiusMatch = label.match(/(-?\d+(?:\.\d+)?)\s*°?\s*C/i);
  if (celsiusMatch) return parseFloat(celsiusMatch[1]);

  const fahrenheitMatch = label.match(/(-?\d+(?:\.\d+)?)\s*°?\s*F/i);
  if (fahrenheitMatch) {
    const f = parseFloat(fahrenheitMatch[1]);
    return Math.round(((f - 32) * 5 / 9) * 10) / 10;
  }

  // "Between X and Y" pattern
  const betweenMatch = label.match(/between\s+(-?\d+)\s*.*?and\s+(-?\d+)/i);
  if (betweenMatch) {
    return (parseFloat(betweenMatch[1]) + parseFloat(betweenMatch[2])) / 2;
  }

  return null;
}

// ─── Parse buckets from an event's sub-markets ────────────
//
// Polymarket weather events are negRisk groups: one event per (city, date),
// with N binary sub-markets — one per temperature range. We treat each
// sub-market's YES side as one bucket, with YES price = P(temp ∈ bucket).

function parseBucketsFromEvent(evt: any): TemperatureBucket[] {
  const buckets: TemperatureBucket[] = [];

  for (const m of evt.markets || []) {
    if (m.closed === true) continue;
    if (m.endDate && new Date(m.endDate).getTime() < Date.now()) continue;

    const label = m.groupItemTitle || "";
    if (!label) continue;

    let clobIds: string[] = [];
    try {
      clobIds = typeof m.clobTokenIds === "string"
        ? JSON.parse(m.clobTokenIds)
        : m.clobTokenIds || [];
    } catch {}

    let prices: number[] = [];
    try {
      const op = typeof m.outcomePrices === "string"
        ? JSON.parse(m.outcomePrices)
        : m.outcomePrices;
      if (Array.isArray(op)) prices = op.map((p: any) => parseFloat(p));
    } catch {}

    buckets.push({
      label,
      tokenId: clobIds[0] || "",           // YES token
      currentPrice: prices[0] ?? 0.5,      // YES price
      tempC: parseTempFromLabel(label),
    });
  }

  return buckets;
}

// ─── Main finder ──────────────────────────────────────────

export interface FindResult {
  markets: WeatherMarket[];
  dropped: DroppedEvent[];
}

export async function findWeatherMarketsDetailed(): Promise<FindResult> {
  // Gamma's `tag=weather` filter is broken (returns unrelated markets), so
  // pull a wide active slice and filter by question text / slug ourselves.
  const url = `${GAMMA_API}/events?limit=500&active=true&closed=false&order=volume24hr&ascending=false`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "EdgeCalc-Weather/1.0" },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) throw new Error(`Gamma API error: ${res.status}`);

  const events: any[] = await res.json().then((d: any) =>
    Array.isArray(d) ? d : [],
  );

  const results: WeatherMarket[] = [];
  const dropped: DroppedEvent[] = [];

  for (const evt of events) {
    const title = evt.title || "";
    const slug  = evt.slug  || "";
    const vol   = parseFloat(evt.volume24hr || evt.volume || "0");

    // Must be a daily-max temperature event. Our forecast engine models the
    // daily high, so "lowest/coldest" markets would be semantically backwards.
    const t = title.toLowerCase();
    if (t.includes("lowest") || t.includes("coldest")) continue;
    const isTempEvent =
      t.includes("highest temperature") ||
      t.includes("hottest") ||
      t.includes("warmest") ||
      (t.includes("temperature") && t.includes("°"));
    if (!isTempEvent) continue;

    // Parse city + date (event-level)
    const city = parseCityFromSlug(slug) || parseCityFromSlug(t.replace(/\s+/g, "-"));
    if (!city) {
      dropped.push({ slug, title, reason: "no-city-mapped", vol24h: vol });
      continue;
    }

    const station = getStation(city);
    if (!station) {
      dropped.push({ slug, title, reason: "no-station", vol24h: vol });
      continue;
    }

    const date = parseDateFromSlug(slug) || parseDateFromSlug(t.replace(/\s+/g, "-"));
    if (!date) {
      dropped.push({ slug, title, reason: "no-date", vol24h: vol });
      continue;
    }

    // Aggregate sub-markets into buckets
    const outcomes = parseBucketsFromEvent(evt);
    if (outcomes.length === 0) {
      dropped.push({ slug, title, reason: "no-buckets", vol24h: vol });
      continue;
    }

    // Event end date = max of sub-market endDates (fallback to evt.endDate)
    const endDate = evt.endDate || evt.markets?.[0]?.endDate || "";
    if (endDate && new Date(endDate).getTime() < Date.now()) {
      dropped.push({ slug, title, reason: "expired", vol24h: vol });
      continue;
    }

    results.push({
      slug,
      conditionId: evt.markets?.[0]?.conditionId || "",  // not used for negRisk exec
      title,
      city,
      date,
      clobTokenIds: outcomes.map((o) => o.tokenId),
      outcomes,
      volume24h: vol,
      endDate,
      active: true,
    });
  }

  results.sort((a, b) => b.volume24h - a.volume24h);
  dropped.sort((a, b) => b.vol24h - a.vol24h);
  return { markets: results, dropped };
}

// Backwards compat shim — most callers only need the matched markets.
export async function findWeatherMarkets(): Promise<WeatherMarket[]> {
  const { markets } = await findWeatherMarketsDetailed();
  return markets;
}
