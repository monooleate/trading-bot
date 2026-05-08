# EdgeCalc Resolution Risk Scorer – Claude Code Prompt

> Másold be ezt a teljes promptot egy új Claude Code sessionbe.
> Ez egy új Netlify Function + signal-combiner patch.
> A Claude Code-nak teret hagyunk hogy a meglévő kódhoz illeszkedve
> implementálja – ne kövesse vakon a struktúrát, hanem olvassa be
> a meglévő fájlokat és ahhoz igazodjon.

---

## SZEREPED

Te egy senior TypeScript fejlesztő vagy az EdgeCalc projekten.
Mielőtt bármit implementálsz:
1. Olvasd be a meglévő kódstruktúrát
2. Azonosítsd a releváns meglévő fájlokat
3. Döntsd el mi illeszkedik a meglévő patternekhez
4. Csak utána implementálj

Ha valamiben nem vagy biztos a meglévő kód alapján, kérdezel.

---

## KONTEXTUS: MIÉRT KELL EZ

A cikk (Haris Ebrat) megfogalmazása szerint az igazi edge:

```
E[X]adjusted = P(YES) - price - resolution_risk - execution_drag
```

Az EdgeCalc jelenlegi signal-combiner csak az első tagot számolja:
```
final_prob - market_price = raw_edge
```

A **resolution_risk** tag teljesen hiányzik.
Ez azt jelenti hogy a rendszer kereskedhet olyan piacokon ahol
a várható kimenet helyes, de a settlement mechanika miatt
a pozíció veszít – miközben az előrejelzés igaz volt.

### Konkrét példák ahol ez számít:

**Weather piacok:**
- Settlement: Wunderground METAR adat – de melyik frissítés?
- "Highest temperature" = METAR maximum vagy óránkénti peak?
- Timezone: lokális éjféltől éjfélig, de Wunderground UTC-t mutat
- Ha a forrás késik vagy unavailable → resolution dispute

**Crypto piacok (BTC Up/Down 5m):**
- "BTC price at 14:00:00 UTC" – de melyik oracle?
- Korábban Binance, most Chainlink – váltás közepén mi történik?
- Mi van ha az oracle és a spot ár 0.3%-ot tér el a határon?

**Politikai piacok:**
- "Will X happen by April 30?" – mi számít "by"?
- Forrás: "major news outlets" – hány kell? melyik?
- Ami az egyik timezone-ban március 31, az másikban április 1

---

## MIT ÉPÍT EZ A MODUL

### Fő komponensek:

```
1. /netlify/functions/resolution-risk
   → Polymarket piac slug alapján elemzi a resolution kockázatot
   → Claude API-t használ a rules szöveg értelmezéséhez
   → Cache: 30 perc (a rules ritkán változnak)

2. Signal-combiner patch
   → adjusted_prob = final_prob × (1 - resolution_risk_score)
   → adjusted_edge = adjusted_prob - market_price
   → Ha adjusted_edge < threshold → trade signal visszavonása

3. UI komponens (opcionális, ha a meglévő tab struktúra engedi)
   → Resolution risk badge a Scanner taban
   → Tooltip: miért kockázatos a settlement
```

---

## A RESOLUTION RISK SCORE DEFINÍCIÓJA

```typescript
interface ResolutionRiskScore {
  score: number              // [0.0 - 1.0]
                             // 0.0 = tökéletesen egyértelmű
                             // 1.0 = teljesen ambiguous/kockázatos
  category: "LOW" | "MEDIUM" | "HIGH" | "SKIP"
  factors: ResolutionFactor[]
  adjustedProbMultiplier: number  // 1 - score
  recommendation: string
  analysedAt: string
}

interface ResolutionFactor {
  name: string               // pl. "source_ambiguity"
  weight: number             // [0-1] súly a végső score-ban
  score: number              // [0-1] ez a faktor mennyire kockázatos
  description: string        // emberi magyarázat
}
```

### Score komponensek és súlyok:

```
source_clarity      (25%): Van-e egyértelműen megnevezett, megbízható forrás?
deadline_precision  (20%): Pontosan definiált-e a cutoff (timezone-szal)?
wording_ambiguity   (25%): "reach" vs "close above" vs "be above" különbségek
historical_disputes (15%): Volt-e már vita hasonló piacoknál?
source_availability (15%): Elérhető-e a forrás automatikusan settlement időben?
```

