// src/components/HomePage.tsx
//
// Mission-control landing page. Aggregates session state across every
// auto-trader category (multi-status), shows env-var availability
// (env-status), and routes each card to its dedicated /trade/<venue>/
// page — never to a /tools# tab anymore. Tools dashboard is kept
// strictly for analysis (signal layer + research).

import { useEffect, useState } from "react";

const FN = "/.netlify/functions";

// ─── Types ────────────────────────────────────────────────────────────

interface MultiStatus {
  ok: boolean;
  paperMode: boolean;
  totals: {
    bankrollStart: number;
    bankrollCurrent: number;
    sessionPnL: number;
    closedTrades: number;
    openPositions: number;
  };
  categories: {
    category: string;
    label: string;
    found: boolean;
    paperMode: boolean | null;
    bankrollStart: number;
    bankrollCurrent: number;
    sessionPnL: number;
    closedTrades: number;
    openPositions: number;
    stopped: boolean;
    startedAt: string | null;
  }[];
  activeCount: number;
}

interface EnvStatus {
  paperMode: boolean;
  env: { name: string; category: string; description: string; set: boolean; required_for: string[] }[];
  capabilities: Record<string, { ok: boolean; missing: string[] }>;
}

// Mirror of LiveReadinessReport from auto-trader/shared/live-readiness.mts.
// Pulled per-category from /auto-trader-api?action=status so the home page
// can render the same gate verdict the cron path uses to refuse live trades.
interface ReadinessGate {
  key: string;
  label: string;
  passed: boolean;
  actual: string;
  required: string;
  applicable: boolean;
}
interface LiveReadinessReport {
  category: string;
  ready: boolean;
  gatesPassed: number;
  gatesTotal: number;
  gates: ReadinessGate[];
  reason: string;
}

// Categories the cron loop force-flips back to paper if liveReadiness.ready
// is false. Matches the auto-trader categories handled by live-readiness.mts.
const READINESS_CATEGORIES: { key: "crypto" | "weather" | "hyperliquid" | "funding-arb"; label: string; statusUrl: string }[] = [
  { key: "crypto",       label: "Crypto",        statusUrl: "/.netlify/functions/auto-trader-api?action=status&category=crypto" },
  { key: "weather",      label: "Weather",       statusUrl: "/.netlify/functions/auto-trader-api?action=status&category=weather" },
  { key: "hyperliquid",  label: "Hyperliquid",   statusUrl: "/.netlify/functions/auto-trader-api?action=status&category=hyperliquid" },
  { key: "funding-arb",  label: "Funding Arb",   statusUrl: "/.netlify/functions/auto-trader-api?action=status&category=hyperliquid&layer=arb" },
];

// ─── Capability cards ─────────────────────────────────────────────────

interface Card {
  id: string;
  title: string;
  blurb: string;
  icon: string;
  href: string;
  mode: "PAPER+LIVE" | "PAPER-ONLY" | "MANUAL" | "READ-ONLY" | "ANALYSIS";
  capability?: string;
  group: "execution" | "tools" | "analysis";
  category?: string;     // links per-category bankroll snapshot to this card
}

