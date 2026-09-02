"""Proper scores. Brier + log are pure-python (mirror the TS harness in
@core/statistics.mts); CRPS uses `properscoring` when available."""
from __future__ import annotations

import math

_EPS = 1e-15


def proper_scores(probs: list[float], outcomes: list[int]) -> dict:
    n = min(len(probs), len(outcomes))
    if n == 0:
        return {"n": 0, "brier": None, "log_score": None}
    brier = 0.0
    logs = 0.0
    for i in range(n):
        p = min(1 - _EPS, max(_EPS, float(probs[i])))
        y = 1 if outcomes[i] else 0
        brier += (p - y) ** 2
        logs += -(y * math.log(p) + (1 - y) * math.log(1 - p))
    return {"n": n, "brier": brier / n, "log_score": logs / n}