### Score → trade döntés:

```
0.00 - 0.15: LOW    → Normal trading, adjusted_prob = final_prob × 0.97
0.15 - 0.35: MEDIUM → Óvatosabb sizing, adjusted_prob = final_prob × 0.85
0.35 - 0.60: HIGH   → Csak nagy edge esetén, adjusted_prob = final_prob × 0.70
0.60+:       SKIP   → Ne kereskedj, adjusted_prob = 0
```

---

## CLAUDE API PROMPT A RULES ELEMZÉSÉHEZ

```typescript
// A meglévő EdgeCalc ANTHROPIC_API_KEY-t használja
// Nézd meg hogyan hívja a /llm-dependency function – ugyanazt a
// pattern-t kövesd

const systemPrompt = `Te egy Polymarket prediction market settlement
analyst vagy. Feladatod egy piac resolution rules szövegét elemezni
és azonosítani a potenciális kockázatokat.

Válaszolj CSAK valid JSON-ban, semmi más.

A következő faktorokat értékeld 0.0-1.0 között:
- source_clarity: Mennyire egyértelmű és megbízható a settlement forrás?
- deadline_precision: Mennyire pontosan definiált a cutoff idő/dátum?
- wording_ambiguity: Mennyire ambiguous a piac kérdésének szövege?
- historical_disputes: Mennyire valószínű hogy ez a típusú piac vitát generál?
- source_availability: Mennyire elérhető automatikusan a forrás settlement-kor?

Minden faktornál adj egy rövid magyarázatot.

Kategóriák:
- 0.0-0.2: Teljesen egyértelmű
- 0.2-0.4: Kisebb kockázat
- 0.4-0.6: Mérsékelt kockázat
- 0.6-0.8: Magas kockázat
- 0.8-1.0: Kritikusan ambiguous`

const userPrompt = `Elemezd ezt a Polymarket piacot:

Kérdés: ${market.question}
Resolution rules: ${market.rules}
Settlement forrás: ${market.resolutionSource}
Cutoff: ${market.endDate}
Kategória: ${market.category}

Válaszolj ebben a JSON formátumban:
{
  "factors": {
    "source_clarity": { "score": 0.0, "explanation": "..." },
    "deadline_precision": { "score": 0.0, "explanation": "..." },
    "wording_ambiguity": { "score": 0.0, "explanation": "..." },
    "historical_disputes": { "score": 0.0, "explanation": "..." },
    "source_availability": { "score": 0.0, "explanation": "..." }
  },
  "overall_recommendation": "...",
  "biggest_risk": "..."
}`
```

---

## SIGNAL-COMBINER PATCH LOGIKA

```typescript
// A meglévő signal-combiner outputját módosítjuk
// Nézd meg a meglévő /signal-combiner function kódját
// és AHHOZ illeszkedve add hozzá:

interface AdjustedSignal {
  // Meglévő mezők változatlanul
  final_prob: number
  kelly_fraction: number
  raw_edge: number

  // Új mezők
  resolution_risk: ResolutionRiskScore
  adjusted_prob: number        // final_prob × adjustedProbMultiplier
  adjusted_edge: number        // adjusted_prob - market_price
  trade_recommended: boolean   // adjusted_edge > threshold ÉS risk != SKIP
  trade_blocked_reason?: string // ha nem ajánlott, miért
}

// Döntési logika:
function applyResolutionAdjustment(
  signal: ExistingSignalOutput,
  risk: ResolutionRiskScore,
  marketPrice: number,
  edgeThreshold: number
): AdjustedSignal {
  const adjusted_prob = signal.final_prob * risk.adjustedProbMultiplier
  const adjusted_edge = adjusted_prob - marketPrice

  const trade_recommended =
    risk.category !== "SKIP" &&
    adjusted_edge > edgeThreshold

  return {
    ...signal,
    resolution_risk: risk,
    adjusted_prob,
    adjusted_edge,
    trade_recommended,
    trade_blocked_reason: !trade_recommended
      ? risk.category === "SKIP"
        ? `Resolution risk too high: ${risk.recommendation}`
        : `Adjusted edge ${(adjusted_edge * 100).toFixed(1)}% below threshold`
      : undefined
  }
}
```

---

## CATEGORY-SPECIFIKUS HEURISZTIKÁK

