"""Phase 4 gate: geography is data, and more than one country can live in one database."""

from __future__ import annotations

import hashlib
import json
import tempfile
from io import StringIO
from pathlib import Path

from django.core.management import CommandError, call_command
from django.test import TestCase

from geo.loader import GeoPackError, available_packs, canonical_bytes, load_pack, read_pack, validate_pack
from geo.models import AdminUnit, CountryConfig, normalize_name
from sites.models import Site


def build_pack(country="TST", units=None, levels=None, minimums=None) -> dict:
    units = units if units is not None else [
        {"level": 1, "code": "G1", "parent_code": None, "name": "محافظة أولى", "unit_type": "governorate"},
        {"level": 2, "code": "D1", "parent_code": "G1", "name": "قضاء أول", "unit_type": "district"},
        {"level": 3, "code": "S1", "parent_code": "D1", "name": "ناحية أولى", "unit_type": "subdistrict"},
    ]
    levels = levels if levels is not None else [
        {"level": 1, "key": "governorate", "label": "محافظة", "label_plural": "المحافظات", "code_system": "ISO3166-2"},
        {"level": 2, "key": "district", "label": "قضاء", "label_plural": "الأقضية", "code_system": "GeoNames"},
        {"level": 3, "key": "subdistrict", "label": "ناحية", "label_plural": "النواحي", "code_system": "GeoNames"},
    ]
    pack = {
        "schemaVersion": 1,
        "dataset": "amrit-geo-pack",
        "version": "1.0",
        "countryCode": country,
        "countryName": "Testland",
        "levels": levels,
        "minimumCounts": minimums or {},
        "rowCounts": {"total": len(units)},
        "units": units,
    }
    pack["contentSha256"] = hashlib.sha256(canonical_bytes(units)).hexdigest()
    return pack


class GeoPackLoaderTests(TestCase):
    def test_loads_the_packaged_india_pack(self):
        """The pack is written by Python and read by both products; this is the server side."""
        self.assertIn("IN", available_packs())
        pack = read_pack("IN")
        self.assertEqual(pack["countryCode"], "IND")
        self.assertEqual(pack["rowCounts"]["total"], 36 + 785)

        result = load_pack(pack)
        self.assertEqual(result["created"], 821)
        self.assertEqual(AdminUnit.objects.for_country("IND").at_level(1).count(), 36)
        self.assertEqual(AdminUnit.objects.for_country("IND").at_level(2).count(), 785)

        district = AdminUnit.objects.for_country("IND").at_level(2).first()
        self.assertTrue(district.admin_path.startswith("IND/"))
        self.assertEqual(district.admin_path.count("/"), 2)
        self.assertEqual(district.code_system, "LGD")

    def test_reload_updates_in_place(self):
        load_pack(read_pack("IN"))
        result = load_pack(read_pack("IN"))
        self.assertEqual(result["created"], 0)
        self.assertEqual(result["updated"], 821)
        self.assertEqual(AdminUnit.objects.count(), 821)

    def test_arbitrary_depth_and_non_latin_names(self):
        load_pack(validate_pack(build_pack()))
        deepest = AdminUnit.objects.get(id="TST:3:S1")
        self.assertEqual(deepest.admin_path, "TST/G1/D1/S1")
        self.assertEqual(deepest.parent_id, "TST:2:D1")
        self.assertEqual(deepest.name, "ناحية أولى")

    def test_rejects_malformed_packs(self):
        cases = {
            "undeclared level": build_pack(
                levels=[{"level": 1, "key": "r", "label": "R", "label_plural": "Rs", "code_system": "ISO3166-2"}],
                units=[
                    {"level": 1, "code": "R1", "parent_code": None, "name": "One"},
                    {"level": 2, "code": "X1", "parent_code": "R1", "name": "Two"},
                ],
            ),
            "not in the pack": build_pack(units=[
                {"level": 1, "code": "G1", "parent_code": None, "name": "One"},
                {"level": 2, "code": "D9", "parent_code": "MISSING", "name": "Orphan"},
            ]),
            "duplicate unit": build_pack(units=[
                {"level": 1, "code": "G1", "parent_code": None, "name": "One"},
                {"level": 1, "code": "G1", "parent_code": None, "name": "Again"},
            ]),
            "must not declare a parent": build_pack(units=[
                {"level": 1, "code": "G1", "parent_code": "X", "name": "One"},
            ]),
            "unexpectedly small": build_pack(minimums={"1": 50}),
        }
        for message, pack in cases.items():
            with self.subTest(case=message):
                with self.assertRaisesMessage(GeoPackError, message):
                    validate_pack(pack)

    def test_rejects_tampered_content(self):
        pack = build_pack()
        pack["units"][0]["name"] = "Renamed after hashing"
        with self.assertRaisesMessage(GeoPackError, "content hash mismatch"):
            validate_pack(pack)


