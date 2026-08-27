"""Cross-runtime parity for the Phase 29 scan models.

The desktop and this runtime must compute the same statistic on the same rows. What is
pinned in ``shared/golden-datasets/detector_reference.json`` is what is deterministic: the
log-likelihood ratios on worked cases, and the cluster each shape selects with its observed,
tested and ratios. p-values are not pinned — the two runtimes seed different generators — so
a difference there is simulation noise and a difference in the geometry is a defect.
"""

from __future__ import annotations

import json
from pathlib import Path

from django.test import SimpleTestCase

from .detectors import (
    BERNOULLI_PURELY_SPATIAL_ID,
    BERNOULLI_PURELY_TEMPORAL_ID,
    BERNOULLI_SPACE_TIME_ID,
    DEFAULT_DETECTOR_ID,
    MULTIVARIATE_ID,
    POISSON_PURELY_TEMPORAL_ID,
    POISSON_SPACE_TIME_ID,
    SPACE_TIME_PERMUTATION_ID,
    DenominatorRow,
    get_detector,
    list_detectors,
)
from .scan_models import (
    BernoulliSettings,
    PoissonSettings,
    PopulationRow,
    bernoulli_log_likelihood_ratio,
    multivariate_combined_llr,
    poisson_log_likelihood_ratio,
    scan_bernoulli,
    scan_poisson,
)

FIXTURE = json.loads(
    (Path(__file__).resolve().parent.parent / "shared" / "golden-datasets" / "detector_reference.json").read_text()
)

DENOMINATORS = [DenominatorRow(**row) for row in FIXTURE["bernoulli"]["denominators"]]
POPULATION = [PopulationRow(**row) for row in FIXTURE["poisson"]["population"]]


class RegistryTests(SimpleTestCase):
    def test_holds_every_model_in_the_order_the_desktop_registers_them(self):
        # The scan family, in registration order. Later phases append their own families
        # after these, so this asserts the prefix rather than the whole registry: the order
        # an operator sees is part of the contract and must not be reshuffled by an addition.
        self.assertEqual(
            [detector.descriptor.id for detector in list_detectors()][:7],
            [
                SPACE_TIME_PERMUTATION_ID,
                BERNOULLI_SPACE_TIME_ID,
                BERNOULLI_PURELY_TEMPORAL_ID,
                BERNOULLI_PURELY_SPATIAL_ID,
                POISSON_SPACE_TIME_ID,
                POISSON_PURELY_TEMPORAL_ID,
                MULTIVARIATE_ID,
            ],
        )
        # The default stays the control arm of every comparison Phases 28 to 34 make.
        self.assertEqual(DEFAULT_DETECTOR_ID, SPACE_TIME_PERMUTATION_ID)

    def test_every_registered_model_is_in_the_shared_fixture(self):
        # Field-by-field descriptor parity is asserted in ``test_detectors.py``, which maps
        # the two key names that differ between the runtimes. This only checks that Phase 29
        # did not add a detector on one side and forget the other.
        self.assertEqual(
            [detector.descriptor.id for detector in list_detectors()],
            [descriptor["id"] for descriptor in FIXTURE["detectors"]],
        )

    def test_the_wire_is_named_as_the_reason_not_the_model(self):
        # An operator reading the portal has to be told what is missing and where the scan
        # can be run instead, not that a detector is simply absent.
        reason = get_detector(BERNOULLI_SPACE_TIME_ID).unavailable_reason({})
        self.assertIn("federation wire", reason)
        self.assertIn("laboratory node", reason)

    def test_poisson_asks_for_a_population_and_will_not_substitute_isolates(self):
        reason = get_detector(POISSON_SPACE_TIME_ID).unavailable_reason({"denominators": DENOMINATORS})
        self.assertIn("No population at risk", reason)

    def test_multivariate_needs_isolates_the_portal_does_not_hold(self):
        reason = get_detector(MULTIVARIATE_ID).unavailable_reason({"denominators": DENOMINATORS})
        self.assertIn("permutes whole isolates", reason)

    def test_a_single_location_deployment_is_offered_the_temporal_scan(self):
        one = [DenominatorRow(**{**row.to_dict(), "location": "The laboratory"}) for row in DENOMINATORS]
        context = {"denominators": one}
        self.assertIn("Only one location", get_detector(BERNOULLI_SPACE_TIME_ID).unavailable_reason(context))
        self.assertIsNone(get_detector(BERNOULLI_PURELY_TEMPORAL_ID).unavailable_reason(context))


