"""Validation for administrator-supplied deployment settings.

Everything here is reached from a form an administrator fills in, and the values end up in
FHIR output, in `<img src>`, and in map tile requests. The rules below are load-bearing,
not hardening:

* an uploaded logo is rendered into an authenticated admin page and, on this server, into
  the public dashboard — so SVG is refused outright, the bytes are checked rather than the
  filename, and the image is re-encoded so the stored file is one this codebase produced;
* URLs are restricted to https, because a ``javascript:`` or ``data:`` value would execute
  where these are rendered;
* changing the identifier namespace is not fully reversible — FHIR bundles already
  exported carry the old system URIs — so the change is stamped with an effective-from
  timestamp and the caller is expected to confirm it.
"""

from __future__ import annotations

import io
import json
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from django.core.exceptions import ValidationError
from django.utils import timezone

# Formats a browser renders as an image and nothing else. SVG is deliberately absent: it
# is an executable document, and sanitising it safely is a larger problem than it looks.
ALLOWED_IMAGE_FORMATS = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}
MAX_LOGO_BYTES = 2 * 1024 * 1024
MAX_LOGO_PIXELS = 4096

# Magic bytes, so a file is judged by its content rather than by its name or the
# Content-Type the browser volunteered.
IMAGE_SIGNATURES = (
    (b"\x89PNG\r\n\x1a\n", "PNG"),
    (b"\xff\xd8\xff", "JPEG"),
    (b"RIFF", "WEBP"),  # followed by 'WEBP' at offset 8; checked below
)

# Fields an administrator may change at runtime. Anything absent here is either derived or
# fixed at build time (appId and the code-signing identity are OS-level and cannot change
# without a rebuild and a re-sign).
EDITABLE_FIELDS = {
    "country_name", "locale", "fallback_locales", "text_direction", "numbering_system",
    "timezone", "calendar", "date_input_order", "first_day_of_week", "epi_week_system",
    "fiscal_year_start_month", "admin_levels", "identifier_namespace", "branding",
    "guidelines", "code_systems", "banned_identifier_keys", "privacy", "map",
    "reporting_frameworks",
}
BUILD_TIME_ONLY = {"app_id"}

# Named so the settings screen can say *why* a value is not on the form, rather than
# leaving an administrator hunting for a field that was never going to be there.
BUILD_TIME_FIELDS = (
    ("Application id", "Identifies the installed bundle to the operating system, and is fixed when the application is packaged."),
    ("Code-signing identity", "Belongs to whoever signs and distributes the build; a running installation cannot re-sign itself."),
    ("Installer filename and protocol handlers", "Registered with the operating system at install time."),
)

# Changing these splits identifier continuity for everything already exported.
IRREVERSIBLE_FIELDS = {"identifier_namespace"}


def detect_image_format(data: bytes) -> str | None:
    """Return PNG/JPEG/WEBP from the leading bytes, or None."""
    for signature, name in IMAGE_SIGNATURES:
        if data.startswith(signature):
            if name == "WEBP":
                return "WEBP" if len(data) >= 12 and data[8:12] == b"WEBP" else None
            return name
    return None


def validate_logo(data: bytes, *, filename: str = "") -> tuple[bytes, str]:
    """Validate and re-encode an uploaded logo.

    Returns (bytes, content_type). Raises ValidationError with a message meant for the
    administrator. The returned bytes are produced by this process, so a file carrying a
    valid image header followed by hostile trailing content cannot survive.
    """
    if not data:
        raise ValidationError("The logo file is empty.")
    if len(data) > MAX_LOGO_BYTES:
        raise ValidationError(
            f"The logo is {len(data) // 1024} KB; the limit is {MAX_LOGO_BYTES // 1024} KB."
        )

    lowered = filename.lower()
    if lowered.endswith(".svg") or data.lstrip()[:5].lower() in {b"<?xml", b"<svg"}:
        raise ValidationError(
            "SVG logos are not accepted. An SVG is an executable document and this image is "
            "rendered on the public dashboard. Upload a PNG, JPEG or WebP."
        )

    detected = detect_image_format(data)
    if detected not in ALLOWED_IMAGE_FORMATS:
        raise ValidationError("The file is not a PNG, JPEG or WebP image.")

    try:
        from PIL import Image
    except ImportError as error:
        # Fail closed. Without an imaging library the bytes cannot be decoded and
        # re-encoded, so accepting the upload would mean storing a file this codebase has
        # not verified and cannot vouch for. Refusing is the honest outcome; the
        # alternative is a guarantee that only appears to hold.
        raise ValidationError(
            "Logo uploads are unavailable because the imaging library is not installed. "
            "Install Pillow (it is listed in requirements.txt) and try again."
        ) from error

    try:
        with Image.open(io.BytesIO(data)) as image:
            image.verify()
        with Image.open(io.BytesIO(data)) as image:
            if max(image.size) > MAX_LOGO_PIXELS:
                raise ValidationError(
                    f"The logo is {image.size[0]}×{image.size[1]}; the limit is "
                    f"{MAX_LOGO_PIXELS}px on the longest side."
                )
            buffer = io.BytesIO()
            image.convert("RGBA" if detected == "PNG" else "RGB").save(buffer, format=detected)
            return buffer.getvalue(), ALLOWED_IMAGE_FORMATS[detected]
    except ValidationError:
        raise
    except Exception as error:  # noqa: BLE001 - any decode failure is a rejected upload
        raise ValidationError(f"The image could not be read: {error}") from error


