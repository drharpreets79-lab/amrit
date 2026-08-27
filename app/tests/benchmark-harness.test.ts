// @vitest-environment node

import { describe, expect, it } from 'vitest'

import {
  RANKING_STATISTIC, SIGNAL_CAP_PER_CELL, alerted, armsFor, calibrate, computeEndpoints,
  evidenceOf, isPooled, matchSignal, median, outcomeOf, rankableDetectors, runBenchmark,
  siteYearsOf, wilson, type BenchmarkArm
} from '../src/main/benchmark'
import { listDetectors, type DetectorSignal } from '../src/main/detection/registry'
import type { SeededOutbreak } from '../src/main/outbreak-simulation'

const signal = (over: Partial<DetectorSignal> = {}): DetectorSignal => ({
  signal_id: 'a', status: 'alert', signal_type: 'Resistance phenotype',
  organism: 'KPN', antibiotic: 'MEM', scope: 'Location cluster', location: 'Medical ICU',
  start_date: '2026-08-01', end_date: '2026-08-10', days: 10,
  observed: 12, expected: 4, excess: 8, observed_expected_ratio: 3,
  log_likelihood_ratio: 9.5, p_value: 0.01, recurrence_interval_days: 100,
  detector_id: 'space-time-permutation', ...over
})

const outbreak = (over: Partial<SeededOutbreak> = {}): SeededOutbreak => ({
  outbreak_id: 'OB-1', type: 'clonal-multidrug', site_code: 'DEMO-DEL-01', ward: 'Medical ICU',
  organism_code: 'KPN', organism: 'Klebsiella pneumoniae', phenotype_class: 'carbapenem',
  agents: ['MEM', 'IPM'], first_acquisition_date: '2026-07-28', first_specimen_date: '2026-08-02',
  last_specimen_date: '2026-08-14', duration_days: 14, intended_excess_cases: 20,
  observed_cases: 18, case_specimen_numbers: [], case_patient_ids: [], ...over
})

describe('ranking', () => {
  it('declares a statistic for every registered detector', () => {
    // A detector added without one would silently fall back to a field that is zero for its
    // family, scoring it at zero sensitivity, which reads as a finding about the method.
    const registered = listDetectors().map((detector) => detector.descriptor.id).sort()
    expect(rankableDetectors().sort()).toEqual(registered)
  })

  it('ranks the scan family by log-likelihood ratio, not recurrence interval', () => {
    // The recurrence interval is capped at `permutations + 1`, so every cluster past the
    // p-value floor ties and the benchmark could not order them at any tight alert budget.
    expect(RANKING_STATISTIC['space-time-permutation']).toBe('log-likelihood-ratio')
    expect(evidenceOf(signal({ log_likelihood_ratio: 12.5, recurrence_interval_days: 100 }))).toBe(12.5)
  })

  it('reads each other family from its own field', () => {
    expect(evidenceOf(signal({ detector_id: 'ewma', chart_exceedance: 2.4 } as never))).toBe(2.4)
    expect(evidenceOf(signal({ detector_id: 'farrington', farrington_score: 1.8 } as never))).toBe(1.8)
    expect(evidenceOf(signal({ detector_id: 'bayesian-spatial-scan', posterior_given_outbreak: 0.7 } as never))).toBe(0.7)
  })

  it('refuses to guess for an unknown detector', () => {
    expect(evidenceOf(signal({ detector_id: 'not-a-detector' }))).toBeNull()
  })
})

