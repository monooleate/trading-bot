# EdgeCalc Weather Modul – Patch Prompt

> Ez egy patch a meglévő weather implementációhoz.
> Előbb olvasd be a meglévő weather kódot, majd implementáld
> az alábbi javításokat ahhoz illeszkedve.
> Ne kövesd vakon a struktúrát – a meglévő kód az irányadó.

---

## SZEREPED

Te egy senior TypeScript fejlesztő vagy az EdgeCalc projekten.
A weather trading modul már implementálva van.
A feladatod három konkrét problémát javítani és egy forecasting
fejlesztést bevezetni – mindkettőt a meglévő kódhoz igazodva.

**Első lépés mindig:** olvasd be a meglévő weather fájlokat,
azonosítsd a releváns kódot, és csak utána implementálj.

---

## MIÉRT KELL EZ A PATCH

Három forrásból jöttek elő a problémák:

**1. alteregoeth-ai/weatherbot repo (referencia)**
```
github.com/alteregoeth-ai/weatherbot
```
Ez a repo dokumentálja a helyes Polymarket settlement station-öket.
A mi meglévő kódunkban hibás station adatok lehetnek.

**2. suislanchez/polymarket-kalshi-weather-bot repo**
```
github.com/suislanchez/polymarket-kalshi-weather-bot
```
31 tagú GFS ensemble forecast Open-Meteo-ból – ez pontosabb
mint a mi jelenlegi fix súlyozású GFS + ECMWF megközelítésünk.

**3. Közvetlen elemzés alapján azonosított hibák**
London station: valószínűleg EGLL (Heathrow) van beírva,
de a helyes EGLC (London City Airport).

---

## JAVÍTÁS 1: SETTLEMENT STATION LOOKUP TABLE

### A probléma

A Polymarket weather piacok **repülőtéri METAR állomásokon**
szállnak el – nem városközponti koordinátákon.
A különbség 3-8°F lehet, ami 1-2°F-os bucket piacokon
garantált veszteséget okoz ha rosszul van beállítva.

### Helyes station adatok (alteregoeth repo alapján):

```
NYC     → KLGA  (LaGuardia)        NEM KNYC, NEM JFK
Chicago → KORD  (O'Hare)
Miami   → KMIA  (Miami Intl)
Dallas  → KDAL  (Love Field)       NEM KDFW (Dallas/Fort Worth!)
Seattle → KSEA  (Sea-Tac)
Atlanta → KATL  (Hartsfield)
London  → EGLC  (London City)      NEM EGLL (Heathrow)!
Tokyo   → RJTT  (Haneda)           NEM RJAA (Narita)
```

### Mit kell csinálni:

1. Olvasd be a meglévő station-config fájlt (vagy ahol a station
   adatok tárolva vannak a meglévő kódban)
2. Hasonlítsd össze a fenti helyes értékekkel
3. Javítsd ki a hibásakat
4. Ha van unit teszt a station lookup-ra, frissítsd azt is
5. Ha nincs unit teszt, adj hozzá egyet a kritikus esetekre
   (Dallas KDAL vs KDFW, London EGLC vs EGLL)

### Amit ellenőrizz minden statiónál:

```typescript
// Minden station esetén:
// 1. Az ICAO kód helyes-e?
// 2. A koordináták a repülőtérre mutatnak-e?
// 3. A city_offset értéke reális-e?
//    (repülőtér általában hűvösebb mint a városközpont)
```

---

## JAVÍTÁS 2: ENSEMBLE FORECAST UPGRADE

### A probléma

A jelenlegi implementáció valószínűleg fix súlyozással kombinálja
a GFS és ECMWF modelleket (pl. 60/40 vagy 70/30).

A suislanchez/polymarket-kalshi-weather-bot megközelítése
**31 tagú GFS ensemble**-t használ Open-Meteo-ból:
- 31 független modell futás ugyanarra a szituációra
- Az eredmény: hány tag jósol adott threshold fölé/alá
- Ez közvetlenül konvertálható valószínűséggé

### Az ensemble logika:

```
Kérdés: "Lesz-e Chicago napi max >= 78°F április 20-án?"

31 GFS ensemble tag futtatása:
  - 24 tag jósol >= 78°F-t
  - 7 tag jósol < 78°F-t

P(YES) = 24/31 = 77.4%

Ha a Polymarket price: $0.52
Edge = 0.774 - 0.52 = 25.4% → erős szignál
```

### Open-Meteo ensemble endpoint:

```
https://api.open-meteo.com/v1/forecast
  ?latitude={lat}
  &longitude={lon}
  &daily=temperature_2m_max
  &models=gfs_seamless
  &ensemble=true
  &forecast_days=3
  &timezone={tz}
```

