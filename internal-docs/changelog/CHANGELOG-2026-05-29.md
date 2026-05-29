# 2026-05-29 — HL Perp performance-audit + consecutive-loss deadlock fix

## TL;DR

A user kérte a Hyperliquid bot teljesítmény-ellenőrzését (`mj-trading.netlify.app/trade/hyperliquid/`). A [trade-history-audit playbook](../playbooks/trade-history-audit.md) 5-step procedure-jét követve a history **valid** (bankroll-rekonciliáció bit-pontos), de **két komoly problémát** tárt fel, amelyből egy deterministikus kód-bug — ezt lejavítottuk.

1. **🔴 Consecutive-loss DEADLOCK (lejavítva — Sprint 42G)**: a HL paper bot **12 napja (2026-05-17 óta) nem kereskedett**, miközben a cron futott (`lastRunAt` ma). Gyökérok: a `consecutiveLosses` counter (5) ≥ `consecutiveLossLimit` (3), és a [`decision-engine.mts:108`](../../netlify/functions/auto-trader/hyperliquid/decision-engine.mts) minden tick-en blokkol amíg a counter ≥ limit. A counter **csak nyertes trade-en** nullázódik ([`session-manager.mts:96`](../../netlify/functions/auto-trader/hyperliquid/session-manager.mts)) → nincs trade → nincs win → permanens block. Az `applyConsecutiveLossPause` csak a `pausedUntil` cooldown-ablakot állította, a countert nem; a `:108` gate viszont a nyers countot nézi, nem a pause lejártát. A "design intent 1h pause" valójában **örökös leállás** volt.

2. **🟠 Directional long-bias (NEM kód-bug → B18 vizsgálat)**: a 22 closed trade **mind LONG** (21× BTC, 1× ETH), win rate 27.3%, calibration-deviation 32.7%, profit factor 0.31. Ez signal-quality / regime-kérdés (n=22 statisztikailag elégtelen), nem deterministikus bug — a playbook §8.2/§8.9 szerint spekulatív irány-kényszerítés tilos. Felvéve mint **B18** backlog-vizsgálat (precondition: 30+ trade).

## Audit-eredmény (read-only, 5-step playbook)

