"""The non-scan detectors Phase 30 adds, mirrored from the desktop.

``app/src/main/detection/process-control.ts``, ``farrington.ts`` and ``bayesian-scan.ts`` are
the twins of this module. As with the scan models, what has to agree is the arithmetic: the
EWMA recursion and its time-varying limits, the CUSUM reference value, the Bernoulli scoring
weights, Farrington's reference-window construction and reweighting, and the Gamma-Poisson
marginal likelihood. ``shared/golden-datasets/detector_reference.json`` pins all of them, and
``test_nonscan_models.py`` asserts this runtime reproduces the desktop's numbers.

## What the portal can and cannot run, and why it differs from Phase 29

Phase 29's models all needed a denominator the federation wire does not carry, so every one of
them is unavailable centrally. Phase 30 is not uniform in that way, and the difference is worth
stating because it is the first time the portal gains a detector rather than losing one:

* **EWMA and the Poisson CUSUM run on the federated aggregate.** They need a count per period
  and nothing else, and the wire carries exactly that — ``date``, ``signal_code`` and ``count``.
  A ministry watching a national series of carbapenem-resistant *Klebsiella* can chart it today,
  with no contract change and no privacy question, because a count is already what crosses.
* **The Bernoulli CUSUM cannot**, for the Phase 29 reason: it charts the resistant share and the
  wire has no tested count.
* **Farrington can in principle and cannot in practice.** It needs counts only, so the wire
  suffices; it also needs five years of them, and no AMRIT deployment is five years old. The
  unavailability message says which of those two it is, because they call for different actions.
* **The Bayesian spatial scan needs a location per count.** The wire carries the reporting site,
  so a central run scans sites as islands exactly as the permutation scan already does there.

## Validation status, which differs by detector

Farrington is validated against R's ``surveillance::algo.farrington`` — the reference
implementation ECDC and UKHSA work from — on a fixed 364-week series, and agrees on every alarm,
every trend decision and every threshold to five decimal places. The desktop is the arm that was
compared; this module is then held to the desktop. The control charts and the Bayesian scan have
no comparable reference package in wide use and are validated against worked examples computed
from their source papers' formulae, which is a weaker claim and is labelled as one.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from statistics import NormalDist
from typing import Any, Iterable, Sequence

import numpy as np

_NORMAL = NormalDist()


def _incomplete_beta(a: float, b: float, x: float) -> float:
    """Regularized incomplete beta, by Lentz's continued fraction.

    Written out rather than taken from scipy: scipy is not in ``requirements.txt`` and adding a
    large binary dependency to a server a ministry has to deploy, for one Student-t tail, is not
    a trade worth making. Mirrors ``incompleteBeta`` in ``statistics.ts``.
    """
    if x <= 0:
        return 0.0
    if x >= 1:
        return 1.0
    if x > (a + 1) / (a + b + 2):
        return 1 - _incomplete_beta(b, a, 1 - x)
    front = math.exp(math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b)
                     + a * math.log(x) + b * math.log(1 - x))
    tiny = 1e-30
    c = 1.0
    d = 1 - (a + b) * x / (a + 1)
    if abs(d) < tiny:
        d = tiny
    d = 1 / d
    h = d
    for m in range(1, 301):
        m2 = 2 * m
        numerator = m * (b - m) * x / ((a + m2 - 1) * (a + m2))
        d = 1 + numerator * d
        if abs(d) < tiny:
            d = tiny
        c = 1 + numerator / c
        if abs(c) < tiny:
            c = tiny
        d = 1 / d
        h *= d * c
        numerator = -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1))
        d = 1 + numerator * d
        if abs(d) < tiny:
            d = tiny
        c = 1 + numerator / c
        if abs(c) < tiny:
            c = tiny
        d = 1 / d
        delta = d * c
        h *= delta
        if abs(delta - 1) < 1e-15:
            break
    return front * h / a


def _t_two_sided(t: float, df: int) -> float:
    """Two-sided Student-t p-value, for Farrington's trend coefficient."""
    if df <= 0:
        return float("nan")
    x = df / (df + t * t)
    return _incomplete_beta(df / 2, 0.5, x)

# ---------------------------------------------------------------------------------
# Series


