import type { CountryProfile } from '../../src/shared/types'

/**
 * Country profiles for renderer tests.
 *
 * Defined inline rather than loaded through src/main/country-profile.ts, which reads the
 * filesystem and is main-process only. The shapes mirror shared/country-profiles/IN.json
 * and TESTLAND.json; src/main/country-profile.test coverage validates the real files.
 */
export const indiaProfile: CountryProfile = {
  schema_version: 1,
  profile_id: 'IN',
  source: 'curated',
  country_code: 'IND',
  country_code_2: 'IN',
  country_name: 'India',
  who_region: 'SEARO',
  locale: 'en-IN',
  text_direction: 'ltr',
  numbering_system: 'latn',
  timezone: 'Asia/Kolkata',
  date_input_order: 'DMY',
  epi_week_system: 'iso',
  fiscal_year_start_month: 4,
  admin_levels: [
    { level: 1, key: 'state', label: 'State / UT', label_plural: 'States & UTs', code_system: 'LGD', required: true },
    { level: 2, key: 'district', label: 'District', label_plural: 'Districts', code_system: 'LGD', required: false }
  ],
  identifier_namespace: { base_uri: 'https://amrit.icmr.gov.in', urn_prefix: 'urn:icmr:amrit' },
  branding: { product_name: 'ICMR AMRIT', authority_name: 'Indian Council of Medical Research' },
  guidelines: { default: 'CLSI', available: ['CLSI', 'EUCAST'], national_body: 'ICMR' }
}

/** Three levels, right-to-left, non-Latin digits — the generalization gate. */
export const testlandProfile: CountryProfile = {
  schema_version: 1,
  profile_id: 'TESTLAND',
  source: 'curated',
  country_code: 'TST',
  country_code_2: 'TS',
  country_name: 'تستلاند (Testland)',
  who_region: 'EMRO',
  locale: 'ar',
  text_direction: 'rtl',
  numbering_system: 'arab',
  timezone: 'Asia/Baghdad',
  date_input_order: 'DMY',
  epi_week_system: 'mmwr',
  fiscal_year_start_month: 10,
  admin_levels: [
    { level: 1, key: 'governorate', label: 'محافظة', label_plural: 'المحافظات', code_system: 'ISO3166-2', required: true },
    { level: 2, key: 'district', label: 'قضاء', label_plural: 'الأقضية', code_system: 'GeoNames', required: true },
    { level: 3, key: 'subdistrict', label: 'ناحية', label_plural: 'النواحي', code_system: 'GeoNames', required: false }
  ],
  identifier_namespace: { base_uri: 'https://amr.testland.example', urn_prefix: 'urn:testland:amr' },
  branding: { product_name: 'AMR Testland', authority_name: 'وزارة الصحة' },
  guidelines: { default: 'EUCAST', available: ['EUCAST'], national_body: null }
}
