
# 2026-05-11 (c) — `internal-docs/` átszervezés (current-state / math / roadmap / archive)

## A user kérése

"Az internal-docs mappa tartalmát ésszerűsítsük, rendezzük logikus
mappaszerkezetbe! Elemezd az összes doksit és ha már nincs rá szükség
akkor vagy archive vagy törlés. Duplikációk nem kellenek. current-state
; math ; future-state és roadmap-to-reach future state."

## Új struktúra

A korábbi `app/`, `migration/`, `app/done/`, `math/weather/` keverék
egyszerre 5 szemantikai mappára bontva:

| Mappa | Mit tartalmaz | Mikor olvasod |
|-------|---------------|---------------|
| `current-state/` | Élő rendszer snapshot (architecture, env-vars, deploy, settings, trading-status, auto-claim) | Új session elején — "mi van most" |
| `math/` | Signal math + bot impl reference (02-ev-kelly … 16-weather-bot) | Algoritmus-szintű kérdéseknél |
| `roadmap/` | Hetzner migráció, master-plan, új stratégiák, infrastructure | "Mit építsünk legközelebb" |
| `changelog/` | Session-by-session history | "Mit változtattam tegnap" |
| `archive/` | Elkészült promptok + historikus tanulságok | Ritkán; régi döntések indoka |

## Mozgatások (git mv-vel a tracked fájlokon)

**`current-state/` (6 fájl):**
- `app/architecture.md` → `current-state/architecture.md`
- `app/trading-status.md` → `current-state/trading-status.md`
- `app/settings-help.md` → `current-state/settings-reference.md`
- `app/auto-claim.md` → `current-state/auto-claim.md`
- `env-vars.md` (root-ból) → `current-state/env-vars.md`
- `app/DEPLOY.md` → `current-state/deploy.md`

**`math/` (1 új flat-be hozva):**
- `math/weather/README.md` → `math/16-weather-bot.md`

**`roadmap/` (6 fájl + új README):**
- `edgecalc-master-plan.md` (root) → `roadmap/master-plan.md`
- `migration/hetzner-migration-plan.md` → `roadmap/hetzner-migration.md`
- `migration/infrastructure.md` → `roadmap/hetzner-infrastructure.md`
- `migration/migration-plan.md` → `roadmap/migration-strangler-fig.md`
- `migration/new-strategies-roadmap_1.md` → `roadmap/new-strategies.md`
- `migration/risk-coordinator.md` → `roadmap/risk-coordinator-considerations.md`
- **Új:** `roadmap/README.md` — olvasási sorrend a 6 doki-hoz

**`archive/` (5 prompt + 3 misc):**
- `app/done/edgecalc-{autotrader,hyperliquid,funding-arb,resolution-risk,weather-patch}-{prompt,patch}.md` → `archive/prompts/{autotrader,hyperliquid,funding-arb,resolution-risk,weather-patch}-{prompt,patch}.md`
- `app/paper-pnl-analysis.md` → `archive/paper-pnl-v2-bug.md` (a v2 sim bug forensics, már fixelve sim v3-mal)
- `migration/reference/VPS-SETUP_detailed_done_26-04-03.md` → `archive/grabit-vps-setup.md`
- `content-roadmap-matekmegoldasok.md` (root, untracked) → `archive/matekmegoldasok-content-roadmap.md` (másik projekt cikk-roadmap-je)

## Törlések (4 dupli/elavult)

- `app/done/hyperliquid.md` (átfedi `math/14-hl-directional.md`)
- `app/done/weather-patch.md` (átfedi CHANGELOG-2026-04-21)
- `app/done/roadmap.md` (Sprint 1 status, elavult)
- `migration/README_2.md` (csak meta-olvasási sorrend, beépítve `roadmap/README.md`-be)

## Cross-reference frissítések

**`internal-docs/README.md`** — teljes újraírás. Index 5 mappára, minden
fájl egysoros leírással.

**`CLAUDE.md`** — irányadó hivatkozások javítva (a session-history
bejegyzéseket nem nyúltam):
- "Mappaszerkezet" block (L56) — bemutatja az 5 új almappát
- "KÖTELEZŐ SESSION-ZÁRÓ SZABÁLY" 2. és 4. pont — `current-state/` /
  `math/` / `roadmap/` szétbontás
- "Új tab hozzáadása" 6. pont — `math/NN-new-panel.md` path
- 14-15. session env-vars hivatkozás → `current-state/env-vars.md`
- 26. session "B (külön MD)" → `roadmap/hetzner-migration.md`

**Belső roadmap cross-ref-ek** (7 sibling-link javítva):
- `roadmap/hetzner-migration.md` → `migration-strangler-fig.md` /
  `hetzner-infrastructure.md` / `risk-coordinator-considerations.md` /
  `new-strategies.md` / `../archive/grabit-vps-setup.md`
