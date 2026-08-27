#!/usr/bin/env python3
"""Build the bundled geographic directory: postal codes and places to coordinates.

An address the software can only *store* is worth less than one it can *place*. A national
programme asking "where are the carbapenem-resistant isolates coming from" needs facilities
on a map, and typing latitude and longitude by hand — which is what this software asked for
until now — is not something a laboratory will do correctly, or at all.

The directory answers three questions, in descending order of precision:

  1. **What is at this postal code?**  GeoNames' postal dataset, ~1.8 million codes across
     121 countries, each with a place name, its administrative names and a coordinate.
  2. **Where is this town?**  GeoNames' `cities500` gazetteer, ~235,000 settlements of 500
     people or more. This is the answer for the ~130 countries with no postal system at
     all, and the fallback for a code the directory has not caught up with.
  3. **Where is this administrative area?**  A population-weighted centroid of the places
     within it, matched by name onto the ISO 3166-2 subdivisions the reporting tree uses.
     Coarse, and labelled as such, but it never leaves a facility unplaced.

Postal codes are the input an operator already knows, which is why they are the primary key
here. They are not sufficient on their own and this software must never assume they are:
roughly half the countries in ISO 3166-1 have no postal system, several publish only a
truncated code (Ireland, Malta, Chile, China, Argentina, Brazil), and where codes *are*
point-precise — the United Kingdom, the Netherlands — a coordinate derived from one
identifies a building. That is why every resolved point carries an explicit precision, and
why nothing here is ever applied to a patient's residence.

## Shape

One gzipped shard per country, all of them bundled, loaded only when that country is the
deployment's. Names are pooled and coordinates rounded to four decimals (~11 m), which is
what keeps 1.8 million rows inside a few tens of megabytes.

    python3 tools/generate_geo_directory.py --source /path/to/geonames
    python3 tools/generate_geo_directory.py --check

Source files, all CC BY 4.0 from https://download.geonames.org:

    export/zip/allCountries.zip     postal codes
    export/dump/cities500.zip       settlements over 500 people
    export/dump/countryInfo.txt     ISO alpha-2 to alpha-3
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import shutil
import sys
import unicodedata
import zipfile
from collections import defaultdict
from datetime import date
from pathlib import Path
from typing import Any, Iterator
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent.parent
OUTPUT_DIR = ROOT / "shared" / "geo-directory"
ISO_PACK = ROOT / "shared" / "geo-packs" / "_iso3166-2.json"

SCHEMA_VERSION = 1
DATASET = "geonames-geo-directory"
LICENCE_URL = "https://creativecommons.org/licenses/by/4.0/"
BASE_URL = "https://download.geonames.org/export"
DOWNLOADS = {
    "allCountries.zip": f"{BASE_URL}/zip/allCountries.zip",
    "cities500.zip": f"{BASE_URL}/dump/cities500.zip",
    "countryInfo.txt": f"{BASE_URL}/dump/countryInfo.txt",
    # Names for GeoNames' own first-level divisions. Without it the only division names
    # available come from the postal dataset, so the 126 countries with no postal codes had
    # nameless divisions and none of their ISO 3166-2 subdivisions could be matched — which
    # is exactly the half of the world this work exists to serve.
    "admin1CodesASCII.txt": f"{BASE_URL}/dump/admin1CodesASCII.txt",
}

# Coordinates to four decimals: about 11 metres, finer than any source here is accurate to,
# and it roughly halves the compressed size against the source's six.
PRECISION = 4


def _fetch(source: Path) -> None:
    """Download whatever is missing. Existing files are left alone."""
    source.mkdir(parents=True, exist_ok=True)
    for name, url in DOWNLOADS.items():
        target = source / name
        if target.exists():
            continue
        print(f"downloading {name} from {url}")
        with urlopen(url) as response, target.open("wb") as handle:  # noqa: S310 - fixed host
            shutil.copyfileobj(response, handle)


def _rows(source: Path, archive: str, member: str) -> Iterator[list[str]]:
    """Tab-separated rows from a zip member, or from the extracted file beside it."""
    plain = source / member
    if plain.exists():
        with plain.open("r", encoding="utf-8") as handle:
            for line in handle:
                if line.strip():
                    yield line.rstrip("\n").split("\t")
        return
    with zipfile.ZipFile(source / archive) as bundle, bundle.open(member) as handle:
        for raw in handle:
            line = raw.decode("utf-8").rstrip("\n")
            if line.strip():
                yield line.split("\t")


def _alpha3_by_alpha2(source: Path) -> dict[str, str]:
    mapping: dict[str, str] = {}
    for line in (source / "countryInfo.txt").read_text(encoding="utf-8").splitlines():
        if line.startswith("#") or not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) > 1 and len(parts[0]) == 2 and len(parts[1]) == 3:
            mapping[parts[0]] = parts[1]
    return mapping


def _fold(name: str) -> str:
    """A name reduced to what two spellings of the same place have in common.

    Diacritics stripped, case folded, punctuation and the connecting words that differ
    between datasets removed — GeoNames writes "Arunachal Pradesh" where ISO 3166-2 writes
    "Arunāchal Pradesh", and "Provincia de Buenos Aires" where ISO writes "Buenos Aires".
    """
    decomposed = unicodedata.normalize("NFKD", name)
    stripped = "".join(character for character in decomposed if not unicodedata.combining(character))
    lowered = stripped.casefold()
    words = [word for word in "".join(c if c.isalnum() else " " for c in lowered).split() if word]
    # The two datasets differ mostly by the administrative noun one of them spells out:
    # GeoNames writes "Municipality of Žalec" where ISO 3166-2 writes "Žalec", and
    # "Provincia de Buenos Aires" where ISO writes "Buenos Aires". Dropping these words is
    # what takes subdivision matching from half the world to most of it.
    noise = {"province", "provincia", "provincie", "prefecture", "region", "regione", "regiao",
             "state", "estado", "department", "departamento", "district", "governorate",
             "county", "municipality", "municipio", "commune", "comune", "canton", "kanton",
             "oblast", "okrug", "krai", "voivodeship", "parish", "territory", "federal",
             "republic", "autonomous", "special", "administrative", "metropolitan", "city",
             "capital", "island", "islands", "emirate", "division", "zone", "area", "council",
             "de", "del", "da", "do", "of", "the", "la", "le", "el", "and", "y"}
    meaningful = [word for word in words if word not in noise]
    return " ".join(meaningful or words)


class _Pool:
    """A string pool. Place names repeat across thousands of postal codes each."""

    def __init__(self) -> None:
        self.values: list[str] = []
        self._index: dict[str, int] = {}

    def add(self, value: str) -> int:
        value = value.strip()
        found = self._index.get(value)
        if found is None:
            found = len(self.values)
            self._index[value] = found
            self.values.append(value)
        return found


def _round(value: str) -> float | None:
    try:
        return round(float(value), PRECISION)
    except (TypeError, ValueError):
        return None


def _geonames_admin1_names(source: Path) -> dict[str, dict[str, str]]:
    """alpha-2 -> GeoNames admin1 code -> its name, from `admin1CodesASCII.txt`.

    Rows are `CC.code \t name \t asciiname \t geonameid`. Both spellings are kept as
    alternatives, since ISO 3166-2 sometimes agrees with one and not the other.
    """
    names: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    path = source / "admin1CodesASCII.txt"
    if not path.exists():
        return names
    for line in path.read_text(encoding="utf-8").splitlines():
        parts = line.split("\t")
        if len(parts) < 2 or "." not in parts[0]:
            continue
        alpha2, _, code = parts[0].partition(".")
        for spelling in parts[1:3]:
            if spelling.strip():
                names[alpha2][code].add(spelling.strip())
    return names


def _iso_subdivisions() -> dict[str, list[tuple[str, str]]]:
    """ISO 3166-2 level-1 units per alpha-3, as (code, folded name)."""
    if not ISO_PACK.exists():
        return {}
    pack = json.loads(ISO_PACK.read_text(encoding="utf-8"))
    out: dict[str, list[tuple[str, set[str]]]] = {}
    for alpha3, entry in (pack.get("countries") or {}).items():
        units = []
        for unit in entry.get("units") or []:
            if unit.get("level") != 1 or not unit.get("code") or not unit.get("name"):
                continue
            # The standard's romanisation and the local spelling are both offered, because
            # GeoNames agrees with one or the other depending on the country.
            spellings = {_fold(unit["name"])}
            if unit.get("name_local"):
                spellings.add(_fold(unit["name_local"]))
            units.append((unit["code"], {spelling for spelling in spellings if spelling}))
        out[alpha3] = units
    return out


def build(source: Path, check: bool) -> int:
    alpha3_by_alpha2 = _alpha3_by_alpha2(source)
    admin1_codes = _geonames_admin1_names(source)
    iso_units = _iso_subdivisions()

    # country -> postal code -> list of (place, admin1 name, admin1 code, admin2 name, lat, lng, accuracy)
    postal: dict[str, dict[str, list[tuple]]] = defaultdict(lambda: defaultdict(list))
    for row in _rows(source, "allCountries.zip", "allCountries.txt"):
        if len(row) < 11:
            continue
        alpha2, code, place = row[0], row[1].strip(), row[2].strip()
        latitude, longitude = _round(row[9]), _round(row[10])
        if not alpha2 or not code or latitude is None or longitude is None:
            continue
        accuracy = row[11].strip() if len(row) > 11 else ""
        postal[alpha2][code].append((place, row[3].strip(), row[4].strip(), row[5].strip(),
                                     latitude, longitude, accuracy))
    print(f"postal: {sum(len(codes) for codes in postal.values())} codes in {len(postal)} countries")

    # country -> list of (name, admin1 code, admin2 code, lat, lng, population)
    localities: dict[str, list[tuple]] = defaultdict(list)
    for row in _rows(source, "cities500.zip", "cities500.txt"):
        if len(row) < 15:
            continue
        alpha2, name = row[8], row[1].strip()
        latitude, longitude = _round(row[4]), _round(row[5])
        if not alpha2 or not name or latitude is None or longitude is None:
            continue
        try:
            population = int(row[14] or 0)
        except ValueError:
            population = 0
        localities[alpha2].append((name, row[10].strip(), row[11].strip(), latitude, longitude, population))
    print(f"localities: {sum(len(rows) for rows in localities.values())} in {len(localities)} countries")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    index: dict[str, dict[str, Any]] = {}
    unmatched_total = 0

    for alpha2 in sorted(set(postal) | set(localities)):
        alpha3 = alpha3_by_alpha2.get(alpha2)
        if not alpha3:
            continue
        names = _Pool()

        codes: dict[str, list[list]] = {}
        for code, entries in postal[alpha2].items():
            codes[code] = [
                [names.add(place), names.add(admin1), names.add(admin2), latitude, longitude,
                 int(accuracy) if accuracy.isdigit() else None]
                for place, admin1, _admin1_code, admin2, latitude, longitude, accuracy in entries
            ]

        places = [
            [names.add(name), admin1_code, names.add(admin2_code), latitude, longitude, population]
            for name, admin1_code, admin2_code, latitude, longitude, population in localities[alpha2]
        ]

        # A subdivision's centroid, weighted by population so it lands where the people are
        # rather than in the empty middle of a large, mostly unpopulated area.
        weighted: dict[str, list[float]] = defaultdict(lambda: [0.0, 0.0, 0.0])
        country_weight = [0.0, 0.0, 0.0]
        for name, admin1_code, _admin2, latitude, longitude, population in localities[alpha2]:
            weight = float(max(population, 1))
            for bucket in (weighted[admin1_code], country_weight) if admin1_code else (country_weight,):
                bucket[0] += latitude * weight
                bucket[1] += longitude * weight
                bucket[2] += weight
        centroids = {
            admin1_code: [round(total[0] / total[2], PRECISION), round(total[1] / total[2], PRECISION)]
            for admin1_code, total in weighted.items() if total[2]
        }
        country_centroid = (
            [round(country_weight[0] / country_weight[2], PRECISION),
             round(country_weight[1] / country_weight[2], PRECISION)]
            if country_weight[2] else None
        )

        # GeoNames numbers its own administrative divisions; the reporting tree uses ISO
        # 3166-2. Matched on the folded name, which is the only thing the two datasets share.
        admin1_names: dict[str, set[str]] = defaultdict(set)
        for code, spellings in admin1_codes.get(alpha2, {}).items():
            admin1_names[code].update(spellings)
        for _code, admin1_name, admin1_code, _a2, _lat, _lng, _acc in (
            entry for entries in postal[alpha2].values() for entry in entries
        ):
            if admin1_code and admin1_name:
                admin1_names[admin1_code].add(admin1_name)

        folded_geonames: dict[str, str] = {}
        for code, spellings in admin1_names.items():
            for spelling in spellings:
                folded_geonames.setdefault(_fold(spelling), code)

        by_iso: dict[str, list[float]] = {}
        unmatched: list[str] = []
        for iso_code, spellings in iso_units.get(alpha3, []):
            # The ISO code's own suffix is the second route: many countries number their
            # divisions identically in both datasets (`IN-KL` against GeoNames `KL`), and a
            # code match is worth more than a name match when both are available.
            suffix = iso_code.partition("-")[2]
            geonames_code = next(
                (folded_geonames[folded] for folded in spellings if folded in folded_geonames),
                suffix if suffix in centroids else None,
            )
            centroid = centroids.get(geonames_code) if geonames_code else None
            if centroid:
                by_iso[iso_code] = centroid
            else:
                unmatched.append(iso_code)
        unmatched_total += len(unmatched)

        shard = {
            "schemaVersion": SCHEMA_VERSION,
            "alpha2": alpha2,
            "alpha3": alpha3,
            "names": names.values,
            "postalCodes": codes,
            "localities": places,
            "subdivisionCentroids": by_iso,
            "countryCentroid": country_centroid,
        }
        path = OUTPUT_DIR / f"{alpha3}.json.gz"
        payload = json.dumps(shard, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if not check:
            # mtime=0 so an unchanged shard produces identical bytes and does not churn git.
            with gzip.GzipFile(filename="", mode="wb", fileobj=path.open("wb"), mtime=0) as handle:
                handle.write(payload)
        index[alpha3] = {
            "alpha2": alpha2,
            "postalCodes": len(codes),
            "localities": len(places),
            "subdivisionCentroids": len(by_iso),
            "subdivisionsUnmatched": unmatched,
            "bytes": path.stat().st_size if path.exists() else 0,
            "sha256": hashlib.sha256(payload).hexdigest(),
        }

    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "dataset": DATASET,
        "generated": date.today().isoformat(),
        "source": "GeoNames postal codes and cities500 gazetteer",
        "sourceUrl": "https://download.geonames.org",
        "licence": "Creative Commons Attribution 4.0",
        "licenceUrl": LICENCE_URL,
        "attribution": "Contains data from GeoNames (www.geonames.org), CC BY 4.0.",
        "countries": index,
    }
    manifest_path = OUTPUT_DIR / "manifest.json"
    if not check:
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    total = sum(entry["bytes"] for entry in index.values())
    with_postal = sum(1 for entry in index.values() if entry["postalCodes"])
    print(f"wrote {len(index)} shards, {total / 1_000_000:.1f} MB total")
    print(f"  {with_postal} countries have postal codes; the rest resolve by locality and subdivision")
    print(f"  {unmatched_total} ISO 3166-2 subdivisions could not be matched to a GeoNames division")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT / ".geonames-cache",
                        help="folder holding the GeoNames downloads; missing files are fetched")
    parser.add_argument("--check", action="store_true", help="report without writing")
    arguments = parser.parse_args()
    _fetch(arguments.source)
    raise SystemExit(build(arguments.source, arguments.check))
