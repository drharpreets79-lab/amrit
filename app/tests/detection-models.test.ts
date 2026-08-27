// @vitest-environment node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  BERNOULLI_PURELY_SPATIAL_ID, BERNOULLI_PURELY_TEMPORAL_ID, BERNOULLI_SPACE_TIME_ID,
  MULTIVARIATE_ID, POISSON_PURELY_TEMPORAL_ID, POISSON_SPACE_TIME_ID, SPACE_TIME_PERMUTATION_ID,
  DEFAULT_DETECTOR_ID, describeDetectors, deriveDenominators, getDetector, listDetectors
} from '../src/main/detection/registry'
import { bernoulliLogLikelihoodRatio, scanBernoulli } from '../src/main/detection/bernoulli'
import { poissonLogLikelihoodRatio, scanPoisson } from '../src/main/detection/poisson'
import { scanMultivariate } from '../src/main/detection/multivariate'
import { runOutbreakDetection } from '../src/main/outbreak-detection'
import { simulate } from '../src/main/outbreak-simulation'
import { DEMO_SITES } from '../src/main/demo-population'
import type { DenominatorRow, PopulationRow } from '../src/main/detection/types'

const fixture = JSON.parse(readFileSync(
  resolve(process.cwd(), 'resources/shared/golden-datasets/detector_reference.json'), 'utf8'
)) as {
  detectors: Array<{ id: string }>
  bernoulli: {
    settings: Record<string, number | string>
    denominators: DenominatorRow[]
    shapes: Record<string, {
      study_start: string; study_end: string; streams: number; locations: number
      total_tested: number; total_resistant: number
      clusters: Array<Record<string, string | number>>
    }>
    likelihood_cases: Array<{ cases: number; tested: number; total_cases: number; total_tested: number; log_likelihood_ratio: number }>
  }
  poisson: {
    settings: Record<string, number | string>
    population: PopulationRow[]
    study_start: string; study_end: string; streams: number; locations: number
    total_population: number; population_unit: string
    clusters: Array<Record<string, string | number>>
    likelihood_cases: Array<{ cases: number; expected: number; total_cases: number; log_likelihood_ratio: number }>
  }
  multivariate: { combining_cases: Array<{ stream_log_likelihood_ratios: number[]; combined: number; streams: number }> }
}

const bernoulliSettings = fixture.bernoulli.settings as never
const denominators = fixture.bernoulli.denominators

const geometryOf = (shape: 'space-time' | 'purely-temporal' | 'purely-spatial') => {
  const result = scanBernoulli({
    denominators,
    settings: shape === 'purely-spatial'
      ? { ...(bernoulliSettings as object), analysisType: 'retrospective' } as never
      : bernoulliSettings,
    shape
  })
  return {
    study_start: result.studyStart, study_end: result.studyEnd,
    streams: result.streams, locations: result.locations,
    total_tested: result.totalTested, total_resistant: result.totalResistant,
    clusters: result.signals.map((signal) => ({
      antibiotic: signal.antibiotic, location: signal.location,
      start_date: signal.start_date, end_date: signal.end_date, days: signal.days,
      observed: signal.observed, tested: signal.tested,
      proportion: signal.proportion, baseline_proportion: signal.baseline_proportion,
      log_likelihood_ratio: signal.log_likelihood_ratio
    }))
  }
}

