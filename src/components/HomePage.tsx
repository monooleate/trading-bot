// src/components/HomePage.tsx
//
// Mission-control style landing page. Shows live session metrics from
// /auto-trader, env-var availability from /env-status, and routes the
// user to every trading + analysis surface the app exposes.

import { useEffect, useState } from "react";

const FN = "/.netlify/functions";

// ─── Types ────────────────────────────────────────────────────────────

interface SessionState {
  paperMode: boolean;
  bankrollCurrent: number;
  bankrollStart: number;
  sessionPnL: number;
  sessionLoss: number;
  tradeCount: number;
  closedTrades?: number;     // older deployments may not return this; fall back to tradeCount
  openPositions: number;
  stopped: boolean;
  stoppedReason: string | null;
}

interface EnvStatus {
  paperMode: boolean;
  env: { name: string; category: string; description: string; set: boolean; required_for: string[] }[];
  capabilities: Record<string, { ok: boolean; missing: string[] }>;
}

// ─── Capability cards ─────────────────────────────────────────────────

interface Card {
  id: string;
  title: string;
  blurb: string;
  icon: string;
  href: string;
  external?: boolean;
  mode: "PAPER+LIVE" | "PAPER-ONLY" | "MANUAL" | "READ-ONLY" | "ANALYSIS";
  capability?: string;       // matches env-status capabilities key
  group: "execution" | "tools" | "analysis";
}

const CARDS: Card[] = [
  // ── Execution ──
  {
    id: "crypto",
    title: "Crypto Auto-Trader",
    blurb: "BTC short markets · cron 3 perc · TP/SL + entry window",
    icon: "🪙",
    href: "/trade/crypto/",
    mode: "PAPER+LIVE",
    capability: "live-crypto-auto",
    group: "execution",
  },
  {
    id: "hyperliquid",
    title: "Hyperliquid Trader",
    blurb: "BTC/ETH/SOL perp · paper-only Netlify-on · live: Hetzner",
    icon: "⚡",
    href: "/trade/hyperliquid/",
    mode: "PAPER-ONLY",
    capability: "hyperliquid-paper",
    group: "execution",
  },
  {
    id: "weather",
    title: "Weather Trader",
    blurb: "Hőmérséklet piacok · 31-tagú GFS ensemble · station fix",
    icon: "🌤️",
    href: "/trade/weather/",
    mode: "PAPER+LIVE",
    group: "execution",
  },
  {
    id: "bybit",
    title: "Bybit Futures",
    blurb: "Manuális order leadás · balances · positions",
    icon: "📉",
    href: "/tools#trading",
    mode: "MANUAL",
    capability: "bybit-manual",
    group: "execution",
  },
  {
    id: "binance",
    title: "Binance Futures",
    blurb: "Manuális order leadás · balances · positions",
    icon: "🟡",
    href: "/tools#trading",
    mode: "MANUAL",
    capability: "binance-manual",
    group: "execution",
  },
  {
    id: "polymarket-manual",
    title: "Polymarket Manual",
    blurb: "Read-only piacok + intent JSON (Python script lokálisan)",
    icon: "🎯",
    href: "/tools#trading",
    mode: "MANUAL",
    capability: "manual-trading",
    group: "execution",
  },

  // ── Tools (Polymarket-specifikus) ──
  {
    id: "auto-claim",
    title: "Auto-Claim",
    blurb: "Polymarket nyertes pozíciók scan + redeem intent",
    icon: "💰",
    href: "/tools#trading",
    mode: "READ-ONLY",
    capability: "auto-claim",
    group: "tools",
  },
  {
    id: "pair-arb",
    title: "Pair-Cost Arb",
    blurb: "YES+NO < $1.00 redeem arb · VWAP @ notional",
    icon: "♻️",
    href: "/tools#arbmatrix",
    mode: "READ-ONLY",
    group: "tools",
  },
  {
    id: "edge-tracker",
    title: "Edge Tracker",
    blurb: "PnL · kalibráció · IC bar · edge decay · heatmap",
    icon: "📊",
    href: "/tools#autotrader",
    mode: "ANALYSIS",
    group: "tools",
  },
  {
    id: "settings",
    title: "⚙ Beállítások",
    blurb: "11 paraméter · runtime override · auth-protected",
    icon: "🔧",
    href: "/tools#settings",
    mode: "MANUAL",
    capability: "settings",
    group: "tools",
  },

  // ── Analysis (signal layer + research) ──
  {
    id: "scanner",
    title: "Market Scanner",
    blurb: "Polymarket top piacok · EV calc · Kelly sizing",
    icon: "🔭",
    href: "/tools#scanner",
    mode: "ANALYSIS",
    group: "analysis",
  },
  {
    id: "signals",
    title: "Signal Combiner",
    blurb: "8 jelzés · Grinold-Kahn IR = IC × √N",
    icon: "🧠",
    href: "/tools#signals",
    mode: "ANALYSIS",
    group: "analysis",
  },
  {
    id: "orderflow",
    title: "Order Flow",
    blurb: "Kyle λ · VPIN · Hawkes branching",
    icon: "📈",
    href: "/tools#orderflow",
    mode: "ANALYSIS",
    group: "analysis",
  },
  {
    id: "vol",
    title: "Vol Harvest",
    blurb: "IV vs RV spread · locked profit",
    icon: "🌊",
    href: "/tools#vol",
    mode: "ANALYSIS",
    group: "analysis",
  },
  {
    id: "apex",
    title: "Apex Wallets",
    blurb: "Whale consensus · bot detector · LP Subgroup A/B/C",
    icon: "🐋",
    href: "/tools#apex",
    mode: "ANALYSIS",
    group: "analysis",
  },
  {
    id: "condprob",
    title: "Cond. Probability",
    blurb: "Monotonicity violations · marginal polytope",
    icon: "🎲",
    href: "/tools#condprob",
    mode: "ANALYSIS",
    group: "analysis",
  },
];

