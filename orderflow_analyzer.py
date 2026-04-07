#!/usr/bin/env python3
"""
orderflow_analyzer.py
---------------------
Lokálisan futtatható order flow elemző script.
Lekéri a Polymarket CLOB trade history-t és kiszámolja:
  - Kyle's Lambda (price impact)
  - VPIN (Volume-synchronized Probability of Informed Trading)
  - Hawkes branching ratio (MLE)
  - Avellaneda-Stoikov optimális spread

Futtatás:
  pip install numpy scipy requests
  python orderflow_analyzer.py --token-id <token_id>
  python orderflow_analyzer.py --token-id <token_id> --limit 500 --plot
"""

import argparse
import json
import sys
import time
from dataclasses import dataclass, field
from typing import Optional

import numpy as np
import requests
from scipy.optimize import minimize
from scipy.stats import linregress

# ─── Konfig ───────────────────────────────────────────────────────────────────
CLOB_HOST  = "https://clob.polymarket.com"
GAMMA_HOST = "https://gamma-api.polymarket.com"

# ─── 1. KYLE'S LAMBDA ─────────────────────────────────────────────────────────

def estimate_kyle_lambda(prices: np.ndarray, volumes: np.ndarray,
                          signs: np.ndarray) -> dict:
    """
    OLS regresszió: Δp_t = λ * Q_t + ε
    Q_t = signed volume (+ buy, - sell)
    """
    signed_vol   = volumes * signs
    price_changes = np.diff(prices)
    mask = price_changes != 0
    x, y = signed_vol[1:][mask], price_changes[mask]

    if len(x) < 10:
        return {"error": "Insufficient data (< 10 non-zero changes)"}

    slope, intercept, r, p_val, se = linregress(x, y)

    level = ("🔴 HIGH  – informed traders active, widen spread significantly"
             if slope > 0.002 else
             "🟡 MODERATE – some informed flow, moderate spread widening"
             if slope > 0.001 else
             "🟢 LOW   – normal liquidity, standard spread")

    return {
        "lambda":      float(slope),
        "r_squared":   float(max(0, r**2)),
        "p_value":     float(p_val),
        "std_error":   float(se),
        "n_obs":       int(len(x)),
        "level":       level,
        "danger":      slope > 0.002,
    }

# ─── 2. VPIN ──────────────────────────────────────────────────────────────────

def compute_vpin(buy_vols: np.ndarray, sell_vols: np.ndarray,
                 bucket_size: int = 50) -> dict:
    """
    VPIN = |V_buy - V_sell| / (V_buy + V_sell)  per bucket
    Threshold: > 0.65 widen, > 0.80 pull quotes.
    """
    n_buckets = len(buy_vols) // bucket_size
    if n_buckets < 2:
        return {"error": f"Need at least {bucket_size*2} trades for VPIN"}

    vpins = []
    for i in range(n_buckets):
        s, e = i * bucket_size, (i + 1) * bucket_size
        vb, vs = buy_vols[s:e].sum(), sell_vols[s:e].sum()
        total = vb + vs
        if total > 0:
            vpins.append(abs(vb - vs) / total)

    vpins = np.array(vpins)
    current = vpins[-1]
    avg     = vpins.mean()

    signal = ("🚨 PULL_QUOTES  – VPIN > 0.80, informed flow dominant" if current > 0.80 else
              "🔴 WIDEN_SPREAD – VPIN > 0.65, elevated toxicity"       if current > 0.65 else
              "🟡 CAUTION      – VPIN > 0.40, above normal"            if current > 0.40 else
              "🟢 NORMAL       – healthy order flow")

    return {
        "current":      float(current),
        "average":      float(avg),
        "max":          float(vpins.max()),
        "history":      vpins[-10:].tolist(),
        "signal":       signal,
        "pull_quotes":  current > 0.80,
        "danger":       current > 0.65,
        "bucket_size":  bucket_size,
        "n_buckets":    int(n_buckets),
    }

# ─── 3. HAWKES PROCESS MLE ────────────────────────────────────────────────────

def hawkes_neg_log_likelihood(params, event_times: np.ndarray, T: float) -> float:
    mu, alpha, beta = params
    if mu <= 0 or alpha <= 0 or beta <= 0 or alpha >= beta:
        return 1e10
    n = len(event_times)
    # Rekurzív R számítás O(n)
    R = np.zeros(n)
    for i in range(1, n):
        R[i] = np.exp(-beta * (event_times[i] - event_times[i-1])) * (1 + R[i-1])
    integral = mu * T + (alpha / beta) * np.sum(1 - np.exp(-beta * (T - event_times)))
    log_sum  = np.sum(np.log(np.maximum(mu + alpha * R, 1e-10)))
    return -(log_sum - integral)

