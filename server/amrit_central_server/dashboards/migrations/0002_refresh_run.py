import django.db.models.deletion
import django.utils.timezone
import uuid

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("dashboards", "0001_initial")]

    operations = [
        migrations.CreateModel(
            name="DashboardRefreshRun",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("scope_type", models.CharField(choices=[("national", "National"), ("state", "State"), ("district", "District"), ("site", "Site / facility")], db_index=True, default="national", max_length=16)),
                ("scope_value", models.CharField(blank=True, db_index=True, max_length=120)),
                ("status", models.CharField(choices=[("pending", "Pending"), ("success", "Success"), ("partial", "Partial"), ("failed", "Failed")], db_index=True, default="pending", max_length=16)),
                ("clicked_at", models.DateTimeField(db_index=True, default=django.utils.timezone.now)),
                ("completed_at", models.DateTimeField(blank=True, null=True)),
                ("expected_sites", models.PositiveIntegerField(default=0)),
                ("responded_sites", models.PositiveIntegerField(default=0)),
                ("failed_sites", models.PositiveIntegerField(default=0)),
                ("records_represented", models.PositiveBigIntegerField(default=0)),
                ("fhir_bundles", models.PositiveIntegerField(default=0)),
                ("site_lab_codes", models.JSONField(blank=True, default=list)),
                ("query_ids", models.JSONField(blank=True, default=list)),
            ],
            options={
                "ordering": ["-clicked_at"],
                "indexes": [models.Index(fields=["scope_type", "scope_value", "-clicked_at"], name="dash_refresh_scope_time_idx")],
            },
        ),
        migrations.AddField(
            model_name="kpisnapshot",
            name="refresh_run",
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="snapshots", to="dashboards.dashboardrefreshrun"),
        ),
    ]
