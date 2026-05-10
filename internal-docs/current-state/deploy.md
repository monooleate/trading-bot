# Deploy Guide – EdgeCalc Auto-Trader

Teljes lépés-listás útmutató az auto-trader éles üzembe helyezéséhez.

> ⚠ **Biztonság**: Csak dedikált hot wallet-et használj kis összeggel. Az éles trading valós pénzt mozgat.

---

## Fázis 0 – Előfeltételek

Ez már rendelkezésre áll a projektben:

- [x] Node.js 20+ (`node --version`)
- [x] npm install lefutott (`package-lock.json` jelen)
- [x] Netlify CLI elérhető (`npx netlify --version`)
- [x] Polymarket proxy wallet létezik (polymarket.com email login)
- [x] Polygon hálózati USDC a wallet-en (min. $50 ajánlott kezdésnek)

---

## Fázis 1 – Lokális paper mode teszt (KÖTELEZŐ)

**Cél:** legalább 10+ trading kör hiba nélkül lokálisan, mielőtt éles deploy.

### 1.1 Indítsd el a dev szervert

```bash
cd "C:/dev/trading-bot 2"
npx netlify dev --port 8888
```

### 1.2 Böngészőben

1. Nyisd meg: <http://localhost:8888>
2. Kattints **Crypto** kártyára → `/trade/crypto`
3. **Auto-Trader** tabon kattints "Run Scan"
4. Nézd a "Last Run" eredményeket:
   - ha `"Too few active signals"` vagy `"Edge too small"` → **normális**, a signal endpointok lokálisan gyenge adatot kapnak
   - ha 500-as hiba → nézd a `netlify dev` logot

### 1.3 Edge Tracker ellenőrzés

- `/trade/crypto` → **Edge Tracker** tab
- Ha `isMock: true` banner jelenik meg → még nincs valódi trade history, mock-ot mutat
- Ez OK, a 6 chart + KPI render-elést ellenőrzi

### 1.4 Checklista

- [ ] HomePage `/` renderel, 5 kártya látszik
- [ ] Crypto route `/trade/crypto` 2 tabbal (Auto-Trader + Edge Tracker)
- [ ] Weather route `/trade/weather` 2 tabbal
- [ ] Tools route `/tools` betölti a régi Dashboard-ot 11 tabbal
- [ ] Auto-Trader "Run Scan" működik, JSON választ ad
- [ ] Edge Tracker chartjai renderelnek (akár mock, akár valós)
- [ ] Reset/Stop gomb működik (Session state változik)

---

## Fázis 2 – Netlify deploy (paper mode-ban)

**Cél:** a kód éles Netlify-on fut paper mode-ban, az auto-trader cron minden 3 percben scan-el (nincs éles trade).

### 2.1 Netlify account setup

```bash
# Ha még nem vagy bejelentkezve
npx netlify login

# Ha nincs site linkelve
npx netlify init
# Választás: "Create & configure a new site"
```

### 2.2 Első deploy

```bash
cd "C:/dev/trading-bot 2"
npm run build
npx netlify deploy --prod --dir=dist
```

### 2.3 Environment variables – paper mode

Menj a Netlify dashboard-ra → `Site configuration` → `Environment variables` → **Add variable**:

```env
# Auth (bármikor módosíthatod)
JWT_SECRET=<32+ karakter random string>
AUTH_PASSWORD_HASH=<sha256 hash, lásd alább>

# Auto-trader config – paper mode MARAD első körben
PAPER_MODE=true
SESSION_LOSS_LIMIT=20
MAX_KELLY_FRACTION=0.20
EDGE_THRESHOLD_CRYPTO=0.15
COOLDOWN_SECONDS=300
```

**SHA-256 jelszó hash generálás:**
```bash
node -e "console.log(require('crypto').createHash('sha256').update('IDE_A_JELSZO').digest('hex'))"
```

### 2.4 Redeploy az env vars-szal

```bash
npx netlify deploy --prod --dir=dist
```

Vagy Netlify dashboard → `Deploys` → `Trigger deploy` → `Deploy site`.

### 2.5 Scheduled function verifikáció

A `netlify.toml` már tartalmazza:
```toml
[functions."auto-trader"]
  schedule = "*/3 * * * *"
```