const CARDS: Card[] = [
  // ── Execution: dedicated /trade/<x>/ pages ──
  {
    id: "crypto",
    title: "Crypto Auto-Trader",
    blurb: "Polymarket BTC short markets · cron 3 perc · TP/SL + entry window",
    icon: "🪙",
    href: "/trade/crypto/",
    mode: "PAPER+LIVE",
    capability: "live-crypto-auto",
    category: "crypto",
    group: "execution",
  },
  {
    id: "hyperliquid",
    title: "Hyperliquid Perp",
    blurb: "BTC/ETH/SOL directional perp · cron 3 perc · TP/SL via HL markPrice",
    icon: "⚡",
    href: "/trade/hyperliquid/",
    mode: "PAPER-ONLY",
    capability: "hyperliquid-paper",
    category: "hyperliquid",
    group: "execution",
  },
  {
    id: "funding-arb",
    title: "Funding Rate Arbitrage",
    blurb: "Delta-neutral carry · SHORT HL perp + LONG Binance spot · cron 3 perc",
    icon: "♻️",
    href: "/trade/funding-arb/",
    mode: "PAPER-ONLY",
    capability: "hyperliquid-paper",
    category: "funding-arb",
    group: "execution",
  },
  {
    id: "weather",
    title: "Weather Trader",
    blurb: "Hőmérséklet piacok · 31-tagú GFS ensemble · KLGA/KDAL/EGLC station fix",
    icon: "🌤️",
    href: "/trade/weather/",
    mode: "PAPER+LIVE",
    category: "weather",
    group: "execution",
  },
  {
    id: "bybit",
    title: "Bybit Futures",
    blurb: "Manuális order leadás · v5 API · balances + positions",
    icon: "📉",
    href: "/trade/bybit/",
    mode: "MANUAL",
    capability: "bybit-manual",
    group: "execution",
  },
  {
    id: "binance",
    title: "Binance Futures",
    blurb: "Manuális order leadás · USDM perpetual",
    icon: "🟡",
    href: "/trade/binance/",
    mode: "MANUAL",
    capability: "binance-manual",
    group: "execution",
  },
  {
    id: "polymarket-manual",
    title: "Polymarket Manual + Auto-Claim",
    blurb: "Read-only piac scan · intent generátor · nyertes pozíció redeem",
    icon: "🎯",
    href: "/trade/polymarket-manual/",
    mode: "MANUAL",
    capability: "manual-trading",
    group: "execution",
  },

  // ── Analysis: /tools (csak elemzés, nincs trading itt) ──
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
  {
    id: "arbmatrix",
    title: "Arb Matrix",
    blurb: "VWAP arb · LLM dependency · Pair-Cost arb scanner",
    icon: "♻️",
    href: "/tools#arbmatrix",
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
  const [multi, setMulti]     = useState<MultiStatus | null>(null);
  const [envStat, setEnvStat] = useState<EnvStatus | null>(null);
  const [loadErr, setLoadErr] = useState<string>("");
  const [readiness, setReadiness] = useState<Record<string, LiveReadinessReport | null>>({});

  useEffect(() => {
    Promise.all([
      fetch(`${FN}/multi-status?paper=true`).then((r) => r.json()).catch(() => null),
      fetch(`${FN}/env-status`).then((r) => r.json()).catch(() => null),
    ]).then(([m, e]) => {
      if (m?.ok) setMulti(m);
      if (e?.ok) setEnvStat(e);
      if (!m || !e) setLoadErr("Néhány adat nem töltődött be — frissíts.");
    }).catch((err) => setLoadErr(err.message));
  }, []);

  // Live-readiness aggregator: poll each auto-trader category every 30s so
  // the home-page banner reflects the latest gate verdict without a manual
  // refresh. Shorter than the cron tick so the user sees flips immediately.
  useEffect(() => {
    const fetchAll = async () => {
      const results: Record<string, LiveReadinessReport | null> = {};
      await Promise.all(
        READINESS_CATEGORIES.map(async (c) => {
          try {
            const r = await fetch(c.statusUrl);
            const j = await r.json();
            results[c.key] = (j?.liveReadiness as LiveReadinessReport) ?? null;
          } catch {
            results[c.key] = null;
          }
        }),
      );
      setReadiness(results);
    };
    fetchAll();
    const id = setInterval(fetchAll, 30_000);
    return () => clearInterval(id);
  }, []);

  const live    = envStat ? !envStat.paperMode : false;
  const totals  = multi?.totals;

  // Aggregate readiness verdict — the banner is loud (red) when env intent
  // is LIVE but at least one trader is NOT live-ready (the cron will have
  // force-flipped it back to paper). When env is already PAPER the banner
  // is informational (amber) so the operator still sees what's pending.
  const readinessRows = READINESS_CATEGORIES.map((c) => ({
    key: c.key,
    label: c.label,
    href: `/trade/${c.key}/`,
    report: readiness[c.key] ?? null,
  }));
  const notReady = readinessRows.filter((r) => r.report && !r.report.ready);
  const anyKnownReadiness = readinessRows.some((r) => r.report !== null);
  const liveBlocked = live && notReady.length > 0;
  const pnlPositive = (totals?.sessionPnL ?? 0) >= 0;
  const roi = totals && totals.bankrollStart > 0
    ? (totals.sessionPnL / totals.bankrollStart) * 100
    : 0;

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
          <div className="hp-sub">Mission Control · Polymarket + Hyperliquid + Crypto venues</div>
        </div>
        <div className="hp-mode-display">
          <span className={`hp-mode-pill ${live ? "live" : "paper"}`}>
            {live ? "● LIVE" : "● PAPER MODE"}
          </span>
        </div>
      </header>

      {/* ─── LIVE READINESS BANNER ─── */}
      {liveBlocked && (
        <div className="hp-live-blocked">
          <div className="hp-live-blocked-head">
            <span className="hp-live-blocked-glyph">🚦</span>
            <div>
              <div className="hp-live-blocked-title">
                Live trading auto-suspended on {notReady.length} bot{notReady.length > 1 ? "s" : ""}
              </div>
              <div className="hp-live-blocked-sub">
                PAPER_MODE=false van beállítva, de az alábbi bot(ok) nem teljesítik a live-readiness küszöböket. A cron minden tickben visszaállítja paper-be amíg a kapuk nem futnak át.
              </div>
            </div>
          </div>
          <div className="hp-live-blocked-grid">
            {notReady.map((r) => (
              <a key={r.key} href={r.href} className="hp-live-blocked-card">
                <div className="hp-live-blocked-card-head">
                  <span className="hp-live-blocked-cat">{r.label}</span>
                  <span className="hp-live-blocked-pill">PAPER</span>
                </div>
                <div className="hp-live-blocked-reason">{r.report!.reason}</div>
                <div className="hp-live-blocked-gates">
                  {r.report!.gates.filter((g) => g.applicable && !g.passed).map((g) => (
                    <span key={g.key} className="hp-live-gate-fail" title={`have ${g.actual} · need ${g.required}`}>
                      ✗ {g.label}
                    </span>
                  ))}
                </div>
              </a>
            ))}
          </div>
        </div>
      )}

      {/* ─── PER-TRADER LIVE-READINESS QUICK GLANCE ─── */}
      {anyKnownReadiness && (
        <>
          <SectionTitle
            title="Live-readiness gates"
            subtitle="Bot-onkénti verdict — zöld = élesedhet, sárga = paper-validálás folyamatban / blokkolva"
          />
          <div className="hp-readiness-grid">
            {readinessRows.map((r) => {
              const rep = r.report;
              const cls = !rep ? "unknown" : rep.ready ? "ready" : "not-ready";
              return (
                <a key={r.key} href={r.href} className={`hp-rd-card hp-rd-${cls}`}>
                  <div className="hp-rd-head">
                    <span className="hp-rd-cat">{r.label}</span>
                    <span className="hp-rd-status">
                      {!rep ? "?" : rep.ready ? "READY" : "PAPER"}
                    </span>
                  </div>
                  <div className="hp-rd-count">
                    {rep ? `${rep.gatesPassed}/${rep.gatesTotal} gates` : "lekérdezés…"}
                  </div>
                  {rep && (
                    <div className="hp-rd-reason" title={rep.reason}>{rep.reason}</div>
                  )}
                </a>
              );
            })}
          </div>
        </>
      )}

      {/* ─── SESSION SUMMARY (összesített) ─── */}
      <SectionTitle title="Aggregated session" subtitle="Minden bot összesítve · per-category lentebb" />
      <section className="hp-summary">
        <Stat
          label="Bankroll (Σ)"
          value={totals ? `$${totals.bankrollCurrent.toFixed(0)}` : "…"}
          sub={totals && totals.bankrollStart > 0
            ? `start: $${totals.bankrollStart.toFixed(0)}`
            : "no active session"}
          accent="neu"
        />
        <Stat
          label="PnL (Σ)"
          value={totals ? (pnlPositive ? "+" : "") + "$" + totals.sessionPnL.toFixed(0) : "…"}
          sub={totals ? `${roi.toFixed(0)}% ROI` : ""}
          accent={pnlPositive ? "pos" : "neg"}
        />
        <Stat
          label="Closed trades"
          value={totals ? `${totals.closedTrades}` : "…"}
          sub={totals?.openPositions ? `${totals.openPositions} nyitott` : "0 nyitott"}
          accent="neu"
        />
        <Stat
          label="Active bots"
          value={multi ? `${multi.activeCount}/4` : "…"}
          sub="cron */3 perc · UTC"
          accent={multi && multi.activeCount > 0 ? "pos" : "neu"}
        />
      </section>

      {/* ─── PER-CATEGORY BREAKDOWN ─── */}
      {multi && multi.categories.some((c) => c.found) && (
        <div className="hp-breakdown">
          {multi.categories.filter((c) => c.found).map((c) => (
            <div key={c.category} className="hp-bd-row">
              <span className="hp-bd-cat">{c.label}</span>
              <span className="hp-bd-bk">${c.bankrollCurrent.toFixed(0)}</span>
              <span className={`hp-bd-pnl ${c.sessionPnL >= 0 ? "pos" : "neg"}`}>
                {c.sessionPnL >= 0 ? "+" : ""}${c.sessionPnL.toFixed(0)}
              </span>
              <span className="hp-bd-trades">{c.closedTrades} trade</span>
              <span className={`hp-bd-status ${c.stopped ? "stopped" : "running"}`}>
                {c.stopped ? "STOPPED" : "RUNNING"}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* ─── EXECUTION CARDS ─── */}
      <SectionTitle title="Trading & Execution" subtitle="Saját oldal kategóriánként · /trade/<venue>/ — itt nincs duplikáció a /tools-szal" />
      <div className="hp-grid">
        {CARDS.filter((c) => c.group === "execution").map((c) => (
          <CapCard key={c.id} card={c} envStat={envStat} multi={multi} />
        ))}
      </div>

      {/* ─── ANALYSIS CARDS ─── */}
      <SectionTitle title="Analysis & Research" subtitle="Csak elemzés (read-only) · /tools — nincs trading execution itt" />
      <div className="hp-grid">
        {CARDS.filter((c) => c.group === "analysis").map((c) => (
          <CapCard key={c.id} card={c} envStat={envStat} multi={multi} />
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
        <span>
          <a href="/tools" style={{ marginRight: 18 }}>tools →</a>
          <a href="https://github.com/monooleate/trading-bot" target="_blank" rel="noopener noreferrer">github</a>
        </span>
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

function CapCard({ card, envStat, multi }: { card: Card; envStat: EnvStatus | null; multi: MultiStatus | null }) {
  const cap     = card.capability ? envStat?.capabilities?.[card.capability] : null;
  const blocked = cap && !cap.ok;
  const mode    = MODE_LABEL[card.mode];
  const cat     = card.category && multi
    ? multi.categories.find((c) => c.category === card.category)
    : null;

  return (
    <a href={card.href} className={`hp-card ${blocked ? "blocked" : ""}`}>
      <div className="hp-card-top">
        <span className="hp-card-icon">{card.icon}</span>
        <span className={`hp-pill ${mode.cls}`}>{mode.txt}</span>
      </div>
      <div className="hp-card-title">{card.title}</div>
      <div className="hp-card-blurb">{card.blurb}</div>
      {cat && cat.found && (
        <div className="hp-card-stats">
          <span>${cat.bankrollCurrent.toFixed(0)}</span>
          <span className={cat.sessionPnL >= 0 ? "pos" : "neg"}>
            {cat.sessionPnL >= 0 ? "+" : ""}${cat.sessionPnL.toFixed(0)}
          </span>
          <span className="hp-card-trades">{cat.closedTrades} trade</span>
        </div>
      )}
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
  gap: 12px;
  flex-wrap: wrap;
}
@media (max-width: 480px) {
  .hp-wrap { padding: 18px 12px 32px; }
  .hp-header { margin-bottom: 18px; }
  .hp-logo { font-size: 18px; }
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

/* ─── Live-blocked banner ─── */
.hp-live-blocked {
  background: linear-gradient(180deg, #2a0000 0%, #1a0000 100%);
  border: 1px solid var(--danger);
  border-left: 4px solid var(--danger);
  border-radius: 4px;
  padding: 14px 16px;
  margin-bottom: 22px;
  animation: hp-blocked-pulse 3s ease-in-out infinite;
}
@keyframes hp-blocked-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(241,53,53,0); }
  50%      { box-shadow: 0 0 22px 0 rgba(241,53,53,.18); }
}
.hp-live-blocked-head {
  display: flex;
  gap: 14px;
  align-items: flex-start;
  margin-bottom: 12px;
}
.hp-live-blocked-glyph { font-size: 28px; line-height: 1; }
.hp-live-blocked-title {
  font-family: var(--sans);
  font-size: 15px;
  font-weight: 700;
  color: var(--danger);
  letter-spacing: -.01em;
}
.hp-live-blocked-sub {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
  margin-top: 4px;
  line-height: 1.5;
}
.hp-live-blocked-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 10px;
}
.hp-live-blocked-card {
  background: #1a0a0a;
  border: 1px solid #5a1a1a;
  border-radius: 3px;
  padding: 10px 12px;
  text-decoration: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  transition: border-color .15s, background .15s;
}
.hp-live-blocked-card:hover {
  border-color: var(--danger);
  background: #220a0a;
}
.hp-live-blocked-card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.hp-live-blocked-cat {
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 700;
  color: var(--text);
  letter-spacing: .04em;
  text-transform: uppercase;
}
.hp-live-blocked-pill {
  font-family: var(--mono);
  font-size: 9px;
  font-weight: 700;
  color: var(--warn);
  background: #1f1500;
  border: 1px solid #4a3300;
  padding: 2px 7px;
  border-radius: 2px;
  letter-spacing: .12em;
  text-transform: uppercase;
}
.hp-live-blocked-reason {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--muted);
  line-height: 1.45;
}
.hp-live-blocked-gates {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
}
.hp-live-gate-fail {
  font-family: var(--mono);
  font-size: 9.5px;
  color: var(--danger);
  background: #1a0000;
  border: 1px solid #3a0000;
  padding: 2px 6px;
  border-radius: 2px;
  white-space: nowrap;
}

/* ─── Per-trader readiness quick glance ─── */
.hp-readiness-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
  margin-bottom: 24px;
}
@media (max-width: 760px) { .hp-readiness-grid { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 380px) { .hp-readiness-grid { grid-template-columns: 1fr; } }
.hp-rd-card {
  display: flex;
  flex-direction: column;
  gap: 5px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-left-width: 3px;
  border-radius: 3px;
  padding: 12px 14px;
  text-decoration: none;
  color: var(--text);
  transition: border-color .15s, background .15s;
}
.hp-rd-ready     { border-left-color: var(--accent); }
.hp-rd-not-ready { border-left-color: var(--warn); }
.hp-rd-unknown   { border-left-color: var(--muted); }
.hp-rd-card:hover { background: #131318; }
.hp-rd-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.hp-rd-cat {
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .04em;
  text-transform: uppercase;
}
.hp-rd-status {
  font-family: var(--mono);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: .12em;
  padding: 2px 7px;
  border-radius: 2px;
}
.hp-rd-ready     .hp-rd-status { background: #0a2010; color: var(--accent); border: 1px solid #1a3300; }
.hp-rd-not-ready .hp-rd-status { background: #1f1500; color: var(--warn);   border: 1px solid #4a3300; }
.hp-rd-unknown   .hp-rd-status { background: #16161c; color: var(--muted);  border: 1px solid var(--border); }
.hp-rd-count {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--muted);
}
.hp-rd-reason {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--text);
  opacity: .85;
  line-height: 1.45;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

/* ─── Summary stats ─── */
.hp-summary {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
  margin-bottom: 12px;
}
@media (max-width: 760px) { .hp-summary { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 380px) { .hp-summary { grid-template-columns: 1fr; } }
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

/* ─── Per-category breakdown ─── */
.hp-breakdown {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 6px 10px;
  margin-bottom: 36px;
}
.hp-bd-row {
  display: grid;
  grid-template-columns: 2fr 1fr 1fr 1fr 1fr;
  align-items: center;
  padding: 8px 6px;
  font-family: var(--mono);
  font-size: 11px;
  border-bottom: 1px solid var(--border);
  gap: 6px;
}
@media (max-width: 600px) {
  .hp-bd-row {
    grid-template-columns: 1fr auto;
    grid-template-areas:
      "cat status"
      "bk pnl"
      "trades trades";
    row-gap: 4px;
  }
  .hp-bd-cat { grid-area: cat; }
  .hp-bd-bk { grid-area: bk; }
  .hp-bd-pnl { grid-area: pnl; text-align: right; }
  .hp-bd-trades { grid-area: trades; font-size: 9.5px; }
  .hp-bd-status { grid-area: status; justify-self: end; }
}
.hp-bd-row:last-child { border-bottom: none; }
.hp-bd-cat { color: var(--text); font-weight: 700; }
.hp-bd-bk { color: var(--muted); }
.hp-bd-pnl.pos { color: var(--accent); font-weight: 700; }
.hp-bd-pnl.neg { color: var(--danger); font-weight: 700; }
.hp-bd-trades { color: var(--muted); font-size: 10px; }
.hp-bd-status { font-size: 9px; padding: 2px 6px; border-radius: 2px; text-align: center; letter-spacing: .08em; }
.hp-bd-status.running { background: #0a2010; color: var(--accent); border: 1px solid #1a3300; }
.hp-bd-status.stopped { background: #1f1400; color: var(--warn); border: 1px solid #332200; }

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
.hp-card.blocked { border-color: #5a1a1a; }
.hp-card.blocked:hover { border-color: var(--danger); }
.hp-card-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}
.hp-card-icon { font-size: 24px; line-height: 1; }
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
.hp-card-stats {
  display: flex;
  gap: 10px;
  align-items: center;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--muted);
  background: var(--surface2);
  border: 1px solid var(--border);
  padding: 6px 8px;
  border-radius: 2px;
  margin-top: 4px;
}
.hp-card-stats .pos { color: var(--accent); font-weight: 700; }
.hp-card-stats .neg { color: var(--danger); font-weight: 700; }
.hp-card-trades { margin-left: auto; font-size: 9px; }
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
.hp-card-warn code { color: var(--warn); font-size: 9px; word-break: break-all; }
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
.hp-env-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.hp-env-dot.ok      { background: var(--accent); box-shadow: 0 0 6px rgba(200,241,53,.35); }
.hp-env-dot.missing { background: var(--danger); box-shadow: 0 0 6px rgba(241,53,53,.35); }
.hp-env-name { color: var(--text); font-weight: 700; font-size: 10px; }
.hp-env-desc { color: var(--muted); font-size: 9.5px; }

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
