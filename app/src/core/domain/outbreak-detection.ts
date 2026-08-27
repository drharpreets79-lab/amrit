import type { AstResult, IsolateRecord } from '../../shared/types'

export type OutbreakAnalysisType = 'prospective' | 'retrospective'
export type OutbreakTarget = 'organism' | 'resistance' | 'both'

export interface OutbreakSettings {
  analysisType: OutbreakAnalysisType
  target: OutbreakTarget
  baselineDays: number
  maxClusterDays: number
  deduplicationDays: number
  minimumCases: number
  permutations: number
  recurrenceThresholdDays: number
}

export interface OutbreakCaseEvent {
  date: string
  location: string
  signalType: 'organism' | 'resistance'
  signalCode: string
  organismCode: string
  organism: string
  antibioticCode?: string
  count: number
}

export interface OutbreakAggregateRow {
  date: string
  signal_type: 'organism' | 'resistance'
  signal_code: string
  organism_code: string
  organism: string
  antibiotic_code: string
  count: number
}

export interface OutbreakSignal {
  signal_id: string
  status: 'alert' | 'monitor'
  signal_type: 'Organism' | 'Resistance phenotype'
  organism: string
  antibiotic: string
  scope: 'Location cluster' | 'All-location temporal cluster'
  location: string
  start_date: string
  end_date: string
  days: number
  observed: number
  expected: number
  excess: number
  observed_expected_ratio: number
  log_likelihood_ratio: number
  p_value: number
  recurrence_interval_days: number
}

export interface OutbreakScanResult {
  method: 'Kulldorff space-time permutation scan statistic'
  analysisType: OutbreakAnalysisType
  settings: OutbreakSettings
  studyStart: string | null
  studyEnd: string | null
  inputRecords: number
  eligibleEvents: number
  locations: number
  signalsTested: number
  invalidDateRecords: number
  repeatEventsExcluded: number
  maximumPossibleClusterDays: number
  /**
   * Mean and standard deviation of the Monte Carlo maxima the run already computed.
   *
   * Added for PACE (Phase 31), which runs this scan and a Bernoulli scan over the same
   * streams and has to order signals coming from two statistics with different scales. Each
   * signal's log-likelihood ratio standardised against its own model's null is comparable;
   * the raw ratios are not. Reporting the two moments costs two numbers and avoids running
   * the permutations twice.
   *
   * **The statistic, the events, the signals and the settings are unchanged.** This is the
   * control arm of every comparison Phases 28 to 34 make, and the parity test that asserts
   * the registry's signals are byte-identical to calling this function directly still holds:
   * these are two extra fields on the result, not a change to what the scan does.
   */
  nullMaximumMean: number
  nullMaximumSd: number
  signals: OutbreakSignal[]
  warnings: string[]
}

export const DEFAULT_OUTBREAK_SETTINGS: OutbreakSettings = Object.freeze({
  analysisType: 'prospective',
  target: 'both',
  baselineDays: 365,
  maxClusterDays: 60,
  deduplicationDays: 30,
  minimumCases: 3,
  permutations: 999,
  recurrenceThresholdDays: 365
})

const DAY_MS = 86_400_000
const text = (value: unknown): string => String(value ?? '').trim()
const upper = (value: unknown): string => text(value).toLocaleUpperCase()
const round = (value: number, digits = 3): number => Number(value.toFixed(digits))

function parseDate(value: unknown): Date | null {
  const raw = text(value)
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  if (!match) return null
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3])
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
    ? parsed : null
}

function dateKey(date: Date): string { return date.toISOString().slice(0, 10) }

function stableLocation(record: IsolateRecord): string {
  return text(record.location) || text(record.department) || text(record.location_type) || 'Unknown location'
}

function organismIdentity(record: IsolateRecord): { code: string; name: string } | null {
  const name = text(record.organism)
  const code = upper(record.organism_code) || name.toLocaleUpperCase()
  return code && name ? { code, name } : null
}

function astEntries(record: IsolateRecord): Array<[string, AstResult]> {
  return Object.entries(record.antibiotic_results ?? {}).map(([code, result]) => [upper(code), result])
}

