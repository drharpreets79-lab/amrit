# Bundled reference data and its licences

Every dataset this software ships or generates, what it is, and the terms it comes under.
This file is the human-readable record; `tools/check_data_licences.py` enforces that every
bundled asset carries a matching machine-readable entry, so a new dataset cannot be added
without appearing here.

Nothing in this list is patient data. The packaged catalogue is asserted PII-free at
generation time and again by the runtime loader.

## Summary

| Dataset | Where | Source | Terms | Ships in the installer |
|---|---|---|---|---|
| WHONET reference catalogue (organisms, antimicrobials, expert rules, expected resistance, MIC panels, code values, field definitions) | `app/resources/catalog-seed.v2.json` | WHONET / WHO Collaborating Centre for Surveillance of Antimicrobial Resistance | Distributed for AMR surveillance use | Yes |
| SNOMED CT concept codes on organism rows | `master_organisms.snomed_code` within the catalogue | SNOMED International | **Affiliate licence required** — see below | Yes |
| LOINC codes on antimicrobial rows | `master_antibiotics.loinc_sbt`, `.loinc_mlc` | Regenstrief Institute | Free to use with attribution and an accepted licence | Yes |
| ATC codes and defined daily doses | `master_antibiotics.atc_code`, AMC calculations | WHO Collaborating Centre for Drug Statistics Methodology | Free for non-commercial use; redistribution of the full index is restricted | Yes |
| WHO AWaRe classification | `master_antibiotics.who_aware` | World Health Organization | Published for public health use | Yes |
| ISO 3166-1 country list with WHO regions | `shared/country-profiles/reference/countries.json` | Derived from the country code set already in the WHONET catalogue | Country codes are not themselves copyrightable; the list is derived, not copied from the ISO standard | Yes |
| CLDR locale defaults (locale, direction, numbering system, time zones, week start, date order) | `shared/country-profiles/reference/countries.json` | Unicode CLDR, via the ICU data built into Node | Unicode Licence (permissive, attribution) | Yes |
| ISO 3166-2 country subdivisions | `shared/geo-packs/_iso3166-2.json` | ISO 3166-2, via the tables bundled with pycountry (Debian iso-codes) | **Requires an ISO licence** — see below | Yes |
| India administrative units (LGD codes) | `shared/geo-packs/IN.json` | Local Government Directory, Ministry of Panchayati Raj, Government of India | Administrative codes published for public administrative use | Yes |
| Google Address Data Service address formats | `shared/address-formats/address-formats.v1.json` | Google `libaddressinput`, via the `google-i18n-address` package | Apache Licence 2.0, attribution required | Yes |
| Postal codes, settlements and subdivision centroids | `shared/geo-directory/` | GeoNames | Creative Commons Attribution 4.0 | Yes |
| CLSI breakpoint tables | Not bundled | CLSI | **Paid standard.** Linked and importable only; never redistributed | No |
| EUCAST breakpoint tables | `app/resources/breakpoints/eucast-breakpoints.json` | EUCAST | Published free of charge; redistribution permitted with attribution | Yes |
| ICD-10 diagnosis starter value set | `app/resources/diagnosis-codes.v1.json` | World Health Organization | ICD is published freely; WHO retains copyright, attribution required | Yes |
| ICD-11 MMS starter value set (bundled subset) | `shared/terminology/icd11-mms.verified.json` | World Health Organization, via the WHO ICD API | **CC BY-ND 3.0 IGO** — attribution required, no derivatives; shipped as an unmodified selection | Yes |
| Genomic AMR marker catalogue | `app/resources/genomic-markers.v1.json` | Curated from published literature; marker names are nomenclature | Nomenclature and published findings | Yes |
| LOINC susceptibility concepts (bundled subset) | `shared/terminology/terminology-seed.v1.json`, `shared/terminology/loinc-abxbact.expansion.json` | Regenstrief Institute, retrieved from the HL7 public terminology server | Free to use under the LOINC licence, with attribution | Yes |
| ICD-10 categories from the WHO ICD API | `shared/terminology/icd10-who.verified.json` | World Health Organization, ICD API release 2019 | ICD is published freely; WHO retains copyright, attribution required | Yes |
| SNOMED CT descriptions for bundled catalogue concepts | `shared/terminology/snomed-catalogue.verified.json` | SNOMED International | **Licence required** — free in a Member country (India is one), affiliate licence elsewhere | Yes, gated |
| UCUM units on quantities | `shared/terminology/terminology-seed.v1.json` | Regenstrief Institute | Free and permissive; copyright notice retained | Yes |

## EUCAST breakpoints

EUCAST publishes its clinical breakpoint tables free of charge and permits redistribution
with attribution. That is why they ship with the installer and CLSI's do not: M100 is a paid
standard, so the application can only link to it and import a copy the laboratory already
licenses.

