# CHANGELOG — 2026-09-10

## 93. session — a drift-check kiértékelése → B67 (a tiszta-számláló provenanciája) + a drift-check prompt pontosítása

A user sorban: „nézd meg a drift-check eredményét és minden rendben van-e a kereskedő botokkal" → „csináld a kettő kicsit" (a számláló-fix és a drift-check prompt) → „pusholhatsz is a mainre".

### 1. A drift-check első ütemezett futása (06:03 UTC) — kiértékelve

Hat pont rendben, két eltérés, és **mindkettő valós**:

- **(a) a tiszta first-observation számláló túlszámol** (54 számolt, ebből 29 valódi) → **B67**, lent.
- **(b) a sports-session nem rekonciliál** → **B70**. A kiértékeléskor ezt reset-szivárgásnak írtam le, és a bankrollt helyesnek mondtam. **Mindkettő téves volt.** Nem volt reset: a `started_at` 09-09 06:00:19. A −7,5 ennek a sessionnek a valódi vesztesége, és a **bankroll** a hibás: +$7,50 fantom a P2-10 fix átmenetéből.

Két dolgot tévesen jelzett a futás, illetve én:

- A „8 hiba" a logban hamis pozitív. Mind a crypto combiner-bizalmi kapu `DECISION_SKIP` szövege: „Combiner trust gate: WATCH recommendation + … — likely model error".
- **A saját F-Arb riasztásomat visszavontam.** Azt állítottam, hogy 6 pozíció beragadt, de a szkriptem nem szűrt `status`-ra. Mind a 6 `CLOSED` („Carry flipped negative (reverse)"), a nyitott pozíciók száma 0, a bot tickel. Valós megfigyelés közben: kettő 6, illetve 15 perc után zárult, összesen $0,0009 funding jött, a bankroll 200 → 198,56 (díj).

Bot-állapot a read-only ellenőrzéskor:

| bot | állapot |
|---|---|
| crypto | 104,30 |
| weather | 86,57 = 100 − 13,43, rekonciliál |
| HL | 199,83, van SHORT is |
| sports | 43,00, 3 új pozíció; a bankroll +7,50-dal túlbecsült (B70) |
| F-Arb | 198,56 |

Mind az öt fut, 17 override, a deploy szinkronban.

### 2. B67 — a számláló provenanciája: epoch, nem jelzés

**A hiba.** A B61 `firstBackfilled` jelzést csak a saját deployjától (09-09 11:04 UTC) állítja be a kód, és csak akkor, ha a first-tuple még **üres**. A B53 viszont már 05:25-kor élesedett, és a kettő között újrascannelt pre-B53 sorokat a `??=` kitöltötte. Ezek soha nem kaphatnak jelzést, a régi `isCleanFirstObservation` pedig tisztának mondta őket.

**Mérés.** Élő ledger-dump, 15:44 UTC. Két független implementáció, számra egyező eredménnyel: egy inline újraimplementáció és a **szállított** függvény.

| | rezolvált | tiszta (csak jelzés) | tiszta (provenancia) | rés |
|---|---|---|---|---|
| crypto | 108 | 16 | 13 | 3 |
| weather | 64 | 7 | **2** | 5 |
| sports | 167 | 31 | 15 | 16 |
| hyperliquid | 10 | 9 | 8 | 1 |
| **össz.** | **349** | **63** | **38** | **25** |

- **Hány órás volt a rés-sor a befagyasztáskor** (medián): 14–32 óra; a HL-sor 150 órás volt.
- **Az epoch pontos másodperce nem számít.** Élőben 0 jelzett sor jött létre az epoch után, és ±10 percében egyetlen sor sem jött létre.
- **⚠ Mekkora a hatás valójában.** Ez **provenancia- és számlálási hiba, nem nagy pontszám-torzítás**.
  - A 25 rés-sorból csak 2 ára volt a kimenettől 0,02-n belül.
  - A pontszámok nem változnak, mert a fogyasztók minden sort pontoznak.
  - A walk-forward banner (`category=all`) 30% → **25%** tisztát mutat.

**Fix.** [`prediction-ledger.mts`](../../packages/core/src/prediction-ledger.mts): `FIRST_TUPLE_EPOCH` = `2026-09-09T05:25:24Z` (a B53 deploy-run vége) + `firstObservationProvenance()`. Erre vált az `isCleanFirstObservation` és a `firstObservationCoverage`. Tiszta függvény, adatmigráció nélkül. A `firstBackfilled` hamis doc-ját („Absent/false ⇒ genuine") is javítottam.

**Teszt.** [`prediction-ledger.test.mts`](../../packages/core/src/prediction-ledger.test.mts): pinelve egy élő rés-sor pontos mása, az epoch-határ, a hiányzó/olvashatatlan `firstTs` és a négy élő alak coverage-e. Részletek: [sprints B67](../roadmap/sprints.md).

### 3. A drift-check prompt pontosítása

Ez lokális ütemezett feladat (`edgecalc-drift-check`), nincs a repóban. A változások:

- **A referencia a CLAUDE.md, nem a prompt.** A promptba égetett „15 override" elavult volt, a CLAUDE.md „18"-at mondott, élőben 17 volt. Az AKTUÁLIS ÁLLAPOT elejére kulcsonkénti referencia-lista került, a prompt pedig már nem tartalmaz knob-számot.
- **F-Arb: nyitott = `status = "OPEN"`.** A lezártak a tömbben maradnak.
- **Hiba-számlálás:** `grep -v "likely model error"`. Élőben: nyers 2 → szűrt 0.
- **Tiszta-számláló:** a B67-szabály, plusz `clean_24h` a `resolvedAt`-ból, mert a check futások között nem emlékszik a tegnapi értékre.
- **Sports:** fut (operátor-döntés). A +7,50-es bankroll-fantom ismert eltérés (B70), csak akkor jelenti, ha változik.
- **codeVersion:** a `BUILD_INFO` sha első 12 karaktere, és csak a `builtAt` utáni sorokon kell egyeznie. E nélkül minden deploy után hamis riasztás jönne.
- **Minden parancs 2026-09-10-én élőben kipróbálva.**

### 4. Felvéve / doksi

- **`sprints.md`:**
  - **B67** ✅;
  - **B70** 🟢 backlog (sports bankroll-fantom, operátor-döntés);
  - B38 precondition-állás: 19 tiszta crypto sor.
- **CLAUDE.md:** AKTUÁLIS ÁLLAPOT 2026-09-10, kulcsonkénti knob-referencia-lista, a 90. session „18 override" blokkja átcímkézve, 93. session bejegyzés.
- **`math/21` §6:** provenancia-bekezdés.
- **`playbooks/system-audit.md` §6:** új anti-pattern, „provenancia-jelzőt csak előre bevezetni".

**Verifikáció:** `tsc` 0 · **53/53** teszt · build zöld. Pusholva `main`-re → auto-deploy.
