#!/usr/bin/env python3
"""Derive every brand asset both products ship from the one supplied master.

Documentation and packaging tooling, not part of either product.

A country profile names **one** logo file, and both products must find it under that name:
the desktop renderer resolves it as ``./resources/<file>`` and the portal as
``static('img/<file>')``. Those are different folders, so a file present in one and absent
from the other renders on one product and 404s on the other — which is exactly what
happened when the profile was pointed at ``icmr_logo.png``. This script writes the same
filenames into both asset roots, so the profile can name a logo without knowing which
product is reading it.

Two variants are produced for every mark:

  ``<name>.png``        the mark as supplied, for light backgrounds
  ``<name>-light.png``  the same silhouette knocked out in white, for dark backgrounds

The knockout is a *reversal*, not a recolouring: the alpha channel is preserved exactly and
only the colour channels are replaced, so the mark's shape, proportions and clear space are
untouched. An identity guide that forbids reversal should supply its own reversed asset
instead; see ``branding.logo_reverse`` in the country profile.

    python3 tools/generate_brand_assets.py
    python3 tools/generate_brand_assets.py --check
"""

from __future__ import annotations

import argparse
import hashlib
import sys
from pathlib import Path

try:
    from PIL import Image, ImageChops
except ModuleNotFoundError:  # pragma: no cover - guidance, not logic
    sys.exit("Pillow is required: pip install Pillow")

ROOT = Path(__file__).resolve().parent.parent

# Where a country profile's `logo` is looked up, per product. Both get identical bytes.
ASSET_ROOTS = (
    ROOT / "app" / "src" / "renderer" / "public" / "resources",
    ROOT / "server" / "amrit_central_server" / "central" / "static" / "img",
)

# The supplied ICMR master: emblem and wordmark locked up together on a square white canvas.
# Never written to. The brand implementation note promises the supplied asset is carried
# byte-for-byte, and a generator that overwrites its own input would break that promise and
# derive the next run's output from the previous run's output.
MASTER = ROOT / "app" / "resources" / "icmr-logo.png"

# The packaged desktop application's OS icon lives outside the renderer bundle, and is a
# separate file from the master for the reason above.
APP_ICON_PATH = ROOT / "app" / "resources" / "icmr-appicon.png"

EMBLEM = "icmr-emblem"


def _trim_to_content(image: Image.Image) -> Image.Image:
    """Crop away a flat margin, whether it is transparent or opaque white.

    The supplied master is a 512x512 canvas whose artwork occupies only the top 224 rows,
    fully opaque. Anything sizing it with `object-contain` therefore renders the artwork at
    44% of the box and centres the emptiness — which is why the portal header showed a mark
    a third of its intended size.
    """
    rgba = image.convert("RGBA")
    box = rgba.getchannel("A").getbbox()
    if box is None or box == (0, 0, *rgba.size):
        white = Image.new("RGB", rgba.size, (255, 255, 255))
        box = ImageChops.difference(rgba.convert("RGB"), white).convert("L").getbbox()
    return rgba.crop(box) if box else rgba


def _ink_alpha(image: Image.Image) -> Image.Image:
    """An alpha channel describing where the ink is, for a mark printed on flat white.

    The supplied master carries no transparency at all — every pixel is opaque, the
    background included. Reversing it by replacing the colour channels alone therefore
    produces an opaque white rectangle, which is precisely what appeared in the sidebar the
    first time this ran.

    So the coverage has to be recovered from the artwork: how far each pixel is from the
    white it was printed on, rescaled so the darkest ink is fully opaque. Anti-aliased edges
    keep their partial coverage, which is what stops the reversed mark looking cut out with
    scissors.
    """
    rgba = image.convert("RGBA")
    red, green, blue, existing = rgba.split()
    # Distance from white measured on the *least* bright channel, not on luminance. The ICMR
    # lockup is navy and orange, and orange is bright: judged by luminance its tagline would
    # come out half transparent and the mark would print two different weights.
    darkest_channel = ImageChops.darker(ImageChops.darker(red, green), blue)
    floor = darkest_channel.getextrema()[0]
    if floor >= 255:  # a blank image; nothing to recover
        return existing
    span = 255 - floor
    coverage = darkest_channel.point(lambda value: min(255, round((255 - value) * 255 / span)))
    # Where the master *does* carry transparency, honour it: a pixel that was never drawn
    # cannot become ink.
    return ImageChops.multiply(coverage, existing)


