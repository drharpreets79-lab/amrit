/**
 * Kulldorff's Poisson scan statistic, on resistant cases per population at risk.
 *
 * The model that answers the question an infection-prevention team actually asks — is this
 * ward producing more resistant infections *per patient-day* than the hospital as a whole —
 * and the one AMRIT cannot run on laboratory data alone.
 *
 * That is the whole difficulty and it is worth stating plainly rather than working around.
 * A laboratory record is evidence that a specimen was taken. It carries no information about
 * how many patients were present to take specimens from, how long they stayed, or how many
 * were admitted. `deriveDenominators` extracts isolates *tested*, which is the Bernoulli
 * model's denominator and a good one; it is not a population at risk, and substituting it
 * here would silently convert "resistant per patient-day" into "resistant per test", which
 * is the Bernoulli model wearing a Poisson label. So this detector requires
 * `DetectorContext.population` and says so when it is absent.
 *
 * ## The statistic
 *
 * For a candidate window Z with `c` cases and expected count `μ`, and `C` cases overall:
 *
 *     LLR = c·ln(c/μ) + (C−c)·ln((C−c)/(C−μ))   for c > μ, and 0 otherwise
 *
 * with `μ = C · (population inside Z) / (population overall)`. The expectation is the
 * population share, not a modelled rate, which is what makes the scan scale-free: doubling
 * every population value changes no statistic, so the unit the deployment supplies —
 * patient-days, admissions, occupied beds — never enters the arithmetic. It is carried on
 * the signal so a reader knows which rate they are looking at.
 *
 * ## The null
 *
 * Cases are redistributed across cells in proportion to population, holding the total case
 * count fixed. That is the Poisson null conditioned on the total, which is a multinomial
 * draw, and it is what SaTScan simulates for this model. Sampling is sequential binomial
 * over the remaining population share — the same distribution as a multinomial draw,
 * without building a cumulative table per replication.
 *
 * ## Where it fails
 *
 * A population series that is itself driven by the outbreak breaks the model. If an outbreak
 * closes a ward, its patient-days fall, the expected count falls with them, and the observed
 * excess is inflated by the response to the outbreak rather than the outbreak. The Bernoulli
 * model does not have this failure because its denominator moves with testing, not with
 * occupancy. Neither is uniformly safer; they fail differently, which is the argument for
 * having both.
 */

import { denominatorsFrom } from './denominators'
import type {
  DenominatorRow, Detector, DetectorContext, DetectorDescriptor, DetectorRunResult, DetectorSignal,
  PopulationRow
} from './types'

const DAY_MS = 86_400_000

export type PoissonScanShape = 'space-time' | 'purely-temporal' | 'purely-spatial'

export interface PoissonSettings {
  analysisType: 'prospective' | 'retrospective'
  baselineDays: number
  maxClusterDays: number
  /** Minimum resistant cases inside a window before it is reported. */
  minimumCases: number
  /**
   * Minimum expected count inside a window.
   *
   * A window with an expectation near zero produces a large log-likelihood ratio from two
   * cases, and the Monte Carlo correction handles that honestly but slowly. This is a guard
   * against reporting a ward that had four patient-days and one resistant isolate.
   */
  minimumExpected: number
  permutations: number
  recurrenceThresholdDays: number
}

export const DEFAULT_POISSON_SETTINGS: PoissonSettings = Object.freeze({
  analysisType: 'prospective',
  baselineDays: 365,
  maxClusterDays: 60,
  minimumCases: 3,
  minimumExpected: 0.5,
  permutations: 999,
  recurrenceThresholdDays: 365
})

export interface PoissonSignal {
  signal_id: string
  status: 'alert' | 'monitor'
  organism: string
  antibiotic: string
  scope: string
  location: string
  start_date: string
  end_date: string
  days: number
  observed: number
  expected: number
  excess: number
  observed_expected_ratio: number
  /** Population at risk inside the window, in `population_unit`. */
  population: number
  population_unit: string
  /** Cases per unit of population inside the window, and everywhere else. */
  rate: number
  baseline_rate: number
  log_likelihood_ratio: number
  p_value: number
  recurrence_interval_days: number
}

