---
paths:
  - "packages/**/*.test.mts"
  - "services/**/*.test.mts"
  - "scripts/run-tests.mjs"
  - ".github/workflows/ci.yml"
---

# Tesztek

- Teszt-fájl: `*.test.mts` a `packages/` vagy `services/` alatt — a `scripts/run-tests.mjs` csak ezeket találja (tsx-szel futtatja, nem-0 exit = FAIL). Más helyen / más kiterjesztéssel írt teszt némán kimarad.
- „Kész" csak ha mind zöld: `npx tsc --noEmit` exit 0 + `node scripts/run-tests.mjs` (N/N) + `npm run build`; a záró jelentésbe a számokat írd.
- SQL-t / store-t érintő logikát valódi Postgres ellen tesztelj PGlite-tal (minta: `packages/core/src/pg-roundtrip.test.mts`, `services/worker/src/pillars/weather/multi-model-store.test.mts`).
- Default-OFF knobnál pineld teszttel, hogy OFF-nál a kimenet bit-azonos a régi úttal.
- Regressziós fixet nevesített teszttel pinelj (minta: a `kelly-sizer.test.mts` fejléce „pins the B36 fix").
- Mérést / összehasonlító harness-t pozitív és negatív kontrollal futtass: egy vak összehasonlítás is „azonos"-t mond, egy rossz alapvonal hamis nyerést (B73).
