#!/usr/bin/env python3
"""
vol_divergence.py
-----------------
BTC Volatility Harvester – Implied vs Realized Vol elemző

Lekéri:
  1. Binance 1m klines → realized vol (több ablak)
  2. Polymarket BTC UP/DOWN kontraktok → implied vol + locked profit

Futtatás:
  pip install numpy requests
  python vol_divergence.py                    # teljes elemzés
  python vol_divergence.py --demo             # szintetikus adat
  python vol_divergence.py --watch            # folyamatos figyelés (2 perc/frissítés)
  python vol_divergence.py --json             # JSON output
"""

import argparse
import json
import math
import sys
import time
from datetime import datetime

import numpy as np
import requests

# ─── Konfig ───────────────────────────────────────────────────────────────────
BINANCE_API   = "https://api.binance.com"
GAMMA_API     = "https://gamma-api.polymarket.com"
CLOB_API      = "https://clob.polymarket.com"
POLYMARKET_FEE = 0.02   # ~2% taker fee/oldal (konzervatív)

# ─── 1. REALIZED VOLATILITY ───────────────────────────────────────────────────

def fetch_klines(symbol: str = "BTCUSDT", interval: str = "1m", limit: int = 60) -> np.ndarray:
    """Binance klines lekérése, close árak visszaadása."""
    url = f"{BINANCE_API}/api/v3/klines"
    r = requests.get(url, params={"symbol": symbol, "interval": interval, "limit": limit}, timeout=8)
    r.raise_for_status()
    return np.array([float(k[4]) for k in r.json()])  # close prices

def realized_vol(closes: np.ndarray, periods_per_year: float = 365 * 24 * 60) -> float:
    """
    Close-to-close log return vol, annualizált.
    periods_per_year: 1m klines esetén 525600 (365*24*60)
    """
    if len(closes) < 2:
        return 0.0
    log_returns = np.diff(np.log(closes))
    return float(np.std(log_returns, ddof=1) * np.sqrt(periods_per_year))

def parkinson_vol(highs: np.ndarray, lows: np.ndarray, periods_per_year: float = 365 * 24 * 60) -> float:
    """
    Parkinson volatility – high/low alapú, pontosabb close-to-close-nál.
    """
    if len(highs) < 2:
        return 0.0
    hl_ratio = np.log(highs / lows)
    var = np.mean(hl_ratio ** 2) / (4 * np.log(2))
    return float(np.sqrt(var * periods_per_year))

def fetch_realized_vols(windows: list[int] = [5, 15, 30, 60]) -> dict:
    """Több időablakra számít realized vol-t."""
    max_window = max(windows) + 5
    r = requests.get(f"{BINANCE_API}/api/v3/klines",
                     params={"symbol": "BTCUSDT", "interval": "1m", "limit": max_window},
                     timeout=8)
    r.raise_for_status()
    data = r.json()
    closes = np.array([float(k[4]) for k in data])
    highs  = np.array([float(k[2]) for k in data])
    lows   = np.array([float(k[3]) for k in data])
    current_price = closes[-1]

    result = {"current_price": current_price, "windows": {}}
    for w in windows:
        c = closes[-w:]; h = highs[-w:]; l = lows[-w:]
        result["windows"][f"{w}m"] = {
            "close_to_close": realized_vol(c),
            "parkinson":      parkinson_vol(h, l),
        }
    return result

# ─── 2. IMPLIED VOL (binary kontraktból) ─────────────────────────────────────

def implied_vol_from_binary(p: float, T_hours: float) -> float:
    """
    Naïv IV visszaszámítás binary kontraktból.
    p: YES ár (0-1), T_hours: lejáratig hátralévő idő órában
    
    Közelítés: binary ATM straddle prémium ≈ σ * √(T/2π)
    Ha p ≈ 0.5, a kontraktár ≈ 0.5 + σ * √(T/2π) * 0.5
    → σ ≈ 2 * |p - 0.5| / √(T/2π)
    """
    if p <= 0.01 or p >= 0.99 or T_hours <= 0:
        return 0.0
    T = T_hours / (365 * 24)  # évben
    dist = abs(p - 0.5)
    sigma = 2 * dist / math.sqrt(T / (2 * math.pi))
    return min(sigma, 50.0)  # cap 5000%-on