interface BuildResult {
  events: OutbreakCaseEvent[]
  invalidDateRecords: number
  repeatEventsExcluded: number
}

/** WHONET-style patient de-duplication: one patient-organism episode per rolling interval. */
export function buildOutbreakCaseEvents(
  records: IsolateRecord[],
  settings: Pick<OutbreakSettings, 'target' | 'deduplicationDays'> = DEFAULT_OUTBREAK_SETTINGS
): BuildResult {
  const target = settings.target ?? DEFAULT_OUTBREAK_SETTINGS.target
  const deduplicationDays = settings.deduplicationDays ?? DEFAULT_OUTBREAK_SETTINGS.deduplicationDays
  const ordered = records.map((record, index) => ({ record, index, date: parseDate(record.specimen_date) }))
    .sort((left, right) => (left.date?.getTime() ?? Number.MAX_SAFE_INTEGER) - (right.date?.getTime() ?? Number.MAX_SAFE_INTEGER)
      || Number(left.record.id ?? 0) - Number(right.record.id ?? 0) || left.index - right.index)
  const lastSeen = new Map<string, number>()
  const events: OutbreakCaseEvent[] = []
  let invalidDateRecords = 0
  let repeatEventsExcluded = 0
  const interval = Math.max(0, deduplicationDays) * DAY_MS

  const include = (record: IsolateRecord, date: Date, signalType: 'organism' | 'resistance', signalCode: string,
    organismCode: string, organism: string, antibioticCode = ''): void => {
    const patient = text(record.patient_id).toLocaleLowerCase()
    const identity = patient || `record:${String(record.id ?? `${date.getTime()}:${events.length}`)}`
    const episodeKey = `${identity}\u001f${signalCode}`
    const previous = lastSeen.get(episodeKey)
    if (previous !== undefined && date.getTime() - previous <= interval) { repeatEventsExcluded += 1; return }
    lastSeen.set(episodeKey, date.getTime())
    events.push({
      date: dateKey(date), location: stableLocation(record), signalType, signalCode,
      organismCode, organism, ...(antibioticCode ? { antibioticCode } : {}), count: 1
    })
  }

  for (const { record, date } of ordered) {
    if (!date) { invalidDateRecords += 1; continue }
    const organism = organismIdentity(record)
    if (!organism) continue
    if (target !== 'resistance') {
      include(record, date, 'organism', `ORG:${organism.code}`, organism.code, organism.name)
    }
    if (target !== 'organism') {
      for (const [antibioticCode, ast] of astEntries(record)) {
        // `I` is not portable evidence of resistance: under current EUCAST it means
        // susceptible with increased exposure. Scan only interpretations explicitly saved R.
        if (upper(ast.result) !== 'R') continue
        include(record, date, 'resistance', `R:${organism.code}:${antibioticCode}`,
          organism.code, organism.name, antibioticCode)
      }
    }
  }
  return { events, invalidDateRecords, repeatEventsExcluded }
}

/** Aggregate-only wire product. No patient, specimen, ward, or free-text identifier leaves site. */
export function aggregateOutbreakCases(records: IsolateRecord[], deduplicationDays = 30): {
  schema_version: 1
  method: string
  deduplication_days: number
  rows: OutbreakAggregateRow[]
  source_records: number
  eligible_events: number
  repeat_events_excluded: number
  invalid_date_records: number
} {
  const built = buildOutbreakCaseEvents(records, { target: 'both', deduplicationDays })
  const buckets = new Map<string, OutbreakAggregateRow>()
  for (const event of built.events) {
    const bucketKey = [event.date, event.signalType, event.signalCode].join('\u001f')
    const current = buckets.get(bucketKey)
    if (current) current.count += event.count
    else buckets.set(bucketKey, {
      date: event.date, signal_type: event.signalType, signal_code: event.signalCode,
      organism_code: event.organismCode, organism: event.organism,
      antibiotic_code: event.antibioticCode ?? '', count: event.count
    })
  }
  return {
    schema_version: 1,
    method: 'WHONET-compatible case aggregation for space-time permutation scan',
    deduplication_days: deduplicationDays,
    rows: [...buckets.values()].sort((left, right) => left.date.localeCompare(right.date)
      || left.signal_code.localeCompare(right.signal_code)),
    source_records: records.length,
    eligible_events: built.events.length,
    repeat_events_excluded: built.repeatEventsExcluded,
    invalid_date_records: built.invalidDateRecords
  }
}

