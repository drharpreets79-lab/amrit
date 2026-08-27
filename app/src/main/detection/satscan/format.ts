/**
 * SaTScan's file formats, written and read.
 *
 * This is a bridge, not a reimplementation. AMRIT already implements Kulldorff's space-time
 * permutation statistic; what it has never had is a way to put identical input through
 * SaTScan itself and compare, which is arm 1 of Study B in
 * `paper/AMRIT_paper_phasewise_plan.md`. It also lets a deployment that already trusts
 * SaTScan keep using it and see the results in the same interface.
 *
 * **SaTScan is not bundled.** It is free but its distribution terms do not permit
 * redistribution, so the operator installs it and points AMRIT at it. Nothing in this
 * repository contains SaTScan source or binaries.
 *
 * ## Categorical locations, and why the spatial window is set to nothing
 *
 * SaTScan is built around geography: a cluster is a circle over coordinates. AMRIT scans
 * wards and reporting sites as categorical islands and deliberately infers no adjacency
 * between them — `docs/OUTBREAK_DETECTION.md` says coordinates or validated functional
 * meta-groups would be required before a window could span more than one. To put the same
 * question to SaTScan, each location is written to the coordinates file on a widely spaced
 * grid and the spatial window is set so that no circle can reach a second location. The
 * result is one-location clusters, which is exactly what AMRIT computes. Giving the
 * locations plausible-looking coordinates instead would silently ask SaTScan a different
 * and easier question.
 *
 * ## Verification status
 *
 * Written against SaTScan's published parameter and file documentation. The writers and
 * parsers are covered by tests over fixtures constructed to that documentation, **not**
 * against output from a real SaTScan run, because no SaTScan installation was available on
 * the machine this was written on. `runSatScan` reports the binary's version at run time
 * for exactly this reason, and the first real round-trip should be treated as the check
 * that these formats are right.
 */

import type { OutbreakCaseEvent, OutbreakSettings } from '../../../core/domain/outbreak-detection'
import type { DenominatorRow, PopulationRow } from '../../../core/domain/detection/types'

const text = (value: unknown): string => String(value ?? '').trim()

/**
 * SaTScan location identifiers cannot carry the delimiters the files use.
 *
 * Ward names in real data contain spaces, slashes and commas — "Oncology / haematology" is
 * in this repository's own demonstration network. They are replaced rather than quoted,
 * because SaTScan's readers are whitespace-delimited and do not take quotes, and the
 * mapping back is kept so a parsed cluster can be reported under the name an operator
 * recognises.
 */
export function encodeLocationIds(locations: readonly string[]): Map<string, string> {
  const forward = new Map<string, string>()
  const used = new Set<string>()
  for (const [index, location] of [...locations].sort().entries()) {
    const base = text(location).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'LOC'
    let candidate = base.slice(0, 40)
    if (used.has(candidate)) candidate = `${candidate.slice(0, 34)}_${index}`
    used.add(candidate)
    forward.set(location, candidate)
  }
  return forward
}

export function invert(mapping: Map<string, string>): Map<string, string> {
  return new Map([...mapping].map(([name, id]) => [id, name]))
}

/** `YYYY/M/D`, the form SaTScan writes and reads. */
export function satscanDate(iso: string): string {
  const [year = '', month = '', day = ''] = text(iso).split('-')
  return `${year}/${Number(month)}/${Number(day)}`
}

export interface CaseFileOptions {
  /** Restrict to one signal code, which is how AMRIT scans: one series per phenotype. */
  signalCode?: string
}

/**
 * The case file: location, count, date.
 *
 * One row per location and date. SaTScan sums duplicates, but writing them pre-summed keeps
 * the file small and makes it readable next to AMRIT's own aggregate.
 */
export function writeCaseFile(events: readonly OutbreakCaseEvent[], ids: Map<string, string>, options: CaseFileOptions = {}): string {
  const counts = new Map<string, number>()
  for (const event of events) {
    if (options.signalCode && event.signalCode !== options.signalCode) continue
    const id = ids.get(event.location)
    if (!id) continue
    const key = `${id}\u001f${event.date}`
    counts.set(key, (counts.get(key) ?? 0) + event.count)
  }
  return [...counts]
    .map(([key, count]) => {
      const [id = '', date = ''] = key.split('\u001f')
      return `${id} ${count} ${satscanDate(date)}`
    })
    .sort()
    .join('\n')
}

