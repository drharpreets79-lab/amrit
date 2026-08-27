# Expansion — Phase Execution Tracker

Companion to [PLAN.md](./PLAN.md) (Phases 16–34). Continues
[`docs/globalization/PHASE_STATUS.md`](../globalization/PHASE_STATUS.md), whose Phases A and 0–15 are done.
Update the Status column as each phase lands.
Statuses: `not-started` · `in-progress` · `blocked` · `done`

## Recorded baseline (14 August 2026, branch `phase-a-repo-split`)

Every phase below is measured against this. Verified by reading the tree, not the documentation.

| Product | Result |
|---|---|
| desktop app | 368 tests passed / 3 skipped, under IN and TESTLAND |
| web server | 339 tests passed / 1 skipped, under IN and TESTLAND |
| continuous integration | **none** — no `.github/` in the repository |
| platforms built and verified | macOS only (win/linux declared in `electron-builder`, never exercised) |
| mobile | none |
| LOINC codes on FHIR output | none (121/399 antibiotics carry LOINC in the catalogue, unused) |
| ICD in FHIR output | none (no `Condition` resource; 34-code starter value set) |
| inbound interoperability | none |
| detection algorithms | 1 (Kulldorff space-time permutation) |
| seeded outbreaks in synthetic data | none |

## Decisions taken (owner, 14 August 2026)

| Question | Decision |
|---|---|
| Mobile architecture | Capacitor, **full offline node** — extract a platform-neutral core, phone is a node not a viewer |
| "Implement SaTScan" | **All three**: file/binary interoperability · SaTScan's other models · non-scan detectors. **Amended 14 August 2026:** SaTScan itself dropped as a requirement — Windows-first, non-redistributable, would not run here. The models are implemented natively and validated against open-source R references instead; the bridge survives as optional interoperability. |
| Superiority claim | **Build a better detector, then test it**, with a pre-specified failure condition |
| Standards depth | **All four**: fix and validate what exists · inbound as well as outbound · publish an AMRIT FHIR IG · full terminology service |

## Phases

### Prerequisite

