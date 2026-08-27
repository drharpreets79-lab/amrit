import type { AnalysisFilters, AnalysisResult, AstResult, DeduplicateMode, IsolateRecord, Row } from '../shared/types'
import { DEFAULT_DETECTOR_ID, getDetector } from './detection/registry'
import { runOutbreakDetection } from './outbreak-detection'

type AstCounts = { tested: number; R: number; I: number; S: number; measurements: number[] }
type PriorityIndicator = {
  indicator: string
  numerator: number
  denominator: number
  rate: number | null
  tested_with: string
}

const INDICATORS = [
  { label: 'MRSA among Staphylococcus aureus', organisms: ['staphylococcus aureus', 's. aureus'], drugs: ['FOX', 'OXA'], positive: ['R', 'I'] },
  { label: 'Vancomycin-nonsusceptible Enterococcus', organisms: ['enterococcus'], drugs: ['VAN'], positive: ['R', 'I'] },
  { label: '3GC-nonsusceptible Escherichia coli', organisms: ['escherichia coli', 'e. coli'], drugs: ['CTX', 'CRO', 'CAZ'], positive: ['R', 'I'] },
  { label: '3GC-nonsusceptible Klebsiella pneumoniae', organisms: ['klebsiella pneumoniae'], drugs: ['CTX', 'CRO', 'CAZ'], positive: ['R', 'I'] },
  { label: 'Carbapenem-nonsusceptible Enterobacterales', organisms: ['escherichia coli', 'e. coli', 'klebsiella', 'enterobacter', 'serratia', 'citrobacter', 'proteus', 'morganella'], drugs: ['MEM', 'IPM', 'ETP'], positive: ['R', 'I'] },
  { label: 'Carbapenem-nonsusceptible Pseudomonas aeruginosa', organisms: ['pseudomonas aeruginosa'], drugs: ['MEM', 'IPM'], positive: ['R', 'I'] },
  { label: 'Carbapenem-nonsusceptible Acinetobacter spp.', organisms: ['acinetobacter'], drugs: ['MEM', 'IPM'], positive: ['R', 'I'] },
  { label: 'Fluoroquinolone-resistant Escherichia coli', organisms: ['escherichia coli', 'e. coli'], drugs: ['CIP', 'LVX'], positive: ['R'] },
  { label: 'Penicillin-nonsusceptible Streptococcus pneumoniae', organisms: ['streptococcus pneumoniae'], drugs: ['PEN'], positive: ['R', 'I'] }
] as const

const CONTAMINANT_TOKENS = [
  'coagulase-negative staphylococcus', 'staphylococcus epidermidis', 'staphylococcus hominis',
  'staphylococcus haemolyticus', 'staphylococcus capitis', 'staphylococcus warneri',
  'corynebacterium', 'cutibacterium', 'propionibacterium', 'micrococcus', 'bacillus'
]

const TITLES: Record<string, string> = {
  ris: 'S/I/R profile', stewardship: 'Antimicrobial stewardship', unitAntibiogram: 'Unit antibiogram',
  specimenAntibiogram: 'Specimen antibiogram', priorityIndicators: 'Priority AMR indicators',
  dataQuality: 'Data quality and contamination', trends: 'AMR trends', isolateListing: 'Isolate listing',
  summary: 'Surveillance summary', clusterWatch: 'Outbreak and cluster detection'
}

const text = (value: unknown): string => String(value ?? '').trim()
const key = (value: unknown): string => text(value).toLocaleUpperCase()
const round = (value: number, digits = 1): number => Number(value.toFixed(digits))
const percent = (numerator: number, denominator: number): number => denominator ? round((numerator / denominator) * 100) : 0

interface PreparedCohort {
  records: IsolateRecord[]
  sourceCount: number
  repeatIsolatesExcluded: number
  mode: DeduplicateMode
  selectedOrganisms: string[]
  selectedSpecimenTypes: string[]
}

