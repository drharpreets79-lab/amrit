// @vitest-environment node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  BAYESIAN_SCAN_ID, CUSUM_BERNOULLI_ID, CUSUM_POISSON_ID, EWMA_ID, FARRINGTON_ID,
  describeDetectors, getDetector, listDetectors
} from '../src/main/detection/registry'
import {
  bernoulliCusum, cusumChart, ewmaChart, poissonReference, runProcessControl
} from '../src/main/detection/process-control'
import { farringtonAt, requiredPeriods, DEFAULT_FARRINGTON_SETTINGS } from '../src/main/detection/farrington'
import { logMarginalLikelihood, scanBayesian } from '../src/main/detection/bayesian-scan'
import { aggregatePeriods, buildDailySeries } from '../src/main/detection/series'
import { pnorm, qnbinom, qnorm, qpois, twoSidedT } from '../src/main/detection/statistics'
import { simulate } from '../src/main/outbreak-simulation'
import { DEMO_SITES } from '../src/main/demo-population'

const fixture = JSON.parse(readFileSync(
  resolve(process.cwd(), 'resources/shared/golden-datasets/detector_reference.json'), 'utf8'
)) as {
  detectors: Array<{ id: string }>
  process_control: {
    series: number[]; tested: number[]; in_control_mean: number
    aggregate_periods: { period_days: number; result: number[] }
    ewma: { lambda: number; limit_sigma: number; z: number[]; upper: number[] }
    cusum_poisson: { shift: number; reference: number; sums: number[] }
    cusum_bernoulli: { p0: number; p1: number; sums: number[] }
  }
  farrington: {
    counts: number[]
    settings: Record<string, number | string | boolean>
    reference: Array<{ index: number; observed: number; upperbound: number; alarm: boolean; trend: boolean }>
  }
  bayesian: { likelihood_cases: Array<{ count: number; baseline: number; shape: number; rate: number; log_marginal_likelihood: number }> }
}

describe('the numerics the regression detectors stand on', () => {
  // Compared against R, because Farrington is validated against R and a threshold that
  // differs by a quantile is a threshold that differs.
  it('matches R for the normal quantile and distribution function', () => {
    expect(qnorm(0.995)).toBeCloseTo(2.5758293035488999, 12)
    expect(qnorm(0.975)).toBeCloseTo(1.9599639845400534, 12)
    expect(pnorm(-1.96)).toBeCloseTo(0.024997895148220428, 12)
    expect(pnorm(2.5758293035489004)).toBeCloseTo(0.995, 12)
  })

  it('matches R for the Student-t tail and the discrete quantiles', () => {
    expect(twoSidedT(2.5, 10)).toBeCloseTo(0.031446844236608783, 12)
    expect(twoSidedT(4.2, 7)).toBeCloseTo(0.0040355599252199616, 12)
    expect(qnbinom(0.99, 2.5, 10)).toBe(33)
    expect(qpois(0.99, 10)).toBe(18)
  })
})

describe('the registry after Phase 31', () => {
  it('holds thirteen detectors across four families', () => {
    // Twelve after Phase 30, thirteen once PACE joined them in Phase 31.
    expect(listDetectors()).toHaveLength(13)
    expect(describeDetectors()).toEqual(fixture.detectors)
    const families = new Set(describeDetectors().map((descriptor) => descriptor.family))
    expect(families).toEqual(new Set(['scan', 'process-control', 'regression', 'bayesian']))
  })

  it('marks the two charts that need no denominator as such', () => {
    // The point of including them: they run on a deployment that has nothing but counts,
    // which is what the federation wire carries.
    expect(getDetector(EWMA_ID).descriptor.requires.denominators).toBe(false)
    expect(getDetector(CUSUM_POISSON_ID).descriptor.requires.denominators).toBe(false)
    expect(getDetector(CUSUM_BERNOULLI_ID).descriptor.requires.denominators).toBe(true)
  })
})

describe('period aggregation', () => {
  it('matches the fixture and drops the partial period at the start', () => {
    const { period_days: periodDays, result } = fixture.process_control.aggregate_periods
    expect(aggregatePeriods(fixture.process_control.series, periodDays)).toEqual(result)
    // 16 values into periods of 4 is exactly 4 periods; 17 would drop the first value, not
    // keep a short period, because an under-filled first period reads as a quiet baseline.
    expect(aggregatePeriods([9, ...fixture.process_control.series], 4)).toEqual(result)
  })
})

