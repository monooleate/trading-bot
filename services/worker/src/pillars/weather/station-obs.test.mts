// services/worker/src/pillars/weather/station-obs.test.mts
//
// Pins the B71 settlement-observation source: Hong Kong settles on the Hong
// Kong Observatory's own daily maximum, not on the airport METAR.

import { parseHkoRyesMax, obsSourceFor, fetchHkoDailyMax } from "./station-obs.mts";

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

console.log("\n1. parseHkoRyesMax");
{
  // Trimmed from the live RYES report for 2026-09-10: the airport (Chek Lap Kok)
  // read 33.0 °C, the Observatory 31.9 °C — only the Observatory settles.
  const report = { ChekLapKokMaxTemp: "33.0", HKOReadingsMaxTemp: "31.9", HKOReadingsMinTemp: "26.2" };
  check("reads the Observatory, not the airport", parseHkoRyesMax(report) === 31.9,
    String(parseHkoRyesMax(report)));
  check("numeric value accepted", parseHkoRyesMax({ HKOReadingsMaxTemp: 32.2 }) === 32.2);
  check("blank reading → null", parseHkoRyesMax({ HKOReadingsMaxTemp: "" }) === null);
  check("missing field → null", parseHkoRyesMax({ ChekLapKokMaxTemp: "33.0" }) === null);
  check("non-numeric → null", parseHkoRyesMax({ HKOReadingsMaxTemp: "***" }) === null);
  check("implausible → null", parseHkoRyesMax({ HKOReadingsMaxTemp: "99.9" }) === null);
  check("null payload → null", parseHkoRyesMax(null) === null);
}

console.log("\n2. obsSourceFor");
{
  check("HKO settles on the Observatory report", obsSourceFor("HKO") === "hko");
  check("an airport station uses METAR", obsSourceFor("EGLC") === "metar");
  check("the old Hong Kong airport id is plain METAR, not HKO", obsSourceFor("VHHH") === "metar");
  check("unknown id defaults to METAR", obsSourceFor("ZZZZ") === "metar");
}

console.log("\n3. fetchHkoDailyMax input guard");
{
  const r = await fetchHkoDailyMax("2026-9-1");
  check("malformed date → null without a request", r === null);
}

console.log(`\n=== station-obs: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
