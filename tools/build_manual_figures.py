#!/usr/bin/env python3
"""Draw the manual's figures.

Documentation tooling, not part of either product.

The figures are generated rather than drawn by hand for the same reason the screenshots are
captured rather than mocked up: a diagram that is edited in a drawing program drifts from
the system it claims to describe, and nobody notices until a reader follows it and is wrong.
Every box and arrow here names a real endpoint, table, command or module, so a figure that
goes stale fails review against the code it cites.

    python3 tools/build_manual_figures.py            # writes docs/manual/images/fig-*.png
"""

from __future__ import annotations

from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "manual" / "images"

# The deployment's own palette would be read from the country profile; these are the
# structural colours of the diagram itself — role, not brand.
NAVY = "#123a63"
BLUE = "#1f6fb2"
TEAL = "#0e7c7b"
AMBER = "#b3701a"
GREY = "#6b7785"
LIGHT = "#eef3f8"
LINE = "#c7d3e0"


def canvas(width: float, height: float):
    figure, axes = plt.subplots(figsize=(width, height), dpi=200)
    axes.set_xlim(0, 100)
    axes.set_ylim(0, 100)
    axes.axis("off")
    return figure, axes


def box(axes, x, y, w, h, title, lines=(), colour=BLUE, fill=LIGHT, fontsize=7.2, step=None):
    """One labelled block. `step` prints the ordinal a reader follows the figure by."""
    axes.add_patch(FancyBboxPatch(
        (x, y), w, h, boxstyle="round,pad=0.6,rounding_size=1.6",
        linewidth=1.15, edgecolor=colour, facecolor=fill,
    ))
    # A coloured spine, so a block's family is readable in greyscale print too.
    axes.add_patch(FancyBboxPatch(
        (x + 0.4, y + 0.8), 0.9, h - 1.6, boxstyle="round,pad=0.1,rounding_size=0.4",
        linewidth=0, facecolor=colour, alpha=0.85,
    ))
    heading = title if step is None else f"{step}. {title}"
    axes.text(x + w / 2, y + h - 3.2, heading, ha="center", va="top",
              fontsize=fontsize + 0.9, fontweight="bold", color=NAVY)
    for index, line in enumerate(lines):
        axes.text(x + w / 2, y + h - 7.6 - index * 3.5, line, ha="center", va="top",
                  fontsize=fontsize, color="#33414f")


def legend(axes, entries, y=2.0):
    """What the colours mean. A diagram that needs a key should carry one."""
    span = 96 / max(1, len(entries))
    for index, (colour, label) in enumerate(entries):
        x = 2 + index * span
        axes.add_patch(FancyBboxPatch((x, y), 2.2, 2.2, boxstyle="round,pad=0.1,rounding_size=0.5",
                                      linewidth=0, facecolor=colour))
        axes.text(x + 3.4, y + 1.1, label, ha="left", va="center", fontsize=6.3, color="#33414f")


def band(axes, y, h, label, colour="#f4f7fb"):
    """A horizontal zone — the tier a row of blocks belongs to."""
    axes.add_patch(FancyBboxPatch((1.5, y), 97, h, boxstyle="round,pad=0.3,rounding_size=1.0",
                                  linewidth=0, facecolor=colour))
    axes.text(97.5, y + h + 0.6, label, ha="right", va="bottom", fontsize=6.4,
              fontweight="bold", color=GREY)


def arrow(axes, start, end, label="", colour=GREY, style="-|>", offset=1.4, dashed=False):
    axes.add_patch(FancyArrowPatch(
        start, end, arrowstyle=style, mutation_scale=11, linewidth=1.2,
        color=colour, linestyle="--" if dashed else "-",
        connectionstyle="arc3,rad=0.0", shrinkA=2, shrinkB=2,
    ))
    if label:
        midpoint = ((start[0] + end[0]) / 2, (start[1] + end[1]) / 2 + offset)
        axes.text(midpoint[0], midpoint[1], label, ha="center", va="bottom",
                  fontsize=6.4, color=colour, style="italic")


def title(axes, text, subtitle=""):
    axes.text(50, 97, text, ha="center", va="top", fontsize=10.5, fontweight="bold", color=NAVY)
    if subtitle:
        axes.text(50, 92, subtitle, ha="center", va="top", fontsize=7, color=GREY)


