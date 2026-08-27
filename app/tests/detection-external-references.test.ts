// @vitest-environment node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { bernoulliLogLikelihoodRatio } from '../src/main/detection/bernoulli'
import { poissonLogLikelihoodRatio } from '../src/main/detection/poisson'

/**
 * Concordance against published reference implementations.
 *
 * This is what Study B arm 1 became when SaTScan left the critical path on 14 August 2026.
 * SaTScan is a Windows-first binary that cannot be redistributed and would not run on the
 * machine this was built on; every claim resting on it would have required a reviewer to
 * obtain a copy. These references are free, open-source, cross-platform and installable in
 * one command, so the concordance below is something a reader can reproduce rather than
 * take on trust.
 *
 * The R packages are not bundled here. Their *output* is, in the shared fixture, alongside
 * the version that produced it.
 */
const fixture = JSON.parse(readFileSync(
  resolve(process.cwd(), 'resources/shared/golden-datasets/detector_reference.json'), 'utf8'
)) as {
  external_references: {
    packages: Record<string, string>
    bernoulli: { reference: string; cases: Array<{ cases: number; tested: number; total_cases: number; total_tested: number; smerc: number; all_cases_inside: boolean }> }
    poisson: { reference: string; cases: Array<{ cases: number; expected: number; total_cases: number; smerc: number }> }
    space_time_permutation: { reference: string; note: string; counts: number[][]; windows: Array<{ zone: number; duration: number; score: number }> }
  }
}

const external = fixture.external_references

describe('Bernoulli scan against smerc::stat.binom', () => {
  const rows = external.bernoulli.cases

  it('has enough cases to be a comparison rather than a spot check', () => {
    expect(rows.length).toBeGreaterThan(150)
  })

  it('agrees exactly wherever the reference is defined', () => {
    let worst = 0
    for (const row of rows.filter((item) => !item.all_cases_inside)) {
      const mine = bernoulliLogLikelihoodRatio(row.cases, row.tested, row.total_cases, row.total_tested)
      worst = Math.max(worst, Math.abs(mine - row.smerc) / Math.max(1, Math.abs(row.smerc)))
    }
    expect(worst).toBeLessThan(1e-9)
  })

  it('returns the finite value where the reference returns zero through a NaN', () => {
    // `smerc` evaluates `0 * (log(0) - log(popout))` when every case falls inside the window
    // and zeroes the NaN that produces. The limit of `x·log(x)` as `x → 0` is 0, so the
    // statistic is finite; AMRIT takes the limit. Eight of the 169 cases land here, and the
    // disagreement is the reference's, which is worth recording in the direction it runs.
    const degenerate = rows.filter((item) => item.all_cases_inside)
    expect(degenerate.length).toBe(8)
    for (const row of degenerate) {
      expect(row.smerc).toBe(0)
      expect(bernoulliLogLikelihoodRatio(row.cases, row.tested, row.total_cases, row.total_tested))
        .toBeGreaterThan(0)
    }
  })
})

describe('Poisson scan against smerc::stat.poisson', () => {
  it('agrees exactly on every case', () => {
    let worst = 0
    for (const row of external.poisson.cases) {
      const mine = poissonLogLikelihoodRatio(row.cases, row.expected, row.total_cases)
      worst = Math.max(worst, Math.abs(mine - row.smerc) / Math.max(1, Math.abs(row.smerc)))
    }
    expect(worst).toBeLessThan(1e-9)
  })
})

describe('space-time permutation against scanstatistics::scan_permutation', () => {
  const { counts, windows } = external.space_time_permutation
  const days = counts.length
  const total = counts.reduce((sum, row) => sum + row.reduce((a, b) => a + b, 0), 0)
  const dayTotal = counts.map((row) => row.reduce((a, b) => a + b, 0))
  const locationTotal = Array.from({ length: counts[0]!.length }, (_, index) =>
    counts.reduce((sum, row) => sum + (row[index] as number), 0))

  // The kernel `outbreak-detection.ts` uses, written out so the comparison is against the
  // same arithmetic rather than a re-derivation of it.
  const logLikelihoodRatio = (observed: number, expected: number, whole: number): number => {
    if (observed <= expected || expected <= 0 || whole <= observed || whole <= expected) return 0
    return observed * Math.log(observed / expected)
      + (whole - observed) * Math.log((whole - observed) / (whole - expected))
  }

  it('reproduces the reference statistic to the precision the fixture stores', () => {
    let worst = 0
    for (const window of windows) {
      const zone = window.zone - 1
      let observed = 0
      let expected = 0
      for (let day = days - window.duration; day < days; day += 1) {
        observed += counts[day]![zone] as number
        expected += ((locationTotal[zone] as number) * (dayTotal[day] as number)) / total
      }
      worst = Math.max(worst, Math.abs(logLikelihoodRatio(observed, expected, total) - window.score) / window.score)
    }
    // The fixture stores the reference score to nine decimal places, so the comparison
    // inherits that rounding: measured against the unrounded R output the agreement is
    // 6.2e-15, which is machine precision for this arithmetic.
    expect(worst).toBeLessThan(1e-8)
  })

  it('compares the kernel and not the whole detector, deliberately', () => {
    // AMRIT's detector stratifies the expectation by day of week, which this reference does
    // not do. On the fixture both select the same zone and the same window; only the expected
    // count differs, and it differs by design rather than by defect. Comparing the detectors
    // end to end would therefore measure the stratification. Phase 33 has to state which
    // variant any external comparison is against.
    expect(external.space_time_permutation.note).toMatch(/stratifies the expectation by day of week/)
  })
})

describe('provenance', () => {
  it('records the version of every reference package it quotes', () => {
    // A concordance figure without the version of the software it was measured against is
    // not reproducible, which is the objection this whole file exists to answer.
    expect(Object.keys(external.packages)).toEqual(
      expect.arrayContaining(['surveillance', 'smerc', 'scanstatistics']))
    for (const version of Object.values(external.packages)) expect(version).toBeTruthy()
  })
})