- Deploy után menj: Netlify dashboard → `Functions` → `auto-trader`
- Kellene látnod: `Scheduled: */3 * * * *`
- Nézd a logokat 3-6 perc múlva, meg kell jelenjenek a `SIGNAL`/`DECISION_SKIP` bejegyzések

### 2.6 Checklista

- [ ] `https://<site>.netlify.app` betölt
- [ ] Minden 4 oldal elérhető (/, /trade/crypto, /trade/weather, /tools)
- [ ] Functions tab-on `auto-trader` scheduled badge-dzsel
- [ ] Manual "Run Scan" működik a CryptoTrader UI-ból
- [ ] 30 perc múlva van trade log (NDJSON) a függvény logjaiban
- [ ] Netlify Blobs-ban megjelenik az `auto-trader-state` store

---

## Fázis 3 – Telegram alerts (opcionális de ajánlott)

### 3.1 Bot létrehozás

1. Telegram → keresd: `@BotFather`
2. `/newbot` parancs
3. Adj nevet (pl. "EdgeCalc Alert Bot")
4. Adj username-et (pl. `edgecalc_alert_bot`)
5. Kapsz egy tokent: `1234567890:ABC-DEF1234ghI...`

### 3.2 Chat ID lekérés

1. Írj egy üzenetet a bot-odnak (`Hello`)
2. Nyisd meg böngészőben:
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
3. Keresd: `"chat":{"id":123456789,...}`

### 3.3 Env vars hozzáadás

Netlify dashboard → Environment variables:
```env
TELEGRAM_BOT_TOKEN=1234567890:ABC-DEF1234ghI...
TELEGRAM_CHAT_ID=123456789
```

Redeploy után a paper trade-ek is kapnak `🟢 TRADE OPEN [PAPER]` üzeneteket.

---

## Fázis 4 – Élő trading (LIVE MODE)

> ⚠ **FIGYELEM**: ezután valós pénzt kezel. Csak akkor folytasd ha:
> - Legalább 50+ paper trade lefutott
> - Az Edge Tracker kalibráció jó (deviation < 0.07)
> - Sharpe > 1.0
> - Kalibráció chartok a 45°-os egyenesen

### 4.1 Polymarket wallet setup

1. **Dedikált hot wallet**: ne használd a fő wallet-edet. Kreálj egy újat pl. MetaMask-ban.
2. Küldj rá csak annyi USDC-t amennyit **készen állsz elveszíteni** (javasolt: $50)
3. Menj polymarket.com → email login ezzel a wallet-tel
4. A Polymarket dashboardon látod a **proxy wallet address**-edet → ez lesz `POLY_FUNDER_ADDRESS`
5. MetaMask → Export Private Key → **SOHA ne commitold, ne oszd meg, ne küldd senkinek**

### 4.2 Live mode env vars

Netlify Environment variables → **add új változókat**:
```env
POLY_PRIVATE_KEY=0x<64 hex karakter>
POLY_FUNDER_ADDRESS=0x<proxy wallet 40 hex>
POLY_SIGNATURE_TYPE=1
PAPER_MODE=false
```

⚠ **`PAPER_MODE=false` bekapcsolása után a cron valós trade-eket fog nyitni.**

### 4.3 Redeploy

```bash
npx netlify deploy --prod --dir=dist
```

### 4.4 Első valós trade monitor

Az első 1 órában:
- Nézd a Telegram alerteket (ha bekötötted)
- Nézd a Netlify Functions log-ot
- Nézd a Polymarket dashboard-odat: megjelennek-e az ordereid
- Ha bármi furcsa → **azonnal `PAPER_MODE=true` vissza** env var-ban, redeploy

### 4.5 Risk management beállítások (kezdő)

```env
SESSION_LOSS_LIMIT=10     # $10 napi max loss (kis kezdésnek)
MAX_KELLY_FRACTION=0.10   # max 10% bankroll per trade (óvatos)
EDGE_THRESHOLD_CRYPTO=0.18  # 18% — csak nagyon biztos trade-ek
```

Idővel lazíthatsz (0.20 Kelly, 15% edge), ha bizonyított a stratégia.

---

## Fázis 5 – Monitoring és iteráció

### 5.1 Napi ellenőrzés