def _with_ink_alpha(image: Image.Image) -> Image.Image:
    """The mark in its own colours, lifted off the white it was printed on.

    Simply attaching the coverage to the original pixels would darken every soft edge, since
    those pixels are already part white. Undoing the composite — recovering C from
    `printed = C·a + 255·(1-a)` — puts the mark's true colours back, so it looks the same on
    a white header and on a coloured one.
    """
    rgba = image.convert("RGBA")
    alpha = _ink_alpha(image)
    alpha_values = alpha.load()
    source = rgba.load()
    out = Image.new("RGBA", rgba.size)
    target = out.load()
    for y in range(rgba.height):
        for x in range(rgba.width):
            a = alpha_values[x, y]
            if a == 0:
                continue
            r, g, b, _ = source[x, y]
            scale = a / 255
            target[x, y] = (
                min(255, max(0, round((r - 255 * (1 - scale)) / scale))),
                min(255, max(0, round((g - 255 * (1 - scale)) / scale))),
                min(255, max(0, round((b - 255 * (1 - scale)) / scale))),
                a,
            )
    return out


def _reverse(image: Image.Image) -> Image.Image:
    """White knockout: every pixel white, opacity taken from the ink coverage.

    A reversal, not a recolouring — the silhouette, its proportions and its clear space are
    the mark's own, and only the ink's colour changes so it can be read on a dark ground.
    """
    knockout = Image.new("RGBA", image.size, (255, 255, 255, 0))
    knockout.putalpha(_ink_alpha(image))
    return knockout


def _square(image: Image.Image, size: int, background: tuple[int, int, int, int]) -> Image.Image:
    """Centre a mark on a square canvas with the clear space the identity guide requires.

    The guide's protection rule is expressed as a margin proportional to the mark, so the
    artwork is inset by a tenth of the canvas on every side rather than by a fixed count of
    pixels that would change meaning with the output size.
    """
    inset = round(size * 0.1)
    inner = size - inset * 2
    mark = image.copy()
    mark.thumbnail((inner, inner), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), background)
    canvas.alpha_composite(mark, ((size - mark.width) // 2, (size - mark.height) // 2))
    return canvas


def _emblem_from(master: Image.Image) -> Image.Image:
    """The circular emblem alone, taken from the left of the supplied lockup.

    The lockup places the roundel to the left of the wordmark. Cutting at the artwork's own
    height keeps the circle whole and takes nothing of the type, so no measurement of this
    particular file is baked in beyond "the emblem is as wide as it is tall".
    """
    art = _trim_to_content(master)
    return _trim_to_content(art.crop((0, 0, min(art.height, art.width), art.height)))


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16]


def build(check: bool) -> int:
    if not MASTER.exists():
        sys.exit(f"supplied master not found: {MASTER}")
    master = Image.open(MASTER)

    emblem = _emblem_from(master)
    lockup = _trim_to_content(master)
    outputs: dict[str, Image.Image] = {
        f"{EMBLEM}.png": _square(_with_ink_alpha(emblem), 256, (255, 255, 255, 0)),
        f"{EMBLEM}-light.png": _square(_reverse(emblem), 256, (255, 255, 255, 0)),
        "icmr-lockup.png": _with_ink_alpha(lockup),
        "icmr-lockup-light.png": _reverse(lockup),
    }

    drift: list[str] = []
    for root in ASSET_ROOTS:
        root.mkdir(parents=True, exist_ok=True)
        for name, image in outputs.items():
            path = root / name
            before = _digest(path) if path.exists() else None
            if check:
                if before is None:
                    drift.append(f"missing: {path.relative_to(ROOT)}")
                continue
            image.save(path, "PNG", optimize=True)
            after = _digest(path)
            state = "unchanged" if before == after else "written"
            print(f"{state:>9}  {path.relative_to(ROOT)}  {image.width}x{image.height}")

    if not check:
        # electron-builder wants an opaque square; a transparent icon renders as a hole in
        # several Linux docks and as a black square in some Windows shells.
        icon = _square(emblem, 512, (255, 255, 255, 255))
        icon.save(APP_ICON_PATH, "PNG", optimize=True)
        print(f"  written  {APP_ICON_PATH.relative_to(ROOT)}  512x512  (opaque, OS icon)")

    if drift:
        print("\n".join(drift), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail if an asset is missing rather than writing it")
    raise SystemExit(build(parser.parse_args().check))
