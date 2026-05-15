// Reusable result-card library for every Auto-Trader category.
//
// All bots route their per-tick scan output through these components so a
// crypto trade row, a weather scan row and a hyperliquid coin row all share
// the same validation-chip language, the same action chip palette and the
// same "why we entered / why we skipped" reason footer.
//
// The two key components are <ScanResultsCard> (header + config line + rows)
// and <ScanResultRow> (the universal market row with title, chips, signal
// arrows, action, optional size/entry/pnl and a reason footer).

import type { ReactNode } from "react";

/* ─── Action types ─────────────────────────────────────── */

export type ActionKind =
  | "skip"
  | "position_opened"
  | "opened"
  | "closed"
  | "traded"
  | "failed"
  | "error"
  | "close_error";

/* ─── Chip ─────────────────────────────────────────────── */

export interface ResultChip {
  label: string;
  /** Visual tone. Default: neutral surface chip. */
  tone?: "default" | "pos" | "neg" | "warn" | "info";
  /** When true: outline-only (transparent bg, coloured border + text). */
  outline?: boolean;
  /** Native title for hover tooltip — great for explaining edge math. */
  title?: string;
}

export function Chip({ chip }: { chip: ResultChip }) {
  const cls =
    "ts-chip" +
    (chip.tone && chip.tone !== "default" ? ` ts-chip-${chip.tone}` : "") +
    (chip.outline ? " ts-chip-outline" : "");
  return (
    <span className={cls} title={chip.title}>
      {chip.label}
    </span>
  );
}

/* ─── Signal arrow ─────────────────────────────────────── */

export interface SignalArrow {
  /** Short label, e.g. "FR", "VPIN". */
  name: string;
  /** Numeric score in [0,1], or null/undefined when the signal is missing. */
  score: number | null | undefined;
  /** Optional native title — defaults to the numeric score for quick hover. */
  title?: string;
}

export function SignalRow({ signals }: { signals: SignalArrow[] }) {
  if (!signals.length) return null;
  return (
    <div className="ts-row-signals">
      {signals.map((s) => {
        const off = s.score === null || s.score === undefined;
        const arrow = off ? "·" : s.score! > 0.5 ? "↑" : "↓";
        const cls = off
          ? "ts-sig ts-sig-off"
          : s.score! > 0.5
          ? "ts-sig ts-sig-up"
          : "ts-sig ts-sig-down";
        const tooltip =
          s.title ||
          (off ? `${s.name}: no signal` : `${s.name}: ${(s.score! * 100).toFixed(0)}%`);
        return (
          <span key={s.name} className={cls} title={tooltip}>
            {s.name}{arrow}
          </span>
        );
      })}
    </div>
  );
}

/* ─── Criteria gate ────────────────────────────────────── */

// One pass/fail check applied to a scanned market row. Used by the
// CriteriaSummary chip + popover below — the operator can hover any row
// and see exactly which thresholds passed and which didn't.
//
// Mirror of the backend's `DecisionGate` shape (shared/types.mts) so HL
// + funding-arb can ship gates straight from the scan loop and the UI
// renders them without a per-bot translation.
export interface CriteriaGate {
  /** Short label, e.g. "edge ≥ threshold". */
  label: string;
  /** Did this gate pass for this row? */
  passed: boolean;
  /** Stringified actual value (e.g. "+13.0%", "0.07"). Optional —
   *  some gates (e.g. "not evaluated" placeholders) leave it blank. */
  actual?: string;
  /** Stringified required threshold (e.g. "≥ 4.0%", "≤ 8.0%"). */
  required?: string;
  /** Optional one-line tooltip explaining the gate. */
  hint?: string;
}

/** Compact "X/Y gates ✓" chip with a hover popover that lists every gate.
 *  Pure CSS — no JS needed for the hover interaction. Rendered uniformly
 *  on every scan-row across all four bots so the operator can compare
 *  at a glance and hover for the breakdown. */
function CriteriaSummary({ gates }: { gates: CriteriaGate[] }) {
  if (!gates.length) return null;
  const passed = gates.filter((g) => g.passed).length;
  const total  = gates.length;
  const failed = total - passed;
  const allPass = passed === total;
  const tone = allPass ? "pos" : passed === 0 ? "neg" : "warn";
  // Trail label spells out the failure count when not all pass — operator
  // doesn't have to do mental math from "2/8".
  const trail = allPass ? "✓" : `· ${failed}✗`;
  return (
    <span className={`ts-crit ts-crit-${tone}`} tabIndex={0}>
      <span className="ts-crit-chip">
        {passed}/{total} gates {trail}
      </span>
      <div className="ts-crit-popover" role="tooltip">
        <div className="ts-crit-popover-head">
          Belépési kritériumok • {passed} / {total} teljesült{failed > 0 ? ` · ${failed} bukás` : ""}
        </div>
        {gates.map((g, i) => (
          <div
            key={i}
            className={`ts-crit-row ${g.passed ? "ts-crit-pass" : "ts-crit-fail"}`}
            title={g.hint}
          >
            <span className="ts-crit-mark">{g.passed ? "✓" : "✗"}</span>
            <span className="ts-crit-label">{g.label}</span>
            <span className="ts-crit-actual">{g.actual ?? "—"}</span>
            <span className="ts-crit-req">{g.required ?? ""}</span>
          </div>
        ))}
      </div>
    </span>
  );
}

/* ─── ScanResultRow ────────────────────────────────────── */