describe('the registry after Phase 29', () => {
  it('holds every model and keeps the case-only scan as the default', () => {
    // The scan family, in registration order. Later phases append their own families after
    // these, so this asserts the prefix: the order an operator sees is part of the contract
    // and must not be reshuffled by an addition.
    expect(listDetectors().map((detector) => detector.descriptor.id).slice(0, 7)).toEqual([
      SPACE_TIME_PERMUTATION_ID,
      BERNOULLI_SPACE_TIME_ID, BERNOULLI_PURELY_TEMPORAL_ID, BERNOULLI_PURELY_SPATIAL_ID,
      POISSON_SPACE_TIME_ID, POISSON_PURELY_TEMPORAL_ID,
      MULTIVARIATE_ID
    ])
    // The default stays the control arm. Changing it before the benchmark has run would be
    // choosing the winner in advance, and it is the only model that needs no denominator.
    expect(DEFAULT_DETECTOR_ID).toBe(SPACE_TIME_PERMUTATION_ID)
  })

  it('describes the same detectors the shared fixture holds', () => {
    expect(describeDetectors()).toEqual(fixture.detectors)
  })

  it('marks every denominator-requiring model as such, and only those', () => {
    const requiring = describeDetectors()
      .filter((descriptor) => (descriptor as { requires: { denominators: boolean } }).requires.denominators)
      .map((descriptor) => descriptor.id)
    expect(requiring).not.toContain(SPACE_TIME_PERMUTATION_ID)
    // The six Phase 29 models, and nothing else from that phase.
    expect(requiring).toEqual(expect.arrayContaining([
      BERNOULLI_SPACE_TIME_ID, BERNOULLI_PURELY_TEMPORAL_ID, BERNOULLI_PURELY_SPATIAL_ID,
      POISSON_SPACE_TIME_ID, POISSON_PURELY_TEMPORAL_ID, MULTIVARIATE_ID
    ]))
  })

  it('offers a purely temporal scan to a deployment with one location', () => {
    // A single-laboratory site is a very common AMRIT deployment and cannot run any
    // space-time model. Before Phase 29 it had the category-time substitute and nothing else.
    const oneLocation = denominators.map((row) => ({ ...row, location: 'The laboratory' }))
    const context = { denominators: oneLocation }
    expect(getDetector(BERNOULLI_SPACE_TIME_ID).unavailableReason(context)).toMatch(/Only one location/)
    expect(getDetector(BERNOULLI_PURELY_TEMPORAL_ID).unavailableReason(context)).toBeNull()
    const result = getDetector(BERNOULLI_PURELY_TEMPORAL_ID).run({ ...context, settings: bernoulliSettings })
    expect(result.signals.length).toBeGreaterThan(0)
    expect(result.signals[0]?.scope).toBe('All-location temporal cluster')
  })

  it('tells an operator what is missing rather than returning nothing', () => {
    expect(getDetector(BERNOULLI_SPACE_TIME_ID).unavailableReason({})).toMatch(/No denominators/)
    expect(getDetector(POISSON_SPACE_TIME_ID).unavailableReason({ denominators }))
      .toMatch(/No population at risk/)
    expect(getDetector(MULTIVARIATE_ID).unavailableReason({ denominators }))
      .toMatch(/No patient-level records/)
  })
})

describe('Bernoulli proportion scan', () => {
  it('computes the published log-likelihood ratio', () => {
    for (const item of fixture.bernoulli.likelihood_cases) {
      expect(bernoulliLogLikelihoodRatio(item.cases, item.tested, item.total_cases, item.total_tested))
        .toBeCloseTo(item.log_likelihood_ratio, 5)
    }
  })

  it('reports nothing when the inside proportion is below the outside one', () => {
    // A ward with unusually low resistance is not an outbreak, and reporting it in the same
    // list would bury the ones that are.
    expect(bernoulliLogLikelihoodRatio(1, 50, 30, 100)).toBe(0)
  })

  it('reproduces the fixture geometry for all three shapes', () => {
    for (const shape of ['space-time', 'purely-temporal', 'purely-spatial'] as const) {
      expect(geometryOf(shape)).toEqual(fixture.bernoulli.shapes[shape])
    }
  })

  it('finds the seeded ward and the seeded window in the space-time shape', () => {
    const cluster = fixture.bernoulli.shapes['space-time']?.clusters[0]
    expect(cluster).toMatchObject({
      antibiotic: 'MEM', location: 'Medical ICU', start_date: '2026-03-11', end_date: '2026-03-14'
    })
    // 20 of 24 resistant inside, against a sixth outside. The case-only scan cannot make
    // this comparison because it never looks at the 24.
    expect(cluster?.proportion).toBeCloseTo(0.8333, 3)
    expect(cluster?.baseline_proportion).toBeCloseTo(0.1667, 3)
  })

  it('does not flag the stream that did not move', () => {
    const flagged = fixture.bernoulli.shapes['space-time']?.clusters.map((cluster) => cluster.antibiotic)
    expect(flagged).not.toContain('CIP')
  })

  it('warns that a low replication count disables alerting rather than coarsening it', () => {
    const result = scanBernoulli({ denominators, settings: { ...(bernoulliSettings as object), permutations: 99 } as never })
    expect(result.warnings.some((warning) => warning.includes('100 days'))).toBe(true)
  })
})

