"""Validate canonical events and data products against the version they declare.

Each schema is frozen — ``additionalProperties: false`` with a ``const`` version — so a
version cannot be extended in place and a new one is always a new file. Nothing here
chooses a schema for the payload; the payload declares it.

Canonical event 1.0 and 1.1 are **withdrawn**. Both carried ``state_code`` and
``district_code``, which put one country's two-level administrative hierarchy into the
wire format itself. 2.0 replaces them with ``admin_codes``, which numbers levels rather
than naming them. A producer still sending 1.0 or 1.1 is refused with the migration
stated, rather than accepted into a shape this software no longer stores.

Data products are unaffected: neither contract ever named an administrative level.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

CONTRACT_ROOT = Path(__file__).resolve().parent.parent / "shared" / "contracts"

EVENT_SCHEMAS = {
    "2.0": "canonical-event-2.0.schema.json",
}
PRODUCT_SCHEMAS = {
    "national-amr-data-product/1.0": "data-product.schema.json",
    "amr-data-product/1.1": "data-product-1.1.schema.json",
}

# What a withdrawn version should be told, so an operator reading the error knows the fix
# rather than only that they were refused.
WITHDRAWN_EVENT_VERSIONS = {
    "1.0": "state_code -> admin_codes[level 1].code, district_code -> admin_codes[level 2].code, and country_code is now required",
    "1.1": "drop state_code and district_code; the same values belong in admin_codes",
}

DEFAULT_EVENT_VERSION = "2.0"
DEFAULT_PRODUCT_CONTRACT = "national-amr-data-product/1.0"


class ContractError(ValueError):
    """Raised when a payload does not satisfy the version it declares."""


@lru_cache(maxsize=8)
def load_schema(filename: str) -> dict:
    path = CONTRACT_ROOT / filename
    if not path.is_file():
        raise ContractError(f"contract schema is missing: {filename}")
    return json.loads(path.read_text(encoding="utf-8"))


def _validate(payload: dict, filename: str) -> dict:
    from jsonschema import Draft202012Validator

    validator = Draft202012Validator(load_schema(filename))
    errors = sorted(validator.iter_errors(payload), key=lambda error: list(error.path))
    if errors:
        detail = "; ".join(
            f"{'/'.join(str(part) for part in error.path) or '<root>'}: {error.message}" for error in errors
        )
        raise ContractError(detail)
    return payload


def validate_event(payload: dict) -> dict:
    version = str((payload or {}).get("schema_version") or DEFAULT_EVENT_VERSION)
    filename = EVENT_SCHEMAS.get(version)
    if filename is None:
        migration = WITHDRAWN_EVENT_VERSIONS.get(version)
        if migration:
            raise ContractError(
                f"canonical event schema_version {version!r} is withdrawn; send 2.0 instead ({migration})"
            )
        raise ContractError(f"unsupported canonical event schema_version: {version!r}")
    return _validate(payload, filename)


def validate_data_product(payload: dict) -> dict:
    contract = str((payload or {}).get("contract") or DEFAULT_PRODUCT_CONTRACT)
    filename = PRODUCT_SCHEMAS.get(contract)
    if filename is None:
        raise ContractError(f"unsupported data product contract: {contract!r}")
    return _validate(payload, filename)


def supported_event_versions() -> list[str]:
    return sorted(EVENT_SCHEMAS)


def supported_product_contracts() -> list[str]:
    return sorted(PRODUCT_SCHEMAS)
