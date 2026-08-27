/**
 * Kulldorff's Bernoulli scan statistic, on resistant-among-tested.
 *
 * The model AMRIT should probably have had first. The case-only space-time permutation was
 * designed for surveillance where no population at risk exists, and it conditions on both
 * margins so that it does not need one — buying immunity to reporting-effort artefacts and
 * paying with blindness to any rise that is uniform across locations. Antimicrobial
 * resistance is not that setting. Every resistant isolate arrived with a susceptibility
 * test, so the isolates *tested* against that agent are a denominator the laboratory
 * already holds, and `deriveDenominators` extracts it.
 *
 * With it the question changes from "were there more resistant isolates here than the
 * margins predict" to "was a larger *share* of what was tested resistant". Those differ in
 * two ways that matter:
 *
 *   * A change in testing volume moves the first and not the second. A ward that sent twice
 *     as many specimens produces twice as many resistant isolates at unchanged resistance;
 *     the case-only scan can flag that and the Bernoulli scan does not.
 *   * A fall in testing volume with resistant cases continuing moves the second and not the
 *     first. `outbreak-simulation.ts` seeds exactly that as its `proportion-shift` arm, and
 *     the case-only scan returns nothing for it.
 *
 * ## The statistic
 *
 * For a candidate window Z with `c` cases among `n` tested, and `C` cases among `N` tested
 * overall, the log-likelihood ratio is the usual Bernoulli form, evaluated only where the
 * inside proportion exceeds the outside one because AMRIT scans for high rates:
 *
 *     LLR = c·ln(c/n) + (n−c)·ln((n−c)/n)
 *         + (C−c)·ln((C−c)/(N−n)) + ((N−n)−(C−c))·ln(((N−n)−(C−c))/(N−n))
 *         − [ C·ln(C/N) + (N−C)·ln((N−C)/N) ]
 *
 * ## The null
 *
 * Case and control labels are redistributed among the tested isolates, holding every cell's
 * *tested* count fixed. That is the Bernoulli null: the number of tests in each ward on each
 * day is treated as given, and only which of them were resistant is random. Sampling is
 * sequential hypergeometric rather than shuffling an array of labels, which is the same
 * distribution at a fraction of the allocation.
 *
 * The p-value compares each candidate against the simulated **maximum** across every window,
 * location and stream, exactly as the permutation scan does, because the multiple-testing
 * problem is identical.
 */

import { denominatorUnavailableReason, denominatorsFrom } from './denominators'
import type {
  DenominatorRow, Detector, DetectorContext, DetectorDescriptor, DetectorRunResult, DetectorSignal
} from './types'

const DAY_MS = 86_400_000

export type BernoulliScanShape = 'space-time' | 'purely-temporal' | 'purely-spatial'

export interface BernoulliSettings {
  analysisType: 'prospective' | 'retrospective'
  baselineDays: number
  maxClusterDays: number
  /** Minimum resistant isolates inside a window before it is reported. */
  minimumCases: number
  /** Minimum isolates tested inside a window. A proportion over three tests is noise. */
  minimumTested: number
  permutations: number
  recurrenceThresholdDays: number
}

export const DEFAULT_BERNOULLI_SETTINGS: BernoulliSettings = Object.freeze({
  analysisType: 'prospective',
  baselineDays: 365,
  maxClusterDays: 60,
  minimumCases: 3,
  // Three resistant out of three tested is 100% and means nothing. The permutation scan has
  // no equivalent guard because it never looks at a denominator.
  minimumTested: 10,
  permutations: 999,
  recurrenceThresholdDays: 365
})

export interface BernoulliSignal {
  signal_id: string
  status: 'alert' | 'monitor'
  organism: string
  antibiotic: string
  scope: string
  location: string
  start_date: string
  end_date: string
  days: number
  /** Resistant isolates inside the window. */
  observed: number
  /** Isolates tested inside the window. */
  tested: number
  proportion: number
  /** Resistant proportion everywhere else in the study window. */
  baseline_proportion: number
  proportion_ratio: number
  log_likelihood_ratio: number
  p_value: number
  recurrence_interval_days: number
}

