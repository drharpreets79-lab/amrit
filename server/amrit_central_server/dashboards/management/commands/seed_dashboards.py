"""Seed synthetic KPISnapshots so dashboards are populated without live sites.

Idempotent-ish: clears prior ``source='seed'`` snapshots first, then writes a
fresh set for the country + a few level-1 units, one level-2 unit and one facility, including several
historical points so the trend line renders. Writing the latest snapshots runs
the threshold-rule engine, which auto-raises draft action plans.

    python manage.py seed_action_rules      # rules first
    python manage.py seed_dashboards        # then snapshots (+ auto plans)
"""

from __future__ import annotations

from datetime import timedelta

from django.core.management.base import BaseCommand
from django.utils import timezone

from analytics.fhir import wilson_ci
from actionplans.rules import evaluate_snapshot
from metrics import registry
from metrics.registry import FAMILY_PHENOTYPE, FAMILY_RESISTANCE
from dashboards.models import KPISnapshot

# Plausible India AMRSN-like headline resistance (%R).
BASE_RATES = {
    "res_eco_carbapenem": 14, "res_eco_3gc": 72, "res_eco_fq": 68,
    "res_kpn_carbapenem": 46, "res_kpn_3gc": 65, "res_kpn_colistin": 8,
    "res_sau_mrsa": 38, "res_efm_vre": 13, "res_pae_carbapenem": 22,
    "res_aba_carbapenem": 71, "res_sat_fq": 25,
    "res_bsi_eco_carbapenem": 16, "res_bsi_kpn_carbapenem": 50,
    "phen_esbl": 60, "phen_cre": 40, "phen_crab": 68, "phen_crpa": 21, "phen_mdr": 45,
}

# (scope_type, scope_value, rate multiplier, denominator scale)
# Scope values are administrative *codes*, which is what snapshots are keyed by; the demo
# ones are India's because the demo story is, but the shape names no country's levels.
SCOPES = [
    ("country", "", 1.00, 4200),
    ("admin:1", "29", 0.92, 900),
    ("admin:1", "27", 1.08, 1100),
    ("admin:1", "07", 1.15, 700),
    ("admin:2", "572", 0.95, 500),
    ("site", "NIMHANS-BLR", 0.98, 260),
]

ORGANISM_BUCKETS = {
    "Escherichia coli": 1320, "Klebsiella pneumoniae": 980, "Staphylococcus aureus": 640,
    "Pseudomonas aeruginosa": 410, "Acinetobacter baumannii": 360, "Enterococcus faecium": 210,
}
SPECIMEN_BUCKETS = {
    "Urine": 1500, "Blood": 1100, "Respiratory": 720, "Wound / pus": 540, "CSF": 90,
}


class Command(BaseCommand):
    help = "Seed synthetic KPI snapshots (and trigger auto action plans)."

    def handle(self, *args, **opts):
        KPISnapshot.objects.filter(source="seed").delete()
        now = timezone.now()
        written = 0
        latest_snaps = []

        for scope_type, scope_value, mult, den_scale in SCOPES:
            # Historical points (6 months back) for the trend metric only.
            for months_ago in range(6, 0, -1):
                when = now - timedelta(days=30 * months_ago)
                key = "res_kpn_carbapenem"
                drift = 1 + (6 - months_ago) * 0.03  # rising trend
                self._resistance_snapshot(key, scope_type, scope_value,
                                          BASE_RATES[key] * mult * drift, den_scale, when)
                written += 1

            # Current snapshots for every catalog metric.
            for metric in registry.all_metrics():
                snap = None
                if metric.family in (FAMILY_RESISTANCE, FAMILY_PHENOTYPE) and metric.key in BASE_RATES:
                    snap = self._resistance_snapshot(
                        metric.key, scope_type, scope_value,
                        BASE_RATES[metric.key] * mult, den_scale, now)
                elif metric.key == "burden_isolates":
                    snap = self._plain(metric.key, scope_type, scope_value,
                                       {"total": den_scale, "n_sites": 6 if scope_type == "country" else 1}, now)
                elif metric.key == "burden_organism_mix":
                    snap = self._plain(metric.key, scope_type, scope_value,
                                       self._scaled_buckets(ORGANISM_BUCKETS, den_scale), now)
                elif metric.key == "burden_specimen_mix":
                    snap = self._plain(metric.key, scope_type, scope_value,
                                       self._scaled_buckets(SPECIMEN_BUCKETS, den_scale), now)
                elif metric.key == "cov_sites_reporting":
                    total = 16 if scope_type == "country" else 3
                    snap = self._plain(metric.key, scope_type, scope_value,
                                       {"value": max(1, total - 1), "total": total,
                                        "rate_percent": round((total - 1) / total * 100, 1)}, now)
                elif metric.key == "cov_sites_online":
                    total = 16 if scope_type == "country" else 3
                    snap = self._plain(metric.key, scope_type, scope_value,
                                       {"value": total - 2, "total": total,
                                        "rate_percent": round((total - 2) / total * 100, 1)}, now)
                elif metric.key == "cov_ast_completeness":
                    snap = self._plain(metric.key, scope_type, scope_value,
                                       {"value": 87.5, "rate_percent": 87.5, "total": den_scale}, now)
                if snap is not None:
                    written += 1
                    latest_snaps.append(snap)

        # Fire the rule engine on the current snapshots -> draft action plans.
        plans = 0
        for snap in latest_snaps:
            plans += len(evaluate_snapshot(snap))

        self.stdout.write(self.style.SUCCESS(
            f"snapshots written: {written} · draft action plans raised: {plans}"))

    # -- helpers -----------------------------------------------------------
    def _resistance_snapshot(self, key, scope_type, scope_value, rate, den_scale, when):
        rate = round(min(rate, 99.0), 1)
        den = int(den_scale * 0.6)
        num = int(round(den * rate / 100))
        ci = wilson_ci(num, den)
        value = {
            "numerator": num, "denominator": den, "rate_percent": rate,
            "ci_low_percent": round(ci["low"] * 100, 2),
            "ci_high_percent": round(ci["high"] * 100, 2), "ci_level": ci["level"],
            "n_sites": 6 if scope_type == "country" else 1,
        }
        return self._plain(key, scope_type, scope_value, value, when)

    def _plain(self, key, scope_type, scope_value, value, when):
        return KPISnapshot.objects.create(
            metric_key=key, scope_type=scope_type, scope_value=scope_value or "",
            value_json=value, n_sites=value.get("n_sites", 0), source="seed",
            computed_at=when,
        )

    @staticmethod
    def _scaled_buckets(buckets, den_scale):
        factor = den_scale / 4200.0
        scaled = {k: max(1, int(v * factor)) for k, v in buckets.items()}
        return {"total": sum(scaled.values()), "buckets": scaled}
