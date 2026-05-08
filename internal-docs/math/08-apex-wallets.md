# Tab 08 – Apex Wallet Profiler

## Áttekintés

Az apex wallet profiler a Polymarket leaderboard legjobb kereskedőit azonosítja és elemzi négy dimenzióban:

1. **Sharpe ratio** – kockázatkorrigált hozam
2. **Payout ratio** – aszimmetrikus nyereség struktúra
3. **Category specialist** – melyik kategóriában valóban jó
4. **Bot detector** – Hubble Research módszertan

---

## Sharpe Ratio

### Matematikai definíció

A wallet Sharpe ratióját a per-piac PnL sorozatból számítjuk:

$$\text{Sharpe} = \frac{\bar{r}_P}{\sigma_P} \cdot \sqrt{N}$$

ahol:
- $\bar{r}_P$ = átlagos per-market PnL
- $\sigma_P$ = PnL szórása
- $N$ = piacok száma

**Apex kritérium:** $\text{Sharpe} > 2.0$

---

## Payout Ratio (Aszimmetria)

Ez a legfontosabb mutató – a konvencionális win rate-nél sokkal informatívabb.

### Számítás

$$\text{Payout Ratio} = \frac{\overline{W}}{\overline{L}}$$

ahol $\overline{W}$ = átlagos nyerő PnL, $\overline{L}$ = átlagos vesztes PnL (abszolút értékben).

### Break-even win rate

$$\text{WR}_{BE} = \frac{1}{1 + \text{Payout Ratio}}$$

### Példa a cikkből

| Metrika | Érték |
|---------|-------|
| Átlag belépési ár | 27¢ |
| Átlag kilépési ár (nyerésnél) | 91¢ |
| Átlag veszteség | -27¢ |
| Payout Ratio | $\frac{91-27}{27} = 2.37\times$ |
| Break-even WR | $\frac{1}{1+2.37} = 29.7\%$ |
| Tényleges WR | 51% |
| **Edge** | **+21.3%/trade** |

**Következtetés:** Egy wallet ami 51%-ot nyer de 3:1 payout ratioval rendelkezik, sokkal jobb mint egy 70%-os win rate-ű wallet 1:1 payout ratióval.

### Apex kritérium: $\text{Payout Ratio} > 2.0$

---

## Category Specialist

### Motiváció

A legjobb walletok szisztematikusan **egy kategóriában** erősek, másokban pénzt veszítenek. Ha csak az erős kategóriát másolod, a teljes edge-et kapod a veszteséges kategóriák nélkül.

### Implementáció

Kulcsszó-alapú kategorizálás:

| Kategória | Kulcsszavak |
|-----------|-------------|
| crypto | btc, bitcoin, eth, sol, up-or-down, 15-minute |
| politics | president, election, trump, senate, vote |
| sports | nba, nfl, basketball, championship |
| economics | fed, rate cut, gdp, inflation, fomc |

Per-kategória win rate:

$$\text{WR}_{cat} = \frac{\#\text{nyerő piacok}_{cat}}{\#\text{lezárt piacok}_{cat}}$$

**Copy jel:** $\text{WR}_{cat} \geq 65\%$ és min. 10 trade a kategóriában.

---

## Bot Detector

### Hubble Research módszertan (4 jelzés)

#### 1. Focus Ratio

$$\text{Focus Ratio} = \frac{\text{összes trade}}{\text{egyedi piacok száma}}$$

| Értéktartomány | Interpretáció |
|----------------|---------------|
| 2-10 | Normál humán kereskedő |
| 10-20 | Gyanús |
| > 50 | Bot szint (arb bot: egy piacra fókuszál) |

#### 2. 24h lefedettség + Sleep gap

- **24h lefedettség** = aktív órák / 24
- **Sleep gap** = maximális egymást követő inaktív órák száma

Emberek tipikusan 6-8 órát alszanak. Bot: nincs sleep gap.

#### 3. Median inter-trade interval

$$\tilde{\tau} = \text{median}(t_{i+1} - t_i)$$

| Értéktartomány | Interpretáció |
|----------------|---------------|
| < 10 mp | HFT bot |
| 10-60 mp | Gyors bot |
| > 5 perc | Valószínűleg humán |

#### 4. Timing regularity (CV)

$$\text{CV} = \frac{\sigma_\tau}{\bar{\tau}}$$

Embereknél $\text{CV} > 1$ (kaotikus). Botoknál $\text{CV} < 0.3$ (metronóm).

### Osztályozás

| Bot Score | Osztály |
|-----------|---------|
| 0-14 | HUMAN |
| 15-34 | LIKELY_HUMAN |
| 35-59 | UNCERTAIN |
| 60-79 | LIKELY_BOT |
| 80-100 | BOT |

**Consensus szűrés:** BOT és LIKELY_BOT walletok automatikusan kizárva az apex consensus detektorból.

---

## Session Classifier

A 4AM ET (UTC 07-10) alacsony likviditású ablak megfigyelés:

| Session | UTC | Karakterisztika |
|---------|-----|-----------------|
| Low Liquidity | 07-10 | 4AM ET, legkevesebb verseny |
| London | 06-09 | Likviditás sweep |
| NY Open | 13-17 | Legmagasabb volume |
| NY Close | 20-23 | Napi zárás |
| Asian | 23-06 | Alacsony likviditás |

Ha egy apex wallet szisztematikusan a Low Liquidity ablakban aktív (`low_liq_pct > 25%`) → swisstony pattern.

---

## Consensus Detector

Az apex walletok (Sharpe > 2.0, WR > 60%, Payout > 2.0, nem bot) legutóbbi trade-jeit összevetve keresi ahol **2+ apex wallet** ugyanolyan irányban aktív ugyanazon a piacon.

$$\text{Confidence} = \frac{\text{dominant side count}}{\text{total sides}}$$

**¼-Kelly pozícióméretezés consensus alapján:**

$$f_{¼K} = \frac{1}{4} \cdot \frac{p \cdot b - q}{b}$$

ahol $b = \frac{1}{\text{avg price}} - 1$ és $p = \text{confidence}$.

---

## Használat

### Dashboard (Tab 08)

**Consensus tab** (alapértelmezett):
- ⟳ Consensus Scan → leaderboard lekérés → apex szűrés → consensus keresés
- Minden jelnél ¼-Kelly pozíció kalkulálva a bankroll alapján

**Leaderboard tab:**
- 1d / 7d / 30d / all ablak váltható
- Top 50 wallet PnL, volume, trade szám

**Profil tab:**
- Polymarket proxy wallet address beírása
- Teljes profil: Sharpe, payout ratio, category map, bot score, time heatmap

### Python CLI

```bash
# Demo
python apex_wallet_profiler.py --demo

# Leaderboard (7 napos ablak)
python apex_wallet_profiler.py --leaderboard --window 7d

# Consensus detection
python apex_wallet_profiler.py --consensus --window 7d

# Claude API elemzéssel
python apex_wallet_profiler.py --consensus --claude

# Egy wallet profilja
python apex_wallet_profiler.py --profile 0xd48165a42bb4eeb5971e5e830c068eef0890af35

# JSON output
python apex_wallet_profiler.py --consensus --json
```

**Fontos:** Polymarket **proxy wallet address** kell (nem az EOA/MetaMask address). A proxy address a profil URL-jében látható: `polymarket.com/profile/0x...`

---

## Forrás

- Hubble Research: *Bot Zone Analysis on Polymarket* (2026)
- Kyle, A.S. (1985): adverse selection és information coefficient
- Grinold & Kahn: *Active Portfolio Management*