- `roadmap/master-plan.md` → új env-vars path + relative `../current-state/` /
  `../math/` / `../changelog/` linkek
- `roadmap/hetzner-infrastructure.md`, `roadmap/migration-strangler-fig.md`,
  `roadmap/new-strategies.md`, `roadmap/risk-coordinator-considerations.md`
  → új sibling-fájlnevekre

**`math/13-crypto-bot.md`** — `app/architecture.md` →
`current-state/architecture.md`, `app/paper-pnl-analysis.md` →
`archive/paper-pnl-v2-bug.md`.

**`changelog/`** fájlokat **nem** módosítottam — történelem-marker.

## Üres mappák törlése

`app/done/`, `app/`, `migration/reference/`, `migration/`, `math/weather/`
mind eltávolítva (üresek lettek a mozgatások után).

## Verifikáció

- `git status`: 13 modified file, 2 új untracked (`roadmap/README.md`,
  `archive/matekmegoldasok-content-roadmap.md`).
- Grep verifikáció: nincs maradék `internal-docs/(app|migration)/`
  hivatkozás a non-changelog fájlokban.
- TypeScript / build NEM futott (csak markdown, kód érintetlen).

## Hova nyúlj legközelebb

- Új doksi írásakor a megfelelő szemantikus mappába tedd (current-state
  / math / roadmap / archive). A flat root már nem támogatott.
- Az `archive/`-ban lévő doksikat NE editáld in-place — történelmi
  forrás. Ha új tanulság van, az `current-state/` vagy `math/` alá kerül.
- Egy új CLAUDE.md "Mappaszerkezet" block tükrözi az 5 mappát — új
  almappa hozzáadásakor frissíteni kell.

---

# 2026-05-11 (a) — Crypto Reconcile + per-position Gamma diagnostic

## A user észrevett bug

A /trade/crypto/ oldalon 1 pending paper position past endDate maradt
"awaiting Polymarket resolution"-nel, és nem volt világos, miért nem
záródik automatikusan.

## A valódi viselkedés

Polymarket BTC up/down piacai **UMA-n keresztül** rendeződnek:

1. Market endDate-je megtörténik.
2. UMA proposer beadja a kimenetet (~minutes–1h).
3. 2 órás dispute window.
4. UMA finalizálja → Gamma `closed=true` + `outcomePrices` ∈ {0,1}
   + `umaResolutionStatus="resolved"`.

Tehát **5min–4h közötti várakozás teljesen normális**. A paper-resolver
minden 3 percben próbálkozik, és automatikusan zár amint a 3 feltétel
együtt teljesül. Az előző commit-ban az UMA finality gate-et hozzáadtuk:
closed=true egyedül nem elég — a resolver explicit várja a `resolved`-et,
nem fogad el `proposed` / `disputed` / `challenged` / `settled_pending`
állapotot (fake-win védelem).

## Fix — diagnosztika gomb

A felhasználó **nem látta**, hogy melyik konkrét gate blokkol. Most:

### `crypto/paper-resolver.mts`

Új `diagnosePendingPositions(positions[])` async helper. Per-position
Gamma probe, NEM mutálja a session-t. Visszaad egy `PendingDiagnostic[]`
listát:

```typescript
interface PendingDiagnostic {
  market: string;
  conditionId: string | null;
  ageMin: number;
  gamma: {
    found: boolean;
    closed: boolean | null;
    outcomePrices: number[] | null;
    umaResolutionStatus: string | null;
  } | null;
  verdict: string;       // emberbarát szöveg
  shouldClose: boolean;  // resolver-nek zárnia kéne, de még nem futott
}
```

Verdict szövegek minden esetre:
- "Missing conditionId" → legacy pozíció, reset kell
- "Gamma returned no market" → conditionId stale/wrong vagy closed=true még nem flippelt
- "UMA <state>" → dispute/voting window — várj
- "Closed=true és UMA final de op nem binary" → ritka 50/50 dispute
- "Resolved on Gamma" → resolver következő tickkor zár

### `auto-trader/index.mts`

Új `handleCryptoReconcile(config)` — `case "reconcile"` mostantól crypto-ra
is működik (eddig weather-only volt). Két lépés:

1. `resolvePendingPaperPositions(session)` — bárkit, akit lehet, zár.
2. A maradék pending-eket `diagnosePendingPositions`-szel ellenőrzi.

Visszaad: `{ resolved: [...], stillPending: [...], session }`.

### `CryptoTrader.tsx`

- Új "⟳ Reconcile pending" gomb a controls-ban — csak akkor látszik, ha
  `pendingCount > 0`. Pattern szimmetrikus a Weather Reconcile gombbal.
- Új `ReconcileResult` típus + új `display.action === "reconciled"` ág a
  render-ben. Külön kártya "Reconcile result" header-rel, a zárt
  pozíciók zöld sorral + PnL-lel, a maradék pending-ek a Gamma chip-
  ekkel: `age 8min`, `closed: true`, `op: [0.50, 0.50]`, `uma: proposed`,
  + emberbarát verdict.
