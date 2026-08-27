"""Grant the deployment-settings capability to the roles that should hold it.

has_cap consults RoleDefinition before the ROLE_CAPS defaults, so a capability added in
code is invisible until the seeded rows carry it. Without this migration a superuser is
refused by their own portal.

Deliberately narrow: only super_admin. Editing the identifier namespace changes what every
downstream FHIR consumer sees, which is a different authority from managing users, so it
is not bundled with CAP_MANAGE_USERS.
"""

from __future__ import annotations

from django.db import migrations

CAPABILITY = "manage_deployment"
GRANT_TO = ("super_admin",)


def grant(apps, schema_editor):
    RoleDefinition = apps.get_model("amrit_sites", "RoleDefinition")
    for definition in RoleDefinition.objects.filter(slug__in=GRANT_TO):
        capabilities = list(definition.capabilities or [])
        if CAPABILITY not in capabilities:
            capabilities.append(CAPABILITY)
            definition.capabilities = capabilities
            definition.save(update_fields=["capabilities"])


def revoke(apps, schema_editor):
    RoleDefinition = apps.get_model("amrit_sites", "RoleDefinition")
    for definition in RoleDefinition.objects.filter(slug__in=GRANT_TO):
        capabilities = [cap for cap in (definition.capabilities or []) if cap != CAPABILITY]
        definition.capabilities = capabilities
        definition.save(update_fields=["capabilities"])


class Migration(migrations.Migration):
    dependencies = [("amrit_sites", "0007_roledefinition_scope_level_and_more")]

    operations = [migrations.RunPython(grant, revoke)]
