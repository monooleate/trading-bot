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

export interface TemperatureBucket {
  label: string;             // e.g. "18°C" or "65°F or higher"
  tokenId: string;
  currentPrice: number;
  tempC: number | null;      // parsed center temp in °C, null if unparseable
}

// ─── Slug parsing ─────────────────────────────────────────

const CITY_PATTERNS: Record<string, string[]> = {
  shanghai: ["shanghai"],
  london: ["london"],
  "new-york": ["new-york", "nyc", "new-york-city"],
  "los-angeles": ["los-angeles", "la-"],
  chicago: ["chicago"],
  "hong-kong": ["hong-kong"],
  seoul: ["seoul"],
  miami: ["miami"],
  seattle: ["seattle"],
  atlanta: ["atlanta"],
};

function parseCityFromSlug(slug: string): string | null {
  const s = slug.toLowerCase();
  for (const [city, patterns] of Object.entries(CITY_PATTERNS)) {
    if (patterns.some((p) => s.includes(p))) return city;
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
  // "18°C" → 18
  // "65°F or higher" → convert to C
  // "Between 15°C and 20°C" → midpoint 17.5
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

// ─── Parse buckets from market outcomes ───────────────────

function parseBuckets(market: any): TemperatureBucket[] {
  const buckets: TemperatureBucket[] = [];

  // Gamma API returns tokens array or outcomePrices
  const tokens = market.tokens || [];
  let prices: number[] = [];
  try {
    const op = typeof market.outcomePrices === "string"
      ? JSON.parse(market.outcomePrices)
      : market.outcomePrices;
    if (Array.isArray(op)) prices = op.map((p: any) => parseFloat(p));
  } catch {}

  if (tokens.length > 0) {
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const label = t.outcome || `Outcome ${i}`;
      buckets.push({
        label,
        tokenId: t.token_id || "",
        currentPrice: prices[i] ?? 0.5,
        tempC: parseTempFromLabel(label),
      });
    }
  }

  return buckets;
}

// ─── Main finder ──────────────────────────────────────────

export async function findWeatherMarkets(): Promise<WeatherMarket[]> {
  const url = `${GAMMA_API}/events?tag=weather&limit=50&order=volume24hr&ascending=false&active=true`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "EdgeCalc-Weather/1.0" },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) throw new Error(`Gamma API error: ${res.status}`);

  const events: any[] = await res.json().then((d: any) =>
    Array.isArray(d) ? d : [],
  );

  const results: WeatherMarket[] = [];

  for (const evt of events) {
    for (const m of evt.markets || []) {
      const question = m.question || m.title || evt.title || "";
      const slug = m.slug || "";

      // Must be temperature-related
      const q = question.toLowerCase();
      if (!q.includes("temp") && !q.includes("highest") && !q.includes("hottest") && !q.includes("warmest") && !q.includes("coldest") && !q.includes("°")) {
        continue;
      }

      // Skip closed/expired
      if (m.closed === true) continue;
      if (m.endDate && new Date(m.endDate).getTime() < Date.now()) continue;

      // Parse city and date
      const city = parseCityFromSlug(slug) || parseCityFromSlug(question.toLowerCase().replace(/\s+/g, "-"));
      if (!city) continue;

      // Must have a known station
      const station = getStation(city);
      if (!station) continue;

      const date = parseDateFromSlug(slug) || parseDateFromSlug(question.toLowerCase().replace(/\s+/g, "-"));
      if (!date) continue;

      // Parse buckets
      const outcomes = parseBuckets(m);
      if (outcomes.length === 0) continue;

      const vol = parseFloat(m.volume24hr || m.volume || "0");

      results.push({
        slug,
        conditionId: m.conditionId || "",
        title: question,
        city,
        date,
        clobTokenIds: outcomes.map((o) => o.tokenId),
        outcomes,
        volume24h: vol,
        endDate: m.endDate || "",
        active: true,
      });
    }
  }

  results.sort((a, b) => b.volume24h - a.volume24h);
  return results;
}