export interface BernoulliScanResult {
  method: string
  shape: BernoulliScanShape
  settings: BernoulliSettings
  studyStart: string | null
  studyEnd: string | null
  streams: number
  locations: number
  totalTested: number
  totalResistant: number
  /**
   * Mean and standard deviation of the Monte Carlo maxima, for PACE (Phase 31).
   *
   * PACE runs this scan alongside the case-only permutation scan and has to order signals
   * from two statistics that do not share a scale. A log-likelihood ratio standardised
   * against its own model's null is comparable across the two; the raw ratios are not.
   */
  nullMaximumMean: number
  nullMaximumSd: number
  signals: BernoulliSignal[]
  warnings: string[]
}

interface Cell {
  day: number
  location: string
  tested: number
  cases: number
}

interface Stream {
  organismCode: string
  antibioticCode: string
  cells: Cell[]
}

const round = (value: number, digits = 4): number => Number(value.toFixed(digits))

function fnv1a(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function randomGenerator(seed: number): () => number {
  let state = seed || 0x9e3779b9
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 4_294_967_296
  }
}

/** Mean and standard deviation of the simulated maxima, over the sample rather than a population estimate. */
function momentsOf(values: readonly number[]): { mean: number; sd: number } {
  if (values.length === 0) return { mean: 0, sd: 0 }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
  return { mean, sd: Math.sqrt(variance) }
}

/** `x·ln(x/y)`, with the limit at `x = 0` rather than a `NaN`. */
function xlogxy(x: number, y: number): number {
  return x <= 0 ? 0 : x * Math.log(x / y)
}

export function bernoulliLogLikelihoodRatio(
  cases: number, tested: number, totalCases: number, totalTested: number
): number {
  const outsideTested = totalTested - tested
  const outsideCases = totalCases - cases
  if (tested <= 0 || outsideTested <= 0 || totalCases <= 0 || totalCases >= totalTested) return 0
  // High rates only, as everywhere else in this codebase: a ward with unusually *low*
  // resistance is not an outbreak and reporting it as one would bury the ones that are.
  if (cases / tested <= outsideCases / outsideTested) return 0
  const inside = xlogxy(cases, tested) + xlogxy(tested - cases, tested)
  const outside = xlogxy(outsideCases, outsideTested) + xlogxy(outsideTested - outsideCases, outsideTested)
  const overall = xlogxy(totalCases, totalTested) + xlogxy(totalTested - totalCases, totalTested)
  const llr = inside + outside - overall
  return Number.isFinite(llr) && llr > 0 ? llr : 0
}

/**
 * Redistribute cases among cells, holding each cell's tested count fixed.
 *
 * Sequential hypergeometric: cell by cell, draw how many of its tested isolates are cases
 * given how many cases and tests remain unallocated. Identical in distribution to shuffling
 * a label array of length `totalTested`, without allocating one per replication.
 */
function permuteCases(cells: readonly Cell[], totalCases: number, totalTested: number, random: () => number): number[] {
  const drawn = Array.from({ length: cells.length }, () => 0)
  let casesLeft = totalCases
  let testedLeft = totalTested
  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index] as Cell
    let taken = 0
    for (let draw = 0; draw < cell.tested; draw += 1) {
      if (testedLeft <= 0) break
      if (random() < casesLeft / testedLeft) {
        taken += 1
        casesLeft -= 1
      }
      testedLeft -= 1
    }
    drawn[index] = taken
  }
  return drawn
}

interface Candidate {
  stream: Stream
  location: string
  start: number
  end: number
  cases: number
  tested: number
  llr: number
}

