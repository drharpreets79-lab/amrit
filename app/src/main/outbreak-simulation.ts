/**
 * Synthetic outbreaks of known truth, for measuring what a detector actually finds.
 *
 * Until this existed, `demo-population.ts` produced a good background and nothing to
 * detect: the demonstration network's outbreak page was empty and every detector in the
 * repository had been tested only against hand-written fixtures. A benchmark needs a
 * corpus where the answer is known before the run.
 *
 * ## Why this models transmission rather than inflating a count
 *
 * Adding twenty cases to a ward on one day produces a signal every method finds, and
 * measures nothing except that the arithmetic works. A real outbreak is an index case, a
 * ward, onward acquisition at some rate, a lag between acquiring an organism and a
 * specimen reaching the laboratory, and an end. The lag is the part that matters most:
 * detection delay — the quantity an infection-prevention team actually experiences, and
 * the one the WHONET–SaTScan literature does not report — is only meaningful if the
 * observed epidemic curve is the acquisition curve convolved with a realistic delay.
 *
 * ## The five outbreak types, and why each one is here
 *
 * They are chosen to *discriminate between detectors*, not to flatter one:
 *
 * | Type | What it is | Which method should find it |
 * |---|---|---|
 * | `clonal-multidrug` | One clone in one ward, resistant across a whole mechanism class | Everything, but phenotype-aggregating methods should find it soonest — the evidence is split across three agents for a per-agent scan |
 * | `single-agent` | Transmission expressed on exactly one antimicrobial | Per-agent and aggregating methods equally; included deliberately, because aggregation buys nothing here and must be shown not to cost anything either |
 * | `proportion-shift` | Susceptible isolates thin out while resistant cases continue: the resistant **count** is unchanged, the denominator falls, the proportion rises | Denominator-aware methods only. A case-only scan counts resistant cases, and that number did not move |
 * | `system-wide-rise` | A uniform rise across every ward at once | Nothing that conditions on both margins. This is the documented blind spot of the current detector, made measurable instead of asserted |
 * | `pseudo-outbreak` | More specimens tested, resistance unchanged — a practice change, not transmission | Every count-based method **should** flag it. That is the specificity limit, not a defect, and the write-up says so |
 *
 * ## Ground truth
 *
 * The generator writes down what it did — every contributing specimen number, the
 * acquisition date, the first and last specimen dates — rather than anything being
 * inferred afterwards. Seeded cases are otherwise indistinguishable from background
 * cases: same generator, same organism and specimen tables, same record shape, same
 * validation path. Nothing marks a record as seeded except the truth file.
 */

import {
  CLASS_OF,
  DEMO_NETWORK_COUNTRY,
  DEMO_SITES,
  NETWORK_CALIBRATION,
  ORGANISMS,
  SPECIMENS,
  WARDS,
  adjustedRate,
  micFor,
  pick,
  pickWeighted,
  sequence,
  type DemoSite,
  type Organism,
  type Ward
} from './demo-population'
import type { IsolateRecord } from '../shared/types'

const DAY_MS = 86_400_000

export type OutbreakType =
  | 'clonal-multidrug'
  | 'single-agent'
  | 'proportion-shift'
  | 'system-wide-rise'
  | 'pseudo-outbreak'

/** Types that add cases. The rest convert cases the background already produced. */
const ADDITIVE_TYPES: ReadonlySet<OutbreakType> = new Set<OutbreakType>([
  'clonal-multidrug',
  'single-agent',
  'pseudo-outbreak'
])

export type BackgroundRate = 'low' | 'medium' | 'high'

/** Isolates per site per day. `medium` reproduces the shipped demonstration network. */
const BACKGROUND_PER_DAY: Readonly<Record<BackgroundRate, number>> = Object.freeze({
  low: 4,
  medium: 14,
  high: 40
})