class BernoulliTests(SimpleTestCase):
    def test_log_likelihood_ratio_matches_the_worked_cases(self):
        for case in FIXTURE["bernoulli"]["likelihood_cases"]:
            self.assertAlmostEqual(
                bernoulli_log_likelihood_ratio(
                    case["cases"], case["tested"], case["total_cases"], case["total_tested"]
                ),
                case["log_likelihood_ratio"],
                places=5,
            )

    def test_a_ward_with_low_resistance_is_not_an_outbreak(self):
        self.assertEqual(bernoulli_log_likelihood_ratio(1, 50, 30, 100), 0.0)

    def test_reproduces_the_desktop_geometry_for_all_three_shapes(self):
        for shape, expected in FIXTURE["bernoulli"]["shapes"].items():
            raw = dict(FIXTURE["bernoulli"]["settings"])
            if shape == "purely-spatial":
                raw["analysisType"] = "retrospective"
            result = scan_bernoulli(DENOMINATORS, settings=BernoulliSettings.from_dict(raw), shape=shape)
            self.assertEqual(result["study_start"], expected["study_start"], shape)
            self.assertEqual(result["study_end"], expected["study_end"], shape)
            self.assertEqual(result["streams"], expected["streams"], shape)
            self.assertEqual(result["locations"], expected["locations"], shape)
            self.assertEqual(result["total_tested"], expected["total_tested"], shape)
            self.assertEqual(result["total_resistant"], expected["total_resistant"], shape)
            geometry = [
                {
                    "antibiotic": signal["antibiotic"],
                    "location": signal["location"],
                    "start_date": signal["start_date"],
                    "end_date": signal["end_date"],
                    "days": signal["days"],
                    "observed": signal["observed"],
                    "tested": signal["tested"],
                    "proportion": signal["proportion"],
                    "baseline_proportion": signal["baseline_proportion"],
                    "log_likelihood_ratio": signal["log_likelihood_ratio"],
                }
                for signal in result["signals"]
            ]
            self.assertEqual(geometry, expected["clusters"], shape)

    def test_the_same_input_gives_the_same_answer_twice(self):
        # Randomness is derived from the input and never from the clock: a benchmark that
        # cannot be repeated is not evidence.
        settings = BernoulliSettings.from_dict(FIXTURE["bernoulli"]["settings"])
        first = scan_bernoulli(DENOMINATORS, settings=settings)
        second = scan_bernoulli(DENOMINATORS, settings=settings)
        self.assertEqual(first["signals"], second["signals"])


class PoissonTests(SimpleTestCase):
    def test_log_likelihood_ratio_matches_the_worked_cases(self):
        for case in FIXTURE["poisson"]["likelihood_cases"]:
            self.assertAlmostEqual(
                poisson_log_likelihood_ratio(case["cases"], case["expected"], case["total_cases"]),
                case["log_likelihood_ratio"],
                places=5,
            )

    def test_reproduces_the_desktop_geometry(self):
        expected = FIXTURE["poisson"]
        result = scan_poisson(
            DENOMINATORS, POPULATION, settings=PoissonSettings.from_dict(expected["settings"])
        )
        self.assertEqual(result["study_start"], expected["study_start"])
        self.assertEqual(result["study_end"], expected["study_end"])
        self.assertEqual(result["streams"], expected["streams"])
        self.assertEqual(result["locations"], expected["locations"])
        self.assertEqual(result["total_population"], expected["total_population"])
        self.assertEqual(result["population_unit"], expected["population_unit"])
        geometry = [
            {
                "antibiotic": signal["antibiotic"],
                "location": signal["location"],
                "start_date": signal["start_date"],
                "end_date": signal["end_date"],
                "days": signal["days"],
                "observed": signal["observed"],
                "expected": signal["expected"],
                "population": signal["population"],
                "log_likelihood_ratio": signal["log_likelihood_ratio"],
            }
            for signal in result["signals"]
        ]
        self.assertEqual(geometry, expected["clusters"])

    def test_refuses_to_substitute_isolates_tested_for_a_population_at_risk(self):
        result = scan_poisson(DENOMINATORS, [], settings=PoissonSettings.from_dict(FIXTURE["poisson"]["settings"]))
        self.assertEqual(result["signals"], [])
        self.assertIn("laboratory record does not carry one", result["warnings"][0])

    def test_excludes_a_case_whose_location_has_no_population_series(self):
        orphan = DENOMINATORS + [
            DenominatorRow("2026-03-12", "Day surgery", "KPN", "MEM", 4, 4)
        ]
        result = scan_poisson(orphan, POPULATION, settings=PoissonSettings.from_dict(FIXTURE["poisson"]["settings"]))
        self.assertTrue(any("4 resistant isolates" in warning for warning in result["warnings"]))
        self.assertTrue(all(signal["location"] != "Day surgery" for signal in result["signals"]))


class MultivariateTests(SimpleTestCase):
    def test_combines_only_the_streams_that_contribute(self):
        for case in FIXTURE["multivariate"]["combining_cases"]:
            combined, streams = multivariate_combined_llr(case["stream_log_likelihood_ratios"])
            self.assertAlmostEqual(combined, case["combined"], places=5)
            self.assertEqual(streams, case["streams"])