describe('control charts', () => {
  const { series, tested, in_control_mean: mean } = fixture.process_control

  it('reproduces the EWMA recursion and its time-varying limits', () => {
    const { lambda, limit_sigma: limitSigma, z, upper } = fixture.process_control.ewma
    const chart = ewmaChart(series, mean, Math.sqrt(mean), lambda, limitSigma)
    chart.z.forEach((value, index) => expect(value).toBeCloseTo(z[index] as number, 9))
    chart.upper.forEach((value, index) => expect(value).toBeCloseTo(upper[index] as number, 9))
    // The limit widens toward its asymptote rather than starting there.
    expect(upper[0] as number).toBeLessThan(upper[upper.length - 1] as number)
  })

  it('uses the Poisson reference value, not the arithmetic midpoint', () => {
    const { shift, reference, sums } = fixture.process_control.cusum_poisson
    expect(poissonReference(mean, shift)).toBeCloseTo(reference, 9)
    // The arithmetic midpoint of 4 and 6 is 5; Lucas's value is where the log-likelihood
    // ratio changes sign, which is not 5.
    expect(reference).not.toBeCloseTo(5, 3)
    // Eight places, not nine: the fixture stores the reference value rounded to nine, and
    // the sums are recomputed from that rounded input, so the last place drifts by design.
    cusumChart(series, reference).forEach((value, index) => expect(value).toBeCloseTo(sums[index] as number, 8))
  })

  it('scores the Bernoulli CUSUM on resistant-among-tested', () => {
    const { p0, p1, sums } = fixture.process_control.cusum_bernoulli
    bernoulliCusum(series, tested, p0, p1).forEach((value, index) =>
      expect(value).toBeCloseTo(sums[index] as number, 9))
  })

  it('never goes below zero, which is what makes a CUSUM a one-sided test', () => {
    expect(cusumChart([0, 0, 0, 0], 4).every((value) => value === 0)).toBe(true)
  })

  it('reports how many signals it found, not only how many it returned', () => {
    // The cap is 50 and these charts can produce hundreds. A run that says "50" when it
    // found 600 has hidden the number that matters for a false-alert-rate comparison.
    const { records } = simulate({
      seed: 777, windowDays: 730, backgroundRate: 'medium', endDate: '2026-08-14',
      sites: DEMO_SITES.slice(0, 1), outbreaks: []
    })
    const result = runProcessControl({ context: { records }, chart: 'ewma' })
    expect(result.signals.length).toBeLessThanOrEqual(50)
    expect(result.signalsFound).toBeGreaterThanOrEqual(result.signals.length)
    // Measured, not asserted from theory: on a corpus with no outbreak in it these charts
    // alarm repeatedly, because they correct for no multiplicity across 241 charted series.
    expect(result.signalsFound).toBeGreaterThan(50)
    expect(result.warnings[0]).toMatch(/corrects for no/)
  }, 120_000)
})

describe('Farrington, against the reference implementation', () => {
  const { counts, reference } = fixture.farrington
  const settings = fixture.farrington.settings as never

  it('reproduces every threshold R produced', () => {
    let worst = 0
    for (const row of reference) {
      // R indices are 1-based.
      const result = farringtonAt(counts, row.index - 1, settings)
      expect(result).not.toBeNull()
      if (row.upperbound > 0) {
        worst = Math.max(worst, Math.abs((result as { threshold: number }).threshold - row.upperbound) / row.upperbound)
      }
    }
    // Everything above this is IRLS convergence noise between two implementations of the
    // same regression, not a difference in method.
    expect(worst).toBeLessThan(1e-4)
  })

  it('reproduces every alarm and every trend decision R made', () => {
    for (const row of reference) {
      const result = farringtonAt(counts, row.index - 1, settings) as { alarm: boolean; trend: boolean }
      expect(result.alarm).toBe(row.alarm)
      expect(result.trend).toBe(row.trend)
    }
  })

  it('finds the injected excess', () => {
    expect(reference.some((row) => row.alarm)).toBe(true)
  })

  it('refuses to run on a series with no previous years, and says how many it needs', () => {
    const { records } = simulate({
      seed: 5, windowDays: 400, backgroundRate: 'medium', endDate: '2026-08-14',
      sites: DEMO_SITES.slice(0, 1), outbreaks: []
    })
    const reason = getDetector(FARRINGTON_ID).unavailableReason({ records })
    // The constraint that matters most about this method, and it must not fail quietly:
    // a period that cannot be tested is not a period with no aberration.
    expect(reason).toMatch(/needs 5/)
    expect(reason).toMatch(/EWMA and the CUSUM charts/)
  }, 120_000)

  it('requires five years of periods before the first testable one', () => {
    expect(requiredPeriods(DEFAULT_FARRINGTON_SETTINGS)).toBe(52 * 5 + 3 + 1)
  })
})

