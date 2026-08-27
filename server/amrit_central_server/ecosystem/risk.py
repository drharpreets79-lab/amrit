"""Transparent joint AMR risk score; evidence board can version weights."""

DEFAULT_WEIGHTS = {"likelihood": 0.25, "impact": 0.30, "exposure": 0.20, "spread": 0.15, "control_gap": 0.10}


def calculate_risk(components, weights=None):
    weights = weights or DEFAULT_WEIGHTS
    missing = [key for key in weights if components.get(key) is None]
    if missing: return {"score": None, "rating": "insufficient-evidence", "missing": missing, "weights": weights}
    values = {key: max(0.0, min(5.0, float(components[key]))) for key in weights}
    score = sum(values[key] * weight for key, weight in weights.items()) / sum(weights.values())
    rating = "low" if score < 1.5 else "moderate" if score < 2.5 else "high" if score < 3.5 else "critical"
    return {"score": round(score, 3), "rating": rating, "components": values, "weights": weights,
            "uncertainty": components.get("uncertainty", "not-rated")}
