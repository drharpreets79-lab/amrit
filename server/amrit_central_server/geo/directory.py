"""Turning an address into a place on a map.

The server side of the geographic directory. Mirrors ``app/src/shared/geo-directory.ts``
and ``app/src/main/geo-directory.ts`` function for function, reads the same shards, and is
pinned against the same fixture by ``test_directory.py`` — a facility that resolves to one
point on the desktop and another on the portal is the same defect as not resolving at all.

A postal code is the input an operator already knows, so it is the primary key here. It is
not a mechanism that works everywhere and this module never assumes it is:

  - roughly half the countries in ISO 3166-1 have no postal system;
  - several publish only a truncated code (Ireland, Malta, Chile, China, Argentina, Brazil);
  - where codes are point-precise, a coordinate derived from one identifies a building.

So there are three routes to a coordinate — postal code, settlement name, subdivision
centroid — and every point carries the precision it was resolved at.

Facilities only. A patient's residence is never given a coordinate: ``Site`` has an address
and this module serves it, while a patient has a town and a postal code already coarsened by
``privacy.patient_postal_code_digits``, and resolving that would undo the coarsening.
"""

from __future__ import annotations

import gzip
import json
import re
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable

DIRECTORY_ROOT = Path(__file__).resolve().parent.parent / "shared" / "geo-directory"

# Ordered best to worst. `device` is a facility's own consented reading and `manual` is a
# coordinate somebody typed; both outrank anything derived from an address, because each
# knew something the directory does not.
PRECISION_RANK = {
    "device": 0,
    "manual": 0,
    "plus_code": 1,
    "postal_area": 2,
    "locality": 3,
    "subdivision": 4,
    "country": 5,
}
GEO_PRECISIONS = tuple(PRECISION_RANK)

POSTAL_SOURCE = "geonames-postal"
LOCALITY_SOURCE = "geonames-cities500"
SUBDIVISION_SOURCE = "geonames-subdivision-centroid"

_SEPARATORS = re.compile(r"[\s\-.]")
_ALPHA3 = re.compile(r"^[A-Z]{3}$")

# The shortest prefix a postal lookup will fall back to. See `directory_key_for`.
MINIMUM_PREFIX = 2


@dataclass(frozen=True)
class GeoPoint:
    latitude: float
    longitude: float
    precision: str
    source: str
    resolved_at: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {key: value for key, value in asdict(self).items() if value is not None}


@dataclass(frozen=True)
class PlaceCandidate:
    locality: str
    admin_area: str
    latitude: float
    longitude: float
    precision: str
    source: str
    dependent_locality: str | None = None
    postal_code: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {key: value for key, value in asdict(self).items() if value is not None}


class GeoDirectoryShard:
    """One country's slice of the directory, with its postal index built once on load."""

    def __init__(self, payload: dict[str, Any]) -> None:
        self.alpha2: str = payload.get("alpha2", "")
        self.alpha3: str = payload.get("alpha3", "")
        self._names: list[str] = payload.get("names") or []
        self._postal: dict[str, list[list]] = payload.get("postalCodes") or {}
        self._localities: list[list] = payload.get("localities") or []
        self._subdivisions: dict[str, list[float]] = payload.get("subdivisionCentroids") or {}
        self._country_centroid: list[float] | None = payload.get("countryCentroid")
        # Codes are stored in the source's own spelling; operators type them with spaces and
        # hyphens. Both must find the same row, or someone is told their own country's
        # postal code does not exist.
        self._by_normalized = {normalize_postal_code(code): code for code in self._postal}

    def name(self, index: Any) -> str:
        return self._names[index] if isinstance(index, int) and 0 <= index < len(self._names) else ""

    @property
    def has_postal_directory(self) -> bool:
        return bool(self._postal)

    def directory_key_for(self, typed: str) -> str | None:
        """The stored key for a typed code, allowing for a directory holding only a prefix.

        For copyright reasons GeoNames carries only the outward part of a code for the
        United Kingdom, Canada, the Netherlands and Ireland, and truncated codes for Chile,
        China, Argentina, Brazil and Malta. Without this a London operator typing a
        perfectly valid ``EC1Y 8SY`` is told their own postcode does not exist — the
        directory holds ``EC1Y``. Two characters is the floor: one would place a facility
        somewhere in a whole postal region and call it an address.
        """
        normalized = normalize_postal_code(typed)
        for length in range(len(normalized), MINIMUM_PREFIX - 1, -1):
            key = self._by_normalized.get(normalized[:length])
            if key:
                return key
        return None

    def places_for_postal_code(self, code: str) -> list[PlaceCandidate]:
        key = self.directory_key_for(code)
        if not key:
            return []
        return [
            PlaceCandidate(
                locality=self.name(place),
                admin_area=self.name(admin1),
                dependent_locality=self.name(admin2) or None,
                postal_code=key,
                latitude=latitude,
                longitude=longitude,
                precision="postal_area",
                source=POSTAL_SOURCE,
            )
            for place, admin1, admin2, latitude, longitude, _accuracy in self._postal[key]
        ]

    def places_named(self, query: str, limit: int = 12) -> list[PlaceCandidate]:
        needle = query.strip().casefold()
        if len(needle) < 2:
            return []
        scored: list[tuple[int, int, PlaceCandidate]] = []
        for name_index, _admin1_code, admin2_index, latitude, longitude, population in self._localities:
            name = self.name(name_index)
            folded = name.casefold()
            if folded == needle:
                rank = 0
            elif folded.startswith(needle):
                rank = 1
            elif needle in folded:
                rank = 2
            else:
                continue
            scored.append((rank, -int(population or 0), PlaceCandidate(
                locality=name,
                admin_area=self.name(admin2_index),
                latitude=latitude,
                longitude=longitude,
                precision="locality",
                source=LOCALITY_SOURCE,
            )))
        scored.sort(key=lambda entry: (entry[0], entry[1]))
        return [candidate for _rank, _population, candidate in scored[:limit]]

    def subdivision_point(self, iso_code: str) -> GeoPoint | None:
        centroid = self._subdivisions.get(str(iso_code or "").strip().upper())
        if not centroid:
            return None
        return GeoPoint(centroid[0], centroid[1], "subdivision", SUBDIVISION_SOURCE)

    def country_point(self) -> GeoPoint | None:
        if not self._country_centroid:
            return None
        return GeoPoint(self._country_centroid[0], self._country_centroid[1], "country", SUBDIVISION_SOURCE)