def save(figure, name):
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"{name}.png"
    figure.savefig(path, bbox_inches="tight", facecolor="white")
    plt.close(figure)
    print(f"wrote {path.relative_to(ROOT)}")


# --------------------------------------------------------------------------- #
# Figure 1 — the boundary                                                      #
# --------------------------------------------------------------------------- #
def figure_architecture():
    figure, axes = canvas(9.6, 6.0)
    title(axes, "Figure 1. Where patient data stops",
          "Rows stay in the laboratory. Only counts and rates cross the line.")

    band(axes, 60, 26, "INSIDE THE LABORATORY", "#eef6f4")
    band(axes, 30, 26, "THE WIRE", "#fdf6ec")
    band(axes, 7, 22, "AT THE PROGRAMME", "#eef3f8")

    box(axes, 4, 62, 26, 21, "Sources", [
        "Manual entry · CSV / XLSX",
        "WHONET legacy files",
        "Sequencing and PCR results",
    ], colour=GREY, fill="#ffffff", fontsize=6.6, step=1)
    box(axes, 34, 62, 30, 21, "AMRIT desktop", [
        "Electron · SQLite · offline capable",
        "Patient rows, AST, identifiers",
        "Decision support + interpretation",
        "Local analysis and exports",
    ], colour=TEAL, fill="#ffffff", fontsize=6.6, step=2)
    box(axes, 68, 62, 28, 21, "Local answer", [
        "executeAggregateQuery()",
        "counts, rates, distributions",
        "k-anonymity applied here,",
        "before anything is sent",
    ], colour=TEAL, fill="#ffffff", fontsize=6.6, step=3)
    arrow(axes, (30, 72), (34, 72))
    arrow(axes, (64, 72), (68, 72))

    axes.plot([2, 98], [59, 59], color="#b03030", linewidth=1.8, linestyle=(0, (6, 4)))
    axes.text(50, 57.4, "TRUST BOUNDARY — no patient row, no identifier, no free text crosses",
              ha="center", va="top", fontsize=7.0, color="#b03030", fontweight="bold")

    box(axes, 4, 32, 43, 20, "Question in", [
        "GET /v1/poll  (long-poll, batched)",
        "WebSocket nudge for a live refresh",
        "Bearer token + out-of-band site token",
    ], colour=AMBER, fill="#ffffff", fontsize=6.6, step=4)
    box(axes, 53, 32, 43, 20, "Aggregate out", [
        "POST /v1/respond",
        "isolate_count · organism_distribution · specimen_distribution",
        "resistance_rate · measure_bundle (FHIR) · cluster_scan · heartbeat",
    ], colour=AMBER, fill="#ffffff", fontsize=6.6, step=5)
    arrow(axes, (25, 52), (25, 58), colour=AMBER)
    arrow(axes, (74, 58), (74, 52), colour=AMBER)

    box(axes, 4, 10, 29, 16, "Stored centrally", [
        "QueryResult · KPISnapshot",
        "No row-level data exists here",
    ], colour=BLUE, fill="#ffffff", fontsize=6.6, step=6)
    box(axes, 36, 10, 29, 16, "Computed", [
        "metrics registry · refresh_scope()",
        "Scoped: country / admin / site",
    ], colour=BLUE, fill="#ffffff", fontsize=6.6, step=7)
    box(axes, 68, 10, 28, 17, "Seen", [
        "Stakeholder dashboards",
        "Outbreak console · action plans",
        "Public summary · audit",
    ], colour=NAVY, fill="#ffffff", fontsize=6.6, step=8)
    arrow(axes, (33, 18), (36, 18))
    arrow(axes, (65, 18), (68, 18))
    arrow(axes, (74, 32), (74, 26), colour=AMBER)

    legend(axes, [(TEAL, "laboratory-held"), (AMBER, "federation channel"),
                  (BLUE, "programme-held aggregates"), (NAVY, "presented to people")], y=2.0)
    save(figure, "fig-architecture")


