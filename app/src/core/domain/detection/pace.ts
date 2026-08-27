/**
 * PACE — Phenotype-Aggregated Cluster Evaluation. The detector this repository proposes.
 *
 * Everything before this phase implemented methods someone else published. This one is new, so
 * it is written to be attacked: four components, each switchable off from settings, so the
 * benchmark can attribute any gain to a mechanism rather than to "the new one is better". The
 * pre-registered hypothesis and its failure condition were deposited in
 * `docs/expansion/PACE_PROTOCOL.md` before the first benchmark run.
 *
 * ## The four components
 *
 * **(1) Phenotype aggregation** (`aggregatePhenotypes`). Agents that share a resistance
 * mechanism become one stream: `KPN | carbapenem-R` instead of `R:KPN:MEM`, `R:KPN:IPM` and
 * `R:KPN:ETP`. Phase 32 measured the cost of not doing this — one seeded 16-case carbapenemase
 * cluster reported as thirteen signals, the two that reached alert status naming cephalosporins
 * dragged along by co-resistance. See `phenotype.ts`.
 *
 * **(2) Dual-model scan** (`models`). The case-only space-time permutation scan and the
 * space-time Bernoulli scan over resistant-among-tested, run over the *same* streams. The first
 * catches a rise in the number of cases; the second catches a rise in the resistant share,
 * including the system-wide rise the first is blind to by construction. Their two Monte Carlo
 * p-values are combined by Šidák, a rule fixed before any benchmark run.
 *
 * **(3) Empirically calibrated alert threshold** (`calibrateThreshold`). Instead of alerting at
 * a nominal recurrence interval of 365 days, the threshold is the corrected p-value that yields
 * the site's chosen number of alerts per site-year, given how much data was actually scanned. A
 * site gets a budget it can staff against rather than a number inherited from a paper.
 *
 * **(4) Transmission-plausibility re-ranking** (`rerankByPlausibility`). Where ward and
 * admission data exist, signals are ordered by whether their cases could plausibly have infected
 * one another. **It never creates a signal, never suppresses one and never changes a p-value.**
 * Keeping it outside the inference is what keeps the p-values interpretable, and it is why this
 * component is described as cosmetic without apology.
 *
 * ## What PACE does not reimplement
 *
 * Neither statistic. The case-only arm calls `scanOutbreakEvents` — the same function the
 * control arm calls, whose agreement with `scanstatistics::scan_permutation` is pinned in
 * `shared/golden-datasets/detector_reference.json` — and the proportion arm calls `scanBernoulli`,
 * pinned against `smerc::stat.binom` over 169 cases. PACE is a composition of validated kernels
 * plus the four components above. A new detector that also brought new statistics would make
 * every disagreement with a reference ambiguous between the two.
 *
 * That has one consequence worth stating up front: with `aggregatePhenotypes` off and
 * `models: 'case-only'`, PACE **is** the control arm — same events, same statistic, same
 * p-values — because the Šidák correction over one model is the identity. That is not an
 * accident; it is what makes the ablation a measurement rather than a comparison of two
 * codebases.
 */

import {
  DEFAULT_OUTBREAK_SETTINGS, buildOutbreakCaseEvents, scanOutbreakEvents,
  type OutbreakSettings, type OutbreakTarget
} from '../outbreak-detection'
import {
  DEFAULT_BERNOULLI_SETTINGS, bernoulliDetectorSignal, scanBernoulli, type BernoulliScanShape
} from './bernoulli'
import { denominatorUnavailableReason, deriveDenominators, stableLocation } from './denominators'
import {
  buildPhenotypeIndex, countStreams, labelForPhenotype, mapRecordsToPhenotypes, type Phenotype
} from './phenotype'
import type {
  Detector, DetectorContext, DetectorDescriptor, DetectorRunResult, DetectorSignal
} from './types'
import type { AstResult, IsolateRecord } from '../../../shared/types'

