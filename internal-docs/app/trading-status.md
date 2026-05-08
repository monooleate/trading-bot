# Trading Status — mit tudsz most, mit tudsz majd Hetznerrel

> Frissítve: 2026-05-09. Forrás: `auto-trader/index.mts` + `netlify.toml` cron config + `execution.mts` clob-client integráció.

---

## TL;DR

- **Paper mód:** az auto-trader **automatikusan** fut Netlify cron-ról 3 percenként, simulált order-ekkel — semmit nem kell indítanod kézzel.
- **Live Polymarket BTC short markets:** ha `PAPER_MODE=false` + `POLY_PRIVATE_KEY` az env-ben, **a Netlify cron automatikusan valódi ordert ad le** a Polymarket CLOB-on, 3 percenként.
- **Manuális Polymarket trade (Tab 5 UI):** read-only intent generálás → lokális Python script futtatja le. Ez direkt biztonsági döntés (privát kulcs nem kerül szerverre kézi tradenél).
- **Hyperliquid + Funding Arb:** csak paper mode működik megbízhatóan Netlify-ról; live runtime-hoz Hetzner kell.

---

## Most rögtön — szerver nélküli (Netlify-only) működés

### Polymarket — automata BTC 5m/15m bot

**Hogyan fut:** `[functions."auto-trader"]` `schedule = "*/3 * * * *"` UTC →
3 percenként hív `runCryptoTrader`-t → BTC short markets keresése → signal
aggregation (signal-combiner + OB imbalance) → entry-window filter →
decision → buy → sell.

| Konfiguráció | Mi történik |
|---|---|
| `PAPER_MODE=true` (default) | Cron 3 percenként szimulált open+close-t csinál, eredmények bekerülnek az Edge Tracker-be (Tab 12). **Ehhez SEMMIT nem kell csinálnod**, deploy után magától indul. |
| `PAPER_MODE=false` + `POLY_PRIVATE_KEY` + `POLY_FUNDER_ADDRESS` env-ben | Cron 3 percenként **valódi ordert ad le** a Polymarket CLOB-on `@polymarket/clob-client`-en keresztül ECDSA aláírással. Nincs kézi indítás, magától kereskedik. |

**FONTOS biztonsági kompromisszum:** live mode-ban a privát kulcs **a Netlify env varban van** (futás közben memóriában). Ez explicit tradeoff — a manuális Trading panel ezért nem csinál ilyet, a kézi tradet a Python script futtatja a saját géppeden. Az auto-trader esetében pragmatikus döntés volt, hogy ne kelljen 3 percenként a saját géped futtatni.

**Stop / pause / reset live trading:**
- Tab 12 (Auto-Trader) → Status panel → Stop gomb → `action=stop` request → session leállítva
- Vagy közvetlen: `curl -X POST https://<site>.netlify.app/.netlify/functions/auto-trader -d '{"action":"stop"}'`
- Vagy env varokkal: `SESSION_LOSS_LIMIT` lecsökkentése → automatikus stop az első veszteség után

### Polymarket — manuális trade (Tab 5)

**Workflow:**
1. Tab 5 → Polymarket → válassz piacot
2. BUY YES vagy BUY NO + összeg → "Intent generálás"
3. Másold a kapott parancsot, futtasd lokálisan: `python polymarket_trade.py --intent '<json>'`

**Miért nem direktben?** A manuális oldal explicit nem teszi a privát kulcsot Netlify-ra, mert egyszer beégetve nem tudod könnyen kivenni — vs. az auto-trader, ahol a kontrollált, tesztelt code path veszi le a kockázatot. Ez egy szándékos döntés, nem hiba.

### Polymarket — Auto-Claim nyertes pozíciók (új, ma)

**Workflow:** Tab 5 → Polymarket → "Auto-Claim" section
1. Wallet 0x… cím beírása (localStorage-ben megjegyzi)
2. 🔍 Ellenőriz → listázza a redeemable pozíciókat + összesít USDC-t
3. 📋 Intent generálás → másold, futtasd lokálisan: `python polymarket_trade.py --redeem-intent '<json>'`