def fit_hawkes(timestamps: np.ndarray) -> dict:
    """MLE fitting, 8 random starts."""
    if len(timestamps) < 20:
        return {"error": "Need at least 20 trades for Hawkes fitting"}

    t0 = timestamps[0]
    ts = timestamps - t0
    T  = ts[-1]

    best_result, best_ll = None, np.inf
    np.random.seed(42)
    for _ in range(8):
        x0 = [np.random.uniform(0.1, 3.0),
              np.random.uniform(0.1, 0.7),
              np.random.uniform(1.0, 6.0)]
        try:
            res = minimize(hawkes_neg_log_likelihood, x0,
                           args=(ts, T), method="Nelder-Mead",
                           options={"xatol": 1e-6, "fatol": 1e-6, "maxiter": 5000})
            if res.fun < best_ll:
                best_ll, best_result = res.fun, res
        except Exception:
            continue

    if best_result is None:
        return {"error": "Optimization failed"}

    mu, alpha, beta = best_result.x
    br = alpha / beta

    return {
        "mu":             float(mu),
        "alpha":          float(alpha),
        "beta":           float(beta),
        "branching_ratio": float(br),
        "avg_intensity":  float(mu / max(1 - br, 1e-6)),
        "log_likelihood": float(-best_ll),
        "interpretation": (
            f"🔴 {br*100:.0f}% of trades triggered by prior trades – market running HOT"
            if br > 0.75 else
            f"🟡 {br*100:.0f}% self-excited – moderate clustering"
            if br > 0.5 else
            f"🟢 {br*100:.0f}% self-excited – normal exogenous flow"
        ),
        "danger": br > 0.75,
    }

# ─── 4. AVELLANEDA-STOIKOV QUOTING ────────────────────────────────────────────

@dataclass
class ASParams:
    gamma: float = 0.10   # risk aversion
    kappa: float = 1.50   # execution intensity
    sigma: float = 0.05   # volatility
    T:     float = 24.0   # horizon (hours)

def as_quote(mid: float, inventory: float, time_remaining: float,
             p: ASParams, kyle_lambda: float = 0.001) -> dict:
    """
    Avellaneda-Stoikov optimális bid/ask számítás.
    kyle_lambda: price impact – szélesíti a spreadet ha magas.
    """
    # Reservation price
    r = mid - inventory * p.gamma * p.sigma**2 * time_remaining

    # Optimális half-spread
    half_spread = (p.gamma * p.sigma**2 * time_remaining / 2 +
                   (1 / p.gamma) * np.log(1 + p.gamma / p.kappa))

    # Kyle lambda hatása: ha high informed flow, szélesítünk
    lambda_adj = 1 + 50 * kyle_lambda  # 0.002 lambda → 10% szélesítés
    half_spread *= lambda_adj

    bid = np.clip(r - half_spread, 0.01, 0.98)
    ask = np.clip(r + half_spread, 0.02, 0.99)
    ask = max(ask, bid + 0.01)

    return {
        "reservation_price": round(r, 4),
        "bid":               round(bid, 4),
        "ask":               round(ask, 4),
        "spread":            round(ask - bid, 4),
        "half_spread":       round(half_spread, 4),
        "inventory_skew":    round(mid - r, 4),
    }

# ─── 5. ÖSSZESÍTETT KERESKEDÉSI AJÁNLÁS ──────────────────────────────────────

def trading_recommendation(kyle: dict, vpin: dict, hawkes: dict,
                             mid: float, inventory: float = 0) -> dict:
    """Összesített döntési logika."""
    pull  = vpin.get("pull_quotes", False)
    widen = vpin.get("danger", False) or kyle.get("danger", False)
    hot   = hawkes.get("danger", False)

    if pull:
        action = "🚫 NE KERESKEDJ – húzd vissza az ajánlatokat (VPIN kritikus)"
        color  = "RED"
    elif widen:
        action = "⚠️  SZÉLESÍTSD a spreadet – informed flow detektálva"
        color  = "ORANGE"
    elif hot:
        action = "⚡ MOMENTUM – klaszteres flow, trend követés lehetséges"
        color  = "YELLOW"
    else:
        action = "✅ NORMÁL piac – standard spread megfelelő"
        color  = "GREEN"

    # AS quoting
    p = ASParams()
    kl = kyle.get("lambda", 0.001)
    quotes = as_quote(mid, inventory, p.T / 2, p, kl)

    return {
        "action":  action,
        "color":   color,
        "quotes":  quotes,
        "summary": {
            "kyle_danger":  kyle.get("danger", False),
            "vpin_danger":  vpin.get("danger", False),
            "hawkes_danger": hawkes.get("danger", False),
            "overall_risk": "HIGH" if (pull or widen) else "MEDIUM" if hot else "LOW",
        }
    }