export interface PoissonScanResult {
  method: string
  shape: PoissonScanShape
  settings: PoissonSettings
  studyStart: string | null
  studyEnd: string | null
  streams: number
  locations: number
  totalCases: number
  totalPopulation: number
  populationUnit: string
  signals: PoissonSignal[]
  warnings: string[]
}

interface Cell {
  day: number
  location: string
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

export function poissonLogLikelihoodRatio(cases: number, expected: number, totalCases: number): number {
  const outsideCases = totalCases - cases
  const outsideExpected = totalCases - expected
  if (expected <= 0 || outsideExpected <= 0 || totalCases <= 0) return 0
  // High rates only. A ward with unusually *few* resistant infections per patient-day is
  // good news, and reporting it in the same list as an outbreak would bury the outbreak.
  if (cases <= expected) return 0
  const inside = cases * Math.log(cases / expected)
  const outside = outsideCases > 0 ? outsideCases * Math.log(outsideCases / outsideExpected) : 0
  const llr = inside + outside
  return Number.isFinite(llr) && llr > 0 ? llr : 0
}

/**
 * Redistribute cases across cells in proportion to population, holding the total fixed.
 *
 * Sequential binomial on the remaining population share: identical in distribution to a
 * multinomial draw over the cells, without a cumulative table per replication.
 */
function allocateCases(
  weights: readonly number[], totalCases: number, totalWeight: number, random: () => number
): number[] {
  const drawn = Array.from({ length: weights.length }, () => 0)
  let casesLeft = totalCases
  let weightLeft = totalWeight
  for (let index = 0; index < weights.length && casesLeft > 0; index += 1) {
    const weight = weights[index] ?? 0
    if (weight <= 0 || weightLeft <= 0) continue
    const probability = Math.min(1, weight / weightLeft)
    let taken = 0
    for (let draw = 0; draw < casesLeft; draw += 1) {
      if (random() < probability) taken += 1
    }
    drawn[index] = taken
    casesLeft -= taken
    weightLeft -= weight
  }
  return drawn
}

interface Candidate {
  stream: Stream
  location: string
  start: number
  end: number
  cases: number
  expected: number
  population: number
  llr: number
}

interface Grid {
  /** Population per location per day, the expectation weights. */
  population: Map<string, number[]>
  total: number
}

function scanStream(
  stream: Stream, counts: readonly number[], grid: Grid, studyDays: number,
  settings: PoissonSettings, shape: PoissonScanShape, collect: boolean
): { maximum: number; candidates: Candidate[] } {
  const totalCases = counts.reduce((sum, value) => sum + value, 0)
  if (totalCases < settings.minimumCases || grid.total <= 0) return { maximum: 0, candidates: [] }

  const groups = new Map<string, { cases: number[]; population: number[] }>()
  const blank = (): { cases: number[]; population: number[] } => ({
    cases: Array.from({ length: studyDays }, () => 0),
    population: Array.from({ length: studyDays }, () => 0)
  })
  // Purely temporal collapses location into one series; every other shape keeps them apart.
  // The population series has to be collapsed the same way or the expectation is taken over
  // a different denominator than the cases.
  for (const [location, series] of grid.population) {
    const key = shape === 'purely-temporal' ? 'All locations' : location
    const bucket = groups.get(key) ?? blank()
    for (let day = 0; day < studyDays; day += 1) {
      bucket.population[day] = (bucket.population[day] ?? 0) + (series[day] ?? 0)
    }
    groups.set(key, bucket)
  }
  for (const [index, cell] of stream.cells.entries()) {
    const key = shape === 'purely-temporal' ? 'All locations' : cell.location
    const bucket = groups.get(key)
    // A case in a location with no population series cannot be given an expectation. It is
    // dropped here and counted in the warnings, rather than assigned to another ward.
    if (!bucket || cell.day < 0 || cell.day >= studyDays) continue
    bucket.cases[cell.day] = (bucket.cases[cell.day] ?? 0) + (counts[index] ?? 0)
  }

  const maximumDays = shape === 'purely-spatial'
    ? studyDays
    : Math.max(1, Math.min(settings.maxClusterDays, Math.max(1, Math.floor(studyDays / 2))))
  const ends = shape === 'purely-spatial' || settings.analysisType === 'prospective'
    ? [studyDays - 1]
    : Array.from({ length: studyDays }, (_, index) => index)

  let maximum = 0
  const candidates: Candidate[] = []
  for (const [location, bucket] of groups) {
    for (const end of ends) {
      let cases = 0
      let population = 0
      const limit = shape === 'purely-spatial' ? studyDays : maximumDays
      for (let length = 1; length <= limit && length <= end + 1; length += 1) {
        const start = end - length + 1
        cases += bucket.cases[start] ?? 0
        population += bucket.population[start] ?? 0
        if (shape === 'purely-spatial' && length < limit && start > 0) continue
        if (cases < settings.minimumCases) continue
        const expected = totalCases * (population / grid.total)
        if (expected < settings.minimumExpected) continue
        const llr = poissonLogLikelihoodRatio(cases, expected, totalCases)
        if (llr <= 0) continue
        if (llr > maximum) maximum = llr
        if (collect) candidates.push({ stream, location, start, end, cases, expected, population, llr })
      }
    }
  }
  return { maximum, candidates }
}

export interface PoissonScanOptions {
  denominators: readonly DenominatorRow[]
  population: readonly PopulationRow[]
  settings?: Partial<PoissonSettings>
  shape?: PoissonScanShape
  organismNames?: Readonly<Record<string, string>>
  seed?: number
}

function boundSettings(raw: Partial<PoissonSettings> = {}): PoissonSettings {
  const clamp = (value: number | undefined, low: number, high: number, fallback: number): number =>
    Math.max(low, Math.min(high, Math.trunc(value ?? fallback)))
  return {
    analysisType: raw.analysisType === 'retrospective' ? 'retrospective' : 'prospective',
    baselineDays: clamp(raw.baselineDays, 30, 3650, DEFAULT_POISSON_SETTINGS.baselineDays),
    maxClusterDays: clamp(raw.maxClusterDays, 1, 365, DEFAULT_POISSON_SETTINGS.maxClusterDays),
    minimumCases: clamp(raw.minimumCases, 2, 100, DEFAULT_POISSON_SETTINGS.minimumCases),
    minimumExpected: Math.max(0.01, Math.min(100, raw.minimumExpected ?? DEFAULT_POISSON_SETTINGS.minimumExpected)),
    permutations: clamp(raw.permutations, 19, 9999, DEFAULT_POISSON_SETTINGS.permutations),
    recurrenceThresholdDays: clamp(raw.recurrenceThresholdDays, 20, 100_000, DEFAULT_POISSON_SETTINGS.recurrenceThresholdDays)
  }
}

const parseDay = (value: string): number => {
  const parsed = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(parsed) ? Math.round(parsed / DAY_MS) : Number.NaN
}
const dayKey = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10)

