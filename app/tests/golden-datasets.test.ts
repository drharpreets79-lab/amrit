// @vitest-environment node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { calculateOneHealthMetrics } from '../src/main/one-health-engine'

/**
 * The reference fixtures in shared/golden-datasets were never read by any code: the same
 * numbers were retyped by hand in one-health-engine.test.ts, so the files could drift from
 * the implementation without anything failing. They are now the source of truth for these
 * formulas, and the duplication is gone.
 */
const load = <T>(name: string): T =>
  JSON.parse(readFileSync(resolve(process.cwd(), `resources/shared/golden-datasets/${name}`), 'utf8')) as T

interface Fixture<TInput, TExpected> {
  description?: string
  input: TInput[]
  expected: TExpected
}

const close = (actual: unknown, expected: unknown, precision = 2): void => {
  expect(typeof actual).toBe('number')
  expect(actual as number).toBeCloseTo(expected as number, precision)
}

describe('golden datasets', () => {
  it('reproduces the antimicrobial consumption reference', () => {
    const fixture = load<Fixture<Record<string, unknown>, Record<string, number>>>('amc_reference.json')
    const metrics = calculateOneHealthMetrics('amc', fixture.input as never) as Record<string, unknown>

    for (const [key, expected] of Object.entries(fixture.expected)) {
      if (typeof expected !== 'number') continue
      // Only assert on measures the engine actually reports; the fixture also records
      // denominators the engine does not surface.
      if (!(key in metrics)) continue
      close(metrics[key], expected)
    }
    // The headline measures must be present, not merely consistent when absent.
    expect(metrics).toHaveProperty('ddd')
    expect(metrics).toHaveProperty('ddd_per_100_bed_days')
  })

  it('carries fixtures for the other One Health domains', () => {
    // These describe formulas the engine does not implement yet. Loading them here keeps
    // the files honest — a malformed or missing fixture fails now rather than silently.
    for (const name of ['hai_reference.json', 'animal_amu_reference.json']) {
      const fixture = load<Fixture<unknown, Record<string, unknown>>>(name)
      expect(Array.isArray(fixture.input)).toBe(true)
      expect(fixture.input.length).toBeGreaterThan(0)
      expect(Object.keys(fixture.expected).length).toBeGreaterThan(0)
    }
  })

  it('ships the fixtures with the application', () => {
    expect(() => load('amc_reference.json')).not.toThrow()
  })
})
