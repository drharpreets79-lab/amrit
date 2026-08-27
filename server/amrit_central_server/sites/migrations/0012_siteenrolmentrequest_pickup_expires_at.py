from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("amrit_sites", "0011_site_and_pickup_token_hashes")]

    operations = [
        migrations.AddField(
            model_name="siteenrolmentrequest",
            name="pickup_expires_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
    ]