const DAY_MS = 86_400_000
const round = (value: number, digits = 4): number => Number(value.toFixed(digits))
const upper = (value: unknown): string => String(value ?? '').trim().toLocaleUpperCase()
const text = (value: unknown): string => String(value ?? '').trim()
const parseDay = (value: unknown): number => {
  const raw = text(value)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return Number.NaN
  const parsed = Date.parse(`${raw}T00:00:00Z`)
  return Number.isFinite(parsed) ? Math.round(parsed / DAY_MS) : Number.NaN
}

export const PACE_ID = 'pace'

/** Which of the two models produced the evidence behind a signal. */
export type PaceModel = 'case-only' | 'proportion'

export interface PaceSettings {
  /** Component 1. Off makes PACE's streams the control arm's streams, exactly. */
  aggregatePhenotypes: boolean
  /** Component 2. `dual` runs both scans and combines them; the others run one. */
  models: 'dual' | 'case-only' | 'proportion'
  /** Component 3. Off falls back to the nominal `recurrenceThresholdDays` rule. */
  calibrateThreshold: boolean
  /** The alert budget component 3 solves for. */
  targetAlertsPerSiteYear: number
  /** Component 4. Ordering only: it never changes which signals exist or what their p-values are. */
  rerankByPlausibility: boolean
  /** Days within which two cases in one ward are treated as a plausible transmission pair. */
  plausibilityWindowDays: number

  // Settings passed through to the two kernels. Named as they are named there, so an operator
  // setting `maxClusterDays` does not have to learn a second vocabulary.
  analysisType: 'prospective' | 'retrospective'
  target: OutbreakTarget
  baselineDays: number
  maxClusterDays: number
  deduplicationDays: number
  minimumCases: number
  /** Resistant-among-tested needs a denominator worth dividing by. Bernoulli arm only. */
  minimumTested: number
  permutations: number
  /** The nominal rule, used when `calibrateThreshold` is off. */
  recurrenceThresholdDays: number
}

export const DEFAULT_PACE_SETTINGS: PaceSettings = Object.freeze({
  aggregatePhenotypes: true,
  models: 'dual',
  calibrateThreshold: true,
  targetAlertsPerSiteYear: 1,
  rerankByPlausibility: true,
  plausibilityWindowDays: 14,
  analysisType: 'prospective',
  target: 'both',
  baselineDays: DEFAULT_OUTBREAK_SETTINGS.baselineDays,
  maxClusterDays: DEFAULT_OUTBREAK_SETTINGS.maxClusterDays,
  deduplicationDays: DEFAULT_OUTBREAK_SETTINGS.deduplicationDays,
  minimumCases: DEFAULT_OUTBREAK_SETTINGS.minimumCases,
  minimumTested: DEFAULT_BERNOULLI_SETTINGS.minimumTested,
  permutations: DEFAULT_OUTBREAK_SETTINGS.permutations,
  recurrenceThresholdDays: DEFAULT_OUTBREAK_SETTINGS.recurrenceThresholdDays
})

export interface PaceSignal extends DetectorSignal {
  /**
   * The ranking statistic: the log-likelihood ratio standardised against its own model's
   * Monte Carlo null maxima. Higher is stronger. See `evidenceOf` in `benchmark/ranking.ts`.
   */
  pace_evidence: number
  /** Models that reported this cluster. Two means both saw it. */
  pace_models: PaceModel[]
  /** Monte Carlo p-value from the case-only scan, or `null` when that model did not report it. */
  p_case_only: number | null
  /** Monte Carlo p-value from the proportion scan, or `null`. */
  p_proportion: number | null
  /** The stream this cluster is in: a mechanism id when pooling is on, an agent code when off. */
  phenotype: string
  /** Share of the cluster's cases that could plausibly have infected one another. Null when off. */
  transmission_plausibility: number | null
}

interface Component {
  model: PaceModel
  signal: DetectorSignal
  p: number
  evidence: number
}

