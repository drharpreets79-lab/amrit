import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { isoFallbackPack } from './geo-pack'
import type { AdminLevelDefinition, CountryProfile } from '../shared/types'

/**
 * Country profile registry.
 *
 * The profile is the single source of country-varying behaviour. Nothing here changes
 * behaviour on its own — callers adopt it phase by phase (docs/globalization/PLAN.md).
 *
 * Resolution order, most specific first:
 *   1. A curated profile in resources/shared/country-profiles/<PROFILE_ID>.json
 *   2. A profile synthesized from the checked-in ISO 3166-1 + CLDR reference, so every
 *      country works with nothing authored
 *   3. _default.json
 *
 * profile.schema.json is the contract. The zod schema below mirrors it for runtime use
 * because the app ships no JSON-Schema validator; a test asserts every curated profile
 * satisfies both, so the two cannot drift silently.
 */

/**
 * Stated wherever SNOMED codes are surfaced. Member status belongs to the country, not to
 * this software, so the notice names the obligation rather than asserting an answer.
 */
export const SNOMED_LICENCE_NOTICE =
  'Requires a SNOMED CT licence: free in a SNOMED International Member country, an affiliate licence elsewhere. This software grants no licence; establish your position before relying on these codes.'

const SHARED_DIRECTORY = 'shared/country-profiles'
const FALLBACK_PROFILE_ID = '_default'

export const ADMIN_LEVEL_KEY = /^[a-z][a-z0-9_]*$/
const URN_PREFIX = /^urn:[a-z0-9][a-z0-9-]*(:[a-z0-9][a-z0-9-]*)*$/
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/

const adminLevelSchema = z.strictObject({
  level: z.number().int().min(1).max(6),
  key: z.string().regex(ADMIN_LEVEL_KEY),
  label: z.string().min(1),
  label_plural: z.string().min(1),
  code_system: z.string().min(1),
  required: z.boolean().optional().default(false)
})

export const countryProfileSchema = z.strictObject({
  schema_version: z.literal(1),
  profile_id: z.string().regex(/^[A-Z0-9_]+$/),
  source: z.enum(['curated', 'synthesized', 'fallback']).optional(),

  country_code: z.string().regex(/^[A-Z]{3}$/),
  country_code_2: z.string().regex(/^[A-Z]{2}$/).optional(),
  country_name: z.string().min(1),
  who_region: z.string().nullable().optional(),

  locale: z.string().min(2).optional(),
  fallback_locales: z.array(z.string()).optional(),
  text_direction: z.enum(['ltr', 'rtl']).optional(),
  numbering_system: z.string().optional(),
  timezone: z.string().nullable().optional(),
  timezone_ambiguous: z.boolean().optional(),
  calendar: z
    .enum(['gregory', 'buddhist', 'ethiopic', 'islamic', 'islamic-umalqura', 'nepali', 'persian', 'roc'])
    .optional(),
  date_input_order: z.enum(['DMY', 'MDY', 'YMD']).optional(),
  first_day_of_week: z.number().int().min(1).max(7).optional(),
  epi_week_system: z.enum(['iso', 'mmwr']).optional(),
  fiscal_year_start_month: z.number().int().min(1).max(12).optional(),

  admin_levels: z.array(adminLevelSchema).max(6),

  identifier_namespace: z
    .strictObject({
      base_uri: z.string().url().startsWith('https://'),
      urn_prefix: z.string().regex(URN_PREFIX)
    })
    .optional(),

  branding: z
    .strictObject({
      product_name: z.string().min(1),
      app_id: z.string().optional(),
      authority_name: z.string().min(1),
      logo: z.string().nullable().optional(),
      logo_reverse: z.string().nullable().optional(),
      colors: z.record(z.string(), z.string().regex(HEX_COLOR)).optional()
    })
    .optional(),

  guidelines: z
    .strictObject({
      default: z.string().min(1),
      available: z.array(z.string()).min(1),
      national_body: z.string().nullable().optional()
    })
    .optional(),

  code_systems: z
    .record(
      z.string(),
      z.strictObject({ enabled: z.boolean(), licence: z.string().nullable().optional() })
    )
    .optional(),

  banned_identifier_keys: z.array(z.string()).optional(),

  privacy: z
    .strictObject({
      k_anonymity_floor: z.number().int().min(1).optional(),
      patient_postal_code_digits: z.number().int().min(0).nullable().optional(),
      retention_days: z.number().int().min(1).nullable().optional(),
      residency_note: z.string().nullable().optional()
    })
    .optional(),

  map: z
    .strictObject({
      center: z.tuple([z.number(), z.number()]).nullable().optional(),
      zoom: z.number().min(0).max(20).optional(),
      tile_url: z.string().nullable().optional()
    })
    .optional(),

  reporting_frameworks: z.array(z.string()).optional()
})

