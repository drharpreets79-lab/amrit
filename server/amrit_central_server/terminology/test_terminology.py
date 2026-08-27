"""Phase 22 — the terminology operations, and the parity that makes them worth having.

The portal validates what the desktop exports. If the two disagree about what a code means,
the portal rejects the product's own output, so these tests assert the same facts the desktop
tests assert, against the same seed file.
"""

from __future__ import annotations

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase
from rest_framework.test import APIClient

from .loader import terminology_seed
from .service import (
    ICD10_SYSTEM,
    ICD11_SYSTEM,
    LOINC_SYSTEM,
    SNOMED_SYSTEM,
    UCUM_SYSTEM,
    Gate,
    all_systems_enabled,
    antibiotic_binding,
    describe_terminology,
    expand,
    lookup,
    profile_gate,
    translate,
    unit_for,
    validate_code,
)

SEED = terminology_seed()


def no_snomed(system: str) -> Gate:
    if system == SNOMED_SYSTEM:
        return Gate(False, "SNOMED is disabled in this deployment's country profile.")
    return Gate(True, "")


class SeedTests(SimpleTestCase):
    def test_seed_carries_its_provenance(self):
        self.assertEqual(SEED["dataset"], "amrit-terminology")
        # The source is named, not pinned: the codes came from the public terminology server
        # while a licensed LOINC release was unavailable and from the release itself once one
        # was. Both are legitimate provenance; a test that pins one forces a lie when the other
        # is used.
        self.assertTrue(str(SEED["provenance"]["server"]).strip())
        self.assertIn("ABXBACT", SEED["provenance"]["expansion"])
        self.assertRegex(SEED["contentSha256"], r"^[0-9a-f]{64}$")

    def test_the_catalogue_loinc_columns_are_not_used(self):
        """`loinc_mlc` is minimum *lethal* concentration. AMRIT measures MIC, and 6651-4 is not it."""
        meropenem = SEED["bindings"]["antibiotic"]["MEM"]
        self.assertEqual(meropenem["mic"], "6652-2")
        self.assertNotIn("6651-4", meropenem.values())

    def test_every_antibiotic_is_either_bound_or_listed_as_uncoded(self):
        self.assertEqual(len(SEED["bindings"]["antibiotic"]) + len(SEED["unmatched"]), 399)


