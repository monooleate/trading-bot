"""Distribution forecasters. Chronos-Bolt is load-on-demand (Phase 7); until
the weight is wired / installed, a naive persistence+empirical-quantile
forecaster answers so /forecast is testable. get_forecaster reuses a resident
handle; main.py releases it after the idle TTL."""
from __future__ import annotations

import math


class _NaiveForecaster:
    """Persistence mean + empirical residual quantiles. Deterministic, dep-free."""
    tier = "naive-persistence"

    def predict(self, series: list[float], horizon: int, quantiles: list[float]) -> dict:
        if not series:
            return {"forecaster": self.tier, "median": [], "quantiles": {}}
        last = series[-1]
        # residual spread from the series' own first differences
        diffs = [series[i] - series[i - 1] for i in range(1, len(series))]
        n = len(diffs)
        if n:
            mean = sum(diffs) / n
            sd = math.sqrt(sum((d - mean) ** 2 for d in diffs) / n) if n > 1 else 0.0
        else:
            sd = 0.0
        median = [last] * horizon
        # normal-ish quantile bands widening with sqrt(h)
        def z(q: float) -> float:
            # rough inverse-normal (Acklam-lite) good enough for a placeholder
            return math.sqrt(2) * _erfinv(2 * q - 1)
        bands = {
            str(q): [last + z(q) * sd * math.sqrt(h + 1) for h in range(horizon)]
            for q in quantiles
        }
        return {"forecaster": self.tier, "median": median, "quantiles": bands}


def _erfinv(x: float) -> float:
    # Winitzki approximation
    a = 0.147
    ln = math.log(1 - x * x) if abs(x) < 1 else -30.0
    t = 2 / (math.pi * a) + ln / 2
    return math.copysign(math.sqrt(math.sqrt(t * t - ln / a) - t), x)


def get_forecaster(current, tier: str):
    """Return a resident forecaster, loading Chronos-Bolt on demand when
    available; otherwise the naive fallback."""
    if current is not None:
        return current
    if tier.startswith("chronos"):
        try:
            from chronos import ChronosPipeline  # type: ignore  # noqa: F401
            # Phase 7: load ChronosPipeline.from_pretrained(...) here and wrap
            # .predict() to emit the same {median, quantiles} shape.
            return _NaiveForecaster()  # placeholder until the weight is wired
        except Exception:
            return _NaiveForecaster()
    return _NaiveForecaster()
