// netlify/functions/auto-trader/registry-bootstrap.mts
//
// Side-effect-only module that imports every bot's `index.mts` so each
// bot's `registerBot(...)` call fires. The dispatcher's lazy-import of
// this module ensures registration happens on first use without paying
// the import cost when only legacy bots are touched.
//
// To add a new bot: write `auto-trader/<bot>/index.mts` with a
// top-level `registerBot(...)` call, then add the import line below.

// Sports bot — registry-native from day one.
import "./sports/index.mts";

// Future bots:
// import "./politics/index.mts";
// import "./macro/index.mts";

// Existing bots (crypto / weather / hyperliquid / funding-arb) are NOT
// imported here yet — they still live in the legacy switch-case dispatcher.
// Migrating them is a separate session: add an adapter file (e.g.
// `crypto/bot-def.mts`) that wraps the existing exports + add the import
// here. Until then the dispatcher's `LEGACY_CATEGORIES` set short-circuits
// them away from the registry path.