# --------------------------------------------------------------------------- #
# Figure 2 — enrolment and credentials                                         #
# --------------------------------------------------------------------------- #
def figure_enrolment():
    figure, axes = canvas(9.6, 6.2)
    title(axes, "Figure 2. Enrolment: nothing is granted by asking",
          "Device-flow shape — the laboratory mints its own bearer token; the portal stores only hashes.")

    lanes = [("Laboratory desktop", 15), ("Central portal", 50), ("Administrator", 85)]
    for label, x in lanes:
        axes.add_patch(FancyBboxPatch((x - 13, 86), 26, 6, boxstyle="round,pad=0.4,rounding_size=1.2",
                                      linewidth=1.0, edgecolor=LINE, facecolor="#f4f7fb"))
        axes.text(x, 89, label, ha="center", va="center", fontsize=7.4, fontweight="bold", color=NAVY)
        axes.plot([x, x], [14, 85], color=LINE, linewidth=1.0)

    steps = [
        (1, 79, "POST /api/v2/sites/register/", 15, 50, "lab code, address, admin units", BLUE),
        (2, 71, "pickup token — shown once", 50, 15, "only its hash is kept", TEAL),
        (3, 63, "queued in Registry → Requests", 50, 85, "SiteEnrolmentRequest · pending", GREY),
        (4, 55, "approve", 85, 50, "creates the Site, mints the site token", AMBER),
        (5, 47, "site token, out of band", 85, 15, "carried by the programme, not this channel", AMBER),
        (6, 39, "POST /fetch_site_token/", 15, 50, "lab code + pickup token", BLUE),
        (7, 31, "bearer token — once, single use", 50, 15, "stored in the OS credential vault", TEAL),
        (8, 22, "GET /v1/poll · POST /v1/respond", 15, 50, "both factors on every request", NAVY),
    ]
    for number, y, label, source, target, note, colour in steps:
        arrow(axes, (source, y), (target, y), colour=colour)
        axes.text((source + target) / 2, y + 1.8, f"{number}. {label}", ha="center",
                  fontsize=6.7, color=NAVY, fontweight="bold")
        axes.text((source + target) / 2, y - 2.9, note, ha="center", fontsize=6.0,
                  color=GREY, style="italic")

    axes.add_patch(FancyBboxPatch((5, 5), 90, 11, boxstyle="round,pad=0.5,rounding_size=1.2",
                                  linewidth=1.0, edgecolor=AMBER, facecolor="#fdf6ec"))
    axes.text(50, 12.4, "Two factors, two channels", ha="center", fontsize=7.2,
              fontweight="bold", color="#7a4d10")
    axes.text(50, 8.4, "A stolen bearer token is useless without the site token, and a stolen site token is useless without the bearer.\n"
                       "Approval is what creates the site; a re-approved laboratory must collect a new token before it can sync again.",
              ha="center", va="center", fontsize=6.4, color="#7a4d10")
    save(figure, "fig-enrolment")


# --------------------------------------------------------------------------- #
# Figure 3 — a dashboard refresh                                               #
# --------------------------------------------------------------------------- #
def figure_query_lifecycle():
    figure, axes = canvas(9.6, 5.6)
    title(axes, "Figure 3. One dashboard refresh, end to end",
          "The button dispatches a batch of questions; every laboratory answers from its own database.")

    band(axes, 56, 30, "PORTAL", "#eef3f8")
    band(axes, 26, 28, "LABORATORY", "#eef6f4")

    box(axes, 4, 58, 21, 25, "Refresh live", [
        "dashboards.views",
        ".refresh_live()",
        "scope from the viewer's",
        "role and admin unit",
    ], colour=BLUE, fill="#ffffff", fontsize=6.3, step=1)
    box(axes, 28, 58, 21, 25, "Dispatch", [
        "dispatch_live_pull()",
        "one Query per metric spec",
        "QueryDispatch per site",
        "TTL from settings",
    ], colour=BLUE, fill="#ffffff", fontsize=6.3, step=2)
    box(axes, 52, 58, 21, 25, "Wake + deliver", [
        "WebSocket nudge to",
        "sites that are online",
        "GET /v1/poll returns a",
        "batch, not one query",
    ], colour=AMBER, fill="#ffffff", fontsize=6.3, step=3)
    box(axes, 76, 58, 20, 25, "Roll up", [
        "refresh_scope()",
        "writes KPISnapshot",
        "per metric and scope",
        "with its computed_at",
    ], colour=NAVY, fill="#ffffff", fontsize=6.3, step=6)
    arrow(axes, (25, 70), (28, 70))
    arrow(axes, (49, 70), (52, 70))

    box(axes, 28, 29, 21, 22, "Check the allow-list", [
        "a query type this site",
        "has not allowed is",
        "refused and logged",
    ], colour=TEAL, fill="#ffffff", fontsize=6.3, step=4)
    box(axes, 52, 29, 21, 22, "Answer locally", [
        "aggregate over SQLite",
        "k-anonymity applied",
        "POST /v1/respond",
    ], colour=TEAL, fill="#ffffff", fontsize=6.3, step=5)
    arrow(axes, (62, 58), (62, 51), colour=AMBER)
    arrow(axes, (49, 40), (52, 40), colour=TEAL, style="<|-")
    arrow(axes, (73, 40), (86, 40), colour=TEAL)
    arrow(axes, (86, 40), (86, 58), colour=TEAL)

    axes.add_patch(FancyBboxPatch((4, 4), 92, 17, boxstyle="round,pad=0.5,rounding_size=1.2",
                                  linewidth=1.0, edgecolor=LINE, facecolor="#f6f8fa"))
    axes.text(50, 18.4, "Why a pull, and why a batch", ha="center", fontsize=7.2, fontweight="bold", color=NAVY)
    axes.text(50, 10.5,
              "A laboratory that pushed an extract would need a queue, a retry policy, a credential for the server and an inbound firewall exception.\n"
              "Here the desktop answers a question it has already allow-listed, computes it locally and forgets it — an unreachable site degrades the\n"
              "count, never the record. The batch matters too: a refresh asks sixteen questions, and one-per-poll made that sixteen round trips per site.",
              ha="center", va="center", fontsize=6.3, color="#33414f")
    save(figure, "fig-query-lifecycle")