export interface ScanRowProps {
  /** Required key ↑ propagated by parent. */
  /** Human-readable title (e.g. market title). */
  title: string;
  /** Optional small prefix chip rendered before the title — e.g. "BTC" or
   *  city emoji. */
  prefix?: string;
  /** Native tooltip on the title (full id, slug, etc.) */
  titleTip?: string;
  /** Optional "open on venue" deep-link rendered after the title as a small
   *  ↗ icon. Use the helpers in `./marketLinks.ts` to build this — Polymarket
   *  for crypto/weather/sports, Hyperliquid for HL Perp + F-Arb perp-side. */
  link?: string | null;
  action: ActionKind | string;
  /** Validation / context chips: market price, model %, edge, direction… */
  chips?: ResultChip[];
  /** Per-signal arrow row (orderflow, vol-div, …). */
  signals?: SignalArrow[];
  /** Per-row entry-criteria pass/fail — drives the hover gate popover. */
  criteria?: CriteriaGate[];
  /** Right-side small detail line (e.g. "$3.40 @ 54¢"). */
  extra?: string;
  /** Right-side P&L (formatted, with sign). Coloured by `pnlValue`. */
  pnl?: string;
  pnlValue?: number;
  /** Decision reason, shown muted under the row. */
  reason?: string;
  /** When true: render reason in danger colour (parser/exec error). */
  isErrorReason?: boolean;
}

export function ScanResultRow(p: ScanRowProps) {
  const pnlColor =
    p.pnlValue === undefined
      ? undefined
      : p.pnlValue >= 0
      ? "var(--accent)"
      : "var(--danger)";

  // Decide the row's overall tone so the operator can spot at a glance
  // whether the bot acted, was filtered out, or hit an error. Driven by the
  // action verb plus the criteria-gate verdict for "skip" rows.
  const a = String(p.action);
  const failedGates = (p.criteria ?? []).filter((g) => !g.passed);
  let tone: "pass" | "skip" | "fail" | "neutral" = "neutral";
  if (a === "traded" || a === "position_opened" || a === "opened") tone = "pass";
  else if (a === "closed") tone = "neutral";
  else if (a === "failed" || a === "error" || a === "close_error") tone = "fail";
  else if (a === "skip") tone = failedGates.length > 0 ? "skip" : "neutral";

  // Surface the FIRST failing gate as a visible chip next to the action so
  // the operator doesn't have to hover the gates popover to see what blocked
  // a skip.
  const firstFail = failedGates[0];

  return (
    <div className={`ts-row ts-row-${tone}`}>
      <div className="ts-row-main">
        <div className="ts-row-title" title={p.titleTip || p.title}>
          {p.prefix && <span className="ts-row-title-prefix">{p.prefix}</span>}
          <span className="ts-row-title-text">{p.title}</span>
          {p.link && (
            <a
              href={p.link}
              target="_blank"
              rel="noopener noreferrer"
              className="ts-row-title-link"
              title="Megnyitás a venue oldalán (új fülön)"
              onClick={(e) => e.stopPropagation()}
            >
              ↗
            </a>
          )}
        </div>
        {p.chips && p.chips.length > 0 && (
          <div className="ts-row-chips">
            {p.chips.map((c, i) => <Chip key={i} chip={c} />)}
            {p.criteria && <CriteriaSummary gates={p.criteria} />}
          </div>
        )}
        {(!p.chips || p.chips.length === 0) && p.criteria && p.criteria.length > 0 && (
          <div className="ts-row-chips">
            <CriteriaSummary gates={p.criteria} />
          </div>
        )}
        {p.signals && <SignalRow signals={p.signals} />}
        {tone === "skip" && firstFail && (
          <div className="ts-row-blocker" title={firstFail.hint}>
            <span className="ts-row-blocker-mark">✗</span>
            <span className="ts-row-blocker-label">{firstFail.label}</span>
            <span className="ts-row-blocker-actual">{firstFail.actual ?? "—"}</span>
            <span className="ts-row-blocker-req">{firstFail.required ?? ""}</span>
            {failedGates.length > 1 && (
              <span className="ts-row-blocker-more">+{failedGates.length - 1} további</span>
            )}
          </div>
        )}
      </div>
      <span className={`ts-row-action ts-act-${p.action}`}>
        {String(p.action).replace(/_/g, " ")}
      </span>
      {p.extra && <span className="ts-row-extra">{p.extra}</span>}
      {p.pnl && (
        <span className="ts-row-pnl" style={{ color: pnlColor }}>
          {p.pnl}
        </span>
      )}
      {p.reason && (
        <div
          className={`ts-row-reason${p.isErrorReason ? " ts-row-reason-error" : ""}`}
        >
          {p.reason}
        </div>
      )}
    </div>
  );
}

/* ─── ScanResultsCard ──────────────────────────────────── */

export interface ScanResultsCardProps {
  /** Header line, e.g. "Scanned 7 BTC up/down markets · evaluated top 3". */
  headerText: string;
  /** Optional tag rendered after the header — typically the source tag. */
  source?: "manual" | "cron" | null;
  /** Extra tags rendered next to the source (e.g. model lag indicator). */
  tags?: { text: string; tone?: "info" | "warn" | "default" }[];
  /** Optional one-line config summary (edge thresholds, fees, etc.) */
  configLine?: string;
  children?: ReactNode;
}

