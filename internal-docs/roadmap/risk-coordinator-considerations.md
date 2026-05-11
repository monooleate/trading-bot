# EdgeCalc — Risk Coordinator (NEM-implementáció dokumentum)

> **SSOT scope:** Ez a fájl a **pilléres-vs-koordinátor trade-off
> SSOT-je** — mit ad fel a pilléres modell, milyen veszélyekkel jár,
> mikor érdemes később koordinátort bevezetni. **No-build referencia**:
> nincs implementáció, csak elv.
>
> **Mit NEM találsz itt:**
> - Konkrét pilléres bot-implementációk → `../math/13-crypto-bot.md`, `14-hl-directional.md`, `15-funding-arb.md`, `16-weather-bot.md`
> - Live-mode bevezetési feltételek → [`master-plan.md`](./master-plan.md) "KRITIKUS" szekció
>
> **Dátum:** 2026-04-24
> **Cél:** Te a pilléres modell mellett döntöttél (saját bankroll, saját kill switch pillérenként). Ez a dokumentum **NEM** a coordinator implementációja, hanem annak rögzítése, **mit adsz fel** ezzel a döntéssel, **milyen veszélyekkel** kell tisztában lenned, és **mikor érdemes** később koordinátort bevezetni.
> **Status:** No-build, dokumentációs referencia.

---

## 1. Mit ad fel a pilléres modell — őszintén

### 1.1 Cross-pillar correlation risk
A pillérek **logikailag izoláltak**, de **a piacuk nem**. Példák:

- Pillér 1 (Polymarket BTC up/down) NO-t vesz, mert a Binance signal szerint BTC esik
- Pillér 3 (HL directional) BTC short-ot nyit ugyanezért az okért
- Pillér 5 (latency-arb) Bybit BTC short-ot nyit ugyanezért
- Pillér 4 (HL+Bybit funding arb) **delta-neutral**, nem érintett

**Te most**: 3 pillér × egyirányú BTC short. Ha BTC hirtelen +5%-ot megy (rövid squeeze), **mind a 3 pillér egyszerre veszít**. A "kis $20 session loss limit" pillérenként kvázi $60 össz vesztességet ad, és ez nem egy diverzifikált 3 pozíció, ez **3x koncentrált 1 pozíció**.

**Pilléres modellben ezt nem látod**, mert minden pillér csak a saját session-jét nézi.

### 1.2 Bankroll fragmentation
A pilléres modellben:
- Pillér 1: $200 (poly-crypto)
- Pillér 2: $150 (poly-weather)
- Pillér 3: $300 (hl-directional)
- Pillér 4: $400 (hl-bybit-arb)
- Pillér 5: $300 (latency-arb)
- **Össz**: $1,350

Egy adott pillanatban a Pillér 1 használhatatlan tőkével ül (épp WAIT), míg a Pillér 5 maximum kihasználtsággal akar még pozíciót, de a saját $300-jából nem fér bele. **Koordinált modellben** a Pillér 5 átmenetileg "kölcsönkérhetne" Pillér 1-től.

**Pilléres modellben fix az allokáció**, opportunity loss van.

### 1.3 Globális kill switch hiánya
Pillérenként van session loss limit ($20-$50). De **össz portfólió szinten nincs** stop. Ha 3 pillér egyszerre éri el a saját limit-jét → $90+ veszteség egyszerre, **és nem lát össz-szintű alarm-ot**.

### 1.4 Cross-venue netting hiánya
- Pillér 4 (hl-bybit-arb): HL BTC perp short $400
- Pillér 3 (hl-directional): HL BTC perp short $300

A te szempontodból ez **2 független pozíció**. A **HL margin engine szerint** ez **1 db $700 BTC short pozíció ugyanazon a wallet-en**. A margin requirement, a likvidációs ár **közös**, de a 2 pillér **nem tudja egymást**.

**Konkrét veszély**: Pillér 3 nyit egy $300 short-ot, Pillér 4 nyit egy $400 short-ot 5 perccel később. A HL margin engine látja a $700 össz exposure-t. Ha BTC megy +3%-ot, a HL liquidation engine **mindkettőt likvidálja egyszerre**, mert egy wallet-ben vannak. A pillérek session loss limitje sose triggerelt — közvetlen liquidation történt.

**Ez a legkomolyabb pilléres modell-veszély**. Mitigációhoz lásd §3.

---

## 2. Mikor jó a pilléres modell (a jelenlegi fázisban)

A pilléres modell **most a helyes választás**, mert:

1. **Egyszerűség** — kevesebb code, kevesebb bug, gyorsabb migráció
2. **Független fejleszthetőség** — egy pillér crash/buggy ≠ az egész rendszer down
3. **Sprint-szerű paper→live** — egyenként győznek meg paper-ben
4. **Strategiák független megfigyelhetősége** — kalibrálás, IC, win rate per-pillér tisztán
5. **Egyszerű mental model** — "ez egy bot, ami ezt csinálja" vs "ez 5 stratégia egy közös tőkén"
6. **Risk apetite alacsony** — induláskor $1,350 össz, max $90 napi veszteség, nem fáj annyira hogy érne minden komplexitást

