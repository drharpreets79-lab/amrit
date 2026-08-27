# ICMR brand implementation

The interface follows the supplied 47-page ICMR identity guide.

- Primary navy: `#23376D` (RGB 35, 55, 109)
- Primary blue: `#1B75BC` (RGB 27, 117, 188)
- Accent orange: `#F15A29` (RGB 241, 90, 41)
- Display: Gotham Black when installed
- Headings: Gotham Medium when installed
- Body: Gotham Light when installed
- Fallback: Calibri, then platform sans-serif

Proprietary Gotham font files are not bundled; the interface uses them only when already
licensed and installed. The supplied PDFs are byte-identical. Design implementation is based on
the logo colour specification, typography pages, hierarchy page, and logo protection/minimum-size
rules.

## The marks

The supplied master is `app/resources/icmr-logo.png`: the roundel and the wordmark locked up on
a 512×512 canvas whose artwork occupies only the top 224 rows. It is carried byte-for-byte and
never written to. Everything else is derived from it by `tools/generate_brand_assets.py`:

| File | What it is | Where it is used |
|---|---|---|
| `icmr-emblem.png` | the roundel alone, trimmed, transparent | light backgrounds — the portal header |
| `icmr-emblem-light.png` | the same roundel reversed to white | dark backgrounds — the desktop sidebar |
| `icmr-lockup.png` | roundel and wordmark, trimmed, transparent | wide slots, documents |
| `icmr-lockup-light.png` | the lockup reversed to white | wide slots on dark |
| `icmr-appicon.png` | roundel centred on an opaque 512×512 square | the packaged application's OS icon |

The mark is never recoloured, distorted, shadowed, outlined, or placed on a busy image, and the
protection rule is applied as a margin proportional to the mark rather than a fixed pixel count,
so it holds at every output size.

**Reversal, and what to confirm with ICMR.** `-light.png` replaces the colour channels with white
and preserves the alpha channel exactly, so the silhouette, proportions and clear space are
untouched. This is a knockout, not a recolouring, and it is what allows the emblem to sit
directly on the navy sidebar rather than on a white plate. If the identity guide forbids reversal
outright, supply an approved reversed asset under the same filename, or clear
`branding.logo_reverse` in `IN.json` — the interface then falls back to the plate on its own.

## Why the filenames matter

A country profile names one logo, and each product resolves that name against its own asset
root: the desktop renderer as `./resources/<file>`, the portal as `static('img/<file>')`. Neither
resolver checks that the file exists — a missing one is a silent 404 and an empty space. So
`tools/generate_brand_assets.py` writes identical bytes into both roots, and
`app/tests/branding-assets.test.ts` and `central/test_branding_assets.py` fail if a shipped
profile names a mark either product is missing.

```bash
python3 tools/generate_brand_assets.py
```

## This is India's profile, not the product's

Everything above is the content of `shared/country-profiles/IN.json`. Another deployment supplies
its own `branding.logo`, `branding.logo_reverse`, `authority_name`, `product_name` and three
colours, and no ICMR asset reaches its screens. A deployment that supplies no mark gets its
authority's name set in type — showing one country's emblem above another country's data is
worse than showing none.
