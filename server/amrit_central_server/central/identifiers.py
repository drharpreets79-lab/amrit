"""FHIR and schema identifiers, built from the active country profile.

These strings are wire-visible: every FHIR resource this server emits carries them, and
downstream consumers match on them. Changing a namespace after data has been exported
splits identifier continuity, which is why the profile treats it as a deliberate setting
rather than something derived.

The India profile reproduces the previously hardcoded values exactly, so existing
deployments emit byte-identical output.
"""

from __future__ import annotations

DEFAULT_BASE_URI = "https://amrit.invalid"
DEFAULT_URN_PREFIX = "urn:amrit"


def _namespace(profile: dict | None) -> dict:
    return (profile or {}).get("identifier_namespace") or {}


def base_uri(profile: dict | None = None) -> str:
    if profile is None:
        profile = _active_profile()
    return str(_namespace(profile).get("base_uri") or DEFAULT_BASE_URI).rstrip("/")


def urn_prefix(profile: dict | None = None) -> str:
    if profile is None:
        profile = _active_profile()
    return str(_namespace(profile).get("urn_prefix") or DEFAULT_URN_PREFIX).rstrip(":")


def _active_profile() -> dict | None:
    from .country_profile import ProfileError, get_profile

    try:
        return get_profile()
    except ProfileError:
        # A misconfigured profile must not stop an export; the reserved .invalid default
        # makes the unconfigured state obvious rather than silently borrowing a namespace.
        return None


def uri(*segments: str, profile: dict | None = None) -> str:
    """Build a canonical URI under the deployment's namespace."""
    path = "/".join(str(segment).strip("/") for segment in segments if str(segment).strip("/"))
    return f"{base_uri(profile)}/{path}" if path else base_uri(profile)


def urn(*segments: str, profile: dict | None = None) -> str:
    """Build a URN under the deployment's prefix, joining segments with colons."""
    tail = ":".join(str(segment).strip(":") for segment in segments if str(segment).strip(":"))
    return f"{urn_prefix(profile)}:{tail}" if tail else urn_prefix(profile)


# Named helpers, so the shape of each identifier lives in one place.
def lab_code_system(profile: dict | None = None) -> str:
    return uri("lab-code", profile=profile)


def measure_url(antibiotic_code: str, profile: dict | None = None) -> str:
    return uri("Measure", f"resistance-rate-{str(antibiotic_code).lower()}", profile=profile)


def proportion_ci_extension(profile: dict | None = None) -> str:
    return uri("StructureDefinition", "proportion-ci", profile=profile)


def bundle_identifier_system(profile: dict | None = None) -> str:
    return uri("bundle-id", profile=profile)


def aggregate_code_system(profile: dict | None = None) -> str:
    return uri("CodeSystem", "aggregate", profile=profile)