# ─── 3. POLYMARKET BTC KONTRAKTOK ────────────────────────────────────────────

def fetch_btc_markets(limit: int = 20) -> list:
    """BTC UP/DOWN kontraktok keresése a Gamma API-n."""
    try:
        r = requests.get(f"{GAMMA_API}/markets", params={
            "active": "true", "closed": "false",
            "limit": limit, "order": "volume24hr", "ascending": "false",
            "tag_slug": "crypto",
        }, timeout=8)
        r.raise_for_status()
        data = r.json()
        markets = data if isinstance(data, list) else data.get("markets", [])
        # BTC + 15m szűrés
        return [m for m in markets if
                ("btc" in (m.get("question") or "").lower() or
                 "bitcoin" in (m.get("question") or "").lower()) and
                any(x in (m.get("question") or "").lower() for x in ["15", "up", "down"])][:6]
    except Exception as e:
        print(f"  [WARN] Gamma API: {e}")
        return []

def fetch_token_mid(token_id: str) -> float:
    """CLOB midpoint lekérés."""
    try:
        r = requests.get(f"{CLOB_API}/midpoint", params={"token_id": token_id}, timeout=4)
        return float(r.json().get("mid", 0.5))
    except Exception:
        return 0.5

# ─── 4. LOCKED PROFIT KALKULÁTOR ─────────────────────────────────────────────

def locked_profit(yes_price: float, no_price: float, fee_pct: float = POLYMARKET_FEE) -> dict:
    """
    Locked profit kalkuláció fee-vel.
    
    Ha YES + NO < $1.00 (ask oldalon), akkor mindkét oldal megvásárlásával
    garantált $1.00 kapunk lejáratkor.
    
    Valódi belépési cost = ask árak, nem mid! Ez kritikus különbség.
    A spread (mid - bid) jellemzően 1-3 cent/oldal.
    """
    gross = yes_price + no_price
    # Fee mindkét oldalon
    fee_yes  = yes_price * fee_pct
    fee_no   = no_price  * fee_pct
    total_fee = fee_yes + fee_no
    net = 1.0 - gross - total_fee

    return {
        "yes_price":    yes_price,
        "no_price":     no_price,
        "gross_cost":   gross,
        "estimated_fee": total_fee,
        "net_profit":   net,
        "net_pct":      net * 100,
        "has_edge":     net > 0,
        "signal":       "🟢 STRONG_EDGE" if net > 0.03 else
                        "🟡 MARGINAL"    if net > 0    else
                        "🔴 NO_EDGE",
        "note": "⚠ Mid árak! Valódi ask általában 1-3¢ magasabb." if gross < 0.98 else ""
    }

# ─── 5. VOL SPREAD ────────────────────────────────────────────────────────────

def vol_spread_signal(iv: float, rv: float) -> dict:
    """Vol spread értelmezése és kereskedési ajánlás."""
    spread = iv - rv
    spread_pct = spread * 100

    if spread > 1.0:
        signal = "🔴 NAGYON MAGAS prémium – IV >> RV, kontraktok erősen túlárazottak"
        action = "SELL both sides (ha YES+NO > $1+fee)"
    elif spread > 0.5:
        signal = "🟠 MAGAS prémium – IV > RV, pánik árazás"
        action = "SELL both sides – vol crush várható"
    elif spread > 0.2:
        signal = "🟡 MÉRSÉKELT prémium – normál range felső határa"
        action = "CAUTION – figyeld de ne lépj be vakon"
    elif spread > -0.1:
        signal = "🟢 KIEGYENSÚLYOZOTT – normál piac"
        action = "WAIT – nincs szignifikáns edge"
    else:
        signal = "🔵 IV < RV – Realized > Implied (ritka!)"
        action = "BUY volatility – piaci mozgás alulértékelt"

    return {
        "implied_vol":  iv,
        "realized_vol": rv,
        "spread":       spread,
        "spread_pct":   spread_pct,
        "signal":       signal,
        "action":       action,
    }

