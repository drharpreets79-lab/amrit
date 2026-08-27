# AMRIT Implementation Guide

Profiles, value sets and concept maps for the resources AMRIT emits from antimicrobial
resistance surveillance.

Two properties of this guide are worth stating before the profiles themselves:

**The value sets, concept maps and code systems are generated, not authored.** They come from
`shared/terminology/terminology-seed.v1.json` — the same file the exporter binds with — via
`tools/generate_ig_valuesets.py`, which has a `--check` mode that fails the build when the two
diverge. A guide that lists codes the software does not send is a published claim that fails on
contact, and this one cannot drift into that state without breaking CI.

**The canonical is `https://amrit.invalid` until a deployment publishes it.** `.invalid` is
reserved and can never resolve, so an unpublished guide cannot be mistaken for a published one.
A deployment sets its own canonical here and in `identifier_namespace.base_uri`; the runtime
stamps that same value into `meta.profile` on every resource it emits.

## What is coded, and what is not

264 of 399 catalogue antimicrobials carry a LOINC susceptibility concept, chosen by the method
that produced the result — an MIC and a disk diffusion of one drug are different concepts. The
remaining 135 have no LOINC concept and are exported with the WHONET coding alone, with a tag on
the bundle naming the reason. Quantities carry UCUM units; before this guide existed a bare
number made an MIC in mg/L and a zone diameter in mm indistinguishable.

SNOMED CT codes for organisms and specimens are emitted where the deployment's licence position
allows it, and omitted with a stated reason where it does not — never silently.

## Examples

Every profile in this guide has a worked example, and none of them was written by hand. They are
produced from the exporter itself by `app/scripts/generate-reference-corpus.ts`, which runs
`createExport` over three fixed isolates and writes both these examples and the reference corpus
the official HL7 validator checks in CI. The generator has a `--check` mode, so an example that
stops matching what the product emits fails the build rather than quietly becoming fiction.

The three isolates are chosen to cover the gaps as well as the happy path: one fully coded with
an ICD-10 diagnosis, one whose diagnosis is free text (emitted as `Condition.code.text` with no
coding, because free text must never become a code) and whose first agent has no LOINC concept,
and one coded in ICD-11 rather than ICD-10.

## Dependencies and global profiles

{% include dependency-table.xhtml %}

{% include globals-table.xhtml %}

## Cross-version analysis

{% include cross-version-analysis.xhtml %}

## Intellectual property

The guide itself is CC0-1.0. The vocabularies it binds to are not, and their terms differ:
LOINC, SNOMED CT, ICD-10, ICD-11 and UCUM each carry their own licence, recorded with the
deployment's position on each in `shared/DATA_LICENCES.md`.

{% include ip-statements.xhtml %}
