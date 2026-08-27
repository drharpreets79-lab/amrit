"""Site registry — one row per AMRIT installation that long-polls this server."""

from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import timedelta

from django.conf import settings
from django.db import models
from django.utils import timezone


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest() if token else ""


class Site(models.Model):
    """An AMRIT site that authenticates with a bearer token."""

    STATUS_CHOICES = (
        ("active", "Active"),
        ("disabled", "Disabled"),
        ("provisioning", "Provisioning"),
    )

    lab_code = models.CharField(max_length=32, unique=True, db_index=True)
    name = models.CharField(max_length=200)
    # The country's own name, as the site writes it; country_code is what code matches on.
    country = models.CharField(max_length=100, blank=True)
    country_code = models.CharField(max_length=3, blank=True, db_index=True)
    # Which reporting unit this site is under. admin_path is what every scope filter
    # matches on, as an ASCII prefix.
    admin_unit = models.ForeignKey(
        "geo.AdminUnit", on_delete=models.SET_NULL, null=True, blank=True, related_name="sites"
    )
    admin_path = models.CharField(max_length=512, blank=True, db_index=True)
    # Where the building is, structured on the ISO 19160-1 field set — a different question
    # from admin_unit, and one whose shape varies by country. See geo.address.
    address = models.JSONField(default=dict, blank=True)
    # A country spanning several zones cannot have one correct default, so a site may
    # carry its own; blank means fall back to the country profile.
    timezone = models.CharField(max_length=64, blank=True)
    lab_domain = models.CharField(max_length=80, blank=True)

    # The two credentials a site presents, and neither is recoverable from this table.
    #
    # auth_token is the bearer token the installation sends on every request. It reaches the
    # laboratory over the wire, at the end of an approved enrolment.
    #
    # site_token is a second factor that deliberately does *not* travel that path: it is
    # shown once to whoever approved the site and passed to the laboratory by some other
    # means — a phone call, a signed letter, whatever the programme uses. Compromising the
    # enrolment channel therefore does not by itself yield a working credential.
    #
    # site_token used to be stored in clear and was listed in the API's and the admin's
    # search_fields, so the second factor could be read out of the registry by anyone who
    # could search it — which is no second factor at all.
    auth_token_hash = models.CharField(max_length=128, db_index=True)
    auth_token_prefix = models.CharField(max_length=8, blank=True)
    site_token_hash = models.CharField(max_length=128, blank=True, db_index=True)
    site_token_prefix = models.CharField(max_length=8, blank=True)

    allowed_query_types = models.JSONField(default=list, blank=True)

    status = models.CharField(max_length=16, choices=STATUS_CHOICES, default="active")
    last_seen_at = models.DateTimeField(null=True, blank=True)
    last_poll_at = models.DateTimeField(null=True, blank=True)
    last_response_at = models.DateTimeField(null=True, blank=True)

    contact_email = models.EmailField(blank=True)
    notes = models.TextField(blank=True)

    latitude = models.FloatField(null=True, blank=True)
    longitude = models.FloatField(null=True, blank=True)
    is_online = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["lab_code"]

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.lab_code} — {self.name}"

    def sync_admin_unit_fields(self) -> None:
        """Derive admin_path and country_code from the unit this site is placed at.

        Nothing assembles a path by hand, so the link and the path cannot disagree. A site
        with no unit keeps whatever path it was given — an importer may know the path
        before the tree carries the unit.
        """
        if not self.admin_unit_id:
            return
        unit = self.admin_unit
        self.admin_path = unit.admin_path
        self.country_code = unit.country_code

    @property
    def place_label(self) -> str:
        """Where this site is, in one line, for a table cell or a map popup.

        The reporting unit comes first when there is one, because that is what the number
        on the screen is grouped by; the postal address is the fallback for a site nobody
        has placed in the tree yet. Neither is assembled from level names, so a country
        with five levels reads as naturally here as one with a single level.
        """
        unit = self.admin_unit
        if unit is not None:
            chain, cursor, depth = [], unit, 0
            while cursor is not None and depth < 8:
                chain.append(cursor.name)
                cursor = cursor.parent
                depth += 1
            return " · ".join(reversed(chain))
        from geo.address import address_summary

        return address_summary(self.address)

    def normalize_address(self) -> None:
        """Validate the address against its country's rules and cache its rendering.

        Done on the model rather than only in the serializer because the API is not the
        only writer — enrolment, the demo seeder and management commands save sites too,
        and an address that cannot be rendered in its own country is a defect wherever it
        came from.
        """
        from geo.address import clean_address

        if not self.address:
            self.address = {}
            return
        self.address = clean_address(self.address, country_code=self.country_code)

    def resolve_geo_point(self) -> None:
        """Place this facility from its address, when nothing better already has.

        On the model rather than in one view because every writer benefits — enrolment, the
        demo seeder, the API and management commands all save sites, and a registry where
        only the sites registered through one route appear on the map is worse than a
        registry with no map.

        Never overwrites: a point that is already stored was either resolved from a finer
        address than this one, typed by a person, or reported by the installation itself.
        Re-resolving on every save would also mean a directory update silently moving
        facilities somebody had already corrected by hand.
        """
        from geo import directory

        if not self.address or self.address.get("geo_point"):
            return
        result = directory.resolve(
            self.country_code,
            postal_code=self.address.get("postal_code"),
            locality=self.address.get("locality"),
            subdivision_code=self.address.get("admin_area_code"),
        )
        if result.point:
            self.address["geo_point"] = result.point.as_dict()

    @property
    def map_point(self) -> dict | None:
        """The best coordinate for this site, and how exact it is.

        The installation's own consented reading wins over anything derived from an
        address: it knows where the building is, and the directory only knows where the
        postal code is. Callers get the precision alongside, because a map that plots a
        subdivision centroid and a GPS fix identically tells a programme something untrue.
        """
        if self.latitude is not None and self.longitude is not None:
            return {
                "latitude": self.latitude,
                "longitude": self.longitude,
                "precision": "device",
                "source": "site-report",
            }
        point = (self.address or {}).get("geo_point")
        return dict(point) if isinstance(point, dict) else None

    def save(self, *args, **kwargs):
        self.sync_admin_unit_fields()
        self.normalize_address()
        self.resolve_geo_point()
        return super().save(*args, **kwargs)

    # ---- identity ------------------------------------------------------
    def rename_lab_code(self, new_code: str, *, by=None, note: str = "") -> str:
        """Change the code this site is known by, carrying everything that names it.

        A registry and a desktop that disagree about a laboratory's code cannot sync at all:
        the desktop sends its own code on every poll and the server answers 403 lab_code
        mismatch. One side has to move, and it is this one. On the desktop the code is the
        parent key of a dozen local tables and is stamped on every isolate row, so renaming
        there rewrites the laboratory's whole database. Here it is a single unique column —
        results, dispatches, operator profiles and audit rows all reach a site by primary
        key, so they follow a rename without being touched.

        Two things do name the code as text, and they are treated differently:

        * ``Query.target_lab_codes`` is *addressing* — it decides which site a pending query
          is deliverable to. It is rewritten, or the rename would silently stop queries
          reaching the site. Which sites a query actually went to is not lost by this: that
          is what the dispatch rows record, and they point at the site by key.
        * ``PollAuditEntry.lab_code`` and ``DashboardRefreshRun.site_lab_codes`` are
          *history* — what was sent, and under what name, at the time. Rewriting those would
          be falsifying a log, so they are left exactly as they are and the rename is
          appended to the audit trail instead.

        The token is deliberately untouched. It authenticates the site, not the name, so a
        site that was syncing before the rename keeps syncing after it with no
        reconfiguration at the laboratory — which is the point of fixing the mismatch here.
        """
        from django.db import transaction

        new_code = (new_code or "").strip()
        old_code = self.lab_code
        if not new_code:
            raise ValueError("A laboratory code is required.")
        if len(new_code) > 32:
            raise ValueError("A laboratory code may be at most 32 characters.")
        if new_code == old_code:
            return old_code
        clash = Site.objects.filter(lab_code__iexact=new_code).exclude(pk=self.pk).first()
        if clash is not None:
            raise ValueError(f"{clash.lab_code} is already registered, so that code is taken.")

        from queries.models import PollAuditEntry, Query

        with transaction.atomic():
            self.lab_code = new_code
            self.save(update_fields=["lab_code", "updated_at"])
            # Scanned in Python rather than filtered in SQL on purpose: JSONField
            # ``__contains`` is not supported on SQLite, which is the default backend here,
            # and a rename is a rare administrative act where being right on every backend
            # matters more than the query count.
            for query in Query.objects.exclude(target_lab_codes=[]).only("id", "target_lab_codes"):
                targets = query.target_lab_codes or []
                if old_code not in targets:
                    continue
                query.target_lab_codes = [new_code if code == old_code else code for code in targets]
                query.save(update_fields=["target_lab_codes"])
            detail = f"Renamed from {old_code} to {new_code}"
            if by is not None:
                detail += f" by {by}"
            if note:
                detail += f" — {note}"
            PollAuditEntry.objects.create(
                site=self, lab_code=old_code, action="site_renamed", detail=detail[:2000]
            )
        return new_code

    # ---- token mgmt ----------------------------------------------------
    @staticmethod
    def issue_token(length: int = 48) -> str:
        return secrets.token_urlsafe(length)

    def set_auth_token(self, token: str) -> None:
        self.auth_token_hash = _hash_token(token)
        self.auth_token_prefix = token[:8]

    def set_site_token(self, token: str) -> None:
        self.site_token_hash = _hash_token(token)
        self.site_token_prefix = token[:8]

    def check_site_token(self, token: str) -> bool:
        """Whether this request carries the site's second factor.

        A site with no site token issued is not asked for one — a deployment that has not
        adopted the second channel still works. A site that *has* one is always asked: the
        previous check ran only when the client chose to send the header, so omitting
        ``X-AMRIT-Site`` skipped the second factor rather than failing it.
        """
        if not self.site_token_hash:
            return True
        return bool(token) and hmac.compare_digest(_hash_token(token), self.site_token_hash)

    @classmethod
    def authenticate_bearer(cls, token: str):
        if not token:
            return None
        token_hash = _hash_token(token)
        return cls.objects.filter(auth_token_hash=token_hash, status="active").first()

    def touch_seen(self, *, polled: bool = False, responded: bool = False) -> None:
        now = timezone.now()
        self.last_seen_at = now
        if polled:
            self.last_poll_at = now
        if responded:
            self.last_response_at = now
        self.save(update_fields=["last_seen_at", "last_poll_at", "last_response_at"])