export function ScanResultsCard(p: ScanResultsCardProps) {
  return (
    <div className="ts-card">
      <h3 className="ts-card-head">
        <strong>{p.headerText}</strong>
        {p.tags?.map((t, i) => (
          <span
            key={i}
            className={`ts-tag${t.tone && t.tone !== "default" ? ` ts-tag-${t.tone}` : ""}`}
          >
            {t.text}
          </span>
        ))}
        {p.source && <span className="ts-tag">via {p.source}</span>}
      </h3>
      {p.configLine && <div className="ts-cfgline">{p.configLine}</div>}
      {p.children}
    </div>
  );
}

/* ─── Per-bot criteria mappers ─────────────────────────── */

// Pure helpers — given the per-row scan data + the per-tick config, build
// the list of pass/fail gates that determined whether the bot would enter
// this trade. Lives here so the four trader panels render an identical
// hover popover and so adding a new gate touches only one file.

interface CryptoRowCriteriaIn {
  netEdge?: number;
  edge?: number;
  marketPrice?: number;
  kellyUsed?: number;
  activeSignals?: number;
  obImbalance?: { ratio: number; direction: "UP" | "DOWN" | "NEUTRAL" } | null;
  direction?: "YES" | "NO";
}
interface CryptoCfgCriteriaIn {
  edgeThreshold:    number;
  maxKellyFraction: number;
  btcMinPriceBand:  number;
}
export function cryptoEntryCriteria(
  r: CryptoRowCriteriaIn,
  cfg?: CryptoCfgCriteriaIn,
): CriteriaGate[] {
  const gates: CriteriaGate[] = [];
  const edge = r.netEdge ?? r.edge;

  if (cfg && edge !== undefined) {
    gates.push({
      label: "Net edge ≥ küszöb",
      passed: edge >= cfg.edgeThreshold,
      actual: `${edge >= 0 ? "+" : ""}${(edge * 100).toFixed(2)}%`,
      required: `≥ ${(cfg.edgeThreshold * 100).toFixed(1)}%`,
      hint: "Modell-prob × payout − fees − market price (signed).",
    });
  }
  if (cfg && r.marketPrice !== undefined) {
    const lo = cfg.btcMinPriceBand;
    const hi = 1 - cfg.btcMinPriceBand;
    const inBand = r.marketPrice >= lo && r.marketPrice <= hi;
    gates.push({
      label: "Market price entry-band-ben",
      passed: inBand,
      actual: `${(r.marketPrice * 100).toFixed(0)}¢`,
      required: `[${(lo * 100).toFixed(0)}¢, ${(hi * 100).toFixed(0)}¢]`,
      hint: "A deep-OTM piacokon $0.01 fill artefakt torzítja az IC-t.",
    });
  }
  if (cfg && r.kellyUsed !== undefined && r.kellyUsed > 0) {
    gates.push({
      label: "Kelly méret ≤ cap",
      passed: r.kellyUsed <= cfg.maxKellyFraction,
      actual: `${(r.kellyUsed * 100).toFixed(2)}%`,
      required: `≤ ${(cfg.maxKellyFraction * 100).toFixed(1)}%`,
      hint: "¼-Kelly + intézményi 8% hard cap.",
    });
  }
  if (r.activeSignals !== undefined) {
    gates.push({
      label: "Aktív signal források",
      passed: r.activeSignals >= 2,
      actual: `${r.activeSignals}/5`,
      required: "≥ 2",
      hint: "Egyetlen signal-tól nem indítunk pozíciót.",
    });
  }
  if (r.obImbalance && r.direction) {
    const obDir = r.obImbalance.direction;
    const aligned =
      (r.direction === "YES" && obDir === "UP") ||
      (r.direction === "NO"  && obDir === "DOWN") ||
      obDir === "NEUTRAL";
    gates.push({
      label: "Order book imbalance gate",
      passed: aligned,
      actual: `OB ${obDir}`,
      required: r.direction === "YES" ? "UP / NEUTRAL" : "DOWN / NEUTRAL",
      hint: "Binance top-10 depth ratio, mint konvergencia szignál.",
    });
  }
  return gates;
}

interface WeatherRowCriteriaIn {
  edge?: number;
  confidence?: number;
}
interface WeatherCfgCriteriaIn {
  edgeThreshold: number;
  confidenceMin: number;
  maxEdgeCap:    number;
}
export function weatherEntryCriteria(
  r: WeatherRowCriteriaIn,
  cfg?: WeatherCfgCriteriaIn,
): CriteriaGate[] {
  const gates: CriteriaGate[] = [];
  if (!cfg) return gates;
  if (r.edge !== undefined) {
    gates.push({
      label: "Edge ≥ küszöb",
      passed: r.edge >= cfg.edgeThreshold,
      actual: `${r.edge >= 0 ? "+" : ""}${(r.edge * 100).toFixed(2)}%`,
      required: `≥ ${(cfg.edgeThreshold * 100).toFixed(1)}%`,
    });
    gates.push({
      label: "Edge ≤ cap (model-error gate)",
      passed: Math.abs(r.edge) <= cfg.maxEdgeCap,
      actual: `${(Math.abs(r.edge) * 100).toFixed(1)}%`,
      required: `≤ ${(cfg.maxEdgeCap * 100).toFixed(0)}%`,
      hint: "Túl nagy edge valószínűleg model-error, nem opportunity.",
    });
  }
  if (r.confidence !== undefined) {
    gates.push({
      label: "Confidence ≥ küszöb",
      passed: r.confidence >= cfg.confidenceMin,
      actual: `${(r.confidence * 100).toFixed(0)}%`,
      required: `≥ ${(cfg.confidenceMin * 100).toFixed(0)}%`,
      hint: "Forecast confidence az ensemble σ alapján.",
    });
  }
  return gates;
}

