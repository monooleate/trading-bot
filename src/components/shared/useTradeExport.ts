// Hook for the "💾 Export Trades" button that TraderShell renders.
//
// Pulls the closed-trades + summary for a given category from the existing
// edge-tracker endpoint, wraps them in a versioned envelope (so the file
// is self-describing if someone opens it months later) and triggers a
// browser download via a hidden anchor.
//
// JSON over CSV: the trade payload contains nested signal data, so a flat
// CSV would lose information. JSON is also easier to round-trip back
// through the codebase if we ever build an "import previous trades"
// flow for forensic analysis.

import { useCallback, useState } from "react";

export type ExportCategory =
  | "crypto" | "weather" | "hyperliquid" | "funding-arb";

interface UseTradeExportOptions {
  category: ExportCategory;
  /** "paper" | "live" | "both" — forwarded to the edge-tracker. */
  mode?: "paper" | "live" | "both";
  /** "7" | "30" | "90" | "all" — forwarded to the edge-tracker. */
  days?: string;
}

export function useTradeExport({
  category,
  mode = "paper",
  days = "all",
}: UseTradeExportOptions) {
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const exportTrades = useCallback(async () => {
    setExporting(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ mode, category, days });
      const res = await fetch(`/.netlify/functions/edge-tracker?${qs}`);
      if (!res.ok) throw new Error(`edge-tracker returned ${res.status}`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "edge-tracker rejected the request");

      // Self-describing envelope so the file is intelligible without the
      // app context.
      const envelope = {
        $schema:    "edgecalc-trade-export/v1",
        category,
        mode,
        days,
        exportedAt: new Date().toISOString(),
        summary:    data.summary ?? null,
        signalIC:   data.signalIC ?? null,
        trades:     data.trades ?? [],
        sourceNote:
          "Snapshot pulled from /.netlify/functions/edge-tracker. " +
          "Server retains the authoritative session state in Netlify Blobs.",
      };

      const blob = new Blob([JSON.stringify(envelope, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const ts = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .replace("T", "_")
        .slice(0, 19);
      a.href = url;
      a.download = `trades-${category}-${mode}-${ts}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setError(e?.message || String(e));
      throw e; // surface so TraderShell's reset-with-backup can decide
    } finally {
      setExporting(false);
    }
  }, [category, mode, days]);

  return { exportTrades, exporting, error };
}