const empty = (shape: PoissonScanShape, settings: PoissonSettings, warning: string): PoissonScanResult => ({
  method: 'Kulldorff Poisson scan statistic', shape, settings,
  studyStart: null, studyEnd: null, streams: 0, locations: 0,
  totalCases: 0, totalPopulation: 0, populationUnit: '', signals: [], warnings: [warning]
})

export function scanPoisson(options: PoissonScanOptions): PoissonScanResult {
  const settings = boundSettings(options.settings)
  const shape = options.shape ?? 'space-time'
  const names = options.organismNames ?? {}

  const populationRows = options.population.filter((row) => row.population > 0)
  if (populationRows.length === 0) {
    return empty(shape, settings, 'No population at risk was supplied. This model reports cases per '
      + 'patient-day (or per admission, or per occupied bed) and a laboratory record does not carry one.')
  }
  const caseRows = options.denominators.filter((row) => row.antibiotic_code !== '' && row.resistant > 0)
  if (caseRows.length === 0) {
    return empty(shape, settings, 'No resistant isolates: there is nothing for a rate to be a rate of.')
  }

  const populationDays = populationRows.map((row) => parseDay(row.date)).filter(Number.isFinite)
  const caseDays = caseRows.map((row) => parseDay(row.date)).filter(Number.isFinite)
  const allDays = [...populationDays, ...caseDays]
  if (allDays.length === 0) return empty(shape, settings, 'No valid dates in the population or case rows.')
  let studyEnd = allDays[0] as number
  let dataStart = allDays[0] as number
  for (const day of allDays) {
    if (day > studyEnd) studyEnd = day
    if (day < dataStart) dataStart = day
  }
  const studyStart = Math.max(dataStart, studyEnd - (settings.baselineDays - 1))
  const studyDays = studyEnd - studyStart + 1

  const grid: Grid = { population: new Map(), total: 0 }
  const units = new Set<string>()
  for (const row of populationRows) {
    const day = parseDay(row.date) - studyStart
    if (!Number.isFinite(day) || day < 0 || day >= studyDays) continue
    const series = grid.population.get(row.location) ?? Array.from({ length: studyDays }, () => 0)
    series[day] = (series[day] ?? 0) + row.population
    grid.population.set(row.location, series)
    grid.total += row.population
    units.add(row.unit || 'population')
  }
  if (grid.total <= 0) {
    return empty(shape, settings, 'The population rows fall outside the study window, so no window has '
      + 'an expected count.')
  }

  const streams = new Map<string, Stream>()
  let orphanCases = 0
  for (const row of caseRows) {
    const day = parseDay(row.date) - studyStart
    if (!Number.isFinite(day) || day < 0 || day >= studyDays) continue
    if (!grid.population.has(row.location)) {
      orphanCases += row.resistant
      continue
    }
    const key = `${row.organism_code}:${row.antibiotic_code}`
    const stream = streams.get(key)
      ?? { organismCode: row.organism_code, antibioticCode: row.antibiotic_code, cells: [] }
    stream.cells.push({ day, location: row.location, cases: row.resistant })
    streams.set(key, stream)
  }

  const streamList = [...streams.values()]
  const seedMaterial = JSON.stringify({
    settings, shape, total: grid.total,
    streams: streamList.map((stream) => [stream.organismCode, stream.antibioticCode, stream.cells.length])
  })
  const random = randomGenerator(options.seed ?? fnv1a(seedMaterial))

  const observed: Candidate[] = []
  for (const stream of streamList) {
    const counts = stream.cells.map((cell) => cell.cases)
    observed.push(...scanStream(stream, counts, grid, studyDays, settings, shape, true).candidates)
  }
  observed.sort((left, right) => right.llr - left.llr || right.cases - left.cases)

  // The weights a case can land on under the null: one per cell, the population of that
  // cell's location on that day. Built once per stream rather than per replication.
  const weightsByStream = new Map<Stream, number[]>()
  for (const stream of streamList) {
    weightsByStream.set(stream, stream.cells.map((cell) =>
      (grid.population.get(cell.location)?.[cell.day]) ?? 0))
  }

  const simulatedMaxima: number[] = []
  for (let simulation = 0; simulation < settings.permutations; simulation += 1) {
    let maximum = 0
    for (const stream of streamList) {
      const totalCases = stream.cells.reduce((sum, cell) => sum + cell.cases, 0)
      if (totalCases < settings.minimumCases) continue
      const weights = weightsByStream.get(stream) ?? []
      const weightTotal = weights.reduce((sum, value) => sum + value, 0)
      if (weightTotal <= 0) continue
      const counts = allocateCases(weights, totalCases, weightTotal, random)
      const result = scanStream(stream, counts, grid, studyDays, settings, shape, false)
      if (result.maximum > maximum) maximum = result.maximum
    }
    simulatedMaxima.push(maximum)
  }

  const selected: Candidate[] = []
  for (const candidate of observed) {
    const overlaps = selected.some((current) =>
      current.stream === candidate.stream && current.location === candidate.location
      && candidate.start <= current.end && candidate.end >= current.start)
    if (!overlaps) selected.push(candidate)
  }

  const populationUnit = units.size === 1 ? [...units][0] as string : 'mixed population units'
  const signals = selected.map((candidate): PoissonSignal => {
    const exceedances = simulatedMaxima.filter((value) => value >= candidate.llr - 1e-12).length
    const pValue = (exceedances + 1) / (settings.permutations + 1)
    const recurrence = 1 / pValue
    const totalCases = candidate.stream.cells.reduce((sum, cell) => sum + cell.cases, 0)
    const outsidePopulation = grid.total - candidate.population
    const outsideCases = totalCases - candidate.cases
    return {
      signal_id: fnv1a([candidate.stream.organismCode, candidate.stream.antibioticCode,
        candidate.location, candidate.start, candidate.end].join('|')).toString(16).padStart(8, '0'),
      status: recurrence >= settings.recurrenceThresholdDays ? 'alert' : 'monitor',
      organism: names[candidate.stream.organismCode] ?? candidate.stream.organismCode,
      antibiotic: candidate.stream.antibioticCode,
      scope: shape === 'space-time' ? 'Location rate cluster'
        : shape === 'purely-temporal' ? 'All-location rate cluster'
          : 'Location rate excess',
      location: candidate.location,
      start_date: dayKey(studyStart + candidate.start),
      end_date: dayKey(studyStart + candidate.end),
      days: candidate.end - candidate.start + 1,
      observed: candidate.cases,
      expected: round(candidate.expected, 2),
      excess: round(candidate.cases - candidate.expected, 2),
      observed_expected_ratio: candidate.expected > 0 ? round(candidate.cases / candidate.expected, 2) : 0,
      population: round(candidate.population, 2),
      population_unit: populationUnit,
      rate: candidate.population > 0 ? round(candidate.cases / candidate.population, 6) : 0,
      baseline_rate: outsidePopulation > 0 ? round(outsideCases / outsidePopulation, 6) : 0,
      log_likelihood_ratio: round(candidate.llr, 3),
      p_value: round(pValue),
      recurrence_interval_days: round(recurrence, 1)
    }
  }).filter((signal) => signal.p_value <= 0.05).slice(0, 50)

  const warnings: string[] = []
  if (studyDays < 60) warnings.push('Fewer than 60 study days: the baseline rate may be unstable.')
  if (settings.permutations < 999) {
    warnings.push('Fewer than 999 Monte Carlo replications: the highest reachable recurrence interval is '
      + `${settings.permutations + 1} days, so no alert can fire above that threshold.`)
  }
  if (orphanCases > 0) {
    warnings.push(`${orphanCases} resistant isolates are in locations with no population series and were `
      + 'excluded. A case with no denominator cannot be given an expected count, and assigning it to '
      + 'another location would invent one.')
  }
  if (units.size > 1) {
    warnings.push(`The population rows mix ${units.size} units (${[...units].sort().join(', ')}). The scan `
      + 'compares population shares, so mixing units silently reweights locations against each other.')
  }
  if (shape === 'space-time' && grid.population.size < 2) {
    warnings.push('Only one location: use the purely temporal shape.')
  }

  return {
    method: 'Kulldorff Poisson scan statistic',
    shape,
    settings,
    studyStart: dayKey(studyStart),
    studyEnd: dayKey(studyEnd),
    streams: streamList.length,
    locations: grid.population.size,
    totalCases: streamList.reduce((sum, stream) => sum + stream.cells.reduce((inner, cell) => inner + cell.cases, 0), 0),
    totalPopulation: round(grid.total, 2),
    populationUnit,
    signals,
    warnings
  }
}