// ─── Mode badge styling ───────────────────────────────────────────────

const MODE_LABEL: Record<Card["mode"], { txt: string; cls: string }> = {
  "PAPER+LIVE":  { txt: "Paper + Live",  cls: "hp-pill-live" },
  "PAPER-ONLY":  { txt: "Paper-only",    cls: "hp-pill-paper" },
  "MANUAL":      { txt: "Manual",        cls: "hp-pill-manual" },
  "READ-ONLY":   { txt: "Read-only",     cls: "hp-pill-readonly" },
  "ANALYSIS":    { txt: "Analysis",      cls: "hp-pill-analysis" },
};

// ─── Component ────────────────────────────────────────────────────────

export default function HomePage() {
  const [session, setSession] = useState<SessionState | null>(null);
  const [envStat, setEnvStat] = useState<EnvStatus | null>(null);
  const [loadErr, setLoadErr] = useState<string>("");

  useEffect(() => {
    Promise.all([
      fetch(`${FN}/auto-trader?action=status`).then((r) => r.json()).catch(() => null),
      fetch(`${FN}/env-status`).then((r) => r.json()).catch(() => null),
    ]).then(([trader, env]) => {
      if (trader?.session) setSession(trader.session);
      else if (trader?.ok && trader?.session) setSession(trader.session);
      if (env?.ok) setEnvStat(env);
      if (!trader || !env) setLoadErr("Néhány adat nem töltődött be — frissíts.");
    }).catch((e) => setLoadErr(e.message));
  }, []);

  const live = envStat ? !envStat.paperMode : false;
  const pnlPositive = (session?.sessionPnL ?? 0) >= 0;

  // Group env by category for the bottom checklist
  const byCategory: Record<string, EnvStatus["env"]> = {};
  if (envStat) {
    for (const e of envStat.env) {
      (byCategory[e.category] ||= []).push(e);
    }
  }
  const CAT_ORDER = ["auth", "polymarket", "bybit", "binance", "hyperliquid", "telegram", "llm", "trader"];
  const CAT_LABEL: Record<string, string> = {
    auth: "Auth (login)",
    polymarket: "Polymarket",
    bybit: "Bybit",
    binance: "Binance",
    hyperliquid: "Hyperliquid",
    telegram: "Telegram alerts",
    llm: "LLM (Claude API)",
    trader: "Trader tuning (defaultok)",
  };

  return (
    <div className="hp-wrap">
      <style>{css}</style>

      {/* ─── HEADER ─── */}
      <header className="hp-header">
        <div>
          <div className="hp-logo">EDGE<span>/</span>CALC</div>
          <div className="hp-sub">Mission Control · Quantitative Polymarket Auto-Trader</div>
        </div>
        <div className="hp-mode-display">
          <span className={`hp-mode-pill ${live ? "live" : "paper"}`}>
            {live ? "● LIVE" : "● PAPER MODE"}
          </span>
        </div>
      </header>

      {/* ─── SESSION SUMMARY ─── */}
      <section className="hp-summary">
        <Stat
          label="Bankroll"
          value={session ? `$${session.bankrollCurrent.toFixed(2)}` : "…"}
          sub={session ? `start: $${session.bankrollStart.toFixed(0)}` : ""}
          accent="neu"
        />
        <Stat
          label="Session PnL"
          value={session ? (pnlPositive ? "+" : "") + "$" + session.sessionPnL.toFixed(2) : "…"}
          sub={session && session.bankrollStart > 0
            ? `${((session.sessionPnL / session.bankrollStart) * 100).toFixed(1)}%`
            : ""}
          accent={pnlPositive ? "pos" : "neg"}
        />
        <Stat
          label="Closed trades"
          value={session ? `${session.closedTrades ?? session.tradeCount ?? 0}` : "…"}
          sub={session?.openPositions ? `${session.openPositions} nyitott` : "0 nyitott"}
          accent="neu"
        />
        <Stat
          label="Status"
          value={session?.stopped ? "STOPPED" : (session ? "RUNNING" : "…")}
          sub={session?.stoppedReason ?? "cron */3 perc"}
          accent={session?.stopped ? "warn" : "pos"}
        />
      </section>

      {/* ─── EXECUTION CARDS ─── */}
      <SectionTitle title="Trading & Execution" subtitle="Auto-trader pillérek és manuális kereskedés" />
      <div className="hp-grid">
        {CARDS.filter((c) => c.group === "execution").map((c) => (
          <CapCard key={c.id} card={c} envStat={envStat} />
        ))}
      </div>

      {/* ─── TOOLS CARDS ─── */}
      <SectionTitle title="Tools" subtitle="Polymarket-specifikus segédoldalak + tracking" />
      <div className="hp-grid">
        {CARDS.filter((c) => c.group === "tools").map((c) => (
          <CapCard key={c.id} card={c} envStat={envStat} />
        ))}
      </div>

      {/* ─── ANALYSIS CARDS ─── */}
      <SectionTitle title="Signal Layer & Research" subtitle="8 jelzés + market discovery, csak elemzés (read-only)" />
      <div className="hp-grid">
        {CARDS.filter((c) => c.group === "analysis").map((c) => (
          <CapCard key={c.id} card={c} envStat={envStat} />
        ))}
      </div>

      {/* ─── ENV STATUS CHECKLIST ─── */}
      <SectionTitle title="Environment Status" subtitle="Netlify env varok — zöld = beállítva, piros = hiányzik" />
      <div className="hp-env-grid">
        {CAT_ORDER.filter((c) => byCategory[c]?.length).map((cat) => (
          <div key={cat} className="hp-env-card">
            <div className="hp-env-cat">{CAT_LABEL[cat] || cat}</div>
            {byCategory[cat].map((e) => (
              <div key={e.name} className="hp-env-row" title={e.description}>
                <span className={`hp-env-dot ${e.set ? "ok" : "missing"}`} />
                <span className="hp-env-name">{e.name}</span>
                <span className="hp-env-desc">{e.description}</span>
              </div>
            ))}
          </div>
        ))}
      </div>

      {loadErr && <div className="hp-err">⚠ {loadErr}</div>}

      <footer className="hp-footer">
        <span>cron */3 perc UTC · Netlify Functions · v8</span>
        <a href="https://github.com/monooleate/trading-bot" target="_blank" rel="noopener noreferrer">github</a>
      </footer>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────

function Stat({
  label, value, sub, accent,
}: { label: string; value: string; sub?: string; accent: "pos" | "neg" | "neu" | "warn" }) {
  return (
    <div className="hp-stat">
      <div className="hp-stat-lbl">{label}</div>
      <div className={`hp-stat-val ${accent}`}>{value}</div>
      {sub && <div className="hp-stat-sub">{sub}</div>}
    </div>
  );
}

function SectionTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="hp-section">
      <div className="hp-section-title">{title}</div>
      <div className="hp-section-sub">{subtitle}</div>
    </div>
  );
}

