# Onboarding a country

What a ministry does to run AMRIT for a country the maintainers have never configured.
Nothing here requires a code change or a new release.

## The short version

Every ISO 3166-1 country already has a working profile: locale, script direction,
numbering system, time zone, date order and week start are synthesized from checked-in
reference data. Set the country, load or import its administrative units, set your
identifier namespace, and you are running.

## 1. Choose the country

Server:

```bash
docker compose exec web python manage.py bootstrap --country NGA \
  --admin-username admin --admin-password '<a long password>'
```

Desktop application: pick the country in **Deployment and country**, or set
`AMRIT_COUNTRY_PROFILE`.

The profile reports what it resolved. Check two things:

- **Administrative levels.** A synthesized profile starts with one generic level called
  "Administrative area". Rename it and add levels to match how your country is actually
  organised — province and district, governorate and district and subdistrict, state and
  LGA and ward. Up to six.
- **Time zone.** If your country spans several, the profile deliberately has no default and
  each site sets its own. A country-level guess would mis-stamp every observation near a
  day boundary.

## 2. Load the administrative units

If a pack ships for your country, `bootstrap` loads it. Otherwise prepare a CSV:

```csv
level,code,parent_code,name,name_local,unit_type
1,NG-LA,,Lagos,,state
2,NG-LA-IK,NG-LA,Ikeja,,lga
3,NG-LA-IK-1,NG-LA-IK,Ward 1,,ward
```

- `code` is what scoping matches on. Keep it ASCII and stable — a code that changes breaks
  every historical link to it.
- `name` may be in any script. Names are for people; codes are for the system.
- Every non-top-level row needs a `parent_code` that exists in the same file.

Then:

```bash
docker compose exec web python manage.py import_admin_units \
  --country NGA --name Nigeria --file units.csv \
  --level 1:state:State:States:ISO3166-2 \
  --level 2:lga:LGA:LGAs:GeoNames \
  --level 3:ward:Ward:Wards:GeoNames --dry-run
```

`--dry-run` validates and reports without writing. An orphan row is refused outright
rather than importing a broken tree.

A GeoNames `admin1Codes`/`admin2Codes` export maps onto these columns directly.

To ship the units with an installer instead, build a pack:

```bash
python3 tools/generate_geo_pack.py --country NGA --name Nigeria \
  --level 1:state:State:States:ISO3166-2 \
  --level 2:lga:LGA:LGAs:GeoNames \
  --source units.csv
python3 tools/sync_shared.py
```

## 3. Set your identifier namespace

Until you do, exports carry `https://amrit.invalid`, a reserved host that marks the
namespace as unset rather than borrowing another country's.

In **Deployment and country**, set the base URI to a host your ministry controls and the
URN prefix to something like `urn:health:ng:amr`.

**Do this before exporting anything.** Bundles already sent carry the previous system URIs
and cannot be recalled, so a later change leaves downstream consumers seeing two identifier
systems for one deployment. The application asks for explicit confirmation and records an
effective-from timestamp for exactly this reason.

## 4. Set the rest of the profile

All from **Deployment and country**, with no restart:

| Setting | Notes |
|---|---|
| Product name, authority, logo, colours | PNG, JPEG or WebP; SVG is refused, being an executable document rendered in the interface |
| Guideline body | CLSI or EUCAST. EUCAST is published free of charge; CLSI M100 is a paid standard |
| Epidemiological week | ISO-8601 or MMWR. They disagree, so a count filed under one and read under the other lands in the wrong week |
| Reporting year | The month your reporting year starts |
| Privacy | k-anonymity floor, retention, residency note |
| Map | Centre, zoom, and a tile URL you can reach |

The application id and code-signing identity cannot be changed here: they are fixed when
the application is built and signed. Export the profile and rebuild with it.

## 5. Register the first site

Give each site the server URL — and nothing else. In its Sync Centre the laboratory presses
**Request access**; you approve it under **Registry → Sites**, and the desktop then collects
its own bearer token. Until you decide, the site is told it is awaiting a decision rather than
that something is wrong.

Approving also issues that laboratory's **site token**, shown to you once. Send it to the site
administrator by a route other than the server — it is the factor that does not travel the
enrolment channel, and the laboratory cannot sync without it. See
[Deployment](DEPLOYMENT.md#the-two-credentials).

The request shows what the site claimed, and an approved site reports back what the server
stored, so a mistake is visible immediately rather than at the first report. If a laboratory
was configured with a different code from the one you registered — the case that shows up as
`HTTP 403 lab_code mismatch` — rename the site here rather than at the laboratory; see
[Deployment](DEPLOYMENT.md#when-the-codes-disagree).

A site records two different things about where it is, and they are stored separately
because they are frequently not the same place:

- **which reporting unit it is under** — a unit from the tree you loaded in step 2. Every
  scope filter, dashboard and metric groups by this.
- **its postal address** — the fields your country actually writes, in your country's
  order, with your country's names for them. Nothing to configure: the bundled address pack
  covers 250 countries, so the form shows an *emirate* in the United Arab Emirates, an
  *eircode* in Ireland, and no postal code at all where there is none. A territory the pack
  does not list still gets a working form rather than an error.

An address that does not match the country's rules is refused at entry — with the field
named — rather than stored in a shape that will never render.

### What is recorded about a patient's place

The isolate editor asks for the patient's town and postal code, under your country's own
names for them, from the same pack. It does **not** ask for a street address, and there is
nowhere to put one: a street address is the strongest re-identifier a health record can
carry, and AMR surveillance does not need it.

Before anything leaves the deployment — a FHIR bundle, a CSV export — the postal code is
truncated to the number of leading characters set in **Deployment → Privacy**
(`patient_postal_code_digits`, default 3; set 0 to drop it entirely). Pick this
deliberately: three characters de-identify a large-area code and pin a single street in a
small dense country. Nothing patient-level is ever sent to the central server, whatever this
is set to.

## Adopting another country's setup

A ministry that has configured a deployment can export its effective profile, and a second
deployment can adopt it. Build-time fields such as the application id are dropped on
import: they belong to the build that produced them.

## Checking your work

- Sign in and open **Open data and licences**. Note the SNOMED CT entry: it requires a
  licence outside a SNOMED International Member country, and this software grants none.
- Confirm the dashboards render and the drill-down shows your levels, not "State" and
  "District", unless those are your terms.
- Register a test site and run one query end to end.
- Take a backup and restore it into a scratch deployment.
