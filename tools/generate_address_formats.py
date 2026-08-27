#!/usr/bin/env python3
"""Build the universal postal-address format pack.

Administrative geography and postal address are two different things, and this software
conflated them: a laboratory's location was a `state_lgd_code` plus a `district_lgd_code`
plus one free-text `address` blob. That is India's postal model with India's codes, and
it does not describe where a building is in Japan, Ireland or the United Arab Emirates.

The administrative tree (AdminUnit / admin_path) answers "which reporting unit is this
under". This pack answers the other question — "how is an address written here" — for
every country, so one address form and one stored shape work everywhere:

* which fields exist at all (Singapore has no admin area; Ireland has no postal code
  pattern in the usual sense; the UAE has no locality);
* which are required;
* what each is locally called — `state`, `prefecture`, `emirate`, `oblast`, `parish`,
  `post_town`, `eircode`, `pin` — so the form never says "State" to someone whose
  country has none;
* what order they are written in, and which are conventionally uppercased;
* the postal-code pattern, so a wrong code is caught at entry rather than at delivery.

Field names here are the neutral ISO 19160-1 / libaddressinput set, not the source's
internal spellings, and they map one-to-one onto FHIR R4 `Address`:

    address_lines      -> Address.line[]
    dependent_locality -> Address.district
    locality           -> Address.city
    admin_area         -> Address.state
    postal_code        -> Address.postalCode
    country_code       -> Address.country

Source: the Google Address Data Service dataset, as vendored by the `google-i18n-address`
package. Build-time dependency only — the generated pack is checked in, so nothing new
ships at runtime. Licence terms are recorded in shared/data-licences.json.

    pip install google-i18n-address
    python3 tools/generate_address_formats.py
    python3 tools/generate_address_formats.py --check
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
REFERENCE_PATH = REPOSITORY_ROOT / "shared" / "country-profiles" / "reference" / "countries.json"
OUTPUT_PATH = REPOSITORY_ROOT / "shared" / "address-formats" / "address-formats.v1.json"

DATASET = "amrit-address-formats"
VERSION = "google-address-data"

# Source token -> the neutral field name this software stores and emits. The source's own
# names ("country_area", "city_area", "company_name") describe one country's mental model;
# these are the ISO 19160-1 ones.
FIELD_BY_TOKEN = {
    "N": "recipient",
    "O": "organization",
    "A": "address_lines",
    "D": "dependent_locality",
    "C": "locality",
    "S": "admin_area",
    "Z": "postal_code",
    "X": "sorting_code",
}

# Order is significant: it is the order a form renders when a country has no format
# string of its own.
FIELD_ORDER = [
    "recipient",
    "organization",
    "address_lines",
    "dependent_locality",
    "locality",
    "admin_area",
    "postal_code",
    "sorting_code",
]

# The source records a local name only where it differs from the default; the defaults
# live in its ZZ entry and are repeated here so a caller never has to know that.
LABEL_KEY_BY_FIELD = {
    "admin_area": "state_name_type",
    "locality": "locality_name_type",
    "dependent_locality": "sublocality_name_type",
    "postal_code": "zip_name_type",
}


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def canonical_bytes(value: object) -> bytes:
    """Byte-identical to canonicalJson() in app/src/main/geo-pack.ts."""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def load_source():
    try:
        import i18naddress  # noqa: PLC0415 — build-time only, deliberately not imported at module scope
    except ImportError:  # pragma: no cover - depends on the build environment
        sys.exit(
            "google-i18n-address is not installed. It is a build-time dependency only:\n"
            "    pip install google-i18n-address\n"
            "The generated pack is checked in, so runtime does not need it."
        )
    return i18naddress.load_validation_data("all")


def fields_from(letters: str) -> list[str]:
    """'ACSZ' -> the neutral field names, in render order.

    Unknown letters are dropped rather than guessed at: a token this software cannot store
    must not silently become a field the form claims is required.
    """
    named = {FIELD_BY_TOKEN[letter] for letter in letters if letter in FIELD_BY_TOKEN}
    return [field for field in FIELD_ORDER if field in named]


def fields_in_format(format_string: str) -> list[str]:
    """The fields a country's format string actually places, in the order it places them."""
    seen: list[str] = []
    for token in re.findall(r"%([A-Z])", format_string or ""):
        field = FIELD_BY_TOKEN.get(token)
        if field and field not in seen:
            seen.append(field)
    return seen


def split_source_list(value: str | None) -> list[str]:
    return [part for part in str(value or "").split("~") if part]


def split_examples(value: str | None) -> list[str]:
    """Postal-code examples, which the source separates with commas, not tildes.

    Splitting these with the tilde rule returned the whole list as a single element, so a
    form offering "for example, {first}" showed an Indian operator `110034,110001` — two
    codes and a comma presented as one code. Ireland's `A65 F4E2` happens to contain no
    comma, which is why it looked correct wherever anyone checked.
    """
    return [part.strip() for part in str(value or "").split(",") if part.strip()]