# --------------------------------------------------------------------------- #
# Figure 4 — outbreak detection                                                #
# --------------------------------------------------------------------------- #
def figure_outbreak():
    figure, axes = canvas(9.6, 5.8)
    title(axes, "Figure 4. Outbreak signal: space–time permutation scan",
          "Kulldorff's case-only statistic — chosen because an AMR programme has cases, not denominators.")

    box(axes, 3, 64, 29, 22, "Input", [
        "Daily case counts by site,",
        "organism and phenotype",
        "(the cluster_scan aggregate)",
        "No patient rows, no population",
    ], colour=TEAL, fill="#ffffff", fontsize=6.4, step=1)
    box(axes, 35.5, 64, 29, 22, "Expected count", [
        "μ(s,t) = C(s)·C(t) / C",
        "site total × period total",
        "over the observed grid —",
        "no census denominator needed",
    ], colour=BLUE, fill="#ffffff", fontsize=6.4, step=2)
    box(axes, 68, 64, 29, 22, "Scan windows", [
        "every site × every window",
        "up to max_cluster_days",
        "prospective: only windows",
        "that end today",
    ], colour=BLUE, fill="#ffffff", fontsize=6.4, step=3)
    arrow(axes, (32, 75), (35.5, 75))
    arrow(axes, (64.5, 75), (68, 75))

    box(axes, 3, 36, 29, 24, "Test statistic", [
        "generalised likelihood ratio",
        "G = (c/μ)^c · ((C−c)/(C−μ))^(C−c)",
        "the largest G over all windows",
        "is the candidate cluster",
    ], colour=AMBER, fill="#ffffff", fontsize=6.4, step=4)
    box(axes, 35.5, 36, 29, 24, "Inference", [
        "999 Monte-Carlo permutations",
        "of dates within the grid",
        "p = (1 + #{G* ≥ G}) / (1 + M)",
        "multiple testing absorbed by",
        "the maximum statistic itself",
    ], colour=AMBER, fill="#ffffff", fontsize=6.4, step=5)
    box(axes, 68, 36, 29, 24, "Output", [
        "sites, window, observed cases,",
        "expected, ratio, p-value",
        "recurrence interval = 1/p",
        "draft action plan if a rule fires",
    ], colour=NAVY, fill="#ffffff", fontsize=6.4, step=6)
    arrow(axes, (17.5, 64), (17.5, 60))
    arrow(axes, (32, 48), (35.5, 48))
    arrow(axes, (64.5, 48), (68, 48))

    axes.add_patch(FancyBboxPatch((3, 4), 94, 27, boxstyle="round,pad=0.5,rounding_size=1.2",
                                  linewidth=1.0, edgecolor=LINE, facecolor="#f6f8fa"))
    axes.text(50, 28.6, "Why this method rather than the alternatives", ha="center",
              fontsize=7.2, fontweight="bold", color=NAVY)
    rows = [
        ("Poisson / Bernoulli spatial scan", "needs a population at risk per site — a programme has isolates, not catchments"),
        ("EWMA / CUSUM per series", "says when, never where; needs a stable per-site baseline that rarely exists"),
        ("Fixed rule (\"3 cases in 7 days\")", "transparent but scale-blind: floods a large site, stays silent at a small one"),
        ("Space–time permutation (chosen)", "conditions on both margins, so reporting effort cancels — as in WHONET / SaTScan"),
    ]
    for index, (method, why) in enumerate(rows):
        y = 23.4 - index * 4.6
        axes.text(6, y, method, ha="left", va="center", fontsize=6.4, fontweight="bold",
                  color=NAVY if index < 3 else TEAL)
        axes.text(38, y, why, ha="left", va="center", fontsize=6.3, color="#33414f")
    save(figure, "fig-outbreak")