Egy mondatban: **a pilléres modell a "MVP risk management"-ed**. Ez most jó.

---

## 3. Pilléres modell mellé szükséges védelmek (ezeket BUILD-old)

A coordinator nélkül **2 dolgot mindenképp** építened kell, hogy az 1.4-es likvidációs veszélyt elkerüld:

### 3.1 Per-venue exposure cap (read-only watchdog)
Egy **passzív watchdog process** (`shared/exposure-monitor`), ami **csak figyel és alert-el**, nem dönt:

```typescript
// shared/exposure-monitor/index.ts
async function checkExposure() {
  // Hyperliquid összes pozíció lekérdezés (1 wallet, mindegy melyik pillér nyitotta)
  const hlPositions = await hlClient.clearinghouseState(WALLET);
  
  for (const coin of ['BTC', 'ETH', 'SOL']) {
    const totalNotional = hlPositions
      .filter(p => p.coin === coin)
      .reduce((sum, p) => sum + Math.abs(p.notional), 0);
    
    if (totalNotional > MAX_NOTIONAL_PER_COIN) {
      await telegramAlertOps(`⚠️ HL ${coin} össz exposure $${totalNotional} > $${MAX_NOTIONAL_PER_COIN}`);
      await redis.set('alarm:hl-overexposure:' + coin, '1', 'EX', 3600);
    }
  }
  
  // Hasonló: Bybit, Polymarket
}

setInterval(checkExposure, 60_000);  // 1 perces poll
```

És a pillérek a `decision-engine`-ben **olvassák ezt az alarm flag-et**:
```typescript
// pillars/hl-directional/decision-engine.ts
const overexposureAlarm = await redis.get(`alarm:hl-overexposure:${coin}`);
if (overexposureAlarm === '1') {
  return { action: 'WAIT', reason: 'HL overexposure alarm active' };
}
```

**Ez nem koordinátor**, mert nem hoz allokációs döntést. Csak **körkörös figyelő + szabály-alapú gate**.

### 3.2 Wallet split (HL két különböző sub-account)
Hyperliquid támogatja a **sub-account**-okat. **Egyszerűbb és biztosabb** mint a watchdog, mert nem kell kódot írni:

- HL Wallet A → `pillar-hl-directional` (saját private key, saját bankroll)
- HL Wallet B → `pillar-hl-bybit-arb` (külön private key, külön bankroll)

Ezzel a HL margin engine **két külön account**-nak látja, és nem közös likvidáció. **Ezt javaslom inkább a watchdog helyett.**

```env
# Két HL kulcs
HL_DIRECTIONAL_PRIVATE_KEY=0x...
HL_DIRECTIONAL_WALLET_ADDRESS=0x...

HL_ARB_PRIVATE_KEY=0x...
HL_ARB_WALLET_ADDRESS=0x...
```

**Trade-off**: két wallet → tőkét el kell osztani előre, nem fluid, manual top-up. De ez konzisztens a pilléres filozófiával.

### 3.3 Globális kill switch (semi-manual)
A `scripts/kill-switch.sh` (lásd `hetzner-infrastructure.md` §11) az "össz-rendszer leállító". **De ez manuális**, te kell hogy kiadd.

**Auto-trigger** opció — egyszerű variáns:
```typescript
// shared/global-kill-switch/index.ts
async function checkGlobalKillSwitch() {
  // Mai össz PnL minden pillérről (Postgres query)
  const todayPnl = await pg.query(`
    SELECT SUM(pnl_usd) AS total
    FROM trade_log
    WHERE closed_at > NOW() - INTERVAL '24 hours'
      AND mode = 'live'
  `);
  
  const total = todayPnl.rows[0].total || 0;
  
  if (total < -GLOBAL_DAILY_LOSS_LIMIT) {
    await telegramAlertOps(`🚨 GLOBÁLIS DAILY LOSS LIMIT TRIGGER: $${total}`);
    await execAsync('pm2 stop pillar-poly-crypto pillar-poly-weather pillar-hl-directional pillar-hl-bybit-arb pillar-latency-arb');
  }
}

setInterval(checkGlobalKillSwitch, 5 * 60_000);  // 5 perces poll
```

`GLOBAL_DAILY_LOSS_LIMIT=100` (azaz $100 össz napi veszteség → minden pillér stop).

**Ez nem koordinátor**, mert nem allokál. Csak **össz-szintű emergency brake**.

---

## 4. Mikor jön el a koordinátor építésének ideje

