# Country profiles

A country profile is the single source of country-varying behaviour for both products.
`profile.schema.json` is the contract. The desktop app mirrors it in zod
(`app/src/main/country-profile.ts`) because it ships no JSON-Schema validator; the server
validates against the schema directly (`server/amrit_central_server/central/country_profile.py`).
Both suites validate the same checked-in files, so the two validators cannot drift silently.

## No country needs a profile written for it

Resolution runs in three tiers:

```
curated file (IN.json)  →  synthesized from ISO 3166-1 + CLDR  →  _default.json
```

Synthesis covers **all 249 ISO 3166-1 countries** (250 selectable, including Kosovo under
the user-assigned XKX code) from `reference/countries.json`. A curated file exists only to
*override* what synthesis produces. India has one because its LGD codes are not ISO 3166-2
and it needs two levels.

Selecting a profile:

- desktop app — `AMRIT_COUNTRY_PROFILE`, else the `country_profile_id` preference, else `IN`
- server — `AMRIT_COUNTRY_PROFILE`, else the fallback; multi-country deployments call
  `get_profile(country_code)` per country

## reference/countries.json is generated

```bash
node tools/generate_country_reference.mjs
```

```bash
node tools/generate_country_reference.mjs --check
```

Inputs are both already in the repository — nothing is fetched. ISO 3166-1 alpha-2/alpha-3,
names and WHO regions come from the `country` code set already bundled in the packaged
catalogue; locale, text direction, numbering system, time zones, first day of week and date
field order come from the ICU/CLDR data built into Node. The result is checked in so both
runtimes read identical values and Python needs no CLDR of its own.

Two things the generator deliberately does:

- **Canonicalises IANA time zone names.** ICU still reports several zones under their
  pre-rename "backward" names and which one it reports depends on the ICU build, so
  `Asia/Calcutta` becomes `Asia/Kolkata`. Without this the checked-in file would change
  between Node versions and Python's `zoneinfo` would receive non-canonical identifiers.
- **Refuses to guess a time zone for a country that spans several.** 34 entries get
  `timezone: null` and `timezone_ambiguous: true`. Picking the first zone alphabetically
  would have made `America/Adak` the United States default and mis-stamped every specimen
  date near a day boundary. Those deployments choose explicitly, and each site may override.

## Adding or overriding a country

1. Copy `_default.json` to `<ISO alpha-2>.json` and edit it.
2. Validate: `cd server/amrit_central_server && python manage.py test central.test_country_profile`
   and `cd app && pnpm vitest run tests/country-profile.test.ts`.
3. Re-vendor: `python3 tools/sync_shared.py`.

Curated profiles are matched by `profile_id` first, then by `country_code`, so
`AMRIT_COUNTRY_PROFILE=IND` also resolves to `IN.json`.

## Deliberate defaults in synthesized profiles

| Field | Value | Why |
|---|---|---|
| `identifier_namespace.base_uri` | `https://amrit.invalid` | `.invalid` is reserved (RFC 2606). An unconfigured FHIR namespace must be obvious, never silently borrow another country's identifiers. Set it before exporting. |
| `code_systems.snomed.enabled` | `false` | SNOMED CT needs a Member-country affiliate licence. Off by default is the licence-safe position (Phase 10). |
| `guidelines.default` | `EUCAST` | EUCAST breakpoint tables are free worldwide; CLSI M100 is a paid licence. |
| `epi_week_system` | `iso` | ISO-8601 and MMWR weeks differ by up to a week. Guessing per country would encode half-knowledge as fact. |
| `fiscal_year_start_month` | `1` | Same reasoning. India (4) and other exceptions come from curated profiles or the administration GUI. |
| `admin_levels` | one generic ISO 3166-2 level | Phase 3 refines the label from the ISO 3166-2 subdivision category and lets deployments import deeper levels. |

## `IN.json` and preserving current behaviour

`IN.json` states India's real values — `en-IN`, `Asia/Kolkata`, fiscal year starting in
April. The running system today uses `LANGUAGE_CODE = "en-us"` and `TIME_ZONE = "UTC"` on
the server and has no locale logic in the app.

**Nothing consumes the profile for decisions yet**, so there is no behaviour change. When
Phase 7 wires locale and timezone through, adopting these values must be an explicit,
tested step for existing Indian deployments — not a silent switch on upgrade.
