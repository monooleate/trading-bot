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
