"""Phase 31 — the PACE rules, asserted against the fixture the desktop writes.

What is tested here is every part of PACE that is a rule rather than a scan, because those are
the parts both runtimes hold and the parts that would drift silently. The two scans PACE composes
cannot run centrally at all, and the last test in this file is the assertion that the portal says
so with a reason rather than returning an empty result.
"""

from __future__ import annotations

import json
from pathlib import Path

from django.test import SimpleTestCase

from .detectors import PACE_ID, detector_availability, describe_detectors, get_detector
from .pace import (
    alert_threshold_for,
    build_phenotype_index,
    count_streams,
    label_for_phenotype,
    map_records_to_phenotypes,
    phenotype_for_agent,
    sidak,
    transmission_plausibility,
)

FIXTURE = json.loads(
    (Path(__file__).resolve().parents[1] / "shared/golden-datasets/detector_reference.json").read_text()
)
PACE_FIXTURE = FIXTURE["pace"]


class PhenotypeMappingTests(SimpleTestCase):
    def test_every_agent_maps_the_way_the_desktop_maps_it(self):
        for row in PACE_FIXTURE["catalogue"]:
            phenotype = phenotype_for_agent(row)
            expected = PACE_FIXTURE["phenotype_map"][row["code"]]
            self.assertEqual(phenotype.id if phenotype else None, expected, row["code"])

    def test_subclass_beats_class_because_the_class_is_too_coarse(self):
        """``Cephems`` holds first- and fourth-generation cephalosporins. Different mechanisms."""
        third = phenotype_for_agent({"code": "CRO", "class_name": "Cephems", "subclass_name": "Cephalosporin III"})
        fourth = phenotype_for_agent({"code": "FEP", "class_name": "Cephems", "subclass_name": "Cephalosporin IV"})
        self.assertEqual(third.id, "3GC-R")
        self.assertEqual(fourth.id, "4GC-R")

    def test_an_unclassified_agent_stands_alone(self):
        self.assertIsNone(
            phenotype_for_agent({"code": "TZP", "class_name": "Beta-lactam+Inhibitors", "subclass_name": ""})
        )
        self.assertIsNone(phenotype_for_agent(None))

    def test_labels_survive_the_upper_casing_both_counting_paths_apply(self):
        index = build_phenotype_index(PACE_FIXTURE["catalogue"])
        self.assertEqual(label_for_phenotype("CARBAPENEM-R", index), "Carbapenem resistance")
        self.assertEqual(label_for_phenotype("TZP", index), "TZP")


class CountingRuleTests(SimpleTestCase):
    def setUp(self):
        self.index = build_phenotype_index(PACE_FIXTURE["catalogue"])

    def test_an_isolate_resistant_to_three_carbapenems_is_one_case(self):
        mapped = map_records_to_phenotypes(PACE_FIXTURE["pooling"]["records"], self.index, True)
        actual = [
            {"specimen_number": record["specimen_number"], "antibiotic_results": record["antibiotic_results"]}
            for record in mapped
        ]
        self.assertEqual(actual, PACE_FIXTURE["pooling"]["mapped"])

    def test_resistant_beats_intermediate_beats_susceptible(self):
        record = {
            "specimen_date": "2026-03-01",
            "organism_code": "KPN",
            "antibiotic_results": {"MEM": {"result": "S"}, "IPM": {"result": "R"}, "ETP": {"result": "I"}},
        }
        mapped = map_records_to_phenotypes([record], self.index, True)[0]
        self.assertEqual(mapped["antibiotic_results"]["carbapenem-R"]["result"], "R")

    def test_pooling_removes_multiplicity_and_says_how_much(self):
        records = PACE_FIXTURE["pooling"]["records"]
        mapped = map_records_to_phenotypes(records, self.index, True)
        self.assertEqual(count_streams(records), PACE_FIXTURE["pooling"]["streams_before"])
        self.assertEqual(count_streams(mapped), PACE_FIXTURE["pooling"]["streams_after"])


