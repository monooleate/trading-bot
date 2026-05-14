// Single source of truth for the unified Auto-Trader UI.
// Every per-bot panel (Crypto, Weather, Hyperliquid, Funding Arb) renders
// through TraderShell + the shared cards in TraderResults — they all hit
// these `ts-` classes so the look + interaction stays identical.

export const traderShellCSS = `
.ts-wrap { max-width: 880px; margin: 0 auto; padding: 1.5rem 1rem; }

/* ─── Header ───────────────────────────────────────────── */
.ts-header { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.4rem; flex-wrap: wrap; }
.ts-title { font-family: var(--sans); font-size: 1.35rem; color: var(--text); margin: 0; letter-spacing: -0.01em; }
.ts-mode {
  font-family: var(--mono); font-size: 0.62rem; padding: 3px 9px;
  border-radius: 4px; text-transform: uppercase; letter-spacing: 0.6px;
  font-weight: 700;
}
.ts-mode-paper { background: var(--warn); color: var(--bg); }
.ts-mode-live  { background: var(--danger); color: #fff; }

.ts-status-cluster { margin-left: auto; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.ts-pill {
  font-family: var(--mono); font-size: 0.62rem;
  padding: 3px 8px; border-radius: 12px;
  display: inline-flex; align-items: center; gap: 5px;
  border: 1px solid var(--border); background: var(--surface);
  text-transform: uppercase; letter-spacing: .04em;
}
.ts-pill-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
.ts-pill-live { color: var(--accent); border-color: var(--accent); }
.ts-pill-live .ts-pill-dot { background: var(--accent); animation: ts-pulse 1.4s ease-in-out infinite; }
.ts-pill-idle { color: var(--muted); }
.ts-pill-cron-on { color: var(--accent2); border-color: var(--accent2); }
.ts-pill-cron-off { color: var(--muted); }
.ts-pill-mute { color: var(--muted); }
@keyframes ts-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%      { opacity: 0.45; transform: scale(1.4); }
}

.ts-subtitle {
  font-family: var(--mono); font-size: 0.7rem; color: var(--muted);
  margin: 0 0 1rem; padding: 0.6rem 0.75rem;
  background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
  line-height: 1.45;
}

/* ─── Stats grid ───────────────────────────────────────── */
.ts-stats {
  display: grid; gap: 0.5rem; margin-bottom: 1rem;
  grid-template-columns: repeat(auto-fit, minmax(115px, 1fr));
}
.ts-stat {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 8px; padding: 0.6rem 0.5rem; text-align: center;
}
.ts-stat-label {
  display: block; font-family: var(--mono); font-size: 0.55rem;
  color: var(--muted); text-transform: uppercase;
  margin-bottom: 4px; letter-spacing: 0.08em;
}
.ts-stat-value { font-family: var(--mono); font-size: 1.05rem; color: var(--text); font-weight: 600; }
.ts-stat-pos  { color: var(--accent); }
.ts-stat-neg  { color: var(--danger); }
.ts-stat-warn { color: var(--warn); }
.ts-stat-info { color: var(--accent2); }

/* ─── Alerts (stopped / paused / info) ─────────────────── */
.ts-alerts { display: flex; flex-direction: column; gap: 6px; margin-bottom: 1rem; }
.ts-alert {
  font-family: var(--mono); font-size: 0.72rem;
  padding: 0.5rem 0.75rem; border-radius: 6px;
  display: flex; align-items: center; justify-content: center; gap: 0.75rem;
  flex-wrap: wrap;
}
.ts-alert-text { text-align: center; }
.ts-alert-danger { background: var(--danger); color: #fff; }
.ts-alert-warn   { background: var(--warn); color: var(--bg); }
.ts-alert-info   { background: var(--surface); color: var(--accent2); border: 1px solid var(--accent2); }
.ts-alert-action {
  font-family: var(--mono); font-size: 0.7rem; font-weight: 600;
  padding: 0.25rem 0.6rem; border-radius: 4px;
  background: rgba(0, 0, 0, 0.25); color: inherit; border: 1px solid currentColor;
  cursor: pointer; transition: background 120ms ease;
}
.ts-alert-action:hover:not(:disabled) { background: rgba(0, 0, 0, 0.40); }
.ts-alert-action:disabled { opacity: 0.5; cursor: not-allowed; }
.ts-alert-info .ts-alert-action { background: var(--surface2); border-color: var(--accent2); }
.ts-alert-info .ts-alert-action:hover:not(:disabled) { background: var(--accent2); color: var(--bg); }

/* ─── Controls ─────────────────────────────────────────── */
.ts-controls { display: flex; gap: 0.5rem; margin-bottom: 1.25rem; flex-wrap: wrap; }
.ts-btn {
  font-family: var(--mono); font-size: 0.7rem; padding: 0.55rem 1rem;
  border: 1px solid var(--border); border-radius: 6px; cursor: pointer;
  letter-spacing: 0.05em; text-transform: uppercase;
  transition: opacity 0.15s, border-color 0.15s, color 0.15s, background 0.15s;
}
.ts-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.ts-btn-primary   { background: var(--accent); color: var(--bg); border-color: var(--accent); font-weight: 700; }
.ts-btn-primary:hover:not(:disabled) { background: #d4ff40; }
.ts-btn-secondary { background: var(--surface); color: var(--text); }
.ts-btn-secondary:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.ts-btn-info      { background: transparent; color: var(--accent2); border-color: var(--accent2); }
.ts-btn-info:hover:not(:disabled) { background: rgba(53,200,241,0.08); }
.ts-btn-danger    { background: transparent; color: var(--danger); border-color: var(--danger); }
.ts-btn-danger:hover:not(:disabled) { background: rgba(241,53,53,0.08); }

/* ─── Error banner ─────────────────────────────────────── */
.ts-error {
  background: rgba(241,53,53,0.1); border: 1px solid var(--danger);
  border-radius: 6px; padding: 0.75rem;
  color: var(--danger); font-family: var(--mono); font-size: 0.72rem;
  margin-bottom: 1rem;
}

/* ─── Card (results / pending / positions / etc.) ──────── */
.ts-card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 8px; padding: 1rem; margin-bottom: 0.75rem;
}
.ts-card.ts-card-accent { border-color: var(--accent2); }
.ts-card-head {
  font-family: var(--sans); font-size: 0.85rem; color: var(--muted);
  margin: 0 0 0.5rem; display: flex; align-items: center;
  gap: 0.5rem; flex-wrap: wrap;
}
.ts-card-head strong { color: var(--text); font-weight: 600; }
.ts-tag {
  font-family: var(--mono); font-size: 0.6rem; color: var(--muted);
  background: var(--surface2); padding: 2px 6px; border-radius: 3px;
}
.ts-tag-info { color: var(--accent2); }
.ts-tag-warn { color: var(--warn); }

.ts-cfgline {
  font-family: var(--mono); font-size: 0.6rem; color: var(--muted);
  margin: 0 0 0.6rem; padding: 0 0 0.5rem;
  border-bottom: 1px solid var(--border); line-height: 1.55;
}

/* ─── Scan result row (the big unified one) ────────────── */
.ts-row {
  display: grid;
  grid-template-columns: 1fr auto auto;
  align-items: start;
  gap: 0.5rem 0.65rem;
  padding: 0.65rem 0.65rem;
  border-bottom: 1px solid var(--border);
  border-left: 3px solid transparent;
  font-family: var(--mono);
  font-size: 0.72rem;
  transition: background 0.15s, border-left-color 0.15s;
}
.ts-row:last-child { border-bottom: none; }
.ts-row-pass    { border-left-color: var(--accent);  background: rgba(200,241,53,0.04); }
.ts-row-skip    { border-left-color: var(--warn);    background: rgba(241,160,53,0.04); }
.ts-row-fail    { border-left-color: var(--danger);  background: rgba(241,53,53,0.06); }
.ts-row-neutral { border-left-color: transparent; }

/* Inline "blocker" line — visible without hovering. Highlights the FIRST
   failed gate so the operator can scan the rejected-trade list at a glance. */
.ts-row-blocker {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
  font-family: var(--mono); font-size: 0.62rem;
  color: var(--warn);
  background: rgba(241,160,53,0.08);
  border: 1px solid var(--warn);
  border-radius: 3px;
  padding: 2px 7px;
  margin-top: 2px;
  width: fit-content;
}
.ts-row-blocker-mark   { color: var(--danger); font-weight: 700; }
.ts-row-blocker-label  { color: var(--text); }
.ts-row-blocker-actual { color: var(--danger); font-weight: 700; }
.ts-row-blocker-req    { color: var(--muted); }
.ts-row-blocker-more   { color: var(--muted); font-size: 0.55rem; }
.ts-row-main { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.ts-row-title {
  color: var(--text); font-weight: 600; font-size: 0.78rem;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  display: flex; align-items: center; gap: 6px;
}
.ts-row-title-prefix { color: var(--accent); flex-shrink: 0; }
.ts-row-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.ts-chip {
  font-size: 0.6rem; padding: 1px 6px; border-radius: 3px;
  background: var(--surface2); color: var(--text);
  border: 1px solid var(--border); white-space: nowrap;
}
.ts-chip-pos     { color: var(--accent); border-color: var(--accent); }
.ts-chip-neg     { color: var(--danger); border-color: var(--danger); }
.ts-chip-warn    { color: var(--warn);   border-color: var(--warn); }
.ts-chip-info    { color: var(--accent2); border-color: var(--accent2); }
.ts-chip-outline { background: transparent; }

/* ─── Criteria gate chip + hover popover ───────────────── */
.ts-crit {
  position: relative;
  display: inline-flex; align-items: center;
  cursor: help; outline: none;
}
.ts-crit-chip {
  font-family: var(--mono); font-size: 0.6rem;
  padding: 1px 7px; border-radius: 3px;
  background: var(--surface2); border: 1px solid var(--border);
  color: var(--text); white-space: nowrap;
  letter-spacing: 0.04em;
}
.ts-crit-pos .ts-crit-chip  { color: var(--accent);  border-color: var(--accent); }
.ts-crit-warn .ts-crit-chip { color: var(--warn);    border-color: var(--warn); }
.ts-crit-neg .ts-crit-chip  { color: var(--danger);  border-color: var(--danger); }

.ts-crit-popover {
  position: absolute;
  /* 2026-05-14e bug fix: a popover most a chip-hez tapad (bottom: 100%) és
     ::before pseudo-bridge kitölti a 8px-es vizuális rést a popover és a
     chip között. Korábbi verzió (bottom: calc(100% + 8px)) ott hagyott egy
     "halott" gap-et, amibe a kurzor beesett :hover-ből → popover eltűnt
     mielőtt elérted volna. */
  bottom: 100%; left: 0;
  margin-bottom: 8px;
  z-index: 50;
  min-width: 280px; max-width: 360px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
  box-shadow: 0 12px 32px rgba(0,0,0,0.45);
  opacity: 0; visibility: hidden;
  transform: translateY(4px);
  transition: opacity 0.12s ease-out, transform 0.12s ease-out, visibility 0s linear 0.12s;
  pointer-events: none;
  /* Off-screen védelem: ha a chip a viewport tetején van és a popover
     felfelé nem férne ki, a max-height + scroll megakadályozza hogy
     teljesen láthatatlan legyen. */
  max-height: calc(100vh - 32px);
  overflow-y: auto;
}
/* Invisible hover-bridge: a popover alá lóg egy 10px magas zóna ami
   átfedi a margin-bottom: 8px vizuális gap-et és a chip felső szélét.
   Így a kurzor út a chip→popover között soha nem hagyja el a hover-target
   bounding box-ot. */
.ts-crit-popover::after {
  content: "";
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  height: 10px;
}
.ts-crit:hover .ts-crit-popover,
.ts-crit:focus .ts-crit-popover,
.ts-crit:focus-within .ts-crit-popover {
  opacity: 1; visibility: visible; transform: translateY(0);
  transition-delay: 0s;
  pointer-events: auto;
}
.ts-crit-pos .ts-crit-popover  { border-color: var(--accent); }
.ts-crit-warn .ts-crit-popover { border-color: var(--warn); }
.ts-crit-neg .ts-crit-popover  { border-color: var(--danger); }
.ts-crit-popover-head {
  font-family: var(--mono); font-size: 0.6rem;
  color: var(--muted); text-transform: uppercase;
  letter-spacing: 0.06em;
  border-bottom: 1px solid var(--border);
  padding-bottom: 4px; margin-bottom: 6px;
}
.ts-crit-row {
  display: grid;
  grid-template-columns: 16px 1fr auto auto;
  gap: 7px; align-items: center;
  font-family: var(--mono); font-size: 0.62rem;
  padding: 3px 0;
  color: var(--text);
}
.ts-crit-row + .ts-crit-row { border-top: 1px solid var(--border); }
.ts-crit-mark { font-weight: 700; }
.ts-crit-pass .ts-crit-mark { color: var(--accent); }
.ts-crit-fail .ts-crit-mark { color: var(--danger); }
.ts-crit-label  { color: var(--text); }
.ts-crit-actual { color: var(--text); font-weight: 600; text-align: right; }
.ts-crit-req    { color: var(--muted); text-align: right; font-size: 0.58rem; }

@media (max-width: 600px) {
  .ts-crit-popover { left: auto; right: 0; min-width: 240px; }
}

.ts-row-signals { display: flex; gap: 6px; flex-wrap: wrap; }
.ts-sig {
  font-size: 0.6rem; color: var(--accent2);
  letter-spacing: 0.05em;
}
.ts-sig-up   { color: var(--accent); }
.ts-sig-down { color: var(--danger); }
.ts-sig-off  { color: var(--muted); opacity: 0.5; }

.ts-row-action {
  text-transform: uppercase; font-size: 0.6rem;
  padding: 2px 7px; border-radius: 3px; align-self: start;
  letter-spacing: 0.05em; font-weight: 700;
}
.ts-act-traded,
.ts-act-position_opened,
.ts-act-opened   { background: var(--accent); color: var(--bg); }
.ts-act-closed   { background: var(--accent2); color: var(--bg); }
.ts-act-skip     { background: var(--surface2); color: var(--muted); }
.ts-act-failed,
.ts-act-error,
.ts-act-close_error { background: var(--danger); color: #fff; }

.ts-row-extra {
  font-family: var(--mono); font-size: 0.66rem;
  color: var(--accent2); align-self: start; text-align: right;
  white-space: nowrap;
}
.ts-row-pnl  { font-weight: 700; align-self: start; text-align: right; white-space: nowrap; }

.ts-row-reason {
  grid-column: 1 / -1; color: var(--muted); font-size: 0.62rem;
  padding-top: 4px; line-height: 1.55;
}
.ts-row-reason b { color: var(--text); font-weight: 600; }
.ts-row-reason.ts-row-reason-error { color: var(--danger); }

/* ─── Pending positions row ───────────────────────────── */
.ts-pending-row {
  display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;
  font-family: var(--mono); font-size: 0.7rem;
  padding: 0.5rem; background: var(--surface2); border-radius: 4px;
  border-left: 3px solid var(--accent2);
  margin-bottom: 5px;
}
.ts-pending-row.ts-ready { border-left-color: var(--accent); }
.ts-pending-key { font-weight: 700; color: var(--text); text-transform: capitalize; min-width: 90px; }
.ts-pending-meta { color: var(--muted); font-size: 0.6rem; }
.ts-pending-bucket { background: var(--bg); padding: 1px 6px; border-radius: 3px; color: var(--text); }
.ts-pending-dir { padding: 1px 6px; border-radius: 3px; font-size: 0.6rem; font-weight: 700; }
.ts-pending-dir-YES { background: var(--accent); color: var(--bg); }
.ts-pending-dir-NO  { background: var(--danger); color: #fff; }
.ts-pending-pred { color: var(--accent2); }
.ts-pending-size { color: var(--muted); font-weight: 600; margin-left: auto; }
.ts-pending-when {
  font-family: var(--mono); font-size: 0.65rem; color: var(--warn);
  background: var(--bg); padding: 2px 6px; border-radius: 3px;
}
.ts-pending-row.ts-ready .ts-pending-when { color: var(--accent); }
.ts-pending-foot {
  margin-top: 0.6rem; font-family: var(--mono); font-size: 0.58rem;
  color: var(--muted); text-transform: uppercase; letter-spacing: .04em;
}

/* ─── Open / opportunities row ─────────────────────────── */
.ts-pos-row {
  display: flex; gap: 0.6rem; padding: 0.4rem 0;
  border-bottom: 1px solid var(--border);
  font-family: var(--mono); font-size: 0.72rem;
  flex-wrap: wrap; align-items: center;
}
.ts-pos-row:last-child { border-bottom: none; }
.ts-pos-coin    { font-weight: 700; color: var(--accent); min-width: 44px; }
.ts-pos-size    { color: var(--text); }
.ts-pos-spread  { color: var(--muted); }
.ts-pos-acc     { margin-left: auto; font-weight: 700; }
.ts-pos-age     { color: var(--muted); font-size: 0.62rem; }
.ts-opp-annual  { color: var(--muted); }
.ts-opp-annual.viable { color: var(--accent); font-weight: 700; }
.ts-opp-oi      { color: var(--muted); }
.ts-opp-reason  { color: var(--muted); font-size: 0.6rem; flex-basis: 100%; opacity: 0.75; }

/* ─── Open position rationale ("Why?" panel) ───────────── */
.ts-pos-details { border-bottom: 1px solid var(--border); }
.ts-pos-details:last-child { border-bottom: none; }
.ts-pos-details > summary { list-style: none; cursor: pointer; }
.ts-pos-details > summary::-webkit-details-marker { display: none; }
.ts-pos-row-clickable {
  display: flex; gap: 0.6rem; padding: 0.4rem 0;
  font-family: var(--mono); font-size: 0.72rem;
  flex-wrap: wrap; align-items: center;
  border-bottom: none;
}
.ts-pos-row-clickable:hover { background: var(--surface2); }
.ts-pos-why-toggle {
  font-family: var(--mono); font-size: 0.6rem; color: var(--accent2);
  margin-left: 0.5rem; padding: 1px 6px; border-radius: 3px;
  background: var(--bg); border: 1px solid var(--border);
  text-transform: uppercase; letter-spacing: .05em;
}
.ts-pos-why-toggle::before { content: "▸ "; color: var(--muted); }
.ts-pos-details[open] .ts-pos-why-toggle::before { content: "▾ "; color: var(--accent); }
.ts-pos-details[open] .ts-pos-why-toggle { color: var(--accent); border-color: var(--accent); }

.ts-pos-why {
  margin: 0.2rem 0 0.6rem;
  padding: 0.75rem 0.85rem;
  background: var(--surface2);
  border-left: 3px solid var(--accent2);
  border-radius: 0 4px 4px 0;
  font-family: var(--mono); font-size: 0.68rem; color: var(--text);
  display: flex; flex-direction: column; gap: 0.6rem;
}
.ts-pos-why-empty { color: var(--muted); font-style: italic; line-height: 1.45; }

/* Live-gate panel: warm accent strip distinguishes "as-of-now" from the
   frozen entry-decision (which uses the cool blue accent2 strip). */
.ts-pos-why-live { border-left: 3px solid var(--warn); }
.ts-pos-why-live .ts-pos-why-thesis-text strong { color: var(--warn); }

.ts-pos-why-label {
  display: block; font-size: 0.55rem;
  color: var(--muted); text-transform: uppercase;
  letter-spacing: 0.08em; margin-bottom: 4px;
}

.ts-pos-why-thesis {
  background: var(--bg); border: 1px solid var(--border);
  padding: 0.5rem 0.6rem; border-radius: 4px; line-height: 1.55;
}
.ts-pos-why-thesis-text strong { color: var(--accent); }
.ts-pos-why-thesis-text strong:not(:first-of-type) { color: var(--accent2); }

.ts-pos-why-grid {
  display: grid; gap: 0.4rem;
  grid-template-columns: repeat(auto-fit, minmax(135px, 1fr));
}
.ts-pos-why-cell {
  background: var(--bg); border: 1px solid var(--border);
  padding: 0.4rem 0.55rem; border-radius: 4px;
  display: flex; flex-direction: column; gap: 2px;
}
.ts-pos-why-cell-label {
  font-size: 0.52rem; color: var(--muted);
  text-transform: uppercase; letter-spacing: 0.06em;
}
.ts-pos-why-cell-val { font-size: 0.78rem; color: var(--text); font-weight: 600; }
.ts-pos-why-cell-sub { font-size: 0.56rem; color: var(--muted); font-weight: 400; margin-left: 4px; }
.ts-pos-why-pos { color: var(--accent); }
.ts-pos-why-neg { color: var(--danger); }

.ts-pos-why-signals-row {
  display: flex; flex-wrap: wrap; gap: 0.4rem;
}
.ts-pos-why-sig {
  background: var(--bg); border: 1px solid var(--border);
  padding: 2px 7px; border-radius: 3px;
  font-size: 0.62rem;
  display: inline-flex; align-items: center; gap: 5px;
}
.ts-pos-why-sig-up   { color: var(--accent);  border-color: var(--accent); }
.ts-pos-why-sig-down { color: var(--danger);  border-color: var(--danger); }
.ts-pos-why-sig-off  { color: var(--muted); }
.ts-pos-why-sig-ob   { color: var(--accent2); border-color: var(--accent2); }
.ts-pos-why-sig-num  { color: var(--muted); font-size: 0.55rem; font-weight: 400; }

.ts-pos-why-gate-list {
  display: flex; flex-direction: column; gap: 3px;
  background: var(--bg); border: 1px solid var(--border);
  padding: 0.4rem 0.5rem; border-radius: 4px;
}
.ts-pos-why-gate {
  display: grid;
  grid-template-columns: 14px 1fr auto auto;
  align-items: baseline; gap: 0.5rem;
  font-size: 0.62rem; padding: 1px 0;
}
.ts-pos-why-gate-pass .ts-pos-why-gate-mark { color: var(--accent); }
.ts-pos-why-gate-fail .ts-pos-why-gate-mark { color: var(--danger); }
.ts-pos-why-gate-fail { background: rgba(241,53,53,0.06); border-radius: 3px; padding: 2px 4px; }
.ts-pos-why-gate-mark { font-weight: 700; }
.ts-pos-why-gate-label  { color: var(--text); }
.ts-pos-why-gate-actual { color: var(--accent2); font-size: 0.58rem; white-space: nowrap; }
.ts-pos-why-gate-req    { color: var(--muted); font-size: 0.58rem; white-space: nowrap; }

.ts-pos-why-meta {
  display: flex; flex-wrap: wrap; gap: 1rem;
  font-size: 0.55rem; color: var(--muted);
  border-top: 1px solid var(--border); padding-top: 0.4rem;
}

@media (max-width: 600px) {
  .ts-pos-why-gate { grid-template-columns: 14px 1fr; }
  .ts-pos-why-gate-actual,
  .ts-pos-why-gate-req { grid-column: 2 / -1; padding-left: 4px; }
}

/* ─── Dropped (collapsible) ────────────────────────────── */
.ts-dropped { margin-top: 0.75rem; font-family: var(--mono); font-size: 0.65rem; }
.ts-dropped summary {
  cursor: pointer; color: var(--muted); padding: 0.4rem 0;
  list-style: none;
}
.ts-dropped summary::-webkit-details-marker { display: none; }
.ts-dropped summary::before { content: "▸ "; color: var(--muted); }
.ts-dropped[open] summary::before { content: "▾ "; }
.ts-dropped summary:hover { color: var(--text); }
.ts-dropped-list { display: flex; flex-direction: column; gap: 4px; padding-top: 6px; }
.ts-dropped-row {
  display: grid;
  grid-template-columns: 110px 1fr auto auto;
  align-items: center; gap: 8px; padding: 4px 0;
}
.ts-dropped-reason {
  padding: 1px 5px; border-radius: 3px;
  background: var(--surface2); color: var(--warn);
  font-size: 0.55rem; text-transform: uppercase; text-align: center;
}
.ts-dropped-title {
  color: var(--text); overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
}
.ts-dropped-meta { color: var(--muted); text-align: right; white-space: nowrap; }
.ts-dropped-vol { color: var(--accent2); text-align: right; white-space: nowrap; }

@media (max-width: 600px) {
  .ts-wrap { padding: 1rem 0.75rem; }
  .ts-stats { grid-template-columns: repeat(2, 1fr); }
  .ts-row {
    grid-template-columns: 1fr;
  }
  .ts-row-action, .ts-row-extra, .ts-row-pnl { align-self: auto; text-align: left; }
  .ts-dropped-row { grid-template-columns: 1fr auto; }
  .ts-dropped-reason { grid-column: 1 / -1; }
  .ts-status-cluster { margin-left: 0; width: 100%; }
  .ts-title { font-size: 1.15rem; }
  .ts-controls .ts-btn { flex: 1 1 calc(50% - 0.25rem); }
  .ts-pos-row { font-size: 0.66rem; }
  .ts-pos-acc { margin-left: 0; }
}
@media (max-width: 380px) {
  .ts-stats { grid-template-columns: 1fr; }
  .ts-controls .ts-btn { flex: 1 1 100%; }
}
`;
