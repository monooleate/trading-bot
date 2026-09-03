// packages/core/src/fetch-retry.test.mts
//
// Regression guard for the shared fetchWithRetry backoff helper (sprints.md B48).
// Uses injected _fetch / _sleep — no real network, no real timers.
//
// Run: npx tsx packages/core/src/fetch-retry.test.mts

import { fetchWithRetry } from "./fetch-retry.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}

// A fake fetch that replays a queue of {status} responses or throws "NET".
function fakeFetch(queue: Array<number | "NET">) {
  let i = 0;
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    const item = queue[Math.min(i, queue.length - 1)];
    i++;
    if (item === "NET") throw new Error("network down");
    return new Response("{}", { status: item });
  };
  return { fn: fn as unknown as typeof fetch, calls, get count() { return i; } };
}

function recordingSleep() {
  const delays: number[] = [];
  return { sleep: async (ms: number) => { delays.push(ms); }, delays };
}

// ── 1. success on first try → single call ───────────────────────────────────
{
  const t = "success-first";
  const ff = fakeFetch([200]);
  const sl = recordingSleep();
  const res = await fetchWithRetry("u", {}, { _fetch: ff.fn, _sleep: sl.sleep });
  expect(res.status === 200, t, `status 200, got ${res.status}`);
  expect(ff.count === 1, t, `1 call, got ${ff.count}`);
  expect(sl.delays.length === 0, t, `no sleeps, got ${sl.delays.length}`);
}

// ── 2. 429 then 200 → retried once ──────────────────────────────────────────
{
  const t = "429-then-200";
  const ff = fakeFetch([429, 200]);
  const sl = recordingSleep();
  const res = await fetchWithRetry("u", {}, { _fetch: ff.fn, _sleep: sl.sleep });
  expect(res.status === 200, t, `final 200, got ${res.status}`);
  expect(ff.count === 2, t, `2 calls, got ${ff.count}`);
  expect(sl.delays.length === 1, t, `1 sleep, got ${sl.delays.length}`);
}

// ── 3. 500,500,200 with retries=2 → 3 calls ─────────────────────────────────
{
  const t = "5xx-recover";
  const ff = fakeFetch([500, 500, 200]);
  const sl = recordingSleep();
  const res = await fetchWithRetry("u", {}, { _fetch: ff.fn, _sleep: sl.sleep, retries: 2 });
  expect(res.status === 200, t, `final 200, got ${res.status}`);
  expect(ff.count === 3, t, `3 calls, got ${ff.count}`);
}

// ── 4. retryOn5xx=false → 500 returned immediately (order-safe path) ─────────
{
  const t = "5xx-no-retry";
  const ff = fakeFetch([500, 200]);
  const sl = recordingSleep();
  const res = await fetchWithRetry("u", {}, { _fetch: ff.fn, _sleep: sl.sleep, retryOn5xx: false });
  expect(res.status === 500, t, `returns 500 (no retry), got ${res.status}`);
  expect(ff.count === 1, t, `1 call (no double-send), got ${ff.count}`);
}

// ── 5. 429 exhausted → returns final 429, does not throw ─────────────────────
{
  const t = "429-exhausted";
  const ff = fakeFetch([429, 429, 429]);
  const sl = recordingSleep();
  const res = await fetchWithRetry("u", {}, { _fetch: ff.fn, _sleep: sl.sleep, retries: 2 });
  expect(res.status === 429, t, `final 429, got ${res.status}`);
  expect(ff.count === 3, t, `3 calls, got ${ff.count}`);
  expect(sl.delays.length === 2, t, `2 sleeps, got ${sl.delays.length}`);
}

// ── 6. network error then 200 → retried ─────────────────────────────────────
{
  const t = "net-then-200";
  const ff = fakeFetch(["NET", 200]);
  const sl = recordingSleep();
  const res = await fetchWithRetry("u", {}, { _fetch: ff.fn, _sleep: sl.sleep });
  expect(res.status === 200, t, `final 200, got ${res.status}`);
  expect(ff.count === 2, t, `2 calls, got ${ff.count}`);
}

// ── 7. network error, retryOnNetworkError=false → throws, single call ────────
{
  const t = "net-no-retry";
  const ff = fakeFetch(["NET", 200]);
  const sl = recordingSleep();
  let threw = false;
  try {
    await fetchWithRetry("u", {}, { _fetch: ff.fn, _sleep: sl.sleep, retryOnNetworkError: false });
  } catch { threw = true; }
  expect(threw, t, "should throw");
  expect(ff.count === 1, t, `1 call (no retry), got ${ff.count}`);
}

// ── 8. order-safe combo: 5xx no retry, but 429 still retries ─────────────────
{
  const t = "order-safe-429";
  const ff = fakeFetch([429, 200]);
  const sl = recordingSleep();
  const res = await fetchWithRetry("u", {}, {
    _fetch: ff.fn, _sleep: sl.sleep, retryOn5xx: false, retryOnNetworkError: false,
  });
  expect(res.status === 200, t, `429→200 still retried, got ${res.status}`);
  expect(ff.count === 2, t, `2 calls, got ${ff.count}`);
}

// ── 9. Retry-After header (numeric seconds) honoured ────────────────────────
{
  const t = "retry-after";
  let i = 0;
  const calls: number[] = [];
  const fn = (async (_url: string) => {
    calls.push(1);
    const s = i === 0 ? 429 : 200;
    i++;
    return new Response("{}", { status: s, headers: s === 429 ? { "retry-after": "2" } : {} });
  }) as unknown as typeof fetch;
  const sl = recordingSleep();
  const res = await fetchWithRetry("u", {}, { _fetch: fn, _sleep: sl.sleep });
  expect(res.status === 200, t, `final 200, got ${res.status}`);
  expect(sl.delays.length === 1 && sl.delays[0] === 2000, t, `honoured 2000ms Retry-After, got ${sl.delays}`);
}

// ─── CLI report ───────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("fetch-retry.test.mts") || entry.endsWith("fetch-retry.test.js");
  } catch { return false; }
})();

if (isMain) {
  if (failures.length === 0) {
    console.log("fetch-retry.test: all checks passed");
    process.exit(0);
  } else {
    console.log(`fetch-retry.test: ${failures.length} failure(s)`);
    for (const f of failures) console.log(`  ✗ [${f.test}] ${f.message}`);
    process.exit(1);
  }
}

export { failures };
