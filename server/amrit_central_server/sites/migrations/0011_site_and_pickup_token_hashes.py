"""Store the site's second factor as a hash, and give an enrolment request a pickup secret.

``Site.site_token`` held the second factor in clear, in a column that was listed in the REST
API's and the Django admin's ``search_fields`` — so the credential that is supposed to travel
by a separate channel could be read straight out of the registry. Existing values are hashed
in place here rather than discarded, so a deployment that has already distributed site tokens
keeps working; the plaintext column is then dropped.

``SiteEnrolmentRequest.pickup_token_hash`` is how an installation later proves it is the one
collecting the answer to its own request, without every laboratory being given a shared
enrolment secret.
"""

import hashlib

from django.db import migrations, models


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest() if token else ""


def hash_existing_site_tokens(apps, schema_editor):
    Site = apps.get_model("amrit_sites", "Site")
    for site in Site.objects.exclude(site_token="").only("id", "site_token"):
        site.site_token_hash = _hash_token(site.site_token)
        site.site_token_prefix = site.site_token[:8]
        site.save(update_fields=["site_token_hash", "site_token_prefix"])


def unhash_is_impossible(apps, schema_editor):
    """Reversing drops the hashes; the plaintext is not recoverable by design.

    A deployment rolling this back has to reissue site tokens. Saying so here is better than
    a reverse that silently leaves every site unable to authenticate.
    """
    Site = apps.get_model("amrit_sites", "Site")
    Site.objects.update(site_token_hash="", site_token_prefix="")


class Migration(migrations.Migration):

    dependencies = [("amrit_sites", "0010_siteenrolmentrequest")]

    operations = [
        migrations.AddField(
            model_name="site",
            name="site_token_hash",
            field=models.CharField(blank=True, db_index=True, max_length=128),
        ),
        migrations.AddField(
            model_name="site",
            name="site_token_prefix",
            field=models.CharField(blank=True, max_length=8),
        ),
        migrations.RunPython(hash_existing_site_tokens, unhash_is_impossible),
        migrations.RemoveField(model_name="site", name="site_token"),
        migrations.AddField(
            model_name="siteenrolmentrequest",
            name="pickup_token_hash",
            field=models.CharField(blank=True, db_index=True, max_length=128),
        ),
        migrations.AddField(
            model_name="siteenrolmentrequest",
            name="pickup_redeemed_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
    ]
