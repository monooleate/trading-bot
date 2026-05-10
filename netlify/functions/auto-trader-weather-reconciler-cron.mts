// netlify/functions/auto-trader-weather-reconciler-cron.mts
//
// Scheduled wrapper around the weather paper-position reconciler.
// Runs every 15 minutes and:
//   1. Walks all open weather paper positions
//   2. Skips positions whose endDate hasn't passed
//   3. For ready positions, queries Polymarket Gamma — if resolved, closes
//      with the real settlement price
//   4. After 6h past endDate without Gamma resolution, falls back to
//      pulling actual METAR daily-max and settling on physical truth
//
// All logic lives in `auto-trader/weather/reconciler.mts` — this file is
// just the schedule + error envelope.
//
// Always-on: unlike the scan cron (which honours weatherCronEnabled), the
// reconciler always runs. There's no point gating it — its only job is to
// close already-open paper positions, and skipping it just leaves them
// open longer.

import { schedule } from "@netlify/functions";
import { runWeatherReconciler } from "./auto-trader/weather/reconciler.mts";

export const handler = schedule("*/15 * * * *", async () => {
  try {
    const result = await runWeatherReconciler(true);
    console.log("[weather-reconciler]", JSON.stringify({
      scanned: result.scanned,
      ready:   result.ready,
      settled: result.settled,
      failed:  result.failed,
      pending: result.pendingTotal,
    }));
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (err: any) {
    console.error("[weather-reconciler] error:", err?.message || err);
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: false, error: String(err?.message || err) }),
    };
  }
});