interface SeriesEvent { day: number; location: string; count: number }
interface ScanSeries {
  family: 'space-time' | 'category-time'
  signalType: 'organism' | 'resistance'
  signalCode: string
  organism: string
  antibiotic: string
  events: SeriesEvent[]
  locationMeta?: Map<string, { signalCode: string; organism: string; antibiotic: string }>
}
interface Candidate {
  series: ScanSeries
  location: string
  start: number
  end: number
  observed: number
  expected: number
  llr: number
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index); hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function randomGenerator(seed: number): () => number {
  let state = seed || 0x9e3779b9
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5
    return (state >>> 0) / 4_294_967_296
  }
}

function shuffled<T>(values: T[], random: () => number): T[] {
  const result = [...values]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1)); const held = result[index]
    result[index] = result[other] as T; result[other] = held as T
  }
  return result
}

function logLikelihoodRatio(observed: number, expected: number, total: number): number {
  if (observed <= expected || expected <= 0 || total <= observed || total <= expected) return 0
  const outsideObserved = total - observed; const outsideExpected = total - expected
  return observed * Math.log(observed / expected) + outsideObserved * Math.log(outsideObserved / outsideExpected)
}

/** Mean and standard deviation of the simulated maxima, over the sample rather than a population estimate. */
function moments(values: readonly number[]): { mean: number; sd: number } {
  if (values.length === 0) return { mean: 0, sd: 0 }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
  return { mean, sd: Math.sqrt(variance) }
}

function scanSeries(series: ScanSeries, studyDays: number, settings: OutbreakSettings, collect: boolean): {
  maximum: number
  candidates: Candidate[]
} {
  const total = series.events.reduce((sum, event) => sum + event.count, 0)
  if (total < settings.minimumCases || studyDays < 2) return { maximum: 0, candidates: [] }
  const locations = [...new Set(series.events.map((event) => event.location))]
  if (locations.length < 2) return { maximum: 0, candidates: [] }
  const maximumDays = Math.max(1, Math.min(settings.maxClusterDays, Math.floor(studyDays / 2)))
  const dateTotals = Array.from({ length: studyDays }, () => 0)
  const byLocation = new Map<string, number[]>()
  for (const location of locations) byLocation.set(location, Array.from({ length: studyDays }, () => 0))
  for (const event of series.events) {
    if (event.day < 0 || event.day >= studyDays) continue
    dateTotals[event.day] = (dateTotals[event.day] ?? 0) + event.count
    const counts = byLocation.get(event.location)
    if (counts) counts[event.day] = (counts[event.day] ?? 0) + event.count
  }
  const stratumTotals = Array.from({ length: 7 }, () => 0)
  for (let day = 0; day < studyDays; day += 1) stratumTotals[day % 7] = (stratumTotals[day % 7] ?? 0) + (dateTotals[day] ?? 0)
  let maximum = 0
  const candidates: Candidate[] = []
  const ends = settings.analysisType === 'prospective'
    ? [studyDays - 1] : Array.from({ length: studyDays }, (_, index) => index)
  for (const [location, counts] of byLocation) {
    const locationStrata = Array.from({ length: 7 }, () => 0)
    for (let day = 0; day < studyDays; day += 1) locationStrata[day % 7] = (locationStrata[day % 7] ?? 0) + (counts[day] ?? 0)
    for (const end of ends) {
      let observed = 0
      const windowStrata = Array.from({ length: 7 }, () => 0)
      for (let length = 1; length <= maximumDays && length <= end + 1; length += 1) {
        const start = end - length + 1
        observed += counts[start] ?? 0
        windowStrata[start % 7] = (windowStrata[start % 7] ?? 0) + (dateTotals[start] ?? 0)
        if (observed < settings.minimumCases) continue
        let expected = 0
        for (let stratum = 0; stratum < 7; stratum += 1) {
          const denominator = stratumTotals[stratum] ?? 0
          if (denominator) expected += ((locationStrata[stratum] ?? 0) * (windowStrata[stratum] ?? 0)) / denominator
        }
        const llr = logLikelihoodRatio(observed, expected, total)
        if (llr <= 0) continue
        maximum = Math.max(maximum, llr)
        if (collect) candidates.push({ series, location, start, end, observed, expected, llr })
      }
    }
  }
  return { maximum, candidates }
}

