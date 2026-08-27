// @vitest-environment node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { addressFormatFor, addressFormatPack } from '../src/main/address-format'
import {
  ADDRESS_FIELD_ORDER,
  fieldsForForm,
  formatAddress,
  labelFor,
  moveUnsupportedFieldToAddressLines,
  normalizeAddress,
  repairUnsupportedAddressFields,
  toFhirAddress,
  validateAddress,
  withAddressField,
  type PostalAddress
} from '../src/shared/address'

/**
 * The same fixture the server's `geo/test_address.py` reads. If the two implementations
 * ever disagree about how a country writes an address, one of these suites fails — an
 * address rendered one way on the desktop and another on the portal is the same defect as
 * not storing it at all.
 */
interface Case {
  name: string
  address: PostalAddress
  formatted?: string
  labels?: Record<string, string>
  problems: Array<{ field: string; code: string }>
}

const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), 'resources/shared/golden-datasets/address_reference.json'), 'utf8')
) as {
  cases: Case[]
  fhir: { address: PostalAddress; expected: Record<string, unknown> }
}

describe('postal addresses follow the shared fixture', () => {
  for (const testCase of fixture.cases) {
    it(testCase.name, () => {
      const format = addressFormatFor(testCase.address.country_code ?? '')
      const problems = validateAddress(testCase.address, format).map(({ field, code }) => ({ field, code }))
      expect(problems).toEqual(testCase.problems)

      if (testCase.formatted !== undefined) {
        expect(normalizeAddress(testCase.address, format).formatted).toBe(testCase.formatted)
      }
      for (const [field, expected] of Object.entries(testCase.labels ?? {})) {
        expect(labelFor(field as never, format)).toBe(expected)
      }
    })
  }

  it('maps onto FHIR Address one-to-one, apart from the sorting code', () => {
    const format = addressFormatFor(fixture.fhir.address.country_code)
    const resource = toFhirAddress(normalizeAddress(fixture.fhir.address, format), format)
    expect(resource).toEqual(fixture.fhir.expected)
  })
})

describe('the address format pack', () => {
  it('covers every country the registry can offer', () => {
    const pack = addressFormatPack()
    expect(Object.keys(pack.countries).length).toBeGreaterThanOrEqual(240)
    for (const entry of Object.values(pack.countries)) {
      expect(entry.format).toBeTruthy()
      expect(entry.fields.length).toBeGreaterThan(0)
      expect(Object.keys(entry.labels).sort()).toEqual(
        ['admin_area', 'dependent_locality', 'locality', 'postal_code']
      )
    }
  })

  it('falls back to a working form for a country it does not list', () => {
    const format = addressFormatFor('ZZZ')
    expect(format).toEqual(addressFormatPack().default)
    expect(fieldsForForm(format)).toContain('address_lines')
  })

  it('orders form fields the way the country writes them', () => {
    // Japan writes the prefecture before the street; the form must not impose one order.
    expect(fieldsForForm(addressFormatFor('JPN')).slice(0, 3)).toEqual([
      'postal_code',
      'admin_area',
      'address_lines'
    ])
    expect(fieldsForForm(addressFormatFor('USA')).slice(0, 4)).toEqual([
      'organization',
      'address_lines',
      'locality',
      'admin_area'
    ])
  })

  it('never offers a recipient field, in any country', () => {
    // These are the addresses of facilities. An attention line is where a person's name
    // ends up, and this software does not store people's addresses.
    for (const alpha3 of Object.keys(addressFormatPack().countries)) {
      expect(fieldsForForm(addressFormatFor(alpha3))).not.toContain('recipient')
    }
    expect(ADDRESS_FIELD_ORDER).toContain('recipient')
  })
})

