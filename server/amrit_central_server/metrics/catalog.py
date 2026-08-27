"""Concrete AMR indicator catalog.

Each entry is a ``MetricDef`` registered once at import. Formulas follow the same
convention the desktop app uses in ``aggregate_measures.calculate_resistance_summary``:

    %R = R / (R + I + S) × 100

with the denominator restricted to isolates that carry an S/I/R interpretation,
first-isolate-per-patient-per-organism de-duplication honoured, and a two-sided
Wilson 95% confidence interval.

References: WHO GLASS core indicators, WHO Bacterial Priority Pathogens List
(BPPL 2024), national surveillance methodology, and CLSI/EUCAST breakpoints.
"""

from __future__ import annotations

from .registry import (
    FAMILY_ANTIBIOGRAM,
    FAMILY_BURDEN,
    FAMILY_COVERAGE,
    FAMILY_PHENOTYPE,
    FAMILY_RESISTANCE,
    SECTION_ADVANCED,
    SECTION_BASIC,
    MetricDef,
    register,
)

_RES_DEFINITION = (
    "The percentage of tested {org} isolates reported as resistant (R) to "
    "{abx}. Non-susceptible intermediate (I) isolates count toward the "
    "denominator but not the numerator."
)
_RES_FORMULA = "%R = R ÷ (R + I + S) × 100, with a Wilson 95% confidence interval."


def _resistance(
    key, org_code, org_name, abx_code, abx_name, *,
    section=SECTION_BASIC, specimen_category="", who_priority="", guideline="WHO GLASS",
    short=None, caveats="",
):
    default_filters = {"organism_code": org_code, "antibiotic_code": abx_code}
    scope_note = ""
    if specimen_category:
        default_filters["specimen_category"] = specimen_category
        scope_note = f" ({specimen_category} specimens only)"
    return register(MetricDef(
        key=key,
        title=f"{org_name} — {abx_name} resistance{scope_note}",
        short_label=short or f"{org_name.split()[0][0]}. {org_name.split()[-1][:12]} / {abx_name}",
        family=FAMILY_RESISTANCE,
        section=section,
        unit="%",
        definition=_RES_DEFINITION.format(org=org_name, abx=abx_name) + scope_note,
        formula=_RES_FORMULA,
        data_source="Federated resistance_rate pull from participating AMRIT sites; aggregate only.",
        query_type="resistance_rate",
        numerator_label=f"{org_name} isolates resistant to {abx_name}",
        denominator_label=f"{org_name} isolates with an S/I/R result for {abx_name}",
        organism_code=org_code,
        organism_name=org_name,
        antibiotic_code=abx_code,
        antibiotic_name=abx_name,
        default_filters=default_filters,
        guideline_ref=guideline,
        who_priority=who_priority,
        higher_is_worse=True,
        caveats=caveats or "Suppressed when the denominator is below the k-anonymity floor.",
    ))


# --------------------------------------------------------------------------- #
# Priority pathogen × antibiotic resistance (headline / GLASS core)           #
# --------------------------------------------------------------------------- #
_resistance("res_eco_carbapenem", "ECO", "Escherichia coli", "MEM", "Meropenem",
            who_priority="Critical", short="E. coli / Carbapenem")
_resistance("res_eco_3gc", "ECO", "Escherichia coli", "CRO", "Ceftriaxone",
            who_priority="Critical", short="E. coli / 3GC")
_resistance("res_eco_fq", "ECO", "Escherichia coli", "CIP", "Ciprofloxacin",
            section=SECTION_ADVANCED, short="E. coli / FQ")
_resistance("res_kpn_carbapenem", "KPN", "Klebsiella pneumoniae", "MEM", "Meropenem",
            who_priority="Critical", short="K. pneumoniae / Carbapenem")
_resistance("res_kpn_3gc", "KPN", "Klebsiella pneumoniae", "CRO", "Ceftriaxone",
            who_priority="Critical", short="K. pneumoniae / 3GC")
_resistance("res_kpn_colistin", "KPN", "Klebsiella pneumoniae", "COL", "Colistin",
            section=SECTION_ADVANCED, who_priority="Critical", short="K. pneumoniae / Colistin",
            caveats="Colistin should be confirmed by broth microdilution; disk diffusion is unreliable.")
_resistance("res_sau_mrsa", "SAU", "Staphylococcus aureus", "OXA", "Oxacillin (Methicillin)",
            who_priority="High", guideline="WHO GLASS · CLSI", short="S. aureus / MRSA",
            caveats="Oxacillin/cefoxitin non-susceptibility defines MRSA.")
