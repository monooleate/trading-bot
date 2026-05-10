# Beállítások — minden paraméter egy helyen

Ez a fájl referenciának szolgál: minden trader Beállítások tabján
megjelenő paraméter mit csinál, mire érdemes figyelni. A leírások a
backend `trader-settings.mts` SCHEMA-ból jönnek (`help` mező), tehát ez
a fájl + a UI tooltip + az inline kék hint mind ugyanazt a szöveget
tartalmazza — egy forrásból.

A változtatások a következő cron tickben (3 perc) érvénybe lépnek,
redeploy nélkül. A backend range-clamp-eli a min/max-on, az auth gate
csak bejelentkezett user-nek engedi a mentést.

---

## Crypto Auto-Trader (`/trade/crypto/#settings`)

### Risk & sizing

| Paraméter | Default | Mit csinál |
|---|---|---|
| **Edge threshold (net)** | 15% | Csak akkor lép be az auto-trader, ha a kombinált predikció és piaci ár közti `|edge|` (a 3.6% roundtrip fee után) ≥ ez az érték. Magasabb = kevesebb, de jobb minőségű trade. |
| **Max Kelly fraction** | 8% | Egy trade max ekkora bankroll-aránya. A binary piacokon a master-plan 8% hard cap-et javasol; magasabbra állítani csak akkor érdemes ha az IC-d > 0.10. |
| **Cooldown per market** | 300s (5 perc) | Ugyanazon a piacon (slug) hány másodpercet kell várni két entry között. Megakadályozza a re-entry spam-et ha gyors a cron. |
| **Session loss limit** | $20 | Ha a session összesített VESZTESÉG-e (csak a vesztes trade-ek abszolút USD-je) eléri ezt → automatikus stop. Reset-tel indítható újra. |

### BTC short-market exit (P1.2)

| Paraméter | Default | Mit csinál |
|---|---|---|
| **BTC short-market TP** | 0.75 | Take-profit ár: ha a pozíció oldali ár eléri 75¢-et, lezárjuk. A master-plan 5m piacokon átlag $19 helyett $52 veszteséget ment meg. |
| **BTC short-market SL** | 0.35 | Stop-loss ár: ha a pozíció oldali ár 35¢ alá esik, lezárjuk. Élesben szigorúan SL nélkül NE menj — a 5m piacok gyorsan $0-ra eshetnek. |
| **Entry window start** | 60s | A market megnyitása után mennyi ms-tól léphetünk be. <60s = retail zaj és pánik. |
| **Entry window end** | 180s | Meddig léphetünk be a megnyitás után. >180s a 5m piacon = nem lesz idő exitálni TP/SL hit nélkül. |
| **Hold-to-end cutoff** | 60s | Ha kevesebb mint ennyi van resolution-ig, NE zárjuk a pozíciót — hagyjuk lejárni a Polymarket settles-en. |

### OB imbalance (P1.3)

| Paraméter | Default | Mit csinál |
|---|---|---|
| **OB imbalance UP threshold** | 1.80× | Binance top-10 bid/ask depth ratio. Felette → UP irány konfirmált. Magasabb = szigorúbb konvergencia, kevesebb trade. |
| **OB imbalance DOWN threshold** | 0.55× | Bid/ask ratio alsó küszöb. Alatta → DOWN irány konfirmált. 0.55 ≈ inverze az UP threshold-nak (1/1.8). |

### Paper resolver (v2 simulator)

| Paraméter | Default | Mit csinál |
|---|---|---|
| **Paper resolver fallback delay** | 30 min | Mennyi időt várunk a tényleges Polymarket resolution-re a market endDate után, mielőtt a Brownian-bridge szimulátorra esünk vissza. Hosszabb = realisztikusabb paper PnL, de később zárul. |
| **Brownian σ per √min** | 0.45 | A `finalProb`-tól FÜGGETLEN random-walk σ-ja. 0.45 / √min ≈ a Polymarket BTC 5m piacok empirikus volatilitása. Magasabb = nagyobb pnl-szórás. |

### Market finder

| Paraméter | Default | Mit csinál |
|---|---|---|
| **Min YES price (deep-OTM cut)** | 0.10 | Az olyan piacokat skippeljük, ahol a YES ár 0.10 alatt vagy 0.90 felett van — ezeken a depth alig 1-2 share, nem realisztikus paper-ben filltetni. A 141 paper trade $0.01 entry probléma fő javítása. |

---

## Weather Trader (`/trade/weather/#settings`)

### Risk & sizing