class SiteLinkageTests(TestCase):
    def setUp(self):
        load_pack(read_pack("IN"))

    def test_setting_a_unit_derives_the_path_and_country(self):
        district = AdminUnit.objects.for_country("IND").at_level(2).first()
        site = Site.objects.create(lab_code="TREE01", name="Tree Lab", admin_unit=district)
        site.refresh_from_db()

        self.assertEqual(site.admin_path, district.admin_path)
        self.assertEqual(site.country_code, "IND")
        # The unit chain is what names the place; no column repeats a level's name.
        self.assertEqual(site.place_label, f"{district.parent.name} · {district.name}")

    def test_an_address_is_stored_apart_from_the_reporting_unit(self):
        """A facility's postal town and its reporting unit are often not the same place."""
        district = AdminUnit.objects.for_country("IND").at_level(2).first()
        site = Site.objects.create(
            lab_code="ADDR01", name="Addressed Lab", admin_unit=district,
            address={"country_code": "IND", "address_lines": ["12 Hospital Road"],
                     "locality": "Kochi", "admin_area": "Kerala", "postal_code": "682011"},
        )
        site.refresh_from_db()
        self.assertEqual(site.admin_path, district.admin_path)
        # India uppercases the post town, so what is stored is what the country writes.
        self.assertEqual(site.address["locality"], "KOCHI")
        # Rendered with India's own format string, and cached rather than recomputed.
        self.assertIn("KOCHI 682011", site.address["formatted"])

    def test_an_address_the_country_cannot_render_is_refused(self):
        from geo.address import AddressError

        with self.assertRaises(AddressError):
            Site.objects.create(lab_code="BAD01", name="Bad",
                                address={"country_code": "IND", "postal_code": "NOT-A-PIN"})

    def test_scope_by_prefix_rather_than_by_name(self):
        state = AdminUnit.objects.for_country("IND").at_level(1).first()
        districts = list(AdminUnit.objects.filter(parent=state)[:2])
        for index, district in enumerate(districts):
            Site.objects.create(lab_code=f"S{index}", name=f"Site {index}", admin_unit=district)
        Site.objects.create(lab_code="OTHER", name="Elsewhere",
                            admin_unit=AdminUnit.objects.for_country("IND").at_level(1).last())

        scoped = Site.objects.filter(admin_path__startswith=f"{state.admin_path}/")
        self.assertEqual(scoped.count(), len(districts))

    def test_descendants_of_uses_the_path(self):
        state = AdminUnit.objects.for_country("IND").at_level(1).first()
        descendants = AdminUnit.objects.descendants_of(state)
        self.assertGreater(descendants.count(), 0)
        self.assertTrue(all(unit.level == 2 for unit in descendants))
        self.assertIn(state, AdminUnit.objects.descendants_of(state, include_self=True))


class NonLatinScopingTests(TestCase):
    """The case that fails today: names outside ASCII.

    central.roles scopes with ``state__iexact``, and case-insensitive matching on SQLite
    is ASCII-only, so a Turkish or Greek unit name silently returns nothing. Codes are
    ASCII by construction, so prefix matching on admin_path is not affected — this test
    pins that difference before Phase 5 relies on it.
    """

    def setUp(self):
        units = [
            {"level": 1, "code": "TR-34", "parent_code": None, "name": "İstanbul"},
            {"level": 1, "code": "GR-A", "parent_code": None, "name": "Αττική"},
            {"level": 2, "code": "TR-34-01", "parent_code": "TR-34", "name": "Şişli"},
        ]
        levels = [
            {"level": 1, "key": "province", "label": "Province", "label_plural": "Provinces", "code_system": "ISO3166-2"},
            {"level": 2, "key": "district", "label": "District", "label_plural": "Districts", "code_system": "GeoNames"},
        ]
        load_pack(validate_pack(build_pack(country="TUR", units=units, levels=levels)))

    def test_prefix_scoping_finds_non_ascii_units(self):
        province = AdminUnit.objects.get(id="TUR:1:TR-34")
        district = AdminUnit.objects.get(id="TUR:2:TR-34-01")
        Site.objects.create(lab_code="IST01", name="İstanbul Lab", admin_unit=district)

        scoped = Site.objects.filter(admin_path__startswith=f"{province.admin_path}/")
        self.assertEqual(scoped.count(), 1)
        self.assertEqual(scoped.first().place_label, "İstanbul · Şişli")

    def test_name_matching_is_the_unreliable_path(self):
        """Documents why scoping must not match on names.

        Dotted and dotless I are the classic case: whether ``iexact`` treats "İstanbul"
        and "istanbul" as equal depends on the database and its collation, so it cannot be
        the basis of an access-control decision.
        """
        district = AdminUnit.objects.get(id="TUR:2:TR-34-01")
        Site.objects.create(lab_code="IST02", name="Lab", admin_unit=district)
        by_code = Site.objects.filter(admin_path__startswith="TUR/TR-34/")
        self.assertEqual(by_code.count(), 1)


