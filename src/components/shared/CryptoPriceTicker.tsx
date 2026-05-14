import { useCallback, useEffect, useRef, useState } from "react";

// Lightweight live-price strip for the trader pages. The crypto bot trades
// BTC short-markets on Polymarket; the HL Perp + Funding-Arb bots trade
// BTC/ETH/SOL on Hyperliquid. Surfacing the current spot price (+ 24h
// change) at the top of each trader page gives the operator the price
// context the scan result chips (mp 60¢ / pred 58%) alone don't.
//
// Best-practice details:
//  - Backend (binance-price.mts) caches 15s; this widget polls every 30s,
//    so most polls hit cache (≤2 origin hits/min regardless of how many
//    browsers are open).
//  - Pauses polling when the tab is hidden (visibilitychange) — avoids
//    background bandwidth when you minimize/switch tabs.
//  - "Stale" pill if the last successful fetch is >2 min old (network /
//    function blip), so the user never reads a frozen number as live.
//  - One row of compact cards on desktop, horizontal scroll-snap on
//    mobile so 3-5 coins fit without wrapping.

interface PriceTicker {
  symbol:       string;
  price:        number;
  change24h:    number;
  changePct24h: number;
  high24h:      number;
  low24h:       number;
  volume24h:    number;
}

interface PriceResponse {
  ok: boolean;
  source?: "bybit" | "binance" | "none";
  fetchedAt?: string;
  tickers?: PriceTicker[];
  error?: string;
}

interface Props {
  /** Symbols to display, default BTC + ETH + SOL. */
  symbols?: string[];
  /** Poll interval in ms. Default 30s — backend cache is 15s. */
  pollMs?: number;
  /** Optional inline title; default "Live prices". */
  title?: string;
}

const DEFAULTS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];

function formatPrice(p: number): string {
  if (!Number.isFinite(p)) return "—";
  if (p >= 1000)  return p.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (p >= 10)    return p.toFixed(2);
  if (p >= 0.1)   return p.toFixed(3);
  return p.toFixed(5);
}

function formatPct(p: number): string {
  if (!Number.isFinite(p)) return "—";
  const v = p * 100;
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}%`;
}

function formatVol(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "—";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function symbolLabel(s: string): string {
  // Strip the USDT quote for cleaner display: BTCUSDT → BTC.
  return s.endsWith("USDT") ? s.slice(0, -4) : s;
}

export default function CryptoPriceTicker({
  symbols = DEFAULTS,
  pollMs = 30_000,
  title = "Live prices",
}: Props) {
  const [tickers, setTickers]   = useState<PriceTicker[]>([]);
  const [fetchedAt, setAt]      = useState<string | null>(null);
  const [error, setError]       = useState<string | null>(null);
  const [loading, setLoading]   = useState<boolean>(true);
  // Track the previous price per symbol so we can flash a brief up/down
  // color when the value changes (gives a subtle "live" feeling without
  // a busy animation).
  const prevPriceRef = useRef<Map<string, number>>(new Map());
  const [flash, setFlash] = useState<Map<string, "up" | "down">>(new Map());

  const load = useCallback(async () => {
    try {
      const qs = `?symbols=${encodeURIComponent(symbols.join(","))}`;
      const res = await fetch(`/.netlify/functions/binance-price${qs}`);
      const json = await res.json() as PriceResponse;
      if (!json.ok || !json.tickers) {
        throw new Error(json.error || "no tickers");
      }
      // Compute flash state by comparing new vs prev.
      const next = new Map<string, "up" | "down">();
      for (const t of json.tickers) {
        const prev = prevPriceRef.current.get(t.symbol);
        if (prev !== undefined && prev !== t.price) {
          next.set(t.symbol, t.price > prev ? "up" : "down");
        }
        prevPriceRef.current.set(t.symbol, t.price);
      }
      setFlash(next);
      setTickers(json.tickers);
      setAt(json.fetchedAt ?? new Date().toISOString());
      setError(null);
      // Clear the flash after a short delay so it stays a flash, not a
      // permanent color.
      setTimeout(() => setFlash(new Map()), 800);
    } catch (e: any) {
      setError(e?.message ?? "fetch failed");
    } finally {
      setLoading(false);
    }
  }, [symbols.join(",")]);                                              // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer) return;
      if (!cancelled) load();
      timer = setInterval(() => { if (!cancelled) load(); }, pollMs);
    };
    const stop = () => {
      if (timer) { clearInterval(timer); timer = null; }
    };

    // Pause polling when the tab is hidden so a backgrounded dashboard
    // doesn't burn bandwidth or rack up requests overnight.
    const onVis = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };

    start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load, pollMs]);

  // Staleness: 2× poll interval without a successful refresh.
  const isStale = !!fetchedAt &&
    (Date.now() - new Date(fetchedAt).getTime() > Math.max(60_000, pollMs * 2.5));

  return (
    <div className="cpt-wrap" role="region" aria-label="Live crypto prices">
      <div className="cpt-head">
        <span className="cpt-title">{title}</span>
        {loading && tickers.length === 0 && <span className="cpt-meta">Loading…</span>}
        {!loading && fetchedAt && (
          <span className={`cpt-meta ${isStale ? "cpt-stale" : ""}`}>
            {isStale ? "stale" : "live"} ·{" "}
            <time dateTime={fetchedAt}>
              {new Date(fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </time>
          </span>
        )}
        {error && tickers.length === 0 && (
          <span className="cpt-meta cpt-err">err: {error}</span>
        )}
      </div>

      <div className="cpt-row">
        {tickers.length === 0 && !loading && (
          <div className="cpt-empty">Price feed unavailable</div>
        )}
        {tickers.map((t) => {
          const up = t.changePct24h >= 0;
          const flashCls = flash.get(t.symbol);
          return (
            <div
              key={t.symbol}
              className={`cpt-card ${up ? "cpt-up" : "cpt-down"} ${flashCls ? `cpt-flash-${flashCls}` : ""}`}
              title={`${t.symbol} · vol24h ${formatVol(t.volume24h)} · range ${formatPrice(t.low24h)}–${formatPrice(t.high24h)}`}
            >
              <div className="cpt-sym">{symbolLabel(t.symbol)}</div>
              <div className="cpt-price">${formatPrice(t.price)}</div>
              <div className="cpt-delta">
                <span className="cpt-arrow" aria-hidden>{up ? "▲" : "▼"}</span>
                {formatPct(t.changePct24h)}
              </div>
              <div className="cpt-range">
                <span className="cpt-range-lbl">24h</span>
                <span className="cpt-range-val">
                  ${formatPrice(t.low24h)} – ${formatPrice(t.high24h)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <style>{STYLES}</style>
    </div>
  );
}

const STYLES = `
.cpt-wrap{margin:0 0 14px 0;}
.cpt-head{display:flex;align-items:center;gap:10px;margin-bottom:6px;font-family:var(--mono);font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;}
.cpt-title{color:var(--text);font-weight:700;}
.cpt-meta{font-size:9.5px;}
.cpt-stale{color:var(--warn);}
.cpt-err{color:var(--danger);text-transform:none;letter-spacing:0;}
/* auto-fill (NOT auto-fit) so a single-coin Crypto card stays at ~180px
   instead of stretching to full row width. Empty tracks remain
   reserved at minmax(180px, 1fr), so adding more coins later just
   fills the next track instead of reshuffling. */