describe('matching a signal to a seeded outbreak', () => {
  it('matches on organism, overlapping window and the seeded ward', () => {
    const match = matchSignal(signal(), outbreak())
    expect(match).not.toBeNull()
    expect(match?.localised).toBe(true)
    expect(match?.overlapDays).toBe(9)
  })

  it('refuses a different organism however well the window fits', () => {
    expect(matchSignal(signal({ organism: 'ECO' }), outbreak())).toBeNull()
  })

  it('refuses a window that does not overlap', () => {
    expect(matchSignal(signal({ start_date: '2026-06-01', end_date: '2026-06-10' }), outbreak())).toBeNull()
  })

  it('admits an all-location signal but does not call it localised', () => {
    // Four of the twelve detectors have no spatial dimension. A rule requiring the ward would
    // score them at zero by construction, which reports the rule's shape and not the method's.
    const pooled = signal({ location: 'All locations', scope: 'All-location temporal cluster' })
    expect(isPooled(pooled)).toBe(true)
    const match = matchSignal(pooled, outbreak())
    expect(match).not.toBeNull()
    expect(match?.localised).toBe(false)
  })

  it('refuses a different ward when the signal did claim a ward', () => {
    expect(matchSignal(signal({ location: 'Surgical ICU' }), outbreak())).toBeNull()
  })

  it('treats a pooled signal as localised for an outbreak seeded in every ward', () => {
    const everywhere = outbreak({ type: 'system-wide-rise', ward: 'All wards' })
    const pooled = signal({ location: 'All locations', scope: 'All-location temporal cluster' })
    expect(matchSignal(pooled, everywhere)?.localised).toBe(true)
  })

  it('ignores the antibiotic, deliberately', () => {
    // A clonal outbreak expresses across every agent its mechanism affects and the detectors
    // legitimately differ about which to name. Phase 32 measured the case-only scan naming
    // amikacin for a carbapenem outbreak.
    expect(matchSignal(signal({ antibiotic: 'AMK' }), outbreak())).not.toBeNull()
  })
})

describe('calibration', () => {
  const nullSignals = (values: number[]): DetectorSignal[] =>
    values.map((value, index) => signal({ signal_id: `n${index}`, log_likelihood_ratio: value }))

  it('spends the budget and no more', () => {
    const calibration = calibrate({
      nullSignals: nullSignals([10, 9, 8, 7, 6, 5, 4]), siteYears: 3, targetRate: 1, nullCells: 3
    })
    expect(calibration.threshold).toBe(7)
    expect(calibration.nullAlerts).toBe(3)
    expect(calibration.achievedRate).toBeCloseTo(1, 9)
    expect(alerted(nullSignals([10, 9, 8, 7, 6]), calibration)).toHaveLength(3)
  })

  it('admits everything when the detector is already quieter than the budget', () => {
    const calibration = calibrate({ nullSignals: nullSignals([5]), siteYears: 10, targetRate: 1, nullCells: 1 })
    expect(calibration.threshold).toBe(Number.NEGATIVE_INFINITY)
    expect(calibration.belowBudget).toBe(true)
    // Reported as what it is, below target, rather than inflated to meet it.
    expect(calibration.achievedRate).toBeCloseTo(0.1, 9)
  })

  it('spends less than the budget when the statistic ties, and says so', () => {
    const calibration = calibrate({
      nullSignals: nullSignals([5, 5, 5, 5, 5, 1]), siteYears: 3, targetRate: 1, nullCells: 3
    })
    expect(calibration.nullAlerts).toBe(0)
    expect(calibration.tiedAtThreshold).toBe(true)
  })

  it('refuses to calibrate from a truncated null distribution', () => {
    // Each detector reports at most 50 signals per cell. A budget above what the cap retains
    // would set the threshold from a truncated tail and silently understate the false-alert rate.
    expect(() => calibrate({
      nullSignals: nullSignals([1, 2, 3]), siteYears: 500, targetRate: 1, nullCells: 1
    })).toThrow(/truncated null distribution/)
    expect(SIGNAL_CAP_PER_CELL).toBe(50)
  })

  it('counts site-years as sites times days', () => {
    expect(siteYearsOf([{ sites: 4, windowDays: 730 }])).toBeCloseTo(8, 1)
  })
})

