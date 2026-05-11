# Matematikailag megalapozott, automatizálható DeFi kereskedési stratégiák
## $500–$5,000 tőkével, agresszív kockázatvállalással, retail bot fókusszal

> **Vezetői összefoglaló**: Az alábbi kutatás technikai mélységben tárgyalja, hogy retail méretű tőkével (\$500–\$5,000) milyen, akadémiai irodalomban vagy quant blogokban dokumentált stratégiák implementálhatók ténylegesen. A fő következtetés: **ezen a tőkenagyságon a klasszikus atomic MEV (sandwich, két-lépéses cross-DEX arbitrázs Ethereum mainneten) gazdaságilag nem életképes** – a top 10 MEV bot a teljes extrakció ~60%-át kapja, és a CEX-DEX arbitrázshoz 19 nagy searcher 19 hónap alatt 233,8M USD-t extraktált, ami szignifikáns belépési korlátot épített (Wu et al., Flashbots/Paradigm, 2025). Retail edge ezért az alábbi szegmensekben létezik: (1) **Cosmos/Osmosis ökoszisztéma**, ahol az MEV piac kevésbé érett és a Skip ProtoRev modul csak részlegesen szippantja el a profitot; (2) **L2-ek nagyon vékony pool-jai (Base, Arbitrum)**, ahol a Dencun utáni alacsony fee-k lehetővé teszik az olcsó próbálkozást, de spam-versenyek dominálnak; (3) **concentrated liquidity LP-zés stochastic control alapú újragazdálkodással** (Cartea, Fukasawa, Milionis irodalom); (4) **funding rate arbitrázs perpetuálok között**, ahol a delta-neutrális kitettség 10–25% APR-t hoz a 2025-ös rezsim mellett; (5) **statisztikai arbitrázs cointegrált kripto-párokon**, ahol az akadémiai irodalom 1.5–2.45 közötti Sharpe-ot mért. A kis tőke (\$500–\$5,000) miatt a flash loan alapú megközelítés **nem ad valós edge-et**: a profitabilitást nem a sajáttőke, hanem a sebesség és az inklúziós garancia korlátozza.

---

## 1. A piac strukturális elemzése $500–$5,000 tőkén

### 1.1. Mit mond az akadémiai/empirikus irodalom a retail edge-ről?

A modern DeFi mikrostruktúra-irodalom három, retail számára releváns ténymegállapítást rögzít:

- **CEX-DEX arbitrázs centralizált.** Wu, Sui, Thiery és Pai (King's College London / Flashbots / Ethereum Foundation / Paradigm, *Measuring CEX-DEX Extracted Value*, arXiv:2507.13023, 2025) 7,2 millió CEX-DEX arbitrázs tranzakciót elemezve azt találja, hogy 19 hónap alatt 19 nagy searcher 233,8M USD-t extraktált, "exclusive deals between searchers and builders" mellett. A retail belépési korlát "significantly elevated".
- **Cross-chain arbitrázs koncentrált.** Az ACM 2025 mérése (*Cross-Chain Arbitrage: The Next Frontier of MEV*) szerint 9 blokkláncon 1 év alatt 242,535 cross-chain arbitrázs ment 868,64M USD volumennel, de a top 5 cím lebonyolítja a kereskedés >50%-át, egyetlen cím a napi volumen ~40%-át (Dencun után). A bridge-alapú arbitrázs 242 másodperces átlagos átfutása miatt elsősorban a pre-pozícionált inventory-val rendelkező arbitrazsőrök életképesek.
- **L2-eken a spam dominál, nem a priority fee.** Chaliasos et al. (*First-Spammed, First-Served*, arXiv:2506.01462v3, 2025) Arbitrum, Base, Optimism, Unichain és zkSync adatokon mutatja meg, hogy a Dencun után a revert ráta 5%-ról 10–20%-ra ugrott, és a reverted txn-ek >80%-a swap, ezek ~50%-a USDC-WETH Uniswap v3/v4 pool-okon. A bot-ok nem priority fee-vel, hanem **duplikált transaction spam-mel** versenyeznek – ami pont a retail számára teszi nehezen játszhatóvá a piacot megfelelő RPC nélkül.
- **LP edge létezik, de aktív menedzsment kell.** Cartea, Drissi, Monga (*Decentralised Finance and Automated Market Making: Predictable Loss and Optimal Liquidity Provision*, arXiv:2309.08431) Uniswap v3 historikus adatokon **megmutatja, hogy átlagosan az LP-k jelentős veszteséget realizáltak**, viszont a stochastic control alapú range-skewing out-of-sample is jobb teljesítményt ad.
- **LVR mint univerzális kockázati metrika.** Milionis, Moallemi, Roughgarden, Zhang (*Automated Market Making and Loss-Versus-Rebalancing*, arXiv:2208.06046, "Black-Scholes formula for AMMs") megmutatja, hogy a CFMM LP nettó hozama lokálisan ≈ fee bevétel − ½·σ²·L·Δt, vagyis bármely strategiának (akár hedged LP-nek) a realizált volatilitás × marginális likviditás × idő ellen kell profitot termelnie.

### 1.2. Mit jelent ez a $500–$5,000 sávra?

| Stratégia-osztály | Retail edge $500–$5,000-nél | Fő akadály |
|---|---|---|
| Ethereum mainnet atomic MEV (sandwich, top-of-block arb) | **Nincs** | Builder integráció, sub-100 ms latencia |
| CEX-DEX arbitrázs liquid párokon | **Nincs** | Inventory több venue-n, sebesség |
| Cross-chain arbitrázs bridge-en | **Marginális** | 242 s bridge latencia |
| Osmosis / Cosmos cyclic arb (post-ProtoRev) | **Részleges** | ProtoRev elviszi a hot route-okat, de a hosszabb route-ok és új poolok élnek |
| L2 (Base, Arbitrum) thin-pool arb | **Részleges** | Spam-verseny, revert költség, de alacsony gas |
| Uniswap v3 concentrated LP (aktív) | **Igen** | Tudásigény, IL, oracle |
| Funding rate arbitrázs (perp DEX-ek) | **Igen** | Likvidáció, fee | 
| Statisztikai arbitrázs (cointegráció) | **Igen** | Kockázat: rezsimváltás |
| Hyperliquid/Injective market making (Avellaneda–Stoikov) | **Igen** | Inventory risk, latencia |

---

## 2. Akadémiai/matematikai alapok – referenciák

Minden további stratégia ezekre épít:

1. **Milionis–Moallemi–Roughgarden–Zhang (2022)** – LVR closed-form: `LVR_t = ½ σ²(P) · P · |x*'(P)|`. Minden passzív AMM LP "variance swap floating leg"-jét fizet az arbitrazsőröknek.
2. **Cartea–Drissi–Monga (2023)** – Stochastic control alapú optimális likviditás-szolgáltatás Uniswap v3-on (HJB egyenlet, model-free verzió több pool-ra).
3. **Avellaneda–Stoikov (2008, *Quantitative Finance*)** – Optimális market making limit orderbook-on: reservation price `r = s − q·γ·σ²(T−t)`, optimális spread `δ = γσ²(T−t) + (2/γ)·ln(1+γ/κ)`. Implementáció: Hummingbot `avellaneda_market_making` strategy, Stoikov saját SSRN 5066176 (*Market Making in Crypto*, 2024).
4. **Engle–Granger (1987) cointegration / Johansen (1991)** – Statisztikai arbitrázs alap. Crypto-specifikus alkalmazás: Tadi–Kortchemski (*Evaluation of Dynamic Cointegration-Based Pairs Trading Strategy in the Cryptocurrency Market*, arXiv:2109.10662) – Bitmex spot+perp, Sharpe ≈ 1.5; ijsra 2026/0283 (BTC-ETH pair, 16,34% annualizált, 8,45% vol, β≈0,09).
5. **Daian et al. (2019) Flash Boys 2.0** – MEV taxonómia, sandwich/arbitrázs/likvidáció.
6. **A²MM (Heimbach–Wattenhofer, arXiv:2106.07371)** – atomic arbitrázs optimális trade routing.
7. **Wan et al. (*Strategic Analysis of Just-In-Time Liquidity Provision*, arXiv:2509.16157, 2025)** – CLMM-eken JIT LP-zés nem-lineáris optimalizálása, megmutatja, hogy a meglévő JIT LP-k 69%-kal több hozamot generálhatnának, ha a price impact-et explicit modelleznék.
8. **Fukasawa et al. (arXiv:2502.01931, 2025)** – Utility indifference indoklás a Uniswap v3 konstrukcióra, többszereplős LP egyenértékűsége egy reprezentatív LP-vel.

Minden alább részletezett stratégia ezeket az alapokat operacionalizálja kis tőkén.

---

## A) NETLIFY FUNCTIONS-RA IMPLEMENTÁLHATÓ STRATÉGIÁK

**Platform-korlátok (megerősítve a Netlify dokumentációból):**
- Pro/Enterprise plan-on a synchronous function timeout kérésre 26 s-ra emelhető.
- Scheduled functions: 30 s hard limit, csak published deploy-on fut, cron expression (UTC), JS/TS inline definícióval.
- Background functions (Pro+): max 15 perc, aszinkron – ez teszi lehetővé a "hosszabb" feladatokat (pl. tick aggregáció).
- Stateless – minden állapotot külső store-ba (Supabase, Upstash Redis, Netlify Blobs) kell tenni.
- **Nincs WebSocket persistent kapcsolat, nincs mempool subscription** – ezért minden mempool/private-orderflow MEV stratégia kizárt.

### A1. Cross-DEX latency-tolerant arbitrázs jelzőrendszer (cron-driven)

**Mit csinál:** 30–60 másodpercenként pollozza a top likviditású Uniswap v3 pool-okat (Base, Arbitrum, Ethereum) + PancakeSwap v3 (BSC) + Osmosis CL pool-okat, és kiszámolja a no-arb feltétel megsértését (Adams et al. v3 whitepaper képletekkel: `P = sqrtPriceX96² / 2^192`). Ha a spread > küszöb (fee_a + fee_b + bridge_cost + slippage), webhook hív egy execution endpoint-ot (lehet ugyanazon Netlify function on-demand, vagy külső VPS).

**Matematikai alap:** Constant-product no-arbitrázs feltétel `(P_A − P_B)/P_A > total_friction`, ahol `total_friction` magában foglalja `2 × LP fee + gas / notional + 2 × slippage`. Részletes routing: A²MM optimal two-point arbitrázs (arXiv:2106.07371). Implementációhoz a kvantitatív megközelítés: `x*_optimal = (sqrt(k·P_target) − R_in)`, ahol P_target a másik venue marginális ára.

**Becsült éves hozam $500–$5,000 tőkén:** A retail számára elérhető, lassú (nem atomic, nem co-located) arbitrázsok ritkák a fő párokon; **pesszimista 5–15% APR**, **optimista 30–60%** thin pool / exotic token párokon, ha az exekúció ugyanazon a láncon (atomic) megoldható. Pure cross-chain bridge-elt arbitrázs retail szinten **alig profitábilis** – az ACM 2025-ös mérés szerint a bridge-alapú arbitrázsok 242 s átlagos átfutásúak, és a market dominancia 1 címé (~40%).

**Gas vs profit:** Base / Arbitrum / BSC posztDencun: a tipikus swap gas ~$0.005–0.05; profitábilitási küszöb $500 notional-en ~0,2–0,5% spread.

**Infrastruktúra:** Netlify Scheduled Function (cron `*/1 * * * *`), Alchemy/Ankr/QuickNode RPC, Supabase a pool állapot cache-eléséhez. **Kritikus**: a Netlify Function nem subscribe-olhat WebSocket-re, ezért HTTP eth_call multicall hívásokat használjon (Multicall3 deploy-olva minden EVM láncon).

**SDK / library:**
- `viem` (ajánlott TypeScript-hez, gyors, tree-shakeable)
- `@uniswap/v3-sdk`, `@uniswap/sdk-core`
- `@pancakeswap/v3-sdk`
- `@cosmjs/stargate`, `osmojs` (Osmosis CL pool read-only)
- `multicall3` direct ABI call

**GitHub referencia repók:**
- `Uniswap/v3-sdk` (hivatalos, SqrtPrice math)
- `pancakeswap/pancake-frontend` (smart router)
- `osmosis-labs/osmojs` 
- `Mogambo009/crypto-arbitrage-finder`, `DefiLab-xyz/uniswap-v3-backtest` (npm csomag, kifejezetten Netlify-kompatibilis)
- `ARBProtocol/solana-jupiter-bot` (csak referenciának, koncept szintjén)

**Kockázatok:** A jelzés és az exekúció között lejár az opportunity (race condition); az atomic teljesítés hiányában a második láb fail-elhet; nagy spread-ek általában rug/honeypot tokeneket jeleznek (whitelist szükséges); revert költségek.

### A2. Funding rate skenner + manuális/webhook exekúció (delta-neutrális perp arb)

**Mit csinál:** A Netlify Scheduled Function 5–15 percenként lekérdezi Hyperliquid, Paradex, dYdX v4, Aster, Lighter, Backpack, Extended, Vest, GMX/Jupiter API-jait a futó funding rate-ekért, valamint Binance/Bybit perp funding-okat (összehasonlítási anchor-ként). Kiszámolja a normalizált APR-t (intervallum-különbségek figyelembevételével – pl. Hyperliquid óránként, Binance 8 óránként, lásd BSIC, *Perpetual Complexity Part 1*) és Telegram/Discord webhookot küld küszöb felett, vagy Hummingbot REST endpoint-ot trigger-el.

**Matematikai alap:** Spot-perp parity: `F_t = S_t · exp((r + funding_rate_cumulative)·τ)`. Delta-neutral PnL várható értéke `E[PnL] = Σ funding_payments − fees − borrow_cost`. Tactical (rövid távú) entry: csak ha `funding_8h_normalized > 2 × (taker_fee + maker_fee)` (Chainstack Hyperliquid bot dokumentációból: `>0.11%/óra` küszöb maker order-ekkel).

**Becsült hozam $500–$5,000 tőkén:** 2025-ös átlagos BTC/ETH funding ~0.015%/8h ≈ 19% annualizált *bruttó*; a fee-k és margin lockup miatt nettó **8–20% APR** stabil delta-neutrális poziciókon. Volatilis időszakokban (alt funding spike) 30–80% lehet, de **likvidáció risk** explodál. PI² Network és FundingView 12+ DEX mérésén alapulva.

**Gas / fee:** Hyperliquid: 0.045% taker / 0.015% maker (perp), spot 0.07%/0.04%. Egy belépés + kilépés ~0.12% spot + 0.12% perp = 0.24% round-trip → minimum 2 funding ciklust ki kell ülni, hogy break-even legyen. **\$500-on minimum order méret problémája lehet** (Hyperliquid min notional ~$10, Paradex ~$10 → működik).

**Infrastruktúra:**
- Netlify Scheduled Function (15 perc cron)
- Upstash Redis vagy Supabase az utolsó funding snapshot cache-elésére
- Külső exekutor: dedikált VPS Hummingbot funding_rate_arbitrage strategy-vel (Hummingbot `Funding Rate Arbitrage` connector Hyperliquid-re, lásd hummingbot.org guide)

**SDK / library:**
- `@nktkas/hyperliquid` vagy `nomeida/hyperliquid-python-sdk` (Python)
- `dYdX v4 client` (TS/Python)
- `injective-py` / `@injectivelabs/sdk-ts` Helix perp-hez
- `ccxt` Binance/Bybit funding rate query-hez

**GitHub repók:**
- `ksmit323/funding-rate-arbitrage` (Encode Hackathon nyertese, Orderly + Hyperliquid + ApexPro)
- `hummingbot/hummingbot` `funding_rate_arbitrage` strategy
- `chainstack docs` Hyperliquid funding bot tutorial (Python implementáció, nyilvánosan elérhető)

**Kockázatok:** Likvidáció (extrém kitettség a perp lábon ha margin elfogy); funding flip (a stratégia "megfordul" rád, gyors exit kell); exchange szolvencia (FTX-szindróma); cross-margin vs isolated margin choice.

### A3. Statisztikai arbitrázs jelzőrendszer (cointegrált párok)

**Mit csinál:** A scheduled function napi 1×/4 óránként lekér 1 év OHLC-t (CoinGecko / Binance API / Kaiko) ~30 nagy cap kripto-eszközre (BTC, ETH, SOL, BNB, ATOM, OSMO, TIA, INJ, stb.), futtat **Engle–Granger két lépéses** és **Johansen** cointegráció tesztet (statsmodels.tsa.stattools.coint, vagy TS-ben `simple-statistics` + custom OLS). Mean-reverting spread-eket azonosít, OU-illesztéssel half-life-ot számol (`τ = −ln(2)/ln(1+θ)`), és z-score belépési jelzést ad (±2σ-nál long/short).

**Matematikai alap:** 
- Engle–Granger: regresszió `Y_t = α + β X_t + ε_t`, majd ADF teszt ε_t-n.
- Spread: `s_t = log(P_A) − β·log(P_B)`.
- OU folyamat: `ds = θ(μ − s)dt + σ dW`.
- Belépési szabály: `z = (s − μ̂)/σ̂_e`, long ha z < −Z*, short ha z > +Z*.
- Akadémiai validáció: Tadi–Kortchemski (arXiv:2109.10662): Bitmex spot+perp adaton kombinálva KSS nonlineáris cointegrációt is, naive buy-and-hold-ot megveri. Park (2026, ijsra): BTC-ETH 16,34% annualizált, 8,45% vol, β≈0,09, Sharpe 1,58–2,45 különböző cluster-eken.

**Becsült hozam:** $500–$5,000 tőkén **15–35% APR** elérhető (cointegration tartósan érvényes alt-alt párokon, pl. ETH-stETH típusú, vagy OSMO-ATOM/TIA-ATOM), Sharpe 1,5–2,5. Maximális drawdown alacsony (Park: BTC-ETH stratégia maxDD ~8%, szemben BTC HODL 54% voljal).

**Gas / fee:** A jel napi 1–3-szor adódik – CEX-en (Binance, OKX) szinte zéró fee impact; DEX-en (Uniswap v3, Osmosis CL) a fee és slippage miatt csak nagyobb tőkén életképes – **\$1,000+ alatt CEX execution ajánlott**.

**Infrastruktúra:**
- Netlify Scheduled (`0 */4 * * *`)
- Database: Supabase Postgres (időbeli OLS regressziós koefficiensek, spread history)
- Külső exekutor: ccxt Python script egy VPS-en, *vagy* TypeScript-ben viem-mel DEX execution

**SDK / library:**
- Adat: `ccxt` (Python/TS), CoinGecko Pro API, Binance public API
- Stat: TS-ben nehéz – minimum viable: `simple-statistics` + custom ADF (Newey–West), de jobb Background Functions-ben Python runtime (Netlify Python beta) vagy *Netlify Edge Function*-ben WebAssembly statsmodels (nehéz). **Gyakorlatban**: a stat tesztet futtasd egy Python Cloud Function-ön (GCP / Modal / Replit cron) és az eredményt POST-old Netlify Function endpoint-ra.

**GitHub repók:**
- `quantopian/zipline-trader` cointegration példák
- `hudson-and-thames/arbitragelab` (commercial, de open source verzió is van)
- `Marketcetera` cointegration example
- `mfrdixon/crypto-cointegration` (academic, kifejezetten kripto)

**Kockázatok:** Rezsimváltás (a párkapcsolat megszakad – cf. UST/LUNA 2022); look-ahead bias backtest-ben; non-stationary β; alacsony likviditás az alt-alt párokon.

### A4. On-chain "signal" alapú directional jelzés (TVL, fund flow)

**Mit csinál:** Netlify Background Function 5–10 percenként lekér DefiLlama / Dune Analytics API-ról TVL változásokat, Cosmos Mintscan-ről validator unbond / IBC transfer flow-kat, Etherscan token transferek-et (large whale moves, > $1M). Egy ML/regressziós modell alapján (akár csak EMA crossover + Bayesian z-score) jelzést ad direkciós momentum trade-re.

**Matematikai alap:** Volume-Synchronized Probability of Informed Trading (VPIN, Easley–López–O'Hara 2012), kripto-adaptáció: Yang–Wu–Zhang (2023, *Integrating Tick-Level Data and Periodical Signals for High-Frequency Market Making*). Gyakorlatilag: `signal_t = z(volume_t / volume_MA_24h)` + `z(funding_t)` + `z(open_interest_change_t)`. Akkor LONG ha az aggregát Z > 2.

**Becsült hozam:** **Nehéz előre megmondani** – akadémiai meta-elemzés (Crone–Brophy–Ward 2021, *Exploration of Algorithmic Trading Strategies for the Bitcoin Market*) szerint a momentum + on-chain signal stratégiák kripto-piacon Sharpe 0.8–1.3 között teljesítenek. **Realisztikus 10–25% APR**, magas variancia.

**Gas / fee:** Mivel a jel napi <5x, és spot CEX-en (vagy a tőke 1–5%-án mer szét több DEX-en) hajtható végre, gas/fee nem szignifikáns.

**Infrastruktúra:** Netlify Scheduled Function + Supabase + Telegram webhook. Exekúció lehet manuális, vagy Hummingbot script ami HTTP endpoint-on hallgat.

**SDK / library:** `@defillama/sdk`, `dune-client` (Dune Analytics), `viem` + `eth-multicall`, `osmojs` Osmosis state-hez.

**GitHub repók:** `DefiLlama/defillama-sdk`, `duneanalytics/dune-client`, `mempool/mempool` (BTC fee jelekhez).

**Kockázatok:** On-chain jel látszólag késik (a piac már mozgott mire indikáció jön); rug pull tokenek; data quality (DefiLlama API outage).

### A5. Concentrated Liquidity "rebalance trigger" service

**Mit csinál:** Egy Netlify cron óránként lekérdezi a user Uniswap v3 / PancakeSwap v3 / Osmosis CL pozícióinak árát (`slot0.tick`) az aktuális tickjéhez képest. Ha kilóg a tartományból > 1.5%-kal vagy az IL > collected_fees, akkor webhook trigger-eli a rebalance-t (külső exekutor scriptre vagy Gamma/Arrakis-szerű manager kontraktra).

**Matematikai alap:** Cartea–Drissi–Monga (arXiv:2309.08431) "concentration risk" alatti optimális range-skew. Konkrét képlet: optimális szélesség `Δ* ∝ √(σ²·τ·γ)` ahol γ a fee-arány, τ a várható rebalance horizon. Akadémiai validáció: a tan paper "out-of-sample performance of our strategy is superior to the historical performance of LPs in the pool we consider" (i.e. átlag LP veszít, optimalizált nyerhet).

**Becsült hozam:** Friedrich–Strehle (arXiv:2504.16542): a stochastic optimization alapú LP rebalance + Cartea-style range-skewing 5–30% net APR-t hoz ETH-USDC 0.05% pool-on, **figyelembe véve a divergence loss-t és a rebalancing cost-ot**. Magas vol időszakban LVR ~20%/év – ezt felül kell múlnia a fee-knek.

**Gas / fee:** Ethereum mainnet: $20–80 per rebalance, ezért $1,000 alatti pozíciókra **gazdaságilag öngyilkos**. **Arbitrum / Base ($0.5–2 per rebalance) és Osmosis CL (~$0.01–0.05)** életképes. PancakeSwap v3 BSC: ~$0.10.

**Infrastruktúra:** Netlify Scheduled Function (15 perc – 1 óra cron, attól függően milyen tight a range), Supabase user pozíciók DB-jéért, signed transaction az exekúcióhoz külső VPS-en (a private key SOHA ne legyen Netlify env varokban; az exekúciót egy minimal-trust autonóm kontraktra delegáld – pl. Gelato Network task, vagy Arrakis vault).

**SDK / library:**
- `@uniswap/v3-sdk` (Position, Pool, Tick, TickMath)
- `@pancakeswap/v3-sdk`
- `osmojs` (concentrated-liquidity module)
- `@gelatonetwork/automate-sdk` (autonóm exekútáláshoz)

**GitHub repók:**
- `Bella-DeFinTech/uniswap-v3-simulator` ("Tuner" – tick-level pontosság, SQLite persistence)
- `DefiLab-xyz/uniswap-v3-backtest` (NPM csomag, Netlify-kompatibilis)
- `GammaStrategies/awesome-uniswap-v3` (curated lista, az ETH Zurich / Cartea / Charm finance referenciákkal)
- `panoptic-labs/research` (perpetual options + LP simulator, Jupyter notebook + Python)
- `DefiLab-xyz/uniswap-v3-simulator`

**Kockázatok:** Impermanent loss = LVR + divergence (Milionis et al. szétválasztotta); MEV sandwich a rebalance körül (Flashbots Protect ajánlott); rebalance cost spike vol-spike közben.

---

## B) DEDIKÁLT VPS-RE SZÁNT STRATÉGIÁK

**Infrastruktúra alapfeltevés:** 4 GB RAM, 2 vCPU, 100 Mbps, Hetzner / DigitalOcean / OVH ($5–20/hó). PM2 process manager, Node.js 20+ vagy Python 3.11+, Docker. Dedikált RPC (Alchemy Growth $49/hó vagy QuickNode Build $10/hó, **soha public RPC**). Optimálisan us-east / fra (Frankfurt) co-location a target chain validator-okhoz.

### B1. Osmosis cyclic arbitrage + IBC cross-chain searcher (Skip Protocol)

**Mit csinál:** Mempool subscribe-ol az Osmosis Tendermint RPC-jén (`tendermint_websocket`), figyel beérkező swap-okat 3 fontosabb pool-on (OSMO/ATOM, USDC/OSMO, TIA/OSMO, INJ/OSMO). Minden swap-hoz ProtoRev-szerűen route-okat generál (highest-liquidity heurisztika + hot-route lookup), kiszámolja az optimális input mennyiséget (cyclic CFMM-en a profitmaximalizáló bemenetnek closed-form megoldása van; lásd Osmosis docs *Arbitrage* page), és bundle-t küld a Skip Auction-ön keresztül vagy közvetlenül a mempool-ba (FCFS, Osmosis nem PBS).

**Matematikai alap:** Két-pool cyclic arb optimális input: ha pool A: x·y=k_A, pool B: u·v=k_B és a route A→B→A, akkor `x* = (sqrt(k_A·k_B·r_AB) − k_A) / (1 + r_AB)` típusú zárt forma, ahol r_AB a kumulatív fee-szorzó (1-0.003)² UniV2 stílusban. Osmosis Balancer pool-okra a képlet általánosabb (súlyozott geometriai átlag), erre az `osmojs` SDK adja a quote-ot.

A Skip MEV Satellite mérése: Osmosis genesis óta legalább $6,73M atomic arbitrázs profit folyt, $50k-nál kevesebb tranzakciós díj mellett – ez ma is folyamatos, jóllehet a ProtoRev modul a "highest-liquidity" route-ok 40–60%-át elszippantja. **A retail edge a hot route lookup-ban nem szereplő, kisebb / újabb pool-okon van** (új IBC tokenek, pl. újonnan listázott Cosmos token-ek első hetei, alloyed BTC, RWA tokenek).

**Becsült hozam $500–$5,000 tőkén:** $500–$5,000 tőkén **havi $20–$200 nettó nyereség realisztikus** (240–500% éves implicit, de jelentős variancia – heteken keresztül nulla lehet, majd egyetlen TIA listing alatt $200+). A felső plafont a verseny (Skip ProtoRev + más bot-ok) szabja.

**Gas / fee:** Osmosis tranzakciós fee ~$0.01–0.05, profit margin / opportunity általában $5–$200.

**Infrastruktúra:**
- VPS Frankfurt vagy Tokyo (Osmosis validator concentration)
- Tendermint WebSocket subscribe a saját Osmosis node-ról vagy Polkachu / Stakecito public RPC-ről (ne mainnet.osmosis.zone, az rate-limit)
- Skip Auction endpoint integráció
- PM2 + Prometheus monitoring

**SDK / library:**
- `osmojs` (TypeScript), `@cosmjs/stargate`
- Python: `cosmpy`, `pyinjective` (Injective oldalra)
- Skip: `skip-mev/skipper` (Python + Go példa bot)

**GitHub repók:**
- `skip-mev/skipper` (hivatalos Skip bot példa, CosmWasm + EVM Cosmos chain-ekre)
- `osmosis-labs/osmosis` (a core repo, ProtoRev modul kódjának olvasása kötelező)
- `Faddat/osmoarb`, `imperator-co-archive/osmosis-arbitrage` (Python Jupyter notebook)
- `terra-money/multi-finder` (Terra-era arb, de hasznos pattern Cosmos cyclic-hoz)
- `larry0x/oraculus` (referencia Cosmos searcher pattern)

**Kockázatok:** ProtoRev megelőzi a tx-edet → revert, gas-loss; Tendermint mempool FCFS spam háború; new pool deployer rug; Osmosis chain halt (történt 2024 szept.).

### B2. PancakeSwap v3 + BSC multi-DEX arbitrázs (BiSwap, ApeSwap, Thena)

**Mit csinál:** WebSocket-en subscribe-ol a BSC `newPendingTransactions` (vagy alphaSync / bloXroute mempool stream)-re, dekódolja a Pancake/Biswap/Thena router calldata-jait, kiszámolja a swap utáni új pool state-et (constant product math), majd ha cross-DEX/cross-pool arbitrázs adódik → flash loan-os bundle-ben végrehajtja.

**Matematikai alap:** Heimbach–Wattenhofer A²MM (arXiv:2106.07371) optimal trade routing for two-point arbitrage. BSC-n PoSA konszenzus (3 másodperc block time), nincs hivatalos PBS, de van privát mempool (bloXroute, 48Club builders). 

**Becsült hozam:** Egyenetlen, $500–$5,000 tőkén **havonta $0–$300 reális**, sok hét nulla profittal. A BSC arbitrage piac érett, jaredfromsubway.eth típusú nagyok dominálnak.

**Gas / fee:** BSC tranzakció ~$0.10–0.30; flash loan fee Venus/PancakeSwap V3 flash swap ~0.05%.

**Infrastruktúra:** VPS Singapore (Binance validator közelség), saját BSC archive node vagy Ankr Premium, bloXroute BDN előfizetés ($150–500/hó az olcsóbb tier-ek).

**SDK / library:** `ethers.js v6` vagy `viem`, `@pancakeswap/v3-sdk`, `@pancakeswap/smart-router`.

**GitHub repók:**
- `yuyasugano/pancake-bakery-arbitrage` (alapszintű, oktatási)
- `Haehnchen/uniswap-arbitrage-flash-swap` (flash swap pattern UniV2/Pancake)
- `taprwhiz/MEV-arbitrage-contract` (flash loan + triangular Solidity)
- `ubakirdogen/Triangular-DEX-Arbitrage-Bot` (Hardhat + ethers.js)
- `axatbhardwaj/arbitrage-bot` (Uniswap V3 + PancakeSwap V3 swap event monitor)

**Kockázatok:** Erős verseny, MEV "jaredfromsubway"-szerű boto-k front-run-elnek; honeypot / rug tokenek; BSC blockchain reorgok.

### B3. Uniswap v3/v4 aktív concentrated liquidity market making (Cartea-style)

**Mit csinál:** Hosszabb távra tartott LP pozíció ETH-USDC (5 bps) vagy similar pool-on Base / Arbitrum / Unichain-en, programatikusan rebalansolt 1–24 órás intervallumon. A range szélesség adaptív: `Δ* = c · σ_realized · √τ`, ahol σ_realized 1h–4h-ás EWMA-ja a tick mid-price-nak, és c a kockázati toleranciatényező (3–10 közötti, alacsonyabb = szűkebb range, magasabb fee bevétel de magasabb out-of-range arány).

**Matematikai alap:**
- Cartea–Drissi–Monga stochastic control (arXiv:2309.08431) – optimal range egy stochasztikus drift-tel rendelkező marginális ár mellett.
- Milionis LVR – minden LP pozíciónak hedge-elni érdemes a delta-exposure-jét (pl. perp short ETH Hyperliquidon).
- Mellow Protocol / Arrakis / Gamma vault-okhoz kapcsolódó akadémiai dokumentáció.
- Hashemseresht et al. (arXiv:2309.10129) **Adaptive Liquidity Provision in Uniswap V3 with Deep Reinforcement Learning** – DRL ágens kifejezetten retail tőkére tervezve, hedge-elve perp future-rel. Hivatkozott idézet: "this strategy does not require substantial computational resources and is thus accessible to individual investors".

**Becsült hozam $500–$5,000:** ETH-USDC 5bps Base / Arbitrum-on, hedged stratégiával 8–25% nettó APR (LVR-mentes); unhedged volatilis piacon -20%-tól +40%-ig. Eric Wall és Charm Finance dashboardok historikus 2023–2025-ös adatai szerint az "active management" v3 LP-k a passzív v3 LP-k 1.5–3-szorosát hozzák.

**Gas / fee:** Base / Arbitrum: $0.20–1.50 rebalance, ezért 1–2 rebalance/nap életképes. Mainnet alkalmatlan ezen a tőkenagyságon.

**Infrastruktúra:** VPS, Alchemy/QuickNode RPC, Hummingbot dashboard + Python custom strategy *vagy* Mellow Protocol vault deployer.

**SDK / library:**
- `@uniswap/v3-sdk`, `@uniswap/v4-sdk` (új, hooks-aware)
- `dragonfly-xyz/useful-solidity-patterns` v3 math
- Python: `uniswap-python`, `unipy`

**GitHub repók:**
- `Bella-DeFinTech/uniswap-v3-simulator` ("Tuner" backtester, tick-level)
- `DefiLab-xyz/uniswap-v3-backtest` (gyors NPM)
- `panoptic-labs/research` (Panoptic backtester – LP + perpetual options replikáció)
- `GammaStrategies/awesome-uniswap-v3`
- `revert-finance/lite` (vagyonkezelő referencia)
- `fewwwww/awesome-uniswap-hooks` (v4 hooks lista, Bunni, EulerSwap)

**Kockázatok:** Smart contract risk (Bunni hack 2025); IL = LVR + divergence; oracle manipuláció v4 hookokon; range out-of-bound közben minden hozam megszűnik.

### B4. Avellaneda–Stoikov market making Hyperliquid / Injective Helix-en (orderbook)

**Mit csinál:** Klasszikus AS modell limit orderbook-on: reservation price `r = s − q·γ·σ²·(T−t)`, optimális spread `δ = γσ²(T−t) + (2/γ)·ln(1+γ/κ)`. A bot folyamatosan ad bid/ask limit order-eket az aktuálisan optimális szinten, és kezeli az inventory-t (target inventory %-hoz skew-el). Mid-cap likviditású párokon (pl. INJ-USDT Helix-en, vagy alt-perpek Hyperliquidon) van retail edge.

**Matematikai alap:** Avellaneda–Stoikov (2008, *Quantitative Finance* 8(3) 217–224). Crypto-adaptáció Stoikov saját 2024-es paper-jében (SSRN 5066176, *Market Making in Crypto*). Hummingbot konkrét képletei: `γ = inventory risk aversion`, `κ = orderbook density`, mindkettő on-the-fly kalibrálható.

**Becsült hozam $500–$5,000:** Aktívan kezelt MM bot kis cap altcoin párokon **20–80% APR** elérhető (Hummingbot Botcamp anyagok, Stoikov SSRN paper). Magas oldalsó verseny BTC/ETH-n elviszi a margint – cél: vékony tier-2 párokra koncentrálni.

**Gas / fee:** Injective: zero gas fees (decentralizált orderbook native, INJ tokenben small fee). Hyperliquid: 0.045% taker / 0.015% maker.

**Infrastruktúra:** VPS, Hummingbot Docker, dedikált RPC. PM2 monitoring + Grafana dashboard.

**SDK / library:**
- `hummingbot/hummingbot` (Python + Cython; built-in `avellaneda_market_making` strategy)
- `injective-py` (`pyinjective`) vagy `@injectivelabs/sdk-ts`
- Hyperliquid Python SDK (`nktkas/hyperliquid` JS, vagy hivatalos Python)

**GitHub repók:**
- `hummingbot/hummingbot` (avellaneda_market_making strategy)
- `crypto-chassis/ccapi` (CMM market making 200 sor C++)
- `InjectiveLabs/sdk-python`
- `InjectiveLabs/injective-trading-bot` (demo MM bot)

**Kockázatok:** Inventory risk (egyoldalúan kifut a piac), latencia (orderbook venue-n a maker order-eked átfutják); thin tokenek halálát kell folyamatosan figyelni; Hyperliquid leverage liquidáció a perp lábon.

### B5. Atomic flash arbitrage on Ethereum L2 / Base (Flashbots SUAVE / mev-share)

**Mit csinál:** WebSocket-en figyeli a Base / Arbitrum mempool-t (privát mempool, sequencer-en keresztül – nincs igazi public mempool, ezért **mev-share opt-in flow** kell), és arbitrázs alkalmakat keres backrun formában (`searcher` callback-et küld a Flashbots mev-share endpointra). Flash loan Balancer Vault-ról (0% fee), atomic execution UniV3 / Curve / Aerodrome / BaseSwap pool-okon.

**Matematikai alap:** Daian et al. (2019) MEV taxonómia + Flashbots `simple-blind-arbitrage` flash loan tutorial. Atomic transakcióban: borrow X token → swap → swap → repay borrow + fee, ha negatív akkor revert (csak gas-loss revert callback).

**Becsült hozam $500–$5,000:** Itt a sajáttőke szinte irreleváns (flash loan adja), de **a profit nem a tőkétől függ, hanem a sebességtől**. Realistikus retail searcher Base/Arbitrum-on (Flashbots writings 2025): **havi $50–$500 nettó**, hatalmas variancia, gyakori revert. Az Extropy Academy elemzés szerint a top 10 ETH MEV builder a profit ~60%-át kapja, így a maradék a több száz független searcher között oszlik el.

**Gas / fee:** Base $0.005–0.02/swap, de revert-ek halmozódnak (~10–20% revert ráta poszt-Dencun). Flash loan: Balancer Vault 0% (preferált).

**Infrastruktúra:**
- VPS us-east (Coinbase sequencer közelében)
- Saját Reth/Erigon archive node Base/Arbitrum-on, *vagy* QuickNode Build+ tier WebSocket+trace
- mev-share opt-in és searcher signup Flashbots-on

**SDK / library:**
- `viem` + `flashbots-ethers-provider-bundle`
- `@flashbots/mev-share-client-ts`
- Foundry (kontraktokhoz: `forge`)

**GitHub repók:**
- `flashbots/simple-blind-arbitrage` (Balancer flash loan + Flashbots bundle, hivatalos)
- `flashbots/mev-share-client-ts`
- `manuelinfosec/flash-arb-bot` (Aave V2 flash loan, oktatási)
- `Haehnchen/uniswap-arbitrage-flash-swap`

**Kockázatok:** **Erős verseny** (Flashbots saját közléseik szerint a top searcher-ek bare-metal EPYC vasakon koloköltöznek validator-ok mellé); revert-loss spirál; smart contract bug → tőkeveszteség; Flashbots policy változások.

### B6. Solana Raydium / Orca / Meteora backrun arbitrázs (Jito bundle)

**Mit csinál:** Yellowstone gRPC stream Geyser plugin-on, sub-50 ms account update latencia, Jito bundle submission. Jupiter SDK kvótákkal multi-hop route-okat tesztel, profit > Jito tip-nél bundle küld.

**Matematikai alap:** Jito-Labs hivatalos `mev-bot` repo dokumentációja (3-hop backrun ágenseket csinál), 2024-ben átlag profit/blokk a top bot-oknál ~ $1500 ETH-en, Solana-n 2024 januárban 2Fast bot egyetlen tx-ben $1.9M (Yellow.com referencia). 2025 H1: ~90M sikeres arbitrázs Jito detection-en, $142.8M összprofit. Retail share ebből marginális.

**Becsült hozam $500–$5,000:** **Havi $0–$300 reális**, RPC Fast / Helius dedikált infra nélkül vissza-ütközik. A bare-metal cohabitált bot-okkal verseny.

**Gas / fee:** Tx ~$0.0001–0.001 + Jito tip (változó, 30000–5000000 lamports = $0.005–$0.85).

**Infrastruktúra:** Dedikált Yellowstone gRPC endpoint (Helius $99/hó vagy Triton One), Jito block-engine integráció, Solana validator-okkal lehetőleg co-located VPS.

**SDK / library:**
- `@solana/web3.js`, `@jito-labs/jito-ts`
- Jupiter `@jup-ag/api`
- Rust: `solana-sdk`, `jito-sdk-rust`

**GitHub repók:**
- `jito-labs/mev-bot` (hivatalos Jito 3-hop backrun TypeScript bot)
- `ARBProtocol/ARB-V2` (Solana Jupiter arb, Rust, jito tip integráció)
- `ARBProtocol/solana-jupiter-bot` (TS verzió)
- `AV1080p/Solana-Arbitrage-Bot` (multi-DEX Rust)

**Kockázatok:** Solana congestion, 76,8% non-vote failure rate átlag MEV bot-oknál (Coinfeeds adat), bundle tip elveszik ha nem land, validator scheduling lottery.

### B7. CEX-DEX statisztikai arbitrázs cross-exchange market making (Hummingbot XEMM)

**Mit csinál:** Maker order Hyperliquid / Injective / Osmosis DEX-en, taker order a hedge venue-n (Binance vagy Bybit) ha kitöltődik. A min_profitability spread-en felül market-makel. Hummingbot built-in `cross_exchange_market_making` (XEMM) strategy.

**Matematikai alap:** Klasszikus liquidity-mirroring. A profit elsősorban a price-discovery aszinkronból (CEX vezet, DEX lemarad) jön. A "Black-Scholes formula for AMMs" (Milionis–Moallemi–Roughgarden–Zhang) szerint pontosan ez az LVR a hagyományos LP terhére – itt te vagy a piaca a DEX-en, de manuálisan re-quote-olsz.

**Becsült hozam $500–$5,000:** 10–30% APR realisztikus stabil pár (BTC, ETH, SOL) makelése thin DEX-en, ahol a spread > 0,1%.

**Gas / fee:** DEX-en (Injective zero gas, Osmosis ~$0.01) + CEX fee (Binance 0.075% taker → VIP1+ vagy BNB discount ajánlott).

**Infrastruktúra:** Hummingbot dokkerben, VPS (Tokyo / Singapore – Binance Tokyo közeli), dedikált RPC.

**SDK / library:** Hummingbot natívan támogatja, ezen kívül `ccxt` Binance-hez, `pyinjective` Injective-hez, `osmojs` / `@cosmjs/stargate` Osmosis-hoz.

**GitHub repók:** `hummingbot/hummingbot` `cross_exchange_market_making` strategy; Hummingbot Botcamp tutorials.

**Kockázatok:** Inventory drift (CEX-en több BTC kell mint amennyi nálad van DEX-en), withdraw lag (CEX → DEX átutalás minutes); exchange szolvencia.

---

## 3. Stratégiák összehasonlító táblája

| # | Stratégia | Platform | Tőkeigény | Becsült APR (nettó, $500–$5k-ra) | Infra-igény | Kockázat |
|---|---|---|---|---|---|---|
| A1 | Cross-DEX arb signal | Netlify cron | $500+ | 5–60% (variancia hatalmas) | Alacsony | Race condition |
| A2 | Funding skenner | Netlify + VPS exekutor | $500+ | 8–25% | Alacsony | Likvidáció |
| A3 | Stat arb signal | Netlify + külső Python | $500+ | 15–35% | Közepes | Rezsim |
| A4 | On-chain signal | Netlify | $500+ | 10–25% | Alacsony | Data quality |
| A5 | CL rebalance trigger | Netlify cron | $1000+ | 8–30% (hedged) | Közepes | IL/LVR |
| B1 | Osmosis cyclic arb | VPS Frankfurt | $500+ | 50–300% (variancia!) | Közepes | ProtoRev, spam |
| B2 | BSC PancakeSwap arb | VPS Singapore | $1000+ | 0–60% | Magas | Erős verseny |
| B3 | UniV3 active LP | VPS, Base/Arb | $1000+ | 8–25% (hedged) | Magas | LVR, hack |
| B4 | Avellaneda–Stoikov MM | VPS, Helix/Hyperliquid | $1000+ | 20–80% (alt párok) | Közepes | Inventory |
| B5 | Flash arb L2 | VPS + dedikált node | $0 (flash loan) | 0–60% | Nagyon magas | Verseny, revert |
| B6 | Solana Jito backrun | VPS + Helius | $500+ | 0–40% | Nagyon magas | Bundle race |
| B7 | XEMM Hummingbot | VPS | $1000+ | 10–30% | Közepes | Withdraw lag |

---

## 4. Realisztikus portfólió-allokáció $1,000 és $5,000 tőkén

**$1,000 (agresszív, retail-fókuszú):**
- $400 – Cosmos/Osmosis cyclic searcher (B1) – legjobb retail edge/cost arány
- $300 – Avellaneda–Stoikov MM Hyperliquid alt párokon (B4)
- $200 – Funding rate arb skenner + manuális exekúció (A2)
- $100 – Stat arb cointegráció CEX-en (A3)

**$5,000:**
- $1,500 – Osmosis cyclic + Injective on-chain MM (B1 + B4)
- $1,500 – Concentrated LP Base/Arbitrum hedged (B3) + Netlify rebalance trigger (A5)
- $1,000 – Funding rate arb delta-neutral 3 venue-n (A2 + Hummingbot exec)
- $500 – Stat arb cointegráció pairs (A3)
- $500 – BSC PancakeSwap thin-pool arb (B2) tanuló/exploratív

---

## 5. Mit kerülj el ezen a tőkenagyságon (evidencia-alapú)

1. **Ethereum mainnet atomic MEV searcher** – Flashbots saját 2025-ös elemzése szerint a top 10 builder vágja zsebre a profit 60%-át; a bare-metal kolokáció nélküli retail searcher nettó negatívan teljesít a revert/gas loss miatt.
2. **Flash loan arb mint főstratégia** – a "$200M flash loan $3.24 profitért" Arkham 2023-as anekdota tipikus: a tőkeméret irreleváns, a sebesség minden. Ha még nem nyertél manuál arb-ot $1k-on, ne pénzelj flash loan-os bot-ot.
3. **Marketing "100x APR" botok** (Telegram-szerű) – ezek vagy 1-2 hét backtest cherry-pick, vagy közvetlen scam (private key exfiltráció).
4. **Sandwich attack-ek** – nem csak etikailag problémás, hanem retail-szinten elérhetetlen: a Flashbots mev-share opt-in flow miatt csak backrun-okat tudsz nyerni, sandwich-hez exclusive builder integráció kell.
5. **Spread-token chasing rug pool-okon** – a "100% spread" UNIv3 pool-ok 99%-ban honeypot-ok; whitelist nélkül minimum $200/hét veszteség.

---

## 6. Akadémiai és quant források a továbbtanuláshoz

**Primer akadémiai irodalom (mind ingyenes/preprint):**
- Milionis, Moallemi, Roughgarden, Zhang. *Automated Market Making and Loss-Versus-Rebalancing*. arXiv:2208.06046 (2022).
- Cartea, Drissi, Monga. *Decentralised Finance and Automated Market Making: Predictable Loss and Optimal Liquidity Provision*. arXiv:2309.08431.
- Cartea, Drissi, Monga. *Automated Market Making and Decentralized Finance*. arXiv:2407.16885.
- Hashemseresht et al. *Adaptive Liquidity Provision in Uniswap V3 with Deep Reinforcement Learning*. arXiv:2309.10129.
- Wu, Sui, Thiery, Pai. *Measuring CEX-DEX Extracted Value and Searcher Profitability*. arXiv:2507.13023 (2025).
- Heimbach, Wattenhofer. *A²MM*. arXiv:2106.07371.
- Tadi, Kortchemski. *Evaluation of Dynamic Cointegration-Based Pairs Trading Strategy in the Cryptocurrency Market*. arXiv:2109.10662.
- Chaliasos et al. *First-Spammed, First-Served: MEV Extraction on Fast-Finality Blockchains*. arXiv:2506.01462 (2025).
- Wan et al. *Strategic Analysis of Just-In-Time Liquidity Provision in CLMMs*. arXiv:2509.16157 (2025).
- *Cross-Chain Arbitrage: The Next Frontier of MEV in Decentralized Finance*. Proc. ACM SIGMETRICS 2025.
- Avellaneda, Stoikov. *High-Frequency Trading in a Limit Order Book*. Quantitative Finance 8(3) 2008.
- Stoikov et al. *Market Making in Crypto*. SSRN 5066176 (2024).

**Quant blogok / industry research:**
- **a16z crypto**: LVR series (Milionis–Moallemi posts), v4 LP design.
- **Paradigm Research**: searcher economics, MEV-share.
- **Gauntlet**: AMM parameter optimization, Compound/Aave risk modelling.
- **Flashbots Writings**: *MEV and the Limits of Scaling* (2025), `simple-blind-arbitrage` tutorial.
- **Skip Protocol / Mekatek blog**: Cosmos MEV market structure.
- **Panoptic blog**: backtester, perp option replication of LP.
- **Reverie**: *Approaches to MEV: Ethereum vs Cosmos*.
- **DefiLab.xyz / Charm Finance** dashboards a Uniswap v3 LP historical performance-hez.

**Code repó-aggregátorok:**
- `GammaStrategies/awesome-uniswap-v3`
- `fewwwww/awesome-uniswap-hooks`
- `topics/triangular-arbitrage` GitHub
- `hummingbot/hummingbot` és Hummingbot Botcamp

---

## 7. Záró megjegyzések és figyelmeztetések

1. **A "becsült éves hozam" oszlopok a felsorolt akadémiai és quant blog forrásokból származó *historikus* tartományok, nem előrejelzés.** Az ex-ante várt hozam a piaci verseny intenzifikálódásával csökkenőben van minden szegmensben – kifejezetten az atomic MEV piacokon.
2. **Smart contract risk univerzális.** A 2025-ös Bunni (Uniswap v4 hook) hack arra figyelmeztet, hogy az audit-olt kontraktokon is állandóan jelennek meg újabb exploit minták. Soha ne tedd az össz tőkédet egy protokollba.
3. **A "marketing 1000% APR" típusú forrásokat tudatosan kerültem.** Minden számszerűsített hozam akadémiai paperből, Flashbots/Paradigm/a16z elemzésből, vagy Hummingbot/Skip Protocol/Osmosis dokumentációból származik.
4. **A $500–$5,000 sávban az átlagos retail kereskedő `gas/fee + revert + opportunity cost`-on nem termel pozitív kockázat-adjustált hozamot.** Ez a kutatás stratégiát mutat be, de a végrehajtás minősége (RPC, latencia, exception handling, monitoring) determinálja a nyereséget, nem a stratégia maga.
5. **A jogi környezet változik.** Az ESMA 2025 júliusi *Maximal Extractable Value: Implications for Crypto Markets* dokumentum (ESMA50-481369926-29744) jelzi, hogy MiCA alapján egyes MEV stratégiák piaci visszaélésnek minősülhetnek az EU-ban. Konzultálj jogásszal mielőtt sandwich/front-running-szerű stratégiát futtatsz.

---

*A jelen jelentés kizárólag oktatási és kutatási célt szolgál, nem befektetési tanácsadás.*