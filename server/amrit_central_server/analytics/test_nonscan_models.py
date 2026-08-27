"""Cross-runtime parity for the Phase 30 non-scan detectors.

Farrington carries the strongest claim in this file and it is worth being precise about its
shape. The desktop implementation was compared against R's ``surveillance::algo.farrington`` —
the reference ECDC and UKHSA work from — on a fixed 364-week series, and agreed on every alarm,
every trend decision and every threshold. That package's own output is pinned in the shared
fixture, so this runtime is held to the same standard rather than merely to the desktop.

The control charts and the Bayesian scan have no reference package in comparable use, so their
fixtures are worked examples computed from the source papers' formulae. That proves the two
runtimes agree with each other and with the published recursion. It does not prove either agrees
with a third implementation, and the difference in strength is deliberate rather than an
oversight.
"""

from __future__ import annotations

import json
from pathlib import Path

from django.test import SimpleTestCase

from .detectors import (
    BAYESIAN_SCAN_ID,
    CUSUM_BERNOULLI_ID,
    CUSUM_POISSON_ID,
    EWMA_ID,
    FARRINGTON_ID,
    get_detector,
    list_detectors,
)
from .nonscan_models import (
    _t_two_sided,
    aggregate_periods,
    anscombe_residuals,
    assign_weights,
    bernoulli_cusum,
    cusum_chart,
    ewma_chart,
    farrington_at,
    log_marginal_likelihood,
    poisson_reference,
    posterior_over_regions,
    reference_indices,
)

FIXTURE = json.loads(
    (Path(__file__).resolve().parent.parent / "shared" / "golden-datasets" / "detector_reference.json").read_text()
)
CHARTS = FIXTURE["process_control"]
FARRINGTON = FIXTURE["farrington"]


class RegistryTests(SimpleTestCase):
    def test_every_registered_detector_is_in_the_shared_fixture(self):
        self.assertEqual(
            [detector.descriptor.id for detector in list_detectors()],
            [descriptor["id"] for descriptor in FIXTURE["detectors"]],
        )
        # Twelve after Phase 30, thirteen once PACE joined them in Phase 31.
        self.assertEqual(len(list_detectors()), 13)

    def test_the_two_count_only_charts_can_run_on_the_federated_aggregate(self):
        # The first detectors the portal *gains* rather than loses. They need a count per
        # period and nothing else, which is exactly what crosses the wire.
        for detector_id in (EWMA_ID, CUSUM_POISSON_ID):
            self.assertIsNone(
                get_detector(detector_id).unavailable_reason({"events": [{"date": "2026-01-01", "count": 3}]}),
                detector_id,
            )

    def test_the_proportion_chart_still_needs_a_denominator_the_wire_lacks(self):
        reason = get_detector(CUSUM_BERNOULLI_ID).unavailable_reason({"events": [1]})
        self.assertIn("federation wire", reason)
        self.assertIn("laboratory node", reason)

    def test_farrington_is_unavailable_for_want_of_time_not_of_contract(self):
        # A different kind of unavailable from the wire limitation, and the message has to
        # distinguish them because they call for different actions — one is a decision, the
        # other is only waiting.
        reason = get_detector(FARRINGTON_ID).unavailable_reason({"events": [1]})
        self.assertIn("five", reason)
        self.assertIn("matter of time rather than of contract", reason)

    def test_the_bayesian_scan_says_it_is_unfinished_rather_than_impossible(self):
        reason = get_detector(BAYESIAN_SCAN_ID).unavailable_reason({"events": [1]})
        self.assertIn("unfinished work", reason)


class ChartTests(SimpleTestCase):
    def test_aggregate_periods_matches_the_desktop(self):
        expected = CHARTS["aggregate_periods"]
        self.assertEqual(aggregate_periods(CHARTS["series"], expected["period_days"]), expected["result"])

    def test_ewma_recursion_and_limits_match_the_desktop(self):
        spec = CHARTS["ewma"]
        mean = CHARTS["in_control_mean"]
        z, upper = ewma_chart(CHARTS["series"], mean, mean ** 0.5, spec["lambda"], spec["limit_sigma"])
        for index, value in enumerate(z):
            self.assertAlmostEqual(value, spec["z"][index], places=9)
        for index, value in enumerate(upper):
            self.assertAlmostEqual(value, spec["upper"][index], places=9)
        # The limit widens toward its asymptote rather than starting there.
        self.assertLess(upper[0], upper[-1])

    def test_poisson_cusum_uses_lucas_reference_value(self):
        spec = CHARTS["cusum_poisson"]
        reference = poisson_reference(CHARTS["in_control_mean"], spec["shift"])
        self.assertAlmostEqual(reference, spec["reference"], places=9)
        # Not the arithmetic midpoint, which would tune the chart to a different shift.
        self.assertNotAlmostEqual(reference, 5.0, places=3)
        for index, value in enumerate(cusum_chart(CHARTS["series"], reference)):
            self.assertAlmostEqual(value, spec["sums"][index], places=8)

    def test_bernoulli_cusum_matches_the_desktop(self):
        spec = CHARTS["cusum_bernoulli"]
        sums = bernoulli_cusum(CHARTS["series"], CHARTS["tested"], spec["p0"], spec["p1"])
        for index, value in enumerate(sums):
            self.assertAlmostEqual(value, spec["sums"][index], places=9)

    def test_a_cusum_never_goes_below_zero(self):
        self.assertEqual(cusum_chart([0, 0, 0, 0], 4), [0.0, 0.0, 0.0, 0.0])


