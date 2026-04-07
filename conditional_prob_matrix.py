#!/usr/bin/env python3
"""
conditional_prob_matrix.py
--------------------------
Conditional Probability Mispricing Detector

Logika: ha két korrelált piac árai matematikailag inkonzisztensek,
az arbitrázs lehetőség. Példák:

  P(Trump wins PA) = 0.70
  P(Trump wins presidency) = 0.45
  → Ellentmondás: PA nélkül szinte lehetetlen elnök lenni

  P(Fed holds May) = 0.65
  P(Fed cuts Q2 total) = 0.72
  → Ellentmondás: ha Q2-ben vágnak, de Májusban tartanak, csak Júniusban vághatnak

  P(BTC > 100k EOY) = 0.42
  P(BTC > 80k EOY) = 0.55
  → Ellentmondás: P(>100k) > P(>80k) mathematikailag lehetetlen

Polymarket CLI integrálva: `polymarket -o json markets search "..."` 

Futtatás:
  pip install requests numpy
  python conditional_prob_matrix.py --demo
  python conditional_prob_matrix.py --scan-fed
  python conditional_prob_matrix.py --scan-btc
  python conditional_prob_matrix.py --scan-election
  python conditional_prob_matrix.py --custom "market_slug_1" "market_slug_2"
  python conditional_prob_matrix.py --cli    # Polymarket CLI-n keresztül
"""

import argparse
import json
import math
import subprocess
import sys
from dataclasses import dataclass
from typing import Optional
import requests
import numpy as np

GAMMA_API = "https://gamma-api.polymarket.com"
CLOB_API  = "https://clob.polymarket.com"

# ─── DATA CLASSES ─────────────────────────────────────────────────────────────

@dataclass
class Market:
    slug:       str
    question:   str
    yes_price:  float
    no_price:   float
    volume_24h: float
    condition_id: str = ""
    token_yes:  str = ""

@dataclass
class Violation:
    type:        str   # MONOTONICITY | CONDITIONAL | JOINT | COMPLEMENT
    severity:    float # 0-1, magasabb = erősebb
    market_a:    Market
    market_b:    Market
    description: str
    edge:        float # becsült EV cent/contract
    action:      str   # melyik piacon mit tegyünk

# ─── CLI WRAPPER ──────────────────────────────────────────────────────────────

def cli_available() -> bool:
    """Elérhető-e a polymarket CLI?"""
    try:
        result = subprocess.run(
            ["polymarket", "--version"],
            capture_output=True, text=True, timeout=5
        )
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False

