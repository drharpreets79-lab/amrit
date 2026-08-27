"""Seed the demonstration pack for this deployment's country, plus one user per role.

Idempotent. Safe to run on every deploy. Passwords are reset for demo accounts each run so
the printed credentials always work.

Which pack is used follows the configured country profile: the packs live in
``_demo_fixtures.py``, keyed by alpha-3. A country with no pack is reported and skipped, not
filled with another country's hospitals — and not failed either, because this seeder runs
from the container entrypoint and a missing *demonstration* pack is no reason for a portal
to refuse to start.
"""

from __future__ import annotations

import random
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone

from geo.address import clean_address
from sites.models import ROLE_CHOICES, Site, UserProfile

from ._demo_fixtures import available_countries, fixture_for

User = get_user_model()


def _resolve_unit(level1_name: str, level2_name: str = ""):
    """The administrative unit a demo row names, when the tree carries it.

    Demo data names places; the tree is keyed by code. Matching by name is acceptable here
    and nowhere else — this is seed data being placed, not a scope filter being evaluated —
    and an ambiguous or missing name yields no unit rather than a guess.
    """
    from geo.models import AdminUnit, normalize_name

    def one(level: int, name: str, parent=None):
        if not name:
            return None
        candidates = [
            unit
            for unit in AdminUnit.objects.filter(level=level)
            if normalize_name(unit.name) == normalize_name(name)
            and (parent is None or unit.parent_id == parent.id)
        ]
        return candidates[0] if len(candidates) == 1 else None

    level1 = one(1, level1_name)
    return one(2, level2_name, parent=level1) or level1


class Command(BaseCommand):
    help = "Seed this country's optional demonstration pack and its published demo accounts."

    def add_arguments(self, parser):
        parser.add_argument("--no-activity", action="store_true",
                            help="Do not simulate last_seen_at timestamps.")
        parser.add_argument("--country", default="",
                            help="Alpha-3 of the pack to seed. Defaults to the configured country profile.")
        parser.add_argument("--strict", action="store_true",
                            help="Fail when this country has no demonstration pack, instead of skipping it.")

    @transaction.atomic
    def handle(self, *args, **opts):
        from central.country_profile import get_profile

        profile = get_profile()
        requested = (opts.get("country") or profile.get("country_code") or "").strip().upper()
        fixture = fixture_for(requested)
        if fixture is None:
            # Skipped rather than failed. This runs from the container entrypoint, where a
            # non-zero exit is a failed boot and, under `restart: unless-stopped`, a restart
            # loop — which is exactly what a deployment configured for a country with no pack
            # used to get. The operator is told what to do about it instead.
            message = (
                f"No demonstration pack exists for {requested or 'an unconfigured country'}; "
                f"nothing was seeded. Packs available: {available_countries()}. Set "
                "AMRIT_COUNTRY_PROFILE to one of those countries, or add a pack for this one "
                "in sites/management/commands/_demo_fixtures.py."
            )
            if opts.get("strict"):
                raise CommandError(message)
            self.stdout.write(self.style.WARNING(message))
            return
        sample_sites = fixture.sites
        demo_users = fixture.users
        now = timezone.now()
        rng = random.Random(20260501)
        valid_roles = {code for code, _ in ROLE_CHOICES}

        # ---- sites -------------------------------------------------------
        created_sites = 0
        updated_sites = 0
        for i, entry in enumerate(sample_sites):
            code, name = entry.lab_code, entry.name
            admin_area, locality = entry.admin_area, entry.locality
            unit = _resolve_unit(admin_area, locality)
            defaults = dict(
                name=name, country=fixture.country_name,
                # Normalised here as well as on save, so the "has this row changed?"
                # comparison below sees the same shape the database holds.
                address=clean_address(
                    {
                        "country_code": fixture.country_code,
                        "address_lines": [f"{name}", "Department of Microbiology"],
                        "admin_area": admin_area,
                        "locality": locality,
                        "postal_code": f"{fixture.postal_seed + i * 137:06d}",
                    }
                ),
                admin_unit=unit,
                latitude=entry.latitude, longitude=entry.longitude, status="active",
                allowed_query_types=[
                    "heartbeat", "isolate_count", "organism_distribution",
                    "specimen_distribution", "resistance_rate",
                ],
            )
            site, created = Site.objects.get_or_create(lab_code=code, defaults=defaults)
            if created:
                created_sites += 1
            else:
                changed = False
                for k, v in defaults.items():
                    if getattr(site, k) != v:
                        setattr(site, k, v)
                        changed = True
                if changed:
                    updated_sites += 1
                    site.save()

            if not site.auth_token_hash:
                token = Site.issue_token()
                site.set_auth_token(token)
                site.save(update_fields=["auth_token_hash", "auth_token_prefix"])

            if not opts.get("no_activity"):
                # ~70% recently online, 20% idle, 10% silent
                roll = rng.random()
                if roll < 0.7:
                    last = now - timedelta(seconds=rng.randint(5, 240))
                elif roll < 0.9:
                    last = now - timedelta(minutes=rng.randint(15, 6 * 60))
                else:
                    last = now - timedelta(days=rng.randint(2, 30))
                site.last_seen_at = last
                site.last_poll_at = last
                site.save(update_fields=["last_seen_at", "last_poll_at"])

        self.stdout.write(self.style.SUCCESS(
            f"sites: {created_sites} created, {updated_sites} updated, {Site.objects.count()} total"
        ))

        # ---- users -------------------------------------------------------
        printed = []
        for entry in demo_users:
            username, role, password = entry.username, entry.role, entry.password
            full_name, org = entry.full_name, entry.organization
            level1, level2, site_code = entry.level1, entry.level2, entry.site_lab_code
            if role not in valid_roles:
                raise CommandError(f"Demonstration pack names role {role!r}, which this deployment does not define.")
            email = f"{username}@amrit.demo"
            is_super = (role == "super_admin")
            user, _ = User.objects.get_or_create(
                username=username,
                defaults={"email": email, "is_staff": is_super, "is_superuser": is_super},
            )
            user.email = email
            user.is_staff = is_super or role == "programme_admin"
            user.is_superuser = is_super
            user.set_password(password)
            user.save()

            site_obj = None
            if site_code:
                site_obj = Site.objects.filter(lab_code=site_code).first()

            unit = _resolve_unit(level1, level2)
            UserProfile.objects.update_or_create(
                user=user,
                defaults=dict(
                    role=role,
                    full_name=full_name,
                    organization=org,
                    admin_unit=unit,
                    country_code=unit.country_code if unit else "",
                    site=site_obj,
                ),
            )
            printed.append((username, role, password))

        self.stdout.write("")
        self.stdout.write(self.style.SUCCESS(
            f"{fixture.country_name} demonstration pack · accounts (username · role · password):"
        ))
        for u, r, p in printed:
            self.stdout.write(f"  {u:18s}  {r:26s}  {p}")
