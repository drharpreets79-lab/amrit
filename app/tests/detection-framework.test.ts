// @vitest-environment node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_DETECTOR_ID,
  SPACE_TIME_PERMUTATION_ID,
  describeDetectors,
  detectorAvailability,
  deriveDenominators,
  describeDenominatorCoverage,
  getDetector,
  listDetectors,
  registerDetector,
  type Detector
} from '../src/main/detection/registry'
import { runOutbreakDetection, scanOutbreakEvents, type OutbreakCaseEvent } from '../src/main/outbreak-detection'
import { simulate } from '../src/main/outbreak-simulation'
import { DEMO_SITES } from '../src/main/demo-population'
import type { IsolateRecord } from '../src/shared/types'

const fixture = JSON.parse(readFileSync(
  resolve(process.cwd(), 'resources/shared/golden-datasets/detector_reference.json'), 'utf8'
)) as {
  detectors: Array<Record<string, unknown>>
  denominators: { records: IsolateRecord[]; rows: unknown[]; coverage: Record<string, unknown> }
  scan: {
    settings: Record<string, unknown>
    events: OutbreakCaseEvent[]
    study_start: string
    study_end: string
    eligible_events: number
    locations: number
    signals_tested: number
    clusters: Array<Record<string, unknown>>
  }
}

describe('detector registry', () => {
  it('registers the existing scan statistic and makes it the default', () => {
    expect(listDetectors().length).toBeGreaterThan(0)
    expect(DEFAULT_DETECTOR_ID).toBe(SPACE_TIME_PERMUTATION_ID)
    const detector = getDetector(SPACE_TIME_PERMUTATION_ID)
    expect(detector.descriptor.method).toBe('Kulldorff space-time permutation scan statistic')
    // The one method here that needs no denominator, which is both why it works on
    // notifiable-disease counts and why it cannot see a uniform rise.
    expect(detector.descriptor.requires.denominators).toBe(false)
    expect(detector.descriptor.blindSpot).toMatch(/uniform across/)
    expect(detector.descriptor.citation).toMatch(/Kulldorff/)
  })

  it('refuses a duplicate id, because ids are stored on signals', () => {
    const impostor = {
      ...getDetector(SPACE_TIME_PERMUTATION_ID),
      descriptor: { ...getDetector(SPACE_TIME_PERMUTATION_ID).descriptor }
    } as Detector
    expect(() => registerDetector(impostor)).toThrow(/already registered/)
  })

  it('names an unknown detector rather than returning nothing', () => {
    expect(() => getDetector('bernoulli')).toThrow(/No detector 'bernoulli'/)
  })

  it('says why a detector cannot run, in a sentence an operator can act on', () => {
    const empty = detectorAvailability({ records: [] })
    expect(empty[0]?.available).toBe(false)
    expect(empty[0]?.reason).toMatch(/No records/)

    const { records } = simulate({
      seed: 7, windowDays: 90, backgroundRate: 'low', endDate: '2026-08-14',
      sites: DEMO_SITES.slice(0, 1), outbreaks: []
    })
    expect(detectorAvailability({ records })[0]?.available).toBe(true)
  })
})

describe('the adapter does not change the detector it wraps', () => {
  /**
   * The scan statistic is the control arm of every comparison Phases 28 to 34 make, so the
   * one thing the framework must not do is alter it. Registering it and calling it
   * directly have to produce the same signals, field for field.
   */
  it('produces signals byte-identical to calling runOutbreakDetection directly', () => {
    const { records } = simulate({
      seed: 99, windowDays: 150, backgroundRate: 'low', endDate: '2026-08-14',
      sites: DEMO_SITES.slice(0, 1),
      outbreaks: [{
        id: 'CTRL', type: 'clonal-multidrug', siteCode: DEMO_SITES[0]!.code, ward: 'Medical ICU',
        organismCode: 'KPN', phenotypeClass: 'carbapenem',
        excessCases: 20, durationDays: 14, startDaysBeforeEnd: 14
      }]
    })
    const settings = { analysisType: 'prospective' as const, permutations: 99 }
    const direct = runOutbreakDetection(records, settings)
    const viaRegistry = getDetector(SPACE_TIME_PERMUTATION_ID).run({ records, settings })

    expect(viaRegistry.signals.length).toBe(direct.signals.length)
    expect(viaRegistry.signals.length).toBeGreaterThan(0)
    const stripped = viaRegistry.signals.map(({ detector_id, ...rest }) => {
      expect(detector_id).toBe(SPACE_TIME_PERMUTATION_ID)
      return rest
    })
    expect(JSON.stringify(stripped)).toBe(JSON.stringify(direct.signals))
    expect(viaRegistry.warnings).toEqual(direct.warnings)
    expect(viaRegistry.settings).toEqual(direct.settings)
    // Two full scans over 150 days of seeded data, and the suite runs files in parallel.
    // It costs about six seconds on an idle machine and more on a loaded one; vitest's
    // five-second default made that a timeout rather than a slow test.
  }, 120_000)

  it('reports the recurrence interval the replication count can actually reach', () => {
    const { records } = simulate({
      seed: 5, windowDays: 90, backgroundRate: 'low', endDate: '2026-08-14',
      sites: DEMO_SITES.slice(0, 1), outbreaks: []
    })
    const result = getDetector(SPACE_TIME_PERMUTATION_ID).run({ records, settings: { permutations: 99 } })
    // 99 replications floor the p-value at 1/100, so no cluster of any size can reach the
    // shipped 365-day alert threshold. The diagnostic exists so that is visible rather
    // than inferred.
    expect(result.diagnostics.maximum_reachable_recurrence_interval).toBe(100)
  })
})