/**
 * The control file: location, controls, date. Bernoulli only.
 *
 * Controls are the isolates that were tested and were **not** resistant. `I` is counted as
 * a control, not a case, which is the same judgement the rest of this codebase makes:
 * current EUCAST defines it as susceptible with increased exposure.
 */
export function writeControlFile(rows: readonly DenominatorRow[], ids: Map<string, string>, organismCode: string, antibioticCode: string): string {
  const lines: string[] = []
  for (const row of rows) {
    if (row.organism_code !== organismCode || row.antibiotic_code !== antibioticCode) continue
    const id = ids.get(row.location)
    if (!id) continue
    const controls = row.tested - row.resistant
    if (controls <= 0) continue
    lines.push(`${id} ${controls} ${satscanDate(row.date)}`)
  }
  return lines.sort().join('\n')
}

/**
 * The population file: location, date, population at risk. Poisson only.
 *
 * SaTScan reads this as the denominator for the discrete Poisson model and interpolates
 * between the dates it is given. AMRIT writes one row per location per date it holds,
 * because a laboratory's occupancy series is daily where it exists at all and interpolating
 * from sparse rows would put a number in the denominator that nobody measured.
 *
 * The unit never reaches SaTScan and does not need to: the model uses each cell's *share* of
 * the total population, so patient-days and admissions give the same answer as long as they
 * are not mixed. `scanPoisson` warns when they are; this writer cannot, because by here the
 * rows have already been chosen.
 */
export function writePopulationFile(rows: readonly PopulationRow[], ids: Map<string, string>): string {
  const lines: string[] = []
  for (const row of rows) {
    const id = ids.get(row.location)
    if (!id || row.population <= 0) continue
    lines.push(`${id} ${satscanDate(row.date)} ${row.population}`)
  }
  return lines.sort().join('\n')
}

/**
 * The coordinates file, spacing each location far enough apart to be its own island.
 *
 * The grid step is large relative to the spatial window written into the parameter file, so
 * no circle can contain two locations. See the note at the top of this file: the point is
 * to ask SaTScan the question AMRIT answers, not a geographically plausible one.
 */
export const ISLAND_GRID_STEP = 1000
export const ISLAND_MAX_RADIUS = 1

export function writeCoordinatesFile(ids: Map<string, string>): string {
  return [...ids.values()].sort().map((id, index) => {
    const column = index % 100
    const row = Math.floor(index / 100)
    return `${id} ${column * ISLAND_GRID_STEP} ${row * ISLAND_GRID_STEP}`
  }).join('\n')
}

export type SatScanModel = 'space-time-permutation' | 'bernoulli' | 'poisson'

const MODEL_CODE: Readonly<Record<SatScanModel, number>> = Object.freeze({
  // SaTScan ModelType: 0 Discrete Poisson, 1 Bernoulli, 2 Space-Time Permutation.
  'space-time-permutation': 2,
  bernoulli: 1,
  poisson: 0
})

export interface ParameterFileOptions {
  model: SatScanModel
  caseFile: string
  controlFile?: string
  populationFile?: string
  coordinatesFile: string
  resultsFile: string
  studyStart: string
  studyEnd: string
  settings: Pick<OutbreakSettings, 'analysisType' | 'maxClusterDays' | 'minimumCases' | 'permutations'>
}

/**
 * The parameter file, written so it provably encodes the AMRIT settings that produced it.
 *
 * A concordance study whose two arms were configured differently measures the
 * configuration. Every value here comes from the same `OutbreakSettings` object the AMRIT
 * run used, and the header records them in plain text so a reader can check without
 * decoding SaTScan's numeric enumerations.
 */