function permuteSeries(series: ScanSeries, random: () => number): ScanSeries {
  const expanded: Array<{ day: number; location: string }> = []
  for (const event of series.events) {
    for (let count = 0; count < event.count; count += 1) expanded.push({ day: event.day, location: event.location })
  }
  const dayPools = Array.from({ length: 7 }, () => [] as number[])
  for (const event of expanded) dayPools[event.day % 7]?.push(event.day)
  const shuffledPools = dayPools.map((pool) => shuffled(pool, random))
  const offsets = Array.from({ length: 7 }, () => 0)
  const counts = new Map<string, number>()
  for (const event of expanded) {
    const stratum = event.day % 7; const offset = offsets[stratum] ?? 0
    const day = shuffledPools[stratum]?.[offset] ?? event.day; offsets[stratum] = offset + 1
    const eventKey = `${day}\u001f${event.location}`
    counts.set(eventKey, (counts.get(eventKey) ?? 0) + 1)
  }
  return { ...series, events: [...counts].map(([eventKey, count]) => {
    const [day, location = 'Unknown location'] = eventKey.split('\u001f')
    return { day: Number(day), location, count }
  }) }
}

function seriesFromEvents(events: OutbreakCaseEvent[], firstDay: number): ScanSeries[] {
  const bySignal = new Map<string, OutbreakCaseEvent[]>()
  for (const event of events) {
    const values = bySignal.get(event.signalCode) ?? []; values.push(event); bySignal.set(event.signalCode, values)
  }
  const series: ScanSeries[] = []
  for (const [signalCode, values] of bySignal) {
    const first = values[0]
    if (!first) continue
    if (new Set(values.map((event) => event.location)).size >= 2) {
      series.push({
        family: 'space-time', signalType: first.signalType, signalCode,
        organism: first.organism, antibiotic: first.antibioticCode ?? '',
        events: values.map((event) => ({ day: Math.round((parseDate(event.date)?.getTime() ?? firstDay) / DAY_MS) - firstDay, location: event.location, count: event.count }))
      })
    }
  }
  for (const signalType of ['organism', 'resistance'] as const) {
    const values = events.filter((event) => event.signalType === signalType)
    const distinctSignals = [...new Set(values.map((event) => event.signalCode))]
    if (distinctSignals.length < 2) continue
    const meta = new Map<string, { signalCode: string; organism: string; antibiotic: string }>()
    for (const event of values) meta.set(event.signalCode, { signalCode: event.signalCode, organism: event.organism, antibiotic: event.antibioticCode ?? '' })
    series.push({
      family: 'category-time', signalType, signalCode: `${signalType.toUpperCase()}:ALL`,
      organism: '', antibiotic: '', locationMeta: meta,
      events: values.map((event) => ({ day: Math.round((parseDate(event.date)?.getTime() ?? firstDay) / DAY_MS) - firstDay, location: event.signalCode, count: event.count }))
    })
  }
  return series
}

function nonOverlapping(candidates: Candidate[]): Candidate[] {
  const selected: Candidate[] = []
  for (const candidate of candidates) {
    const overlaps = selected.some((current) => current.series.signalType === candidate.series.signalType
      && current.series.signalCode === candidate.series.signalCode && current.location === candidate.location
      && candidate.start <= current.end && candidate.end >= current.start)
    if (!overlaps) selected.push(candidate)
  }
  return selected
}

