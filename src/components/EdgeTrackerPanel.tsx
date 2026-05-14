import { useState, useEffect, useCallback, Fragment } from "react";
import CalibrationHealthBadge from "./shared/CalibrationHealthBadge";

// ─── Types (mirror backend) ─────────────────────────────

interface SummaryStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  totalPnlPct: number;
  avgPnlPerTrade: number;
  avgEdgeAtEntry: number;
  sharpeRatio: number;
  sharpeCiLo: number;
  sharpeCiHi: number;
  sortinoRatio: number;
  profitFactor: number;
  expectancy: number;
  payoffRatio: number;
  longestWinStreak: number;
  longestLossStreak: number;
  currentStreak: number;
  evGap: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  maxDrawdownDuration: number;
  kellyOptimal: number;
  kellyUsed: number;
  kellyEfficiency: number;
  calibrationDeviation: number;
  isWellCalibrated: boolean;
}

interface CumulativePoint {
  index: number; closedAt: string;
  actual: number; random: number; ev: number;
  drawdown: number; peak: number;
}

interface CalibrationBucket {
  probRange: [number, number]; predictedAvg: number;
  actualWinRate: number; tradeCount: number;
  deviation: number; isWellCalibrated: boolean;
}

interface SignalICResult {
  signalName: string; ic: number; tradeCount: number;
  strength: "strong" | "moderate" | "weak" | "noise";
}

interface CalibrationHealth {
  status: "good" | "weak" | "noise" | "insufficient";
  maxAbsIC: number;
  topSignal: string | null;
  tradeCount: number;
  shouldSuspendLive: boolean;
  message: string;
}

interface EdgeDecayPoint {
  week: string; avgEdge: number; avgPnl: number; tradeCount: number;
}

interface HeatmapCell {
  hour: number; category: string; winRate: number; tradeCount: number;
}

interface HistogramBin { lo: number; hi: number; count: number; }

interface TradeRow {
  closedAt: string; openedAt: string; category: string;
  market: string; direction: "YES" | "NO" | "LONG" | "SHORT";
  entryPrice: number; exitPrice: number; shares: number;
  pnl: number; pnlPct: number;
  edgeAtEntry: number; predictedProb: number;
}

interface CalibrationView {
  category: "crypto" | "hyperliquid";
  useRealizedIC: boolean;
  shrinkageK: number;
  computedAt: string | null;
  sampleSize: number;
  priors:    Record<string, number>;
  realized:  Record<string, { ic: number; n: number }>;
  effective: Record<string, number>;
}

interface EdgeTrackerData {
  ok: boolean;
  isMock: boolean;
  summary: SummaryStats;
  cumulativePnl: CumulativePoint[];
  calibration: CalibrationBucket[];
  signalIC: SignalICResult[];
  calibrationHealth?: CalibrationHealth;
  edgeDecay: { points: EdgeDecayPoint[]; slope: number; hasDecay: boolean };
  heatmap: HeatmapCell[];
  distribution: HistogramBin[];
  trades: TradeRow[];
  calibrationView?: CalibrationView | null;
}

// ─── Color tokens (match dashboardStyles) ───────────────

const COLORS = {
  actual: "#c8f135",
  baseline: "#666680",
  theoretical: "#35f1c8",
  win: "#c8f135",
  loss: "#f13535",
  warn: "#f1a035",
  muted: "#666680",
  surface: "#18181f",
  border: "#232330",
};

// ─── Main panel ─────────────────────────────────────────

type EdgeCategory = "crypto" | "weather" | "hyperliquid" | "funding-arb" | "sports" | "all";

interface Props {
  defaultCategory?: EdgeCategory;
}

export default function EdgeTrackerPanel({ defaultCategory = "all" }: Props) {
  const [mode, setMode] = useState<"paper" | "live" | "both">("paper");
  const [category, setCategory] = useState<string>(defaultCategory);
  const [days, setDays] = useState<string>("30");
  const [data, setData] = useState<EdgeTrackerData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = `?mode=${mode}&category=${category}&days=${days}`;
      const res = await fetch(`/.netlify/functions/edge-tracker${qs}`);
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "Unknown error");
      setData(json);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [mode, category, days]);

  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <div className="ec-sec-title">Edge Tracker</div>
      <div className="ec-sec-sub">
        Statistical analysis: does the edge realize over many trades?
      </div>

      <FilterBar
        mode={mode} setMode={setMode}
        category={category} setCategory={setCategory}
        days={days} setDays={setDays}
        defaultCategory={defaultCategory}
      />

      {error && <div className="et-error">Error: {error}</div>}
      {loading && <div className="et-loading">Loading...</div>}

      {data && (
        <>
          {data.isMock && (
            <div className="et-mock-banner">
              ⚠ Showing MOCK data (100 simulated trades). Start trading in the Auto-Trader tab to see real results.
            </div>
          )}

          {data.summary.totalTrades < 20 && !data.isMock && (
            <div className="et-warn-banner">
              ⚠ Only {data.summary.totalTrades} trades. Statistics need at least 50 trades to be meaningful.
            </div>
          )}

          {data.calibrationHealth && (
            <CalibrationHealthBadge
              category={category as EdgeCategory}
              days={days}
              health={data.calibrationHealth}
              variant="full"
            />
          )}

          <SummaryCards s={data.summary} />
          {data.calibrationView && <CalibrationViewCard view={data.calibrationView} />}
          <CumulativePnlChart points={data.cumulativePnl} />
          <UnderwaterDrawdownChart points={data.cumulativePnl} maxDDDuration={data.summary.maxDrawdownDuration} />
          <div className="et-grid2">
            <CalibrationChart buckets={data.calibration} />
            <SignalICChart results={data.signalIC} />
          </div>
          <EdgeDecayChart decay={data.edgeDecay} />
          <div className="et-grid2">
            <WinRateHeatmap cells={data.heatmap} />
            <PnlDistribution bins={data.distribution} />
          </div>
          <TradeTable trades={data.trades} />
        </>
      )}

      <style>{styles}</style>
    </div>
  );
}

