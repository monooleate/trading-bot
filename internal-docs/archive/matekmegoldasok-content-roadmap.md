# Tartalom-roadmap: matekmegoldasok.hu kvantitatív bővítés

> **Cél:** az EdgeCalc trading projektben implementált kvantitatív matematikai
> tudás (Kelly, Kyle λ, VPIN, Hawkes, IR=IC·√N, KL-divergencia, Brown-híd,
> ensemble-előrejelzés stb.) megosztása a matekmegoldasok.hu-n hasznos,
> kalkulátor-támogatott cikksorozatként.
>
> **Forma:** 12 cikk + 8 új interaktív kalkulátor, beillesztve a meglévő
> `docs/crypto/` szekcióba és 2 cikk a `docs/statisztika/` alá.
>
> **Időkeret:** 9 session × ~1-2 cikk/session.

---

## 0. Kontextus és audit (olvassd el az indulás előtt)

### 0.1 Stack és konvenció (mathSEO_reference alapján)

- **Framework:** Deno Fresh 2.x + Preact + Tailwind v4 + Vite
- **Markdown:** marked + remark-gfm + KaTeX 0.16
- **MDX:** `@mdx-js/mdx` v3, Preact JSX runtime, server-side render
- **Charts:** Chart.js 4.4 (kalkulátorokban használjuk grafikonra)
- **Cikkek helye:** `docs/<kategoria>/<slug>.md` vagy `.mdx`
- **Regisztráció:** `docs/toc.ts` (`["page", id, title]` vagy
  `["subcategory", key]`)
- **Kalkulátorok:** Preact island a `islands/<NameKalkulator>.tsx`-ben,
  importálva + URL-pattern matchelve a `routes/[...slug].tsx`-ben,
  bejegyezve a `data/calculators/hu.json`-ba
- **Schema:** front-matter `articleSchema` + `faqPageSchema` mezők
- **KaTeX:** inline `$x$` vagy `\(x\)`, block `\[...\]` vagy `$$...$$`,
  fenced `` ```katex `` is működik
- **Admonition:** `> [info]: ...`, `> [warn]: ...`, `> [tip]: ...`
- **FAQ admonition (collapsible):** `::: faq Kérdés?\nVálasz\n:::`
- **Heading anchor:** automatikus, `github-slugger`-rel
- **Olvasói ToC:** automatikus a renderelt H2-H4 alapján

### 0.2 Meglévő `docs/crypto/` audit

| Path | Státusz | Mit fed le |
|------|---------|------------|
| `docs/crypto/bevezetes.md` | KÉSZ | Kategória landing, általános "miért matek a kriptón" |
| `docs/crypto/hataridos-strategiak/bevezetes.md` | KÉSZ | Hedging, spekuláció, spread, arbitrázs (naív) |
| `docs/crypto/hataridos-strategiak/funding-rate-strategia.md` | KÉSZ | Naív funding-fee arbitrázs (delta-neutral, fix költségek) |
| `docs/crypto/hataridos-strategiak/funding-rate-strategia-kalkulator.md` | KÉSZ | Funding-rate kalkulátor cikk |
| `docs/crypto/opcios-strategiak/bevezetes.md` | KÉSZ | Opciós placeholder |
| `islands/Funding_Rate_Arbitrage.tsx` | KÉSZ | Funding-rate sim island |

**Konklúzió:** a "miért érdekes a kriptó-matek" alapcikk + a NAIV funding-rate
sztori MEGVAN. Az új tartalom a **mélységet** és a **jelfeldolgozási szintet**
hozza be — nem duplikálja, hanem fölé épül. Egyik új cikk se írja át a
meglévőket (csak hivatkozzunk rájuk `[lásd: ...]` belső linkekkel).

### 0.3 Új kategória-struktúra javaslat

A `docs/crypto/` alá két új subcategory + 1 új top-level:

```
docs/
├── crypto/
│   ├── bevezetes.md                               (KÉSZ)
│   ├── hataridos-strategiak/                      (KÉSZ + 1 új)
│   │   ├── bevezetes.md
│   │   ├── funding-rate-strategia.md
│   │   ├── funding-rate-strategia-kalkulator.md
│   │   └── funding-rate-haladó.md                 ← S2: mark-to-market accrual
│   ├── opcios-strategiak/                         (KÉSZ — érintetlen)
│   ├── kvantitativ-jelek/                         ← ÚJ subcategory (S3-S6)
│   │   ├── bevezetes.md
│   │   ├── kyle-lambda.md
│   │   ├── vpin-toxic-flow.md
│   │   ├── hawkes-folyamatok.md
│   │   ├── iv-rv-divergencia.md
│   │   ├── feltteles-valoszinuseg-piacokon.md
│   │   ├── smart-money-payout-ratio.md
│   │   └── arbitrázs-vwap-validalt.md
│   └── stratégia-kombinálás/                      ← ÚJ subcategory (S7-S8)
│       ├── bevezetes.md
│       ├── kelly-kriterium-kalkulator.md
│       ├── kelly-kriterium.md
│       ├── sharpe-information-ratio.md
│       └── grinold-kahn-alaptorveny.md
└── statisztika/                                   (KÉSZ — bővítjük 2 cikkel)
    ├── ... (meglévők)
    ├── brown-mozgas.md                            ← ÚJ S9
    └── ensemble-elorejelzes.md                    ← ÚJ S9
```

**Indoklás:**
- A `kvantitativ-jelek` subcat tartja a piaci-mikrostruktúra anyagot
  (Kyle/VPIN/Hawkes/IV-RV/cond.prob/smart-money/arb) — ez a "hogyan dolgoz fel
  egy kvant a piaci adatot".
- A `stratégia-kombinálás` subcat tartja a tét-méretezés és portfolió-szintű
  matematikát (Kelly/Sharpe/IR/Grinold-Kahn) — ez a "hogyan rakok össze egy
  stratégiát több jelből".
- A Brown-híd és az ensemble-előrejelzés tisztán matematikai cikk, minimális
  pénzügyi konnotáció — ezek a `statisztika/` alá kerülnek (a meglévő
  `atlag-kalkulator` mellé).

### 0.4 Konvencionális checklist (minden cikk megírásakor használandó)

Egy új cikk akkor "kész", ha mind a 8 pont igaz:

1. [ ] Front-matter: `title`, `description`, `published_at`, `refreshed_at`
2. [ ] `articleSchema` blokk a front-matter-ben (Article + opcionális
       `mainEntity: SoftwareApplication` ha kalkulátoros)
3. [ ] `faqPageSchema` blokk (6-8 Q&A) — a cikk végén `## GYIK` szekció
       tükrözze
