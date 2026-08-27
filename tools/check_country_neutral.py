#!/usr/bin/env python3
"""Fail the build if country-specific values are hardcoded in shared code.

Country-specific data belongs in a country profile or a geo pack. This gate stops it
being reintroduced into application code, where it silently makes the product wrong for
every other country.

Deliberately narrow: it flags identifiers and values that would be *emitted* or *matched*,
not branding words in documentation, comments or curated profile files.

    python3 tools/check_country_neutral.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]

# Directories that legitimately contain country-specific values.
EXEMPT_DIRS = {
    "shared/country-profiles",   # the profiles themselves
    "shared/geo-packs",          # per-country geography
    "shared/address-formats",    # per-country postal form, one entry per country by design
    "docs",
    "architecture",
    "ops",
    "graphify-out",
    "app/out",
    "app/tests",                 # fixtures assert India's own values on purpose
    "app/release",
    "node_modules",
    ".venv",
    ".git",
    "staticfiles",
    "out",
    "release",
    "dist",
    "__pycache__",
}

# Files that hold India's own values by design, or record the history of this work.
EXEMPT_FILES = {
    "app/resources/catalog-seed.v1.json",
    "app/resources/catalog-seed.v2.json",
    "tools/check_country_neutral.py",
    "tools/split_catalog_seed.py",
    "shared/contracts/data-product.schema.json",      # frozen 1.0 contract
    "app/src/main/database.ts",   # reads the withdrawn columns once, to lift and drop them
    # Its subject is the withdrawn versions: it names the fields they carried so an
    # operator refused by it is told what to change.
    "server/amrit_central_server/ecosystem/contracts.py",
    # An explicitly India-only optional demonstration story, guarded against use by any
    # other deployment profile.
    "server/amrit_central_server/sites/management/commands/seed_demo.py",
    # The desktop's twin of the above: four named Indian metros with ISO 3166-2 codes to
    # match, so it is India's pack and no one else's. `seedDemoNetwork` refuses to seed it
    # under another country's profile rather than relabelling Delhi as somewhere else.
    "app/src/main/demo-population.ts",
}

# Files whose subject *is* the withdrawn vocabulary: the contract that documents the
# migration away from it, and the generator whose docstring explains what it replaces.
# Matched by suffix so the vendored copies under app/ and server/ are covered too.
EXEMPT_SUFFIXES = (
    "shared/contracts/canonical-event-2.0.schema.json",
    "tools/generate_address_formats.py",
)

SUFFIXES = {".py", ".ts", ".tsx", ".js", ".mjs", ".html", ".json"}

# Test modules assert the India profile's own values, which is the point of them.
TEST_PATTERNS = ("/tests/", "/test_", "tests.py", ".test.ts", ".test.tsx")

RULES: list[tuple[str, str, str]] = [
    (
        r"https://amrit\.icmr\.gov\.in",
        "hardcoded India FHIR namespace",
        "build it from the profile via central.identifiers / src/main/identifiers.ts",
    ),
    (
        r"urn:icmr:",
        "hardcoded India URN prefix",
        "build it from the profile via central.identifiers / src/main/identifiers.ts",
    ),
    (
        r"\bicmr-(navy|blue|orange|yellow|bg|grey)\b",
        "hardcoded India brand token",
        "use the brand-* tokens, whose values come from the profile",
    ),
    (
        r"22\.9734\s*,\s*78\.6569",
        "hardcoded India map centre",
        "read profile.map.center; the neutral fallback is a world view",
    ),
    (
        r"country\s*[:=]\s*['\"]IND['\"]",
        "hardcoded reporting country",
        "use the active profile's country_code",
    ),
    (
        r"\bcountry\s*[:=]\s*['\"]India['\"]",
        "hardcoded deployment country name",
        "use the active profile's country_name",
    ),
    (
        r"default:['\"]India \(national\)['\"]",
        "hardcoded India dashboard fallback",
        "derive the country label from the active profile",
    ),
    (
        r"publisher\s*:\s*['\"]Indian Council of Medical Research['\"]",
        "hardcoded India FHIR publisher",
        "read branding.authority_name from the active profile",
    ),
    (
        r"state__iexact|district__iexact",
        "scoping by administrative name",
        "use central.scopes.site_scope_q; name matching is ASCII-only and fails closed",
    ),
    (
        r"\b(state|district)_lgd_code\b|\bstate_code\b|\bdistrict_code\b",
        "a column named after one country's administrative tier",
        "use admin_unit_id / admin_path, or admin_codes[{level, code}] on the wire",
    ),
    (
        r"scope_type\s*[:=]\s*['\"](national|state|district)['\"]",
        "a scope stored under a withdrawn spelling",
        "store country / admin:<level>; the old words are accepted on input only",
    ),
    (
        r"['\"](state|district)_health_officer['\"]",
        "a role named after one country's administrative tier",
        "use admin_officer; its depth comes from the operator's own unit",
    ),
]


def in_exempt_dir(path: Path) -> bool:
    relative_path = path.relative_to(REPOSITORY_ROOT)
    relative = relative_path.as_posix()
    for exempt in EXEMPT_DIRS:
        # A one-part name such as node_modules or __pycache__ is exempt wherever a tool
        # created it, not just at repository root. Multi-part entries remain anchored so
        # an unrelated directory with the same leaf name is still scanned.
        if "/" not in exempt and exempt in relative_path.parts[:-1]:
            return True
        if relative == exempt or relative.startswith(f"{exempt}/"):
            return True
    return False


def main() -> int:
    findings: list[str] = []
    for path in REPOSITORY_ROOT.rglob("*"):
        if not path.is_file() or path.suffix not in SUFFIXES or in_exempt_dir(path):
            continue
        relative = path.relative_to(REPOSITORY_ROOT).as_posix()
        if relative in EXEMPT_FILES or relative.endswith(EXEMPT_SUFFIXES):
            continue
        # Migrations record what the schema used to be; that is their whole job.
        if "/migrations/" in f"/{relative}":
            continue
        if any(marker in f"/{relative}" for marker in TEST_PATTERNS):
            continue
        # Vendored copies of shared/ mirror exempt sources.
        if any(
            marker in f"/{relative}"
            for marker in ("/shared/country-profiles/", "/shared/geo-packs/", "/shared/address-formats/")
        ):
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        lines = text.splitlines()
        for pattern, what, fix in RULES:
            for match in re.finditer(pattern, text):
                line = text.count("\n", 0, match.start()) + 1
                # Prose is exempt: a comment explaining what a field replaced is how the
                # replacement stays understandable. Only emitted or matched values count.
                if lines[line - 1].lstrip().startswith(("#", "//", "*", "/*")):
                    continue
                findings.append(f"{relative}:{line}: {what} — {fix}")

    if findings:
        print(f"{len(findings)} country-specific value(s) hardcoded in shared code:", file=sys.stderr)
        for finding in sorted(findings):
            print(f"  - {finding}", file=sys.stderr)
        return 1
    print("country-neutral check passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