# ─── 6. PRINT ─────────────────────────────────────────────────────────────────

def print_analysis(rv_data: dict, markets: list, vs: dict):
    cp = rv_data["current_price"]
    print(f"\n{'═'*60}")
    print(f"  BTC VOLATILITY HARVESTER")
    print(f"  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}  |  BTC: ${cp:,.0f}")
    print(f"{'═'*60}")

    print(f"\n{'─'*60}")
    print("  REALIZED VOLATILITY (Binance 1m klines)")
    print('─'*60)
    for window, vols in rv_data["windows"].items():
        c2c = vols["close_to_close"] * 100
        park = vols["parkinson"] * 100
        bar = "█" * int(c2c / 5) + "░" * max(0, 20 - int(c2c / 5))
        print(f"  {window:>4}:  [{bar}]  C2C: {c2c:5.1f}%  Parkinson: {park:5.1f}%")

    print(f"\n{'─'*60}")
    print("  VOL SPREAD (Implied – Realized)")
    print('─'*60)
    print(f"  Implied vol (PM):   {vs['implied_vol']*100:6.1f}%")
    print(f"  Realized vol (15m): {vs['realized_vol']*100:6.1f}%")
    print(f"  Spread:             {vs['spread_pct']:+6.1f}%")
    print(f"  {vs['signal']}")
    print(f"  → {vs['action']}")

    print(f"\n{'─'*60}")
    print("  POLYMARKET BTC KONTRAKTOK")
    print('─'*60)
    if not markets:
        print("  ⚠ Nincs BTC kontraktadat (API nem elérhető)")
    else:
        print(f"  {'Kérdés':<40} {'YES':>6} {'NO':>6} {'Gross':>7} {'Net':>7} {'Signal'}")
        print("  " + "─" * 80)
        for m in markets:
            lp = m["locked_profit"]
            q  = m["question"][:38]
            print(f"  {q:<40} {lp['yes_price']:>5.2f}¢ {lp['no_price']:>5.2f}¢ "
                  f"{lp['gross_cost']:>6.2f}  {lp['net_profit']:>+6.4f}  {lp['signal']}")
            if lp.get("note"):
                print(f"  {'':40} {lp['note']}")

    edge_markets = [m for m in markets if m["locked_profit"]["has_edge"]]
    if edge_markets:
        best = max(edge_markets, key=lambda m: m["locked_profit"]["net_profit"])
        lp = best["locked_profit"]
        print(f"\n  🎯 LEGJOBB LEHETŐSÉG:")
        print(f"     {best['question'][:55]}")
        print(f"     Net profit: ${lp['net_profit']:.4f} / kontraktpár ({lp['net_pct']:.2f}%)")
        print(f"     URL: {best['url']}")
    else:
        print(f"\n  ⚪ Nincs locked profit lehetőség (fee után negatív)")

    print(f"\n  ⚠  FONTOS: Ezek mid árak. Valódi ask 1-3¢ magasabb oldalanként.")
    print(f"     Fee becslés: {POLYMARKET_FEE*100:.0f}%/oldal (taker)")
    print()

# ─── DEMO ─────────────────────────────────────────────────────────────────────

