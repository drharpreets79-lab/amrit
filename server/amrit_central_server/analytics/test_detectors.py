"""Cross-runtime parity for the detector framework.

Both products read ``shared/golden-datasets/detector_reference.json``. A detector that is
described one way on the desktop and another on the portal is the same defect as not having
a registry, because Phases 28 to 34 compare methods across the two.

What is pinned is what is deterministic. p-values are not: the desktop seeds an
FNV-1a/xorshift stream and this runtime a SHA-256-seeded ``random.Random``, so Monte Carlo
results differ by simulation noise on identical input.
"""

from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path

from django.test import SimpleTestCase

from .detectors import (
    DEFAULT_DETECTOR_ID,
    SPACE_TIME_PERMUTATION_ID,
    Detector,
    derive_denominators,
    describe_denominator_coverage,
    describe_detectors,
    detector_availability,
    get_detector,
    register_detector,
)
from .outbreak_detection import CaseEvent

FIXTURE = json.loads(
    (Path(__file__).resolve().parent.parent / "shared" / "golden-datasets" / "detector_reference.json").read_text()
)


class DetectorRegistryTests(SimpleTestCase):
    def test_registers_the_existing_scan_and_makes_it_the_default(self):
        self.assertEqual(DEFAULT_DETECTOR_ID, SPACE_TIME_PERMUTATION_ID)
        detector = get_detector(SPACE_TIME_PERMUTATION_ID)
        self.assertEqual(detector.descriptor.method, "Kulldorff space-time permutation scan statistic")
        self.assertFalse(detector.descriptor.requires.denominators)

    def test_duplicate_id_is_refused_because_ids_are_stored_on_signals(self):
        original = get_detector(SPACE_TIME_PERMUTATION_ID)
        impostor = Detector(
            descriptor=original.descriptor,
            default_settings=original.default_settings,
            unavailable_reason=original.unavailable_reason,
            run=original.run,
        )
        with self.assertRaisesMessage(ValueError, "already registered"):
            register_detector(impostor)

    def test_unknown_detector_names_itself(self):
        with self.assertRaisesMessage(KeyError, "No detector 'bernoulli'"):
            get_detector("bernoulli")

    def test_availability_gives_a_reason_an_operator_can_act_on(self):
        rows = detector_availability({"events": []})
        self.assertFalse(rows[0]["available"])
        self.assertIn("No case events", rows[0]["reason"])