// ─── FilterBar ──────────────────────────────────────────

function FilterBar({ mode, setMode, category, setCategory, days, setDays, defaultCategory }: any) {
  const MODES = [["paper", "Paper"], ["live", "Live"], ["both", "Both"]];
  const CATS: [string, string][] = (() => {
    switch (defaultCategory) {
      case "all":         return [["all", "All"], ["crypto", "Crypto"], ["weather", "Weather"], ["hyperliquid", "HL Perp"], ["funding-arb", "Funding Arb"]];
      case "crypto":      return [["crypto", "Crypto"], ["all", "All"]];
      case "weather":     return [["weather", "Weather"], ["all", "All"]];
      case "hyperliquid": return [["hyperliquid", "HL Perp"], ["all", "All"]];
      case "funding-arb": return [["funding-arb", "Funding Arb"], ["all", "All"]];
      default:            return [["all", "All"]];
    }
  })();
  const DAYS = [["7", "7d"], ["30", "30d"], ["90", "90d"], ["all", "All"]];

  return (
    <div className="et-filters">
      <FilterGroup label="Mode" options={MODES} value={mode} onChange={setMode} />
      <FilterGroup label="Category" options={CATS} value={category} onChange={setCategory} />
      <FilterGroup label="Window" options={DAYS} value={days} onChange={setDays} />
    </div>
  );
}

function FilterGroup({ label, options, value, onChange }: any) {
  return (
    <div className="et-filter-group">
      <span className="et-filter-label">{label}</span>
      <div className="et-chip-row">
        {options.map(([v, l]: any) => (
          <button
            key={v}
            className={`et-chip ${value === v ? "active" : ""}`}
            onClick={() => onChange(v)}
          >{l}</button>
        ))}
      </div>
    </div>
  );
}

// ─── Summary KPI Cards ──────────────────────────────────

function SummaryCards({ s }: { s: SummaryStats }) {
  const pnlColor = s.totalPnl >= 0 ? "ec-pos" : "ec-neg";
  const wrColor = s.winRate >= 0.55 ? "ec-pos" : s.winRate >= 0.45 ? "ec-warn" : "ec-neg";
  const sharpColor = s.sharpeRatio >= 1.0 ? "ec-pos" : s.sharpeRatio >= 0.5 ? "ec-warn" : "ec-neg";
  const edgeColor = s.avgEdgeAtEntry >= 0.12 ? "ec-pos" : s.avgEdgeAtEntry >= 0.08 ? "ec-warn" : "ec-neg";
  const ddColor = s.maxDrawdownPct < 20 ? "ec-warn" : "ec-neg";
  const kColor = s.kellyEfficiency >= 0.8 && s.kellyEfficiency <= 1.2 ? "ec-pos" : "ec-warn";

  // Extended metrics colors. All "0 at small N" cards stay muted instead of
  // green, so the user doesn't read green into a meaningless number.
  const pfColor = s.totalTrades < 10 ? "ec-muted" : s.profitFactor >= 1.5 ? "ec-pos" : s.profitFactor >= 1.0 ? "ec-warn" : "ec-neg";
  const sortinoColor = s.totalTrades < 10 ? "ec-muted" : s.sortinoRatio >= 1.5 ? "ec-pos" : s.sortinoRatio >= 0.7 ? "ec-warn" : "ec-neg";
  const expColor = s.totalTrades < 10 ? "ec-muted" : s.expectancy > 0 ? "ec-pos" : "ec-neg";
  const payoffColor = s.totalTrades < 10 ? "ec-muted" : s.payoffRatio >= 1.5 ? "ec-pos" : s.payoffRatio >= 1.0 ? "ec-warn" : "ec-neg";
  // EV-gap: positive = beating model; negative = under-realizing. Threshold
  // in USD is bankroll-dependent — for the per-bot $150-200 bankroll, a
  // $5+ gap either way is meaningful.
  const evGapColor = Math.abs(s.evGap) < 2 ? "ec-muted" : s.evGap > 0 ? "ec-pos" : "ec-neg";
  // Streak: signed integer, positive = winning, negative = losing
  const streakColor = s.currentStreak > 0 ? "ec-pos" : s.currentStreak < 0 ? "ec-neg" : "ec-muted";

  // Sharpe CI sub-text. Show CI in compact form. When CI brackets zero, flag
  // it explicitly ("not yet significant").
  const ciBracketsZero = s.sharpeCiLo <= 0 && s.sharpeCiHi >= 0;
  const sharpeSub = s.totalTrades < 3
    ? "per-trade risk-adj"
    : ciBracketsZero
      ? `95% CI [${s.sharpeCiLo.toFixed(2)}, ${s.sharpeCiHi.toFixed(2)}] — n.s.`
      : `95% CI [${s.sharpeCiLo.toFixed(2)}, ${s.sharpeCiHi.toFixed(2)}]`;

  const ddSub = s.maxDrawdownDuration > 0
    ? `${s.maxDrawdownPct.toFixed(1)}% · ${s.maxDrawdownDuration}t deep`
    : `${s.maxDrawdownPct.toFixed(1)}%`;

  // EV gap: format $ with sign, sub explains direction in plain English.
  const evGapValue = `${s.evGap >= 0 ? "+" : ""}$${s.evGap.toFixed(2)}`;
  const evGapSub = s.evGap > 0 ? "actual > model" : s.evGap < 0 ? "actual < model" : "model parity";

  return (
    <>
      <div className="et-kpi-grid">
        <Card title="Total PnL" value={`${s.totalPnl >= 0 ? "+" : ""}$${s.totalPnl.toFixed(2)}`}
              sub={`${s.totalPnlPct.toFixed(1)}% vs start`} color={pnlColor} />
        <Card title="Win Rate" value={`${(s.winRate * 100).toFixed(1)}%`}
              sub={`${s.wins}/${s.totalTrades}`} color={wrColor} />
        <Card title="Sharpe" value={s.sharpeRatio.toFixed(2)}
              sub={sharpeSub} color={sharpColor} />
        <Card title="Avg Edge" value={`${(s.avgEdgeAtEntry * 100).toFixed(1)}%`}
              sub="at entry" color={edgeColor} />
        <Card title="Max DD" value={`$${s.maxDrawdown.toFixed(2)}`}
              sub={ddSub} color={ddColor} />
        <Card title="Kelly Eff" value={`${s.kellyEfficiency.toFixed(2)}×`}
              sub={`used ${(s.kellyUsed * 100).toFixed(1)}% / opt ${(s.kellyOptimal * 100).toFixed(1)}%`}
              color={kColor} />
      </div>
      <div className="et-kpi-grid et-kpi-grid-ext">
        <Card title="Profit Factor" value={s.profitFactor >= 999 ? "∞" : s.profitFactor.toFixed(2)}
              sub="Σwins / |Σlosses|" color={pfColor} />
        <Card title="Sortino" value={s.sortinoRatio.toFixed(2)}
              sub="downside-only Sharpe" color={sortinoColor} />
        <Card title="Expectancy" value={`${s.expectancy >= 0 ? "+" : ""}$${s.expectancy.toFixed(2)}`}
              sub="per trade" color={expColor} />
        <Card title="Payoff" value={s.payoffRatio >= 999 ? "∞" : `${s.payoffRatio.toFixed(2)}×`}
              sub="avgWin / avgLoss" color={payoffColor} />
        <Card title="EV Gap" value={evGapValue}
              sub={evGapSub} color={evGapColor} />
        <Card title="Streak"
              value={s.currentStreak === 0 ? "—" : `${s.currentStreak > 0 ? "+" : ""}${s.currentStreak}`}
              sub={`max ${s.longestWinStreak}W / ${s.longestLossStreak}L`}
              color={streakColor} />
      </div>
    </>
  );
}

