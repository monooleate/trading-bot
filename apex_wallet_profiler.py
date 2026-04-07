#!/usr/bin/env python3
"""
apex_wallet_profiler.py
-----------------------
Polymarket Apex Wallet Profiler

1. Leaderboard lekérés (top 100 wallet)
2. Minden wallet profilozása: Sharpe, win rate, diverzifikáció
3. Apex szűrés: Sharpe > 2.0, win rate > 60%, min. 20 trade
4. Consensus detection: hol aktívak egyszerre az apex walletok?
5. Claude API összefoglalás (opcionális)

Futtatás:
  pip install numpy requests
  python apex_wallet_profiler.py --demo
  python apex_wallet_profiler.py --leaderboard
  python apex_wallet_profiler.py --consensus
  python apex_wallet_profiler.py --profile 0x...
  python apex_wallet_profiler.py --consensus --claude   # Claude elemzéssel
"""

import argparse
import json
import math
import sys
import time
from collections import defaultdict
from dataclasses import dataclass, field, asdict
from typing import Optional

import numpy as np
import requests

# ─── Konfig ───────────────────────────────────────────────────────────────────
DATA_API  = "https://data-api.polymarket.com"
GAMMA_API = "https://gamma-api.polymarket.com"

APEX_MIN_SHARPE   = 2.0
APEX_MIN_WINRATE  = 0.60
APEX_MIN_TRADES   = 20
APEX_MIN_PAYOUT   = 2.0  # min payout ratio (avg_win / avg_loss)
APEX_CONSENSUS_N  = 2   # min apex wallet ugyanabban a piacban

# ─── DATA CLASSES ─────────────────────────────────────────────────────────────

@dataclass
class Trade:
    market:    str
    side:      str   # BUY | SELL
    price:     float
    size:      float
    timestamp: str
    outcome:   Optional[float] = None

@dataclass
class WalletProfile:
    address:        str
    name:           Optional[str]
    total_trades:   int
    total_volume:   float
    markets_count:  int
    sharpe_ratio:   float
    win_rate:       float
    avg_position_size: float
    is_apex:        bool
    apex_criteria:  dict
    recent_markets: list[str]
    # Payout ratio (poszt alapján: a lényeg)
    payout_ratio:   float = 0.0   # avg_win / avg_loss abszolút értéke
    avg_win:        float = 0.0   # átlagos nyerő trade PnL
    avg_loss:       float = 0.0   # átlagos vesztes trade PnL (pozitív szám)
    break_even_wr:  float = 0.0   # break-even win rate ennél a payout ratio-nál
    # Kategória specialist
    category_stats: dict = None   # {category: {win_rate, trades, pnl}}
    best_category:  str  = ""     # legjobb kategória
    best_cat_wr:    float = 0.0   # legjobb kategória win rate

@dataclass
class ConsensusSignal:
    market:           str
    market_question:  str
    dominant_side:    str
    apex_count:       int
    total_apex:       int
    confidence:       float
    avg_price:        float
    wallets:          list[str]


# ─── SESSION CLASSIFIER ───────────────────────────────────────────────────────

SESSIONS = {
    'low_liquidity': (7,  10,  '4AM ET – Low Liquidity'),
    'london':        (6,  9,   'London Open'),
    'ny_open':       (13, 17,  'NY Open'),
    'ny_close':      (20, 23,  'NY Close'),
    'asian':         (23, 6,   'Asian Session'),
}

def classify_session(utc_hour: int) -> str:
    if 7 <= utc_hour <= 10:  return 'low_liquidity'
    if 6 <= utc_hour <= 9:   return 'london'
    if 13 <= utc_hour <= 17: return 'ny_open'
    if 20 <= utc_hour <= 23: return 'ny_close'
    return 'asian'

def analyze_time_activity(trades: list[Trade]) -> dict:
    """Időalapú trade aktivitás elemzés."""
    hourly = [0] * 24
    sessions = {k: 0 for k in SESSIONS}

    for t in trades:
        if not t.timestamp:
            continue
        try:
            from datetime import timezone
            ts = t.timestamp
            if isinstance(ts, str):
                from datetime import datetime
                # ISO format
                dt = datetime.fromisoformat(ts.replace('Z', '+00:00'))
                h = dt.astimezone(timezone.utc).hour
            else:
                from datetime import datetime
                h = datetime.utcfromtimestamp(float(ts) / 1000 if float(ts) > 1e10 else float(ts)).hour
            hourly[h] += 1
            sessions[classify_session(h)] += 1
        except Exception:
            continue

    total = max(sum(hourly), 1)
    peak_hour = hourly.index(max(hourly))
    peak_sess = max(sessions, key=sessions.get)
    low_liq_pct = sessions['low_liquidity'] / total

    return {
        'hourly_distribution': hourly,
        'session_breakdown':   sessions,
        'peak_hour_utc':       peak_hour,
        'peak_session':        peak_sess,
        'low_liq_pct':         round(low_liq_pct, 3),
        'low_liq_trades':      sessions['low_liquidity'],
        'is_low_liq_heavy':    low_liq_pct > 0.25,
    }