class SiteEnrolmentRequest(models.Model):
    """A laboratory asking to be registered, waiting for someone to decide.

    Registration used to create an active `Site` outright: whoever held the enrolment
    secret could add a laboratory to the national registry, and the first anyone knew of it
    was a new row in the sites table. A registry of who may submit surveillance data is not
    something a shared secret alone should be able to extend, and an administrator had no
    place to see what had asked to join.

    So an unrecognised lab code now lands here instead, and nothing about it is real until
    a person with `manage_sites` approves it. Approval is what creates the `Site` and
    issues its token; rejection keeps the row, because "we turned this one down" is an
    answer worth still having the next time the same code appears.

    A site the registry already knows is *not* routed through here — that is a site
    updating its own details, which the enrolment secret already governs.
    """

    STATUS_CHOICES = (
        ("pending", "Awaiting decision"),
        ("approved", "Approved"),
        ("rejected", "Rejected"),
    )

    lab_code = models.CharField(max_length=32, db_index=True)
    name = models.CharField(max_length=200, blank=True)
    country = models.CharField(max_length=100, blank=True)
    country_code = models.CharField(max_length=3, blank=True)
    address = models.JSONField(default=dict, blank=True)
    # As the client stated it: [{level, code}] at any depth, resolved to a unit only on
    # approval. Storing the claim rather than the resolution means a request still makes
    # sense if the tree gains the unit after the request arrives.
    admin_units = models.JSONField(default=list, blank=True)
    contact_email = models.EmailField(blank=True)
    app_version = models.CharField(max_length=32, blank=True)
    # Recorded so an administrator deciding on a request can see where it came from.
    source_ip = models.GenericIPAddressField(null=True, blank=True)

    # How the installation that filed this request proves, later, that it is the one
    # collecting the answer.
    #
    # The plaintext is returned exactly once, in the response to the request itself, and only
    # its hash is kept. The desktop holds it and presents it when polling for its token, so
    # picking up a credential needs no shared enrolment secret distributed to every
    # laboratory — and knowing a lab code is not enough to collect that lab's token.
    #
    # Redemption is single-use: the bearer token is minted at pickup and handed over once. A
    # second attempt is refused rather than quietly rotating the credential, because a
    # replayed pickup would otherwise cut off the installation that already has it.
    pickup_token_hash = models.CharField(max_length=128, blank=True, db_index=True)
    pickup_expires_at = models.DateTimeField(null=True, blank=True)
    pickup_redeemed_at = models.DateTimeField(null=True, blank=True)

    status = models.CharField(max_length=16, choices=STATUS_CHOICES, default="pending", db_index=True)
    decided_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="site_enrolment_decisions",
    )
    decided_at = models.DateTimeField(null=True, blank=True)
    decision_note = models.TextField(blank=True)
    site = models.ForeignKey(Site, on_delete=models.SET_NULL, null=True, blank=True, related_name="enrolment_requests")

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            # One live request per lab code. A client that retries — and a desktop polling
            # for its token retries steadily — must refresh its request, not file a new one
            # each time and bury the queue.
            models.UniqueConstraint(
                fields=["lab_code"], condition=models.Q(status="pending"),
                name="unique_pending_enrolment_per_lab_code",
            )
        ]

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.lab_code} ({self.status})"

    def issue_pickup_token(self) -> str:
        """Mint the collection secret for this request and return it once."""
        token = secrets.token_urlsafe(32)
        self.pickup_token_hash = _hash_token(token)
        ttl = max(300, int(getattr(settings, "AMRIT_ENROLMENT_PICKUP_TTL_SECONDS", 86_400)))
        self.pickup_expires_at = timezone.now() + timedelta(seconds=ttl)
        self.pickup_redeemed_at = None
        return token

    def pickup_expired(self) -> bool:
        return bool(self.pickup_expires_at and self.pickup_expires_at <= timezone.now())

    def check_pickup_token(self, token: str) -> bool:
        if not self.pickup_token_hash or not token or self.pickup_expired():
            return False
        return hmac.compare_digest(_hash_token(token), self.pickup_token_hash)