class MultiCountryTests(TestCase):
    def setUp(self):
        load_pack(read_pack("IN"))
        load_pack(validate_pack(build_pack()))

    def test_two_countries_coexist_without_bleeding(self):
        self.assertEqual(AdminUnit.objects.for_country("IND").count(), 821)
        self.assertEqual(AdminUnit.objects.for_country("TST").count(), 3)

        india_site = Site.objects.create(
            lab_code="IND01", name="India Lab",
            admin_unit=AdminUnit.objects.for_country("IND").at_level(2).first())
        testland_site = Site.objects.create(
            lab_code="TST01", name="Testland Lab", admin_unit=AdminUnit.objects.get(id="TST:3:S1"))

        self.assertEqual(Site.objects.filter(country_code="IND").get(), india_site)
        self.assertEqual(Site.objects.filter(country_code="TST").get(), testland_site)
        self.assertEqual(Site.objects.filter(admin_path__startswith="IND/").count(), 1)

    def test_country_config_holds_per_country_overrides(self):
        CountryConfig.objects.create(country_code="TST", profile_id="TESTLAND",
                                     overrides={"branding": {"product_name": "AMR Testland"}})
        config = CountryConfig.objects.get(country_code="TST")
        self.assertEqual(config.overrides["branding"]["product_name"], "AMR Testland")


class ImportCommandTests(TestCase):
    def _csv(self, body: str) -> str:
        handle = tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False, encoding="utf-8")
        handle.write(body)
        handle.close()
        return handle.name

    def test_imports_a_three_level_country_from_csv(self):
        path = self._csv(
            "level,code,parent_code,name,unit_type\n"
            "1,NG-LA,,Lagos,state\n"
            "2,NG-LA-IK,NG-LA,Ikeja,lga\n"
            "3,NG-LA-IK-1,NG-LA-IK,Ward 1,ward\n"
        )
        output = StringIO()
        call_command(
            "import_admin_units", "--country", "NGA", "--name", "Nigeria", "--file", path,
            "--level", "1:state:State:States:ISO3166-2",
            "--level", "2:lga:LGA:LGAs:GeoNames",
            "--level", "3:ward:Ward:Wards:GeoNames",
            stdout=output,
        )
        self.assertIn("3 unit(s)", output.getvalue())
        self.assertEqual(AdminUnit.objects.for_country("NGA").count(), 3)
        self.assertEqual(AdminUnit.objects.get(id="NGA:3:NG-LA-IK-1").admin_path, "NGA/NG-LA/NG-LA-IK/NG-LA-IK-1")

    def test_dry_run_writes_nothing(self):
        path = self._csv("level,code,parent_code,name\n1,R1,,Region One\n")
        call_command("import_admin_units", "--country", "NGA", "--file", path,
                     "--level", "1:region:Region:Regions:ISO3166-2", "--dry-run", stdout=StringIO())
        self.assertEqual(AdminUnit.objects.count(), 0)

    def test_rejects_an_orphan_row_rather_than_importing_a_broken_tree(self):
        path = self._csv("level,code,parent_code,name\n1,R1,,One\n2,D1,NOPE,Orphan\n")
        with self.assertRaises(CommandError):
            call_command("import_admin_units", "--country", "NGA", "--file", path,
                         "--level", "1:region:Region:Regions:ISO3166-2",
                         "--level", "2:district:District:Districts:GeoNames", stdout=StringIO())
        self.assertEqual(AdminUnit.objects.count(), 0)

    def test_load_geo_pack_command(self):
        output = StringIO()
        call_command("load_geo_pack", "IN", stdout=output)
        self.assertIn("821 unit(s)", output.getvalue())


class NormalizeNameTests(TestCase):
    def test_folds_case_width_and_whitespace(self):
        self.assertEqual(normalize_name("  Tamil   Nadu "), "tamil nadu")
        self.assertEqual(normalize_name("KERALA"), "kerala")
        # Composed and decomposed forms of the same name must fold together, or the
        # linking migration would report a false unmatched row. These two strings render
        # identically and are not equal as Python strings.
        composed = "Ni\u00f1o"        # LATIN SMALL LETTER N WITH TILDE
        decomposed = "Nin\u0303o"     # n + COMBINING TILDE
        self.assertNotEqual(composed, decomposed)
        self.assertEqual(normalize_name(composed), normalize_name(decomposed))
