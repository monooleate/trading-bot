// netlify/functions/resolution-risk.mts
// GET  /.netlify/functions/resolution-risk?slug=<market-slug>
// POST /.netlify/functions/resolution-risk   body: { slug, question?, rules?, resolutionSource?, endDate?, category? }
//
// Returns a ResolutionRiskScore for a Polymarket market:
//   E[X]adjusted = P(YES) - price - resolution_risk - execution_drag
// The complete methodology and logic lives in _resolution-risk.ts so that
// signal-combiner can import the same code path.

import type { Context } from "@netlify/functions";
import {
  analyseResolutionRisk,
  fetchMarketMeta,
  type MarketMeta,
  type ResolutionRiskScore,
} from "./_resolution-risk.js";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type":                 "application/json",
};

function errorResponse(msg: string, status = 400): Response {
  return new Response(JSON.stringify({ ok: false, error: msg }), { status, headers: CORS });
}

function successResponse(slug: string, risk: ResolutionRiskScore, extra: Record<string, any> = {}): Response {
  return new Response(JSON.stringify({
    ok:   true,
    slug,
    risk,
    ...extra,
  }), { status: 200, headers: CORS });
}

export default async function handler(req: Request, _ctx: Context) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  try {
    // ── POST: caller supplies full metadata (no Gamma round-trip) ───────────
    if (req.method === "POST") {
      let body: any;
      try { body = await req.json(); } catch { return errorResponse("Invalid JSON"); }

      const slug = (body?.slug || "").toString().trim();
      if (!slug) return errorResponse("slug required");

      // If only slug provided, fall through to Gamma fetch path
      const hasInlineMeta = body.question || body.rules || body.resolutionSource;

      let meta: MarketMeta | null;
      if (hasInlineMeta) {
        meta = {
          question:         (body.question         || "").toString(),
          slug,
          rules:            (body.rules            || "").toString(),
          resolutionSource: (body.resolutionSource || "").toString(),
          endDate:          (body.endDate          || "").toString(),
          category:         (body.category         || "").toString(),
          closed:           !!body.closed,
        };
      } else {
        meta = await fetchMarketMeta(slug);
        if (!meta) return errorResponse("Market not found", 404);
      }

      const risk = await analyseResolutionRisk(meta);
      if (!risk) return errorResponse("Analysis failed", 502);
      return successResponse(slug, risk, { market: meta });
    }

    // ── GET: fetch metadata from Gamma, then analyse ─────────────────────────
    const url  = new URL(req.url);
    const slug = (url.searchParams.get("slug") || "").trim();
    if (!slug) return errorResponse("slug query param required");

    const meta = await fetchMarketMeta(slug);
    if (!meta) return errorResponse("Market not found", 404);

    const risk = await analyseResolutionRisk(meta);
    if (!risk) return errorResponse("Analysis failed", 502);

    return successResponse(slug, risk, {
      market: {
        question:         meta.question,
        slug:             meta.slug,
        endDate:          meta.endDate,
        category:         meta.category,
        resolutionSource: meta.resolutionSource,
        has_rules:        !!meta.rules,
        rules_length:     (meta.rules || "").length,
      },
    });
  } catch (err: any) {
    return errorResponse(err?.message || "unknown error", 502);
  }
}