# ─── BOT DETECTOR ─────────────────────────────────────────────────────────────

@dataclass
class BotScore:
    score:          int
    classification: str   # HUMAN | LIKELY_HUMAN | UNCERTAIN | LIKELY_BOT | BOT
    signals:        list[str]
    focus_ratio:    float
    hours_active:   int
    median_interval_sec: Optional[float]
    timing_cv:      float
    has_sleep_gap:  bool

def detect_bot(trades: list[Trade]) -> BotScore:
    """
    Bot detekció Hubble Research módszertan alapján.
    Négy jelzés: focus ratio, 24h lefedettség, sleep gap, timing regularity.
    """
    signals = []
    score   = 0

    if len(trades) < 5:
        return BotScore(0, "UNCERTAIN", ["Insufficient data (<5 trade)"],
                        0, 0, None, 0, True)

    # ── Focus ratio ──────────────────────────────────────────────────────────
    markets = len(set(t.market for t in trades if t.market))
    focus_ratio = len(trades) / max(markets, 1)

    if   focus_ratio > 50: score += 35; signals.append(f"Focus ratio {focus_ratio:.0f} (>50 = bot szint)")
    elif focus_ratio > 20: score += 15; signals.append(f"Focus ratio {focus_ratio:.0f} (magas)")

    # ── 24h lefedettség + sleep gap ──────────────────────────────────────────
    hour_counts = [0] * 24
    timestamps  = []
    for t in trades:
        if not t.timestamp: continue
        try:
            from datetime import datetime, timezone
            ts_str = t.timestamp
            if isinstance(ts_str, (int, float)):
                dt = datetime.utcfromtimestamp(float(ts_str) / 1000 if float(ts_str) > 1e10 else float(ts_str))
            else:
                dt = datetime.fromisoformat(str(ts_str).replace("Z","+00:00")).astimezone(timezone.utc)
            hour_counts[dt.hour] += 1
            timestamps.append(dt.timestamp())
        except Exception:
            continue

    hours_active  = sum(1 for h in hour_counts if h > 0)
    hours_active_pct = hours_active / 24

    if   hours_active_pct > 0.90: score += 25; signals.append(f"24/7 aktív ({hours_active}/24 óra)")
    elif hours_active_pct > 0.75: score += 12; signals.append(f"Szinte folyamatos ({hours_active}/24 óra)")

    # Sleep gap (6+ egymást követő inaktív óra)
    max_gap = cur_gap = 0
    for h in list(range(24)) * 2:
        if hour_counts[h] == 0: cur_gap += 1; max_gap = max(max_gap, cur_gap)
        else: cur_gap = 0
    has_sleep_gap = max_gap >= 6
    if not has_sleep_gap and len(timestamps) > 20:
        score += 20; signals.append("Nincs sleep gap (6+ inaktív óra hiányzik)")

    # ── Inter-trade interval ──────────────────────────────────────────────────
    timestamps.sort()
    intervals = [timestamps[i] - timestamps[i-1] for i in range(1, len(timestamps))]
    median_iv = None
    timing_cv = 1.0

    if len(intervals) >= 5:
        s_ivs   = sorted(intervals)
        median_iv = s_ivs[len(s_ivs) // 2]
        mean_iv   = np.mean(intervals)
        std_iv    = np.std(intervals)
        timing_cv = std_iv / mean_iv if mean_iv > 0 else 1.0

        if   median_iv < 10:  score += 25; signals.append(f"Median interval {median_iv:.1f}s (HFT bot)")
        elif median_iv < 60:  score += 15; signals.append(f"Median interval {median_iv:.1f}s (gyors bot)")
        elif median_iv < 300: score +=  5; signals.append(f"Median interval {median_iv:.1f}s (rövid)")

        if   timing_cv < 0.3: score += 20; signals.append(f"Timing nagyon szabályos (CV={timing_cv:.2f})")
        elif timing_cv < 0.6: score += 10; signals.append(f"Timing szabályos (CV={timing_cv:.2f})")

    score = min(100, score)
    classification = (
        "BOT"          if score >= 80 else
        "LIKELY_BOT"   if score >= 60 else
        "UNCERTAIN"    if score >= 35 else
        "LIKELY_HUMAN" if score >= 15 else
        "HUMAN"
    )
    if not signals: signals.append("Nincs bot jelzés – valószínűleg humán trader")

    return BotScore(
        score=score, classification=classification, signals=signals,
        focus_ratio=round(focus_ratio, 2), hours_active=hours_active,
        median_interval_sec=round(median_iv, 1) if median_iv else None,
        timing_cv=round(timing_cv, 3), has_sleep_gap=has_sleep_gap,
    )

# ─── API ──────────────────────────────────────────────────────────────────────

def api_get(base: str, path: str, params: dict = {}, retries: int = 2) -> any:
    url = f"{base}{path}"
    for attempt in range(retries + 1):
        try:
            r = requests.get(url, params=params, timeout=10,
                             headers={"Accept": "application/json"})
            r.raise_for_status()
            return r.json()
        except requests.exceptions.RequestException as e:
            if attempt < retries:
                time.sleep(1)
            else:
                raise

def fetch_leaderboard(window: str = "7d", limit: int = 100) -> list[dict]:
    """Top wallets a Polymarket leaderboard alapján."""
    data = api_get(DATA_API, "/leaderboard", {"window": window, "limit": limit})
    if isinstance(data, list):
        return data
    return data.get("data", data.get("results", []))

def fetch_trades(address: str, limit: int = 500) -> list[Trade]:
    """Wallet trade history lekérése."""
    data = api_get(DATA_API, "/trades", {"user": address, "limit": limit})
    trades = data if isinstance(data, list) else []
    result = []
    for t in trades:
        try:
            result.append(Trade(
                market    = t.get("market") or t.get("conditionId") or "",
                side      = (t.get("side") or "").upper(),
                price     = float(t.get("price") or 0),
                size      = float(t.get("size")  or 0),
                timestamp = t.get("timestamp") or "",
                outcome   = None,
            ))
        except (ValueError, TypeError):
            continue
    return result

def fetch_activity(address: str, limit: int = 200) -> list[dict]:
    """Wallet aktivitás (redemptions stb.)"""
    data = api_get(DATA_API, "/activity", {"user": address, "limit": limit})
    return data if isinstance(data, list) else []

def fetch_market_question(condition_id: str) -> str:
    """Piac kérdés lekérése condition_id alapján."""
    try:
        data = api_get(GAMMA_API, "/markets", {"condition_id": condition_id, "limit": "1"})
        markets = data if isinstance(data, list) else data.get("markets", [])
        if markets:
            return markets[0].get("question", condition_id[:20] + "...")
    except Exception:
        pass
    return condition_id[:30] + "..."


# ─── PAYOUT RATIO + CATEGORY ANALYSIS ───────────────────────────────────────

def calc_payout_ratio(markets: dict) -> dict:
    """
    Aszimmetrikus payout ratio számítás.
    
    A poszt logikája: 27¢ belépés → 91¢ kilépés nyerésnél, -27¢ veszteségnél
    Payout ratio = avg_win / avg_loss
    Break-even win rate = 1 / (1 + payout_ratio)
    
    Ha payout ratio = 3.37 (91/27), break-even WR = 1/4.37 = 22.9%
    Aktuális WR = 51% → hatalmas edge
    """
    wins   = [m["pnl"] for m in markets.values() if m["pnl"] > 0.01]
    losses = [abs(m["pnl"]) for m in markets.values() if m["pnl"] < -0.01]
    
    avg_win  = float(np.mean(wins))   if wins   else 0.0
    avg_loss = float(np.mean(losses)) if losses else 0.01  # div/0 védelem
    
    payout_ratio   = avg_win / avg_loss if avg_loss > 0 else 0.0
    break_even_wr  = 1 / (1 + payout_ratio) if payout_ratio > 0 else 0.5
    
    return {
        "payout_ratio":  round(payout_ratio, 3),
        "avg_win":       round(avg_win, 4),
        "avg_loss":      round(avg_loss, 4),
        "break_even_wr": round(break_even_wr, 3),
        "win_count":     len(wins),
        "loss_count":    len(losses),
    }


def calc_category_stats(trades: list[Trade], activity: list[dict]) -> dict:
    """
    Category specialist elemzés.
    
    A poszt megfigyelése: a legjobb walletok egy kategóriában erősek,
    másokban pénzt veszítenek. Ha csak az erős kategóriát másolja az ember,
    a teljes edge-et kapja a veszteséges kategóriák nélkül.
    
    Kategória becslésa: market slug / question kulcsszavak alapján.
    """
    CATEGORY_KEYWORDS = {
        "crypto":    ["btc", "bitcoin", "eth", "ethereum", "crypto", "sol", "xrp",
                      "up-or-down", "15-minute", "5-minute", "price"],
        "politics":  ["president", "election", "trump", "biden", "harris", "congress",
                      "senate", "governor", "vote", "poll", "democrat", "republican"],
        "sports":    ["nba", "nfl", "mlb", "nhl", "soccer", "football", "basketball",
                      "tennis", "golf", "game", "match", "championship", "win"],
        "economics": ["fed", "rate", "gdp", "inflation", "cpi", "recession", "fomc",
                      "interest", "unemployment", "jobs"],
        "other":     [],  # fallback
    }

    def detect_category(market_slug: str) -> str:
        slug_lower = market_slug.lower()
        for cat, keywords in CATEGORY_KEYWORDS.items():
            if cat == "other":
                continue
            if any(kw in slug_lower for kw in keywords):
                return cat
        return "other"

    # Per-market PnL (trades alapján)
    market_data: dict[str, dict] = defaultdict(lambda: {"pnl": 0.0, "cat": "other"})
    for t in trades:
        mkt = t.market
        if not mkt:
            continue
        market_data[mkt]["cat"] = detect_category(mkt)
        if t.side == "BUY":
            market_data[mkt]["pnl"] -= t.price * t.size
        else:
            market_data[mkt]["pnl"] += t.price * t.size

    # Redemptions
    for act in activity:
        if act.get("type", "").upper() in ("REDEEM", "REDEMPTION"):
            mkt = act.get("market") or act.get("conditionId") or ""
            if mkt in market_data:
                market_data[mkt]["pnl"] += float(act.get("cashAmount") or act.get("cash") or 0)

    # Aggregálás kategória szerint
    cat_stats: dict[str, dict] = {}
    for mkt, data in market_data.items():
        cat = data["cat"]
        if cat not in cat_stats:
            cat_stats[cat] = {"wins": 0, "losses": 0, "pnl": 0.0, "trades": 0}
        cs = cat_stats[cat]
        cs["pnl"]    += data["pnl"]
        cs["trades"] += 1
        if data["pnl"] > 0.01:
            cs["wins"] += 1
        elif data["pnl"] < -0.01:
            cs["losses"] += 1

    # Win rate per category
    result = {}
    for cat, cs in cat_stats.items():
        closed = cs["wins"] + cs["losses"]
        result[cat] = {
            "win_rate": round(cs["wins"] / closed, 3) if closed > 0 else 0,
            "trades":   cs["trades"],
            "pnl":      round(cs["pnl"], 2),
            "wins":     cs["wins"],
            "losses":   cs["losses"],
        }

    return result

# ─── ANALYTICS ────────────────────────────────────────────────────────────────

def calc_sharpe(pnl_series: list[float], annualize: bool = False) -> float:
    """Sharpe ratio a PnL sorozatból."""
    if len(pnl_series) < 3:
        return 0.0
    returns = np.diff(pnl_series)
    mean    = np.mean(returns)
    std     = np.std(returns, ddof=1)
    if std == 0:
        return 0.0
    sharpe = mean / std
    if annualize:
        sharpe *= np.sqrt(len(returns))
    return float(sharpe)

def profile_wallet(address: str, name: Optional[str] = None) -> WalletProfile:
    """Teljes wallet profil számítás."""
    trades   = fetch_trades(address, limit=500)
    activity = fetch_activity(address, limit=200)

    if not trades:
        return WalletProfile(
            address=address, name=name, total_trades=0, total_volume=0,
            markets_count=0, sharpe_ratio=0, win_rate=0, avg_position_size=0,
            is_apex=False, apex_criteria={}, recent_markets=[],
        )

    # Volume
    total_volume = sum(t.price * t.size for t in trades)
    avg_pos      = total_volume / len(trades) if trades else 0

    # Piac diverzifikáció
    markets = defaultdict(lambda: {"buys": 0, "sells": 0, "pnl": 0.0})
    for t in trades:
        mkt = t.market
        if t.side == "BUY":
            markets[mkt]["buys"]  += 1
            markets[mkt]["pnl"]   -= t.price * t.size
        else:
            markets[mkt]["sells"] += 1
            markets[mkt]["pnl"]   += t.price * t.size

    # Redemptions hozzáadása PnL-hez
    for act in activity:
        if act.get("type", "").upper() in ("REDEEM", "REDEMPTION"):
            mkt = act.get("market") or act.get("conditionId") or ""
            if mkt in markets:
                markets[mkt]["pnl"] += float(act.get("cashAmount") or act.get("cash") or 0)

    pnl_series = [m["pnl"] for m in markets.values()]
    sharpe     = calc_sharpe(pnl_series)

    # Win rate (nyereséges piacok aránya)
    closed = [m for m in markets.values() if abs(m["pnl"]) > 0.01]
    wins   = sum(1 for m in closed if m["pnl"] > 0)
    win_rate = wins / len(closed) if closed else 0.0

    # Recent markets
    recent = [t.market for t in sorted(trades, key=lambda x: x.timestamp, reverse=True)[:5]]
    recent_unique = list(dict.fromkeys(recent))

    # Payout ratio számítás
    payout = calc_payout_ratio(markets)
    pr     = payout["payout_ratio"]

    # Category specialist
    cat_stats    = calc_category_stats(trades, activity)
    best_cat     = max(cat_stats, key=lambda c: cat_stats[c]["win_rate"]) if cat_stats else ""
    best_cat_wr  = cat_stats[best_cat]["win_rate"] if best_cat else 0.0

    apex_criteria = {
        "sharpe_ok":    sharpe > APEX_MIN_SHARPE,
        "winrate_ok":   win_rate > APEX_MIN_WINRATE,
        "volume_ok":    len(trades) >= APEX_MIN_TRADES,
        "payout_ok":    pr >= APEX_MIN_PAYOUT,   # ÚJ: 3:1 payout ratio
    }
    is_apex = all(apex_criteria.values())

    time_act = analyze_time_activity(trades)
    bot      = detect_bot(trades)

    return WalletProfile(
        address           = address,
        name              = name,
        total_trades      = len(trades),
        total_volume      = round(total_volume, 2),
        markets_count     = len(markets),
        sharpe_ratio      = round(sharpe, 3),
        win_rate          = round(win_rate, 3),
        avg_position_size = round(avg_pos, 2),
        is_apex           = is_apex,
        apex_criteria     = apex_criteria,
        recent_markets    = recent_unique,
        payout_ratio      = pr,
        avg_win           = payout["avg_win"],
        avg_loss          = payout["avg_loss"],
        break_even_wr     = payout["break_even_wr"],
        category_stats    = cat_stats,
        best_category     = best_cat,
        best_cat_wr       = best_cat_wr,
    ), time_act, bot

# ─── CONSENSUS DETECTION ─────────────────────────────────────────────────────

def detect_consensus(apex_wallets: list[str], min_apex: int = APEX_CONSENSUS_N) -> list[ConsensusSignal]:
    """
    Keres olyan piacokat ahol min. N apex wallet aktív ugyanolyan irányban.
    """
    market_activity: dict[str, dict] = defaultdict(lambda: {
        "wallets": [], "sides": [], "prices": []
    })

    for addr in apex_wallets:
        try:
            trades = fetch_trades(addr, limit=30)  # csak legutóbbi 30
            for t in trades:
                if not t.market:
                    continue
                market_activity[t.market]["wallets"].append(addr)
                market_activity[t.market]["sides"].append(t.side)
                market_activity[t.market]["prices"].append(t.price)
            time.sleep(0.15)  # rate limit kímélése
        except Exception as e:
            print(f"  [WARN] {addr[:10]}...: {e}")

    signals: list[ConsensusSignal] = []
    for market, data in market_activity.items():
        unique_wallets = list(set(data["wallets"]))
        if len(unique_wallets) < min_apex:
            continue

        buys  = data["sides"].count("BUY")
        sells = data["sides"].count("SELL")
        dominant      = "BUY" if buys >= sells else "SELL"
        dominant_count = max(buys, sells)

        if dominant_count < min_apex:
            continue

        avg_price  = np.mean(data["prices"]) if data["prices"] else 0
        confidence = dominant_count / len(data["sides"]) if data["sides"] else 0

        signals.append(ConsensusSignal(
            market          = market,
            market_question = fetch_market_question(market),
            dominant_side   = dominant,
            apex_count      = dominant_count,
            total_apex      = len(unique_wallets),
            confidence      = round(confidence, 2),
            avg_price       = round(avg_price, 4),
            wallets         = unique_wallets[:3],  # csak első 3 publikusan
        ))

    return sorted(signals, key=lambda s: s.apex_count, reverse=True)

# ─── CLAUDE ELEMZÉS ──────────────────────────────────────────────────────────

def claude_analyze(signals: list[ConsensusSignal], apex_count: int) -> str:
    """Claude API hívás a consensus jelzések összefoglalásához."""
    try:
        import urllib.request
        context = {
            "apex_wallets_analyzed": apex_count,
            "consensus_signals":     [asdict(s) for s in signals[:5]],
            "timestamp":             time.strftime("%Y-%m-%d %H:%M UTC"),
        }
        prompt = f"""You are a prediction market analyst. Here are consensus signals from apex traders (Sharpe > 2.0, win rate > 60%) on Polymarket:

{json.dumps(context, indent=2)}

For each signal, provide:
1. Signal strength assessment (1-10)
2. Key risk factors
3. Recommended position size (% of bankroll, using quarter-Kelly logic)
4. One-sentence rationale

Keep response concise, factual, no hype. Format as JSON array."""

        body = json.dumps({
            "model": "claude-sonnet-4-20250514",
            "max_tokens": 800,
            "messages": [{"role": "user", "content": prompt}],
        }).encode()

        req = urllib.request.Request(
            "https://api.anthropic.com/v1/messages",
            data=body,
            headers={
                "Content-Type": "application/json",
                "anthropic-version": "2023-06-01",
            }
        )
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read())
            return data["content"][0]["text"]
    except Exception as e:
        return f"Claude elemzés nem elérhető: {e}"

