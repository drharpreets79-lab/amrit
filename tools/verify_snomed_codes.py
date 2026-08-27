#!/usr/bin/env python3
"""Check the SNOMED CT codes the WHONET catalogue carries against a terminology server.

Phase 22, SNOMED arm. The catalogue asserts a SNOMED concept for 2,099 of its 2,380 organisms
and 3 of its 8 specimen groups. Nothing in this repository has ever checked one: a code that
was mistyped, retired, or belongs to a different concept looks exactly like a correct one, and
AMRIT emits it on every organism observation.

This is the same check `generate_terminology_seed.py` runs on the ICD-10 starter set, where it
found `U88` — a code that ships and does not exist. Running it against SNOMED is how the same
class of defect gets found here rather than by a receiver.

## What this tool does and does not put in the seed

It records, per code: whether the server resolves it, and the fully specified name the server
returns. **The names are written to a separate file and are not bundled by default.** SNOMED CT
descriptions are licensed content: free to use in a Member country (India is one) and requiring
an affiliate licence elsewhere, which is why `code_systems.snomed.enabled` has gated SNOMED
since Phase 10. `--include-displays` writes them for a deployment that holds a licence and wants
them; without it the file carries validity and nothing else, which is a fact about the
catalogue rather than a copy of SNOMED.

    python3 tools/verify_snomed_codes.py                     # validity only
    python3 tools/verify_snomed_codes.py --include-displays   # validity + FSN (licensed use)
    python3 tools/verify_snomed_codes.py --limit 50           # a sample, for a quick check
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path
from typing import Any

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
CATALOGUE = REPOSITORY_ROOT / "app" / "resources" / "catalog-seed.v2.json"
OUTPUT = REPOSITORY_ROOT / "shared" / "terminology" / "snomed-catalogue.verified.json"

TERMINOLOGY_SERVER = "https://tx.fhir.org/r4"
SNOMED = "http://snomed.info/sct"


def lookup(code: str, timeout: int = 60) -> tuple[bool, str, str]:
    """Resolve one concept. Returns (found, display, reason)."""
    url = (f"{TERMINOLOGY_SERVER}/CodeSystem/$lookup?system={urllib.parse.quote(SNOMED)}"
           f"&code={urllib.parse.quote(code)}")
    request = urllib.request.Request(url, headers={"Accept": "application/fhir+json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read())
    except urllib.error.HTTPError as error:
        try:
            body = json.loads(error.read())
            reason = (body.get("issue") or [{}])[0].get("diagnostics", str(error))
        except Exception:  # noqa: BLE001 - the HTTP status is the fallback reason
            reason = str(error)
        return False, "", str(reason)[:300]
    except Exception as error:  # noqa: BLE001
        return False, "", f"lookup failed: {error}"
    if payload.get("resourceType") != "Parameters":
        diagnostics = (payload.get("issue") or [{}])[0].get("diagnostics", "not found")
        return False, "", str(diagnostics)[:300]
    display = next(
        (item.get("valueString", "") for item in payload.get("parameter", []) if item.get("name") == "display"),
        "",
    )
    return True, display, ""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--include-displays", action="store_true",
                        help="record the fully specified names (licensed SNOMED content)")
    parser.add_argument("--limit", type=int, default=0, help="check only the first N codes")
    parser.add_argument("--delay", type=float, default=0.15, help="seconds between requests")
    arguments = parser.parse_args()

    catalogue = json.loads(CATALOGUE.read_text(encoding="utf-8"))["catalogue"]
    targets: list[dict[str, str]] = []
    for row in catalogue["organisms"]:
        code = str(row.get("snomed_code") or "").strip()
        if code:
            targets.append({"kind": "organism", "local": str(row.get("code", "")),
                            "localName": str(row.get("organism_name", "")), "snomed": code})
    for row in catalogue["samples"]:
        code = str(row.get("concept_code") or "").strip()
        if code and str(row.get("system", "")) == SNOMED:
            targets.append({"kind": "specimen", "local": str(row.get("code", "")),
                            "localName": str(row.get("name", "")), "snomed": code})
    if arguments.limit:
        targets = targets[: arguments.limit]

    verified: list[dict[str, str]] = []
    rejected: list[dict[str, str]] = []
    # One request per distinct concept: the catalogue reuses concepts across rows, and paying
    # for the same lookup twice is the difference between seven minutes and fourteen.
    seen: dict[str, tuple[bool, str, str]] = {}
    for index, target in enumerate(targets, start=1):
        code = target["snomed"]
        if code not in seen:
            seen[code] = lookup(code)
            time.sleep(arguments.delay)
        found, display, reason = seen[code]
        row = {"kind": target["kind"], "local": target["local"], "snomed": code}
        if found:
            if arguments.include_displays:
                row["display"] = display
                row["localName"] = target["localName"]
            verified.append(row)
        else:
            rejected.append({**row, "localName": target["localName"], "reason": reason})
        if index % 100 == 0:
            print(f"  {index}/{len(targets)} ({len(rejected)} rejected)", flush=True)

    payload = {
        "source": TERMINOLOGY_SERVER,
        "system": SNOMED,
        "retrieved": date.today().isoformat(),
        "checked": len(targets),
        "distinctConcepts": len(seen),
        "displaysIncluded": bool(arguments.include_displays),
        "licenceNote": (
            "SNOMED CT is licensed content. Free to use in a SNOMED International Member country "
            "or territory (India is one); an affiliate licence is required elsewhere. This file "
            "records which of the catalogue's codes resolve; descriptions are present only when "
            "the tool was run with --include-displays, and a deployment that redistributes them "
            "needs its own licence position."
        ),
        "verified": verified,
        "rejected": rejected,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(payload, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{len(verified)} of {len(targets)} catalogue SNOMED references resolve; "
          f"{len(rejected)} do not -> {OUTPUT.relative_to(REPOSITORY_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