def aggregate_periods(values: Sequence[float], period_days: int) -> list[float]:
    """Sum a daily series into fixed-length periods, most recent period last.

    Partial periods at the *start* are dropped rather than kept short: an under-filled first
    period reads as an unusually quiet baseline and makes everything after it look like an
    excess. Mirrors ``aggregatePeriods`` in ``series.ts``.
    """
    period = max(1, int(period_days))
    complete = len(values) // period
    offset = len(values) - complete * period
    return [float(sum(values[offset + index * period: offset + (index + 1) * period]))
            for index in range(complete)]


# ---------------------------------------------------------------------------------
# Process control


def ewma_chart(
    values: Sequence[float], mean: float, sigma: float, lam: float, limit_sigma: float
) -> tuple[list[float], list[float]]:
    """EWMA statistic and its time-varying upper limit.

    The limit uses the exact variance of the smoothed statistic,
    ``lambda/(2-lambda) * (1 - (1-lambda)^(2t))``, rather than its asymptote. Using the
    asymptotic width makes the first periods far too wide, and a chart that cannot alarm early
    is not the fast detector it is being included for.
    """
    z: list[float] = []
    upper: list[float] = []
    current = mean
    for index, value in enumerate(values):
        current = lam * value + (1 - lam) * current
        z.append(current)
        variance = (lam / (2 - lam)) * (1 - (1 - lam) ** (2 * (index + 1)))
        upper.append(mean + limit_sigma * sigma * math.sqrt(variance))
    return z, upper


def cusum_chart(values: Sequence[float], reference: float) -> list[float]:
    """Page's one-sided upper CUSUM: ``S_t = max(0, S_{t-1} + x_t - k)``."""
    sums: list[float] = []
    current = 0.0
    for value in values:
        current = max(0.0, current + value - reference)
        sums.append(current)
    return sums


def poisson_reference(in_control: float, shift: float) -> float:
    """Lucas's Poisson reference value: where the log-likelihood ratio changes sign.

    ``(mu1 - mu0) / log(mu1 / mu0)``, not the arithmetic midpoint often quoted — that is only
    correct for a normal mean, and using it here would tune the chart to a different shift than
    the one requested.
    """
    out_of_control = in_control * (1 + shift)
    if in_control <= 0 or out_of_control <= in_control:
        return in_control
    return (out_of_control - in_control) / math.log(out_of_control / in_control)


def bernoulli_cusum(
    cases: Sequence[float], tested: Sequence[float], p0: float, p1: float
) -> list[float]:
    """Bernoulli CUSUM on the resistant proportion.

    Each period contributes the log-likelihood ratio of its resistant-among-tested under ``p1``
    against ``p0``. Written per period because the series is already aggregated, and identical
    to the per-isolate form: a period's ratio is the sum of its isolates' ratios.
    """
    case_weight = math.log(p1 / p0)
    control_weight = math.log((1 - p1) / (1 - p0))
    sums: list[float] = []
    current = 0.0
    for index, resistant in enumerate(cases):
        controls = max(0.0, (tested[index] if index < len(tested) else 0.0) - resistant)
        current = max(0.0, current + resistant * case_weight + controls * control_weight)
        sums.append(current)
    return sums


# ---------------------------------------------------------------------------------
# Quasi-Poisson regression and Farrington


@dataclass
class GlmFit:
    coefficients: np.ndarray
    fitted: np.ndarray
    hat: np.ndarray
    dispersion: float
    cov_unscaled: np.ndarray
    df_residual: int
    converged: bool


def fit_quasi_poisson(
    response: Sequence[float], design: np.ndarray, weights: Sequence[float] | None = None,
    max_iterations: int = 50, tolerance: float = 1e-10,
) -> GlmFit | None:
    """Fit ``log(mu) = X beta`` with quasi-Poisson variance, by IRLS.

    Matched to R's ``glm(family = quasipoisson(link = "log"))``: the same ``mu = y + 0.1``
    start, the same relative-deviance convergence test, and the same Pearson dispersion over
    residual degrees of freedom with prior weights.
    """
    y = np.asarray(response, dtype=float)
    x = np.asarray(design, dtype=float)
    n, p = x.shape
    if n == 0 or p == 0 or y.shape[0] != n:
        return None
    prior = np.ones(n) if weights is None else np.asarray(weights, dtype=float)

    mu = y + 0.1
    eta = np.log(mu)
    deviance = math.inf
    coefficients = np.zeros(p)
    information = np.zeros((p, p))
    converged = False

    for _ in range(max_iterations):
        working = eta + (y - mu) / mu
        weight = prior * mu
        information = x.T @ (x * weight[:, None])
        projection = x.T @ (weight * working)
        try:
            coefficients = np.linalg.solve(information, projection)
        except np.linalg.LinAlgError:
            return None
        eta = x @ coefficients
        mu = np.exp(eta)
        if not np.all(np.isfinite(mu)) or np.any(mu <= 0):
            return None
        with np.errstate(divide="ignore", invalid="ignore"):
            term = np.where(y > 0, y * np.log(np.where(y > 0, y, 1) / mu), 0.0)
        updated = float(2 * np.sum(prior * (term - (y - mu))))
        if abs(updated - deviance) / (abs(updated) + 0.1) < tolerance:
            deviance = updated
            converged = True
            break
        deviance = updated

    try:
        cov_unscaled = np.linalg.inv(information)
    except np.linalg.LinAlgError:
        return None
    df_residual = n - p
    pearson = float(np.sum(prior * (y - mu) ** 2 / mu))
    dispersion = pearson / df_residual if df_residual > 0 else float("nan")
    hat = (prior * mu) * np.einsum("ij,jk,ik->i", x, cov_unscaled, x)
    return GlmFit(coefficients, mu, hat, dispersion, cov_unscaled, df_residual, converged)