# ─── DEMO ─────────────────────────────────────────────────────────────────────

def run_demo():
    """Szintetikus adat demo."""
    print("\n[DEMO MODE – szintetikus adatok]")
    profiles = [
        WalletProfile("0xABCD...1234", "WhaleX",    342, 128400, 18, 2.84, 0.71, 375, True,
                      {"sharpe_ok": True, "winrate_ok": True, "volume_ok": True, "payout_ok": True},
                      ["fed-rates", "btc-q2"],
                      payout_ratio=3.37, avg_win=0.091, avg_loss=0.027,
                      break_even_wr=0.229,
                      category_stats={
                          "crypto":    {"win_rate": 0.91, "trades": 210, "pnl": 8420, "wins": 191, "losses": 19},
                          "politics":  {"win_rate": 0.14, "trades": 87,  "pnl": -1240, "wins": 12, "losses": 75},
                          "economics": {"win_rate": 0.55, "trades": 45,  "pnl": 310,  "wins": 25, "losses": 20},
                      },
                      best_category="crypto", best_cat_wr=0.91),
        WalletProfile("0xEF01...5678", None,         87,  34200,  9, 1.92, 0.63, 393, False,
                      {"sharpe_ok": False, "winrate_ok": True, "volume_ok": True, "payout_ok": False},
                      ["election-2025"],
                      payout_ratio=1.42, avg_win=0.048, avg_loss=0.034,
                      break_even_wr=0.413,
                      category_stats={
                          "politics": {"win_rate": 0.63, "trades": 87, "pnl": 1840, "wins": 55, "losses": 32},
                      },
                      best_category="politics", best_cat_wr=0.63),
        WalletProfile("0xGH23...9012", "CryptoSage", 219,  89100, 14, 3.21, 0.74, 406, True,
                      {"sharpe_ok": True, "winrate_ok": True, "volume_ok": True, "payout_ok": True},
                      ["fed-rates", "sp500-q3"],
                      payout_ratio=4.12, avg_win=0.103, avg_loss=0.025,
                      break_even_wr=0.196,
                      category_stats={
                          "crypto":    {"win_rate": 0.74, "trades": 148, "pnl": 6210, "wins": 109, "losses": 39},
                          "economics": {"win_rate": 0.68, "trades": 71,  "pnl": 2880, "wins": 48, "losses": 23},
                          "sports":    {"win_rate": 0.22, "trades": 18,  "pnl": -890, "wins": 4, "losses": 14},
                      },
                      best_category="crypto", best_cat_wr=0.74),
    ]
    signals = [
        ConsensusSignal("fed-rates-hold-may",    "Will Fed hold rates in May 2025?",    "BUY",  2, 2, 1.0,  0.72, ["0xABCD...1234", "0xGH23...9012"]),
        ConsensusSignal("btc-100k-q2-2025",      "Will BTC exceed $100k by Q2 2025?",   "SELL", 2, 2, 1.0,  0.38, ["0xABCD...1234", "0xGH23...9012"]),
    ]
    print_results(profiles, signals)

