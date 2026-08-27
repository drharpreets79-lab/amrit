// @vitest-environment node

import { describe, expect, it } from 'vitest'

import { addressFormatFor } from '../src/main/address-format'
import {
  RESIDENCE_FIELDS,
  normalizeAddress,
  residenceFieldsForForm,
  validateResidence,
  type PatientResidence,
  type PostalAddress
} from '../src/shared/address'
import { lookupPostalCode } from '../src/main/geo-directory'

/**
 * The boundary the geographic directory is most likely to erode.
 *
 * Resolving a postal code to a coordinate is now one call away, and a patient's residence
 * carries a postal code. It is *deliberately* coarsened before export by
 * `privacy.patient_postal_code_digits`, and a coordinate resolved from it would put back
 * precisely the precision that setting exists to remove — silently, and in a field nobody
 * would think to check.
 *
 * So the rule is written down as a test rather than as a comment: facilities get points,
 * patients do not.
 */
describe('geocoding stops at the facility', () => {
  const format = addressFormatFor('IND')

  it('resolves a facility address to a point', () => {
    const result = lookupPostalCode('IND', '682011')
    expect(result.point).not.toBeNull()
    expect(result.point?.precision).toBe('postal_area')
  })

  it('refuses a coordinate attached to a patient residence', () => {
    const residence = {
      country_code: 'IND',
      locality: 'Kochi',
      postal_code: '682011',
      geo_point: { latitude: 9.967, longitude: 76.3159, precision: 'postal_area', source: 'geonames-postal' }
    } as unknown as PatientResidence

    const problems = validateResidence(residence, format)
    expect(problems.map((problem) => problem.field)).toContain('geo_point')
    expect(problems.find((problem) => problem.field === 'geo_point')?.code).toBe('not_stored')
  })

  it('refuses a Plus Code attached to a patient residence', () => {
    const residence = {
      country_code: 'IND',
      locality: 'Kochi',
      plus_code: '7J3Q2M8Q+P9'
    } as unknown as PatientResidence
    expect(validateResidence(residence, format)).toContainEqual(
      expect.objectContaining({ field: 'plus_code', code: 'not_stored' })
    )
  })

  it('accepts the same residence once the coordinate is gone', () => {
    const residence: PatientResidence = { country_code: 'IND', locality: 'Kochi', postal_code: '682011' }
    expect(validateResidence(residence, format)).toEqual([])
  })

  it('never offers a coordinate field on a residence form', () => {
    // The form is built from this list, so a field absent here cannot be typed into.
    expect(RESIDENCE_FIELDS).not.toContain('geo_point')
    expect(residenceFieldsForForm(format)).not.toContain('geo_point')
  })

  it('keeps a facility point through normalisation, because a facility is the exception', () => {
    const address: PostalAddress = {
      country_code: 'IND',
      address_lines: ['12 Hospital Road'],
      locality: 'Kochi',
      admin_area: 'Kerala',
      postal_code: '682011',
      geo_point: { latitude: 9.967, longitude: 76.3159, precision: 'postal_area', source: 'geonames-postal' }
    }
    expect(normalizeAddress(address, format).geo_point?.precision).toBe('postal_area')
  })
})