function scanStream(
  stream: Stream, counts: readonly number[], studyDays: number,
  settings: BernoulliSettings, shape: BernoulliScanShape, collect: boolean
): { maximum: number; candidates: Candidate[] } {
  const totalCases = counts.reduce((sum, value) => sum + value, 0)
  const totalTested = stream.cells.reduce((sum, cell) => sum + cell.tested, 0)
  if (totalCases < settings.minimumCases || totalTested < settings.minimumTested) {
    return { maximum: 0, candidates: [] }
  }

  // Purely spatial collapses time; purely temporal collapses location. Both are the same
  // scan with one dimension held whole, which is why they share this function.
  const groups = new Map<string, { cases: number[]; tested: number[] }>()
  for (const [index, cell] of stream.cells.entries()) {
    const key = shape === 'purely-temporal' ? 'All locations' : cell.location
    const bucket = groups.get(key) ?? {
      cases: Array.from({ length: studyDays }, () => 0),
      tested: Array.from({ length: studyDays }, () => 0)
    }
    if (cell.day >= 0 && cell.day < studyDays) {
      bucket.cases[cell.day] = (bucket.cases[cell.day] ?? 0) + (counts[index] ?? 0)
      bucket.tested[cell.day] = (bucket.tested[cell.day] ?? 0) + cell.tested
    }
    groups.set(key, bucket)
  }

  const maximumDays = shape === 'purely-spatial'
    ? studyDays
    : Math.max(1, Math.min(settings.maxClusterDays, Math.max(1, Math.floor(studyDays / 2))))
  const ends = shape === 'purely-spatial'
    ? [studyDays - 1]
    : settings.analysisType === 'prospective'
      ? [studyDays - 1]
      : Array.from({ length: studyDays }, (_, index) => index)

  let maximum = 0
  const candidates: Candidate[] = []
  for (const [location, bucket] of groups) {
    for (const end of ends) {
      let cases = 0
      let tested = 0
      const limit = shape === 'purely-spatial' ? studyDays : maximumDays
      for (let length = 1; length <= limit && length <= end + 1; length += 1) {
        const start = end - length + 1
        cases += bucket.cases[start] ?? 0
        tested += bucket.tested[start] ?? 0
        if (shape === 'purely-spatial' && length < limit && start > 0) continue
        if (cases < settings.minimumCases || tested < settings.minimumTested) continue
        const llr = bernoulliLogLikelihoodRatio(cases, tested, totalCases, totalTested)
        if (llr <= 0) continue
        if (llr > maximum) maximum = llr
        if (collect) candidates.push({ stream, location, start, end, cases, tested, llr })
      }
    }
  }
  return { maximum, candidates }
}

export interface BernoulliScanOptions {
  denominators: readonly DenominatorRow[]
  settings?: Partial<BernoulliSettings>
  shape?: BernoulliScanShape
  /** Organism display names, so a signal reads as a species and not a WHONET code. */
  organismNames?: Readonly<Record<string, string>>
  seed?: number
}

function boundSettings(raw: Partial<BernoulliSettings> = {}): BernoulliSettings {
  const clamp = (value: number | undefined, low: number, high: number, fallback: number): number =>
    Math.max(low, Math.min(high, Math.trunc(value ?? fallback)))
  return {
    analysisType: raw.analysisType === 'retrospective' ? 'retrospective' : 'prospective',
    baselineDays: clamp(raw.baselineDays, 30, 3650, DEFAULT_BERNOULLI_SETTINGS.baselineDays),
    maxClusterDays: clamp(raw.maxClusterDays, 1, 365, DEFAULT_BERNOULLI_SETTINGS.maxClusterDays),
    minimumCases: clamp(raw.minimumCases, 2, 100, DEFAULT_BERNOULLI_SETTINGS.minimumCases),
    minimumTested: clamp(raw.minimumTested, 2, 10_000, DEFAULT_BERNOULLI_SETTINGS.minimumTested),
    permutations: clamp(raw.permutations, 19, 9999, DEFAULT_BERNOULLI_SETTINGS.permutations),
    recurrenceThresholdDays: clamp(raw.recurrenceThresholdDays, 20, 100_000, DEFAULT_BERNOULLI_SETTINGS.recurrenceThresholdDays)
  }
}

const parseDay = (value: string): number => {
  const parsed = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(parsed) ? Math.round(parsed / DAY_MS) : Number.NaN
}
const dayKey = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10)

