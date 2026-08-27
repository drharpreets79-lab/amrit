"""The postal-address contract, driven by the fixture both runtimes share.

``shared/golden-datasets/address_reference.json`` is the same file the desktop app's
``address.test.ts`` reads. If the two implementations ever disagree about how a country
writes an address, one of these suites fails — which is the point: an address rendered one
way on the desktop and another on the portal is the same defect as not storing it.
"""

from __future__ import annotations

import json
from pathlib import Path

from django.test import SimpleTestCase
from jsonschema import Draft202012Validator

from geo.address import (
    AddressError,
    address_format_for,
    address_format_pack,
    clean_address,
    fields_for_form,
    format_address,
    label_for,
    normalize_address,
    repair_unsupported_address_fields,
    to_fhir_address,
    validate_address,
)

FIXTURE = json.loads(
    (Path(__file__).resolve().parent.parent / "shared" / "golden-datasets" / "address_reference.json")
    .read_text(encoding="utf-8")
)


class AddressFixtureTests(SimpleTestCase):
    def test_every_case_renders_and_validates_as_the_fixture_says(self):
        for case in FIXTURE["cases"]:
            with self.subTest(case=case["name"]):
                fmt = address_format_for(case["address"].get("country_code", ""))
                problems = [
                    {"field": problem["field"], "code": problem["code"]}
                    for problem in validate_address(case["address"], fmt)
                ]
                self.assertEqual(problems, case["problems"])
                if "formatted" in case:
                    self.assertEqual(normalize_address(case["address"], fmt)["formatted"], case["formatted"])
                for field, expected in (case.get("labels") or {}).items():
                    self.assertEqual(label_for(field, fmt), expected)

    def test_fhir_mapping_is_one_to_one_apart_from_the_sorting_code(self):
        case = FIXTURE["fhir"]
        fmt = address_format_for(case["address"]["country_code"])
        resource = to_fhir_address(normalize_address(case["address"], fmt), fmt)
        self.assertEqual(resource, case["expected"])

    def test_the_shared_contract_accepts_the_address_the_runtime_stores(self):
        contract = json.loads(
            (Path(__file__).resolve().parent.parent / "shared" / "contracts" / "postal-address.schema.json")
            .read_text(encoding="utf-8")
        )
        Draft202012Validator.check_schema(contract)
        stored = clean_address({"country_code": "IND", "plus_code": "7J3Q2M8Q+P9"})
        self.assertEqual(list(Draft202012Validator(contract).iter_errors(stored)), [])


class AddressPackTests(SimpleTestCase):
    def test_the_pack_covers_every_country_the_registry_offers(self):
        """A deployment must never open an address form with no fields on it."""
        pack = address_format_pack()
        self.assertGreaterEqual(len(pack["countries"]), 240)
        for entry in pack["countries"].values():
            self.assertTrue(entry["format"])
            self.assertTrue(entry["fields"])
            # All four varying labels are always present, so nothing has to guess one.
            self.assertEqual(
                set(entry["labels"]), {"admin_area", "locality", "dependent_locality", "postal_code"}
            )

    def test_an_unlisted_country_falls_back_to_a_working_form(self):
        fmt = address_format_for("ZZZ")
        self.assertEqual(fmt, address_format_pack()["default"])
        self.assertIn("address_lines", fields_for_form(fmt))

    def test_form_fields_follow_the_order_the_country_writes_them(self):
        """Japan writes prefecture before street; the form must not impose one order."""
        self.assertEqual(
            fields_for_form(address_format_for("JPN"))[:3],
            ["postal_code", "admin_area", "address_lines"],
        )
        self.assertEqual(
            fields_for_form(address_format_for("USA"))[:4],
            ["organization", "address_lines", "locality", "admin_area"],
        )