describe('denominators', () => {
  it('derives tested and resistant counts, and matches the shared fixture', () => {
    const rows = deriveDenominators(fixture.denominators.records)
    expect(rows).toEqual(fixture.denominators.rows)
    expect(describeDenominatorCoverage(rows)).toEqual(fixture.denominators.coverage)
  })

  it('counts I as tested but never as resistant', () => {
    const rows = deriveDenominators(fixture.denominators.records)
    const gentamicin = rows.find((row) => row.antibiotic_code === 'GEN')
    // EUCAST defines I as susceptible with increased exposure, and the scan already refuses
    // to merge it into resistance. Counting it here would make numerator and denominator
    // disagree about what resistance means.
    expect(gentamicin).toEqual(expect.objectContaining({ tested: 1, resistant: 0 }))
  })

  it('ignores an agent with no interpretation, rather than diluting the denominator', () => {
    const rows = deriveDenominators(fixture.denominators.records)
    expect(rows.find((row) => row.antibiotic_code === 'AMK')).toBeUndefined()
  })

  it('carries an organism-level row that is not the sum of its agents', () => {
    const rows = deriveDenominators(fixture.denominators.records)
    const isolates = rows.find((row) =>
      row.date === '2026-01-05' && row.location === 'Medical ICU' && row.antibiotic_code === '')
    const meropenem = rows.find((row) =>
      row.date === '2026-01-05' && row.location === 'Medical ICU' && row.antibiotic_code === 'MEM')
    // Panels differ between isolates, so no single agent's denominator is the isolate
    // count. A detector needing "how many Klebsiella were seen here" must read the
    // organism row, not reconstruct it.
    expect(isolates?.tested).toBe(2)
    expect(meropenem?.tested).toBe(2)
    expect(rows.filter((row) => row.antibiotic_code === '').length).toBeGreaterThan(1)
  })

  it('names the denominators a laboratory record cannot supply', () => {
    const coverage = describeDenominatorCoverage(deriveDenominators(fixture.denominators.records))
    // Poisson wants a population at risk. Nothing in an isolate record carries one, and a
    // deployment that wants that model has to supply it.
    expect(coverage.unavailable).toContain('patient-days')
    expect(coverage.unavailable).toContain('admissions')
  })
})

describe('shared fixture', () => {
  it('describes the same detectors the registry holds', () => {
    expect(describeDetectors()).toEqual(fixture.detectors)
  })

  it('reproduces the fixture’s deterministic cluster geometry', () => {
    const result = scanOutbreakEvents(fixture.scan.events, fixture.scan.settings)
    expect(result.studyStart).toBe(fixture.scan.study_start)
    expect(result.studyEnd).toBe(fixture.scan.study_end)
    expect(result.eligibleEvents).toBe(fixture.scan.eligible_events)
    expect(result.locations).toBe(fixture.scan.locations)
    expect(result.signalsTested).toBe(fixture.scan.signals_tested)
    // Observed, expected and the log-likelihood ratio are deterministic given the input.
    // p-values are not, and the fixture deliberately does not pin them: the two runtimes
    // seed different generators.
    const geometry = result.signals.map((signal) => ({
      scope: signal.scope,
      signal_type: signal.signal_type,
      organism: signal.organism,
      antibiotic: signal.antibiotic,
      location: signal.location,
      start_date: signal.start_date,
      end_date: signal.end_date,
      days: signal.days,
      observed: signal.observed,
      expected: signal.expected,
      log_likelihood_ratio: signal.log_likelihood_ratio
    }))
    expect(geometry).toEqual(fixture.scan.clusters)
  })
})