export interface OutbreakSpec {
  /** Stable identifier. Derived from the specification when omitted. */
  id?: string
  type: OutbreakType
  siteCode: string
  /** Ward name, as it appears in `WARDS`. Ignored by `system-wide-rise`, which spans all. */
  ward: string
  organismCode: string
  /**
   * Mechanism class whose agents all go resistant together — `carbapenem`,
   * `cephalosporin`, `fluoroquinolone`, `glycopeptide`. Ignored when `agents` is given.
   */
  phenotypeClass?: string
  /** Explicit agents. A `single-agent` outbreak passes exactly one. */
  agents?: readonly string[]
  excessCases: number
  durationDays: number
  /**
   * Days before the end of the study window at which the first acquisition happens.
   *
   * Framed this way because prospective detection only looks at clusters ending at the
   * data cut: an outbreak that finished six months ago is a retrospective question.
   */
  startDaysBeforeEnd: number
}

export interface SeededOutbreak {
  outbreak_id: string
  type: OutbreakType
  site_code: string
  /** `All wards` for `system-wide-rise`. */
  ward: string
  organism_code: string
  organism: string
  phenotype_class: string
  agents: string[]
  /** Null for the conversion types, which have no acquisition process. */
  first_acquisition_date: string | null
  first_specimen_date: string | null
  last_specimen_date: string | null
  duration_days: number
  intended_excess_cases: number
  /** What the generator actually produced. Below the intent when the window ran out. */
  observed_cases: number
  case_specimen_numbers: string[]
  case_patient_ids: string[]
}

export interface SimulationGroundTruth {
  schema_version: 1
  generator_version: string
  seed: number
  window_days: number
  study_start: string
  study_end: string
  background_rate: BackgroundRate
  sites: string[]
  background_records: number
  total_records: number
  outbreaks: SeededOutbreak[]
}

export interface SimulationOptions {
  seed?: number
  /** Length of the study window in days. */
  windowDays?: number
  backgroundRate?: BackgroundRate
  /** Last specimen date, `YYYY-MM-DD`. Pin it for a reproducible corpus. */
  endDate?: string
  outbreaks?: readonly OutbreakSpec[]
  sites?: readonly DemoSite[]
}

export interface SimulationResult {
  records: IsolateRecord[]
  truth: SimulationGroundTruth
}

export const GENERATOR_VERSION = '1.0.0'

const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10)
const parseDay = (value: string): number => Date.UTC(
  Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10))
)

function organismFor(code: string): Organism {
  const organism = ORGANISMS.find((item) => item.code === code)
  if (!organism) throw new Error(`No demonstration organism '${code}'. Known: ${ORGANISMS.map((o) => o.code).join(', ')}`)
  return organism
}

function wardFor(name: string): Ward {
  const ward = WARDS.find((item) => item.name === name)
  if (!ward) throw new Error(`No demonstration ward '${name}'. Known: ${WARDS.map((w) => w.name).join(', ')}`)
  return ward
}

function siteFor(sites: readonly DemoSite[], code: string): DemoSite {
  const site = sites.find((item) => item.code === code)
  if (!site) throw new Error(`No demonstration site '${code}'. Known: ${sites.map((s) => s.code).join(', ')}`)
  return site
}

/**
 * The agents a mechanism expresses across, restricted to what this organism reports.
 *
 * A carbapenemase-producing Klebsiella is resistant to meropenem, imipenem and ertapenem
 * together. Moving one of the three would be a phenotype no laboratory has reported, and
 * would also hand a per-agent scan an easier problem than reality poses.
 */
export function agentsForPhenotype(organism: Organism, phenotypeClass: string): string[] {
  return organism.panel.filter((code) => CLASS_OF[code] === phenotypeClass)
}

/** Specimens that plausibly grow this organism, weighted as the background weights them. */
function specimenWeightsFor(organismCode: string): Record<string, number> {
  const weights: Record<string, number> = {}
  for (const specimen of SPECIMENS) {
    const weight = specimen.organisms[organismCode]
    if (weight) weights[specimen.code] = weight * specimen.share
  }
  if (!Object.keys(weights).length) weights[SPECIMENS[0]?.code ?? 'URINE'] = 1
  return weights
}

/** Knuth's Poisson sampler on our own stream, so a corpus is reproducible from its seed. */
function poisson(mean: number, random: () => number): number {
  if (mean <= 0) return 0
  const limit = Math.exp(-mean)
  let count = 0
  let product = random()
  while (product > limit && count < 1000) {
    count += 1
    product *= random()
  }
  return count
}