interface HlRowCriteriaIn {
  edge?: number;
  predictedProb?: number;
  notionalUSD?: number;
  leverage?: number;
}
interface HlCfgCriteriaIn {
  edgeThreshold?:    number;
  maxNotionalUSD?:   number;
  maxLeverage?:      number;
}
export function hlEntryCriteria(
  r: HlRowCriteriaIn,
  cfg?: HlCfgCriteriaIn,
): CriteriaGate[] {
  const gates: CriteriaGate[] = [];
  if (cfg?.edgeThreshold !== undefined && r.edge !== undefined) {
    gates.push({
      label: "Net edge ≥ küszöb",
      passed: r.edge >= cfg.edgeThreshold,
      actual: `${r.edge >= 0 ? "+" : ""}${(r.edge * 100).toFixed(2)}%`,
      required: `≥ ${(cfg.edgeThreshold * 100).toFixed(1)}%`,
    });
  }
  if (cfg?.maxNotionalUSD !== undefined && r.notionalUSD !== undefined) {
    gates.push({
      label: "Notional ≤ cap",
      passed: r.notionalUSD <= cfg.maxNotionalUSD,
      actual: `$${r.notionalUSD.toFixed(0)}`,
      required: `≤ $${cfg.maxNotionalUSD.toFixed(0)}`,
    });
  }
  if (cfg?.maxLeverage !== undefined && r.leverage !== undefined) {
    gates.push({
      label: "Leverage ≤ cap",
      passed: r.leverage <= cfg.maxLeverage,
      actual: `${r.leverage}×`,
      required: `≤ ${cfg.maxLeverage}×`,
    });
  }
  return gates;
}

interface ArbRowCriteriaIn {
  spreadAnnualized?: number;
  spreadHourly?: number;
  openInterestM?: number;
}
interface ArbCfgCriteriaIn {
  minAnnualized?: number;
  minOpenInterestM?: number;
}
export function arbEntryCriteria(
  r: ArbRowCriteriaIn,
  cfg?: ArbCfgCriteriaIn,
): CriteriaGate[] {
  const gates: CriteriaGate[] = [];
  if (cfg?.minAnnualized !== undefined && r.spreadAnnualized !== undefined) {
    gates.push({
      label: "Annualised spread ≥ küszöb",
      passed: r.spreadAnnualized >= cfg.minAnnualized,
      actual: `${r.spreadAnnualized.toFixed(1)}%/yr`,
      required: `≥ ${cfg.minAnnualized.toFixed(1)}%/yr`,
    });
  }
  if (cfg?.minOpenInterestM !== undefined && r.openInterestM !== undefined) {
    gates.push({
      label: "Open interest ≥ küszöb",
      passed: r.openInterestM >= cfg.minOpenInterestM,
      actual: `$${r.openInterestM.toFixed(0)}M`,
      required: `≥ $${cfg.minOpenInterestM.toFixed(0)}M`,
      hint: "Likviditási garancia a leszálláshoz.",
    });
  }
  return gates;
}

/* ─── Pending positions card (weather paper trades) ────── */

export interface PendingPositionLite {
  /** Primary key shown bold (city, coin, symbol). */
  primary: string;
  /** Secondary meta line (date, slug). */
  secondary?: string;
  /** Optional "open on venue" deep-link rendered as a ↗ icon next to the
   *  primary text. Built via helpers in `./marketLinks.ts`. */
  link?: string | null;
  /** Optional bucket / band chip. */
  bucket?: string;
  /** YES / NO direction chip, or LONG / SHORT. */
  direction?: "YES" | "NO" | "LONG" | "SHORT";
  /** Centre prediction text, e.g. "pred 24°C" or "spread 0.12%". */
  predictionText?: string;
  /** Right-aligned size, e.g. "$4.20". */
  sizeText: string;
  /** Right-most cell: time-until or "ready" badge. */
  whenText: string;
  /** When true the row gets the green "ready" border. */
  isReady?: boolean;
}

export interface PendingPositionsCardProps {
  title: string;
  positions: PendingPositionLite[];
  footnote?: string;
}

export function PendingPositionsCard(p: PendingPositionsCardProps) {
  if (!p.positions.length) return null;
  return (
    <div className="ts-card ts-card-accent">
      <h3 className="ts-card-head" style={{ color: "var(--accent2)" }}>
        <strong>{p.title}</strong>
      </h3>
      {p.positions.map((pos, i) => (
        <div
          key={i}
          className={`ts-pending-row${pos.isReady ? " ts-ready" : ""}`}
        >
          <span className="ts-pending-key">
            {pos.primary}
            {pos.link && (
              <a
                href={pos.link}
                target="_blank"
                rel="noopener noreferrer"
                className="ts-row-title-link"
                title="Megnyitás a venue oldalán (új fülön)"
                onClick={(e) => e.stopPropagation()}
              >
                ↗
              </a>
            )}
          </span>
          {pos.secondary && <span className="ts-pending-meta">{pos.secondary}</span>}
          {pos.bucket && <span className="ts-pending-bucket">{pos.bucket}</span>}
          {pos.direction && (
            <span
              className={
                "ts-pending-dir " +
                (pos.direction === "YES" || pos.direction === "LONG"
                  ? "ts-pending-dir-YES"
                  : "ts-pending-dir-NO")
              }
            >
              {pos.direction}
            </span>
          )}
          {pos.predictionText && (
            <span className="ts-pending-pred">{pos.predictionText}</span>
          )}
          <span className="ts-pending-size">{pos.sizeText}</span>
          <span className="ts-pending-when">{pos.whenText}</span>
        </div>
      ))}
      {p.footnote && <div className="ts-pending-foot">{p.footnote}</div>}
    </div>
  );
}