function boundSettings(raw: Partial<PaceSettings> = {}): PaceSettings {
  const clampInt = (value: number | undefined, low: number, high: number, fallback: number): number =>
    Math.max(low, Math.min(high, Math.trunc(value ?? fallback)))
  const models = raw.models === 'case-only' || raw.models === 'proportion' ? raw.models : 'dual'
  return {
    aggregatePhenotypes: raw.aggregatePhenotypes !== false,
    models,
    calibrateThreshold: raw.calibrateThreshold !== false,
    targetAlertsPerSiteYear: Math.max(0.01, Math.min(365, Number(raw.targetAlertsPerSiteYear
      ?? DEFAULT_PACE_SETTINGS.targetAlertsPerSiteYear))),
    rerankByPlausibility: raw.rerankByPlausibility !== false,
    plausibilityWindowDays: clampInt(raw.plausibilityWindowDays, 1, 365, DEFAULT_PACE_SETTINGS.plausibilityWindowDays),
    analysisType: raw.analysisType === 'retrospective' ? 'retrospective' : 'prospective',
    target: raw.target === 'organism' || raw.target === 'resistance' ? raw.target : 'both',
    baselineDays: clampInt(raw.baselineDays, 30, 3650, DEFAULT_PACE_SETTINGS.baselineDays),
    maxClusterDays: clampInt(raw.maxClusterDays, 1, 365, DEFAULT_PACE_SETTINGS.maxClusterDays),
    deduplicationDays: clampInt(raw.deduplicationDays, 0, 365, DEFAULT_PACE_SETTINGS.deduplicationDays),
    minimumCases: clampInt(raw.minimumCases, 2, 100, DEFAULT_PACE_SETTINGS.minimumCases),
    minimumTested: clampInt(raw.minimumTested, 2, 10_000, DEFAULT_PACE_SETTINGS.minimumTested),
    permutations: clampInt(raw.permutations, 19, 9999, DEFAULT_PACE_SETTINGS.permutations),
    recurrenceThresholdDays: clampInt(raw.recurrenceThresholdDays, 20, 100_000,
      DEFAULT_PACE_SETTINGS.recurrenceThresholdDays)
  }
}

/**
 * The Šidák correction over the models that were run.
 *
 * Two models are two chances to declare a cluster, and reporting the smaller p-value without
 * correction would inflate the false-alert rate by close to a factor of two. Šidák rather than
 * Bonferroni because it is exact for independent tests and never larger, and the choice is
 * recorded in the protocol rather than made after seeing which correction flattered PACE.
 *
 * **With one model this is the identity**, which is what makes `models: 'case-only'` with
 * pooling off literally the control arm rather than a near-copy of it.
 *
 * The honest limit: the two p-values are *not* independent — both models read the same isolates,
 * and a real cluster moves both — so Šidák is conservative here. Conservative in the direction
 * that costs PACE sensitivity, which is the direction a superiority claim should err in.
 */
export function sidak(p: number, models: number): number {
  if (models <= 1) return p
  const bounded = Math.max(0, Math.min(1, p))
  return 1 - (1 - bounded) ** models
}

/**
 * The corrected p-value that spends an alert budget, given how much data was scanned.
 *
 * The scans report a p-value corrected against the maximum over every window, location and
 * stream, so under the null the probability that a run produces *any* signal at or below `p` is
 * `p`. One run covers `siteYears` site-years, so the expected alerts per site-year at threshold
 * `p` is `p / siteYears`, and the threshold that meets a target rate is `target * siteYears`.
 *
 * Two bounds, both real and both reported rather than silently applied:
 *
 * * The Monte Carlo floor `1 / (permutations + 1)`. A budget tighter than the floor cannot be
 *   expressed at all, and asking for one at 99 replications is how a deployment ends up unable
 *   to alert — Phase 32 measured that failure on the shipped defaults.
 * * The reporting ceiling 0.05. Both kernels drop signals above it before PACE sees them, so a
 *   budget that would admit weaker evidence than that cannot be spent, however generous.
 */
export function alertThresholdFor(
  targetAlertsPerSiteYear: number, siteYears: number, permutations: number
): { threshold: number; floored: boolean; ceilinged: boolean } {
  const floor = 1 / (permutations + 1)
  const raw = targetAlertsPerSiteYear * Math.max(siteYears, 1e-9)
  const ceilinged = raw > 0.05
  const floored = raw < floor
  return { threshold: Math.max(floor, Math.min(0.05, raw)), floored, ceilinged }
}