def reference_indices(index: int, years_back: int, window_half_width: int, periods_per_year: int) -> list[int]:
    """Reference period indices for a tested index, most distant year first."""
    out: list[int] = []
    for year in range(years_back, 0, -1):
        anniversary = index - periods_per_year * year
        for offset in range(-window_half_width, window_half_width + 1):
            candidate = anniversary + offset
            if candidate >= 0:
                out.append(candidate)
    return out


def anscombe_residuals(
    response: Sequence[float], fitted: Sequence[float], hat: Sequence[float], dispersion: float
) -> list[float]:
    """``3/2 (y^(2/3) mu^(-1/6) - mu^(1/2)) / sqrt(phi (1 - h))``.

    Anscombe's transformation rather than Pearson's because it is close to normal for Poisson
    counts, which is what makes a fixed cutoff meaningful across baselines of different size.
    """
    out: list[float] = []
    for index, y in enumerate(response):
        mu = fitted[index]
        numerator = 1.5 * (y ** (2 / 3) * mu ** (-1 / 6) - math.sqrt(mu))
        denominator = math.sqrt(dispersion * (1 - hat[index])) if dispersion * (1 - hat[index]) > 0 else 0.0
        out.append(numerator / denominator if denominator > 0 else 0.0)
    return out


def assign_weights(residuals: Sequence[float], threshold: float = 1.0) -> list[float]:
    """Farrington's weights: down-weight above the cutoff, rescale to sum to ``n``."""
    denominator = sum(residual ** -2 if residual > threshold else 1.0 for residual in residuals)
    gamma = len(residuals) / denominator if denominator > 0 else 1.0
    return [gamma * residual ** -2 if residual > threshold else gamma for residual in residuals]


@dataclass
class FarringtonResult:
    index: int
    observed: float
    expected: float
    threshold: float
    dispersion: float
    trend: bool
    probability: float
    score: float
    alarm: bool
    reference_values: int