# ─── CLOB API HÍVÁSOK ─────────────────────────────────────────────────────────

def fetch_trades(token_id: str, limit: int = 200) -> list:
    url = f"{CLOB_HOST}/trades?market={token_id}&limit={limit}"
    r   = requests.get(url, timeout=10, headers={"Accept": "application/json"})
    r.raise_for_status()
    data = r.json()
    return data if isinstance(data, list) else data.get("data", data.get("trades", []))

def fetch_mid(token_id: str) -> float:
    try:
        r = requests.get(f"{CLOB_HOST}/midpoint?token_id={token_id}", timeout=5)
        return float(r.json().get("mid", 0.5))
    except Exception:
        return 0.5

def fetch_markets(limit: int = 20) -> list:
    r = requests.get(
        f"{GAMMA_HOST}/markets",
        params={"active": "true", "closed": "false",
                "limit": limit, "order": "volume24hr", "ascending": "false"},
        timeout=10
    )
    r.raise_for_status()
    data = r.json()
    return data if isinstance(data, list) else data.get("markets", [])

# ─── PARSE TRADES ─────────────────────────────────────────────────────────────

def parse_trades(trades: list) -> dict:
    prices, volumes, sides, buy_vols, sell_vols, timestamps = [], [], [], [], [], []
    for t in trades:
        p    = float(t.get("price") or t.get("tradePrice") or 0)
        size = float(t.get("size")  or t.get("amount") or 0)
        side_str = (t.get("side") or t.get("makerSide") or "").upper()
        side = 1 if side_str == "BUY" else -1
        ts   = t.get("timestamp", "")
        if p > 0 and size > 0:
            prices.append(p); volumes.append(size); sides.append(side)
            buy_vols.append(size if side == 1 else 0)
            sell_vols.append(size if side == -1 else 0)
            if ts:
                try:
                    from datetime import datetime
                    timestamps.append(datetime.fromisoformat(ts.replace("Z","")).timestamp())
                except Exception:
                    pass
    return {
        "prices":     np.array(prices),
        "volumes":    np.array(volumes),
        "sides":      np.array(sides),
        "buy_vols":   np.array(buy_vols),
        "sell_vols":  np.array(sell_vols),
        "timestamps": np.array(timestamps) if timestamps else None,
    }

# ─── PRINT HELPERS ────────────────────────────────────────────────────────────

def section(title: str):
    print(f"\n{'─'*55}")
    print(f"  {title}")
    print('─'*55)

def print_results(mid: float, n: int, kyle: dict, vpin: dict, hawkes: dict, rec: dict):
    print(f"\n{'═'*55}")
    print(f"  ORDER FLOW ANALYSIS")
    print(f"  Mid price: {mid:.4f} ({mid*100:.1f}¢) | Trades: {n}")
    print(f"{'═'*55}")

    section("KYLE'S LAMBDA – Price Impact")
    if "error" in kyle:
        print(f"  ⚠ {kyle['error']}")
    else:
        print(f"  λ = {kyle['lambda']:.6f}")
        print(f"  R² = {kyle['r_squared']:.4f}  (>0.15 = informed flow active)")
        print(f"  {kyle['level']}")

    section("VPIN – Order Flow Toxicity")
    if "error" in vpin:
        print(f"  ⚠ {vpin['error']}")
    else:
        bar = "█" * int(vpin['current'] * 20) + "░" * (20 - int(vpin['current'] * 20))
        print(f"  Current: {vpin['current']:.3f}  [{bar}]")
        print(f"  Average: {vpin['average']:.3f}  |  Max: {vpin['max']:.3f}")
        print(f"  {vpin['signal']}")

    section("HAWKES – Order Flow Clustering")
    if hawkes is None:
        print("  ⚠ No timestamp data available")
    elif "error" in hawkes:
        print(f"  ⚠ {hawkes['error']}")
    else:
        print(f"  μ (baseline) = {hawkes['mu']:.4f} trades/sec")
        print(f"  α (excitation) = {hawkes['alpha']:.4f}")
        print(f"  β (decay) = {hawkes['beta']:.4f}")
        print(f"  Branching ratio = {hawkes['branching_ratio']:.3f}")
        print(f"  {hawkes['interpretation']}")

    section("AVELLANEDA-STOIKOV QUOTING")
    q = rec["quotes"]
    print(f"  Reservation price: {q['reservation_price']:.4f}")
    print(f"  Bid:  {q['bid']:.4f}  ({q['bid']*100:.1f}¢)")
    print(f"  Ask:  {q['ask']:.4f}  ({q['ask']*100:.1f}¢)")
    print(f"  Spread: {q['spread']*100:.2f}¢  (half: {q['half_spread']*100:.2f}¢)")
    print(f"  Inventory skew: {q['inventory_skew']:+.4f}")

    section("RECOMMENDATION")
    print(f"  {rec['action']}")
    risk = rec['summary']['overall_risk']
    color = {"HIGH": "🔴", "MEDIUM": "🟡", "LOW": "🟢"}.get(risk, "")
    print(f"  Overall risk: {color} {risk}")
    print()

