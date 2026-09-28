# CHANGELOG — 2026-09-25 (95. session)

## Kiváltó ok

A user: *„már régen nyitottak a botok, szinte egyik sem működik! állítsunk a paramétereken!"*, majd mid-turn: *„ha minden veszteséges, akkor nem kellene trénelnünk a kereskedő botokat?"*

**Kód NEM változott.** A session tartalma: (1) élő read-only diagnózis, (2) egy operatív döntés (sports leállítása), (3) a „tréning" fogalmának tisztázása.

## Diagnózis (read-only, élő box)

Módszer: `ssh analytics` → `docker logs edgecalc-workers` + belső `fetch http://api:7000/api/multi-status` a workers konténerből (a `runtime-overrides-v1` raw DB-értékét a harness-classifier „Production Reads" címén blokkolta — de a worker-log first-hand kiírja az effektív knobokat, pl. a `threshold 15%`-ot, úgyhogy nem feltételezés).

**A 09-02-i tiszta indulás óta (~23 nap) minden bot mínuszban** — összesen $700 → $614.58 (**−$85.42, −12,2%**), 102 zárt trade, 1 nyitott:

| Bot | Tőke | PnL | % | Zárt | Nyitva | Állapot |
|---|---|---|---|---|---|---|
| crypto | $150 → $111.84 | −$38.16 | −25% | 10 | 0 | Kereskedik, de veszít; **>25% DD** (`ddFraction 0.254`) |
| weather | $100 → $86.57 | −$13.43 | −13% | 33 | 0 | Most 0 illeszkedő piac |
| hyperliquid | $200 → $199.32 | −$0.68 | ~0% | 30 | 0 | **B74 halt** → flat |
| funding-arb | $200 → $197.38 | −$2.62 | −1% | 11 | 1 | ~flat |
| sports | $50 → $19.47 | −$30.53 | **−61%** | 18 | 0 | Fabrikált fair value → longshot-bukás |

**A tehetetlenség okai (logból verifikálva):**
- **Crypto**: `edgeThreshold = 15%` ([services/worker/src/pillars/shared/config.mts:33](../../services/worker/src/pillars/shared/config.mts), `EDGE_THRESHOLD_CRYPTO || "0.15"`, tunable 0.02–0.30) → csak a >15% nettó edge-ű (fee után) piac megy át; a valós jelek 5–8%-on buknak. **Nem befagyott** — 2026-09-25-én is nyitott 3-at (BTC-above-84k NO / ETH-above-2700 NO / SOL-above-120 NO, 16–20% edge). Ráadásul a bot **>25% drawdownban** van (a `riskDdKillEnabled=1` advisory-t logol, de a `paperNeverStop` miatt nem halt).
  - ⚠ **Korrekció (2026-09-28, 96. session):** a „nyitott 3-at" téves — a logban ezek `DECISION_TRADE` sorok voltak, és mindhármat `ORDER_REJECTED` követte (14 napon át 68/68). Lásd [changelog 2026-09-28](CHANGELOG-2026-09-28.md) · sprints B75.
- **Crypto up-or-down + HL**: minden ticken `Directional halt (B74): up-or-down market, measure-only` → **8 napja szándékosan** nem nyitnak (a 94. session mérése: up-or-down −44%, HL −59% Brier-skill a piac ellen).
- **Worker-tick**: csak `crypto` + `weather` pillért reconcile-el (a HL/up-or-down a crypto-scan része); **sports és F-Arb egyáltalán nincs a worker tickben** (24h-ban 0 log).

## Döntés — „fegyelmezett rendrakás" (a user választása)

A négy felkínált irányból (fegyelmezett rendrakás / crypto adatgyűjtő kísérlet / tényleg lazítsunk mindenen / előbb mélyebb audit) a user a **fegyelmezett rendrakást** választotta:

1. **Sports LEÁLLÍTÁSA.** A `paperNeverStop` szelep a manuális stopot sosem oldja fel — csak az auto-stopokat (`session loss limit` / `calibration noise` / `consecutive loss`), lásd [paper-never-stop.mts:29](../../services/worker/src/pillars/shared/paper-never-stop.mts). A durable módszer tehát a `stop` action, ami `stoppedReason="Manual stop"`-ot ír ([sports/index.mts:461](../../services/worker/src/pillars/sports/index.mts)). ⚠ **A stopot az operátor alkalmazza** (dashboard → Sports → Stop): az auth nálam nincs, a DB-írást a classifier blokkolja (a 90. session precedense: az operátor futtatja a kész műveletet). Utána `/multi-status` verifikáció (stopped=true + reason="Manual stop").
   - **⚠ SSOT-figyelem:** ez **visszafordítja a 92. session** „sports fut" döntését (akkor a `sportsCronEnabled` override törölve lett + reset $50/0). A CLAUDE.md explicit szabálya szerint a sports-politika váltásakor a CLAUDE.md AKTUÁLIS ÁLLAPOT-ot kell frissíteni — megtörtént. Indok: fabrikált fair value (a Polymarket-ár 0.5 felé húzása) → strukturális longshot-bukás, valódi edge-forrás nincs → **B37-ig ne fusson**.
2. **HL + crypto up-or-down halt MARAD** (B74) — ez tartja a HL-t ~flaten.
3. **NINCS lazítás.** A 93. session promóciós kapuja szerint a predikciók a piaci ár ELLEN veszítenek (crypto −61% · weather −124% · sports −6% Brier-skill) → a küszöb-lazítás vagy a directionalHalt kikapcsolása a rendszer saját mérése szerint **gyorsítaná** a paper-veszteséget (B56b: „plauzibilis javítás mérve ronthat").

## A „tréning"-kérdés tisztázása

A user kérdése jogos, de a válasz árnyalt (a 68. session B50 „training discovery" + a B41 forecasting szerint):

- A hangolás **nem teremt edge-et** — csak újraosztja. Ha a forecast strukturálisan a piaci ár alatt van (amit a mérés mutat a directional/weather/sports ágakon), azt **jobb információforrás** javítja, nem a paraméter.
- A grid-search / RL a paper-PnL-en **csapda** (mindhárom B50 kutató-ág így jelölte: reward-hacking a fill-modellen, kis minta, irreprodukálható seed).
- A **valódi tréning-karok** már azonosítottak és nem lazítás:
  - **B69** — a weather multi-model ensemble pooling a boxon **bizonyítottan +12,7% CRPS-skillt** ad (a GEFS-only σ ~1,9×-esen túl szűk); operacionalizálandó a B52-flip + σ/EMOS-knobok forward-újrahangolásával.
  - **B37** — a sports csak valódi Pinnacle-odds feeddel kaphat edge-et.
- Az irány tehát: proper-score / offline-kalibráció a valós historikus adaton, **nem** knob-csavarás a paper-PnL-en.

## Hátralévő operatív lépés

- [ ] Operátor: sports `Stop` a dashboardon → utána `/multi-status` verifikáció (stopped + "Manual stop"). Amíg ez nem történik meg, a sports session `stopped=false` marad (bár funkcionálisan már ~dormant: utolsó aktivitás jóval korábbi, 0 nyitott pozíció).

## Doksi-touch

- `CLAUDE.md` — AKTUÁLIS ÁLLAPOT dátum 2026-09-16 → 2026-09-25; knob-lista sports-jegyzet frissítve (manuális stop, a 92. session-döntés visszafordítva); új „95. session" blokk.
- Ez a changelog.
- Sprint-hivatkozás: a valódi javító-karok a [sprints.md](../roadmap/sprints.md) **B37** (sports Pinnacle-feed) és **B69** (weather ensemble-flip) tételei — új sprint-task nem keletkezett (a sports-stop operatív döntés, nem code-change).
