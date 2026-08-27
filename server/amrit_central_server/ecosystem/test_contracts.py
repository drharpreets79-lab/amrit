"""Phase 13 gate: 2.0 is the only canonical event contract; 1.0 and 1.1 are withdrawn."""

from __future__ import annotations

import uuid

from django.test import SimpleTestCase

from ecosystem.contracts import (
    ContractError,
    supported_event_versions,
    supported_product_contracts,
    validate_data_product,
    validate_event,
)


def event_20(**overrides) -> dict:
    payload = {
        "schema_version": "2.0",
        "event_id": str(uuid.uuid4()),
        "module": "amc",
        "event_type": "consumption",
        "purpose": "surveillance",
        "facility_id": "FAC-1",
        "country_code": "IND",
        "observed_at": "2026-02-01T00:00:00Z",
        "admin_codes": [
            {"level": 1, "code": "28", "code_system": "LGD"},
            {"level": 2, "code": "583", "code_system": "LGD"},
        ],
        "admin_path": "IND/28/583",
        "reporting_period": {
            "start": "2026-01-01",
            "end": "2026-01-31",
            "epi_week": 5,
            "epi_year": 2026,
            "epi_week_system": "mmwr",
        },
        "timezone": "Asia/Kolkata",
        "payload": {},
    }
    payload.update(overrides)
    return payload


class CanonicalEventContractTests(SimpleTestCase):
    def test_only_20_is_offered(self):
        self.assertEqual(supported_event_versions(), ["2.0"])

    def test_20_validates(self):
        self.assertTrue(validate_event(event_20()))

    def test_20_requires_a_country(self):
        """Without it an event cannot be placed once more than one country reports."""
        payload = event_20()
        del payload["country_code"]
        with self.assertRaisesMessage(ContractError, "country_code"):
            validate_event(payload)

    def test_20_rejects_a_malformed_country_code(self):
        for bad in ("IN", "ind", "INDIA", ""):
            with self.subTest(code=bad):
                with self.assertRaises(ContractError):
                    validate_event(event_20(country_code=bad))

    def test_20_supports_more_than_two_levels(self):
        payload = event_20(
            country_code="TST",
            admin_codes=[
                {"level": 1, "code": "G1"},
                {"level": 2, "code": "D1"},
                {"level": 3, "code": "S1"},
            ],
            admin_path="TST/G1/D1/S1",
        )
        self.assertTrue(validate_event(payload))

    def test_20_carries_no_administrative_chain_for_a_national_event(self):
        payload = event_20()
        del payload["admin_codes"]
        del payload["admin_path"]
        self.assertTrue(validate_event(payload))

    def test_20_refuses_the_withdrawn_level_names(self):
        """The whole point of 2.0: no field in the envelope names a country's tier."""
        for field in ("state_code", "district_code"):
            with self.subTest(field=field):
                with self.assertRaises(ContractError):
                    validate_event(event_20(**{field: "28"}))

    def test_withdrawn_versions_are_refused_with_their_migration(self):
        for version, hint in (("1.0", "admin_codes"), ("1.1", "admin_codes")):
            with self.subTest(version=version):
                with self.assertRaisesMessage(ContractError, "withdrawn"):
                    validate_event(event_20(schema_version=version))
                with self.assertRaisesMessage(ContractError, hint):
                    validate_event(event_20(schema_version=version))

    def test_an_unknown_version_is_refused_rather_than_guessed(self):
        with self.assertRaisesMessage(ContractError, "unsupported canonical event schema_version"):
            validate_event(event_20(schema_version="9.9"))

    def test_a_missing_version_defaults_to_20(self):
        payload = event_20()
        del payload["schema_version"]
        # 2.0 requires the field, so the default only decides *which* schema judges it.
        with self.assertRaisesMessage(ContractError, "schema_version"):
            validate_event(payload)


class DataProductContractTests(SimpleTestCase):
    def base(self, **overrides) -> dict:
        payload = {
            "contract": "national-amr-data-product/1.0",
            "module": "amc",
            "generated_at": "2026-02-01T00:00:00Z",
            "record_count": 12,
            "metrics": {},
            "quality": {"status": "validated", "schema_version": "1.0"},
        }
        payload.update(overrides)
        return payload

    def test_both_contracts_are_offered(self):
        self.assertEqual(
            supported_product_contracts(), ["amr-data-product/1.1", "national-amr-data-product/1.0"]
        )

    def test_10_validates_unchanged(self):
        self.assertTrue(validate_data_product(self.base()))

    def test_11_requires_a_country(self):
        with self.assertRaisesMessage(ContractError, "country_code"):
            validate_data_product(self.base(contract="amr-data-product/1.1"))
        self.assertTrue(
            validate_data_product(self.base(contract="amr-data-product/1.1", country_code="IND"))
        )

    def test_an_unknown_contract_is_refused(self):
        with self.assertRaisesMessage(ContractError, "unsupported data product contract"):
            validate_data_product(self.base(contract="something-else/2.0"))
