# Terminology, coded output and the Implementation Guide

Phases 22–25 of [`docs/expansion/PLAN.md`](../expansion/PLAN.md). What AMRIT now says in
standard vocabularies, where each code came from, and — the part that matters most — what it
still does not say and why.

## The position on every code system the plan named

| System | Position | Where |
|---|---|---|
| **LOINC** | **Bundled, subset.** 917 concepts: a susceptibility code per agent and method for the 264 catalogue antibiotics LOINC covers, plus the three observation codes. Retrieved from the HL7 public terminology server, hash-pinned, `--check`-gated. | `shared/terminology/terminology-seed.v1.json` |
| **UCUM** | **Bundled.** The three units AMRIT measures in. | same |
| **SNOMED CT** | **Unchanged from Phase 10.** Organism and specimen concepts from the WHONET catalogue, gated on the deployment's licence position. Now reachable through `$translate` and emitted on `Observation.valueCodeableConcept` and `Specimen.type`. | same, `amrit-organism-to-snomed` |
| **ICD-10** | **Starter value set bundled and verified**, 33 codes. The full WHO release is **not** bundled — see below. | same, `icd10-starter.verified.json` |
| **ICD-11 MMS** | **Bundled, subset — Phase 26.** 40 codes from WHO's own ICD API, release 2026-01: the infection syndromes AMR surveillance reports on, plus WHO's `MG50`–`MG54` antimicrobial-resistance findings. Shipped as a *selection*, never an edit, because CC BY-ND 3.0 IGO forbids derivatives. **No ICD-10↔ICD-11 map** — see below. | `icd11-mms.verified.json`, `tools/fetch_icd11.py` |
| **ATC/DDD** | **Referenced, not bundled**, unchanged. The catalogue carries `atc_code` per antibiotic; the WHO index itself is redistribution-restricted. | catalogue |
| **HL7 terminology** | **Used inline**, not bundled: observation categories, interpretation codes, condition categories and the v2 tables are small, stable and quoted where they are used. | `services.ts` |

## What the codes are, and how they were chosen

**The catalogue's own LOINC columns are wrong for this purpose, and are not used.**
`master_antibiotics` carries `loinc_mlc` and `loinc_sbt` for 121 agents. They are valid LOINC
codes — for minimum *lethal* concentration and serum bactericidal titer. AMRIT records minimum
*inhibitory* concentration and disk diffusion. Meropenem's MLC code is `6651-4` and its MIC code
is `6652-2`; binding the first to an MIC result would have put a wrong code on every
susceptibility observation the product has ever exported. Phase 23's plan text assumed those two
columns were MIC and disk diffusion; they are not.

**The codes come from the terminology server and are matched by substance name.**
`tools/generate_terminology_seed.py` expands the LOINC `ABXBACT` class (2,115 concepts), reads
the *method* out of each display rather than assuming it from a column name, and matches to the
catalogue by normalised substance name. Four rules are applied, each counted separately so a
reviewer can accept or reject them individually: exact (249), nomenclature synonym such as
clavulanic acid → clavulanate (7), salt-word stripped (1), ester prodrug stripped such as
cefpodoxime proxetil → cefpodoxime (7).

**135 of 399 agents have no LOINC susceptibility concept.** They export with the WHONET coding
alone and are listed with the reason in the seed's `unmatched` section. A wrong code is a defect;
a missing one is a gap that someone can close.

**One shipped diagnosis code does not exist.** Verifying the 34-code starter set against the
terminology server rejected `U88`, and found five codes whose bundled description had been
paraphrased away from WHO's own text (`A09`, `A15`, `B95`, `B96`, `U82`). The seed now carries
WHO's display; `U88` is excluded and recorded in `rejectedDiagnosisCodes`.

## What an export now carries

| Element | Before | After |
|---|---|---|
| Susceptibility `Observation.code` | `urn:whonet:antibiotic-code` only | LOINC for the agent **and method**, then WHONET |
| `valueQuantity` | `{ value: 8 }` — an MIC and a zone diameter were indistinguishable | `{ value: 8, unit: 'mg/L', system: UCUM, code: 'mg/L' }`, or no unit at all where the method is unknown |
| Organism `Observation.code` | `text: 'Organism identified'` | LOINC `11475-1` |
| Organism value | WHONET code | WHONET code **and** SNOMED where licensed |
| `Specimen.type` | WHONET code | WHONET code **and** SNOMED where the catalogue has one (3 of 8 groups) |
| `DiagnosticReport.code` | free text | LOINC `18725-2` |
| Diagnosis | stored, never exported | `Condition` resource + `DiagnosticReport.conclusionCode` + v2 `DG1` |
| `meta.profile` | absent | stamped on every emitted resource |
| HL7 v2 `OBX-3` | local triplet only | local triplet **plus** the LOINC alternate identifier |
| HL7 v2 `OBX-6` | empty | UCUM unit |

**What cannot be coded is stated on the bundle.** Every omission — an agent LOINC does not cover,
a vocabulary the deployment has not licensed — becomes a `meta.tag` naming the reason. A receiver
can tell "this deployment does not license SNOMED" from "this organism is unknown", which a
silent absence cannot.

**Free text is never coerced into a code.** A record with a diagnosis note and no diagnosis code
produces a `Condition` with `code.text` and no `coding`, and no `DG1`.

## The Implementation Guide, and what is not done

