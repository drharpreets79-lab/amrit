from django.db import migrations


class Migration(migrations.Migration):
    """Join the independent query-type and FHIR-result schema branches."""

    dependencies = [
        ("queries", "0002_alter_query_type"),
        ("queries", "0002_queryresult_fhir_json"),
    ]

    operations = []