class OperationTests(SimpleTestCase):
    def test_lookup_answers_from_the_bundled_subset(self):
        found = lookup(SEED, LOINC_SYSTEM, "6652-2")
        self.assertTrue(found.ok)
        self.assertIn("Minimum inhibitory concentration", found.value["display"])

    def test_lookup_distinguishes_not_bundled_from_not_a_code(self):
        missing = lookup(SEED, LOINC_SYSTEM, "18156-0")
        self.assertFalse(missing.ok)
        self.assertIn("not that it is invalid", missing.reason)

    def test_validate_code_answers_false_rather_than_failing(self):
        self.assertTrue(validate_code(SEED, LOINC_SYSTEM, "6652-2").ok)
        self.assertFalse(validate_code(SEED, LOINC_SYSTEM, "nope").ok)

    def test_translate_gives_a_different_code_per_method(self):
        result = translate(SEED, "urn:whonet:antibiotic-code", "MEM")
        self.assertTrue(result.ok)
        by_relationship = {row["relationship"]: row["code"] for row in result.value}
        self.assertEqual(by_relationship["mic"], "6652-2")
        self.assertEqual(by_relationship["disk"], "6653-0")

    def test_translate_refuses_rather_than_returning_empty_when_snomed_is_off(self):
        blocked = translate(SEED, "urn:whonet:organism-code", "SAJ", gate=no_snomed)
        self.assertFalse(blocked.ok)
        self.assertIn("disabled", blocked.reason)

    def test_translate_says_unmapped_rather_than_guessing(self):
        result = translate(SEED, "urn:whonet:organism-code", "NOT-AN-ORGANISM")
        self.assertFalse(result.ok)
        self.assertIn("nothing is guessed", result.reason)

    def test_expand_reports_the_match_count_not_the_page_size(self):
        page = expand(SEED, LOINC_SYSTEM, count=5)
        self.assertTrue(page.ok)
        self.assertEqual(len(page.value["concepts"]), 5)
        self.assertGreater(page.value["total"], 5)

    def test_binding_follows_the_method(self):
        self.assertEqual(antibiotic_binding(SEED, "MEM", "MIC").value["code"], "6652-2")
        self.assertEqual(antibiotic_binding(SEED, "MEM", "DISK").value["code"], "6653-0")
        self.assertEqual(antibiotic_binding(SEED, "MEM", "").value["method"], "plain")

    def test_binding_refuses_for_an_agent_loinc_does_not_code(self):
        uncoded = SEED["unmatched"][0]["code"]
        result = antibiotic_binding(SEED, uncoded, "MIC")
        self.assertFalse(result.ok)
        self.assertIn("no LOINC susceptibility concept", result.reason)

    def test_units(self):
        self.assertEqual(unit_for(SEED, "MIC"), "mg/L")
        self.assertEqual(unit_for(SEED, "DISK"), "mm")
        self.assertEqual(unit_for(SEED, ""), "")

    def test_profile_gate_disables_only_what_the_profile_names(self):
        gate = profile_gate({"snomed": {"enabled": False, "licence": "No affiliate licence here."}})
        self.assertFalse(gate(SNOMED_SYSTEM).enabled)
        self.assertIn("No affiliate licence here.", gate(SNOMED_SYSTEM).reason)
        self.assertTrue(gate(LOINC_SYSTEM).enabled)
        # A deployment cannot switch off AMRIT's own code space; there would be nothing left.
        self.assertTrue(gate("urn:whonet:antibiotic-code").enabled)

    def test_describe_terminology_lists_every_system(self):
        described = describe_terminology(SEED, all_systems_enabled)
        self.assertIn(LOINC_SYSTEM, [row["url"] for row in described])
        self.assertIn(UCUM_SYSTEM, [row["url"] for row in described])


class EndpointTests(TestCase):
    def setUp(self):
        user = get_user_model().objects.create_user(username="tx", password="tx-password-1")
        self.client = APIClient()
        self.client.force_authenticate(user=user)

    def test_lookup_returns_parameters(self):
        response = self.client.get("/api/v1/terminology/CodeSystem/$lookup",
                                   {"system": LOINC_SYSTEM, "code": "6652-2"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["resourceType"], "Parameters")
        displays = [p["valueString"] for p in response.data["parameter"] if p["name"] == "display"]
        self.assertIn("Meropenem", displays[0])

    def test_lookup_returns_an_operation_outcome_with_a_usable_reason(self):
        response = self.client.get("/api/v1/terminology/CodeSystem/$lookup",
                                   {"system": LOINC_SYSTEM, "code": "not-a-code"})
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.data["resourceType"], "OperationOutcome")
        self.assertIn("bundled subset", response.data["issue"][0]["diagnostics"])

    def test_translate_returns_matches(self):
        response = self.client.get("/api/v1/terminology/ConceptMap/$translate",
                                   {"system": "urn:whonet:antibiotic-code", "code": "MEM", "relationship": "mic"})
        self.assertEqual(response.status_code, 200)
        matches = [p for p in response.data["parameter"] if p["name"] == "match"]
        self.assertEqual(len(matches), 1)
        concept = next(part for part in matches[0]["part"] if part["name"] == "concept")
        self.assertEqual(concept["valueCoding"]["code"], "6652-2")

    def test_expand_pages(self):
        response = self.client.get("/api/v1/terminology/ValueSet/$expand",
                                   {"system": LOINC_SYSTEM, "filter": "meropenem", "count": 2})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["resourceType"], "ValueSet")
        self.assertLessEqual(len(response.data["expansion"]["contains"]), 2)
        self.assertGreater(response.data["expansion"]["total"], 0)

    def test_systems_endpoint_states_the_version_a_receiver_is_validating_against(self):
        response = self.client.get("/api/v1/terminology/systems")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["dataset"], "amrit-terminology")
        self.assertRegex(response.data["contentSha256"], r"^[0-9a-f]{64}$")
        self.assertGreater(response.data["uncodedAntibiotics"], 0)

    def test_operations_require_authentication(self):
        anonymous = APIClient()
        response = anonymous.get("/api/v1/terminology/CodeSystem/$lookup",
                                 {"system": LOINC_SYSTEM, "code": "6652-2"})
        self.assertIn(response.status_code, (401, 403))

    def test_capability_statement_lists_the_operations_that_exist(self):
        response = self.client.get("/api/v1/terminology/metadata")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["resourceType"], "CapabilityStatement")
        self.assertEqual(response.data["fhirVersion"], "4.0.1")
        operations = {
            operation["name"]
            for resource in response.data["rest"][0]["resource"]
            for operation in resource["operation"]
        }
        self.assertEqual(operations, {"lookup", "validate-code", "translate", "expand"})

    def test_capability_statement_claims_no_implementation_guide_it_cannot_serve(self):
        """The IG is authored but unpublished. Advertising it would be a broken promise."""
        response = self.client.get("/api/v1/terminology/metadata")
        self.assertNotIn("implementationGuide", response.data)


