// packages/core/src/trial-cluster.mts
//
// Effective trial count for the Deflated Sharpe — model-discovery-training §3.A
// / #3 (sprints.md B50). Pure, portable (zero I/O).
//
// WHY: the DSR deflates a Sharpe by E[max SR over N trials]; that benchmark grows
// with N, so the honest N matters. The system logs EVERY knob change as a trial
// (trader-trials), but many are near-duplicates — the changelog shows the SAME
// knob nudged again and again (weather-invert, useRealizedIC, a confidence-min
// 0.02→0.05 tweak). Counting each as an INDEPENDENT trial over-deflates: twenty
// tweaks of one knob are not twenty independent chances to overfit, they are ~one.
//
// López de Prado's fix is ONC — cluster the trials by the correlation of their
// RETURN series and use the cluster count as the effective N. We do not yet log a
// per-trial return series (that needs per-trade config labelling, #4), so we use
// the honest proxy available from the trial log itself: cluster trials by the
// OVERLAP of the knob-sets they changed (Jaccard ≥ threshold, connected
// components). Trials touching the same knobs collapse into one cluster; trials
// touching disjoint knobs stay separate. N_eff = number of clusters ≤ literal N,
// so the DSR deflation is corrected DOWN to what the config search actually
// explored — never fabricating independence that is not there.
//
// N_eff < N ⇒ LESS deflation ⇒ a more accurate (not artificially harsh) benchmark.
// The threshold (default 0.5) bounds single-linkage chaining: {A} merges with
// {A,B} (J=0.5) but {A,B} and {B,C} (J=1/3) do not.

/** Jaccard similarity |A∩B| / |A∪B|. Two empty sets → 1 (identical). Pure. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const uni = a.size + b.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

/**
 * Effective number of trials: connected components of the graph whose nodes are
 * trials and whose edges join trials with Jaccard(changed-keys) ≥ threshold.
 * Trials with no changed keys are ignored. Returns 0 for no usable trials. Pure.
 */
export function effectiveTrialCount(
  trials: Array<{ keys?: string[] }>, threshold = 0.5,
): number {
  const sets = (trials ?? [])
    .map((t) => new Set((t?.keys ?? []).filter((k) => typeof k === "string" && k.length > 0)))
    .filter((s) => s.size > 0);
  const n = sets.length;
  if (n === 0) return 0;

  // Union-find connected components.
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) { const nx = parent[x]; parent[x] = r; x = nx; }
    return r;
  };
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      if (jaccard(sets[i], sets[j]) >= threshold) union(i, j);

  const roots = new Set<number>();
  for (let i = 0; i < n; i++) roots.add(find(i));
  return roots.size;
}