# --------------------------------------------------------------------------- #
# Figure 5 — breakpoints                                                       #
# --------------------------------------------------------------------------- #
def figure_breakpoints():
    figure, axes = canvas(9.6, 5.4)
    title(axes, "Figure 5. From a published table to an interpreted result",
          "Every stage is refusable, and nothing interprets a result until a person activates it.")

    stages = [
        (2.5, "Fetch", ["EUCAST workbook —", "free, redistributable;", "or a CLSI file you supply"], TEAL),
        (18.7, "Parse", ["every banded section,", "footnote superscripts", "dropped, numbers only"], BLUE),
        (34.9, "Map", ["route and indication split", "from the agent; organism", "scopes as membership rules"], BLUE),
        (51.1, "Stage", ["versioned set, inactive;", "unmatched rows counted;", "source hash recorded"], AMBER),
        (67.3, "Activate", ["explicit, audited;", "refused while any row", "is still unmatched"], AMBER),
        (83.5, "Interpret", ["MIC or zone → S / I / R;", "a species row beats", "a group row"], NAVY),
    ]
    for index, (x, heading, lines, colour) in enumerate(stages):
        box(axes, x, 44, 14, 38, heading, lines, colour=colour, fill="#ffffff",
            fontsize=6.0, step=index + 1)
        if index < len(stages) - 1:
            arrow(axes, (x + 14, 63), (x + 16.2, 63))

    axes.add_patch(FancyBboxPatch((2.5, 5), 95, 33, boxstyle="round,pad=0.5,rounding_size=1.2",
                                  linewidth=1.0, edgecolor=LINE, facecolor="#f6f8fa"))
    axes.text(50, 35.4, "Design choices worth stating in a paper", ha="center",
              fontsize=7.2, fontweight="bold", color=NAVY)
    points = [
        "Guidelines are versioned data, not code: a set carries its source hash, edition and per-row provenance, so a result",
        "interpreted today can be re-read years later against the table that actually produced it.",
        "Group scopes (\"Enterobacterales\", \"Enterobacterales except Morganellaceae\") are predicates over the organism",
        "catalogue's taxonomy, not expanded species lists — a laboratory that adds an organism inherits the right breakpoints.",
        "Interpretation refuses rather than guesses: conflicting equally specific rows, or a route the record does not state,",
        "leave the result blank with a stated reason instead of picking one.",
    ]
    for index, line in enumerate(points):
        axes.text(50, 30.4 - index * 4.1, line, ha="center", va="center", fontsize=6.3,
                  color="#33414f", fontweight="bold" if index % 2 == 0 else "normal")
    save(figure, "fig-breakpoints")