/** Isolates that belong to a signal's cluster: its organism, its stream, its ward, its window. */
function casesFor(
  signal: DetectorSignal, phenotype: string, mapped: readonly IsolateRecord[], pooledLocation: boolean
): IsolateRecord[] {
  const start = parseDay(signal.start_date)
  const end = parseDay(signal.end_date)
  const organism = upper(signal.organism)
  const wanted = upper(phenotype)
  return mapped.filter((record) => {
    const day = parseDay(record.specimen_date)
    if (!Number.isFinite(day) || day < start || day > end) return false
    const code = upper(record.organism_code) || upper(record.organism)
    if (organism && code !== organism && upper(record.organism) !== organism) return false
    if (!pooledLocation && stableLocation(record) !== signal.location) return false
    // An organism-stream signal has no phenotype to match on; every isolate of the organism
    // in the window is one of its cases.
    if (!wanted) return true
    const results = (record.antibiotic_results ?? {}) as Record<string, AstResult>
    // Compared case-insensitively. Phenotype ids are mixed case (`carbapenem-R`, `3GC-R`) and
    // agent codes are upper case, and matching them exactly silently found nothing for every
    // pooled stream whose id was not already upper case — which cost the seeded carbapenem
    // cluster its plausibility score and, through the re-ranking, its place at the top.
    return Object.entries(results).some(([code, ast]) =>
      upper(code) === wanted && upper(ast?.result) === 'R')
  })
}

/**
 * How much of a cluster could plausibly be transmission, on a 0-to-1 scale.
 *
 * The question is whether the cases overlapped in a place, not whether they arrived close
 * together in time: two patients on the same ward whose stays overlap could have shared a
 * source; two patients whose specimens fall in the same fortnight but who were never on a ward
 * together could not have infected one another, and a cluster made only of those is more likely
 * a testing artefact than an outbreak.
 *
 * Where `admission_date` is present the stay is `admission → specimen`; where it is absent —
 * outpatient records, imports from systems that never carried it — the specimen date alone is
 * used and the window widens to `plausibilityWindowDays`, which is a weaker check and is why
 * `admissionsKnown` is reported next to the score.
 *
 * The score is the share of cases with at least one plausible partner. Nothing here reaches the
 * statistics: it orders signals that the two scans already produced.
 */
export function transmissionPlausibility(
  cases: readonly IsolateRecord[], windowDays: number
): { score: number; cases: number; admissionsKnown: number } {
  const intervals = cases.map((record) => {
    const specimen = parseDay(record.specimen_date)
    const admission = parseDay(record.admission_date)
    const known = Number.isFinite(admission) && admission <= specimen
    return {
      location: stableLocation(record),
      start: known ? admission : specimen - windowDays,
      end: known ? specimen : specimen + windowDays,
      known
    }
  }).filter((interval) => Number.isFinite(interval.start) && Number.isFinite(interval.end))

  const admissionsKnown = intervals.filter((interval) => interval.known).length
  if (intervals.length < 2) {
    return { score: 0, cases: intervals.length, admissionsKnown }
  }

  // A sweep per ward rather than every pair against every other. Exactly the same answer — an
  // interval overlaps another iff some earlier-starting one has not yet ended, or the next one
  // starts before this one ends — and O(n log n) rather than O(n^2), which matters because an
  // organism-level signal over a busy ward can carry thousands of isolates and the full grid
  // asks for this on every signal of every cell.
  const byLocation = new Map<string, Array<{ start: number; end: number }>>()
  for (const interval of intervals) {
    const bucket = byLocation.get(interval.location) ?? []
    bucket.push({ start: interval.start, end: interval.end })
    byLocation.set(interval.location, bucket)
  }
  let plausible = 0
  for (const bucket of byLocation.values()) {
    bucket.sort((left, right) => left.start - right.start || left.end - right.end)
    let maximumEndSoFar = Number.NEGATIVE_INFINITY
    for (const [index, interval] of bucket.entries()) {
      const overlapsEarlier = maximumEndSoFar >= interval.start
      const next = bucket[index + 1]
      const overlapsLater = next !== undefined && next.start <= interval.end
      if (overlapsEarlier || overlapsLater) plausible += 1
      maximumEndSoFar = Math.max(maximumEndSoFar, interval.end)
    }
  }
  return { score: round(plausible / intervals.length), cases: intervals.length, admissionsKnown }
}

