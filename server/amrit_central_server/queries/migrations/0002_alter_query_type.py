from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("queries", "0001_initial")]

    operations = [
        migrations.AlterField(
            model_name="query",
            name="type",
            field=models.CharField(
                choices=[
                    ("heartbeat", "Heartbeat"),
                    ("isolate_count", "Isolate count"),
                    ("organism_distribution", "Organism distribution"),
                    ("specimen_distribution", "Specimen distribution"),
                    ("resistance_rate", "Resistance rate"),
                    ("measure_bundle", "FHIR MeasureReport bundle"),
                    ("cluster_scan", "Outbreak scan aggregate cases"),
                ],
                db_index=True,
                max_length=64,
            ),
        ),
    ]