describe('editing an address', () => {
  const format = addressFormatFor('IND')

  it('clears a component rather than storing an empty string', () => {
    const withCity = withAddressField({ country_code: 'IND' }, 'locality', 'Kochi')
    expect(withCity.locality).toBe('Kochi')
    expect('locality' in withAddressField(withCity, 'locality', '  ')).toBe(false)
  })

  it('splits street lines on newlines and drops the blank ones', () => {
    const edited = withAddressField({ country_code: 'IND' }, 'address_lines', '12 Hospital Road\n\nAnsari Nagar\n')
    expect(edited.address_lines).toEqual(['12 Hospital Road', 'Ansari Nagar'])
  })

  it('moves a country-incompatible component into printable street lines without losing it', () => {
    const repaired = moveUnsupportedFieldToAddressLines({
      country_code: 'IND',
      address_lines: ['12 Hospital Road'],
      dependent_locality: 'Fort Kochi',
      locality: 'Kochi',
      admin_area: 'Kerala',
      postal_code: '682011'
    }, 'dependent_locality', format)

    expect(repaired.dependent_locality).toBeUndefined()
    expect(repaired.address_lines).toEqual(['12 Hospital Road', 'Fort Kochi'])
    expect(repaired.formatted).toContain('Fort Kochi')
    expect(validateAddress(repaired, format)).not.toContainEqual(
      expect.objectContaining({ field: 'dependent_locality', code: 'unsupported' })
    )
  })

  it('does not duplicate a component already present in the street lines', () => {
    const repaired = moveUnsupportedFieldToAddressLines({
      country_code: 'IND',
      address_lines: ['12 Hospital Road', 'Fort Kochi'],
      dependent_locality: 'fort kochi'
    }, 'dependent_locality', format)

    expect(repaired.address_lines).toEqual(['12 Hospital Road', 'Fort Kochi'])
    expect(repaired.dependent_locality).toBeUndefined()
  })

  it('repairs every unsupported imported component before storage', () => {
    const repaired = repairUnsupportedAddressFields({
      country_code: 'IND',
      address_lines: ['12 Hospital Road'],
      dependent_locality: 'Fort Kochi',
      sorting_code: 'ROUTE 8'
    }, format)

    expect(repaired.address_lines).toEqual(['12 Hospital Road', 'Fort Kochi', 'ROUTE 8'])
    expect(repaired.dependent_locality).toBeUndefined()
    expect(repaired.sorting_code).toBeUndefined()
  })

  it('refuses to store a recipient, whatever the caller passes', () => {
    expect(withAddressField({ country_code: 'IND' }, 'recipient', 'Dr Smith')).toEqual({ country_code: 'IND' })
    expect(formatAddress({ country_code: 'IND', recipient: 'Dr Smith' } as PostalAddress, format)).toBe('')
  })

  it('recomputes formatted rather than trusting what it was given', () => {
    const normalized = normalizeAddress(
      {
        country_code: 'IND',
        address_lines: ['12 Hospital Road'],
        locality: 'Kochi',
        admin_area: 'Kerala',
        postal_code: '682011',
        formatted: 'whatever the caller sent'
      },
      format
    )
    expect(normalized.formatted).toBe('12 Hospital Road\nKOCHI 682011\nKerala')
  })

  it('does not let a pattern it cannot compile become a data-entry wall', () => {
    const broken = { ...format, postal_code_pattern: '(unclosed' }
    expect(
      validateAddress(
        { country_code: 'IND', address_lines: ['A'], locality: 'Kochi', admin_area: 'Kerala', postal_code: '682011' },
        broken
      )
    ).toEqual([])
  })

  it('decodes a full Plus Code offline and retains it in canonical form', () => {
    const normalized = normalizeAddress(
      { country_code: 'IND', plus_code: '7j3q 2m8q+p9' },
      format
    )
    expect(normalized.plus_code).toBe('7J3Q2M8Q+P9')
    expect(normalized.geo_point).toEqual(expect.objectContaining({
      latitude: 11.0168125,
      longitude: 75.6884375,
      precision: 'plus_code',
      source: 'open-location-code'
    }))
  })

  it('refuses invalid and short Plus Codes instead of guessing a nearby reference', () => {
    expect(validateAddress({ country_code: 'IND', plus_code: 'NOT+A+CODE' }, format).filter((problem) => problem.field === 'plus_code'))
      .toEqual([expect.objectContaining({ field: 'plus_code', code: 'plus_code' })])
    expect(validateAddress({ country_code: 'IND', plus_code: '2M8Q+P9' }, format).filter((problem) => problem.field === 'plus_code'))
      .toEqual([expect.objectContaining({ field: 'plus_code', code: 'plus_code' })])
  })

  it('exports Plus Code as a FHIR extension without dropping sorting code', () => {
    const resource = toFhirAddress({
      country_code: 'IND', plus_code: '7J3Q2M8Q+P9', sorting_code: 'ROUTE-1'
    })
    expect(resource?.extension).toEqual([
      expect.objectContaining({ valueString: 'ROUTE-1' }),
      expect.objectContaining({ valueString: '7J3Q2M8Q+P9' })
    ])
  })
})
