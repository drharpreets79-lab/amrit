# Standards track — completion plan (Phases 22–26 and the SNOMED arm)

Written 14 August 2026, against the tree as it stands. Every row says who can do it, what it
needs, and how anyone can tell it is finished. Where something is blocked, the blocker is a
named artefact or credential rather than "more work".

**Read the status table first.** Most of Phases 22–25 are already built and verified; the
remaining work is smaller than the phase numbers suggest, and two of the five items need
something only the owner can supply.

---

## Where the track stands right now

| Phase | State | Evidence |
|---|---|---|
| 22 Terminology service | **done** | `$lookup`/`$validate-code`/`$translate`/`$expand` in both runtimes and over HTTP; seed hash-pinned and `--check`-gated in CI; LOINC 2.82 ingested from the licensed release; ICD-10 and ICD-11 starter sets verified against their publishers |
| 23 LOINC bindings | **done, validator-verified** | Official HL7 validator: **0 errors** on the reference corpus. LOINC per agent *and method*, UCUM units, HL7 v2 OBX-3/OBX-6 populated |
| 24 ICD diagnosis | **mostly done** | `Condition` + `conclusionCode` + `DG1`; ICD-10 (33 codes) and ICD-11 MMS (40 codes) both bundled and verified; free text never coerced. **Open:** ICD-10↔11 ConceptMap, full-release ingestion, picker performance measurement |
| 25 FHIR IG | **built** | SUSHI 0 errors, IG Publisher produced `fhir-ig/output/` including `full-ig.zip`; validator green on profiles and generated artefacts. **Open:** Jekyll for the HTML site, publication URL, CI gate |
| 26 Inbound | **substantially built, unverified by me** | `app/src/main/inbound/` (MLLP, v2 parser, FHIR ingest, reconciliation, quarantine/merge) with two test files. Needs the full security review and fuzz evidence before it can be called done |
| SNOMED arm | **verification running** | Every catalogue SNOMED code is being checked against the terminology server; bundling descriptions needs the licence decision below |

---

## What is required from you

Three things, in order of how much they unblock.

### 1. SNOMED CT release files, or NRC portal access — blocks the SNOMED arm

India is a SNOMED International Member, so use inside India is free; that is the *use* position,
not the *distribution* position, and AMRIT ships beyond India. What is needed:

| Option | What to supply | What it unlocks |
|---|---|---|
| **A. RF2 release** (preferred, mirrors how LOINC arrived) | The SNOMED CT International Edition RF2 zip, or the India Edition, dropped in a folder like `Loinc/` | Full organism, specimen and substance subsets; refset-based value sets; offline reproducible builds |
| **B. NRC / MLDS account** | Username and password for the India NRC (NHA/C-DAC) or SNOMED International MLDS | Same as A, and the tool can refresh releases itself |
| **C. Nothing further** | — | What is running now: every catalogue SNOMED code checked for existence against the public terminology server, descriptions withheld from the bundle unless a deployment turns them on |

**Also needed with A or B: a written licence position** — whether AMRIT may bundle SNOMED
descriptions in the installer it distributes, or whether they stay behind
`code_systems.snomed.enabled` and are fetched per deployment. That is a legal decision, and the
code already supports either answer.

### 2. A Ruby/Jekyll install — blocks the IG's HTML site only

The IG Publisher produced every machine-readable artefact; only the rendered website step failed,
because `jekyll` is not installed. `gem install jekyll bundler` (or `brew install jekyll`) is the
whole fix. Everything a validator or a receiver consumes already exists without it.

### 3. A publication URL for the IG — blocks one Phase 25 exit criterion

Today the canonical is `https://amrit.invalid`, deliberately: `.invalid` can never resolve, so an
unpublished guide cannot be mistaken for a published one. To publish, give me the URL and I set it
in `sushi-config.yaml` and in `identifier_namespace.base_uri`; the runtime then stamps that same
value into `meta.profile` on every resource, and the two cannot disagree.

**Not required:** the ICD-11 credentials you sent have already been used — ICD-11 MMS is ingested
and verified. Since they travelled through a chat transcript, **rotate them** at
<https://icd.who.int/icdapi> when convenient. They are not written into the repository, and the
tool reads them from `ICD_CLIENT_ID` / `ICD_CLIENT_SECRET` in the environment.

---

## The phases, as work

### Phase A — SNOMED, once the release or the decision arrives

