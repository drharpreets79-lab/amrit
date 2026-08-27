# Organism and antimicrobial-resistance outbreak detection

## The family of methods

AMRIT began with one detector and now has thirteen, registered behind one contract
(`app/src/main/detection/`, mirrored in `server/amrit_central_server/analytics/`). They are
not interchangeable. Each answers a different question, needs a different denominator, and
fails in a different way, and an operator choosing between them has to be able to see all
three. This table is that summary; the sections below give each one in full.

| Detector id | Question it answers | Denominator it needs | What it cannot see |
|---|---|---|---|
| `space-time-permutation` | Were there more resistant cases here, this fortnight, than the margins predict? | **None.** Case counts only | A rise that is uniform across every location. Conditioning on both margins buys immunity to reporting-effort artefacts and pays for it here |
| `bernoulli-space-time` | Was a larger *share* of what was tested resistant here? | Isolates tested, derived from the records | A rise in resistant cases matched by a rise in testing. The share did not move |
| `bernoulli-purely-temporal` | Same, with location collapsed. **The scan a single-laboratory deployment gets** | Isolates tested | A rise confined to one ward, diluted by every other |
| `bernoulli-purely-spatial` | Which wards carry excess resistance over the whole period? Retrospective only | Isolates tested | Change. It ranks standing burden: a ward that rose sharply last month averages back to ordinary |
| `poisson-space-time` | Are there more resistant infections here per patient-day? | **Population at risk.** Never derivable from laboratory data | Nothing wrong with the population series it was handed. If a ward closes because of the outbreak, its patient-days fall and the excess is inflated by the response |
| `poisson-purely-temporal` | Same, location collapsed | Population at risk | Ward-confined rises, plus the Poisson failure above |
| `multivariate-bernoulli` | Did the agents of one organism move together here? | Isolates tested, **and patient-level records** | A single-agent phenotype, which gains nothing from combining and pays the multiplicity of the rest of the panel |
| `ewma` | Has this series drifted above its own recent baseline? | **None.** Counts only | Space, entirely. Two wards each carrying half a cluster cross no limit. Smoothing damps a single very large period |
| `cusum-poisson` | Has this series shifted, sustained, however slightly? | **None.** Counts only | *When* it shifted. The accumulated sum says the process moved, not where in the run |
| `cusum-bernoulli` | Has the resistant *share* shifted, sustained? | Isolates tested | Same as above, plus a dependence on a stable baseline share: a changed testing panel moves p0 underneath the chart |
| `farrington` | Is this period above what the same period in previous years predicts? | **None.** Counts only — but five years of them | Anything inside its first five years, which is every AMRIT deployment. And a sustained rise, which its reweighting absorbs into the baseline |
| `bayesian-spatial-scan` | Given the data, how probable is it that this ward is having an outbreak? | **None.** Counts only | Whatever the prior says. It also shares the permutation scan's margin-conditioned baseline and so its blind spot |
| `pace` | Did a resistance *mechanism* cluster here — by count, by share, or both? | Isolates tested, **and patient-level records** | Wherever the catalogue's class is not the mechanism. Carbapenem resistance in *P. aeruginosa* is often porin loss, which is not transmissible, and pooling it tells one story about two. It also inherits both its parents' blind spots |

Six things follow from the table and are worth stating plainly.

**The default is still the case-only scan.** It is the control arm of every comparison
Phases 28–34 make, it is what the WHONET–SaTScan workflow runs, and it is the only model
that works on a deployment with no denominator at all. Changing the default before the
benchmark has run would be choosing the winner in advance.

**A single-location laboratory now has a real temporal scan.** Before, it had the
category-time substitute and nothing else. `bernoulli-purely-temporal` requires no second
location and asks a question a single site can answer.

**The scan and proportion models do not run centrally.** The federation wire carries the count
of *resistant* cases and nothing about how many isolates were tested, so every denominator-requiring
model reports unavailable on the portal, naming the wire rather than the model. Adding a tested count was
considered and deferred: a second number per cell is a privacy change, not a schema change,
because a cell that is safe as "4 resistant" is not necessarily safe as "4 resistant of 4
tested" — that identifies a complete testing panel in a small ward, and k-anonymity
suppression would have to be recomputed over pairs. The reasoning is recorded in
`server/amrit_central_server/analytics/scan_models.py`.

