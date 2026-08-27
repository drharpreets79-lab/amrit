#!/usr/bin/env python3
"""Fetch ICD-11 MMS codes from WHO's own ICD API, and keep only what WHO confirms.

Phase 26. The diagnosis starter set shipped in Phase 24 is ICD-10, and its own notice says a
deployment may replace it with "an ICD-11 linearisation". This is that linearisation, taken
from the source of truth rather than transcribed: <https://icd.who.int/icdapi>.

## What this tool does and does not decide

The candidate list below is authored here — it is a statement about *which infection
syndromes AMR surveillance reports on*, mirroring the ICD-10 starter set concept for concept.
Everything else comes from WHO:

* the code is confirmed by `codeinfo`, which resolves a code to its entity URI,
* the title is WHO's `title`, never a string this repository typed,
* a candidate WHO does not recognise is **rejected and listed with the reason**, exactly as
  `verify_icd10` does. A guessed ICD-11 code that silently became a diagnosis on a patient
  record is the failure this design exists to prevent.

`--children` widens the set one level down from each verified code. Those codes are WHO's
own children of a confirmed parent, so widening adds no judgement of ours.

## What the API does not offer, and what follows from that

There is no ICD-10 → ICD-11 mapping endpoint. The published surface is
`/icd/release/11/…` (foundation, linearizations, codeinfo, search) and `/icd/release/10/…`
(ICD-10 categories); the swagger at <https://id.who.int/swagger/index.html> lists 21 paths
and none of them maps between revisions. WHO publishes mapping *tables* separately, outside
the API and under their own terms.

So this tool emits **no ConceptMap between the two revisions**, and the seed carries none.
Two starter value sets coexist — a record says which system it used, which is what the
`diagnosis_system` column has always been for. Inventing an equivalence between an ICD-10
category and an ICD-11 category, neither of which is a subset of the other, would be a
guess with a patient's diagnosis attached to it.

## Credentials

WHO issues a client id and secret free of charge to anyone who registers at
<https://icd.who.int/icdapi>. They are read from the environment, or from a file named by
`ICD_API_CREDENTIALS_FILE`, and are never written to disk or into the cache:

    export ICD_API_CLIENT_ID=...
    export ICD_API_CLIENT_SECRET=...

    # or, for a shell whose environment this tool does not inherit:
    export ICD_API_CREDENTIALS_FILE=~/.amrit/icd-api.json   # {"client_id": "...", "client_secret": "..."}

`.icd-api.json` and `.icd-api.env` are in `.gitignore` so a credentials file dropped in the
working tree cannot be committed by accident.

## Usage

    python3 tools/fetch_icd11.py                    # verify the candidates (network)
    python3 tools/fetch_icd11.py --children         # also take one level of WHO's children
    python3 tools/fetch_icd11.py --release 2025-01  # pin a release rather than take the latest
    python3 tools/fetch_icd11.py --check            # offline: is the committed cache usable?

The output feeds `tools/generate_terminology_seed.py`, which is what actually builds the
asset both runtimes read.
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
CACHE = REPOSITORY_ROOT / "shared" / "terminology" / "icd11-mms.verified.json"

TOKEN_ENDPOINT = "https://icdaccessmanagement.who.int/connect/token"
API_ROOT = "https://id.who.int"
LINEARIZATION = "mms"
# The canonical system URI for ICD-11 MMS, and the one HL7 uses. It is a URI, not a fetchable
# document; the release-qualified URL underneath it is what this tool reads.
ICD11_SYSTEM = "http://id.who.int/icd/release/11/mms"

# ICD-11 MMS candidates, one per concept in the ICD-10 starter set at
# `app/resources/diagnosis-codes.v1.json`, plus the syndromes that set records at
# category level, plus WHO's own antimicrobial-resistance block. `icd10` names the concept
# this parallels; it is a note for the reviewer, not an assertion of equivalence — see the
# module docstring.
#
# `expect` is the load-bearing field. It is a lowercase substring WHO's own title must
# contain before the code is accepted, and it exists because the first run of this tool
# accepted all 32 candidates and nine of them were the wrong concept:
#
#   1A04 was labelled "Enteritis due to Campylobacter" and WHO's 1A04 is
#        "Intestinal infections due to Clostridioides difficile";
#   1A09 was labelled "Shigellosis" and WHO's 1A09 is "Infections due to other Salmonella";
#   1D00 was labelled "Bacterial meningitis" and WHO's 1D00 is "Infectious encephalitis";
#   1G60 was "Bacteraemia" and WHO's 1G60 is "Certain other disorders of infectious origin";
#   CB27 was "Pyothorax" and WHO's CB27 is "Pleural effusion";
#   FA11 was "Pyogenic arthritis" and WHO's FA11 is "Reactive arthropathies";
#   NE81 was "Infection following a procedure" and WHO's NE81 is "Injury or harm arising
#        from a procedure";
#   QA0Y was "Carrier of an infectious agent" and WHO's QA0Y is "Other examination or
#        investigation";
#   GB55 was matched to ICD-10 N10 (acute) and WHO's GB55 is the *chronic* nephritis.
#
# Every one of those is a real ICD-11 code, so checking that the code resolves proved
# nothing. A pneumonia patient coded as a pleural effusion is not a missing code, it is a
# wrong diagnosis on a patient record, and it is invisible downstream because the code
# validates. `expect` turns "this code exists" into "this code means what we asked for",
# and a candidate that fails it is rejected and listed with WHO's actual title.
CANDIDATES: list[dict[str, str]] = [
    # Enteric infections
    {"code": "1A00", "purpose": "Cholera", "expect": "cholera", "icd10": "A00"},
    {"code": "1A02", "purpose": "Intestinal infections due to Shigella", "expect": "shigella", "icd10": "A03"},
    {"code": "1A03", "purpose": "Intestinal infections due to Escherichia coli", "expect": "escherichia coli", "icd10": "A04"},
    {"code": "1A04", "purpose": "Intestinal infections due to Clostridioides difficile", "expect": "clostridioides difficile", "icd10": "A04.7"},
    {"code": "1A06", "purpose": "Gastroenteritis due to Campylobacter", "expect": "campylobacter", "icd10": "A04.5"},
    {"code": "1A07", "purpose": "Typhoid fever", "expect": "typhoid", "icd10": "A01"},
    {"code": "1A09", "purpose": "Infections due to other Salmonella", "expect": "salmonella", "icd10": "A02"},
    {"code": "1A0Z", "purpose": "Bacterial intestinal infections, unspecified", "expect": "bacterial intestinal infections", "icd10": "A04"},
    {"code": "1A40", "purpose": "Gastroenteritis or colitis, agent unspecified", "expect": "gastroenteritis or colitis", "icd10": "A09"},
    # Tuberculosis
    {"code": "1B10", "purpose": "Tuberculosis of the respiratory system", "expect": "tuberculosis of the respiratory", "icd10": "A15"},
    {"code": "1B1Z", "purpose": "Tuberculosis, unspecified", "expect": "tuberculosis", "icd10": "A16"},
    # Skin and soft tissue
    {"code": "1B70", "purpose": "Bacterial cellulitis, erysipelas or lymphangitis", "expect": "cellulitis", "icd10": "L03"},
    {"code": "1B72", "purpose": "Impetigo", "expect": "impetigo", "icd10": "L01"},
    {"code": "1B7Y", "purpose": "Other specified pyogenic bacterial infection of skin", "expect": "pyogenic bacterial infection of skin", "icd10": "L08"},
    # Central nervous system
    {"code": "1C1C", "purpose": "Meningococcal disease", "expect": "meningococcal", "icd10": "A39"},
    {"code": "1D00", "purpose": "Infectious encephalitis, not elsewhere classified", "expect": "encephalitis", "icd10": "G04"},
    {"code": "1D01", "purpose": "Infectious meningitis, not elsewhere classified", "expect": "meningitis", "icd10": "G00"},
    {"code": "1D01.0Z", "purpose": "Bacterial meningitis, unspecified", "expect": "bacterial meningitis", "icd10": "G00.9"},
    # Sepsis and bloodstream infection
    {"code": "1G40", "purpose": "Sepsis without septic shock", "expect": "sepsis without septic shock", "icd10": "A41"},
    {"code": "1G41", "purpose": "Sepsis with septic shock", "expect": "septic shock", "icd10": "A41.9"},
    {"code": "MA15.0", "purpose": "Bacteraemia", "expect": "bacteraemia", "icd10": "A49.9"},
    {"code": "KA60", "purpose": "Sepsis of fetus or newborn", "expect": "sepsis of fetus or newborn", "icd10": "P36"},
    {"code": "JB40.0", "purpose": "Puerperal sepsis", "expect": "puerperal sepsis", "icd10": "O85"},
    # Cardiac
    {"code": "BB40", "purpose": "Acute or subacute infectious endocarditis", "expect": "endocarditis", "icd10": "I33"},
    # Respiratory
    {"code": "CA40", "purpose": "Pneumonia", "expect": "pneumonia", "icd10": "J18"},
    {"code": "CA42", "purpose": "Acute bronchitis", "expect": "acute bronchitis", "icd10": "J20"},
    {"code": "CA44", "purpose": "Pyothorax", "expect": "pyothorax", "icd10": "J86"},
    # Intra-abdominal
    {"code": "DC12", "purpose": "Cholecystitis", "expect": "cholecystitis", "icd10": "K81"},
    {"code": "DC50", "purpose": "Peritonitis", "expect": "peritonitis", "icd10": "K65"},
    # Bone and joint
    {"code": "FA10", "purpose": "Direct infections of joint", "expect": "direct infections of joint", "icd10": "M00"},
    {"code": "FB84", "purpose": "Osteomyelitis or osteitis", "expect": "osteomyelitis", "icd10": "M86"},
    # Urinary tract
    {"code": "GB51", "purpose": "Acute pyelonephritis", "expect": "pyelonephritis", "icd10": "N10"},
    {"code": "GC08", "purpose": "Urinary tract infection, site not specified", "expect": "urinary tract infection", "icd10": "N39.0"},
    # Healthcare-associated
    {"code": "NE81.2", "purpose": "Surgical site infection", "expect": "surgical site infection", "icd10": "T81.4"},
    {"code": "QD0Z", "purpose": "Carrier of infectious disease agent, unspecified", "expect": "carrier of infectious disease agent", "icd10": "Z22"},
    # WHO's antimicrobial-resistance block. This is the part of ICD-11 that ICD-10 answers
    # only with the U82–U88 supplementary codes, and it is the reason an AMR product wants
    # ICD-11 at all: `--children` expands these into the organism-specific findings —
    # MG51.00 is methicillin resistant Staphylococcus aureus — which is the vocabulary this
    # product's own alerts are already written in.
    {"code": "MG50", "purpose": "Gram negative bacteria resistant to antimicrobial drugs", "expect": "gram negative bacteria resistant", "icd10": "U82-U88"},
    {"code": "MG51", "purpose": "Gram positive bacteria resistant to antimicrobial drugs", "expect": "gram positive bacteria resistant", "icd10": "U82-U88"},
    {"code": "MG52", "purpose": "Bacteria neither gram negative nor positive, resistant to antimicrobial drugs", "expect": "neither gram negative nor positive", "icd10": "U82-U88"},
    {"code": "MG53", "purpose": "Virus resistant to antimicrobial drugs", "expect": "virus resistant", "icd10": "U82-U88"},
    {"code": "MG54", "purpose": "Fungus resistant to antimicrobial drugs", "expect": "fungus resistant", "icd10": "U82-U88"},
]


class IcdApiError(RuntimeError):
    """A failure that stops the run, as opposed to one candidate WHO declines."""


DEFAULT_CREDENTIAL_FILES = (
    REPOSITORY_ROOT / ".icd-api.json",
    Path.home() / ".amrit" / "icd-api.json",
)


def credentials_from_file(path: Path) -> tuple[str, str]:
    """Read a credentials file, accepting either JSON or `KEY=value` lines.

    A file is offered because the shell that runs this tool is not always the shell the
    operator exported the variables in. It is read and never rewritten, and nothing from it
    reaches the cache, the console or an error message.
    """
    text = path.read_text(encoding="utf-8")
    values: dict[str, str] = {}
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            values = {str(key).lower(): str(value) for key, value in parsed.items()}
    except json.JSONDecodeError:
        for line in text.splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                key, _, value = line.partition("=")
                values[key.strip().lower().removeprefix("icd_api_")] = value.strip().strip("'\"")
    return values.get("client_id", "").strip(), values.get("client_secret", "").strip()


def credentials() -> tuple[str, str]:
    client_id = os.environ.get("ICD_API_CLIENT_ID", "").strip()
    client_secret = os.environ.get("ICD_API_CLIENT_SECRET", "").strip()
    if not client_id or not client_secret:
        named = os.environ.get("ICD_API_CREDENTIALS_FILE", "").strip()
        candidates = [Path(named).expanduser()] if named else list(DEFAULT_CREDENTIAL_FILES)
        for path in candidates:
            if path.is_file():
                client_id, client_secret = credentials_from_file(path)
                if client_id and client_secret:
                    break
    if not client_id or not client_secret:
        raise IcdApiError(
            "No ICD API credentials. WHO issues them free of charge at "
            "https://icd.who.int/icdapi. Either set ICD_API_CLIENT_ID and ICD_API_CLIENT_SECRET, "
            "or write {\"client_id\": \"...\", \"client_secret\": \"...\"} to .icd-api.json in the "
            "repository root (gitignored) or ~/.amrit/icd-api.json."
        )
    return client_id, client_secret


def access_token() -> str:
    """OAuth 2 client credentials, the only flow the ICD API accepts."""
    client_id, client_secret = credentials()
    body = urllib.parse.urlencode({
        "client_id": client_id,
        "client_secret": client_secret,
        "scope": "icdapi_access",
        "grant_type": "client_credentials",
    }).encode()
    request = urllib.request.Request(
        TOKEN_ENDPOINT, data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            payload = json.loads(response.read())
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:200]
        raise IcdApiError(
            f"The token endpoint refused the credentials ({error.code}): {detail}"
        ) from error
    except OSError as error:
        raise IcdApiError(f"Could not reach {TOKEN_ENDPOINT}: {error}") from error
    token = str(payload.get("access_token", ""))
    if not token:
        raise IcdApiError("The token endpoint answered without an access_token.")
    return token


def get(url: str, token: str, language: str) -> dict[str, Any] | None:
    """One API read. `None` means WHO does not have it; anything else raises."""
    request = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        # Both are mandatory on every ICD API call. v2 is the response shape this tool parses.
        "API-Version": "v2",
        "Accept-Language": language,
    })
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        if error.code == 401:
            raise IcdApiError("The API rejected the token (401). Re-run to obtain a fresh one.") from error
        raise IcdApiError(f"{url} failed with HTTP {error.code}.") from error
    except OSError as error:
        raise IcdApiError(f"{url} could not be reached: {error}") from error


def text_of(value: Any) -> str:
    """ICD-API v2 titles are language-tagged objects; some fields are plain strings."""
    if isinstance(value, dict):
        return str(value.get("@value", "")).strip()
    return str(value or "").strip()


def entity_id(uri: str) -> str:
    return uri.rstrip("/").rsplit("/", 1)[-1]


def release_id(uri: str) -> str:
    """The release id inside a release URI.

    WHO writes a release as `.../icd/release/11/2026-01/mms` — the id is the segment *before*
    the linearization, not the last one. Taking the last segment yields the literal string
    `mms`, and every URL built from it becomes `/mms/mms/…`, which the API answers with 404 on
    every single call. That is exactly what happened the first time this ran, and it looked
    like WHO rejecting all 32 candidate codes rather than like a malformed URL, which is why
    the parsing is a named function with a test rather than an inline `rsplit`.
    """
    parts = [part for part in uri.rstrip("/").split("/") if part]
    if len(parts) >= 2 and parts[-1] == LINEARIZATION:
        return parts[-2]
    return parts[-1] if parts else ""


def latest_release(token: str, language: str) -> str:
    payload = get(f"{API_ROOT}/icd/release/11/{LINEARIZATION}", token, language)
    if not payload:
        raise IcdApiError("WHO returned no linearization description for MMS.")
    release = str(payload.get("latestRelease", "")).strip()
    if release:
        return release_id(release)
    releases = [release_id(str(item)) for item in payload.get("release", []) if item]
    if not releases:
        raise IcdApiError("WHO listed no MMS releases.")
    return releases[0]


def read_entity(token: str, release: str, uri: str, language: str) -> dict[str, Any] | None:
    """Read a linearization entity by its URI, forced onto https."""
    url = uri.replace("http://", "https://", 1)
    if f"/release/11/{release}/" not in url:
        url = f"{API_ROOT}/icd/release/11/{release}/{LINEARIZATION}/{entity_id(url)}"
    return get(url, token, language)


def concept_from(entity: dict[str, Any], requested: str, purpose: str, icd10: str) -> dict[str, str]:
    return {
        "code": text_of(entity.get("code")) or requested,
        "display": text_of(entity.get("title")),
        "classKind": str(entity.get("classKind", "")),
        "uri": str(entity.get("@id", "")),
        "browserUrl": str(entity.get("browserUrl", "")),
        "purpose": purpose,
        "parallelsIcd10": icd10,
    }


def means_what_was_asked(title: str, expect: str) -> bool:
    """Does WHO's title for this code carry the concept the candidate asked for?

    A substring test, deliberately. Anything cleverer — token overlap, edit distance, a
    synonym table — would start accepting near misses, and a near miss here is the exact
    defect this guards against. A candidate with no `expect` is a candidate nobody has
    checked, so it fails: silence must not be assent when the subject is a diagnosis code.
    """
    if not expect:
        return False
    return expect.strip().lower() in title.strip().lower()


def verify(token: str, release: str, language: str, with_children: bool) -> dict[str, Any]:
    verified: list[dict[str, str]] = []
    rejected: list[dict[str, str]] = []
    seen: set[str] = set()
    base = f"{API_ROOT}/icd/release/11/{release}/{LINEARIZATION}"

    for candidate in CANDIDATES:
        code = candidate["code"]
        info = get(f"{base}/codeinfo/{urllib.parse.quote(code, safe='')}", token, language)
        if not info or not info.get("stemId"):
            rejected.append({
                "code": code,
                "purpose": candidate["purpose"],
                "reason": f"WHO's {release} MMS release has no code {code}. Left out rather than "
                          "corrected here: a diagnosis code this repository invented is worse than "
                          "a diagnosis code it lacks.",
            })
            continue
        entity = read_entity(token, release, str(info["stemId"]), language)
        if not entity:
            rejected.append({
                "code": code,
                "purpose": candidate["purpose"],
                "reason": f"codeinfo resolved {code} to {info['stemId']}, which the linearization "
                          "did not return.",
            })
            continue
        concept = concept_from(entity, code, candidate["purpose"], candidate["icd10"])
        # The code exists. Whether it means what was asked for is a separate question, and
        # the one that matters — see CANDIDATES for the nine that resolved to the wrong
        # concept when only existence was checked.
        if not means_what_was_asked(concept["display"], candidate.get("expect", "")):
            rejected.append({
                "code": code,
                "purpose": candidate["purpose"],
                "reason": f"{code} exists in WHO's {release} MMS release, but its title is "
                          f"\"{concept['display']}\", which does not contain "
                          f"\"{candidate.get('expect', '')}\". The code is real and means something "
                          "else. Left out: a valid code for the wrong concept is worse than no "
                          "code, because nothing downstream can detect it.",
            })
            continue
        if concept["code"] and concept["code"] not in seen:
            seen.add(concept["code"])
            verified.append(concept)
        if concept["code"] != code:
            # `codeinfo` answers with the stem for a postcoordinated or residual code. Recording
            # the difference keeps the candidate list honest about what it actually asked for.
            concept["requested"] = code

        if with_children:
            for child_uri in entity.get("child", []) or []:
                child = read_entity(token, release, str(child_uri), language)
                time.sleep(0.15)
                if not child:
                    continue
                child_code = text_of(child.get("code"))
                if not child_code or child_code in seen:
                    continue
                seen.add(child_code)
                verified.append(concept_from(
                    child, child_code,
                    f"Child of {concept['code']} ({concept['display']})",
                    candidate["icd10"],
                ))
        time.sleep(0.2)

    verified.sort(key=lambda row: row["code"])
    return {
        "source": f"{API_ROOT}/icd/release/11/{release}/{LINEARIZATION}",
        "api": "https://icd.who.int/icdapi",
        "system": ICD11_SYSTEM,
        "release": release,
        "language": language,
        "retrieved": date.today().isoformat(),
        "licence": "ICD-11 is published by WHO under CC BY-ND 3.0 IGO. Attribution is required "
                   "and derivative works are not permitted; this cache is an unmodified subset "
                   "of WHO's codes and titles.",
        "mappingNote": "WHO's ICD API exposes no ICD-10 to ICD-11 mapping endpoint, so no "
                       "ConceptMap between the revisions is generated. Each record states which "
                       "system its diagnosis code came from.",
        "candidates": len(CANDIDATES),
        "withChildren": with_children,
        "verified": verified,
        "rejected": rejected,
    }


def check() -> int:
    """Offline: is there a cache, and does it say what the seed builder needs?"""
    if not CACHE.exists():
        print(f"missing {CACHE.relative_to(REPOSITORY_ROOT)}; run tools/fetch_icd11.py with "
              "ICD_API_CLIENT_ID and ICD_API_CLIENT_SECRET set", file=sys.stderr)
        return 1
    cached = json.loads(CACHE.read_text(encoding="utf-8"))
    if cached.get("system") != ICD11_SYSTEM:
        print(f"{CACHE.relative_to(REPOSITORY_ROOT)} is not an ICD-11 MMS cache", file=sys.stderr)
        return 1
    missing = [row.get("code") for row in cached.get("verified", []) if not row.get("display")]
    if missing:
        print(f"{len(missing)} cached ICD-11 codes carry no WHO title: {missing[:5]}", file=sys.stderr)
        return 1
    print(f"ICD-11 cache: {len(cached['verified'])} codes verified against WHO release "
          f"{cached.get('release')}, {len(cached.get('rejected', []))} rejected, retrieved "
          f"{cached.get('retrieved')}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--release", default="", help="MMS release id, e.g. 2025-01; default is WHO's latest")
    parser.add_argument("--language", default="en", help="Accept-Language for WHO's titles")
    parser.add_argument("--children", action="store_true", help="also take one level of WHO's children")
    parser.add_argument("--check", action="store_true", help="offline: verify the committed cache")
    arguments = parser.parse_args()

    if arguments.check:
        return check()

    try:
        token = access_token()
        release = arguments.release.strip() or latest_release(token, arguments.language)
        payload = verify(token, release, arguments.language, arguments.children)
    except IcdApiError as error:
        print(str(error), file=sys.stderr)
        return 1

    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_text(json.dumps(payload, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {CACHE.relative_to(REPOSITORY_ROOT)}: {len(payload['verified'])} ICD-11 MMS codes "
          f"from WHO release {release}, {len(payload['rejected'])} candidates rejected")
    for row in payload["rejected"]:
        print(f"  rejected {row['code']} ({row['purpose']})")
    print("next: python3 tools/generate_terminology_seed.py && python3 tools/sync_shared.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
