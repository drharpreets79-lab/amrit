/**
 * Kulldorff's multivariate scan statistic, over the agents of one organism.
 *
 * Every scan in this directory so far evaluates one organism–antibiotic stream at a time and
 * then corrects each against the Monte Carlo maximum taken over all of them. For a clonal
 * outbreak that is the wrong shape twice over. A carbapenemase-producing *Klebsiella
 * pneumoniae* clone raises meropenem, imipenem and ertapenem together; each stream holds
 * roughly a third of the evidence, and each is then penalised for the multiplicity of all
 * three. Evidence split, multiplicity inflated — and Phase 32 measured the consequence: one
 * seeded 16-case cluster reported as thirteen signals, with the two that reached alert status
 * naming cephalosporins rather than the carbapenems that defined it.
 *
 * The multivariate scan is the published answer. For a candidate window the test statistic is
 * the *sum* of the individual log-likelihood ratios over the streams that contribute
 * positively, and the p-value comes from the Monte Carlo distribution of that combined
 * maximum. Streams showing nothing contribute nothing rather than diluting; a mechanism
 * expressed across three agents is scored as one finding.
 *
 * ## The null is the whole difficulty, and SaTScan's does not transfer
 *
 * SaTScan's multivariate model permutes each data stream independently, which is right for
 * the setting it was built for: emergency-department visits, over-the-counter sales and
 * absenteeism are separate data sources, and under the null they really are independent.
 *
 * Antimicrobial resistance streams are not separate data sources. They are columns of the
 * same isolate. One *K. pneumoniae* that is resistant to meropenem is resistant to imipenem
 * for the same reason, in the same specimen, on the same day. Permuting the agents
 * independently destroys that, so the simulated maximum carries far less cross-stream
 * agreement than the observed data does, and the observed combined statistic beats it every
 * time.
 *
 * That is not a theoretical concern. Run on a 180-day single-site corpus with **no outbreak
 * seeded at all**, the independent-stream null produced three signals at the p-value floor —
 * a detector that alerts on nothing. The finding is recorded in `docs/OUTBREAK_DETECTION.md`
 * and the setting that reproduces it is kept, because Phase 33 needs the faithful SaTScan
 * arm in the benchmark and because a claim of this kind should be reproducible by whoever
 * doubts it.
 *
 * The default null instead permutes **isolates**. Within an organism, each (day, location)
 * cell keeps its isolate count and the isolates are shuffled between cells carrying their
 * complete susceptibility profile. Co-resistance survives intact, panel differences move
 * with the isolates that have them, and the hypothesis being tested is the one an infection
 * control team means: these isolates were exchangeable across wards and days. It needs
 * patient-level records, which is why this detector asks for them and says so when they are
 * absent.
 *
 * ## What this is not
 *
 * Not Phase 31's phenotype aggregation, and the benchmark must not confuse them. Aggregation
 * *pools cases* into one stream defined by a resistance mechanism, using the catalogue's
 * antibiotic classes. This combines *statistics* from streams that stay separate, and groups
 * by organism because organism is a field on the data rather than an inference from it.
 * Different mechanisms, different failure modes; Phase 33's ablation grid needs both present
 * and distinguishable.
 *
 * Kulldorff M, Mostashari F, Duczmal L, Yih WK, Kleinman K, Platt R. Multivariate scan
 * statistics for disease surveillance. Statistics in Medicine 2007;26:1824-1833.
 * doi:10.1002/sim.2818
 */

import { BERNOULLI_SPACE_TIME_ID, bernoulliLogLikelihoodRatio } from './bernoulli'
import { stableLocation } from './denominators'
import type { AstResult, IsolateRecord } from '../../../shared/types'
import type {
  Detector, DetectorContext, DetectorDescriptor, DetectorRunResult, DetectorSignal
} from './types'

const DAY_MS = 86_400_000

/**
 * How the null is generated.
 *
 * `isolate` shuffles whole isolates between cells, preserving co-resistance. `independent-stream`
 * is SaTScan's, permutes each agent on its own, and is invalid on these data — kept so the
 * benchmark can carry the faithful comparator and so the finding can be reproduced.
 */
