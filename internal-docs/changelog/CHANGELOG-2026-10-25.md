# CHANGELOG — 2026-10-25

## B81 — Polymarket logikai arbitrázs végrehajtható áron → FAIL

A B80 (forex, FAIL) után a következő irány a szerkezeti edge: megmarad-e a `condprob` tab középáras monotonicitás-/partíció-sértése a könyv ask-oldalán, a taker díj után. Előre regisztrált, lokálisan futó, read-only mérés. Élő rendszer, knob, box: **nem változott**.

### Mi készült

- [`packages/core/src/arb-scan.mts`](../../packages/core/src/arb-scan.mts) (pure): VWAP-vétel díjjal (`rate · p · (1−p)` szintenként, docs.polymarket.com/trading/fees), NO-ask = YES-bid tükre, partíció (buy-all-YES / buy-all-NO), beágyazott pár (YES bővebb + NO szűkebb), létra-felismerés (`parseRung` a kérdés-szövegből, `rungDirection` a sablon szövegéből, a középár csak vétó).
- [`packages/core/src/arb-scan.test.mts`](../../packages/core/src/arb-scan.test.mts): a docs díj-példája, VWAP, pozitív kontroll (beültetett arbot megtalál) és negatív kontroll (tisztességes könyvben nincs), valamint az öt próbafutás-artefakt mindegyike nevesítve pinelve.
- [`scripts/eval-polymarket-arb.mts`](../../scripts/eval-polymarket-arb.mts): az összes aktív esemény (Gamma `events/keyset` — az offset-lapozás ~2000-nél HTTP 422), CLOB `POST /books` a jelöltekre, ítélet-sor + `SUMMARY_JSON`.

### Eredmény

3 szkennelés (08:39 / 10:40 / 12:41 UTC): középáron ~9 500–10 800 „sértés" → végrehajtható áron, díj után, 100 részvényre 24–28 nyereséges → a szabály szerint számító mindháromban **1, mindig ugyanaz az esemény** (+$0,75 → +$0,53 a ~$99-on). A ≥ 3 esemény feltétel nem teljesült → **FAIL**. Számok és döntés: → Backlog **B81** ([`sprints.md`](../roadmap/sprints.md)).

### Csapdák (a próbafutásokból, mind teszttel pinelve)

Öt hamis „arbitrázs", mind detektor-hiba: az 1,00-s ask kiszűrése; két csapat azonos címkéjű spread-piaca egy létrában; üres könyvű lépcsők szemét-középára megfordította az irányt; év nélküli dátum-címkék; „reach … or lower" és vegyes ↑/↓ létra. A tartós szabály a [`.claude/rules/prediction-ledger-measurement.md`](../../.claude/rules/prediction-ledger-measurement.md)-be került.

Kapu: `tsc` exit 0 · **60/60** teszt · build zöld.
