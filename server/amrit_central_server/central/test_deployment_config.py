"""Phase 6b gate: the administration screen's security rules.

Each test here corresponds to a way an administrator-supplied value reaches somewhere
dangerous — a rendered page, an `<img src>`, a tile request, or exported FHIR.
"""

from __future__ import annotations

import base64
import io
import json

from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.test import Client, SimpleTestCase, TestCase
from django.urls import reverse

from central import country_profile as cp
from central.deployment_config import (
    apply_overrides,
    detect_image_format,
    irreversible_changes,
    validate_https_url,
    validate_logo,
    validate_overrides,
    validate_urn_prefix,
)
from geo.models import CountryConfig
from sites.models import UserProfile

User = get_user_model()

try:  # The re-encode guarantee depends on it; see validate_logo.
    import PIL  # noqa: F401

    PILLOW_AVAILABLE = True
except ImportError:
    PILLOW_AVAILABLE = False

PNG_1PX = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


class LogoUploadRulesTests(SimpleTestCase):
    def test_svg_is_refused_outright(self):
        """An SVG is an executable document rendered on the public dashboard."""
        for payload, name in (
            (b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "logo.svg"),
            (b'<?xml version="1.0"?><svg onload="alert(1)"/>', "logo.png"),  # lying filename
        ):
            with self.subTest(name=name):
                with self.assertRaisesMessage(ValidationError, "SVG"):
                    validate_logo(payload, filename=name)

    def test_content_is_judged_by_bytes_not_by_filename(self):
        with self.assertRaisesMessage(ValidationError, "not a PNG, JPEG or WebP"):
            validate_logo(b"GIF89a not really an image", filename="logo.png")

    def test_html_disguised_as_an_image_is_refused(self):
        with self.assertRaises(ValidationError):
            validate_logo(b"<html><script>alert(1)</script></html>", filename="logo.jpg")

    def test_an_oversized_file_is_refused_before_decoding(self):
        with self.assertRaisesMessage(ValidationError, "limit is"):
            validate_logo(b"\x89PNG\r\n\x1a\n" + b"0" * (3 * 1024 * 1024), filename="big.png")

    def test_an_empty_file_is_refused(self):
        with self.assertRaisesMessage(ValidationError, "empty"):
            validate_logo(b"", filename="logo.png")

    def test_a_real_png_is_accepted_and_re_encoded(self):
        if not PILLOW_AVAILABLE:
            self.skipTest("Pillow is not installed; the fail-closed path is covered below")
        data, content_type = validate_logo(PNG_1PX, filename="logo.png")
        self.assertEqual(content_type, "image/png")
        self.assertEqual(detect_image_format(data), "PNG")

    def test_trailing_payload_does_not_survive_re_encoding(self):
        """A valid header followed by hostile bytes must not be stored verbatim."""
        if not PILLOW_AVAILABLE:
            self.skipTest("Pillow is not installed; the fail-closed path is covered below")
        data, _ = validate_logo(PNG_1PX + b"<script>alert(1)</script>", filename="logo.png")
        self.assertNotIn(b"<script>", data)

    def test_uploads_fail_closed_when_the_imaging_library_is_missing(self):
        """The re-encode guarantee is either enforced or the upload is refused.

        Accepting bytes this codebase cannot decode would leave a documented guarantee
        that only appears to hold.
        """
        if PILLOW_AVAILABLE:
            self.skipTest("Pillow is installed; re-encoding is enforced")
        with self.assertRaisesMessage(ValidationError, "imaging library is not installed"):
            validate_logo(PNG_1PX, filename="logo.png")


