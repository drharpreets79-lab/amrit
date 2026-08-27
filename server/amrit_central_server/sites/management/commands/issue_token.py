"""Issue (or rotate) a bearer auth token for an AMRIT site.

Usage:
    python manage.py issue_token SITE-001
    python manage.py issue_token SITE-001 --rotate
    python manage.py issue_token SITE-001 --create   # create site if missing
"""

from __future__ import annotations

from django.core.management.base import BaseCommand, CommandError

from central.country_profile import get_profile
from sites.models import Site


class Command(BaseCommand):
    help = "Mint or rotate the bearer auth token for an AMRIT site."

    def add_arguments(self, parser):
        parser.add_argument("lab_code", help="Site.lab_code (e.g. SITE-001)")
        parser.add_argument("--rotate", action="store_true",
                            help="Rotate even if a token is already set.")
        parser.add_argument("--create", action="store_true",
                            help="Create the site if it does not exist.")
        parser.add_argument("--name", default="", help="Site name when --create is used.")

    def handle(self, *args, **opts):
        lab_code = opts["lab_code"].strip()
        if not lab_code:
            raise CommandError("lab_code is required")

        site = Site.objects.filter(lab_code=lab_code).first()
        if site is None:
            if not opts["create"]:
                raise CommandError(
                    f"No site with lab_code={lab_code!r}. "
                    f"Pass --create to make one, or check Django admin."
                )
            profile = get_profile()
            site = Site.objects.create(
                lab_code=lab_code,
                name=opts["name"] or lab_code,
                country=profile["country_name"],
                country_code=profile["country_code"],
                status="active",
            )
            self.stdout.write(self.style.SUCCESS(f"created site {lab_code}"))

        if site.auth_token_hash and not opts["rotate"]:
            raise CommandError(
                f"Site {lab_code} already has a token. Pass --rotate to replace it."
            )

        token = Site.issue_token()
        site.set_auth_token(token)
        site.save(update_fields=["auth_token_hash", "auth_token_prefix"])

        self.stdout.write("")
        self.stdout.write(self.style.SUCCESS(f"Bearer token for {lab_code}:"))
        self.stdout.write(f"  {token}")
        self.stdout.write("")
        self.stdout.write("Paste into AMRIT Settings → Network Sync:")
        self.stdout.write(f"  Server URL  : http://<central-server-host>:8000")
        self.stdout.write(f"  Lab code    : {lab_code}")
        self.stdout.write(f"  Bearer token: {token}")
        self.stdout.write(f"  Site token  : (leave blank)")
        self.stdout.write("")
        self.stdout.write(self.style.WARNING(
            "This token is shown ONCE. Store it securely; only its hash is kept on the server."
        ))
