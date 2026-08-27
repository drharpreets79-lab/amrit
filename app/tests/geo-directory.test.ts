// @vitest-environment node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import { lookupLocality, lookupPostalCode, resetGeoDirectoryCache } from '../src/main/geo-directory'
import { isAtLeastAsPrecise, normalizePostalCode } from '../src/shared/geo-directory'

/**
 * The desktop half of the shared geocoding fixture. `server/.../geo/test_directory.py` runs
 * the same cases against the same shards, because a facility that lands in one place on the
 * desktop and another on the portal is the same defect as not being placed at all.
 */

interface ExpectedPlace {
  locality?: string
  admin_area?: string
  dependent_locality?: string
  latitude?: number
  longitude?: number
  precision?: string
}

interface Case {
  name: string
  country_code: string
  postal_code?: string
  locality?: string
  subdivision_code?: string
  expect: {
    available?: boolean
    candidate_count?: number
    candidate_count_at_least?: number
    first?: ExpectedPlace
    postal_code_unknown?: boolean
    country_has_no_postal_directory?: boolean
    point?: ExpectedPlace
    point_precision?: string
  }
}

const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), 'resources/shared/golden-datasets/geo_directory_reference.json'), 'utf8')
) as { cases: Case[]; precision_order: string[] }

beforeAll(() => resetGeoDirectoryCache())

describe('the geographic directory follows the shared fixture', () => {
  for (const testCase of fixture.cases) {
    it(testCase.name, () => {
      const result = testCase.postal_code || !testCase.locality
        ? lookupPostalCode(testCase.country_code, testCase.postal_code ?? '', testCase.subdivision_code)
        : { ...lookupPostalCode(testCase.country_code, '', testCase.subdivision_code), candidates: lookupLocality(testCase.country_code, testCase.locality) }

      const expected = testCase.expect
      if (expected.available !== undefined) expect(result.available).toBe(expected.available)
      if (expected.candidate_count !== undefined) expect(result.candidates).toHaveLength(expected.candidate_count)
      if (expected.candidate_count_at_least !== undefined) {
        expect(result.candidates.length).toBeGreaterThanOrEqual(expected.candidate_count_at_least)
      }
      if (expected.postal_code_unknown !== undefined) {
        expect(result.postalCodeUnknown).toBe(expected.postal_code_unknown)
      }
      if (expected.country_has_no_postal_directory !== undefined) {
        expect(result.countryHasNoPostalDirectory).toBe(expected.country_has_no_postal_directory)
      }
      if (expected.first) {
        const first = result.candidates[0]
        expect(first).toBeDefined()
        for (const [key, value] of Object.entries(expected.first)) {
          expect(first?.[key as keyof typeof first]).toBe(value)
        }
      }
      if (expected.point) {
        for (const [key, value] of Object.entries(expected.point)) {
          expect(result.point?.[key as keyof NonNullable<typeof result.point>]).toBe(value)
        }
      }
      if (expected.point_precision) expect(result.point?.precision).toBe(expected.point_precision)
    })
  }
})

describe('postal code normalisation', () => {
  it('ignores the separators an operator types but a directory does not store', () => {
    expect(normalizePostalCode(' ec1y 8sy ')).toBe('EC1Y8SY')
    expect(normalizePostalCode('22162-1010')).toBe('221621010')
    expect(normalizePostalCode('154-0023')).toBe('1540023')
  })
})

describe('precision never silently coarsens a point', () => {
  it('accepts a finer answer and refuses a coarser one', () => {
    expect(isAtLeastAsPrecise('postal_area', 'locality')).toBe(true)
    expect(isAtLeastAsPrecise('subdivision', 'postal_area')).toBe(false)
    expect(isAtLeastAsPrecise('country', 'subdivision')).toBe(false)
    // Nothing stored yet: anything is an improvement on no point at all.
    expect(isAtLeastAsPrecise('country', undefined)).toBe(true)
    // A coordinate somebody typed knew something the directory does not.
    expect(isAtLeastAsPrecise('locality', 'manual')).toBe(false)
  })
})