const POOLED_LOCATION = 'All locations'

/** Two clusters are the same cluster when they are the same stream, place and overlapping days. */
function sameCluster(left: DetectorSignal, right: DetectorSignal): boolean {
  if (upper(left.organism) !== upper(right.organism)) return false
  if (upper(left.antibiotic) !== upper(right.antibiotic)) return false
  if (left.location !== right.location) return false
  return parseDay(left.start_date) <= parseDay(right.end_date)
    && parseDay(left.end_date) >= parseDay(right.start_date)
}

/** The log-likelihood ratio standardised against its model's null maxima. */
function standardise(llr: number, mean: number, sd: number): number {
  if (!Number.isFinite(llr)) return 0
  // A null that never produced a positive statistic has no spread to standardise by. Falling
  // back to the raw ratio keeps the ordering meaningful and is flagged in the diagnostics.
  if (!(sd > 1e-9)) return round(llr, 3)
  return round((llr - mean) / sd, 3)
}

export interface PaceRunOptions {
  records: readonly IsolateRecord[]
  antibioticClasses?: readonly { code: string; class_name?: string | null; subclass_name?: string | null }[]
  settings?: Partial<PaceSettings>
  seed?: number
}

export interface PaceResult {
  method: string
  settings: PaceSettings
  signals: PaceSignal[]
  warnings: string[]
  diagnostics: Record<string, string | number | null>
}