export type MultivariateNull = 'isolate' | 'independent-stream'

export interface MultivariateSettings {
  analysisType: 'prospective' | 'retrospective'
  baselineDays: number
  maxClusterDays: number
  /** Minimum resistant isolates summed across the contributing streams. */
  minimumCases: number
  /** Minimum isolates tested, in each contributing stream, over the whole study window. */
  minimumTested: number
  permutations: number
  recurrenceThresholdDays: number
  /** `organism` groups a stream set per organism; `all` treats every stream as one set. */
  grouping: 'organism' | 'all'
  nullModel: MultivariateNull
}

export const DEFAULT_MULTIVARIATE_SETTINGS: MultivariateSettings = Object.freeze({
  analysisType: 'prospective',
  baselineDays: 365,
  maxClusterDays: 60,
  minimumCases: 3,
  minimumTested: 10,
  permutations: 999,
  recurrenceThresholdDays: 365,
  // Organism by default. Combining across organisms would score a busy ICU as a cluster,
  // because every stream in it rises together for a reason that is not transmission of any
  // one thing.
  grouping: 'organism',
  nullModel: 'isolate'
})

export interface MultivariateSignal {
  signal_id: string
  status: 'alert' | 'monitor'
  organism: string
  /** The contributing agents, comma-separated, in descending order of contribution. */
  antibiotic: string
  scope: string
  location: string
  start_date: string
  end_date: string
  days: number
  /** Resistant isolates summed over contributing streams. */
  observed: number
  tested: number
  /** Streams that contributed a positive log-likelihood ratio to this window. */
  streams: number
  stream_codes: string[]
  /** Sum of the contributing streams' log-likelihood ratios. */
  log_likelihood_ratio: number
  p_value: number
  recurrence_interval_days: number
}