/**
 * Days from acquiring an organism to the specimen that finds it.
 *
 * Geometric with a mean near three days and a hard cap. Without this the observed cluster
 * begins on the day transmission begins, and every measured detection delay is an artefact
 * of the generator rather than a property of the detector.
 */
function detectionLag(random: () => number): number {
  const probability = 1 / 3
  const draw = Math.floor(Math.log(1 - random() * 0.999) / Math.log(1 - probability))
  return 1 + Math.min(13, Math.max(0, draw))
}

/**
 * Acquisition day offsets for one transmission chain.
 *
 * An index case on day zero, then exponential growth at the rate that reaches the intended
 * size by the end of the window. Poisson noise around it, and a hard stop at the intended
 * total so the factorial cell means what it says.
 */
export function acquisitionOffsets(
  excessCases: number,
  durationDays: number,
  random: () => number
): number[] {
  const total = Math.max(1, Math.trunc(excessCases))
  const days = Math.max(1, Math.trunc(durationDays))
  if (total === 1 || days === 1) return Array.from({ length: total }, () => 0)
  const offsets = [0]
  const growth = Math.log(total) / days
  const perColonised = Math.exp(growth) - 1
  for (let day = 1; day < days && offsets.length < total; day += 1) {
    const drawn = poisson(offsets.length * perColonised, random)
    for (let index = 0; index < drawn && offsets.length < total; index += 1) offsets.push(day)
  }
  // Growth that undershot leaves the tail unfilled; spread the remainder over the last
  // third rather than stacking it on the final day, which would be a spike, not a curve.
  let cursor = 0
  while (offsets.length < total) {
    offsets.push(Math.max(1, days - 1 - (cursor % Math.max(1, Math.ceil(days / 3)))))
    cursor += 1
  }
  return offsets.sort((left, right) => left - right)
}

interface RecordSeed {
  site: DemoSite
  ward: Ward
  organism: Organism
  specimenCode: string
  specimenName: string
  dayMs: number
  serial: number
  /** Agents forced to `R`, whatever the background rate would have given. */
  forcedResistant?: readonly string[]
  /** Extra odds ratio applied to every other agent: a clone drags its whole panel. */
  coResistancePressure?: number
  patientId?: string
}

function buildRecord(seed: RecordSeed, random: () => number): IsolateRecord {
  const { site, ward, organism } = seed
  const forced = new Set(seed.forcedResistant ?? [])
  const results: Record<string, { result: string; measurement: string; method: string; guideline: string }> = {}
  const classRolls: Record<string, number> = {}
  for (const code of organism.panel) {
    if ((code === 'NIT' || code === 'FOS') && seed.specimenCode !== 'URINE') continue
    let interpretation: string
    if (forced.has(code)) {
      interpretation = 'R'
    } else {
      const baseRate = organism.base[code] ?? 0.2
      const rate = adjustedRate(
        baseRate, site.pressure, ward.pressure, NETWORK_CALIBRATION, seed.coResistancePressure ?? 1
      )
      const className = CLASS_OF[code]
      const roll = className
        ? (classRolls[className] ??= random()) * 0.75 + random() * 0.25
        : random()
      interpretation = roll < rate ? 'R' : roll < rate + 0.07 ? 'I' : 'S'
    }
    results[code] = {
      result: interpretation,
      measurement: micFor(interpretation, random),
      method: 'MIC',
      guideline: 'CLSI'
    }
  }
  const female = random() < 0.47
  return {
    lab_code: site.code,
    // Every case is a different patient. If they were not, the rolling
    // patient-organism de-duplication in `buildOutbreakCaseEvents` would collapse the
    // whole outbreak into a single event and the cluster would vanish before any
    // detector saw it.
    patient_id: seed.patientId ?? `${site.code}-P${String(600_000 + seed.serial)}`,
    specimen_number: `${site.code}-S${String(seed.serial).padStart(7, '0')}`,
    specimen_date: dayKey(seed.dayMs),
    specimen_type: seed.specimenName,
    specimen_code: seed.specimenCode,
    organism: organism.name,
    organism_code: organism.code,
    sex: female ? 'f' : 'm',
    age_years: ward.name === 'Neonatal ICU'
      ? 0
      : ward.name === 'Paediatrics' ? Math.floor(random() * 14) : 16 + Math.floor(random() * 74),
    location: ward.name,
    location_type: ward.type,
    record_status: 'final',
    antibiotic_results: results as IsolateRecord['antibiotic_results'],
    patient_residence: {
      country_code: DEMO_NETWORK_COUNTRY.code,
      admin_codes: [{ level: 1, code: site.stateCode }]
    }
  } as IsolateRecord
}