A Claude API hívás drága és lassú.
Bizonyos esetekben előre tudható a kockázat – ezeket heurisztikával
kezeld, Claude API-t csak akkor hívj ha a heurisztika nem ad
egyértelmű választ.

```typescript
// Gyors heurisztika Claude API hívás előtt:
function quickHeuristic(market: Market): ResolutionRiskScore | null {

  // BTC Up/Down 5m piacok → alacsony kockázat, jól definiált
  if (market.slug.includes("btc-updown-5m") ||
      market.slug.includes("btc-updown-15m")) {
    return buildLowRiskScore("Standardized BTC 5m/15m market, well-defined oracle")
  }

  // Weather temperature piacok → közepes kockázat (METAR kerekítés)
  if (market.slug.includes("highest-temperature") ||
      market.slug.includes("temp-in")) {
    return buildMediumRiskScore(
      "Weather market: METAR rounding + station offset risk",
      ["deadline_precision", "source_availability"]
    )
  }

  // "By end of [month]" politikai piacok → magas kockázat
  if (market.question.match(/by (end of|april|march|may)/i) &&
      market.category === "politics") {
    return null  // Claude API-ra bízzuk
  }

  // Minden más: Claude API
  return null
}
```

---

## CACHE STRATÉGIA

```typescript
// A meglévő Netlify Blobs cache pattern alapján
// Nézd meg hogyan cache-el a /polymarket-proxy vagy /apex-wallets
// és pontosan ugyanazt a pattern-t használd

// Cache key: "resolution-risk-{slug}"
// TTL: 30 perc (a rules ritkán változnak)
// Ha a piac lezárt (endDate < now) → ne cache-elj, return SKIP
```

---

## FEJLESZTÉSI SORREND

Claude Code döntse el a konkrét implementációt a meglévő kód
alapján. Az alábbi sorrend csak iránymutató:

### 1. Meglévő kód feltérképezése
- Olvasd be a `/netlify/functions/` mappát
- Azonosítsd az `llm-dependency` function pattern-jét
- Azonosítsd hogyan működik a signal-combiner
- Azonosítsd a Netlify Blobs cache pattern-t
- Azonosítsd a Gamma API market fetch logikát

### 2. Heurisztika réteg
- Gyors kategória-alapú scoring Claude nélkül
- Unit tesztek ismert piac típusokra

### 3. Claude API integráció
- Rules szöveg lekérése Gamma API-ból
- Claude elemzés strukturált JSON outputtal
- Hibakezelés: ha Claude timeout → heurisztika fallback

### 4. Netlify Function
- Cache logika
- Rate limiting (Claude API hívások)
- Response formátum a meglévő endpointokhoz igazodva

### 5. Signal-combiner patch
- adjusted_prob és adjusted_edge számítás
- trade_recommended flag
- A meglévő output struktúrát ne törd el – additive legyen

### 6. UI (ha a meglévő Scanner tab engedi)
- Resolution risk badge (LOW/MEDIUM/HIGH/SKIP)
- Hover tooltip a faktorokkal
- Ha a Scanner tab struktúrája bonyolult → skip, csak backend

---

## AMIT NE CSINÁLJ

- Ne írj felül meglévő signal-combiner logikát, csak bővítsd
- Ne változtasd meg a meglévő API response formátumot
- Ne hívj Claude API-t minden requestnél – cache-elj
- Ne implementálj resolution risk-et olyan piacoknál ahol
  a meglévő kód már kezeli (pl. BTC 5m weather piacok)
- Ne legyen a modul blokkoló – ha a resolution risk service
  nem elérhető, a rendszer működjön tovább az eredeti
  final_prob-bal (graceful degradation)

---

## DEFINITION OF DONE

- [ ] Heurisztika helyesen kategorizálja a BTC 5m és weather piacokat
- [ ] Claude API elemzés strukturált JSON-t ad vissza
- [ ] Cache működik (30 perc TTL)
- [ ] Signal-combiner adjusted_edge-et is visszaad
- [ ] Ha risk = SKIP → trade_recommended = false
- [ ] Ha Claude API hibázik → graceful fallback heurisztikára
- [ ] A meglévő signal-combiner output visszafelé kompatibilis marad
- [ ] TypeScript strict mode hiba nélkül fordul

---

*Kezdd a meglévő kód feltérképezésével. Olvasd be a releváns
fájlokat, majd javasold az implementációs tervet mielőtt kódolsz.*