def run_demo():
    print("\n[DEMO MODE – szintetikus adatok]")
    rv_data = {
        "current_price": 67245.50,
        "windows": {
            "5m":  {"close_to_close": 0.082, "parkinson": 0.094},
            "15m": {"close_to_close": 0.091, "parkinson": 0.103},
            "30m": {"close_to_close": 0.118, "parkinson": 0.127},
            "60m": {"close_to_close": 0.142, "parkinson": 0.158},
        }
    }
    markets = [
        {"question": "Will BTC go UP in next 15 minutes?",
         "slug": "btc-up-15m", "url": "https://polymarket.com",
         "locked_profit": locked_profit(0.54, 0.51)},
        {"question": "Will BTC go DOWN in next 15 minutes?",
         "slug": "btc-down-15m", "url": "https://polymarket.com",
         "locked_profit": locked_profit(0.48, 0.49)},
    ]
    avg_iv = 0.58  # szimulált pánik implied vol
    rv_15m = rv_data["windows"]["15m"]["close_to_close"]
    vs = vol_spread_signal(avg_iv, rv_15m)
    print_analysis(rv_data, markets, vs)

# ─── MAIN ─────────────────────────────────────────────────────────────────────

def run_once(args) -> dict:
    print("[INFO] Binance klines lekérése...")
    rv_data = fetch_realized_vols([5, 15, 30, 60])

    print("[INFO] Polymarket BTC kontraktok keresése...")
    raw_markets = fetch_btc_markets()

    markets = []
    for m in raw_markets:
        tokens = m.get("tokens", [])
        yes_p, no_p = 0.5, 0.5
        for t in tokens:
            tid = t.get("token_id") or t.get("tokenId")
            out = (t.get("outcome") or "").upper()
            if tid:
                mid = fetch_token_mid(tid)
                if out in ("YES", "UP"):   yes_p = mid
                elif out in ("NO", "DOWN"): no_p = mid
        # Implied vol (15m kontraktra)
        iv = implied_vol_from_binary(yes_p, 15 / 60)
        markets.append({
            "question":    m.get("question", "N/A"),
            "slug":        m.get("slug", ""),
            "yes_price":   yes_p,
            "no_price":    no_p,
            "implied_vol": iv,
            "locked_profit": locked_profit(yes_p, no_p),
            "url": f"https://polymarket.com/event/{m.get('slug','')}" if m.get("slug") else "https://polymarket.com",
        })

    avg_iv = np.mean([m["implied_vol"] for m in markets]) if markets else rv_data["windows"]["15m"]["close_to_close"]
    rv_15m = rv_data["windows"]["15m"]["close_to_close"]
    vs = vol_spread_signal(avg_iv, rv_15m)

    return {"rv": rv_data, "markets": markets, "vol_spread": vs}

def main():
    parser = argparse.ArgumentParser(description="BTC Volatility Harvester")
    parser.add_argument("--demo",  action="store_true")
    parser.add_argument("--watch", action="store_true", help="Folyamatos frissítés (2 perc)")
    parser.add_argument("--json",  action="store_true")
    args = parser.parse_args()

    if args.demo:
        run_demo(); return

    if args.watch:
        print("🔄 Watch mode – Ctrl+C a kilépéshez")
        while True:
            try:
                data = run_once(args)
                print_analysis(data["rv"], data["markets"], data["vol_spread"])
                print("⏳ Következő frissítés 2 perc múlva...")
                time.sleep(120)
            except KeyboardInterrupt:
                print("\n[STOP]"); break
            except Exception as e:
                print(f"[ERROR] {e}"); time.sleep(30)
        return

    data = run_once(args)
    if args.json:
        print(json.dumps({
            "btc_price": data["rv"]["current_price"],
            "realized_vol": {k: v["close_to_close"] * 100 for k, v in data["rv"]["windows"].items()},
            "vol_spread": data["vol_spread"],
            "markets": [{
                "question": m["question"],
                "locked_profit": m["locked_profit"],
            } for m in data["markets"]],
        }, indent=2))
    else:
        print_analysis(data["rv"], data["markets"], data["vol_spread"])

if __name__ == "__main__":
    main()