The bundled file is an extract of EUCAST's own published workbook, generated by
`tools/fetch_eucast_breakpoints.py`. No value in it is derived, interpolated or filled in;
where EUCAST states insufficient evidence, the row is absent rather than guessed. Footnote
superscripts are stripped from the run formatting rather than from the flattened text,
because a footnote read as a digit turns a 2 mg/L breakpoint into 21 mg/L.

Breakpoint Centre's update button refetches the current edition. What arrives is staged, not
activated: a table that has not been matched against the local antimicrobial and organism
catalogues never interprets a result.

Cite as: European Committee on Antimicrobial Susceptibility Testing. *Breakpoint tables for
interpretation of MICs and zone diameters.* https://www.eucast.org/clinical_breakpoints

## ICD-10 diagnosis codes

A small starter value set of WHO ICD-10 category codes for the infection syndromes AMR
surveillance reports on, seeded into the ordinary editable coded-value catalogue. It exists
so that diagnosis is recorded as a code rather than as free text, not so that a deployment
stops there — extend it, or replace it with a national value set or a licensed SNOMED CT
subset, in Master Studio under Coded values.

ICD is published by WHO and freely available for use. WHO retains copyright; a modified or
extended list must not be presented as the classification itself.

## ICD-11 MMS starter value set

The same clinical scope expressed in ICD-11 Mortality and Morbidity Statistics: 40 codes
covering the infection syndromes AMR surveillance reports on, plus WHO's `MG50`–`MG54`
antimicrobial-resistance findings, which are the part of ICD-11 that ICD-10 answers only
with its `U82`–`U88` supplementary codes.

