# 2026-05-13 — Mobile UI optimalizálás + tap-to-tooltip rendszer

## Kontextus

A user észlelte, hogy a dashboard mobilon nem használható kényelmesen —
a 100+ `title="..."` HTML hover-szöveg érintőeszközön egyáltalán nem
jelenik meg (a böngésző natív `title` nem trigger-elődik tap-re), a
táblák túlnyúlnak a viewporton, és bizonyos panel-fejlécek átfedik
egymást keskeny képernyőn.

## Mit változtattam

### (a) Tap-to-tooltip rendszer — `src/layouts/Base.astro`

Inline JS modul a `<body>` végén:
- `matchMedia("(pointer: coarse)")` detekció — csak touch-eszközön aktiválódik
- Indulásnál átirányítja az összes `[title]` → `[data-tip]` attribútumra
  (így a böngésző se próbálja meg long-press-en megjeleníteni a default UI-t)
- `MutationObserver` figyeli a React renderelt új DOM-csomópontokat és az
  attribútum-változásokat — friss `title=` is be lesz kapcsolva
- Floating popup DIV (`.tap-tip`) ami a tapped elem közelében jelenik meg,
  viewport-clamp-pel (nem lóg ki bal/jobb szélen, ha lecsúszna lent → fent
  jelenik meg), 4.5s után auto-dismiss-el, vagy scroll/resize/külső tap is bezárja

### (b) Globális mobile CSS — `src/styles/global.css`

- `viewport-fit=cover` + `safe-area-inset-left/right` padding (notch / fülek)
- `-webkit-text-size-adjust: 100%` (iOS landscape ne nagyítson)
- `overflow-x: hidden` body-n — tábla-overflow ne ragadja meg az egész
  oldalt vízszintesen
- `body` `-webkit-tap-highlight-color: transparent` — nincs kék flash
- `@media (max-width: 768px)`:
  - `input, select, textarea { font-size: 16px !important }` — iOS auto-zoom
    megelőzése a fókuszáláskor
  - `button, .ec-btn, .ts-btn, .aw-btn { min-height: 36px }` — tap-target
- `.tap-tip` popup styling (mono font, accent border, glow shadow)
- Új generikus `.tbl-scroll` wrapper class — `overflow-x: auto` +
  `-webkit-overflow-scrolling: touch` + finom gradient árnyék a jobb szélen,
  hogy a user lássa van mit görgetni

### (c) `<Base.astro>` meta-tag-ek

- `viewport-fit=cover` viewport meta-n (notch-ot tisztelő layout)
- Új `theme-color` meta (`#0a0a0c` — fekete app-chrome iOS PWA-ban)

### (d) Tábla-wrapper-ek

Mind a táblákat csomagoltam `<div className="tbl-scroll">` szülőbe, amik
mobilon vízszintes görgetést kapnak (Bootstrap `.table-responsive` mintára):

- `ApexWalletsPanel.tsx` — Top Wallets leaderboard
- `ArbMatrixPanel.tsx` — VWAP arb eredmények + pair-cost arb candidate-ek
- `SignalCombinerPanel.tsx` — market picker + Top 10 scanner
- `OrderFlowPanel.tsx` — market picker
- `VolDivergencePanel.tsx` — vol divergence eredmények
- `TradingPanel.tsx` — balances, positions, redeemable, polymarket markets

Dashboard.tsx scanner table-jénél már volt inline `overflow-x: auto` —
nem nyúltam hozzá.

### (e) Dashboard shell mobile breakpoints — `src/components/shared/dashboardStyles.ts`

Új `@media (max-width: 768px)` és `(max-width: 480px)` szekciók:
- `.ec-header` csökkentett padding + flex-wrap (logó + bankroll szét tud
  törni két sorra ha szükséges)
- `.ec-tabs` kisebb padding + kisebb font (több tab fér egy sorba a
  horizontális scroll előtt)
- `.ec-card` csökkentett padding (több content látszik)
- `.ec-big` (statisztika érték) kisebb font
- `.ec-sbar-row` (Swarm bars) flex-wrap, lbl flex-row

## Mit NEM csináltam

- A `title=` hivatkozások számát (100) nem csökkentettem — a tap-tooltip
  ezt láthatatlanul rendezi le. Ha később bevezetünk dedikált React
  `<Tooltip>` komponenst, automatikus migráció lehet a `data-tip` →
  `<Tooltip>` jsx-re (de jelenleg a JS-megoldás 0 refactor).
- A komplex panel-tartalmakat (pl. CondProbPanel matrix, EdgeTracker
  chartok) nem alakítottam újra mobilra — a `.tbl-scroll` és a meglévő
  breakpoint-ek elegendőek, és a panel-specifikus UX-revíziót külön
  feladatként kezeljük (nem volt benne a user kérésében).

## Build verifikáció

`npx astro build` ✅ — minden oldal generálódik, dist/index.html tartalmazza
a tap-tooltip script-et és a viewport-fit meta-t. Type-error nincs.

## Fájlok érintve

- `src/layouts/Base.astro` (új inline script + viewport-fit + theme-color)
- `src/styles/global.css` (mobile base + tap-tip popup + .tbl-scroll)
- `src/components/shared/dashboardStyles.ts` (új @media szabályok)
- `src/components/ApexWalletsPanel.tsx` (table wrapper)
- `src/components/ArbMatrixPanel.tsx` (2× table wrapper)
- `src/components/SignalCombinerPanel.tsx` (2× table wrapper)
- `src/components/OrderFlowPanel.tsx` (table wrapper)
- `src/components/VolDivergencePanel.tsx` (table wrapper)
- `src/components/TradingPanel.tsx` (4× table wrapper)