/**
 * The interface in shared/types.ts is what the renderer sees; the zod schema above is
 * the runtime guard. This assertion fails to compile if the two drift, so the mirror
 * cannot rot silently. profile.schema.json remains the cross-product contract, and the
 * Python suite validates the same curated files against it.
 */
type SchemaMatchesSharedType = z.infer<typeof countryProfileSchema> extends CountryProfile
  ? true
  : never
const _schemaMatchesSharedType: SchemaMatchesSharedType = true
void _schemaMatchesSharedType

export type { AdminLevelDefinition, CountryProfile }

export interface CountryReferenceEntry {
  alpha3: string
  alpha2: string
  name: string
  who_region: string | null
  entry_type: 'country' | 'organization'
  iso3166_1: boolean
  locale: string
  timezone: string | null
  timezone_ambiguous: boolean
  timezones: string[]
  first_day_of_week: number
  numbering_system: string
  text_direction: 'ltr' | 'rtl'
  date_input_order: 'DMY' | 'MDY' | 'YMD'
}

/** Mirrors the resolution used for the packaged catalogue in catalog-seed.ts. */
function candidatePaths(relative: string): string[] {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url))
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  return [
    resourcesPath ? resolve(resourcesPath, 'resources', relative) : '',
    resolve(process.cwd(), 'resources', relative),
    resolve(moduleDirectory, '../../resources', relative)
  ].filter(Boolean)
}

function readSharedJson<T>(relative: string): T | null {
  for (const candidate of candidatePaths(`${SHARED_DIRECTORY}/${relative}`)) {
    if (existsSync(candidate)) return JSON.parse(readFileSync(candidate, 'utf8')) as T
  }
  return null
}

let referenceCache: Map<string, CountryReferenceEntry> | null = null

function reference(): Map<string, CountryReferenceEntry> {
  if (referenceCache) return referenceCache
  const payload = readSharedJson<{ countries: CountryReferenceEntry[] }>('reference/countries.json')
  if (!payload) throw new Error('Country reference data is missing from the shared bundle.')
  referenceCache = new Map(payload.countries.map((entry) => [entry.alpha3, entry]))
  return referenceCache
}

/** Selectable countries, sorted by name. Excludes the WHO/FAO organisation entries. */
export function availableCountries(options: { isoOnly?: boolean } = {}): CountryReferenceEntry[] {
  return [...reference().values()]
    .filter((entry) => entry.entry_type === 'country')
    .filter((entry) => !options.isoOnly || entry.iso3166_1)
    .sort((left, right) => left.name.localeCompare(right.name))
}

/** Accept an alpha-2 or alpha-3 code in any case and return the alpha-3. */
export function resolveCountryCode(value: string): string | null {
  const candidate = (value ?? '').trim().toUpperCase()
  if (reference().has(candidate)) return candidate
  for (const entry of reference().values()) {
    if (entry.alpha2 === candidate) return entry.alpha3
  }
  return null
}

/**
 * Build a valid profile for any ISO 3166-1 country with nothing authored.
 *
 * Locale, direction, numbering system, time zone and date order come from the
 * checked-in CLDR-derived reference. The hierarchy is a single ISO 3166-2 level with a
 * generic label; Phase 3 refines the label from the subdivision category, and a
 * deployment can add deeper levels through the importer.
 */
export function synthesizeProfile(countryCode: string): CountryProfile {
  const alpha3 = resolveCountryCode(countryCode)
  if (!alpha3) throw new Error(`Unknown country code: ${countryCode}`)
  const entry = reference().get(alpha3)
  if (!entry) throw new Error(`Unknown country code: ${countryCode}`)
  if (entry.entry_type !== 'country') throw new Error(`${alpha3} is an organisation, not a country.`)

  return countryProfileSchema.parse({
    schema_version: 1,
    profile_id: alpha3,
    source: 'synthesized',
    country_code: alpha3,
    country_code_2: entry.alpha2,
    country_name: entry.name,
    who_region: entry.who_region,
    locale: entry.locale,
    fallback_locales: ['en'],
    text_direction: entry.text_direction,
    numbering_system: entry.numbering_system,
    timezone: entry.timezone,
    timezone_ambiguous: entry.timezone_ambiguous,
    calendar: 'gregory',
    date_input_order: entry.date_input_order,
    first_day_of_week: entry.first_day_of_week,
    epi_week_system: 'iso',
    fiscal_year_start_month: 1,
    admin_levels: isoAdminLevels(alpha3),
    // .invalid is reserved (RFC 2606) and is the honest value for "not yet set". It makes
    // an unconfigured namespace obvious in exported FHIR rather than silently borrowing
    // another country's identifiers.
    identifier_namespace: {
      base_uri: 'https://amrit.invalid',
      urn_prefix: `urn:amrit:${entry.alpha2.toLowerCase()}`
    },
    branding: {
      product_name: 'AMRIT',
      authority_name: entry.name,
      logo: null,
      logo_reverse: null,
      colors: {}
    },
    guidelines: { default: 'EUCAST', available: ['EUCAST', 'CLSI'], national_body: null },
    // SNOMED CT ships enabled; the licence position is recorded and surfaced to the
    // administrator rather than silently disabling a vocabulary they may be entitled to.
    code_systems: { snomed: { enabled: true, licence: SNOMED_LICENCE_NOTICE } },
    banned_identifier_keys: [],
    privacy: { k_anonymity_floor: 5, retention_days: null, residency_note: null, patient_postal_code_digits: 3 },
    map: { center: null, zoom: 4, tile_url: null },
    reporting_frameworks: ['GLASS']
  })
}