export function runPace(options: PaceRunOptions): PaceResult {
  const settings = boundSettings(options.settings)
  const index: ReadonlyMap<string, Phenotype> = buildPhenotypeIndex(options.antibioticClasses ?? [])
  const records = options.records
  const mapped = mapRecordsToPhenotypes(records, index, settings.aggregatePhenotypes)
  const warnings: string[] = []

  const scanSettings: Partial<OutbreakSettings> = {
    analysisType: settings.analysisType,
    target: settings.target,
    baselineDays: settings.baselineDays,
    maxClusterDays: settings.maxClusterDays,
    deduplicationDays: settings.deduplicationDays,
    minimumCases: settings.minimumCases,
    permutations: settings.permutations,
    // The kernel's own alerting is not used: PACE decides status from the combined p-value.
    // Set to the same nominal value so the kernel's `settings` echo is not misleading.
    recurrenceThresholdDays: settings.recurrenceThresholdDays
  }

  const runCaseOnly = settings.models !== 'proportion'
  const runProportion = settings.models !== 'case-only'
  const modelsRun = (runCaseOnly ? 1 : 0) + (runProportion ? 1 : 0)

  const components: Component[] = []
  const diagnostics: Record<string, string | number | null> = {}

  let studyStart: string | null = null
  let studyEnd: string | null = null
  let locations = 0

  if (runCaseOnly) {
    const built = buildOutbreakCaseEvents(mapped as IsolateRecord[], {
      target: settings.target, deduplicationDays: settings.deduplicationDays
    })
    const scan = scanOutbreakEvents(built.events, scanSettings, {
      inputRecords: mapped.length,
      invalidDateRecords: built.invalidDateRecords,
      repeatEventsExcluded: built.repeatEventsExcluded
    })
    studyStart = scan.studyStart
    studyEnd = scan.studyEnd
    locations = Math.max(locations, scan.locations)
    for (const signal of scan.signals) {
      components.push({
        model: 'case-only',
        signal: { ...signal, detector_id: PACE_ID },
        p: signal.p_value,
        evidence: standardise(signal.log_likelihood_ratio, scan.nullMaximumMean, scan.nullMaximumSd)
      })
    }
    diagnostics.case_only_eligible_events = scan.eligibleEvents
    diagnostics.case_only_streams = scan.signalsTested
    diagnostics.case_only_null_maximum_mean = scan.nullMaximumMean
    diagnostics.case_only_null_maximum_sd = scan.nullMaximumSd
    warnings.push(...scan.warnings)
  }

  if (runProportion) {
    const denominators = deriveDenominators(mapped)
    const organismNames: Record<string, string> = {}
    for (const record of mapped) {
      const code = upper(record.organism_code) || upper(record.organism)
      if (code && !organismNames[code]) organismNames[code] = text(record.organism) || code
    }
    const wards = new Set(denominators.map((row) => row.location))
    // One ward cannot support a space-time scan and a single-laboratory deployment is the
    // common case, so the shape follows the data. Pre-specified, not chosen per run.
    const shape: BernoulliScanShape = wards.size >= 2 ? 'space-time' : 'purely-temporal'
    const scan = scanBernoulli({
      denominators,
      shape,
      organismNames,
      settings: {
        analysisType: settings.analysisType,
        baselineDays: settings.baselineDays,
        maxClusterDays: settings.maxClusterDays,
        minimumCases: settings.minimumCases,
        minimumTested: settings.minimumTested,
        permutations: settings.permutations,
        recurrenceThresholdDays: settings.recurrenceThresholdDays
      },
      ...(options.seed === undefined ? {} : { seed: options.seed })
    })
    studyStart = studyStart ?? scan.studyStart
    studyEnd = studyEnd ?? scan.studyEnd
    locations = Math.max(locations, scan.locations)
    for (const signal of scan.signals) {
      const detectorSignal = bernoulliDetectorSignal(signal, shape, PACE_ID)
      components.push({
        model: 'proportion',
        signal: shape === 'purely-temporal'
          ? { ...detectorSignal, location: POOLED_LOCATION }
          : detectorSignal,
        p: signal.p_value,
        evidence: standardise(signal.log_likelihood_ratio, scan.nullMaximumMean, scan.nullMaximumSd)
      })
    }
    diagnostics.proportion_shape = shape
    diagnostics.proportion_streams = scan.streams
    diagnostics.proportion_total_tested = scan.totalTested
    diagnostics.proportion_null_maximum_mean = scan.nullMaximumMean
    diagnostics.proportion_null_maximum_sd = scan.nullMaximumSd
    warnings.push(...scan.warnings)
  }

  // ---- merge the two models' views of the same cluster --------------------------------
  const groups: Component[][] = []
  for (const component of components) {
    const group = groups.find((current) => current.some((member) => sameCluster(member.signal, component.signal)))
    if (group) group.push(component)
    else groups.push([component])
  }

  const studyDays = studyStart && studyEnd
    ? Math.max(1, parseDay(studyEnd) - parseDay(studyStart) + 1)
    : 0
  const sites = new Set(records.map((record) => text(record.lab_code)).filter(Boolean)).size || 1
  const siteYears = (sites * studyDays) / 365.25
  const calibration = alertThresholdFor(settings.targetAlertsPerSiteYear, siteYears, settings.permutations)

  const built: PaceSignal[] = groups.map((group) => {
    const ordered = [...group].sort((left, right) => left.p - right.p || right.evidence - left.evidence)
    const best = ordered[0] as Component
    const combined = round(sidak(best.p, modelsRun))
    const recurrence = combined > 0 ? round(1 / combined, 1) : 0
    // Not upper-cased: the id is the key into the mapped records and into the label table,
    // and `carbapenem-R` is not `CARBAPENEM-R` in either.
    const phenotype = text(best.signal.antibiotic)
    const pooled = best.signal.location === POOLED_LOCATION
      || best.signal.scope === 'All-location temporal cluster'
    const cases = settings.rerankByPlausibility
      ? casesFor(best.signal, phenotype, mapped, pooled)
      : []
    const plausibility = settings.rerankByPlausibility
      ? transmissionPlausibility(cases, settings.plausibilityWindowDays)
      : null
    const status: 'alert' | 'monitor' = settings.calibrateThreshold
      ? (combined <= calibration.threshold ? 'alert' : 'monitor')
      : (recurrence >= settings.recurrenceThresholdDays ? 'alert' : 'monitor')
    const caseOnly = ordered.find((component) => component.model === 'case-only')
    const proportion = ordered.find((component) => component.model === 'proportion')
    return {
      ...best.signal,
      detector_id: PACE_ID,
      status,
      antibiotic: phenotype ? labelForPhenotype(phenotype, index) : best.signal.antibiotic,
      p_value: combined,
      recurrence_interval_days: recurrence,
      pace_evidence: Math.max(...ordered.map((component) => component.evidence)),
      pace_models: ordered.map((component) => component.model),
      p_case_only: caseOnly ? caseOnly.p : null,
      p_proportion: proportion ? proportion.p : null,
      phenotype,
      transmission_plausibility: plausibility ? plausibility.score : null
    }
  })

  /*
   * Ordering, and what it is allowed to touch.
   *
   * Plausibility orders; it does not promote. Alerts stay ahead of monitors, so re-ranking can
   * never move a cluster past the alert threshold, and it never touches a p-value.
   *
   * **It also does not outrank the evidence, and the first version did.** Signals are banded by
   * their standardised evidence rounded to the nearest whole unit — one unit being one standard
   * deviation of that model's null maximum, so a band holds clusters whose strength the data
   * cannot distinguish — and plausibility orders *within* a band. Ranking on plausibility first
   * put the seeded carbapenem cluster sixth behind four co-resistant streams on the first corpus
   * it was run against, which is the failure this component was supposed to fix rather than
   * cause. Banding is a rounding, so the comparator stays transitive and the order stays
   * reproducible.
   *
   * With the component off the order is evidence alone, which is the order the scans produced.
   */
  const band = (signal: PaceSignal): number => Math.round(signal.pace_evidence)
  const signals = built.sort((left, right) => {
    if (left.status !== right.status) return left.status === 'alert' ? -1 : 1
    if (settings.rerankByPlausibility) {
      const bands = band(right) - band(left)
      if (bands !== 0) return bands
      const difference = (right.transmission_plausibility ?? 0) - (left.transmission_plausibility ?? 0)
      if (Math.abs(difference) > 1e-9) return difference
    }
    return right.pace_evidence - left.pace_evidence || left.p_value - right.p_value
  }).slice(0, 50)

  const streamsBefore = countStreams(records)
  const streamsAfter = countStreams(mapped)
  if (settings.aggregatePhenotypes && streamsAfter === streamsBefore && streamsBefore > 0) {
    warnings.push('Phenotype aggregation pooled nothing: every agent kept its own stream. The '
      + 'catalogue supplied has no class or subclass column this mapping recognises, so PACE is '
      + 'running the control arm\'s stream set under another name.')
  }
  if (!settings.aggregatePhenotypes) {
    warnings.push('Phenotype aggregation is off: this is an ablation arm, and its streams are the '
      + 'per-agent streams of the case-only scan.')
  }
  if (settings.calibrateThreshold && calibration.floored) {
    warnings.push(`The alert budget of ${settings.targetAlertsPerSiteYear} per site-year is below the `
      + `Monte Carlo floor of 1/${settings.permutations + 1}. The threshold is the floor, so the `
      + 'measured rate will exceed the target until the replication count rises.')
  }
  if (settings.calibrateThreshold && calibration.ceilinged) {
    warnings.push(`The alert budget of ${settings.targetAlertsPerSiteYear} per site-year would admit `
      + 'signals weaker than p = 0.05, which neither scan reports. The threshold is 0.05 and the '
      + 'measured rate will fall below the target.')
  }

  diagnostics.method = 'Phenotype-Aggregated Cluster Evaluation'
  diagnostics.models = settings.models
  diagnostics.models_combined = modelsRun
  diagnostics.study_start = studyStart
  diagnostics.study_end = studyEnd
  diagnostics.study_days = studyDays
  diagnostics.sites = sites
  diagnostics.locations = locations
  diagnostics.site_years = round(siteYears, 3)
  diagnostics.streams_before_aggregation = streamsBefore
  diagnostics.streams_after_aggregation = streamsAfter
  diagnostics.phenotypes_known = index.size
  diagnostics.alert_threshold_p = settings.calibrateThreshold ? round(calibration.threshold, 6) : null
  diagnostics.alert_threshold_rule = settings.calibrateThreshold
    ? `${settings.targetAlertsPerSiteYear} alert(s) per site-year over ${round(siteYears, 2)} site-years`
    : `nominal recurrence interval >= ${settings.recurrenceThresholdDays} days`
  diagnostics.implied_recurrence_interval_days = settings.calibrateThreshold
    ? round(1 / calibration.threshold, 1)
    : settings.recurrenceThresholdDays
  diagnostics.maximum_reachable_recurrence_interval = settings.permutations + 1
  diagnostics.signals_alerting = signals.filter((signal) => signal.status === 'alert').length
  diagnostics.clusters_seen_by_both_models = signals.filter((signal) => signal.pace_models.length > 1).length

  return {
    method: 'Phenotype-Aggregated Cluster Evaluation',
    settings,
    signals,
    warnings,
    diagnostics
  }
}

