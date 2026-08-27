"""Formula-equivalence tests.

The web server never re-derives resistance from patient rows — sites do. But the
server must understand the wire payload *exactly* as the desktop produces it.
These tests pin ``site_resistance_payload`` and ``aggregate_resistance`` to the
desktop's %R = R / (R + I + S) definition.

If the desktop package is importable (its light modules only), we compare against
``aggregate_measures.calculate_resistance_summary`` directly. Otherwise we compare
against an inline reference implementation of the same contract.
"""

from __future__ import annotations

import os
import sys

from django.test import SimpleTestCase

from metrics.compute import aggregate_resistance, site_resistance_payload
from metrics.registry import all_metrics, get


# A fixed isolate fixture: 10 isolates tested against MEM.
# 4 R, 1 I, 3 S  -> denominator 8 (2 rows have no MEM result), numerator 4 -> 50.0%
FIXTURE = [
    {"antibiotic_results": {"MEM": {"result": "R"}}, "infection_origin": "HAI"},
    {"antibiotic_results": {"MEM": {"result": "R"}}, "infection_origin": "HAI"},
    {"antibiotic_results": {"MEM": {"result": "R"}}, "infection_origin": "CAI"},
    {"antibiotic_results": {"MEM": {"result": "R"}}, "infection_origin": "CAI"},
    {"antibiotic_results": {"MEM": {"result": "I"}}, "infection_origin": "HAI"},
    {"antibiotic_results": {"MEM": {"result": "S"}}, "infection_origin": "CAI"},
    {"antibiotic_results": {"MEM": {"result": "S"}}, "infection_origin": "CAI"},
    {"antibiotic_results": {"MEM": {"result": "S"}}, "infection_origin": "Unknown"},
    {"antibiotic_results": {"MEM": {"result": ""}}, "infection_origin": "HAI"},
    {"antibiotic_results": {"GEN": {"result": "R"}}, "infection_origin": "HAI"},
]


def _reference_summary(rows, antibiotic_code):
    """Inline copy of the desktop numerator/denominator contract."""
    num = den = 0
    for row in rows:
        result = str((row.get("antibiotic_results", {}).get(antibiotic_code) or {}).get("result") or "").upper()
        if result not in {"R", "I", "S"}:
            continue
        den += 1
        if result == "R":
            num += 1
    return {"numerator": num, "denominator": den,
            "score": round(num / den * 100, 2) if den else 0.0}


def _desktop_summary(rows, antibiotic_code):
    """Try the real desktop function; fall back to the inline reference."""
    desktop_dir = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "..", "..", "desktop_app")
    )
    if desktop_dir not in sys.path:
        sys.path.insert(0, desktop_dir)
    try:
        from aggregate_measures import calculate_resistance_summary  # type: ignore
        s = calculate_resistance_summary(rows, antibiotic_code)
        return {"numerator": s["numerator"], "denominator": s["denominator"], "score": s["score"]}
    except Exception:
        return _reference_summary(rows, antibiotic_code)


class ResistanceFormulaTests(SimpleTestCase):
    def test_site_payload_matches_desktop_contract(self):
        payload = site_resistance_payload(FIXTURE, "MEM")
        ref = _desktop_summary(FIXTURE, "MEM")
        self.assertEqual(payload["numerator"], ref["numerator"])
        self.assertEqual(payload["denominator"], ref["denominator"])
        self.assertEqual(payload["rate_percent"], ref["score"])
        self.assertEqual(payload["numerator"], 4)
        self.assertEqual(payload["denominator"], 8)
        self.assertEqual(payload["rate_percent"], 50.0)

    def test_intermediate_counts_in_denominator_not_numerator(self):
        rows = [
            {"antibiotic_results": {"MEM": {"result": "I"}}},
            {"antibiotic_results": {"MEM": {"result": "S"}}},
        ]
        payload = site_resistance_payload(rows, "MEM")
        self.assertEqual(payload["numerator"], 0)
        self.assertEqual(payload["denominator"], 2)
        self.assertEqual(payload["rate_percent"], 0.0)

    def test_by_origin_stratification(self):
        payload = site_resistance_payload(FIXTURE, "MEM")
        # HAI rows with an S/I/R MEM result: 2×R + 1×I (the "" and GEN rows are skipped).
        self.assertEqual(payload["by_origin"]["HAI"]["denominator"], 3)
        self.assertEqual(payload["by_origin"]["HAI"]["numerator"], 2)
        self.assertEqual(payload["by_origin"]["CAI"]["denominator"], 4)  # 2R + 2S
        self.assertEqual(payload["by_origin"]["CAI"]["numerator"], 2)

    def test_aggregate_across_sites_sums_and_wilson(self):
        p1 = dict(site_resistance_payload(FIXTURE, "MEM"), lab_code="A")
        p2 = dict(site_resistance_payload(FIXTURE, "MEM"), lab_code="B")
        agg = aggregate_resistance([p1, p2])
        self.assertEqual(agg["numerator"], 8)
        self.assertEqual(agg["denominator"], 16)
        self.assertEqual(agg["rate_percent"], 50.0)
        self.assertEqual(agg["n_sites"], 2)
        self.assertLess(agg["ci_low_percent"], 50.0)
        self.assertGreater(agg["ci_high_percent"], 50.0)

    def test_zero_denominator_is_safe(self):
        agg = aggregate_resistance([{"numerator": 0, "denominator": 0, "lab_code": "A"}])
        self.assertIsNone(agg["rate_percent"])
        self.assertEqual(agg["n_sites"], 0)


class RegistryTests(SimpleTestCase):
    def test_catalog_registered(self):
        self.assertIsNotNone(get("res_kpn_carbapenem"))
        self.assertGreater(len(all_metrics()), 15)

    def test_every_metric_is_self_documenting(self):
        for m in all_metrics():
            self.assertTrue(m.definition, f"{m.key} missing definition")
            self.assertTrue(m.formula, f"{m.key} missing formula")
            self.assertTrue(m.title, f"{m.key} missing title")
