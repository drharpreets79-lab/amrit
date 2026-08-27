from django.db import migrations, models


BUILTINS = {
    "super_admin": ("Super Admin", "national", "all"),
    "icmr_user": ("ICMR User", "national", "all"),
    "policy_maker": ("Policy Maker", "national", "all"),
    "researcher": ("Researcher", "epidemiologist", "all"),
    "epidemiologist": ("Epidemiologist", "epidemiologist", "all"),
    "public_health_expert": ("Public Health Expert", "national", "all"),
    "state_health_officer": ("State Health Officer", "state", "state"),
    "district_health_officer": ("District Health Officer", "district", "district"),
    "hospital_admin": ("Hospital Administrator", "hospital", "site"),
    "press": ("Press / Media", "", "none"),
    "citizen": ("Citizen", "", "none"),
}

CAP_MAP = {
    "super_admin": ["view_dashboard", "view_all_sites", "view_map", "run_query", "view_queries", "view_audit", "manage_users", "manage_sites", "view_public_summary", "view_basic_dashboard", "view_advanced_dashboard", "manage_action_plans", "track_action_points"],
    "icmr_user": ["view_dashboard", "view_all_sites", "view_map", "run_query", "view_queries", "view_audit", "manage_sites", "view_public_summary", "view_basic_dashboard", "view_advanced_dashboard", "manage_action_plans", "track_action_points"],
    "policy_maker": ["view_dashboard", "view_all_sites", "view_map", "view_queries", "view_public_summary", "view_basic_dashboard", "view_advanced_dashboard", "manage_action_plans", "track_action_points"],
    "researcher": ["view_dashboard", "view_all_sites", "view_map", "run_query", "view_queries", "view_public_summary", "view_basic_dashboard", "view_advanced_dashboard", "track_action_points"],
    "epidemiologist": ["view_dashboard", "view_all_sites", "view_map", "run_query", "view_queries", "view_audit", "view_public_summary", "view_basic_dashboard", "view_advanced_dashboard", "manage_action_plans", "track_action_points"],
    "public_health_expert": ["view_dashboard", "view_all_sites", "view_map", "run_query", "view_queries", "view_public_summary", "view_basic_dashboard", "view_advanced_dashboard", "manage_action_plans", "track_action_points"],
    "state_health_officer": ["view_dashboard", "view_scoped_sites", "view_map", "run_query", "view_queries", "view_public_summary", "view_basic_dashboard", "view_advanced_dashboard", "manage_action_plans", "track_action_points"],
    "district_health_officer": ["view_dashboard", "view_scoped_sites", "view_map", "run_query", "view_queries", "view_public_summary", "view_basic_dashboard", "view_advanced_dashboard", "manage_action_plans", "track_action_points"],
    "hospital_admin": ["view_dashboard", "view_own_site", "run_query", "view_queries", "view_public_summary", "view_basic_dashboard", "view_advanced_dashboard", "track_action_points"],
    "press": ["view_dashboard", "view_public_summary"],
    "citizen": ["view_public_summary"],
}


def seed_roles(apps, schema_editor):
    Role = apps.get_model("amrit_sites", "RoleDefinition")
    for slug, (label, dashboard, scope) in BUILTINS.items():
        Role.objects.get_or_create(slug=slug, defaults={"label": label, "dashboard_kind": dashboard, "scope_kind": scope, "capabilities": CAP_MAP[slug], "is_system": True})


class Migration(migrations.Migration):
    dependencies = [("amrit_sites", "0003_site_is_online")]
    operations = [
        migrations.AlterField(model_name="userprofile", name="role", field=models.CharField(db_index=True, default="citizen", max_length=32)),
        migrations.CreateModel(
            name="RoleDefinition",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("slug", models.SlugField(max_length=32, unique=True)),
                ("label", models.CharField(max_length=100)),
                ("description", models.TextField(blank=True)),
                ("dashboard_kind", models.CharField(blank=True, choices=[("", "Operations / public only"), ("national", "National"), ("state", "State"), ("district", "District"), ("epidemiologist", "Epidemiology"), ("hospital", "Hospital")], max_length=32)),
                ("scope_kind", models.CharField(choices=[("none", "No sites"), ("all", "All sites"), ("state", "Profile state"), ("district", "Profile state + district"), ("site", "Assigned site")], default="none", max_length=16)),
                ("capabilities", models.JSONField(blank=True, default=list)),
                ("is_system", models.BooleanField(default=False)),
                ("is_active", models.BooleanField(default=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={"ordering": ["label"]},
        ),
        migrations.RunPython(seed_roles, migrations.RunPython.noop),
    ]
