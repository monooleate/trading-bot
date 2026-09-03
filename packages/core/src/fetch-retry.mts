// packages/core/src/fetch-retry.mts
//
// Shared fetch wrapper with bounded exponential backoff on transient failures.
// → sprints.md B48. Retries HTTP 429 (rate-limit) and, optionally, 5xx / network
// errors, honouring a `Retry-After` header when present. Each attempt gets a
// FRESH AbortSignal.timeout so a retry is never pre-aborted by the previous
// attempt's clock.
//
// SAFETY — idempotency:
//   429 means the request was rejected BEFORE it was processed, so retrying is
//   always safe, even for order placement. A 5xx or a network error is AMBIGUOUS
//   for a non-idempotent write (the order may already have landed), so callers
//   that PLACE ORDERS must pass { retryOn5xx: false, retryOnNetworkError: false }
//   and rely on the 429-only path. Read (GET) calls default to full retry.

export interface FetchRetryOpts {
  retries?: number;               // extra attempts after the first (default 2 → up to 3 tries)
  baseDelayMs?: number;           // backoff base ms (default 300)
  maxDelayMs?: number;            // backoff cap ms (default 4000)
  timeoutMs?: number;             // per-attempt AbortSignal.timeout (default 8000)
  retryOn5xx?: boolean;           // retry on HTTP 5xx (default true)
  retryOnNetworkError?: boolean;  // retry when fetch() itself throws (default true)
  // ── Test injection only — never set from production callers ──
  _fetch?: typeof fetch;
  _sleep?: (ms: number) => Promise<void>;
  _now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Exponential backoff with full jitter, capped.
function backoffDelay(attempt: number, base: number, cap: number, rnd: number): number {
  const exp = Math.min(cap, base * 2 ** attempt);
  return Math.floor(rnd * exp);
}

// Parse a Retry-After header (delta-seconds or HTTP-date) into ms, or null.
function retryAfterMs(res: Response, now: () => number): number | null {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(h);
  if (Number.isFinite(date)) return Math.max(0, date - now());
  return null;
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  opts: FetchRetryOpts = {},
): Promise<Response> {
  const {
    retries = 2,
    baseDelayMs = 300,
    maxDelayMs = 4000,
    timeoutMs = 8000,
    retryOn5xx = true,
    retryOnNetworkError = true,
    _fetch = fetch,
    _sleep = defaultSleep,
    _now = Date.now,
  } = opts;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const hasMore = attempt < retries;
    try {
      const res = await _fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const transient = res.status === 429 || (res.status >= 500 && retryOn5xx);
      if (transient && hasMore) {
        const ra = res.status === 429 ? retryAfterMs(res, _now) : null;
        const delay = ra ?? backoffDelay(attempt, baseDelayMs, maxDelayMs, Math.random());
        await _sleep(delay);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (retryOnNetworkError && hasMore) {
        await _sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs, Math.random()));
        continue;
      }
      throw err;
    }
  }
  // Unreachable — the loop always returns or throws — but keeps the type honest.
  throw lastErr ?? new Error("fetchWithRetry: retries exhausted");
}