function specimenName(code: string): string {
  return SPECIMENS.find((item) => item.code === code)?.name ?? code
}

export function simulate(options: SimulationOptions = {}): SimulationResult {
  const seed = options.seed ?? 20260814
  const windowDays = Math.max(30, Math.trunc(options.windowDays ?? 730))
  const backgroundRate = options.backgroundRate ?? 'medium'
  const sites = options.sites ?? DEMO_SITES
  const endMs = parseDay(options.endDate ?? dayKey(Date.now()))
  const startMs = endMs - (windowDays - 1) * DAY_MS
  const random = sequence(seed)
  const records: IsolateRecord[] = []
  let serial = 0

  // ---- background ---------------------------------------------------------------
  const perDay = BACKGROUND_PER_DAY[backgroundRate]
  for (const site of sites) {
    for (let day = 0; day < windowDays; day += 1) {
      const dayMs = startMs + day * DAY_MS
      const month = new Date(dayMs).getUTCMonth()
      const monsoon = month >= 5 && month <= 8
      const count = poisson(perDay, random)
      for (let index = 0; index < count; index += 1) {
        const seasonal = SPECIMENS.map((item) => ({
          ...item,
          share: item.code === 'ENTERIC_STOOL' || item.code === 'URINE'
            ? item.share * (monsoon ? 1.35 : 0.92)
            : item.share
        }))
        const specimen = pick(seasonal, random())
        const organismCode = pickWeighted(specimen.organisms, random())
        const organism = ORGANISMS.find((item) => item.code === organismCode)
        if (!organism) continue
        const ward = pick(WARDS, random())
        // One isolate in six carries a multi-drug-resistant strain, as in the
        // demonstration network. Without this the background has no MDR tail and every
        // seeded outbreak stands out for the wrong reason.
        const coResistancePressure = random() < 0.17 ? 2.2 + random() * 1.4 : 0.55 + random() * 0.35
        serial += 1
        records.push(buildRecord({
          site, ward, organism, specimenCode: specimen.code, specimenName: specimen.name,
          dayMs, serial, coResistancePressure
        }, random))
      }
    }
  }
  const backgroundRecords = records.length

  // ---- outbreaks ----------------------------------------------------------------
  const outbreaks: SeededOutbreak[] = []
  for (const [specIndex, spec] of (options.outbreaks ?? []).entries()) {
    const organism = organismFor(spec.organismCode)
    const site = siteFor(sites, spec.siteCode)
    const phenotypeClass = spec.phenotypeClass ?? (spec.agents?.length ? 'explicit' : 'carbapenem')
    const agents = (spec.agents?.length ? [...spec.agents] : agentsForPhenotype(organism, phenotypeClass))
      .filter((code) => organism.panel.includes(code))
    if (!agents.length) {
      throw new Error(
        `Outbreak ${spec.id ?? specIndex} asks for ${phenotypeClass} in ${organism.code}, `
        + `which reports none of that class. Panel: ${organism.panel.join(', ')}`
      )
    }
    const outbreakId = spec.id ?? `OB-${String(specIndex + 1).padStart(3, '0')}-${spec.type}`
    const firstAcquisitionMs = endMs - spec.startDaysBeforeEnd * DAY_MS
    const specimenNumbers: string[] = []
    const patientIds: string[] = []
    let firstSpecimenMs: number | null = null
    let lastSpecimenMs: number | null = null

    if (ADDITIVE_TYPES.has(spec.type)) {
      const ward = wardFor(spec.ward)
      const specimenWeights = specimenWeightsFor(organism.code)
      // A pseudo-outbreak is a testing change: more specimens of the same organism at the
      // ward's normal resistance. Nothing is forced resistant, and nothing was transmitted.
      const pseudo = spec.type === 'pseudo-outbreak'
      const offsets = acquisitionOffsets(spec.excessCases, spec.durationDays, random)
      for (const offset of offsets) {
        const acquiredMs = firstAcquisitionMs + offset * DAY_MS
        const specimenMs = pseudo ? acquiredMs : acquiredMs + detectionLag(random) * DAY_MS
        // A case whose specimen falls past the data cut has not been observed yet. That is
        // what a still-running outbreak looks like, and dropping it is the honest choice.
        if (specimenMs > endMs || specimenMs < startMs) continue
        const specimenCode = pickWeighted(specimenWeights, random())
        serial += 1
        const patientId = `${site.code}-OB${outbreakId.slice(-3)}-P${String(serial)}`
        records.push(buildRecord({
          site, ward, organism,
          specimenCode, specimenName: specimenName(specimenCode),
          dayMs: specimenMs, serial, patientId,
          ...(pseudo ? {} : { forcedResistant: agents, coResistancePressure: 3.4 })
        }, random))
        const record = records[records.length - 1] as IsolateRecord
        specimenNumbers.push(String(record.specimen_number))
        patientIds.push(patientId)
        firstSpecimenMs = firstSpecimenMs === null ? specimenMs : Math.min(firstSpecimenMs, specimenMs)
        lastSpecimenMs = lastSpecimenMs === null ? specimenMs : Math.max(lastSpecimenMs, specimenMs)
      }
    } else {
      const windowStart = firstAcquisitionMs
      const windowEnd = firstAcquisitionMs + (spec.durationDays - 1) * DAY_MS
      const wardScope = spec.type === 'system-wide-rise' ? null : spec.ward
      const inWindow = (record: IsolateRecord): boolean => {
        if (record.lab_code !== site.code || record.organism_code !== organism.code) return false
        if (wardScope !== null && record.location !== wardScope) return false
        const ms = parseDay(String(record.specimen_date))
        return ms >= windowStart && ms <= windowEnd
      }
      const phenotypeResistant = (record: IsolateRecord): boolean => agents.every((code) => {
        const ast = (record.antibiotic_results as Record<string, { result?: string }> | undefined)?.[code]
        return !ast || ast.result === 'R'
      })

      if (spec.type === 'proportion-shift') {
        // The one signal a case-only method cannot see, constructed so that it is exactly
        // that and nothing else.
        //
        // The first attempt converted susceptible isolates to resistant and left the total
        // alone. That raises the resistant *count*, and the resistant count is precisely
        // what the case-only scan counts — so it was detected, and the arm was measuring
        // nothing it claimed to. Here the resistant cases continue at their existing rate
        // and the susceptible ones thin out: fewer routine specimens reach the laboratory
        // from that ward, which is an ordinary thing to happen. The resistant count is
        // unchanged, so a case-only scan sees no cluster at all; the denominator falls, so
        // the resistant proportion rises and a Bernoulli scan does see it.
        const removable = records.filter((record) => inWindow(record) && !phenotypeResistant(record))
        const doomed = new Set(removable.slice(0, Math.max(0, Math.trunc(spec.excessCases)))
          .map((record) => String(record.specimen_number)))
        for (const record of removable) {
          if (!doomed.has(String(record.specimen_number))) continue
          const ms = parseDay(String(record.specimen_date))
          specimenNumbers.push(String(record.specimen_number))
          patientIds.push(String(record.patient_id))
          firstSpecimenMs = firstSpecimenMs === null ? ms : Math.min(firstSpecimenMs, ms)
          lastSpecimenMs = lastSpecimenMs === null ? ms : Math.max(lastSpecimenMs, ms)
        }
        for (let index = records.length - 1; index >= 0; index -= 1) {
          const record = records[index] as IsolateRecord
          if (doomed.has(String(record.specimen_number))) records.splice(index, 1)
        }
      } else {
        // A uniform rise in every ward at once. The space-time permutation conditions on
        // the location margin, so a rise that is the same everywhere leaves no
        // location-by-time interaction for it to find. This is the blind spot
        // `docs/OUTBREAK_DETECTION.md` records; seeding it makes it measurable.
        const eligible = records.filter((record) => inWindow(record) && !phenotypeResistant(record))
        for (const record of eligible.slice(0, Math.max(0, Math.trunc(spec.excessCases)))) {
          const ast = record.antibiotic_results as Record<string, { result: string; measurement: string }>
          for (const code of agents) {
            if (!ast[code]) continue
            ast[code] = { ...ast[code], result: 'R', measurement: micFor('R', random) } as never
          }
          const ms = parseDay(String(record.specimen_date))
          specimenNumbers.push(String(record.specimen_number))
          patientIds.push(String(record.patient_id))
          firstSpecimenMs = firstSpecimenMs === null ? ms : Math.min(firstSpecimenMs, ms)
          lastSpecimenMs = lastSpecimenMs === null ? ms : Math.max(lastSpecimenMs, ms)
        }
      }
    }

    outbreaks.push({
      outbreak_id: outbreakId,
      type: spec.type,
      site_code: site.code,
      ward: spec.type === 'system-wide-rise' ? 'All wards' : spec.ward,
      organism_code: organism.code,
      organism: organism.name,
      phenotype_class: phenotypeClass,
      agents,
      first_acquisition_date: ADDITIVE_TYPES.has(spec.type) ? dayKey(firstAcquisitionMs) : null,
      first_specimen_date: firstSpecimenMs === null ? null : dayKey(firstSpecimenMs),
      last_specimen_date: lastSpecimenMs === null ? null : dayKey(lastSpecimenMs),
      duration_days: spec.durationDays,
      intended_excess_cases: spec.excessCases,
      observed_cases: specimenNumbers.length,
      case_specimen_numbers: specimenNumbers,
      case_patient_ids: patientIds
    })
  }

  records.sort((left, right) => String(left.specimen_date).localeCompare(String(right.specimen_date))
    || String(left.specimen_number).localeCompare(String(right.specimen_number)))

  return {
    records,
    truth: {
      schema_version: 1,
      generator_version: GENERATOR_VERSION,
      seed,
      window_days: windowDays,
      study_start: dayKey(startMs),
      study_end: dayKey(endMs),
      background_rate: backgroundRate,
      sites: sites.map((site) => site.code),
      background_records: backgroundRecords,
      total_records: records.length,
      outbreaks
    }
  }
}

