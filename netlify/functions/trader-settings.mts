// netlify/functions/trader-settings.mts
//
// Auth-protected runtime override store for the auto-trader engine.
// GET  → returns the current effective config (env defaults merged with
//        any saved overrides) plus the per-field allowed range.
// POST → validates, clamps, and persists overrides into Netlify Blobs.
//
// Why a runtime store rather than env vars:
//   - Tuning during paper testing without redeploys
//   - One source of truth shared by every cron tick of the trader
// Why auth-protected:
//   - These knobs change real money behaviour. Only the JWT-authed owner
//     can change them. Anonymous reads via GET return *defaults only*
//     (never expose currently-active live overrides without auth).

import type { Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { checkAuth } from "./_auth-guard.ts";
import { CORS, getTraderConfig, getBtcExitConfig } from "./auto-trader/shared/config.mts";

const STORE_NAME = "trader-settings";
const KEY = "runtime-overrides-v1";

// ─── Schema: each editable field has a default range and a hard min/max ─

type Category = "crypto" | "weather" | "hyperliquid" | "funding-arb" | "sports" | "common";

interface FieldSpec {
  default: number;
  min: number;
  max: number;
  label: string;
  step: number;
  unit: string;
  category: Category;
  group: string;            // sub-section title inside the per-category page
  help?: string;            // one-sentence explanation rendered as tooltip + inline hint
}

const SCHEMA: Record<string, FieldSpec> = {
  edgeThreshold:        { default: 0.15,    min: 0.02,    max: 0.30,    label: "Edge threshold (net)",       step: 0.005, unit: "frac",  category: "crypto", group: "Risk & sizing", help: "Csak akkor lép be az auto-trader, ha a kombinált predikció és piaci ár közti |edge| (a 3.6% roundtrip fee után) ≥ ez az érték. Magasabb = kevesebb, de jobb minőségű trade." },
  maxKellyFraction:     { default: 0.08,    min: 0.01,    max: 0.25,    label: "Max Kelly fraction",         step: 0.005, unit: "frac",  category: "crypto", group: "Risk & sizing", help: "Egy trade max ekkora bankroll-aránya. A binary piacokon a master-plan 8% hard cap-et javasol; magasabbra állítani csak akkor érdemes ha az IC-d > 0.10." },
  cooldownSeconds:      { default: 300,     min: 30,      max: 3600,    label: "Cooldown per market",        step: 30,    unit: "sec",   category: "crypto", group: "Risk & sizing", help: "Ugyanazon a piacon (slug) hány másodpercet kell várni két entry között. Megakadályozza a re-entry spam-et ha gyors a cron." },
  sessionLossLimit:     { default: 20,      min: 5,       max: 1000,    label: "Session loss limit",         step: 5,     unit: "USD",   category: "crypto", group: "Risk & sizing", help: "Ha a session összesített VESZTESÉG-e (csak a vesztes trade-ek abszolút USD-je) eléri ezt → automatikus stop. Reset-tel indítható újra." },
  btcTpTarget:          { default: 0.75,    min: 0.55,    max: 0.95,    label: "BTC short-market TP",        step: 0.01,  unit: "price", category: "crypto", group: "BTC short-market exit", help: "Take-profit ár: ha a pozíció oldali ár eléri ezt, lezárjuk. 0.75 = 75¢ — a master-plan 5m piacokon átlag $19 helyett $52 veszteséget ment meg." },
  btcSlTarget:          { default: 0.35,    min: 0.05,    max: 0.45,    label: "BTC short-market SL",        step: 0.01,  unit: "price", category: "crypto", group: "BTC short-market exit", help: "Stop-loss ár: ha a pozíció oldali ár ez alá esik, lezárjuk. Élesben szigorúan SL nélkül NE menj — a 5m piacok gyorsan $0-ra eshetnek." },
  btcEntryWindowStartMs:{ default: 60000,   min: 0,       max: 600000,  label: "Entry window start",         step: 5000,  unit: "ms",    category: "crypto", group: "BTC short-market exit", help: "A market megnyitása után mennyi ms-tól léphetünk be. <60s = retail zaj és pánik, ne lépj be." },
  btcEntryWindowEndMs:  { default: 180000,  min: 30000,   max: 900000,  label: "Entry window end",           step: 5000,  unit: "ms",    category: "crypto", group: "BTC short-market exit", help: "Meddig léphetünk be a megnyitás után. >180s a 5m piacon = nem lesz idő exitálni TP/SL hit nélkül." },
  btcHoldToEndCutoffMs: { default: 60000,   min: 10000,   max: 300000,  label: "Hold-to-end cutoff",         step: 5000,  unit: "ms",    category: "crypto", group: "BTC short-market exit", help: "Ha kevesebb mint ennyi ms van resolution-ig, NE zárjuk a pozíciót — hagyjuk lejárni (a Polymarket settles-en pörög le)." },
  obImbalanceUpRatio:   { default: 1.80,    min: 1.10,    max: 5.00,    label: "OB imbalance UP threshold",  step: 0.05,  unit: "ratio", category: "crypto", group: "OB imbalance", help: "Binance top-10 bid/ask depth ratio. Felette → UP irány konfirmált. Magasabb = szigorúbb konvergencia, kevesebb trade." },
  obImbalanceDownRatio: { default: 0.55,    min: 0.20,    max: 0.95,    label: "OB imbalance DOWN threshold",step: 0.05,  unit: "ratio", category: "crypto", group: "OB imbalance", help: "Bid/ask ratio alsó küszöb. Alatta → DOWN irány konfirmált. 0.55 = kb. inverze az UP threshold-nak (1/1.8)." },
  // Paper-resolver knobs (paperFallbackAfterMs, paperBrownianSigma)
  // were retired in simVersion 3 — paper closes only on real Polymarket
  // resolution, no simulator. Old Blobs overrides are silently ignored
  // by `loadRuntimeOverrides()` since the keys are no longer in SCHEMA.
  btcMinPriceBand:      { default: 0.10,    min: 0.02,    max: 0.30,    label: "Min YES price (deep-OTM cut)", step: 0.01, unit: "frac", category: "crypto", group: "Market finder", help: "Az olyan piacokat skippeljük, ahol a YES ár 0.10 alatt vagy 0.90 felett van — ezeken a depth alig 1-2 share, nem realisztikus paper-ben filltetni. A 141 paper trade $0.01 entry probléma fő javítása." },
  // ─── Decision-engine gate knobs (2026-05-11 audit fixes) ─────────
  // The legacy $1 minimum position size silently padded sub-Kelly sizes
  // up to $1 — a 13× over-sizing for 0.03% Kelly fractions on a $250
  // paper bankroll. Now an explicit gate. Set this low enough that a
  // legitimate ¼-Kelly entry on the paper bankroll clears it, but high
  // enough to reject combiner-noise-level convictions.
  minPositionSizeUSDC:  { default: 0.50,    min: 0.10,    max: 50,      label: "Min position size",            step: 0.05, unit: "USD",  category: "crypto", group: "Risk & sizing", help: "Minimum abszolút USD méret. Ha a ¼-Kelly × bankroll ez alá esik, a bot SKIP-pel (nem padding-eli fel $1-re). Default $0.50 = 0.2% $250 paper bankrollon — a 8% Kelly cap-en belül." },
  // Combiner convergence threshold. Mirrors the signal-combiner's own
  // recommend() WAIT gate so the engine doesn't trade on noise-level
  // combiner outputs (the 8 raw signals all default to 0.5 when absent;
  // their weighted average converges to 0.5 without real input).
  combinerConfidenceMin:{ default: 0.05,    min: 0.01,    max: 0.20,    label: "Combiner confidence min",      step: 0.005, unit: "frac", category: "crypto", group: "Risk & sizing", help: "Minimum |finalProb − 0.5| amitől a combiner outputot 'signal'-nek és nem zajnak vesszük. Megegyezik a signal-combiner saját recommend() WAIT-küszöbével (5%)." },
  cryptoMaxOpenPositions:{ default: 5,      min: 1,       max: 20,      label: "Max open positions",           step: 1,     unit: "n",    category: "crypto", group: "Risk & sizing", help: "Egyszerre max ennyi nyitott crypto paper pozíció. Védi a bankroll-t a túlexpozíciótól ha sok piac van egyszerre nyitva. 5 default = $250 paper-en bőven elég." },
  // ─── Live-readiness gates (apply to every trader) ──────────────
  // The cron loop refuses to honor PAPER_MODE=false until a session has
  // accumulated enough validated paper data. Every trader (crypto,
  // weather, hyperliquid, funding-arb) reads these knobs from the same
  // store, so a single tuning surface drives the live-go decision.
  liveReadyMinTrades:      { default: 30,   min: 10,   max: 300,  label: "Min closed trades",         step: 5,    unit: "n",     category: "common", group: "Live readiness", help: "Minimum lezárt paper trade-ek száma, amik kellenek a live aktiváláshoz. 30 = statisztikailag értelmes, 100+ = magas konfidencia." },
  liveReadyMinWinRate:     { default: 0.50, min: 0.30, max: 0.80, label: "Min win rate",              step: 0.01, unit: "frac",  category: "common", group: "Live readiness", help: "Minimum win-ráta a paper történetben. 0.50 = positive expectancy minimum (a fees miatt valójában >0.52 kell hogy a stratégia valós profitot termeljen)." },
  liveReadyMinIC:          { default: 0.05, min: 0.01, max: 0.30, label: "Min top-signal |IC|",       step: 0.01, unit: "frac",  category: "common", group: "Live readiness", help: "A legmagasabb |IC| signal Pearson-korrelációja a tényleges win/loss kimenetelekkel. 0.05 = értelmes prediktív erő, 0.10+ = erős. Csak crypto + weather-re alkalmazható (funding-arb rate-driven)." },
  liveReadyMaxCalibDev:    { default: 0.07, min: 0.01, max: 0.30, label: "Max calibration deviation", step: 0.01, unit: "frac",  category: "common", group: "Live readiness", help: "A predicted-prob és tényleges-win-rate átlagos eltérése bucket-enként. <0.07 = a model jól kalibrált. Csak crypto + weather-re." },
  liveReadyMinSharpe:      { default: 0.5,  min: 0,    max: 5.0,  label: "Min Sharpe ratio",          step: 0.05, unit: "ratio", category: "common", group: "Live readiness", help: "Per-trade kockázat-igazított hozam minimum. 0.5 = elfogadható, 1.0+ = jó, 2.0+ = kiváló (általában gyanús kis mintán)." },
  liveReadyMaxDrawdownPct: { default: 25,   min: 5,    max: 80,   label: "Max drawdown %",            step: 1,    unit: "pct",   category: "common", group: "Live readiness", help: "Maximum megengedett drawdown a kezdő bankrollhoz képest. >25% = a stratégia túl volatilis a live-hoz, csökkenteni kell a Kelly fraction-t vagy szigorítani a signal filtereket." },
  // ─── Weather trader knobs ──────────────────────────────────────
  weatherEdgeThreshold:   { default: 0.12, min: 0.02, max: 0.40, label: "Edge threshold (net)",          step: 0.005, unit: "frac", category: "weather", group: "Risk & sizing", help: "A weather predikció és a Polymarket-ár közti |edge| minimum, amitől entry-zünk. Alacsonyabb mint a crypto-é mert a hőmérséklet predikció pontosabb." },
  weatherConfidenceMin:   { default: 0.65, min: 0.30, max: 0.95, label: "Min model confidence",          step: 0.01,  unit: "frac", category: "weather", group: "Risk & sizing", help: "A 31-tagú GFS ensemble vagy a single-run forecast confidence-e (mennyire egységes a tagok jóslata). Alatta skippeljük a piacot." },
  weatherExitBeforeMin:   { default: 45,   min: 10,   max: 240,  label: "Exit-before window",            step: 5,     unit: "min",  category: "weather", group: "Risk & sizing", help: "Hány perccel a market lezárása előtt nem indítunk új pozíciót (slippage és exit nehezedik a végén)." },
  weatherMaxPositionUSD:  { default: 25,   min: 5,    max: 500,  label: "Max position size",             step: 5,     unit: "USD",  category: "weather", group: "Risk & sizing", help: "Egy weather trade max USD értéke. Konzervatív ($25 default) mert a weather edge sokszor nagyobb mint a binary 8% Kelly cap engedne." },
  weatherMaxEdgeCap:      { default: 0.40, min: 0.10, max: 0.95, label: "Max-edge sanity cap",           step: 0.01,  unit: "frac", category: "weather", group: "Risk & sizing", help: "Ha az edge számítás >40%-ot ad, akkor valószínűleg számolási hiba (pl. rossz station temp). Cap-elem hogy ne tegyünk irreális pozíciót." },
  weatherForecastDays:    { default: 0,    min: 0,    max: 7,    label: "forecast_days (0 = auto)",      step: 1,     unit: "days", category: "weather", group: "Forecast pipeline", help: "Mennyi napra előre kérjük le a forecast-ot. 0 = auto (a piac endDate alapján számolva). Manual override csak teszteléshez." },
  weatherApplyCityOffset: { default: 0,    min: 0,    max: 1,    label: "Apply city_offset to forecast", step: 1,     unit: "bool", category: "weather", group: "Forecast pipeline", help: "Bekapcsolva: a tényleges station vs. lakossági centroid közti hőmérséklet-eltolás (pl. KLGA → NYC) alkalmazza. Nemzetközi piacokon is fontos." },
  weatherUseEnsemble:     { default: 1,    min: 0,    max: 1,    label: "Use 31-member GFS ensemble",    step: 1,     unit: "bool", category: "weather", group: "Forecast pipeline", help: "Default ON (2026-05-11): 31 GFS ensemble tag → P(YES) = (hány tag jósol >= threshold) / 31, empirikus σ. Kikapcsolva csak a control run + hardcoded σ=1.0/1.5. Az ensemble adatok elérhetők az Open-Meteo ensemble API-n." },
  weatherCronEnabled:     { default: 0,    min: 0,    max: 1,    label: "Enable scheduled cron runs",    step: 1,     unit: "bool", category: "weather", group: "Scheduling", help: "A weather auto-trader-weather-cron 5 percenként fut, de csak akkor csinál bármit ha ez a toggle BE van kapcsolva. Default OFF — biztonsági ráhagyás." },
  weatherMarketDisagreeMaxC: { default: 2.0, min: 0.5, max: 5.0, label: "Max market disagreement",       step: 0.1,   unit: "°C",   category: "weather", group: "Risk & sizing", help: "Skip a trade-et ha a bot predikciója >ennyi °C-kal eltér a piac modális (legmagasabban árazott) bucketjétől. Lényeg: a >2°C disagreement gyakran model hiba (rossz station, stale forecast), nem alfa. 2.0 = ~3.6°F = általában 1-2 bucket spread." },
  weatherMaxOpenPositions:   { default: 5,    min: 1,   max: 20,  label: "Max open positions",            step: 1,     unit: "n",    category: "weather", group: "Risk & sizing", help: "Egyszerre max ennyi nyitott weather pozíció. 5 default = a 8-10 város × 5-7 nap × 8 bucket-ből bőven elég jó konvergens fogadásra." },
  // ─── Tier 1 (32. session) belső konstansok expose-olva ──────────────
  // A Black-Scholes vol_divergence + collinearity matrix + Bonferroni IC
  // threshold számára. Default = a Tier 1 hardcoded értékei, vagyis a
  // beállítások felülírása nélkül a viselkedés változatlan.
  bonferroniAlpha:           { default: 0.05, min: 0.01, max: 0.20, label: "Bonferroni familywise α",       step: 0.005, unit: "frac", category: "common", group: "IC threshold (Bonferroni)", help: "A Calibration Health küszöbök familywise hibarátája. Per-signal α = familywise / signal_count. Magasabb = enyhébb live-readiness gate (több livr-szignál átmegy)." },
  bonferroniGoodMultiplier:  { default: 2.0,  min: 1.0,  max: 4.0,  label: "Bonferroni 'good' multiplier",  step: 0.1,   unit: "ratio", category: "common", group: "IC threshold (Bonferroni)", help: "A 'good' küszöb = z × SE × multiplier. Default 2.0 = két SE. Magasabb = szigorúbb 'good' status. A 'weak' küszöb mindig 1×, a 'noise' < 1×." },
  collinearityHighThreshold: { default: 0.7,  min: 0.5,  max: 0.95, label: "Collinearity high-pair |ρ|",    step: 0.05,  unit: "ratio", category: "common", group: "Signal collinearity", help: "Az Edge Tracker collinearity-mátrix highPairs listájába azok a párok kerülnek, ahol |ρ| > ez. Csak observability, NEM gate. Magasabb = csak az extrém kollineáris párok kerülnek figyelmeztetésbe." },
  volSignalEnabled:          { default: 1,    min: 0,    max: 1,    label: "Black-Scholes vol_divergence ON", step: 1,   unit: "bool", category: "crypto", group: "Signal toggles", help: "Default ON (Tier 1 redesign): N(d₂) digital pricing aktív 5m/15m BTC piacokon. Kikapcsolva → getVolSignal mindig null-t ad, a 8-jelzéses combiner 7 jelre megy. Csak akkor kapcsold ki, ha a paper-validáció után az IC noise marad." },
  volStrikeFetchEnabled:     { default: 1,    min: 0,    max: 1,    label: "Strike-price fetch (Binance kline)", step: 1, unit: "bool", category: "crypto", group: "Signal toggles", help: "Default ON: a piac openedAt-jére fetcheli a BTC árat (Binance 1m kline) hogy K = S₀. Kikapcsolva → K = S fallback (ATM), fairYes ≈ 0.5 minden piacon → semleges signal. Latency-trade-off: 1 extra Binance call signal-onként." },
  // ─── Hyperliquid Perp knobs ─────────────────────────────────────
  hlEdgeThresholdPaper:      { default: 0.12, min: 0.02,  max: 0.40,     label: "Edge threshold (paper)",       step: 0.005, unit: "frac",  category: "hyperliquid", group: "Risk & sizing", help: "Minimum |signal.edge| amitől paper módban entry-zünk HL perp-be. A live küszöb külön állítható; alacsonyabb paper = több paper trade IC-validáláshoz." },
  hlEdgeThresholdLive:       { default: 0.18, min: 0.05,  max: 0.50,     label: "Edge threshold (live)",        step: 0.005, unit: "frac",  category: "hyperliquid", group: "Risk & sizing", help: "Live módban szigorúbb küszöb (default 18%) — csak akkor lépünk be valós tőkével ha a signal egyértelmű." },
  hlMaxLeverage:             { default: 3,    min: 1,     max: 10,       label: "Max leverage",                 step: 0.5,   unit: "ratio", category: "hyperliquid", group: "Risk & sizing", help: "Maximum tőkeáttétel. Default 3× a konzervatív perp standard; >5× csak akkor ha az IC-d kimutathatóan >0.10 + a session Sharpe >1.0." },
  hlVolGateRvPct:            { default: 120,  min: 50,    max: 300,      label: "Volatility gate (RV %)",       step: 5,     unit: "pct",   category: "hyperliquid", group: "Risk & sizing", help: "Skip a trade-et ha a realized volatility (annualized) ennél magasabb. Védi a botot a flash-crash + funding-spike eseményektől." },
  hlConsecutiveLossLimit:    { default: 3,    min: 1,     max: 10,       label: "Consecutive loss limit",       step: 1,     unit: "n",     category: "hyperliquid", group: "Risk & sizing", help: "Ennyi egymás utáni loss után a session 1 órára szünetel. Anti-revenge guard." },
  hlSessionLossLimit:        { default: 50,   min: 10,    max: 500,      label: "Session loss limit",           step: 5,     unit: "USD",   category: "hyperliquid", group: "Risk & sizing", help: "A session összesített vesztesége nem érheti el ezt — auto-stop. Reset-tel indítható újra." },
  hlCooldownSeconds:         { default: 300,  min: 60,    max: 3600,     label: "Per-coin cooldown",            step: 30,    unit: "sec",   category: "hyperliquid", group: "Risk & sizing", help: "Ugyanazon a coin-on (BTC/ETH/SOL) mennyi mp kell két entry között." },
  hlMaxOpenPositions:        { default: 3,    min: 1,     max: 10,       label: "Max open positions",           step: 1,     unit: "n",     category: "hyperliquid", group: "Risk & sizing", help: "Egyszerre max ennyi nyitott HL perp. >3 = nehéz kézzel monitorolni." },
  // ─── Funding Arb knobs ──────────────────────────────────────────
  frMinSpreadHourly:         { default: 0.0001, min: 0.00001, max: 0.005, label: "Min spread (hourly)",         step: 0.00005, unit: "frac", category: "funding-arb", group: "Risk & sizing", help: "Minimum HL/Binance funding rate különbség óránként amitől entry-zünk. 0.0001 = 0.01%/h = ~88%/yr break-even reverse." },
  frMinOpenInterestUSD:      { default: 5000000, min: 1000000, max: 100000000, label: "Min open interest",       step: 500000,  unit: "USD",  category: "funding-arb", group: "Risk & sizing", help: "Minimum HL OI a coin-on ($M-ban). Védi a botot a vékony piacoktól ahol a slippage felemészti a spread-et." },
  frMaxHoldDays:             { default: 14,   min: 1,     max: 60,       label: "Max hold (days)",              step: 1,     unit: "days",  category: "funding-arb", group: "Risk & sizing", help: "Ennyi nap után zárjuk a pozíciót függetlenül a spread-től. Védi a botot a stale-positionoktól (pl. funding regime váltás után)." },
  frMaxCapitalPct:           { default: 0.40, min: 0.05,  max: 0.80,     label: "Max capital allocated",        step: 0.05,  unit: "frac",  category: "funding-arb", group: "Risk & sizing", help: "A bankroll maximum hány %-a lehet egyszerre arb pozíciókban. 40% default = még marad room a HL perp + crypto bot számára." },
  frMaxOpenPositions:        { default: 3,    min: 1,     max: 10,       label: "Max open positions",           step: 1,     unit: "n",     category: "funding-arb", group: "Risk & sizing", help: "Egyszerre max ennyi nyitott arb pozíció. >3 = kézzel nehéz monitorolni, és a kapcsolt HL bankroll túl gyorsan felemésztődik." },
  // ─── Sports knobs ───────────────────────────────────────────────
  sportsEdgeThreshold:       { default: 0.10, min: 0.02,  max: 0.40,     label: "Edge threshold (net)",         step: 0.005, unit: "frac",  category: "sports", group: "Risk & sizing", help: "Pinnacle-derived true probability és Polymarket-ár közti minimum edge fee után." },
  sportsMaxPositionUSD:      { default: 20,   min: 2,     max: 200,      label: "Max position size",            step: 1,     unit: "USD",   category: "sports", group: "Risk & sizing", help: "Egy sports trade max USD értéke." },
  sportsMaxOpenPositions:    { default: 3,    min: 1,     max: 15,       label: "Max open positions",           step: 1,     unit: "n",     category: "sports", group: "Risk & sizing", help: "Egyszerre max ennyi nyitott sports pozíció. Default 3 — a hosszú-lejáratú piacok különben hetekig blokkolják a slot-okat." },
  sportsMinHoursToEnd:       { default: 2,    min: 0,     max: 72,       label: "Min hours to end-date",        step: 1,     unit: "h",     category: "sports", group: "Market filter", help: "Csak olyan piacokat fogad el, ahol legalább ennyi óra van a settlement-ig. Védi a botot az utolsó-pillanat liquidity-drop-tól." },
  sportsMaxHoursToEnd:       { default: 72,   min: 6,     max: 8760,     label: "Max hours to end-date",        step: 6,     unit: "h",     category: "sports", group: "Market filter", help: "Csak olyan piacokat fogad el, ahol nem több mint ennyi óra van a settlement-ig. Default 72h (3 nap) = a 3 open slot 3 napon belül felszabadul. Növeld ha hosszabb-lejáratú edge-eket akarsz (pl. season-long futures), csökkentsd ha csak match-day moneyline kell." },
};

// ─── Preset definitions ───────────────────────────────────────────────
//
// Per-bot preset bundles. Each preset is a partial map of field → value,
// applied via POST in the same body shape as a manual save. The Loose
// preset is meant for the early calibration phase where the operator
// wants more paper trades to land in the IC sample; Strict is for the
// post-live-go state where we only trade convergent signals.
//
// Descriptions are surfaced verbatim on the UI button tooltips so the
// operator can decide without leaving the page.

export interface PresetDefinition {
  label: string;          // short button label (e.g. "Lazább")
  description: string;    // tooltip / under-button hint
  values: Record<string, number>;
}

export interface CategoryPresets {
  loose:  PresetDefinition;
  normal: PresetDefinition;
  strict: PresetDefinition;
}

export const PRESETS: Record<string, CategoryPresets> = {
  crypto: {
    loose: {
      label: "Lazább",
      description: "Több paper trade az IC kalibrációhoz. A 2026-05-12 stagnáció oka: combiner confidence gate (5%) blokkolt mindent — itt 2%-ra lazítunk. Kisebb edge-küszöb + alacsonyabb min position size + alacsonyabb min OI. Csak paper módra ajánlott.",
      values: {
        edgeThreshold:         0.08,
        combinerConfidenceMin: 0.02,
        minPositionSizeUSDC:   0.20,
        maxKellyFraction:      0.05,
        sessionLossLimit:      30,
        cooldownSeconds:       180,
        cryptoMaxOpenPositions: 8,
        bonferroniAlpha:       0.10,  // enyhébb live-gate
      },
    },
    normal: {
      label: "Normál",
      description: "Az audit-validált default értékek (2026-05-11 12-gates rendszer). Combiner confidence 5%, edge 15%, ¼-Kelly + 8% cap. Ezzel mentünk a friss simV3 paper validációba.",
      values: {
        edgeThreshold:         0.15,
        combinerConfidenceMin: 0.05,
        minPositionSizeUSDC:   0.50,
        maxKellyFraction:      0.08,
        sessionLossLimit:      20,
        cooldownSeconds:       300,
        cryptoMaxOpenPositions: 5,
        bonferroniAlpha:       0.05,
      },
    },
    strict: {
      label: "Szigorú",
      description: "Csak a magas-konvergencia trade-ek. Edge ≥25%, combiner confidence ≥10%, min pozíció $2, Kelly cap 5%. Live-readiness elérése után ajánlott — kevés, de magas-konfidencia trade.",
      values: {
        edgeThreshold:         0.25,
        combinerConfidenceMin: 0.10,
        minPositionSizeUSDC:   2.00,
        maxKellyFraction:      0.05,
        sessionLossLimit:      15,
        cooldownSeconds:       600,
        cryptoMaxOpenPositions: 3,
        bonferroniAlpha:       0.02,  // szigorúbb live-gate
      },
    },
  },
  weather: {
    loose: {
      label: "Lazább",
      description: "Több paper trade: edge 6%, confidence 50%, market-disagreement 3°C tolerancia. Sanity cap 60%. Új city-k indításához vagy a calibrációs sample bővítéséhez ajánlott.",
      values: {
        weatherEdgeThreshold:    0.06,
        weatherConfidenceMin:    0.50,
        weatherMarketDisagreeMaxC: 3.0,
        weatherMaxEdgeCap:       0.60,
        weatherExitBeforeMin:    30,
        weatherMaxPositionUSD:   15,
        weatherMaxOpenPositions: 8,
      },
    },
    normal: {
      label: "Normál",
      description: "Edge 12%, confidence 65%, disagreement 2°C, sanity cap 40%. A 2026-05-11 audit-validált default — ezzel mentünk élesbe a 31-tagú GFS ensemble-lel.",
      values: {
        weatherEdgeThreshold:    0.12,
        weatherConfidenceMin:    0.65,
        weatherMarketDisagreeMaxC: 2.0,
        weatherMaxEdgeCap:       0.40,
        weatherExitBeforeMin:    45,
        weatherMaxPositionUSD:   25,
        weatherMaxOpenPositions: 5,
      },
    },
    strict: {
      label: "Szigorú",
      description: "Edge ≥20%, confidence ≥80%, disagreement ≤1.5°C, sanity cap 30%. Csak a magas-konvergencia trade-ek (extrém hideg/meleg piacok ahol az ensemble σ < 1°C).",
      values: {
        weatherEdgeThreshold:    0.20,
        weatherConfidenceMin:    0.80,
        weatherMarketDisagreeMaxC: 1.5,
        weatherMaxEdgeCap:       0.30,
        weatherExitBeforeMin:    60,
        weatherMaxPositionUSD:   40,
        weatherMaxOpenPositions: 3,
      },
    },
  },
  hyperliquid: {
    loose: {
      label: "Lazább",
      description: "Paper edge 8%, max leverage 5×, vol gate 150% — több paper sample az IC-méréshez. Csak paper módra; a live edge továbbra is 12%-on marad.",
      values: {
        hlEdgeThresholdPaper:   0.08,
        hlEdgeThresholdLive:    0.12,
        hlMaxLeverage:          5,
        hlVolGateRvPct:         150,
        hlConsecutiveLossLimit: 5,
        hlSessionLossLimit:     75,
        hlCooldownSeconds:      180,
      },
    },
    normal: {
      label: "Normál",
      description: "Paper 12%, live 18%, leverage 3×, vol gate 120%. A 2026-05-10 audit default — TP/SL clamp + paper-vol gate parity.",
      values: {
        hlEdgeThresholdPaper:   0.12,
        hlEdgeThresholdLive:    0.18,
        hlMaxLeverage:          3,
        hlVolGateRvPct:         120,
        hlConsecutiveLossLimit: 3,
        hlSessionLossLimit:     50,
        hlCooldownSeconds:      300,
      },
    },
    strict: {
      label: "Szigorú",
      description: "Paper 18%, live 25%, leverage 2×, vol gate 90%. Csak a magas-konvergencia perp trade-ek — live-readiness elérése után ajánlott.",
      values: {
        hlEdgeThresholdPaper:   0.18,
        hlEdgeThresholdLive:    0.25,
        hlMaxLeverage:          2,
        hlVolGateRvPct:         90,
        hlConsecutiveLossLimit: 2,
        hlSessionLossLimit:     30,
        hlCooldownSeconds:      600,
      },
    },
  },
  "funding-arb": {
    loose: {
      label: "Lazább",
      description: "Spread ≥0.005%/h (~43%/yr), OI floor $2M, max 60 nap hold. Több arb sample a paper IC-hez. Vékonyabb piacokon is enged.",
      values: {
        frMinSpreadHourly:     0.00005,
        frMinOpenInterestUSD:  2000000,
        frMaxHoldDays:         60,
        frMaxCapitalPct:       0.50,
        frMaxOpenPositions:    5,
      },
    },
    normal: {
      label: "Normál",
      description: "Spread ≥0.01%/h (~88%/yr), OI floor $5M, 14 nap hold. A 2026-05-10 audit default — atomic 2-leg open + asymmetric close slippage.",
      values: {
        frMinSpreadHourly:     0.0001,
        frMinOpenInterestUSD:  5000000,
        frMaxHoldDays:         14,
        frMaxCapitalPct:       0.40,
        frMaxOpenPositions:    3,
      },
    },
    strict: {
      label: "Szigorú",
      description: "Spread ≥0.05%/h (~438%/yr), OI floor $20M, 7 nap hold. Csak az extrém-spread eseményeket fogjuk (post-listing pump, leveraged-token squeeze).",
      values: {
        frMinSpreadHourly:     0.0005,
        frMinOpenInterestUSD:  20000000,
        frMaxHoldDays:         7,
        frMaxCapitalPct:       0.25,
        frMaxOpenPositions:    2,
      },
    },
  },
  sports: {
    loose: {
      label: "Lazább",
      description: "Edge ≥5%, max pozíció $10, max 5 nap a settlement-ig, 5 open slot. Több paper trade a Pinnacle-edge validáláshoz.",
      values: {
        sportsEdgeThreshold:    0.05,
        sportsMaxPositionUSD:   10,
        sportsMaxOpenPositions: 5,
        sportsMinHoursToEnd:    2,
        sportsMaxHoursToEnd:    120,  // 5 days
      },
    },
    normal: {
      label: "Normál",
      description: "Edge ≥10%, max pozíció $20, max 3 nap a settlement-ig, 3 open slot. Match-day moneyline-fókusz — gyors slot-forgás.",
      values: {
        sportsEdgeThreshold:    0.10,
        sportsMaxPositionUSD:   20,
        sportsMaxOpenPositions: 3,
        sportsMinHoursToEnd:    2,
        sportsMaxHoursToEnd:    72,   // 3 days
      },
    },
    strict: {
      label: "Szigorú",
      description: "Edge ≥18%, max pozíció $30, max 24 ó a settlement-ig, 2 open slot. Csak a same-day chalk fade-ek (NFL playoff longshot, NBA chalk lemmings).",
      values: {
        sportsEdgeThreshold:    0.18,
        sportsMaxPositionUSD:   30,
        sportsMaxOpenPositions: 2,
        sportsMinHoursToEnd:    2,
        sportsMaxHoursToEnd:    24,   // 1 day
      },
    },
  },
};

type Overrides = Partial<Record<keyof typeof SCHEMA, number>>;

// ─── Validate + clamp incoming POST body ──────────────────────────────

function validate(body: unknown): { ok: true; overrides: Overrides } | { ok: false; reason: string } {
  if (!body || typeof body !== "object") return { ok: false, reason: "body must be a JSON object" };
  const out: Overrides = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (!(k in SCHEMA)) continue; // ignore unknown keys silently
    const spec = SCHEMA[k];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return { ok: false, reason: `${k}: must be a finite number` };
    }
    const clamped = Math.max(spec.min, Math.min(spec.max, v));
    out[k as keyof typeof SCHEMA] = clamped;
  }
  return { ok: true, overrides: out };
}