function selectedValues(plural: string[] | undefined, singular: string | undefined): string[] {
  const source = plural?.length ? plural : (text(singular) ? [text(singular)] : [])
  return [...new Set(source.map(text).filter(Boolean))]
}

/** Mirrors Python: apply multi-selects first, then keep earliest patient + organism isolate. */
export function prepareAnalysisCohort(records: IsolateRecord[], filters: AnalysisFilters): PreparedCohort {
  const selectedOrganisms = selectedValues(filters.organisms, filters.organism)
  const selectedSpecimenTypes = selectedValues(filters.specimenTypes, filters.specimenType)
  const organismKeys = new Set(selectedOrganisms.map((value) => value.toLocaleLowerCase()))
  const specimenKeys = new Set(selectedSpecimenTypes.map((value) => value.toLocaleLowerCase()))
  const exactOrganisms = Boolean(filters.organisms?.length)
  const exactSpecimens = Boolean(filters.specimenTypes?.length)
  const selected = records.filter((record) => {
    if (organismKeys.size) {
      const name = text(record.organism).toLocaleLowerCase()
      const code = text(record.organism_code).toLocaleLowerCase()
      const matches = exactOrganisms
        ? organismKeys.has(name) || organismKeys.has(code)
        : [...organismKeys].some((value) => name.includes(value) || code === value)
      if (!matches) return false
    }
    if (specimenKeys.size) {
      const name = text(record.specimen_type).toLocaleLowerCase()
      const code = text(record.specimen_code).toLocaleLowerCase()
      const matches = exactSpecimens
        ? specimenKeys.has(name) || specimenKeys.has(code)
        : [...specimenKeys].some((value) => name.includes(value) || code === value)
      if (!matches) return false
    }
    return true
  })
  const mode = filters.deduplicateMode ?? 'firstPatientOrganism'
  if (mode === 'allIsolates') {
    return { records: selected, sourceCount: selected.length, repeatIsolatesExcluded: 0, mode, selectedOrganisms, selectedSpecimenTypes }
  }
  const ordered = selected.map((record, index) => ({ record, index })).sort((left, right) => {
    const leftDate = parseDate(left.record.specimen_date)?.getTime() ?? Number.MAX_SAFE_INTEGER
    const rightDate = parseDate(right.record.specimen_date)?.getTime() ?? Number.MAX_SAFE_INTEGER
    if (leftDate !== rightDate) return leftDate - rightDate
    const leftId = Number(left.record.id ?? 0)
    const rightId = Number(right.record.id ?? 0)
    return leftId - rightId || left.index - right.index
  })
  const seen = new Set<string>()
  const included: IsolateRecord[] = []
  for (const { record } of ordered) {
    const patient = text(record.patient_id).toLocaleLowerCase()
    const organism = (text(record.organism_code) || text(record.organism)).toLocaleLowerCase()
    if (!patient || !organism) {
      included.push(record)
      continue
    }
    const cohortKey = `${text(record.lab_code).toLocaleLowerCase()}\u001f${patient}\u001f${organism}`
    if (seen.has(cohortKey)) continue
    seen.add(cohortKey)
    included.push(record)
  }
  return {
    records: included,
    sourceCount: selected.length,
    repeatIsolatesExcluded: selected.length - included.length,
    mode,
    selectedOrganisms,
    selectedSpecimenTypes
  }
}

function countRows(values: Iterable<string>): Array<{ label: string; value: number }> {
  const counts = new Map<string, number>()
  for (const raw of values) {
    const value = raw || 'Unknown'
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts].map(([label, value]) => ({ label, value }))
    .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label))
}

function parseDate(value: unknown): Date | null {
  const raw = text(value)
  let match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(raw)
  let year: number
  let month: number
  let day: number
  if (match) {
    year = Number(match[1]); month = Number(match[2]); day = Number(match[3])
  } else {
    match = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(raw)
    if (!match) return null
    day = Number(match[1]); month = Number(match[2]); year = Number(match[3])
  }
  const result = new Date(Date.UTC(year, month - 1, day))
  return result.getUTCFullYear() === year && result.getUTCMonth() === month - 1 && result.getUTCDate() === day
    ? result : null
}