describe('Bayesian spatial scan', () => {
  it('computes the Gamma-Poisson marginal likelihood', () => {
    for (const item of fixture.bayesian.likelihood_cases) {
      expect(logMarginalLikelihood(item.count, item.baseline, item.shape, item.rate))
        .toBeCloseTo(item.log_marginal_likelihood, 9)
    }
  })

  it('is quiet on a corpus with no outbreak and finds the ward when there is one', () => {
    const empty = simulate({
      seed: 777, windowDays: 730, backgroundRate: 'medium', endDate: '2026-08-14',
      sites: DEMO_SITES.slice(0, 1), outbreaks: []
    })
    const seeded = simulate({
      seed: 777, windowDays: 730, backgroundRate: 'medium', endDate: '2026-08-14',
      sites: DEMO_SITES.slice(0, 1),
      outbreaks: [{
        id: 'BSS', type: 'clonal-multidrug', siteCode: DEMO_SITES[0]!.code, ward: 'Medical ICU',
        organismCode: 'KPN', phenotypeClass: 'carbapenem',
        excessCases: 25, durationDays: 21, startDaysBeforeEnd: 21
      }]
    })
    const quiet = scanBayesian({ context: { records: empty.records } })
    const loud = scanBayesian({ context: { records: seeded.records } })
    expect(quiet.signals).toEqual([])
    expect(loud.signals.length).toBeGreaterThan(0)
    expect(loud.signals[0]?.location).toBe('Medical ICU')
    // The posterior that nothing is happening falls when something is, which is the
    // quantity a p-value cannot give you.
    expect(loud.posteriorNull).toBeLessThan(quiet.posteriorNull)
  }, 120_000)

  it('reports a posterior and refuses to dress it as a p-value', () => {
    const { records } = simulate({
      seed: 777, windowDays: 400, backgroundRate: 'medium', endDate: '2026-08-14',
      sites: DEMO_SITES.slice(0, 1), outbreaks: []
    })
    const result = getDetector(BAYESIAN_SCAN_ID).run({ records })
    // `p_value` stays zero deliberately: `1 - posterior` in that field would invite exactly
    // the misreading the module comment warns about.
    for (const signal of result.signals) expect(signal.p_value).toBe(0)
    expect(result.warnings.some((warning) => warning.includes('not p-values'))).toBe(true)
  }, 120_000)
})

describe('the daily series every non-scan detector reads', () => {
  it('keeps zero days rather than gaps, so a quiet week is data', () => {
    const built = buildDailySeries([
      { date: '2026-01-01', location: 'ICU', organism_code: 'KPN', antibiotic_code: 'MEM', tested: 4, resistant: 3 },
      { date: '2026-01-05', location: 'ICU', organism_code: 'KPN', antibiotic_code: 'MEM', tested: 4, resistant: 3 }
    ], { minimumTotalCases: 1 })
    expect(built.days).toBe(5)
    const series = built.series.find((item) => !item.pooled)
    expect(series?.cases).toEqual([3, 0, 0, 0, 3])
  })

  it('emits a pooled series alongside each location', () => {
    // A temporal detector run only per ward cannot see a rise spread evenly across every
    // ward, which is the case-only scan's documented blind spot. The pooled series covers it.
    const built = buildDailySeries([
      { date: '2026-01-01', location: 'ICU', organism_code: 'KPN', antibiotic_code: 'MEM', tested: 4, resistant: 3 },
      { date: '2026-01-01', location: 'Ward B', organism_code: 'KPN', antibiotic_code: 'MEM', tested: 4, resistant: 2 }
    ], { minimumTotalCases: 1 })
    const pooled = built.series.find((item) => item.pooled)
    expect(pooled?.location).toBe('All locations')
    expect(pooled?.cases[0]).toBe(5)
  })
})