class SharedFixtureParityTests(SimpleTestCase):
    def test_descriptors_match_the_desktop(self):
        """The desktop writes this fixture; this asserts the portal describes the same thing.

        Key names are camelCase on the desktop and snake_case here, which is the existing
        convention on both sides of every other shared fixture, so the comparison maps the
        two field names that differ rather than pretending they are spelled alike.
        """
        expected = FIXTURE["detectors"]
        actual = describe_detectors()
        self.assertEqual(len(actual), len(expected))
        for want, got in zip(expected, actual):
            self.assertEqual(got["id"], want["id"])
            self.assertEqual(got["name"], want["name"])
            self.assertEqual(got["method"], want["method"])
            self.assertEqual(got["family"], want["family"])
            self.assertEqual(got["citation"], want["citation"])
            self.assertEqual(got["blind_spot"], want["blindSpot"])
            self.assertEqual(got["requires"]["denominators"], want["requires"]["denominators"])
            self.assertEqual(got["requires"]["coordinates"], want["requires"]["coordinates"])
            self.assertEqual(got["requires"]["multiple_locations"], want["requires"]["multipleLocations"])
            self.assertEqual(got["supports"]["prospective"], want["supports"]["prospective"])
            self.assertEqual(got["supports"]["retrospective"], want["supports"]["retrospective"])

    def test_denominator_derivation_matches_the_desktop_row_for_row(self):
        rows = [row.to_dict() for row in derive_denominators(FIXTURE["denominators"]["records"])]
        self.assertEqual(rows, FIXTURE["denominators"]["rows"])

    def test_denominator_coverage_matches_the_desktop(self):
        coverage = describe_denominator_coverage(derive_denominators(FIXTURE["denominators"]["records"]))
        self.assertEqual(coverage, FIXTURE["denominators"]["coverage"])

    def test_intermediate_counts_as_tested_and_never_as_resistant(self):
        rows = {row.antibiotic_code: row for row in derive_denominators(FIXTURE["denominators"]["records"])}
        self.assertEqual(rows["GEN"].tested, 1)
        self.assertEqual(rows["GEN"].resistant, 0)
        # An agent with no interpretation was not tested and must not dilute the denominator.
        self.assertNotIn("AMK", rows)

    def test_cluster_geometry_matches_the_desktop(self):
        """Observed, expected and the log-likelihood ratio are deterministic; p-values are not."""
        settings = FIXTURE["scan"]["settings"]
        events = [
            CaseEvent(
                date=date.fromisoformat(row["date"]),
                location=row["location"],
                signal_type=row["signalType"],
                signal_code=row["signalCode"],
                organism=row["organism"],
                antibiotic=row.get("antibioticCode", ""),
                count=row["count"],
            )
            for row in FIXTURE["scan"]["events"]
        ]
        result = get_detector(SPACE_TIME_PERMUTATION_ID).run({"events": events, "settings": settings})
        diagnostics = result["diagnostics"]
        self.assertEqual(diagnostics["study_start"], FIXTURE["scan"]["study_start"])
        self.assertEqual(diagnostics["study_end"], FIXTURE["scan"]["study_end"])
        self.assertEqual(diagnostics["eligible_events"], FIXTURE["scan"]["eligible_events"])
        self.assertEqual(diagnostics["locations"], FIXTURE["scan"]["locations"])
        self.assertEqual(diagnostics["signals_tested"], FIXTURE["scan"]["signals_tested"])

        # The two runtimes scan different islands and name the aggregate correctly for what
        # each holds: wards inside one laboratory here become "All locations", reporting
        # sites across a federation become "All sites". The statistic is the same one —
        # every log-likelihood ratio below agrees with the desktop's to three decimals —
        # so parity maps the label rather than demanding one product borrow the other's
        # word for a thing it does not have. Found by this fixture on its first run.
        labels = FIXTURE["runtime_labels"]["all_locations"]
        geometry = [
            {
                "scope": signal["scope"],
                "signal_type": signal["signal_type"],
                "organism": signal["organism"],
                "antibiotic": signal["antibiotic"],
                "location": labels["desktop"] if signal["location"] == labels["portal"] else signal["location"],
                "start_date": signal["start_date"],
                "end_date": signal["end_date"],
                "days": signal["days"],
                "observed": signal["observed"],
                "expected": signal["expected"],
                "log_likelihood_ratio": signal["log_likelihood_ratio"],
            }
            for signal in result["signals"]
        ]
        self.assertEqual(geometry, FIXTURE["scan"]["clusters"])

    def test_every_signal_carries_the_detector_that_produced_it(self):
        start = date(2026, 1, 1)
        events = []
        for day in range(90):
            when = start + timedelta(days=day)
            events.append(CaseEvent(when, "Ward A", "organism", "ORG:ECO", "Escherichia coli"))
            events.append(CaseEvent(when, "Ward B", "organism", "ORG:ECO", "Escherichia coli"))
            events.append(CaseEvent(when, "Ward A", "organism", "ORG:KPN", "Klebsiella pneumoniae"))
            events.append(CaseEvent(when, "Ward B", "organism", "ORG:KPN", "Klebsiella pneumoniae"))
        for day in range(84, 90):
            events.append(CaseEvent(start + timedelta(days=day), "Ward B", "organism", "ORG:KPN", "Klebsiella pneumoniae", count=6))
        result = get_detector(SPACE_TIME_PERMUTATION_ID).run(
            {"events": events, "settings": {"permutations": 99, "recurrenceThresholdDays": 50, "baselineDays": 90}}
        )
        self.assertTrue(result["signals"])
        for signal in result["signals"]:
            self.assertEqual(signal["detector_id"], SPACE_TIME_PERMUTATION_ID)

    def test_replication_count_bounds_the_reachable_recurrence_interval(self):
        result = get_detector(SPACE_TIME_PERMUTATION_ID).run(
            {"events": [CaseEvent(date(2026, 1, 1), "A", "organism", "ORG:ECO", "Escherichia coli")],
             "settings": {"permutations": 99}}
        )
        # 99 replications floor the p-value at 1/100, so no cluster of any size can reach
        # the shipped 365-day alert threshold.
        self.assertEqual(result["diagnostics"]["maximum_reachable_recurrence_interval"], 100)