_resistance("res_efm_vre", "EFM", "Enterococcus faecium", "VAN", "Vancomycin",
            who_priority="High", short="E. faecium / VRE")
_resistance("res_pae_carbapenem", "PAE", "Pseudomonas aeruginosa", "MEM", "Meropenem",
            who_priority="High", short="P. aeruginosa / Carbapenem")
_resistance("res_aba_carbapenem", "ABA", "Acinetobacter baumannii", "MEM", "Meropenem",
            who_priority="Critical", short="A. baumannii / Carbapenem")
_resistance("res_sat_fq", "SAT", "Salmonella Typhi", "CIP", "Ciprofloxacin",
            section=SECTION_ADVANCED, who_priority="High", short="S. Typhi / FQ")

# Bloodstream-infection variants (GLASS priority specimen)
_resistance("res_bsi_eco_carbapenem", "ECO", "Escherichia coli", "MEM", "Meropenem",
            specimen_category="blood", who_priority="Critical", short="BSI E. coli / Carbapenem")
_resistance("res_bsi_kpn_carbapenem", "KPN", "Klebsiella pneumoniae", "MEM", "Meropenem",
            specimen_category="blood", who_priority="Critical", short="BSI K. pneumoniae / Carbapenem")


# --------------------------------------------------------------------------- #
# Resistance phenotype prevalence                                             #
# --------------------------------------------------------------------------- #
def _phenotype(key, label, phenotype, definition, guideline="WHO GLASS · national programme methodology"):
    return register(MetricDef(
        key=key,
        title=f"{label} prevalence",
        short_label=label,
        family=FAMILY_PHENOTYPE,
        section=SECTION_ADVANCED,
        unit="%",
        definition=definition,
        formula=f"% = isolates flagged {label} ÷ isolates of the relevant organism tested × 100.",
        data_source="Federated resistance_rate / phenotype pull; aggregate only.",
        query_type="resistance_rate",
        numerator_label=f"Isolates meeting the {label} definition",
        denominator_label="Isolates of the relevant organism with a valid AST result",
        default_filters={"phenotype": phenotype},
        guideline_ref=guideline,
        higher_is_worse=True,
    ))


_phenotype("phen_esbl", "ESBL", "ESBL",
           "Extended-spectrum β-lactamase producers among Enterobacterales (E. coli, "
           "Klebsiella), typically flagged by 3rd-generation cephalosporin resistance with "
           "clavulanate synergy.")
_phenotype("phen_cre", "CRE", "CRE",
           "Carbapenem-resistant Enterobacterales — Enterobacterales non-susceptible to at "
           "least one carbapenem (meropenem, imipenem, ertapenem).")
_phenotype("phen_crab", "CRAB", "CRAB",
           "Carbapenem-resistant Acinetobacter baumannii.")
_phenotype("phen_crpa", "CRPA", "CRPA",
           "Carbapenem-resistant Pseudomonas aeruginosa.")
_phenotype("phen_mdr", "MDR", "MDR",
           "Multidrug-resistant — non-susceptible to at least one agent in three or more "
           "antimicrobial classes.")


# --------------------------------------------------------------------------- #
# Burden / volume                                                             #
# --------------------------------------------------------------------------- #
register(MetricDef(
    key="burden_isolates",
    title="Total isolates analysed",
    short_label="Isolates",
    family=FAMILY_BURDEN,
    section=SECTION_BASIC,
    unit="isolates",
    definition="Total number of first-isolate, non-QC bacterial isolates in scope for the period.",
    formula="Count of de-duplicated clinical isolates (first isolate per patient per organism).",
    data_source="Federated isolate_count pull; aggregate count only.",
    query_type="isolate_count",
    numerator_label="Isolates",
    denominator_label="",
    higher_is_worse=False,
    caveats="Excludes drafts, quality-control isolates, and repeat isolates within 14 days.",
))

register(MetricDef(
    key="burden_organism_mix",
    title="Organism distribution",
    short_label="Organism mix",
    family=FAMILY_BURDEN,
    section=SECTION_BASIC,
    unit="isolates",
    definition="Number of isolates by organism, showing which pathogens dominate the caseload.",
    formula="Count of isolates grouped by WHONET organism; k-anonymity floor applied per bucket.",
    data_source="Federated organism_distribution pull; aggregate buckets only.",
    query_type="organism_distribution",
    higher_is_worse=False,
))