// ─── Public helpers used by other functions ───────────────────────────

export async function loadRuntimeOverrides(): Promise<Overrides> {
  try {
    const store = getStore(STORE_NAME);
    const raw = await store.get(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw as string);
    return parsed?.overrides ?? {};
  } catch {
    return {};
  }
}

// ─── HTTP handler ─────────────────────────────────────────────────────

export default async function handler(req: Request, _ctx: Context) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  // GET: return defaults + (if authed) saved overrides
  if (req.method === "GET") {
    const auth = await checkAuth(req);
    const overrides = auth.ok ? await loadRuntimeOverrides() : {};
    const env = getTraderConfig();
    const btc = getBtcExitConfig();
    // Build the effective view dynamically: every key in SCHEMA falls back to
    // its env default (where one exists) or the schema default. This avoids
    // the "added a knob and forgot to expose it" footgun and makes adding new
    // weather/crypto/etc. fields a one-line change in SCHEMA.
    const envByKey: Record<string, number | undefined> = {
      edgeThreshold:         env.edgeThreshold,
      maxKellyFraction:      env.maxKellyFraction,
      cooldownSeconds:       env.cooldownSeconds,
      sessionLossLimit:      env.sessionLossLimit,
      btcTpTarget:           btc.tpTarget,
      btcSlTarget:           btc.slTarget,
      btcEntryWindowStartMs: btc.entryWindowStartMs,
      btcEntryWindowEndMs:   btc.entryWindowEndMs,
      btcHoldToEndCutoffMs:  btc.holdToEndCutoffMs,
    };
    const effective: Record<string, number> = {};
    for (const [k, spec] of Object.entries(SCHEMA)) {
      effective[k] = (overrides as any)[k] ?? envByKey[k] ?? spec.default;
    }
    return new Response(
      JSON.stringify({ ok: true, schema: SCHEMA, effective, overrides, presets: PRESETS, authed: auth.ok }),
      { status: 200, headers: CORS },
    );
  }

  // POST / DELETE: require auth
  const auth = await checkAuth(req);
  if (!auth.ok) return auth.error;

  if (req.method === "DELETE") {
    try {
      const store = getStore(STORE_NAME);
      await store.delete(KEY);
    } catch {}
    return new Response(JSON.stringify({ ok: true, reset: true }), { status: 200, headers: CORS });
  }

  if (req.method === "POST") {
    let body: unknown;
    try { body = await req.json(); }
    catch { return new Response(JSON.stringify({ ok: false, reason: "bad_json" }), { status: 400, headers: CORS }); }
    const v = validate(body);
    if (!v.ok) return new Response(JSON.stringify({ ok: false, reason: v.reason }), { status: 400, headers: CORS });

    const existing = await loadRuntimeOverrides();
    const merged = { ...existing, ...v.overrides };
    try {
      const store = getStore(STORE_NAME);
      await store.set(
        KEY,
        JSON.stringify({ overrides: merged, savedAt: new Date().toISOString() }),
      );
    } catch (err: any) {
      return new Response(JSON.stringify({ ok: false, reason: `blobs_error: ${err.message}` }), {
        status: 500, headers: CORS,
      });
    }
    return new Response(JSON.stringify({ ok: true, overrides: merged }), { status: 200, headers: CORS });
  }

  return new Response(JSON.stringify({ ok: false, reason: "method_not_allowed" }), {
    status: 405, headers: CORS,
  });
}
