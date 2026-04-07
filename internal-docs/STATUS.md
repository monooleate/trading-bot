# EdgeCalc – Aktuális Állapot (2026-04-08)

## Mi működik élőben (mj-trading.netlify.app)

| Tab | Státusz | Megjegyzés |
|-----|---------|------------|
| 06 Vol Harvest | ✅ Fut | RV kiszámítva, de BTC piac szűrő hibás (lejárt piacot talál) |
| 07 Order Flow | ✅ Fut | 1 trade → Kyle λ/VPIN null, mid price OK |
| 08 Apex Wallets | ⚠️ Részben | Consensus piacok megvannak de nevek hibásak (Biden/covid nonsense) |
| 09 Cond Prob | ✅ Fut | Iran April 7 vs April 15 = valódi violation (17.5¢ edge) |
| 10 Signal Combiner | ⚠️ WAIT/50% | Fut de 2-3 signal null → IR alacsony → WAIT ajánlás |

## Miért van a Tab 10 mindig 50%/WAIT

A Signal Combiner 5 signalból aggregál:
- Vol Divergence → null (BTC piac szűrő hibás)
- OrderFlow VPIN → null (1 trade, nem elég)
- Apex Consensus → ⚠️ rossz piac nevek de BUY jelzés van
- Cond Prob → 0.5 (nincs violation → neutral)
- Funding Rate → null (Binance Futures timeout)

Ha csak 2 signal aktív és mindkettő ~0.5 → combined = 0.5 → WAIT.
Ez helyesen működik – az IR = 0.088 túl alacsony kereskedéshez.

## Ismert hibák (Claude Code folytatáshoz)

### 1. Apex market name resolution (apex-wallets.mts)
A Gamma API `/markets?condition_id=X` nem ad vissza helyes piacot.
A conditionId egy hex string amit a Gamma API `conditionId` mezőként tárol.
**Valódi megoldás:** a trades response-ban lévő `title` mezőt kell használni
közvetlenül, nem külön Gamma lookup-ot csinálni.

```typescript
// A /trades response már tartalmazza:
// { proxyWallet, side, price, size, title, slug, ... }
// Ezért a trade aggregációnál a title-t kell eltárolni!
```

### 2. Vol divergence BTC piac (vol-divergence.mts)
A top volume BTC piac majdnem mindig lejárt ($150k april = 0.25h left).
**Megoldás:** endDate szűrő + outcomePrices 0.05-0.95 közé szűrés (már javítva de cache-ben van a régi).

### 3. OrderFlow – kevés trade
A Data API `/trades?asset=tokenId` csak néhány trade-t ad vissza.
Kyle λ és VPIN legalább 50 trade kell.
**Megoldás:** nagyobb limit, több piac párhuzamos lekérése.

### 4. Funding rate signal
A Binance Futures `/fapi/v1/premiumIndex` timeout-ol vagy nem elérhető.
**Megoldás:** fallback a `/fapi/v1/fundingRate` endpointra.

### 5. Signal Combiner – mikor ad valós jelzést?
A WAIT helyes eredmény ha nincs edge. Valódi BUY/SELL jelzés akkor lesz
ha legalább 3-4 signal konvergál. Ez a Tab 08 Apex Consensus javításával
fog megjelenni – az a legerősebb signal (IC=0.08).

## Deploy workflow

A projekt GitHub-on van. Minden változtatás után:
```bash
git add -A && git commit -m "fix" && git push
```
Netlify auto-deploy ~1-2 perc.

A zip fájlok csak referencia – a git repo tartalmazza a valódi kódot.

## Legfontosabb következő lépések (prioritás szerint)

1. **apex-wallets.mts getLeaderboard()** – a trades response `title` mezőjét
   kell eltárolni market-per-wallet aggregációban. Ez adja a piac nevét.

2. **vol-divergence.mts** – endDate + price szűrő (kész, deploy után él)

3. **orderflow-analysis.mts** – több trade lekérése több piacról párhuzamosan

4. **signal-combiner.mts** – ha apex_consensus adja a legerősebb BUY jelzést,
   az apex signal extractor javítása a legfontosabb

## Valódi kereskedési jelzés ami MA van

Tab 09 Iran violation:
- "Iran x Israel/US conflict ends by April 15?" = 37.4¢
- "Iran x Israel/US conflict ends by April 7?" = 19.85¢
- Edge: 17.5¢, severity: 0.88
- Logika: April 7 ⊂ April 15, tehát P(April 7) < P(April 15) ✓
- Akció: SELL April 15 YES @ 0.374 + BUY April 7 YES @ 0.199
- FIGYELEM: Ez nem guaranteed arbitrázs – a piacok nem ugyanabba a piacba
  vannak (nem complement), hanem két külön piac. A spread ~2-4¢ fee.
  Nettó edge: ~13¢ de execution risk van.

Tab 08 Apex Consensus (ha a piac nevek helyesek lennének):
- 0x8ab5... BUY confidence 0.80 (15 wallet, 12 BUY)
- Ez a legerősebb jelzés ha tudjuk melyik piacról van szó
