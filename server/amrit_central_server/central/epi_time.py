"""Epidemiological weeks and reporting years.

Mirrors app/src/main/epi-time.ts exactly; a date bucketed by one product and read by the
other must land in the same week, or a federated count is wrong.

ISO-8601 weeks start on Monday and week 1 contains 4 January. MMWR weeks (US CDC and much
of the Americas) start on Sunday and week 1 is the first with at least four days in the new
year. The two disagree on some dates, so the system in use is stated rather than assumed.

Reporting years differ as well: India runs April to March, the United States October to
September, most countries the calendar year.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

ISO = "iso"
MMWR = "mmwr"


@dataclass(frozen=True)
class EpiWeek:
    year: int
    week: int
    start: date
    end: date
    system: str


def _as_date(value: date | datetime | str) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value).strip()
    if len(text) < 10:
        raise ValueError(f"Not an ISO date: {value!r}")
    return date.fromisoformat(text[:10])


def _week_start(value: date, start_weekday: int) -> date:
    """start_weekday: 0 = Monday (ISO), 6 = Sunday (MMWR), using date.weekday()."""
    return value - timedelta(days=(value.weekday() - start_weekday) % 7)


def _iso_week(value: date) -> EpiWeek:
    start = _week_start(value, 0)
    thursday = start + timedelta(days=3)
    year = thursday.year
    first_thursday = _week_start(date(year, 1, 4), 0) + timedelta(days=3)
    week = ((thursday - first_thursday).days // 7) + 1
    return EpiWeek(year, week, start, start + timedelta(days=6), ISO)


def _mmwr_week(value: date) -> EpiWeek:
    start = _week_start(value, 6)
    wednesday = start + timedelta(days=3)
    year = wednesday.year
    first_start = _week_start(date(year, 1, 4), 6)
    week = ((start - first_start).days // 7) + 1
    return EpiWeek(year, week, start, start + timedelta(days=6), MMWR)


def epi_week(value: date | datetime | str, system: str | None = None) -> EpiWeek:
    resolved = (system or _profile_value("epi_week_system", ISO) or ISO).lower()
    parsed = _as_date(value)
    return _mmwr_week(parsed) if resolved == MMWR else _iso_week(parsed)


@dataclass(frozen=True)
class ReportingYear:
    year: int
    start: date
    end: date
    label: str


def reporting_year(value: date | datetime | str, start_month: int | None = None) -> ReportingYear:
    month = int(start_month if start_month is not None else _profile_value("fiscal_year_start_month", 1) or 1)
    month = min(12, max(1, month))
    parsed = _as_date(value)
    year = parsed.year if parsed.month >= month else parsed.year - 1
    start = date(year, month, 1)
    end = date(year + 1, month, 1) - timedelta(days=1)
    # A year spanning two calendar years is written 2026-27 so it cannot be mistaken for
    # the calendar year.
    label = str(year) if month == 1 else f"{year}-{str((year + 1) % 100).zfill(2)}"
    return ReportingYear(year, start, end, label)


def local_date(instant: datetime | str, time_zone: str | None) -> date:
    """The calendar date an instant falls on in a given zone.

    A specimen recorded at 23:30 belongs to that local day. Bucketing on the UTC date shifts
    it for every site away from Greenwich, a systematic error at every day, week and year
    boundary.
    """
    moment = instant if isinstance(instant, datetime) else datetime.fromisoformat(str(instant).replace("Z", "+00:00"))
    if not time_zone:
        return moment.date()
    try:
        return moment.astimezone(ZoneInfo(time_zone)).date()
    except (ZoneInfoNotFoundError, ValueError):
        # An unknown zone must not lose the observation.
        return moment.date()


def resolve_time_zone(site_time_zone: str | None, country_code: str | None = None) -> str | None:
    """The zone to bucket a site's observations in: the site's own, else the country's."""
    site = str(site_time_zone or "").strip()
    if site:
        return site
    # A country spanning several zones has no honest default; None rather than a guess.
    return _profile_value("timezone", None, country_code)


def _profile_value(key: str, default, country_code: str | None = None):
    from .country_profile import ProfileError, get_profile

    try:
        return get_profile(country_code).get(key, default)
    except ProfileError:
        return default