A pilléres modell **nyitva van a későbbi koordinátor-ra**. Az alábbi triggerek mutatják, hogy érdemes dolgozni rajta:

### Trigger 1: A bankroll fragmentation valós opportunity loss-ot okoz
Ha 3 hónap után **a Postgres trade log-on lefuttatva**:
```sql
SELECT pillar, AVG(bankroll_utilization_pct) FROM ...
```
Ha valamelyik pillér átlagosan **<30% bankroll utilization**-t mutat, miközben másik pillér gyakran "max position cap"-pen van → koordinátor érdemes.

### Trigger 2: Cross-pillar correlation tényleg fáj
Ha az Edge Tracker megmutatja, hogy bizonyos napokon **3+ pillér egyszerre veszít** (nem véletlen szerint), az nem diverzifikáció. Cross-pillar PnL correlation > 0.5 → koordinátor érdemes.

### Trigger 3: Total bankroll skálázás
Induláskor $1,350. Ha 6 hónap után $5,000-10,000 bankroll-on jársz, **akkor érdemes** a koordinátorba ölt fejlesztési időt befektetni — addig nem éri meg.

### Trigger 4: 7+ pillér működik
5 pillérig a pilléres modell jól skálázódik. 7+ pillérnél a manual mental model már fárasztó, és a per-pillér optimalizálás nem éri meg az össz-portfolió optimalizáció előnyét.

---

## 5. Mit jelentene a koordinátor — későbbi referencia

**Ha** valaha építed (NEM most), egy minimal coordinator kb. ennyi:

### 5.1 Komponensek
```
risk-coordinator/
├── exposure-tracker.ts        # Real-time össz pozíció minden venue-n
├── allocator.ts                # Bankroll allokációs logika
├── circuit-breaker.ts          # Globális stop trigger-ek
├── correlation-monitor.ts      # Cross-pillar PnL correlation
└── api.ts                      # Pillérek lekérdezik: "kapok-e még tőkét?"
```

### 5.2 Pillér ↔ koordinátor protokoll
```typescript
// Minden pillér decision-engine elején:
const allocation = await coordinator.requestAllocation({
  pillar: 'poly-crypto',
  proposedSize: 50,
  proposedSide: 'YES',
  proposedMarket: 'BTC-up-2pm',
  edge: 0.18,
  reason: 'signal-combiner BUY YES, kelly_q=0.04',
});

if (!allocation.approved) {
  return { action: 'WAIT', reason: allocation.denyReason };
}

// Pillér nyit a `allocation.approvedSize` USD-ön (nem feltétlenül a proposedSize!)
```

### 5.3 Allokációs logika (egyszerű kezdő variáns)
```typescript
function decideAllocation(req) {
  // 1. Globális daily loss check
  if (todayGlobalPnl < -GLOBAL_DAILY_LIMIT) return { approved: false, reason: 'global daily loss' };
  
  // 2. Per-asset exposure check (BTC össz exposure minden venue-n)
  const btcExposure = getCrossVenueExposure('BTC');
  if (btcExposure + req.proposedSize > MAX_BTC_EXPOSURE) {
    return { approved: false, reason: 'BTC overexposure' };
  }
  
  // 3. Pillér confidence-based dynamic allocation
  const pillarHistoricalSharpe = getPillarSharpe(req.pillar);  // last 30 days
  const adjustedSize = req.proposedSize * Math.min(1, pillarHistoricalSharpe / 1.5);
  
  // 4. Side-aware netting (long/short balance)
  if (req.proposedSide === 'short' && getNetBtcDelta() < -EXPOSURE_LIMIT_SIDE) {
    return { approved: false, reason: 'too short BTC overall' };
  }
  
  return { approved: true, approvedSize: adjustedSize };
}
```

### 5.4 Becslés
- 2-3 hét fejlesztés
- Új process, új DB tábla, pillér decision-engine integráció
- Test coverage kritikus (egy bug = hibás allokáció = pénzveszteség)

---

## 6. Összegzés — mi a most döntés

**A pilléres modell a helyes induló választás**, **DE** építened kell:

1. **Két HL wallet** (HL_DIRECTIONAL_*, HL_ARB_*) — likvidációs koncentráció elkerülése
2. **Globális kill switch script** + **5 perces auto-trigger** ($100 daily loss → stop minden) — black swan védelem
3. **Cross-venue exposure dashboard** (Edge Tracker bővítés) — manual monitoring eszköz, nem auto

**Ne építsd**:
- Risk coordinator process
- Cross-pillar bankroll lending
- Allokációs logika

**Felülvizsgálat**: 3 hónap után, ha a §4 trigger-ek aktiválódnak, akkor visszanyitod ezt a doksit, és felépíted a §5-ös vázat.

---

**Következő dokumentum**: `new-strategies-roadmap.md` — a 36 ötlet rangsorolva (mit építs először, mit később, mit soha).