- [ ] Edge Tracker `/trade/crypto` → Edge Tracker tab → `days=7`
  - Van-e valódi kumulatív PnL a random baseline felett?
  - Kalibráció chart: pontok a 45° körül?
  - Signal IC: legalább 1 szignál > 0.05?
- [ ] Telegram alertek: van-e anomália?
- [ ] Polymarket dashboard: stuck order-ek?

### 5.2 Havi ellenőrzés

- [ ] Edge decay chart: csökkenő trend?
- [ ] Max Drawdown: kezelhető maradt?
- [ ] Kelly efficiency: 0.8-1.2 között?

### 5.3 Vészstop

```bash
# Azonnali leállítás a UI-ból:
# → /trade/crypto → Auto-Trader → Stop gomb
# → /trade/weather → Weather Trader → Stop gomb

# Vagy env var-ból:
# Netlify dashboard → Environment variables → PAPER_MODE=true → redeploy
```

---

## Függelék A – Költségek

| Tétel | Költség |
|-------|---------|
| Netlify free tier | $0 (125k function invocation/hó, auto-trader ~14k/hó cron) |
| Netlify Blobs | $0 (1GB ingyen, bőven elég session state-nek) |
| Polygon gas | ~$0.01 / trade |
| Polymarket taker fee | 1.8% (már benne van az edge threshold-ban) |
| USDC kezdő tőke | $50-100 javasolt |

---

## Függelék B – Hibaelhárítás

### "Session stopped: Manual stop"
→ UI-ban kattints **Reset** gombra, vagy API hívás:
```bash
curl -X POST "https://<site>/.netlify/functions/auto-trader-api" \
  -H "Content-Type: application/json" \
  -d '{"action":"reset","category":"crypto"}'
```

### "No active BTC Up/Down markets found"
→ Normális. A Polymarket BTC up/down piacok rövid távúak, időnként nincs aktív. Várj.

### "Buy order not filled"
→ Az ár elmozdult a limit order elől. A rendszer később újrapróbálja, vagy a cooldown után új piacra mozdul.

### Éles trade nem jelenik meg
→ Ellenőrizd:
1. `PAPER_MODE=false` van-e beállítva
2. `POLY_PRIVATE_KEY` helyes-e (64 hex char 0x-szel kezdődve)
3. `POLY_FUNDER_ADDRESS` egyezik-e a Polymarket dashboard-ján levővel
4. Van-e USDC a wallet-en (min. pozícióméret + gas)

### Netlify function timeout
→ A 10s limit kevés lehet a signal aggregatornak. Ha gyakori: egyszerűsítsd a `signal-aggregator.mts`-t vagy növeld a timeout-ot a Netlify dashboard-on (pro plan kell).

---

## Függelék C – Env vars teljes lista

```env
# Auth (védett function-ökhöz)
JWT_SECRET=
AUTH_PASSWORD_HASH=

# Polymarket (LIVE mode-hoz)
POLY_PRIVATE_KEY=
POLY_FUNDER_ADDRESS=
POLY_SIGNATURE_TYPE=1

# Auto-trader config
PAPER_MODE=true
SESSION_LOSS_LIMIT=20
MAX_KELLY_FRACTION=0.20
EDGE_THRESHOLD_CRYPTO=0.15
COOLDOWN_SECONDS=300

# Weather trader config
WEATHER_EDGE_THRESHOLD=0.12
WEATHER_CONFIDENCE_MIN=0.65
WEATHER_EXIT_BEFORE_MIN=45
WEATHER_MAX_POSITION_USD=25

# Monitoring (opcionális)
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# LLM (meglévő EdgeCalc endpointokhoz)
ANTHROPIC_API_KEY=
```

---

## Támogatott categories és állapotok

| Category | Status | Auto | Min Edge | Fee | Jegyzet |
|----------|--------|------|----------|-----|---------|
| Crypto   | ✅ READY | IGEN | 15% net | 1.8% | BTC up/down piacok |
| Weather  | ✅ READY | IGEN | 12% net | 1.0% | GFS+ECMWF, ritka piacok |
| Sports   | 🚧 ALERT | NEM | – | 0.6% | Sprint 2 |
| Politics | 🚧 ALERT | NEM | – | ~1% | Sprint 3 |
| Macro    | 🚧 ALERT | NEM | – | ~? | Sprint 4 |

---

*Utolsó frissítés: 2026-04-14*
