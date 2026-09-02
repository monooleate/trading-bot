"""Volatility estimators. Realized vol is pure-python (always available);
RealizedGARCH uses `arch` when installed, else falls back to realized vol so
/vol always answers (hetzner-docker-setup §7)."""
from __future__ import annotations

import math


def realized_vol(returns: list[float]) -> float:
    """Sample stdev of log returns (per-period). Returns 0 for <2 points."""
    n = len(returns)
    if n < 2:
        return 0.0
    mean = sum(returns) / n
    var = sum((r - mean) ** 2 for r in returns) / (n - 1)
    return math.sqrt(var)


def garch_forecast(returns: list[float], horizon: int = 1) -> float:
    """GARCH(1,1) conditional vol forecast via `arch`; falls back to realized
    vol scaled by sqrt(horizon) when arch is unavailable or the fit fails."""
    fallback = realized_vol(returns) * math.sqrt(max(1, horizon))
    if len(returns) < 50:
        return fallback
    try:
        import numpy as np
        from arch import arch_model  # type: ignore

        scaled = np.asarray(returns, dtype=float) * 100.0  # arch prefers %-returns
        res = arch_model(scaled, vol="Garch", p=1, q=1, mean="Zero").fit(disp="off")
        fc = res.forecast(horizon=horizon, reindex=False)
        var = float(fc.variance.values[-1, -1])
        return math.sqrt(var) / 100.0
    except Exception:
        return fallback