export interface MultivariateScanResult {
  method: string
  settings: MultivariateSettings
  studyStart: string | null
  studyEnd: string | null
  groups: number
  streams: number
  locations: number
  isolates: number
  signals: MultivariateSignal[]
  warnings: string[]
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

/**
 * One isolate, reduced to what the scan needs: where it was, and its whole profile.
 *
 * `agents` and `resistant` are parallel: agent index, and 1 when that agent was reported R.
 * They stay together through every permutation, which is the point.
 */
interface Isolate {
  cell: number
  agents: Int32Array
  resistant: Uint8Array
}

/** One organism's isolates, and the agent and location vocabularies they index into. */
interface Group {
  key: string
  organismCode: string
  agentCodes: string[]
  locations: string[]
  isolates: Isolate[]
  /** Cell index → day, and cell index → location index. */
  cellDay: Int32Array
  cellLocation: Int32Array
}

/** Cases and tested per agent, per location, per day, for one assignment of isolates to cells. */
interface Counts {
  cases: Float64Array
  tested: Float64Array
  totalCases: Float64Array
  totalTested: Float64Array
}

function tally(group: Group, assignment: Int32Array, studyDays: number): Counts {
  const agents = group.agentCodes.length
  const locations = group.locations.length
  const size = agents * locations * studyDays
  const counts: Counts = {
    cases: new Float64Array(size),
    tested: new Float64Array(size),
    totalCases: new Float64Array(agents),
    totalTested: new Float64Array(agents)
  }
  for (let index = 0; index < group.isolates.length; index += 1) {
    const isolate = group.isolates[index] as Isolate
    const cell = assignment[index] as number
    const day = group.cellDay[cell] as number
    const location = group.cellLocation[cell] as number
    const base = (location * studyDays + day)
    for (let position = 0; position < isolate.agents.length; position += 1) {
      const agent = isolate.agents[position] as number
      const offset = agent * locations * studyDays + base
      counts.tested[offset] = (counts.tested[offset] as number) + 1
      counts.totalTested[agent] = (counts.totalTested[agent] as number) + 1
      if (isolate.resistant[position] === 1) {
        counts.cases[offset] = (counts.cases[offset] as number) + 1
        counts.totalCases[agent] = (counts.totalCases[agent] as number) + 1
      }
    }
  }
  return counts
}

interface Contribution { code: string; llr: number; cases: number; tested: number }
interface Candidate {
  group: Group
  location: string
  start: number
  end: number
  cases: number
  tested: number
  llr: number
  contributions: Contribution[]
}

function scanGroup(
  group: Group, counts: Counts, studyDays: number, settings: MultivariateSettings, collect: boolean
): { maximum: number; candidates: Candidate[] } {
  const agents = group.agentCodes.length
  const locations = group.locations.length
  const maximumDays = Math.max(1, Math.min(settings.maxClusterDays, Math.max(1, Math.floor(studyDays / 2))))
  const ends = settings.analysisType === 'prospective'
    ? [studyDays - 1]
    : Array.from({ length: studyDays }, (_, index) => index)

  const windowCases = new Float64Array(agents)
  const windowTested = new Float64Array(agents)
  let maximum = 0
  const candidates: Candidate[] = []
  for (let location = 0; location < locations; location += 1) {
    for (const end of ends) {
      windowCases.fill(0)
      windowTested.fill(0)
      for (let length = 1; length <= maximumDays && length <= end + 1; length += 1) {
        const start = end - length + 1
        let combined = 0
        let cases = 0
        let tested = 0
        const contributions: Contribution[] = []
        for (let agent = 0; agent < agents; agent += 1) {
          const offset = agent * locations * studyDays + location * studyDays + start
          windowCases[agent] = (windowCases[agent] as number) + (counts.cases[offset] as number)
          windowTested[agent] = (windowTested[agent] as number) + (counts.tested[offset] as number)
          const totalTested = counts.totalTested[agent] as number
          if (totalTested < settings.minimumTested) continue
          const llr = bernoulliLogLikelihoodRatio(
            windowCases[agent] as number, windowTested[agent] as number,
            counts.totalCases[agent] as number, totalTested
          )
          // A stream showing nothing contributes nothing. That is the point of the
          // multivariate form: it does not average a signal away against silence.
          if (llr <= 0) continue
          combined += llr
          cases += windowCases[agent] as number
          tested += windowTested[agent] as number
          if (collect) {
            contributions.push({
              code: group.agentCodes[agent] as string, llr,
              cases: windowCases[agent] as number, tested: windowTested[agent] as number
            })
          }
        }
        if (combined <= 0 || cases < settings.minimumCases) continue
        if (combined > maximum) maximum = combined
        if (collect) {
          contributions.sort((left, right) => right.llr - left.llr)
          candidates.push({
            group, location: group.locations[location] as string, start, end, cases, tested,
            llr: combined, contributions
          })
        }
      }
    }
  }
  return { maximum, candidates }
}

/** Fisher-Yates over a copy, so the caller's array is not disturbed. */
function shuffled(source: Int32Array, random: () => number): Int32Array {
  const copy = source.slice()
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1))
    const held = copy[index] as number
    copy[index] = copy[swap] as number
    copy[swap] = held
  }
  return copy
}

/**
 * SaTScan's null: each agent permuted on its own, cell tested counts held fixed.
 *
 * Kept because Phase 33 needs the faithful comparator, and because a claim that a published
 * method fails on these data should be reproducible by anyone who doubts it. It is not the
 * default: see the module comment, and the measurement in `docs/OUTBREAK_DETECTION.md`.
 */
function permuteStreams(group: Group, observed: Counts, studyDays: number, random: () => number): Counts {
  const agents = group.agentCodes.length
  const locations = group.locations.length
  const stride = locations * studyDays
  const counts: Counts = {
    cases: new Float64Array(observed.cases.length),
    tested: observed.tested,
    totalCases: observed.totalCases,
    totalTested: observed.totalTested
  }
  for (let agent = 0; agent < agents; agent += 1) {
    let casesLeft = observed.totalCases[agent] as number
    let testedLeft = observed.totalTested[agent] as number
    for (let index = 0; index < stride; index += 1) {
      const offset = agent * stride + index
      const cellTested = observed.tested[offset] as number
      let taken = 0
      for (let draw = 0; draw < cellTested; draw += 1) {
        if (testedLeft <= 0) break
        if (random() < casesLeft / testedLeft) {
          taken += 1
          casesLeft -= 1
        }
        testedLeft -= 1
      }
      counts.cases[offset] = taken
    }
  }
  return counts
}