| # | Phase | Risk | Status | Exit criteria (short) |
|---|---|---|---|---|
| 16 | CI and the build matrix | low | **in-progress** | Workflow authored (`.github/workflows/ci.yml`) and **every command in it verified locally on macOS**; `.gitattributes` normalises line endings so Windows checkouts cannot break the byte-compared golden fixtures. **Blocked on the owner for the rest**: the repository has no git remote and `gh` is not installed, so no leg of the matrix has actually executed; Windows and Linux legs, the clean-VM launches and the signing credentials all need that. See [Phase 16 execution log](#phase-16-execution-log). |

### Track P — Platforms

| # | Phase | Risk | Status | Exit criteria (short) |
|---|---|---|---|---|
| 17 | Extract platform-neutral `core/` | **HIGH** | **in-progress** | **The seam exists and is enforced.** `app/src/core/` holds the four interfaces the plan named — `SqlDriver`, `AssetSource`, `SecretStore`, `PathResolver` — bundled as `Platform`; `app/src/adapters/node/` implements all four against real `node:sqlite` and the real bundled assets, with 10 tests that exercise a database rather than a mock. An ESLint rule fails the build if anything under `core/` imports `node:*`, a Node built-in, `electron`, the DOM, `main/` or an adapter; the rule was verified by planting a violation and watching it fail. **The synchronous/asynchronous decision is taken and encoded**: `core/` is asynchronous throughout, because `@capacitor-community/sqlite` cannot be otherwise, and the desktop adapter wraps its synchronous driver at a cost of one microtask per query. **Not done:** moving the 44 already-portable modules into `core/domain/`, and converting `database.ts` (4,395 synchronous lines) and its callers to the async seam — that is the bulk of the phase and it is the part that must not be rushed. |
| 18 | Android | medium | **blocked** | **Blocked on this machine and on accounts, not on code.** No Android SDK and no Gradle are installed (`gradle: not found`, no `~/Library/Android/sdk`), so nothing can be built; a Play internal-testing track needs a Play Console account and a physical device, neither of which exists here. `adapters/capacitor/` is scaffolded and empty, waiting on Phase 17's domain move. |
| 19 | iOS | medium-high | **blocked** | **Blocked.** Xcode is not installed — `xcodebuild` reports "requires Xcode, but active developer directory '/Library/Developer/CommandLineTools' is a command line tools instance" — so no build, no simulator and no archive is possible. TestFlight additionally needs an Apple Developer Program membership and physical devices. |
| 20 | Mobile as a first-class surface | low-medium | **blocked** | **Blocked on 18 and 19**, and on two criteria that are not code at all: one-handed capture "verified on device by someone who did not write it", and a barcode round-trip against a real label. Both need a person and a device. |
| 21 | Five-platform release engineering | medium | not-started | One tagged commit → signed artefacts for all five from CI · cross-platform backup/restore round-trip both directions · offline update path tested · DEPLOYMENT.md covers mobile |

### Track S — Standards

| # | Phase | Risk | Status | Exit criteria (short) |
|---|---|---|---|---|
| 22 | Terminology service and code-system ingestion | medium | **done** | `app/src/main/terminology/` and `server/amrit_central_server/terminology/`, over one hash-pinned seed built by `tools/generate_terminology_seed.py` from the HL7 public terminology server. `$lookup`, `$validate-code`, `$translate` and `$expand` in both runtimes and over HTTP at `/api/v1/terminology/`. LOINC and UCUM bundled with terms recorded; ICD-11, ATC/DDD and the full ICD-10 release deferred **with the reason written down** in [`docs/standards/TERMINOLOGY.md`](../standards/TERMINOLOGY.md). Disabling a system produces a reason, never an empty result or a substitute code. app 18 tests / server 23 tests. |
| 23 | LOINC bindings on every laboratory output | medium | **done** | Every observation, specimen and report carries LOINC or a **tag on the bundle naming why it cannot**; MIC in mg/L and zone diameter in mm, UCUM-coded and distinguishable; HL7 v2 OBX-3 carries the LOINC alternate identifier and OBX-6 the unit, both previously empty. Golden bundle pinned. 264 of 399 agents bound, 135 uncoded and enumerated. **Verified 14 August 2026:** the official HL7 FHIR validator reports **zero errors** on the exporter-generated reference corpus, and it runs in CI. Getting there found three real defects it alone could see — the exporter was sending a record's free text as the *display* of a coded value (`display: "MEM"` where the code system says "Meropenem", "Klebsiella pneumoniae" for a code whose display is "Klebsiella pneumoniae complex", "Blood" for "Blood / normally sterile fluid"). Displays now come from the code system and free text goes to `CodeableConcept.text`. |
| 24 | ICD as a first-class coded diagnosis | low-medium | **done (cross-revision map withdrawn with a reason)** | `Condition` emitted from the stored diagnosis with the stored system, `DiagnosticReport.conclusionCode` alongside it, and HL7 v2 `DG1` — one segment per code. **Free text is never emitted as a code**, asserted by test. The 34-code starter set is verified against the terminology server, which **rejected `U88` (not an ICD-10 code) and corrected five paraphrased displays**. **ICD-11 MMS is bundled and verified** against WHO's own API, so a deployment on either revision emits its own. The **diagnosis picker now searches the whole bundled classification**: typing runs `ValueSet/$expand` in the main process over both revisions and appends what it finds after the starter set, so the common answer stays first and the long tail is reachable; the bridge is optional-chained, so a renderer on an older preload degrades to the starter set rather than throwing. **The ICD-10↔ICD-11 ConceptMap is withdrawn, not deferred:** WHO's ICD API publishes no mapping between the revisions — 21 documented paths, none of them cross-revision — and inventing an equivalence between two categories, neither a subset of the other, would be a guess with a patient's diagnosis attached. A record stays in the revision it was captured in, which is what `diagnosis_system` has always been for. The plan's ~70,000-row picker measurement is **not claimed**: what is bundled is the infection chapters rather than all of ICD-10, and the measurement belongs on a device (Track P). |
| 25 | AMRIT FHIR Implementation Guide | medium | **done (one criterion is a deployment act)** | Nine profiles in FHIR Shorthand; eleven ValueSets, ConceptMaps and CodeSystems **generated from the terminology seed** with a `--check` gate, so the IG cannot drift from the runtime. **The IG builds with the HL7 IG Publisher: 0 errors**, 841 pages, 0 broken links, and every remaining warning reviewed below rather than suppressed. **The official HL7 validator reports zero errors on the reference corpus**, and that corpus is now *generated by the exporter* (`app/scripts/generate-reference-corpus.ts`, with `--check`) rather than hand-written — validating a hand-made file would have proved nothing about the product. Both run in CI as merge gates (`fhir` job), against a pinned validator. **The earlier "blocked on a Java runtime" was stale**: `java -version` reports openjdk 26.0.2. The gates found five real exporter defects, listed in the log. **Not done, and not a build step:** publishing at a stable URL — the canonical is still `https://amrit.invalid` by design, and a deployment substitutes its own. See [Phase 25 execution log](#phase-25-execution-log). |
| 26 | Inbound HL7 v2.5.1 and FHIR | **HIGH** | **in-progress** | `app/src/main/inbound/`: MLLP listener, v2.5.1 parser, FHIR Bundle ingest, terminology reconciliation, quarantine and auditable merge. **Secure by default and tested as such**: disabled in the default configuration, refuses to start without a credential, refuses a wildcard bind and a network bind with no allowlist, constant-time credential comparison, message-size cap and rate limit. A simulated LIS ORU^R01 files an interpreted isolate; AMRIT's own exported ORU reads back; a fuzz run over mutated real messages throws nothing; unmapped codes quarantine with every reason listed rather than being guessed; a resend merges auditably rather than duplicating; the federation outbox stays empty after a full inbound cycle, proven against a real database. app 41 tests. |

### Track D — Detection

| # | Phase | Risk | Status | Exit criteria (short) |
|---|---|---|---|---|
| 27 | Detector framework | low | **done** | `app/src/main/detection/` and `server/amrit_central_server/analytics/detectors.py`, agreeing on `shared/golden-datasets/detector_reference.json`. STPSS wrapped, **not rewritten** — a parity test asserts the registry's signals are byte-identical to calling `runOutbreakDetection` directly. Denominator derivation mirrored row-for-row across runtimes. Every signal carries `detector_id`. Detectors declare requirements and give a reason when they cannot run. app 13 tests / server 11 tests. See [Phase 27 execution log](#phase-27-execution-log). |
| 28 | SaTScan interoperability | low-medium | **done (rescoped)** | Writers (`.cas`/`.ctl`/`.geo`/`.pop`/`.prm`), runner, both output parsers and the arm-1 concordance harness built and tested; `.prm` provably encodes the AMRIT settings; missing binary degrades cleanly and **still writes the input files**; no SaTScan binary or source committed. 31 tests. **SaTScan left the critical path on 14 August 2026** (owner): it is a Windows-first binary that would not run here, cannot be redistributed, and would have made every headline claim depend on a reviewer obtaining a copy. The round-trip criterion is **withdrawn** — nothing depends on it. The bridge survives as optional interoperability for deployments that already run SaTScan. See [SaTScan retirement](#satscan-retirement-14-august-2026). |
| 29 | SaTScan's other models | medium | **done** | Bernoulli (3 shapes), Poisson (2 shapes) and multivariate in both runtimes, agreeing on the shared fixture's cluster geometry and log-likelihood ratios. **Validated against published reference implementations**: `smerc::stat.binom` (169 cases), `smerc::stat.poisson` (56 cases), `scanstatistics::scan_permutation` (6 windows) — all agreeing to machine precision, and one case where the reference is wrong and AMRIT is right. Every model documented with its denominator requirement and failure mode. Single-location deployments get `bernoulli-purely-temporal`. app 28 tests / server 13 tests. |
| 30 | Non-scan detectors | medium | **done** | EWMA, Poisson CUSUM, Bernoulli proportion CUSUM, Farrington 1996 and the Neill Bayesian spatial scan built and registered in both runtimes — twelve detectors across four families. **Farrington agrees exactly with R `surveillance` 1.26.1 `algo.farrington`**: 101 tested periods, every alarm and every trend decision identical, worst threshold difference 1.9e-5, and that package's own output is pinned in the fixture. The other three are pinned against worked examples from their source papers, which is a weaker claim and is labelled as one. Every blind spot documented in `OUTBREAK_DETECTION.md`. app 20 tests / server 21 tests. **Closed 14 August 2026:** all five run inside the Phase 33 harness, which is what the exit criterion asked; Farrington is registered there and reports "not run" with its reason on any corpus shorter than ~1,850 days, measured. Noufaily 2013's ten-level seasonal model remains unimplemented and is explicitly **not claimed** — the plan's exit criterion names a reference implementation *or* a worked example per detector, and Noufaily was never one of the five. See [Phase 30 execution log](#phase-30-execution-log). |
| 31 | The AMRIT detector (PACE) | **HIGH** | **done** | Four components built, each switchable off, in both runtimes; the frozen protocol is written, dated and **deposited before the first benchmark run** ([`PACE_PROTOCOL.md`](./PACE_PROTOCOL.md), SHA-256 `9e6899af…`); `pnpm benchmark -- --ablation` runs the whole grid from one command. PACE reimplements neither statistic — it composes `scanOutbreakEvents` and `scanBernoulli` — and with pooling off and one model it is the control arm **signal for signal**, which a test asserts. app 32 tests / server 17 tests. **Not done:** the endpoints themselves, which are Phase 34's full grid. See [Phase 31 execution log](#phase-31-execution-log). |

### Track E — Evidence

| # | Phase | Risk | Status | Exit criteria (short) |
|---|---|---|---|---|
| 32 | Synthetic data with outbreaks in it | medium | **done** | `app/src/main/outbreak-simulation.ts`: transmission model (index case → exponential acquisition → geometric detection lag → end), five outbreak types, 960-cell factorial (900 seeded + 60 null), machine-readable ground truth, golden digest gated in CI. Corpus **demonstrated to discriminate**: the clonal cluster is found, the proportion shift is not. The shipped demonstration network now carries outbreaks and writes its truth file beside the database. 12 tests. See [Phase 32 execution log](#phase-32-execution-log) — it found a production crash in the detector. |
| 33 | Benchmark harness | low | **done** | `app/src/main/benchmark/` and `pnpm benchmark`. Every arm calibrated to a matched **empirical** false-alert rate on null replicates *before* it sees a seeded cell, ranked by its own evidence statistic. All five endpoints computed by code, including detection delay by re-running each arm at successive data cuts. Reduced grid runs in CI and uploads its report. 23 tests. **Closed 14 August 2026:** the PACE ablation grid lands with Phase 31 and runs from `pnpm benchmark -- --ablation`, bounded, in CI. The exit criterion's remaining clause — a full grid reproducible from a seed — is satisfied by construction (the corpus is regenerated from the grid's seeds); **executing** the 960-cell grid is Phase 34's work, not this phase's. See [Phase 33 execution log](#phase-33-execution-log). |
| 34 | Run the studies and report | low | not-started | Every `‹PENDING›` in the manuscript closed with a measured value or a stated reason · claims register carries evidence per row · pre-registration referenced in Methods · `OUTBREAK_DETECTION.md` documents the whole family |

## Phase 16 execution log

Measured on macOS 15 (arm64), Node 22.22.3, pnpm 11.21.0, Python 3.13.9, at commit
`1766bf7` plus this phase's changes. Every command below is one the workflow runs.

| Command | Result |
|---|---|
| `tools/sync_shared.py --check` | in sync across 2 products, 270 files, contract 2.0 |
| `tools/check_data_licences.py` | 15 datasets recorded, 14 bundled |
| `tools/check_country_neutral.py` | **was failing**, now passes — see corrections |
| `pnpm run check` (tsc + eslint `--max-warnings=0`) | exit 0 |
| `pnpm test` | **417 passed / 3 skipped**, 43 files |
| `AMRIT_COUNTRY_PROFILE=TESTLAND pnpm test` | **417 passed / 3 skipped** |
| `pnpm run build` | exit 0, 2,473 modules |
| `electron-builder --dir` | exit 0, 381 MB unpacked (macOS arm64) |
| `manage.py check` | no issues |
| `manage.py makemigrations --check --dry-run` | no changes detected |
| `manage.py test` | **369 tests, OK** (1 skipped) |
| `AMRIT_COUNTRY_PROFILE=TESTLAND manage.py test` | **369 tests, OK** (1 skipped) |
| `manage.py spectacular --validate` | exit 0 |
| `manage.py migrate` + `smoke_e2e.py` | ALL CHECKS PASSED |

Test counts are above the Phase 15 baseline (368 app / 339 server) because the outbreak,
demonstration-network and manuscript work landed after it, plus this phase's four.

**What still needs the owner.** These are the parts of the exit criteria that cannot be
completed from this machine:

| Item | Why | Needs |
|---|---|---|
| Any leg of the matrix actually running | `git remote -v` is empty and `gh` is not installed — the workflow has never executed | A GitHub (or other) remote, and a push |
| Windows and Linux verification | Only macOS is available here | The remote above; the matrix covers both once it can run |
| Clean-VM launch of the installers | No VM access | A Windows and a Linux machine, or a self-hosted runner |
| Code signing and notarisation | Credentials are the owner's | Apple Developer ID + notarytool, Windows EV or Azure Trusted Signing, stored as repository secrets |

## Phase 32 execution log

**Deliverables**

| Item | Where |
|---|---|
| Generator | [`app/src/main/outbreak-simulation.ts`](../../app/src/main/outbreak-simulation.ts) |
| Tests (12) | [`app/tests/outbreak-simulation.test.ts`](../../app/tests/outbreak-simulation.test.ts) |
| Golden digest | `app/tests/fixtures/outbreak-simulation.golden.json` |
| Factorial corpus CLI | `pnpm outbreak:corpus -- --out <dir>` |
| Demonstration network with outbreaks | `pnpm demo:network -- --database <path>` (`--no-outbreaks` for the old behaviour) |

**Measured end to end.** Seeded a real database (6,000 background isolates across four
sites, 26 outbreak cases), then ran the application's own detector over it: DEMO-DEL-01
produced 13 signals and 2 alerts on the seeded *K. pneumoniae* carbapenem cluster;
DEMO-MUM-01 produced the seeded *E. coli* colistin cluster. The outbreak page is no longer
empty.

**The corpus discriminates**, which is the property that makes it a benchmark rather than a
demonstration. On a one-site 180-day corpus the case-only scan found the clonal cluster and
returned **zero** signals for the proportion shift — the arm built specifically to need a
denominator.

**What running it found.** All four are recorded in
[`docs/OUTBREAK_DETECTION.md`](../OUTBREAK_DETECTION.md); the first is a fixed crash.

1. **`outbreak-detection.ts` crashed on realistic volumes.** `Math.max(...dates)` spreads
   one argument per event; a year of a four-site network is ~122,000 of them and V8 throws
   `RangeError: Maximum call stack size exceeded` past roughly 125,000. **Every deployment
   large enough to need the scan would have hit it.** Folded into a loop.
2. **Replications silently cap alerting.** The recurrence interval ceiling is
   `permutations + 1`, so at the exploratory 99 or at 199 no alert can reach the 365-day
   default threshold however large the cluster.
3. **One outbreak, thirteen signals — and the alerts named the wrong mechanism.** The
   seeded phenotype was carbapenem; ceftriaxone and ceftazidime alerted at RI 1,000 while
   the three carbapenems came in at 333, 91 and 24, all below threshold. This is the
   per-agent fragmentation Phase 31 targets, now demonstrated rather than argued.
4. **Runtime.** ~30 s for one site at 999 replications over ~32,000 events. The 960-cell
   grid × several detectors is days of serial compute, so Phase 33 must parallelise and CI
   must run a reduced grid. `--manifest-only` exists for a scheduler.

## Phase 27 execution log

**Deliverables**

| Item | Where |
|---|---|
| Contract | `app/src/main/detection/types.ts` |
| Registry | `app/src/main/detection/registry.ts` |
| Denominators | `app/src/main/detection/denominators.ts` |
| STPSS adapter | `app/src/main/detection/space-time-permutation.ts` |
| Python mirror | `server/amrit_central_server/analytics/detectors.py` |
| Shared fixture | `shared/golden-datasets/detector_reference.json` |
| Tests | `app/tests/detection-framework.test.ts` (13), `server/.../analytics/test_detectors.py` (11) |

**The control arm is intact.** `outbreak-detection.ts` is untouched; the registry wraps it.
A test asserts the wrapped signals are byte-identical to calling `runOutbreakDetection`
directly, field for field, because a control arm that was rewritten while being wrapped is
not a control.

**Two decisions worth knowing:**

*Detectors declare what they need.* A Bernoulli or Poisson model cannot run without a
denominator and a circular window cannot run without coordinates, so `unavailableReason`
returns a sentence rather than a boolean — an operator has to be told what to change, and
"no denominators" and "only one location" need different answers.

*Every signal carries `detector_id`.* Once several detectors can run, the same ward and the
same fortnight mean different things from a case-only scan and a proportion scan, and an
unattributed signal is also unreproducible. It is read from the registry, not written at
the call site, so it cannot drift from what produced it.

**The denominator model.** `deriveDenominators` produces tested and resistant counts per
date, location, organism and agent — the denominator the case-only method throws away and
Phase 29's Bernoulli model needs. An agent counts as tested when the record carries `R`,
`I` or `S`; `I` is **not** counted as resistant, because the scan already refuses to merge
it and counting it here would make numerator and denominator disagree about what resistance
means. `describeDenominatorCoverage` names what a laboratory record cannot supply —
patient-days, admissions, occupied beds — so nobody assumes the Poisson model is available.

**Blocker recorded for Phase 29: the portal cannot run a denominator-requiring detector.**
The federation wire carries the count of *resistant* cases and nothing about how many
isolates were tested. Adding the denominator is a contract change with a privacy dimension —
a second number per cell, so k-anonymity suppression has to be recomputed — and it is a
Phase 29 decision, recorded now rather than discovered then.

**What the parity fixture found on its first run.** The two runtimes label the all-island
cluster differently: the desktop says `All locations`, the portal says `All sites`. Every
number agreed — both log-likelihood ratios matched to three decimals — so the statistic is
the same. The labels differ because the islands differ: the desktop scans wards inside one
laboratory, the portal scans reporting sites across a federation. Both are correct for what
they hold, so the fixture records the mapping rather than forcing one product to borrow the
other's word for a thing it does not have.

## Phase 28 execution log

**Deliverables**

| Item | Where |
|---|---|
| Input writers and output parsers | `app/src/main/detection/satscan/format.ts` |
| Runner and availability | `app/src/main/detection/satscan/runner.ts` |
| Arm-1 concordance harness | `app/src/main/detection/satscan/concordance.ts` |
| Tests (26) | `app/tests/satscan-bridge.test.ts` |

**Three decisions worth knowing.**

*Categorical locations are written as islands.* SaTScan is built around geography: a cluster
is a circle over coordinates. AMRIT scans wards and reporting sites as categorical islands
and deliberately infers no adjacency. So each location is written to the coordinates file on
a grid spaced 1,000 apart and the spatial window is set to 1, making every circle
single-location — the question AMRIT actually answers. Giving the wards plausible-looking
coordinates would have quietly asked SaTScan an easier question.

*SaTScan is a comparator, not a `Detector`.* The registry's contract is synchronous and
in-process. SaTScan is a subprocess that writes files, can take minutes, and fails for
reasons no in-process detector can. Forcing it in would mean making every detector async for
one, or giving this one a `run` that throws. It is described alongside the detectors with an
honest reason when unconfigured, and driven through `runSatScan`.

*A missing binary still writes the files.* An air-gapped ministry prepares the run on the
machine with the data and carries the directory to one with SaTScan. Losing the work because
the binary is absent would make the bridge useless exactly where it is most needed.

**Concordance matching** follows the paper plan: identical location set, overlapping time
window. Identical locations because a cluster over a different ward is a different finding
however similar its statistics; overlapping windows because the two implementations tie-break
candidate windows differently and demanding identical dates would score a one-day difference
as disagreement. AMRIT's all-location temporal cluster is **excluded from matching and said
to be excluded**: a SaTScan run with island coordinates cannot form a cluster spanning every
location, so that is a difference in what was asked, not a disagreement about an answer.

**The honest limit.** Every format here is written to SaTScan's published documentation and
tested against fixtures built to that documentation. That proves the writers and parsers are
self-consistent. It does **not** prove the documentation was read correctly — no SaTScan
installation existed on this machine. The first round-trip against a real binary is the check
that matters, which is why `runSatScan` records the binary's version on every run.

**Superseded 14 August 2026.** This phase used to ask the owner to install SaTScan and run the
bridge once. It no longer does: SaTScan left the critical path and arm 1 of Study B is now run
against open-source R reference implementations. The bridge remains, tested, as optional
interoperability for a deployment that already has SaTScan; if such a deployment ever runs it,
whatever the formats got wrong will surface then. Nothing waits on it. See
[SaTScan retirement](#satscan-retirement-14-august-2026).

## Phase 33 execution log

**Deliverables**

| Item | Where |
|---|---|
| Evidence statistic per detector | [`app/src/main/benchmark/ranking.ts`](../../app/src/main/benchmark/ranking.ts) |
| Matched empirical false-alert-rate calibration | [`app/src/main/benchmark/calibration.ts`](../../app/src/main/benchmark/calibration.ts) |
| Signal-to-truth matching rule | [`app/src/main/benchmark/matching.ts`](../../app/src/main/benchmark/matching.ts) |
| Endpoints | [`app/src/main/benchmark/endpoints.ts`](../../app/src/main/benchmark/endpoints.ts) |
| Grid runner | [`app/src/main/benchmark/harness.ts`](../../app/src/main/benchmark/harness.ts) |
| CLI | `pnpm benchmark -- --out <dir> [--reduced]` |
| Tests (23) | `app/tests/benchmark-harness.test.ts` |
| CI | reduced grid on Linux, report uploaded as an artefact |

**The order is enforced by the code, not by whoever runs it.** Null replicates are generated and
scored first, each arm is calibrated on those alone, and only then are the seeded cells generated.
Calibrating on data containing the outbreaks would let a detector choose its threshold knowing what
it is about to be asked to find.

**Four decisions worth knowing.**

*Arms are ranked by their own evidence statistic, and the scan family's is the log-likelihood ratio
rather than the recurrence interval.* The recurrence interval is capped at `permutations + 1`, so
every cluster past the p-value floor ties at the ceiling and no tight alert budget could order them.
The log-likelihood ratio has no ceiling and is deterministic given the data, which also makes the
replication count a speed setting rather than a sensitivity setting — the benchmark runs at 99
replications, which would disable alerting in production and is harmless here because nothing reads
a p-value. Stated as a cost: the log-likelihood ratio is uncorrected for the multiple testing the
p-value corrects for.

*An all-location signal is allowed to match, and spatial accuracy is reported separately.* Four of
the twelve detectors have no spatial dimension. A matching rule requiring the seeded ward would
score them at zero sensitivity by construction, which reports the rule's shape rather than the
method's. So sensitivity admits the pooled signal and spatial accuracy — the proportion of matched
signals that named the right ward — is its own column. The purely temporal Bernoulli scan duly
scores full sensitivity and 0% spatial accuracy, which is exactly what it is.

*Detection delay is measured by re-running each arm at successive data cuts.* A single run at the
data cut reports the interval between the outbreak's first specimen and the signal's end date, which
is the outbreak's age — a property of the corpus, identical for every arm. Measuring latency means
truncating the corpus and asking on which day each arm first alerts, which multiplies the compute by
the number of cuts and is why the stride is configurable and off by default. On a two-cell probe the
measurement discriminated: 4 days for the multivariate scan, 8 for the space-time Bernoulli, 12 for
everything else.

*The antibiotic is deliberately not part of the matching rule.* A clonal outbreak expresses across
every agent its mechanism affects, and Phase 32 measured the case-only scan naming amikacin for a
carbapenem cluster. Requiring the agent would score a detector on which co-resistant agent it ranked
first, which none of these methods claims to determine.

**What building it found.**

1. **Null and seeded cells must cover the same sites, and nearly did not.** `factorialDesign` pins
   each outbreak type to a particular site — the proportion shift at `DEMO-KOL-01`, the single-agent
   cluster at `DEMO-MUM-01` — so a run that supplies one site cannot generate half the grid. The
   deeper problem is that the false-alert rate is per site-year: calibrating on one site and
   evaluating on four would set a threshold against a quarter of the geography it is then applied
   to. The site count is now derived from the grid and checked.
2. **An arm that never ran was reporting 0% sensitivity.** Farrington needs five years of history
   and no corpus here has them, so it is unavailable on every cell — and the table printed it beside
   detectors that had looked and found nothing. "Did not look" and "looked and missed" must not
   print the same. Every endpoint is now `null` when the arm did not run, and the table says
   **not run** with the reason the detector gave.
3. **The calibration could have been set from a truncated null distribution.** Detectors cap their
   reported signals at 50 per run, and Phase 30 measured the EWMA chart finding several hundred on a
   single null corpus. The threshold is safe while the alert budget is below what the cap retains,
   and silently wrong above it, so `calibrate` now refuses to run rather than assuming it.

**Not a source of numbers yet.** The reduced grid is two seeded cells with 95% intervals from 9% to
91%. Nothing in it is a finding; it is a regression gate. The full 960-cell grid is Phase 34, and the
PACE ablation needs Phase 31 — the harness takes arms as data, so PACE will need no change here.

**Closed 14 August 2026.** PACE did need no change here: `paceAblationArms()` is seven arms built
from the same `BenchmarkArm` shape, and the harness did not move. Two things were added when Phase
31 used it, both because Phase 31 could not have been reported honestly without them.

*The alert rate each detector's own rule produces, per arm.* Every endpoint in this harness is
measured after the matched calibration has replaced the detector's threshold, which is what makes
sensitivity comparable and also what makes a detector's own alerting invisible.
`nativeAlertsPerSiteYear` counts the alerts each arm raised under its own rule on the null
replicates. It costs nothing — those runs had already happened — and it is the only column in which
PACE's third component, or the control's nominal 365-day recurrence interval, can be judged.

*An arm that never ran now says so in the notes as well as the table.* A seven-row table hides a
"not run" row easily, and the reason is usually a property of the corpus rather than of the method.

**The Farrington question, answered with a measurement.** Phase 30 left it open: lengthen the corpus
for that arm or exclude it and say which. Measured on single-site null corpora — 730 days
unavailable, **1,825 days still unavailable** (it needs 264 weekly periods before it can test one,
about 1,850 days), 2,200 days runs: 1,134 series, 56,143 periods tested, 4.2 s. So the answer is
**exclude it, and say why**: every arm must see the same corpus, because the calibration is per
site-year over shared nulls, so running Farrington on its own longer corpus would produce a
sensitivity that is not comparable to any other row. A grid that wants Farrington must run
`--window-days 2000` or more **for every arm**, and the report now names the arm that did not run.

## SaTScan retirement, 14 August 2026

**Decision (owner).** SaTScan is dropped as a requirement. It is a Windows-first binary that would not run
on the development machine, its licence forbids redistribution, and every claim resting on it would have
required a reviewer to obtain a copy before they could check anything.

**Why this costs nothing.** The comparison SaTScan was for is available from software that runs everywhere.
AMRIT now implements SaTScan's model set natively — space-time permutation, Bernoulli, Poisson, purely
temporal, purely spatial, multivariate — and the external validation those models needed comes from
published R packages that any reviewer can install in one command:

| AMRIT | Reference | Result |
|---|---|---|
| Farrington 1996 | `surveillance::algo.farrington` 1.26.1 | 101 tested periods: every alarm, every trend decision, thresholds to 1.9e-5 |
| Bernoulli log-likelihood ratio | `smerc::stat.binom` | 161 of 169 cases exact; the other 8 are a reference defect, below |
| Poisson log-likelihood ratio | `smerc::stat.poisson` | 56 of 56, to 1e-13 |
| Space-time permutation kernel | `scanstatistics::scan_permutation` | 6 windows, to 6.2e-15 |

**This is a stronger position than the one it replaces**, not a retreat from it. A concordance figure a
reader can reproduce on their own machine is worth more than one resting on a binary they must request, and
the comparison is now against four independent implementations rather than one.

**What running the references found.**

1. **`smerc::stat.binom` returns zero where the statistic is finite.** When every case of a stream falls
   inside the candidate window, `smerc` evaluates `0 * (log(0) - log(popout))`, gets `NaN`, and silently
   zeroes the result. The limit of `x log x` as `x` tends to zero is zero, so the statistic is finite —
   87.2 in the pinned case — and AMRIT computes it. Eight of 169 cases land there. Recorded in the
   direction the disagreement runs, because "we differ from the reference" and "the reference is wrong
   here" are different claims.
2. **AMRIT's space-time permutation is the day-of-week-stratified variant and `scanstatistics` is not.**
   Both select the same zone and the same window on the shared fixture; the expected count differs because
   AMRIT stratifies the margins by day of week, which `docs/OUTBREAK_DETECTION.md` has always stated. The
   log-likelihood ratio kernel agrees to 6.2e-15 on identical observed and expected counts. A
   cluster-for-cluster comparison of the two detectors would measure the stratification, so Phase 33 must
   say which variant any external comparison is against. This was briefly mistaken for a defect in the
   expectation before the stratification was traced; it is not one.

**What changed in the plan.** Phase 28's round-trip exit criterion withdrawn. Phase 29's exit criterion
re-pointed from SaTScan to "a published reference implementation" and now met. Phase 31's pre-registered
hypothesis amended, dated, with the original text preserved and the amendment made before any benchmark run.
Phase 33's SaTScan arm made optional. Study B arm 1 in the paper plan re-pointed at the R references.

**What is not claimed.** The bridge's file formats are still verified against SaTScan's published
documentation rather than against real SaTScan output. That was true before and remains true; the
difference is that nothing now depends on it.

## Phase 29 execution log

**Deliverables**

| Item | Where |
|---|---|
| Bernoulli scan, 3 shapes | [`app/src/main/detection/bernoulli.ts`](../../app/src/main/detection/bernoulli.ts) |
| Poisson scan, 2 shapes | [`app/src/main/detection/poisson.ts`](../../app/src/main/detection/poisson.ts) |
| Multivariate scan | [`app/src/main/detection/multivariate.ts`](../../app/src/main/detection/multivariate.ts) |
| Python mirror | `server/amrit_central_server/analytics/scan_models.py` |
| Bridge: population file, Bernoulli/Poisson paths | `app/src/main/detection/satscan/format.ts`, `runner.ts` |
| Tests | `app/tests/detection-models.test.ts` (21), `server/.../analytics/test_scan_models.py` (13), 5 added to `app/tests/satscan-bridge.test.ts` |
| Shared fixture | `shared/golden-datasets/detector_reference.json` — `bernoulli`, `poisson`, `multivariate` sections |

**The two runtimes agree on the statistic, not merely on the descriptors.** Phase 27's fixture
pinned descriptors and denominator derivation. This one pins the geometry: on the same fourteen
days of denominators, the desktop and the portal select the same window (Medical ICU, meropenem,
11–14 March), with the same 20 of 24 resistant against a baseline share of 0.167, and the same
log-likelihood ratio of 20.912. The Poisson model likewise: 20 observed against 5.03 expected,
LLR 15.977. p-values are still not pinned, for the Phase 27 reason.

**What running it found.** All four are in [`docs/OUTBREAK_DETECTION.md`](../OUTBREAK_DETECTION.md).

1. **SaTScan's multivariate null is invalid on AMR data, and not marginally.** The published
   statistic permutes each data stream independently. On a 180-day single-site corpus with **no
   outbreak seeded at all** it produced three signals at the p-value floor; across five null
   replicates, twelve — against zero for the case-only scan and one for the univariate Bernoulli.
   The cause is that the agents of one organism are columns of the same isolate, so the data
   carry co-resistance and the independent null does not. Replaced as the default by an
   isolate-permutation null, which returns nothing on the same corpus. SaTScan's is kept as a
   setting because Phase 33 needs the faithful arm and the claim should be reproducible.
2. **The proportion-shift arm is now detected, and by exactly one family.** Case-only: zero
   signals. Space-time Bernoulli: three, strongest on the seeded ward and the seeded mechanism,
   at a resistant share of 0.966 against 0.546. Phase 32 built that arm to be invisible to a
   case-only scan; Phase 29 is the first thing that can see it.
3. **The proportion scan localises a clonal cluster the case-only scan does not.** On the
   clonal arm the case-only scan gave one signal scoped `All locations` naming amikacin — an
   agent dragged along by co-resistance. The Bernoulli scan put its strongest signal on the
   seeded ward with imipenem, one of the three carbapenems that defined the outbreak.
4. **The multivariate scan cannot be validated through the Phase 28 bridge.** SaTScan's
   multivariate model takes multiple case files and assumes the independence this data lacks,
   so the two are not computing the same statistic. A difference in method, not a disagreement
   about an answer, and recorded as such rather than reported as poor concordance.

**The Phase 27 blocker, decided.** The federation wire carries resistant cases and no tested
count, so no model here can run centrally. Adding one was **deferred out of Phase 29**: a second
number per cell is a privacy change rather than a schema change — a cell that is safe as
"4 resistant" is not necessarily safe as "4 resistant of 4 tested", which identifies a complete
testing panel in a small ward and forces k-anonymity suppression to be recomputed over pairs. It
is also a contract version bump with a migration for every enrolled site, and Phase 21 has not
shipped a release path that can carry one. Nothing in Phase 29's exit criteria needs it. Each
detector therefore registers on the portal and reports unavailable with a reason naming the wire
and pointing at the laboratory node.

**Exit criterion met, 14 August 2026, against a different comparator.** This phase used to be
blocked on a SaTScan installation. The criterion now reads "agrees with a published reference
implementation within Monte-Carlo tolerance", and it is satisfied: `smerc::stat.binom` over 169
cases, `smerc::stat.poisson` over 56, and `scanstatistics::scan_permutation` over 6 windows, all
to machine precision, plus one case where the reference is wrong and AMRIT is right. Nothing in
this phase now waits on the owner. See [SaTScan retirement](#satscan-retirement-14-august-2026).

## Phase 30 execution log

**Deliverables**

| Item | Where |
|---|---|
| Daily series every non-scan detector reads | [`app/src/main/detection/series.ts`](../../app/src/main/detection/series.ts) |
| EWMA, Poisson CUSUM, Bernoulli CUSUM | [`app/src/main/detection/process-control.ts`](../../app/src/main/detection/process-control.ts) |
| Farrington 1996 | [`app/src/main/detection/farrington.ts`](../../app/src/main/detection/farrington.ts) |
| Quasi-Poisson IRLS | [`app/src/main/detection/glm.ts`](../../app/src/main/detection/glm.ts) |
| Distribution functions | [`app/src/main/detection/statistics.ts`](../../app/src/main/detection/statistics.ts) |
| Bayesian spatial scan | [`app/src/main/detection/bayesian-scan.ts`](../../app/src/main/detection/bayesian-scan.ts) |
| Python mirror | `server/amrit_central_server/analytics/nonscan_models.py` |
| Tests | `app/tests/detection-nonscan.test.ts` (20), `server/.../analytics/test_nonscan_models.py` (21) |

**Validated against the reference implementation, not against a description of it.** R was
available on this machine and `surveillance` 1.26.1 installed, so Farrington was compared against
`algo.farrington` — the algorithm ECDC and UKHSA actually run — on a fixed 364-week series with
trend, seasonality and two injected excesses. Across all 101 testable periods: **every alarm
identical, every trend-retention decision identical, worst relative threshold difference
1.9 x 10^-5.** Both runtimes. That package's own output is pinned in
`shared/golden-datasets/detector_reference.json`, so the agreement is a test rather than a memory.

**What running it found.**

1. **A wrong dispersion in the trend test that agreed on every alarm.** R's `summary.glm`
   recomputes its own dispersion for the coefficient t-test and never sees the `phi` that
   Farrington floors at 1. Using the floored value — the obvious choice — matched the reference on
   all 101 alarms and disagreed about the *trend term* in four of them, moving the threshold by up
   to 28% where it differed. Agreement on the headline number is not agreement.
2. **The control charts alarm freely under the null, measurably.** On a 730-day single-site corpus
   with no outbreak seeded, EWMA produced more than fifty signals across 241 charted series. Not a
   defect: 241 independent charts with no multiplicity correction will do that. It is the concrete
   argument for Phase 33's matched-empirical-false-alert-rate design. The result now reports
   `signalsFound` alongside the capped list, because a cap of fifty that hides six hundred hides
   the number that matters.
3. **The Bayesian scan reported nothing on data it had clearly responded to.** Neill spreads the
   outbreak prior across every enumerated region; with the ~6,400 regions a real corpus produces,
   each starts near one in a million and no region reached the 5% reporting threshold even with a
   seeded cluster present — while the posterior that *nothing* was happening had fallen from 0.994
   to 0.680. Fixed by computing and reporting both the unconditional posterior and the posterior
   conditional on an outbreak existing somewhere, and thresholding on the latter. It now finds the
   seeded ward and stays silent on the empty corpus.
4. **Farrington cannot run on any corpus this repository generates.** It needs five years of
   history; `outbreak-simulation.ts` defaults to 730 days. The detector says so with the numbers
   rather than returning "no aberrations" for a method that was never able to test a period. Phase
   33 must generate a longer corpus for this arm or exclude it and say which.

**Two detectors reached the portal**, which is the first time a phase has *added* central
capability rather than recording why it cannot. EWMA and the Poisson CUSUM need a count per period
and nothing else, and the federation wire already carries that — no contract change, no privacy
question.

**No new dependency.** The normal quantile, Student-t tail, incomplete beta and negative-binomial
quantile are written out in both runtimes and tested against R, rather than adding scipy to a
server a ministry has to deploy for the sake of one t-distribution tail.

**What is not done, and is not claimed.** Noufaily 2013's ten-level seasonal model is not
implemented — its negative-binomial threshold and 2.58 reweighting cutoff are available as
settings, and selecting them gives Farrington 1996 with two of Noufaily's changes rather than
`farringtonFlexible`. Implementing the threshold without the seasonal model would produce numbers
matching neither paper. The detectors also do not yet run inside a benchmark harness, which is
Phase 33 and is where the exit criterion "all in the benchmark harness" is met.

## Phase 17 execution log

**Deliverables so far**

| Item | Where |
|---|---|
| The four seams | `app/src/core/db/driver.ts`, `io/assets.ts`, `secrets/store.ts`, `paths/resolver.ts` |
| The bundle a platform satisfies | `app/src/core/platform.ts` |
| Node platform | `app/src/adapters/node/index.ts` |
| Purity gate | `no-restricted-imports` / `no-restricted-globals` on `src/core/**` in `app/eslint.config.js` |
| Tests (10) | `app/tests/core-platform.test.ts` |

**The synchronous/asynchronous decision, taken.** The plan set out three options and recommended
the first; that is what the interface encodes. `core/` is **asynchronous throughout**, because
`@capacitor-community/sqlite` is Promise-based and a WebView cannot block, and the desktop adapter
wraps synchronous `node:sqlite` in resolved promises at a cost of one microtask per query. The
rejected alternative — a WASM SQLite on mobile so `core/` could stay synchronous — was rejected
for a reason worth keeping: it adds a second SQLite implementation to test, with its own
persistence story inside a WebView, and every bug then has to be reproduced twice.

**The gate is enforced, and was checked by breaking it.** A file importing `node:fs` was planted
under `core/` and ESLint failed with the message the rule carries. The rule also forbids `core/`
importing an adapter, because that inverts the seam and would compile.

**The adapter is tested against a database, not a mock.** A mock agrees with whatever the
interface says. The tests open real SQLite files: a transaction that throws rolls back and keeps
*the caller's* error rather than a rollback error; `backup` is `VACUUM INTO` and the result is
opened and read, because a file copy taken mid-write is a corrupt database that looks fine until
it is restored.

**`isHardwareBacked` is on the `SecretStore` interface deliberately.** A site token in the iOS
Secure Enclave and one in a laptop process are not the same control, and a deployment policy that
cannot tell them apart cannot be enforced. The Node adapter answers `false` and means it.

**28 modules moved, no test edited.** `core/` now holds 34 files: the whole detection stack
(15 modules plus `outbreak-detection.ts`), the terminology service, the HL7 v2 parser, the
benchmark's ranking and calibration, One Health, validation, retention, breakpoint mapping,
epi-time, identifiers and the profile holder. Every caller keeps its old import path through a
one-line shim, which is what makes this an extraction rather than a rewrite: **668 tests pass and
not one was changed**.

**The gate found a real coupling the moment it could.** Four moved modules failed it by importing
`main/active-profile`, which resolved a country profile by reading a file — so a domain module
that only wanted to know which country it was running for pulled the filesystem in behind it. The
holder is now in `core/` with a `setProfileResolver` seam, and the desktop installs a resolver
that reads from disk. `activeProfile()` **throws** when no resolver has been installed rather than
inventing a country: a record filed under the wrong country's rules is worse than a startup that
stops and says what is missing.

**What is not done, and is the rest of the phase.** `database.ts` — 4,395 synchronous lines — has
not been converted to the asynchronous seam, and neither have its callers; until that lands,
`services.ts`, `analysis-engine.ts` and the exporters stay in `main/`. 18 modules still import
`node:*` or `electron`, and every one of them is either the database, an asset reader, a path
resolver, a credential store or a subprocess — which is to say, each is a candidate for exactly
one of the four seams.

## Phase 31 execution log

**Deliverables**

| Item | Where |
|---|---|
| Mechanism mapping and the pooling rule | [`app/src/main/detection/phenotype.ts`](../../app/src/main/detection/phenotype.ts) |
| The detector | [`app/src/main/detection/pace.ts`](../../app/src/main/detection/pace.ts) |
| Python mirror of every rule | `server/amrit_central_server/analytics/pace.py` |
| Ablation arms | `paceAblationArms()` in `app/src/main/benchmark/harness.ts` |
| Catalogue for a headless run | `app/src/main/benchmark/catalogue.ts` |
| Frozen protocol | [`PACE_PROTOCOL.md`](./PACE_PROTOCOL.md), SHA-256 `9e6899af732ab572967cca7bc7ef4495d3da8e291a476cf067ff43f4fea2b12b`, 14 August 2026 |
| CLI | `pnpm benchmark -- --ablation --out <dir>` |
| Tests | `app/tests/detection-pace.test.ts` (32), `server/.../analytics/test_pace.py` (17) |
| Shared fixture | `shared/golden-datasets/detector_reference.json` — `pace` section |

**The protocol was deposited before the first run, and the order is checkable.** The protocol
file was written and hashed before `--ablation` had ever been executed, and it says so in its own
text; it also records what was already known at the time — the stream counts, the proportion-shift
behaviour — so that no earlier measurement can be re-presented as a result.

*The protocol has not been touched since, and its hash still verifies.* It states "31 desktop
tests", which was the count at deposit; a 32nd was added afterwards, asserting that the
plausibility sweep — an optimisation from comparing every pair to a per-ward sweep, made because an
organism-level signal in a busy ward can carry thousands of isolates — computes exactly what the
pairwise definition computes. Amending a deposited protocol for a test count is precisely the habit
the deposit exists to prevent, so the discrepancy is recorded here instead.

**PACE reimplements neither statistic.** The case-only arm calls `scanOutbreakEvents`, the same
function the control arm calls; the proportion arm calls `scanBernoulli`. Both are already pinned
against published R references. What PACE adds is the four components and the bookkeeping between
them, which means a disagreement with a reference can only ever be about a kernel both arms share.
The consequence worth stating: **with pooling off and one model, PACE is the control arm signal for
signal** — same ids, same p-values, same order — and a test asserts it rather than a comment
claiming it.

**One change to the control file, and what it is.** `outbreak-detection.ts` now also returns
`nullMaximumMean` and `nullMaximumSd`, the two moments of the Monte Carlo maxima it had already
computed. PACE needs them to put a permutation scan's log-likelihood ratio and a Bernoulli scan's
on one scale. The statistic, the events, the signals and the settings are untouched, and the parity
test that pins the wrapped signals to `runOutbreakDetection` still passes.

**What building it found.** All five are recorded in
[`docs/OUTBREAK_DETECTION.md`](../OUTBREAK_DETECTION.md).

1. **The re-ranking component demoted the right answer, on its first corpus.** Ordering by
   plausibility before evidence put the seeded `carbapenem-R` cluster sixth, behind four
   co-resistant streams that happened to score 1.0 — the precise failure component 4 was meant to
   fix. Signals are now banded by evidence rounded to the nearest standardised unit, and
   plausibility orders only within a band.
2. **Plausibility saturates in a busy ward.** Almost every pair of medical-ICU cases overlaps, so
   nearly every cluster scores 1.0. The component is informative in small or sparse wards and close
   to inert otherwise. Room-level data would fix it and AMRIT does not capture room-level data.
3. **A mixed-case identifier silently emptied a cluster.** Phenotype ids are mixed case
   (`carbapenem-R`); both counting paths upper-case agent codes. An exact match therefore found no
   cases for every pooled stream whose id was not already upper case, which showed up as a
   plausibility of 0 on exactly the streams that mattered — and then, through component 4, as a
   demotion. Two bugs compounding, found by printing the numbers.
4. **Pooling fixes the fragmentation without fixing which mechanism leads.** 16 signals against the
   control's 22 on a 120-day corpus, 14 against 18 at 180 days, 10 against 18 at 365. But the
   seeded `carbapenem-R` stream ranked first at 120 and 365 days and eighth at 180, behind
   cephalosporin streams the seeded strain genuinely carries. No claim is made about rank; the
   benchmark's matching rule ignores the antibiotic for the same reason.
5. **The proportion arm needs a ward with a denominator left in it.** Phase 32's proportion-shift
   arm works by removing susceptible isolates; on a medium-background single-site corpus that
   leaves 13 tested isolates in the seeded window and nothing is detectable by any method. At the
   high background rate PACE finds it on the seeded ward and the seeded mechanism, 1.000 against
   0.697 elsewhere. Detectability of that arm is a property of ward volume, so any report of it has
   to state the background rate.

**The ablation grid runs, and its first run says nothing — which is the correct result.** One
command produced all seven arms in 53 seconds on a bounded grid (one site, 180 days, two seeded
cells, two null replicates), and the numbers are not usable: every arm reported **zero** signals on
the null corpora, so the matched calibration had nothing to bind on ("all signals" admitted) and the
native-alert-rate column that measures component 3 is 0.00 everywhere. Sensitivity is 100% for six
arms with a 95% interval of 34–100%. Nothing in that is a finding, and the protocol said in advance
that it would not be. What the run establishes is the thing Phase 31 owed: the grid exists, every
component switches off independently, and CI runs it on every push so a component that quietly
stops being ablatable fails the day it lands. Runtime cost: PACE 8.8 s against the control's 6.3 s
on the same four cells, roughly 1.4x, most of it the second scan.

**PACE is not the default, and the interface still calls the control directly.** Making it the
default before the benchmark has run would be choosing the winner in advance, which is the same
reason `DEFAULT_DETECTOR_ID` did not move in Phase 29 or 30. Wiring the analysis page to the
registry is not part of this phase's exit criteria and has not been done.

**Component 3 cannot be measured through the endpoints, and that is said in advance.** The harness
replaces every arm's threshold with a matched empirical one — the whole point of Phase 33 — so the
`pace-no-calibration` arm will report the same sensitivity as full PACE. The benchmark now reports
`nativeAlertsPerSiteYear` per arm, counting the alerts each detector's **own** rule raised on the
null corpora, and that column is where component 3 is visible. It costs nothing: the null runs had
already happened.

**Not done, and not claimed.** No endpoint has been computed. The reduced ablation grid is a
regression gate, not a result; the 960-cell study is Phase 34. The superiority hypothesis stands
untested, with its failure condition written down.

## Pre-registered superiority hypothesis (Phase 31)

Recorded here on the date the plan was written, so its provenance is checkable.

**Original, as recorded:**

> At a matched **empirical** false-alert rate of one per site-year, PACE detects seeded clonal multi-drug
> outbreaks of ≤ 20 excess cases with at least **15 percentage points** higher sensitivity, and a median
> detection delay at least **2 days** shorter, than per-agent case-only space-time permutation as run by both
> AMRIT's current detector and SaTScan.

**Amendment, 14 August 2026, before any benchmark run.** The trailing clause becomes "…as run by AMRIT's
current detector, whose agreement with a published reference implementation is established separately."
SaTScan is dropped as a second implementation of the comparator.

*What does not change:* the comparator method — per-agent case-only space-time permutation, one stream per
organism–antibiotic pair, fixed recurrence-interval threshold — and both endpoints, both thresholds and the
failure condition.

*Why this is legitimate rather than a violation of pre-registration:* no benchmark has run, no endpoint has
been computed, and the amendment is recorded with its date and its reason alongside the original text rather
than replacing it. Amending a hypothesis after seeing results is the thing pre-registration exists to
prevent; amending it before any data exists, in public, is not that. The comparator's fidelity is now
established against `smerc` and `scanstatistics` instead, which is a check a reviewer can repeat.

**Failure condition:** if either endpoint is not cleared, the superiority claim is dropped and the paper
reports equivalence plus the operational advantages.

**Scope of the claim:** better than the WHONET–SaTScan workflow *as the field runs it* — case-only space-time
permutation, one stream per organism–antibiotic pair, fixed recurrence-interval threshold. **Not** better than
every model SaTScan can be configured to run. SaTScan ships Bernoulli and multivariate models; the unqualified
claim would be false and a reviewer would say so. That scope statement is unaffected by dropping the binary:
it is a claim about a workflow, not about an executable.

## Corrections found during execution

Plan claims that contact with the code disproved. This table is the most useful thing the last plan produced;
keep it fed. Add a row the moment reality contradicts PLAN.md, and fix PLAN.md in the same commit.

| Claim | Reality |
|---|---|
| "Implement SaTScan in addition to the existing outbreak detection algorithm" (as briefed) | The existing algorithm **is** SaTScan's algorithm — Kulldorff's space-time permutation scan statistic, the model WHONET drives SaTScan with, already implemented in both runtimes and documented as such in `docs/OUTBREAK_DETECTION.md`. Rescoped before planning to interoperability + the models SaTScan has that AMRIT lacks + non-scan detectors. |
| "Prove the algorithm here is better than SaTScan" (as briefed) | Not achievable against a faithful reimplementation of the same statistic: two correct implementations differ only by Monte-Carlo noise. Rescoped to building a genuinely different detector (Phase 31) and testing it against a pre-registered endpoint, with the failure condition written before the run. |
| Windows support assumed present because `electron-builder` declares `win: { target: ['nsis','portable'] }` | Declared, never built. `app/release/` holds macOS output only and there is no CI, so no Windows or Linux artefact has ever been produced or launched. Phase 16 exists because of this. |
| FHIR export assumed to imply LOINC | It does not. `services.ts:1441` emits `code: { text: 'Organism identified' }` and `services.ts:1466` emits `system: 'urn:whonet:antibiotic-code'`. LOINC codes sit in the catalogue for 121 of 399 antibiotics and are read by nothing. |
| Coded diagnosis assumed to flow through to output because the columns exist | `diagnosis_system`/`diagnosis_code`/`diagnosis_display` are stored (`database.ts:761`) and never exported. No bundle contains a `Condition`. |
| `valueQuantity` assumed to carry a unit | It carries `{ value: numeric }` and nothing else, which makes an MIC in mg/L and a zone diameter in mm indistinguishable to any receiver. |
| Demo dataset assumed to demonstrate outbreak detection | `demo-population.ts` builds an excellent background — organism mix by specimen, ward and city gradients, real co-resistance — and seeds no outbreak at all. The outbreak page in the shipped demonstration is empty. |
| `app/src/main/` assumed portable because it is "just TypeScript" | 14 of its 28 files import `node:fs`/`node:path`/`node:os`, 4 import `electron`, and `database.ts:1142` constructs `new DatabaseSync(path)` from `node:sqlite`. None of those exist on iOS or Android. Phase 17 is the consequence. |
| `smoke_e2e.py` assumed runnable on a fresh checkout | It talks to a real database rather than a Django test database, and every `*.sqlite3` is gitignored. It appeared to pass locally only because a migrated `smoke.sqlite3` was already sitting in the tree; on a clean CI checkout it died with `django.db.utils.OperationalError: no such table: amrit_sites_site`. The workflow runs `manage.py migrate` first. Found by running the CI command rather than reading it. |
| Line endings assumed irrelevant | They are, until Windows joins the matrix. A Windows checkout with the default `core.autocrlf=true` rewrites text files to CRLF, and both products compare golden fixtures byte-for-byte — `address_reference.json`, `geo_directory_reference.json`, the contract schemas, the catalogue seed. That failure reads as a data bug and is a checkout bug. `.gitattributes` pins LF before the first Windows run, not after it. |
| The packaged desktop application assumed to have an icon | `electron-builder` reports `default Electron icon is used  reason=application icon is not set`, on every platform, despite `app/resources/icmr-appicon.png` existing in the tree. Not fixed here — it belongs with signing and release engineering in Phase 21 — but recorded so it is not discovered by a user. |
| Both runtimes assumed to describe a cluster identically | They do not, and both are right. The desktop names the all-island cluster `All locations` and the portal names it `All sites`, because the desktop scans wards inside one laboratory and the portal scans reporting sites across a federation. Every number matched — the log-likelihood ratios agreed to three decimals — so the statistic is shared and only the noun differs. The fixture records the mapping instead of forcing one product to use the other's word for a thing it does not have. Found by the parity fixture on its first run, which is what it is for. |
| The portal assumed able to run any detector the desktop can | It cannot run a denominator-requiring one. The federation wire carries the count of *resistant* cases and nothing about how many isolates were tested, so Bernoulli and Poisson models are unavailable centrally until the contract carries a denominator — a change with a privacy dimension, because a second number per cell means k-anonymity suppression has to be recomputed. Recorded at Phase 27 so Phase 29 does not discover it. |
| The scan statistic assumed to work at deployment scale | It did not. `Math.max(...dates)` at `outbreak-detection.ts:393` spread one function argument per event; at ~122,000 events — one year of a four-site network — V8 threw `RangeError: Maximum call stack size exceeded`. The existing tests all used hand-written fixtures of a few hundred events, so nothing had ever run it at size. Fixed by folding. **Generating a realistic corpus found a crash on the first run**, which is the argument for Phase 32 preceding Phase 31. |
| A proportion shift assumed invisible to a case-only scan | Only if it is built correctly. The first construction converted susceptible isolates to resistant and held the total constant — but a case-only resistance scan counts *resistant cases*, and that number had just gone up, so it was detected and the arm measured nothing it claimed to. Rebuilt so the resistant count is unchanged and the denominator falls instead. An arm that does not fail for the right detector is not an arm. |
| Monte Carlo replications assumed to affect only p-value precision | They bound the alert threshold. The p-value floor is `1/(permutations+1)`, so the recurrence interval ceiling is `permutations+1` days; at the interface's own "exploratory" 99 replications no cluster of any size can reach the default 365-day alert threshold. Lowering replications does not coarsen alerting, it disables it. |
| The ward assumed sufficient as a cluster location | `stableLocation()` returns `location`, so four hospitals' "Medical ICU" wards are one location. Correct for a laboratory node scanning its own data; wrong for any cross-site analysis, which dilutes a real ward cluster across every hospital using the same ward name. A benchmark spanning sites must scan per site. |
| SaTScan assumed to be the only way to validate the scan models externally | It is not, and it was the worst of the available ways. `smerc` and `scanstatistics` implement the same statistics, are free and open-source, install in one command on any operating system, and produced concordance to machine precision. A validation a reviewer can reproduce is worth more than one resting on a binary they must obtain. Found by checking what R offered before accepting the blocker. |
| The reference implementation assumed correct wherever it disagrees | `smerc::stat.binom` returns 0 whenever every case falls inside the window, because `0 * (log(0) - log(popout))` is `NaN` in R and it zeroes NaNs. The statistic is finite there — the limit of `x log x` is 0 — and AMRIT returns it. 8 of 169 cases. A disagreement with a reference has a direction, and recording which way it runs is the whole point of measuring it. |
| A difference from `scan_permutation` assumed to be a defect in AMRIT's expectation | It is the documented day-of-week stratification. AMRIT stratifies the margins by day of week and `scanstatistics` does not, so the expected counts differ by design; the log-likelihood kernel agrees to 6.2e-15 on identical inputs and both pick the same zone and window. Nearly recorded as a bug before the stratification was traced. Phase 33 must state which variant any external comparison uses. |
| Farrington assumed runnable on AMRIT's corpora once implemented | It needs five years of history before it can test a single period, and no corpus this repository generates is longer than 730 days. Implemented, validated exactly against the reference, and unavailable on every dataset AMRIT currently has. Phase 33 must lengthen the corpus for this arm or exclude it and say so. **Settled 14 August 2026: excluded.** Measured — 730 days unavailable, 1,825 days *still* unavailable (264 weekly periods, ~1,850 days, are needed before the first testable one), 2,200 days runs in 4.2 s over 1,134 series. It is excluded rather than given a longer corpus because the calibration is per site-year over a shared null corpus: an arm run on different data produces a sensitivity that cannot be put in the same table as the others. A grid that wants Farrington runs `--window-days 2000` for every arm. |
| The floored dispersion assumed usable throughout the Farrington fit | R floors `phi` at 1 for the threshold and uses the **unfloored** estimate for the trend coefficient's t-test, because `summary.glm` recomputes its own and never sees `phi`. Using the floored value agreed with the reference on all 101 alarms and disagreed about the trend term in four, moving the threshold by up to 28% where it differed. Found only because the reference implementation was run rather than read. |
| A posterior probability assumed directly reportable, like a p-value | Neill spreads the outbreak prior across every enumerated region, so at ~6,400 regions each starts near one in a million and no region cleared a 5% posterior even with a seeded outbreak present — while the posterior of no outbreak anywhere had fallen from 0.994 to 0.680. The detector was responding correctly and reporting nothing. Both posteriors are now computed; the conditional one ranks and thresholds, the unconditional one is what a reader quotes. |
| Control charts assumed comparable to scan statistics at their default thresholds | They are not, and the gap is not small. 241 independent charts with no multiplicity correction produced more than fifty signals on a corpus with no outbreak in it. Any comparison between the families has to be made at a matched empirical false-alert rate, which is what Phase 33 specifies and why. |
| Multivariate scan assumed to need "either" denominator, like the other models | It needs **patient-level isolates**, and the reason is the null rather than the statistic. SaTScan's multivariate model permutes each data stream independently, which is correct for genuinely separate data sources and wrong for the agents of one organism — they are columns of the same isolate, so the data carry co-resistance the independent null does not. On a corpus with no outbreak in it that null alerted at the p-value floor, twelve times across five null replicates. The isolate-permutation null that replaces it has to move whole isolates, and an aggregate row cannot say which isolate a resistance came from. Found by running it on the Phase 32 null corpus, which is what null replicates are for. |
| Multivariate assumed validatable against SaTScan through the Phase 28 bridge | It is not, and this is not a bridge defect. SaTScan's multivariate model takes several case files and assumes the independence AMR streams do not have, so with the corrected null the two are not computing the same statistic. Reporting the difference as poor concordance would blame the implementation for a difference in the question. |
| Poisson assumed to be a model AMRIT can offer once implemented | Implemented and unusable. Nothing in the product captures patient-days, admissions or occupied beds, and `deriveDenominators` cannot invent them. The detector is registered, is honest about what it needs, and no deployment can currently feed it. Capture is not in Phase 29's scope and is not promised. |
| Mobile SQLite assumed to be a drop-in for `node:sqlite` | `node:sqlite` is **synchronous** and all 4,395 lines of `database.ts` are written synchronously; `@capacitor-community/sqlite` is Promise-based. This is a decision, not a detail, and Phase 17 must take it explicitly before moving code. |
| Transmission plausibility assumed to be a safe thing to order signals by | It demoted the seeded cluster on the first corpus it saw. Ordering by plausibility before evidence put `carbapenem-R` sixth, behind four co-resistant streams that scored 1.0 — the exact failure the component exists to fix. It also **saturates**: in a busy medical ICU almost every pair of cases overlaps in ward and time, so nearly every cluster scores 1.0 and the component discriminates hardly at all. Now banded — plausibility orders only within one standardised unit of evidence — and the saturation is documented rather than tuned away, because the fix is room-level data AMRIT does not capture. |
| A phenotype id assumed to survive a round trip through the counting paths | It does not. Ids are mixed case (`carbapenem-R`) and both `buildOutbreakCaseEvents` and `deriveDenominators` upper-case agent codes, so an exact match found no cases for every pooled stream whose id was not already upper case. The symptom was a plausibility of 0 on precisely the streams that mattered, which then demoted them — a silent lookup failure and a fragile ordering rule compounding into a wrong answer that looked like a finding about the method. |
| Phenotype pooling assumed to fix which mechanism gets named | It fixes the fragmentation and not the naming. Signals fell from 22 to 16, 18 to 14 and 18 to 10 on 120-, 180- and 365-day corpora, but the seeded `carbapenem-R` stream ranked first at 120 and 365 days and **eighth** at 180, behind cephalosporin streams the seeded strain genuinely carries. No claim about rank is made, and the benchmark's matching rule ignores the antibiotic. |
| The seeded proportion shift assumed detectable on any corpus | Only where the ward has volume. The arm works by removing susceptible isolates, so on a medium-background single-site corpus it leaves 13 tested isolates in the seeded window and no method can see it. At the high background rate PACE finds it on the seeded ward and mechanism, 1.000 against 0.697. Detectability is a property of ward volume, so a report of that arm without its background rate is not interpretable. |
| Catalogue SNOMED codes assumed to be SNOMED codes | 2,089 of 2,102 references resolve. **Thirteen do not**, and AMRIT has been emitting them on organism observations — among them *Candida auris*, a WHO critical-priority pathogen. Most are in the `…1000000000` extension range, which is a namespace an edition assigns rather than a concept the International Edition holds. Found by `$lookup` against a terminology server, which is the same check that found `U88` in the ICD-10 starter set; nothing in this repository could have found either, because nothing here knows what those classifications contain. They are recorded as rejected and not bundled; the organism still exports under its WHONET code. |
| The starter diagnosis set assumed to be all the ICD a deployment needs | It was 33 codes because that is what had been typed, not because that is what a laboratory codes into. WHO's own API supplies the classification: 1,135 categories across chapters I and XXII plus the pneumonia and urinary blocks, with WHO's titles verbatim. The starter set survives as the *default value set* the picker offers first, which is what it should always have been. |
| The catalogue's LOINC columns assumed to be MIC and disk diffusion | They are **MLC and SBT** — minimum *lethal* concentration and serum bactericidal titer, neither of which AMRIT measures. The plan's Phase 23 text says "`loinc_sbt` for disk diffusion / `loinc_mlc` for MIC"; meropenem's stored `loinc_mlc` is 6651-4, which the terminology server resolves to "Meropenem [Susceptibility] by Minimum lethal concentration (MLC)", while its MIC code is 6652-2. Binding to the stored columns would have put a wrong code on every susceptibility observation the product exports. The codes now come from the LOINC ABXBACT class with the method read out of the display. |
| Those columns assumed not to be LOINC codes at all | They are. `11-7` looks truncated and is a genuine legacy LOINC code — the first guess was that a prefix had been lost, and probing `18911-7` found nothing. Checking against the terminology server rather than reasoning about the format settled it in one request, and settled it the other way. |
| The starter diagnosis value set assumed to contain ICD-10 codes | 33 of 34 do. **`U88` does not exist in ICD-10** and has shipped since the set was authored. Five more carried descriptions paraphrased away from WHO's own text. Both classes of defect are invisible to every test in this repository, because nothing here knows what ICD-10 says; `$validate-code` against the terminology server knows, and now runs once at seed-build time. |
| Specimen types assumed codeable in LOINC | LOINC has no specimen-type axis — a specimen is coded in SNOMED CT or HL7 v2 table 0487, and LOINC's "System" axis is part of an observation's name rather than a specimen code. The plan's Phase 23 bullet asks for "LOINC specimen codes on `Specimen.type`"; what ships is the WHONET code plus SNOMED where the catalogue carries one, which is 3 of 8 specimen groups. |
| PACE's third component assumed measurable in the benchmark | It is not, by the benchmark's own design: the harness replaces every arm's threshold with a matched empirical one, which is what makes sensitivity comparable, so the calibration ablation must report the same sensitivity as the full detector. Measured instead by counting the alerts each arm's *own* rule raised on the null corpora, which the null runs had already produced. Recorded in the protocol before the run rather than explained afterwards. |
