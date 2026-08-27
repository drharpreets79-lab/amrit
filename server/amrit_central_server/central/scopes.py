"""Scope vocabulary and the single place that turns a scope into a queryset filter.

The hierarchy used to be four fixed levels — national, state, district, site — named in
enums, in migrations, in every metric computation and in the drill-down config. This
module replaces that with a country-driven chain:

    global -> country -> admin:1 .. admin:N -> site

``state`` and ``district`` are gone. They named one country's two levels, so a country
with three sub-national levels could not express its third and a country with one carried
a scope called "district" it could never use. Migration ``0009`` rewrote every stored row
to ``admin:1``/``admin:2``; the old spellings are still *accepted on input* — including
``national`` — because refusing a saved bookmark or a scripted API call outright helps
nobody, and translating it costs one dictionary lookup.

Filtering is by administrative code, as a prefix match on ``admin_path``. Codes are ASCII,
so this is the only form that works for unit names outside ASCII — which is the whole
reason the name comparison it replaced had to go.
"""

from __future__ import annotations

from django.db.models import Q

CANONICAL_GLOBAL = "global"
CANONICAL_COUNTRY = "country"
CANONICAL_SITE = "site"
ADMIN_PREFIX = "admin:"

# Accepted on input only. Nothing writes these, and no row stores them.
_ACCEPTED_ALIASES = {
    "national": CANONICAL_COUNTRY,
    "state": f"{ADMIN_PREFIX}1",
    "district": f"{ADMIN_PREFIX}2",
}


def canonical_scope_type(value: str | None) -> str:
    """Accept any spelling, including the withdrawn ones; return the canonical one."""
    text = str(value or "").strip().lower()
    if not text:
        return CANONICAL_COUNTRY
    return _ACCEPTED_ALIASES.get(text, text)


def accepted_spellings(value: str | None) -> list[str]:
    """Every spelling that names the same tier, for matching against stored rows.

    Migration ``0009`` canonicalised every row, so in a migrated database the canonical
    form is enough. The aliases are still included because a caller may pass one, and
    because a row written by something outside this codebase should not silently fail to
    match a scope it plainly belongs to.
    """
    canonical = canonical_scope_type(value)
    spellings = {canonical, *(alias for alias, target in _ACCEPTED_ALIASES.items() if target == canonical)}
    if value:
        spellings.add(str(value).strip().lower())
    return sorted(spelling for spelling in spellings if spelling)


def admin_level(scope_type: str | None) -> int | None:
    """The level number for an ``admin:N`` scope, else None."""
    canonical = canonical_scope_type(scope_type)
    if not canonical.startswith(ADMIN_PREFIX):
        return None
    suffix = canonical[len(ADMIN_PREFIX):]
    return int(suffix) if suffix.isdigit() else None


def scope_for_level(level: int) -> str:
    return f"{ADMIN_PREFIX}{int(level)}"


def scope_chain(profile: dict | None = None, *, include_global: bool = False) -> list[str]:
    """The drill-down chain for a country, outermost first."""
    levels = sorted(
        (int(definition["level"]) for definition in (profile or {}).get("admin_levels", [])),
    ) or [1, 2]
    chain = [CANONICAL_COUNTRY, *(scope_for_level(level) for level in levels), CANONICAL_SITE]
    return [CANONICAL_GLOBAL, *chain] if include_global else chain


def child_scope(scope_type: str, profile: dict | None = None) -> str | None:
    """The next scope down, used for rankings and drill-down links."""
    chain = scope_chain(profile)
    canonical = canonical_scope_type(scope_type)
    if canonical not in chain:
        return None
    index = chain.index(canonical)
    return chain[index + 1] if index + 1 < len(chain) else None


def scope_label(profile: dict | None, scope_type: str) -> str:
    """A human label for a scope, in the country's own terms."""
    canonical = canonical_scope_type(scope_type)
    if canonical == CANONICAL_GLOBAL:
        return "Global"
    if canonical == CANONICAL_COUNTRY:
        return str((profile or {}).get("country_name") or "National")
    if canonical == CANONICAL_SITE:
        return "Site"
    level = admin_level(canonical)
    for definition in (profile or {}).get("admin_levels", []):
        if int(definition["level"]) == level:
            return str(definition["label"])
    return f"Level {level}"


