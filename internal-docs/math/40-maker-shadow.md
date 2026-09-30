# 40 — Shadow maker orders (B77) + a bucket-kulcsos ledger (B78)

> Kód: [`packages/core/src/maker-shadow.mts`](../../packages/core/src/maker-shadow.mts) · [`services/worker/src/pillars/shared/maker-shadow-store.mts`](../../services/worker/src/pillars/shared/maker-shadow-store.mts) · [`scripts/eval-maker-shadow.ts`](../../scripts/eval-maker-shadow.ts) · [`packages/core/src/prediction-ledger.mts`](../../packages/core/src/prediction-ledger.mts) · feladat: [sprints B77 / B77b / B78](../roadmap/sprints.md)

## 1. B77 — a kérdés

A B75 replay szerint a crypto „15–20% edge" nagy része a spread volt, amit a taker megfizet. Egy álló (limit) vételi megbízás nem fizeti a spreadet, hanem **beszedi az árat, amit megad**. Két dolog viszont nem dönthető el gondolkodással:

1. **Kitöltődik-e egyáltalán** (és milyen gyorsan), ha az ár a célzott edge-nél áll?
2. **Adverse selection:** a kitöltések a jók, vagy azok, amikor a piac épp ellenünk mozdult (egy eladó akkor jelentkezik, amikor informáltabb nálunk)?

A paper-motornak nincs sorállása, így egy „álló megbízás" paper-szimulációja hamis magabiztosságot adna. Ezért a B77 első fele **előre-naplózó árnyék-mérés** (nem visszatölthető: hogy egy álló megbízás kitöltődött volna-e, a következő percek könyvétől függ).

## 2. A modell (szándékosan a fill-arányra nézve pesszimista)

- Egy árnyék-megbízás egy **hipotetikus álló vétel** a választott oldal tokenjén, `limit` áron. Ticken ként (~3 perc) egyszer figyeljük.
- **Kitöltődik**, ha egy megfigyelésen a legjobb ask ≤ limit (egy eladó hajlandó volt a mi áraink alatt/mellett eladni, ami egy valódi CLOB-on a mi álló vételünkkel párosodik).
- **A kitöltés ára a LIMIT**, sosem a (jobb) ask: nincs árjavítási jóváírás. A két megfigyelés között megjelenő és eltűnő eladókat nem látjuk → a mért kitöltési arány **alsó korlát**. Sorállás-optimizmus nincs, amit korrigálni kellene.
- Az **adverse selection nincs modellezve, hanem mérve**: minden megbízás — kitöltött vagy sem — a piac valódi feloldásával kerül elszámolásra, így az eval a kitöltöttek és a ki nem töltöttek kimenetét össze tudja vetni.
- **Létra:** minden lehetőséghez három cél-edge (5 / 10 / 15%), így a bizonyíték egy *kitöltési-arány–edge görbe*, nem egy önkényes pont. Az `e` cél-edge legmagasabb megengedett ára `maxPrice = pSide − e − kilépési díj`, a legjobb ask alatt egy tickkel plafonozva; ask fölé eső (marketable, azaz taker) létrafok kimarad; az azonos limitre kerekedők egybeolvadnak.
- **Elszámolás:** a paper-resolver díjával azonos (`kilépési díj = max(bevétel, költség) × 1,5%`), belépési díj nincs (maker).

## 3. Mikor keletkezik árnyék-megbízás

Crypto **threshold** piacokon (az irányított ág a B74 óta le van tiltva), ha a döntés **csak árra bukik**:
- a döntés kapui közül csak az árfüggők buknak (`Net edge ≥ küszöb`, `Kelly méret ≥ minimum`) — bármi más (model-hiba, resolution-risk, konfidencia, cross-position, sanity cap) nem ár-kérdés, arra nincs árnyék-megbízás; vagy
- a döntés kötés lett volna a quote-on, de a könyv-VWAP megöli az edge-et (B75 végrehajtható-edge kapu, `edge_below_threshold`).

(piac, oldal) párra legfeljebb 6 óránként egy létra; `MAX_BOOKS = 8` könyv/tick és `MAX_RESOLUTIONS = 6` Gamma-lekérés/tick. **Nulla trading-hatás:** nem nyit pozíciót, nem változtat döntést. Default **BE** (`makerShadowRecord`, env `MAKER_SHADOW_RECORD`).

## 4. Az eval és a döntés (B77b)

[`eval-maker-shadow.ts`](../../scripts/eval-maker-shadow.ts) létrafokonként: kitöltési arány (Wilson 90% CI), medián idő a kitöltésig, lezárt kitöltött **piacok**, modellezett edge, **realizált hozam/$** (90% CI) és az adverse-gap `(találati arány − modell) kitöltöttre − ugyanez ki nem töltöttre`.

- **Független egység a PIAC, nem a megbízás:** egy létra fokai és egy piac újra-elhelyezett létrái ugyanaz a fogadás többször látva → a CI a piaconkénti átlagokon számol.
- **Verdikt:** `PROMISING` csak ≥ 30 lezárt-kitöltött piac + pozitív alsó 90% hozam-határ + adverse-gap > −10 pont mellett. Kevesebb piacnál `INSUFFICIENT` és semmi más: az adatfolyam lassú (hetente pár jogosult piac), egy kis minta nem olvasódhat leletként.
- **B77b (tényleges álló paper-megbízások) csak `PROMISING` létrafokra épül.** Ha semelyik nem az, nem építjük.

## 5. B78 — a ledger `conditionId`-hibája

A weather-esemény **egy slug, ~11 alpiaccal**, és a bot szkennelésenként a legnagyobb edge-ű bucketet pontozza — így a kiválasztott bucket szkennelések közt változik. Egy slug = egy sor mellett **három különböző bucket** keveredett egy rekordban: a write-once első-látás tuple az *első* szkennelés bucketjét írta le, a `conditionId`/`predictedProb` az *utolsóét*, az `outcome` pedig vagy az utolsó bucketét (Gamma) vagy a *kötöttét* (a zárt trade az esemény-slugra illeszkedett, bucketet nem hordoz). Az első tuple egy másik bucket eredményén lett pontozva.

**Javítás:** a weather sor **(esemény, bucket)** — az új `bucketId` (a bucket `conditionId`-ja) a sor kulcsának része (`recordKey`); a `slug` marad az eseményé (megjelenítés, illesztés). Minden más kategória kulcsa változatlan (bájt-azonos viselkedés, teszttel pinelve). A zárt trade-ből való `outcome`-kitöltés bucket-sorokra kimarad — azok a saját `conditionId`-jukon, Gamma-ból oldódnak fel.

**Provenance:** egy weather sor `bucketId` nélkül `backfilled`-ként minősül (nem mert visszatöltött, hanem mert az első tuple nem igazolt: hogy melyik bucketről szól, nem lett rögzítve). Élő adaton (2026-09-30): 288 weather sor, 271 lezárt, a B67-szabály szerint **209 „tiszta"**, és **mind a 209 többször volt szkennelve** → a deploykor a weather tiszta-számláló 209 → 0, majd csak az új, bucket-kulcsos sorokból épül újra. Ez a helyes szám, nem regresszió.

⚠ A `packages/core/src/ledger.ts` (dormáns Postgres-backend, csak a `pg-roundtrip.test.mts` használja) `(category, slug)` kulcson dolgozik és az első-tuple mezőket amúgy sem képezi le; ha a worker valaha átáll rá, a bucket-kulcsot is át kell vinni.