// ---------------------------------------------------------------------------------
// Registration

export const POISSON_SPACE_TIME_ID = 'poisson-space-time'
export const POISSON_PURELY_TEMPORAL_ID = 'poisson-purely-temporal'

const CITATION = 'Kulldorff M. A spatial scan statistic. Communications in Statistics: Theory and '
  + 'Methods 1997;26:1481-1496. doi:10.1080/03610929708831995'

function descriptorFor(shape: PoissonScanShape): DetectorDescriptor {
  const shared = {
    method: 'Kulldorff Poisson scan statistic on cases per population at risk',
    family: 'scan' as const,
    citation: CITATION,
    supports: Object.freeze({ prospective: true, retrospective: true })
  }
  if (shape === 'purely-temporal') {
    return Object.freeze({
      ...shared,
      id: POISSON_PURELY_TEMPORAL_ID,
      name: 'Poisson rate scan, purely temporal',
      requires: Object.freeze({ denominators: true, coordinates: false, multipleLocations: false }),
      blindSpot: 'Collapses location, so a rise confined to one ward is diluted by every other. '
        + 'It also inherits the Poisson failure: a population series that responds to the outbreak '
        + 'moves the expectation in the same direction as the excess.'
    })
  }
  return Object.freeze({
    ...shared,
    id: POISSON_SPACE_TIME_ID,
    name: 'Poisson rate scan, space-time',
    requires: Object.freeze({ denominators: true, coordinates: false, multipleLocations: true }),
    blindSpot: 'Trusts the population series it is given. If a ward closes to admissions because of '
      + 'the outbreak, its patient-days fall, the expected count falls with them, and the excess is '
      + 'inflated by the response rather than the event. The Bernoulli model does not have this '
      + 'failure, and has others.'
  })
}