# Default role slugs. A deployment renames the labels from the administration GUI; the
# slugs are what stored rows and code refer to, so they say what a role *is* rather than
# what one country calls the tier it works at. `admin_officer` replaced the pair
# state_health_officer / district_health_officer, which had identical capabilities and
# differed only in a level name — the level now comes from the profile's admin unit, so one
# role serves every depth.
ROLE_CHOICES = (
    ("super_admin", "Super Admin"),
    ("programme_admin", "Programme Administrator"),
    ("policy_maker", "Policy Maker"),
    ("researcher", "Researcher"),
    ("epidemiologist", "Epidemiologist"),
    ("public_health_expert", "Public Health Expert"),
    ("admin_officer", "Administrative Health Officer"),
    ("hospital_admin", "Hospital Administrator"),
    ("press", "Press / Media"),
    ("citizen", "Citizen"),
)


class UserProfile(models.Model):
    """Role + geographic scope for each operator account."""

    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="amrit_profile",
    )
    role = models.CharField(max_length=32, default="citizen", db_index=True)
    full_name = models.CharField(max_length=200, blank=True)
    organization = models.CharField(max_length=200, blank=True)
    designation = models.CharField(max_length=120, blank=True)
    # What this operator may see, as a place in the tree rather than a level's name. A
    # profile linked to a unit is scoped to that unit and everything under it, at whatever
    # depth the unit sits — which is what lets one role definition serve a country with one
    # sub-national level and a country with five.
    country_code = models.CharField(max_length=3, blank=True, db_index=True)
    admin_unit = models.ForeignKey(
        "geo.AdminUnit", on_delete=models.SET_NULL, null=True, blank=True, related_name="profiles"
    )
    site = models.ForeignKey(
        Site,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="profiles",
    )
    phone = models.CharField(max_length=32, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["role", "user__username"]

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.user.username} · {self.get_role_display()}"

    @property
    def role_label(self) -> str:
        try:
            definition = RoleDefinition.objects.filter(slug=self.role, is_active=True).only("label").first()
            if definition:
                return definition.label
        except Exception:
            pass
        return dict(ROLE_CHOICES).get(self.role, self.role.replace("_", " ").title())