class UrlRuleTests(SimpleTestCase):
    def test_only_https_is_accepted(self):
        """These values are rendered into pages and into exported FHIR."""
        for bad in (
            "javascript:alert(1)",
            "data:text/html;base64,PHNjcmlwdD4=",
            "file:///etc/passwd",
            "http://example.org",
            "//example.org",
            "example.org",
            "",
        ):
            with self.subTest(value=bad):
                with self.assertRaises(ValidationError):
                    validate_https_url(bad, field="Base URI")

    def test_a_valid_https_url_is_normalised(self):
        self.assertEqual(validate_https_url("https://amr.example/", field="Base URI"), "https://amr.example")

    def test_urn_prefix_shape_is_enforced(self):
        self.assertEqual(validate_urn_prefix("urn:example:amr"), "urn:example:amr")
        for bad in ("example:amr", "urn:", "urn:Example:AMR", "urn:example:amr:"):
            with self.subTest(value=bad):
                if bad == "urn:example:amr:":
                    self.assertEqual(validate_urn_prefix(bad), "urn:example:amr")
                    continue
                with self.assertRaises(ValidationError):
                    validate_urn_prefix(bad)


class OverrideValidationTests(SimpleTestCase):
    def test_build_time_only_fields_are_refused_with_an_explanation(self):
        with self.assertRaisesMessage(ValidationError, "built and signed"):
            validate_overrides({"branding": {"app_id": "com.example.amr"}})

    def test_unknown_settings_are_refused(self):
        with self.assertRaisesMessage(ValidationError, "Unknown setting"):
            validate_overrides({"not_a_setting": 1})

    def test_namespace_urls_go_through_the_url_rule(self):
        with self.assertRaises(ValidationError):
            validate_overrides({"identifier_namespace": {"base_uri": "javascript:alert(1)", "urn_prefix": "urn:x:y"}})

    def test_tile_url_goes_through_the_url_rule(self):
        with self.assertRaises(ValidationError):
            validate_overrides({"map": {"tile_url": "http://tiles.example/{z}/{x}/{y}.png"}})

    def test_colours_must_be_hex(self):
        with self.assertRaisesMessage(ValidationError, "hex"):
            validate_overrides({"branding": {"colors": {"navy": "red"}}})

    def test_duplicate_admin_levels_are_refused(self):
        with self.assertRaisesMessage(ValidationError, "more than once"):
            validate_overrides({"admin_levels": [
                {"level": 1, "key": "a", "label": "A", "label_plural": "As", "code_system": "X"},
                {"level": 1, "key": "b", "label": "B", "label_plural": "Bs", "code_system": "X"},
            ]})

    def test_a_valid_override_document_passes(self):
        cleaned = validate_overrides({
            "identifier_namespace": {"base_uri": "https://amr.example", "urn_prefix": "urn:example:amr"},
            "branding": {"product_name": "AMR Example", "colors": {"navy": "#123456"}},
            "map": {"tile_url": "https://tiles.example/{z}/{x}/{y}.png"},
        })
        self.assertEqual(cleaned["identifier_namespace"]["base_uri"], "https://amr.example")

    def test_overrides_merge_one_level_deep(self):
        base = {"branding": {"product_name": "A", "authority_name": "B"}, "locale": "en"}
        merged = apply_overrides(base, {"branding": {"product_name": "C"}})
        self.assertEqual(merged["branding"], {"product_name": "C", "authority_name": "B"})
        self.assertEqual(merged["locale"], "en")

    def test_namespace_changes_are_reported_as_irreversible(self):
        current = {"identifier_namespace": {"base_uri": "https://a.example", "urn_prefix": "urn:a:b"}}
        proposed = {"identifier_namespace": {"base_uri": "https://b.example", "urn_prefix": "urn:a:b"}}
        self.assertEqual(irreversible_changes(current, proposed), ["identifier_namespace"])
        self.assertEqual(irreversible_changes(current, current), [])


