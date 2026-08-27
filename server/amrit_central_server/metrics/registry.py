"""Declarative registry of every dashboard metric.

A ``MetricDef`` is the single source of truth for a dashboard item: its title,
plain-language **definition**, the **calculation** (numerator / denominator /
formula), the data source, the WHONET query type that feeds it, and the
guideline reference. Every chart, table, and infographic renders its definition
and formula straight from here, so the dashboards are self-documenting — there
is no place for a number to appear without an attached definition.

The registry holds *no data*. It only describes how a number is defined and
computed. Values live in ``dashboards.KPISnapshot`` (computed from live/federated
pulls) — never patient rows.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional


# Metric families — drive grouping + which compute routine runs.
FAMILY_RESISTANCE = "resistance"        # %R for an organism × antibiotic combo
FAMILY_PHENOTYPE = "phenotype"          # ESBL / CRE / MRSA … prevalence
FAMILY_BURDEN = "burden"                # isolate / organism / specimen counts
FAMILY_COVERAGE = "coverage"            # sites reporting, completeness, QC
FAMILY_ANTIBIOGRAM = "antibiogram"      # organism × antibiotic %S grid

SECTION_BASIC = "basic"
SECTION_ADVANCED = "advanced"


@dataclass(frozen=True)
class MetricDef:
    key: str
    title: str
    short_label: str
    family: str
    section: str                        # default placement: basic | advanced
    unit: str                           # "%", "isolates", "sites", "grid"
    definition: str                     # plain-language "what is this number"
    formula: str                        # human-readable calculation
    data_source: str                    # where the raw numbers come from
    query_type: str = ""                # SUPPORTED_QUERY_TYPE that feeds it
    numerator_label: str = ""
    denominator_label: str = ""
    organism_code: str = ""             # for resistance / phenotype combos
    organism_name: str = ""
    antibiotic_code: str = ""
    antibiotic_name: str = ""
    default_filters: Dict = field(default_factory=dict)
    guideline_ref: str = ""             # GLASS / national programme / CLSI / EUCAST / WHO PPL
    who_priority: str = ""              # WHO priority-pathogen tier, if any
    higher_is_worse: bool = True        # colour direction for the tile
    caveats: str = ""

    # ---- self-documentation helpers used by templates -------------------
    def as_definition_dict(self) -> Dict:
        return {
            "key": self.key,
            "title": self.title,
            "definition": self.definition,
            "formula": self.formula,
            "numerator": self.numerator_label,
            "denominator": self.denominator_label,
            "unit": self.unit,
            "data_source": self.data_source,
            "guideline_ref": self.guideline_ref,
            "who_priority": self.who_priority,
            "caveats": self.caveats,
        }


# Populated by metrics.catalog at import time.
_REGISTRY: Dict[str, MetricDef] = {}


def register(metric: MetricDef) -> MetricDef:
    if metric.key in _REGISTRY:
        raise ValueError(f"duplicate metric key: {metric.key}")
    _REGISTRY[metric.key] = metric
    return metric


def get(key: str) -> Optional[MetricDef]:
    return _REGISTRY.get(key)


def all_metrics() -> List[MetricDef]:
    return list(_REGISTRY.values())


def by_family(family: str) -> List[MetricDef]:
    return [m for m in _REGISTRY.values() if m.family == family]


def by_keys(keys: List[str]) -> List[MetricDef]:
    return [_REGISTRY[k] for k in keys if k in _REGISTRY]


def definitions_catalog() -> List[Dict]:
    """Everything the UI needs to render an 'ⓘ Definition' popover per item."""
    return [m.as_definition_dict() for m in _REGISTRY.values()]