export interface MultivariateScanOptions {
  /** Patient-level isolates. Required by the default `isolate` null. */
  records: readonly IsolateRecord[]
  settings?: Partial<MultivariateSettings>
  organismNames?: Readonly<Record<string, string>>
  seed?: number
}

function boundSettings(raw: Partial<MultivariateSettings> = {}): MultivariateSettings {
  const clamp = (value: number | undefined, low: number, high: number, fallback: number): number =>
    Math.max(low, Math.min(high, Math.trunc(value ?? fallback)))
  return {
    analysisType: raw.analysisType === 'retrospective' ? 'retrospective' : 'prospective',
    baselineDays: clamp(raw.baselineDays, 30, 3650, DEFAULT_MULTIVARIATE_SETTINGS.baselineDays),
    maxClusterDays: clamp(raw.maxClusterDays, 1, 365, DEFAULT_MULTIVARIATE_SETTINGS.maxClusterDays),
    minimumCases: clamp(raw.minimumCases, 2, 100, DEFAULT_MULTIVARIATE_SETTINGS.minimumCases),
    minimumTested: clamp(raw.minimumTested, 2, 10_000, DEFAULT_MULTIVARIATE_SETTINGS.minimumTested),
    permutations: clamp(raw.permutations, 19, 9999, DEFAULT_MULTIVARIATE_SETTINGS.permutations),
    recurrenceThresholdDays: clamp(raw.recurrenceThresholdDays, 20, 100_000,
      DEFAULT_MULTIVARIATE_SETTINGS.recurrenceThresholdDays),
    grouping: raw.grouping === 'all' ? 'all' : 'organism',
    nullModel: raw.nullModel === 'independent-stream' ? 'independent-stream' : 'isolate'
  }
}

const text = (value: unknown): string => String(value ?? '').trim()
const upper = (value: unknown): string => text(value).toLocaleUpperCase()
const parseDay = (value: string): number => {
  const parsed = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(parsed) ? Math.round(parsed / DAY_MS) : Number.NaN
}
const dayKey = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10)