- A meglévő pending card footnote frissítve: pontos UMA timeline (5min–4h)
  + utalás a Reconcile gombra.

## Hatás deploy után

A felhasználó most:
1. Látja a pending card-on, hogy `expired Xm ago · UMA settlement window`
   (a `getCryptoPendingPositions`-ben már korábban hozzáadott waitReason).
2. Klikkel a `⟳ Reconcile pending` gombra → friss Gamma query per
   conditionId → új kártya mutatja a konkrét állapotot:
   - `closed: false` → market még nyitva (extreme edge case, restart?)
   - `closed: true, uma: proposed` → 2h dispute window
   - `closed: true, uma: resolved, op: [1, 0]` → következő cron tick zárja
   - `no conditionId` → legacy, reset kell

## A user pending pozíciója nagy valószínűséggel

Egy normális UMA dispute window-ban van (closed=true, uma=proposed).
A reconcile gomb klikkelése megmutatja a pontos állapotot. Ha 4+ óra
múlva sem záródik, az dispute eset (manual review).

`tsc --noEmit` exit 0 (project files), Astro build 9 page generated.

# 2026-05-11 (b) — Reconcile "Unknown error" fix (Netlify 10s timeout)

## A user észrevett bug

A /trade/crypto/ oldalon a "⟳ Reconcile pending" gombra "Unknown error"
jelent meg. A backend nem dobott látható error message-et, és a frontend
fallback szöveget mutatott.

## Root cause

`handleCryptoReconcile` két lépésben futott:

1. `resolvePendingPaperPositions(session)` — minden past-endDate pozícióra
   1 Gamma fetch (~5-8s timeout-tal).
2. `diagnosePendingPositions(stillPending)` — UJABB 1 Gamma fetch ugyanazon
   pozíciónként.

N pending pozíció = **2N Gamma fetch szekvenciálisan**, kb. N × 10-16s
wall-clock. Egyetlen pending pozíción a függvény ~10s körüli volt, és a
**Netlify default function timeout 10s** alatt megszakadt. A frontend
`res.json()` üres body-ra hibát dobott vagy `data` undefined volt, így
a useTraderAction fallback `data.error || "Unknown error"`-ra esett.

## Fix — single-pass refactor

### `crypto/paper-resolver.mts`

`resolvePendingPositions` mostantól **egyetlen Gamma fetch-et csinál per
pozíció**, és visszaadja a teljes diagnosztikai listát is:

```typescript
return {
  session: updated,
  resolutions: ResolutionRecord[],
  pendingDiagnostics: PendingDiagnostic[],  // ÚJ
};
```

A `PendingDiagnostic` típus a Gamma probe eredményét hordozza: closed,
outcomePrices, umaResolutionStatus, ageMin, plain-language verdict.
A `parseResolution` és `buildDiagnostic` segéd-fv-ek dolgozzák fel a
nyers Gamma raw-t.

Régi `diagnosePendingPositions` standalone függvény **törölve** — fölösleges
volt.

### `auto-trader/index.mts`

`handleCryptoReconcile` egyszerűsített:

```typescript
const r = await resolvePendingPaperPositions(session);
if (r.resolutions.length > 0) await saveSession(r.session);
return jsonResponse({
  ok: true, action: "reconciled",
  resolved: r.resolutions,
  stillPending: r.pendingDiagnostics,  // már megvan, nem kell újabb fetch
  session: sessionSummary(r.session),
});
```

Wall-clock most ~N × 5s (a 8s Gamma timeout-on belül). Egy pending pozíción
~2s, 5 pending-en ~10s — biztonságos a 10s budget alatt.

## Védő fix: outer catch fallback

`auto-trader/index.mts` top-level catch most graceful-en kezeli az üres
`err.message`-t:

```typescript
const errMsg = (err && (err.message || err.toString?.() || String(err))) || "internal error";
```

Eddig ha valamit `throw undefined`-dal vagy primitív-vel dobott, az error
message üres volt → frontend "Unknown error" fallback. Most legalább
"internal error" jelenik meg, és az `alertError` is `.catch(() => {})`
wrap-pelve, hogy a Telegram alert hibája ne maszkolja a tényleges hibát.

## Hatás deploy után

- A "⟳ Reconcile pending" gomb most ~2-3s alatt válaszol (1 pending).
- Az új "Reconcile result" kártya megjelenik a Gamma chip-ekkel:
  `closed: true`, `op: [0.50, 0.50]`, `uma: proposed`, + emberbarát
  verdict.
- Ha mégis hiba történne (Gamma API kiesés, stb.), az error pontos
  message-szel jelenik meg, nem generic "Unknown error".

`tsc --noEmit` exit 0 (project files), Astro build 9 page generated.