export function scanBernoulli(options: BernoulliScanOptions): BernoulliScanResult {
  const settings = boundSettings(options.settings)
  const shape = options.shape ?? 'space-time'
  const names = options.organismNames ?? {}

  // Only agent-level rows carry a denominator; the organism-level rows exist for detectors
  // that need an isolate count and are not a numerator for anything.
  const rows = options.denominators.filter((row) => row.antibiotic_code !== '' && row.tested > 0)
  const days = rows.map((row) => parseDay(row.date)).filter((value) => Number.isFinite(value))
  let studyEnd: number | null = null
  let dataStart: number | null = null
  for (const day of days) {
    if (studyEnd === null || day > studyEnd) studyEnd = day
    if (dataStart === null || day < dataStart) dataStart = day
  }
  if (studyEnd === null || dataStart === null) {
    return {
      method: 'Kulldorff Bernoulli scan statistic', shape, settings,
      studyStart: null, studyEnd: null, streams: 0, locations: 0,
      totalTested: 0, totalResistant: 0, nullMaximumMean: 0, nullMaximumSd: 0, signals: [],
      warnings: ['No denominators: nothing was tested, so there is no proportion to scan.']
    }
  }
  const studyStart = Math.max(dataStart, studyEnd - (settings.baselineDays - 1))
  const studyDays = studyEnd - studyStart + 1
  const bounded = rows.filter((row) => parseDay(row.date) >= studyStart)

  const streams = new Map<string, Stream>()
  for (const row of bounded) {
    const key = `${row.organism_code}:${row.antibiotic_code}`
    const stream = streams.get(key) ?? { organismCode: row.organism_code, antibioticCode: row.antibiotic_code, cells: [] }
    stream.cells.push({
      day: parseDay(row.date) - studyStart,
      location: row.location,
      tested: row.tested,
      cases: row.resistant
    })
    streams.set(key, stream)
  }

  const seedMaterial = JSON.stringify({
    settings, shape,
    rows: bounded.map((row) => [row.date, row.location, row.organism_code, row.antibiotic_code, row.tested, row.resistant])
  })
  const random = randomGenerator(options.seed ?? fnv1a(seedMaterial))

  const observed: Candidate[] = []
  const streamList = [...streams.values()]
  for (const stream of streamList) {
    const counts = stream.cells.map((cell) => cell.cases)
    observed.push(...scanStream(stream, counts, studyDays, settings, shape, true).candidates)
  }
  observed.sort((left, right) => right.llr - left.llr || right.cases - left.cases)

  const simulatedMaxima: number[] = []
  for (let simulation = 0; simulation < settings.permutations; simulation += 1) {
    let maximum = 0
    for (const stream of streamList) {
      const totalCases = stream.cells.reduce((sum, cell) => sum + cell.cases, 0)
      const totalTested = stream.cells.reduce((sum, cell) => sum + cell.tested, 0)
      if (totalCases < settings.minimumCases || totalTested < settings.minimumTested) continue
      const counts = permuteCases(stream.cells, totalCases, totalTested, random)
      const result = scanStream(stream, counts, studyDays, settings, shape, false)
      if (result.maximum > maximum) maximum = result.maximum
    }
    simulatedMaxima.push(maximum)
  }
  const nullMoments = momentsOf(simulatedMaxima)

  const selected: Candidate[] = []
  for (const candidate of observed) {
    const overlaps = selected.some((current) =>
      current.stream === candidate.stream && current.location === candidate.location
      && candidate.start <= current.end && candidate.end >= current.start)
    if (!overlaps) selected.push(candidate)
  }

  const signals = selected.map((candidate): BernoulliSignal => {
    const exceedances = simulatedMaxima.filter((value) => value >= candidate.llr - 1e-12).length
    const pValue = (exceedances + 1) / (settings.permutations + 1)
    const recurrence = 1 / pValue
    const totalCases = candidate.stream.cells.reduce((sum, cell) => sum + cell.cases, 0)
    const totalTested = candidate.stream.cells.reduce((sum, cell) => sum + cell.tested, 0)
    const outsideCases = totalCases - candidate.cases
    const outsideTested = totalTested - candidate.tested
    const baseline = outsideTested > 0 ? outsideCases / outsideTested : 0
    const proportion = candidate.tested > 0 ? candidate.cases / candidate.tested : 0
    return {
      signal_id: fnv1a([candidate.stream.organismCode, candidate.stream.antibioticCode,
        candidate.location, candidate.start, candidate.end].join('|')).toString(16).padStart(8, '0'),
      status: recurrence >= settings.recurrenceThresholdDays ? 'alert' : 'monitor',
      organism: names[candidate.stream.organismCode] ?? candidate.stream.organismCode,
      antibiotic: candidate.stream.antibioticCode,
      scope: shape === 'space-time' ? 'Location proportion cluster'
        : shape === 'purely-temporal' ? 'All-location proportion cluster'
          : 'Location proportion excess',
      location: candidate.location,
      start_date: dayKey(studyStart + candidate.start),
      end_date: dayKey(studyStart + candidate.end),
      days: candidate.end - candidate.start + 1,
      observed: candidate.cases,
      tested: candidate.tested,
      proportion: round(proportion),
      baseline_proportion: round(baseline),
      proportion_ratio: baseline > 0 ? round(proportion / baseline, 2) : 0,
      log_likelihood_ratio: round(candidate.llr, 3),
      p_value: round(pValue),
      recurrence_interval_days: round(recurrence, 1)
    }
  }).filter((signal) => signal.p_value <= 0.05).slice(0, 50)

  const warnings: string[] = []
  if (studyDays < 60) warnings.push('Fewer than 60 study days: the baseline proportion may be unstable.')
  if (settings.permutations < 999) {
    warnings.push(`Fewer than 999 Monte Carlo replications: the highest reachable recurrence interval is `
      + `${settings.permutations + 1} days, so no alert can fire above that threshold.`)
  }
  if (shape === 'space-time' && new Set(bounded.map((row) => row.location)).size < 2) {
    warnings.push('Only one location: use the purely temporal shape, which is what a single-laboratory '
      + 'deployment needs and which the space-time scan cannot provide.')
  }

  return {
    method: 'Kulldorff Bernoulli scan statistic',
    shape,
    settings,
    studyStart: dayKey(studyStart),
    studyEnd: dayKey(studyEnd),
    streams: streamList.length,
    locations: new Set(bounded.map((row) => row.location)).size,
    totalTested: bounded.reduce((sum, row) => sum + row.tested, 0),
    totalResistant: bounded.reduce((sum, row) => sum + row.resistant, 0),
    nullMaximumMean: round(nullMoments.mean),
    nullMaximumSd: round(nullMoments.sd),
    signals,
    warnings
  }
}