// ---------------------------------------------------------------------------------
// Factorial design

export interface FactorialCell {
  arm_id: string
  type: OutbreakType
  excessCases: number
  durationDays: number
  backgroundRate: BackgroundRate
  replicate: number
  seed: number
  outbreaks: OutbreakSpec[]
}

export interface FactorialOptions {
  excessCases?: readonly number[]
  durationDays?: readonly number[]
  backgroundRates?: readonly BackgroundRate[]
  types?: readonly OutbreakType[]
  replicates?: number
  /** Replicates carrying no outbreak at all, for the false-alert rate per site-year. */
  nullReplicates?: number
  baseSeed?: number
}

/**
 * The pre-specified grid, matching `paper/AMRIT_paper_phasewise_plan.md` Study B arm 2.
 *
 * Cluster sizes and durations are the plan's; background rate and outbreak type are added
 * because a benchmark run at one background volume and one outbreak shape measures one
 * point, not a method.
 */
export function factorialDesign(options: FactorialOptions = {}): FactorialCell[] {
  const excessCases = options.excessCases ?? [5, 10, 20, 40]
  const durationDays = options.durationDays ?? [7, 14, 30]
  const backgroundRates = options.backgroundRates ?? (['low', 'medium', 'high'] as const)
  const types = options.types ?? ([
    'clonal-multidrug', 'single-agent', 'proportion-shift', 'system-wide-rise', 'pseudo-outbreak'
  ] as const)
  const replicates = Math.max(1, Math.trunc(options.replicates ?? 5))
  const nullReplicates = Math.max(0, Math.trunc(options.nullReplicates ?? 20))
  const baseSeed = options.baseSeed ?? 20260814

  const cells: FactorialCell[] = []
  let counter = 0
  for (const type of types) {
    for (const excess of excessCases) {
      for (const duration of durationDays) {
        for (const rate of backgroundRates) {
          for (let replicate = 1; replicate <= replicates; replicate += 1) {
            counter += 1
            cells.push({
              arm_id: `${type}|n${excess}|d${duration}|${rate}|r${replicate}`,
              type,
              excessCases: excess,
              durationDays: duration,
              backgroundRate: rate,
              replicate,
              seed: baseSeed + counter,
              outbreaks: [specFor(type, excess, duration)]
            })
          }
        }
      }
    }
  }
  for (const rate of backgroundRates) {
    for (let replicate = 1; replicate <= nullReplicates; replicate += 1) {
      counter += 1
      cells.push({
        arm_id: `null|${rate}|r${replicate}`,
        type: 'clonal-multidrug',
        excessCases: 0,
        durationDays: 0,
        backgroundRate: rate,
        replicate,
        seed: baseSeed + counter,
        outbreaks: []
      })
    }
  }
  return cells
}

