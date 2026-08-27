# PACE — frozen analysis protocol

**Written 14 August 2026, before the first benchmark run of the detector it describes.**

This document exists so that the superiority claim in the manuscript can be checked rather than
believed. Everything a reader would need to see moved after the results came in is fixed here
first: the hypothesis, both endpoints, both thresholds, the comparator, the matching rule, the
ranking statistic, the calibration, the combination rule, the corpus, and the condition under
which the claim is dropped.

**Deposit.** The SHA-256 of this file is recorded in
[`PHASE_STATUS.md`](./PHASE_STATUS.md#phase-31-execution-log) together with the date, and the
commit that introduced it is the deposit record. Any later change to this file changes the hash,
so an amendment cannot be made to look like the original. Amendments go at the bottom, dated, with
the original text left in place — the same convention the SaTScan amendment already follows.

**Status at the time of writing:** PACE is implemented (`app/src/main/detection/pace.ts`,
`server/amrit_central_server/analytics/pace.py`), 31 desktop tests and 17 portal tests pass, and
**no benchmark has been run against it** — not a reduced grid, not a single cell. The measurements
quoted below as motivation come from Phases 29, 30 and 32, all of which predate PACE.

---

## 1. The hypothesis

Quoted verbatim from [`PHASE_STATUS.md`](./PHASE_STATUS.md#pre-registered-superiority-hypothesis-phase-31),
where it was recorded when the plan was written:

> At a matched **empirical** false-alert rate of one per site-year, PACE detects seeded clonal
> multi-drug outbreaks of ≤ 20 excess cases with at least **15 percentage points** higher
> sensitivity, and a median detection delay at least **2 days** shorter, than per-agent case-only
> space-time permutation as run by AMRIT's current detector, whose agreement with a published
> reference implementation is established separately.

The trailing clause carries the amendment of 14 August 2026, which dropped SaTScan as a second
implementation of the comparator before any benchmark had run. The comparator *method*, both
endpoints and both thresholds are unchanged from the original.

**Failure condition, pre-specified.** If either endpoint is not cleared, the superiority claim is
dropped and the paper reports equivalence plus the operational advantages — embedded, no second
licensed executable, no manual file transfer, five platforms, detection delay reported. A
superiority claim that cannot fail is not evidence.

**Scope.** Better than the WHONET–SaTScan workflow *as the field runs it*: case-only space-time
permutation, one stream per organism–antibiotic pair, a fixed recurrence-interval threshold. **Not**
better than every model SaTScan can be configured to run. AMRIT itself now implements the Bernoulli
and multivariate models SaTScan ships, and PACE is built out of two of them; a claim to beat them
would be a claim to beat its own components.

---

## 2. The comparator

`space-time-permutation` as registered in both runtimes: Kulldorff's space-time permutation scan
over one stream per organism–antibiotic pair, day-of-week stratified, with the shipped settings.
Its agreement with `scanstatistics::scan_permutation` is pinned in
`shared/golden-datasets/detector_reference.json` and was measured to 6.2e-15 on the shared fixture.

The comparator arm in the benchmark is the **registered detector**, not a PACE arm configured to
imitate it. As it happens the two are the same thing — PACE with pooling off, one model and the
nominal threshold is byte-identical to the control, and a test asserts it signal for signal — but
the arm that appears in the results table is the control detector itself.

---

## 3. The four components, and the arms that ablate them

| Component | Setting | Ablation arm |
|---|---|---|
| 1. Phenotype aggregation | `aggregatePhenotypes` | `pace-no-aggregation` |
| 2. Dual-model scan | `models: dual` | `pace-case-only`, `pace-proportion-only` |
| 3. Empirically calibrated threshold | `calibrateThreshold` | `pace-no-calibration` |
| 4. Transmission-plausibility re-ranking | `rerankByPlausibility` | `pace-no-rerank` |

One command runs all of them plus the control: `pnpm benchmark -- --ablation --out <dir>`.

Each arm differs from full PACE in exactly one component, so a difference in an endpoint is
attributable to that component and to nothing else.

**Component 3 is not measurable through the endpoints, and this is stated in advance rather than
discovered.** The harness calibrates every arm to a matched empirical alert rate on null replicates,
which by design replaces whatever threshold a detector would have chosen for itself; that is what
makes the sensitivity figures comparable at all. `pace-no-calibration` will therefore report the
same sensitivity as full PACE. Component 3 is measured instead in the `own rule alerts/site-yr`
column, which counts the alerts each arm's **own** threshold raised on the null corpora. The
prediction, recorded here before the run: PACE's calibrated threshold produces an alert rate closer
to the stated target than the control's nominal recurrence interval of 365 days does.

---

## 4. Analysis decisions, frozen

Each of these could be chosen after the fact to flatter a result. None may be.

**Combination rule.** Šidák over the Monte Carlo p-values of the models that ran:
`p = 1 − (1 − min p)^k`, `k` the number of models. Over one model this is the identity. The two
p-values are not independent — both models read the same isolates — so Šidák is conservative here,
in the direction that costs PACE sensitivity.

**Evidence statistic (ranking).** Each signal's log-likelihood ratio standardised against its own
model's Monte Carlo null maxima, `(LLR − mean) / sd`; the maximum over the models that reported the
cluster. The raw ratios of a permutation scan and a Bernoulli scan do not share a scale, and the
corrected p-value ties at the Monte Carlo floor, so neither can order PACE's signals. Reported as
`pace_evidence`; declared in `benchmark/ranking.ts` alongside every other detector's statistic.

**Alert threshold (component 3).** The corrected p-value that spends the target budget:
`p* = target × site-years scanned`, bounded below by the Monte Carlo floor `1/(permutations+1)` and
above by 0.05, where both kernels stop reporting. Both bounds are reported when they bind.

**Re-ranking (component 4).** Signals are banded by `round(pace_evidence)` — one band is one
standard deviation of the null maximum, so a band holds clusters the data cannot tell apart — and
plausibility orders *within* a band. Alerts always precede monitors. Re-ranking never creates,
suppresses or re-statuses a signal and never changes a p-value.

**Matching rule.** Unchanged from Phase 33 (`benchmark/matching.ts`): organism, ≥ 1 day of window
overlap, and the seeded ward *or* an all-location signal; spatial accuracy reported separately; the
antibiotic deliberately not part of the rule.

**Calibration.** Unchanged from Phase 33: null replicates generated and scored first, each arm
calibrated on those alone, seeded cells generated only afterwards. Target one alert per site-year.

**Corpus.** `outbreak-simulation.ts`, factorial grid, seeds derived from the grid rather than read
from disk. The full study is the 960-cell grid (900 seeded, 60 null).

**Replications.** 99 in the benchmark. This is a speed setting and not a sensitivity setting
*because* arms are ranked by their own evidence statistic rather than by a p-value or a recurrence
interval; in production the shipped 999 applies, and Phase 32 measured what happens to alerting
below that.

---

## 5. What is already known to be true, and is not being tested

Stated so that no reader mistakes a demonstration for a finding.

* Pooling reduces the number of signals for one outbreak. Measured before this protocol was
  written: 16 against 22, 14 against 18, and 10 against 18 on 120-, 180- and 365-day corpora.
  That is a mechanism, not an endpoint.
* PACE's proportion arm sees the seeded proportion shift, and its case-only arm does not. Also
  measured beforehand, and also a mechanism — the arm was built by Phase 32 to have exactly that
  property.
* Which mechanism PACE ranks first is **not** claimed. On the 120- and 365-day corpora it ranked
  the seeded `carbapenem-R` stream first; on a 180-day corpus it ranked it eighth, behind the
  cephalosporin streams that the seeded strain genuinely also carries. The endpoints do not depend
  on the antibiotic, by the matching rule above.

---

## 6. Amendments

None. Any amendment appended below must carry its date and its reason, and must leave the text
above unchanged.