These are **not transcribed**. `tools/fetch_icd11.py` reads them from WHO's own ICD API
(<https://icd.who.int/icdapi>, release 2026-01) and keeps only what WHO confirms twice:
that the code exists, and that WHO's own title for it carries the concept the code was
requested for. The display stored is WHO's title, never a string this repository typed. The
second check is not decoration — the first run of that tool accepted nine codes that exist
in ICD-11 and mean something else, including a "Shigellosis" candidate whose code is WHO's
category for other *Salmonella* infections.

**ICD-11 is published under CC BY-ND 3.0 IGO.** Attribution is required and derivative
works are not permitted. What ships is therefore a *selection* and never an edit: WHO's
codes and WHO's titles, subset but unmodified. A deployment needing a modified list must
take that up with WHO. The position is recorded as `code_systems.icd11` in the country
profile, so a deployment whose counsel objects to the no-derivatives terms can switch it
off and receive a stated reason rather than an empty result.

**No ICD-10 ↔ ICD-11 map is bundled.** WHO's API exposes no mapping endpoint between the
revisions, and the two classifications are not subsets of one another. A record states
which system its diagnosis code came from and the two are never silently interchanged;
inventing an equivalence would attach a guess to a patient's diagnosis.

Fetching requires WHO API credentials, which WHO issues free of charge on registration. A
checkout without them still builds: the seed reports zero ICD-11 concepts, which is a
visible absence rather than a silent one.

## SNOMED CT

The organism catalogue carries SNOMED CT concept codes.

**SNOMED CT requires a licence.** It is free to use in a SNOMED International Member
country or territory; elsewhere it requires an affiliate licence obtained from SNOMED
International. Member status is a property of the country, not of this software, and it
changes over time.

This software does not grant, include or imply any SNOMED CT licence. A deployment is
responsible for establishing its own position before relying on these codes.

The application surfaces this in its licences view rather than hiding it in a file, and the
profile records the position as `code_systems.snomed.licence` so a deployment can state
what applies to it. The codes are supplementary: WHONET codes are the primary organism
identifier throughout, so the application functions with or without SNOMED in use.

See https://www.snomed.org/get-snomed for current Member countries and licensing.

## ISO 3166-2

The subdivision pack reproduces subdivision codes and names from the ISO 3166-2 standard.
It is bundled under the deploying organisation's ISO licence.

A deployment that redistributes this software needs its own ISO licence for that data. The
pack is a separate file, so a deployment without one can remove
`shared/geo-packs/_iso3166-2.json` and import its administrative units instead; everything
else continues to work, and countries simply start with an empty tree as they did before.

`pycountry` is a build-time dependency of `tools/generate_iso3166_2_pack.py` only. The
generated pack is checked in, so pycountry is not distributed with either product.

## Google Address Data Service address formats

The address-format pack carries, for each country, the shape of a postal address: which
fields exist, which are required, what each is locally called, the order they are written
in, which are uppercased, and the postal-code pattern. It carries no personal data and no
place names — administrative units come from the ISO 3166-2 pack, and the two are joined
by ISO 3166-2 codes.

The dataset comes from Google's `libaddressinput` project under the Apache Licence 2.0,
which permits redistribution with attribution and the licence text. Attribution appears in
the licences view of both products.

`google-i18n-address`, which vendors the dataset, is BSD-3-Clause and is a build-time
dependency of `tools/generate_address_formats.py` only. The generated pack is checked in,
so neither the package nor its own data directory is distributed with either product.

## GeoNames postal codes and cities500 gazetteer

The geographic directory turns an address into a point on a map: 1,080,715 postal codes
across 121 countries, 235,285 settlements of 500 people or more across 246, and
population-weighted centroids for the ISO 3166-2 subdivisions the two can be matched onto.
One gzipped shard per country, about 21 MB in total, bundled in full so the software places
a facility with no network.

GeoNames publishes both datasets under **Creative Commons Attribution 4.0**, which permits
redistribution with attribution. The attribution — "Contains data from GeoNames
(www.geonames.org), CC BY 4.0" — appears in the licences view of both products.

Two limits a deployment should know about:

- **The United Kingdom extract carries Royal Mail copyright and database right**, and
  GeoNames supplies it without warranty of accuracy, timeliness or completeness. Canada,
  the Netherlands and the United Kingdom are present only as the first part of each code;
  Ireland, Malta, Chile, China, Argentina and Brazil are truncated for copyright reasons.
- **Coverage is not the world.** 121 countries have postal codes here; the rest resolve by
  settlement name and then by subdivision centroid. This is a property of the world, not of
  the dataset — roughly half the countries in ISO 3166-1 have no postal system.

The directory holds no personal data. It is applied to facilities only, never to a
patient's residence: resolving a coarsened patient postal code to a coordinate would undo
the coarsening that `privacy.patient_postal_code_digits` exists to apply.

## LOINC, and what "a subset" means here

Phase 22 bundles 917 LOINC concepts, not the LOINC release. They are the codes AMRIT actually
emits: the susceptibility concepts for the 264 catalogue antibiotics that have one, and the three
observation codes for organism identification, the susceptibility panel and the microbiology
report. They were retrieved from the HL7 public terminology server (`tx.fhir.org`) by
`tools/generate_terminology_seed.py`, which pins them by content hash and has a `--check` mode
that fails the build on drift.

**The catalogue's own LOINC columns are not used, and should not be.** `master_antibiotics`
carries `loinc_mlc` and `loinc_sbt` for 121 agents. They are valid LOINC codes for the wrong
things: MLC is minimum *lethal* concentration and SBT is serum bactericidal titer, while AMRIT
records minimum *inhibitory* concentration and disk diffusion. Binding a susceptibility result to
them would put a wrong code on every exported observation, which is worse than the missing code it
replaces. The row above them in the summary table is retained because those columns are still in
the bundled catalogue; nothing reads them.

**135 of 399 antibiotics have no LOINC susceptibility concept** and are exported with the WHONET
coding alone. They are listed, with the reason, in the `unmatched` section of the seed. A wrong
code is a defect and a missing one is a gap; this is the gap.

## SNOMED CT, and the thirteen codes that do not exist

Every SNOMED reference the WHONET catalogue carries was checked against a terminology server —
2,102 references, 1,960 distinct concepts. **2,089 resolve. Thirteen do not**, and AMRIT has been
emitting them on organism observations:

`Candida auris`, `Candida bracarensis`, `Candida carpophila`, `Candida duobushaemulonii`,
`Candida fabianii`, `Candida pseudohaemulonii`, `Candida pulcherrima`, `Candida utilis`,
`Cyberlindnera sp.`, `Wickerhamomyces sp.`, `Anaerococcus degeneri`, `Herbaspirillum sp.` and
`Arcobacter skirrowii`.

Most carry identifiers in the `…1000000000` extension range, which is a namespace an edition
assigns rather than a concept the International Edition contains. `Candida auris` is the one that
matters most: it is a WHO critical-priority pathogen, and a receiver resolving that code against
the International Edition gets nothing.

They are recorded in the seed's `rejectedSnomedCodes` and **not bundled**. The organism still
exports under its WHONET code, which is the primary identifier throughout; what it does not carry
is a SNOMED coding that would not resolve.

Descriptions are bundled only for concepts that resolve, and only because
`verify_snomed_codes.py` was run with `--include-displays`. They stay behind
`code_systems.snomed.enabled`: a deployment without a licence position switches SNOMED off and the
export says so rather than substituting another vocabulary.

## What is deliberately not bundled

- **CLSI M100 and the breakpoint tables.** A paid standard. The application links to CLSI
  and accepts an imported file; it never redistributes the tables.
- **GADM administrative boundaries.** Licensed for non-commercial use only, which is
  incompatible with an unrestricted installer. The administrative-unit importer accepts a
  GADM-derived CSV if a deployment chooses to prepare one; that is the deployment's
  decision and its licence obligation.

## Attribution

Where a licence requires attribution, the licences view names the source. Deployments that
redistribute this software should keep that view reachable.

## Adding a dataset

1. Add a row to the table above.
2. Add a `licences` entry to the asset itself, so the check can find it.
3. Run `python3 tools/check_data_licences.py`.

An asset without an entry fails the build. That is deliberate: an unlicensed dataset
discovered after distribution is far more expensive than one caught here.