class CleanAddressTests(SimpleTestCase):
    def test_an_empty_address_is_not_an_error(self):
        """A site may be recorded before anyone knows where its building is."""
        self.assertEqual(clean_address(None), {})
        self.assertEqual(clean_address({}), {})

    def test_the_country_can_be_supplied_by_the_caller(self):
        cleaned = clean_address({"address_lines": ["12 Hospital Road"], "locality": "Kochi",
                                 "admin_area": "Kerala", "postal_code": "682011"}, country_code="IND")
        self.assertEqual(cleaned["country_code"], "IND")
        self.assertEqual(cleaned["locality"], "KOCHI")

    def test_an_unsupported_suburb_is_preserved_as_a_printable_address_line(self):
        cleaned = clean_address({
            "country_code": "IND",
            "address_lines": ["12 Hospital Road"],
            "dependent_locality": "Fort Kochi",
            "locality": "Kochi",
            "admin_area": "Kerala",
            "postal_code": "682011",
        })
        self.assertNotIn("dependent_locality", cleaned)
        self.assertEqual(cleaned["address_lines"], ["12 Hospital Road", "Fort Kochi"])
        self.assertIn("Fort Kochi", cleaned["formatted"])

    def test_repair_does_not_duplicate_an_existing_address_line(self):
        repaired = repair_unsupported_address_fields({
            "country_code": "IND",
            "address_lines": ["12 Hospital Road", "Fort Kochi"],
            "dependent_locality": "fort kochi",
        })
        self.assertEqual(repaired["address_lines"], ["12 Hospital Road", "Fort Kochi"])

    def test_an_invalid_address_is_refused_with_the_field_named(self):
        # The country's own word for the field, in sentence case. `label_for` used to
        # return the source dataset's raw token, which is how "pin" reached a screen as a
        # visible field label; the renderer now translates the token instead.
        with self.assertRaisesMessage(AddressError, "Pin does not match the format"):
            clean_address({"country_code": "IND", "postal_code": "NOT-A-PIN"})

    def test_a_non_object_is_refused_rather_than_coerced(self):
        with self.assertRaises(AddressError):
            clean_address("12 Hospital Road, Kochi")

    def test_formatted_is_recomputed_rather_than_trusted(self):
        cleaned = clean_address({"country_code": "IND", "address_lines": ["12 Hospital Road"],
                                 "locality": "Kochi", "admin_area": "Kerala", "postal_code": "682011",
                                 "formatted": "whatever the caller sent"})
        self.assertEqual(cleaned["formatted"], "12 Hospital Road\nKOCHI 682011\nKerala")

    def test_a_pattern_this_engine_cannot_compile_does_not_block_entry(self):
        """The pack is data; bad data must not become a data-entry wall."""
        broken = dict(address_format_for("IND"), postal_code_pattern="(unclosed")
        self.assertEqual(validate_address({"country_code": "IND", "address_lines": ["A"],
                                           "locality": "Kochi", "admin_area": "Kerala",
                                           "postal_code": "682011"}, broken), [])

    def test_a_full_plus_code_is_decoded_offline(self):
        cleaned = clean_address({"country_code": "IND", "plus_code": "7j3q 2m8q+p9"})
        self.assertEqual(cleaned["plus_code"], "7J3Q2M8Q+P9")
        self.assertEqual(cleaned["geo_point"]["precision"], "plus_code")
        self.assertEqual(cleaned["geo_point"]["source"], "open-location-code")
        self.assertAlmostEqual(cleaned["geo_point"]["latitude"], 11.0168125)

    def test_short_and_invalid_plus_codes_are_refused(self):
        for code in ("2M8Q+P9", "NOT+A+CODE"):
            with self.subTest(code=code), self.assertRaisesMessage(AddressError, "Plus Code"):
                clean_address({"country_code": "IND", "plus_code": code})

    def test_fhir_keeps_sorting_and_plus_code_extensions(self):
        resource = to_fhir_address({
            "country_code": "IND", "sorting_code": "ROUTE-1", "plus_code": "7J3Q2M8Q+P9"
        })
        self.assertEqual(
            [extension["valueString"] for extension in resource["extension"]],
            ["ROUTE-1", "7J3Q2M8Q+P9"],
        )


class RenderingEdgeCaseTests(SimpleTestCase):
    def test_a_literal_only_line_is_kept(self):
        fmt = dict(address_format_for("IND"), format="%A%nALWAYS")
        self.assertEqual(
            format_address({"country_code": "IND", "address_lines": ["12 Hospital Road"]}, fmt),
            "12 Hospital Road\nALWAYS",
        )

    def test_an_orphaned_separator_is_not_left_behind(self):
        """`%C, %S %Z` with no state must not render "Atlanta,  30329"."""
        fmt = address_format_for("USA")
        self.assertEqual(
            format_address({"country_code": "USA", "locality": "Atlanta", "postal_code": "30329"}, fmt),
            "ATLANTA 30329",  # the US uppercases its post town
        )

    def test_the_recipient_token_never_renders(self):
        """These are the addresses of facilities; an attention line is where a person ends up."""
        fmt = address_format_for("USA")
        rendered = format_address(
            {"country_code": "USA", "recipient": "Dr Smith", "address_lines": ["1600 Clifton Road"],
             "locality": "Atlanta", "admin_area": "GA", "postal_code": "30329"},
            fmt,
        )
        self.assertNotIn("Dr Smith", rendered)
        self.assertNotIn("recipient", normalize_address({"country_code": "USA", "recipient": "Dr Smith"}, fmt))