/* ─── Open positions card ──────────────────────────────── */

// Frozen-at-entry rationale payload, rendered by the expandable
// "Why this trade?" panel on each open position row. Optional — positions
// opened before the auto-trader started persisting the decision snapshot
// (or non-crypto categories that don't fill it in) get a "no data" panel.
export interface OpenPositionRationale {
  decidedAt: string;
  /** "prob"   = crypto / weather / HL perp (model finalProb vs market price).
   *  "spread" = funding-arb (HL hourly rate vs Binance hourly rate). */
  flavor?: "prob" | "spread";
  finalProb: number;
  marketPrice: number;
  grossEdge: number;
  netEdge: number;
  feePct: number;
  direction: "YES" | "NO" | "LONG" | "SHORT";
  kellyRaw: number;
  kellyCapped: number;
  kellyCap: number;
  positionSizeUSDC: number;
  entryPrice: number;
  /** Optional pre-formatted entry-price label. If absent, falls back to
   *  "(entryPrice * 100).toFixed(0)¢" — correct for prob-space bots
   *  (crypto, weather). HL perp passes "$108,432" so the thesis line
   *  reads naturally without converting USD prices to cents. */
  entryPriceLabel?: string;
  /** Optional pre-formatted market-price label. Same fallback rule. */
  marketPriceLabel?: string;
  /** Spread-flavor extras (funding-arb). */
  spreadAnnualizedPct?: number;
  openInterestUSD?: number;
  activeSignals: number;
  signalBreakdown: {
    funding_rate?: number | null;
    orderflow?: number | null;
    vol_divergence?: number | null;
    apex_consensus?: number | null;
    cond_prob?: number | null;
    // Kakushadze 151-strategies signals — also fed into the combiner +
    // Kelly. Optional so older snapshots (pre-2026-05-10) keep parsing.
    momentum?: number | null;
    contrarian?: number | null;
    pairs_spread?: number | null;
  } | null;
  obImbalance: { ratio: number; direction: "UP" | "DOWN" | "NEUTRAL" } | null;
  gates: CriteriaGate[];
  reason: string;
}

/** Live-gate snapshot — what the bot's decision-engine would say RIGHT
 *  NOW about this market, as of the most recent cron scan. Populated by
 *  the backend's getStatus from runStatus.lastResult.results for the
 *  matching slug/coin. Shows whether the conviction still holds. */
export interface LiveGateSnapshot {
  evaluatedAt: string | null;
  action: string | null;
  reason: string | null;
  direction: "YES" | "NO" | "LONG" | "SHORT" | null;
  edge: number | null;
  netEdge?: number | null;
  predictedProb?: number | null;
  marketPrice?: number | null;
  activeSignals?: number | null;
  kellyUsed?: number | null;
  gates: CriteriaGate[];
}

export interface OpenPositionRow {
  /** Primary key — coin / city / market title. */
  coin: string;
  /** Optional "open on venue" deep-link rendered as a ↗ icon next to the
   *  coin / title. Polymarket for crypto/weather/sports, Hyperliquid for
   *  HL Perp + F-Arb perp-side. Use helpers in `./marketLinks.ts`. */
  link?: string | null;
  /** Optional direction chip rendered after the coin. */
  direction?: "YES" | "NO" | "LONG" | "SHORT";
  /** Optional entry price chip ("@$54.32" / "@54¢"). */
  entryText?: string;
  /** Notional / size text (e.g. "$3.40", "$100"). */
  sizeText: string;
  /** Optional middle-row text (spread, prediction, etc.) */
  spreadText?: string;
  /** Right-side P&L (omit if not yet meaningful). */
  pnlText?: string;
  pnlValue?: number;
  /** "Age" or "ends in" label rendered last. */
  ageText: string;
  /** Frozen entry decision snapshot — toggles the "Why?" panel when present.
   *  Pass `null` (not undefined) to render the "no data, older position"
   *  placeholder instead of suppressing the toggle entirely. */
  rationale?: OpenPositionRationale | null;
  /** Current gate state as of the last cron scan. Optional — falls back to
   *  "no recent scan data" if the bot hasn't scanned this market since the
   *  position was opened (or if the scan-result slug didn't match). */
  liveGates?: LiveGateSnapshot | null;
}

const SIGNAL_LABELS: Array<[
  | "funding_rate" | "orderflow" | "vol_divergence" | "apex_consensus" | "cond_prob"
  | "momentum"    | "contrarian" | "pairs_spread",
  string,
]> = [
  ["funding_rate",   "FR"],
  ["orderflow",      "VPIN"],
  ["vol_divergence", "VOL"],
  ["apex_consensus", "APEX"],
  ["cond_prob",      "CP"],
  ["momentum",       "MOM"],
  ["contrarian",     "CTR"],
  ["pairs_spread",   "PRS"],
];