describe('Poisson rate scan', () => {
  it('computes the published log-likelihood ratio', () => {
    for (const item of fixture.poisson.likelihood_cases) {
      expect(poissonLogLikelihoodRatio(item.cases, item.expected, item.total_cases))
        .toBeCloseTo(item.log_likelihood_ratio, 5)
    }
  })

  it('reproduces the fixture geometry', () => {
    const result = scanPoisson({
      denominators, population: fixture.poisson.population,
      settings: fixture.poisson.settings as never, shape: 'space-time'
    })
    expect(result.studyStart).toBe(fixture.poisson.study_start)
    expect(result.studyEnd).toBe(fixture.poisson.study_end)
    expect(result.streams).toBe(fixture.poisson.streams)
    expect(result.locations).toBe(fixture.poisson.locations)
    expect(result.totalPopulation).toBe(fixture.poisson.total_population)
    expect(result.populationUnit).toBe(fixture.poisson.population_unit)
    expect(result.signals.map((signal) => ({
      antibiotic: signal.antibiotic, location: signal.location,
      start_date: signal.start_date, end_date: signal.end_date, days: signal.days,
      observed: signal.observed, expected: signal.expected,
      population: signal.population, log_likelihood_ratio: signal.log_likelihood_ratio
    }))).toEqual(fixture.poisson.clusters)
  })

  it('refuses to substitute isolates tested for a population at risk', () => {
    // The whole point of the model is the denominator, and the two denominators answer
    // different questions. Running it on isolates would be the Bernoulli model relabelled.
    const result = scanPoisson({ denominators, population: [], settings: fixture.poisson.settings as never })
    expect(result.signals).toEqual([])
    expect(result.warnings[0]).toMatch(/laboratory record does not carry one/)
  })

  it('excludes a case whose location has no population series, and says how many', () => {
    const orphan: DenominatorRow[] = [...denominators, {
      date: '2026-03-12', location: 'Day surgery', organism_code: 'KPN',
      antibiotic_code: 'MEM', tested: 4, resistant: 4
    }]
    const result = scanPoisson({
      denominators: orphan, population: fixture.poisson.population,
      settings: fixture.poisson.settings as never
    })
    expect(result.warnings.some((warning) => warning.includes('4 resistant isolates'))).toBe(true)
    expect(result.signals.every((signal) => signal.location !== 'Day surgery')).toBe(true)
  })

  it('names the unit it was given, and complains when it was given several', () => {
    const mixed: PopulationRow[] = fixture.poisson.population.map((row, index) =>
      index % 2 === 0 ? row : { ...row, unit: 'admissions' })
    const result = scanPoisson({ denominators, population: mixed, settings: fixture.poisson.settings as never })
    expect(result.populationUnit).toBe('mixed population units')
    expect(result.warnings.some((warning) => warning.includes('mix 2 units'))).toBe(true)
  })
})