# ─── PRINT ────────────────────────────────────────────────────────────────────

def print_results(profiles: list[WalletProfile], signals: list[ConsensusSignal]):
    apex = [p for p in profiles if p.is_apex]
    non_apex = [p for p in profiles if not p.is_apex]

    print(f"\n{'═'*65}")
    print(f"  APEX WALLET PROFILER")
    print(f"  {time.strftime('%Y-%m-%d %H:%M UTC')}  |  {len(profiles)} wallet elemezve")
    print(f"{'═'*65}")

    print(f"\n{'─'*65}")
    print(f"  APEX WALLETOK ({len(apex)} / {len(profiles)} – {len(apex)/max(len(profiles),1)*100:.1f}%)")
    print(f"  Kritérium: Sharpe > {APEX_MIN_SHARPE}, Win rate > {APEX_MIN_WINRATE*100:.0f}%, min. {APEX_MIN_TRADES} trade")
    print('─'*65)
    print(f"  {'Wallet':<16} {'Name':<12} {'Sharpe':>7} {'WR':>6} {'Payout':>7} {'B/E WR':>7} {'Best Cat':<10} {'Trades':>7}")
    print("  " + "─" * 80)
    for p in sorted(apex, key=lambda x: x.payout_ratio, reverse=True):
        addr    = p.address[:14] + ".."
        name    = (p.name or "—")[:10]
        cat_str = f"{p.best_category[:8]}({p.best_cat_wr*100:.0f}%)" if p.best_category else "—"
        pr_flag = " 🎯" if p.payout_ratio >= 3.0 else ""
        print(f"  {addr:<16} {name:<12} {p.sharpe_ratio:>7.3f} {p.win_rate*100:>5.1f}% "
              f"{p.payout_ratio:>6.2f}x{pr_flag} {p.break_even_wr*100:>5.1f}%  "
              f"{cat_str:<14} {p.total_trades:>7,}")

    if non_apex:
        print(f"\n  NON-APEX ({len(non_apex)}):")
        for p in non_apex[:3]:
            addr  = p.address[:14] + ".."
            missing = [k.replace("_ok","") for k, v in p.apex_criteria.items() if not v]
            print(f"  {addr} – hiányzik: {', '.join(missing)}")

    print(f"\n{'─'*65}")
    print(f"  CONSENSUS JELZÉSEK ({len(signals)})")
    print('─'*65)
    # Payout ratio összefoglaló
    if apex:
        print(f"\n{'─'*65}")
        print("  PAYOUT RATIO ELEMZÉS (aszimmetria)")
        print('─'*65)
        print(f"  {'Wallet':<18} {'Payout':>8} {'Avg Win':>9} {'Avg Loss':>9} {'B/E WR':>8} {'Edge'}")
        print("  " + "─" * 65)
        for p in sorted(apex, key=lambda x: x.payout_ratio, reverse=True):
            addr   = p.address[:16] + ".."
            actual_edge = p.win_rate - p.break_even_wr
            flag   = "  🎯 ERŐS" if p.payout_ratio >= 3.0 and actual_edge > 0.2 else ""
            print(f"  {addr:<18} {p.payout_ratio:>7.2f}x  "
                  f"${p.avg_win*100:>6.1f}¢  ${p.avg_loss*100:>6.1f}¢  "
                  f"{p.break_even_wr*100:>5.1f}%  {actual_edge*100:>+.1f}%{flag}")
        print(f"\n  Logika: Ha payout=3.37x → break-even WR=22.9%")
        print(f"  Ha a wallet 51%-ot nyer → edge = +28.1% minden trade-en")

    # Category specialist breakdown
    if apex:
        print(f"\n{'─'*65}")
        print("  CATEGORY SPECIALIST TÉRKÉP")
        print('─'*65)
        print(f"  Csak az erős kategóriát másolva: kizárod a veszteséges kategóriákat")
        for p in sorted(apex, key=lambda x: x.payout_ratio, reverse=True):
            addr = p.address[:14] + ".."
            print(f"\n  {addr} ({p.name or 'N/A'}):")
            if p.category_stats:
                for cat, cs in sorted(p.category_stats.items(),
                                       key=lambda x: x[1]["win_rate"], reverse=True):
                    wr   = cs["win_rate"] * 100
                    pnl  = cs["pnl"]
                    flag = " ✓ COPY" if wr >= 65 and cs["trades"] >= 10 else                            " ✗ SKIP" if wr < 40 else ""
                    bar  = "█" * int(wr/10) + "░" * (10 - int(wr/10))
                    print(f"    {cat:<10} [{bar}] {wr:5.1f}%  "
                          f"${pnl:>+8,.0f}  {cs['trades']:>4} trade{flag}")

    if not signals:
        print("  ⚪ Nincs consensus – az apex walletok különböző piacokban aktívak")
    else:
        for i, s in enumerate(signals, 1):
            side_emoji = "📈" if s.dominant_side == "BUY" else "📉"
            print(f"\n  [{i}] {side_emoji} {s.dominant_side}  (conf: {s.confidence:.0%})")
            print(f"      {s.market_question[:60]}")
            print(f"      Apex wallets: {s.apex_count}/{s.total_apex}  |  Avg price: {s.avg_price:.4f}")

            # Quarter-Kelly javaslat (naïv, p = confidence)
            p_win  = s.confidence
            payoff = (1 / s.avg_price) - 1 if s.dominant_side == "BUY" else (1 / (1 - s.avg_price)) - 1
            kelly  = max(0, (p_win * payoff - (1 - p_win)) / payoff)
            qkelly = kelly * 0.25
            print(f"      ¼-Kelly pozíció: {qkelly*100:.1f}% bankroll")


    # Időalapú minták
    all_time = {}
    for p in profiles:
        if hasattr(p, '_time_act'):
            for sess, cnt in p._time_act.get('session_breakdown', {}).items():
                all_time[sess] = all_time.get(sess, 0) + cnt

    if all_time:
        total_t = max(sum(all_time.values()), 1)
        print(f"\n{'─'*65}")
        print("  IDŐALAPÚ AKTIVITÁS (apex wallets összesített)")
        print('─'*65)
        labels = {
            'low_liquidity': '4AM ET (Low Liq)  UTC 07-10',
            'london':        'London Open       UTC 06-09',
            'ny_open':       'NY Open           UTC 13-17',
            'ny_close':      'NY Close          UTC 20-23',
            'asian':         'Asian Session     UTC 23-06',
        }
        for sess, cnt in sorted(all_time.items(), key=lambda x: -x[1]):
            pct  = cnt / total_t * 100
            bar  = '█' * int(pct / 3) + '░' * (20 - int(pct / 3))
            flag = ' ← LOW LIQ WINDOW' if sess == 'low_liquidity' and pct > 20 else ''
            print(f"  {labels.get(sess, sess):<30} [{bar}] {pct:5.1f}%{flag}")

    print()