**Two detectors do run centrally, and they are the first the portal has gained.** EWMA and the
Poisson CUSUM need a count per period and nothing else, which is exactly what already crosses the
wire. A ministry can chart a national series of carbapenem-resistant *Klebsiella* today, with no
contract change and no privacy question, because a count is already what it holds.

**A control chart is not a cheap scan statistic and must not be compared to one at nominal
thresholds.** These methods correct for no multiplicity whatsoever. On a seeded 730-day
single-site corpus with **no outbreak in it**, the EWMA chart produced more than fifty signals
across 241 charted series — not a defect, but arithmetic: 241 independent charts at a nominal
one-in-370 limit will do that. Every comparison in Phase 33 is made at a matched *empirical*
false-alert rate for exactly this reason, and the run reports how many signals it found as well
as how many it returned, because a cap of fifty that hides six hundred hides the number that
matters.

**The thirteenth detector is AMRIT's own, and it is not the default.** `pace` is the one method
here with no published source, so it carries the burden the others do not: a frozen protocol
([`docs/expansion/PACE_PROTOCOL.md`](expansion/PACE_PROTOCOL.md)), a pre-registered hypothesis with
a failure condition, and an ablation grid that can attribute any gain to a specific component. It
also reimplements no statistics — it composes the two scans above — so a disagreement with a
reference implementation would be a disagreement about one of them and not about PACE.

## PACE, and what pooling agents into mechanisms does

The detector Phase 31 proposes. Four components, each switchable off, and the reasons each exists
are measurements the earlier phases made rather than arguments.

**1. Phenotype aggregation.** The case-only scan builds one stream per organism–antibiotic pair, so
a carbapenemase-producing *Klebsiella* appears as three streams — meropenem, imipenem, ertapenem —
each holding roughly a third of the evidence and each corrected against the Monte Carlo maximum
over *all* streams. Phase 32 measured that costing an outbreak its identity: one seeded 16-case
cluster reported as thirteen signals whose two alerts were cephalosporins dragged along by
co-resistance. PACE pools agents that share a mechanism, using the catalogue's `class_name` and
`subclass_name` columns rather than a list in the source, so a deployment that adds an agent gets
it classified without a code change.

The counting rule is where this goes wrong if it goes wrong: an isolate resistant to meropenem,
imipenem *and* ertapenem is **one** carbapenem-resistant case, not three. The pooling therefore
happens on the record — one result per mechanism, `R` beating `I` beating `S` — and every count
downstream is derived from those records by the functions that already existed. One implementation
of the rule, not two.

Measured: 16 signals against the control's 22 on a 120-day corpus, 14 against 18 at 180 days, 10
against 18 at 365.

**2. Dual-model scan.** The case-only permutation scan and the Bernoulli proportion scan run over
the same mechanism streams, and their Monte Carlo p-values are combined by Šidák. The first sees a
rise in cases; the second sees a rise in the resistant share, including the system-wide rise the
first cannot see by construction. Over one model the correction is the identity, which is what
makes the single-model ablation arm literally the control detector rather than a near-copy: a test
asserts the two agree signal for signal.

**3. An alert threshold that spends a stated budget.** Rather than alerting at a nominal recurrence
interval of 365 days, PACE solves for the corrected p-value that yields a target number of alerts
per site-year given how much data was actually scanned, bounded below by the Monte Carlo floor and
above by the 0.05 at which the kernels stop reporting. Both bounds are reported when they bind,
because a deployment that cannot express its budget should be told so rather than left to discover
it.

**4. Transmission-plausibility re-ranking, which is cosmetic and says so.** Where admission dates
exist, signals are ordered by whether their cases overlapped in a ward long enough to have infected
one another. It never creates a signal, never suppresses one, never changes a status and never
changes a p-value. Keeping it outside the inference is what keeps the p-values interpretable.

### What building it found

1. **Re-ranking on plausibility alone demoted the right answer.** The first version ordered signals
   by plausibility before evidence. On the first corpus it was run against, that put the seeded
   `carbapenem-R` cluster *sixth*, behind four co-resistant streams that happened to score 1.0 —
   the exact failure the component was meant to fix. Signals are now banded by evidence rounded to
   the nearest whole standardised unit, one unit being one standard deviation of that model's null
   maximum, and plausibility orders only *within* a band.
2. **Plausibility saturates in a busy ward.** In a medical ICU almost every pair of cases overlaps,
   so nearly every cluster scores 1.0 and the component discriminates hardly at all. It is
   informative where wards are small or clusters sparse, and close to inert where they are not.
   Recorded rather than tuned away: the fix would be room- or bed-level data, which AMRIT does not
   capture.