/**
 * One outbreak of each type, in the place that type is realistic.
 *
 * The organism and ward are fixed per type so a cell differs from its neighbours only in
 * the factor being varied. `startDaysBeforeEnd` equals the duration, so every seeded
 * outbreak is still running at the data cut — the prospective case.
 */
function specFor(type: OutbreakType, excessCases: number, durationDays: number): OutbreakSpec {
  const common = { type, excessCases, durationDays, startDaysBeforeEnd: durationDays }
  switch (type) {
    case 'clonal-multidrug':
      return { ...common, siteCode: 'DEMO-DEL-01', ward: 'Medical ICU', organismCode: 'KPN', phenotypeClass: 'carbapenem' }
    case 'single-agent':
      return { ...common, siteCode: 'DEMO-MUM-01', ward: 'Neonatal ICU', organismCode: 'ECO', agents: ['COL'] }
    case 'proportion-shift':
      return { ...common, siteCode: 'DEMO-KOL-01', ward: 'General medicine', organismCode: 'ECO', phenotypeClass: 'cephalosporin' }
    case 'system-wide-rise':
      return { ...common, siteCode: 'DEMO-CHN-01', ward: 'All wards', organismCode: 'KPN', phenotypeClass: 'fluoroquinolone' }
    case 'pseudo-outbreak':
      return { ...common, siteCode: 'DEMO-MUM-01', ward: 'Oncology / haematology', organismCode: 'PAE', phenotypeClass: 'carbapenem' }
  }
}