.cpt-row{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px;}
.cpt-card{
  background:var(--surface);
  border:1px solid var(--border);
  border-left:3px solid var(--border);
  border-radius:4px;
  padding:10px 12px;
  display:grid;
  grid-template-columns:auto 1fr;
  grid-template-rows:auto auto auto;
  column-gap:10px;
  row-gap:2px;
  align-items:baseline;
  transition:border-color .25s ease, background-color .25s ease;
}
.cpt-card.cpt-up   { border-left-color:var(--accent); }
.cpt-card.cpt-down { border-left-color:var(--danger); }
.cpt-card.cpt-flash-up   { background:rgba(200,241,53,0.08); }
.cpt-card.cpt-flash-down { background:rgba(241,53,53,0.08); }
.cpt-sym{font-family:var(--mono);font-size:11px;color:var(--muted);letter-spacing:.06em;text-transform:uppercase;grid-row:1;grid-column:1;}
.cpt-price{font-family:var(--mono);font-size:18px;font-weight:700;color:var(--text);letter-spacing:-0.02em;grid-row:1;grid-column:2;text-align:right;line-height:1.1;}
.cpt-delta{font-family:var(--mono);font-size:11px;font-weight:700;grid-row:2;grid-column:2;text-align:right;line-height:1.1;}
.cpt-up   .cpt-delta{color:var(--accent);}
.cpt-down .cpt-delta{color:var(--danger);}
.cpt-arrow{font-size:9px;margin-right:3px;vertical-align:1px;}
.cpt-range{grid-row:3;grid-column:1 / span 2;display:flex;justify-content:space-between;font-family:var(--mono);font-size:9.5px;color:var(--muted);margin-top:3px;border-top:1px solid var(--border);padding-top:3px;}
.cpt-range-lbl{text-transform:uppercase;letter-spacing:.08em;}
.cpt-empty{font-family:var(--mono);font-size:11px;color:var(--muted);padding:10px;border:1px dashed var(--border);border-radius:4px;}

@media (max-width: 640px){
  /* Horizontal scroll-snap row so 3+ coins fit without wrapping and the
     trader page above the fold stays compact. */
  .cpt-row{
    display:flex;
    gap:8px;
    overflow-x:auto;
    scroll-snap-type:x mandatory;
    -webkit-overflow-scrolling:touch;
    padding-bottom:4px;
    /* Hide native scrollbar for a cleaner feel — content still scrolls. */
    scrollbar-width:none;
  }
  .cpt-row::-webkit-scrollbar{display:none;}
  .cpt-card{
    flex:0 0 158px;
    scroll-snap-align:start;
    padding:9px 10px;
  }
  .cpt-price{font-size:16px;}
  .cpt-head{flex-wrap:wrap;}
}
`;