export function scanOutbreakEvents(
  events: OutbreakCaseEvent[],
  rawSettings: Partial<OutbreakSettings> = {},
  metadata: { inputRecords?: number; invalidDateRecords?: number; repeatEventsExcluded?: number } = {}
): OutbreakScanResult {
  const settings: OutbreakSettings = {
    analysisType: rawSettings.analysisType ?? DEFAULT_OUTBREAK_SETTINGS.analysisType,
    target: rawSettings.target ?? DEFAULT_OUTBREAK_SETTINGS.target,
    baselineDays: Math.max(30, Math.min(3650, Math.trunc(rawSettings.baselineDays ?? DEFAULT_OUTBREAK_SETTINGS.baselineDays))),
    maxClusterDays: Math.max(1, Math.min(365, Math.trunc(rawSettings.maxClusterDays ?? DEFAULT_OUTBREAK_SETTINGS.maxClusterDays))),
    deduplicationDays: Math.max(0, Math.min(365, Math.trunc(rawSettings.deduplicationDays ?? DEFAULT_OUTBREAK_SETTINGS.deduplicationDays))),
    minimumCases: Math.max(2, Math.min(100, Math.trunc(rawSettings.minimumCases ?? DEFAULT_OUTBREAK_SETTINGS.minimumCases))),
    permutations: Math.max(19, Math.min(9999, Math.trunc(rawSettings.permutations ?? DEFAULT_OUTBREAK_SETTINGS.permutations))),
    recurrenceThresholdDays: Math.max(20, Math.min(100_000, Math.trunc(rawSettings.recurrenceThresholdDays ?? DEFAULT_OUTBREAK_SETTINGS.recurrenceThresholdDays)))
  }
  const eligible = events.filter((event) => parseDate(event.date) && event.count > 0
    && (settings.target === 'both' || event.signalType === settings.target))
  const dates = eligible.map((event) => parseDate(event.date)?.getTime()).filter((value): value is number => value !== undefined)
  // Folded rather than spread. `Math.max(...dates)` passes one argument per event, and a
  // real year of a four-site network is tens of thousands of them: past roughly 125,000
  // V8 throws `RangeError: Maximum call stack size exceeded` and the scan dies on exactly
  // the deployments large enough to need it. Found by running the detector over a
  // generated corpus rather than over a hand-written fixture.
  let studyEndMs: number | null = null
  let dataStartMs: number | null = null
  for (const value of dates) {
    if (studyEndMs === null || value > studyEndMs) studyEndMs = value
    if (dataStartMs === null || value < dataStartMs) dataStartMs = value
  }
  const baselineStartMs = studyEndMs === null ? null : Math.max(dataStartMs ?? studyEndMs, studyEndMs - (settings.baselineDays - 1) * DAY_MS)
  const bounded = baselineStartMs === null ? [] : eligible.filter((event) => (parseDate(event.date)?.getTime() ?? 0) >= baselineStartMs)
  const firstDay = baselineStartMs === null ? 0 : Math.trunc(baselineStartMs / DAY_MS)
  const studyDays = baselineStartMs === null || studyEndMs === null ? 0 : Math.round((studyEndMs - baselineStartMs) / DAY_MS) + 1
  const series = seriesFromEvents(bounded, firstDay)
  const observedCandidates: Candidate[] = []
  for (const item of series) observedCandidates.push(...scanSeries(item, studyDays, settings, true).candidates)
  observedCandidates.sort((left, right) => right.llr - left.llr || right.observed - left.observed)

  const seedMaterial = JSON.stringify({ settings, events: bounded.map((event) => [event.date, event.location, event.signalCode, event.count]) })
  const random = randomGenerator(fnv1a(seedMaterial))
  const simulatedMaxima: number[] = []
  for (let simulation = 0; simulation < settings.permutations; simulation += 1) {
    let maximum = 0
    for (const item of series) maximum = Math.max(maximum, scanSeries(permuteSeries(item, random), studyDays, settings, false).maximum)
    simulatedMaxima.push(maximum)
  }
  const nullMoments = moments(simulatedMaxima)
  const converted = nonOverlapping(observedCandidates).map((candidate): OutbreakSignal => {
    const exceedances = simulatedMaxima.filter((value) => value >= candidate.llr - 1e-12).length
    const pValue = (exceedances + 1) / (settings.permutations + 1)
    const recurrence = 1 / pValue
    const meta = candidate.series.family === 'category-time'
      ? candidate.series.locationMeta?.get(candidate.location) : undefined
    const organism = meta?.organism ?? candidate.series.organism
    const antibiotic = meta?.antibiotic ?? candidate.series.antibiotic
    const signalCode = meta?.signalCode ?? candidate.series.signalCode
    const startMs = (firstDay + candidate.start) * DAY_MS
    const endMs = (firstDay + candidate.end) * DAY_MS
    const id = fnv1a([signalCode, candidate.location, startMs, endMs].join('|')).toString(16).padStart(8, '0')
    return {
      signal_id: id,
      status: recurrence >= settings.recurrenceThresholdDays ? 'alert' : 'monitor',
      signal_type: candidate.series.signalType === 'organism' ? 'Organism' : 'Resistance phenotype',
      organism,
      antibiotic,
      scope: candidate.series.family === 'space-time' ? 'Location cluster' : 'All-location temporal cluster',
      location: candidate.series.family === 'space-time' ? candidate.location : 'All locations',
      start_date: new Date(startMs).toISOString().slice(0, 10),
      end_date: new Date(endMs).toISOString().slice(0, 10),
      days: candidate.end - candidate.start + 1,
      observed: candidate.observed,
      expected: round(candidate.expected, 2),
      excess: round(candidate.observed - candidate.expected, 2),
      observed_expected_ratio: round(candidate.observed / candidate.expected, 2),
      log_likelihood_ratio: round(candidate.llr, 3),
      p_value: round(pValue, 4),
      recurrence_interval_days: round(recurrence, 1)
    }
  }).filter((signal) => signal.p_value <= 0.05).slice(0, 50)

  const warnings: string[] = []
  if (studyDays < 60) warnings.push('Fewer than 60 study days: baseline may be unstable.')
  if (new Set(bounded.map((event) => event.location)).size < 2) warnings.push('Only one physical location: location clusters cannot be estimated; all-location temporal scan only.')
  if (settings.permutations < 999) warnings.push('Fewer than 999 Monte Carlo replications limits p-value resolution.')
  if (metadata.invalidDateRecords) warnings.push(`${metadata.invalidDateRecords} record(s) excluded because specimen date was invalid or missing.`)
  return {
    method: 'Kulldorff space-time permutation scan statistic', analysisType: settings.analysisType, settings,
    studyStart: baselineStartMs === null ? null : new Date(baselineStartMs).toISOString().slice(0, 10),
    studyEnd: studyEndMs === null ? null : new Date(studyEndMs).toISOString().slice(0, 10),
    inputRecords: metadata.inputRecords ?? events.length,
    eligibleEvents: bounded.reduce((sum, event) => sum + event.count, 0),
    locations: new Set(bounded.map((event) => event.location)).size,
    signalsTested: new Set(bounded.map((event) => event.signalCode)).size,
    invalidDateRecords: metadata.invalidDateRecords ?? 0,
    repeatEventsExcluded: metadata.repeatEventsExcluded ?? 0,
    maximumPossibleClusterDays: studyDays ? Math.max(1, Math.min(settings.maxClusterDays, Math.floor(studyDays / 2))) : 0,
    nullMaximumMean: round(nullMoments.mean, 4),
    nullMaximumSd: round(nullMoments.sd, 4),
    signals: converted,
    warnings
  }
}

export function runOutbreakDetection(records: IsolateRecord[], settings: Partial<OutbreakSettings> = {}): OutbreakScanResult {
  const merged = { ...DEFAULT_OUTBREAK_SETTINGS }
  for (const [key, value] of Object.entries(settings)) {
    if (value !== undefined) (merged as unknown as Record<string, unknown>)[key] = value
  }
  const built = buildOutbreakCaseEvents(records, merged)
  return scanOutbreakEvents(built.events, merged, {
    inputRecords: records.length,
    invalidDateRecords: built.invalidDateRecords,
    repeatEventsExcluded: built.repeatEventsExcluded
  })
}
