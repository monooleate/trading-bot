---
paths:
  - "apps/web/**"
---

# Frontend (`apps/web`, Astro + React)

- Inline Tailwind utility class TILOS — a projekt CSS-változókat használ (`apps/web/src/styles/global.css`: `--bg`, `--surface`, `--surface2`, `--border`, `--text`, `--muted`, `--accent` = YES/zöld, `--danger` = NO/piros, `--accent2` = info, `--warn`, `--mono`, `--sans`). Hex-értéket ne másolj, a változót használd.
- Minden komponens a saját `<style>` blokkjában definiálja az osztályait, egyedi 2–3 betűs prefixszel (`aw-`, `cp-`, `sc-`, `et-`, a közös trader shellnél `ts-`); nincs új globális CSS.
- Mobil: táblázat `.tbl-scroll` wrapperben; grid-gyerekre `min-width: 0` blowout-guard (egy min-content-széles kártya a szomszédot is szétfeszíti); input `font-size ≥ 16px` (iOS auto-zoom). Ellenőrizd 320 és 375 px-en: 0 vízszintes túlcsordulás, desktop változatlan.
- Új `/tools/` tab: `src/components/<Név>Panel.tsx` + prefix + `DEMO` konstans `is_demo: true`-val + `Dashboard.tsx` import/tab-array/render + route a `services/api/src/routes/` alatt (és a `server.ts`-ben) + `internal-docs/math/NN-name.md` + CLAUDE.md tab-tábla.
- Új bot UI: `src/components/trader/<Bot>Trader.tsx` a `TraderShell` + `useAutoTraderStatus(category)` + `useTraderAction(category)` köré; `HomePage.tsx` `CARDS` bővítése.
- ¼-Kelly a frontenden: `src/lib/math.ts` `kellyBinary` (+ 8% binary hard cap kívül) — ne implementáld újra.
- A frontend a `/.netlify/functions/<név>` útvonalakat hívja; az `edgecalc-api` ezt és az `/api/<név>`-t is kiszolgálja — ne írd át tömegesen.
- Lokális dev: `npm run dev` (4321, csak frontend); a backend a Bun API-n fut (nincs `netlify dev`).