def validate_https_url(value: str, *, field: str) -> str:
    """Accept only an absolute https URL. These are rendered and fetched."""
    text = str(value or "").strip()
    if not text:
        raise ValidationError(f"{field} is required.")
    parsed = urlparse(text)
    if parsed.scheme.lower() != "https":
        raise ValidationError(
            f"{field} must be an absolute https:// URL. "
            f"{parsed.scheme or 'A relative value'} is not accepted here because this value is "
            "rendered into pages and into exported FHIR."
        )
    if not parsed.netloc:
        raise ValidationError(f"{field} is missing a host.")
    return text.rstrip("/")


def validate_urn_prefix(value: str) -> str:
    text = str(value or "").strip().rstrip(":")
    import re

    if not re.fullmatch(r"urn:[a-z0-9][a-z0-9-]*(:[a-z0-9][a-z0-9-]*)*", text):
        raise ValidationError(
            "The URN prefix must look like urn:example:amr — lowercase, colon-separated."
        )
    return text


def validate_overrides(overrides: dict[str, Any]) -> dict[str, Any]:
    """Validate an override document and return the cleaned version."""
    if not isinstance(overrides, dict):
        raise ValidationError("Deployment settings must be an object.")

    unknown = set(overrides) - EDITABLE_FIELDS
    build_time = unknown & BUILD_TIME_ONLY
    if build_time:
        raise ValidationError(
            f"{', '.join(sorted(build_time))} is fixed when the application is built and signed, "
            "and cannot be changed here. Export this profile and rebuild with it."
        )
    if unknown:
        raise ValidationError(f"Unknown setting(s): {', '.join(sorted(unknown))}.")

    cleaned = json.loads(json.dumps(overrides))  # reject anything not JSON-serialisable

    namespace = cleaned.get("identifier_namespace")
    if namespace is not None:
        if not isinstance(namespace, dict):
            raise ValidationError("identifier_namespace must be an object.")
        namespace["base_uri"] = validate_https_url(namespace.get("base_uri"), field="Base URI")
        namespace["urn_prefix"] = validate_urn_prefix(namespace.get("urn_prefix"))

    map_settings = cleaned.get("map")
    if isinstance(map_settings, dict) and map_settings.get("tile_url"):
        map_settings["tile_url"] = validate_https_url(map_settings["tile_url"], field="Map tile URL")

    branding = cleaned.get("branding")
    if isinstance(branding, dict):
        if "app_id" in branding:
            raise ValidationError(
                "The application id is fixed when the application is built and signed, and cannot "
                "be changed here."
            )
        for name, colour in (branding.get("colors") or {}).items():
            import re

            if not re.fullmatch(r"#[0-9A-Fa-f]{6}", str(colour)):
                raise ValidationError(f"Colour '{name}' must be a six-digit hex value like #1B75BC.")

    levels = cleaned.get("admin_levels")
    if levels is not None:
        if not isinstance(levels, list) or len(levels) > 6:
            raise ValidationError("Administrative levels must be a list of at most six entries.")
        seen = set()
        for definition in levels:
            level = definition.get("level")
            if not isinstance(level, int) or not 1 <= level <= 6:
                raise ValidationError("Each administrative level must have a level between 1 and 6.")
            if level in seen:
                raise ValidationError(f"Administrative level {level} is defined more than once.")
            seen.add(level)
            for required in ("key", "label", "label_plural", "code_system"):
                if not str(definition.get(required) or "").strip():
                    raise ValidationError(f"Level {level} is missing {required}.")

    return cleaned


def apply_overrides(profile: dict[str, Any], overrides: dict[str, Any]) -> dict[str, Any]:
    """Layer an override document over a resolved profile, one level deep per field."""
    merged = json.loads(json.dumps(profile))
    for field, value in (overrides or {}).items():
        if isinstance(value, dict) and isinstance(merged.get(field), dict):
            merged[field] = {**merged[field], **value}
        else:
            merged[field] = value
    return merged


def irreversible_changes(current: dict[str, Any], proposed: dict[str, Any]) -> list[str]:
    """Fields whose change cannot be undone for data already exported."""
    changed = []
    for field in IRREVERSIBLE_FIELDS:
        if (current or {}).get(field) != (proposed or {}).get(field):
            changed.append(field)
    return changed


def stamp_effective_from(overrides: dict[str, Any]) -> dict[str, Any]:
    """Record when an identifier namespace took effect, so past exports stay explainable."""
    namespace = overrides.get("identifier_namespace")
    if isinstance(namespace, dict) and not namespace.get("effective_from"):
        namespace["effective_from"] = timezone.now().isoformat()
    return overrides
