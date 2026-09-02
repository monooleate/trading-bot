"""Post-hoc calibration. Isotonic/Platt via scikit-learn when available; else
returns the raw probs (identity) so /calibrate never hard-fails. The TS
walk-forward Platt eval in @core/calibration.mts stays the live measurement
path; this service is the heavier isotonic/Venn-Abers option (≥1000 outcomes)."""
from __future__ import annotations


def fit_calibrator(probs: list[float], outcomes: list[int], method: str = "isotonic") -> list[float]:
    n = min(len(probs), len(outcomes))
    if n < 10:
        return list(probs)
    try:
        if method == "isotonic":
            from sklearn.isotonic import IsotonicRegression  # type: ignore
            ir = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
            ir.fit(probs[:n], outcomes[:n])
            return [float(x) for x in ir.predict(probs[:n])]
        if method == "platt":
            import numpy as np
            from sklearn.linear_model import LogisticRegression  # type: ignore
            X = np.asarray(probs[:n], dtype=float).reshape(-1, 1)
            y = np.asarray(outcomes[:n], dtype=int)
            lr = LogisticRegression().fit(X, y)
            return [float(p) for p in lr.predict_proba(X)[:, 1]]
    except Exception:
        pass
    return list(probs)
