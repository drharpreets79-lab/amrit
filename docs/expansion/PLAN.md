# AMRIT Expansion Plan — Phases 16–34

> Continues the phase numbering of [`docs/globalization/PLAN.md`](../globalization/PLAN.md) (Revision 3),
> whose Phases A and 0–15 are complete. Four workstreams run in parallel from a shared prerequisite.
>
> **Prepared:** 14 August 2026 · **Scope decided by the owner on the same date** (see [Decisions](#decisions-taken)).

## What this plan delivers

1. **Five platforms.** iOS and Android join macOS, Windows and Linux — as full offline nodes, not as viewers.
2. **Standards compliance that a third party can check.** LOINC on every laboratory observation, ICD as a
   first-class coded diagnosis, a published AMRIT FHIR Implementation Guide, inbound HL7 v2.5.1 and FHIR from
   hospital LIS, and a terminology service behind all of it.
3. **A detector family, not a single algorithm.** SaTScan file/binary interoperability, SaTScan's other models,
   non-scan detectors (EWMA, CUSUM, Farrington/Noufaily, Bayesian spatial scan), and a new AMRIT detector
   designed to beat the workflow the field actually uses.
4. **Evidence.** Synthetic data with seeded outbreaks of known truth, a benchmark harness, and a
   pre-registered superiority test whose failure condition is written down before it runs.

---

## Verified starting state

Read from the tree on 14 August 2026, not from documentation.

| Area | State | Evidence |
|---|---|---|
| Desktop app | Electron 43, React 19, `node:sqlite`, 368 tests passing / 3 skipped | [`app/package.json`](../../app/package.json) |
| Build targets declared | mac (dmg, zip), win (nsis, portable), linux (AppImage, deb) | `app/package.json` → `build` |
| Build targets **exercised** | macOS only | `app/release/` holds mac output; no Windows or Linux artefact |
| Continuous integration | **none at all** | no `.github/` directory in the repository |
| Mobile | **none** | no Capacitor, React Native, Expo or Tauri dependency anywhere |
| Platform-neutral core | **does not exist** | 14 of 28 files in `app/src/main/` import `node:fs`/`node:path`/`node:os`; 4 import `electron`; `database.ts` and `decision-support.ts` bind `node:sqlite` directly |
| FHIR R4 export | Bundle with Organization, Patient, Specimen, Observation ×N, DiagnosticReport | [`app/src/main/services.ts:1404`](../../app/src/main/services.ts) |
| LOINC on FHIR output | **absent.** Organism observation is `code: { text: 'Organism identified' }`; AST observation is `system: 'urn:whonet:antibiotic-code'` | `services.ts:1441`, `services.ts:1466` |
| LOINC in the catalogue | `loinc_sbt` / `loinc_mlc` columns exist and are populated for **121 of 399** antibiotics; never read by any exporter | `app/resources/catalog-seed.v2.json`; `database.ts:286,654,973` |
| ICD | 34-code starter ICD-10 value set; `diagnosis_system`/`diagnosis_code`/`diagnosis_display` stored on isolates; **never exported** — no `Condition` resource in any bundle | [`app/resources/diagnosis-codes.v1.json`](../../app/resources/diagnosis-codes.v1.json); `database.ts:761` |
| HL7 v2.5.1 | ORU^R01 built by string concatenation; MSH/PID/PV1/SPM/OBR/OBX/NTE; export only, never validated against a conformance profile | `services.ts:1583–1620` |
| Inbound interoperability | **none.** No MLLP listener, no FHIR endpoint that accepts clinical data, no v2 parser | — |
| Terminology service | **none.** No `$lookup`, no `$translate`, no ValueSet expansion | — |
| Outbreak detection | Kulldorff space-time permutation scan statistic, both runtimes | [`app/src/main/outbreak-detection.ts`](../../app/src/main/outbreak-detection.ts) (477 lines); `server/amrit_central_server/analytics/outbreak_detection.py` |
| Other detectors | **none.** One method, no plug-in seam | — |
| SaTScan interoperability | **none.** No `.cas`/`.geo`/`.prm` writer, no output parser, no runner | — |
| Synthetic data | 4 sites × ~10,000 isolates × 2 years, organism-by-specimen mix, ward and city resistance gradients, real co-resistance | [`app/src/main/demo-population.ts`](../../app/src/main/demo-population.ts) |
| Seeded outbreaks in synthetic data | **none.** `grep -i outbreak demo-population.ts demo-seed.ts` returns nothing | — |
| Paper | Study B (SaTScan concordance + seeded-truth detection) already designed and awaiting execution | [`paper/AMRIT_paper_phasewise_plan.md:116`](../../paper/AMRIT_paper_phasewise_plan.md) |

---

## The request as stated, corrected

The instruction was "implement SaTScan **in addition to** the existing outbreak detection algorithm", and then
"prove the algorithm implemented here is better at detecting outbreaks than SaTScan."

Both need restating, because as written they are not achievable:

**AMRIT's existing algorithm already *is* SaTScan's algorithm.** `outbreak-detection.ts` implements Kulldorff's
space-time permutation scan statistic — the exact model WHONET drives SaTScan with, with the same
Monte-Carlo maximum-statistic correction, the same day-of-week stratification and the same recurrence
interval. `docs/OUTBREAK_DETECTION.md` says so in its first paragraph. So "add SaTScan" cannot mean "add the
scan statistic", and "beat SaTScan" cannot mean "beat this statistic with this statistic": two faithful
implementations of one method differ only by Monte-Carlo noise, and a claim of superiority over your own
reimplementation would be caught by the first reviewer who reads the Methods.

**What was decided instead** (owner, 14 August 2026):

| As stated | As scoped |
|---|---|
| "Implement SaTScan" | All three of: (a) SaTScan **file and binary interoperability** so a real head-to-head is possible; (b) **SaTScan's other models** that AMRIT does not have — Poisson, Bernoulli, purely temporal, purely spatial, space-time Bernoulli; (c) **non-SaTScan detectors** — EWMA, CUSUM, Farrington/Noufaily, Bayesian spatial scan |
| "Prove ours is better" | **Build a genuinely different detector first**, then test it against a pre-registered superiority endpoint on seeded truth, and report whatever the data says — including failure |

**The claim must also be stated precisely.** SaTScan can be *configured* to run the Bernoulli model, the
multivariate model, and adjustment for covariates. A claim of "better than SaTScan" in the abstract is
therefore false in the general case and will be treated as such. The defensible, testable, operationally
meaningful claim is:

> **Better than the WHONET–SaTScan workflow as the field actually runs it** — case-only space-time permutation,
> one stream per organism–antibiotic pair, a fixed recurrence-interval threshold — at matched empirical
> false-alert rate.

Every phase below is written to support that sentence and no stronger one.

---

## Decisions taken

| Question | Decision |
|---|---|
| Mobile architecture | **Capacitor, full offline node.** Extract a platform-neutral core; Capacitor wraps the existing React renderer; SQLite via a driver interface. A phone is a node, not a viewer. |
| SaTScan work | **All three** — interoperability, additional models, non-scan detectors |
| Superiority | **Build a better detector, then test it**, with a pre-specified failure condition |
| Standards depth | **All four** — fix and validate what exists, inbound as well as outbound, publish an AMRIT FHIR IG, and ship a terminology service |

---

## Dependency graph

```
                        ┌─────────────────────────────────────────┐
   Phase 16  CI ────────┤ blocks every release-producing phase    │
   (blocker)            └─────────────────────────────────────────┘
        │
        ├─── Track P ── 17 core/ ── 18 Android ── 19 iOS ── 20 mobile UX ── 21 five-platform release
        │                  │
        │                  └── (core/ also unblocks running detectors identically on mobile)
        │
        ├─── Track S ── 22 terminology ── 23 LOINC bindings ── 24 ICD ── 25 FHIR IG ── 26 inbound
        │
        ├─── Track D ── 27 detector framework ── 28 SaTScan interop ─┐
        │                        ├── 29 more scan models ────────────┼── 31 AMRIT detector (PACE)
        │                        └── 30 non-scan detectors ──────────┘
        │
        └─── Track E ── 32 outbreak-seeded synthetic data ── 33 benchmark harness ── 34 studies + report
                             │                                    │
                             └── needed by 31 and 33 ─────────────┘
```

Tracks P, S and D are independent after Phase 16 and can be staffed in parallel. Track E's Phase 32 should
start early — Phase 31's design work needs seeded truth to iterate against, and waiting for it serialises
the critical path.

---

# Track P — Platforms

## Phase 16 — Continuous integration and the build matrix

**Blocker for everything that produces an artefact. Nothing else in this plan should start first.**

The repository has no CI. Five platforms cannot be maintained by hand, and the existing three declared
targets are already unverified: macOS is the only one that has ever been built. A Windows-specific
`node:sqlite` failure, a path-separator bug or a case-sensitivity bug in the Linux build would not be
discovered until a user hit it.

**Work**

- `.github/workflows/` (or the chosen runner): matrix over `macos-latest`, `windows-latest`, `ubuntu-latest`.
- Per platform: `pnpm run check` (tsc + eslint, `--max-warnings=0`), `pnpm test`, `pnpm run build`,
  `electron-builder --dir`.
- Server job: Django test suite, `smoke_e2e.py`, `python -m pip audit`, OpenAPI diff.
- The existing gates run in CI rather than by hand: `tools/sync_shared.py --check`,
  `tools/check_country_neutral.py`, `tools/check_data_licences.py`.
- The **two-profile matrix** (IN and TESTLAND) that Phases 8–15 established runs on every commit, not
  occasionally. Phase 15's status note records three test files that silently inherited an ambient profile;
  CI is what stops that recurring.
- Artefact retention: unsigned installers per platform on every main-branch build, so a Windows regression is
  visible the day it lands.

**Windows specifically.** Verify before assuming: `node:sqlite` availability in the shipped Electron runtime
on Windows; `app.getPath` behaviour under a roaming profile; the geo-directory shard loader against 247 gzip
files on NTFS; long-path limits (`shared/geo-directory/` plus a deep user path can exceed 260 characters);
`electron-builder` NSIS output on an ARM64 Windows host. Code signing (EV or Azure Trusted Signing) and
macOS notarisation both need credentials — obtain them in this phase, not at release.

**Exit criteria** — green matrix on all three desktop platforms; installers produced and manually launched on
a clean Windows VM and a clean Linux VM; both test suites and every existing gate running on every commit;
signing credentials in the runner's secret store and a signed build verified by `signtool verify` /
`spctl --assess`.

**Duration** 1.5–2 weeks · **Risk** low technically, medium on credential procurement lead time.

---

## Phase 17 — Extract a platform-neutral `core/`

This is the largest engineering task in the plan and the one every mobile phase depends on.

**The problem.** `app/src/main/` is 14,730 lines carrying the entire domain: the database and its 40-odd
migrations, breakpoint interpretation, decision support, the analysis engine, the outbreak scan, the country
profile registry, geo packs, the geographic directory, One Health, exporters, validation, WHONET legacy
import. None of it is conceptually tied to Electron — but 14 files import `node:fs`, `node:path` or
`node:os`, 4 import `electron`, and `database.ts` constructs `new DatabaseSync(path)` from `node:sqlite`
directly at line 1142. On iOS and Android none of those modules exist.

**The shape.** Four narrow interfaces, one adapter per platform. Nothing else moves.

```
core/                     platform-neutral; no node:*, no electron, no DOM
  db/                     SqlDriver interface + migrations + every query
  domain/                 breakpoints, decision support, analysis, detection, profiles, One Health
  io/                     AssetSource interface (catalogue seed, geo packs, geo directory, licences)
  secrets/                SecretStore interface (credentials.ts today uses Electron safeStorage)
  paths/                  PathResolver interface (paths.ts today uses app.getPath)

adapters/electron/        node:sqlite · node:fs · electron safeStorage · app.getPath
adapters/capacitor/       @capacitor-community/sqlite · Capacitor Filesystem · Keychain/Keystore · app data dir
adapters/node/            node:sqlite · node:fs · file-backed secrets   (for tests and headless benchmarks)
```

**The four interfaces**

| Interface | Replaces | Notes |
|---|---|---|
| `SqlDriver` | `DatabaseSync` | Must expose `exec`, `prepare`/`run`/`all`, transactions, and `backup`. **The synchronous/asynchronous mismatch is the hard part**: `node:sqlite` is synchronous and `database.ts` is written synchronously throughout; `@capacitor-community/sqlite` is Promise-based. Resolve this deliberately — see risk below. |
| `AssetSource` | `readFileSync(resolveResourcePath(...))` | Catalogue seed, diagnosis codes, geo packs, 247 gzip geo-directory shards, country profiles, licences. On mobile these are bundled assets read through Capacitor, and gzip must be decompressed in JS rather than by `node:zlib`. |
| `SecretStore` | `credentials.ts` (Electron `safeStorage`) | iOS Keychain, Android Keystore, Electron safeStorage, encrypted file for headless. |
| `PathResolver` | `paths.ts` (`app.getPath`) | Database location, backup location, export destination, log location. |

**The synchronous/asynchronous decision.** Three options, and it must be chosen before any code moves:

1. **Make `core/` async throughout.** Correct, portable, and a mechanical but very large diff across
   `database.ts` (4,395 lines) and every caller. Highest one-time cost, lowest long-term cost.
2. **Use a synchronous SQLite on mobile too** — a WASM SQLite (`wa-sqlite`/`sql.js`) over a synchronous VFS,
   or a small native plugin exposing synchronous bindings. Keeps the diff near zero; adds a WASM runtime,
   a persistence story (OPFS is not available inside a Capacitor WebView the way it is in a browser) and a
   performance question on 10,000-row analytics.
3. **Async seam at the repository boundary only** — keep `database.ts` synchronous internally, run it in a
   worker, and make the seam async. Smallest diff, but a worker on iOS with a WASM database has the same
   persistence question as option 2 plus a serialisation cost.

**Recommendation: option 1.** It is the only one that does not add a second SQLite implementation to
maintain and test. Budget it honestly: this is the phase, not a detail inside it.

**Constraint.** The extraction must be behaviour-preserving. The 368 existing desktop tests are the proof —
they run unchanged against `adapters/node/`, with no test rewritten to accommodate the move. A test that has
to change to keep passing is a behaviour change, and it must be justified in writing or reverted.

**Exit criteria** — `core/` imports nothing from `node:*`, `electron` or the DOM, enforced by an ESLint
`no-restricted-imports` rule that fails the build; all 368 app tests pass unchanged through
`adapters/node/`; the Electron app runs on all three desktop platforms with `adapters/electron/` and
produces byte-identical FHIR, HL7, WHONET and Measure exports for a fixed corpus (a golden-output test
pinning this is part of the phase); the detection engine runs identically under `adapters/node/` for the
benchmark harness Track E needs.

**Duration** 5–7 weeks · **Risk HIGH** — largest diff in the plan, touching the file every other file depends on.

---

## Phase 18 — Android

**Work**

- Capacitor 7 project (`mobile/`), Android target, the existing renderer built to a web bundle.
- `adapters/capacitor/` completed against `core/`'s four interfaces.
- Bundle the resource payload: catalogue seed, geo packs, geo directory. **Size is the immediate problem** —
  the geo directory alone is 21.4 MB across 247 shards. Ship the base country's shard plus the ISO 3166-2
  pack in the APK; fetch the rest on demand, cache them, and degrade honestly (postal lookup unavailable,
  never silently wrong) when offline and absent.
- Android App Bundle build in the Phase 16 matrix; Play internal testing track.
- Database at rest: SQLCipher or Android's file-based encryption, decided against the deployment's own
  policy — a phone is lost far more often than a desktop, and it carries patient-level records.

**Exit criteria** — install from a Play internal-testing build on a physical Android 13+ device; complete a
full offline capture → interpretation → local outbreak scan → export cycle with no network; the two-profile
test matrix passes against `adapters/capacitor/` in an emulator; database file confirmed encrypted at rest;
a device with the application uninstalled leaves no readable record behind.

**Duration** 3–4 weeks after Phase 17 · **Risk** medium.

---

## Phase 19 — iOS

Same core, different constraints, and the constraints are where the time goes.

- Xcode project via Capacitor; iOS 16+ target.
- **Privacy manifest** (`PrivacyInfo.xcprivacy`) declaring required-reason API use — file timestamp, disk
  space, user defaults are all in the required-reason list and Capacitor's own plugins use several.
- Keychain-backed `SecretStore`; Data Protection class chosen explicitly (`NSFileProtectionComplete` means
  the database is unreadable while the device is locked — verify the app's background behaviour survives it).
- App Store Connect, TestFlight, and the review conversation. A microbiology surveillance application
  handling patient records will draw questions under the health-data guidelines. Prepare the answer before
  submitting: what is stored, where it goes, and that nothing leaves the device except aggregate counts.
- On-device storage limits and the "offloaded app" behaviour must not lose the database.

**Exit criteria** — TestFlight build installed on a physical iPhone and iPad; the same full offline cycle as
Android; privacy manifest complete and accepted; App Store review passed or its objections documented with a
remediation plan; the database confirmed unreadable with the device locked.

**Duration** 3–4 weeks after Phase 17 (partly parallel with Phase 18) · **Risk** medium-high — App Store
review is an external dependency with an unpredictable tail.

---

## Phase 20 — Mobile as a first-class surface

Making the desktop UI *run* on a phone is Phase 18. Making it *usable* on a phone is this phase, and it is
not optional: a laboratory technician entering an isolate on a 6-inch screen with gloves on is a different
user from an analyst with a mouse.

**Work**

- Responsive pass over 13 pages and 13 components. `RecordsPage`, `IsolateEditor`, `MasterStudioPage` and
  `DataTable` are the hard ones — wide tables and dense forms.
- Touch targets, keyboard-avoidance, and a capture flow that works one-handed.
- **Barcode/QR capture** for specimen numbers and lab codes. This is the feature that makes a phone better
  than a desktop for capture rather than merely equal, and it removes the transcription error that
  `validation.ts` currently has to catch.
- Biometric/PIN lock on resume; configurable idle timeout.
- Background sync with the existing aggregate-only outbox, respecting platform background-execution limits.
  **The privacy boundary does not move**: the outbox still carries counts, never records.
- Analytics and the outbreak scan on a phone: run them, but bound them. 999 Monte-Carlo replications over a
  year of data is a real CPU cost on a mid-range Android device. Measure it, offer a lower default on
  battery, and never silently reduce replications without saying so in the result.

**Regulatory question to settle in this phase, not later.** `decision-support.ts` performs breakpoint
interpretation, which on a desktop reads as laboratory software and on a phone at the bedside can read as
clinical decision support. Whether that changes the product's classification under EU MDR, India's CDSCO
rules or the US FDA's clinical-decision-support guidance is a question for counsel, and the answer shapes
the UI. The conservative position — surveillance and laboratory interpretation only, no individual treatment
recommendation, stated in the interface — is what the code does today and should be documented as a
deliberate boundary rather than an accident.

**Exit criteria** — every page usable at 375 × 667 without horizontal scroll; capture flow completed
one-handed on a physical device by someone who did not write it; barcode capture round-trips a real
specimen label; scan runtime measured and published for a reference device; regulatory position recorded in
`app/docs/PRIVACY_AND_SAFETY.md` with a date and a named decision-maker.

**Duration** 3–4 weeks · **Risk** low-medium.

---

## Phase 21 — Five-platform release engineering

- Signing and notarisation for all five: macOS (Developer ID + notarytool), Windows (EV/Azure Trusted
  Signing), Linux (repository signing), Android (Play App Signing), iOS (App Store).
- Update channels: `electron-updater` for desktop, store update for mobile, and — because many deployments
  are air-gapped — a documented offline update path for all five.
- A single release runbook and one version number across every artefact.
- **Schema compatibility across platforms.** A user capturing on Android and analysing on Windows must have
  the same database schema and the same migration path. Add a cross-platform round-trip test: create on one
  platform, back up, restore on another, verify byte-identical exports.
- Version-skew policy: what happens when a phone on version *n* syncs to a server on version *n−1*.

**Exit criteria** — a single tagged commit produces signed artefacts for all five platforms from CI;
cross-platform backup/restore round-trip verified in both directions between desktop and mobile; offline
update path documented and tested; `docs/globalization/DEPLOYMENT.md` extended to cover mobile deployment.

**Duration** 2–3 weeks · **Risk** medium.

---

# Track S — Standards

## Phase 22 — Terminology service and code-system ingestion

Everything in this track needs one thing first: a place where a code system lives, with its version, its
licence and its lookup.

**Work**

- `core/terminology/`: `CodeSystem`, `ValueSet`, `ConceptMap` storage in the existing SQLite schema, with
  version and provenance hash — the same pattern `breakpoint-mapping.ts` already uses for guideline sets.
- Operations: `$lookup`, `$validate-code`, `$translate`, `ValueSet/$expand`. Exposed locally to the app and
  over HTTP from the server, so an external system can validate against the same tables the exporter uses.
- Ingestion tooling in `tools/` for each system, following the existing `generate_catalog_seed.py` pattern:
  content hash, row counts, a `--check` mode that fails the build on drift.
- **Licence gating per code system**, extending the mechanism Phase 10 built (`shared/data-licences.json`,
  `tools/check_data_licences.py`). This is not optional and it differs sharply by system:

| System | Redistribution position | Consequence for the plan |
|---|---|---|
| **LOINC** | Free; requires acceptance of the LOINC licence and attribution; redistribution permitted under its terms | Can bundle. Record the terms and surface them in the licences view, as Phase 10 established. |
| **ICD-10** | WHO; free for non-commercial use, permission-based redistribution | Verify the current terms before bundling. If unclear, ship as a downloadable pack rather than in the installer. |
| **ICD-11 MMS** | CC BY-ND 3.0 IGO for the linearisation | Bundleable **with attribution and no derivatives** — the no-derivatives clause means a curated subset must be shipped as a *selection*, not as a modified table. |
| **ATC/DDD** | WHO Collaborating Centre; **redistribution restricted** | The catalogue already carries `atc_code` per antibiotic. Keep the codes as references; do not bundle the ATC index. |
| **UCUM** | Free, permissive | Bundle. |
| **SNOMED CT** | Already decided in Phase 10 — ships enabled with a licence notice; this software grants no SNOMED licence | Unchanged. |
| **HL7 terminology** (`terminology.hl7.org`) | Free | Bundle. |

**Exit criteria** — every system above either bundled with its terms recorded in `shared/data-licences.json`
and surfaced in both products, or explicitly deferred with the reason written down; `$lookup`, `$translate`
and `$expand` covered by tests in both runtimes; `tools/check_data_licences.py` passing with the new entries;
a deployment can disable any single code system and the application degrades honestly rather than crashing.

**Duration** 3–4 weeks · **Risk** medium — the licence work is slower than the code.

---

## Phase 23 — LOINC bindings on every laboratory output

**The gap.** The FHIR exporter emits `code: { text: 'Organism identified' }` for the organism observation and
a local `urn:whonet:antibiotic-code` for each susceptibility observation. Neither is interoperable: a
receiving system cannot tell what was measured without reading the display text. LOINC codes for exactly
these observations already sit unused in the catalogue for 121 of 399 antibiotics.

**Work**

- **Complete the antibiotic LOINC coverage.** 278 of 399 antibiotics have no `loinc_sbt`/`loinc_mlc`. LOINC
  carries a susceptibility code per antibiotic per method; map the remainder from the LOINC release ingested
  in Phase 22, and leave genuinely uncoded agents uncoded rather than guessing — an incorrect LOINC code is
  worse than an absent one.
- **Bind AST observations**: `Observation.code` gets the LOINC susceptibility code for the agent and method
  (`loinc_sbt` for disk diffusion / `loinc_mlc` for MIC — the two columns exist because the codes differ),
  keeping the WHONET code as a second `coding` entry. Both, not either: the WHONET code is the reason a
  WHONET user can read the output.
- **Bind the organism observation**: LOINC for the culture observation, with the organism as
  `valueCodeableConcept` — SNOMED where licensed, WHONET code always.
- **Bind the specimen**: LOINC specimen codes on `Specimen.type` alongside the existing WHONET specimen code.
  The catalogue has 8 samples and 38 aliases; map each.
- **Bind the report**: `DiagnosticReport.code` LOINC, replacing today's free-text
  `'Microbiology culture and antimicrobial susceptibility'`.
- **`valueQuantity` gets real units**: MIC in mg/L and zone diameter in mm, coded in UCUM. Today
  `valueQuantity: { value: numeric }` has no unit at all, which makes an MIC and a zone diameter
  indistinguishable to a receiver.
- Mirror all of it in the HL7 v2 exporter: OBX-3 carries LOINC in the alternate identifier triplet, OBX-6
  carries UCUM units.
- Terminology binding must be **profile-aware**: a deployment without a LOINC licence acceptance gets the
  WHONET coding only, and the export says so rather than silently dropping the standard coding.

**Exit criteria** — every `Observation`, `Specimen` and `DiagnosticReport` in a generated bundle carries a
LOINC coding or a recorded reason it cannot; MIC and zone-diameter values carry UCUM units and are
distinguishable; the official HL7 FHIR validator reports zero errors on terminology binding for a reference
corpus; a golden-output test pins the coded bundle so a catalogue change cannot silently alter it.

**Duration** 3–4 weeks · **Risk** medium — the mapping work is detailed and each wrong code is a defect.

---

## Phase 24 — ICD as a first-class coded diagnosis

**The gap.** 34 ICD-10 category codes ship as a starter set; the isolate table has
`diagnosis_system`/`diagnosis_code`/`diagnosis_display`; and none of it reaches any export. There is no
`Condition` resource in any bundle.

**Work**

- Ingest full ICD-10 and the ICD-11 MMS linearisation through Phase 22's tooling, subject to that phase's
  licence findings. Keep the starter set as the *default value set*, not as the *only available codes* —
  the existing design note in `diagnosis-codes.v1.json` already anticipates this and should be honoured.
- A `ConceptMap` between ICD-10 and ICD-11 for the infection syndromes AMR surveillance reports on, so a
  deployment on either standard can produce output in the other.
- Emit `Condition` in the diagnostic bundle, referenced from `DiagnosticReport.encounter`/
  `Observation.focus` as appropriate, with the code system taken from the stored `diagnosis_system` — the
  field already exists precisely so several standards can coexist.
- Capture side: the diagnosis picker searches the full ingested system with the starter set surfaced first;
  free-text diagnosis remains possible but is stored as text, never silently coerced into a code.
- HL7 v2: DG1 segment carrying the coded diagnosis.
- GLASS alignment: check the diagnosis mapping against the GLASS infection-origin and specimen categories the
  existing exporters already produce, so the two do not disagree.

**Exit criteria** — a bundle from a record with a coded diagnosis contains a valid `Condition`; ICD-10 and
ICD-11 both round-trip; the ConceptMap is tested in both directions; free-text diagnosis is never emitted as
a code; the diagnosis picker performs acceptably against the full system on a mobile device (this is a
~70,000-row search on a phone — measure it).

**Duration** 2–3 weeks · **Risk** low-medium.

---

## Phase 25 — The AMRIT FHIR Implementation Guide

Compliance that no third party can check is an assertion. This phase makes it checkable.

**Work**

- Author profiles for every resource AMRIT emits: `AmritOrganization`, `AmritPatient`, `AmritSpecimen`,
  `AmritOrganismObservation`, `AmritSusceptibilityObservation`, `AmritDiagnosticReport`, `AmritCondition`,
  `AmritMeasure`, `AmritMeasureReport`. Derive from international base profiles rather than inventing:
  where an existing IG covers the ground (the AMR/AU reporting work, the laboratory report profiles), derive
  from it and say so.
- ValueSets and ConceptMaps published as part of the IG, generated from the Phase 22 tables so the IG and
  the runtime cannot drift.
- `CapabilityStatement` for the server's FHIR endpoints, including the inbound endpoints Phase 26 adds.
- Author in FHIR Shorthand (FSH/SUSHI), publish with the HL7 IG Publisher, host the output.
- **The official HL7 FHIR validator runs in CI** against a reference corpus, and zero errors is a merge gate.
  This is the single most valuable line in this phase: it converts "we support FHIR" into a build that fails
  when we stop.
- `meta.profile` stamped on every emitted resource so a receiver knows what to validate against.

**Exit criteria** — IG builds clean with the HL7 IG Publisher, zero errors and a reviewed warning list;
official validator green on the reference corpus in CI; published IG reachable at a stable URL; every emitted
resource carries `meta.profile`; the IG's ValueSets are generated from the same tables the exporter reads.

**Duration** 4–5 weeks · **Risk** medium — IG Publisher and terminology-server dependencies are fiddly.

---

## Phase 26 — Inbound: HL7 v2.5.1 and FHIR from the LIS

This is the gap the WHONET literature names most often — Aboushady and colleagues' systematic review lists
limited LIS interoperability as a recurring barrier across 511 studies. Export solves half of it. A
laboratory that must retype results into a second system will not sustain surveillance.

**Work**

- **MLLP listener** accepting ORU^R01 over TCP, with the framing, ACK/NACK and sequence-number handling the
  standard requires. Runs in the desktop node (where the LIS is), not centrally.
- **v2 parser** for MSH/PID/PV1/SPM/OBR/OBX/NTE/DG1, tolerant of the real-world variation that makes v2 v2:
  segment ordering, Z-segments, local coding systems, missing optional fields.
- **FHIR ingest**: `POST [base]/Bundle` accepting a transaction or collection bundle, validated against the
  Phase 25 profiles before anything is written.
- **Terminology reconciliation**: incoming local codes are mapped through Phase 22's `ConceptMap`s to the
  WHONET code space. Unmapped codes go to a **quarantine** queue for a human, they are never guessed, and a
  record with an unmapped organism is not silently dropped.
- **Deduplication and reconciliation** against records already captured: same patient, same specimen, same
  date arriving twice must merge, not duplicate, and the merge must be auditable.
- **Security.** An inbound network listener is a new attack surface on a machine holding patient records.
  Bind to loopback or an explicit allowlisted interface by default, require mutual TLS or a pre-shared
  credential, rate-limit, cap message size, and fuzz the parser. Off by default; a deployment turns it on
  deliberately. The Phase 11 finding — that three insecure defaults shipped and had to be corrected — is the
  precedent: this listener must be secure-by-default from its first commit.
- **The privacy boundary is unchanged.** Inbound patient-level data lands in the local node only. The
  federation outbox still carries aggregates, and `pii_guard.py` still refuses anything else.

**Exit criteria** — a real or simulated LIS sends an ORU^R01 and the isolate appears with correct
interpretation; malformed and hostile messages are rejected with a correct NACK and never crash the listener;
unmapped codes quarantine rather than corrupt; duplicate arrival merges auditably; the listener is off by
default and refuses to start without a credential; a fuzz run over the parser finds no crash; the aggregate
outbox is unchanged, proven by the existing PII guard tests.

**Duration** 4–6 weeks · **Risk HIGH** — inbound parsing of a permissive standard plus a network listener on
a clinical machine is the highest-risk surface in this plan.

---

# Track D — Detection

## Phase 27 — Detector framework

Today there is one algorithm and no seam. Everything else in this track needs the seam first.

**Work**

- A `Detector` interface in `core/detection/`: takes case events plus optional denominators, returns signals
  in a common shape, declares its own parameters and its own requirements (does it need denominators? does it
  need coordinates?).
- The existing STPSS becomes `SpaceTimePermutationDetector`, registered rather than hardcoded, with
  **byte-identical output** to today for the same input and seed. A parity test pins this; it is the control
  arm of every comparison that follows.
- Mirror the framework in the Python runtime so the portal can run the same detectors, and add a
  cross-runtime parity test on a shared fixture — the pattern Phases 9, 13 and 14 already use for epi weeks,
  addresses and geocoding.
- **A denominator model.** Every model beyond case-only needs one, and AMR has good ones the case-only
  method throws away: isolates tested for that organism–agent pair (the natural Bernoulli denominator),
  specimens processed, admissions, patient-days. Define which are derivable from the existing schema
  (isolates-tested certainly is) and which need new capture (patient-days do).
- Deterministic seeding across every detector, so a benchmark is reproducible.
- UI: the Analytics page gains a detector selector and shows which detector produced each signal. A signal
  without its method attached is not interpretable.

**Exit criteria** — STPSS output byte-identical before and after the refactor across the existing test
corpus; TypeScript and Python detector registries agree on a shared fixture; denominator derivation tested;
adding a detector requires no change to the calling code.

**Duration** 2–3 weeks · **Risk** low.

---

## Phase 28 — SaTScan interoperability

> **Rescoped, 14 August 2026 (owner).** SaTScan has left the critical path. Nothing in this plan or in the
> paper now depends on running it, and no exit criterion is blocked on it. The reason is not that the
> comparison was unimportant — it is that the comparison is now available from software that runs
> everywhere. AMRIT implements SaTScan's model set natively (Phase 29) and the external validation those
> models needed is supplied by published R reference packages, which are free, open-source, cross-platform
> and installable by any reviewer. SaTScan is a Windows-first binary that would not run on the owner's
> machine, cannot be redistributed, and would have made every headline claim in this repository depend on
> a reviewer obtaining a copy.
>
> **What survives:** the bridge itself, as optional interoperability, because it is built, tested and useful
> to a surveillance unit that already runs SaTScan. Deleting working code that costs nothing to keep would
> destroy value for those deployments.
>
> **What is withdrawn:** the round-trip exit criterion, and Study B arm 1's dependence on SaTScan. Withdrawn
> rather than waived — a criterion nothing depends on should be removed, not marked as permanently
> outstanding.

Not a reimplementation — a bridge, so a deployment that already trusts SaTScan can keep using it.

**Work**

- **Writer**: emit SaTScan's input formats from AMRIT's case events — `.cas` (case file), `.ctl` (control
  file for Bernoulli), `.geo` (coordinates), `.pop` (population), and a `.prm` parameter file whose settings
  correspond exactly to the AMRIT settings that produced it.
- **Runner**: optionally invoke a **user-supplied** SaTScan batch executable. SaTScan is free but its
  redistribution terms do not permit bundling; the operator installs it and points AMRIT at it. Absent
  binary is a clean unavailable state, never a crash.
- **Parser**: read SaTScan's `.txt` and `.col`/`.gis` output back into the common signal shape, so
  SaTScan's results appear in the same UI and the same exports as AMRIT's.
- **Concordance harness**: run both on identical input and report cluster matching (identical location set,
  overlapping window), log-likelihood-ratio agreement by Spearman ρ and Bland–Altman, and p-value and
  recurrence-interval agreement across ten Monte-Carlo runs. This is Study B arm 1 from the paper plan,
  implemented as code rather than as a one-off.
- Record the SaTScan version at run time, as the paper plan requires.

**Exit criteria (as rescoped)** — writers and parsers verified against SaTScan's published documentation;
the concordance harness produces the arm-1 table from one command *when a binary is present*; a missing
SaTScan binary degrades cleanly and still writes the input files; the `.prm` file demonstrably encodes the
same parameters the AMRIT run used; **no SaTScan binary or source is committed to this repository**.

**Withdrawn** — "round-trip works against a real SaTScan installation". No claim depends on it.

**Duration** 2–3 weeks · **Risk** low-medium — depends on an external binary's output format staying stable.

---

## Phase 29 — SaTScan's other models, natively

AMRIT has one of SaTScan's models. These are the ones it does not have, and one of them matters more for AMR
than the one it has.

| Model | Why it matters for AMR | Denominator needed |
|---|---|---|
| **Space-time Bernoulli** | **The important one.** Cases = resistant isolates, controls = susceptible isolates of the same organism–agent pair. Immune to testing-volume changes, and — unlike the case-only permutation — it *can* see a uniform system-wide rise in resistance, which `OUTBREAK_DETECTION.md` correctly lists as the current method's blind spot | Isolates tested (already derivable) |
| **Space-time Poisson** | Rate per population at risk, for a deployment that has patient-days or admissions | Patient-days / admissions (new capture) |
| **Purely temporal** | A single-location laboratory — a very common AMRIT deployment — cannot use any space-time model. Today those sites get the category-time substitute only | Either |
| **Purely spatial** | Retrospective: which wards carry excess resistance overall, independent of time | Either |
| **Multivariate / multiple data streams** | Several organism–antibiotic streams evaluated jointly rather than one at a time | **Patient-level isolates**, not "either" — see the correction below |

**Work** — implement each against the Phase 27 interface, in both runtimes; validate each against a
**published reference implementation**; document each model's assumptions and blind spots as candidly as
`OUTBREAK_DETECTION.md` does today.

**The reference is R, not SaTScan (rescoped 14 August 2026).** The scan statistics have open-source
reference implementations that run on every operating system and that any reviewer can install in one
command: `SpatialEpi::kulldorff` and `smerc` for the spatial Poisson and Bernoulli scans,
`scanstatistics` for the space-time family, alongside `surveillance` which Phase 30 already validates
Farrington against. These are better comparators than SaTScan for this repository's purpose, not merely
available ones: a concordance claim a reader can reproduce is worth more than one resting on a binary they
must request.

**Corrected during execution.** Two rows of the table above were wrong and the tracker records why.
The multivariate model needs patient-level isolates rather than "either" denominator, because
SaTScan's independent-stream null does not hold for agents of the same organism — on a corpus with no
outbreak in it, that null alerted at the p-value floor — and the isolate-permutation null that replaces
it has to move whole isolates. It also cannot be validated through the bridge, because SaTScan's
multivariate model assumes an independence these data do not have, so the two are not computing the
same statistic. The Poisson model is implemented and no deployment can feed it: nothing in AMRIT
captures patient-days, and capture is not in this phase.

**Exit criteria** — each model's log-likelihood ratios agree with a published reference implementation
within Monte-Carlo tolerance on a shared fixture; every model documented with its denominator requirement and
its failure mode; a single-location deployment gets a working purely-temporal scan.

**Duration** 4–5 weeks · **Risk** medium — Bernoulli and Poisson likelihood implementations must be exactly
right, and "exactly right" is what the Phase 28 bridge verifies.

---

## Phase 30 — Non-scan detectors

Scan statistics are one family. Public-health surveillance uses others, and a comparison confined to one
family is not a comparison.

| Detector | Provenance | Role here |
|---|---|---|
| **EWMA** | Standard statistical process control; used in hospital infection surveillance | Fast temporal detector, low latency, per stream |
| **CUSUM** — including a resistance-**proportion** CUSUM | Standard SPC; proportion variant is the natural AMR form | Sensitive to sustained small shifts, which is exactly what creeping resistance is |
| **Farrington / Noufaily** | The algorithm ECDC and UKHSA actually run in routine aberration detection | The strongest non-scan comparator, and the one a European reviewer will ask about by name |
| **Bayesian spatial scan (BSS)** | Neill et al. | Posterior probability of an outbreak rather than a p-value; gives calibrated evidence for ranking |

**Work** — implement in `core/detection/`, mirrored in Python; each with its own parameter documentation and
failure modes; each in the Phase 33 benchmark harness on the same footing as the scan statistics; UI exposes
them with an honest description of what each is and is not for.

**Exit criteria** — each detector validated against a published reference implementation or a worked example
from its source paper (`surveillance` R package for Farrington/Noufaily is the practical reference); all run
in the benchmark harness; documentation states each one's blind spot.

**Corrected during execution.** The `surveillance` R package was available and was used, so Farrington is
validated against the reference implementation itself rather than a worked example — every alarm, every
trend decision and every threshold, in both runtimes. The other three have no reference package in
comparable use and are pinned against worked examples from their source papers; the two claims differ in
strength and the documentation says so rather than flattening them. Noufaily 2013's ten-level seasonal
model is **not** implemented and is not claimed: two of its self-contained changes are settings on the
Farrington 1996 implementation. Farrington needs five years of history and cannot run on any corpus this
repository currently generates, which is a Phase 33 problem recorded now.

**Duration** 4–5 weeks · **Risk** medium.

---

## Phase 31 — The AMRIT detector

The phase the superiority claim rests on. Read this section before agreeing to the claim.

### Why the current workflow loses power on AMR data

Four specific, fixable weaknesses in what `outbreak-detection.ts` does today — which is also what the
WHONET–SaTScan workflow does:

1. **Per-agent fragmentation.** `seriesFromEvents` (`outbreak-detection.ts:332`) builds one stream per
   `R:ORG:AB`. A carbapenemase-producing *K. pneumoniae* clone appears as three separate streams —
   `R:KPN:MEM`, `R:KPN:IPM`, `R:KPN:ETP` — each holding roughly a third of the evidence, and each then
   corrected against the Monte-Carlo maximum over *all* streams. That is a double penalty: evidence split,
   multiplicity inflated. For a clonal outbreak, which is the case infection control cares about, pooling
   mechanistically linked agents into one phenotype stream is strictly more powerful.
2. **Denominator blindness.** The case-only design conditions on both margins, which buys immunity to
   reporting-effort artefacts and pays for it with blindness to a uniform rise. `OUTBREAK_DETECTION.md:91`
   states this honestly. AMR has a denominator that plain case surveillance lacks — isolates *tested* — and
   discarding it is a choice inherited from a method designed for a setting where no denominator existed.
3. **A nominal threshold, not a measured one.** Alerting at recurrence interval ≥ 365 days assumes the null
   the permutation generates matches the site's real baseline. Ward-level clustering, seasonality and
   overdispersion all break that assumption, and when they do the real false-alert rate is unknown. An alert
   budget a site can actually plan against has to be measured on that site's own history.
4. **One winner per stream.** The maximum-statistic correction is conservative when several true clusters
   coexist, and `nonOverlapping()` then keeps only the first per location. Secondary clusters are discarded
   by construction.

### Proposal — PACE (Phenotype-Aggregated Cluster Evaluation)

Four components. Each is independently testable and independently ablatable, so the benchmark can attribute
any gain to a specific mechanism rather than to "the new one is better".

**(1) Phenotype aggregation.** Map (organism, antibiotic) → mechanism-level phenotype class, using catalogue
data that already exists: `class_name` and `subclass_name` on all 399 antibiotics, the 7 expert rules, and
the 1,024 expected-resistance rows. Streams become `KPN | carbapenem-R`, `ECO | 3GC-R (ESBL phenotype)`,
`SAU | oxacillin-R (MRSA)`. Fewer streams, more cases per stream, lower multiplicity, and — importantly —
streams that correspond to a transmissible biological entity rather than to a laboratory panel choice.

**(2) Dual-model scan per stream.** Run both the case-only space-time permutation (preserving today's
behaviour exactly) and the space-time Bernoulli on resistant-versus-tested from Phase 29. The first catches
count clusters; the second catches proportion clusters and the system-wide rise the first cannot see.
Combine with a pre-specified rule — Šidák correction over the two Monte-Carlo p-values — chosen and frozen
before any benchmark run, not selected afterwards because it performed better.

**(3) Empirically calibrated alert threshold.** Instead of a fixed recurrence interval, learn the threshold
that yields a *target false-alert rate per site-year* (default: 1) by permutation over that site's own
baseline. The site then has an alert budget it can staff against, and the reported rate is measured rather
than nominal.

**(4) Transmission-plausibility re-ranking — optional, ablatable, and strictly cosmetic to the statistics.**
Where ward and admission data exist, re-rank signals by patient-overlap plausibility. It never creates a
signal and never changes a p-value; it only orders what the statistics already produced. Keeping this
outside the inference is what keeps the p-values interpretable.

### The pre-registered hypothesis

Written before any run, deposited, and quoted verbatim in the Methods:

> At a matched **empirical** false-alert rate of one per site-year, PACE detects seeded clonal multi-drug
> outbreaks of ≤ 20 excess cases with at least **15 percentage points** higher sensitivity, and a median
> detection delay at least **2 days** shorter, than per-agent case-only space-time permutation as run by
> AMRIT's current detector, whose agreement with a published reference implementation is established
> separately.

**Amendment, 14 August 2026, before any benchmark run.** The original text ended "…as run by both AMRIT's
current detector and SaTScan." SaTScan is dropped as a second implementation of the comparator. The
comparator *method* is unchanged — per-agent case-only space-time permutation, one stream per
organism–antibiotic pair, fixed recurrence-interval threshold — and the endpoints and thresholds are
unchanged. What changes is only which implementations of that method PACE is measured against. This
amendment is recorded rather than applied silently, and it is made **before the first benchmark run and
before any endpoint has been computed**, which is the condition that makes amending a pre-registered
hypothesis legitimate rather than a violation of it.

**Pre-specified failure condition.** If PACE does not clear both endpoints, the paper reports equivalence
plus the operational advantages (embedded, no second licensed executable, no manual file transfer,
five platforms, detection delay reported) and **the superiority claim is dropped**. That sentence goes in
the frozen protocol before the first run. A superiority claim that cannot fail is not evidence.

**Where PACE should be expected to lose**, stated in advance so the discussion is honest: a single-agent
outbreak with no mechanistic siblings gains nothing from aggregation and may lose slightly from the extra
multiplicity of the dual model; a site with no susceptible-isolate denominator cannot run component 2 at all;
and phenotype aggregation will mis-pool if the catalogue's class assignments are wrong for an unusual
organism–agent pair, which is a data-quality dependency the case-only method does not have.

**Exit criteria** — PACE implemented behind the Phase 27 interface in both runtimes; all four components
independently ablatable by configuration; the frozen protocol written, dated and deposited **before** the
first benchmark run; a full ablation grid runnable from one command.

**As built, 14 August 2026 — three deviations from this section, all recorded before any run.**

*Component 4 orders within bands of evidence, not across them.* The section above says re-ranking is
strictly cosmetic, and it is; what it did not say is that a purely plausibility-ordered list can bury the
strongest signal, which is what happened on the first corpus PACE saw. Signals are banded by their
standardised evidence rounded to the nearest whole unit and plausibility orders inside a band.

*Component 3 cannot be measured through the benchmark's endpoints.* Phase 33 calibrates every arm to a
matched empirical alert rate, which by design replaces the threshold a detector chose for itself. The
calibration ablation therefore reports the same sensitivity as the full detector, and component 3 is
measured instead by counting the alerts each arm's own rule raised on the null replicates — a column the
harness now reports for every arm, including the control's nominal 365-day recurrence interval.

*PACE composes the existing kernels rather than reimplementing them.* The case-only arm calls
`scanOutbreakEvents` and the proportion arm calls `scanBernoulli`, both already pinned against published R
references. The consequence is that with pooling off and one model PACE **is** the control arm, signal for
signal, which a test asserts — and which makes the ablation a measurement rather than a comparison of two
codebases.

**Duration** 5–6 weeks · **Risk HIGH** — this is research, and it is allowed to fail. The plan is
constructed so that failure costs the superiority claim and nothing else.

---

# Track E — Evidence

## Phase 32 — Synthetic data with outbreaks in it

**The gap.** `demo-population.ts` generates a genuinely good background — organism mix by specimen, ward and
city resistance gradients, panels that follow the organism, real co-resistance — and contains no outbreak
whatsoever. Every detector currently has nothing to detect, and the demonstration dataset shows an empty
outbreak page.

**Work**

- **An outbreak generator that models transmission, not arithmetic.** Inflating a count produces a signal
  every detector finds and proves nothing. A seeded outbreak should be an index case, a ward, a daily
  transmission hazard, a coherent phenotype expressed across every agent the mechanism affects, a plausible
  detection lag from acquisition to specimen, and an end. The resulting cases must be indistinguishable from
  background cases by any field except the recorded ground truth.
- **Factorial design**, matching the paper plan: excess cases {5, 10, 20, 40} × duration {7, 14, 30 days} ×
  background rate {low, medium, high} × site, replicated.
- **Outbreak types**, chosen so they discriminate between detectors rather than flatter one:
  - *clonal multi-drug* — the case PACE's phenotype aggregation is designed for;
  - *single-agent* — the case where aggregation gains nothing, included deliberately;
  - *proportion shift with no count increase* — invisible to case-only, visible to Bernoulli;
  - *uniform system-wide rise* — invisible to case-only by construction; the negative control that makes the
    documented blind spot measurable instead of asserted;
  - *pseudo-outbreak* — a testing-practice change, not transmission. Every detector **should** flag it and
    the write-up should say so; this is the specificity limit, not a defect.
- **Null replicates** with no outbreak at all, enough of them to estimate false-alert rate per site-year with
  a usable confidence interval.
- **Ground truth file**: outbreak id, site, ward, organism, phenotype, start, end, contributing record ids,
  excess count. Written by the generator, never inferred afterwards.
- Deterministic seeds. The generator and its seed are committed; the multi-gigabyte output is not. A small
  golden fixture is committed so a generator change that alters the data is visible in a diff.

**Exit criteria** — generator produces the full factorial deterministically from a seed; ground truth
complete and machine-readable; a blinded inspection cannot distinguish seeded cases from background cases by
any field other than the truth file; the null replicates support a false-alert-rate estimate; golden fixture
committed and gated.

**Duration** 3–4 weeks · **Risk** medium — *the realism of the generator determines whether the benchmark
means anything*, and an unrealistically clean outbreak flatters every detector equally.

---

## Phase 33 — Benchmark harness

**Work**

- One command runs every detector — STPSS (control), the Phase 29 models, the Phase 30 detectors and PACE —
  across the entire Phase 32 corpus. SaTScan is an **optional** arm, included when the operator has a binary
  and skipped with a recorded reason when not; no endpoint depends on it.
- Endpoints, all pre-specified: sensitivity at matched empirical false-alert rate; **median detection delay
  in days** (the quantity the WHONET–SaTScan literature does not report, and the one an infection-prevention
  team actually experiences); false-alert rate per site-year; positive predictive value; spatial and temporal
  accuracy of the detected window against truth.
- **Matched false-alert rate, not matched nominal threshold.** Comparing detectors at their default
  thresholds compares tuning, not method. Every comparison is made at an empirically equalised alert budget.
- Ablation grid over PACE's four components, so any gain is attributed to a mechanism.
- Output: the paper's Figure 3 and its supplementary tables, generated by the harness, not assembled by hand.
- Runs in CI on a reduced grid so a detector regression is caught the day it lands.

**Exit criteria** — full grid reproducible from a seed on a clean machine; every endpoint computed by code,
not by hand; ablation attributes each component's contribution; reduced grid in CI.

**Duration** 2–3 weeks · **Risk** low.

---

## Phase 34 — Run the studies and report what happened

- Execute Study B arms 1 and 2 from the paper plan, plus the PACE superiority test.
- Fill the `‹PENDING›` markers in `paper/AMRIT_manuscript_draft_v1.md`.
- Update `docs/OUTBREAK_DETECTION.md`: it currently documents one method accurately and will need to
  document a family, including each one's blind spot, with the same candour.
- Update the claims register (`paper/AMRIT_paper_phasewise_plan.md`, row C-12 and its neighbours) with
  measured values.
- **Report the failures.** If PACE loses, that goes in the paper. If a component ablates to no effect, that
  goes in the paper. The value of a pre-specified failure condition is entirely in honouring it.

**Exit criteria** — every `‹PENDING›` in the manuscript closed with a measured value or a stated reason;
claims register carries evidence for each row; the frozen protocol and the deposited pre-registration
referenced in Methods; `OUTBREAK_DETECTION.md` current.

**Duration** 2–3 weeks · **Risk** low.

---

## Schedule

Parallel tracks after Phase 16. Durations are working weeks for one competent engineer per track.

| Track | Phases | Serial weeks |
|---|---|---:|
| Prerequisite | 16 | 2 |
| P — Platforms | 17, 18, 19, 20, 21 | 16–22 |
| S — Standards | 22, 23, 24, 25, 26 | 16–22 |
| D — Detection | 27, 28, 29, 30, 31 | 17–22 |
| E — Evidence | 32, 33, 34 | 7–10 |

- **One engineer, fully serial:** roughly 58–78 weeks.
- **Three tracks in parallel** (P, S, D+E share a person): roughly **24–30 weeks** to all four goals.
- **Earliest paper-ready date** — Track D + Track E only, ignoring platforms and standards: about
  **20–24 weeks**, and Phase 32 must start in week 1 for that to hold.

**Suggested order if the work must be serialised:** 16 → 32 → 27 → 28 → 29 → 31 → 33 → 34 (paper first),
then 22 → 23 → 24 → 25 → 26 (standards), then 17 → 18 → 19 → 20 → 21 (platforms). Rationale: the paper is
the time-sensitive deliverable and the outbreak work is on its critical path; the platform work is the
largest and the least externally constrained.

---

## Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | **Phase 17 core extraction destabilises the desktop app** | Medium | Severe — every other phase builds on it | Behaviour-preserving refactor with 368 existing tests as the contract; golden-output tests on every exporter; no test may be edited to keep passing |
| 2 | **Synchronous/asynchronous SQLite mismatch is worse than estimated** | Medium | High | Decide the approach in Phase 17 before moving code; prototype the async conversion on `database.ts` alone and measure the diff before committing to it |
| 3 | **PACE does not beat STPSS** | Medium | Costs the superiority claim only | Pre-specified failure condition; equivalence + operational advantages carry the paper regardless; the ablation grid tells you *why* it lost |
| 4 | **App Store review rejects or delays** | Medium | Delays Phase 19 | Prepare the health-data answer before submitting; Android ships independently; TestFlight distribution does not require full review |
| 5 | **LOINC/ICD licence terms block bundling** | Low-medium | Standards track partially deferred | Phase 22 resolves licences *before* Phase 23 depends on them; downloadable-pack fallback for any system that cannot be bundled |
| 6 | **Inbound MLLP listener introduces a vulnerability on a clinical machine** | Medium | Severe | Off by default; loopback-bound; credential required to start; fuzz the parser; size and rate caps; independent security review of Phase 26 before release |
| 7 | **Synthetic outbreaks are too easy and every detector scores near-perfectly** | Medium | Benchmark proves nothing | Calibrate difficulty against the seeded-truth literature; include the small-cluster (5 excess cases) and proportion-shift-only arms specifically because they are hard |
| 8 | **SaTScan output format changes or the binary is unavailable to reviewers** | Low | Weakens Study B arm 1 | Arm 2 against seeded truth needs no SaTScan and carries the claim independently — already noted in the paper plan's own risk table |
| 9 | **Regulatory classification changes when interpretation moves to a phone** | Low-medium | Could block mobile release | Settle in Phase 20 with counsel; the conservative surveillance-only boundary is what the code already implements |
| 10 | **Five-platform maintenance exceeds capacity after release** | Medium | Long-term | Phase 16's matrix is the mitigation; anything not tested in CI on a platform is not supported on that platform, and the documentation should say so |
| 11 | **Phenotype aggregation mis-pools for unusual organism–agent pairs** | Medium | PACE produces a wrong stream | The class assignments come from the catalogue, so they are inspectable and correctable; the ablation grid isolates the damage; document it as a data-quality dependency |

---

## Standing rules for this plan

Carried from the globalization plan, because they are what made it work:

1. **Corrections get written down.** `docs/globalization/PHASE_STATUS.md` carries a table of ~50 plan claims
   that contact with the code disproved. That table is the most useful artefact the last plan produced.
   [`PHASE_STATUS.md`](./PHASE_STATUS.md) in this directory continues the practice for Phases 16–34.
2. **A shim's deletion is scheduled when the shim is introduced.** Phase 13's finding — that compatibility
   columns kept past one phase become the thing they replaced — applies to every adapter in Phase 17.
3. **Test matrices that only run one configuration prove nothing.** The IN/TESTLAND matrix runs on every
   commit from Phase 16 onward, and the platform matrix joins it.
4. **A guarantee is either enforced or the operation is refused.** The Pillow finding from Phase 6b is the
   precedent: no silently-unenforced guarantee ships.
5. **Look at the screen, not only the diff.** Phase 14 found a three-line Django comment rendering as visible
   body text on every page of the portal. Mobile UI work in Phase 20 is verified on a physical device.
6. **No claim the benchmarks did not test.** Already the paper plan's rule; Phase 31's pre-specified failure
   condition is how it is honoured here.
