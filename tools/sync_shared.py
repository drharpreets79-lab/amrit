#!/usr/bin/env python3
"""Vendor shared/ into each product so both can be distributed independently.

app/ and server/ are shipped separately and must never reference each other, or reach
outside their own folder at runtime. Anything they genuinely share lives in shared/ and
is copied into each product by this script.

Usage:
    python3 tools/sync_shared.py           # copy shared/ into every product
    python3 tools/sync_shared.py --check   # verify copies match; exit 1 on drift (CI gate)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
SHARED_ROOT = REPOSITORY_ROOT / "shared"

# Where each product expects its vendored copy.
TARGETS = (
    REPOSITORY_ROOT / "app" / "resources" / "shared",
    REPOSITORY_ROOT / "server" / "amrit_central_server" / "shared",
)

MANIFEST_NAME = ".shared-manifest.json"
EXCLUDED_NAMES = {".DS_Store", "__pycache__", MANIFEST_NAME}


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_files() -> list[Path]:
    """Every file under shared/, sorted, excluding noise."""
    files = [
        path
        for path in SHARED_ROOT.rglob("*")
        if path.is_file() and not any(part in EXCLUDED_NAMES for part in path.parts)
    ]
    return sorted(files)


def build_manifest() -> dict[str, object]:
    version = (SHARED_ROOT / "VERSION").read_text(encoding="utf-8").strip()
    return {
        "contract_version": version,
        "generated_by": "tools/sync_shared.py",
        "files": {
            path.relative_to(SHARED_ROOT).as_posix(): sha256_file(path)
            for path in source_files()
        },
    }


def sync(target: Path, manifest: dict[str, object]) -> None:
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True, exist_ok=True)
    for relative in manifest["files"]:
        destination = target / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SHARED_ROOT / relative, destination)
    (target / MANIFEST_NAME).write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


def check(target: Path, manifest: dict[str, object]) -> list[str]:
    """Return a list of human-readable drift descriptions; empty means in sync."""
    problems: list[str] = []
    if not target.is_dir():
        return [f"{target.relative_to(REPOSITORY_ROOT)} is missing — run tools/sync_shared.py"]

    expected: dict[str, str] = manifest["files"]  # type: ignore[assignment]
    for relative, digest in expected.items():
        candidate = target / relative
        if not candidate.is_file():
            problems.append(f"missing: {target.relative_to(REPOSITORY_ROOT)}/{relative}")
        elif sha256_file(candidate) != digest:
            problems.append(f"content differs: {target.relative_to(REPOSITORY_ROOT)}/{relative}")

    present = {
        path.relative_to(target).as_posix()
        for path in target.rglob("*")
        if path.is_file() and not any(part in EXCLUDED_NAMES for part in path.parts)
    }
    for extra in sorted(present - set(expected)):
        problems.append(f"unexpected file: {target.relative_to(REPOSITORY_ROOT)}/{extra}")

    manifest_path = target / MANIFEST_NAME
    if not manifest_path.is_file():
        problems.append(f"missing manifest: {target.relative_to(REPOSITORY_ROOT)}/{MANIFEST_NAME}")
    else:
        vendored = json.loads(manifest_path.read_text(encoding="utf-8"))
        if vendored.get("contract_version") != manifest["contract_version"]:
            problems.append(
                f"contract version drift in {target.relative_to(REPOSITORY_ROOT)}: "
                f"{vendored.get('contract_version')!r} != {manifest['contract_version']!r}"
            )
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify vendored copies match shared/ without writing anything",
    )
    args = parser.parse_args()

    if not SHARED_ROOT.is_dir():
        print(f"error: {SHARED_ROOT} does not exist", file=sys.stderr)
        return 2

    manifest = build_manifest()

    if args.check:
        problems = [problem for target in TARGETS for problem in check(target, manifest)]
        if problems:
            print("shared/ vendoring is out of sync:", file=sys.stderr)
            for problem in problems:
                print(f"  - {problem}", file=sys.stderr)
            print("\nrun: python3 tools/sync_shared.py", file=sys.stderr)
            return 1
        print(
            f"shared/ in sync across {len(TARGETS)} products "
            f"({len(manifest['files'])} files, contract {manifest['contract_version']})"
        )
        return 0

    for target in TARGETS:
        sync(target, manifest)
        print(f"synced {len(manifest['files'])} files -> {target.relative_to(REPOSITORY_ROOT)}")
    print(f"contract version {manifest['contract_version']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