3. **Which mechanism ranks first depends on the corpus, and is not claimed.** PACE ranked the
   seeded `carbapenem-R` stream first on 120-day and 365-day corpora and eighth on a 180-day one,
   behind the cephalosporin streams. That is not obviously an error — the simulator gives the
   seeded strain genuine co-resistance, so the cephalosporin cluster is real — but it means the
   pooling fixes the *fragmentation* without guaranteeing which mechanism leads. The benchmark's
   matching rule deliberately ignores the antibiotic for the same reason.
4. **A mixed-case identifier silently emptied a cluster.** Phenotype ids are written mixed-case
   (`carbapenem-R`) and both counting paths upper-case agent codes on the way through, so an exact
   match found nothing for every pooled stream whose id was not already upper case. The visible
   symptom was a plausibility score of 0 on exactly the streams that mattered, which then demoted
   them through component 4. Found by printing the scores rather than by a test, and now pinned by
   one.
5. **The proportion arm needs a ward busy enough to leave a denominator.** Phase 32's
   proportion-shift arm works by removing susceptible isolates, and on a medium-background
   single-site corpus that leaves 13 tested isolates in the seeded window — below the shipped
   `minimumTested` of 10 after the scan's own windowing, and far below what a stable proportion
   needs. At the high background rate the same arm is found, on the seeded ward and the seeded
   mechanism, at a resistant share of 1.000 against 0.697 elsewhere. The arm's detectability is a
   property of ward volume, and any report of it must state the background rate.

### What PACE cannot do

It cannot run on the portal, and the reason is worse than the one that stops the Bernoulli models.
The federation wire carries aggregate counts, and pooling needs to know which resistances came from
the same specimen — a row saying "4 resistant on 3 March" cannot say that. Adding a tested count to
the contract, which Phase 29 deferred for privacy reasons, would make the proportion arm possible
and would still leave the pooling impossible.

## The case-only method, in detail

AMRIT uses Kulldorff's **space-time permutation scan statistic (STPSS)**, the case-only
method integrated by WHONET with SaTScan. It needs case counts rather than a population
denominator, conditions expected counts on spatial and temporal marginals, and evaluates
overlapping temporal/location windows with a Monte Carlo maximum-likelihood test.

This is an independent, deterministic implementation of the published method. It does not
bundle, invoke, or claim output identity with the SaTScan executable. The UI therefore says
"WHONET-compatible method," not "SaTScan results."

Primary references:

- Kulldorff M, et al. *A Space-Time Permutation Scan Statistic for Disease Outbreak
  Detection.* PLOS Medicine. 2005;2:e59. DOI: 10.1371/journal.pmed.0020059.
  https://journals.plos.org/plosmedicine/article?id=10.1371/journal.pmed.0020059
- WHONET. *Cluster Detection with SaTScan.* WHO Collaborating Centre for Surveillance of
  Antimicrobial Resistance. https://whonet.org/WebDocs/WHONET%208.Cluster%20detection%20and%20SaTScan.html
- Natale A, et al. *Use of WHONET-SaTScan system for simulated real-time detection of
  antimicrobial resistance clusters in a hospital in Italy, 2012 to 2014.* Euro Surveill.
  2017;22(11):30484. https://pmc.ncbi.nlm.nih.gov/articles/PMC5356424/
- Park R, et al. *Statistical detection of geographic clusters of resistant Escherichia
  coli in a regional network with WHONET and SaTScan.* Expert Rev Anti Infect Ther.
  2016;14:1097-1107. https://stacks.cdc.gov/view/cdc/42729/

## What is scanned

Two event families are tested:

1. identified organism episodes;
2. organism-antibiotic episodes recorded as resistant (`R`).

AMRIT does not merge `I` into resistance. Current EUCAST defines `I` as susceptible with
increased exposure, while other systems may use intermediate differently; counting only an
explicit `R` avoids creating guideline-dependent false resistance clusters.

The desktop scans wards/units as categorical location "islands." It also substitutes signal
category for location to detect hospital-wide temporal increases, a documented WHONET use
when a physical location is unavailable. The portal scans reporting sites as location
islands and performs the same all-site temporal category scan.