export function scanMultivariate(options: MultivariateScanOptions): MultivariateScanResult {
  const settings = boundSettings(options.settings)
  const names = options.organismNames ?? {}

  interface Staged { day: number; location: string; organismCode: string; agents: string[]; resistant: number[] }
  const staged: Staged[] = []
  for (const record of options.records) {
    const day = parseDay(text(record.specimen_date))
    if (!Number.isFinite(day)) continue
    const organismCode = upper(record.organism_code) || upper(record.organism)
    if (!organismCode) continue
    const agents: string[] = []
    const resistant: number[] = []
    const results = (record.antibiotic_results ?? {}) as Record<string, AstResult>
    for (const [rawCode, ast] of Object.entries(results)) {
      const interpretation = upper(ast?.result)
      // Same rule as `deriveDenominators`: R, I and S count as tested, and I is not
      // resistant. Two detectors disagreeing about that would make their comparison a
      // comparison of definitions.
      if (interpretation !== 'R' && interpretation !== 'I' && interpretation !== 'S') continue
      agents.push(upper(rawCode))
      resistant.push(interpretation === 'R' ? 1 : 0)
    }
    if (agents.length === 0) continue
    staged.push({ day, location: stableLocation(record), organismCode, agents, resistant })
  }

  const emptyResult = (warning: string): MultivariateScanResult => ({
    method: 'Kulldorff multivariate scan statistic', settings,
    studyStart: null, studyEnd: null, groups: 0, streams: 0, locations: 0, isolates: 0,
    signals: [], warnings: [warning]
  })
  if (staged.length === 0) {
    return emptyResult('No isolates with susceptibility results: there is nothing to combine.')
  }

  let studyEnd = staged[0]!.day
  let dataStart = staged[0]!.day
  for (const item of staged) {
    if (item.day > studyEnd) studyEnd = item.day
    if (item.day < dataStart) dataStart = item.day
  }
  const studyStart = Math.max(dataStart, studyEnd - (settings.baselineDays - 1))
  const studyDays = studyEnd - studyStart + 1
  const bounded = staged.filter((item) => item.day >= studyStart)
  if (bounded.length === 0) return emptyResult('No isolates inside the study window.')

  interface Building {
    key: string
    organismCode: string
    agentIndex: Map<string, number>
    locationIndex: Map<string, number>
    cellIndex: Map<string, number>
    cellDay: number[]
    cellLocation: number[]
    isolates: Isolate[]
    assignment: number[]
  }
  const building = new Map<string, Building>()
  for (const item of bounded) {
    const key = settings.grouping === 'all' ? 'all' : item.organismCode
    const group: Building = building.get(key) ?? {
      key, organismCode: settings.grouping === 'all' ? '' : item.organismCode,
      agentIndex: new Map(), locationIndex: new Map(), cellIndex: new Map(),
      cellDay: [], cellLocation: [], isolates: [], assignment: []
    }
    const day = item.day - studyStart
    let location = group.locationIndex.get(item.location)
    if (location === undefined) {
      location = group.locationIndex.size
      group.locationIndex.set(item.location, location)
    }
    const cellKey = `${location}:${day}`
    let cell = group.cellIndex.get(cellKey)
    if (cell === undefined) {
      cell = group.cellDay.length
      group.cellIndex.set(cellKey, cell)
      group.cellDay.push(day)
      group.cellLocation.push(location)
    }
    const agents = new Int32Array(item.agents.length)
    const resistant = new Uint8Array(item.agents.length)
    for (let index = 0; index < item.agents.length; index += 1) {
      const code = item.agents[index] as string
      let agent = group.agentIndex.get(code)
      if (agent === undefined) {
        agent = group.agentIndex.size
        group.agentIndex.set(code, agent)
      }
      agents[index] = agent
      resistant[index] = (item.resistant[index] as number) === 1 ? 1 : 0
    }
    group.isolates.push({ cell, agents, resistant })
    group.assignment.push(cell)
    building.set(key, group)
  }

  const groups: Group[] = []
  const assignments = new Map<Group, Int32Array>()
  for (const draft of building.values()) {
    const group: Group = {
      key: draft.key,
      organismCode: draft.organismCode,
      agentCodes: [...draft.agentIndex.keys()],
      locations: [...draft.locationIndex.keys()],
      isolates: draft.isolates,
      cellDay: Int32Array.from(draft.cellDay),
      cellLocation: Int32Array.from(draft.cellLocation)
    }
    groups.push(group)
    assignments.set(group, Int32Array.from(draft.assignment))
  }

  const seedMaterial = JSON.stringify({
    settings, studyDays,
    groups: groups.map((group) => [group.key, group.isolates.length, group.agentCodes.length, group.locations.length])
  })
  const random = randomGenerator(options.seed ?? fnv1a(seedMaterial))

  const observedCounts = new Map<Group, Counts>()
  const observed: Candidate[] = []
  for (const group of groups) {
    const counts = tally(group, assignments.get(group) as Int32Array, studyDays)
    observedCounts.set(group, counts)
    observed.push(...scanGroup(group, counts, studyDays, settings, true).candidates)
  }
  observed.sort((left, right) => right.llr - left.llr || right.cases - left.cases)

  const simulatedMaxima: number[] = []
  for (let simulation = 0; simulation < settings.permutations; simulation += 1) {
    let maximum = 0
    for (const group of groups) {
      const counts = settings.nullModel === 'independent-stream'
        ? permuteStreams(group, observedCounts.get(group) as Counts, studyDays, random)
        // Shuffling the assignment moves whole isolates between cells while every cell keeps
        // its isolate count. The profile travels with the isolate, so co-resistance is
        // preserved and the null is "these isolates were exchangeable across wards and days".
        : tally(group, shuffled(assignments.get(group) as Int32Array, random), studyDays)
      const result = scanGroup(group, counts, studyDays, settings, false)
      if (result.maximum > maximum) maximum = result.maximum
    }
    simulatedMaxima.push(maximum)
  }

  const selected: Candidate[] = []
  for (const candidate of observed) {
    const overlaps = selected.some((current) =>
      current.group === candidate.group && current.location === candidate.location
      && candidate.start <= current.end && candidate.end >= current.start)
    if (!overlaps) selected.push(candidate)
  }

  const signals = selected.map((candidate): MultivariateSignal => {
    const exceedances = simulatedMaxima.filter((value) => value >= candidate.llr - 1e-12).length
    const pValue = (exceedances + 1) / (settings.permutations + 1)
    const recurrence = 1 / pValue
    return {
      signal_id: fnv1a([candidate.group.key, candidate.location, candidate.start, candidate.end]
        .join('|')).toString(16).padStart(8, '0'),
      status: recurrence >= settings.recurrenceThresholdDays ? 'alert' : 'monitor',
      organism: candidate.group.organismCode
        ? names[candidate.group.organismCode] ?? candidate.group.organismCode
        : 'All organisms',
      antibiotic: candidate.contributions.map((contribution) => contribution.code).join(', '),
      scope: 'Multivariate location cluster',
      location: candidate.location,
      start_date: dayKey(studyStart + candidate.start),
      end_date: dayKey(studyStart + candidate.end),
      days: candidate.end - candidate.start + 1,
      observed: candidate.cases,
      tested: candidate.tested,
      streams: candidate.contributions.length,
      stream_codes: candidate.contributions.map((contribution) => contribution.code),
      log_likelihood_ratio: round(candidate.llr, 3),
      p_value: round(pValue),
      recurrence_interval_days: round(recurrence, 1)
    }
  }).filter((signal) => signal.p_value <= 0.05).slice(0, 50)

  const warnings: string[] = []
  if (studyDays < 60) warnings.push('Fewer than 60 study days: the baseline proportion may be unstable.')
  if (settings.permutations < 999) {
    warnings.push('Fewer than 999 Monte Carlo replications: the highest reachable recurrence interval is '
      + `${settings.permutations + 1} days, so no alert can fire above that threshold.`)
  }
  if (settings.nullModel === 'independent-stream') {
    warnings.push('The independent-stream null is SaTScan\'s and does not hold for antimicrobial '
      + 'resistance: the agents of one organism are columns of the same isolate, so permuting them '
      + 'separately produces a null with less cross-stream agreement than the data. On a seeded '
      + 'corpus with no outbreak this setting alerted at the p-value floor. Use it only to reproduce '
      + 'that comparison, never to run surveillance.')
  }

  return {
    method: 'Kulldorff multivariate scan statistic',
    settings,
    studyStart: dayKey(studyStart),
    studyEnd: dayKey(studyEnd),
    groups: groups.length,
    streams: groups.reduce((sum, group) => sum + group.agentCodes.length, 0),
    locations: new Set(bounded.map((item) => item.location)).size,
    isolates: bounded.length,
    signals,
    warnings
  }
}