A `ensemble=true` paraméter 31 tagú ensemble-t ad vissza.
Minden tag külön `temperature_2m_max_member{0-30}` mezőként jelenik meg.

### Mit kell csinálni:

1. Olvasd be a meglévő forecast-engine fájlt
2. Azonosítsd hogyan kombinálják a modellek outputját jelenleg
3. Add hozzá az ensemble voting opciót **a meglévő logika mellé**
   (ne töröld az eredeti megközelítést – tartsd meg fallback-ként)
4. Konfigurálható legyen: `USE_ENSEMBLE=true/false` env var
5. Ha az ensemble API nem elérhető → graceful fallback
   az eredeti GFS+ECMWF kombinációra

### Confidence számítás ensemble alapján:

```typescript
// Az ensemble egyhangúság = confidence
// 31/31 tag egyezik → confidence: 1.0
// 16/31 tag egyezik → confidence: 0.52 (coin flip)

function ensembleConfidence(
  membersAbove: number,
  totalMembers: number
): number {
  const fraction = membersAbove / totalMembers
  // A confidence az egyhangúság mértéke
  // 0.5 = coin flip (alacsony confidence)
  // 1.0 vagy 0.0 = teljes egyhangúság (magas confidence)
  return Math.abs(fraction - 0.5) * 2
}
```

---

## JAVÍTÁS 3: DYNAMIC ERROR BALANCING (DEB)

### A probléma

A fix súlyozás (GFS 60%, ECMWF 40%) nem veszi figyelembe
hogy melyik modell teljesített jobban az utóbbi időben
az adott városban, évszakban, időjárástípusban.

### A DEB ötlete (yangyuan-zhen/PolyWeather alapján):

```
Minden trade lezárása után:
  - Melyik modell jósolta pontosabban a settlement értéket?
  - Frissítsd a modell súlyokat az utóbbi N trade alapján

Pl. utóbbi 20 trade-ben:
  GFS átlagos hiba: 1.2°F
  ECMWF átlagos hiba: 0.8°F
  → ECMWF súlya nő automatikusan
```

### Mit kell csinálni:

1. Olvasd be a meglévő trade log / NDJSON struktúrát
2. Ellenőrizd: tartalmazza-e a trade log az egyes modellek
   előrejelzett értékét settlement időpontjára?
3. Ha igen: add hozzá a DEB súlyfrissítő logikát a trade
   lezárása utáni callbackbe
4. Ha nem: először bővítsd a NDJSON log struktúrát hogy
   tartalmazza a modell-specifikus előrejelzéseket
5. A DEB súlyok perzisztálódjanak (nem reset-elődnek
   minden futásnál)

---

## AMIT NE CSINÁLJ

- Ne törd el a meglévő paper trading logikát
- Ne változtasd meg a NDJSON log meglévő mezőit
  (csak adj hozzá új mezőket)
- Ne legyen blokkoló a DEB – ha nincs elég historikus adat
  (< 10 trade), használja az eredeti fix súlyozást
- Ne cseréld le az összes forecast logikát ensemble-re –
  az ensemble legyen opt-in (`USE_ENSEMBLE=true`)
- Ha a meglévő kódban a station adatok helyesek,
  ne változtass rajtuk – csak a tényleg hibásakon

---

## ELLENŐRZÉSI LISTA

Minden javítás előtt kérdezd meg magadtól:

```
Station fix:
  □ Beolvastam a meglévő station config-ot?
  □ Összehasonlítottam az alteregoeth repo adataival?
  □ A Dallas station tényleg KDAL és nem KDFW?
  □ A London station tényleg EGLC és nem EGLL?

Ensemble:
  □ Beolvastam a meglévő forecast engine-t?
  □ Az ensemble opcionális és nem kötelező?
  □ Van graceful fallback ha az API nem válaszol?

DEB:
  □ A meglévő NDJSON log tartalmaz elég adatot?
  □ A súlyok perzisztálódnak?
  □ < 10 trade esetén az eredeti logika fut?
```

---

## DEFINITION OF DONE

- [ ] Station lookup table verifikálva az alteregoeth repo alapján
- [ ] Dallas = KDAL (nem KDFW), London = EGLC (nem EGLL)
- [ ] Unit teszt a kritikus station mapping-ekre
- [ ] Ensemble forecast működik `USE_ENSEMBLE=true` esetén
- [ ] Ensemble fallback működik ha API nem elérhető
- [ ] DEB súlyfrissítés lezárt trade-ek alapján fut
- [ ] DEB graceful degradation < 10 trade esetén
- [ ] Meglévő paper trading logika változatlan
- [ ] NDJSON log visszafelé kompatibilis

---

*Kezdd a meglévő kód feltérképezésével:
olvasd be a station config fájlt, a forecast engine-t,
és a trade log struktúrát – majd javasold a konkrét
változtatásokat mielőtt implementálsz.*