A redeem on-chain tx (Polygon), tehát a privát kulcs lokálisan kell. Csak az **eligibility check** és intent generálás megy Netlify-ról.

### Polymarket — Pair-Cost Arb scanner (új, ma)

**Tab 11 → "D. Pair-Cost Arb" chip** → Min profit % + Test notional ($) →
🔍 Scan → minden binary piacon ellenőrzi: top YES ask + top NO ask < $1.00,
és VWAP-ot számol a megadott notional-on (depth validáció).

Ha van candidate: a tényleges 2-leg vételt manuálisan kell végrehajtani a
Trading panelban (YES + NO atomikusan, kis idő alatt egymás után), majd
resolve után az Auto-Claim-mel begyűjteni a $1-t/share-t.

### Bybit Futures + Binance Futures (Tab 5)

**Hogyan:** Tab 5 → Bybit/Binance → balance/positions/order leadás közvetlen API-n.
- `BYBIT_API_KEY` + `BYBIT_API_SECRET` env varok
- `BINANCE_API_KEY` + `BINANCE_API_SECRET` env varok
- **Élesítés előtt:** `BYBIT_TESTNET=true` és `BINANCE_TESTNET=true` (default)
- Manuális ordert ad le, NINCS automatika rajta.

### Edge Tracker (Tab 12)

A paper mode auto-trader minden 3 percben rögzít trade-eket → Tab 12 mutatja
a kumulatív PnL-t, kalibrációt, signal IC-t, edge decay-t.

### ⚙ Beállítások (új, ma)

Tab 13 → bejelentkezés → 11 paraméter slider+number input-tal:
- **Risk & sizing:** edge threshold, max Kelly fraction, session loss limit, cooldown
- **BTC short markets:** TP/SL targetek, entry windows, hold-to-end cutoff
- **OB imbalance:** UP/DOWN ratio thresholds

A változások **3 percen belül** érvényesek (a következő cron tickkel) — nem kell redeploy.

---

## Amit szerver nélkül NEM tudsz — Hetzner kell hozzá

### 1. Hyperliquid perp + Funding Arbitrage live trading

**Probléma:**
- Netlify Functions 10 másodperc serverless timeout → atomic 2-leg open
  (HL SHORT + Binance LONG hedge) megbízhatatlan
- Cold start kezelés → in-memory session state minden hívásnál elveszik,
  Postgres kell helyette
- 24/7 WebSocket fillCallback nem működik serverless-ben

**Mit kell csinálni:** `internal-docs/migration/hetzner-migration-plan.md`
Fázis 2 (HL execution port) + Fázis 3 (Funding-arb port).

**Becsült idő:** 2-3 nap HL, 2-3 nap funding-arb (+ Fázis 1 VPS setup 1 nap).

### 2. P2.2 — Real-time Binance/PM divergencia detektor

**Probléma:** folyamatos WS feed kell mindkét forrásra (`btcusdt@kline_1s`
+ Polymarket CLOB), Netlify-on definíció szerint sosem fog menni.

**Mit ad:** ha Binance >$50 mozgás 30s alatt + PM ár nem frissült → 2-3s
divergencia ablak → entry trigger.

**Mit kell csinálni:** Hetzner Fázis 4. Becsült idő 3-4 nap.

### 3. P3.3 — LP Refresh Window execution

**Probléma:** LP wallet (Subgroup A/B) fill events streamelése + 8-15s
window-on belül a stale quote opposite oldali eltrétálása. WS + Postgres
+ Redis kell hozzá.

**Előfeltétel:** A.5 LP klasszifikáció (most kész) + warproxxx/poly_data
manuális Python futtatás (~9 confirmed LP wallet listája).

**Mit kell csinálni:** Hetzner Fázis 5. Becsült idő 5-7 nap.

