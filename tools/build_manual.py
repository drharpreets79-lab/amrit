#!/usr/bin/env python3
"""Build the operator manual as a branded PDF and DOCX.

Documentation tooling, not part of either product.

`docs/manual/README.md` is the single source. Everything that makes the output *look* like a
particular organisation's document — the emblem, the authority's name, the product's name,
the three brand colours — is read from the deployment's country profile, exactly as the two
products read it. Building under `IN` produces the ICMR-branded manual; building under
`TESTLAND` produces Testland's. No country's identity is compiled into the template, for the
same reason none is compiled into the portal chrome.

    python3 tools/build_manual.py                       # the configured profile, or IN
    AMRIT_COUNTRY_PROFILE=TESTLAND python3 tools/build_manual.py
    python3 tools/build_manual.py --html-only           # inspect the intermediate HTML

Requires `pandoc` on PATH. The PDF is rendered by the Electron already pinned in `app/`, so
a machine that can build the desktop application can build the manual; there is no LaTeX,
no Pango and no second toolchain to keep in step.
"""

from __future__ import annotations

import argparse
import base64
import html
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import zipfile
from datetime import date
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent


def _shown(path: Path) -> str:
    """A path relative to the repository when it is inside it, absolute when it is not."""
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


MANUAL_DIR = ROOT / "docs" / "manual"
SOURCE = MANUAL_DIR / "README.md"
PROFILE_DIR = ROOT / "shared" / "country-profiles"
ASSET_DIR = ROOT / "app" / "src" / "renderer" / "public" / "resources"
ELECTRON = ROOT / "app" / "node_modules" / ".bin" / "electron"
RENDERER = ROOT / "tools" / "manual" / "render_pdf.mjs"

# Fallbacks used when a profile leaves a colour unset. The palette is a property of the
# deployment, so these are only ever the last resort.
DEFAULT_COLOURS = {"navy": "#23376D", "blue": "#1B75BC", "orange": "#F15A29"}


def load_profile(country: str) -> dict[str, Any]:
    """The country profile, by curated id or ISO code, falling back to `_default`."""
    for candidate in (country, country.upper(), "_default"):
        path = PROFILE_DIR / f"{candidate}.json"
        if path.is_file():
            return json.loads(path.read_text(encoding="utf-8"))
    raise SystemExit(f"no country profile found for {country!r}")


def data_uri(path: Path) -> str:
    """Inline an asset so the intermediate HTML renders identically from anywhere."""
    kind = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return f"data:{kind};base64,{base64.b64encode(path.read_bytes()).decode('ascii')}"