def farrington_at(
    counts: Sequence[float], index: int, years_back: int = 5, window_half_width: int = 3,
    periods_per_year: int = 52, alpha: float = 0.005, trend: bool = True, reweight: bool = True,
    weights_threshold: float = 1.0, limit_cases: int = 5, limit_periods: int = 4,
) -> FarringtonResult | None:
    """Test one period against the same period in previous years.

    Returns ``None`` when the period cannot be tested. A period that cannot be tested is not a
    period with no aberration, and the two must not be conflated.
    """
    indices = reference_indices(index, years_back, window_half_width, periods_per_year)
    if len(indices) < 4:
        return None
    response = [float(counts[position]) if position < len(counts) else 0.0 for position in indices]
    if sum(response) <= 0:
        return None

    def fit(with_trend: bool):
        design = np.column_stack([np.ones(len(indices)), np.asarray(indices, dtype=float)]) \
            if with_trend else np.ones((len(indices), 1))
        initial = fit_quasi_poisson(response, design)
        if initial is None:
            return None
        if not reweight:
            return initial, max(initial.dispersion, 1.0), initial.dispersion, design
        residuals = anscombe_residuals(response, initial.fitted, initial.hat, max(initial.dispersion, 1.0))
        refit = fit_quasi_poisson(response, design, assign_weights(residuals, weights_threshold))
        if refit is None:
            return initial, max(initial.dispersion, 1.0), initial.dispersion, design
        return refit, max(refit.dispersion, 1.0), refit.dispersion, design

    fitted = fit(trend)
    if fitted is None:
        return None
    model, phi, raw_dispersion, _design = fitted
    use_trend = trend

    if use_trend:
        # The retention rule, exactly as the reference states it: three reference years, a
        # significant coefficient, and no extrapolation above the reference set. The p-value
        # uses the *unfloored* dispersion because R's summary.glm recomputes its own and never
        # sees the floored phi — the two disagree on real data and the threshold moves with it.
        slope = float(model.coefficients[1])
        variance = float(model.cov_unscaled[1, 1])
        standard_error = math.sqrt(max(0.0, raw_dispersion * variance))
        p_value = _t_two_sided(slope / standard_error, model.df_residual) \
            if standard_error > 0 and model.df_residual > 0 else 1.0
        predicted = math.exp(float(model.coefficients[0]) + slope * index)
        if not (years_back >= 3 and p_value < 0.05 and predicted <= max(response)):
            use_trend = False
            fitted = fit(False)
            if fitted is None:
                return None
            model, phi, raw_dispersion, _design = fitted

    row = np.array([1.0, float(index)]) if use_trend else np.array([1.0])
    expected = math.exp(float(row @ model.coefficients))
    if not math.isfinite(expected) or expected <= 0:
        return None
    se_link = math.sqrt(max(0.0, phi * float(row @ model.cov_unscaled @ row)))
    se_response = se_link * expected

    observed = float(counts[index]) if index < len(counts) else 0.0
    tau = phi + (se_response ** 2) / expected
    scale = math.sqrt((4 / 9) * expected ** (1 / 3) * tau)
    threshold = (expected ** (2 / 3) + _NORMAL.inv_cdf(1 - alpha) * scale) ** 1.5
    probability = 1.0 - _NORMAL.cdf((observed ** (2 / 3) - expected ** (2 / 3)) / scale)

    recent = sum(float(counts[position]) for position in
                 range(max(0, index - limit_periods + 1), index + 1) if position < len(counts))
    enough = recent >= limit_cases
    score = (observed - expected) / (threshold - expected) if threshold > expected else 0.0
    return FarringtonResult(
        index=index, observed=observed, expected=expected, threshold=threshold, dispersion=phi,
        trend=use_trend, probability=probability, score=score, alarm=bool(enough and score > 1),
        reference_values=len(indices),
    )


# ---------------------------------------------------------------------------------
# Bayesian spatial scan


def log_marginal_likelihood(count: float, baseline: float, shape: float, rate: float) -> float:
    """Log marginal likelihood of a Poisson count under a ``Gamma(shape, rate)`` rate prior.

    The data factorials do not depend on the region and cancel in every ratio taken from this,
    so they are omitted rather than computed and divided away.
    """
    if baseline < 0 or count < 0:
        return float("-inf")
    return (shape * math.log(rate) - math.lgamma(shape) + math.lgamma(shape + count)
            - (shape + count) * math.log(rate + baseline))


def posterior_over_regions(
    log_null: float, log_regions: Iterable[float], prior_outbreak: float
) -> dict[str, Any]:
    """Normalise prior times marginal likelihood across the null and every region.

    Returns both posteriors, because they answer different questions and the difference is not
    cosmetic. The unconditional one is diluted by the region count — Neill spreads the outbreak
    prior across every enumerated region, so a few thousand regions leave each starting at about
    one in a million. The conditional one, given that an outbreak is happening somewhere, is what
    ranks regions and what an operator is actually asking for.
    """
    regions = list(log_regions)
    if not regions:
        return {"posterior_null": 1.0, "posteriors": [], "posteriors_given_outbreak": []}
    per_region = math.log(max(1e-300, prior_outbreak / len(regions)))
    log_prior_null = math.log(max(1e-300, 1 - prior_outbreak))
    terms = [log_null + log_prior_null] + [value + per_region for value in regions]
    maximum = max(terms)
    denominator = sum(math.exp(term - maximum) for term in terms)
    posteriors = [math.exp(term - maximum) / denominator for term in terms[1:]]

    region_terms = [value + per_region for value in regions]
    region_maximum = max(region_terms)
    region_denominator = sum(math.exp(term - region_maximum) for term in region_terms)
    conditional = [math.exp(term - region_maximum) / region_denominator for term in region_terms]
    return {
        "posterior_null": math.exp(terms[0] - maximum) / denominator,
        "posteriors": posteriors,
        "posteriors_given_outbreak": conditional,
    }
