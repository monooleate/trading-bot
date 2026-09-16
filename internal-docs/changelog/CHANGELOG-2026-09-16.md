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

## 3. B69 — weather offline ensemble-értékelés

(lásd külön szakasz a futás után)

---

*(a deploy, a B74 élesítés és a B69 futás eredménye a szakasz alján frissül)*
