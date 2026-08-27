import { describe, expect, it } from 'vitest'
import {
  adminLevel,
  availableCountries,
  clearCountryProfileCache,
  countryProfileSchema,
  curatedProfileIds,
  getCountryProfile,
  resolveCountryCode,
  synthesizeProfile
} from '../src/main/country-profile'

describe('country profile registry', () => {
  it('offers every ISO 3166-1 country and excludes organisation entries', () => {
    const selectable = availableCountries()
    const iso = availableCountries({ isoOnly: true })

    // The underlying WHONET country code set carries WHO and FAO, which are not countries.
    expect(selectable.some((entry) => entry.alpha3 === 'WHO')).toBe(false)
    expect(selectable.some((entry) => entry.alpha3 === 'FAO')).toBe(false)
    // Kosovo is user-assigned (XK/XKX), usable but not ISO 3166-1.
    expect(selectable.some((entry) => entry.alpha3 === 'XKX')).toBe(true)
    expect(iso.some((entry) => entry.alpha3 === 'XKX')).toBe(false)

    expect(iso).toHaveLength(249)
    expect(selectable).toHaveLength(250)
  })

  it('synthesizes a valid profile for every selectable country', () => {
    const failures: string[] = []
    for (const entry of availableCountries()) {
      try {
        countryProfileSchema.parse(synthesizeProfile(entry.alpha3))
      } catch (error) {
        failures.push(`${entry.alpha3}: ${(error as Error).message}`)
      }
    }
    expect(failures).toEqual([])
  })

  it('refuses to synthesize a profile for an organisation entry', () => {
    expect(() => synthesizeProfile('WHO')).toThrow(/organisation, not a country/)
  })

  it('resolves alpha-2 and alpha-3 codes in any case', () => {
    expect(resolveCountryCode('in')).toBe('IND')
    expect(resolveCountryCode('IND')).toBe('IND')
    expect(resolveCountryCode('ng')).toBe('NGA')
    expect(resolveCountryCode('ZZ')).toBeNull()
  })

  it('carries CLDR-derived locale defaults that differ by country', () => {
    const byCode = new Map(availableCountries().map((entry) => [entry.alpha3, entry]))

    // The day-first assumption in normalizeDate is wrong for the United States.
    expect(byCode.get('USA')?.date_input_order).toBe('MDY')
    expect(byCode.get('IND')?.date_input_order).toBe('DMY')

    // Countries spanning several zones must not take a country-level default.
    expect(byCode.get('USA')?.timezone_ambiguous).toBe(true)
    expect(byCode.get('USA')?.timezone).toBeNull()
    expect(byCode.get('IND')?.timezone).toBe('Asia/Kolkata')

    // Non-Latin digits must be normalised on input, not rejected.
    expect(byCode.get('NPL')?.numbering_system).toBe('deva')
    expect(byCode.get('EGY')?.text_direction).toBe('rtl')
  })

  it('loads the curated India profile and prefers it over synthesis', () => {
    clearCountryProfileCache()
    expect(curatedProfileIds()).toContain('IN')

    for (const requested of ['IN', 'IND', 'in']) {
      const profile = getCountryProfile(requested)
      expect(profile.profile_id).toBe('IN')
      expect(profile.source).toBe('curated')
      expect(profile.country_code).toBe('IND')
      expect(adminLevel(profile, 1)?.label).toBe('State / UT')
      expect(adminLevel(profile, 2)?.label).toBe('District')
      expect(adminLevel(profile, 1)?.code_system).toBe('LGD')
      expect(profile.identifier_namespace?.urn_prefix).toBe('urn:icmr:amrit')
    }
  })

  it('loads the three-level right-to-left test profile', () => {
    const profile = getCountryProfile('TESTLAND')
    expect(profile.admin_levels).toHaveLength(3)
    expect(profile.text_direction).toBe('rtl')
    expect(profile.numbering_system).toBe('arab')
    expect(profile.epi_week_system).toBe('mmwr')
    expect(profile.fiscal_year_start_month).toBe(10)
  })

  it('synthesizes for a country with no curated profile', () => {
    const profile = getCountryProfile('NGA')
    expect(profile.source).toBe('synthesized')
    expect(profile.country_code).toBe('NGA')
    expect(profile.admin_levels).toHaveLength(1)
    expect(profile.admin_levels[0]?.code_system).toBe('ISO3166-2')
    // An unset namespace must be obvious rather than borrowing another country's.
    expect(profile.identifier_namespace?.base_uri).toBe('https://amrit.invalid')
    // SNOMED ships enabled; the licence obligation is recorded and surfaced rather than
    // silently disabling a vocabulary the deployment may be entitled to use.
    expect(profile.code_systems?.snomed?.enabled).toBe(true)
    expect(profile.code_systems?.snomed?.licence).toMatch(/licence/i)
  })

  it('falls back when nothing is configured, and rejects an unknown request', () => {
    clearCountryProfileCache()
    const fallback = getCountryProfile('')
    expect(fallback.profile_id).toBe('DEFAULT')
    expect(fallback.source).toBe('fallback')

    expect(() => getCountryProfile('NOT_A_COUNTRY')).toThrow(/not an ISO 3166-1 country code/)
  })

  it('accepts every curated profile under the runtime schema', () => {
    for (const profileId of curatedProfileIds()) {
      expect(() => countryProfileSchema.parse(getCountryProfile(profileId))).not.toThrow()
    }
  })
})
