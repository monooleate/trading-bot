# EdgeCalc — Polymarket & Funding Arb Toolkit

Astro 4 + React 18 + Tailwind CSS • Netlify static deploy

## Helyi futtatás

```bash
npm install
npm run dev
# → http://localhost:4321
```

## Netlify deploy (első alkalom)

### A) GitHub-on keresztül (ajánlott)

1. Töltsd fel a mappát egy GitHub repo-ba
2. Netlify.com → Add new site → Import from Git
3. Build command: `npm run build`
4. Publish directory: `dist`
5. Deploy site → kész, automatikus CI/CD

### B) Netlify CLI-vel (gyorsabb)

```bash
npm install -g netlify-cli
npm run build
netlify deploy --prod --dir=dist
```

## Python scanner integráció

```bash
pip install requests
python polymarket_scanner.py
# → polymarket_data.json
# Ezt töltsd be a Scanner tabba drag-and-drop-pal
```

## Struktúra

```
edge-calc/
├── src/
│   ├── components/
│   │   └── Dashboard.tsx     ← teljes React island (4 tab)
│   ├── layouts/
│   │   └── Base.astro
│   ├── pages/
│   │   └── index.astro
│   └── styles/
│       └── global.css
├── public/
│   └── favicon.svg
├── astro.config.mjs
├── netlify.toml
├── package.json
└── tailwind.config.mjs
```

## Tab leírás

| Tab | Funkció |
|-----|---------|
| 01 Scanner | Polymarket piacok listája, JSON import, EV kalkulator |
| 02 EV Kalk. | Standalone Expected Value + Kelly pozícióméretező |
| 03 Funding Arb | Delta-neutral funding rate arbitrázs kalkulátor |
| 04 Swarm | Multi-agent szimuláció + Monte Carlo validáció |

## Figyelmeztetés

Ez egy oktatási célú eszköz. Nem befektetési tanács.
