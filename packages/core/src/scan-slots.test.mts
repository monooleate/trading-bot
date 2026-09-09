// packages/core/src/scan-slots.test.mts
//
// Pins the B57 coin-diversified scan-slot contract, including the regression it
// exists for: the live 2026-09-09 volume ranking where BTC owned the top five
// slots and ethereum's best market ranked #6.

import { selectScanSlots, type ScanCandidate } from "./scan-slots.mts";

let passed = 0, failed = 0;
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const mk = (slug: string, coin?: string): ScanCandidate => ({ slug, coin });
const slugs = (xs: ScanCandidate[]) => xs.map((x) => x.slug).join(",");

// ─── 1. The live ranking this exists for ──────────────────────────────────
console.log("\n1. The 2026-09-09 live ranking (BTC owns the top 5)");
{
  const live = [
    mk("btc-82k", "BTC"), mk("btc-74k", "BTC"), mk("btc-72k", "BTC"),
    mk("btc-84k", "BTC"), mk("btc-76k", "BTC"),
    mk("eth-2600", "ETH"), mk("btc-86k", "BTC"), mk("btc-80k", "BTC"),
    mk("eth-2700", "ETH"), mk("btc-78k", "BTC"),
    mk("sol-200", "SOL"),
  ];
  const legacy = live.slice(0, 5);
  check("legacy top-5 is all BTC (the bug)",
    legacy.every((m) => m.coin === "BTC"), slugs(legacy));

  const got = selectScanSlots(live, { windowSize: 5, minPerCoin: 1 });
  check("5 slots returned", got.length === 5, slugs(got));
  check("ETH gets in", got.some((m) => m.coin === "ETH"), slugs(got));
  check("SOL gets in", got.some((m) => m.coin === "SOL"), slugs(got));
  check("BTC keeps the majority (3 of 5)",
    got.filter((m) => m.coin === "BTC").length === 3, slugs(got));
  check("each coin's reserved pick is its HIGHEST-volume market",
    got.some((m) => m.slug === "eth-2600") && !got.some((m) => m.slug === "eth-2700"), slugs(got));
  check("BTC's three are the top three by volume",
    got.filter((m) => m.coin === "BTC").map((m) => m.slug).join(",") === "btc-82k,btc-74k,btc-72k", slugs(got));
  check("output stays in volume order",
    slugs(got) === "btc-82k,btc-74k,btc-72k,eth-2600,sol-200", slugs(got));
}

// ─── 2. Legacy equivalence ────────────────────────────────────────────────
console.log("\n2. Degrades to the legacy slice");
{
  const btcOnly = ["a", "b", "c", "d", "e", "f"].map((s) => mk(s, "BTC"));
  check("single coin → plain top-N",
    slugs(selectScanSlots(btcOnly, { windowSize: 3, minPerCoin: 1 })) === "a,b,c");
  check("minPerCoin 0 → plain top-N even with several coins",
    slugs(selectScanSlots(
      [mk("a", "BTC"), mk("b", "BTC"), mk("c", "ETH")], { windowSize: 2, minPerCoin: 0 })) === "a,b");
  check("fewer candidates than slots → everything",
    slugs(selectScanSlots([mk("a", "BTC"), mk("b", "ETH")], { windowSize: 5 })) === "a,b");
  check("untagged markets are one more coin, not dropped",
    selectScanSlots([mk("a"), mk("b"), mk("c", "ETH")], { windowSize: 2 }).some((m) => m.coin === "ETH"));
}

// ─── 3. Reserve arithmetic ────────────────────────────────────────────────
console.log("\n3. Reserve arithmetic");
{
  const many = [
    mk("b1", "BTC"), mk("b2", "BTC"), mk("b3", "BTC"), mk("b4", "BTC"),
    mk("e1", "ETH"), mk("e2", "ETH"), mk("s1", "SOL"), mk("s2", "SOL"),
  ];
  const two = selectScanSlots(many, { windowSize: 6, minPerCoin: 2 });
  check("minPerCoin 2 → each coin gets two", two.length === 6 &&
    ["BTC", "ETH", "SOL"].every((c) => two.filter((m) => m.coin === c).length === 2), slugs(two));

  // More coins than slots: round-robin must give each its FIRST pick before
  // any coin takes a second, otherwise BTC would eat the whole reserve.
  const tight = selectScanSlots(many, { windowSize: 3, minPerCoin: 2 });
  check("slots < coins×minPerCoin → one each, no coin hogs the reserve",
    tight.length === 3 && new Set(tight.map((m) => m.coin)).size === 3, slugs(tight));

  check("reserve never exceeds the window",
    selectScanSlots(many, { windowSize: 1, minPerCoin: 3 }).length === 1);
  check("a coin with a single market still gets its slot",
    selectScanSlots([mk("b1", "BTC"), mk("b2", "BTC"), mk("b3", "BTC"), mk("z", "SOL")],
      { windowSize: 2 }).some((m) => m.coin === "SOL"));
}

// ─── 4. Robustness ────────────────────────────────────────────────────────
console.log("\n4. Robustness");
{
  check("empty input", selectScanSlots([], { windowSize: 5 }).length === 0);
  check("windowSize 0", selectScanSlots([mk("a", "BTC")], { windowSize: 0 }).length === 0);
  check("negative window", selectScanSlots([mk("a", "BTC")], { windowSize: -3 }).length === 0);
  check("fractional window floors", selectScanSlots(
    [mk("a", "BTC"), mk("b", "BTC"), mk("c", "BTC")], { windowSize: 2.9, minPerCoin: 0 }).length === 2);
  check("null input is safe", selectScanSlots(null as any, { windowSize: 5 }).length === 0);
  check("malformed rows dropped", selectScanSlots(
    [{ slug: "a", coin: "BTC" }, null as any, { coin: "ETH" } as any], { windowSize: 5 }).length === 1);
  check("no duplicates when a coin repeats",
    new Set(selectScanSlots(
      [mk("a", "BTC"), mk("a", "BTC"), mk("b", "ETH")], { windowSize: 3 }).map((m) => m.slug)).size <= 2);
  check("case-insensitive coin grouping",
    selectScanSlots([mk("a", "btc"), mk("b", "BTC"), mk("c", "eth")], { windowSize: 2 })
      .some((m) => (m.coin ?? "").toLowerCase() === "eth"));
}

console.log(`\n=== scan-slots: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
