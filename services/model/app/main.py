"""services/model/app/main.py — B-lépcső ML model service (FastAPI).

Skeleton for the Hetzner B-step. The Bun workers call this over the internal
Docker network (http://model:8000) ONLY behind the existing default-off knobs
(#2 calibration-live, #5 σ-source). Heavy weights (Chronos-Bolt) are
LOAD-ON-DEMAND: idle keeps ~0.3 GB, inference peaks ~2 GB, then the weight is
released after MODEL_IDLE_TTL_SEC (hetzner-docker-setup §18.3).

Endpoints:
  GET  /health     — liveness; reports tier + whether weights are resident
  POST /vol        — realized-vol / RealizedGARCH cross-check (arch)
  POST /forecast   — Chronos-Bolt distribution (load-on-demand)
  POST /calibrate  — isotonic / Venn-Abers post-hoc calibration
  POST /score      — Brier / log / CRPS proper scores
"""
from __future__ import annotations

import os
import time
from typing import Optional

from fastapi import FastAPI
from pydantic import BaseModel

MODEL_TIER = os.environ.get("MODEL_TIER", "chronos-bolt-small")
LOAD_ON_DEMAND = os.environ.get("LOAD_ON_DEMAND", "1") == "1"
IDLE_TTL_SEC = int(os.environ.get("MODEL_IDLE_TTL_SEC", "600"))

app = FastAPI(title="edgecalc-model", version="0.1.0")

# Lazily-loaded forecaster handle + last-use timestamp (for TTL release).
_forecaster = None
_last_used = 0.0


def _maybe_release() -> None:
    """Drop the resident weight if it has been idle past the TTL."""
    global _forecaster, _last_used
    if _forecaster is not None and LOAD_ON_DEMAND and (time.time() - _last_used) > IDLE_TTL_SEC:
        _forecaster = None


@app.get("/health")
def health() -> dict:
    _maybe_release()
    return {
        "ok": True,
        "tier": MODEL_TIER,
        "loaded": _forecaster is not None,
        "load_on_demand": LOAD_ON_DEMAND,
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


class VolRequest(BaseModel):
    returns: list[float]              # log returns
    horizon: int = 1


@app.post("/vol")
def vol(req: VolRequest) -> dict:
    """Realized volatility now; RealizedGARCH (arch) wired in Phase 7."""
    from .volatility import realized_vol, garch_forecast
    rv = realized_vol(req.returns)
    garch = garch_forecast(req.returns, req.horizon)
    return {"ok": True, "realized_vol": rv, "garch_vol": garch, "horizon": req.horizon}


class ForecastRequest(BaseModel):
    series: list[float]
    horizon: int = 12
    quantiles: list[float] = [0.1, 0.5, 0.9]


@app.post("/forecast")
def forecast(req: ForecastRequest) -> dict:
    """Chronos-Bolt distribution forecast (load-on-demand). Phase 7."""
    global _forecaster, _last_used
    from .forecasters import get_forecaster
    _forecaster = get_forecaster(_forecaster, MODEL_TIER)
    _last_used = time.time()
    out = _forecaster.predict(req.series, req.horizon, req.quantiles)
    return {"ok": True, "tier": MODEL_TIER, **out}


class CalibrateRequest(BaseModel):
    probs: list[float]               # raw model P(YES)
    outcomes: list[int]              # realised 0/1 (train)
    method: str = "isotonic"         # isotonic | venn_abers | platt


@app.post("/calibrate")
def calibrate(req: CalibrateRequest) -> dict:
    from .calibration import fit_calibrator
    mapped = fit_calibrator(req.probs, req.outcomes, req.method)
    return {"ok": True, "method": req.method, "calibrated": mapped}


class ScoreRequest(BaseModel):
    probs: list[float]
    outcomes: list[int]


@app.post("/score")
def score(req: ScoreRequest) -> dict:
    from .scoring import proper_scores
    return {"ok": True, **proper_scores(req.probs, req.outcomes)}