const GENERIC_ADMIN_LEVEL: AdminLevelDefinition = {
  level: 1,
  key: 'admin1',
  label: 'Administrative area',
  label_plural: 'Administrative areas',
  code_system: 'ISO3166-2',
  required: false
}

/**
 * Levels named after the subdivision type ISO records for this country.
 *
 * A country whose subdivisions ISO calls Governorates should read "Governorate", not a
 * generic placeholder. Countries with no ISO subdivisions keep the generic level, so the
 * shape of a profile never varies.
 */
function isoAdminLevels(alpha3: string): AdminLevelDefinition[] {
  try {
    const pack = isoFallbackPack(alpha3)
    if (!pack) return [{ ...GENERIC_ADMIN_LEVEL }]
    return pack.levels.map((level) => ({
      level: Number(level.level),
      key: String(level.key),
      label: String(level.label),
      label_plural: String(level.label_plural),
      code_system: String(level.code_system ?? 'ISO3166-2'),
      required: false
    }))
  } catch {
    // A profile must resolve even if the pack is missing or unreadable.
    return [{ ...GENERIC_ADMIN_LEVEL }]
  }
}

export function curatedProfileIds(): string[] {
  for (const candidate of candidatePaths(SHARED_DIRECTORY)) {
    if (!existsSync(candidate)) continue
    return readdirSync(candidate)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .filter((name) => name !== 'profile.schema' && !name.startsWith('_'))
      .sort()
  }
  return []
}

function loadCurated(profileId: string): CountryProfile | null {
  const raw = readSharedJson<unknown>(`${profileId}.json`)
  return raw ? countryProfileSchema.parse(raw) : null
}

const profileCache = new Map<string, CountryProfile>()

/**
 * Resolve the active profile.
 *
 * A desktop install serves one laboratory and therefore one country. `requested` comes
 * from AMRIT_COUNTRY_PROFILE, or from the app_preferences key `country_profile_id` that
 * the caller passes in; the database is not read here so this stays usable before the
 * database is open.
 */
export function getCountryProfile(requested?: string | null): CountryProfile {
  const key = (requested ?? process.env.AMRIT_COUNTRY_PROFILE ?? '').trim()
  const cached = profileCache.get(key)
  if (cached) return cached

  let profile: CountryProfile | null = null
  if (key) {
    profile = loadCurated(key.toUpperCase())
    if (!profile) {
      const alpha3 = resolveCountryCode(key)
      if (alpha3) {
        for (const profileId of curatedProfileIds()) {
          const candidate = loadCurated(profileId)
          if (candidate && candidate.country_code === alpha3) {
            profile = candidate
            break
          }
        }
        if (!profile) profile = synthesizeProfile(alpha3)
      }
    }
    if (!profile) {
      throw new Error(
        `No curated profile named "${key}" and it is not an ISO 3166-1 country code.`
      )
    }
  } else {
    const fallback = readSharedJson<unknown>(`${FALLBACK_PROFILE_ID}.json`)
    if (!fallback) throw new Error('Fallback country profile is missing from the shared bundle.')
    profile = countryProfileSchema.parse(fallback)
  }

  profileCache.set(key, profile)
  return profile
}

export function adminLevel(profile: CountryProfile, level: number): AdminLevelDefinition | null {
  return profile.admin_levels.find((definition) => definition.level === level) ?? null
}

/** Drop cached profiles and reference data. Call after a profile changes. */
export function clearCountryProfileCache(): void {
  profileCache.clear()
  referenceCache = null
}