function Card({ title, value, sub, color }: any) {
  return (
    <div className="et-card">
      <div className="et-card-label">{title}</div>
      <div className={`et-card-value ${color}`}>{value}</div>
      <div className="et-card-sub">{sub}</div>
    </div>
  );
}

// ─── Chart 1: Cumulative PnL (SVG) ──────────────────────

function CumulativePnlChart({ points }: { points: CumulativePoint[] }) {
  if (points.length < 2) return <EmptyChart title="Cumulative PnL" />;

  const W = 1000, H = 260, PAD = { t: 20, r: 20, b: 30, l: 55 };
  const innerW = W - PAD.l - PAD.r, innerH = H - PAD.t - PAD.b;

  const xMax = points.length;
  const allYs = points.flatMap((p) => [p.actual, p.random, p.ev]);
  const yMin = Math.min(...allYs, 0);
  const yMax = Math.max(...allYs, 0);
  const yRange = yMax - yMin || 1;

  const x = (i: number) => PAD.l + (i / Math.max(1, xMax - 1)) * innerW;
  const y = (v: number) => PAD.t + innerH - ((v - yMin) / yRange) * innerH;

  const path = (getter: (p: CumulativePoint) => number) =>
    points.map((p, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(getter(p)).toFixed(1)}`).join(" ");

  const zeroY = y(0);
  const gridY = [yMin, yMin + yRange * 0.25, yMin + yRange * 0.5, yMin + yRange * 0.75, yMax];

  return (
    <div className="et-chart">
      <div className="et-chart-header">
        <h3>Cumulative PnL vs Baselines</h3>
        <div className="et-legend">
          <LegendItem color={COLORS.actual} label="Actual" />
          <LegendItem color={COLORS.baseline} label="Random 50/50" dashed />
          <LegendItem color={COLORS.theoretical} label="EV baseline" dashed />
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="et-svg">
        {/* Grid */}
        {gridY.map((gv, i) => (
          <g key={i}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(gv)} y2={y(gv)} stroke={COLORS.border} strokeWidth={0.5} />
            <text x={PAD.l - 6} y={y(gv) + 3} fill={COLORS.muted} fontSize={10} textAnchor="end" fontFamily="monospace">
              ${gv.toFixed(0)}
            </text>
          </g>
        ))}
        {/* Zero line */}
        {yMin < 0 && yMax > 0 && (
          <line x1={PAD.l} x2={W - PAD.r} y1={zeroY} y2={zeroY} stroke={COLORS.muted} strokeWidth={0.8} />
        )}
        {/* Paths */}
        <path d={path((p) => p.random)} fill="none" stroke={COLORS.baseline} strokeWidth={1.5} strokeDasharray="4 3" />
        <path d={path((p) => p.ev)} fill="none" stroke={COLORS.theoretical} strokeWidth={1.5} strokeDasharray="4 3" />
        <path d={path((p) => p.actual)} fill="none" stroke={COLORS.actual} strokeWidth={2} />
        {/* X-axis labels */}
        <text x={PAD.l} y={H - 8} fill={COLORS.muted} fontSize={10} fontFamily="monospace">Trade 1</text>
        <text x={W - PAD.r} y={H - 8} fill={COLORS.muted} fontSize={10} textAnchor="end" fontFamily="monospace">
          Trade {xMax}
        </text>
      </svg>
    </div>
  );
}

// ─── Chart 1b: Underwater Drawdown ──────────────────────
// Running `actualCum − runningPeak` per trade. Always ≤ 0. The chart fills
// the area below zero so drawdown periods are visually unmistakable, and
// flat zero stretches mark "at peak" (the bot grinding higher).
// Complements the Max DD scalar in SummaryCards by showing duration +
// frequency of drawdowns, not just the worst one.

function UnderwaterDrawdownChart({
  points, maxDDDuration,
}: { points: CumulativePoint[]; maxDDDuration: number }) {
  if (points.length < 2) return <EmptyChart title="Drawdown (underwater curve)" />;

  const W = 1000, H = 180, PAD = { t: 18, r: 20, b: 28, l: 55 };
  const innerW = W - PAD.l - PAD.r, innerH = H - PAD.t - PAD.b;

  const xMax = points.length;
  const dds = points.map((p) => p.drawdown);
  // Drawdowns are always ≤ 0. Floor stretches the y-axis a bit so the
  // worst drawdown sits at ~95% of the chart height.
  const yMin = Math.min(...dds, 0) * 1.05;
  const yMax = 0;
  const yRange = (yMax - yMin) || 1;

  const x = (i: number) => PAD.l + (i / Math.max(1, xMax - 1)) * innerW;
  const y = (v: number) => PAD.t + innerH - ((v - yMin) / yRange) * innerH;

  // Build an area path from the underwater curve back to y=0 (top).
  // First the lower edge along the data, then back along zero.
  const top = y(0);
  const dataPath = points.map((p, i) =>
    `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(p.drawdown).toFixed(1)}`,
  ).join(" ");
  const areaPath = `${dataPath} L ${x(xMax - 1).toFixed(1)} ${top} L ${x(0).toFixed(1)} ${top} Z`;

  // Find index of the worst drawdown to annotate it.
  let worstIdx = 0;
  let worstVal = 0;
  for (let i = 0; i < points.length; i++) {
    if (points[i].drawdown < worstVal) { worstVal = points[i].drawdown; worstIdx = i; }
  }

  const gridY = [yMin, yMin * 0.5, 0];

  return (
    <div className="et-chart">
      <div className="et-chart-header">
        <h3>Drawdown (underwater curve)</h3>
        <span className="et-decay-slope">
          worst ${Math.abs(worstVal).toFixed(2)} {maxDDDuration > 0 ? `· ${maxDDDuration} trades deep` : ""}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="et-svg">
        {gridY.map((gv, i) => (
          <g key={i}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(gv)} y2={y(gv)}
                  stroke={COLORS.border} strokeWidth={0.5} />
            <text x={PAD.l - 6} y={y(gv) + 3} fill={COLORS.muted} fontSize={10}
                  textAnchor="end" fontFamily="monospace">
              ${gv.toFixed(0)}
            </text>
          </g>
        ))}
        {/* Zero line — top of the chart */}
        <line x1={PAD.l} x2={W - PAD.r} y1={top} y2={top}
              stroke={COLORS.muted} strokeWidth={0.8} />
        {/* Area fill */}
        <path d={areaPath} fill={COLORS.loss} fillOpacity={0.18} stroke="none" />
        {/* Outline */}
        <path d={dataPath} fill="none" stroke={COLORS.loss} strokeWidth={1.5} />
        {/* Worst-drawdown marker */}
        {worstVal < 0 && (
          <g>
            <circle cx={x(worstIdx)} cy={y(worstVal)} r={3.5}
                    fill={COLORS.loss} stroke={COLORS.surface} strokeWidth={1} />
            <text x={x(worstIdx)} y={y(worstVal) + 14} fill={COLORS.loss}
                  fontSize={10} textAnchor="middle" fontFamily="monospace">
              ${worstVal.toFixed(2)}
            </text>
          </g>
        )}
        {/* X-axis labels */}
        <text x={PAD.l} y={H - 8} fill={COLORS.muted} fontSize={10} fontFamily="monospace">Trade 1</text>
        <text x={W - PAD.r} y={H - 8} fill={COLORS.muted} fontSize={10}
              textAnchor="end" fontFamily="monospace">
          Trade {xMax}
        </text>
      </svg>
    </div>
  );
}

// ─── Chart 2: Calibration scatter ───────────────────────

function CalibrationChart({ buckets }: { buckets: CalibrationBucket[] }) {
  const valid = buckets.filter((b) => b.tradeCount > 0);
  if (valid.length < 2) return <EmptyChart title="Calibration" small />;

  const W = 480, H = 320, PAD = 40;
  const innerW = W - 2 * PAD, innerH = H - 2 * PAD;

  const scale = (v: number) => PAD + v * innerW;       // x
  const invScale = (v: number) => PAD + (1 - v) * innerH; // y

  const maxCount = Math.max(...valid.map((b) => b.tradeCount));

  return (
    <div className="et-chart">
      <div className="et-chart-header">
        <h3>Calibration (predicted vs actual)</h3>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="et-svg">
        {/* Grid */}
        {[0, 0.25, 0.5, 0.75, 1.0].map((v) => (
          <g key={v}>
            <line x1={scale(v)} x2={scale(v)} y1={PAD} y2={H - PAD} stroke={COLORS.border} strokeWidth={0.5} />
            <line x1={PAD} x2={W - PAD} y1={invScale(v)} y2={invScale(v)} stroke={COLORS.border} strokeWidth={0.5} />
            <text x={scale(v)} y={H - PAD + 14} fill={COLORS.muted} fontSize={9} textAnchor="middle" fontFamily="monospace">
              {(v * 100).toFixed(0)}%
            </text>
            <text x={PAD - 6} y={invScale(v) + 3} fill={COLORS.muted} fontSize={9} textAnchor="end" fontFamily="monospace">
              {(v * 100).toFixed(0)}%
            </text>
          </g>
        ))}
        {/* 45° reference line */}
        <line x1={scale(0)} y1={invScale(0)} x2={scale(1)} y2={invScale(1)}
              stroke={COLORS.theoretical} strokeWidth={1.5} strokeDasharray="5 3" />
        {/* Points */}
        {valid.map((b, i) => {
          const r = 3 + Math.sqrt(b.tradeCount / Math.max(1, maxCount)) * 12;
          const absDev = Math.abs(b.deviation);
          const color = absDev < 0.05 ? COLORS.actual : absDev < 0.15 ? COLORS.warn : COLORS.loss;
          return (
            <g key={i}>
              <circle cx={scale(b.predictedAvg)} cy={invScale(b.actualWinRate)} r={r}
                      fill={color} fillOpacity={0.6} stroke={color} strokeWidth={1}>
                <title>
                  {`Predicted: ${(b.predictedAvg * 100).toFixed(1)}% → Actual: ${(b.actualWinRate * 100).toFixed(1)}% (${b.tradeCount} trades)`}
                </title>
              </circle>
            </g>
          );
        })}
        <text x={W / 2} y={H - 8} fill={COLORS.muted} fontSize={10} textAnchor="middle" fontFamily="monospace">
          Predicted Probability
        </text>
        <text x={12} y={H / 2} fill={COLORS.muted} fontSize={10} textAnchor="middle" fontFamily="monospace"
              transform={`rotate(-90 12 ${H / 2})`}>
          Actual Win Rate
        </text>
      </svg>
    </div>
  );
}

// ─── Chart 3: Signal IC bars ────────────────────────────

function SignalICChart({ results }: { results: SignalICResult[] }) {
  return (
    <div className="et-chart">
      <div className="et-chart-header">
        <h3>Signal Information Coefficient</h3>
      </div>
      <div className="et-ic-list">
        {results.map((r) => {
          const abs = Math.abs(r.ic);
          const width = Math.min(100, abs * 400); // IC=0.25 → 100% width
          const color = r.strength === "strong" ? COLORS.actual
            : r.strength === "moderate" ? COLORS.theoretical
            : r.strength === "weak" ? COLORS.warn : COLORS.loss;
          return (
            <div key={r.signalName} className="et-ic-row">
              <div className="et-ic-name">{r.signalName.replace("_", " ")}</div>
              <div className="et-ic-bar-track">
                <div className="et-ic-bar-fill" style={{ width: `${width}%`, background: color }} />
                {/* Threshold line at IC=0.05 */}
                <div className="et-ic-threshold" style={{ left: `${0.05 * 400}%` }} />
              </div>
              <div className="et-ic-value" style={{ color }}>
                {r.ic >= 0 ? "+" : ""}{r.ic.toFixed(3)}
              </div>
            </div>
          );
        })}
      </div>
      <div className="et-chart-footer">
        Threshold: IC = 0.05 (significance) &nbsp;•&nbsp; Green ≥ 0.10, Cyan ≥ 0.05, Orange ≥ 0.02
      </div>
    </div>
  );
}

// ─── Chart 4: Edge Decay ────────────────────────────────

function EdgeDecayChart({ decay }: { decay: { points: EdgeDecayPoint[]; slope: number; hasDecay: boolean } }) {
  const { points, slope, hasDecay } = decay;
  if (points.length < 2) return <EmptyChart title="Edge Decay (weekly)" small />;

  const W = 1000, H = 220, PAD = { t: 20, r: 20, b: 40, l: 55 };
  const innerW = W - PAD.l - PAD.r, innerH = H - PAD.t - PAD.b;

  const ys = points.map((p) => p.avgEdge);
  const yMax = Math.max(...ys, 0.2);
  const yMin = Math.min(...ys, 0);
  const yRange = yMax - yMin || 0.01;

  const x = (i: number) => PAD.l + (i / Math.max(1, points.length - 1)) * innerW;
  const y = (v: number) => PAD.t + innerH - ((v - yMin) / yRange) * innerH;

  // Regression line
  const firstEdge = points[0].avgEdge;
  const mean = ys.reduce((s, v) => s + v, 0) / ys.length;
  const intercept = mean - slope * ((points.length - 1) / 2);
  const regY = (i: number) => slope * i + intercept;

  return (
    <div className="et-chart">
      <div className="et-chart-header">
        <h3>Edge Decay (weekly)</h3>
        {hasDecay && <span className="et-decay-warn">⚠ Decay trend detected</span>}
        <span className="et-decay-slope">slope: {slope.toFixed(4)}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="et-svg">
        {/* Grid */}
        {[0, 0.25, 0.5, 0.75, 1.0].map((t) => {
          const gv = yMin + yRange * t;
          return (
            <g key={t}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(gv)} y2={y(gv)} stroke={COLORS.border} strokeWidth={0.5} />
              <text x={PAD.l - 6} y={y(gv) + 3} fill={COLORS.muted} fontSize={10} textAnchor="end" fontFamily="monospace">
                {(gv * 100).toFixed(1)}%
              </text>
            </g>
          );
        })}
        {/* Line */}
        <path d={points.map((p, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${y(p.avgEdge)}`).join(" ")}
              fill="none" stroke={COLORS.actual} strokeWidth={2} />
        {/* Regression */}
        <line x1={x(0)} y1={y(regY(0))} x2={x(points.length - 1)} y2={y(regY(points.length - 1))}
              stroke={hasDecay ? COLORS.loss : COLORS.theoretical} strokeWidth={1} strokeDasharray="5 3" />
        {/* Points */}
        {points.map((p, i) => (
          <g key={i}>
            <circle cx={x(i)} cy={y(p.avgEdge)} r={4} fill={COLORS.actual}>
              <title>{`${p.week}: ${(p.avgEdge * 100).toFixed(1)}% edge (${p.tradeCount} trades)`}</title>
            </circle>
            <text x={x(i)} y={H - 8} fill={COLORS.muted} fontSize={9} textAnchor="middle" fontFamily="monospace">
              {p.week.slice(-3)}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

// ─── Chart 5: Win Rate Heatmap (CSS grid) ───────────────

function WinRateHeatmap({ cells }: { cells: HeatmapCell[] }) {
  const categories = Array.from(new Set(cells.map((c) => c.category))).sort();
  const lookup = new Map<string, HeatmapCell>();
  cells.forEach((c) => lookup.set(`${c.hour}|${c.category}`, c));

  if (categories.length === 0) return <EmptyChart title="Win Rate Heatmap" small />;

  const cellColor = (wr: number) => `hsl(${Math.round(wr * 120)}, 65%, 35%)`;

  return (
    <div className="et-chart">
      <div className="et-chart-header">
        <h3>Win Rate by Hour × Category (UTC)</h3>
      </div>
      <div className="et-heatmap" style={{ gridTemplateColumns: `60px repeat(24, 1fr)` }}>
        <div className="et-heat-corner" />
        {Array.from({ length: 24 }, (_, h) => (
          <div key={h} className="et-heat-hour">{h}</div>
        ))}
        {categories.flatMap((cat) => [
          <div key={`label-${cat}`} className="et-heat-cat">{cat}</div>,
          ...Array.from({ length: 24 }, (_, h) => {
            const c = lookup.get(`${h}|${cat}`);
            return (
              <div
                key={`cell-${h}-${cat}`}
                className="et-heat-cell"
                style={{ background: c ? cellColor(c.winRate) : "transparent" }}
                title={c ? `${cat} ${h}h: ${(c.winRate * 100).toFixed(0)}% win (${c.tradeCount}t)` : "no data"}
              >
                {c ? c.tradeCount : ""}
              </div>
            );
          }),
        ])}
      </div>
      <div className="et-chart-footer">
        Cells colored red→yellow→green by win rate. Numbers = trade count.
      </div>
    </div>
  );
}

// ─── Chart 6: PnL Distribution histogram ────────────────

function PnlDistribution({ bins }: { bins: HistogramBin[] }) {
  if (bins.length === 0) return <EmptyChart title="PnL Distribution" small />;
  const maxCount = Math.max(...bins.map((b) => b.count), 1);

  return (
    <div className="et-chart">
      <div className="et-chart-header">
        <h3>PnL Distribution</h3>
      </div>
      <div className="et-hist">
        {bins.map((b, i) => {
          const height = (b.count / maxCount) * 160;
          const isLoss = b.hi <= 0;
          return (
            <div key={i} className="et-hist-col" title={`$${b.lo.toFixed(1)} to $${b.hi.toFixed(1)}: ${b.count} trades`}>
              <div
                className="et-hist-bar"
                style={{ height: `${height}px`, background: isLoss ? COLORS.loss : COLORS.win }}
              />
            </div>
          );
        })}
      </div>
      <div className="et-hist-axis">
        <span>${bins[0]?.lo.toFixed(0)}</span>
        <span>0</span>
        <span>${bins[bins.length - 1]?.hi.toFixed(0)}</span>
      </div>
    </div>
  );
}

// ─── Trade Table ────────────────────────────────────────

function TradeTable({ trades }: { trades: TradeRow[] }) {
  if (trades.length === 0) {
    return (
      <div className="et-chart">
        <div className="et-chart-header"><h3>Recent Trades</h3></div>
        <div className="et-empty">No trades yet</div>
      </div>
    );
  }
  return (
    <div className="et-chart">
      <div className="et-chart-header">
        <h3>Recent Trades ({trades.length})</h3>
      </div>
      <div className="et-table-wrap tbl-scroll">
        <table className="ec-tbl">
          <thead>
            <tr>
              <th>Date</th><th>Cat</th><th>Market</th><th>Dir</th>
              <th>Edge</th><th>Entry</th><th>Exit</th><th>PnL</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t, i) => {
              const isYesLike = t.direction === "YES" || t.direction === "LONG";
              // Polymarket markets price in [0,1] (¢); HL perp prices in USD.
              const isBinaryPrice = t.entryPrice >= 0 && t.entryPrice <= 1;
              const fmtPrice = (p: number) =>
                isBinaryPrice
                  ? `${(p * 100).toFixed(0)}¢`
                  : p >= 1000 ? `$${p.toFixed(0)}` : `$${p.toFixed(2)}`;
              const pnl = Number.isFinite(t.pnl) ? t.pnl : 0;
              return (
                <tr key={i}>
                  <td>{new Date(t.closedAt).toLocaleDateString()} {new Date(t.closedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
                  <td><span className="ec-tag">{t.category}</span></td>
                  <td className="ec-mq">{t.market}</td>
                  <td className={isYesLike ? "ec-pos" : "ec-neg"}>{t.direction}</td>
                  <td>{((t.edgeAtEntry ?? 0) * 100).toFixed(1)}%</td>
                  <td>{fmtPrice(t.entryPrice)}</td>
                  <td>{fmtPrice(t.exitPrice)}</td>
                  <td className={pnl >= 0 ? "ec-pos" : "ec-neg"}>
                    {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Calibration view (realized vs prior IC) ────────────

function CalibrationViewCard({ view }: { view: CalibrationView }) {
  const signals = Object.keys(view.priors);
  const ts = view.computedAt
    ? new Date(view.computedAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })
    : "—";
  return (
    <div className="et-chart">
      <div className="et-chart-header">
        <h3>Signal IC calibration ({view.category})</h3>
        <span className={`et-cal-toggle ${view.useRealizedIC ? "et-cal-on" : "et-cal-off"}`}>
          {view.useRealizedIC ? "ON" : "OFF"} · K={view.shrinkageK} · N={view.sampleSize} · {ts}
        </span>
      </div>
      <div className="et-cal-grid">
        <div className="et-cal-head et-cal-name">Signal</div>
        <div className="et-cal-head">Prior</div>
        <div className="et-cal-head">Realized (n)</div>
        <div className="et-cal-head">Effective</div>
        {signals.map((s) => {
          const prior = view.priors[s] ?? 0;
          const r = view.realized[s];
          const eff = view.effective[s] ?? prior;
          const delta = eff - prior;
          return (
            <Fragment key={s}>
              <div className="et-cal-name">{s.replace("_", " ")}</div>
              <div className="et-cal-val">{(prior * 100).toFixed(1)}%</div>
              <div className="et-cal-val">
                {r && r.n > 0 ? `${(r.ic * 100).toFixed(1)}% (${r.n})` : <span className="et-cal-muted">—</span>}
              </div>
              <div className={`et-cal-val ${delta > 0.005 ? "ec-pos" : delta < -0.005 ? "ec-neg" : ""}`}>
                {(eff * 100).toFixed(1)}%
              </div>
            </Fragment>
          );
        })}
      </div>
      <div className="et-chart-footer">
        {view.useRealizedIC
          ? `Live calibrált — a combiner az 'Effective' oszlopot használja (priors keverve a realized IC-vel, K=${view.shrinkageK} shrinkage).`
          : `Statikus prior aktív — kapcsold be: Settings → Signal calibration → "Use realized IC". Sample-size növelése csökkenti a shrinkage súlyát (N=${view.sampleSize}, K=${view.shrinkageK} → realized weight ≈ ${((view.sampleSize / Math.max(1, view.sampleSize + view.shrinkageK)) * 100).toFixed(0)}%).`}
      </div>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────

function LegendItem({ color, label, dashed }: any) {
  return (
    <div className="et-legend-item">
      <span className="et-legend-dot" style={{
        background: dashed ? "none" : color,
        borderTop: dashed ? `2px dashed ${color}` : "none",
      }} />
      <span>{label}</span>
    </div>
  );
}

function EmptyChart({ title, small }: { title: string; small?: boolean }) {
  return (
    <div className={`et-chart ${small ? "et-chart-small" : ""}`}>
      <div className="et-chart-header"><h3>{title}</h3></div>
      <div className="et-empty">Not enough data</div>
    </div>
  );
}

// ─── Styles ─────────────────────────────────────────────

const styles = `
.et-filters { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; padding: 12px; background: var(--surface); border: 1px solid var(--border); border-radius: 4px; }
.et-filter-group { display: flex; align-items: center; gap: 8px; }
.et-filter-label { font-family: var(--mono); font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; }
.et-chip-row { display: flex; gap: 4px; }
.et-chip { background: var(--surface2); border: 1px solid var(--border); color: var(--muted); font-family: var(--mono); font-size: 10px; padding: 4px 10px; border-radius: 12px; cursor: pointer; transition: all 0.15s; text-transform: uppercase; letter-spacing: 0.07em; }
.et-chip:hover { color: var(--text); border-color: var(--accent); }
.et-chip.active { background: #0f1f00; border-color: var(--accent); color: var(--accent); }

.et-error { background: rgba(241,53,53,0.1); border: 1px solid var(--danger); color: var(--danger); padding: 12px; border-radius: 4px; font-family: var(--mono); font-size: 12px; margin-bottom: 12px; }
.et-loading { color: var(--muted); font-family: var(--mono); font-size: 12px; padding: 20px; text-align: center; }
.et-mock-banner { background: rgba(241,160,53,0.08); border: 1px solid var(--warn); color: var(--warn); padding: 10px 14px; border-radius: 4px; font-family: var(--mono); font-size: 11px; margin-bottom: 14px; }
.et-warn-banner { background: rgba(241,160,53,0.08); border: 1px solid var(--warn); color: var(--warn); padding: 8px 14px; border-radius: 4px; font-family: var(--mono); font-size: 11px; margin-bottom: 14px; }


.et-kpi-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; margin-bottom: 18px; }
.et-kpi-grid-ext { margin-top: -8px; }
.et-kpi-grid-ext .et-card { background: var(--surface2); }
.et-card { background: var(--surface); border: 1px solid var(--border); border-radius: 4px; padding: 12px 10px; text-align: center; }
.et-card-label { font-family: var(--mono); font-size: 9px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 4px; }
.et-card-value { font-family: var(--mono); font-size: 20px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.1; }
.et-card-sub { font-family: var(--mono); font-size: 9px; color: var(--muted); margin-top: 3px; }

.et-chart { background: var(--surface); border: 1px solid var(--border); border-radius: 4px; padding: 16px; margin-bottom: 14px; }
.et-chart-small { padding: 14px; }
.et-chart-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; flex-wrap: wrap; gap: 8px; }
.et-chart-header h3 { font-family: var(--mono); font-size: 11px; color: var(--text); text-transform: uppercase; letter-spacing: 0.1em; margin: 0; font-weight: 700; }
.et-chart-footer { font-family: var(--mono); font-size: 9px; color: var(--muted); margin-top: 10px; }
.et-svg { width: 100%; height: auto; display: block; }

.et-legend { display: flex; gap: 14px; }
.et-legend-item { display: flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: 10px; color: var(--muted); }
.et-legend-dot { width: 16px; height: 3px; border-radius: 2px; }

.et-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }

.et-ic-list { display: flex; flex-direction: column; gap: 10px; padding: 4px 0; }
.et-ic-row { display: grid; grid-template-columns: 110px 1fr 60px; align-items: center; gap: 10px; }
.et-ic-name { font-family: var(--mono); font-size: 10px; color: var(--muted); text-transform: uppercase; }
.et-ic-bar-track { position: relative; height: 14px; background: var(--surface2); border-radius: 2px; overflow: hidden; }
.et-ic-bar-fill { height: 100%; transition: width 0.5s ease; }
.et-ic-threshold { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--warn); opacity: 0.6; }
.et-ic-value { font-family: var(--mono); font-size: 11px; text-align: right; font-weight: 700; }

.et-decay-warn { font-family: var(--mono); font-size: 10px; color: var(--danger); font-weight: 700; }
.et-decay-slope { font-family: var(--mono); font-size: 10px; color: var(--muted); }

.et-heatmap { display: grid; gap: 2px; font-family: var(--mono); font-size: 9px; }
.et-heat-corner, .et-heat-hour, .et-heat-cat, .et-heat-cell { padding: 4px 2px; text-align: center; color: var(--muted); }
.et-heat-hour { border-bottom: 1px solid var(--border); }
.et-heat-cat { text-align: right; padding-right: 8px; text-transform: capitalize; color: var(--text); }
.et-heat-cell { min-height: 22px; border-radius: 2px; color: var(--text); font-weight: 700; display: flex; align-items: center; justify-content: center; }

.et-hist { display: flex; align-items: flex-end; gap: 1px; height: 160px; padding: 0 4px; }
.et-hist-col { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; }
.et-hist-bar { width: 100%; border-radius: 2px 2px 0 0; opacity: 0.85; transition: height 0.4s ease; }
.et-hist-axis { display: flex; justify-content: space-between; font-family: var(--mono); font-size: 9px; color: var(--muted); padding: 6px 4px 0; }

.et-cal-toggle { font-family: var(--mono); font-size: 9.5px; padding: 3px 8px; border-radius: 10px; letter-spacing: 0.06em; }
.et-cal-on  { background: rgba(200,241,53,0.12); color: #c8f135; border: 1px solid rgba(200,241,53,0.5); }
.et-cal-off { background: rgba(241,160,53,0.10); color: #f1a035; border: 1px solid rgba(241,160,53,0.45); }
.et-cal-grid { display: grid; grid-template-columns: 1.6fr 1fr 1.4fr 1fr; gap: 6px 14px; font-family: var(--mono); font-size: 11px; padding: 6px 0; }
.et-cal-head { color: var(--muted); font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.08em; border-bottom: 1px solid var(--border); padding-bottom: 4px; }
.et-cal-name { color: var(--text); text-transform: capitalize; }
.et-cal-val  { color: var(--text); text-align: left; }
.et-cal-muted { color: var(--muted); }
@media (max-width: 480px) {
  .et-cal-grid { grid-template-columns: 1.4fr 0.9fr 1.2fr 1fr; font-size: 10px; gap: 4px 8px; }
}
.et-table-wrap { overflow-x: auto; }
.et-empty { text-align: center; padding: 30px; color: var(--muted); font-family: var(--mono); font-size: 11px; }

@media (max-width: 768px) {
  .et-kpi-grid { grid-template-columns: repeat(3, 1fr); }
  .et-grid2 { grid-template-columns: 1fr; }
  .et-heatmap { font-size: 8px; }
}
@media (max-width: 480px) {
  .et-kpi-grid { grid-template-columns: repeat(2, 1fr); }
}
`;
