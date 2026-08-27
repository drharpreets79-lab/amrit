# AMRIT World-Ready Plan — India-specific → installable by any country

> **Revision 3.** Rev 1 removed India-specific *fields*. Rev 2 closed nine gaps that would have blocked
> a real non-India deployment — see [§ Does this actually make it world-usable?](#does-this-actually-make-it-world-usable).
> Rev 3 adds two requirements: **every profile-driven value is editable from a GUI** (Phase 6b), not only
> from JSON files, and **the repo splits into two independently distributable products** (Phase A).

## Context

AMRIT is an AMR surveillance platform in two deliverables sharing one data contract:

- **`electron_app/`** — standalone Node/Electron desktop app (React renderer, `node:sqlite`, offline-first, aggregate-only sync).
- **`Server/amrit_central_server/`** — Django + DRF + Channels central server (dashboards, RBAC, FHIR export, ingest).

The AMR core is already international: WHONET organisms/antibiotics/breakpoints, CLSI/EUCAST, LOINC/ICD, WHO AWaRe, GLASS/ANIMUSE/InFARM exporters, and a 252-country ISO code set already shipped in the seed. **The India coupling is concentrated in five places**, not spread everywhere:

1. **Geography** — a fixed two-level `state → district` hierarchy keyed on India LGD codes, hardcoded in both DB schemas, in RBAC scoping, in every metric group-by, and in the packaged seed (36 states / 785 districts).
2. **Scope enum** — `national → state → district → site` baked into Django choice enums, migrations, dashboard drill-down config, and role definitions.
3. **Identifier namespaces** — `https://amrit.icmr.gov.in/...` and `urn:icmr:amrit:...` written into every FHIR resource, plus `amrit.gov.in` schema `$id`s.
4. **Branding** — appId `in.gov.icmr.amrit`, ICMR emblems, `icmr-navy/blue/orange` Tailwind tokens across ~30 templates, map centred on India.
5. **No i18n** — ~40 renderer files and ~30 templates with hardcoded English; Django has `USE_I18N=True` but no `LocaleMiddleware` and zero `.po` files.

Goal: **any country installs either app without forking, without authoring anything, and without contacting the maintainers.** Hard constraint: existing India deployments keep working — in-place DB migration, no data loss, no forced re-seed, and already-deployed Electron clients keep talking to the server through the transition.

### Decisions taken (confirmed)

| Area | Decision |
|---|---|
| Hierarchy | **Generic N-level tree** (`admin_unit`), per-country level definitions |
| Geo data | **ISO 3166-2 built-in + CSV/GeoNames importer** for deeper levels |
| i18n | **Framework + English extraction** (i18next / Django gettext), RTL-ready, English only shipped |
| Branding | **Full white-label, India as default profile** — India profile reproduces today's exact values |

### Pre-flight (blocking, do before Phase 0)

**The working directory is not a git repository.** There is no rollback for a multi-phase refactor of this size. `git init`, commit the current tree as the baseline, and branch per phase. Do not start Phase 0 until this is done.

---

## Does this actually make it world-usable?

Honest verdict on Revision 1: it would have produced an app with no India-specific *fields*, but **not** an app any country could actually install and run correctly. Nine gaps, each of which would have surfaced during a real non-India deployment:

| # | Gap | Why it blocks worldwide use | Now handled in |
|---|---|---|---|
| 1 | **Profile authoring burden** — Rev 1 required a hand-written profile JSON per country | A country that isn't India or the test fixture has nothing to install with | **Phase 0** — profile *registry* that synthesizes a valid profile for all ~249 ISO 3166-1 countries automatically |
| 2 | **One country per server** — Rev 1 assumed a single global profile | Breaks WHO regional offices, multi-country research networks, and any cross-border aggregator — a large part of the real audience | **Phases 0, 4, 5** — scope root becomes `global → country → admin:1..N → site`; country is data, not config |
| 3 | **CLSI-only breakpoints** — `services.ts:43-48` links four paywalled `clsi.org` URLs, no EUCAST | Most of the world (all of Europe, much of Africa/Asia) uses EUCAST, which is free; CLSI M100 is a paid licence. A EUCAST-only lab has no breakpoint path | **Phase 9** — guideline plurality + offline breakpoint import |
| 4 | **Restricted-licence reference data** — SNOMED CT is bundled (`master_organisms.snomed_code`) | SNOMED CT needs a Member-country affiliate licence; redistributing it to a non-member country is a licensing violation, not a technical bug | **Phase 10** — licence manifest + per-code-system gating |
| 5 | **Unicode case-matching** — 10 sites use `__iexact` on free-text names (`central/roles.py:183-187`, `metrics/compute.py:122-124,233-235`, `dashboards/refresh.py:129-131`, `queries/views.py:122-124`) | SQLite `NOCASE` and Postgres `iexact` are ASCII-only in practice; scoping silently returns **zero rows** for Greek/Cyrillic/Turkish/Arabic unit names — an RBAC failure that fails closed and looks like "no data" | **Phase 5** — code-based `admin_path` prefix matching replaces every name-based `iexact`; regression test in non-Latin script |
| 6 | **Calendar, epi-week and fiscal-year semantics** | Surveillance reports by epidemiological week; ISO-8601 weeks ≠ MMWR weeks. Fiscal/reporting years differ (India Apr–Mar, US Oct–Sep, most Jan–Dec). Nepal/Iran/Ethiopia/Thailand use non-Gregorian civil calendars officially | **Phase 9** |
| 7 | **Single timezone per country** | The US, Russia, Brazil, Canada, Australia, Indonesia, DR Congo span multiple zones; a country-level timezone mis-stamps specimen dates at day boundaries | **Phase 9** — timezone resolves per site, country is only the default |
| 8 | **No first-run onboarding** | Rev 1 shipped an importer but no path from "downloaded the installer" to "working system" without reading docs and running CLI commands | **Phase 11** |
| 9 | **Not actually deployable** — `docker-compose.yml` defines no database service despite `psycopg2-binary`, while `server/amrit_central_server/.env.example` already declares `POSTGRES_DB/USER/PASSWORD/PORT` and references a `docker-compose.override.yml` that is not in the tree; no TLS, no backup, no air-gapped install, no multi-OS/arch build matrix | A ministry IT team cannot stand this up, and many target environments have no outbound internet | **Phase 11** |

Two further items are policy rather than code, but block adoption in several jurisdictions and are now scheduled: data residency/retention configurability, and the conflict between a right-to-erasure request and the tamper-evident audit hash chain (**Phase 12**).

With Phases 0–12 complete the answer is yes: a ministry in any ISO 3166-1 country downloads an installer, picks their country, and gets a working, correctly-scoped, correctly-dated, licence-clean system in their own administrative hierarchy — with no code changes and nothing authored by the maintainers.

---

## Target architecture

### 1. Country Profile registry — one contract, both apps

A single JSON document is the sole source of country-varying behavior. **No country needs a hand-written profile**: the registry resolves in three tiers.

```
explicit profile file  →  synthesized from ISO 3166 + CLDR  →  hard-coded fallback
  (IN.json, curated)      (any of ~249 countries, zero authoring)     (_default.json)
```

`synthesize_profile(country_code)` builds a valid profile for any ISO 3166-1 country from bundled reference data: country name and alpha-2/3 from ISO 3166-1; one admin level from ISO 3166-2, whose subdivision category name becomes the level label ("Province", "Region", "Governorate", …); locale, timezone, date order, first day of week and numbering system from CLDR; WHO region from the code set already in the seed. Curated files exist only to *override* the synthesized result — India needs one because LGD ≠ ISO 3166-2 and it has two levels.

Location: `standards/country-profiles/` (new, repo root, alongside `standards/national-amr-ig/`)
- `profile.schema.json` — JSON Schema for the profile itself
- `IN.json` — India, reproducing today's exact behavior byte-for-byte
- `_default.json` — last-resort fallback
- `TESTLAND.json` — synthetic 3-level, non-Latin-script, RTL country; test fixture only (permanent generalization gate)

Shape (India shown; synthesized profiles have the same shape):

```jsonc
{
  "profile_id": "IN",
  "country_code": "IND",            // ISO 3166-1 alpha-3 — what exporters emit
  "country_code_2": "IN",
  "country_name": "India",
  "who_region": "SEARO",

  "locale": "en-IN",
  "fallback_locales": ["en"],
  "text_direction": "ltr",
  "numbering_system": "latn",        // latn | arab | deva … — input parsing AND display
  "timezone": "Asia/Kolkata",        // DEFAULT only; each site may override
  "calendar": "gregory",             // gregory | nepali | persian | buddhist | ethiopic
  "date_input_order": "DMY",
  "first_day_of_week": 1,
  "epi_week_system": "iso",          // iso | mmwr | custom
  "fiscal_year_start_month": 4,      // India Apr–Mar; US 10; most 1

  "admin_levels": [
    { "level": 1, "key": "state",    "label": "State / UT", "label_plural": "States & UTs",
      "code_system": "LGD", "required": true },
    { "level": 2, "key": "district", "label": "District",   "label_plural": "Districts",
      "code_system": "LGD", "required": false }
  ],

  "identifier_namespace": { "base_uri": "https://amrit.icmr.gov.in", "urn_prefix": "urn:icmr:amrit" },
  "branding": { "product_name": "ICMR AMRIT", "app_id": "in.gov.icmr.amrit",
                "authority_name": "Indian Council of Medical Research",
                "logo": "icmr-emblem.png",
                "colors": { "navy": "#23376D", "blue": "#1B75BC", "orange": "#F15A29" } },

  "guidelines": { "default": "CLSI", "available": ["CLSI", "EUCAST"], "national_body": "ICMR" },
  "code_systems": { "snomed": { "enabled": true, "licence": "member-country" } },

  "banned_identifier_keys": ["aadhaar", "aadhar", "abha", "uhid"],
  "privacy": { "k_anonymity_floor": 5, "retention_days": null, "residency_note": null },
  "map": { "center": [22.9734, 78.6569], "zoom": 4, "tile_url": null },
  "reporting_frameworks": ["GLASS", "ANIMUSE", "InFARM", "NAP-AMR"]
}
```

**Electron**: profiles bundled at `electron_app/resources/country-profiles/`; active id stored in the existing `app_preferences` KV table (`src/main/database.ts:679`) under key `country_profile_id` — `IN` on upgrade, chosen in the wizard on fresh install. New `src/main/country-profile.ts` resolves, synthesizes, validates and caches; exposed to the renderer over the existing preload IPC bridge and consumed via a React context. Env override `AMRIT_COUNTRY_PROFILE` follows the existing `AMRIT_DATABASE_PATH` precedent (`src/main/paths.ts:21,33`). One install serves one laboratory, therefore one country — no multi-country complexity on the desktop side.

**Django**: `AMRIT_COUNTRY_PROFILE` env var sets the *default* (joins the existing `AMRIT_*` knobs at `central/settings.py:192-201`); new `central/country_profile.py` with a cached `get_profile(country_code=None)`; a `geo.CountryConfig` table holds per-country overrides, so a multi-country deployment has one row per hosted country; injected into templates by extending the existing context processor `central/context.py:24-51`.

### 2. Generic administrative hierarchy

Replaces `master_states`/`master_districts` (Electron) and the free-text `Site.state`/`Site.district` (Django).

Electron — add to `CORE_SCHEMA` in `src/main/database.ts`:

```sql
CREATE TABLE IF NOT EXISTS master_admin_units(
  id TEXT PRIMARY KEY,                    -- '<country_code>:<level>:<code>'
  country_code TEXT NOT NULL,
  level INTEGER NOT NULL,
  parent_id TEXT,
  code TEXT NOT NULL,
  code_system TEXT NOT NULL DEFAULT 'ISO3166-2',
  name TEXT NOT NULL,
  name_local TEXT,
  unit_type TEXT,                         -- generalizes is_union_territory
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(parent_id) REFERENCES master_admin_units(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ix_admin_unit_key ON master_admin_units(country_code, level, code);
CREATE INDEX IF NOT EXISTS ix_admin_unit_parent ON master_admin_units(parent_id);
```

Django — new app `geo` with `AdminUnit` of the same shape, `CountryConfig` (per-country profile override), plus on `sites.Site`:
- `country_code` — ISO 3166-1 alpha-3, indexed (promotes today's free-text `country` to a real key)
- `admin_unit` — nullable FK to `AdminUnit` (the deepest unit the site belongs to)
- `admin_path` — denormalized materialized path, e.g. `IND/28/583`, indexed
- `timezone` — nullable; falls back to the country profile

**Every scope filter becomes an `admin_path__startswith` prefix query on codes.** That keeps N levels as cheap as today's two filters *and* removes the Unicode `iexact` hazard (gap #5) — codes are ASCII, names never participate in matching.

**India migration, zero loss**: `master_states` → level 1 rows (`code = lgd_code`, `code_system = 'LGD'`, `unit_type` from `is_union_territory`); `master_districts` → level 2 rows parented by `state_lgd_code`. Django backfills `AdminUnit` from the profile's geo pack, then matches each `Site` by Unicode-normalized (NFC, casefolded) `(state, district)` name; unmatched sites are reported, never silently dropped.

**Compatibility shim**: the legacy columns (`master_states`, `master_districts`, `laboratory.state_lgd_code/state_name/district_lgd_code/district_name`, `master_hospitals.state_lgd_code/district_lgd_code`, `Site.state`, `Site.district`, `UserProfile.state/district`) are **kept and dual-written** for the whole transition. Existing reads, existing API responses, and already-deployed clients keep working unchanged. Dropping them is an optional final phase, not a prerequisite.

### 3. Generic scope, with a country level

Canonical `scope_type`: `global` | `country` | `admin:1` … `admin:N` | `site`.

- `national` is retained as an accepted alias for `country` forever.
- Legacy `state`/`district` are accepted on input forever, resolved through one function in a new `central/scopes.py`.
- A single-country deployment behaves exactly as today: `global` and `country` collapse to the same rowset, and `global` is hidden in the UI when only one country is configured.
- A multi-country deployment (WHO regional office, research network) gets cross-country roll-up for free, because country is already a path segment.
- The drill-down chain is generated from the active profile(s) rather than declared literally at `dashboards/config.py:42,53,64`.

---

## Phases

Each phase is independently shippable and must end with the full test suite green. Ordered by dependency; risk noted.

> **Path convention.** Phase A renames the two product roots. Every path in Phases 0–12 below is written
> in the **pre-split** form (`electron_app/…`, `Server/amrit_central_server/…`) because that is what the
> code says today. After Phase A, apply this mapping mechanically — nothing else about the phases changes:
>
> | Before | After |
> |---|---|
> | `electron_app/…` | `app/…` |
> | `Server/…` | `server/…` |
> | `standards/national-amr-ig/…` | `shared/contracts/…` |
> | `standards/country-profiles/…` | `shared/country-profiles/…` |
> | `test/golden-datasets/…` | `shared/golden-datasets/…` |
> | `electron_app/scripts/generate_*.py` | `tools/generate_*.py` |

---

### Phase A — Repository separation into two distributable products (risk: medium; do FIRST)

Goal: `app/` and `server/` become two products that build, test, ship and version **independently**, with one
source of truth for the contract they share.

**Why first**: every later phase names file paths. Splitting after twelve phases means renaming everything twice.

#### Target layout

```
AMRITNodeWorld/
  app/                     # desktop application — was electron_app/
  server/                  # web server — was Server/
  shared/                  # single source of truth for the shared contract
    contracts/             #   canonical-event + data-product schemas (was standards/national-amr-ig/)
    country-profiles/      #   profile schema + IN/_default/TESTLAND + ISO/CLDR reference
    geo-packs/             #   _iso3166-2.json, IN.json, …
    golden-datasets/       #   was test/golden-datasets/ (currently orphaned — see Phase 8)
    VERSION                #   contract version stamp, e.g. "1.1"
  tools/                   # cross-cutting generators: generate_catalog_seed.py, generate_geo_pack.py, sync_shared.py
  docs/
```

#### Existing couplings to sever (verified, not assumed)

| Coupling | Where | Fix |
|---|---|---|
| Generator imports a **missing sibling project** — `DESKTOP_ROOT = REPOSITORY_ROOT / "desktop_app"`, `sys.path.insert(0, DESKTOP_ROOT)`, plus reads `desktop_app/india_lgd_districts.csv` and `desktop_app/resources/Simple_AST_List_2026.csv` | `electron_app/scripts/generate_catalog_seed.py:19-20,26,276,280` | `desktop_app/` **is not present in this tree** — the script cannot run today. Move to `tools/`, take inputs via `--source` arguments, and drop the sibling import entirely (already scheduled in Phase 3) |
| Provenance paths recorded relative to the repo root | `generate_catalog_seed.py:68` | Record relative to `shared/` so the manifest is stable in a standalone `app/` checkout |
| Root-level shared assets referenced by neither product | `standards/`, `test/golden-datasets/` | Move under `shared/`; the server reads **nothing** from them today (verified — `jsonschema` is a dependency but no code path loads these files), so this move breaks nothing and Phase 6/8 wire them up properly |

Everything else is already clean: `electron_app/package.json` ships `files: ['out/**/*','package.json']` with
`extraResources: resources/`, and `Server/` contains only `amrit_central_server/`, `Dockerfile`,
`docker-compose.yml`, `requirements.txt`.

#### Vendoring — how "shared" survives separate distribution

`shared/` is the source of truth; **each product ships its own copy** so neither distributable references
anything outside its own folder:

- `tools/sync_shared.py` copies `shared/` → `app/resources/shared/` and `server/amrit_central_server/shared/`
- Runs as a pre-build step in both products
- CI runs `tools/sync_shared.py --check`; any drift between `shared/` and a vendored copy fails the build
- `shared/VERSION` is stamped into both artifacts and exchanged on the sync handshake, so a version mismatch
  between an old app and a new server is detected and reported rather than silently mis-parsed

Rejected alternatives: git submodule (adds clone friction for ministries), a published package (needs a
registry these deployments may not reach), duplication with no sync (drifts within one release).

#### Independent build, test and release

- `app/` — `pnpm dist` produces installers with no server present; the app is already offline-first and needs
  no server to function
- `server/` — `docker compose up` runs with no app present; seeded demo data already exercises every dashboard
- Two CI pipelines, path-filtered so a change in one does not rebuild the other
- Separate version numbers and changelogs; a compatibility matrix in `docs/COMPATIBILITY.md` stating which
  app versions each server version accepts, keyed on `shared/VERSION` and the `schema_version` already
  carried in the canonical envelope
- Two release artifacts: app installers (Windows/macOS/Linux) and a server bundle (Docker image + compose +
  source tarball). A downloader of one never needs the other.

#### Verification that separation broke nothing

This is the acceptance gate for the phase — run each in a **clean checkout containing only that product's folder**:

```bash
cd app && pnpm install && pnpm run check && pnpm test && pnpm run build
```

```bash
cd server && docker compose up -d && docker compose exec web python manage.py migrate && docker compose exec web python manage.py test
```

Then the cross-product smoke, which is the only thing that can catch a broken contract after the split — the
repo already has a harness for it at `Server/amrit_central_server/smoke_e2e.py` (registers a lab, then exercises
`/v1/poll`, `/v1/respond`, `/v1/heartbeat`):

```bash
cd server && python amrit_central_server/smoke_e2e.py
```

**Exit**: both suites green from their own roots; both products build in a checkout that contains only that
product plus `shared/`; `smoke_e2e.py` passes app↔server registration, poll, respond and heartbeat; the drift
check passes; `git log --follow` still resolves history for moved files (use `git mv`, never delete-and-add).

---

### Phase 0 — Country Profile registry (risk: low)

No behavior change. Everything resolves the India profile and produces today's values.

**Create**
- `standards/country-profiles/profile.schema.json`, `IN.json`, `_default.json`, `TESTLAND.json`
- `standards/country-profiles/reference/` — ISO 3166-1 + ISO 3166-2 + a CLDR-derived locale defaults table (small, licence-clean; see Phase 10)
- `standards/country-profiles/README.md` — how to override a synthesized profile
- `electron_app/src/main/country-profile.ts` — resolve → synthesize → validate → cache; order: `AMRIT_COUNTRY_PROFILE` env → `app_preferences.country_profile_id` → `IN`
- `Server/amrit_central_server/central/country_profile.py` — same, plus `get_profile(country_code)` for multi-country hosts; order: explicit file → `geo.CountryConfig` row → synthesized → `_default`

**Modify**
- `electron_app/src/shared/types.ts` — add `CountryProfile`, `AdminLevelDef` types (additive)
- `electron_app/src/preload/` + `src/main/index.ts` — expose `getCountryProfile()` over IPC
- `Server/.../central/context.py` — add `amrit_profile` to template context alongside `amrit_caps`/`amrit_role`
- `Server/.../central/settings.py` — read `AMRIT_COUNTRY_PROFILE`

**Also**: this plan lives at `docs/globalization/PLAN.md` with `docs/globalization/PHASE_STATUS.md` as the execution tracker.

**Back-compat**: nothing consumes the profile yet.
**Exit**: `pnpm test` + `pnpm typecheck` in `electron_app`; `python manage.py test` in `Server/amrit_central_server`; **a parameterized test synthesizes a profile for every ISO 3166-1 country and asserts all ~249 validate against `profile.schema.json` in both runtimes** — the gate that proves "any country" is real rather than aspirational.

---

### Phase 1 — Electron admin-unit tree (risk: medium)

**Modify `electron_app/src/main/database.ts`**
- Add `master_admin_units` to `CORE_SCHEMA` (~line 484-802)
- Add `laboratory.admin_unit_id`, `laboratory.admin_path`, `laboratory.country_code`, `laboratory.timezone`, `master_hospitals.admin_unit_id` via the existing additive `LEGACY_COLUMNS` map (~804-860) — `ensureLegacyColumns()` (~1031-1042) applies them to existing DBs with no manual step
- New migration step in `migrate()` (~1044-1069): backfill `master_admin_units` from `master_states`/`master_districts` when the table is empty and the legacy tables are not; append schema version row `3` next to the existing hardcoded v1/v2 inserts
- Dual-write helper: writing an admin unit to a laboratory also fills the four legacy `*_lgd_code`/`*_name` columns
- Generalize `MASTER_SPECS` (~285-316): replace the fixed `states`/`districts` specs with specs generated from `profile.admin_levels`; keep `'states'`/`'districts'` as accepted `MasterKind` aliases so `MasterStudioPage.tsx:17` and `tests/database.test.ts:65-70` keep passing

**Modify `electron_app/src/shared/types.ts`** — add `admin_unit_id`/`admin_path`/`country_code`/`timezone` to `Laboratory`; keep the four LGD fields; add `MasterKind` value `'admin-units'` retaining `'states'|'districts'`.

**Back-compat**: legacy tables/columns still populated; a v2 DB opened by this build upgrades in place; a DB upgraded by this build is still readable by the previous build (columns are purely additive).
**Exit**: existing suite green unchanged; new test opens a fixture v2 DB, migrates, asserts 36 level-1 + 785 level-2 units and that every legacy column still matches.

---

### Phase 2 — Electron surface de-Indianized (risk: low)

**Modify**
- `src/renderer/pages/LaboratoriesPage.tsx` — replace the two fixed state/district selects with a loop over `profile.admin_levels` rendering one cascading select per level, sourced from `master_admin_units` filtered by parent; labels come from `level.label` (India renders exactly "State / UT" and "District" as today); drop the hardcoded `{value:'India'}` country fallback (~line 81) in favour of the 252-country code set already in the seed; replace the literal "State LGD code"/"District LGD code" input labels (~82) with `${level.label} (${level.code_system})`
- `src/main/one-health-engine.ts:42-43` — replace the two hardcoded `field('state_code','State / UT LGD code')`/`field('district_code','District LGD code')` entries in `common()` with fields generated from `profile.admin_levels`; keep emitting `state_code`/`district_code` keys for levels 1 and 2 so `national_events` and the 1.0 canonical envelope are unaffected
- `src/main/one-health-exporters.ts:39` — replace the hardcoded `country: 'IND'` in `animuseProduct()` with `profile.country_code`
- `src/main/services.ts:181-195` `normalizeDate` — drive ambiguous-date parsing from `profile.date_input_order`; India is `DMY`, so India behavior is byte-identical. Also normalize non-ASCII digits to Latin before parsing (Phase 9)
- `src/main/services.ts:53-89 CORE_FIELD_ALIASES` — `patient_state: ['state','province','region']` and `patient_municipality` are already generic; extend with the profile's level labels and localized aliases so an import file headed "Governorate" or "Provincia" maps correctly
- `src/renderer/pages/MasterStudioPage.tsx:17` — "Sites & context" group lists admin levels from the profile

**Back-compat**: all wire formats unchanged for the India profile.
**Exit**: `tests/one-health-governance.test.ts:166` updated to assert `profile.country_code` and re-run under both `IN` and `TESTLAND`; `tests/laboratories-page.test.tsx` renders both profiles.

---

### Phase 3 — Seed split + geo packs + importer (risk: medium)

Today one 3.4 MB hash-pinned asset carries both the neutral AMR core and India geography, and its generator imports from a sibling `desktop_app/india_master_data.py` that lives outside `electron_app` entirely.

**Split**
- `electron_app/resources/catalog-seed.v2.json` — dataset `amrit-core-catalogue`, version `2026.2`: everything except `states`/`districts`. Unchanged content, new envelope.
- `electron_app/resources/geo-packs/_iso3166-2.json` — level-1 subdivisions for **every** ISO 3166-1 country (~4–5k rows, a few hundred KB). This is what makes an arbitrary country work on first boot.
- `electron_app/resources/geo-packs/IN.json` — India LGD levels 1–2 (36 + 785), dataset `amrit-geo-pack`, own sha256

**Modify `electron_app/src/main/catalog-seed.ts`**
- Drop `states`/`districts` from `PackagedCatalogue` and from `MINIMUM_COUNTS` (~46-61)
- Bump `PACKAGED_CATALOGUE_DATASET`/`VERSION`/`CONTENT_SHA256` (~6-9)
- Keep a v1 fallback loader for one release: if `catalog-seed.v2.json` is absent, load v1 and split it in memory — so a partially-updated install still boots
- New `src/main/geo-pack.ts` mirroring `validateAsset()` (~109-160) for geo packs: schema version, dataset, per-pack sha256, per-level minimum counts declared *inside the pack* rather than compiled into the loader

**Modify `electron_app/scripts/generate_catalog_seed.py`**
- Remove the `from india_master_data import load_india_states_lgd, load_india_districts_lgd_starter` import (~line 28) and the `"country": "India"` literal (~line 180) — severs the build-time dependency on `desktop_app/`
- New sibling `electron_app/scripts/generate_geo_pack.py --country IN --source <csv>` producing a geo pack from a CSV of `level,code,parent_code,name,name_local,unit_type`; ships with an ISO 3166-2 generator mode

**Importer (runtime, both apps)** — the path for a country whose deeper levels nobody has packaged:
- Electron: Master Studio → "Administrative units" import accepting the same CSV, with dry-run preview, parent resolution by code, Unicode-safe name handling, and a conflict report
- Django: `python manage.py import_admin_units --country NG --file units.csv` plus a Django-admin upload action
- Both accept GeoNames `admin1CodesASCII`/`admin2Codes` exports directly (documented mapping), so most countries onboard without hand-building a CSV

**Exit**: `tests/catalog-seed.test.ts:46-55` rewritten to assert counts from the asset's own `rowCounts` manifest rather than the literals `states: 36, districts: 785`; new test imports a 3-level TESTLAND pack and asserts tree integrity; a test loads the ISO pack and asserts every ISO 3166-1 country has ≥1 level-1 unit or is explicitly listed as subdivision-less (Monaco, Singapore, Vatican, Nauru, …).

---

### Phase 4 — Django `geo` app + Site linkage (risk: medium)

**Create** `Server/amrit_central_server/geo/`
- `models.py` — `AdminUnit` (fields as above), `AdminUnitQuerySet.descendants_of()`, `CountryConfig` (per-country profile override, enables multi-country hosting)
- `migrations/0001_initial.py`
- `management/commands/import_admin_units.py`, `management/commands/load_geo_pack.py`

**Modify `sites/`**
- `models.py:29-31` — add `Site.country_code` (indexed), `Site.admin_unit` (nullable FK), `Site.admin_path` (indexed), `Site.timezone` (nullable); **keep** `country`/`state`/`district` and populate them from `admin_unit` on save
- `models.py:112-113` — add `UserProfile.admin_unit` (nullable FK) and `UserProfile.country_code`; keep `state`/`district`
- New migration + a data migration that loads the profile's geo pack, matches sites by NFC-normalized casefolded `(state, district)`, and writes a report of unmatched rows to stdout without failing
- `serializers.py:12-33` — additive: expose `country_code`, `admin_unit`, `admin_path`, and a nested `admin_units` array **alongside** the existing `country`/`state`/`district`

**Back-compat**: every existing API response keeps its exact shape; the new fields are additive. `sites/views.py:18` `filterset_fields` gains `country_code` and `admin_path` and keeps `state`/`district`.
**Exit**: `python manage.py migrate` on a copy of a populated India DB links 100% of sites; `python manage.py test`; seeded demo data still renders every dashboard; a two-country fixture (IN + TESTLAND) coexists in one DB with correct isolation.

---

### Phase 5 — Django scope + RBAC generalization (risk: HIGH — the riskiest phase)

This is where the fixed `national → state → district → site` hierarchy actually lives, and where the Unicode scoping hazard (gap #5) is removed.

**Create `central/scopes.py`** — the single place that knows about levels:
- `canonical_scope_type(value)` → `'national'`→`'country'`, `'state'`→`'admin:1'`, `'district'`→`'admin:2'`; passes through `global`/`country`/`site`
- `legacy_scope_type(value)` → the inverse, for rendering to old clients
- `scope_chain(profile)` → `['global', 'country', 'admin:1', …, 'site']` (`global` omitted when one country is configured)
- `scope_label(profile, scope_type)` → `"State / UT"`, `"District"`, …
- `scope_queryset(scope_type, scope_value)` → the one `admin_path__startswith` filter every caller uses

**Modify (each replaces a local hardcoded 3-way switch, and each name-based `iexact`, with a `central/scopes.py` call)**
- `central/roles.py:169-195` `scope_sites()` — **the** RBAC gate; `scope_kind` becomes a level number; today's `state__iexact` / `district__iexact` matching (lines 183-187) becomes `admin_path__startswith`. Semantics for "state officer sees only their state" and "district officer sees district within state" are reproduced exactly — and start working for non-ASCII unit names, which they do not today
- `metrics/compute.py:120-127` `_scope_site_filter`, `:130-138` `_results_for`, `:223-258` `_compute_coverage` (the `cov_geo` KPI counts distinct units per level instead of distinct states/districts)
- `dashboards/refresh.py:106-119` `refresh_all_scopes` — fan out over `scope_chain(profile)` per hosted country instead of the literal state-then-district loop; `:125-137` `_scope_sites`
- `dashboards/views.py:52-75` `_resolve_scope`, `:190-207` `_ranking` (child scope from the chain)
- `dashboards/config.py:42,53,64` — `panels.ranking` child scope derived from the profile
- `actionplans/access.py:12-24` `scope_for_user`, `:27-38` `plans_for_scope`; `actionplans/rules.py:19-43`
- `analytics/filters.py:31-32,79` and `analytics/views.py:70-86` — `state`/`district` filters become a repeatable `admin_code` filter plus `country_code`; the old params stay as aliases
- `queries/views.py:118-124`; `central/views.py:412-421,488-491,584`

**Roles** — `sites/models.py:85-97 ROLE_CHOICES`, `sites/migrations/0004_roledefinition_dynamic_roles.py:4-16,50-51`:
- Add `RoleDefinition.scope_level` (integer, nullable) beside the existing `scope_kind`
- Seed `state_health_officer` → `scope_level=1`, `district_health_officer` → `scope_level=2` — **existing `UserProfile.role` values stay valid**, nothing is invalidated
- Add generic `admin_health_officer` for levels beyond 2, and `country_health_officer` for multi-country hosts; display names come from `scope_label()`
- `central/roles.py:38-50 ROLE_DASHBOARD` and `:53-116 ROLE_CAPS` gain the generic roles with the same capability sets
- `central/roles.py:198-217` — `_SuperAdminProfile.organization` reads `profile.branding.authority_name` instead of the literal `"ICMR"`

**Stored scope values** — `dashboards/models.py:23-28 SCOPE_CHOICES`, reused by `actionplans/models.py:15,114`:
- Data migration rewrites existing `KPISnapshot`/`ActionPlan`/`ThresholdRule` rows `'national'`→`'country'`, `'state'`→`'admin:1'`, `'district'`→`'admin:2'`; reversible
- Inbound API/query params accept both forms indefinitely
- Responses carry both `scope_type` (canonical) **and** `scope_label`

> **Minimum unavoidable break:** any third-party consumer that reads the raw `scope_type` string out of a KPI/action-plan API response and compares it to the literal `"state"`/`"district"`/`"national"` will see `"admin:1"`/`"admin:2"`/`"country"` after this phase. Everything in this repo, and every inbound request, keeps working. If even that is unacceptable, `legacy_scope_type()` can be applied on output for the India profile only — decide at implementation time; the helper exists either way.

**Exit**: full Django suite green; before/after snapshot-parity harness — run `refresh_all_scopes()` on a copy of a populated India DB pre- and post-migration and diff every `KPISnapshot` value; every dashboard renders identically for each seeded role; **a dedicated RBAC test with Greek, Cyrillic, Turkish (dotted/dotless İ/ı) and Arabic unit names proves scoping returns the right rows — the case that silently returns zero today.**

---

### Phase 6 — Namespaces, branding, schema 1.1 (risk: medium)

**Identifier namespaces** — new `Server/.../central/identifiers.py` and `electron_app/src/main/identifiers.ts`, both building URIs from `profile.identifier_namespace`. India profile reproduces today's strings exactly, so **FHIR identifiers already emitted by Indian deployments stay stable**.
- `Server/.../analytics/fhir.py:54,71,145,174,196` and `analytics/views.py:393` (duplicate Measure URL — consolidate into `identifiers.py` while here)
- `analytics/fhir.py:49-64 organization_resource` — `Organization.address` built from the admin-unit chain instead of fixed country/state/district
- `electron_app/src/main/database.ts:2560,2566,2569` (`urn:icmr:amrit:*`) and `src/main/services.ts:1478` (`amrit.icmr.gov.in/CodeSystem/aggregate`)

**Branding**
- `electron_app/package.json:4,7,56,57` — `appId`/`productName`/`author` become build-time inputs from the profile via an `electron-builder` config hook; India build output is unchanged
- `src/main/index.ts:608,684,699`; `src/renderer/App.tsx:41-42,59`; `src/renderer/components/Shell.tsx:48` — name, emblem, alt text from profile
- `src/main/database.ts:1290-1292` One Health domain colours from `profile.branding.colors`
- `src/main/services.ts:1169` LLM system prompt — `profile.guidelines.national_body` replaces the literal "ICMR"; also fix the doc/code mismatch at `electron_app/docs/PRIVACY_AND_SAFETY.md:12` (it claims Indian-identifier redaction that the generic regexes at `services.ts:1176` do not implement) — drive redaction from `profile.banned_identifier_keys`
- `Server/.../central/templates/dashboard/base.html:16-18` — rename Tailwind tokens `icmr-navy/blue/orange` → `brand-navy/blue/accent` (mechanical, ~30 templates) with values injected from the profile; `:54,163`, `registration/login.html:2,7,36`, `dashboard/public.html:7-8` — text from profile
- `dashboard/map.html:41`, `map_embed.html:30` — Leaflet centre/zoom from `profile.map`; **also make the basemap tile URL configurable** (`profile.map.tile_url`) — several target countries block or cannot reach common tile CDNs, and air-gapped installs have none (offline raster fallback in Phase 11)
- `queries/pii_guard.py:43-47` and `ecosystem/views.py:15` — merge `profile.banned_identifier_keys` into the generic blocklist rather than hardcoding `aadhaar`/`abha`/`uhid`
- `ecosystem/models.py:85,105` — `ProgrammeMilestone.framework` default and `ReportingRun.TYPES` (`NAP-AMR`, `InFARM`) from `profile.reporting_frameworks`; `models.py:13,17` — split `Organization.TYPES`, moving `national/state/district` out of the org-type enum into an `admin_level` field so the type enum holds only real org types (`ministry`, `facility`, `laboratory`, `research`, `regulator`)

**Schema evolution** — `standards/national-amr-ig/`. Both current schemas are `additionalProperties: false` with `const` version pins, so 1.0 cannot be extended in place. Add new files; never touch the 1.0 files:
- `canonical-event-1.1.json` — new `$id` on a vendor-neutral host; adds `country_code` (required in 1.1), `admin_codes: [{level, code, code_system}]`, and `reporting_period` (carrying an explicit `epi_week_system`); retains `state_code`/`district_code` as deprecated-but-allowed
- `data-product-1.1.json` — `contract` accepts `national-amr-data-product/1.1`
- Validators pick the schema by the payload's own `schema_version`/`contract`; `ecosystem/views.py:54` accepts both `1.0` and `1.1`. **1.0 producers keep validating forever.**

**Exit**: FHIR golden-file test proves India-profile output is byte-identical to pre-change; a TESTLAND-profile run emits no `icmr` substring anywhere (grep assertion in CI); both schema versions validate their fixtures.

---

### Phase 6b — Profile administration GUI (risk: medium)

Phases 0–6 make every country-varying value *profile-driven*. This phase makes every one of them
**editable by an administrator from the UI** — desktop app and web server both — with no file editing,
no redeploy, and no developer involvement. Depends on Phase 6, because Phase 6 is what routes each value
through the profile in the first place.

#### What is runtime-editable vs build-time only

Be explicit about this in the UI itself; the distinction is an OS constraint, not a design choice.

| Runtime-editable (this phase) | Build-time only (documented, not editable) |
|---|---|
| Logo, product display name, authority name, brand colours | `appId` (`in.gov.icmr.amrit`) — OS bundle identity, fixed at package time |
| Identifier namespace `base_uri` / `urn_prefix` | Code-signing identity and certificate |
| Admin level count, keys, labels, code systems | Installer filename and OS-registered protocol handlers |
| Locale, timezone, calendar, numbering system, date order, first day of week | |
| Epi-week system, fiscal year start month | |
| Guideline default and available set; SNOMED and other code-system toggles | |
| Map centre, zoom, tile URL | |
| k-anonymity floor, retention days, banned identifier keys | |
| Reporting frameworks | |

Changing `appId` requires a rebuild and a re-sign; the UI states this and offers a profile export that a
country feeds into its own build (Phase 11 documents that path).

#### Desktop app — Settings → "Deployment & country"

New renderer page plus main-process handlers.

- **Storage**: an override document, not an edit to the bundled profile. New `app_preferences` key
  `country_profile_overrides` holding a JSON patch applied over the resolved base profile
  (`src/main/country-profile.ts` gains `applyOverrides()`). "Reset to defaults" deletes the patch and returns
  to the synthesized or curated base — always recoverable.
- **Sections**: Identity & branding · Administrative levels · Locale & time · Standards & guidelines ·
  Privacy · Map · Advanced (identifier namespace).
- **Live preview** for logo and colours; the admin sees the effect before committing.
- **Validation** against `profile.schema.json` before the patch is written; invalid input never reaches the DB.
- **Import / export** the effective profile as JSON — the handoff to a country's own build, and the way one
  ministry seeds a second deployment.
- **Diff view** against the base profile, so an admin can see exactly what their deployment has customized.
- **RBAC**: gated on the existing One Health admin role; the change is appended to the tamper-evident audit
  chain with actor, timestamp, and the before/after patch.
- **Logo storage**: uploaded file is copied into the app's `userData` directory, never into `resources/`
  (which is inside the signed bundle and read-only after install).

#### Web server — staff-only "Deployment settings"

- **Storage**: `geo.CountryConfig` (introduced in Phase 4) gains the full override document, one row per hosted
  country, plus a `DeploymentConfig` singleton for server-level branding that is not country-specific.
- **Two surfaces**: a Django-admin ModelAdmin for completeness, and a purpose-built page in the dashboard UI
  with the same sectioned layout as the desktop app.
- **Permission**: a new capability `CAP_MANAGE_DEPLOYMENT` in `central/roles.py`, granted to `super_admin`
  only by default. It is deliberately *not* bundled into `CAP_MANAGE_USERS` — namespace edits change what
  every FHIR consumer sees.
- **Audit**: every change recorded with actor, timestamp, and a field-level diff; surfaced in the existing
  audit view.
- **Cache invalidation**: `get_profile()` is cached; saving must bust the cache across all workers
  (cache-version key bumped on save), otherwise Daphne workers serve stale branding until restart.
- **Multi-country**: the country selector appears only when more than one `CountryConfig` row exists.

#### Security requirements for this phase

These are not optional hardening; each one is a live vulnerability if the phase ships without it.

- **Logo upload.** Accept PNG, JPEG and WebP only. **Reject SVG** — an SVG logo is an executable script vector
  and this file is rendered into an authenticated admin page and, on the server, into the public dashboard.
  If SVG support is genuinely required later, it must be sanitized through a strict allowlist sanitizer and
  served from a separate origin, which is a larger change than it appears. Validate the magic bytes rather
  than trusting the filename or the `Content-Type` header, cap byte size and pixel dimensions, and re-encode
  the image server-side so the stored file is one this codebase produced. Serve uploaded media with a pinned
  `Content-Type` and `X-Content-Type-Options: nosniff`, from a path that cannot execute code.
- **URL fields.** `identifier_namespace.base_uri` and `map.tile_url` are admin-entered and are rendered into
  FHIR output, `<img src>` and tile requests. Require an absolute `https://` URL, reject `javascript:`,
  `data:` and `file:` schemes, and escape on output — do not rely on the field having been validated on input.
- **Identifier namespace changes are not fully reversible.** FHIR bundles already exported carry the old
  `system` URIs; changing the namespace splits identifier continuity for every downstream consumer. The UI
  must show a clear confirmation naming that consequence, and the change must be stored with an
  effective-from timestamp so exports remain explainable after the fact.
- **Server-side authorization on every write**, not only a hidden menu item. `CAP_MANAGE_DEPLOYMENT` is
  checked in the view, and the desktop equivalent is enforced in the main process — the renderer cannot be
  trusted to gate it.

#### Reuse

Phase 11's first-run wizard is the same field set in a guided order. Build the section components here and
have the wizard compose them, rather than writing the forms twice.

**Exit**: an administrator changes logo, product name, colours, admin-level labels and identifier namespace
from the UI in both products, with no file editing and no restart; the change is audited; export/import
round-trips an effective profile between the two products; an SVG upload and a `javascript:` URL are both
rejected with a clear message; a non-privileged user receives 403 on a direct POST to the settings endpoint.

---

### Phase 7 — i18n / l10n (risk: low, high volume)

**Electron** — add `i18next` + `react-i18next`; catalogs at `electron_app/src/renderer/locales/<locale>/<namespace>.json`, one namespace per page. Extract the ~40 renderer files incrementally, enabling `eslint-plugin-i18next`'s `no-literal-string` as a warning repo-wide and promoting it to error per directory as each is converted. Main-process strings (window title, menus, `dialog` errors in `src/main/index.ts`) use a small node-side `i18next` instance. Set `dir` from `profile.text_direction` and mirror the layout for RTL. Number/date display switches to `Intl` with `profile.locale`, `profile.timezone`, `profile.numbering_system` and `profile.calendar` (today it relies on OS locale).

**Django** — add `django.middleware.locale.LocaleMiddleware` to `MIDDLEWARE` (`central/settings.py:39-49`; `USE_I18N` is already `True` at `:150-153`), set `LOCALE_PATHS`, wrap ~30 templates in `{% load i18n %}` / `{% trans %}`, use `gettext_lazy` for model `verbose_name` and choice labels, run `makemessages`. `TIME_ZONE`/`LANGUAGE_CODE` default from the profile — **the India profile keeps today's `UTC`/`en-us` so current behavior is preserved**; deployments opt in to a local zone.

**Also**: user-supplied content (laboratory names, admin unit `name_local`, custom master rows) is never translated — it is stored per-record and rendered with `Intl.Collator(profile.locale)` sorting rather than byte order.

**Back-compat**: English strings are unchanged; only their storage location moves.
**Exit**: catalogs complete with zero fuzzy entries; a pseudo-locale run (`en-XA`) shows no untranslated literals in the main flows; an RTL snapshot test passes; existing UI snapshot tests pass.

---

### Phase 8 — Wire contract, hardening, demo data, test matrix (risk: medium)

**`sites/views.py:35-55 create_labcode`** — today it requires nested `request.data["state"]["state_name"]` and `["district"]["district_name"]`, which only the current Electron client sends. Make the parser tolerant: accept the nested object, a plain string, or the new `admin_units: [{level, code, name}]` array plus `country_code`. Add a clean `POST /api/v2/sites/register/` for new clients. **Deployed clients keep working with no change.**

> **Security finding, adjacent to this work (not caused by it):** `central/urls.py:57-58` registers both `create_labcode` and `fetch_site_token` with `permission_classes=[AllowAny]` — unauthenticated lab registration and token issuance. There is also a URL-name collision: `fetch_site_token` is registered under the name `"create_labcode"`. Both should be fixed in this phase: require a bootstrap/enrolment secret for registration, and give the second route its own name. This is a pre-existing exposure and is worth treating as its own change with its own review.

**Demo/seed data** — `sites/management/commands/seed_demo.py:22-56` (16 Indian hospitals + ICMR/MoHFW/NCDC demo users), `dashboards/management/commands/seed_dashboards.py:25-43` (India AMRSN-calibrated rates, Karnataka/Maharashtra/Delhi scopes), `sites/management/commands/issue_token.py:38` (defaults `country="India"`): parameterize by `--profile`, keep the India dataset as the `IN` fixture, add a neutral fixture generated from the active profile's own admin units.

**Test matrix** — the permanent generalization gate:
- Run both suites under `AMRIT_COUNTRY_PROFILE=IN` and `AMRIT_COUNTRY_PROFILE=TESTLAND` (3 admin levels, non-Latin script, RTL locale, non-Gregorian calendar, MMWR epi weeks, ISO 3166-2 codes)
- Wire the currently **orphaned** `test/golden-datasets/*.json` — no code reads them today; `electron_app/tests/one-health-engine.test.ts:43-50` duplicates their numbers by hand. Add `electron_app/tests/helpers/golden.ts` to load them and assert against the fixtures, removing the duplication.
- `electron_app/tests/laboratory-clone.test.ts:99-109` already clones a lab to `country: 'Bhutan'` — promote that into a full non-India round-trip test (create → capture → export → sync)
- CI grep gate: under a non-India profile, no emitted payload, export, or rendered page may contain `icmr`, `India`, `LGD`, or `Aadhaar`

**Docs** — update `electron_app/docs/PARITY_MATRIX.md` (the acceptance contract), `docs/ARCHITECTURE.md:33-37`, `electron_app/resources/CATALOGUE_PROVENANCE.md`, `docs/ICMR_BRAND_IMPLEMENTATION.md` → `BRANDING.md`.

---

### Phase 9 — Locale-correct data semantics (risk: medium)

Closes gaps #3, #6, #7. Where "it displays in your language" becomes "it computes the right numbers for your country."

**Guideline plurality** — `electron_app/src/main/services.ts:43-48 OFFICIAL_BREAKPOINT_URLS` currently lists four paywalled `clsi.org` links and nothing else:
- Add EUCAST as a first-class source (free clinical breakpoint tables, published annually) with its own download/parse path alongside the existing CLSI workbook staging
- `profile.guidelines.default` selects which is offered first; a EUCAST-only lab never meets a CLSI paywall, and vice versa
- Add an **offline breakpoint import** path (file picker for a locally-obtained table) for labs with no outbound internet or no licence to fetch programmatically
- Keep the existing staged→activated model (`whonet_user_breakpoints`) untouched — this only adds sources

**Epidemiological time** — new `epi_time.ts` / `epi_time.py` sharing one definition:
- `epi_week(date, system)` supporting `iso` (ISO-8601, Monday start) and `mmwr` (US CDC, Sunday start); these differ by up to a week and silently mis-bucket surveillance counts
- `reporting_year(date, fiscal_year_start_month)` — India Apr–Mar, US Oct–Sep, most Jan–Dec
- Dashboards, `metrics/compute.py`, trend analysis and annual-report exports take their period boundaries from these, not from bare calendar arithmetic
- The GLASS exporter continues to use calendar year, as GLASS requires, regardless of national fiscal year

**Calendars and numerals**
- Storage stays ISO-8601 Gregorian UTC everywhere — no change to the wire or DB
- Display converts via `Intl.DateTimeFormat` with `profile.calendar` (Nepali Bikram Sambat, Persian Jalali, Buddhist era, Ethiopic)
- **Input** normalizes Arabic-Indic (`٠١٢`), Devanagari (`०१२`) and other digit sets to Latin before parsing — otherwise a correctly-typed date is rejected as invalid. Applies to `normalizeDate`, all numeric form fields, and CSV/Excel import
- Unicode NFC normalization on all imported text; `Intl.Collator(profile.locale)` for every user-facing sort (today: byte order)

**Timezone per site** — `Site.timezone` / `laboratory.timezone` (added in Phases 1 and 4) resolves before the country default. Specimen dates, heartbeat windows (`AMRIT_ONLINE_WINDOW_SECONDS`) and day-boundary bucketing use the site's zone, so a country spanning several zones (US, Russia, Brazil, Canada, Australia, Indonesia, DR Congo) reports correctly.

**Units** — AMR is metric everywhere (mg/L MIC, mm zone diameter, mg/PCU, DDD/1000 inhabitant-days); no conversion layer is needed, but reporting templates state units explicitly so a non-metric-habituated user cannot mis-enter.

**Exit**: golden tests for ISO vs MMWR week boundaries across year transitions; fiscal-year tests for Apr-start and Oct-start; date round-trip tests in four calendars and three numbering systems; a multi-timezone site fixture proves day-boundary bucketing.

---

### Phase 10 — Reference-data licensing and provenance (risk: medium, mostly legal)

Closes gap #4. Governs whether the built artifact may lawfully be distributed worldwide — which no amount of code generalization solves on its own.

- **Licence manifest** — `standards/DATA_LICENCES.md` plus a machine-readable `licences` block in every seed/geo-pack asset, recording for each bundled dataset: source, version, licence, redistribution terms, and whether it may ship in a public installer.
- **SNOMED CT gating** — `master_organisms.snomed_code`/`snomed_text` (`database.ts:525-532`). SNOMED CT is free to use only in Member countries; elsewhere it requires an affiliate licence. Make it a pluggable, off-by-default-outside-members code system: `profile.code_systems.snomed.enabled` gates seeding and display, the app runs fully without it (WHONET codes are the primary key), and the installer states the licence position. Same treatment for any other restricted vocabulary found during the audit.
- **CLSI** — M100 breakpoint tables are copyrighted and licensed. The app must never redistribute them; it links or imports (Phase 9). EUCAST tables are freely redistributable and *can* ship.
- **Geo data** — ISO 3166 is usable; GeoNames is CC-BY (attribution required); GADM is non-commercial-only, so **GADM must not be bundled** — the importer accepts it if a deployment chooses to, and the docs say so.
- **Attribution surface** — an "Open data and licences" page in both apps listing every bundled dataset and its attribution, satisfying CC-BY and equivalent terms.
- **CI audit** — any asset without a `licences` entry fails the build.

**Exit**: every bundled dataset has a recorded licence; a build with `snomed.enabled=false` produces a working app with no SNOMED content; `DATA_LICENCES.md` reviewed by whoever owns distribution.

---

### Phase 11 — Install, onboarding and deployment (risk: medium)

Closes gaps #8 and #9 — the difference between "the code is generic" and "a ministry can stand it up."

**First-run wizard, Electron** (`src/renderer/pages/` + a `first-run` main-process gate):
1. Choose country (searchable ISO 3166-1 list) → profile synthesized or loaded
2. Confirm/adjust administrative levels; load the bundled ISO 3166-2 units, or import a CSV/GeoNames file for deeper levels
3. Choose guideline body (CLSI / EUCAST) and language
4. Create the laboratory and the first One Health admin
5. Optionally pair with a central server (URL + enrolment secret)

Existing installs skip the wizard entirely — an upgraded India DB already has a lab and a profile.

**First-run, Django** — `python manage.py bootstrap --country NG --interactive` doing the equivalent: load geo pack, create `CountryConfig`, create the superuser, seed role definitions, print the enrolment secret. Idempotent and re-runnable.

**Deployment**
- `server/docker-compose.yml` — add the missing **Postgres service**, named volumes, healthchecks, and a documented `DATABASE_URL`. `psycopg2-binary` is already a requirement, and `server/amrit_central_server/.env.example` already declares `POSTGRES_DB/USER/PASSWORD/PORT` plus a comment referencing a `docker-compose.override.yml` that does not exist in the tree — so the intended shape is documented but never wired. Reconcile the two rather than inventing a third convention.
- `server/amrit_central_server/.env.example` — **already exists**; extend it rather than replacing it. Missing today: `DATABASE_URL`, `REDIS_URL`, the `AMRIT_*` knobs from `central/settings.py:192-201`, and `AMRIT_COUNTRY_PROFILE`.
- Settle the `Dockerfile` entrypoint (line ~22 is currently commented out, leaving the image dependent on compose's `command:`). Also resolve the **two** Dockerfiles (`server/Dockerfile` and `server/amrit_central_server/Dockerfile`) and delete the stray `server/amrit_central_server/Dockerfileh` typo file.
- Reverse proxy + TLS example (Caddy or nginx) — `AllowAny` enrolment over plain HTTP is not acceptable in the field
- `backup.sh` / `restore.sh` and a documented restore drill — mandatory for a surveillance system of record
- **Air-gapped install path**: pre-pulled images, a vendored wheelhouse, an offline npm/pnpm store, offline map tiles, and no first-run outbound calls. Many ministries have no outbound internet
- Electron build matrix: Windows (x64/arm64), macOS (x64/arm64), Linux (AppImage + deb/rpm), with per-profile `appId`/signing documented — including how a country signs its own build
- `docs/globalization/ONBOARDING_A_COUNTRY.md` (end-to-end runbook) and `docs/globalization/DEPLOYMENT.md`

**Accessibility** — `ops/NATIONAL_AMR_SLOS.md:16` already names "accessibility and localisation testing" as a required, unimplemented control. Add automated axe checks to CI and fix contrast/labels in the main flows; also a procurement requirement in many jurisdictions.

**Exit**: on a clean machine with no network, `docker compose up` + `bootstrap --country NG` yields a working server; a fresh Electron install for a country with no curated profile completes the wizard and captures an isolate; the restore drill succeeds from a backup.

---

### Phase 12 — Privacy, retention and legal configurability (risk: low, policy-heavy)

- **Retention** — `profile.privacy.retention_days` drives an automated purge job for row-level operational data; today nothing expires. Several jurisdictions mandate a maximum retention period.
- **Data residency** — the aggregate-only sync design already keeps row-level data on the site; document it explicitly as a residency guarantee, and make the outbound endpoint allowlist configurable so a deployment can prove where data goes.
- **k-anonymity** — `AMRIT_K_ANON_FLOOR` is already configurable; surface it in the profile and display the active floor on public dashboards.
- **Erasure vs. tamper-evident audit** — the One Health audit chain is a hash chain; deleting a record breaks it, but GDPR-style erasure rights require deletion. Resolve with crypto-shredding: the chain stores content *hashes*, and erasure destroys the plaintext while the chain stays verifiable. **Design this before any deployment in a jurisdiction with erasure rights** — retrofitting it into an existing chain is far harder.
- **Consent and legal text** — consent strings, privacy notice and terms become profile/deployment-supplied documents, not hardcoded English text.
- **Templates** — a DPIA template and a records-of-processing template in `docs/globalization/legal/`, since most adopters need them and neither is country-specific in structure.

**Exit**: retention job tested; erasure flow leaves the audit chain verifiable; a legal reviewer signs off the templates.

---

### Phase 13 — Universal address, and the last of `state` / `district` / LGD (risk: medium)

Phases 1–5 introduced the country-neutral tree and made it authoritative. What they deliberately did
**not** do was remove the India-shaped columns beside it: `laboratory.state_lgd_code`,
`master_hospitals.district_lgd_code`, `Site.state`, `UserProfile.district`,
`national_events.state_code`, `Organization.state_code`, the `state`/`district` scope spellings, the
`state`/`district` dashboards and roles. They were kept as a compatibility shim so nothing broke
mid-refactor. A shim that survives is not a shim: a three-level country still could not record its
third level, and a one-level country still carried a "district" it could never fill.

Two separate questions were being answered by one set of columns, and they are now stored apart:

| Question | Answer | Used for |
|---|---|---|
| Which reporting unit is this under? | `admin_unit_id` + `admin_path` | every scope filter, every metric group-by, RBAC |
| Where is the building? | a structured postal address | display, export, FHIR `Address` |

- **Address format** — the ISO 19160-1 / libaddressinput field set (`address_lines`, `dependent_locality`,
  `locality`, `admin_area`, `admin_area_code`, `postal_code`, `sorting_code`, `organization`,
  `language_code`), chosen because it maps one-to-one onto FHIR R4 `Address` and because a per-country
  pack already exists for it. `shared/address-formats/address-formats.v1.json` (250 countries, generated by
  `tools/generate_address_formats.py`) says which fields a country uses, requires and uppercases, what it
  calls each of them, the order it writes them in, and its postal-code pattern. A country the pack does not
  list falls back to a working form rather than an error. **No recipient field**: these are the addresses of
  facilities, and an attention line is where a person's name ends up.
- **Both runtimes, one behaviour** — `app/src/shared/address.ts` and `server/.../geo/address.py` are
  function-for-function equivalents, pinned against the same fixture
  (`shared/golden-datasets/address_reference.json`) in both suites.
- **Wire contract 2.0** — `canonical-event-2.0.schema.json` drops `state_code`/`district_code` for
  `country_code` + `admin_codes[{level, code, code_system}]` + `admin_path`. 1.0 and 1.1 are **withdrawn**:
  a producer on either is refused with its migration stated, rather than accepted into a shape this
  software no longer stores.
- **Scopes** — `national`/`state`/`district` are gone from storage; every row is `country` or
  `admin:<level>`. The old spellings remain *accepted on input* (`accepted_spellings`) so a saved link or a
  scripted call still resolves.
- **Roles and dashboards** — one `admin` dashboard and one `admin_officer` role, both taking their level
  from the viewer's own unit, replace the `state`/`district` pair that had identical capabilities and
  differed only in a level's name. Titles come from the country profile's label for that level.
- **Migrations** — `amrit_sites.0009`, `dashboards.0005`, `actionplans.0003`, `ecosystem.0003`, and the
  desktop app's schema version 4. Every one lifts before it drops, and reports what it could not resolve
  instead of guessing. An operator whose scope cannot be resolved sees **nothing** until someone links
  them: failing closed is recoverable, silently widening access is not.

#### Patients get a residence, not an address

A laboratory has an address. A patient has a *place*, and the two are not the same object — which is
why `patient_state` and `patient_municipality` were still sitting on `isolates` after the facility work
was done. Two free-text columns named after one country's tiers, and between them unable to record the
one sub-city geography almost every country shares and every clinic in a country writes identically:
the postal code.

`patient_residence` is the same field set minus the street:

| Kept | Why |
|---|---|
| `admin_area`, `locality`, `dependent_locality` | the place, in the country's own words, from the same pack |
| `postal_code` | the only sub-city geography that generalizes cleanly — by truncation |
| `admin_unit_id` / `admin_path` | the reporting unit, for scope filters and maps |

| Refused | Why |
|---|---|
| `address_lines`, `organization` | a street address is the strongest re-identifier a health record can carry, and a field that exists will be filled |
| `recipient` | same reason it is absent from facility addresses |

Three rules follow from that, and all three are tested rather than documented:

1. **Validation is weaker than for a facility, deliberately.** A country's `required` set is not
   enforced: a laboratory frequently does not know a patient's town, and refusing the record would lose
   the AST result along with the geography. A postal code that fails the country's pattern is dropped,
   and the isolate is still saved.
2. **Nothing leaves at full precision by default.** `privacy.patient_postal_code_digits` (default **3**,
   `0` drops the code) truncates the code in FHIR bundles and in CSV exports alike — a spreadsheet leaves
   the building as surely as a bundle does. Three characters de-identify a large-area code and pin a
   street in a small country, so the number is the deployment's to set, from the GUI.
3. **None of it reaches the portal.** The server stores aggregates only; its PII guard already refused
   `postal_code` and `address`, and now folds camelCase, so a FHIR-shaped `postalCode` no longer slips
   past a blocklist written in snake_case.

**Exit**: no schema, enum, wire field or UI control in either product names a country's administrative
tier; a patient's postal code can be captured in every country, under that country's own word for it;
nothing patient-level leaves the deployment un-coarsened; both suites green under IN and TESTLAND; the
address fixture produces identical output in both runtimes; `smoke_e2e.py` passes on a database migrated
from the previous schema.

---

## Risk ranking

| Phase | Risk | Why |
|---|---|---|
| 5 — Django scope + RBAC | **HIGH** | Touches every metric, dashboard, snapshot fan-out, and the single RBAC gate `scope_sites()`. A mistake silently widens or narrows data visibility. Requires the snapshot-parity harness before merge. |
| 3 — Seed split | Medium | Hash/version constants must move in lockstep across generator, loader, and asset; a mismatch hard-fails app startup by design. |
| 4 — Django geo app | Medium | Site-matching backfill may leave unmatched rows; must report, never guess. |
| 6 — Namespaces/branding | Medium | FHIR canonical URIs are wire-visible; India output must be byte-identical. |
| 8 — Wire contract | Medium | Deployed clients in the field; also carries the `AllowAny` security fix. |
| 9 — Locale semantics | Medium | Epi-week and fiscal-year changes alter reported numbers; needs golden tests before merge. |
| 6b — Profile admin GUI | Medium | Admin-supplied files and URLs reach FHIR output and rendered pages; the logo-upload and URL-validation rules are load-bearing, not hardening. Namespace edits are not fully reversible. |
| A — Repo separation | Medium | Mechanical, and the couplings are few (verified), but it touches every build path and the CI split. Do it first, with `git mv`, or pay for it twice. |
| 10 — Data licensing | Medium | Legal exposure rather than technical risk; blocks public distribution if unresolved. |
| 11 — Install/deploy | Medium | Broad surface, but failures are visible immediately rather than silent. |
| 1 — Electron tree | Medium | Schema migration on user machines, but purely additive and reversible. |
| 2, 7 — Electron surface, i18n | Low | High file volume, low semantic risk. |
| 0 — Profile registry | Low | Nothing consumes it yet. |
| 12 — Privacy/legal | Low (code) | Mostly policy; the erasure/audit-chain design is the one real engineering item and should be decided early. |

## Verification (end-to-end, after Phase 12)

Paths below are post-split (Phase A). Each product is verified **in isolation first**, then together.

```bash
cd app && pnpm install && pnpm run check && pnpm test && pnpm run build
```

```bash
cd app && AMRIT_COUNTRY_PROFILE=TESTLAND pnpm test
```

```bash
cd server/amrit_central_server && python manage.py migrate && python manage.py test
```

```bash
cd server/amrit_central_server && AMRIT_COUNTRY_PROFILE=TESTLAND python manage.py test
```

```bash
python tools/sync_shared.py --check
```

**Independent-distribution gate** — build each product in a checkout containing only that product plus
`shared/`, and confirm the artifact runs with the other product absent: the app captures and exports isolates
with no server configured; the server serves every dashboard from seeded data with no app connected.

**Cross-product contract gate** — with both running, `python server/amrit_central_server/smoke_e2e.py` must
pass registration, `/v1/poll`, `/v1/respond` and `/v1/heartbeat`, and a deliberate `shared/VERSION` mismatch
must produce a clear reported error rather than a silent mis-parse.

**The "any country" gate** — a parameterized test that, for every ISO 3166-1 country code, synthesizes a profile, validates it, builds the scope chain, and loads its ISO 3166-2 units. It must pass for all ~249 codes or name the exceptions explicitly (subdivision-less microstates).

**Manual gate, both profiles**: `bootstrap` → register a lab from the Electron app through the first-run wizard → capture isolates → run a live aggregate query from the server → export FHIR + GLASS/ANIMUSE/InFARM → confirm the drill-down chain renders every level for every role.

**Non-regression gate**: re-run the India profile against a **copy of a real populated India database** and diff every `KPISnapshot` and every emitted FHIR identifier against a pre-migration capture — that diff must be empty.
