from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse
from django.utils import timezone

from sites.models import RoleDefinition, Site, UserProfile
from .admin_forms import PortalUserForm
from .site_ordering import online_first_sites


class LiveExplorerRoleTests(TestCase):
    """Scope is a place in the tree, so these tests place their sites in one."""

    def setUp(self):
        from geo.models import AdminUnit

        self.karnataka = AdminUnit.objects.create(
            id="IND:1:29", country_code="IND", level=1, code="29", name="Karnataka", admin_path="IND/29")
        self.bengaluru = AdminUnit.objects.create(
            id="IND:2:572", country_code="IND", level=2, code="572", parent=self.karnataka,
            name="Bengaluru Urban", admin_path="IND/29/572")
        self.delhi = AdminUnit.objects.create(
            id="IND:1:07", country_code="IND", level=1, code="07", name="Delhi", admin_path="IND/07")

        self.ka = Site.objects.create(lab_code="KA-1", name="KA Lab", admin_unit=self.bengaluru,
                                      status="active", auth_token_hash="x")
        self.dl = Site.objects.create(lab_code="DL-1", name="Delhi Lab", admin_unit=self.delhi,
                                      status="active", auth_token_hash="y")
        RoleDefinition.objects.update_or_create(
            slug="admin_officer",
            defaults={"label": "Administrative officer", "scope_kind": "admin", "dashboard_kind": "admin",
                      "capabilities": ["view_dashboard", "view_scoped_sites", "run_query"], "is_active": True},
        )

    def user(self, username, role, **profile):
        user = get_user_model().objects.create_user(username=username, password="test-pass")
        UserProfile.objects.create(user=user, role=role, **profile)
        return user

    def test_an_officer_sees_only_their_own_subtree(self):
        self.client.force_login(self.user("level1", "admin_officer", admin_unit=self.karnataka))
        response = self.client.get(reverse("query_new"))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "KA Lab")
        self.assertNotContains(response, "Delhi Lab")

    def test_the_site_filter_is_one_control_for_every_level(self):
        """No "State" box and "District" box: one unit picker, whatever the depth."""
        self.client.force_login(self.user("level1b", "admin_officer", admin_unit=self.karnataka))
        response = self.client.get(reverse("query_new"))
        self.assertContains(response, 'name="admin_path"')
        self.assertNotContains(response, 'name="state"')
        self.assertNotContains(response, 'name="district"')

    def test_hospital_admin_can_query_only_own_site(self):
        self.client.force_login(self.user("hospital", "hospital_admin", admin_unit=self.bengaluru, site=self.ka))
        response = self.client.get(reverse("query_new"))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "KA Lab")
        self.assertNotContains(response, "Delhi Lab")

    def test_live_endpoint_rejects_lab_outside_role_scope(self):
        self.client.force_login(self.user("level2", "admin_officer", admin_unit=self.bengaluru))
        response = self.client.get(reverse("trigger_desktop_filter"), {"target_lab_codes": "DL-1"})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"], "One or more labs are outside your role scope.")

    def test_an_officer_with_no_unit_sees_nothing(self):
        """Fails closed: no unit is no scope, never every site."""
        self.client.force_login(self.user("unplaced", "admin_officer"))
        response = self.client.get(reverse("query_new"))
        self.assertNotContains(response, "KA Lab")
        self.assertNotContains(response, "Delhi Lab")


class PortalAdministrationTests(TestCase):
    def setUp(self):
        self.admin = get_user_model().objects.create_superuser("root", "root@example.com", "root-pass-123")
        self.client.force_login(self.admin)

    def test_admin_can_define_role_and_create_login(self):
        response = self.client.post(reverse("portal_admin_role_new"), {
            "slug": "lab_reviewer", "label": "Lab Reviewer", "description": "Reviews own laboratory",
            "dashboard_kind": "hospital", "scope_kind": "site",
            "capabilities": ["view_dashboard", "view_own_site", "view_basic_dashboard"], "is_active": "on",
        })
        self.assertRedirects(response, reverse("portal_admin_roles"))
        role = RoleDefinition.objects.get(slug="lab_reviewer")
        self.assertIn("view_own_site", role.capabilities)

        response = self.client.post(reverse("portal_admin_user_new"), {
            "username": "reviewer", "password": "Reviewer@2026", "is_active": "on",
            "role": role.slug, "first_name": "Lab", "last_name": "Reviewer",
            "email": "", "organization": "", "designation": "", "admin_unit": "", "site": "",
        })
        self.assertRedirects(response, reverse("portal_admin_users"))
        self.assertTrue(self.client.login(username="reviewer", password="Reviewer@2026"))

    def test_non_admin_cannot_open_portal_admin(self):
        user = get_user_model().objects.create_user("citizen2", password="Citizen@2026")
        UserProfile.objects.create(user=user, role="citizen")
        self.client.force_login(user)
        self.assertEqual(self.client.get(reverse("portal_admin_home")).status_code, 403)


class SiteSelectionOrderingTests(TestCase):
    def setUp(self):
        self.off_z = Site.objects.create(lab_code="OFF-Z", name="Zulu Offline", status="active", auth_token_hash="1")
        self.on_z = Site.objects.create(lab_code="ON-Z", name="Zulu Online", status="active", auth_token_hash="2", is_online=True)
        self.off_a = Site.objects.create(lab_code="OFF-A", name="Alpha Offline", status="active", auth_token_hash="3")
        self.on_a = Site.objects.create(lab_code="ON-A", name="Alpha Online", status="active", auth_token_hash="4", last_seen_at=timezone.now())

    def test_helper_groups_online_then_offline_with_alpha_sort(self):
        ordered = online_first_sites(Site.objects.all())
        self.assertEqual([s.lab_code for s in ordered], ["ON-A", "ON-Z", "OFF-A", "OFF-Z"])

    def test_query_site_selector_uses_shared_order(self):
        admin = get_user_model().objects.create_superuser("sortadmin", "sort@example.com", "pass-12345")
        self.client.force_login(admin)
        response = self.client.get(reverse("query_new"))
        self.assertEqual([s.lab_code for s in response.context["available_sites"]], ["ON-A", "ON-Z", "OFF-A", "OFF-Z"])

    def test_admin_site_choice_uses_same_order_and_status_markers(self):
        labels = [label for value, label in PortalUserForm().fields["site"].choices if value]
        self.assertEqual(labels, ["● Alpha Online · ON-A", "● Zulu Online · ON-Z", "○ Alpha Offline · OFF-A", "○ Zulu Offline · OFF-Z"])
