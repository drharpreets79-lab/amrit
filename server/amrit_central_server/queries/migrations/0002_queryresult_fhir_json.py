from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("queries", "0001_initial")]

    operations = [
        migrations.AddField(
            model_name="queryresult",
            name="fhir_json",
            field=models.JSONField(blank=True, default=dict),
        ),
    ]