# ─── MAIN ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Polymarket Apex Wallet Profiler")
    parser.add_argument("--demo",        action="store_true")
    parser.add_argument("--leaderboard", action="store_true", help="Top wallets listázása")
    parser.add_argument("--consensus",   action="store_true", help="Apex consensus detection")
    parser.add_argument("--profile",     metavar="ADDRESS", help="Egy wallet profilozása")
    parser.add_argument("--window",      default="7d", choices=["1d","7d","30d","all"])
    parser.add_argument("--min-sharpe",  type=float, default=2.0)
    parser.add_argument("--min-winrate", type=float, default=0.60)
    parser.add_argument("--min-trades",  type=int,   default=20)
    parser.add_argument("--claude",      action="store_true", help="Claude API elemzés")
    parser.add_argument("--json",        action="store_true")
    args = parser.parse_args()

    global APEX_MIN_SHARPE, APEX_MIN_WINRATE, APEX_MIN_TRADES
    APEX_MIN_SHARPE  = args.min_sharpe
    APEX_MIN_WINRATE = args.min_winrate
    APEX_MIN_TRADES  = args.min_trades

    if args.demo:
        run_demo(); return

    if args.profile:
        print(f"[INFO] Profil: {args.profile[:20]}...")
        try:
            p = profile_wallet(args.profile)
            if args.json:
                print(json.dumps(asdict(p), indent=2))
            else:
                print_results([p], [])
        except Exception as e:
            print(f"[ERROR] {e}")
        return

    if args.leaderboard or args.consensus:
        print(f"[INFO] Leaderboard lekérése (window={args.window})...")
        try:
            lb = fetch_leaderboard(args.window, 50)
        except Exception as e:
            print(f"[ERROR] Leaderboard: {e}"); sys.exit(1)

        if args.leaderboard:
            print(f"\nTop {min(20, len(lb))} wallet ({args.window}):")
            print(f"  {'Rank':>4}  {'Address':<20}  {'PnL':>10}  {'Volume':>12}  {'Trades':>7}")
            print("  " + "─" * 58)
            for i, w in enumerate(lb[:20], 1):
                addr   = (w.get("proxyWalletAddress") or w.get("address") or w.get("user") or "")[:18]
                pnl    = float(w.get("pnl") or w.get("profit") or 0)
                vol    = float(w.get("volume") or 0)
                trades = int(w.get("tradesCount") or w.get("trades") or 0)
                print(f"  {i:>4}  {addr:<20}  ${pnl:>9,.2f}  ${vol:>11,.0f}  {trades:>7,}")

        if args.consensus:
            print(f"\n[INFO] Apex szűrés + consensus detection (top 20 wallet)...")
            addresses = [
                w.get("proxyWalletAddress") or w.get("address") or w.get("user")
                for w in lb[:20] if w.get("proxyWalletAddress") or w.get("address") or w.get("user")
            ]

            # Profil minden walletnek (rate limiting miatt max 10)
            profiles: list[WalletProfile] = []
            for i, addr in enumerate(addresses[:10], 1):
                print(f"  [{i}/10] Profil: {addr[:16]}...", end="\r")
                try:
                    p = profile_wallet(addr, name=None)
                    profiles.append(p)
                    time.sleep(0.2)
                except Exception:
                    pass
            print()

            apex_wallets = [p.address for p in profiles if p.is_apex]
            print(f"[INFO] Apex walletok: {len(apex_wallets)} / {len(profiles)}")

            if not apex_wallets:
                # Fallback: top 5 PnL alapján
                apex_wallets = addresses[:5]
                print("[INFO] Fallback: top 5 PnL-alapú wallet")

            print(f"[INFO] Consensus keresés {len(apex_wallets)} wallet alapján...")
            signals = detect_consensus(apex_wallets, min_apex=2)

            if args.claude and signals:
                print("[INFO] Claude elemzés...")
                analysis = claude_analyze(signals, len(apex_wallets))
                print(f"\nCLAUDE ELEMZÉS:\n{analysis}\n")

            if args.json:
                print(json.dumps({
                    "apex_wallets": len(apex_wallets),
                    "profiles":     [asdict(p) for p in profiles],
                    "consensus":    [asdict(s) for s in signals],
                }, indent=2))
            else:
                print_results(profiles, signals)
        return

    # Default
    parser.print_help()

if __name__ == "__main__":
    main()