4. [ ] Hero `> [info]:` admonition (gyors áttekintés a feltöltés tetején)
5. [ ] H2/H3 struktúra kérdés-stílusban ("Mi a Kelly?", "Hogyan
       számoljuk?")
6. [ ] KaTeX `\[ ... \]` block + minden képlet után **mit jelent** szótár
       ("Ahol $r$ = ...")
7. [ ] **Cross-link** legalább 2 másik cikkre (a meglévő szazalek-,
       kamatos-kamat-, atlag-kalkulator közül + új cikkek között)
8. [ ] Ha kalkulátoros: új island, route + catalog regisztráció,
       hero-image SVG (`/<kategoria>/<slug>-hero.svg`)

> **Tip:** Frontmatter-mintát mindig a `docs/algebra/kamatos-kamat-kalkulator.md`
> tetejéről másolj — az tartalmazza az összes mezőt helyes YAML-szintaxissal
> (`articleSchema.about` Wikipedia-link tömbbel, `featureList` array-ekkel,
> `faqPageSchema` 8 Q&A-val).

---

## 1. Új top-level kategória **NEM** kell

Először mérlegeltem, hogy `docs/kvantitativ/` legyen-e új top-level. Ezt
**elvetettem** a következő okokból:

- A meglévő `docs/crypto/bevezetes.md` már explicit beharangozza a témát
  ("kereskedési stratégiák matematikai elemzése")
- A `docs/crypto/` subcat már létezik, de jelenleg sekély — pont ezt akarjuk
  mélyíteni
- Új top-level → új menüpont, új sidebar branding, új SEO landing — felesleges
  fragmentáció

**Kivétel:** ha 6+ hónapon belül a `crypto/kvantitativ-jelek` 12+ cikket nőne,
érdemes lenne saját `docs/quant/` top-level-be kiemelni. Most még korai.

---

## 2. Cikkenkénti specifikáció (12 cikk + 2 statisztika cikk = 14 db)

> Minden cikkhez: javasolt slug, fájl-útvonal, KaTeX-blokkok, kalkulátor-spec
> (ha van), source-of-truth a projektünkben (mit használjunk fel a saját
> implementációból), és külső akadémiai forrás (publikálható, hivatkozható).

### Sorozat A — Tét-méretezés és portfolió-matek (`crypto/stratégia-kombinálás/`)

#### A.1 — Kelly-kritérium magyarázata diákoknak ★

- **Slug:** `crypto/strategia-kombinalas/kelly-kriterium`
- **Fájl:** `docs/crypto/strategia-kombinalas/kelly-kriterium.md`
- **Forrás (saját):** `internal-docs/math/02-ev-kelly.md`,
  `auto-trader/crypto/decision-engine.mts:kellyBinary()`,
  `src/lib/math.ts` (¼-Kelly + 8% hard cap)
- **Külső forrás:** Kelly Jr., J.L. (1956), *A New Interpretation of
  Information Rate*, Bell System Technical Journal — Wikipedia: Kelly criterion
- **TOC (H2/H3):**
  1. Mit válaszol meg a Kelly-kritérium? (1 mondat: "mennyit fogadjak?")
  2. Egyszerű érme-példa — 60% nyerési esélyű érme
  3. Várható érték (EV) felelevenítése (cross-link
     `algebra/szazalekszamitas`)
  4. Kelly-képlet: `$f^* = \frac{pb - q}{b}$`
  5. Mit jelent a `b` (odds), `p` (siker), `q = 1−p`?
  6. Példa: 60% × 1:1 odds → Kelly = 20%
  7. Miért nem teszünk fel teljes Kellyt? — drawdown
  8. ¼-Kelly: az intézményi standard
  9. Gyakori hibák (over-betting, korreláló fogadások)
  10. GYIK
- **KaTeX-blokkok:**
  ```katex
  \[
  f^* = \frac{p \cdot b - q}{b}, \quad q = 1 - p
  \]
  ```
- **Kalkulátor:** ⭐ **igen** (külön cikk: `kelly-kriterium-kalkulator.md`,
  lásd alább) — itt csak hivatkozzunk rá
- **Cross-link:** `algebra/szazalekszamitas`, `algebra/kamatos-kamat-kalkulator`
  (idő-érték párhuzam), később `crypto/strategia-kombinalas/sharpe-information-ratio`

#### A.2 — Kelly-kriterium kalkulátor ★

- **Slug:** `crypto/strategia-kombinalas/kelly-kriterium-kalkulator`
- **Fájl:** `docs/crypto/strategia-kombinalas/kelly-kriterium-kalkulator.md`
- **Cikkstílus:** rövid bevezető (~400 szó) + island + worked example + GYIK
- **Új island:** `islands/KellyKriteriumKalkulator.tsx` (specifikáció a §5-ben)
- **Route patch:** `routes/[...slug].tsx` import + URL match
- **Catalog patch:** `data/calculators/hu.json` új tétel
- **Hero image:** `static/crypto/strategia-kombinalas/kelly-kriterium-kalkulator-hero.svg`
- **Schema:** Article + `mainEntity: SoftwareApplication`
  `applicationCategory: "FinanceApplication"`

#### A.3 — Sharpe-ráta és Information Ratio ★★

- **Slug:** `crypto/strategia-kombinalas/sharpe-information-ratio`
- **Fájl:** `docs/crypto/strategia-kombinalas/sharpe-information-ratio.md`
- **Forrás (saját):** `internal-docs/math/10-signal-combiner.md`,
  `netlify/functions/edge-tracker/statistics.mts` (`computeCalibrationHealth`)
- **Külső forrás:** Sharpe, W.F. (1966), *Mutual Fund Performance*; Grinold,
  R.C. & Kahn, R.N. (1999), *Active Portfolio Management*; Kakushadze (2018),
  *151 Trading Strategies* (a projekt PDF-je)
- **TOC:**
  1. "Mennyit kerestem" ≠ "milyen jó volt a stratégia"
  2. Volatilitás mint kockázatmérő (cross-link
     `statisztika/atlag-kalkulator` és új `statisztika/szóras` ha lesz)
  3. Sharpe: `$SR = \frac{\mu - r_f}{\sigma}$`
  4. Information Ratio: `$IR = \frac{\alpha}{\sigma_\alpha}$`
  5. Sharpe vs. IR — mikor melyiket?
  6. **Grinold-Kahn alaptörvény:** `$IR = IC \cdot \sqrt{N}$`
  7. Levezetés (single-period, Gaussian assumption)
  8. Példa: 5 független jelzés, $IC = 0.07$ → $IR = 0.157$
  9. Miért "több gyenge jelzés > egy erős"?
  10. Kalibrációs egészség (cross-link a saját edge-tracker logikára)
  11. GYIK
- **Kalkulátor:** ⭐ **igen** — `islands/SharpeIRKalkulator.tsx` (lásd §5)
  - Input: μ, σ, rf vagy IR-hez: IC, N
  - Output: SR/IR, kalibrációs sáv (good/weak/noise) színkódolva

#### A.4 — Grinold-Kahn fundamental law (deep-dive) ★★★

- **Slug:** `crypto/strategia-kombinalas/grinold-kahn-alaptorveny`
- **Fájl:** `docs/crypto/strategia-kombinalas/grinold-kahn-alaptorveny.md`
- **Forrás (saját):** `internal-docs/math/10-signal-combiner.md`,
  `netlify/functions/signal-combiner.mts` (kombinálási súlyok)
- **Külső forrás:** Grinold-Kahn (1999/2000) Ch.6 — *The Fundamental Law of
  Active Management*
- **TOC:**
  1. A 3 alapösszetevő: IC, breadth, transfer coefficient
  2. Független jelzések feltételezése (és mikor sérül)
  3. Korrelált jelzések: portfólió-szintű IR korrekció
  4. Optimális kombinálási súlyok — mean-variance optimization
  5. Példa: 3 jelzés (FR + VPIN + IV-RV) saját IC-becsléssel
  6. Mikor érdemes hozzáadni egy új jelet? (marginal IR contribution)
  7. Kakushadze-kontextus: 151 stratégia anthology (saját projekt:
     `kakushadze-v9-signal-expansion`)
  8. GYIK
- **Kalkulátor:** ⭐ **igen** — `islands/GrinoldKahnKalkulator.tsx`
  - Input: N db jelzés × `{ic, σ}` + páronkénti korreláció mátrix
  - Output: aggregált IR + per-jel marginal IR contribution

---

### Sorozat B — Piaci mikrostruktúra (`crypto/kvantitativ-jelek/`)

#### B.0 — Kvantitatív jelek bevezetés ★

- **Slug:** `crypto/kvantitativ-jelek/bevezetes`
- **Fájl:** `docs/crypto/kvantitativ-jelek/bevezetes.md`
- **Cél:** subcategory landing — vázolja a 7 cikket (Kyle, VPIN, Hawkes,
  IV-RV, cond.prob, smart-money, arb), 1 mondat/jel, áttérési linkek

#### B.1 — Kyle-féle lambda ★★

- **Slug:** `crypto/kvantitativ-jelek/kyle-lambda`
- **Fájl:** `docs/crypto/kvantitativ-jelek/kyle-lambda.md`
- **Forrás (saját):** `internal-docs/math/06-orderflow.md`,
  `netlify/functions/orderflow-analysis.mts`
- **Külső forrás:** Kyle, A.S. (1985), *Continuous Auctions and Insider
  Trading*, Econometrica 53(6) — Wikipedia: Market microstructure
- **TOC:**
  1. Kereslet-kínálat → ár-hatás (price impact) jelenség
  2. Kyle (1985) modell: informált vs. zajos kereskedők
  3. Az alapegyenlet: `$\Delta p = \lambda \cdot Q$`
  4. Lambda becslése — lineáris regresszió a `(Q, Δp)` adatpontokon
  5. Mit mond a magas λ? — likviditás-hiány
  6. Időskála: 1-perces vs. 5-perces λ
  7. Példa: Polymarket BTC piacon (saját projekt-snapshot)
  8. Korlátok (heteroszkedaszticitás, intraday pattern)
  9. GYIK
- **Kalkulátor:** ⭐ **igen** — `islands/KyleLambdaKalkulator.tsx`
  - Input: trade-list textarea CSV `(timestamp, side, qty, price)` formátumban
  - Output: λ, R², 95% CI, scatter plot Chart.js-szel
  - Defaults: random-generált demo-adat 100 trade-tel

#### B.2 — VPIN: toxic order flow ★★

- **Slug:** `crypto/kvantitativ-jelek/vpin-toxic-flow`
- **Fájl:** `docs/crypto/kvantitativ-jelek/vpin-toxic-flow.md`
- **Forrás (saját):** `internal-docs/math/06-orderflow.md` §VPIN szakasz
- **Külső forrás:** Easley, López de Prado, O'Hara (2012), *Flow Toxicity and
  Liquidity in a High-frequency World*, Review of Financial Studies; Andersen
  & Bondarenko (2014) — kritika
- **TOC:**
  1. Mi a "toxic flow"? — informált vs. tájékozatlan kereskedők
  2. Volume-bucket konstrukció (idő-bucket helyett)
  3. Bulk Volume Classification — buy/sell felosztás
  4. VPIN képlet:
     `$\text{VPIN} = \frac{\sum_{n=1}^{N} |V_n^B - V_n^S|}{\sum_{n=1}^{N} V_n}$`
  5. A 0.7-es küszöb értelmezése
  6. 2010-es flash crash esettanulmány
  7. Korlátok: Andersen-Bondarenko kritika (mintavételi torzítás)
  8. GYIK
- **Kalkulátor:** ⭐ **igen** — `islands/VPINKalkulator.tsx`
  - Input: trade-list CSV + bucket-méret (V) input
  - Output: VPIN idősor Chart.js, küszöb-átlépés highlight

#### B.3 — Hawkes-folyamatok ★★★

- **Slug:** `crypto/kvantitativ-jelek/hawkes-folyamatok`
- **Fájl:** `docs/crypto/kvantitativ-jelek/hawkes-folyamatok.md`
- **Forrás (saját):** `internal-docs/math/06-orderflow.md` §Hawkes szakasz
- **Külső forrás:** Hawkes, A.G. (1971), *Spectra of Some Self-Exciting and
  Mutually Exciting Point Processes*; Bacry, Mastromatteo, Muzy (2015), *Hawkes
  Processes in Finance*, Market Microstructure and Liquidity 1(01)
- **TOC:**
  1. Poisson-folyamat felelevenítése (cross-link
     `statisztika/atlag-kalkulator`-ra `Var(X)=E(X)` Poisson-tulajdonság)
  2. "Önmagát gerjesztő" folyamat fogalma
  3. Intenzitás:
     `$\lambda^*(t) = \mu + \sum_{t_i < t} \alpha \cdot e^{-\beta(t - t_i)}$`
  4. α (gerjesztés erőssége), β (csillapodás), μ (alapintenzitás)
  5. Stacionaritási feltétel: $\alpha < \beta$
  6. Maximum likelihood becslés (haladó box, csak vázlat)
  7. Trading cluster azonosítása példán
  8. GYIK
- **Kalkulátor:** ⭐ opcionális — `islands/HawkesKalkulator.tsx`
  - Input: timestamp-lista textarea + α, β, μ slider
  - Output: szimulált intenzitás-görbe Chart.js, kritikus pontok markered
  - **Megjegyzés:** A valódi MLE-fit túl drága browserben — itt csak vizualizáció

#### B.4 — Implikált vs. realizált volatilitás ★★

- **Slug:** `crypto/kvantitativ-jelek/iv-rv-divergencia`
- **Fájl:** `docs/crypto/kvantitativ-jelek/iv-rv-divergencia.md`
- **Forrás (saját):** `internal-docs/math/07-vol-harvest.md`,
  `netlify/functions/vol-divergence.mts`
- **Külső forrás:** Black, F. & Scholes, M. (1973), *The Pricing of Options
  and Corporate Liabilities*; Bollerslev (1986), *Generalized ARCH* —
  Wikipedia: Volatility (finance)
- **TOC:**
  1. Volatilitás-definíciók: realizált (RV) vs. implikált (IV)
  2. RV = `$\sigma_{\text{RV}} = \sqrt{\frac{1}{N}\sum (r_i - \bar{r})^2}$`
  3. IV — fordított Black-Scholes (vázlat, képlet nélkül a részletes BS-re)
  4. IV-RV spread mint kockázati prémium
  5. "Locked profit" képlet a divergenciából
  6. Mikor érdemes vol short-olni?
  7. Korlátok: vol smile, jump-process bias
  8. GYIK
- **Kalkulátor:** ⭐ **igen** — `islands/IVRVKalkulator.tsx`
  - Input: napi záróárak textarea (vagy "BTC, 30 nap" gomb → demo adat)
  - Output: RV (annualizált), IV (manuál input vagy Deribit-mintaszerű 65%)
  - Spread chart az időben

#### B.5 — Feltételes valószínűség és inkonzisztens piacok ★★

- **Slug:** `crypto/kvantitativ-jelek/feltteles-valoszinuseg-piacokon`
- **Fájl:** `docs/crypto/kvantitativ-jelek/feltteles-valoszinuseg-piacokon.md`
- **Forrás (saját):** `internal-docs/math/09-cond-prob.md`,
  `netlify/functions/cond-prob-matrix.mts`
- **Külső forrás:** Wainwright, M.J. & Jordan, M.I. (2008), *Graphical Models,
  Exponential Families, and Variational Inference*, Foundations and Trends in
  Machine Learning 1(1-2) — KL és Bregman-projekció kapcsán; Bayes-tétel
  (Wikipedia)
- **TOC:**
  1. Bayes-tétel felelevenítése
  2. Marginális vs. együttes valószínűség
  3. Példa: P(A) = 70%, P(B) = 60%, P(A∧B) = 10% → mi a baj?
  4. Marginális politóp fogalma (vázlat, nem teljes geometriai
     felépítés)
  5. Monotonicitás-sértés: ha A ⊆ B, akkor P(A) ≤ P(B)
  6. KL-divergencia: `$D_{KL}(p \| q) = \sum_i p_i \log \frac{p_i}{q_i}$`
  7. Bregman-projekció (haladó box, vázlat)
  8. Esettanulmány: Polymarket "Iran sanctions" piacok 17.5¢ edge
  9. GYIK
- **Kalkulátor:** ⭐ **igen** — `islands/InkonzisztenciaDetektor.tsx`
  - Input: 3 piaci ár (P(A), P(B), P(A∧B)) numeric input
  - Output: konzisztens-e? minimal KL-távolság a politóptól + magyarázó
    szöveg

#### B.6 — Smart money: payout ratio + bot detector ★★

- **Slug:** `crypto/kvantitativ-jelek/smart-money-payout-ratio`
- **Fájl:** `docs/crypto/kvantitativ-jelek/smart-money-payout-ratio.md`
- **Forrás (saját):** `internal-docs/math/08-apex-wallets.md`,
  `apex_wallet_profiler.py`, `netlify/functions/apex-wallets.mts`
- **Külső forrás:** Tharp, V.K. (2007), *Definitive Guide to Position Sizing*
  — payout ratio fogalom; Wikipedia: Win/loss ratio
- **TOC:**
  1. Win rate önmagában nem elég
  2. Payout ratio: `$PR = \frac{\overline{W}}{\overline{L}}$`
  3. Break-even win rate: `$WR_{be} = \frac{1}{1 + PR}$`
  4. Példa: $PR = 2.0$ → 33% már nyereséges
  5. Bot-felismerés statisztikai jegyei:
     - Inter-trade idő variancia (CV)
     - 24h coverage
     - Sleep gap-eloszlás
     - Focus ratio
  6. Konszenzus-detekció több wallet között
  7. LP-subgroup A/B/C klasszifikáció
  8. GYIK
- **Kalkulátor:** ⭐ **igen** — `islands/PayoutRatioKalkulator.tsx`
  - Input: trade-list CSV (P&L per trade) vagy átlag-W / átlag-L direkt input
  - Output: PR, break-even WR, profit factor, expectancy

#### B.7 — Arbitrázs: VWAP-validált YES + NO ★★★

- **Slug:** `crypto/kvantitativ-jelek/arbitrázs-vwap-validalt`
- **Fájl:** `docs/crypto/kvantitativ-jelek/arbitrázs-vwap-validalt.md`
- **Forrás (saját):** `internal-docs/math/11-arb-matrix.md`,
  `netlify/functions/vwap-arb.mts`, `netlify/functions/pair-cost-arb.mts`
- **Külső forrás:** Bertsimas, D. & Lo, A. (1998), *Optimal Control of
  Execution Costs*, J. Financial Markets 1(1) — VWAP optimalizáció;
  Frank-Wolfe algoritmus (Wikipedia)
- **TOC:**
  1. Mi az arbitrázs? — háromszög-példa (egyetemi finance bevezető)
  2. Bináris piac: YES + NO ár összege ≠ 1?
  3. Slippage és VWAP — miért nem elég a top-of-book ár
  4. Cost-line képlet teljes notional-ra:
     `$\text{Cost}(N) = \int_0^N \text{VWAP}(q) \, dq$`
  5. Frank-Wolfe iteráció (haladó box)
  6. Korlátok: redemption-idő, gas, várakozás
  7. Pair-cost arb (saját projekt: Tab 11 D)
  8. GYIK
- **Kalkulátor:** ⭐ **igen** — `islands/VWAPArbKalkulator.tsx`
  - Input: YES order book (bid/ask + size, max 10 szint) + NO order book
  - Output: optimal notional + várható profit % + cost-line ábra Chart.js

---

### Sorozat C — Statisztika cross-cikkek (`statisztika/`)

#### C.1 — Brown-mozgás és Brown-híd ★★★

- **Slug:** `statisztika/brown-mozgas`
- **Fájl:** `docs/statisztika/brown-mozgas.md`
- **Forrás (saját):** `auto-trader/crypto/paper-resolver.mts` (v1 logit-bridge,
  most archiválva, de matematikailag instruktív),
  `internal-docs/math/13-crypto-bot.md` §paper validáció
- **Külső forrás:** Wiener, N. (1923), *Differential-Space*; Karatzas &
  Shreve (1991), *Brownian Motion and Stochastic Calculus*; Wikipedia:
  Brownian bridge
- **TOC:**
  1. Brown-mozgás definíciója (Wiener-folyamat)
  2. Tulajdonságok: független inkrementumok, normál eloszlás
  3. Mi a "híd"? — terminál feltétel rögzítése
  4. Konstrukció: `$B(t) = W(t) - \frac{t}{T} W(T)$`
  5. Logit-transzformált változat (valószínűségi értelmezés)
  6. First-passage probléma: TP/SL gát átlépése
  7. Monte Carlo szimuláció (kódvázlat — Pythonban)
  8. Mire jó? Opció-árazás, paper-trade szimuláció
  9. GYIK
- **Kalkulátor:** ⭐ **igen** — `islands/BrownHidKalkulator.tsx`
  - Input: start-pont, végpont, T (időtartam), σ (volatilitás), upper/lower
    bound
  - Output: 100 path animáció (Chart.js + setInterval), first-passage
    valószínűség becslés Monte Carlo-ból

#### C.2 — Ensemble-előrejelzés ★★

- **Slug:** `statisztika/ensemble-elorejelzes`
- **Fájl:** `docs/statisztika/ensemble-elorejelzes.md`
- **Forrás (saját):** `internal-docs/math/weather/README.md`,
  `netlify/functions/auto-trader/weather/forecast-engine.mts`,
  `ensemble-forecast.mts`
- **Külső forrás:** Hagedorn, R., Doblas-Reyes, F., Palmer, T. (2005), *The
  Rationale Behind the Success of Multi-Model Ensembles*, Tellus A 57(3);
  Wikipedia: Ensemble forecasting
- **TOC:**
  1. Determinisztikus vs. valószínűségi előrejelzés
  2. Ensemble-módszerek alapja (több modell átlaga)
  3. Open-Meteo, ECMWF, GFS — modellek bemutatása
  4. Bias-korrekció (city offset)
  5. Bucket-valószínűség becslése (pl. "26°C–27°C")
  6. Brier-score (kalibráció mértéke):
     `$BS = \frac{1}{N}\sum_{t=1}^{N}(f_t - o_t)^2$`
  7. Gyakorlati alkalmazás: Polymarket időjárási piacok
  8. GYIK
- **Kalkulátor:** ⭐ **igen** — `islands/EnsembleKalkulator.tsx`
  - Input: 3 modell előrejelzése (textarea CSV) + observed outcome
  - Output: ensemble mean, ensemble std, Brier score, bucket-valószínűség

---

## 3. Session-bontás (megírási sorrend)

> Minden session ~1-2 cikk + ~1 új island (ha kalkulátoros). A cél: a
> könnyebb, validáló cikkekkel kezdünk, hogy a workflow (front-matter,
> schema, route-patch, catalog-patch) bejáratódjon — utána jönnek a
> mélyebb anyagok.

### Session 1 — Kelly-alapok (validáló session)

- **Cikkek:** A.1 Kelly-kritérium magyarázat + A.2 Kelly-kalkulátor cikk
- **Új island:** `KellyKriteriumKalkulator.tsx`
- **TOC patch:** új subcategory `crypto/strategia-kombinalas/`, 2 page
- **Catalog patch:** 1 új tétel (`crypto/strategia-kombinalas/kelly-kriterium-kalkulator`)
- **Hero image:** 1 új SVG
- **Becsült munkaóra:** ~6h (a workflow-ra ráhangolódással együtt)
- **Validáció:** `deno task dev` lokálisan, KaTeX render OK, schema rich-result
  test (`https://search.google.com/test/rich-results`)

### Session 2 — Funding-rate haladó (a meglévő mélyítése)

- **Cikkek:** új `crypto/hataridos-strategiak/funding-rate-haladó.md`
- **Tartalom:** mark-to-market accrual, asszimmetrikus close slippage band,
  cross-venue non-atomic risk, paper-vs-live parity
- **Forrás (saját):** `internal-docs/math/15-funding-arb.md`,
  `auto-trader/hyperliquid/funding-arb/fr-session.mts`
- **Új island:** **nem** — a meglévő `Funding_Rate_Arbitrage.tsx`-et bővítjük
  egy "haladó mód" toggle-lel (mark-to-market on/off, slippage band
  állítható)
- **Becsült munkaóra:** ~3h
- **Cross-link:** vissza a meglévő `funding-rate-strategia.md`-re mint
  "alapcikk", előre az A.1 Kelly-cikkre

### Session 3 — Sharpe-IR + Grinold-Kahn alaptörvény

- **Cikkek:** A.3 Sharpe-IR + A.4 Grinold-Kahn
- **Új island:** `SharpeIRKalkulator.tsx` + `GrinoldKahnKalkulator.tsx`
- **Catalog patch:** 2 új tétel
- **Becsült munkaóra:** ~10h (a két cikk + 2 island)
- **Cross-link:** A.1 Kelly-re vissza, B.6 payout-ratio-ra előre

### Session 4 — Kvantitatív jelek bevezetés + Kyle-lambda

- **Cikkek:** B.0 bevezetes + B.1 Kyle-lambda
- **TOC patch:** új subcategory `crypto/kvantitativ-jelek/`, 2 page
- **Új island:** `KyleLambdaKalkulator.tsx`
- **Catalog patch:** 1 új tétel (Kyle-kalkulátor)
- **Becsült munkaóra:** ~7h

### Session 5 — VPIN + Hawkes

- **Cikkek:** B.2 VPIN + B.3 Hawkes
- **Új island:** `VPINKalkulator.tsx` + opc. `HawkesKalkulator.tsx`
- **Becsült munkaóra:** ~9h
- **Megjegyzés:** Hawkes kalkulátor opcionális — ha az MLE-fit túl drága,
  csak vizualizációs sliderrel (μ, α, β) megoldható

### Session 6 — IV-RV + cond. prob

- **Cikkek:** B.4 IV-RV + B.5 cond. prob (inkonzisztens piacok)
- **Új island:** `IVRVKalkulator.tsx` + `InkonzisztenciaDetektor.tsx`
- **Becsült munkaóra:** ~9h

### Session 7 — Smart money + arb

- **Cikkek:** B.6 payout-ratio + B.7 VWAP-arb
- **Új island:** `PayoutRatioKalkulator.tsx` + `VWAPArbKalkulator.tsx`
- **Becsült munkaóra:** ~9h
- **Cross-link:** A.1 Kelly-re vissza (a payout ratio + Kelly együtt teljes
  kép), A.4 Grinold-Kahn-ra (több jel kombinálása)

### Session 8 — Brown-mozgás (statisztika cross-cikk)

- **Cikkek:** C.1 Brown-mozgás + Brown-híd
- **Új island:** `BrownHidKalkulator.tsx` (animációs Chart.js path-ok)
- **Catalog patch:** 1 új tétel a `statisztika` displayCategory alá
- **Becsült munkaóra:** ~6h
- **Megjegyzés:** ez a sorozatban a legmatekosabb cikk — a `crypto/`-tól
  függetlenül is használható statisztika-tananyag

### Session 9 — Ensemble + bevezetes lapok finomítása

- **Cikkek:** C.2 Ensemble-előrejelzés + cross-szekció bevezetes-frissítés
  (hogy a meglévő `crypto/bevezetes.md` lab-link-eket adjon az új cikkekre)
- **Új island:** `EnsembleKalkulator.tsx`
- **Becsült munkaóra:** ~6h

---

## 4. Schema-mintáink (másolás-barát)

### 4.1 Cikk articleSchema (Article + SoftwareApplication)

```yaml
articleSchema:
  "@context": "https://schema.org"
  "@type": "Article"
  "headline": "Kelly-kritérium kalkulátor — Optimális tét-méretezés"
  "description": "Interaktív Kelly-kalkulátor: optimális tét-arány...,
    drawdown-grafikon, ¼-Kelly és full-Kelly összehasonlítás."
  "datePublished": "2026-05-15T10:00:00.000Z"
  "dateModified": "2026-05-15T10:00:00.000Z"
  "inLanguage": "hu"
  "mainEntity":
    "@type": "SoftwareApplication"
    "@id": "https://matekmegoldasok.hu/crypto/strategia-kombinalas/kelly-kriterium-kalkulator"
    "name": "Kelly-kritérium kalkulátor"
    "applicationCategory": "FinanceApplication"
    "operatingSystem": "Any"
    "offers":
      "@type": "Offer"
      "price": "0"
      "priceCurrency": "HUF"
    "featureList":
      - "Kelly-arány számítás (binary outcome)"
      - "¼-Kelly intézményi default"
      - "Drawdown Monte Carlo szimuláció"
      - "Full-Kelly vs. ¼-Kelly összehasonlítás"
    "image":
      "@type": "ImageObject"
      "url": "https://matekmegoldasok.hu/crypto/strategia-kombinalas/kelly-kriterium-kalkulator-hero.svg"
      "width": 1200
      "height": 630
  "author":
    "@id": "https://matekmegoldasok.hu/#founder"
  "publisher":
    "@type": "Organization"
    "name": "MatekMegoldások"
    "url": "https://matekmegoldasok.hu"
  "about":
    - "@type": "Thing"
      "name": "Kelly criterion"
      "sameAs": "https://en.wikipedia.org/wiki/Kelly_criterion"
    - "@type": "Thing"
      "name": "Bankroll management"
      "sameAs": "https://en.wikipedia.org/wiki/Bankroll_management"
```

### 4.2 FAQ schema (8 Q&A javasolt minimum)

```yaml
faqPageSchema:
  "@context": "https://schema.org"
  "@type": "FAQPage"
  "question1": "Mi a Kelly-kritérium?"
  "answer1": "A Kelly-kritérium..."
  "question2": "Mit jelent a ¼-Kelly?"
  "answer2": "..."
  # ... 8 Q&A
```

> **Tip:** a kérdéseket úgy fogalmazd, hogy emberek tényleg keresnék
> Google-on. A Google rich-result test (search.google.com/test/rich-results)
> validálja a JSON-LD-t — minden cikk publikálás előtt ott teszteljük.

---

## 5. Kalkulátor-island sablon

Minden új island ezt a vázat követi (KamatosKamatKalkulator
mintájára):

```tsx
// islands/KellyKriteriumKalkulator.tsx
import { useState, useMemo, useCallback } from 'preact/hooks';
import type { JSX } from 'preact';

// ============================================
// TÍPUSOK
// ============================================

interface KellyResult {
  kellyFraction: number;       // f* in [0, 1]
  quarterKelly: number;
  expectedGrowth: number;      // log-growth rate per bet
  drawdownPath: number[];      // Monte Carlo equity curve sample
}

// ============================================
// SEGÉDFÜGGVÉNYEK
// ============================================

const formatPercent = (n: number, dec = 2) =>
  new Intl.NumberFormat('hu-HU', {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  }).format(n * 100) + '%';

// ============================================
// KALKULÁTOR LOGIKA
// ============================================

const computeKelly = (p: number, b: number): KellyResult => {
  const q = 1 - p;
  const kellyFraction = Math.max(0, (p * b - q) / b);
  const quarterKelly = kellyFraction * 0.25;
  const expectedGrowth = p * Math.log(1 + b * kellyFraction)
                       + q * Math.log(1 - kellyFraction);
  // Monte Carlo drawdown (100 path × 1000 bet)
  const drawdownPath: number[] = [];
  // ... (Monte Carlo logic)
  return { kellyFraction, quarterKelly, expectedGrowth, drawdownPath };
};

// ============================================
// KOMPONENS
// ============================================

export default function KellyKriteriumKalkulator(): JSX.Element {
  const [winProb, setWinProb] = useState(0.55);
  const [oddsB, setOddsB] = useState(1.0);

  const result = useMemo(() => computeKelly(winProb, oddsB), [winProb, oddsB]);

  return (
    <div class="bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700 p-6 my-8">
      {/* Input mezők (Tailwind v4) */}
      {/* Eredmény-kártya */}
      {/* Chart.js drawdown grafikon */}
      {/* Magyarázat: "Mit jelent ez?" */}
    </div>
  );
}
```

**Konvenció checklist:**
- [ ] `'preact/hooks'` import (NEM React)
- [ ] `JSX.Element` return type
- [ ] `Intl.NumberFormat('hu-HU', ...)` minden formázáshoz
- [ ] Tailwind v4 dark-mode utility (`dark:bg-...`)
- [ ] Sliderhez `<input type="range">` + numeric label
- [ ] Chart.js: dynamic import (`await import("chart.js/auto")`) az island
      `useEffect`-jében — SSR-ben nem fut
- [ ] Reszponzív: `grid grid-cols-1 md:grid-cols-2`
- [ ] Eredmény-kártya: nagy szám + "Mit jelent ez?" magyarázó sor

---

## 6. Patch-ek minden új cikkhez (5 fájl módosul)

Minden új cikknél ezt a sorrendet kövessd:

### 6.1 — `docs/<kategoria>/<slug>.md` (új fájl)

A cikk maga, front-matter + KaTeX-tartalom + GYIK.

### 6.2 — `docs/toc.ts` (patch)

Bejegyzés a megfelelő `pages` array-be:

```typescript
// docs/toc.ts — pl. crypto/strategia-kombinalas
"strategia-kombinalas": {
  title: "Stratégia kombinálás",
  pages: [
    ["page", "bevezetes", "Bevezetés"],
    ["page", "kelly-kriterium", "Kelly-kritérium"],
    ["page", "kelly-kriterium-kalkulator", "Kelly-kalkulátor"],
    ["page", "sharpe-information-ratio", "Sharpe-ráta és IR"],
    ["page", "grinold-kahn-alaptorveny", "Grinold-Kahn alaptörvény"],
  ],
},
```

### 6.3 — `data/calculators/hu.json` (patch — csak ha kalkulátoros cikk)

```json
{
  "name": "Kelly-kritérium Kalkulátor",
  "slug": "crypto/strategia-kombinalas/kelly-kriterium-kalkulator",
  "description": "Interaktív Kelly-kalkulátor: optimális tét-arány, ¼-Kelly intézményi standard, Monte Carlo drawdown.",
  "category": "FinanceApplication",
  "displayCategory": "penzugy",
  "homepageTitle": "Kelly Kalkulátor",
  "homepageDescription": "Optimális tét-méretezés Kelly-kritériummal és Monte Carlo drawdown-szimulációval",
  "heroImage": "https://matekmegoldasok.hu/crypto/strategia-kombinalas/kelly-kriterium-kalkulator-hero.svg"
}
```

> **Megjegyzés:** a `displayCategory` lehet meglévő (`penzugy`,
> `statisztika`) — nem kell új kategória ehhez a 14 cikkhez.

### 6.4 — `routes/[...slug].tsx` (patch — csak ha új island)

Két patch egy fájlban:

```tsx
// (1) import a fájl tetején, ABC-rendben
import KellyKriteriumKalkulator from "../islands/KellyKriteriumKalkulator.tsx";

// (2) URL match a többi calculator-injection mellé (~line 720+)
{url.pathname === "/crypto/strategia-kombinalas/kelly-kriterium-kalkulator" && (
  <KellyKriteriumKalkulator />
)}
```

### 6.5 — `static/<kategoria>/<slug>-hero.svg` (új fájl — csak ha kalkulátoros)

1200×630 px Open Graph hero. Egységes designhoz mintát a meglévő
`/algebra/kamatos-kamat-kalkulator-hero.svg`-ből vegyünk.

---

## 7. Források és hivatkozások (kötelezően a cikkek "Források" szekciójába)

> Minden cikk végén legyen `## Források` szekció. Cél: AI-search visibility +
> akadémiai súly + olvasói bizalom.

### 7.1 Akadémiai cikkek (peer-reviewed)

| Téma | Hivatkozás |
|------|-----------|
| Kelly | Kelly Jr., J.L. (1956). *A New Interpretation of Information Rate.* Bell System Technical Journal, 35(4): 917-926. |
| Kyle λ | Kyle, A.S. (1985). *Continuous Auctions and Insider Trading.* Econometrica, 53(6): 1315-1335. |
| VPIN | Easley, D., López de Prado, M., O'Hara, M. (2012). *Flow Toxicity and Liquidity in a High-frequency World.* Review of Financial Studies, 25(5): 1457-1493. |
| Hawkes | Hawkes, A.G. (1971). *Spectra of Some Self-Exciting and Mutually Exciting Point Processes.* Biometrika, 58(1): 83-90. |
| Hawkes (finance) | Bacry, E., Mastromatteo, I., Muzy, J.F. (2015). *Hawkes Processes in Finance.* Market Microstructure and Liquidity, 1(1): 1550005. |
| Black-Scholes | Black, F., Scholes, M. (1973). *The Pricing of Options and Corporate Liabilities.* J. Political Economy, 81(3): 637-654. |
| KL / Bregman | Wainwright, M.J., Jordan, M.I. (2008). *Graphical Models, Exponential Families, and Variational Inference.* Foundations and Trends in ML, 1(1-2). |
| Sharpe | Sharpe, W.F. (1966). *Mutual Fund Performance.* J. Business, 39(1): 119-138. |
| VWAP | Bertsimas, D., Lo, A. (1998). *Optimal Control of Execution Costs.* J. Financial Markets, 1(1): 1-50. |
| Brown-mozgás | Karatzas, I., Shreve, S.E. (1991). *Brownian Motion and Stochastic Calculus.* 2nd ed., Springer. |
| Ensemble | Hagedorn, R., Doblas-Reyes, F., Palmer, T. (2005). *The Rationale Behind the Success of Multi-Model Ensembles.* Tellus A, 57(3): 219-233. |

### 7.2 Könyvek (megvásárolható, ISBN-nel)

- Grinold, R.C., Kahn, R.N. (2000). *Active Portfolio Management.* 2nd ed.,
  McGraw-Hill. ISBN: 978-0070248823.
- Poundstone, W. (2005). *Fortune's Formula.* Hill and Wang.
  ISBN: 978-0809046379. (Kelly népszerűsítő)
- Tharp, V.K. (2007). *Definitive Guide to Position Sizing.* IITM.
  ISBN: 978-0935219098.
- Hull, J.C. (2018). *Options, Futures, and Other Derivatives.* 10th ed.,
  Pearson. ISBN: 978-0134472089.
- Kakushadze, Z., Serur, J.A. (2018). *151 Trading Strategies.* Palgrave
  Macmillan. ISBN: 978-3030027919. (a saját
  `internal-docs/math/151-Trading-Strategies.pdf` referenciánk)

### 7.3 Wikipedia-sameAs linkek (Schema.org `about` mezőkhöz)

```yaml
about:
  - "@type": "Thing"
    "name": "Kelly criterion"
    "sameAs": "https://en.wikipedia.org/wiki/Kelly_criterion"
  - "@type": "Thing"
    "name": "Market microstructure"
    "sameAs": "https://en.wikipedia.org/wiki/Market_microstructure"
  - "@type": "Thing"
    "name": "Volatility (finance)"
    "sameAs": "https://en.wikipedia.org/wiki/Volatility_(finance)"
  - "@type": "Thing"
    "name": "Brownian motion"
    "sameAs": "https://en.wikipedia.org/wiki/Brownian_motion"
  - "@type": "Thing"
    "name": "Information ratio"
    "sameAs": "https://en.wikipedia.org/wiki/Information_ratio"
  - "@type": "Thing"
    "name": "Hawkes process"
    "sameAs": "https://en.wikipedia.org/wiki/Hawkes_process"
  - "@type": "Thing"
    "name": "Volume-synchronized probability of informed trading"
    "sameAs": "https://en.wikipedia.org/wiki/VPIN"
  - "@type": "Thing"
    "name": "Brownian bridge"
    "sameAs": "https://en.wikipedia.org/wiki/Brownian_bridge"
  - "@type": "Thing"
    "name": "Ensemble forecasting"
    "sameAs": "https://en.wikipedia.org/wiki/Ensemble_forecasting"
  - "@type": "Thing"
    "name": "Kullback–Leibler divergence"
    "sameAs": "https://en.wikipedia.org/wiki/Kullback%E2%80%93Leibler_divergence"
```

### 7.4 Saját projekt-források (cross-referencia, NEM publikus link)

A cikkek kéziratába mint "saját projekt-illusztráció" hivatkozhatunk:

- `internal-docs/math/02-ev-kelly.md` (EV + Kelly összefoglaló)
- `internal-docs/math/06-orderflow.md` (Kyle λ + VPIN + Hawkes + AS)
- `internal-docs/math/07-vol-harvest.md` (IV-RV stratégia)
- `internal-docs/math/08-apex-wallets.md` (smart money klasszifikáció)
- `internal-docs/math/09-cond-prob.md` (cond. prob + KL + Bregman)
- `internal-docs/math/10-signal-combiner.md` (Grinold-Kahn IR=IC√N)
- `internal-docs/math/11-arb-matrix.md` (VWAP arb + LLM dep)
- `internal-docs/math/13-crypto-bot.md` (Brown-híd v1 paper-resolver)
- `internal-docs/math/14-hl-directional.md` (HL directional perp)
- `internal-docs/math/15-funding-arb.md` (mark-to-market accrual)
- `internal-docs/math/weather/README.md` (ensemble forecast)

> **Fontos:** ezek a fájlok a saját projektben vannak, NEM publikusak. A
> cikkben ne hivatkozz internal-docs-ra explicit URL-lel — a tartalmat
> emeld át, magyar nyelvű paraphrase-ben, és magát a tartalmat akadémiai
> forráshoz kösd.

---

## 8. Validációs protokoll (cikk publikálás előtt)

Minden cikk publikáláshoz futtasd le ezt a 6 lépést:

1. **`deno task dev`** — lokális Fresh dev server, navigálj a slug-ra
2. **KaTeX render** — minden `\[ ... \]` block tényleg formula-ként
   jelenik meg (nem nyers szöveg)
3. **ToC oldal-jobboldali** — a saját island-mintázat (`TableOfContents`)
   minden H2/H3-at felismer (ha nem: heading anchor ID hibás)
4. **`gh search/test/rich-results`** — vagy a Google Rich Results Test
   (search.google.com/test/rich-results) → `Article` + `FAQPage` + opc.
   `SoftwareApplication` validál
5. **Mobil reszponzív** — Chrome DevTools mobil-emuláció, kalkulátor
   gombok klikkelhetők, KaTeX-blokkok overflow-x scrollolnak
6. **Cross-link sanity** — a cikk hivatkozott URL-jei léteznek (404
   nélkül)

> Ha az 6 közül bármelyik elbukik, a cikk **nem publikálható**. PR-ben
> jelezd a státuszt: `[VALIDÁCIÓ: 5/6 — KaTeX-blokk hiba a §4-ben]`.

---

## 9. Javasolt session-zárási checklist

Minden session zárásakor:

1. [ ] Új cikkek a `docs/`-ban
2. [ ] `toc.ts` patch
3. [ ] `data/calculators/hu.json` patch (ha kalkulátoros)
4. [ ] `routes/[...slug].tsx` patch (ha új island)
5. [ ] `islands/<NameKalkulator>.tsx` (ha új island)
6. [ ] Hero SVG a `static/`-ben (ha új island)
7. [ ] Validáció 6/6 zöld
8. [ ] Belső doksi-frissítés a saját trading-bot projektben:
       `internal-docs/changelog/CHANGELOG-YYYY-MM-DD.md` egy "matek-cikk"
       szekcióval, ami felsorolja a publikált slug-okat

---

## 10. Esetleges szegmentálás (ha 14 cikk soknak bizonyul)

Ha a 9 session lefutása előtt kifut az idő/energia, **prioritás-sorrend**
(az érték-vs-erőfeszítés alapján):

### MUST-HAVE (Session 1, 2, 3 — az alap kvantitatív alaplánc)

- A.1 Kelly-kritérium magyarázat
- A.2 Kelly-kalkulátor cikk
- A.3 Sharpe-IR
- Funding-rate haladó (Session 2)

→ Ez 4 cikk + 3 island, és önmagában már koherens "tét-méretezés" mini-sorozat.

### NICE-TO-HAVE (Session 4-7 — mikrostruktúra mélységi)

- B.0-B.7 (Kyle, VPIN, Hawkes, IV-RV, cond.prob, smart-money, arb)

→ Ez a megkülönböztető tartalom — itt nincs versenytárs magyar nyelven.

### OPTIONAL (Session 8-9 — statisztika-támogatás)

- C.1 Brown-mozgás (igazából ÁLTALÁNOS statisztika cikk, a `/statisztika/`
  alá megy — független a `crypto/` struktúrától)
- C.2 Ensemble-előrejelzés (időjárás-piacokhoz kötődik, opcionális)

---

## 11. Hosszabb távú kiterjesztés (a 9 session után, opcionális)

Ha a 14 cikk publikálása sikeres, a következő logikus bővítés:

- **Premium PDF összeállítás** — a 14 cikkből egybeszerkesztett
  *"Bevezetés a kvantitatív pénzügybe"* PDF (~150-200 oldal), gyakorló
  feladatokkal és megoldókulccsal. Ez illeszkedik a meglévő
  `feladatlapok/` (Premium PDF) szekcióba új kategóriaként
  (`kvantitativ-penzugy`).
- **Egy 13. island:** egy "Stratégia-szimulátor" ami az összes 12 jelet
  kombinálja egy leegyszerűsített Polymarket-szerű piacon — gyakorlati
  showcase. Ez a Funding_Rate_Arbitrage island továbbgondolása.
- **Külföldi nyelv:** a `data/calculators/sk.json` már
  inicializálva van, az SK domain (matematikariesenia.sk) készen áll a
  switchre. Az új cikkeket SK fordításban is be lehet tenni.

---

## 12. Összefoglaló-tábla (egy oldalon)

| # | Slug | Sorozat | Kategória | Kalkulátor | Session |
|---|------|---------|-----------|------------|---------|
| A.1 | `crypto/strategia-kombinalas/kelly-kriterium` | A | Strat-komb | (utal) | 1 |
| A.2 | `crypto/strategia-kombinalas/kelly-kriterium-kalkulator` | A | Strat-komb | ⭐ | 1 |
| FR | `crypto/hataridos-strategiak/funding-rate-haladó` | (bonus) | Határidős | (létező bővítés) | 2 |
| A.3 | `crypto/strategia-kombinalas/sharpe-information-ratio` | A | Strat-komb | ⭐ | 3 |
| A.4 | `crypto/strategia-kombinalas/grinold-kahn-alaptorveny` | A | Strat-komb | ⭐ | 3 |
| B.0 | `crypto/kvantitativ-jelek/bevezetes` | B | Kvant-jel | – | 4 |
| B.1 | `crypto/kvantitativ-jelek/kyle-lambda` | B | Kvant-jel | ⭐ | 4 |
| B.2 | `crypto/kvantitativ-jelek/vpin-toxic-flow` | B | Kvant-jel | ⭐ | 5 |
| B.3 | `crypto/kvantitativ-jelek/hawkes-folyamatok` | B | Kvant-jel | (opc.) | 5 |
| B.4 | `crypto/kvantitativ-jelek/iv-rv-divergencia` | B | Kvant-jel | ⭐ | 6 |
| B.5 | `crypto/kvantitativ-jelek/feltteles-valoszinuseg-piacokon` | B | Kvant-jel | ⭐ | 6 |
| B.6 | `crypto/kvantitativ-jelek/smart-money-payout-ratio` | B | Kvant-jel | ⭐ | 7 |
| B.7 | `crypto/kvantitativ-jelek/arbitrázs-vwap-validalt` | B | Kvant-jel | ⭐ | 7 |
| C.1 | `statisztika/brown-mozgas` | C | Statisztika | ⭐ | 8 |
| C.2 | `statisztika/ensemble-elorejelzes` | C | Statisztika | ⭐ | 9 |

**Összesen: 15 cikk + 12 új interaktív kalkulátor** (A.1, B.0 cikkek
nem-kalkulátorosak, FR pedig a meglévő island bővítése).

---

## Kapcsolódó dokumentumok ebben a repóban

- `internal-docs/math/02-ev-kelly.md` — Kelly + EV alapok (saját)
- `internal-docs/math/06-orderflow.md` — Kyle, VPIN, Hawkes (saját)
- `internal-docs/math/07-vol-harvest.md` — IV-RV (saját)
- `internal-docs/math/08-apex-wallets.md` — smart money (saját)
- `internal-docs/math/09-cond-prob.md` — cond. prob + KL (saját)
- `internal-docs/math/10-signal-combiner.md` — Grinold-Kahn (saját)
- `internal-docs/math/11-arb-matrix.md` — VWAP arb (saját)
- `internal-docs/math/13-crypto-bot.md` — Brown-híd példa (saját)
- `internal-docs/math/15-funding-arb.md` — mark-to-market accrual (saját)
- `internal-docs/math/weather/README.md` — ensemble (saját)
- `internal-docs/mathSEO_reference/` — a publikációs site repo
  (gitignore-ban, nem commitolódik)