Authored in `fhir-ig/`: nine profiles in FHIR Shorthand (`input/fsh/profiles.fsh`), and six
ValueSets and ConceptMaps **generated from the terminology seed** by
`tools/generate_ig_valuesets.py`, which has a `--check` mode so the IG cannot drift from the
runtime. Every emitted resource carries `meta.profile` pointing at the deployment's own canonical
base, and the server publishes a `CapabilityStatement` at `/api/v1/terminology/metadata`.

**Three exit criteria of Phase 25 are not met, and none of them can be met from this machine:**

1. **The IG has not been built with the HL7 IG Publisher.** It is a Java application and there is
   no Java runtime here (`java -version` → "Unable to locate a Java Runtime").
2. **The official HL7 FHIR validator has not been run**, for the same reason, so "zero errors on
   a reference corpus" is unverified and **is not claimed**. The profiles are authored to what the
   exporter emits; they have not been validated by the tool that arbitrates.
3. **The IG is not published at a stable URL.** The canonical base is the deployment's own
   `identifier_namespace.base_uri`, defaulting to `https://amrit.invalid` — a reserved TLD, so an
   unpublished deployment's `meta.profile` is visibly not a claim to something fetchable.

The CapabilityStatement therefore advertises **no** `implementationGuide`: pointing at an IG
nobody can fetch is a broken promise rather than a capability.

## The diagnosis picker, and where its codes come from

The picker offers the starter value set first and searches the whole bundled classification
behind it. Typing two characters runs `ValueSet/$expand` **in the main process**, over both ICD
revisions, and appends what it finds after the starter set — the common answer stays at the top
and the long tail is reachable.

The search runs in the main process because that is where the terminology seed already is.
Shipping a classification into the renderer so the renderer can filter it once would move the
work to the process with less memory, and would have to be repeated for every window.

Three properties worth stating:

* **`total` is the number of matches, not the size of the page.** A picker can therefore say how
  much it did not show instead of implying it found fifty things.
* **A disabled code system answers with its reason, not an empty page.** An empty page reads as
  "no such code", which is a different and wrong statement.
* **The bridge is optional.** `window.amrit?.terminology?.expand` is optional-chained and the
  promise is caught: a renderer running against an older preload degrades to the starter set
  rather than throwing inside a keystroke handler.

The plan's performance criterion — a ~70,000-row search on a phone — is **not yet claimed**. What
is bundled is the infection chapters rather than the whole of ICD-10, which is the scope an AMR
deployment codes into; the measurement belongs with a device, which is Track P.

## ICD-11, and the check that "the code exists" is not

Phase 26 closes the ICD-11 deferral by taking the codes from the source rather than transcribing
them. `tools/fetch_icd11.py` authenticates against WHO's OAuth endpoint, resolves the latest MMS
release, and for each candidate keeps WHO's code and WHO's title. Credentials are free on
registration at <https://icd.who.int/icdapi> and are read from the environment or a gitignored
file; a checkout without them builds a seed reporting zero ICD-11 concepts, which is a visible
absence rather than a silent one.

**The first run of that tool reported 32 of 32 candidates verified, and nine of them were the
wrong concept.** Every candidate resolved, because every candidate was a real ICD-11 code — just
not the one intended:

| Asked for | WHO's actual concept at that code | The right code |
|---|---|---|
| `1A04` Enteritis due to Campylobacter | Intestinal infections due to *Clostridioides difficile* | `1A06` |
| `1A09` Shigellosis | Infections due to other *Salmonella* | `1A02` |
| `1D00` Bacterial meningitis | Infectious encephalitis, NEC | `1D01.0Z` |
| `1G60` Bacteraemia | Certain other disorders of infectious origin | `MA15.0` |
| `CB27` Pyothorax or pleural empyema | Pleural effusion | `CA44` |
| `FA11` Pyogenic arthritis | Reactive arthropathies | `FA10` |
| `JB40` Puerperal sepsis | Infections in the puerperium (the parent) | `JB40.0` |
| `NE81` Infection following a procedure | Injury or harm arising from a procedure, NEC | `NE81.2` |
| `QA0Y` Carrier of an infectious agent | Other examination or investigation | `QD0Z` |

A wrong-but-valid code is the worst case in this whole document: it passes `$validate-code`, it
passes the official validator, it passes a receiving system's terminology check, and it is a
wrong diagnosis on a patient record. Nothing downstream can detect it, because there is nothing
wrong with it *as a code*.

So the tool no longer asks whether a code resolves. Each candidate carries an `expect` string
that WHO's own title must contain, and a candidate failing it is **rejected and listed with WHO's
actual title** rather than accepted. A candidate with no `expect` also fails, because silence must
not be assent when the subject is a diagnosis. The current set is 40 codes, all passing both
checks.

## No map between the ICD revisions, deliberately

WHO's ICD API exposes no ICD-10 → ICD-11 mapping endpoint — the published surface is
`/icd/release/11/…`, `/icd/release/10/…`, `codeinfo` and `search`, and none of them maps between
revisions. WHO publishes mapping *tables* separately, outside the API and under their own terms.

The seed therefore carries **no ConceptMap between the revisions**, and a test asserts its
absence rather than merely not building one. The two classifications are not subsets of one
another: ICD-10 `A41` and ICD-11 `1G40` do not have the same extension. A record states which
system its diagnosis came from — which is what `diagnosis_system` has always been for — and a
deployment on one revision emits that revision. Inventing an equivalence would attach a guess to
a patient's diagnosis and hide it behind a code that validates.