export function writeParameterFile(options: ParameterFileOptions): string {
  const { settings } = options
  // AnalysisType: 3 retrospective space-time, 4 prospective space-time.
  const analysisType = settings.analysisType === 'prospective' ? 4 : 3
  const lines = [
    ';; Written by AMRIT. Every value below is derived from the AMRIT settings used for the',
    ';; matching run, so the two arms of a concordance study cannot silently differ.',
    `;; analysisType=${settings.analysisType} maxClusterDays=${settings.maxClusterDays} `
      + `minimumCases=${settings.minimumCases} permutations=${settings.permutations}`,
    ';; Locations are categorical islands: the coordinates file spaces them '
      + `${ISLAND_GRID_STEP} apart and the spatial window below is ${ISLAND_MAX_RADIUS}, so no`,
    ';; circle can reach a second location. AMRIT infers no adjacency between wards and this',
    ';; keeps SaTScan from inventing some.',
    '',
    '[Input]',
    `CaseFile=${options.caseFile}`,
    ...(options.controlFile ? [`ControlFile=${options.controlFile}`] : []),
    ...(options.populationFile ? [`PopulationFile=${options.populationFile}`] : []),
    'PrecisionCaseTimes=3',
    `StartDate=${satscanDate(options.studyStart)}`,
    `EndDate=${satscanDate(options.studyEnd)}`,
    `CoordinatesFile=${options.coordinatesFile}`,
    'CoordinatesType=0',
    '',
    '[Analysis]',
    `AnalysisType=${analysisType}`,
    `ModelType=${MODEL_CODE[options.model]}`,
    'ScanAreas=1',
    'TimeAggregationUnits=3',
    'TimeAggregationLength=1',
    '',
    '[Output]',
    `ResultsFile=${options.resultsFile}`,
    'MostLikelyClusterEachCentroidASCII=y',
    'MostLikelyClusterCaseInfoEachCentroidASCII=y',
    'CensusAreasReportedClustersASCII=n',
    '',
    '[Spatial Window]',
    'UseDistanceFromCenterOption=y',
    `MaxSpatialSizeInDistanceFromCenter=${ISLAND_MAX_RADIUS}`,
    'MaxSpatialSizeInPopulationAtRisk=50',
    '',
    '[Temporal Window]',
    'MaximumTemporalClusterSizeType=1',
    `MaximumTemporalClusterSize=${settings.maxClusterDays}`,
    'MinimumTemporalClusterSize=1',
    '',
    '[Inference]',
    `MonteCarloReps=${settings.permutations}`,
    'PValueReportType=0',
    'ReportGumbel=n',
    '',
    '[Cluster Restrictions]',
    'MinimumCasesInHighCluster=' + String(settings.minimumCases),
    '',
    '[Run Options]',
    'NumberParallelProcesses=0',
    'SuppressWarnings=n'
  ]
  return lines.join('\n')
}

export interface SatScanCluster {
  cluster: number
  locationIds: string[]
  /** Location names, resolved back through the id mapping. */
  locations: string[]
  startDate: string
  endDate: string
  observed: number
  expected: number
  observedExpectedRatio: number
  logLikelihoodRatio: number
  pValue: number
  recurrenceIntervalDays: number | null
}

