"""Seed threshold rules + manual-authoring templates for the action engine.

Idempotent. Each rule watches a headline resistance metric; a breach at the
given scope raises a draft ActionPlan pre-seeded with stewardship / IPC / lab
action points targeted at the relevant stakeholder role.
"""

from __future__ import annotations

from django.core.management.base import BaseCommand

from actionplans.models import ActionPlanTemplate, ThresholdRule

STEWARDSHIP = "Convene the AMR stewardship committee to review empiric-therapy guidance for {metric}."
IPC = "Reinforce infection-prevention & control bundles (hand hygiene, contact precautions) at affected sites."
LAB = "Verify laboratory AST quality (breakpoints, QC strains) and first-isolate de-duplication for {metric}."
REPORT = "File an Action-Taken Report with the resistance figure ({value}% observed) within 30 days."

RULES = [
    # (name, metric_key, scope_type, comparator, threshold, severity, target_role, title, points)
    ("Carbapenem-resistant Klebsiella — national alert", "res_kpn_carbapenem", "country", "gte", 30, "critical",
     "policy_maker", "National alert: carbapenem-resistant K. pneumoniae at {value}%",
     [STEWARDSHIP, IPC, LAB, REPORT]),
    ("Carbapenem-resistant Klebsiella — level-1 alert", "res_kpn_carbapenem", "admin:1", "gte", 30, "high",
     "admin_officer", "{scope}: carbapenem-resistant K. pneumoniae at {value}%",
     [STEWARDSHIP, IPC, LAB, REPORT]),
    ("MRSA — national watch", "res_sau_mrsa", "country", "gte", 30, "high",
     "policy_maker", "National watch: MRSA at {value}%",
     [STEWARDSHIP, IPC, REPORT]),
    ("Carbapenem-resistant E. coli — national alert", "res_eco_carbapenem", "country", "gte", 20, "critical",
     "policy_maker", "National alert: carbapenem-resistant E. coli at {value}%",
     [STEWARDSHIP, IPC, LAB, REPORT]),
    ("VRE — national watch", "res_efm_vre", "country", "gte", 25, "high",
     "epidemiologist", "National watch: vancomycin-resistant E. faecium at {value}%",
     [IPC, LAB, REPORT]),
    ("Hospital carbapenem-R Klebsiella", "res_kpn_carbapenem", "site", "gte", 40, "high",
     "hospital_admin", "Facility action: carbapenem-resistant K. pneumoniae at {value}%",
     [STEWARDSHIP, IPC, LAB, REPORT]),
]

TEMPLATES = [
    ("Stewardship review", "moderate",
     "Review empiric-therapy guidance in light of the observed resistance.",
     [STEWARDSHIP.replace(" for {metric}", ""), REPORT.replace(" ({value}% observed)", "")]),
    ("IPC escalation", "high",
     "Escalate infection-prevention & control measures at affected facilities.",
     [IPC, REPORT.replace(" ({value}% observed)", "")]),
]


class Command(BaseCommand):
    help = "Seed threshold rules + action-plan templates."

    def handle(self, *args, **opts):
        created = 0
        for name, key, scope, comp, thr, sev, role, title, points in RULES:
            _, was_created = ThresholdRule.objects.get_or_create(
                name=name,
                defaults=dict(
                    metric_key=key, scope_type=scope, comparator=comp, threshold=thr,
                    severity=sev, target_role=role, title_template=title,
                    body_template=("Observed {metric} = {value}% at {scope} scope, which meets or "
                                   "exceeds the {threshold}% action threshold. Draft plan for review."),
                    default_action_points=points,
                ),
            )
            created += int(was_created)
        self.stdout.write(self.style.SUCCESS(
            f"threshold rules: {created} created, {ThresholdRule.objects.count()} total"))

        t_created = 0
        for name, sev, summary, points in TEMPLATES:
            _, was = ActionPlanTemplate.objects.get_or_create(
                name=name, defaults=dict(severity=sev, summary=summary, default_action_points=points))
            t_created += int(was)
        self.stdout.write(self.style.SUCCESS(
            f"plan templates: {t_created} created, {ActionPlanTemplate.objects.count()} total"))
