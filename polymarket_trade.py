#!/usr/bin/env python3
"""
polymarket_trade.py
-------------------
Lokálisan futtatandó script Polymarket order leadáshoz.
A private key SOHA nem kerül a szerverre – csak a te gépeden fut.

Futtatás:
  pip install py-clob-client
  python polymarket_trade.py --action balance
  python polymarket_trade.py --action buy  --token-id <id> --amount 50 --price 0.42
  python polymarket_trade.py --action sell --token-id <id> --amount 50 --price 0.58
  python polymarket_trade.py --action positions
  python polymarket_trade.py --intent '{"token_id":"...","side":"BUY","amount":50,"price":0.42}'

Env vars (.env fájlban vagy exportálva):
  POLYMARKET_PRIVATE_KEY    – Polygon wallet private key (0x...)
  POLYMARKET_PROXY_ADDRESS  – Proxy/funder address
"""

import os
import sys
import json
import argparse
from decimal import Decimal

try:
    from py_clob_client.client import ClobClient
    from py_clob_client.clob_types import (
        OrderArgs, MarketOrderArgs, OrderType, OpenOrderParams
    )
    from py_clob_client.order_builder.constants import BUY, SELL
except ImportError:
    print("[ERROR] py-clob-client nincs telepítve.")
    print("  pip install py-clob-client")
    sys.exit(1)

# ─── Config ───────────────────────────────────────────────────────────────────
HOST       = "https://clob.polymarket.com"
CHAIN_ID   = 137  # Polygon mainnet

def get_client() -> ClobClient:
    key   = os.environ.get("POLYMARKET_PRIVATE_KEY")
    proxy = os.environ.get("POLYMARKET_PROXY_ADDRESS")
    if not key:
        print("[ERROR] POLYMARKET_PRIVATE_KEY env var hiányzik")
        sys.exit(1)
    client = ClobClient(
        HOST,
        key=key,
        chain_id=CHAIN_ID,
        signature_type=1 if proxy else 0,
        funder=proxy or None,
    )
    try:
        client.set_api_creds(client.create_or_derive_api_creds())
    except Exception as e:
        print(f"[WARN] API creds: {e}")
    return client

# ─── Actions ──────────────────────────────────────────────────────────────────

def show_balance(client: ClobClient):
    """USDC egyenleg lekérése."""
    try:
        # Gamma API-n keresztül (wallet balance)
        import urllib.request
        proxy = os.environ.get("POLYMARKET_PROXY_ADDRESS", "")
        if proxy:
            url = f"https://data-api.polymarket.com/value?user={proxy}"
            with urllib.request.urlopen(url, timeout=5) as r:
                data = json.loads(r.read())
            print(f"\n💰 Portfolio értéke: ${data:.2f} USDC")
        else:
            print("[INFO] Wallet address megadásával látható az egyenleg")
    except Exception as e:
        print(f"[ERROR] {e}")

def show_positions(client: ClobClient):
    """Nyitott pozíciók."""
    try:
        orders = client.get_orders(OpenOrderParams())
        if not orders:
            print("\n📋 Nincs nyitott megbízás")
            return
        print(f"\n📋 Nyitott megbízások ({len(orders)}):")
        print(f"  {'Token ID':<20} {'Side':<6} {'Price':>8} {'Size':>10} {'Status'}")
        print("  " + "-" * 65)
        for o in orders[:20]:
            print(f"  {o.get('asset_id','')[:18]:<20} {o.get('side',''):<6} "
                  f"{float(o.get('price',0)):>8.4f} {float(o.get('size_matched',0)):>10.2f} "
                  f"{o.get('status','')}")
    except Exception as e:
        print(f"[ERROR] {e}")