def cli_get_market(slug: str) -> Optional[dict]:
    """Polymarket CLI-n keresztül lekér egy market-et JSON-ban."""
    try:
        result = subprocess.run(
            ["polymarket", "-o", "json", "markets", "get", slug],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0:
            return json.loads(result.stdout)
    except Exception as e:
        print(f"  [CLI] {slug}: {e}")
    return None

def cli_search_markets(query: str, limit: int = 10) -> list[dict]:
    """Polymarket CLI keresés."""
    try:
        result = subprocess.run(
            ["polymarket", "-o", "json", "markets", "search", query, "--limit", str(limit)],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0:
            data = json.loads(result.stdout)
            return data if isinstance(data, list) else []
    except Exception as e:
        print(f"  [CLI search] {query}: {e}")
    return []

def cli_get_midpoint(token_id: str) -> Optional[float]:
    """CLOB midpoint CLI-n keresztül."""
    try:
        result = subprocess.run(
            ["polymarket", "-o", "json", "clob", "midpoint", token_id],
            capture_output=True, text=True, timeout=8
        )
        if result.returncode == 0:
            data = json.loads(result.stdout)
            return float(data.get("mid", 0))
    except Exception:
        pass
    return None

# ─── API FALLBACK ──────────────────────────────────────────────────────────────

def api_get_market(slug: str) -> Optional[Market]:
    """Gamma API-n keresztül lekér egy market-et."""
    try:
        r = requests.get(f"{GAMMA_API}/markets",
                        params={"slug": slug, "limit": "1"}, timeout=8)
        r.raise_for_status()
        data = r.json()
        markets = data if isinstance(data, list) else data.get("markets", [])
        if not markets:
            return None
        m = markets[0]
        prices = m.get("outcomePrices", "[0.5,0.5]")
        if isinstance(prices, str):
            prices = json.loads(prices)
        yp = float(prices[0]) if len(prices) > 0 else 0.5
        np_ = float(prices[1]) if len(prices) > 1 else 1 - yp
        tokens = m.get("tokens", [])
        token_yes = ""
        for t in tokens:
            if (t.get("outcome") or "").upper() in ("YES", "UP"):
                token_yes = t.get("token_id", "")
                break
        return Market(
            slug        = slug,
            question    = m.get("question", slug),
            yes_price   = yp,
            no_price    = np_,
            volume_24h  = float(m.get("volume24hr", 0) or 0),
            condition_id= m.get("conditionId", ""),
            token_yes   = token_yes,
        )
    except Exception as e:
        print(f"  [API] {slug}: {e}")
    return None

def fetch_market(slug: str, use_cli: bool = False) -> Optional[Market]:
    """CLI vagy API alapján tölt le egy market-et."""
    if use_cli and cli_available():
        raw = cli_get_market(slug)
        if raw:
            prices = raw.get("outcomePrices", [0.5, 0.5])
            if isinstance(prices, str):
                prices = json.loads(prices)
            return Market(
                slug       = slug,
                question   = raw.get("question", slug),
                yes_price  = float(prices[0]) if prices else 0.5,
                no_price   = float(prices[1]) if len(prices) > 1 else 0.5,
                volume_24h = float(raw.get("volume24hr", 0) or 0),
                condition_id = raw.get("conditionId", ""),
            )
    return api_get_market(slug)

# ─── VIOLATION DETECTORS ──────────────────────────────────────────────────────

def check_monotonicity(m_strong: Market, m_weak: Market,
                        relation: str = "implies") -> Optional[Violation]:
    """
    Monotonicitás ellenőrzés: ha A → B logikailag, akkor P(A) ≤ P(B).
    Pl: P(BTC > 100k) ≤ P(BTC > 80k) kötelezően.
    
    relation: "implies" | "subset"
    """
    pa = m_strong.yes_price
    pb = m_weak.yes_price

    if pa <= pb:
        return None  # konzisztens

    violation_size = pa - pb
    if violation_size < 0.02:
        return None  # túl kicsi, fee-n belül

    severity = min(1.0, violation_size / 0.20)
    edge     = violation_size * 100  # centben

    return Violation(
        type        = "MONOTONICITY",
        severity    = severity,
        market_a    = m_strong,
        market_b    = m_weak,
        description = (
            f"P({m_strong.question[:40]}) = {pa:.3f} > "
            f"P({m_weak.question[:40]}) = {pb:.3f}\n"
            f"  → Ha A erősebb feltétel mint B, P(A) ≤ P(B) kell legyen.\n"
            f"  → Eltérés: {violation_size*100:.1f}¢"
        ),
        edge   = edge,
        action = (
            f"SELL {m_strong.slug} YES ({pa:.2f}) + "
            f"BUY {m_weak.slug} YES ({pb:.2f})"
        ),
    )

def check_complement(m: Market) -> Optional[Violation]:
    """
    Komplement ellenőrzés: P(YES) + P(NO) kell ≈ 1.00.
    Ha nem, valamelyik fél meg van mispricing-elve.
    (Ez a locked profit detektorból is megvan, de itt az elemzési kontextusban.)
    """
    total = m.yes_price + m.no_price
    dev   = abs(total - 1.0)

    if dev < 0.01:
        return None

    severity = min(1.0, dev / 0.10)
    # A drágábbat adjuk el
    action = (
        f"SELL YES ({m.yes_price:.2f}) + SELL NO ({m.no_price:.2f})"
        if total > 1.0
        else f"BUY YES ({m.yes_price:.2f}) + BUY NO ({m.no_price:.2f})"
    )

    return Violation(
        type        = "COMPLEMENT",
        severity    = severity,
        market_a    = m,
        market_b    = m,
        description = (
            f"P(YES) + P(NO) = {total:.4f} ≠ 1.000\n"
            f"  → Eltérés: {dev*100:.2f}¢"
        ),
        edge   = dev * 100,
        action = action,
    )

def check_conditional(
    m_joint: Market,        # P(A ∩ B)
    m_a:     Market,        # P(A)
    m_b:     Market,        # P(B)
    description: str = "",
) -> Optional[Violation]:
    """
    Feltételes valószínűség konzisztencia:
    P(A ∩ B) ≤ min(P(A), P(B))
    
    Pl: P(Trump wins PA AND wins presidency) ≤ P(Trump wins presidency)
    """
    p_joint = m_joint.yes_price
    p_a     = m_a.yes_price
    p_b     = m_b.yes_price

    max_possible = min(p_a, p_b)
    if p_joint <= max_possible + 0.01:
        return None

    violation = p_joint - max_possible
    severity  = min(1.0, violation / 0.15)

    return Violation(
        type        = "CONDITIONAL",
        severity    = severity,
        market_a    = m_joint,
        market_b    = m_a if p_a < p_b else m_b,
        description = (
            f"P(joint) = {p_joint:.3f} > min(P(A), P(B)) = {max_possible:.3f}\n"
            f"  {description}\n"
            f"  → Eltérés: {violation*100:.1f}¢"
        ),
        edge   = violation * 100,
        action = f"SELL {m_joint.slug} YES ({p_joint:.2f})",
    )

def check_implication_chain(markets: list[Market],
                             chain: list[tuple[str, str]]) -> list[Violation]:
    """
    Implication chain: A → B → C esetén P(A) ≤ P(B) ≤ P(C)
    chain: [(slug_A, slug_B), (slug_B, slug_C)] ahol A → B → C
    """
    market_map = {m.slug: m for m in markets}
    violations = []

    for stronger_slug, weaker_slug in chain:
        ms = market_map.get(stronger_slug)
        mw = market_map.get(weaker_slug)
        if ms and mw:
            v = check_monotonicity(ms, mw)
            if v:
                violations.append(v)
    return violations

# ─── PREDEFINED MARKET GROUPS ─────────────────────────────────────────────────

MARKET_GROUPS = {
    "fed": {
        "description": "Fed kamattörtéet 2025",
        "markets": [
            "will-the-fed-cut-rates-in-may-2025",
            "will-the-fed-cut-rates-in-june-2025",
            "will-the-fed-cut-rates-in-july-2025",
            "will-the-fed-cut-in-q2-2025",
            "will-the-fed-cut-rates-in-2025",
        ],
        "chains": [
            # Ha Május-ban vágnak, Q2-ben is vágtak
            ("will-the-fed-cut-rates-in-may-2025",
             "will-the-fed-cut-in-q2-2025"),
            # Ha Q2-ben vágnak, 2025-ben is vágtak
            ("will-the-fed-cut-in-q2-2025",
             "will-the-fed-cut-rates-in-2025"),
        ],
    },
    "btc": {
        "description": "BTC árszint piacok",
        "markets": [
            "will-bitcoin-hit-120000-in-2025",
            "will-bitcoin-hit-100000-in-2025",
            "will-bitcoin-hit-80000-in-2025",
            "will-bitcoin-hit-60000-in-2025",
        ],
        "chains": [
            # Szigorú monotonicitás: $120k → $100k → $80k → $60k
            ("will-bitcoin-hit-120000-in-2025",
             "will-bitcoin-hit-100000-in-2025"),
            ("will-bitcoin-hit-100000-in-2025",
             "will-bitcoin-hit-80000-in-2025"),
            ("will-bitcoin-hit-80000-in-2025",
             "will-bitcoin-hit-60000-in-2025"),
        ],
    },
}

# ─── SCANNER ──────────────────────────────────────────────────────────────────

def scan_group(group_name: str, use_cli: bool = False) -> list[Violation]:
    """Előre definiált market csoport scanelése."""
    group = MARKET_GROUPS.get(group_name)
    if not group:
        print(f"[ERROR] Ismeretlen csoport: {group_name}")
        return []

    print(f"\n[INFO] Csoport: {group['description']}")
    markets = []
    for slug in group["markets"]:
        print(f"  Betöltés: {slug[:45]}...", end="\r")
        m = fetch_market(slug, use_cli)
        if m:
            markets.append(m)
            print(f"  ✓ {slug[:40]:<40} YES:{m.yes_price:.3f}")
        else:
            print(f"  ✗ {slug[:40]:<40} (nem található)")

    violations = []

    # Monotonicity chain
    violations.extend(check_implication_chain(markets, group.get("chains", [])))

    # Complement check minden piacon
    for m in markets:
        v = check_complement(m)
        if v:
            violations.append(v)

    return violations

def scan_custom(slugs: list[str], use_cli: bool = False) -> list[Violation]:
    """Egyedi slug lista scanelése."""
    markets = []
    for slug in slugs:
        m = fetch_market(slug, use_cli)
        if m:
            markets.append(m)
            print(f"  ✓ {m.question[:55]:<55} YES:{m.yes_price:.3f}")

    violations = []
    # Minden párra complement check
    for m in markets:
        v = check_complement(m)
        if v:
            violations.append(v)

    # Minden párra monotonicity (ha sorrendük logikus)
    for i in range(len(markets) - 1):
        for j in range(i + 1, len(markets)):
            v = check_monotonicity(markets[i], markets[j])
            if v:
                violations.append(v)
            v2 = check_monotonicity(markets[j], markets[i])
            if v2:
                violations.append(v2)

    return violations

# ─── PRINT ────────────────────────────────────────────────────────────────────

def print_violations(violations: list[Violation], bankroll: float = 200.0):
    if not violations:
        print("\n  ✓ Nincs kimutatható conditional probability violation")
        return

    violations.sort(key=lambda v: v.severity, reverse=True)

    print(f"\n{'═'*65}")
    print(f"  CONDITIONAL PROBABILITY VIOLATIONS ({len(violations)} db)")
    print(f"{'═'*65}")

    for i, v in enumerate(violations, 1):
        severity_bar = "█" * int(v.severity * 10) + "░" * (10 - int(v.severity * 10))
        type_emoji = {
            "MONOTONICITY": "📐",
            "COMPLEMENT":   "⚖️",
            "CONDITIONAL":  "🔗",
            "JOINT":        "∩",
        }.get(v.type, "?")

        # Kelly méretezés
        p     = min(0.95, v.severity)
        payoff = v.edge / 100  # USDC
        kelly  = max(0, (p * payoff - (1-p)) / payoff) * 0.25
        pos    = bankroll * kelly

        print(f"\n  [{i}] {type_emoji} {v.type} | Severity: [{severity_bar}] {v.severity:.2f}")
        print(f"      {v.description}")
        print(f"      Edge: {v.edge:.2f}¢ | ¼Kelly pozíció: ${pos:.2f}")
        print(f"      → {v.action}")

    print(f"\n  {'─'*60}")
    total_edge = sum(v.edge for v in violations)
    print(f"  Összesített detektált edge: {total_edge:.1f}¢")
    print(f"  ⚠ Fee és spread figyelembe veendő (~2-4¢/oldal)\n")

# ─── DEMO ─────────────────────────────────────────────────────────────────────

def run_demo():
    """Szintetikus demo inkonzisztens piacokkal."""
    print("\n[DEMO MODE – szintetikus inkonzisztens piacok]")

    # BTC monotonicitás violation szimulálva
    btc_120k = Market("btc-120k", "Will BTC hit $120k in 2025?", 0.38, 0.62, 180000)
    btc_100k = Market("btc-100k", "Will BTC hit $100k in 2025?", 0.32, 0.68, 420000)  # VIOLATION!
    btc_80k  = Market("btc-80k",  "Will BTC hit $80k in 2025?",  0.61, 0.39, 290000)

    # Fed chain violation
    fed_may  = Market("fed-may",  "Will Fed cut in May 2025?",    0.18, 0.82, 140000)
    fed_q2   = Market("fed-q2",   "Will Fed cut in Q2 2025?",     0.12, 0.88, 280000)  # VIOLATION!
    fed_2025 = Market("fed-2025", "Will Fed cut in 2025?",        0.72, 0.28, 580000)

    # Complement violation
    election = Market("election", "Will Candidate X win?",        0.58, 0.47, 320000)  # 1.05 összeg

    violations = []

    # BTC chain
    v = check_monotonicity(btc_120k, btc_100k)
    if v: violations.append(v)
    v = check_monotonicity(btc_100k, btc_80k)
    if v: violations.append(v)

    # Fed chain
    v = check_monotonicity(fed_may, fed_q2)
    if v: violations.append(v)
    v = check_monotonicity(fed_q2, fed_2025)
    if v: violations.append(v)

    # Complement
    v = check_complement(election)
    if v: violations.append(v)

    print_violations(violations)

# ─── MAIN ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Conditional Probability Matrix Mispricing Detector"
    )
    parser.add_argument("--demo",      action="store_true")
    parser.add_argument("--scan-fed",  action="store_true", help="Fed kamattörténet piacok")
    parser.add_argument("--scan-btc",  action="store_true", help="BTC árszint piacok")
    parser.add_argument("--custom",    nargs="+",           help="Egyedi slug-ok listája")
    parser.add_argument("--cli",       action="store_true", help="Polymarket CLI használata")
    parser.add_argument("--bankroll",  type=float, default=200, help="Bankroll USD")
    parser.add_argument("--json",      action="store_true")
    args = parser.parse_args()

    if args.demo:
        run_demo()
        return

    use_cli = args.cli
    if use_cli:
        if cli_available():
            print("[INFO] Polymarket CLI elérhető – használatban")
        else:
            print("[WARN] Polymarket CLI nem elérhető, API fallback")
            use_cli = False

    violations = []

    if args.scan_fed:
        violations.extend(scan_group("fed", use_cli))
    elif args.scan_btc:
        violations.extend(scan_group("btc", use_cli))
    elif args.custom:
        print(f"[INFO] Custom scan: {len(args.custom)} market")
        violations.extend(scan_custom(args.custom, use_cli))
    else:
        parser.print_help()
        return

    if args.json:
        import dataclasses
        print(json.dumps([
            {
                "type": v.type,
                "severity": v.severity,
                "edge_cents": v.edge,
                "description": v.description,
                "action": v.action,
                "market_a": v.market_a.slug,
                "market_b": v.market_b.slug,
            }
            for v in violations
        ], indent=2))
    else:
        print_violations(violations, args.bankroll)

if __name__ == "__main__":
    main()
