# CHANGELOG — 2026-09-16 (94. session)

A user: „csináld őket sorban 1, 2, 3" — a 93. session végi három javaslat:
1. B73 — crypto threshold offline backtest (mérés);
2. B74 — a bizonyítottan vesztes directional kereskedés leállítása, mérés fenn;
3. B69 — weather offline ensemble-értékelés.

Kiinduló mérés (tiszta ledger, B67-provenancia, 2026-09-14, boot 90% CI): a modell
első becslése a piac első ára ellen, OOS Brier-skill —
crypto threshold **+8%** (n=23, CI [−5%,+23%]) · crypto up-or-down **−44%** (n=72,
CI [−77%,−21%]) · HL **−59%** (n=31, CI [−144%,−12%]) · weather **−61%** (n=44) ·
sports **−10%** (n=116). Egyetlen ág mutat edge-jelet (threshold), a directional
ágak bizonyítottan a piac alatt.

---

## 1. B73 — crypto threshold offline backtest → NEGATÍV EREDMÉNY (artefakt kiszűrve)

**Cél:** a threshold-edge (+8%, de n=23) mintáját bővíteni több száz historikus
lezárt above-K piacra, a bot valódi fair-value-jának hű rekonstrukciójával
(N(d₂), σ = HAR-RV — pontosan az élő út, `useHarRv=1`; a `normalCdf`, a
Rogers–Satchell HAR és a d₂ egy-az-egyben a [`signal-combiner.mts`](../../services/api/src/routes/signal-combiner.mts)
+ [`har-rv.mts`](../../packages/core/src/har-rv.mts) portja).

**Az első futás +92%-ot adott — és ez ARTEFAKT volt, nem edge.** Elkaptam, mielőtt
bármit szállítottam volna:
- A Gamma `tag_id=21` lezárt above-K univerzuma (2026-05-15 óta, n=108) **mind
  órás strike-létra** (`…-Npm-et`), nulla napi piaccal.
- Ezeknek **nincs valós ár-idősoruk**: 108-ból **74 a 0,5-ös mag-placeholderen
  ül**, és az explicit 4-napos `prices-history` lekérés is **egyetlen** pontot ad
  vissza, ~1 órával a lejárat előtt.
- A spotból számolt N(d₂) tehát egy **hamis 0,5-ös baseline** ellen „nyert", és a
  mély ITM/OTM kimenetet triviálisan eltalálta (deep-`|m|` sávban Brier 0,0000).

**Verdikt:** offline threshold-backtest ezeken a piacokon **nem elvégezhető** —
nincs valós piaci ár, amit verni lehetne. A threshold-edge csak a bot által
**forward-logolt likvid** sorokból mérhető, ahol a tiszta minta n=23 (+8%, a CI
tartalmazza a 0-t). **Kód nem változott**, az artefaktot nem szállítottam. A
threshold-ág marad forward-only; a napi drift-check követi a tiszta sorok
gyűlését (~+13/nap). Ez a B53/B56b-lecke újabb esete: szennyezett/placeholder
baseline ellen mért „skill" nem edge.

## 2. B74 — measure-only directional halt (default-OFF) ✅ IMPLEMENTED

**Új `directionalHalt` knob** (0/1, `common`, default 0). ON esetén egyik runner
sem nyit **directional** pozíciót, de **tovább logol a ledgerbe** (torzítatlan
mérés):
- **crypto:** csak a **up-or-down** (directional) piacok állnak le
  ([`isDirectionalCryptoMarket`](../../packages/core/src/coin.mts)); a **threshold
  (above-K)** ág változatlanul kereskedik.
- **HL:** minden belépő leáll (a perp-bot teljesen directional).

**Elhelyezés:** mindkét gate azon a piacon/coinon tüzel, ami **különben belépett
volna** (a `!shouldTrade` után), és a sort `predictedProb` + `endDate` /
`marketPrice` mezővel pusholja → az `appendPredictions` logolja, a ledger tovább
gyűlik. A `firstPredictedProb`/`outcome` változatlan, tehát a **mérés (Brier a
kimenet ellen) nem sérül** — pontosan a „ne vegyél fel, de mérj tovább" cél.

- Új helper [`directionalHaltEnabled()`](../../services/worker/src/pillars/shared/config.mts)
  (env `DIRECTIONAL_HALT` + override); tickenként egyszer olvasva.
- SCHEMA + [env-vars.md](../current-state/env-vars.md) `DIRECTIONAL_HALT`.
- Teszt: [`coin.test.mts`](../../packages/core/src/coin.test.mts) új B74-blokk —
  az up-or-down piacokat halt (kohorsz), a threshold piacokat NEM.
- `tsc` 0 · **54/54** teszt · build zöld.

**Miért default-OFF + operátor-élesítés:** viselkedés-változás → mérés-first
doktrína. A live-flip a deploy után külön, jóváhagyott lépés.

## 3. B69 — weather offline ensemble-értékelés → a multi-model pooling BIZONYÍTOTTAN javít

**Lefuttatva a boxon** (dynamical.org Icechunk, izolált `/tmp/b69lib` Python-környezet; a rendszer-Pythonhoz nincs pip/venv, `--target`-be telepítve, a botokat nem érintve). **11 823 állomás-nap**, 439 db 00z init 2025-07-02→09-13, a **B71-javított rezolúciós állomásokra**, T+1 napi maximum, IEM METAR / HKO megfigyeléssel. Pontozás a `multi-model-eval.mts` szerint (Gauss-CRPS, var-ratio, ±1σ), pooling a `multi-model-ensemble.mts` szerint (modellenként egyenlő súly, teljes-variancia tétel).

