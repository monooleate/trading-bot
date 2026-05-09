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
  action: ActionKind | string;
  /** Validation / context chips: market price, model %, edge, direction… */
  chips?: ResultChip[];
  /** Per-signal arrow row (orderflow, vol-div, …). */
  signals?: SignalArrow[];
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

  return (
    <div className="ts-row">
      <div className="ts-row-main">
        <div className="ts-row-title" title={p.titleTip || p.title}>
          {p.prefix && <span className="ts-row-title-prefix">{p.prefix}</span>}
          {p.title}
        </div>
        {p.chips && p.chips.length > 0 && (
          <div className="ts-row-chips">
            {p.chips.map((c, i) => <Chip key={i} chip={c} />)}
          </div>
        )}
        {p.signals && <SignalRow signals={p.signals} />}
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

/* ─── Pending positions card (weather paper trades) ────── */

export interface PendingPositionLite {
  /** Primary key shown bold (city, coin, symbol). */
  primary: string;
  /** Secondary meta line (date, slug). */
  secondary?: string;
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
          <span className="ts-pending-key">{pos.primary}</span>
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

export interface OpenPositionRow {
  coin: string;
  sizeText: string;
  spreadText?: string;
  pnlText: string;
  pnlValue: number;
  ageText: string;
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
      {rows.map((r, i) => (
        <div key={i} className="ts-pos-row">
          <span className="ts-pos-coin">{r.coin}</span>
          <span className="ts-pos-size">{r.sizeText}</span>
          {r.spreadText && <span className="ts-pos-spread">{r.spreadText}</span>}
          <span
            className="ts-pos-acc"
            style={{ color: r.pnlValue >= 0 ? "var(--accent)" : "var(--danger)" }}
          >
            {r.pnlText}
          </span>
          <span className="ts-pos-age">{r.ageText}</span>
        </div>
      ))}
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