def _units_for(level: int, scope_value: str, country_code: str = ""):
    """Units at a level matching a code or a name. Empty when geography is not loaded."""
    from geo.models import AdminUnit, normalize_name

    queryset = AdminUnit.objects.filter(level=level)
    if country_code:
        queryset = queryset.filter(country_code=str(country_code).upper())
    by_code = list(queryset.filter(code=scope_value))
    if by_code:
        return by_code
    folded = normalize_name(scope_value)
    # Names are compared in Python, not in SQL: database case-insensitive matching is
    # ASCII-only in practice, which is exactly the bug this replaces.
    return [unit for unit in queryset if normalize_name(unit.name) == folded]


def site_scope_q(scope_type: str, scope_value: str, *, prefix: str = "", country_code: str = "") -> Q:
    """A Q for a Site queryset, or for a relation to one via ``prefix`` (e.g. ``site__``)."""
    canonical = canonical_scope_type(scope_type)
    field = lambda name: f"{prefix}{name}"  # noqa: E731 - local alias keeps the filters readable

    if canonical in {CANONICAL_GLOBAL, CANONICAL_COUNTRY} and not scope_value:
        return Q()
    if canonical == CANONICAL_COUNTRY:
        return Q(**{field("country_code"): str(scope_value).upper()})
    if canonical == CANONICAL_SITE:
        return Q(**{field("lab_code"): scope_value})

    level = admin_level(canonical)
    if level is None or not scope_value:
        return Q()

    condition = Q()
    for unit in _units_for(level, scope_value, country_code):
        condition |= Q(**{f"{field('admin_path')}__startswith": f"{unit.admin_path}/"})
        condition |= Q(**{field("admin_unit"): unit.pk})

    # An unknown scope value must match nothing rather than everything: a scope filter that
    # silently becomes "all sites" is a data leak.
    return condition if condition else Q(pk__in=[])


def scope_sites_queryset(queryset, scope_type: str, scope_value: str, *, country_code: str = ""):
    condition = site_scope_q(scope_type, scope_value, country_code=country_code)
    return queryset.filter(condition) if condition else queryset


def data_levels() -> set[int]:
    """Administrative levels the stored data actually uses.

    The fan-out must never be narrower than the data. A deployment that has not set
    AMRIT_COUNTRY_PROFILE resolves the fallback profile, which declares a single level;
    following only that would silently stop producing snapshots for every deeper level
    that already exists.
    """
    from geo.models import AdminUnit

    return set(AdminUnit.objects.values_list("level", flat=True).distinct())


def refresh_levels(profile: dict | None = None) -> list[int]:
    """Levels to fan out over: everything the profile declares plus everything in use."""
    declared = {int(definition["level"]) for definition in (profile or {}).get("admin_levels", [])}
    return sorted(declared | data_levels())


def distinct_scope_values(scope_type: str, *, country_code: str = "") -> list[str]:
    """Every value at a scope that has at least one site — the snapshot fan-out list.

    Names are returned rather than codes so stored snapshots keep their current keys and
    existing dashboard links continue to resolve.
    """
    from sites.models import Site

    canonical = canonical_scope_type(scope_type)
    if canonical == CANONICAL_SITE:
        return list(Site.objects.filter(status="active").values_list("lab_code", flat=True))
    if canonical == CANONICAL_COUNTRY:
        return sorted({code for code in Site.objects.exclude(country_code="").values_list("country_code", flat=True)})

    level = admin_level(canonical)
    if level is None:
        return []

    values: set[str] = set()
    from geo.models import AdminUnit

    linked_paths = [path for path in Site.objects.exclude(admin_path="").values_list("admin_path", flat=True)]
    if linked_paths:
        units = AdminUnit.objects.filter(level=level)
        if country_code:
            units = units.filter(country_code=str(country_code).upper())
        for unit in units:
            prefix = f"{unit.admin_path}/"
            if any(path == unit.admin_path or path.startswith(prefix) for path in linked_paths):
                values.add(unit.name)
    return sorted(values)