register(MetricDef(
    key="burden_specimen_mix",
    title="Specimen distribution",
    short_label="Specimen mix",
    family=FAMILY_BURDEN,
    section=SECTION_ADVANCED,
    unit="isolates",
    definition="Number of isolates by specimen type (blood, urine, respiratory, …).",
    formula="Count of isolates grouped by WHONET specimen type; k-anonymity floor applied.",
    data_source="Federated specimen_distribution pull; aggregate buckets only.",
    query_type="specimen_distribution",
    higher_is_worse=False,
))


# --------------------------------------------------------------------------- #
# Antibiogram (organism × antibiotic %S grid)                                 #
# --------------------------------------------------------------------------- #
register(MetricDef(
    key="antibiogram",
    title="Cumulative antibiogram",
    short_label="Antibiogram",
    family=FAMILY_ANTIBIOGRAM,
    section=SECTION_ADVANCED,
    unit="grid",
    definition=(
        "Cumulative susceptibility grid: for each organism × antibiotic pair, the percentage "
        "of isolates susceptible (%S). The reference clinicians use to guide empiric therapy."
    ),
    formula="%S = S ÷ (R + I + S) × 100 per organism × antibiotic cell (CLSI M39 guidance).",
    data_source="Federated resistance_rate pulls per combination; aggregate only.",
    query_type="resistance_rate",
    guideline_ref="CLSI M39",
    higher_is_worse=False,
    caveats="Cells with a denominator below 30 isolates are shown but flagged as unreliable (CLSI M39).",
))


# --------------------------------------------------------------------------- #
# Coverage / data quality                                                     #
# --------------------------------------------------------------------------- #
register(MetricDef(
    key="cov_sites_reporting",
    title="Sites reporting",
    short_label="Reporting sites",
    family=FAMILY_COVERAGE,
    section=SECTION_BASIC,
    unit="sites",
    definition="Registered AMRIT sites that answered at least one aggregate query in the period.",
    formula="Distinct sites with ≥1 answered query dispatch ÷ registered active sites.",
    data_source="Server-side dispatch / result records (no patient data).",
    higher_is_worse=False,
))

register(MetricDef(
    key="cov_sites_online",
    title="Sites online now",
    short_label="Online now",
    family=FAMILY_COVERAGE,
    section=SECTION_BASIC,
    unit="sites",
    definition="Sites whose desktop app has contacted the server within the online window (5 min).",
    formula="Count of sites with last_seen_at within the online window.",
    data_source="Site heartbeat / poll timestamps.",
    higher_is_worse=False,
))

register(MetricDef(
    key="cov_geo",
    title="Geographic coverage",
    short_label="Administrative units covered",
    family=FAMILY_COVERAGE,
    section=SECTION_ADVANCED,
    unit="areas",
    definition="Distinct administrative units, at every level the country defines, with at least one participating site.",
    formula="Distinct administrative paths across active sites, counted per level.",
    data_source="Site registry.",
    higher_is_worse=False,
))

register(MetricDef(
    key="cov_ast_completeness",
    title="AST completeness",
    short_label="AST completeness",
    family=FAMILY_COVERAGE,
    section=SECTION_ADVANCED,
    unit="%",
    definition=(
        "Share of isolates that carry a valid antibiotic-susceptibility result — a data-quality "
        "guardrail. Low completeness means resistance rates rest on a thin denominator."
    ),
    formula="Isolates with ≥1 S/I/R AST result ÷ total isolates × 100.",
    data_source="Federated aggregate pull; counts only.",
    query_type="isolate_count",
    higher_is_worse=False,
))


# Pathogen–drug combos that make up the cumulative antibiogram grid rows/cols.
ANTIBIOGRAM_ORGANISMS = [
    ("ECO", "Escherichia coli"),
    ("KPN", "Klebsiella pneumoniae"),
    ("SAU", "Staphylococcus aureus"),
    ("PAE", "Pseudomonas aeruginosa"),
    ("ABA", "Acinetobacter baumannii"),
    ("EFM", "Enterococcus faecium"),
]
ANTIBIOGRAM_ANTIBIOTICS = [
    ("MEM", "Meropenem"),
    ("CRO", "Ceftriaxone"),
    ("CIP", "Ciprofloxacin"),
    ("GEN", "Gentamicin"),
    ("TZP", "Piperacillin-Tazobactam"),
    ("AMK", "Amikacin"),
]
