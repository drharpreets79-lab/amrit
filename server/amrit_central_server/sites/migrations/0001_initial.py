from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True
    dependencies = []

    operations = [
        migrations.CreateModel(
            name="Site",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("lab_code", models.CharField(db_index=True, max_length=32, unique=True)),
                ("site_token", models.CharField(blank=True, db_index=True, max_length=128)),
                ("name", models.CharField(max_length=200)),
                ("country", models.CharField(blank=True, max_length=100)),
                ("state", models.CharField(blank=True, max_length=100)),
                ("district", models.CharField(blank=True, max_length=100)),
                ("lab_domain", models.CharField(blank=True, max_length=80)),
                ("auth_token_hash", models.CharField(db_index=True, max_length=128)),
                ("auth_token_prefix", models.CharField(blank=True, max_length=8)),
                ("allowed_query_types", models.JSONField(blank=True, default=list)),
                (
                    "status",
                    models.CharField(
                        choices=[("active", "Active"), ("disabled", "Disabled"), ("provisioning", "Provisioning")],
                        default="active",
                        max_length=16,
                    ),
                ),
                ("last_seen_at", models.DateTimeField(blank=True, null=True)),
                ("last_poll_at", models.DateTimeField(blank=True, null=True)),
                ("last_response_at", models.DateTimeField(blank=True, null=True)),
                ("contact_email", models.EmailField(blank=True, max_length=254)),
                ("notes", models.TextField(blank=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={"ordering": ["lab_code"]},
        ),
    ]
