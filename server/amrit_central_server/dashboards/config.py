"""Per-stakeholder dashboard configuration.

Each entry declares which metrics appear in the **Basic** section (headline
tiles + one map + one trend) and the **Advanced** section (full antibiogram,
phenotype detail, distributions, coverage), plus the panels to render. The view
is generic; this dict is the only thing that differs per role, which keeps every
dashboard consistent and self-documenting.
"""

from __future__ import annotations

# Headline resistance combos most stakeholders lead with.
_HEADLINE = [
    "res_kpn_carbapenem",
    "res_eco_carbapenem",
    "res_sau_mrsa",
    "res_efm_vre",
    "res_aba_carbapenem",
    "res_eco_3gc",
]

_ADVANCED_RESISTANCE = [
    "res_eco_carbapenem", "res_eco_3gc", "res_eco_fq",
    "res_kpn_carbapenem", "res_kpn_3gc", "res_kpn_colistin",
    "res_sau_mrsa", "res_efm_vre", "res_pae_carbapenem",
    "res_aba_carbapenem", "res_sat_fq",
    "res_bsi_eco_carbapenem", "res_bsi_kpn_carbapenem",
]

_PHENOTYPES = ["phen_esbl", "phen_cre", "phen_crab", "phen_crpa", "phen_mdr"]


DASHBOARDS = {
    "country": {
        "title": "National AMR Intelligence Dashboard",
        "subtitle": "Country-wide antimicrobial resistance for policy and programme decisions.",
        "scope": "country",
        "basic_tiles": _HEADLINE + ["burden_isolates", "cov_sites_reporting"],
        "trend_metric": "res_kpn_carbapenem",
        "advanced_resistance": _ADVANCED_RESISTANCE,
        "advanced_phenotypes": _PHENOTYPES,
        "panels": {"map": True, "ranking": "auto", "antibiogram": True,
                    "distributions": True, "coverage": True},
    },
    # One dashboard for every sub-national level. It takes its level from the viewer's own
    # administrative unit, so a country with five levels needs five *units*, not five
    # dashboards — and a country with one is not shown a "district" it does not have. The
    # title is filled in from the country profile's label for that level.
    "admin": {
        "title": "{level} AMR Dashboard",
        "subtitle": "Antimicrobial resistance across the sites reporting from your area.",
        "scope": "admin",
        "basic_tiles": _HEADLINE + ["burden_isolates", "cov_sites_reporting"],
        "trend_metric": "res_kpn_carbapenem",
        "advanced_resistance": _ADVANCED_RESISTANCE,
        "advanced_phenotypes": _PHENOTYPES,
        "panels": {"map": True, "ranking": "auto", "antibiogram": True,
                    "distributions": True, "coverage": True},
    },
    "epidemiologist": {
        "title": "Epidemiology & Surveillance Dashboard",
        "subtitle": "Priority-pathogen signals, phenotype trends, and resistance anomalies.",
        "scope": "country",
        "basic_tiles": _HEADLINE + ["phen_cre", "phen_mdr"],
        "trend_metric": "res_kpn_carbapenem",
        "advanced_resistance": _ADVANCED_RESISTANCE,
        "advanced_phenotypes": _PHENOTYPES,
        "panels": {"map": True, "ranking": "auto", "antibiogram": True,
                    "distributions": True, "coverage": True, "signals": True},
    },
    "hospital": {
        "title": "Hospital AMR Dashboard",
        "subtitle": "Your facility's resistance profile, benchmarked against the nation.",
        "scope": "site",
        "basic_tiles": _HEADLINE + ["burden_isolates", "cov_ast_completeness"],
        "trend_metric": "res_kpn_carbapenem",
        "advanced_resistance": _ADVANCED_RESISTANCE,
        "advanced_phenotypes": _PHENOTYPES,
        "panels": {"map": False, "ranking": None, "antibiogram": True,
                    "distributions": True, "coverage": True, "benchmark": True},
    },
}


# Withdrawn dashboard names, kept as redirects only. A bookmark or a link in an old email
# should land somewhere, and both of these named a tier rather than a kind of dashboard.
DASHBOARD_ALIASES = {"national": "country", "state": "admin", "district": "admin"}


def ranking_child_scope(dashboard_kind: str, profile: dict | None = None,
                        scope_type: str | None = None) -> str | None:
    """The scope a dashboard ranks one level down.

    ``"auto"`` in the panel config means "one below whatever the viewer is looking at",
    which is the only definition that holds when the viewer's level is not known until they
    sign in. The chain comes from the country profile, so a three-level country drills
    country -> admin:1 -> admin:2 -> admin:3 -> site and a one-level country stops sooner —
    and the bottom of the chain returns nothing rather than an empty ranking panel.
    """
    from central.scopes import canonical_scope_type, child_scope

    config = DASHBOARDS.get(dashboard_kind) or {}
    configured = (config.get("panels") or {}).get("ranking")
    if not configured:
        return None
    if configured != "auto":
        return canonical_scope_type(configured)
    return child_scope(scope_type or config.get("scope", "country"), profile)