class CombinationAndThresholdTests(SimpleTestCase):
    def test_sidak_matches_the_desktop(self):
        for row in PACE_FIXTURE["sidak"]:
            self.assertAlmostEqual(sidak(row["p"], row["models"]), row["combined"], places=10)

    def test_sidak_over_one_model_is_the_identity(self):
        """Which is what makes the single-model ablation literally the control arm."""
        self.assertEqual(sidak(0.0123, 1), 0.0123)

    def test_alert_threshold_matches_the_desktop(self):
        for row in PACE_FIXTURE["alert_threshold"]:
            measured = alert_threshold_for(row["target"], row["site_years"], row["permutations"])
            self.assertAlmostEqual(measured["threshold"], row["threshold"], places=10)
            self.assertEqual(measured["floored"], row["floored"])
            self.assertEqual(measured["ceilinged"], row["ceilinged"])

    def test_a_budget_below_the_monte_carlo_floor_is_reported_rather_than_faked(self):
        measured = alert_threshold_for(0.01, 0.01, 99)
        self.assertTrue(measured["floored"])
        self.assertAlmostEqual(measured["threshold"], 0.01, places=10)


class PlausibilityTests(SimpleTestCase):
    def test_matches_the_desktop(self):
        measured = transmission_plausibility(
            PACE_FIXTURE["plausibility"]["records"], PACE_FIXTURE["plausibility"]["window_days"]
        )
        self.assertAlmostEqual(measured["score"], PACE_FIXTURE["plausibility"]["score"], places=4)
        self.assertEqual(measured["cases"], PACE_FIXTURE["plausibility"]["cases_counted"])
        self.assertEqual(measured["admissions_known"], PACE_FIXTURE["plausibility"]["admissions_known"])

    def test_different_wards_are_implausible_however_close_in_time(self):
        measured = transmission_plausibility(
            [
                {"specimen_date": "2026-03-01", "admission_date": "2026-02-25", "location": "Ward A"},
                {"specimen_date": "2026-03-01", "admission_date": "2026-02-25", "location": "Ward B"},
            ],
            14,
        )
        self.assertEqual(measured["score"], 0.0)

    def test_one_case_scores_zero_rather_than_certain(self):
        measured = transmission_plausibility([{"specimen_date": "2026-03-01", "location": "Ward A"}], 14)
        self.assertEqual(measured["score"], 0.0)


class RegistrationTests(SimpleTestCase):
    def test_pace_is_registered_and_described_as_the_desktop_describes_it(self):
        described = next(row for row in describe_detectors() if row["id"] == PACE_ID)
        expected = next(row for row in FIXTURE["detectors"] if row["id"] == PACE_ID)
        self.assertEqual(described["name"], expected["name"])
        self.assertEqual(described["method"], expected["method"])
        self.assertEqual(described["family"], expected["family"])
        self.assertEqual(described["blind_spot"], expected["blindSpot"])
        self.assertEqual(described["requires"]["denominators"], expected["requires"]["denominators"])
        self.assertEqual(
            described["requires"]["multiple_locations"], expected["requires"]["multipleLocations"]
        )
        self.assertEqual(described["citation"], expected["citation"])

    def test_it_says_why_it_cannot_run_centrally_rather_than_returning_nothing(self):
        """The wire carries counts, and pooling needs to know which resistances shared a specimen.

        A detector that returned an empty result here would read as "no outbreak" to anyone
        looking at the portal, which is the failure this reason exists to prevent.
        """
        row = next(
            entry
            for entry in detector_availability({"events": []})
            if entry["descriptor"]["id"] == PACE_ID
        )
        self.assertFalse(row["available"])
        self.assertIn("aggregate counts rather than isolates", row["reason"])
        self.assertIn("laboratory node", row["reason"])
        with self.assertRaises(NotImplementedError):
            get_detector(PACE_ID).run({"events": []})

    def test_default_settings_name_all_four_components(self):
        settings = get_detector(PACE_ID).default_settings()
        for key in ("aggregatePhenotypes", "models", "calibrateThreshold", "rerankByPlausibility"):
            self.assertIn(key, settings)
