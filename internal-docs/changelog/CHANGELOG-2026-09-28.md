# CHANGELOG — 2026-09-28 (96. session)

## Kiváltó ok

A user: *„a botok már régen nem kereskednek, miért? kalibrálni kellene? összhangban van a terv és a kód? hogyan tanítsuk?"*, majd: *„csináld meg az első hármat, és bővítsd a paper budgetet, hogy ne dobja vissza a méretezés"*.

## Élő diagnózis (read-only, `ssh analytics`, worker-log 14 nap)

| Esemény | Darab |
|---|---|
| SIGNAL | 58 291 |
| DECISION_SKIP | 25 408 |
| **DECISION_TRADE** | **68** |
| **ORDER_REJECTED** | **68** |
| ORDER_PLACED / FILLED | **0** |

A botok nem álltak le: naponta több belépési döntés született, de a paper fill modell mindet visszadobta (`"paper fill below min size / invalid / implausible vs quote"`). **Korrekció a 95. sessionhöz:** a „ma is nyitott 3 NO-fade" állítás téves volt — azok `DECISION_TRADE` sorok voltak, mindegyiket `ORDER_REJECTED` követte.

Két ok, gyakran együtt:

1. **Vol-target a bináris hozamon** — a `riskVolTargetEnabled=1` a trade saját `pnlPct`-jének szórását (bináris: −100% / +x00%) célozta 10%-ra, így a szorzó mindig a 0,25-ös padlón ült. Minden megbízás a Kelly-méret negyede lett (8,95 → 2,24 $, 6,72 → 1,68 $), ami kevesebb, mint 5 részvény.
2. **Az edge a Gamma-quote-on volt számolva** — az utolsó 20 elutasításból 14-nél a könyv-VWAP több mint 10¢-tel drágább volt (0,22 → 0,37; 0,50 → 0,65). A kijelzett 15–20% nagyrészt spread volt.

A harmadik, amiért két hétig senki nem vette észre: a boxon **üres a `TELEGRAM_BOT_TOKEN`** (minden `alert*` hívás csendben elnyelődik), a napi drift-check pedig knobokat nézett, teljesítést nem.

## Változások (kód)

| Fájl | Mit |
|---|---|
| [`packages/core/src/risk-overlay.mts`](../../packages/core/src/risk-overlay.mts) | Új `equityReturnsFromTrades` — a tőke per-trade hozama (pnl / tőke-előtte). `Number(null)`-csapda kezelve (a hiányzó PnL-t kihagyja, nem 0-nak veszi). |
| [`packages/core/src/executable-edge.mts`](../../packages/core/src/executable-edge.mts) | Új pure `evaluateExecutableEdge`: `P(oldal) − VWAP − kilépési díj ≥ küszöb` és ≥ 5 részvény, explicit hibaokkal (`no_fill` / `below_min_size` / `edge_below_threshold`). |
| [`services/worker/src/pillars/shared/executable-edge.mts`](../../services/worker/src/pillars/shared/executable-edge.mts) | Runner-wrapper: könyv-lekérés + `simulateDepthFill` (a paper fill modelljével azonos) + a Why?-panelbe menő `DecisionGate`. Könyv nélkül a fill modell haircut-fallbackja árazza, sosem a nyers quote. |
| [`services/worker/src/pillars/index.mts`](../../services/worker/src/pillars/index.mts) | Crypto: a vol-target a tőke-hozamon (`maxMult 1`); új végrehajtható-edge kapu a `placeBuyOrder` előtt (`fillModelEnabled` mellett); a `DECISION_TRADE` log közvetlenül a megbízás elé került, és a vol-targetelt méretet írja. |
| [`services/worker/src/pillars/weather/index.mts`](../../services/worker/src/pillars/weather/index.mts) | Ugyanez a kapu a weather ágon (a kísérleti `invertDirection` módban kihagyva). |
| [`services/worker/src/pillars/crypto/execution.mts`](../../services/worker/src/pillars/crypto/execution.mts) | `NO_FILL_WATCHDOG`: 5 egymás utáni elutasításnál (utána 20-anként) logsor + Telegram-kísérlet. |
| [`packages/core/src/types.mts`](../../packages/core/src/types.mts) | `LogEvent += "NO_FILL_WATCHDOG"`. |

Új knob / env nincs: a kapu a meglévő `fillModelEnabled`-hez kötött.

## Mérés (a javítás valós adaton)

- **Vol-target:** a crypto 10 lezárt trade-jén a tőke-hozam szórása **0,059**, így a szorzó **1,000** (volt 0,25).
- **Végrehajtható-edge kapu, replay a 68 élő döntésen:** **7** érte volna el a 15%-ot; a medián valódi edge **−0,3%**, a maximum 29,7%. Ez optimista becslés, mert a mért VWAP a negyedére zsugorított méretre szólt.
- **Őszinte következmény:** a kötések száma nem ugrik meg. A legtöbb „edge" a spread volt, és most a döntésnél, érthető okkal esik ki. Ami átmegy, az valódi áron valódi edge.

## Verifikáció

`tsc` 0 hiba · **55/55** teszt (új: `executable-edge.test.mts`, benne a két élő eset szó szerint + egy valódi depth-walk; `risk-overlay.test.mts` B75-blokk — pozitív kontroll: a régi `pnlPct`-alap ugyanarra a történetre 0,25-öt ad) · build zöld.

## Operatív

- **Napi drift-check:** új 10. pont (teljesítési arány: DECISION_TRADE vs ORDER_PLACED / ORDER_REJECTED + `NO_FILL_WATCHDOG`). A 2. pont sports-elvárása a 95. session döntéséhez igazítva (a sports kézzel leállítva — a CLAUDE.md az irányadó).
- **Paper-tőke feltöltése** (a user kérése): a dashboard 💰 Top up gombjával, `/trade/crypto` → a feltöltés auth-os action, ezért az operátor végzi. A javítás után a 8,95 $-os megbízás már ≥ 9 részvény; a feltöltés a kisebb Kelly-méretű jelek min-méret-ütközését szünteti meg.
- Feladat: [sprints B75](../roadmap/sprints.md) · algoritmus: [math/39](../math/39-executable-edge.md).
