# CHANGELOG — 2026-09-30 (98. session)

## Kiváltó ok

A user: *„B77 és B78 át csináld! Mehet a push a mainre, ha megvagy."*

## Állapotfelvétel a session elején (read-only)

A rendszer 2 napja stabil (0 hiba, 20 override, a box a legutóbbi commiton), és mérő üzemmódban van: 72 óra alatt 0 `DECISION_TRADE`, 1 F-Arb nyitás, 416 directional-halt skip, 1 végrehajtható-edge skip. Az utóbbi az első élő megszólalása a B75 kapunak: `ethereum-above-2700`, jegyzett ár 0,75, a könyv-VWAP 0,92 → a látszólagos edge helyett +1,3% maradt, a kapu helyesen kiszűrte.

## B78 — a weather ledger-sor három bucketet kevert

**Lelet:** a weather-esemény egy slug ~11 alpiaccal, a bot szkennelésenként a legnagyobb edge-ű bucketet pontozza. Egy slug = egy sor mellett az első-látás tuple az *első* szkennelés bucketjéé volt, a `conditionId`/`predictedProb` az *utolsóé*, az `outcome` pedig vagy az utolsóé (Gamma) vagy a *kötötté* (a zárt trade az esemény-slugra illeszkedett, bucketet nem hordoz). Az első tuple egy másik bucket eredményén lett pontozva.

**Javítás** ([`prediction-ledger.mts`](../../packages/core/src/prediction-ledger.mts)):
- új `bucketId` (a bucket `conditionId`-ja) a sor kulcsában (`recordKey`); a `slug` marad az eseményé. A weather runner a scan-sorra teszi (`bucketId: match.bucket.conditionId`).
- a zárt trade-ből való `outcome`-kitöltés bucket-sorokra kimarad (azok a saját `conditionId`-jukon, Gamma-ból oldódnak fel);
- `firstObservationProvenance`: weather sor `bucketId` nélkül nem „tiszta".
- Más kategóriák kulcsa bájt-azonos. A meglévő B67 epoch-teszt kategóriája `weather` → `crypto` lett (a teszt tárgya az idő-szabály, nem a bucket).

**Élő hatás (a boxon mérve):** 288 weather sor, 271 lezárt, a B67-szabály szerint 209 „tiszta", és mind a 209 többször volt szkennelve → a deploykor a weather tiszta-számláló 209 → 0. Ez a helyes szám, nem regresszió. A napi drift-check 4. pontja (SQL + magyarázat) ennek megfelelően frissítve.

**Tesztek** (`prediction-ledger.test.mts`): 3 blokk — bucket-sorok (pozitív kontroll: a régi kulcs ugyanazon szkenneléseken egy vegyes sorba esik össze), az egypiacos kategóriák változatlansága, a provenance-szabály.

## B77 — árnyék maker-megbízások (mérés, nulla trading-hatás)

A B75 replay szerint a crypto „edge" nagy része a spread volt. Egy álló megbízás nem fizeti a spreadet, de hogy kitöltődik-e, és nem épp az adverse-selection esetekben, az gondolkodással nem dönthető el — a paper-motornak nincs sorállása. **Ezért az első fél előre-naplózó árnyék-mérés** ([math/40](../math/40-maker-shadow.md)):

- [`packages/core/src/maker-shadow.mts`](../../packages/core/src/maker-shadow.mts) (pure): a létra-árak (5/10/15% cél-edge, `maxPrice = pSide − e − kilépési díj`, a legjobb ask alatt egy tickkel plafonozva; marketable fokok kimaradnak), a megfigyelés (kitöltés = ask ≤ limit, **a limiten**, késői megfigyelés nem gyárt kitöltést), az elszámolás (a paper-resolver díjával), a piac-klaszterezett összegzés (`PROMISING` ≥ 30 lezárt-kitöltött piac + pozitív alsó 90% határ + adverse-gap > −10 pont mellett; kevesebbnél `INSUFFICIENT`).
- [`maker-shadow-store.mts`](../../services/worker/src/pillars/shared/maker-shadow-store.mts): tár (`maker-shadow` / `v1`), tickenként ≤ 8 könyv és ≤ 6 Gamma-lekérés, létra (piac, oldal) párra 6 óránként, negatív cache ha nincs hely.
- A crypto runner két pontja: (1) a döntés csak az árfüggő kapukon (`Net edge`, `Kelly méret ≥ minimum`) bukik; (2) a B75 kapu `edge_below_threshold`-dal elutasít. Threshold piacokon, az irányított ág (B74) kimarad. A tick elején feldolgozás, a végén mentés; minden hiba elnyelve.
- Új knob `makerShadowRecord` (default **BE**, nem visszatölthető adat), env `MAKER_SHADOW_RECORD` / `_LADDER` / `_TTL_MIN` / `_NOTIONAL_USDC`, új log-esemény `MAKER_SHADOW`.
- Olvasó: [`scripts/eval-maker-shadow.ts`](../../scripts/eval-maker-shadow.ts).

**Tesztek:** [`maker-shadow.test.mts`](../../packages/core/src/maker-shadow.test.mts) (pure) + [`maker-shadow-store.test.mts`](../../services/worker/src/pillars/shared/maker-shadow-store.test.mts) (stubolt CLOB-könyv + Gamma: elhelyezés, egyszeri létra, negatív cache, megfigyelés, elszámolás, hálózati hiba nem dob). `tsc` 0 · **58/58** · build zöld.

**Amit NEM építettem meg, és miért — B77b:** a tényleges álló paper-megbízások (függő-megbízás tár, kitöltésből pozíció, a cross-position kapuk újra-ellenőrzése a kitöltés pillanatában, bankroll-foglalás) csak a mérés `PROMISING` verdiktje után. Bizonyíték nélkül hetekig kihasználatlan kód egy kereskedési ciklusban, és a kitöltéskori kapu-újraértékelést vakon kellene megírni; a B56b/B53 tanulsága, hogy egy hihető, mérés nélküli javítás árthat.

**Várható ütem, őszintén:** a crypto threshold döntések ritkák (72 óra alatt 1), tehát a jogosult piac hetente pár darab. Egy verdikthez ≥ 30 lezárt-kitöltött *piac* kell → hetek, valószínűleg hónapok.

## Menet közben

Egy shell-idézési hibám a `sprints.md`-be írt szövegből törölte a backtick-es azonosítókat (a `node -e "…"` dupla idézőjelében a backtick parancshelyettesítés). Semmi nem futott le káros — a parancsok mind „not found"-dal elbuktak —, a fájlt `git checkout`-tal visszaállítottam (az addigi változás kizárólag ez a hibás beszúrás volt), és a helyes szöveget fájlból illesztettem be. A `git status` csak a szándékolt fájlokat mutatta.
