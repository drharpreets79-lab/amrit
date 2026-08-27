from django.db import migrations


def mark_legacy_snapshots_stale(apps, schema_editor):
    KPISnapshot = apps.get_model("dashboards", "KPISnapshot")
    KPISnapshot.objects.filter(refresh_run__isnull=True).exclude(source="seed").update(is_stale=True)


class Migration(migrations.Migration):
    dependencies = [("dashboards", "0002_refresh_run")]

    operations = [migrations.RunPython(mark_legacy_snapshots_stale, migrations.RunPython.noop)]