The implementation stratifies permutations by day of week. P-values compare every candidate
with the simulated **maximum** statistic across all tested windows, locations, and signals;
this controls the overlapping-window multiple-testing problem. A recurrence interval is
`1 / p` days under daily prospective surveillance.

## Defaults and rationale

| Setting | Default | Meaning |
|---|---:|---|
| Mode | Prospective | Only clusters ending on latest specimen date |
| Baseline | 365 days | Historical case-only expectation |
| Maximum cluster | 60 days | Published hospital AMR implementation used 60 days |
| Repeat interval | 30 days | Rolling first patient-organism/phenotype episode |
| Minimum cases | 3 | Avoid two-case alerts while preserving small outbreak sensitivity |
| Monte Carlo replications | 999 | Minimum p-value 0.001; standard reproducible run |
| Alert recurrence interval | 365 days | Similar null signal expected less than once per year |

Maximum cluster length is automatically capped at half the available study duration, as in
WHONET/SaTScan. `99` replications is labeled exploratory; `9,999` offers finer precision.

## Privacy boundary

Row-level scanning stays local in the standalone app. The portal requests only these fields:

`date`, `signal_type`, `signal_code`, `organism_code`, `organism`, `antibiotic_code`, `count`.

The site aggregates after rolling de-duplication. Patient ID, specimen number, ward, address,
free text, and line listings are not sent. Portal users remain site-scoped by existing role
capabilities. Public dashboards do not expose cluster inputs or signals.

## Interpretation and response gate

A statistical signal is **not** a confirmed outbreak or proof of transmission. Review must
consider:

- patient overlap and admission/transfer history locally;
- specimen mix, screening changes, laboratory contamination, reagent/instrument changes;
- AST panel and breakpoint changes;
- epidemiological links and infection-prevention observations;
- typing, WGS/cgMLST/SNP evidence when available;
- endemicity and whether a broad temporal change affected all locations.

The portal and desktop keep this boundary visible. No alert automatically triggers public
reporting, containment, or clinical treatment advice.

## Behaviour measured against seeded outbreaks

`app/src/main/outbreak-simulation.ts` generates outbreaks of known truth — an index case,
a ward, onward acquisition, a lag from acquisition to specimen, and an end. Running this
implementation over that corpus established four things that reading the code did not.

**Replications cap whether an alert can fire at all.** The Monte Carlo p-value has a floor
of `1 / (permutations + 1)`, so the recurrence interval has a ceiling of `permutations + 1`
days. At the exploratory 99 replications the highest reachable recurrence interval is 100,
and at 199 it is 200 — both below the default 365-day alert threshold, so **no alert can
ever fire** at those settings, however large the cluster. The default 999 reaches 1,000 and
is the lowest setting at which the shipped threshold is attainable. Lowering replications
does not merely coarsen the p-value; past a point it silently disables alerting.

**One outbreak produces many signals.** A seeded carbapenemase-producing *K. pneumoniae*
cluster of 16 cases in one ICU was reported as **13 separate signals**: ertapenem,
imipenem and meropenem as three rows, the organism itself as a fourth, and cephalosporins,
aminoglycosides, fluoroquinolones and co-trimoxazole as further rows, all dragged along by
the clone's co-resistance. The operator sees thirteen alerts for one event.

**The two agents that reached alert status were not the seeded mechanism.** Ceftriaxone and
ceftazidime alerted at a recurrence interval of 1,000 days; the three carbapenems that
actually defined the outbreak came in at 333, 91 and 24 — all below the alert threshold.
The signal a per-agent scan ranks first is whichever agent happens to have the largest
excess over its own baseline, which is not the same as the mechanism that is spreading.

**The location key is the ward, not the ward within a site.** `stableLocation()` returns
`location`, so four hospitals' "Medical ICU" wards are one location. That is correct for a
laboratory node scanning its own data, which is how the desktop uses it, but any analysis
spanning sites must scan each site separately or it dilutes a real ward cluster across
every hospital that happens to use the same ward name.

## What the denominator models add, measured

The three findings below come from running the models over `outbreak-simulation.ts`'s seeded
corpora rather than from reasoning about them. Each is reproduced by a test.