describe('multivariate scan', () => {
  it('sums only the streams that contribute', () => {
    for (const item of fixture.multivariate.combining_cases) {
      const positive = item.stream_log_likelihood_ratios.filter((value) => value > 0)
      expect(positive.length).toBe(item.streams)
      expect(positive.reduce((sum, value) => sum + value, 0)).toBeCloseTo(item.combined, 5)
    }
  })

  it('is silent on a corpus with no outbreak in it', () => {
    const { records } = simulate({
      seed: 33, windowDays: 180, backgroundRate: 'medium', endDate: '2026-08-14',
      sites: DEMO_SITES.slice(0, 1), outbreaks: []
    })
    const result = scanMultivariate({ records, settings: { permutations: 99, baselineDays: 180 } })
    expect(result.signals).toEqual([])
  })

  it("alerts on that same empty corpus under SaTScan's independent-stream null", () => {
    // The finding that made the isolate-permutation null the default. SaTScan permutes each
    // data stream separately, which is right for separate data sources and wrong for the
    // agents of one isolate: co-resistance survives in the data and not in the null, so the
    // observed combined statistic beats every simulated maximum. Kept as a setting, and
    // asserted here, so the claim is reproducible by whoever doubts it.
    const { records } = simulate({
      seed: 33, windowDays: 180, backgroundRate: 'medium', endDate: '2026-08-14',
      sites: DEMO_SITES.slice(0, 1), outbreaks: []
    })
    const result = scanMultivariate({
      records, settings: { permutations: 99, baselineDays: 180, nullModel: 'independent-stream' }
    })
    expect(result.signals.length).toBeGreaterThan(0)
    expect(result.signals[0]?.p_value).toBeCloseTo(1 / 100, 5)
    expect(result.warnings.some((warning) => warning.includes('never to run surveillance'))).toBe(true)
  })

  it('reports one signal for a clonal outbreak, naming the agents that carried it', () => {
    const { records } = simulate({
      seed: 99, windowDays: 150, backgroundRate: 'low', endDate: '2026-08-14',
      sites: DEMO_SITES.slice(0, 1),
      outbreaks: [{
        id: 'CLONAL', type: 'clonal-multidrug', siteCode: DEMO_SITES[0]!.code, ward: 'Medical ICU',
        organismCode: 'KPN', phenotypeClass: 'carbapenem',
        excessCases: 20, durationDays: 14, startDaysBeforeEnd: 14
      }]
    })
    const result = scanMultivariate({ records, settings: { permutations: 99, baselineDays: 150 } })
    const top = result.signals[0]
    expect(top).toBeDefined()
    expect(top?.location).toBe('Medical ICU')
    // The seeded mechanism is carbapenem. The per-agent scan reported this outbreak as
    // thirteen signals and put cephalosporins at the top; here the carbapenems are among
    // the contributing streams of a single finding.
    expect(top?.stream_codes.some((code) => ['MEM', 'IPM', 'ETP'].includes(code))).toBe(true)
    expect(top?.streams).toBeGreaterThan(1)
  })
})

describe('what the proportion scan sees and the case-only scan cannot', () => {
  /**
   * The measurement Phase 29 exists to produce.
   *
   * `outbreak-simulation.ts` seeds a proportion shift by thinning susceptible isolates out of
   * one ward while the resistant cases continue at their existing rate. The resistant *count*
   * is unchanged, so a scan that counts resistant cases has nothing to find; the denominator
   * falls, so the resistant share rises and a Bernoulli scan does.
   */
  it('finds the seeded proportion shift the case-only scan returns nothing for', () => {
    const { records } = simulate({
      seed: 90210, windowDays: 365, backgroundRate: 'medium', endDate: '2026-08-14',
      sites: DEMO_SITES.filter((site) => site.code === 'DEMO-KOL-01'),
      outbreaks: [{
        id: 'PROP', type: 'proportion-shift', siteCode: 'DEMO-KOL-01', ward: 'General medicine',
        organismCode: 'ECO', phenotypeClass: 'cephalosporin',
        excessCases: 80, durationDays: 45, startDaysBeforeEnd: 45
      }]
    })
    const settings = { permutations: 99, baselineDays: 365 }
    const caseOnly = runOutbreakDetection([...records], settings)
    expect(caseOnly.signals).toEqual([])

    const proportion = scanBernoulli({
      denominators: deriveDenominators(records), settings, shape: 'space-time'
    })
    const ward = proportion.signals.filter((signal) => signal.location === 'General medicine')
    expect(ward.length).toBeGreaterThan(0)
    const cephalosporins = ward.filter((signal) => ['FEP', 'CAZ', 'CRO', 'CTX'].includes(signal.antibiotic))
    expect(cephalosporins.length).toBeGreaterThan(0)
    // The share inside the window is far above the share outside it, which is the whole
    // signal: neither number moved in a way a case count would show.
    expect(cephalosporins[0]!.proportion).toBeGreaterThan(cephalosporins[0]!.baseline_proportion)
  }, 120_000)
})
