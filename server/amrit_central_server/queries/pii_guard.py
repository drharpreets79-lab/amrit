"""Defense-in-depth PII filter.

Sites already redact patient-level fields before responding. The server
adds a second layer: every JSON response posted to ``/v1/respond`` is
walked recursively and any banned key triggers a 422. Banned values
inside string fields are also masked.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Iterable

from django.http import JsonResponse
from django.utils.deprecation import MiddlewareMixin

from .fhir_validation import validate_aggregate_fhir_bundle

LOG = logging.getLogger("amrit.pii")

def profile_banned_identifier_keys() -> set[str]:
    """National identifier field names to reject, from the active country profile.

    Each country contributes its own national identifiers. Generic direct-identifier keys
    always apply, so changing country never weakens the common guard.
    """
    try:
        from central.country_profile import get_profile

        return {normalize_key(str(key)) for key in (get_profile().get("banned_identifier_keys") or [])}
    except Exception:  # noqa: BLE001 - never let a profile problem disable the guard
        return set()


BANNED_KEYS: frozenset[str] = frozenset(
    {
        # direct identifiers
        "patient_id",
        "patientid",
        "patient_name",
        "patient",
        "name",
        "first_name",
        "last_name",
        "given_name",
        "family_name",
        "middle_name",
        "full_name",
        "dob",
        "date_of_birth",
        "birthdate",
        "birth_date",
        "ssn",
        "national_id",
        "passport",
        "mrn",
        "phone",
        "phone_number",
        "mobile",
        "email",
        "address",
        "street",
        "postal_code",
        "zip",
        "zipcode",
        "specimen_id",
        "accession_number",
        "barcode",
        "lab_internal_id",
        "guardian_name",
        "next_of_kin",
        "ip_address",
        "device_id",
        "geolocation",
        "gps",
        "lat",
        "lng",
        # A facility's resolved coordinate. It is legitimate on a Site and never in an
        # aggregate result: the block is on the container rather than on `latitude` and
        # `longitude` themselves, because a site's own consented GPS reading travels under
        # those names on the polling endpoint and must keep working.
        "geo_point",
        "geopoint",
        "coordinates",
    }
)

# Common formats that should never appear in aggregate payloads. These are
# *additive* checks on string content — the key-name block is the primary
# guard.
PII_CONTENT_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE),  # email
    re.compile(r"\b\d{12}\b"),  # long national-identifier-like decimal token
    re.compile(r"\b\+?\d{10,15}\b"),  # phone-ish
)

SAFE_TERMINOLOGY_SYSTEMS: frozenset[str] = frozenset(
    {
        "http://snomed.info/sct",
        "http://loinc.org",
        "http://unitsofmeasure.org",
        "http://terminology.hl7.org/CodeSystem/v2-0074",
        "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation",
        "urn:whonet:organism-code",
        "urn:whonet:specimen-code",
        "urn:whonet:antibiotic-code",
    }
)


class PIIViolation(ValueError):
    """Raised when a banned identifier is encountered."""


def scan_payload(payload: Any, *, path: str = "$") -> list[str]:
    """Walk an arbitrary JSON-ish payload and collect violation paths."""
    violations: list[str] = []
    _scan(payload, path, violations)
    return violations


def normalize_key(key: str) -> str:
    """Fold a key to the one spelling the blocklist is written in.

    Case, hyphens and camelCase all name the same field, and the blocklist cannot list
    every spelling of every entry. FHIR writes ``postalCode``; a payload using it slipped
    past a blocklist containing ``postal_code`` until this existed.
    """
    text = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", str(key).strip())
    return text.lower().replace("-", "_").replace(" ", "_")


# Key stems whose every extension is an identifier too.
#
# Exact matching on a fixed list is what the blocklist above does, and Study C measured what it
# costs: `address` was blocked and `address_line1` was not, which is the spelling most laboratory
# systems and every HL7 v2 PID-11 mapping actually use. A stem check closes the family rather
# than the one spelling somebody thought of. Kept deliberately short, because a stem matches
# aggressively and a false positive rejects a legitimate aggregate, which is the worse failure.
BANNED_KEY_STEMS: tuple[str, ...] = (
    "address",
    "addr_",
    "street",
    "postal",
    "patient_name",
    "guardian",
)


def key_is_banned(normalized: str) -> bool:
    """Whether a normalised key is an identifier by exact match or by family."""
    if normalized in BANNED_KEYS or normalized in profile_banned_identifier_keys():
        return True
    return any(
        normalized == stem or normalized.startswith(stem)
        for stem in BANNED_KEY_STEMS
    )


# ISO-8601 dates, masked out before the content patterns run.
#
# A date range carries enough digits to look like a telephone number once separators are
# ignored, and an aggregate legitimately carries dates. Masking them first is what lets the
# telephone pattern tolerate separators without rejecting "2026-01-01 to 2026-03-31".
_ISO_DATE = re.compile(r"\b\d{4}-\d{2}-\d{2}\b")
_SEPARATORS = re.compile(r"[\s().\-]")


def content_is_banned(value: str) -> bool:
    """Whether a string carries an identifier, tolerating the separators people type.

    Study C measured the gap this closes: `+919876543210` was rejected and
    `+91 98765 43210` was not, though they are the same number. The patterns are applied
    both to the string as written and to a separator-stripped copy with dates removed.
    """
    for pattern in PII_CONTENT_PATTERNS:
        if pattern.search(value):
            return True
    compressed = _SEPARATORS.sub("", _ISO_DATE.sub(" ", value))
    return any(pattern.search(compressed) for pattern in PII_CONTENT_PATTERNS)


def _scan(node: Any, path: str, violations: list[str]) -> None:
    if isinstance(node, dict):
        coding_system = str(node.get("system") or "")
        for key, value in node.items():
            normalized = normalize_key(key)
            child_path = f"{path}.{key}"
            if key_is_banned(normalized):
                violations.append(child_path)
                continue
            if normalized == "code" and coding_system in SAFE_TERMINOLOGY_SYSTEMS:
                continue
            _scan(value, child_path, violations)
    elif isinstance(node, list):
        for index, item in enumerate(node):
            _scan(item, f"{path}[{index}]", violations)
    elif isinstance(node, str):
        if content_is_banned(node):
            violations.append(f"{path}~content")
            return


def assert_aggregate_only(payload: Any, *, source: str = "site response") -> None:
    """Raise PIIViolation if banned keys / content are present."""
    if isinstance(payload, dict) and payload.get("resourceType") == "Bundle":
        errors = validate_aggregate_fhir_bundle(payload)
        if errors:
            raise PIIViolation(f"{source} contained unsafe FHIR: {', '.join(errors[:5])}")
        return
    issues = scan_payload(payload)
    if issues:
        LOG.warning("PII guard rejected %s: %s", source, issues[:5])
        raise PIIViolation(f"{source} contained disallowed identifiers: {', '.join(issues[:5])}")


class PIIGuardMiddleware(MiddlewareMixin):
    """Block patient-level identifiers in AMRIT site response payloads.

    Scope: only the AMRIT site-facing endpoint ``/v1/respond`` is guarded.
    Analyst CRUD on Sites and Queries (where ``name`` legitimately means
    lab name, not patient name) is left alone. The whitelist below can be
    extended for future site-facing endpoints.
    """

    SAFE_METHODS: Iterable[str] = ("GET", "HEAD", "OPTIONS")
    GUARDED_PATHS: tuple[str, ...] = ("/v1/respond",)

    def process_request(self, request):
        if request.method in self.SAFE_METHODS:
            return None
        if not any(request.path.startswith(prefix) for prefix in self.GUARDED_PATHS):
            return None
        ctype = request.META.get("CONTENT_TYPE", "")
        if "application/json" not in ctype.lower():
            return None
        body = getattr(request, "body", b"") or b""
        if not body:
            return None
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None
        # Only the inner ``result`` object is patient-derived; the envelope
        # itself uses keys like "ok"/"timestamp"/"query_id".
        target = payload.get("result") if isinstance(payload, dict) else payload
        try:
            if target is not None:
                assert_aggregate_only(target, source=f"{request.method} {request.path} result")
            if isinstance(payload, dict) and payload.get("fhir_bundle") is not None:
                assert_aggregate_only(
                    payload["fhir_bundle"],
                    source=f"{request.method} {request.path} fhir_bundle",
                )
        except PIIViolation as exc:
            return JsonResponse(
                {"error": "pii_guard_rejected", "detail": str(exc)},
                status=422,
            )
        return None