**The documented blind spot is now covered, and the coverage is measured.** The
`proportion-shift` arm thins susceptible isolates out of one ward while the resistant cases
continue at their existing rate: the resistant *count* is unchanged, so a scan that counts
resistant cases has nothing to find. On a single-site 365-day corpus with 23 susceptible
*E. coli* removed from general medicine over 45 days, the case-only scan returned **zero
signals** and the space-time Bernoulli scan returned three, the strongest at the correct ward
on the correct mechanism — cefepime at a resistant share of 0.966 against a baseline of
0.546, with ceftazidime and ceftriaxone behind it. This is the clearest statement available
of what the second model buys: not a better answer to the same question, a different question
that the first one cannot ask.

**On a clonal cluster the proportion scan localises what the case-only scan does not.** On the
`clonal-multidrug` arm the case-only scan produced one signal, scoped to `All locations` and
naming amikacin — an agent dragged along by the clone's co-resistance, not the seeded
mechanism. The space-time Bernoulli scan put its strongest signal on the seeded ward with
imipenem, one of the three carbapenems that defined the outbreak.

**SaTScan's multivariate null does not transfer to antimicrobial resistance, and the failure
is total rather than marginal.** The published multivariate scan sums the per-stream
log-likelihood ratios for a window and permutes each stream independently. That is right for
the setting it was built for — emergency-department visits, over-the-counter sales and
absenteeism are separate data sources. The agents of one organism are not separate data
sources; they are columns of the same isolate, and a *K. pneumoniae* resistant to meropenem
is resistant to imipenem for the same reason. Permuting them independently produces a null
carrying far less cross-stream agreement than the data, so the observed statistic beats every
simulated maximum. Run on a 180-day single-site corpus **with no outbreak seeded at all**, the
independent-stream null produced three signals at the p-value floor; across five null
replicates it produced twelve, against zero for the case-only scan and one for the univariate
Bernoulli. A detector that alerts on nothing is not a detector.

AMRIT's default null therefore permutes **isolates**: within an organism, each day-and-ward
cell keeps its isolate count and the isolates are shuffled between cells carrying their whole
susceptibility profile. Co-resistance survives, panel differences move with the isolates that
have them, and the hypothesis tested is the one an infection-control team means — that these
isolates were exchangeable across wards and days. On the same empty corpus it returns nothing;
on the clonal arm it returns one signal, on the seeded ward, with the carbapenems among its
contributing streams. This needs patient-level records, which is why the detector asks for
them and is unavailable on the portal.

SaTScan's null is kept as a setting (`nullModel: 'independent-stream'`) and is not the default.
Phase 33's benchmark needs the faithful comparator arm, and a claim that a published method
fails on these data should be reproducible by whoever doubts it.

## The non-scan families, and what running them found

**Farrington agrees with the reference implementation exactly.** The desktop and the portal were
both compared against R's `surveillance` 1.26.1 `algo.farrington` — the algorithm ECDC and UKHSA
run — on a fixed 364-week series with trend, seasonality and two injected excesses. Across the
101 testable periods: every alarm identical, every trend-retention decision identical, and the
worst relative difference in threshold 1.9 × 10⁻⁵, which is convergence noise between two
implementations of the same regression. R's own output is pinned in
`shared/golden-datasets/detector_reference.json` so a future change that breaks the agreement
breaks a test.

**One difference in the fit was worth an hour and would have been invisible.** R's `summary.glm`
recomputes its own dispersion for the coefficient t-test and never sees the `phi` that Farrington
floors at 1. Using the floored value for the trend test — the obvious thing to do, and wrong —
produced an implementation that agreed with the reference on every alarm and disagreed about the
trend term in four of 101 periods, moving the threshold by up to 28% where it differed. It looked
correct. The lesson is the one this repository keeps relearning: agreement on the headline number
is not agreement.

**The control charts alarm freely under the null, and that is the point of measuring it.** See the
note above the table. Nothing about this is a defect in the method; it is what happens when 241
independent charts are run without a multiplicity correction, and it is the argument for Phase 33's
matched-false-alert-rate design rather than an argument against including them.

**The Bayesian scan needed its posterior separated in two before it was usable.** Neill spreads the
outbreak prior across every enumerated region, so with the six thousand regions a real corpus
produces, each starts at around one in a million and no region reached a 5% posterior even with a
seeded outbreak present — the detector reported nothing on data where it had clearly responded, since
the posterior that *nothing* was happening had fallen from 0.994 to 0.680. The unconditional
posterior and the posterior conditional on an outbreak existing somewhere are now both computed and
both reported; the conditional one ranks regions and drives the reporting threshold, the
unconditional one is what a reader should quote. With that separation the scan finds the seeded ward
and stays silent on the corpus with no outbreak in it.