class DeploymentViewAuthorisationTests(TestCase):
    """Authorisation is enforced in the view. Hiding a menu item is not an access control."""

    def setUp(self):
        cp.clear_cache()
        CountryConfig.objects.get_or_create(country_code="IND", defaults={"profile_id": "IN"})

    def tearDown(self):
        cp.clear_cache()

    def _client_for(self, *, superuser=False, role="citizen"):
        client = Client()
        if superuser:
            user = User.objects.create_superuser(username=f"root{User.objects.count()}", email="a@b.c", password="pw")
        else:
            user = User.objects.create_user(username=f"user{User.objects.count()}", password="pw")
            UserProfile.objects.create(user=user, role=role)
        client.force_login(user)
        return client

    def test_an_unprivileged_user_is_refused_on_every_endpoint(self):
        client = self._client_for(role="hospital_admin")
        for name, method in (
            ("dashboard_deployment", "get"),
            ("dashboard_deployment_save", "post"),
            ("dashboard_deployment_logo", "post"),
            ("dashboard_deployment_reset", "post"),
            ("dashboard_deployment_export", "get"),
            ("dashboard_deployment_json", "get"),
        ):
            with self.subTest(endpoint=name):
                response = getattr(client, method)(reverse(name), {"country": "IND"})
                self.assertEqual(response.status_code, 403)

    def test_an_anonymous_user_is_redirected_to_sign_in(self):
        response = Client().get(reverse("dashboard_deployment"))
        self.assertIn(response.status_code, {302, 403})

    def test_a_privileged_user_can_read_the_screen(self):
        response = self._client_for(superuser=True).get(reverse("dashboard_deployment"), {"country": "IND"})
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Deployment settings")

    def test_saving_a_namespace_change_requires_explicit_confirmation(self):
        client = self._client_for(superuser=True)
        overrides = json.dumps({
            "identifier_namespace": {"base_uri": "https://amr.example", "urn_prefix": "urn:example:amr"}
        })

        client.post(reverse("dashboard_deployment_save"),
                    {"country": "IND", "overrides": overrides}, follow=True)
        self.assertEqual(CountryConfig.objects.get(country_code="IND").overrides, {})

        client.post(reverse("dashboard_deployment_save"),
                    {"country": "IND", "overrides": overrides, "confirm_irreversible": "yes"}, follow=True)
        stored = CountryConfig.objects.get(country_code="IND").overrides
        self.assertEqual(stored["identifier_namespace"]["base_uri"], "https://amr.example")
        # Stamped so exports made before the change stay explainable.
        self.assertIn("effective_from", stored["identifier_namespace"])

    def test_a_hostile_url_is_refused_through_the_view(self):
        client = self._client_for(superuser=True)
        client.post(reverse("dashboard_deployment_save"), {
            "country": "IND",
            "overrides": json.dumps({"map": {"tile_url": "javascript:alert(1)"}}),
        }, follow=True)
        self.assertEqual(CountryConfig.objects.get(country_code="IND").overrides, {})

    def test_an_svg_upload_is_refused_through_the_view(self):
        client = self._client_for(superuser=True)
        upload = io.BytesIO(b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
        upload.name = "logo.svg"
        response = client.post(reverse("dashboard_deployment_logo"),
                               {"country": "IND", "logo": upload}, follow=True)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(CountryConfig.objects.get(country_code="IND").overrides, {})

    def test_a_valid_logo_is_stored_re_encoded(self):
        client = self._client_for(superuser=True)
        upload = io.BytesIO(PNG_1PX)
        upload.name = "logo.png"
        client.post(reverse("dashboard_deployment_logo"), {"country": "IND", "logo": upload}, follow=True)
        stored = CountryConfig.objects.get(country_code="IND").overrides
        if PILLOW_AVAILABLE:
            self.assertTrue(stored["branding"]["logo"].startswith("data:image/png;base64,"))
        else:
            # Fail closed: nothing is stored when the guarantee cannot be honoured.
            self.assertEqual(stored, {})

    def test_reset_returns_to_the_base_profile(self):
        client = self._client_for(superuser=True)
        CountryConfig.objects.filter(country_code="IND").update(overrides={"locale": "ta-IN"})
        client.post(reverse("dashboard_deployment_reset"), {"country": "IND"}, follow=True)
        self.assertEqual(CountryConfig.objects.get(country_code="IND").overrides, {})

    def test_export_returns_the_effective_profile(self):
        response = self._client_for(superuser=True).get(reverse("dashboard_deployment_export"), {"country": "IND"})
        self.assertEqual(response.status_code, 200)
        self.assertIn("attachment", response["Content-Disposition"])
        self.assertEqual(json.loads(response.content)["country_code"], "IND")