class FarringtonTests(SimpleTestCase):
    def test_matches_r_on_every_threshold(self):
        counts = FARRINGTON["counts"]
        worst = 0.0
        for row in FARRINGTON["reference"]:
            result = farrington_at(counts, row["index"] - 1)  # R indices are 1-based
            self.assertIsNotNone(result)
            if row["upperbound"] > 0:
                worst = max(worst, abs(result.threshold - row["upperbound"]) / row["upperbound"])
        # Above this is IRLS convergence noise between two implementations of the same
        # regression, not a difference in method.
        self.assertLess(worst, 1e-4)

    def test_matches_r_on_every_alarm_and_trend_decision(self):
        counts = FARRINGTON["counts"]
        for row in FARRINGTON["reference"]:
            result = farrington_at(counts, row["index"] - 1)
            self.assertEqual(result.alarm, row["alarm"], row["index"])
            self.assertEqual(result.trend, row["trend"], row["index"])

    def test_reference_window_is_the_same_weeks_in_previous_years(self):
        indices = reference_indices(300, years_back=2, window_half_width=1, periods_per_year=52)
        self.assertEqual(indices, [195, 196, 197, 247, 248, 249])

    def test_reference_values_before_the_series_starts_are_dropped_not_zeroed(self):
        # A week that does not exist is not a week with no cases, and treating it as zero
        # would drag the baseline down and manufacture an excess.
        self.assertEqual(reference_indices(10, years_back=2, window_half_width=1, periods_per_year=52), [])

    def test_weights_down_weight_a_past_outbreak_and_rescale(self):
        weights = assign_weights([0.5, 0.2, 4.0, 0.1], threshold=1.0)
        self.assertLess(weights[2], weights[0])
        # Rescaled so the weights sum to the number of observations, which keeps the
        # dispersion estimate on the same footing as an unweighted fit.
        self.assertAlmostEqual(sum(weights), 4.0, places=6)

    def test_anscombe_residual_is_zero_when_the_fit_is_exact(self):
        self.assertAlmostEqual(anscombe_residuals([4.0], [4.0], [0.0], 1.0)[0], 0.0, places=9)

    def test_student_t_matches_r(self):
        self.assertAlmostEqual(_t_two_sided(2.5, 10), 0.031446844236608783, places=12)
        self.assertAlmostEqual(_t_two_sided(4.2, 7), 0.0040355599252199616, places=12)


class BayesianTests(SimpleTestCase):
    def test_marginal_likelihood_matches_the_desktop(self):
        for case in FIXTURE["bayesian"]["likelihood_cases"]:
            self.assertAlmostEqual(
                log_marginal_likelihood(case["count"], case["baseline"], case["shape"], case["rate"]),
                case["log_marginal_likelihood"],
                places=9,
            )

    def test_posteriors_sum_to_one_with_the_null(self):
        result = posterior_over_regions(log_null=-10.0, log_regions=[-8.0, -9.0, -12.0], prior_outbreak=0.01)
        self.assertAlmostEqual(result["posterior_null"] + sum(result["posteriors"]), 1.0, places=12)

    def test_the_conditional_posterior_is_not_diluted_by_the_region_count(self):
        # Neill spreads the outbreak prior across every enumerated region, so the
        # unconditional posterior shrinks as the grid grows while the ranking does not.
        few = posterior_over_regions(-10.0, [-8.0, -9.0], 0.01)
        many = posterior_over_regions(-10.0, [-8.0, -9.0] + [-30.0] * 500, 0.01)
        self.assertLess(many["posteriors"][0], few["posteriors"][0])
        self.assertAlmostEqual(many["posteriors_given_outbreak"][0], few["posteriors_given_outbreak"][0], places=6)
        self.assertAlmostEqual(sum(many["posteriors_given_outbreak"]), 1.0, places=12)