def pandoc(*arguments: str, stdin: str | None = None) -> str:
    result = subprocess.run(
        ["pandoc", *arguments],
        input=stdin,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise SystemExit(f"pandoc failed: {result.stderr.strip()}")
    return result.stdout


def stylesheet(colours: dict[str, str]) -> str:
    """Page furniture and typography, in the deployment's own colours.

    Gotham is the identity guide's typeface and is proprietary, so it is *used* when the
    machine has a licensed copy installed and never bundled. Calibri is the guide's own
    stated fallback; after that the platform's default.
    """
    navy = colours["navy"]
    blue = colours["blue"]
    orange = colours["orange"]
    return f"""
:root {{
  --navy: {navy};
  --blue: {blue};
  --orange: {orange};
  --ink: #1d2939;
  --muted: #5b6779;
  --line: #d7dde7;
  --wash: #f4f7fb;
}}

@page {{ size: A4; }}

html {{ font-size: 10.5pt; }}
body {{
  margin: 0;
  color: var(--ink);
  font-family: Gotham, "Gotham Light", Calibri, "Segoe UI", system-ui, sans-serif;
  font-weight: 300;
  line-height: 1.5;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}}

/* Cover.
   Chromium prints its header and footer on every page including the first, so the cover
   paints its own full-bleed ground over them rather than trying to switch them off. */
.cover {{
  position: relative;
  display: flex;
  height: 228mm;
  flex-direction: column;
  justify-content: space-between;
  padding: 24mm 4mm 0;
  page-break-after: always;
  background: #fff;
}}
.cover__rule {{ height: 5px; background: linear-gradient(90deg, var(--navy) 0 62%, var(--orange) 62% 100%); }}
.cover__emblem {{ width: 30mm; height: auto; margin-bottom: 14mm; }}
.cover__authority {{ margin: 0 0 2mm; color: var(--navy); font-size: 12pt; font-weight: 600; letter-spacing: .02em; }}
.cover__product {{ margin: 0; color: var(--navy); font-family: Gotham, "Gotham Black", Calibri, system-ui, sans-serif; font-size: 34pt; font-weight: 800; line-height: 1.05; letter-spacing: -.01em; }}
.cover__title {{ margin: 4mm 0 0; color: var(--ink); font-size: 19pt; font-weight: 400; }}
.cover__standfirst {{ max-width: 118mm; margin: 8mm 0 0; color: var(--muted); font-size: 11pt; line-height: 1.6; }}
.cover__meta {{ display: flex; justify-content: space-between; padding: 6mm 0; border-top: 1px solid var(--line); color: var(--muted); font-size: 9pt; }}
.cover__meta strong {{ display: block; color: var(--navy); font-size: 10pt; font-weight: 600; }}

/* Headings. The orange rule under a section number is the guide's accent, used once per
   level so it marks structure rather than decorating every line. */
h1, h2, h3, h4 {{
  color: var(--navy);
  font-family: Gotham, "Gotham Medium", Calibri, system-ui, sans-serif;
  font-weight: 700;
  page-break-after: avoid;
}}
/* The source's numbered sections are `##`, so h2 is the one that opens a page and carries
   the accent rule. h1 exists only on the cover and the contents page. */
h1 {{ margin: 0 0 6mm; padding-bottom: 3mm; border-bottom: 3px solid var(--orange); font-size: 20pt; }}
h2 {{ margin: 0 0 5mm; padding-bottom: 2.6mm; border-bottom: 3px solid var(--orange); font-size: 17pt; page-break-before: always; }}
h2:first-of-type {{ margin-top: 8mm; page-break-before: avoid; }}
h3 {{ margin: 8mm 0 2.5mm; color: var(--blue); font-size: 12pt; }}
h4 {{ margin: 5mm 0 2mm; font-size: 10.5pt; }}
p {{ margin: 0 0 3.4mm; orphans: 3; widows: 3; }}
strong {{ font-weight: 600; }}
a {{ color: var(--blue); text-decoration: none; }}

ul, ol {{ margin: 0 0 3.4mm; padding-left: 6mm; }}
li {{ margin-bottom: 1.4mm; }}

/* Contents */
.contents {{ page-break-after: always; }}
.contents h1 {{ page-break-before: avoid; }}
.contents ol {{ padding-left: 0; list-style: none; counter-reset: section; }}
.contents li {{ margin: 0; padding: 2mm 0; border-bottom: 1px dotted var(--line); counter-increment: section; }}
.contents li::before {{ display: inline-block; width: 9mm; color: var(--orange); content: counter(section) "."; font-weight: 700; }}
.contents a {{ color: var(--navy); font-weight: 600; }}

/* Tables. Ruled rows only: the guide's grids are open, not boxed. */
table {{ width: 100%; margin: 0 0 5mm; border-collapse: collapse; font-size: 9.5pt; page-break-inside: avoid; }}
thead th {{ padding: 2.4mm 2.6mm; border-bottom: 2px solid var(--navy); color: var(--navy); font-weight: 700; text-align: left; }}
tbody td {{ padding: 2.4mm 2.6mm; border-bottom: 1px solid var(--line); vertical-align: top; }}
tbody tr:nth-child(even) {{ background: var(--wash); }}

/* Screenshots. Every one is the real software, so each is framed and captioned as evidence
   rather than dropped into the flow as decoration. */
figure {{ margin: 5mm 0 6mm; page-break-inside: avoid; }}
img {{ max-width: 100%; height: auto; border: 1px solid var(--line); border-radius: 3px; }}
/* The emblem is artwork, not evidence: no frame. */
.cover__emblem {{ border: 0; border-radius: 0; }}
figcaption {{ margin-top: 2mm; padding-left: 2mm; border-left: 3px solid var(--orange); color: var(--muted); font-size: 8.5pt; font-style: normal; }}

pre {{ padding: 3mm 3.5mm; border-left: 3px solid var(--blue); background: var(--wash); font-size: 8.5pt; line-height: 1.45; page-break-inside: avoid; white-space: pre-wrap; }}
code {{ font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace; font-size: .92em; }}
p code, li code, td code {{ padding: .5mm 1mm; border-radius: 2px; background: var(--wash); color: var(--navy); }}
blockquote {{ margin: 0 0 4mm; padding: 2mm 0 2mm 4mm; border-left: 3px solid var(--orange); color: var(--muted); }}
hr {{ height: 1px; margin: 7mm 0; border: 0; background: var(--line); }}
"""


def header_template(profile: dict[str, Any], emblem: str | None) -> str:
    """The running header: the emblem and who this document belongs to.

    Chromium renders these templates in an isolated context with no access to the page's
    own stylesheet, so every rule here is inline and every length is in points.
    """
    branding = profile.get("branding") or {}
    authority = html.escape(str(branding.get("authority_name") or profile.get("country_name") or ""))
    product = html.escape(str(branding.get("product_name") or "AMRIT"))
    colours = {**DEFAULT_COLOURS, **(branding.get("colors") or {})}
    mark = f'<img src="{emblem}" style="height:13px;width:auto;margin-right:6px;vertical-align:middle">' if emblem else ""
    return (
        f'<div style="width:100%;font-size:7pt;color:{colours["navy"]};'
        f'font-family:Calibri,system-ui,sans-serif;padding:0 14mm;'
        f'display:flex;align-items:center;justify-content:space-between;">'
        f'<span style="display:flex;align-items:center;">{mark}<strong>{product}</strong></span>'
        f'<span style="color:#5b6779;">{authority}</span>'
        f"</div>"
    )


def footer_template(profile: dict[str, Any]) -> str:
    branding = profile.get("branding") or {}
    colours = {**DEFAULT_COLOURS, **(branding.get("colors") or {})}
    return (
        f'<div style="width:100%;font-size:7pt;color:#5b6779;'
        f'font-family:Calibri,system-ui,sans-serif;padding:0 14mm;'
        f'display:flex;align-items:center;justify-content:space-between;'
        f'border-top:1px solid #d7dde7;padding-top:3px;">'
        f'<span>Operator manual</span>'
        f'<span style="color:{colours["navy"]};font-weight:600;">'
        f'<span class="pageNumber"></span> / <span class="totalPages"></span></span>'
        f"</div>"
    )


def cover(profile: dict[str, Any], emblem: str | None) -> str:
    branding = profile.get("branding") or {}
    product = html.escape(str(branding.get("product_name") or "AMRIT"))
    authority = html.escape(str(branding.get("authority_name") or ""))
    country = html.escape(str(profile.get("country_name") or ""))
    version = (ROOT / "shared" / "VERSION").read_text(encoding="utf-8").strip()
    mark = f'<img class="cover__emblem" src="{emblem}" alt="">' if emblem else ""
    return f"""<section class="cover">
  <div>
    {mark}
    <p class="cover__authority">{authority}</p>
    <h1 class="cover__product" style="border:0;padding:0;">{product}</h1>
    <p class="cover__title">Operator manual</p>
    <p class="cover__standfirst">One system, two programs. A laboratory runs the desktop
    application; a country runs the central server. Between them travels nothing but
    aggregate numbers. Every screenshot in this manual is the real software, captured from a
    running installation.</p>
  </div>
  <div>
    <div class="cover__meta">
      <span><strong>Deployment</strong>{country}</span>
      <span><strong>Contract version</strong>{html.escape(version)}</span>
      <span><strong>Issued</strong>{date.today().isoformat()}</span>
    </div>
    <div class="cover__rule"></div>
  </div>
</section>"""


def contents(body: str) -> str:
    """A contents page built from the document's own numbered sections.

    Taken from the rendered headings rather than from pandoc's `--toc` so it can be styled
    as a page of the manual instead of a bulleted list, and so the numbers stay the ones the
    author wrote.
    """
    entries = re.findall(r'<h2 id="([^"]+)"[^>]*>\s*(\d+)\.\s*([^<]+)', body)
    if not entries:
        return ""
    items = "\n".join(
        f'    <li><a href="#{identifier}">{title.strip()}</a></li>'
        for identifier, _number, title in entries
    )
    return f'<section class="contents">\n  <h1>Contents</h1>\n  <ol>\n{items}\n  </ol>\n</section>'


def build_html(profile: dict[str, Any], emblem: str | None) -> str:
    # `--embed-resources` inlines the screenshots, so the intermediate file is one
    # self-contained document and the PDF renderer needs no base directory.
    body = pandoc(
        "--from", "gfm",
        "--to", "html5",
        "--embed-resources",
        "--standalone" if False else "--wrap=none",
        "--resource-path", str(MANUAL_DIR),
        str(SOURCE),
    )
    # The source opens with its own title and a hand-written contents list. The cover
    # replaces the title and a generated page replaces the list, which also means the
    # contents can never drift from the sections that actually exist.
    body = re.sub(r'<h1 id="[^"]*">.*?</h1>\s*', "", body, count=1, flags=re.S)
    body = re.sub(r'(<hr\s*/?>\s*)?<h2 id="contents">.*?</ol>\s*', "", body, count=1, flags=re.S)
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{html.escape(str((profile.get('branding') or {}).get('product_name') or 'AMRIT'))} — operator manual</title>
<style>{stylesheet({**DEFAULT_COLOURS, **((profile.get('branding') or {}).get('colors') or {})})}</style>
</head>
<body>
{cover(profile, emblem)}
{contents(body)}
{body}
</body>
</html>"""


def brand_reference_docx(profile: dict[str, Any], target: Path) -> Path:
    """Pandoc's reference document, restyled in the deployment's colours.

    Pandoc styles a DOCX from a reference file rather than from CSS. Rather than carry a
    binary template in the repository — which nobody could review and which would freeze one
    country's palette into the build — the default is taken from pandoc itself and its
    `styles.xml` is rewritten for this profile on every build.
    """
    colours = {**DEFAULT_COLOURS, **((profile.get("branding") or {}).get("colors") or {})}
    navy = colours["navy"].lstrip("#").upper()
    blue = colours["blue"].lstrip("#").upper()

    default = subprocess.run(
        ["pandoc", "--print-default-data-file", "reference.docx"],
        capture_output=True, check=True,
    ).stdout
    scratch = target.with_suffix(".source.docx")
    scratch.write_bytes(default)

    with zipfile.ZipFile(scratch) as source:
        names = source.namelist()
        contents = {name: source.read(name) for name in names}

    styles = contents["word/styles.xml"].decode("utf-8")
    # Heading colours, and the body typeface stack the identity guide asks for. Gotham is
    # proprietary and is therefore named, not embedded: Word uses it where it is installed
    # and falls back to Calibri, which is the guide's own stated fallback.
    styles = re.sub(r'<w:color w:val="[0-9A-Fa-f]{6}"/>', f'<w:color w:val="{navy}"/>', styles)
    styles = styles.replace('w:ascii="Cambria"', 'w:ascii="Gotham"').replace('w:hAnsi="Cambria"', 'w:hAnsi="Gotham"')
    styles = styles.replace('w:ascii="Calibri"', 'w:ascii="Gotham"').replace('w:hAnsi="Calibri"', 'w:hAnsi="Gotham"')
    # Third-level headings take the secondary colour, so the hierarchy is visible at a glance
    # rather than three shades of one navy.
    styles = re.sub(
        r'(<w:style [^>]*w:styleId="Heading3".*?)<w:color w:val="[0-9A-Fa-f]{6}"/>',
        rf'\1<w:color w:val="{blue}"/>',
        styles,
        flags=re.S,
    )
    contents["word/styles.xml"] = styles.encode("utf-8")

    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as out:
        for name in names:
            out.writestr(name, contents[name])
    scratch.unlink(missing_ok=True)
    return target


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--country", default=os.environ.get("AMRIT_COUNTRY_PROFILE", "IN"))
    parser.add_argument("--html-only", action="store_true", help="write the intermediate HTML and stop")
    parser.add_argument("--out", type=Path, default=MANUAL_DIR)
    arguments = parser.parse_args()

    if not shutil.which("pandoc"):
        raise SystemExit("pandoc is required: brew install pandoc")
    if not SOURCE.is_file():
        raise SystemExit(f"manual source not found: {SOURCE}")

    profile = load_profile(arguments.country)
    branding = profile.get("branding") or {}
    logo = str(branding.get("logo") or "").strip()
    emblem = None
    if logo.startswith("data:"):
        emblem = logo
    elif logo and (ASSET_DIR / logo).is_file():
        emblem = data_uri(ASSET_DIR / logo)
    elif logo:
        print(f"note: profile names {logo}, which is not in {_shown(ASSET_DIR)}; building without an emblem")

    arguments.out.mkdir(parents=True, exist_ok=True)
    document = build_html(profile, emblem)
    # The intermediate carries every screenshot inline and runs to tens of megabytes. It is
    # a build artifact, not a deliverable, so it is kept only when asked for and removed
    # once the PDF has been rendered from it.
    html_path = arguments.out / ("AMRIT-operator-manual.html" if arguments.html_only else ".manual-intermediate.html")
    html_path.write_text(document, encoding="utf-8")
    if arguments.html_only:
        print(f"wrote {_shown(html_path)}")
        return 0

    pdf_path = arguments.out / "AMRIT-operator-manual.pdf"
    if not ELECTRON.is_file():
        raise SystemExit(f"electron not found at {ELECTRON}; run pnpm install in app/")
    result = subprocess.run(
        [str(ELECTRON), str(RENDERER)],
        env={
            **os.environ,
            "AMRIT_MANUAL_HTML": str(html_path),
            "AMRIT_MANUAL_PDF": str(pdf_path),
            "AMRIT_MANUAL_HEADER": header_template(profile, emblem),
            "AMRIT_MANUAL_FOOTER": footer_template(profile),
        },
        capture_output=True, text=True, check=False,
    )
    if result.returncode != 0 or not pdf_path.is_file():
        raise SystemExit(f"PDF render failed: {result.stderr.strip() or result.stdout.strip()}")
    html_path.unlink(missing_ok=True)
    print(f"wrote {_shown(pdf_path)} ({pdf_path.stat().st_size / 1_000_000:.2f} MB)")

    reference = brand_reference_docx(profile, arguments.out / ".reference.docx")
    docx_path = arguments.out / "AMRIT-operator-manual.docx"
    pandoc(
        "--from", "gfm",
        "--to", "docx",
        "--reference-doc", str(reference),
        "--toc", "--toc-depth=2",
        "--resource-path", str(MANUAL_DIR),
        "--output", str(docx_path),
        str(SOURCE),
    )
    reference.unlink(missing_ok=True)
    print(f"wrote {_shown(docx_path)} ({docx_path.stat().st_size / 1_000_000:.2f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