describe('endpoints', () => {
  it('reports an arm that never ran as not run, never as zero sensitivity', () => {
    // Farrington needs five years of history and no corpus here has them. "Did not look" and
    // "looked and found nothing" are different results and must not print the same.
    const endpoints = computeEndpoints({ outcomes: [], detectionDelays: [], falseAlertRate: 0 })
    expect(endpoints.ran).toBe(false)
    expect(endpoints.sensitivity).toBeNull()
    expect(endpoints.sensitivityInterval).toBeNull()
    expect(endpoints.positivePredictiveValue).toBeNull()
  })

  it('counts a signal that matched two outbreaks once', () => {
    const second = outbreak({ outbreak_id: 'OB-2' })
    const outcome = outcomeOf([signal()], [outbreak(), second])
    expect(outcome.matches).toHaveLength(2)
    const endpoints = computeEndpoints({ outcomes: [outcome], detectionDelays: [], falseAlertRate: 0 })
    // Two outbreaks found by one signal is a precision of 1, not 2: letting matches drive the
    // numerator would let a detector inflate its own precision by finding one thing twice.
    expect(endpoints.positivePredictiveValue).toBe(1)
    expect(endpoints.sensitivityNumerator).toBe(2)
  })

  it('uses a Wilson interval, which cannot run outside zero and one', () => {
    const [low, high] = wilson(0, 4)
    expect(low).toBe(0)
    expect(high).toBeLessThan(1)
    expect(wilson(4, 4)[1]).toBe(1)
  })

  it('takes the median of an even-length delay set', () => {
    expect(median([2, 4, 6, 8])).toBe(5)
    expect(median([])).toBeNull()
  })

  it('separates spatial accuracy from sensitivity', () => {
    const pooled = signal({ location: 'All locations', scope: 'All-location temporal cluster' })
    const endpoints = computeEndpoints({
      outcomes: [outcomeOf([pooled], [outbreak()])], detectionDelays: [], falseAlertRate: 0
    })
    // Found it, could not say where. Both facts appear; collapsing them would hide the
    // trade-off an infection-prevention team cares about most.
    expect(endpoints.sensitivity).toBe(1)
    expect(endpoints.spatialAccuracy).toBe(0)
  })
})

describe('the harness end to end', () => {
  it('calibrates on nulls first and reports every arm', async () => {
    const arms: BenchmarkArm[] = armsFor(['space-time-permutation', 'bernoulli-space-time', 'farrington'])
    const report = await runBenchmark({
      arms,
      types: ['clonal-multidrug'],
      excessCases: [40],
      durationDays: [14],
      backgroundRates: ['low'],
      replicates: 1,
      nullReplicates: 1,
      windowDays: 200,
      targetRate: 1
    })
    expect(report.arms).toHaveLength(3)
    expect(report.nullCells).toBe(1)
    expect(report.seededCells).toBe(1)
    // Farrington needs five years and this corpus is 200 days, so it must report as not run
    // rather than as a detector that failed.
    const farrington = report.arms.find((arm) => arm.arm.id === 'farrington')
    expect(farrington?.endpoints.ran).toBe(false)
    expect(farrington?.unavailable.length).toBeGreaterThan(0)
    // The scan arms ran and were calibrated against the null replicate alone.
    const scan = report.arms.find((arm) => arm.arm.id === 'space-time-permutation')
    expect(scan?.calibration.siteYears).toBeGreaterThan(0)
    expect(report.notes.some((note) => note.includes('calibrated on the null replicates alone'))).toBe(true)
  }, 600_000)

  it('says so when detection delay was not measured', async () => {
    const report = await runBenchmark({
      arms: armsFor(['bayesian-spatial-scan']),
      types: ['clonal-multidrug'], excessCases: [40], durationDays: [14],
      backgroundRates: ['low'], replicates: 1, nullReplicates: 1, windowDays: 200
    })
    // A single run at the data cut would report the outbreak's age, which is a property of the
    // corpus and identical for every arm. Reporting that as a delay would be worse than a dash.
    expect(report.delayStrideDays).toBe(0)
    expect(report.notes.some((note) => note.includes('rather than any property of the detector'))).toBe(true)
  }, 600_000)
})
