"""Take a fresh installation to a working deployment for one country.

    python manage.py bootstrap --country NGA

Idempotent and re-runnable: it reports what already exists rather than failing or
duplicating. Nothing here invents a credential — an administrator password and the site
enrolment secret are either supplied or the step is skipped with an explanation.
"""

from __future__ import annotations

import secrets

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError

from central import country_profile as cp
from geo.loader import GeoPackError, available_packs, load_pack, read_pack
from geo.models import AdminUnit, CountryConfig

User = get_user_model()


class Command(BaseCommand):
    help = "Prepare this server for a country: profile, geography, roles and the first administrator."

    def add_arguments(self, parser):
        parser.add_argument("--country", required=True, help="ISO 3166-1 alpha-2 or alpha-3, or a curated profile id")
        parser.add_argument("--admin-username", default="", help="create this superuser if it does not exist")
        parser.add_argument("--admin-email", default="", help="email for the superuser")
        parser.add_argument(
            "--admin-password",
            default="",
            help="password for the superuser; omit to skip creating the account",
        )
        parser.add_argument(
            "--print-enrolment-secret",
            action="store_true",
            help="generate a site enrolment secret to put in AMRIT_ENROLMENT_SECRET",
        )
        parser.add_argument("--skip-geo", action="store_true", help="do not load a bundled geo pack")

    def handle(self, *args, **options):
        requested = str(options["country"]).strip()

        # 1. Resolve the profile. Any ISO 3166-1 country works with nothing authored.
        try:
            profile = cp.get_profile(requested)
        except cp.ProfileError as error:
            raise CommandError(str(error)) from error
        country_code = profile["country_code"]
        self.stdout.write(
            f"Country profile: {profile['country_name']} ({country_code}), source {profile.get('source', 'curated')}"
        )
        levels = ", ".join(level["label"] for level in profile["admin_levels"]) or "none"
        self.stdout.write(f"  administrative levels: {levels}")
        if profile.get("timezone_ambiguous"):
            self.stdout.write(self.style.WARNING(
                "  this country spans several time zones, so there is no correct default; "
                "set each site's own zone."
            ))

        # 2. Record it, so a multi-country deployment knows which countries it hosts.
        config, created = CountryConfig.objects.get_or_create(
            country_code=country_code, defaults={"profile_id": profile["profile_id"]}
        )
        self.stdout.write(f"  country configuration: {'created' if created else 'already present'}")

        # 3. Geography, if a pack ships for this country.
        if options["skip_geo"]:
            self.stdout.write("  geography: skipped")
        else:
            self._load_geography(profile, country_code)

        # 4. Role definitions, so capabilities exist before anyone signs in.
        self._report_roles()

        # 5. The first administrator. Never with an invented password.
        self._create_admin(options)

        # 6. The enrolment secret, without which no site can register.
        self._enrolment_secret(options)

        self.stdout.write(self.style.SUCCESS(f"\nbootstrap complete for {country_code}."))
        self.stdout.write("Next: put a TLS reverse proxy in front, then register the first site.")

    def _load_geography(self, profile: dict, country_code: str) -> None:
        existing = AdminUnit.objects.for_country(country_code).count()
        if existing:
            self.stdout.write(f"  geography: {existing} unit(s) already loaded")
            return
        for candidate in (profile["profile_id"], country_code):
            try:
                pack = read_pack(candidate)
            except GeoPackError:
                continue
            result = load_pack(pack)
            self.stdout.write(f"  geography: loaded {result['total']} unit(s) from the {candidate} pack")
            return
        # Not an error: most countries have no bundled pack yet, and the importer is the
        # documented route. Saying so plainly beats a silent empty tree.
        self.stdout.write(self.style.WARNING(
            f"  geography: no bundled pack for {country_code} "
            f"(bundled: {', '.join(available_packs()) or 'none'})"
        ))
        self.stdout.write(
            "    import your own with: manage.py import_admin_units --country "
            f"{country_code} --file units.csv --level 1:region:Region:Regions:ISO3166-2"
        )

    def _report_roles(self) -> None:
        try:
            from sites.models import RoleDefinition

            total = RoleDefinition.objects.filter(is_active=True).count()
            self.stdout.write(f"  roles: {total} active definition(s)")
        except Exception as error:  # noqa: BLE001 - reporting only
            self.stdout.write(self.style.WARNING(f"  roles: could not be read ({error})"))

    def _create_admin(self, options: dict) -> None:
        username = str(options["admin_username"]).strip()
        password = str(options["admin_password"])
        if not username:
            self.stdout.write("  administrator: not requested (--admin-username)")
            return
        if User.objects.filter(username=username).exists():
            self.stdout.write(f"  administrator: {username} already exists")
            return
        if not password:
            # Refusing beats inventing: a generated password printed to a terminal log is
            # a credential in the log, and a default one is an open door.
            self.stdout.write(self.style.WARNING(
                f"  administrator: {username} not created — pass --admin-password"
            ))
            return
        if len(password) < 12:
            raise CommandError("--admin-password must be at least 12 characters.")
        User.objects.create_superuser(
            username=username, email=str(options["admin_email"]).strip() or "", password=password
        )
        self.stdout.write(f"  administrator: created {username}")

    def _enrolment_secret(self, options: dict) -> None:
        from sites.enrolment import enrolment_secret, unauthenticated_enrolment_allowed

        if enrolment_secret():
            self.stdout.write("  site enrolment: secret is configured")
            return
        if unauthenticated_enrolment_allowed():
            self.stdout.write(self.style.ERROR(
                "  site enrolment: UNAUTHENTICATED. Anyone who can reach this server can "
                "register sites and issue site tokens. Set AMRIT_ENROLMENT_SECRET."
            ))
        else:
            self.stdout.write(self.style.WARNING(
                "  site enrolment: no secret configured, so enrolment is closed and no site "
                "can register yet."
            ))
        if options["print_enrolment_secret"]:
            self.stdout.write("\n  Put this in AMRIT_ENROLMENT_SECRET and give it to each site:")
            self.stdout.write(f"    {secrets.token_urlsafe(32)}")