// ---------------------------------------------------------------------------------
// Registration

export const paceDescriptor: DetectorDescriptor = Object.freeze({
  id: PACE_ID,
  name: 'PACE (phenotype-aggregated cluster evaluation)',
  method: 'Phenotype-aggregated dual-model scan: Kulldorff space-time permutation and Bernoulli '
    + 'proportion scans over mechanism-level streams, combined by Šidák correction',
  family: 'scan',
  // The proportion arm needs a denominator, and PACE derives it from the same records the
  // case-only arm scans rather than asking for it separately.
  requires: Object.freeze({ denominators: true, coordinates: false, multipleLocations: false }),
  supports: Object.freeze({ prospective: true, retrospective: true }),
  blindSpot: 'Pools agents by the catalogue\'s mechanism class, so it mis-pools wherever that '
    + 'class does not match the mechanism for an organism — carbapenem resistance in '
    + 'Pseudomonas aeruginosa is often porin loss rather than a transmissible carbapenemase. It '
    + 'also inherits both parents\' limits: a rise uniform across every ward leaves the case-only '
    + 'arm nothing to find, and the proportion arm cannot see an outbreak whose testing volume '
    + 'rose with it.',
  citation: ''
})

export const paceDetector: Detector = {
  descriptor: paceDescriptor,

  defaultSettings(): Record<string, unknown> {
    return { ...DEFAULT_PACE_SETTINGS }
  },

  unavailableReason(context: DetectorContext): string | null {
    if (!context.records?.length) {
      return 'No records: PACE pools each isolate\'s agents into mechanisms, which needs the '
        + 'isolate. Aggregate case counts cannot be pooled after the fact.'
    }
    const settings = boundSettings(context.settings as Partial<PaceSettings> | undefined)
    if (settings.aggregatePhenotypes && !context.antibioticClasses?.length) {
      return 'No antibiotic catalogue: PACE pools agents by the class and subclass columns, and '
        + 'without them it would silently run as the per-agent case-only scan. Supply '
        + 'antibioticClasses, or set aggregatePhenotypes false to run the ablation arm deliberately.'
    }
    if (settings.models !== 'case-only') {
      const missing = denominatorUnavailableReason(context)
      if (missing) return missing
    }
    return null
  },

  run(context: DetectorContext): DetectorRunResult {
    const result = runPace({
      records: context.records ?? [],
      ...(context.antibioticClasses ? { antibioticClasses: context.antibioticClasses } : {}),
      settings: context.settings as Partial<PaceSettings> | undefined,
      ...(context.seed === undefined ? {} : { seed: context.seed })
    })
    return {
      descriptor: paceDescriptor,
      settings: { ...result.settings },
      signals: result.signals,
      warnings: result.warnings,
      diagnostics: result.diagnostics
    }
  }
}