| Paraméter | Default | Mit csinál |
|---|---|---|
| **Edge threshold (net)** | 12% | A weather predikció és a Polymarket-ár közti `|edge|` minimum, amitől entry-zünk. Alacsonyabb mint a crypto-é mert a hőmérséklet predikció pontosabb. |
| **Min model confidence** | 65% | A 31-tagú GFS ensemble vagy a single-run forecast confidence-e (mennyire egységes a tagok jóslata). Alatta skippeljük a piacot. |
| **Exit-before window** | 45 min | Hány perccel a market lezárása előtt nem indítunk új pozíciót (slippage és exit nehezedik a végén). |
| **Max position size** | $25 | Egy weather trade max USD értéke. Konzervatív mert a weather edge sokszor nagyobb mint a binary 8% Kelly cap engedne. |
| **Max-edge sanity cap** | 40% | Ha az edge számítás >40%-ot ad, akkor valószínűleg számolási hiba (pl. rossz station temp). Cap-elem hogy ne tegyünk irreális pozíciót. |

### Forecast pipeline

| Paraméter | Default | Mit csinál |
|---|---|---|
| **forecast_days** | 0 (auto) | Mennyi napra előre kérjük le a forecast-ot. 0 = auto (a piac endDate alapján). Manual override csak teszteléshez. |
| **Apply city_offset to forecast** | OFF | Bekapcsolva: a tényleges station vs. lakossági centroid közti hőmérséklet-eltolás (pl. KLGA → NYC) alkalmazza. Nemzetközi piacokon is fontos. |
| **Use 31-member GFS ensemble** | OFF | Bekapcsolva: 31 GFS ensemble tag → P(YES) = (hány tag jósol >= threshold) / 31. Kikapcsolva: csak a control run. Master-plan szerint +15-20% pontosság ensemble-lel. |

### Scheduling

| Paraméter | Default | Mit csinál |
|---|---|---|
| **Enable scheduled cron runs** | OFF | A weather `auto-trader-weather-cron` 5 percenként fut, de csak akkor csinál bármit ha ez a toggle BE van kapcsolva. Default OFF — biztonsági ráhagyás. |

---

## Hyperliquid Perp + Funding Arb (`/trade/hyperliquid/#settings`)

Jelenleg **nincs runtime-állítható paraméter** a Hyperliquid trader-hez — minden
beállítás env varral történik (`HL_TESTNET`, `HL_MAX_PCT_BANKROLL`,
`HL_MAX_LEVERAGE`, `HL_PRIVATE_KEY` stb.). A SettingsPanel a "Ehhez a
kategóriához nincs runtime-állítható paraméter" üzenettel jelez.

A 2026-04-21 óta tartó **0 trade probléma** oka NEM env hiány: a Netlify
cron eddig csak a crypto kategóriát hívta. A 2026-05-09 commit (`auto-
trader-multi-cron.mts`) ezt javítja — `*/3 * * * *` schedule-en
párhuzamosan triggereli a HL Perp-et és a Funding Arb-ot. **A következő
deploy után ki fog gyűlni adat is**, ekkor érdemes lehet az HL paraméterek
runtime-konfigurálását is hozzáadni.

---

## Bybit / Binance / Polymarket Manual

Manuális venue-k, nincs auto-trader → nincsenek paraméterek a Beállítások
tabon. A bejelentkezett user manuálisan ad le ordert a Trade tabon.

A Bybit / Binance API kulcsokat env varok határozzák meg (`BYBIT_API_KEY`,
`BYBIT_API_SECRET`, `BYBIT_TESTNET`, ugyanígy Binance) — ezek nem
runtime-állíthatók a UI-ról, biztonsági okokból.

---

## Hogyan lépnek érvénybe a változások

1. Mentés → a backend Netlify Blobs-ba ír (`trader-settings` store, key
   `runtime-overrides-v1`)
2. A következő cron tick (max 3 perc) → a `runCryptoTrader` belül
   `loadRuntimeOverrides()` hívást csinál → az új értékek érvényesek
3. A UI azonnal frissül a Reset / Refresh gombbal

A redeploy NEM szükséges semmilyen Settings változtatáshoz. A **kivétel**
a Bybit / Binance API kulcsok és a `PAPER_MODE` flag — ezek env varok,
csak Netlify dashboard → Environment variables → Save → auto-redeploy.

---

## Reset alapértékekre

A Beállítások tab tetején van egy `↺ Reset alapértékek` gomb. Ezzel:
1. A backend törli a teljes `runtime-overrides-v1` Blobs entry-t
2. Minden paraméter visszaáll az env-default értékre (vagy a SCHEMA
   `default` mezőjére, ha nincs env)
3. A következő cron tick már a default-okkal fut

Ez NEM ugyanaz mint a `Reset` gomb a trader Auto-Trader tabján — az a
session state-et (bankroll, closedTrades) törli, ez a paraméter override-okat.
