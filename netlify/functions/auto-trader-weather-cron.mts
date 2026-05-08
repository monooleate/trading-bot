// netlify/functions/auto-trader-weather-cron.mts
//
// Scheduled wrapper around the weather auto-trader. Fires every 5 minutes
// (see netlify.toml) and only does work when the user has opted in via the
// `weatherCronEnabled` runtime setting in the Settings tab.
//
// Without the toggle the function returns immediately, so paper-traders who
// don't want background activity pay nothing. With the toggle on, each tick:
//   1. Pulls the effective WeatherConfig (env defaults + Blobs overrides)
//   2. Runs `runWeatherTrader(cfg, "cron")` — same code path as the manual
//      "Scan" button in the UI
//   3. Updates the run-state Blob so the UI live-status indicator reflects
//      the cron tick
//
// Scheduled functions can't be invoked via URL, so all manual operations
// still go through `auto-trader-api`.

import { schedule } from "@netlify/functions";
import { runWeatherTrader } from "./auto-trader/weather/index.mts";
import { getEffectiveWeatherConfig } from "./auto-trader/weather/decision-engine.mts";

export const handler = schedule("*/5 * * * *", async () => {
  try {
    const cfg = await getEffectiveWeatherConfig();
    if (!cfg.cronEnabled) {
      return { statusCode: 200, body: JSON.stringify({ skipped: "cron disabled" }) };
    }

    const result = await runWeatherTrader(cfg, "cron");
    console.log("[weather-cron]", JSON.stringify({
      action:  result.action,
      scanned: result.marketsScanned ?? 0,
      results: Array.isArray(result.results) ? result.results.length : 0,
    }));
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err: any) {
    console.error("[weather-cron] error:", err?.message || err);
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: String(err?.message || err) }) };
  }
});
