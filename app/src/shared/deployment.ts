import type { CountryProfile } from './types'

/**
 * The fields an administrator may change at runtime.
 *
 * Shared deliberately: the main process refuses anything outside this set, and the settings
 * screen builds its form from it. Two lists would drift, and the drift would show up as a
 * field the operator can edit and the main process silently rejects.
 *
 * Everything absent is either derived from the country code or fixed when the application is
 * built and signed — `app_id` and the code-signing identity cannot be changed by editing a
 * running installation, whatever the UI offers.
 */
export const EDITABLE_PROFILE_FIELDS = [
  'country_name', 'locale', 'fallback_locales', 'text_direction', 'numbering_system',
  'timezone', 'calendar', 'date_input_order', 'first_day_of_week', 'epi_week_system',
  'fiscal_year_start_month', 'admin_levels', 'identifier_namespace', 'branding',
  'guidelines', 'code_systems', 'banned_identifier_keys', 'privacy', 'map',
  'reporting_frameworks'
] as const

export type EditableProfileField = (typeof EDITABLE_PROFILE_FIELDS)[number]

/** Changing these cannot be undone for data already exported. */
export const IRREVERSIBLE_PROFILE_FIELDS = ['identifier_namespace'] as const

/** A bundled logo is a filename inside the read-only app resources; an uploaded one is a data URI. */
export function logoSource(logo: string | null | undefined): string | null {
  if (!logo) return null
  return logo.startsWith('data:') ? logo : `./resources/${logo}`
}

/**
 * Turn an edited profile back into an override document.
 *
 * Only fields the operator actually changed are written, so everything left alone keeps
 * following the base profile and picks up its future corrections. Overrides already stored
 * are carried through untouched — reverting one is an explicit action, not a side effect of
 * saving something else.
 */
export function overridesFor(
  stored: Record<string, unknown>,
  loaded: CountryProfile,
  draft: CountryProfile
): Record<string, unknown> {
  const next = { ...stored }
  for (const field of EDITABLE_PROFILE_FIELDS) {
    if (JSON.stringify(draft[field]) !== JSON.stringify(loaded[field])) next[field] = draft[field]
  }
  return next
}

/** Named so the settings screen can explain *why* a value is not on the form. */
export const BUILD_TIME_FIELDS: Array<{ label: string; reason: string }> = [
  {
    label: 'Application id',
    reason: 'Identifies the installed bundle to the operating system, and is fixed when the application is packaged.'
  },
  {
    label: 'Code-signing identity',
    reason: 'Belongs to whoever signs and distributes the build; a running installation cannot re-sign itself.'
  },
  {
    label: 'Installer filename and protocol handlers',
    reason: 'Registered with the operating system at install time.'
  }
]