function toDetectorSignal(signal: PoissonSignal, shape: PoissonScanShape, detectorId: string): DetectorSignal {
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
    expected: signal.expected,
    excess: signal.excess,
    observed_expected_ratio: signal.observed_expected_ratio,
    log_likelihood_ratio: signal.log_likelihood_ratio,
    p_value: signal.p_value,
    recurrence_interval_days: signal.recurrence_interval_days,
    detector_id: detectorId,
    population: signal.population,
    population_unit: signal.population_unit
  }
}

function poissonDetector(shape: PoissonScanShape): Detector {
  const descriptor = descriptorFor(shape)
  return {
    descriptor,

    defaultSettings(): Record<string, unknown> {
      return { ...DEFAULT_POISSON_SETTINGS }
    },

    unavailableReason(context: DetectorContext): string | null {
      if (!context.population?.length) {
        return 'No population at risk. This model reports resistant cases per patient-day (or per '
          + 'admission, or per occupied bed) and no laboratory record carries one — the deployment has '
          + 'to supply it from whatever system holds occupancy. Until it does, the Bernoulli model '
          + 'scans the resistant share of what was tested, which laboratory data can supply.'
      }
      const denominators = denominatorsFrom(context)
      if (!denominators.some((row) => row.antibiotic_code !== '' && row.resistant > 0)) {
        return 'No resistant isolates: there is nothing for a rate to be a rate of.'
      }
      if (descriptor.requires.multipleLocations) {
        const locations = new Set(context.population.map((row) => row.location))
        if (locations.size < 2) {
          return `Only one location in the population series: use ${POISSON_PURELY_TEMPORAL_ID}.`
        }
      }
      return null
    },

    run(context: DetectorContext): DetectorRunResult {
      const result = scanPoisson({
        denominators: denominatorsFrom(context),
        population: context.population ?? [],
        settings: (context.settings ?? {}) as Partial<PoissonSettings>,
        shape,
        ...(context.seed === undefined ? {} : { seed: context.seed })
      })
      return {
        descriptor,
        settings: { ...result.settings, shape: result.shape },
        signals: result.signals.map((signal) => toDetectorSignal(signal, shape, descriptor.id)),
        warnings: [...result.warnings],
        diagnostics: {
          method: result.method,
          shape: result.shape,
          analysis_type: result.settings.analysisType,
          study_start: result.studyStart,
          study_end: result.studyEnd,
          streams: result.streams,
          locations: result.locations,
          total_cases: result.totalCases,
          total_population: result.totalPopulation,
          population_unit: result.populationUnit,
          maximum_reachable_recurrence_interval: result.settings.permutations + 1
        }
      }
    }
  }
}

export const poissonSpaceTimeDetector = poissonDetector('space-time')
export const poissonPurelyTemporalDetector = poissonDetector('purely-temporal')