## Verification status of the new models

Honest about what has and has not been checked:

- The log-likelihood ratios are pinned against worked cases in
  `shared/golden-datasets/detector_reference.json`, and the cluster each shape selects is
  pinned with its observed, tested and ratios. **Both runtimes reproduce that geometry
  exactly** — the Python mirror selects the same window, with the same counts and the same
  log-likelihood ratio, which is the property that makes a cross-runtime comparison mean
  anything. p-values are deliberately not pinned: the two runtimes seed different generators.
- **Agreement with independent implementations is measured, and the comparator is not SaTScan.**
  SaTScan left the critical path on 14 August 2026: it is a Windows-first binary that would not
  run on the development machine, cannot be redistributed, and would have made every concordance
  figure here depend on a reviewer obtaining a copy. The comparison is instead against
  open-source R packages any reader can install in one command, and the numbers are:

  | AMRIT | Reference | Cases | Worst relative difference |
  |---|---|---|---|
  | Farrington 1996 | `surveillance::algo.farrington` 1.26.1 | 101 periods | 1.9e-5, with every alarm and trend decision identical |
  | Bernoulli log-likelihood ratio | `smerc::stat.binom` | 161 of 169 | below 1e-9 |
  | Poisson log-likelihood ratio | `smerc::stat.poisson` | 56 of 56 | 1e-13 |
  | Space-time permutation kernel | `scanstatistics::scan_permutation` | 6 windows | 6.2e-15 |

  Two qualifications, both stated because concordance tables invite over-reading. The remaining
  8 Bernoulli cases are ones where the *reference* is wrong: `smerc` evaluates
  `0 · (log 0 − log popout)` when every case falls inside the window, gets `NaN`, and zeroes it,
  where the limit is finite and AMRIT returns it. And AMRIT's space-time detector stratifies its
  expectation by day of week where `scanstatistics` does not, so what is compared is the
  log-likelihood kernel on identical observed and expected counts; both implementations select
  the same zone and the same window on the shared fixture, and the expectations differ by design.

- **The SaTScan bridge still exists and is still tested**, as optional interoperability for a
  deployment that already runs SaTScan. Its file formats remain verified against SaTScan's
  published documentation rather than against real output, which was true before and is unchanged.
  What changed is that nothing depends on it.
- **Farrington is validated against a reference implementation; the other three of Phase 30 are
  not.** EWMA, both CUSUMs and the Bayesian scan are pinned against worked examples computed from
  their source papers' formulae, which proves the two runtimes agree with each other and with the
  published recursion, and does not prove either agrees with a third implementation. No package in
  comparable use exists to compare them against. The difference in strength between that and the
  Farrington claim is deliberate and should not be flattened when either is cited.
- The multivariate scan **cannot be validated through the bridge at all** as it stands:
  SaTScan's multivariate model takes multiple case files and assumes the independence this
  data does not have, so the two are not computing the same statistic. That is a difference in
  method, not a disagreement about an answer, and it is stated rather than papered over.

## Known limits

- Case-only STPSS removes purely spatial and purely temporal main effects. This helps avoid
  workload/seasonality artifacts but may miss a uniform system-wide increase; the category-
  time scan partially covers that case, and since Phase 29 the Bernoulli models cover the
  rest of it — at the cost of needing a denominator the case-only method does not.
- Farrington is implemented, validated, and **no corpus this repository generates can run it**.
  It needs five years of history; `outbreak-simulation.ts` defaults to 730 days. Phase 33 must
  either generate a longer corpus for this arm or exclude it and say which — silently running it
  on a short series would report "no aberrations" for a method that was never able to test one.
- The Poisson models are implemented and **no deployment can currently feed them**. Nothing
  in AMRIT captures patient-days, admissions or occupied beds; a deployment that wants a rate
  per patient-day has to supply the series from whatever system holds it. Capture is not
  built and is not promised here.
- Categorical site/ward islands do not infer adjacency. Coordinates or validated functional
  meta-groups would be required for multi-location circular/flexible spatial windows.
- Changes in culturing, referral, testing panels, breakpoint interpretation, or reporting can
  create signals.
- Very rare phenotypes have limited Monte Carlo power. Absence of a signal is not evidence of
  absence of transmission.
- This implementation needs prospective validation against investigated outbreaks before a
  deployment selects local thresholds or treats it as a routine notification system.