function daysBetween(later: Date, earlier: Date): number {
  return Math.round((later.getTime() - earlier.getTime()) / 86_400_000)
}

function median(values: number[]): number | null {
  if (!values.length) return null
  const ordered = [...values].sort((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  const upper = ordered[middle] ?? 0
  return ordered.length % 2 ? upper : ((ordered[middle - 1] ?? upper) + upper) / 2
}

function astEntries(record: IsolateRecord): Array<[string, AstResult]> {
  return Object.entries(record.antibiotic_results ?? {}).map(([code, result]) => [key(code), result])
}

function astResult(record: IsolateRecord, antibioticCode: string): string {
  const wanted = key(antibioticCode)
  const found = astEntries(record).find(([code]) => code === wanted)
  return key(found?.[1].result)
}

function measurement(value: unknown): number | null {
  const match = /(\d+(?:\.\d+)?)/.exec(text(value))
  return match ? Number(match[1]) : null
}

function susceptibilityStats(records: IsolateRecord[]): Map<string, AstCounts> {
  const stats = new Map<string, AstCounts>()
  for (const record of records) {
    for (const [code, result] of astEntries(record)) {
      const interpretation = key(result.result)
      const numeric = measurement(result.measurement)
      if (!['R', 'I', 'S'].includes(interpretation) && numeric === null) continue
      const bucket = stats.get(code) ?? { tested: 0, R: 0, I: 0, S: 0, measurements: [] }
      if (interpretation === 'R' || interpretation === 'I' || interpretation === 'S') {
        bucket.tested += 1
        bucket[interpretation] += 1
      }
      if (numeric !== null) bucket.measurements.push(numeric)
      stats.set(code, bucket)
    }
  }
  return stats
}

function infectionOrigin(record: IsolateRecord): 'Hospital' | 'Community' | 'Unknown' {
  const locationType = text(record.location_type).toLocaleLowerCase()
  if (locationType === 'out') return 'Community'
  if (locationType !== 'in') return 'Unknown'
  const admission = parseDate(record.admission_date)
  const specimen = parseDate(record.specimen_date)
  if (!admission || !specimen) return 'Unknown'
  return daysBetween(specimen, admission) > 2 ? 'Hospital' : 'Community'
}

function priorityIndicators(records: IsolateRecord[]): PriorityIndicator[] {
  return INDICATORS.map((definition) => {
    let numerator = 0
    let denominator = 0
    const testedWith = new Map<string, number>()
    for (const record of records) {
      const organism = text(record.organism).toLocaleLowerCase()
      if (!definition.organisms.some((token) => organism.includes(token))) continue
      const observed = definition.drugs.map((drug) => [drug, astResult(record, drug)] as const)
        .filter(([, result]) => ['R', 'I', 'S'].includes(result))
      const firstObserved = observed[0]
      if (!firstObserved) continue
      denominator += 1
      testedWith.set(firstObserved[0], (testedWith.get(firstObserved[0]) ?? 0) + 1)
      if (observed.some(([, result]) => (definition.positive as readonly string[]).includes(result))) numerator += 1
    }
    const tested_with = [...testedWith].sort((left, right) => right[1] - left[1])
      .slice(0, 2).map(([drug, count]) => `${drug} (${count})`).join(', ') || '-'
    return { indicator: definition.label, numerator, denominator, rate: denominator ? round((numerator / denominator) * 100) : null, tested_with }
  })
}

function commonResult(
  records: IsolateRecord[],
  filters: AnalysisFilters,
  cohort: PreparedCohort,
  truncated: boolean
): AnalysisResult {
  const stats = susceptibilityStats(records)
  const resistant = [...stats.values()].reduce((sum, item) => sum + item.R, 0)
  const intermediate = [...stats.values()].reduce((sum, item) => sum + item.I, 0)
  const susceptible = [...stats.values()].reduce((sum, item) => sum + item.S, 0)
  const tested = resistant + intermediate + susceptible
  const mode = filters.mode ?? 'ris'
  return {
    mode,
    title: TITLES[mode] ?? 'AMR analysis',
    total: records.length,
    resistant,
    intermediate,
    susceptible,
    resistancePercent: percent(resistant, tested),
    byOrganism: countRows(records.map((record) => text(record.organism) || 'Unknown')),
    bySpecimen: countRows(records.map((record) => text(record.specimen_type) || 'Unknown')),
    byMonth: countRows(records.map((record) => text(record.specimen_date).slice(0, 7) || 'Unknown'))
      .sort((left, right) => left.label.localeCompare(right.label)),
    byAntibiotic: [...stats].map(([code, item]) => ({
      code, tested: item.tested, resistant: item.R, percent: percent(item.R, item.tested)
    })).sort((left, right) => right.percent - left.percent || left.code.localeCompare(right.code)),
    dataQuality: [
      { label: 'Missing patient ID', value: records.filter((record) => !text(record.patient_id)).length },
      { label: 'Missing specimen', value: records.filter((record) => !text(record.specimen_type)).length },
      { label: 'Missing organism', value: records.filter((record) => !text(record.organism)).length },
      { label: 'No AST result', value: records.filter((record) => !astEntries(record).some(([, result]) => ['R', 'I', 'S'].includes(key(result.result)))).length },
      { label: 'Draft records', value: records.filter((record) => record.record_status === 'draft').length }
    ],
    cohort: {
      sourceCount: cohort.sourceCount,
      includedCount: records.length,
      repeatIsolatesExcluded: cohort.repeatIsolatesExcluded,
      truncated,
      deduplicateMode: cohort.mode,
      selectedOrganisms: cohort.selectedOrganisms,
      selectedSpecimenTypes: cohort.selectedSpecimenTypes
    },
    summaryLines: [
      `${records.length} isolate record(s) analysed.`,
      `${tested} interpretable AST result(s); ${resistant} resistant (${percent(resistant, tested).toFixed(1)}%).`
    ]
  }
}

function risDetail(records: IsolateRecord[]): Pick<AnalysisResult, 'columns' | 'rows' | 'summaryLines'> {
  const stats = susceptibilityStats(records)
  const rows: Row[] = [...stats].sort(([left], [right]) => left.localeCompare(right)).map(([code, item]) => ({
    code,
    tests: item.tested,
    resistant: item.R,
    intermediate: item.I,
    susceptible: item.S,
    percent_r: percent(item.R, item.tested),
    percent_i: percent(item.I, item.tested),
    percent_s: percent(item.S, item.tested),
    average_measurement: item.measurements.length ? round(item.measurements.reduce((sum, value) => sum + value, 0) / item.measurements.length, 2) : null
  }))
  const ranked = [...rows].sort((left, right) => Number(right.percent_r) - Number(left.percent_r))
  const highest = ranked[0]
  return {
    columns: ['code', 'tests', 'resistant', 'intermediate', 'susceptible', 'percent_r', 'percent_i', 'percent_s', 'average_measurement'],
    rows,
    summaryLines: [
      `Antibiotics with test data: ${rows.length}.`,
      highest ? `Highest resistance rate: ${String(highest.code)} at ${Number(highest.percent_r).toFixed(1)}%.` : 'No susceptibility data matched the filters.'
    ]
  }
}

function groupedAntibiogram(records: IsolateRecord[], antibioticCode: string, group: (record: IsolateRecord) => string): Row[] {
  const buckets = new Map<string, AstCounts>()
  for (const record of records) {
    const result = astResult(record, antibioticCode)
    if (!['R', 'I', 'S'].includes(result)) continue
    const label = group(record) || 'Unknown'
    const bucket = buckets.get(label) ?? { tested: 0, R: 0, I: 0, S: 0, measurements: [] }
    bucket.tested += 1
    bucket[result as 'R' | 'I' | 'S'] += 1
    buckets.set(label, bucket)
  }
  return [...buckets].map(([group_label, item]) => ({
    group: group_label, tests: item.tested, percent_r: percent(item.R, item.tested),
    percent_i: percent(item.I, item.tested), percent_s: percent(item.S, item.tested)
  })).sort((left, right) => Number(right.tests) - Number(left.tests) || String(left.group).localeCompare(String(right.group)))
}

function stewardshipDetail(records: IsolateRecord[]): Pick<AnalysisResult, 'columns' | 'rows' | 'summaryLines'> {
  const patients = new Set(records.map((record) => text(record.patient_id)).filter(Boolean)).size
  const origins = countRows(records.map(infectionOrigin))
  const originCount = (label: string): number => origins.find((item) => item.label === label)?.value ?? 0
  const organisms = countRows(records.map((record) => text(record.organism) || 'Unknown'))
  const indicators = priorityIndicators(records).filter((item) => item.rate !== null).sort((left, right) => Number(right.rate) - Number(left.rate))
  const highest = indicators[0]
  const rows: Row[] = [
    { section: 'Volume', metric: 'Total isolates', value: records.length },
    { section: 'Volume', metric: 'Unique patients', value: patients },
    { section: 'Origin', metric: 'Hospital', value: originCount('Hospital') },
    { section: 'Origin', metric: 'Community', value: originCount('Community') },
    { section: 'Origin', metric: 'Unknown', value: originCount('Unknown') },
    ...organisms.slice(0, 5).map((item) => ({ section: 'Top organism', metric: item.label, value: item.value })),
    ...indicators.slice(0, 5).map((item) => ({ section: 'Priority indicator', metric: item.indicator, value: `${item.rate?.toFixed(1)}% (${item.numerator}/${item.denominator})` }))
  ]
  return {
    columns: ['section', 'metric', 'value'],
    rows,
    summaryLines: [
      'Microbiology signals for stewardship and infection-prevention review; antimicrobial consumption and prescribing data are not included.',
      highest ? `Highest priority AMR signal: ${highest.indicator} at ${highest.rate?.toFixed(1)}%.` : 'No priority-indicator denominator was available.'
    ]
  }
}

function priorityDetail(records: IsolateRecord[]): Pick<AnalysisResult, 'columns' | 'rows' | 'summaryLines'> {
  const indicators = priorityIndicators(records)
  const rows: Row[] = indicators.map((item) => ({ ...item }))
  const ranked = indicators.filter((item) => item.rate !== null).sort((left, right) => Number(right.rate) - Number(left.rate))
  const highest = ranked[0]
  return {
    columns: ['indicator', 'numerator', 'denominator', 'rate', 'tested_with'],
    rows,
    summaryLines: [
      'Priority indicators use saved interpreted AST results and explicit organism/drug denominators.',
      highest ? `Highest rate: ${highest.indicator} at ${highest.rate?.toFixed(1)}%.` : 'No indicator denominator was available.'
    ]
  }
}

function parseAlerts(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
  if (typeof value !== 'string') return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object') : []
  } catch { return [] }
}

function possibleBloodContaminant(record: IsolateRecord): boolean {
  if (!text(record.specimen_type).toLocaleLowerCase().includes('blood')) return false
  const organism = text(record.organism).toLocaleLowerCase()
  if (organism.includes('bacillus anthracis')) return false
  return CONTAMINANT_TOKENS.some((token) => organism.includes(token))
}

function dataQualityDetail(records: IsolateRecord[]): Pick<AnalysisResult, 'columns' | 'rows' | 'summaryLines'> {
  const blood = records.filter((record) => text(record.specimen_type).toLocaleLowerCase().includes('blood'))
  const contaminants = blood.filter(possibleBloodContaminant).length
  const unknownOrigin = records.filter((record) => infectionOrigin(record) === 'Unknown').length
  const qualityAlerts = records.filter((record) => parseAlerts(record.alerts).some((alert) => text(alert.alert_type) === 'data_quality')).length
  const qc = records.filter((record) => text(record.specimen_type).toLocaleLowerCase() === 'quality control').length
  const interpretedCounts = records.map((record) => astEntries(record).filter(([, result]) => ['R', 'I', 'S'].includes(key(result.result))).length)
  const receptionLags: number[] = []
  const testingLags: number[] = []
  for (const record of records) {
    const specimen = parseDate(record.specimen_date)
    const reception = parseDate(record.reception_date)
    const testDate = parseDate(record.dd_test_date)
    if (specimen && reception) receptionLags.push(daysBetween(reception, specimen))
    if (specimen && testDate) testingLags.push(daysBetween(testDate, specimen))
  }
  const rows: Row[] = [
    { metric: 'Rows with data-quality alerts', value: qualityAlerts, guidance: 'Check chronology, mandatory fields, and QC workflows.' },
    { metric: 'Rows with unknown origin', value: unknownOrigin, guidance: 'Complete admission date and inpatient/outpatient context.' },
    { metric: 'Rows with no interpreted AST result', value: interpretedCounts.filter((count) => count === 0).length, guidance: 'Review panel completeness and entry workflows.' },
    { metric: 'Quality control isolates', value: qc, guidance: 'Keep separate from patient-isolate surveillance.' },
    { metric: 'Possible blood-culture contaminant candidates', value: contaminants, guidance: 'Heuristic only; interpret with local collection context.' },
    { metric: 'Median specimen-to-reception delay (days)', value: median(receptionLags), guidance: 'Long delays can reduce time-to-action.' },
    { metric: 'Median specimen-to-test delay (days)', value: median(testingLags), guidance: 'Review turnaround time.' },
    { metric: 'Average interpreted AST results per isolate', value: interpretedCounts.length ? round(interpretedCounts.reduce((sum, count) => sum + count, 0) / interpretedCounts.length) : null, guidance: 'Indicates susceptibility-workup completeness.' }
  ]
  return {
    columns: ['metric', 'value', 'guidance'],
    rows,
    summaryLines: [
      'Data-quality signals are review prompts, not corrected data.',
      blood.length ? `Possible contaminant candidates among blood isolates: ${contaminants}/${blood.length} (${percent(contaminants, blood.length).toFixed(1)}%).` : 'No blood-isolate subset was available.'
    ]
  }
}

function trendDetail(records: IsolateRecord[], antibioticCode: string): Pick<AnalysisResult, 'columns' | 'rows' | 'summaryLines'> {
  if (!antibioticCode) return { columns: ['month', 'tests', 'percent_r', 'percent_i', 'percent_s'], rows: [], summaryLines: ['Select an antibiotic to generate a monthly resistance trend.'] }
  const buckets = new Map<string, AstCounts>()
  for (const record of records) {
    const date = parseDate(record.specimen_date)
    const result = astResult(record, antibioticCode)
    if (!date || !['R', 'I', 'S'].includes(result)) continue
    const month = date.toISOString().slice(0, 7)
    const bucket = buckets.get(month) ?? { tested: 0, R: 0, I: 0, S: 0, measurements: [] }
    bucket.tested += 1
    bucket[result as 'R' | 'I' | 'S'] += 1
    buckets.set(month, bucket)
  }
  const rows: Row[] = [...buckets].sort(([left], [right]) => left.localeCompare(right)).map(([month, item]) => ({
    month, tests: item.tested, percent_r: percent(item.R, item.tested), percent_i: percent(item.I, item.tested), percent_s: percent(item.S, item.tested)
  }))
  return {
    columns: ['month', 'tests', 'percent_r', 'percent_i', 'percent_s'],
    rows,
    summaryLines: rows.length ? [`Monthly resistance trend for ${key(antibioticCode)}; inspect denominators before interpreting change.`] : [`No interpreted ${key(antibioticCode)} results matched the filters.`]
  }
}

function clusterDetail(records: IsolateRecord[], filters: AnalysisFilters): Pick<AnalysisResult, 'columns' | 'rows' | 'clusterFlags' | 'summaryLines' | 'outbreak'> {
  const settings = {
    analysisType: filters.outbreakAnalysisType,
    target: filters.outbreakTarget,
    baselineDays: filters.outbreakBaselineDays,
    maxClusterDays: filters.outbreakMaxClusterDays,
    deduplicationDays: filters.outbreakDeduplicationDays,
    minimumCases: filters.outbreakMinimumCases,
    permutations: filters.outbreakPermutations,
    recurrenceThresholdDays: filters.outbreakRecurrenceThresholdDays
  }
  const outbreak = runOutbreakDetection(records, settings)
  // The detector goes on every row. Once more than one can run, a cluster reported without
  // its method is not interpretable — the same ward and the same fortnight mean different
  // things from a case-only scan and from a proportion scan — and it is not reproducible
  // either. Read from the registry rather than written here, so it cannot drift from what
  // actually produced the signal.
  const detectorId = getDetector(DEFAULT_DETECTOR_ID).descriptor.id
  const flags: Row[] = outbreak.signals.map((signal) => ({ ...signal, detector_id: detectorId }))
  return {
    columns: ['status', 'signal_type', 'organism', 'antibiotic', 'scope', 'location', 'start_date', 'end_date',
      'observed', 'expected', 'observed_expected_ratio', 'p_value', 'recurrence_interval_days', 'detector_id'],
    rows: flags,
    clusterFlags: flags,
    outbreak,
    summaryLines: [
      `WHONET-compatible ${outbreak.analysisType} space-time permutation scan; ${outbreak.settings.permutations} Monte Carlo replications.`,
      `${outbreak.eligibleEvents} eligible event(s); ${outbreak.repeatEventsExcluded} repeat event(s) excluded by ${outbreak.settings.deduplicationDays}-day patient-organism rule.`,
      flags.length ? `${flags.length} multiplicity-adjusted signal(s) have p ≤ 0.05; ${flags.filter((flag) => flag.status === 'alert').length} meet recurrence threshold.` : 'No multiplicity-adjusted signal met p ≤ 0.05.',
      'Statistical signals require infection-prevention review; they are not confirmed outbreaks.'
    ]
  }
}

function summaryDetail(records: IsolateRecord[]): Pick<AnalysisResult, 'columns' | 'rows' | 'summaryLines'> {
  const patients = new Set(records.map((record) => text(record.patient_id)).filter(Boolean)).size
  const organisms = countRows(records.map((record) => text(record.organism) || 'Unknown'))
  const specimens = countRows(records.map((record) => text(record.specimen_type) || 'Unknown'))
  const dates = records.map((record) => parseDate(record.specimen_date)).filter((date): date is Date => Boolean(date)).sort((left, right) => left.getTime() - right.getTime())
  const firstDate = dates[0]
  const lastDate = dates.at(-1)
  const dateRange = firstDate && lastDate ? `${firstDate.toISOString().slice(0, 10)} to ${lastDate.toISOString().slice(0, 10)}` : 'n/a'
  const rows: Row[] = [
    { metric: 'Total isolates', value: records.length }, { metric: 'Unique patients', value: patients },
    { metric: 'Unique organisms', value: organisms.length }, { metric: 'Unique specimen types', value: specimens.length },
    { metric: 'Date range', value: dateRange },
    ...organisms.slice(0, 10).map((item) => ({ metric: `Top organism: ${item.label}`, value: item.value })),
    ...specimens.slice(0, 10).map((item) => ({ metric: `Specimen type: ${item.label}`, value: item.value }))
  ]
  return { columns: ['metric', 'value'], rows, summaryLines: [`${records.length} isolates from ${patients} unique identified patient(s).`, `Date range: ${dateRange}.`] }
}

function isolateListing(records: IsolateRecord[]): Pick<AnalysisResult, 'columns' | 'rows' | 'summaryLines'> {
  const columns = ['id', 'patient_id', 'specimen_date', 'specimen_number', 'specimen_type', 'organism', 'location', 'origin', 'resistant_codes', 'record_status']
  const rows: Row[] = records.map((record) => ({
    id: record.id ?? null,
    patient_id: text(record.patient_id),
    specimen_date: text(record.specimen_date),
    specimen_number: text(record.specimen_number),
    specimen_type: text(record.specimen_type),
    organism: text(record.organism),
    location: text(record.location),
    origin: infectionOrigin(record),
    resistant_codes: astEntries(record).filter(([, result]) => key(result.result) === 'R').map(([code]) => code).slice(0, 3).join(', '),
    record_status: record.record_status ?? 'final'
  }))
  return { columns, rows, summaryLines: [`${rows.length} isolate(s) listed; patient-level fields remain local and are never included in aggregate sync responses.`] }
}

export function runDeterministicAnalysis(
  sourceRecords: IsolateRecord[],
  filters: AnalysisFilters,
  options: { truncated?: boolean } = {}
): AnalysisResult {
  // Outbreak detection performs its own rolling patient-organism/phenotype de-duplication.
  // A once-per-entire-period antibiogram rule would erase later outbreak episodes.
  const cohort = prepareAnalysisCohort(sourceRecords, filters.mode === 'clusterWatch'
    ? { ...filters, deduplicateMode: 'allIsolates' } : filters)
  const records = cohort.records
  const result = commonResult(records, filters, cohort, options.truncated === true)
  const mode = filters.mode ?? 'ris'
  let detail: Pick<AnalysisResult, 'columns' | 'rows' | 'clusterFlags' | 'summaryLines'>
  if (mode === 'ris') detail = risDetail(records)
  else if (mode === 'stewardship') detail = stewardshipDetail(records)
  else if (mode === 'unitAntibiogram') {
    const code = key(filters.antibioticCode)
    const rows = code ? groupedAntibiogram(records, code, (record) => text(record.location) || text(record.department) || (text(record.location_type).toLocaleLowerCase() === 'in' ? 'Inpatient' : text(record.location_type).toLocaleLowerCase() === 'out' ? 'Outpatient' : 'Unknown unit')) : []
    detail = { columns: ['group', 'tests', 'percent_r', 'percent_i', 'percent_s'], rows, summaryLines: [code ? `Unit antibiogram for ${code}; compare tested denominators before rates.` : 'Select an antibiotic to generate a unit antibiogram.'] }
  } else if (mode === 'specimenAntibiogram') {
    const code = key(filters.antibioticCode)
    const rows = code ? groupedAntibiogram(records, code, (record) => text(record.specimen_type) || 'Unknown specimen') : []
    detail = { columns: ['group', 'tests', 'percent_r', 'percent_i', 'percent_s'], rows, summaryLines: [code ? `Specimen antibiogram for ${code}; compare tested denominators before rates.` : 'Select an antibiotic to generate a specimen antibiogram.'] }
  } else if (mode === 'priorityIndicators') detail = priorityDetail(records)
  else if (mode === 'dataQuality') detail = dataQualityDetail(records)
  else if (mode === 'trends') detail = trendDetail(records, key(filters.antibioticCode))
  else if (mode === 'isolateListing') detail = isolateListing(records)
  else if (mode === 'clusterWatch') detail = clusterDetail(records, filters)
  else detail = summaryDetail(records)
  return { ...result, ...detail }
}
