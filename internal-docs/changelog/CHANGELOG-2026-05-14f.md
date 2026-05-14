# 2026-05-14f — HL Perp consecutive-loss pause UX + Settings

## Kontextus

A HL Perp bot 3 egymás utáni loss után 1 órára pause-olja a session-t
(anti-revenge guard, `applyConsecutiveLossPause`). A pause alatt a UI
egy warn alertet mutat: *"Paused until 16:48:17 (consecutive losses
cooldown)"*. Két UX hiányosság maradt:

1. **A pause-t csak a generic Resume gomb tudta törölni**, ami a kontroll-
   panelen volt — az alerten nem volt inline action. Az operátor "elveszett"
   az alert mellett: látja az infót, de nem volt rögtön kapcsolódó gomb.
2. **A pause idő (`consecutiveLossPauseHours = 1`) hard-coded env-only volt** —
   nem volt Settings-knob, nem volt preset-fűzés. A presetek átírták a
   `hlConsecutiveLossLimit`-et de a pause óraszámot nem.

## Mit változott

### 1. `TraderAlert` interface bővítése (`shared/TraderShell.tsx`)

Új opcionális mező:

```ts
export interface TraderAlert {
  tone: "danger" | "warn" | "info";
  text: string;
  action?: {
    label:    string;
    onClick:  () => void;
    disabled?: boolean;
    title?:   string;
  };
}
```

A render mostantól `display: flex; gap: 12px; align-items: center;
justify-content: center;`, szöveg `<span class="ts-alert-text">`-ben,
gomb (ha van) `<button class="ts-alert-action">`-ben. CSS-ben a gomb
örökli a tone color-t (`border: 1px solid currentColor`), átlátszó dark
bg-vel, hover-en sötétebb. Az info-tone-on speciális kontraszt:
surface2 bg + accent2 border → hover az accent2-re.

### 2. HL pause + stopped alerts inline action-nel (`HyperliquidTrader.tsx`)

Mindkét alert most kap egy beépített action gombot:

| Alert | Tone | Inline action |
|---|---|---|
| `pausedUntil` set | warn (orange) | `Cancel pause` → `doAction("resume")` |
| `stopped` flag set | danger (red) | `Resume` → `doAction("resume")` |

Mindkét gomb `disabled: isRunning` alatt (race-protection a folyamatban
lévő művelettel). A meglévő controls-bar `Resume` gomb megmarad — kettős
útvonal: az alerten azonnal kattintható, vagy a kontroll-panelen a teljes
gomb-csoportból.

### 3. Új Settings knob: `hlConsecutiveLossPauseHours` (`trader-settings.mts`)

```ts
hlConsecutiveLossPauseHours: {
  default: 1, min: 0.0833, max: 24, step: 0.25, unit: "h",
  category: "hyperliquid", group: "Risk & sizing",
  label: "Consecutive loss pause",
  help: "Hány órára szünetel a session miután a `Consecutive loss limit`
         triggerelt. Default 1h; 0.0833h ≈ 5 perc (csak kontrollált
         tesztre); 24h = teljes nap pause. A pop-up alertből inline
         `Cancel pause` gomb is törölheti.",
}
```

Preset-fűzés is bővült:

| Preset | hlConsecutiveLossPauseHours |
|---|---|
| Lazább | 0.5h (30 perc) |
| Normál | 1h |
| Szigorú | 2h |

### 4. Backend wiring (`hyperliquid/config.mts`)

A `getEffectiveHlConfig()` override blokk korábban kihagyta a
`consecutiveLossPauseHours`-t (csak az env defaultját használta).
Most a Settings Blobs `hlConsecutiveLossPauseHours` is befolyásolja:

```ts
consecutiveLossPauseHours: ov.hlConsecutiveLossPauseHours ?? env.consecutiveLossPauseHours,
```

Az `index.mts:applyConsecutiveLossPause(session, config.consecutiveLossPauseHours)`
mostantól a runtime override-t használja.

## Fájlok

| Fájl | Változás |
|---|---|
| `netlify/functions/trader-settings.mts` | új knob + 3 preset frissítés |
| `netlify/functions/auto-trader/hyperliquid/config.mts` | override-wiring |
| `src/components/shared/TraderShell.tsx` | TraderAlert.action interface + render |
| `src/components/shared/traderShellStyles.ts` | `.ts-alert-action` CSS |
| `src/components/trader/HyperliquidTrader.tsx` | pause + stopped alert action-ök |

## Acceptance criteria

- [x] Pause-alert mellett inline `Cancel pause` gomb látható
- [x] Click → `/auto-trader-api?category=hyperliquid&action=resume` POST
- [x] A backend (`hlResume`) törli a `pausedUntil`-t és a `stopped`-et is
- [x] Új Settings knob a Hyperliquid Risk & sizing csoportban
- [x] Mind a 3 preset (loose 0.5h / normál 1h / szigorú 2h) bővült
- [x] `getEffectiveHlConfig()` mostantól olvasja az override-ot
- [x] `npm run build` + `tsc --noEmit` tisztán átmegy
- [x] Preview verifikáció: 3 szintetikus alert (warn+action / danger+action / info-no-action) helyesen rendereli a flexbox layoutot + tone color öröklődik a gomb border-re

## Hatás

- Operátor 1 kattintással törli a pause-t a HL trader oldalán, az alerten.
- A pause óraszáma testreszabható: kontrollált 5 perces teszteknél (0.0833h),
  vagy hosszú "kapcsold ki ma estére" üzemmódhoz (24h).
- A többi 4 bot változatlan — a `TraderAlert.action` opcionális field csak
  ott aktív ahol használjuk (HL paused/stopped), így nincs viselkedés-
  változás Crypto/Weather/F-Arb/Sports oldalakon.