// ---------------------------------------------------------------------------------
// Registration
//
// Three detectors rather than one with a shape setting, because the registry is what the
// operator picks from and the three answer different questions. A single-laboratory
// deployment has to be able to see that a purely temporal scan exists; if the shape were a
// setting on one entry, a site with one location would read "space-time Bernoulli:
// unavailable, only one location" and conclude, wrongly, that it has no proportion scan.

export const BERNOULLI_SPACE_TIME_ID = 'bernoulli-space-time'
export const BERNOULLI_PURELY_TEMPORAL_ID = 'bernoulli-purely-temporal'
export const BERNOULLI_PURELY_SPATIAL_ID = 'bernoulli-purely-spatial'

const CITATION = 'Kulldorff M. A spatial scan statistic. Communications in Statistics: Theory and '
  + 'Methods 1997;26:1481-1496. doi:10.1080/03610929708831995'

function descriptorFor(shape: BernoulliScanShape): DetectorDescriptor {
  const shared = {
    method: 'Kulldorff Bernoulli scan statistic on resistant-among-tested',
    family: 'scan' as const,
    citation: CITATION
  }
  if (shape === 'purely-temporal') {
    return Object.freeze({
      ...shared,
      id: BERNOULLI_PURELY_TEMPORAL_ID,
      name: 'Bernoulli proportion scan, purely temporal',
      requires: Object.freeze({ denominators: true, coordinates: false, multipleLocations: false }),
      supports: Object.freeze({ prospective: true, retrospective: true }),
      blindSpot: 'Collapses location, so a rise confined to one ward is diluted by every other '
        + 'ward and may not reach significance. It is the scan for a deployment that has one '
        + 'location, not a substitute for the space-time scan in one that has several.'
    })
  }
  if (shape === 'purely-spatial') {
    return Object.freeze({
      ...shared,
      id: BERNOULLI_PURELY_SPATIAL_ID,
      name: 'Bernoulli proportion scan, purely spatial',
      requires: Object.freeze({ denominators: true, coordinates: false, multipleLocations: true }),
      // Retrospective only. The question is which wards carry excess resistance over the whole
      // period, and a prospective version of that question is the space-time scan.
      supports: Object.freeze({ prospective: false, retrospective: true }),
      blindSpot: 'Collapses time, so a ward whose resistance rose sharply last month and was '
        + 'ordinary for the eleven before it is averaged back to ordinary. It ranks standing '
        + 'burden, not change.'
    })
  }
  return Object.freeze({
    ...shared,
    id: BERNOULLI_SPACE_TIME_ID,
    name: 'Bernoulli proportion scan, space-time',
    requires: Object.freeze({ denominators: true, coordinates: false, multipleLocations: true }),
    supports: Object.freeze({ prospective: true, retrospective: true }),
    blindSpot: 'Sees the resistant share and not the count, so an outbreak that doubles the '
      + 'number of resistant isolates while testing doubles alongside it is invisible here and '
      + 'visible to the case-only permutation scan. The two are complementary, which is why '
      + 'Phase 31 runs both.'
  })
}