| # | Work | Done when |
|---|---|---|
| A1 | Verify every catalogue SNOMED code against the server; record what does not resolve | `shared/terminology/snomed-catalogue.verified.json` lists validity for all 2,102 references *(running now)* |
| A2 | Correct or retire the codes that fail, in the catalogue rather than in a patch | `generate_catalog_seed.py --check` green with the corrected rows |
| A3 | Ingest the RF2 release into the seed behind the SNOMED gate: organisms, specimen types, and the substance concepts for antimicrobials | `$lookup` answers for a SNOMED organism offline, with no network |
| A4 | Emit SNOMED on `Observation.valueCodeableConcept` and `Specimen.type` — already wired; extend to `Condition.code` where a deployment prefers SNOMED to ICD | Validator green with SNOMED enabled *and* with it disabled |
| A5 | Record the licence position in `shared/DATA_LICENCES.md` and surface it in both licences views | `check_data_licences.py` green |

### Phase B — finish Phase 24 (ICD)

| # | Work | Done when |
|---|---|---|
| B1 | Ingest the full ICD-10 and ICD-11 releases, not the starter sets | `$expand` over ICD-10 returns the real classification; the picker pages it |
| B2 | Build the ICD-10 ↔ ICD-11 ConceptMap for the infection syndromes AMR surveillance reports on | Round-trip tested in both directions, in both runtimes |
| B3 | Point the diagnosis picker at `$expand` with the starter set surfaced first | Search over the full system is responsive on a phone-sized device; the measurement is recorded |
| B4 | Check the diagnosis mapping against the GLASS infection-origin categories the exporters already produce | The two do not disagree, demonstrated by a test |

*B2 needs a decision: WHO publishes no official ICD-10↔11 map for these codes, so it is either
authored here and labelled as AMRIT's own, or omitted. Authored-and-labelled is the honest option.*

### Phase C — finish Phase 25 (the IG)

| # | Work | Done when |
|---|---|---|
| C1 | Install Jekyll; rebuild | `fhir-ig/output/index.html` renders and `qa.html` is reviewed |
| C2 | Add the IG build and the official validator to CI as a merge gate | A profile change that breaks the corpus fails the build |
| C3 | Publish at the URL you give me and set the canonical in both places | A receiver can fetch the profile named in `meta.profile` |
| C4 | Add examples to the IG — the reference corpus is already generated and validates | Examples render in the published guide |

### Phase D — finish Phase 26 (inbound), the highest-risk item

The code exists. What is not yet evidenced is the part that matters most on a machine holding
patient records.

| # | Work | Done when |
|---|---|---|
| D1 | Security review of the listener: bind address, credential requirement, TLS, rate limit, message-size cap, refusal to start unconfigured | Each control has a test that fails when it is removed |
| D2 | Fuzz the v2 parser over a seeded corpus of malformed and hostile messages | A recorded run finds no crash, no unbounded allocation, no hang; the seed is committed so it reruns |
| D3 | Prove the quarantine path: an unmapped organism, an unmapped antibiotic, a mangled date | Nothing is guessed, nothing is dropped silently, and a human sees the message |
| D4 | Prove the merge path: the same specimen arriving twice, and arriving changed | Merged, auditable, and reversible; not duplicated |
| D5 | Prove the privacy boundary is unchanged: inbound patient data reaches the local node only | The existing PII-guard tests still pass against a node that has ingested |
| D6 | End-to-end: a simulated LIS sends ORU^R01, the isolate appears interpreted | Recorded, with the message and the resulting record side by side |

### Phase E — the standing gates

| # | Work | Done when |
|---|---|---|
| E1 | `generate_terminology_seed.py --check` and `generate_ig_valuesets.py --check` in CI | Already added; runs on every push |
| E2 | Official validator against the reference corpus in CI | Needs a Java step in the workflow; the corpus and the tool already exist |
| E3 | Licence gates covering every new asset | `check_data_licences.py` green — already true |

---

## Sequencing

Two of these can start immediately and one is waiting on you.

```
now        Phase D (inbound: review, fuzz, evidence)      ← highest risk, no blocker
now        Phase B1/B3 (full ICD releases, picker)        ← no blocker
now        Phase C2 (validator in CI)                     ← no blocker
on Jekyll  Phase C1                                       ← one install
on SNOMED  Phase A3–A5                                    ← release files or a decision
on URL     Phase C3                                       ← one URL
```

Phase D first, on judgement rather than dependency: it is the only part of this track that opens a
network port on a machine holding patient records, and the rest of the track is reversible in a way
that a listener with a weak default is not.
