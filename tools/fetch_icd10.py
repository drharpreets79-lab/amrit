#!/usr/bin/env python3
"""Fetch ICD-10 categories from WHO's own ICD API, for the chapters AMR surveillance uses.

Phase 24. The companion to `fetch_icd11.py`, against `/icd/release/10/…`, and it exists for the
same reason: the 34-code starter set was authored by hand, and `$validate-code` against WHO
found that one of its codes (`U88`) does not exist and five of its descriptions had drifted from
WHO's own text. A hand-authored value set is a guess about a classification; a fetched one is the
classification.

## Which chapters, and why not all of them

Chapter I (`A00-B99`, certain infectious and parasitic diseases) and chapter XXII (`U00-U89`,
codes for special purposes, which is where `U82-U85` antimicrobial resistance lives). Those are
the chapters an AMR surveillance record draws a diagnosis from. Chapter XIV's `N39.0` and
chapter X's pneumonias are the common exceptions, so the block list below names them explicitly
rather than pulling two more chapters wholesale.

Fetching all 22 chapters is possible and is roughly 12,000 categories, an hour of requests, and a
6 MB asset most of which no AMR deployment will ever open. `--chapters` takes whatever a
deployment does want; the default is what this product reports on.

## What is taken, and what is left alone

Categories (`A00`) and their subcategories (`A00.0`) — the levels a diagnosis is actually coded
at. Blocks (`A00-A09`) are ranges rather than codes and are recorded as the parent of what they
contain, not as selectable codes: coding a diagnosis to a range is not coding it.

WHO's title is kept verbatim. Where the existing starter set disagreed, WHO wins and the
difference is reported, because the starter set is this repository's paraphrase and the API is
the classification.

## Credentials

Read from the environment, never written to disk:

    export ICD_API_CLIENT_ID=...
    export ICD_API_CLIENT_SECRET=...

or `ICD_API_CREDENTIALS_FILE=~/.amrit/icd-api.json` holding `{"client_id": …, "client_secret": …}`.
WHO issues them free at <https://icd.who.int/icdapi>.

    python3 tools/fetch_icd10.py                      # fetch the default chapters
    python3 tools/fetch_icd10.py --chapters I XXII X  # more chapters
    python3 tools/fetch_icd10.py --check              # offline: verify the committed cache
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path
from typing import Any

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
CACHE = REPOSITORY_ROOT / "shared" / "terminology" / "icd10-who.verified.json"

TOKEN_ENDPOINT = "https://icdaccessmanagement.who.int/connect/token"
API_ROOT = "https://id.who.int"
DEFAULT_RELEASE = "2019"
DEFAULT_CHAPTERS = ("I", "XXII")
# Blocks outside the default chapters that AMR surveillance codes into often enough to bundle.
# Named individually rather than by pulling their whole chapter: a urinary tract infection and a
# pneumonia are the two diagnoses that recur, and chapters X and XIV are 2,000 codes between them.
EXTRA_BLOCKS = ("J09-J18", "N30-N39")


class IcdApiError(RuntimeError):
    pass


def credentials() -> tuple[str, str]:
    client_id = os.environ.get("ICD_API_CLIENT_ID", "").strip()
    client_secret = os.environ.get("ICD_API_CLIENT_SECRET", "").strip()
    if not (client_id and client_secret):
        named = os.environ.get("ICD_API_CREDENTIALS_FILE", "").strip()
        if named:
            payload = json.loads(Path(named).expanduser().read_text(encoding="utf-8"))
            client_id = str(payload.get("client_id", "")).strip()
            client_secret = str(payload.get("client_secret", "")).strip()
    if not (client_id and client_secret):
        raise IcdApiError(
            "No ICD API credentials. WHO issues them free of charge at https://icd.who.int/icdapi. "
            "Set ICD_API_CLIENT_ID and ICD_API_CLIENT_SECRET, or point ICD_API_CREDENTIALS_FILE at "
            "a file holding them. They are never written into this repository."
        )
    return client_id, client_secret


def access_token() -> str:
    client_id, client_secret = credentials()
    body = urllib.parse.urlencode({
        "client_id": client_id, "client_secret": client_secret,
        "scope": "icdapi_access", "grant_type": "client_credentials",
    }).encode()
    request = urllib.request.Request(
        TOKEN_ENDPOINT, data=body, headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            payload = json.loads(response.read())
    except urllib.error.HTTPError as error:
        raise IcdApiError(f"The token endpoint refused the credentials ({error.code}).") from error
    token = str(payload.get("access_token", ""))
    if not token:
        raise IcdApiError("The token endpoint answered without an access_token.")
    return token


def fetch(url: str, token: str, delay: float) -> dict[str, Any]:
    request = urllib.request.Request(
        url.replace("http://", "https://"),
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json",
                 "Accept-Language": "en", "API-Version": "v2"})
    with urllib.request.urlopen(request, timeout=90) as response:
        payload = json.loads(response.read())
    time.sleep(delay)
    return payload


def title_of(entity: dict[str, Any]) -> str:
    return str((entity.get("title") or {}).get("@value", "")).strip()


def walk(url: str, token: str, delay: float, out: list[dict[str, str]], seen: set[str],
         parent: str = "") -> None:
    """Depth-first over WHO's own child links. Only coded entities are recorded."""
    if url in seen:
        return
    seen.add(url)
    try:
        entity = fetch(url, token, delay)
    except Exception as error:  # noqa: BLE001 - one unreachable node must not lose the rest
        print(f"  skipped {url}: {error}", file=sys.stderr)
        return
    code = str(entity.get("code", "")).strip()
    title = title_of(entity)
    # A block is a range ("A00-A09"), not a code a diagnosis is assigned to.
    is_block = "-" in code
    if code and title and not is_block:
        out.append({"code": code, "display": title, "parent": parent})
    for child in entity.get("child", []) or []:
        walk(child, token, delay, out, seen, parent=code or parent)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--release", default=DEFAULT_RELEASE, help="ICD-10 release, e.g. 2019")
    parser.add_argument("--chapters", nargs="*", default=list(DEFAULT_CHAPTERS),
                        help="chapter numerals to take whole")
    parser.add_argument("--blocks", nargs="*", default=list(EXTRA_BLOCKS),
                        help="individual blocks to take from other chapters")
    parser.add_argument("--delay", type=float, default=0.08, help="seconds between requests")
    parser.add_argument("--check", action="store_true", help="offline: verify the committed cache")
    arguments = parser.parse_args()

    if arguments.check:
        if not CACHE.exists():
            print(f"missing {CACHE.relative_to(REPOSITORY_ROOT)}; run tools/fetch_icd10.py", file=sys.stderr)
            return 1
        cached = json.loads(CACHE.read_text(encoding="utf-8"))
        codes = cached.get("codes", [])
        if not codes:
            print("the ICD-10 cache is empty", file=sys.stderr)
            return 1
        duplicates = len(codes) - len({row["code"] for row in codes})
        if duplicates:
            print(f"the ICD-10 cache has {duplicates} duplicate code(s)", file=sys.stderr)
            return 1
        print(f"ICD-10 cache holds {len(codes)} codes from WHO release {cached.get('release')}")
        return 0

    token = access_token()
    collected: list[dict[str, str]] = []
    seen: set[str] = set()
    base = f"{API_ROOT}/icd/release/10/{arguments.release}"
    for chapter in arguments.chapters:
        print(f"chapter {chapter}", flush=True)
        walk(f"{base}/{chapter}", token, arguments.delay, collected, seen)
    for block in arguments.blocks:
        print(f"block {block}", flush=True)
        walk(f"{base}/{block}", token, arguments.delay, collected, seen)

    unique: dict[str, dict[str, str]] = {}
    for row in collected:
        unique.setdefault(row["code"], row)
    payload = {
        "source": f"{API_ROOT}/icd/release/10/{arguments.release}",
        "system": "http://hl7.org/fhir/sid/icd-10",
        "release": arguments.release,
        "retrieved": date.today().isoformat(),
        "chapters": arguments.chapters,
        "blocks": arguments.blocks,
        "licenceNote": (
            "ICD is published by WHO and freely available for use; WHO retains copyright and "
            "requires attribution. Titles are WHO's own, taken verbatim from the ICD API. A "
            "modified or extended list must not be presented as the classification itself."
        ),
        "codes": sorted(unique.values(), key=lambda row: row["code"]),
    }
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_text(json.dumps(payload, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {len(payload['codes'])} ICD-10 codes -> {CACHE.relative_to(REPOSITORY_ROOT)}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except IcdApiError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from error
