"""Every mark a shipped country profile names must exist under the portal's static root.

``central.context._logo_source`` turns ``branding.logo`` into ``static('img/<file>')`` and
swallows any failure, so a profile naming a file this product does not carry renders as an
empty header rather than an error. The desktop application resolves the same field against a
different folder, which is how a profile came to name a file only one of the two products
had. Neither resolver can catch that; this test can.
"""

from __future__ import annotations

import json
from pathlib import Path

from django.test import SimpleTestCase

PROFILE_DIR = Path(__file__).resolve().parent.parent / "shared" / "country-profiles"
STATIC_IMG = Path(__file__).resolve().parent / "static" / "img"


def _shipped_profiles() -> list[tuple[str, dict]]:
    return [
        (path.name, json.loads(path.read_text(encoding="utf-8")))
        for path in sorted(PROFILE_DIR.glob("*.json"))
        if path.name != "profile.schema.json"
    ]


def _bundled_marks(branding: dict) -> list[str]:
    """Filenames only. An uploaded mark is a data URI and is not looked up on disk."""
    marks = [branding.get("logo"), branding.get("logo_reverse")]
    return [mark for mark in marks if isinstance(mark, str) and mark and not mark.startswith("data:")]


class BrandingAssetsTests(SimpleTestCase):
    def test_every_mark_a_shipped_profile_names_is_present(self):
        missing = [
            f"{name}: {mark}"
            for name, profile in _shipped_profiles()
            for mark in _bundled_marks(profile.get("branding") or {})
            if not (STATIC_IMG / mark).is_file()
        ]
        self.assertEqual(missing, [])

    def test_india_names_the_emblem_and_its_reversed_variant(self):
        india = json.loads((PROFILE_DIR / "IN.json").read_text(encoding="utf-8"))
        self.assertEqual(india["branding"]["logo"], "icmr-emblem.png")
        self.assertEqual(india["branding"]["logo_reverse"], "icmr-emblem-light.png")