// ---------------------------------------------------------------------------------
// The shipped demonstration network

/**
 * Outbreaks the demonstration network carries, so its outbreak page is not empty.
 *
 * Three, chosen to show the range rather than one impressive alert: a clonal carbapenem
 * cluster that every method should find, a smaller single-agent cluster near the limit of
 * detection, and a proportion shift that the current case-only detector will **not** find.
 * The third is deliberate. A demonstration that only shows successes teaches the operator
 * that no signal means no outbreak.
 */
export const DEMO_OUTBREAKS: readonly OutbreakSpec[] = Object.freeze([
  {
    id: 'DEMO-OB-001',
    type: 'clonal-multidrug',
    siteCode: 'DEMO-DEL-01',
    ward: 'Medical ICU',
    organismCode: 'KPN',
    phenotypeClass: 'carbapenem',
    excessCases: 24,
    durationDays: 21,
    startDaysBeforeEnd: 21
  },
  {
    id: 'DEMO-OB-002',
    type: 'single-agent',
    siteCode: 'DEMO-MUM-01',
    ward: 'Neonatal ICU',
    organismCode: 'ECO',
    agents: ['COL'],
    excessCases: 9,
    durationDays: 14,
    startDaysBeforeEnd: 16
  },
  {
    id: 'DEMO-OB-003',
    type: 'proportion-shift',
    siteCode: 'DEMO-KOL-01',
    ward: 'General medicine',
    organismCode: 'ECO',
    phenotypeClass: 'cephalosporin',
    excessCases: 18,
    durationDays: 28,
    startDaysBeforeEnd: 28
  }
])