### 4. Telegram bot kontroll — `/status /stop /pause /resume /pnl`

**Probléma:** node-telegram-bot-api / grammy long-poll vagy webhook kell,
serverless-ben mindkettő rosszul fér el. A `shared/telegram.mts` jelenleg
csak alert push-t tud (egyirányú).

**Mit kell csinálni:** Hetzner Fázis 6. Becsült idő 1-2 nap.

### 5. Globális kill switch + Postgres backup + Disaster recovery

**Probléma:** Redis flag pub/sub kell minden moduluknak ami egyszerre
hallgatja, és napi pg_dump archiválás külön gépre.

**Mit kell csinálni:** Hetzner Fázis 7 (cutover validation) része.

---

## Beállítási kisokos élő Polymarket auto-tradinghez (szerver nélkül)

**Csak akkor csináld ezt, ha 50+ paper trade fut sikeresen az Edge Tracker-en, és a kalibráció jó.**

1. **Netlify env varok** (Site settings → Environment variables):
   ```
   POLY_PRIVATE_KEY      = 0x… (dedikált hot wallet, kis tőke!)
   POLY_FUNDER_ADDRESS   = 0x… (proxy wallet polymarket.com/profile/<itt>)
   POLY_SIGNATURE_TYPE   = 1
   PAPER_MODE            = false
   SESSION_LOSS_LIMIT    = 50            ← naponta max ennyi USD veszteség
   EDGE_THRESHOLD_CRYPTO = 0.15          ← 15% net edge minimum
   ```

2. **Hot wallet feltöltés:** csak annyi USDC-vel amennyit elviselsz veszteni
   (50-200 USDC ajánlott elsőre). NE a fő wallet-ed legyen.

3. **Settings tab tuning:** TP=0.75, SL=0.35, max Kelly=8%, entry window
   60-180s — ezek a master-plan defaultjai, nem kell hozzájuk nyúlni
   eleinte.

4. **Telegram alert** (opcionális, de erősen javasolt élő mode-ban):
   ```
   TELEGRAM_BOT_TOKEN = ...
   TELEGRAM_CHAT_ID   = ...
   ```
   Minden trade open + close-t megkapsz push-ban.

5. **Kill switch a vészhelyzetre:**
   - Gyors: Netlify dashboard → Environment variables → `PAPER_MODE=true`
     → Save → automatikus redeploy ~1 perc → a következő cron tick már
     paper-ben fut
   - Vagy: Tab 12 → Stop gomb (session leáll, de a környezeti var nem
     változik — az env redeploy a "kapcsolószekrény")

6. **Monitoring:** Tab 12 (Edge Tracker) napi 1× ellenőrzés. Ha a
   kalibráció eltér 10pp-nél nagyobban a predicted vs actual közt vagy
   az IR <0, **STOP**.

---

## Connection / runtime hierarchy

```
┌──────────────────────────────────────────────────────────────┐
│ NETLIFY (most ezen vagyunk — szerver nélküli)                │
│                                                              │
│  Cron 3 percenként:                                          │
│    auto-trader → BTC short markets                           │
│       ├─ paper mode: instant simulated fill                  │
│       └─ live mode (POLY_PRIVATE_KEY): valódi clob order ✅  │
│                                                              │
│  Cron óránként:                                              │
│    scheduled-scan → market discovery                         │
│                                                              │
│  Manual UI (Tab 5):                                          │
│    Polymarket trade  → intent → lokális Python (BIZTONSÁG)   │
│    Bybit / Binance   → direkt API (kulcs env-ben)            │
│    Auto-Claim redeem → intent → lokális Python (BIZTONSÁG)   │
│                                                              │
│  Tab 11 D — Pair-Cost Arb scanner (read-only)                │
│  Tab 13 — Settings (auth-protected runtime override)         │
└──────────────────────────────────────────────────────────────┘
                              │
                              │ NEM RUN-OL → Hetzner kell hozzá:
                              │
┌─────────────────────────────▼────────────────────────────────┐
│ HETZNER VPS — még nem létezik, csak terv                     │
│                                                              │
│  PM2 24/7 process-ek:                                        │
│    edgecalc-hl-execution      (Hyperliquid perp live)        │
│    edgecalc-funding-arb       (HL SHORT + Binance LONG)      │
│    edgecalc-divergence-ws     (P2.2 Binance/PM)              │
│    edgecalc-lp-refresh        (P3.3 LP stale quotes)         │
│    edgecalc-webhook-receiver  (Netlify → Hetzner HMAC)       │
│    edgecalc-telegram-bot      (/stop /pause /resume)         │
│  Postgres 16 + Redis 7 + Caddy TLS                           │
└──────────────────────────────────────────────────────────────┘
```