function RationaleBlock({ r }: { r: OpenPositionRationale }) {
  const passed = r.gates.filter((g) => g.passed).length;
  const total  = r.gates.length;
  const allPass = total > 0 && passed === total;
  const isSpread = r.flavor === "spread";
  return (
    <div className="ts-pos-why">
      <div className="ts-pos-why-thesis">
        <span className="ts-pos-why-label">Tézis</span>
        <span className="ts-pos-why-thesis-text">
          {isSpread ? (
            <>
              HL <strong>{(r.finalProb * 100).toFixed(4)}%</strong>/h funding-ot fizet,
              a Binance <strong>{(r.marketPrice * 100).toFixed(4)}%</strong>/h-t fogad
              → spread <strong>{(r.grossEdge * 100).toFixed(4)}%</strong>/h
              {r.spreadAnnualizedPct !== undefined && (
                <> (<strong>{r.spreadAnnualizedPct.toFixed(1)}%</strong>/yr ann.)</>
              )}
              {" "}→ bot SHORT HL + LONG Binance,
              {" "}<strong>${r.positionSizeUSDC.toFixed(2)}</strong>-ért
              {" "}@<strong>{r.entryPriceLabel ?? `$${r.entryPrice.toFixed(2)}`}</strong>.
            </>
          ) : (
            <>
              A modell szerint a YES esélye <strong>{(r.finalProb * 100).toFixed(1)}%</strong>,
              a piac <strong>
                {r.marketPriceLabel ?? `${(r.marketPrice * 100).toFixed(1)}%`}
              </strong>-ot árazott
              → bot <strong>{r.direction}</strong>-t vett
              {" "}@<strong>{r.entryPriceLabel ?? `${(r.entryPrice * 100).toFixed(0)}¢`}</strong>,
              {" "}<strong>${r.positionSizeUSDC.toFixed(2)}</strong>-ért.
            </>
          )}
        </span>
      </div>

      <div className="ts-pos-why-grid">
        <div className="ts-pos-why-cell">
          <span className="ts-pos-why-cell-label">{isSpread ? "Spread (h)" : "Gross edge"}</span>
          <span className="ts-pos-why-cell-val">
            {(r.grossEdge * 100).toFixed(isSpread ? 4 : 2)}%
          </span>
        </div>
        <div className="ts-pos-why-cell">
          <span className="ts-pos-why-cell-label">{isSpread ? "Net spread (− fees)" : "Net edge (− fees)"}</span>
          <span className={`ts-pos-why-cell-val ${r.netEdge >= 0 ? "ts-pos-why-pos" : "ts-pos-why-neg"}`}>
            {r.netEdge >= 0 ? "+" : ""}{(r.netEdge * 100).toFixed(isSpread ? 4 : 2)}%
          </span>
        </div>
        <div className="ts-pos-why-cell">
          <span className="ts-pos-why-cell-label">
            {isSpread ? "Capital % bankroll" : "Kelly raw → capped"}
          </span>
          <span className="ts-pos-why-cell-val">
            {isSpread ? (
              <>
                {(r.kellyCapped * 100).toFixed(1)}%
                <span className="ts-pos-why-cell-sub"> · cap {(r.kellyCap * 100).toFixed(0)}%</span>
              </>
            ) : (
              <>
                {(r.kellyRaw * 100).toFixed(2)}% → {(r.kellyCapped * 100).toFixed(2)}%
                <span className="ts-pos-why-cell-sub"> · cap {(r.kellyCap * 100).toFixed(1)}%</span>
              </>
            )}
          </span>
        </div>
        <div className="ts-pos-why-cell">
          <span className="ts-pos-why-cell-label">
            {isSpread
              ? "OI"
              : r.signalBreakdown
                ? "Aktív signal-ok"
                : "Forecast confidence"}
          </span>
          <span className="ts-pos-why-cell-val">
            {isSpread
              ? r.openInterestUSD !== undefined
                ? `$${(r.openInterestUSD / 1e6).toFixed(1)}M`
                : "—"
              : r.signalBreakdown
                // Crypto / HL: 8-signal combiner, count from the breakdown
                // object so the denominator matches the actual signal set.
                ? `${r.activeSignals}/${
                    [r.signalBreakdown.funding_rate, r.signalBreakdown.orderflow,
                     r.signalBreakdown.vol_divergence, r.signalBreakdown.apex_consensus,
                     r.signalBreakdown.cond_prob, r.signalBreakdown.momentum,
                     r.signalBreakdown.contrarian, r.signalBreakdown.pairs_spread]
                      .filter((v) => v !== undefined).length
                  }`
                // Weather (no 8-signal combiner): forecast-driven, the
                // `activeSignals` field carries the model confidence as a
                // pseudo-count (0-1 scaled internally). Surface that as a %.
                : "forecast-driven"}
          </span>
        </div>
      </div>

      {!isSpread && r.signalBreakdown && (
        <div className="ts-pos-why-signals">
          <span className="ts-pos-why-label">Signal-bontás</span>
          <div className="ts-pos-why-signals-row">
            {SIGNAL_LABELS.map(([key, label]) => {
              const v = r.signalBreakdown![key];
              const off = v === null || v === undefined;
              const arrow = off ? "·" : (v as number) > 0.5 ? "↑" : "↓";
              const cls  = off ? "ts-pos-why-sig-off"
                              : (v as number) > 0.5 ? "ts-pos-why-sig-up"
                              : "ts-pos-why-sig-down";
              return (
                <span key={key} className={`ts-pos-why-sig ${cls}`}>
                  {label}{arrow}
                  {!off && <span className="ts-pos-why-sig-num">{((v as number) * 100).toFixed(0)}%</span>}
                </span>
              );
            })}
            {r.obImbalance && (
              <span
                className="ts-pos-why-sig ts-pos-why-sig-ob"
                title={`Binance top-10 bid/ask depth ratio = ${r.obImbalance.ratio.toFixed(2)}`}
              >
                OB {r.obImbalance.direction === "UP" ? "↑" : r.obImbalance.direction === "DOWN" ? "↓" : "·"}
                <span className="ts-pos-why-sig-num">{r.obImbalance.ratio.toFixed(2)}</span>
              </span>
            )}
          </div>
        </div>
      )}

      <div className="ts-pos-why-gates">
        <span className="ts-pos-why-label">
          Belépési gate-ek · <strong>{passed}/{total}</strong> {allPass ? "✓" : "—"}
        </span>
        <div className="ts-pos-why-gate-list">
          {r.gates.map((g, idx) => (
            <div
              key={idx}
              className={`ts-pos-why-gate ${g.passed ? "ts-pos-why-gate-pass" : "ts-pos-why-gate-fail"}`}
              title={g.hint}
            >
              <span className="ts-pos-why-gate-mark">{g.passed ? "✓" : "✗"}</span>
              <span className="ts-pos-why-gate-label">{g.label}</span>
              <span className="ts-pos-why-gate-actual">{g.actual ?? "—"}</span>
              <span className="ts-pos-why-gate-req">{g.required ?? ""}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="ts-pos-why-meta">
        <span>Decided: {new Date(r.decidedAt).toLocaleString()}</span>
        <span>Reason: {r.reason}</span>
      </div>
    </div>
  );
}

// "Live gates" panel — the current decision-engine state for this market
// as of the most recent cron scan. Rendered below the frozen entry-decision
// so the operator can compare past vs present without two pages of UI.
//
// We filter the gate list down to "what actually got measured this tick":
//   1. Drop placeholders (`actual === "not evaluated"`) — those are padded
//      onto early-exit rows so the scan-row chip Y stays uniform across
//      bots, but in the live-gate context they're noise: the operator
//      wants to know which gates would currently allow opening, not why
//      the engine short-circuited bookkeeping-wise.
//   2. Drop the open-position-uniqueness gate. Every open row sits in a
//      "this position exists" UI context already — re-asserting "already
//      open" as a failing gate just buries the gates that matter (edge,
//      kelly, OB-imbalance, etc.). The crypto bot's legitimate "Market
//      cooldown" gate (time-based, set by setCooldown after a trade) is
//      NOT excluded here — only the open-position guards are.
function isOpenPositionGate(gate: CriteriaGate): boolean {
  const l = gate.label.toLowerCase();
  const a = (gate.actual ?? "").toLowerCase();
  // HL / funding-arb explicit uniqueness gates.
  if (l.includes("nincs már nyitva")) return true;     // HL: "Coin nincs már nyitva"
  if (l.includes("per-coin uniqueness")) return true;  // Funding-arb
  // Legacy crypto stub (pre-fix lastResult cache may still carry rows where
  // a "Market cooldown" gate carries the synthetic "already open" actual).
  if (l === "market cooldown" && a === "already open") return true;
  return false;
}
function isMeaningfulGate(gate: CriteriaGate): boolean {
  if (gate.actual === "not evaluated") return false;
  if (isOpenPositionGate(gate)) return false;
  return true;
}

function LiveGatesBlock({ g }: { g: LiveGateSnapshot }) {
  const filteredGates = g.gates.filter(isMeaningfulGate);
  const passed = filteredGates.filter((x) => x.passed).length;
  const total  = filteredGates.length;
  const allPass = total > 0 && passed === total;
  const evaluated = g.evaluatedAt
    ? new Date(g.evaluatedAt).toLocaleString()
    : "last cron tick";
  // Render the engine's action verb naturally — "position_opened" past-tense
  // shouldn't read as "would do action position_opened". Map each known
  // action to a human-friendly Hungarian phrase. For the live-gate context
  // we lean on `allPass` instead of the raw action verb because the scan
  // skipped the buy on the open-position guard, NOT because a real gate
  // failed — so "SKIP" would mislead.
  const wouldOpenNow = total > 0 && allPass;
  const verdict = total === 0
    ? "—"
    : wouldOpenNow
      ? "MOST megnyitná (minden releváns gate ✓)"
      : `MOST NEM nyitná (${total - passed} releváns gate ✗)`;
  return (
    <div className="ts-pos-why ts-pos-why-live">
      <div className="ts-pos-why-thesis">
        <span className="ts-pos-why-label">Pillanatnyi gate állapot</span>
        <span className="ts-pos-why-thesis-text">
          {total === 0 ? (
            <>A bot ezt a piacot a legutóbbi scan-ben nem értékelte ki (nincs friss gate-adat).</>
          ) : (
            <>
              <strong>{verdict}</strong>
              {typeof g.netEdge === "number" && (
                <> — net edge <strong>{g.netEdge >= 0 ? "+" : ""}{(g.netEdge * 100).toFixed(2)}%</strong></>
              )}
              {typeof g.edge === "number" && typeof g.netEdge !== "number" && (
                <> — edge <strong>{(g.edge * 100).toFixed(2)}%</strong></>
              )}
              {g.direction && <> · irány <strong>{g.direction}</strong></>}
              .
            </>
          )}
        </span>
      </div>
      {total > 0 && (
        <div className="ts-pos-why-gates">
          <span className="ts-pos-why-label">
            Gate-ek MOST · <strong>{passed}/{total}</strong> {allPass ? "✓" : "—"}
          </span>
          <div className="ts-pos-why-gate-list">
            {filteredGates.map((x, idx) => (
              <div
                key={idx}
                className={`ts-pos-why-gate ${x.passed ? "ts-pos-why-gate-pass" : "ts-pos-why-gate-fail"}`}
                title={x.hint}
              >
                <span className="ts-pos-why-gate-mark">{x.passed ? "✓" : "✗"}</span>
                <span className="ts-pos-why-gate-label">{x.label}</span>
                <span className="ts-pos-why-gate-actual">{x.actual ?? "—"}</span>
                <span className="ts-pos-why-gate-req">{x.required ?? ""}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="ts-pos-why-meta">
        <span>Evaluated: {evaluated}</span>
        {g.reason && <span>Engine reason: {g.reason}</span>}
      </div>
    </div>
  );
}

export function OpenPositionsCard({
  title,
  rows,
}: {
  title: string;
  rows: OpenPositionRow[];
}) {
  if (!rows.length) return null;
  return (
    <div className="ts-card">
      <h3 className="ts-card-head"><strong>{title}</strong></h3>
      {rows.map((r, i) => {
        const hasRationaleSlot = r.rationale !== undefined; // null counts (older pos placeholder)
        const r_ = r.rationale ?? null;
        const summaryNode = (
          <>
            <span className="ts-pos-coin">
              {r.coin}
              {r.link && (
                <a
                  href={r.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ts-row-title-link"
                  title="Megnyitás a venue oldalán (új fülön)"
                  onClick={(e) => e.stopPropagation()}
                >
                  ↗
                </a>
              )}
            </span>
            {r.direction && (
              <span
                className={
                  "ts-pending-dir " +
                  (r.direction === "YES" || r.direction === "LONG"
                    ? "ts-pending-dir-YES"
                    : "ts-pending-dir-NO")
                }
              >
                {r.direction}
              </span>
            )}
            {r.entryText && <span className="ts-pos-spread">{r.entryText}</span>}
            <span className="ts-pos-size">{r.sizeText}</span>
            {r.spreadText && <span className="ts-pos-spread">{r.spreadText}</span>}
            {r.pnlText !== undefined && (
              <span
                className="ts-pos-acc"
                style={{
                  color:
                    r.pnlValue === undefined
                      ? "var(--muted)"
                      : r.pnlValue >= 0
                      ? "var(--accent)"
                      : "var(--danger)",
                }}
              >
                {r.pnlText}
              </span>
            )}
            <span
              className="ts-pos-age"
              style={{ marginLeft: r.pnlText !== undefined ? undefined : "auto" }}
            >
              {r.ageText}
            </span>
            {hasRationaleSlot && (
              <span className="ts-pos-why-toggle" aria-hidden="true">Why?</span>
            )}
          </>
        );

        const live = r.liveGates ?? null;
        const hasLive = live && Array.isArray(live.gates);

        if (!hasRationaleSlot && !hasLive) {
          return <div key={i} className="ts-pos-row">{summaryNode}</div>;
        }

        return (
          <details key={i} className="ts-pos-details">
            <summary className="ts-pos-row ts-pos-row-clickable">
              {summaryNode}
            </summary>
            {r_ ? (
              <RationaleBlock r={r_} />
            ) : hasRationaleSlot ? (
              <div className="ts-pos-why ts-pos-why-empty">
                Adat nem elérhető — ez a pozíció a döntés-snapshot bevezetése előtt nyílt.
                A jövőbeli új trade-eken minden gate, edge és signal-érték fagyasztva
                lesz a pozíción.
              </div>
            ) : null}
            {hasLive && <LiveGatesBlock g={live!} />}
          </details>
        );
      })}
    </div>
  );
}

/* ─── Opportunities card ───────────────────────────────── */

export interface OpportunityRowLite {
  coin: string;
  annualizedText: string;
  hourlyText: string;
  oiText: string;
  reason: string;
  viable: boolean;
}

export function OpportunitiesCard({
  title,
  rows,
}: {
  title: string;
  rows: OpportunityRowLite[];
}) {
  if (!rows.length) return null;
  return (
    <div className="ts-card">
      <h3 className="ts-card-head"><strong>{title}</strong></h3>
      {rows.map((r, i) => (
        <div key={i} className="ts-pos-row">
          <span className="ts-pos-coin">{r.coin}</span>
          <span className={"ts-opp-annual" + (r.viable ? " viable" : "")}>
            {r.annualizedText}
          </span>
          <span className="ts-pos-spread">{r.hourlyText}</span>
          <span className="ts-opp-oi">{r.oiText}</span>
          <span className="ts-opp-reason">{r.reason}</span>
        </div>
      ))}
    </div>
  );
}

/* ─── Dropped / skipped (collapsible) ──────────────────── */

export interface DroppedRowLite {
  reason: string;       // short chip text e.g. "no_station"
  title: string;        // full market title
  meta?: string;        // optional middle text e.g. price or bucket
  /** Right-most number — typically 24h volume. */
  trailing?: string;
}

export function DroppedCard({
  summary,
  rows,
}: {
  summary: string;
  rows: DroppedRowLite[];
}) {
  if (!rows.length) return null;
  return (
    <details className="ts-dropped">
      <summary>{summary}</summary>
      <div className="ts-dropped-list">
        {rows.map((d, i) => (
          <div key={i} className="ts-dropped-row">
            <span className="ts-dropped-reason">{d.reason}</span>
            <span className="ts-dropped-title">{d.title}</span>
            <span className="ts-dropped-meta">{d.meta || ""}</span>
            <span className="ts-dropped-vol">{d.trailing || ""}</span>
          </div>
        ))}
      </div>
    </details>
  );
}