# ─── DEMO MODE (valódi API nélkül) ────────────────────────────────────────────

def run_demo():
    print("\n[DEMO MODE – szintetikus adatok]")
    np.random.seed(42)
    N = 300
    prices = [0.50]
    signs_list, vols_list, buy_v, sell_v, ts_list = [], [], [], [], []
    t = 0.0
    for _ in range(N):
        sign = np.random.choice([-1, 1], p=[0.45, 0.55])
        vol  = np.random.exponential(300)
        dp   = 0.0015 * sign * vol / 1000 + np.random.normal(0, 0.004)
        prices.append(np.clip(prices[-1] + dp, 0.01, 0.99))
        signs_list.append(sign); vols_list.append(vol)
        buy_v.append(vol if sign == 1 else 0)
        sell_v.append(vol if sign == -1 else 0)
        t += np.random.exponential(30)
        ts_list.append(t)
    mid = prices[-1]
    kyle   = estimate_kyle_lambda(np.array(prices), np.array(vols_list), np.array(signs_list))
    vpin   = compute_vpin(np.array(buy_v), np.array(sell_v), 30)
    hawkes = fit_hawkes(np.array(ts_list))
    rec    = trading_recommendation(kyle, vpin, hawkes, mid)
    print_results(mid, N, kyle, vpin, hawkes, rec)

# ─── MAIN ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Polymarket Order Flow Analyzer")
    parser.add_argument("--token-id", help="CLOB token ID")
    parser.add_argument("--limit",    type=int, default=200, help="Trade history limit (max 500)")
    parser.add_argument("--inventory",type=float, default=0, help="Current inventory in USD")
    parser.add_argument("--demo",     action="store_true", help="Run with synthetic data")
    parser.add_argument("--json",     action="store_true", help="Output JSON instead of text")
    parser.add_argument("--list-markets", action="store_true", help="List top markets with token IDs")
    args = parser.parse_args()

    if args.demo:
        run_demo(); return

    if args.list_markets:
        print("\nTop Polymarket piacok:")
        markets = fetch_markets(15)
        for m in markets:
            tokens = m.get("tokens", [])
            print(f"\n  {m.get('question','')[:60]}")
            for t in tokens:
                print(f"    [{t.get('outcome','?')}] token_id: {t.get('token_id','')}")
        return

    if not args.token_id:
        print("Használat: python orderflow_analyzer.py --token-id <id>")
        print("           python orderflow_analyzer.py --demo")
        print("           python orderflow_analyzer.py --list-markets")
        sys.exit(1)

    print(f"[INFO] Trades lekérése: {args.token_id[:30]}...")
    trades = fetch_trades(args.token_id, min(500, args.limit))
    mid    = fetch_mid(args.token_id)
    print(f"[INFO] {len(trades)} trade, mid: {mid:.4f}")

    if not trades:
        print("[ERROR] Nincs trade adat"); sys.exit(1)

    parsed = parse_trades(trades)
    kyle   = estimate_kyle_lambda(parsed["prices"], parsed["volumes"], parsed["sides"])
    vpin   = compute_vpin(parsed["buy_vols"], parsed["sell_vols"], 30)
    hawkes = fit_hawkes(parsed["timestamps"]) if parsed["timestamps"] is not None else None
    rec    = trading_recommendation(kyle, vpin, hawkes or {}, mid, args.inventory)

    if args.json:
        print(json.dumps({"kyle": kyle, "vpin": vpin, "hawkes": hawkes, "recommendation": rec}, indent=2))
    else:
        print_results(mid, len(parsed["prices"]), kyle, vpin, hawkes, rec)

if __name__ == "__main__":
    main()