/**
 * Map a Bernoulli signal onto the shared signal shape.
 *
 * `expected` is the resistant count the window would have carried at the outside
 * proportion — the Bernoulli null's expectation, exactly analogous to the permutation
 * scan's expected count, so the two are comparable in a table without a footnote. The
 * proportion fields are carried alongside rather than instead, because a reader who wants
 * to know whether the share moved should not have to divide.
 */
export function bernoulliDetectorSignal(
  signal: BernoulliSignal, shape: BernoulliScanShape, detectorId: string
): DetectorSignal {
  const expected = round(signal.tested * signal.baseline_proportion, 2)
  return {
    signal_id: signal.signal_id,
    status: signal.status,
    signal_type: 'Resistance phenotype',
    organism: signal.organism,
    antibiotic: signal.antibiotic,
    scope: shape === 'purely-temporal' ? 'All-location temporal cluster' : 'Location cluster',
    location: signal.location,
    start_date: signal.start_date,
    end_date: signal.end_date,
    days: signal.days,
    observed: signal.observed,
    expected,
    excess: round(signal.observed - expected, 2),
    observed_expected_ratio: expected > 0 ? round(signal.observed / expected, 2) : 0,
    log_likelihood_ratio: signal.log_likelihood_ratio,
    p_value: signal.p_value,
    recurrence_interval_days: signal.recurrence_interval_days,
    detector_id: detectorId,
    tested: signal.tested,
    proportion: signal.proportion,
    baseline_proportion: signal.baseline_proportion,
    proportion_ratio: signal.proportion_ratio
  }
}

function bernoulliDetector(shape: BernoulliScanShape): Detector {
  const descriptor = descriptorFor(shape)
  return {
    descriptor,

    defaultSettings(): Record<string, unknown> {
      return { ...DEFAULT_BERNOULLI_SETTINGS, ...(shape === 'purely-spatial' ? { analysisType: 'retrospective' } : {}) }
    },

    unavailableReason(context: DetectorContext): string | null {
      const missing = denominatorUnavailableReason(context)
      if (missing) return missing
      if (descriptor.requires.multipleLocations) {
        const locations = new Set(denominatorsFrom(context).map((row) => row.location))
        if (locations.size < 2) {
          return `Only one location: use ${BERNOULLI_PURELY_TEMPORAL_ID}, which is the proportion `
            + 'scan for a single-laboratory deployment.'
        }
      }
      return null
    },

    run(context: DetectorContext): DetectorRunResult {
      const denominators = denominatorsFrom(context)
      const settings = (context.settings ?? {}) as Partial<BernoulliSettings>
      const result = scanBernoulli({
        denominators,
        settings: shape === 'purely-spatial' ? { ...settings, analysisType: 'retrospective' } : settings,
        shape,
        ...(context.seed === undefined ? {} : { seed: context.seed })
      })
      return {
        descriptor,
        settings: { ...result.settings, shape: result.shape },
        signals: result.signals.map((signal) => bernoulliDetectorSignal(signal, shape, descriptor.id)),
        warnings: [...result.warnings],
        diagnostics: {
          method: result.method,
          shape: result.shape,
          analysis_type: result.settings.analysisType,
          study_start: result.studyStart,
          study_end: result.studyEnd,
          streams: result.streams,
          locations: result.locations,
          total_tested: result.totalTested,
          total_resistant: result.totalResistant,
          overall_proportion: result.totalTested > 0 ? round(result.totalResistant / result.totalTested) : 0,
          maximum_reachable_recurrence_interval: result.settings.permutations + 1
        }
      }
    }
  }
}

export const bernoulliSpaceTimeDetector = bernoulliDetector('space-time')
export const bernoulliPurelyTemporalDetector = bernoulliDetector('purely-temporal')
export const bernoulliPurelySpatialDetector = bernoulliDetector('purely-spatial')
