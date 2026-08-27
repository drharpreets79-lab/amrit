"""Exhaustive filter schema for the analytics API.

Filters never reach the AMRIT site DB — they shape both:
  1. The query payload pushed to sites via the long-poll bridge, and
  2. The post-hoc filter applied to aggregate ``QueryResult`` rows already
     stored on the central server.

Adding a new filter only requires extending ``ANALYTICS_FILTERS`` and the
matching evaluator in ``apply_filters_to_buckets``.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, Dict, Iterable, List, Optional


@dataclass(frozen=True)
class FilterDef:
    name: str
    type: str  # "string", "list", "code", "date", "int", "bool", "enum"
    description: str
    enum: Optional[tuple] = None


ANALYTICS_FILTERS: tuple[FilterDef, ...] = (
    # -- Geography / org ---------------------------------------------------
    FilterDef("lab_code", "list", "Filter by AMRIT lab codes (multi-select)."),
    FilterDef("country", "list", "Filter by site country."),
    FilterDef("country_code", "list", "Filter by ISO 3166-1 alpha-3 country code."),
    FilterDef("admin_path", "list", "Filter by administrative path ('AAA/01'); selects that unit and everything under it, at any depth."),
    FilterDef("admin_code", "list", "Filter by administrative unit code at any level."),
    FilterDef("lab_domain", "list", "Filter by laboratory domain (Human, Animal, Environmental, Food)."),
    FilterDef("site_status", "enum", "Site lifecycle status.", enum=("active", "disabled", "provisioning")),
    # -- Clinical specimen / organism --------------------------------------
    FilterDef("organism", "list", "WHONET organism name (substring or list)."),
    FilterDef("organism_code", "list", "WHONET 5-letter organism code."),
    FilterDef("organism_group", "enum", "Higher-level grouping.",
              enum=("Enterobacterales", "Gram-negative", "Gram-positive", "Anaerobes", "Yeast", "Mycobacteria")),
    FilterDef("specimen_type", "list", "WHONET specimen type."),
    FilterDef("specimen_category", "enum", "Specimen category.",
              enum=("blood", "urine", "respiratory", "wound", "csf", "stool", "genital", "other")),
    FilterDef("antibiotic_code", "list", "WHONET antibiotic code(s) — required for resistance metrics."),
    FilterDef("antibiotic_class", "enum", "Antibiotic class.",
              enum=("beta_lactam", "carbapenem", "cephalosporin", "fluoroquinolone",
                    "aminoglycoside", "glycopeptide", "macrolide", "tetracycline",
                    "polymyxin", "oxazolidinone", "sulfonamide", "other")),
    FilterDef("result", "enum", "AST result interpretation.", enum=("R", "I", "S", "RIS")),
    # Options come from the deployment profile. A national body is not a universal enum.
    FilterDef("guideline", "enum", "Breakpoint guideline configured for this deployment."),
    FilterDef("guideline_year", "int", "Breakpoint guideline year (e.g. 2026)."),
    FilterDef("test_method", "enum", "AST method.", enum=("Disk diffusion", "MIC", "E-test", "Gradient strip", "Other")),
    # -- Patient demographics (aggregate-only) -----------------------------
    FilterDef("age_band", "enum", "Patient age band.",
              enum=("0-1", "1-5", "5-15", "15-45", "45-65", "65+", "unknown")),
    FilterDef("sex", "enum", "Patient sex.", enum=("M", "F", "U", "other")),
    FilterDef("pregnancy", "bool", "Pregnancy flag."),
    # -- Encounter / origin ------------------------------------------------
    FilterDef("location_type", "enum", "Encounter location.", enum=("in", "out", "icu", "ward", "ed", "community")),
    FilterDef("ward_type", "list", "Specific ward (ICU, NICU, MED, SURG, ...)."),
    FilterDef("infection_origin", "enum", "Origin classification.",
              enum=("HAI", "CAI", "HCAI", "Unknown")),
    FilterDef("admission_route", "enum", "Admission route.",
              enum=("ED", "OPD", "referral", "transfer", "other")),
    FilterDef("isolate_type", "enum", "Significance flag.",
              enum=("clinical", "screening", "surveillance", "quality_control")),
    FilterDef("first_isolate_only", "bool", "Apply WHONET 'first isolate per patient per organism' deduplication."),
    FilterDef("exclude_qc", "bool", "Drop quality-control isolates."),
    FilterDef("exclude_repeat", "bool", "Drop repeat isolates within 14 days."),
    # -- Resistance phenotype flags ---------------------------------------
    FilterDef("phenotype", "enum", "Resistance phenotype tag.",
              enum=("MRSA", "MSSA", "ESBL", "AmpC", "CRE", "CRAB", "CRPA", "VRE", "PNSP", "MDR", "XDR", "PDR")),
    FilterDef("multi_drug_resistant", "bool", "MDR flag (resistant to ≥1 drug in ≥3 classes)."),
    # -- Time --------------------------------------------------------------
    FilterDef("period_start", "date", "Inclusive start date (YYYY-MM-DD)."),
    FilterDef("period_end", "date", "Inclusive end date (YYYY-MM-DD)."),
    FilterDef("date_resolution", "enum", "Time-bucket resolution for trend output.",
              enum=("day", "week", "iso_week", "month", "quarter", "year")),
    # -- Aggregation / shaping --------------------------------------------
    FilterDef("group_by", "list", "Group buckets by listed dimensions (organism, specimen_type, location_type, ward_type, age_band, sex, admin_path, period)."),
    FilterDef("min_isolates", "int", "Suppress buckets with fewer than N isolates (k-anonymity floor)."),
    FilterDef("min_denominator", "int", "Suppress resistance rates whose denominator is below N."),
    FilterDef("include_zero_buckets", "bool", "Emit empty buckets for completeness."),
    # -- Output knobs ------------------------------------------------------
    FilterDef("output_format", "enum", "Response shape.", enum=("fhir_bundle", "json", "csv")),
    FilterDef("ci_method", "enum", "Confidence-interval method for proportions.",
              enum=("wilson", "exact", "none")),
    FilterDef("ci_level", "int", "Confidence level percent (e.g. 95)."),
)


FILTER_NAMES: frozenset[str] = frozenset(f.name for f in ANALYTICS_FILTERS)


def guideline_options() -> tuple[str, ...]:
    """Guideline bodies advertised and accepted by this deployment."""
    try:
        from central.country_profile import get_profile

        configured = get_profile().get("guidelines") or {}
        candidates = [
            configured.get("default"),
            *(configured.get("available") or []),
            configured.get("national_body"),
            "Other",
        ]
    except Exception:  # noqa: BLE001 - a bad profile must not break the filter catalogue
        candidates = ["EUCAST", "CLSI", "Other"]
    return tuple(dict.fromkeys(str(value).strip() for value in candidates if str(value or "").strip()))


def filters_catalog() -> List[Dict[str, Any]]:
    return [
        {
            "name": f.name,
            "type": f.type,
            "description": f.description,
            "enum": list(guideline_options() if f.name == "guideline" else f.enum or ()) or None,
        }
        for f in ANALYTICS_FILTERS
    ]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def parse_date(value: Any) -> Optional[date]:
    if not value:
        return None
    if isinstance(value, date):
        return value
    s = str(value).strip()[:10]
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def coerce_request_filters(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Validate + normalize a request's filter dict.

    Unknown keys are stripped silently. Lists may arrive as comma-separated
    strings (typical for query-string usage) and are split.
    """
    out: Dict[str, Any] = {}
    for definition in ANALYTICS_FILTERS:
        if definition.name not in raw:
            continue
        value = raw[definition.name]
        if value is None or value == "":
            continue
        if definition.type == "list":
            if isinstance(value, str):
                value = [item.strip() for item in value.split(",") if item.strip()]
            elif isinstance(value, (list, tuple)):
                value = [str(item).strip() for item in value if str(item).strip()]
            else:
                value = [str(value)]
        elif definition.type == "bool":
            value = str(value).strip().lower() in {"1", "true", "yes", "on"}
        elif definition.type == "int":
            try:
                value = int(value)
            except (TypeError, ValueError):
                continue
        elif definition.type == "date":
            parsed = parse_date(value)
            if not parsed:
                continue
            value = parsed.isoformat()
        elif definition.type == "enum":
            value = str(value).strip()
            allowed = guideline_options() if definition.name == "guideline" else definition.enum or ()
            if allowed and value not in allowed:
                continue
        else:
            value = str(value).strip()
        out[definition.name] = value
    return out


def project_to_amrit_query(filters: Dict[str, Any]) -> Dict[str, Any]:
    """Reduce a richer central-server filter set to the subset the AMRIT
    site protocol understands (organism, specimen_type, location_type,
    period_start, period_end). The remaining filters are applied
    centrally on the returned aggregate buckets."""
    keep = {"organism", "specimen_type", "location_type", "period_start", "period_end"}
    return {k: v for k, v in filters.items() if k in keep and not isinstance(v, list)}


def apply_filters_to_buckets(
    buckets: Dict[str, int],
    filters: Dict[str, Any],
) -> Dict[str, int]:
    """Apply post-aggregation filters that operate on bucket *labels* —
    e.g. ``organism`` substring filter, k-anonymity floor."""
    organism_filter: Iterable[str] = filters.get("organism", []) if isinstance(filters.get("organism"), list) else []
    min_isolates = int(filters.get("min_isolates") or 0)
    out: Dict[str, int] = {}
    for label, count in buckets.items():
        if organism_filter and not any(o.lower() in label.lower() for o in organism_filter):
            continue
        if min_isolates and count < min_isolates:
            continue
        out[label] = count
    return out
