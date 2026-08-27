"""Consistent site ordering for portal selection controls."""

from datetime import timedelta

from django.utils import timezone


ONLINE_WINDOW = timedelta(minutes=5)


def site_is_online(site, *, now=None):
    now = now or timezone.now()
    return bool(site.is_online or (site.last_seen_at and site.last_seen_at >= now - ONLINE_WINDOW))


def online_first_sites(sites, *, now=None):
    """Online A-Z, then offline A-Z; annotate each object for templates."""
    now = now or timezone.now()
    result = list(sites)
    for site in result:
        site.is_online = site_is_online(site, now=now)
    return sorted(
        result,
        key=lambda site: (
            0 if site.is_online else 1,
            (site.name or "").casefold(),
            (site.lab_code or "").casefold(),
        ),
    )
