// netlify/functions/auto-trader-api.mts
// Non-scheduled wrapper for the auto-trader.
// The auto-trader/index.mts is scheduled (cron), so Netlify CLI
// intercepts its response locally. This endpoint proxies to the
// same handler for manual/UI calls.
//
// GET  /.netlify/functions/auto-trader-api?action=status
// POST /.netlify/functions/auto-trader-api  { action: "run" | "reset" | "stop" }

import handler from "./auto-trader/index.mts";
export default handler;