const number = (value: unknown): number => {
  const parsed = Number(text(value).replace(/,/g, ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function isoFromSatscan(value: string): string {
  const parts = text(value).split(/[/-]/)
  if (parts.length !== 3) return text(value)
  const [year = '', month = '', day = ''] = parts
  return `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
}

/**
 * Parse the column output (`.col`), which is delimited and stable.
 *
 * Preferred over the prose results file: SaTScan's ASCII report is laid out for a human and
 * its wording has changed between versions, while the column file is a header row and rows
 * of values. `parseResultsFile` exists as a fallback for a run configured without it.
 */
export function parseColumnFile(content: string, idToName: Map<string, string> = new Map()): SatScanCluster[] {
  const lines = text(content).split(/\r?\n/).filter((line) => line.trim())
  if (lines.length < 2) return []
  const delimiter = (lines[0] as string).includes(',') ? ',' : /\t/
  const header = (lines[0] as string).split(delimiter).map((cell) => text(cell).toUpperCase())
  const index = (...names: string[]): number => {
    for (const name of names) {
      const position = header.indexOf(name)
      if (position >= 0) return position
    }
    return -1
  }
  const columns = {
    cluster: index('CLUSTER'),
    loc: index('LOC_ID', 'LOCATION_ID'),
    start: index('START_DATE'),
    end: index('END_DATE'),
    observed: index('OBSERVED'),
    expected: index('EXPECTED'),
    ode: index('ODE', 'OBSERVED_EXPECTED'),
    llr: index('LLR', 'TEST_STATISTIC'),
    p: index('P_VALUE'),
    recurrence: index('RECURR_INT', 'RECURRENCE_INTERVAL')
  }
  const byCluster = new Map<number, SatScanCluster>()
  for (const line of lines.slice(1)) {
    const cells = line.split(delimiter).map((cell) => text(cell))
    const clusterNumber = columns.cluster >= 0 ? number(cells[columns.cluster]) : byCluster.size + 1
    const locationId = columns.loc >= 0 ? (cells[columns.loc] ?? '') : ''
    const existing = byCluster.get(clusterNumber)
    if (existing) {
      // SaTScan writes one row per location in a multi-location cluster.
      if (locationId && !existing.locationIds.includes(locationId)) {
        existing.locationIds.push(locationId)
        existing.locations.push(idToName.get(locationId) ?? locationId)
      }
      continue
    }
    byCluster.set(clusterNumber, {
      cluster: clusterNumber,
      locationIds: locationId ? [locationId] : [],
      locations: locationId ? [idToName.get(locationId) ?? locationId] : [],
      startDate: columns.start >= 0 ? isoFromSatscan(cells[columns.start] ?? '') : '',
      endDate: columns.end >= 0 ? isoFromSatscan(cells[columns.end] ?? '') : '',
      observed: number(cells[columns.observed]),
      expected: number(cells[columns.expected]),
      observedExpectedRatio: columns.ode >= 0 ? number(cells[columns.ode]) : 0,
      logLikelihoodRatio: number(cells[columns.llr]),
      pValue: number(cells[columns.p]),
      recurrenceIntervalDays: columns.recurrence >= 0 ? number(cells[columns.recurrence]) : null
    })
  }
  return [...byCluster.values()].sort((left, right) => left.cluster - right.cluster)
}

const RESULT_FIELDS: ReadonlyArray<[RegExp, keyof SatScanCluster]> = [
  [/^Location IDs included\.*:\s*(.+)$/i, 'locationIds'],
  [/^Time frame\.*:\s*(.+)$/i, 'startDate'],
  [/^Number of cases\.*:\s*([\d.,]+)/i, 'observed'],
  [/^Expected cases\.*:\s*([\d.,]+)/i, 'expected'],
  [/^Observed \/ expected\.*:\s*([\d.,]+)/i, 'observedExpectedRatio'],
  [/^Test statistic\.*:\s*([\d.,]+)/i, 'logLikelihoodRatio'],
  [/^P-value\.*:\s*([\d.,e-]+)/i, 'pValue'],
  [/^Recurrence interval\.*:\s*([\d.,]+)/i, 'recurrenceIntervalDays']
]

/**
 * Parse the prose results file.
 *
 * A fallback. SaTScan lays this out for a human reader and its wording has moved between
 * versions, so the column file is preferred wherever it exists.
 */
export function parseResultsFile(content: string, idToName: Map<string, string> = new Map()): SatScanCluster[] {
  const clusters: SatScanCluster[] = []
  let current: SatScanCluster | null = null
  for (const raw of text(content).split(/\r?\n/)) {
    const line = raw.trim()
    const heading = /^(\d+)\.\s*(?:Location IDs|Census areas)|^CLUSTER\s+(\d+)/i.exec(line)
    if (heading) {
      if (current) clusters.push(current)
      current = {
        cluster: number(heading[1] ?? heading[2] ?? clusters.length + 1),
        locationIds: [], locations: [], startDate: '', endDate: '',
        observed: 0, expected: 0, observedExpectedRatio: 0,
        logLikelihoodRatio: 0, pValue: 1, recurrenceIntervalDays: null
      }
      // The numbered heading carries the location list on the same line.
      const inline = /:\s*(.+)$/.exec(line)
      if (inline?.[1]) {
        current.locationIds = inline[1].split(/[,\s]+/).map(text).filter(Boolean)
        current.locations = current.locationIds.map((id) => idToName.get(id) ?? id)
      }
      continue
    }
    if (!current) continue
    for (const [pattern, field] of RESULT_FIELDS) {
      const match = pattern.exec(line)
      if (!match?.[1]) continue
      const value = match[1].trim()
      if (field === 'locationIds') {
        current.locationIds = value.split(/[,\s]+/).map(text).filter(Boolean)
        current.locations = current.locationIds.map((id) => idToName.get(id) ?? id)
      } else if (field === 'startDate') {
        const [from = '', to = ''] = value.split(/\s+to\s+/i)
        current.startDate = isoFromSatscan(from)
        current.endDate = isoFromSatscan(to)
      } else {
        ;(current as unknown as Record<string, number>)[field] = number(value)
      }
    }
  }
  if (current) clusters.push(current)
  return clusters
}