def normalize_postal_code(code: str) -> str:
    """Upper-cased and stripped of the separators people type but directories do not store."""
    return _SEPARATORS.sub("", str(code or "").strip().upper())


@lru_cache(maxsize=8)
def directory_for(country_code: str) -> GeoDirectoryShard | None:
    """One country's shard, or ``None`` when it is not bundled.

    Cached because a portal renders many sites per request. A missing shard is not an
    error: a deployment may delete the ones it does not need, and the address form works
    without any of them — it simply cannot place the facility.
    """
    key = str(country_code or "").strip().upper()
    if not _ALPHA3.match(key):
        return None
    path = DIRECTORY_ROOT / f"{key}.json.gz"
    if not path.is_file():
        return None
    try:
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            return GeoDirectoryShard(json.load(handle))
    except (OSError, ValueError):
        # A truncated shard must not stop a site being registered.
        return None


def point_from_candidate(candidate: PlaceCandidate, at: str | None = None) -> GeoPoint:
    return GeoPoint(
        latitude=candidate.latitude,
        longitude=candidate.longitude,
        precision=candidate.precision,
        source=candidate.source,
        resolved_at=at or datetime.now(timezone.utc).isoformat(timespec="seconds"),
    )


def is_at_least_as_precise(next_precision: str, current: str | None) -> bool:
    """True when resolving would not coarsen a point that is already stored."""
    if not current:
        return True
    return PRECISION_RANK.get(next_precision, 9) <= PRECISION_RANK.get(current, 9)


@dataclass(frozen=True)
class ResolveResult:
    point: GeoPoint | None
    candidates: tuple[PlaceCandidate, ...]
    postal_code_unknown: bool
    country_has_no_postal_directory: bool
    available: bool

    def as_dict(self) -> dict[str, Any]:
        return {
            "point": self.point.as_dict() if self.point else None,
            "candidates": [candidate.as_dict() for candidate in self.candidates],
            "postalCodeUnknown": self.postal_code_unknown,
            "countryHasNoPostalDirectory": self.country_has_no_postal_directory,
            "available": self.available,
        }


UNAVAILABLE = ResolveResult(None, (), False, True, False)


def resolve(
    country_code: str,
    *,
    postal_code: str | None = None,
    locality: str | None = None,
    subdivision_code: str | None = None,
) -> ResolveResult:
    """Best effort, with everything a caller needs to explain the answer.

    Deliberately does not choose between several places sharing a postal code when they are
    far apart: all of them are returned and the first is pointed at. Silently picking one is
    how a laboratory ends up plotted in the wrong district with nothing on screen to say so.
    """
    shard = directory_for(country_code)
    if shard is None:
        return UNAVAILABLE

    typed = (postal_code or "").strip()
    by_code = shard.places_for_postal_code(typed) if typed else []
    by_name = shard.places_named(locality) if not by_code and locality else []
    candidates = by_code or by_name

    if candidates:
        point: GeoPoint | None = point_from_candidate(candidates[0])
    else:
        point = (shard.subdivision_point(subdivision_code) if subdivision_code else None) or shard.country_point()

    return ResolveResult(
        point=point,
        candidates=tuple(candidates),
        postal_code_unknown=bool(typed) and shard.has_postal_directory and not by_code,
        country_has_no_postal_directory=not shard.has_postal_directory,
        available=True,
    )


def has_postal_directory(country_code: str) -> bool:
    shard = directory_for(country_code)
    return bool(shard and shard.has_postal_directory)


def reset_cache() -> None:
    """Test seam, and the hook a deployment needs after removing shards."""
    directory_for.cache_clear()


def attribution() -> str:
    """Required by CC BY 4.0 wherever a resolved point is shown."""
    return "Contains data from GeoNames (www.geonames.org), CC BY 4.0."


def bundled_countries() -> Iterable[str]:
    return sorted(path.name.removesuffix(".json.gz") for path in DIRECTORY_ROOT.glob("*.json.gz"))