// ---------------------------------------------------------------------------------
// Registration

export const MULTIVARIATE_ID = 'multivariate-bernoulli'

export const multivariateDescriptor: DetectorDescriptor = Object.freeze({
  id: MULTIVARIATE_ID,
  name: 'Multivariate proportion scan',
  method: 'Kulldorff multivariate scan statistic over Bernoulli streams, isolate-permutation null',
  family: 'scan',
  // Denominators are needed and come from the records themselves, because the null has to
  // move whole isolates and an aggregate row cannot say which isolate a resistance came from.
  requires: Object.freeze({ denominators: true, coordinates: false, multipleLocations: false }),
  supports: Object.freeze({ prospective: true, retrospective: true }),
  blindSpot: 'Combines the agents of one organism, so an outbreak of a single-agent phenotype gains '
    + 'nothing here and pays the multiplicity of every other agent in the panel. It also inherits '
    + 'the Bernoulli blind spot: it sees the resistant share, not the count.',
  citation: 'Kulldorff M, Mostashari F, Duczmal L, Yih WK, Kleinman K, Platt R. Multivariate scan '
    + 'statistics for disease surveillance. Statistics in Medicine 2007;26:1824-1833. doi:10.1002/sim.2818'
})

export const multivariateDetector: Detector = {
  descriptor: multivariateDescriptor,

  defaultSettings(): Record<string, unknown> {
    return { ...DEFAULT_MULTIVARIATE_SETTINGS }
  },

  unavailableReason(context: DetectorContext): string | null {
    if (!context.records?.length) {
      // Not a convenience. The null shuffles whole isolates so that co-resistance survives,
      // and an aggregate row cannot say which isolate a resistance belonged to. Running this
      // on aggregates means SaTScan's independent-stream null, which alerts on a corpus with
      // no outbreak in it.
      return 'No patient-level records. This model permutes whole isolates so that co-resistance '
        + 'survives into the null, which pre-aggregated counts cannot support. The portal holds '
        + `aggregates only; run it at the laboratory node, or use ${BERNOULLI_SPACE_TIME_ID}.`
    }
    const pairs = new Set<string>()
    for (const record of context.records) {
      const organism = upper(record.organism_code) || upper(record.organism)
      if (!organism) continue
      for (const [code, ast] of Object.entries((record.antibiotic_results ?? {}) as Record<string, AstResult>)) {
        if (['R', 'I', 'S'].includes(upper(ast?.result))) pairs.add(`${organism}:${upper(code)}`)
      }
    }
    if (pairs.size < 2) {
      return 'Only one organism-antibiotic stream: there is nothing to combine, so the univariate '
        + `${BERNOULLI_SPACE_TIME_ID} scan answers the same question without the extra multiplicity.`
    }
    return null
  },

  run(context: DetectorContext): DetectorRunResult {
    const result = scanMultivariate({
      records: context.records ?? [],
      settings: (context.settings ?? {}) as Partial<MultivariateSettings>,
      ...(context.seed === undefined ? {} : { seed: context.seed })
    })
    const signals: DetectorSignal[] = result.signals.map((signal) => ({
      signal_id: signal.signal_id,
      status: signal.status,
      signal_type: 'Resistance phenotype',
      organism: signal.organism,
      antibiotic: signal.antibiotic,
      scope: 'Location cluster',
      location: signal.location,
      start_date: signal.start_date,
      end_date: signal.end_date,
      days: signal.days,
      observed: signal.observed,
      // A multivariate window has no single expected count: each contributing stream has its
      // own, against its own denominator. Reporting one would be inventing a number, so the
      // shared fields carry the combined observed count and the detail sits in `stream_codes`.
      expected: 0,
      excess: 0,
      observed_expected_ratio: 0,
      log_likelihood_ratio: signal.log_likelihood_ratio,
      p_value: signal.p_value,
      recurrence_interval_days: signal.recurrence_interval_days,
      detector_id: MULTIVARIATE_ID,
      tested: signal.tested,
      streams: signal.streams,
      stream_codes: [...signal.stream_codes]
    }))
    return {
      descriptor: multivariateDescriptor,
      settings: { ...result.settings },
      signals,
      warnings: [...result.warnings],
      diagnostics: {
        method: result.method,
        analysis_type: result.settings.analysisType,
        null_model: result.settings.nullModel,
        study_start: result.studyStart,
        study_end: result.studyEnd,
        groups: result.groups,
        streams: result.streams,
        locations: result.locations,
        isolates: result.isolates,
        grouping: result.settings.grouping,
        maximum_reachable_recurrence_interval: result.settings.permutations + 1
      }
    }
  }
}