- **Adatforrások:** `auto-trader-api?action=status&category=hyperliquid`, `edge-tracker?category=hyperliquid`, közvetlen Binance BTC/ETH/SOL spot, `trader-settings`. (Gamma cross-check **nem alkalmazható** — HL perp pozíciók, nem Polymarket binary.)
- **PnL-reprodukció** ([`hyperliquid/paper-resolver.mts:82`](../../netlify/functions/auto-trader/hyperliquid/paper-resolver.mts) modell: `gross = sizeCoins×(exit−entry) − notional×0.0007 − funding`): mind a 22 trade sign + magnitúdó konzisztens. **Bit-pontos reprodukció korlátozott**, mert az edge-tracker a `sizeCoins`-t 4 tizedesre kerekíti (~$50 notional, 3× lev → ±6% gross-bizonytalanság) — őszintén jelezve a usernek.
- **Bankroll-rekonciliáció (✓ pontos):** `$200 + (−$3.55 Σ closedPnL) − $0 open = $196.45`. A Σ(22 pnl) = −3.55 kézzel ellenőrizve egyezik a `sessionPnL`-lel; `sessionLoss` Σ(losers) = $5.16 ✓, Σ(wins) = $1.61 ✓. **Belső számvitel hibátlan.**
- **Sub-threshold trade-ek** (#3 edge 0.081, #13 0.087, #14 0.086, #16 0.089 < a 0.12 paper edge-threshold): **nem bug** — preset-history artefakt (a trade-ek alacsonyabb effektív `hlEdgeThresholdPaper` mellett nyíltak, a jelenlegi effektív 0.12 override nélkül). Playbook §4.3 analóg.
- **Statisztika (n=22, live-readiness 2/5 gate):** Sharpe −0.43 (95% CI −1.2…+0.03), profit factor 0.31, expectancy −$0.16/trade, longest loss streak 5 (= current). Mind gyenge, de n=22 alatt nincs erős IC/Sharpe következtetés (playbook §6.4).

## Mit változtattunk (Sprint 42G — deadlock fix)

| Fájl | Változás |
|---|---|
| [`shared/types.mts`](../../netlify/functions/auto-trader/shared/types.mts) | Új `PAUSE_AUTORECOVER` LogEvent (audit-trail). |
| [`hyperliquid/session-manager.mts`](../../netlify/functions/auto-trader/hyperliquid/session-manager.mts) | Új pure helper `clearElapsedConsecutiveLossPause(s, limit)` → `{session, cleared}`: lejárt `pausedUntil` + counter ≥ limit → counter→0, pausedUntil→null (idempotens; ACTIVE pause-t nem nyúl). **`resumeHlSession` fix**: a `pausedUntil=null` mellett most a `consecutiveLosses`-t is 0-ra állítja, különben a `resume` nem oldotta volna fel a deadlockot. |
| [`hyperliquid/index.mts`](../../netlify/functions/auto-trader/hyperliquid/index.mts) | A runner a stopped-check és a pause-check **között** hívja a recovery-helpert; `cleared` esetén `PAUSE_AUTORECOVER` log + a normál `saveHlSession` (tick végén, nincs köztes early-return) perzisztálja. |
| [`shared/hl-consec-loss-recovery.test.mts`](../../netlify/functions/auto-trader/shared/hl-consec-loss-recovery.test.mts) | **Új** — 6 unit test: bricked-live-state recovery, active-pause-held, below-limit no-op, no-pause no-op, idempotencia, resume-clears-count. |

**Önfelépülés:** a meglévő bricked session (counter=5, pausedUntil=2026-05-17) **deploy után a következő cron-tick-en magától felépül** — nincs szükség `reset`-re (ami a 22-trade history-t + IC-kalibrációt törölné). Alternatív azonnali unbrick: `resume` action (most már működik, history-megőrző).

**Verifikáció:** `npx tsx hl-consec-loss-recovery.test.mts` ✓ (6/6), `topup-action.test.mts` ✓ (regresszió-mentes), `npx tsc --noEmit` ✓, `npm run build` ✓.

## Követő tételek (sprints.md)

- **Sprint 42G** ✅ (ez a fix) — Completed sprints.
- **B18** 🟠 — HL Perp directional long-bias vizsgálat (precondition: 30+ trade).

---

# 2026-05-29 (b) — Weather cron életre keltése (multi-cron fan-out) — Sprint 43

## Tünet (user-report)

> „a weather bot nagyon régen nyitott pozíciót! mintha nem látná az élő kereskedéseket amiket értékelni kellene"

## Diagnózis

Ugyanaz a **„cron futott, a bot mégsem kereskedett" osztály**, mint a HL deadlock — de **eltérő gyökérok** (ott counter-block, itt nem-regisztrált scheduled function).

| Bot | Utolsó cron-futás (2026-05-29 12:51 UTC) | `runStatus.source` |
|-----|------|--------|
| Crypto | 95 mp-e | `cron` ✅ |
| Hyperliquid | 100 mp-e | `cron` ✅ |
| **Weather** | **2026-05-21 (≈8 napja)** | **`manual`** ❌ |

A `runWeatherTrader` minden futás elején **és** végén frissíti a run-state Blobot
(`source: "cron"` cron-tick esetén). A weather `runStatus.source` viszont **soha**
nem volt `cron`, csak `manual` → a Netlify **egyszer sem hívta meg** az
`auto-trader-weather-cron` ütemezett function-t.

### Gyökérok

Pattern-korreláció a function-deklarációkban:

- **Tüzelő cronok** (`auto-trader` directory-function, `auto-trader-multi-cron`):
  sima `export default handler` + netlify.toml `schedule`, **nincs** `schedule()` wrapper.
- **NEM tüzelő cronok** (`auto-trader-weather-cron`, `auto-trader-weather-reconciler-cron`):
  mindkettő a legacy `export const handler = schedule("…", …)` wrappert használja a
  `@netlify/functions`-ből.

A `.mts` + esbuild bundler alatt a `schedule()` wrapper minta nem regisztrálódik
megfelelően → se a weather trader, se a weather reconciler cron nem futott.
A `weatherCronEnabled` toggle rendben `true` volt (override üres, env default true),
tehát nem az volt a baj.

### Másodlagos megfigyelés (timing, nem bug)

12:51 UTC-kor az egyetlen elérhető weather temp-piac 3 ázsiai város
(Shanghai/Seoul/HK „May 29"), mind `endDate = 12:00 UTC` → helyesen `expired`-ként
skippelt. A napi kereskedési ablak ≈ 00:00–12:00 UTC. A manuális run igazolta,
hogy a trader kódútja ép — csak a cron nem indította.

## Fix — weather befűzése a `auto-trader-multi-cron` fan-out-ba

Választott megközelítés (user): a bizonyítottan tüzelő `*/3` multi-cron újrahasznosítása.

| Fájl | Változás |
|---|---|
| [`auto-trader-multi-cron.mts`](../../netlify/functions/auto-trader-multi-cron.mts) | `FanOutTarget.body.action` szélesítve `"run" \| "reconcile"`-ra; két új target: `{run, weather}` + `{reconcile, weather}`. A dispatcher már most is routol `category: "weather"` + `run/reconcile`-t (`auto-trader/index.mts` :220 / :265), `?source=cron`-nal. |
| [`auto-trader/index.mts`](../../netlify/functions/auto-trader/index.mts) | Weather `run` ág: `cronEnabled` toggle-tisztelet megőrzése — ha `source === "cron" && !wConfig.cronEnabled` → `skipped`. A manuális „Scan" gomb a toggle-tól függetlenül fut (változatlan). Korábban a pause-mechanizmust a most kivezetett wrapper gate-elte; ez a guard reprodukálja. |
| [`netlify.toml`](../../netlify.toml) | A két halott `schedule` entry (`auto-trader-weather-cron` */5, `auto-trader-weather-reconciler-cron` */15) eltávolítva. |
| `auto-trader-weather-cron.mts` + `auto-trader-weather-reconciler-cron.mts` | **Törölve** (a multi-cron lefedi mindkettőt). Egyik fájlra sem hivatkozott semmi (csak komment + UI label). |
| [`WeatherTrader.tsx`](../../src/components/trader/WeatherTrader.tsx) | Cron-pill: `intervalLabel "5 min" → "3 min"`, title a multi-cron fan-out-ra. |
| [`trader-settings.mts`](../../netlify/functions/trader-settings.mts) | `weatherCronEnabled` help: régi `*/5` helyett `*/3` multi-cron + 2026-05-29 megjegyzés. |

### Hatás

- A weather trader + reconciler mostantól minden `*/3` cron-tick-en lefut, ugyanazon
  a fan-out-on mint a HL/F-Arb/Sports → a következő deploy után automatikusan
  nyit/zár paper pozíciókat a 00:00–12:00 UTC ablakban, amikor van aktív piac.
- A reconcile most `*/3` (korábban `*/15` lett volna) — idempotens, csak az
  `endDate`-en túli pending pozíciókra hat, Gamma-cache védi, így ártalmatlan.
- A `weatherCronEnabled` pause-toggle továbbra is működik (cron-tick-eken).

### Verifikáció

- `npx tsc --noEmit` → exit 0; `npm run build` → exit 0, 10 oldal.
- Manuális `action=run&category=weather` (deploy előtt) → `skipped: "No active weather
  temperature markets found"` (mind a 3 piac expired 12:00 UTC után) — a kódút ép.
- **Élesedés**: a fix a következő `netlify deploy --prod` után lép életbe; ellenőrzés:
  `runStatus.source` weather-en `cron`-ra vált és `lastRunAt` frissül 3 percenként.

→ Sprint-tracker: `internal-docs/roadmap/sprints.md` Sprint 43.

---

## (c) — Crypto deploy-gap audit + Netlify build-fix (45. session)

### Trigger

User: *"ellenőrizd és értékeld az élő oldalon a bot általi összes kereskedést (https://mj-trading.netlify.app/trade/crypto/) … validáld … értékeld a bot teljesítményét!"* → a [`playbooks/trade-history-audit.md`](../playbooks/trade-history-audit.md) 5-step procedure-je.

### Audit eredmény — a history VALID, de a teljesítmény katasztrofális

45 closed trade (2026-05-15 → 05-28), 5 open.

- **Step 1 — Gamma cross-check**: 16 reprezentatív trade (mindkét irány) verify-olva a `gamma-api…&closed=true`-n → **mind egyezik**, minden `closedAt > endDate` (nincs pre-resolution close).
- **Step 2 — PnL reprodukció**: a 3.6% roundtrip fee modell mind a **45 trade-en bit-pontos** (max eltérés 0.000000 USD). Loserek `−103.6%` (helyes fee-ujjlenyomat).
- **Step 3 — Bankroll-rekonciliáció**: `$250 + (−$109.75) − $30.56 open = $109.69` ✓ (diff 0.0000).
- **Step 5 — Statisztika**: 22.2% WR (10W/35L), profit factor **0.72**, Sharpe −0.07, **evGap −$742.41**, max DD **152%**, calibrationDeviation 14.2%.
- **Értékelés**: a 10 győztesből 9 **NO/short** fogadás volt egy eső piacon (BTC ~$80k→$73k) → **béta, nem alfa**. A predikciók laposak (minden `predictedProb ∈ [0.45, 0.55]`) = a §4.1 "flat finalProb" minta.

### Gyökérok — a Sprint 41-42B fixek 2 hétig élesítetlenek voltak

A `NO@72k-may-29` open pozíció **tárolt entryDecision-je csak 15 gate-et** tartalmazott (a 16. Outcome-overlap hiányzott), pedig a repo HEAD-en 16 van. A production tehát a **05-15 előtti kódot futtatta**. A user megerősítette: **a 2026-05-15-i Netlify deploy ELBUKOTT**:

```
ERROR: The following serverless functions failed to deploy: signal-combiner-threshold.test
To deploy these functions successfully, change the function names to contain only
alphanumeric characters, hyphens or underscores
```

Ok: a Sprint 41-ben hozzáadott `netlify/functions/signal-combiner-threshold.test.mts` a functions-könyvtár **top-level**-jén volt → a Netlify functionként bundle-elte, és a `signal-combiner-threshold.**test**` névben a **pont érvénytelen**. A deploy a function-bundling stage-en megszakadt → a K-fix + outcome-overlap gate #16 + K-blind downweight + topup **mind élesítetlen maradt**. A bot a régi 15-gate kódot futtatta, Loose preset (0.02) + $1000 loss-limit override mellett → szabad zaj-kereskedés, $250→$109.

### Build-fix (kód — committed + pushed + deployed)

- **Első próba (`b24d3cd`)**: `_tests/` alkönyvtárba mozgatás — **nem működött** (a Netlify a `_`-prefixű mappa loose fájlját is functionként vette, a 21:07-es deploy ugyanazzal a hibával bukott).
- **Valódi fix (`5d910c8`)**: áthelyezés `netlify/functions/auto-trader/shared/`-be. Ott már él 3 másik `.test.mts` (cross-position-gates, topup-action, hl-consec-loss-recovery), és a 05-15-ös hibalog **kizárólag** a top-level fájlt listázta — bizonyíték, hogy az `auto-trader/` alatti fájlok (a mappának van `index.mts`-e → egyetlen function) **nem** külön functionök. A test self-contained (lokális `parseThresholdK`), `npx tsx` zöld. Path-kommentek frissítve.
- **Deploy zöld** ✅, az új kód élő-verifikálva: `combinerKBlindDownweight` megjelent a `trader-settings` schemában, 16 gate aktív.

### Operatív akciók (user-jóváhagyott, auth-olt live API)

| Akció | Érték | Megjegyzés |
|---|---|---|
| `combinerKBlindDownweight` | **0.5** | a maradék lapos-jel (momentum/pairs_spread exact 0.5) ellen |
| `combinerConfidenceMin` | **0.02 → 0.05** | Loose → Normál preset (a user saját terve volt 30+ trade után) |
| `sessionLossLimit` | **marad $1000** | a user explicit választása (friss $250 sessionön gyakorlatilag nincs circuit-breaker) |
| crypto session | **reset** | tiszta lap ($250 / 0 trade); a 45 buggos-kód trade + IC-kalibráció törölve |

> Megjegyzés: ez az audit-rész **azért** került changelogba (a playbook §8.3 szerint pusztán verifikáció nem kerülne ide), mert egy **valódi kód-bug** (deploy-blokkoló test-fájl elhelyezés) lett lejavítva.

---

## (d) — Bidirekcionális F-Arb (reverse arb, paper) — Sprint 44 (45. session)

### Trigger

A 4. bot (Funding-Arb) auditja. Élő állapot: cron fut (`source: cron`, 5 coin / 3 min), `bankrollShared $196.45` (= HL), de **0 closed trade 2026-04-21 óta**. Gyökérok az `arb-detector.mts`-ben:

```js
// Spread must be positive (HL pays more than Binance to shorts)
if (spread < config.minSpreadHourly) { skip }
```

A bot **egyirányú** (HL-short + Binance-spot-long), csak pozitív spreaden lép. A jelenlegi regime-ben a spreadek negatívak (BTC −0.1106%/h, ETH −0.0202, AVAX −0.0028; SOL +0.0013 küszöb-alatti) → semmi nem viable. A nagy negatív BTC spread **fordított irányban +0.1106%/h ≈ 968%/yr** lenne, de a bot ezt strukturálisan kihagyta.

### Mit változott (irány-tudatos detektor + economics)

- **`types.mts`**: `ArbOpportunity` + `ArbPosition` kapott `direction: "forward" | "reverse"` mezőt (+ `score` az opportunity-n = `|spread|`). Backward-compat: a régi pozíciók `direction ?? "forward"`.
- **`arb-detector.mts`**: a jobb-scoringú irányt választja. **FORWARD** (spread ≥ min): HL-short, carry = hlFunding. **REVERSE** (−spread ≥ min): HL-long + Binance-perp-short, carry = `binanceRate − hlRate = −spread`. Ranking + break-even a `score`-on. Live reverse → `isViable=false` + reason (spot-only).
- **`fr-session.mts` (`accrueFunding`)**: irány-tudatos. A snapshot most a Binance rátát is hordozza; `effRate = reverse ? (binanceRate − hlRate) : hlRate`.
- **`fr-executor.mts`**: reverse + live → hard block (open ÉS close). Paper reverse modellezi a HL-long + Binance-short lábakat (nincs live hívás; a PnL funding-only, az ár-lábak delta-neutrálisan kiejtik egymást).
- **`index.mts` (run loop)**: a 8 gate (1 carry, 2 sanity-magnitude, 3 break-even), a close-check (irány-tudatos carry), az `entryDecision` (LONG/SHORT) és a result-sorok mind irány-tudatosak.

### Biztonsági korlát — miért paper-only

A reverse hedge Binance shortot igényel, de a live `hedge-manager.mts` **szándékosan spot-only** (*"only SPOT trading permissions required — never enable futures or withdrawal"*), és spot nem shortolható. Ezért a reverse **paper-only**: a bot most (paper) gyűjt reverse-trade adatot, a live-élesítés (Binance USDM futures-short adapter + perm-döntés) **→ B20** (precondition: 10+ pozitív reverse paper-trade).

### Verifikáció

- Új `netlify/functions/auto-trader/shared/funding-arb-reverse.test.mts` (8 case): forward/reverse direction+score, live-gate reason, küszöb-alatti skip, sanity-cap magnitude, accrual forward (= hlRate) és reverse (= binanceRate − hlRate, pozitív carry negatív hl-fundingon). **Zöld.**
- `npx tsx` (a 8 case) + `npx tsc --noEmit` (exit 0) + `npm run build` (10 oldal) mind zöld.

→ Sprint-tracker: `sprints.md` Sprint 44 (completed, paper) + B20 (live, backlog).

---

## (e) — F-Arb saját bankroll (HL-tól szétválasztva) — Sprint 45 (45. session)

### Trigger

A bidirekcionális F-Arb (d szekció) után a user rámutatott: a **HL-directional** (spekulatív, irányított perp — LONG/SHORT árirány-tét) és az **F-Arb** (delta-neutrális funding harvester, ami magában nyitja mindkét lábát) **két teljesen külön stratégia**. Eddig egyetlen HL bankrollon osztoztak: az F-Arb-nak nem volt saját tőkéje, a `loadHlSession().bankrollCurrent`-et olvasta méretezési referenciaként, és a `reset`/`topup` a HL sessionbe írt. Mivel a két stratégia független, a közös tőke túl-foglalási kockázatot hordozott (egyik sem vonta le a másik lekötését) és fogalmilag is helytelen volt.

### Mit változott

| Réteg | Változás |
|---|---|
| `funding-arb/types.mts` | `ArbSessionState` + `bankrollStart` + `bankrollCurrent`. |
| `funding-arb/fr-session.mts` | `DEFAULT_ARB_BANKROLL = 200`; `fresh()`/`loadArbSession` seedeli/migrálja; új `topupArbSession` + `creditArbPnl` (PnL → saját bankroll); `resetArbSession(paperMode, bankroll?)`. |
| `funding-arb/index.mts` | méretezés a saját `session.bankrollCurrent`-ből; záráskor `creditArbPnl(netPnl)`; `arbReset` saját tőkére (nem ír HL-be); új `arbTopup`; `summarize` `bankroll`/`bankrollStart` (nem `bankrollShared`); live-readiness a saját `bankrollStart`-tal. A `loadHlSession`/`saveHlSession` import **kivezetve**. |
| `auto-trader/index.mts` | az arb-`topup` ág `hlTopup` → `arbTopup`. |
| `multi-status.mts` | `readFundingArb` a saját bankrollt olvassa (`bankrollShared: false`) → a home-page totals-ba bekerül. |
| `FundingArbPanel.tsx` | `bankrollShared`/`bankrollSharedStart` → `bankroll`/`bankrollStart`; „Bankroll (HL)" → „Bankroll"; a „(shared HL bankroll)" felirat eltűnik. |

### Tőke-modell

F-Arb nyitáskor **nem** debitál margint (a lekötést a `deployedCapital ≤ bankroll × maxCapitalPct` korlátozza); záráskor a realizált `netPnl` (= funding − fees − slippage) a `bankrollCurrent`-be folyik. Equity-modell: `bankrollCurrent` = saját tőke, a nyitott margin külön követett. A HL-directional session **érintetlen** (marad a saját $196.45-jén). Élesedés után az F-Arb a migráción át a saját $200-ával indul (0 trade / 0 open → tiszta).

### Mellékhatás — B21 tárgytalan

A korábban felvetett **B21** (shared-bankroll cross-reconciliation live-prereq) **megszűnt** — a szétválasztás gyökerestül elveszi a problémát, így B21 nem került a backlogba.

### Verifikáció

- `funding-arb-reverse.test.mts` +4 case (reset default/override, `creditArbPnl` nyereség/veszteség, `topupArbSession` additív) → **12 case zöld**.
- `npx tsc --noEmit` (exit 0) + `npm run build` (10 oldal) zöld.

→ Sprint-tracker: `sprints.md` Sprint 45 (completed).

---

## (f) — Sports bot: loss-limit kikapcsolható (paper default OFF) + topup — Sprint 46 (45. session)

### Trigger

User: *"a sport bot induljon el az élő oldalon, mert most fogja a session lost limit! paper verzióban nem kell ilyen limit vagy legalábbis lehessen kikapcsolni … és alapból paper versionban legyen kikapcsolva! vezesd be itt is hogy a bankroll-t lehessen top up-olni"*. Élő státusz: a sports bot `stopped: true`, ok „Session loss limit hit: -$35.07" ($250 → $214.93, 3 trade) — a $30-as napi loss-limit leállította, paperben.

### Mit változott

| Réteg | Változás |
|---|---|
| `sports/config.mts` | új `sessionLossLimitEnabled` mező. Env-default: **OFF paperben, ON live-ban** (`!paperMode`); env-override `SPORTS_SESSION_LOSS_LIMIT_ENABLED`. `getEffectiveSportsConfig` olvassa a `sportsSessionLossLimitEnabled` 0/1 Settings-override-ot. |
| `sports/index.mts` | a loss-limit guard CSAK akkor tüzel, ha `sessionLossLimitEnabled`. **Auto-recovery**: ha a session loss-limit miatt állt le ÉS a limit most ki van kapcsolva → a következő cron-tick magától resume-ol (a HL Sprint 42G mintájára). Új `sportsTopup` handler + `topup` a `BotDefinition`-ben. |
| `sports/session-manager.mts` | új `topupSportsSession` (additív, non-destruktív). |
| `shared/bot-registry.mts` | `BotDefinition.topup?` + `BotAction` `"topup"` + `DispatchInput.topupAmount` + dispatch-case. (Eddig a registry-native botok — sports — nem tudtak topupolni.) |
| `auto-trader/index.mts` | a registry-dispatch hívás átadja a `topupAmount`-ot. |
| `trader-settings.mts` | új `sportsSessionLossLimitEnabled` knob (0/1, default 0); a 3 sports preset bővült (Lazább/Normál **0**, Szigorú **1**). |
| `SportsTrader.tsx` | `topup` prop a TraderShell-en (💰 Top up… gomb). |

### Hatás

Deploy után paperben a loss-limit **alapból ki van kapcsolva**, és az auto-recovery a következő cron-tickkel **feloldja** a jelenlegi loss-limit-stopot → a sports bot **magától elindul** (nem kell manuális resume). A limit a Settings-ben bekapcsolható (`sportsSessionLossLimitEnabled = 1`, vagy a Szigorú preset). A bankroll mostantól **topupolható** (💰 Top up… gomb, mint a többi botnál).

### Verifikáció

- Új `shared/sports-loss-limit-topup.test.mts` (4 case): paper-default OFF, live-default ON, env-override ON, topup additív + state-preserving. **Zöld.**
- `npx tsc --noEmit` (exit 0) + `npm run build` (10 oldal) zöld.

→ Sprint-tracker: `sprints.md` Sprint 46 (completed).