def labels_for(entry: dict, defaults: dict) -> dict[str, str]:
    """The local name of every named field, defaults filled in.

    Always complete. A caller rendering a form must not have to decide what to call the
    admin area when the country did not say — and the answer is not "state".
    """
    return {
        field: entry.get(key) or defaults[key]
        for field, key in LABEL_KEY_BY_FIELD.items()
    }


def admin_area_iso_codes(entry: dict, alpha2: str) -> list[str]:
    """Full ISO 3166-2 codes for the level-1 subdivisions, where the source knows them.

    This is the join to the ISO 3166-2 geo pack: an address whose admin_area is one of
    these is the same real place as the AdminUnit carrying that code, so the two models
    line up instead of drifting.
    """
    return [f"{alpha2}-{suffix}" for suffix in split_source_list(entry.get("sub_isoids"))]


def build_country(entry: dict, defaults: dict, alpha2: str) -> dict:
    format_string = entry.get("fmt") or defaults["fmt"]
    required = fields_from(entry.get("require") or defaults["require"])
    used = fields_in_format(format_string)
    # A country can require a field its format string never places (the source has a few).
    # The form must still collect it, so the union is what "this country uses" means.
    used = used + [field for field in FIELD_ORDER if field in required and field not in used]
    return {
        "alpha2": alpha2,
        "format": format_string,
        # Present only where the country writes its address differently in Latin script.
        "latin_format": entry.get("lfmt") or None,
        "fields": [field for field in FIELD_ORDER if field in used],
        "required": required,
        "uppercase": fields_from(entry.get("upper") or defaults.get("upper") or ""),
        "labels": labels_for(entry, defaults),
        "postal_code_pattern": entry.get("zip") or None,
        "postal_code_examples": split_examples(entry.get("zipex")),
        "postal_code_prefix": entry.get("postprefix") or None,
        "language": entry.get("lang") or None,
        "languages": split_source_list(entry.get("languages")),
        "postal_authority_url": entry.get("posturl") or None,
        "admin_area_iso_codes": admin_area_iso_codes(entry, alpha2),
    }


def build_pack() -> dict:
    source = load_source()
    defaults = source["ZZ"]
    reference = json.loads(REFERENCE_PATH.read_text(encoding="utf-8"))

    countries: dict[str, dict] = {}
    missing: list[str] = []
    for country in reference["countries"]:
        if country.get("entry_type") != "country":
            continue
        alpha2, alpha3 = country.get("alpha2"), country["alpha3"]
        entry = source.get(alpha2) if alpha2 else None
        if entry is None:
            # Recorded rather than silently defaulted: an unknown country still gets a
            # working form from `default`, but the gap is visible in the pack itself.
            missing.append(alpha3)
            continue
        countries[alpha3] = build_country(entry, defaults, alpha2)

    body = {
        "dataset": DATASET,
        "version": VERSION,
        "schema_version": 1,
        "description": (
            "Per-country postal address form: which fields exist, which are required, "
            "what they are locally called, the order they are written in, and the postal "
            "code pattern. Field names are the ISO 19160-1 set and map one-to-one onto "
            "FHIR R4 Address."
        ),
        "field_tokens": dict(sorted(FIELD_BY_TOKEN.items())),
        "field_order": FIELD_ORDER,
        # Every country without an entry of its own renders from this, so a deployment in
        # a territory the dataset does not cover still has a usable address form.
        "default": build_country(defaults, defaults, ""),
        "countries": dict(sorted(countries.items())),
        "countries_without_source_entry": sorted(missing),
    }
    return {**body, "checksum": sha256_bytes(canonical_bytes(body))}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Fail if the checked-in pack differs from what this script would generate.",
    )
    args = parser.parse_args()

    pack = build_pack()
    rendered = json.dumps(pack, ensure_ascii=False, indent=2, sort_keys=True) + "\n"

    if args.check:
        if not OUTPUT_PATH.exists():
            print(f"missing: {OUTPUT_PATH.relative_to(REPOSITORY_ROOT)}", file=sys.stderr)
            return 1
        if OUTPUT_PATH.read_text(encoding="utf-8") != rendered:
            print(
                f"stale: {OUTPUT_PATH.relative_to(REPOSITORY_ROOT)} differs from the generated pack.\n"
                "Run: python3 tools/generate_address_formats.py",
                file=sys.stderr,
            )
            return 1
        print(f"up to date: {len(pack['countries'])} countries")
        return 0

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(rendered, encoding="utf-8")

    covered = len(pack["countries"])
    gaps = pack["countries_without_source_entry"]
    print(f"wrote {OUTPUT_PATH.relative_to(REPOSITORY_ROOT)}")
    print(f"  {covered} countries with their own format")
    print(f"  {len(gaps)} falling back to the default form" + (f": {', '.join(gaps)}" if gaps else ""))
    print(f"  checksum {pack['checksum'][:16]}…")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