class RoleDefinition(models.Model):
    """Editable portal role: navigation powers, dashboard, and site scope."""

    DASHBOARD_CHOICES = (
        ("", "Operations / public only"), ("country", "Country-wide"),
        ("admin", "Administrative unit"),
        ("epidemiologist", "Epidemiology"), ("hospital", "Hospital"),
    )
    SCOPE_CHOICES = (
        ("none", "No sites"), ("all", "All sites"), ("site", "Assigned site"),
        ("admin", "Profile administrative unit"), ("country", "Profile country"),
    )

    slug = models.SlugField(max_length=32, unique=True)
    label = models.CharField(max_length=100)
    description = models.TextField(blank=True)
    dashboard_kind = models.CharField(max_length=32, choices=DASHBOARD_CHOICES, blank=True)
    scope_kind = models.CharField(max_length=16, choices=SCOPE_CHOICES, default="none")
    # The administrative depth this role works at, when it is fixed rather than taken from
    # the operator's own unit. Left null, an "admin" role is scoped to whatever level the
    # profile's unit sits at, which is the form that works in any country.
    scope_level = models.PositiveSmallIntegerField(null=True, blank=True)
    capabilities = models.JSONField(default=list, blank=True)
    is_system = models.BooleanField(default=False)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["label"]

    def __str__(self):
        return self.label