class Icd11Tests(SimpleTestCase):
    """Phase 26 — ICD-11 MMS, taken from WHO's own ICD API.

    The portal has to agree with the desktop about ICD-11 for the same reason it has to
    agree about LOINC: it validates the desktop's output. These mirror
    ``app/tests/terminology.test.ts``.
    """

    def setUp(self):
        self.seed = terminology_seed()

    def test_bundles_whos_titles_rather_than_strings_this_repository_typed(self):
        # The first run of tools/fetch_icd11.py accepted 1A09 as "Shigellosis". It is a real
        # ICD-11 code and it is WHO's category for other Salmonella infections, so nothing
        # downstream could have caught it. Shigella's actual code is 1A02.
        self.assertEqual(len(self.seed["concepts"][ICD11_SYSTEM]), 40)
        self.assertEqual(
            lookup(self.seed, ICD11_SYSTEM, "1A09").value["display"],
            "Infections due to other Salmonella",
        )
        self.assertEqual(
            lookup(self.seed, ICD11_SYSTEM, "1A02").value["display"],
            "Intestinal infections due to Shigella",
        )

    def test_carries_whos_antimicrobial_resistance_block(self):
        for code in ("MG50", "MG51", "MG52", "MG53", "MG54"):
            self.assertTrue(lookup(self.seed, ICD11_SYSTEM, code).ok, code)

    def test_no_conceptmap_between_the_icd_revisions(self):
        # WHO's API publishes no mapping between the revisions and the two classifications
        # are not subsets of one another, so none is generated. A record says which system
        # it used; that is what diagnosis_system has always been for.
        self.assertFalse(any(
            m["sourceSystem"] == ICD10_SYSTEM or m["targetSystem"] == ICD11_SYSTEM
            for m in self.seed["conceptMaps"]
        ))
        attempted = translate(self.seed, ICD10_SYSTEM, "A41")
        self.assertFalse(attempted.ok)

    def test_the_two_revisions_never_stand_in_for_one_another(self):
        self.assertTrue(lookup(self.seed, ICD10_SYSTEM, "A41").ok)
        self.assertFalse(lookup(self.seed, ICD11_SYSTEM, "A41").ok)
        self.assertFalse(lookup(self.seed, ICD10_SYSTEM, "1G40").ok)
        self.assertTrue(lookup(self.seed, ICD11_SYSTEM, "1G40").ok)

    def test_a_deployment_can_switch_icd11_off_and_gets_a_reason(self):
        gate = profile_gate({"icd11": {"enabled": False, "licence": "CC BY-ND 3.0 IGO"}})
        result = lookup(self.seed, ICD11_SYSTEM, "1G40", gate)
        self.assertFalse(result.ok)
        self.assertIn("disabled", result.reason)
        self.assertIsNone(result.value)
