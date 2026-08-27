"""Threshold rule engine.

Called after every ``KPISnapshot`` write (see ``dashboards.refresh``). For each
active ``ThresholdRule`` matching the snapshot's metric + scope, if the value
breaches the threshold and no open auto-plan already exists for that rule+scope,
a **draft** ``ActionPlan`` is created and seeded with the rule's action points.
Idempotent: re-running on the same breach does not duplicate plans.
"""

from __future__ import annotations

import logging

from .models import ActionPlan, ActionPoint, OPEN_STATUSES, ThresholdRule

LOG = logging.getLogger("amrit.actionplans")


def evaluate_snapshot(snapshot) -> list:
    """Evaluate all rules against one snapshot. Returns created ActionPlans."""
    value = snapshot.headline
    if value is None:
        return []

    rules = ThresholdRule.objects.filter(
        metric_key=snapshot.metric_key,
        scope_type=snapshot.scope_type,
        is_active=True,
    )
    created = []
    for rule in rules:
        if not rule.breached(value):
            continue
        exists = ActionPlan.objects.filter(
            threshold_rule=rule,
            scope_type=snapshot.scope_type,
            scope_value=snapshot.scope_value or "",
            status__in=OPEN_STATUSES,
        ).exists()
        if exists:
            continue
        created.append(_draft_plan(rule, snapshot, value))
    return created


def _draft_plan(rule: ThresholdRule, snapshot, value) -> ActionPlan:
    ctx = {
        "value": value,
        "threshold": rule.threshold,
        "metric": snapshot.metric_key,
        "scope": snapshot.scope_value or "national",
        "scope_type": snapshot.scope_type,
    }
    title = _fmt(rule.title_template, ctx) or f"{rule.name} — {ctx['scope']}"
    summary = _fmt(rule.body_template, ctx)

    plan = ActionPlan.objects.create(
        title=title,
        summary=summary,
        trigger_metric_key=snapshot.metric_key,
        trigger_snapshot=snapshot,
        threshold_rule=rule,
        observed_value=value,
        scope_type=snapshot.scope_type,
        scope_value=snapshot.scope_value or "",
        severity=rule.severity,
        status="draft",
        target_role=rule.target_role,
        is_auto=True,
    )
    for i, text in enumerate(rule.default_action_points or []):
        ActionPoint.objects.create(
            plan=plan, text=_fmt(str(text), ctx), owner_role=rule.target_role, order=i,
        )
    LOG.info("draft action plan raised: %s (%s=%.1f)", plan.title, snapshot.metric_key, value)
    return plan


def _fmt(template: str, ctx: dict) -> str:
    if not template:
        return ""
    try:
        return template.format(**ctx)
    except (KeyError, IndexError, ValueError):
        return template
