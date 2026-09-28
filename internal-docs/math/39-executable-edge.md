# 39 — Végrehajtható edge (könyv-VWAP) + tőkegörbe-alapú vol-target (B75)

> Kód: [`packages/core/src/executable-edge.mts`](../../packages/core/src/executable-edge.mts) · [`services/worker/src/pillars/shared/executable-edge.mts`](../../services/worker/src/pillars/shared/executable-edge.mts) · [`packages/core/src/risk-overlay.mts`](../../packages/core/src/risk-overlay.mts) `equityReturnsFromTrades` · feladat: [sprints B75](../roadmap/sprints.md)

## 1. A probléma

A crypto és a weather döntési motor az edge-et a Gamma `outcomePrices` árán számolja:

$$\text{edge}_{\text{quote}} = |p - m| - \text{fee}$$

ahol $m$ a piac közép/utolsó ára. Ezen az áron azonban senki nem ad el. A depth-aware fill modell (math/18) a valódi ask-könyvet járja be, és egy
másik árat talál. 2026-09-14 és 09-28 között a 68 kereskedési döntésből 68-at elutasított, és 20-ból 14-nél a könyv-VWAP több mint 10¢-tel a quote
fölött volt (pl. 0,22 → 0,37). A kijelzett 15–20%-os edge nagyrészt spread volt.

## 2. A végrehajtható edge

A választott oldalra ($s \in \{\text{YES}, \text{NO}\}$) a szándékolt $Q$ USDC-méretre szimulált fill átlagára $\text{VWAP}_s(Q)$
(ugyanazzal a `simulateDepthFill`-lel és részvételi plafonnal, amivel a paper fill is tölt). Ekkor

$$\text{edge}_{\text{exec}} = P(s) - \text{VWAP}_s(Q) - f_{\text{exit}}$$

ahol $P(\text{YES}) = p$, $P(\text{NO}) = 1-p$, és $f_{\text{exit}}$ csak a kilépési díj (a belépő slippage már a VWAP-ban van — ugyanez a
paper-resolver elszámolása bekapcsolt fill modellnél, `settlementFeePctFillModel`). A kötés feltétele:

1. $\text{edge}_{\text{exec}} \ge$ a motor saját `edgeThreshold`-ja (crypto 15%, weather 12%);
2. a kitöltött részvényszám $\ge 5$ (Polymarket minimum).

Ha a könyv nem érhető el, a fill modell konzervatív haircut-fallbackja árazza — sosem a nyers quote. A kapu csak `fillModelEnabled=1` mellett aktív
(kikapcsolt fill modellnél a paper fill a quote-on tölt, nincs második ár). A weather kísérleti `invertDirection` módjában kimarad: ott a bot
szándékosan a modell-valószínűség ellen fogad.

**Replay az élő 68 döntésen:** 7 érte volna el a 15%-ot; a medián végrehajtható edge −0,3%, a maximum 29,7%. Ez optimista becslés, mert a mért
VWAP a negyedére zsugorított méretre szólt.

## 3. Vol-target bináris pozíciókra

A math/25 vol-targetje $\text{mult} = \text{clamp}(\sigma^*/\hat\sigma, 0{,}25, 1{,}5)$. A $\hat\sigma$ eddig a trade saját `pnlPct`-jének szórása
volt. Bináris kifizetésnél ez konstrukció szerint ~1 vagy nagyobb (−100% vagy +x00%), így a szorzó minden lehetséges történetnél a 0,25-ös padlón ült.

Helyesen a **tőke** per-trade hozamát kell mérni:

$$r_i = \frac{\text{pnl}_i}{E_{i-1}}, \qquad E_i = E_{i-1} + \text{pnl}_i, \quad E_0 = \text{bankrollStart}$$

Egy 8%-os ¼-Kelly tét elvesztése −8%-ot mozdít a tőkén, nem −100%-ot. Élő adaton (crypto, n=10): $\hat\sigma = 0{,}059$, szorzó **1,000**. A felső
korlát bináris pozícióknál `maxMult = 1`: az overlay csak zsugoríthat, a 8%-os binary capet nem lépheti túl.

## 4. No-fill őr

Minden egymás utáni `ORDER_REJECTED` növeli a számlálót, egy `ORDER_FILLED` nullázza. Öt egymás utáni elutasításnál (utána 20-anként)
`NO_FILL_WATCHDOG` logsor íródik, és Telegram-riasztás indul, ha van token. A napi drift-check 10. pontja a logból számolja a
teljesítési arányt. A `DECISION_TRADE` közvetlenül a megbízás előtt logol, így minden ilyen sort pontosan egy `ORDER_PLACED` vagy `ORDER_REJECTED` követ.

## 5. Mit NEM old meg

A kapu nem teremt edge-et, csak kiszűri a nem létezőt. A kötések száma várhatóan alacsony marad, mert a mérés szerint a threshold-ág edge-e
a valódi áron legtöbbször nincs meg. A nagyobb paper-tőke nagyobb megbízást jelent, ami mélyebbre járja a könyvet: a VWAP romlik, és ezt a kapu
helyesen figyelembe veszi.
