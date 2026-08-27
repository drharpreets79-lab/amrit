// @vitest-environment node

import { describe, expect, it } from 'vitest'

import { withCountryProfile } from '../src/main/active-profile'
import { adminFieldsForProfile } from '../src/main/one-health-engine'
import { animuseProduct, glassProduct } from '../src/main/one-health-exporters'
import { availableBreakpointSources, breakpointSource, normalizeDate, normalizeDigits } from '../src/main/services'
import { indiaProfile, testlandProfile } from './helpers/profile'

/**
 * Phase 2 gate: the same code must behave correctly for a country that is not India,
 * while India's own behaviour is unchanged.
 */
describe('country generalization', () => {
  describe('One Health administrative fields', () => {
    it('numbers the levels and takes only the labels from the country', () => {
      const fields = adminFieldsForProfile(indiaProfile)
      // Keys are level-numbered everywhere. Only the label is India's.
      expect(fields.map((field) => field.key)).toEqual(['admin1_code', 'admin2_code'])
      expect(fields.map((field) => field.label)).toEqual(['State / UT (LGD)', 'District (LGD)'])
      // These stay optional: many events are national or aggregate.
      expect(fields.every((field) => field.required)).toBe(false)
    })

    it('renders a third level with the same key scheme as the first two', () => {
      const fields = adminFieldsForProfile(testlandProfile)
      expect(fields.map((field) => field.key)).toEqual(['admin1_code', 'admin2_code', 'admin3_code'])
      expect(fields[0]?.label).toBe('محافظة (ISO3166-2)')
      expect(fields[2]?.label).toBe('ناحية (GeoNames)')
    })

    it('emits no administrative fields for a country with no subdivisions', () => {
      expect(adminFieldsForProfile({ ...indiaProfile, admin_levels: [] })).toEqual([])
    })
  })

  describe('WOAH ANIMUSE export', () => {
    const animalEvent = {
      facility_id: 'VET-1',
      observed_at: '2026-02-01T00:00:00.000Z',
      payload: { host_species: 'Poultry', quantity_mg: 500 }
    }

    it('reports the profile country instead of a hardcoded IND', () => {
      const india = animuseProduct([animalEvent], indiaProfile.country_code)
      expect(india).toMatchObject({ records: [{ country: 'IND', species: 'Poultry' }] })

      const testland = animuseProduct([animalEvent], testlandProfile.country_code)
      expect(testland).toMatchObject({ records: [{ country: 'TST', species: 'Poultry' }] })
    })

    it('takes the country from the active profile when none is passed', () => {
      const product = withCountryProfile(testlandProfile, () => animuseProduct([animalEvent]))
      expect(product).toMatchObject({ records: [{ country: 'TST' }] })
    })

    it('leaves the GLASS profile string untouched', () => {
      expect(glassProduct([animalEvent])).toMatchObject({ profile: 'WHO-GLASS-compatible/1.0' })
    })
  })

  describe('date parsing', () => {
    it('reads an ambiguous date according to the profile', () => {
      // 03/04/2026 is 3 April in India and 4 March in the United States.
      expect(normalizeDate('03/04/2026', 'DMY')).toBe('2026-04-03')
      expect(normalizeDate('03/04/2026', 'MDY')).toBe('2026-03-04')
      expect(normalizeDate('2026/03/04', 'YMD')).toBe('2026-03-04')
    })

    it('keeps ISO input and unambiguous four-digit years stable in every order', () => {
      for (const order of ['DMY', 'MDY', 'YMD'] as const) {
        expect(normalizeDate('2026-03-04', order)).toBe('2026-03-04')
        expect(normalizeDate('2026-3-4', order)).toBe('2026-03-04')
      }
    })

    it('preserves the existing India behaviour through the active profile', () => {
      const parsed = withCountryProfile(indiaProfile, () => normalizeDate('15/08/2026'))
      expect(parsed).toBe('2026-08-15')
    })

    it('accepts non-Latin digits rather than rejecting them as invalid', () => {
      // Arabic-Indic and Devanagari digits are what a user in those locales actually types.
      expect(normalizeDigits('٢٠٢٦-٠٣-٠٤')).toBe('2026-03-04')
      expect(normalizeDate('٢٠٢٦-٠٣-٠٤', 'DMY')).toBe('2026-03-04')
      expect(normalizeDate('०४/०३/२०२६', 'DMY')).toBe('2026-03-04')
    })

    it('still rejects an unparseable value', () => {
      expect(normalizeDate('not a date', 'DMY')).toBe('')
      expect(normalizeDate('', 'DMY')).toBe('')
    })
  })

  describe('breakpoint guideline sources', () => {
    it('offers the profile\'s bodies with its default first', () => {
      withCountryProfile(indiaProfile, () => {
        expect(availableBreakpointSources()).toEqual(['CLSI', 'EUCAST'])
      })
    })

    it('offers a EUCAST-only country only EUCAST', () => {
      // Previously the only route to breakpoints was CLSI, a paid standard, so such a
      // laboratory had no way to obtain them at all.
      withCountryProfile(testlandProfile, () => {
        expect(availableBreakpointSources()).toEqual(['EUCAST'])
        expect(breakpointSource().label).toBe('EUCAST')
        expect(breakpointSource().links.toolkit).toContain('eucast.org')
      })
    })

    it('states each body\'s licence position, because one is free and one is not', () => {
      expect(breakpointSource('EUCAST').licence).toMatch(/free of charge/i)
      expect(breakpointSource('CLSI').licence).toMatch(/licence/i)
    })

    it('falls back to a usable body rather than nothing when the profile names none', () => {
      const noGuidelines = { ...indiaProfile, guidelines: undefined }
      withCountryProfile(noGuidelines, () => {
        expect(availableBreakpointSources().length).toBeGreaterThan(0)
      })
    })
  })
})