function CapCard({ card, envStat }: { card: Card; envStat: EnvStatus | null }) {
  const cap  = card.capability ? envStat?.capabilities?.[card.capability] : null;
  const blocked = cap && !cap.ok;
  const mode = MODE_LABEL[card.mode];

  return (
    <a
      href={card.href}
      className={`hp-card ${blocked ? "blocked" : ""}`}
    >
      <div className="hp-card-top">
        <span className="hp-card-icon">{card.icon}</span>
        <span className={`hp-pill ${mode.cls}`}>{mode.txt}</span>
      </div>
      <div className="hp-card-title">{card.title}</div>
      <div className="hp-card-blurb">{card.blurb}</div>
      {blocked && cap && (
        <div className="hp-card-warn">
          <span className="hp-warn-icon">⚠</span>
          <span>Hiányzó env: <code>{cap.missing.join(", ")}</code></span>
        </div>
      )}
      {!blocked && cap && (
        <div className="hp-card-ready">
          <span className="hp-ready-icon">✓</span>
          <span>env beállítva</span>
        </div>
      )}
    </a>
  );
}

// ─── CSS ──────────────────────────────────────────────────────────────

const css = `
.hp-wrap {
  max-width: 1180px;
  margin: 0 auto;
  padding: 32px 18px 48px;
  font-family: var(--sans);
  color: var(--text);
}
.hp-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 28px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--border);
}
.hp-logo {
  font-family: var(--mono);
  font-size: 22px;
  color: var(--accent);
  letter-spacing: .2em;
  text-transform: uppercase;
  font-weight: 700;
}
.hp-logo span { color: var(--muted); }
.hp-sub {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--muted);
  letter-spacing: .12em;
  text-transform: uppercase;
  margin-top: 5px;
}
.hp-mode-display {
  display: flex;
  align-items: center;
  gap: 10px;
}
.hp-mode-pill {
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 700;
  padding: 8px 16px;
  border-radius: 3px;
  letter-spacing: .12em;
  text-transform: uppercase;
}
.hp-mode-pill.paper {
  background: #16161c;
  color: var(--accent2);
  border: 1px solid var(--accent2);
}
.hp-mode-pill.live {
  background: #1f0000;
  color: var(--danger);
  border: 1px solid var(--danger);
  animation: hp-pulse 2s ease-in-out infinite;
}
@keyframes hp-pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: .7; }
}

/* ─── Summary stats ─── */
.hp-summary {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
  margin-bottom: 36px;
}
.hp-stat {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 16px 18px;
}
.hp-stat-lbl {
  font-family: var(--mono);
  font-size: 9px;
  color: var(--muted);
  letter-spacing: .14em;
  text-transform: uppercase;
  margin-bottom: 6px;
}
.hp-stat-val {
  font-family: var(--mono);
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -.02em;
  line-height: 1.1;
}
.hp-stat-val.pos  { color: var(--accent); }
.hp-stat-val.neg  { color: var(--danger); }
.hp-stat-val.neu  { color: var(--text); }
.hp-stat-val.warn { color: var(--warn); }
.hp-stat-sub {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--muted);
  margin-top: 5px;
}

/* ─── Section header ─── */
.hp-section {
  margin: 26px 0 14px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}
.hp-section-title {
  font-family: var(--sans);
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
  letter-spacing: -.01em;
}
.hp-section-sub {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--muted);
  margin-top: 3px;
}

/* ─── Capability cards ─── */
.hp-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}
@media (max-width: 980px) { .hp-grid { grid-template-columns: repeat(3, 1fr); } }
@media (max-width: 720px) { .hp-grid { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 460px) { .hp-grid { grid-template-columns: 1fr; } }

.hp-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 16px 16px 14px;
  text-decoration: none;
  color: var(--text);
  display: flex;
  flex-direction: column;
  gap: 8px;
  position: relative;
  transition: border-color .15s, transform .1s, background .15s;
}
.hp-card:hover {
  border-color: var(--accent);
  transform: translateY(-1px);
  background: #131318;
}
.hp-card.blocked {
  border-color: #5a1a1a;
}
.hp-card.blocked:hover {
  border-color: var(--danger);
}
.hp-card-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}
.hp-card-icon {
  font-size: 24px;
  line-height: 1;
}
.hp-card-title {
  font-family: var(--sans);
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
  letter-spacing: -.01em;
}
.hp-card-blurb {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--muted);
  line-height: 1.55;
  flex: 1;
}
.hp-card-warn {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-family: var(--mono);
  font-size: 9px;
  color: var(--danger);
  background: #1f0000;
  border: 1px solid #3a0000;
  padding: 6px 8px;
  border-radius: 2px;
  margin-top: 4px;
}
.hp-card-warn code {
  color: var(--warn);
  font-size: 9px;
  word-break: break-all;
}
.hp-warn-icon, .hp-ready-icon {
  flex-shrink: 0;
  font-weight: 700;
}
.hp-card-ready {
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--mono);
  font-size: 9px;
  color: var(--accent);
  background: #0a1f00;
  border: 1px solid #1a3300;
  padding: 5px 8px;
  border-radius: 2px;
  margin-top: 4px;
}

/* ─── Mode pills ─── */
.hp-pill {
  font-family: var(--mono);
  font-size: 8.5px;
  font-weight: 700;
  padding: 3px 8px;
  border-radius: 2px;
  letter-spacing: .07em;
  text-transform: uppercase;
  flex-shrink: 0;
}
.hp-pill-live     { background: #0a1f00; color: var(--accent);  border: 1px solid #1a3300; }
.hp-pill-paper    { background: #001a2a; color: var(--accent2); border: 1px solid #003344; }
.hp-pill-manual   { background: #1f1400; color: var(--warn);    border: 1px solid #332200; }
.hp-pill-readonly { background: #16161c; color: var(--muted);   border: 1px solid var(--border); }
.hp-pill-analysis { background: #16161c; color: var(--muted);   border: 1px solid var(--border); }

/* ─── Env status grid ─── */
.hp-env-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
  margin-bottom: 28px;
}
@media (max-width: 720px) { .hp-env-grid { grid-template-columns: 1fr; } }

.hp-env-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 14px 16px;
}
.hp-env-cat {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--accent);
  letter-spacing: .14em;
  text-transform: uppercase;
  margin-bottom: 10px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
}
.hp-env-row {
  display: grid;
  grid-template-columns: 12px minmax(140px, max-content) 1fr;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-family: var(--mono);
  font-size: 10px;
}
.hp-env-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}
.hp-env-dot.ok      { background: var(--accent); box-shadow: 0 0 6px rgba(200,241,53,.35); }
.hp-env-dot.missing { background: var(--danger); box-shadow: 0 0 6px rgba(241,53,53,.35); }
.hp-env-name {
  color: var(--text);
  font-weight: 700;
  font-size: 10px;
}
.hp-env-desc {
  color: var(--muted);
  font-size: 9.5px;
}

/* ─── Footer ─── */
.hp-err {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--warn);
  background: #1f1400;
  border-left: 3px solid var(--warn);
  padding: 8px 12px;
  border-radius: 2px;
  margin-bottom: 20px;
}
.hp-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 36px;
  padding-top: 18px;
  border-top: 1px solid var(--border);
  font-family: var(--mono);
  font-size: 10px;
  color: var(--muted);
}
.hp-footer a {
  color: var(--accent2);
  text-decoration: none;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.hp-footer a:hover { color: var(--accent); }
`;