---

## Gyakori kérdések

### "Indítanom kell az auto-tradert kézzel?"
**Nem.** A Netlify cron 3 percenként magától hívja a `/.netlify/functions/auto-trader?action=run`-t. Ahhoz hogy fusson, csak deploy kell és minden env var beállítva. Tab 12-ben látod élőben mit csinál.

### "Paper mode-ban is auto-tradez?"
**Igen.** Pontosan ugyanazt a kódutat fut, csak az `execution.mts` paper mode-ban szimulált fill-t ad vissza valódi CLOB hívás helyett. Az Edge Tracker-be ugyanúgy bekerülnek a "trade-ek".

### "Live mode-ban is teljesen auto, vagy én kattintok ordert?"
**Teljesen auto.** A cron 3 percenként új ordert ad le, ha a decision-engine "shouldTrade=true" döntést hoz. Te csak a paramétereket állítgatod a Settings tabon és az Edge Tracker-t figyeled.

### "Hogyan állítom le ha hibás döntést látok?"
- **Azonnal:** Netlify env vart `PAPER_MODE=true`-ra állítani → ~1 perc redeploy → a következő cron tick paper-ben fut. A nyitott pozíciókat *nem* zárja le, csak új belépést tilt.
- **Open positions zárás manuálisan:** Tab 5 → Polymarket → SELL intent generálás → Python script lefuttatás.
- **Teljes session reset:** `POST /auto-trader { action: "reset" }` → bankroll vissza default-ra, open positions list törlődik (a Polymarket-en lévő pozíciókat NEM zárja le, csak az auto-trader memóriájából tűnnek el).

### "Mi van ha lefagy a Netlify Function futás közben?"
Cron retry van a következő tickre (3 perc múlva). Ha egy buy fillCallback elveszik (live mode), a session-state-ben "PLACED" marad → a következő tick a `checkOrderStatus`-ban tisztázza. **Ez a fő ok, amiért live mode-ban Netlify kockázatosabb mint Hetzner** — egy pozícionált fill amíg meg nem érkezik a state-be, nem védett SL-lel.

### "Polymarket-en mi van ha a 24h piac jellegű market hosszabb mint 5 perc?"
Az entry-window filter a `MarketInfo.openedAtEstimate` mező hiánya esetén
*nem aktiválódik* — ami azt jelenti, hogy hosszabb piacokon (1h, 1 nap, …)
mindenkor be tud lépni a kódba az auto-trader. A TP/SL clamp viszont
mindenhol érvényes. Ha hosszabb piacokra is akarsz ablakszűrőt, a
btc-market-finder.mts `parseDurationMs()` regex felismeri 1h-ig, de az
"5m short market" specifikus tuning a master-plan szerint csak az 5/15
perces piacokra optimális.

---

## Kapcsolódó docs

- `internal-docs/changelog/CHANGELOG-2026-05-08.md` — mai session minden változás
- `internal-docs/migration/hetzner-migration-plan.md` — 7-fázisos action plan szerverre költözéshez
- `CLAUDE.md` "AKTUÁLIS ÁLLAPOT (2026-05-08)" — gyors session-záró összefoglaló