**⚠ Menet közben elkaptam egy valódi tengely-hibát a saját scriptemben** — az IFS/AIFS dimenzió-sorrendje `(lead, member)`, a GEFS-é `(member, lead)`; a pozíciós `axis=1` az ECMWF-modelleknél a **tagokra** maximalizált, és hamis **4–8 °C hidegtorzítást** gyártott (paris IFS 24 vs valós 32). Megfigyelés-kontrollal szúrtam ki (a member-count 8/4 volt 51 helyett), név szerinti redukcióra javítottam. A tanulság a B53/B56b vonalán: mérés előtt kontroll valós adaton.

### Eredmény (a javított futás)

| variáns | torzítás | MAE | RMSE | CRPS | σ̄ | var-ratio | ±1σ |
|---|---|---|---|---|---|---|---|
| GEFS-inst *(amit a bot ma használ)* | −0,74 | 1,62 | 2,04 | 1,287 | 0,94 | **3,69** | 36% |
| GEFS-tmax *(intervallum-max)* | −0,19 | 1,59 | 2,07 | 1,271 | 0,90 | 4,30 | 35% |
| IFS-ENS | −1,20 | 1,65 | 2,05 | 1,346 | 0,74 | 6,15 | 26% |
| AIFS-ENS | −1,55 | 1,77 | 2,15 | 1,377 | 0,95 | 4,49 | 28% |
| **POOLED-inst** (G+I+A) | −1,16 | 1,52 | 1,86 | **1,124** | 1,25 | **1,91** | 44% |
| **POOLED-best** (Gtmax+I+A) | −0,98 | 1,44 | 1,78 | **1,061** | 1,33 | **1,51** | 50% |

**Három megállapítás, mind 11 823 napon:**

1. **A GEFS-only σ súlyosan alul-diszperz — var-ratio 3,69, azaz a σ ~1,9×-esen túl szűk.** Ez a dokumentált weather-patológia első nagymintás számszerűsítése. Az élő `weatherSigmaInflation=2.25` tehát jó irány, sőt kissé bőkezű (√3,69 ≈ 1,92).
2. **A pooling érdemben javít — dispersion ÉS pontosság:** a var-ratio 3,69 → **1,91** (a modellek közötti tag adja a szerkezeti szórást, amit egy család nem lát), a CRPS-skill a GEFS-inst ellen **+12,7% (párosított bootstrap 90% CI [+11,9, +13,4])**, interval-maxszal **+17,6% (CI [+16,9, +18,3])**. Régiónként is pozitív: EU +16,3%, Amerika +12,3%, Ázsia +9,7%. A pool a napok 55–59%-án nyer.
3. **Az intervallum-max változó ~0,55 °C hidegtorzítást vesz le** a GEFS-ből (bias −0,74 → −0,19). A pool viszont örökli az ECMWF hidegtorzítását (IFS −1,20, AIFS −1,55) → a `weatherUseEmos` bias-korrekciója a poollal fontosabb.

### Verdikt és korlátok

A **B52 flip iránya (`weatherUseMultiModel`) bizonyítottan helyes**: a pooling +12–18% CRPS-t hoz és felezi az alul-diszperziót. **Két korlát, amiért ez nem azonnali flip:** (a) ez a mérés **3 modellt** használ, az élő multi-model **6–8-at** (GEM/UKMO/ICON is) és **EMOS-korrigált** — a pontos flip-hatáshoz a forward log kell; (b) a pool **még mindig alul-diszperz** (1,91), tehát a σ-infláció nem tűnik el, csak csökken (~√1,91 ≈ 1,4× a GEFS-only ~1,9× helyett). A két weather-knob (`weatherSigmaInflation` + `weatherEmosSeedWeight`) párban mérendő — a flip után újra kell hangolni, nem előtte. **Kód nem változott** (mérés); a flip + a knob-újrahangolás operátor-döntés a forward multi-model adatra.

Scriptek a scratchpadban (`b69_eval.py`, `b69_ci.py`); a nyers minták a boxon `/tmp/b69_samples.jsonl` (11 823 sor).

---

## Deploy + állapot

- **B73 + B74 kód/doksi:** `1bea55c`, CI + deploy zöld. A `directionalHalt` knob a boxon fut, **default-OFF**.
- **B74 élesítés (2026-09-17 14:28 UTC):** ✅ élesítve. A `directionalHalt=1` DB-írást a harness auto-mode classifier („Feature Flag Writes") blokkolta (kétszer, a chat-engedély sem oldja fel), ezért **az operátor futtatta le** a merge-SQL-t. Élő: **18 override**, `directionalHalt=1`; a workerek tickelnek és olvassák a knobot, az élesítés óta 0 új pozíció nyílt, 0 valódi hiba. A halt-log egyelőre 0 — helyes (a gate csak would-be-trade-re tüzel; a directional ágak a korábbi kapukon amúgy is elakadnak). A CLAUDE.md knob-lista 18-ra frissítve.
- **B69:** csak mérés, nincs live-változás.
