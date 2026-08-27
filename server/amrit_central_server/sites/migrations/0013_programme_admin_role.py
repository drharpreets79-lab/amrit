from django.db import migrations


OLD_SLUG = "icmr_user"
NEW_SLUG = "programme_admin"


def rename_role(apps, schema_editor):
    RoleDefinition = apps.get_model("amrit_sites", "RoleDefinition")
    UserProfile = apps.get_model("amrit_sites", "UserProfile")

    old = RoleDefinition.objects.filter(slug=OLD_SLUG).first()
    current = RoleDefinition.objects.filter(slug=NEW_SLUG).first()
    if old and current:
        current.capabilities = sorted(set(current.capabilities or []) | set(old.capabilities or []))
        current.is_system = current.is_system or old.is_system
        current.is_active = current.is_active or old.is_active
        current.save(update_fields=["capabilities", "is_system", "is_active"])
        old.delete()
    elif old:
        old.slug = NEW_SLUG
        if old.label == "ICMR User":
            old.label = "Programme Administrator"
        old.save(update_fields=["slug", "label"])
    else:
        RoleDefinition.objects.get_or_create(
            slug=NEW_SLUG,
            defaults={
                "label": "Programme Administrator",
                "dashboard_kind": "country",
                "scope_kind": "all",
                "is_system": True,
                "is_active": True,
            },
        )
    UserProfile.objects.filter(role=OLD_SLUG).update(role=NEW_SLUG)


def reverse_role(apps, schema_editor):
    RoleDefinition = apps.get_model("amrit_sites", "RoleDefinition")
    UserProfile = apps.get_model("amrit_sites", "UserProfile")
    current = RoleDefinition.objects.filter(slug=NEW_SLUG).first()
    if current and not RoleDefinition.objects.filter(slug=OLD_SLUG).exists():
        current.slug = OLD_SLUG
        if current.label == "Programme Administrator":
            current.label = "ICMR User"
        current.save(update_fields=["slug", "label"])
    UserProfile.objects.filter(role=NEW_SLUG).update(role=OLD_SLUG)


class Migration(migrations.Migration):
    dependencies = [("amrit_sites", "0012_siteenrolmentrequest_pickup_expires_at")]
    operations = [migrations.RunPython(rename_role, reverse_role)]