# --------------------------------------------------------------------------- #
# Figure 6 — a record's life inside the laboratory                             #
# --------------------------------------------------------------------------- #
def figure_record_lifecycle():
    figure, axes = canvas(9.6, 5.6)
    title(axes, "Figure 6. A record's life inside the laboratory",
          "One validation path, whichever door the data comes in by.")

    box(axes, 3, 70, 27, 16, "Typed", ["Isolate records → New", "panel matched to organism"],
        colour=GREY, fill="#ffffff", fontsize=6.4, step=1)
    box(axes, 3, 50, 27, 16, "Imported", ["CSV / XLSX with a saved", "column mapping; previewed"],
        colour=GREY, fill="#ffffff", fontsize=6.4, step=1)
    box(axes, 3, 30, 27, 16, "WHONET legacy", ["existing data files and", "their code sets"],
        colour=GREY, fill="#ffffff", fontsize=6.4, step=1)

    box(axes, 36, 44, 28, 42, "Decision support", [
        "identity and duplicate check",
        "catalogue codes resolved",
        "breakpoint interpretation",
        "expected-resistance alerts",
        "expert phenotype rules",
        "contaminant flags",
        "",
        "refuses, or accepts as a draft —",
        "never writes a guessed value",
    ], colour=TEAL, fill="#ffffff", fontsize=6.4, step=2)
    for y in (78, 58, 38):
        arrow(axes, (30, y), (36, 65 if y == 58 else y))

    box(axes, 70, 62, 27, 24, "Stored locally", [
        "SQLite, on this computer",
        "audit entry per write",
        "retention clock starts",
    ], colour=BLUE, fill="#ffffff", fontsize=6.4, step=3)
    box(axes, 70, 34, 27, 24, "Used", [
        "Analytics · antibiogram",
        "indicators · local scan",
        "exports · federation answers",
    ], colour=NAVY, fill="#ffffff", fontsize=6.4, step=4)
    arrow(axes, (64, 74), (70, 74))
    arrow(axes, (83.5, 62), (83.5, 58))

    axes.add_patch(FancyBboxPatch((3, 4), 94, 22, boxstyle="round,pad=0.5,rounding_size=1.2",
                                  linewidth=1.0, edgecolor=LINE, facecolor="#f6f8fa"))
    axes.text(50, 23.4, "One path, deliberately", ha="center", fontsize=7.2, fontweight="bold", color=NAVY)
    axes.text(50, 13.5,
              "Imported and seeded records pass exactly the checks a typed record passes. A bulk-load path that skipped validation would\n"
              "make the largest datasets the least trustworthy ones — and those are the datasets a national figure is mostly made of.\n"
              "A record that fails is reported with its row number and reason, and lands as a draft rather than disappearing.",
              ha="center", va="center", fontsize=6.4, color="#33414f")
    save(figure, "fig-record-lifecycle")


# --------------------------------------------------------------------------- #
# Figure 7 — who sees what                                                     #
# --------------------------------------------------------------------------- #
def figure_roles():
    figure, axes = canvas(9.6, 5.4)
    title(axes, "Figure 7. Who sees what, and at which scope",
          "A role is a capability set, a dashboard composition and a scope — not a filter on one screen.")

    scopes = [
        (58, 30, "NATIONAL SCOPE", "#eef3f8"),
        (40, 16, "SUB-NATIONAL SCOPE — the viewer's own administrative unit", "#eef6f4"),
        (22, 16, "SINGLE FACILITY", "#fdf6ec"),
        (4, 16, "PUBLIC — suppressed, no site detail", "#f6f8fa"),
    ]
    for y, h, label, colour in scopes:
        band(axes, y, h, label, colour)

    roles = [
        (4, 73, 21, 13, "Policy maker", ["headline resistance,", "burden, coverage"], BLUE),
        (27, 73, 21, 13, "Public health expert", ["national profile,", "programme view"], BLUE),
        (50, 73, 21, 13, "Epidemiologist", ["phenotypes, signals,", "outbreak console"], NAVY),
        (73, 73, 23, 13, "Researcher", ["epidemiology view,", "no action queue"], NAVY),
        (4, 60, 92, 11, "Programme / super administrator",
         ["registry, enrolment approvals, queries, audit, deployment settings, users and roles"], TEAL),
        (4, 42, 92, 12, "Administrative health officer",
         ["the same dashboard at whatever level the viewer's unit sits; ranks one level down, whatever the country's tier count"], TEAL),
        (4, 24, 44, 12, "Hospital administrator",
         ["one facility, benchmarked", "against the national figure"], AMBER),
        (52, 24, 44, 12, "Laboratory (desktop operator)",
         ["holds the rows; answers only", "allow-listed query types"], AMBER),
        (4, 6, 92, 12, "Press · Citizen",
         ["the public summary only — national headline figures, nothing below the k-anonymity floor"], GREY),
    ]
    for x, y, w, h, name, lines, colour in roles:
        box(axes, x, y, w, h, name, lines, colour=colour, fill="#ffffff", fontsize=6.2)
    save(figure, "fig-roles")


def main() -> int:
    figure_architecture()
    figure_enrolment()
    figure_query_lifecycle()
    figure_outbreak()
    figure_breakpoints()
    figure_record_lifecycle()
    figure_roles()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