def place_limit_order(client: ClobClient, token_id: str, side_str: str, amount: float, price: float):
    """Limit order leadás."""
    side = BUY if side_str.upper() == "BUY" else SELL
    side_name = "BUY  ✅" if side == BUY else "SELL ❌"

    print(f"\n⚡ Order előkészítés:")
    print(f"   Token:  {token_id[:30]}...")
    print(f"   Irány:  {side_name}")
    print(f"   Összeg: ${amount:.2f} USDC")
    print(f"   Ár:     {price:.4f} ({price*100:.1f}¢)")
    print(f"   Shares: {amount/price:.2f}")

    confirm = input("\n❓ Megerősítés? (igen/nem): ").strip().lower()
    if confirm not in ("igen", "i", "yes", "y"):
        print("[ABORT] Törölve")
        return

    try:
        order_args = OrderArgs(
            token_id=token_id,
            price=price,
            size=amount / price,  # share mennyiség
            side=side,
        )
        signed  = client.create_order(order_args)
        result  = client.post_order(signed, OrderType.GTC)
        print(f"\n✅ Order leadva!")
        print(f"   Order ID: {result.get('orderID', 'N/A')}")
        print(f"   Status:   {result.get('status', 'N/A')}")
    except Exception as e:
        print(f"\n[ERROR] Order hiba: {e}")

def place_market_order(client: ClobClient, token_id: str, side_str: str, amount: float):
    """Market order – azonnali teljesítés."""
    side = BUY if side_str.upper() == "BUY" else SELL
    print(f"\n⚡ Market order: {side_str} ${amount:.2f} USDC")
    confirm = input("❓ Megerősítés? (igen/nem): ").strip().lower()
    if confirm not in ("igen", "i", "yes", "y"):
        print("[ABORT] Törölve")
        return
    try:
        mo     = MarketOrderArgs(token_id=token_id, amount=amount, side=side, order_type=OrderType.FOK)
        signed = client.create_market_order(mo)
        result = client.post_order(signed, OrderType.FOK)
        print(f"✅ Market order: {result}")
    except Exception as e:
        print(f"[ERROR] {e}")

def cancel_all(client: ClobClient):
    """Összes nyitott order törlése."""
    confirm = input("❓ Összes order törlése? (igen/nem): ").strip().lower()
    if confirm not in ("igen", "i", "yes", "y"):
        print("[ABORT] Törölve")
        return
    result = client.cancel_all()
    print(f"✅ Törölve: {result}")

# ─── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Polymarket trade executor")
    parser.add_argument("--action",   choices=["balance","positions","buy","sell","market-buy","market-sell","cancel-all"], default="balance")
    parser.add_argument("--token-id", help="CLOB token ID")
    parser.add_argument("--amount",   type=float, default=10.0, help="USDC összeg")
    parser.add_argument("--price",    type=float, default=0.5,  help="Ár (0-1)")
    parser.add_argument("--intent",   help="JSON intent (a webes felületről)")
    args = parser.parse_args()

    # .env betöltés ha van
    if os.path.exists(".env"):
        with open(".env") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip())

    client = get_client()
    print("✓ Polymarket client inicializálva")

    # Intent feldolgozás (webes felülettől jött)
    if args.intent:
        try:
            intent = json.loads(args.intent)
            print(f"\n📥 Intent fogadva: {intent}")
            if intent["side"].upper() == "BUY":
                place_limit_order(client, intent["token_id"], "BUY", intent["amount"], intent["price"])
            else:
                place_limit_order(client, intent["token_id"], "SELL", intent["amount"], intent["price"])
        except Exception as e:
            print(f"[ERROR] Intent feldolgozás: {e}")
        return

    if args.action   == "balance":    show_balance(client)
    elif args.action == "positions":  show_positions(client)
    elif args.action == "buy":        place_limit_order(client, args.token_id, "BUY",  args.amount, args.price)
    elif args.action == "sell":       place_limit_order(client, args.token_id, "SELL", args.amount, args.price)
    elif args.action == "market-buy": place_market_order(client, args.token_id, "BUY",  args.amount)
    elif args.action == "market-sell":place_market_order(client, args.token_id, "SELL", args.amount)
    elif args.action == "cancel-all": cancel_all(client)

if __name__ == "__main__":
    main()
