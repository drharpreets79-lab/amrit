/**
 * One postal address shape for every country.
 *
 * A laboratory used to be located by a `state_lgd_code`, a `district_lgd_code` and one
 * free-text blob. That is India's model with India's codes; it cannot say where a building
 * is in Japan, Ireland or the United Arab Emirates. This module replaces it with the
 * ISO 19160-1 / libaddressinput field set, driven by a per-country format pack, so the
 * same stored shape and the same form work everywhere.
 *
 * Two different questions are deliberately kept apart:
 *
 *   - *which reporting unit is this under* — the AdminUnit tree, `admin_unit_id`, and what
 *     every scope filter matches on;
 *   - *how is an address written here* — everything else in this module.
 *
 * They are joined by `admin_area_code` (ISO 3166-2) and never conflated, because a
 * facility's postal town and its reporting district are frequently not the same place.
 *
 * Everything here is pure. The main process loads the pack; the renderer receives a
 * `CountryAddressFormat` over IPC and calls these functions directly, so the form
 * validates as the user types without a round trip.
 */

import { GEO_PRECISIONS, isAtLeastAsPrecise, type GeoPoint } from './geo-directory.js'
import { normalizePlusCode, plusCodeProblem, pointFromPlusCode } from './open-location-code.js'

export type { GeoPoint }

/** Fields in the order a form renders them when the country has no format string. */
export const ADDRESS_FIELD_ORDER = [
  'recipient',
  'organization',
  'address_lines',
  'dependent_locality',
  'locality',
  'admin_area',
  'postal_code',
  'sorting_code'
] as const

export type AddressField = (typeof ADDRESS_FIELD_ORDER)[number]

/** Fields this software stores. `recipient` is not one of them: these are the addresses of
 * facilities, and an attention line is a place for a person's name to end up. */
export const STORED_ADDRESS_FIELDS: AddressField[] = ADDRESS_FIELD_ORDER.filter(
  (field) => field !== 'recipient'
) as AddressField[]

/** The four fields whose local name varies by country, and what each is called by default. */
export type LabelledAddressField = 'admin_area' | 'locality' | 'dependent_locality' | 'postal_code'

export interface CountryAddressFormat {
  alpha2: string
  /** Tokens: %N %O %A %D %C %S %Z %X, and %n for a line break. Literal text is kept. */
  format: string
  latin_format: string | null
  /** Every field this country places or requires. A field absent here has nowhere to go. */
  fields: AddressField[]
  required: AddressField[]
  uppercase: AddressField[]
  /** e.g. `{ admin_area: 'emirate', postal_code: 'eircode' }`. Always complete. */
  labels: Record<LabelledAddressField, string>
  postal_code_pattern: string | null
  postal_code_examples: string[]
  postal_code_prefix: string | null
  language: string | null
  languages: string[]
  postal_authority_url: string | null
  /** ISO 3166-2 codes of the level-1 subdivisions, where the standard covers them. */
  admin_area_iso_codes: string[]
}

export interface AddressFormatPack {
  dataset: string
  version: string
  schema_version: number
  field_order: AddressField[]
  /** Used by any country the pack has no entry for, so an address form always renders. */
  default: CountryAddressFormat
  countries: Record<string, CountryAddressFormat>
  checksum: string
}

export interface PostalAddress {
  /** ISO 3166-1 alpha-3. The only field every country has, and the key into the pack. */
  country_code: string
  address_lines?: string[]
  dependent_locality?: string
  locality?: string
  admin_area?: string
  /** ISO 3166-2. The join to the administrative tree, so the two cannot disagree. */
  admin_area_code?: string
  postal_code?: string
  /** Full Google Open Location Code. Facilities only; decoded locally without a web API. */
  plus_code?: string
  sorting_code?: string
  organization?: string
  /** BCP 47 tag of the script the address is written in. */
  language_code?: string
  admin_unit_id?: string | null
  /**
   * Where this address is, when the geographic directory could work it out.
   *
   * Facilities only. `PatientResidence` has no such field and must never gain one: a
   * patient's postal code is already coarsened by `privacy.patient_postal_code_digits`,
   * and attaching a coordinate would undo exactly what that setting exists to do.
   *
   * Always carries its own precision, because a subdivision centroid and a postal-code
   * centre are not interchangeable and a map that treats them as though they were is
   * worse than a map with a gap in it.
   */
  geo_point?: GeoPoint
  /** Derived; recomputed whenever a component changes. Never authoritative. */
  formatted?: string
}

const TOKEN_FIELD: Record<string, AddressField> = {
  N: 'recipient',
  O: 'organization',
  A: 'address_lines',
  D: 'dependent_locality',
  C: 'locality',
  S: 'admin_area',
  Z: 'postal_code',
  X: 'sorting_code'
}

/** Fields that are always acceptable, whatever the country's format places. */
const UNIVERSAL_FIELDS = new Set<AddressField>(['address_lines', 'organization'])

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** Every field that holds a single string, so it can be read and written by name. */
export type AddressComponentField = Exclude<AddressField, 'recipient' | 'address_lines'>

/**
 * The value a token stands for, as text. `address_lines` is the only multi-line one, and
 * it keeps its own line breaks rather than being flattened.
 */
export function valueFor(field: AddressField, address: PostalAddress): string {
  if (field === 'address_lines') {
    return (address.address_lines ?? []).map(text).filter(Boolean).join('\n')
  }
  if (field === 'recipient') return ''
  return text(address[field])
}

/** Set or clear one field, returning a new address. Empty clears rather than storing "". */
export function withAddressField(address: PostalAddress, field: AddressField, value: string): PostalAddress {
  const next: PostalAddress = { ...address }
  if (field === 'recipient') return next
  if (field === 'address_lines') {
    const lines = value.split('\n').map((line) => line.trim()).filter(Boolean)
    if (lines.length) next.address_lines = lines
    else delete next.address_lines
    return next
  }
  const trimmed = value.trim()
  if (trimmed) next[field] = trimmed
  else delete next[field]
  return next
}

/**
 * Preserve a country-incompatible structured component as an ordinary address line.
 *
 * Imported records and country changes can leave a value in a field that the new country's
 * format cannot render. The value must not remain hidden (where validation blocks saving),
 * and it must not be deleted. Moving it into `%A` follows libaddressinput's own remedy and
 * keeps the address printable. An existing identical line is reused rather than duplicated.
 */
export function moveUnsupportedFieldToAddressLines(
  address: PostalAddress,
  field: AddressField,
  format: CountryAddressFormat
): PostalAddress {
  if (field === 'recipient' || UNIVERSAL_FIELDS.has(field) || format.fields.includes(field)) {
    return normalizeAddress(address, format)
  }
  const value = valueFor(field, address)
  if (!value) return normalizeAddress(address, format)

  const lines = (address.address_lines ?? []).map(text).filter(Boolean)
  const key = value.toLocaleLowerCase()
  if (!lines.some((line) => line.toLocaleLowerCase() === key)) lines.push(value)

  let next = withAddressField(address, 'address_lines', lines.join('\n'))
  next = withAddressField(next, field, '')
  return normalizeAddress(next, format)
}

/** Losslessly repair every populated component the selected country cannot print. */
export function repairUnsupportedAddressFields(
  address: PostalAddress,
  format: CountryAddressFormat
): PostalAddress {
  let repaired = address
  for (const field of STORED_ADDRESS_FIELDS) {
    if (!valueFor(field, repaired) || format.fields.includes(field) || UNIVERSAL_FIELDS.has(field)) continue
    repaired = moveUnsupportedFieldToAddressLines(repaired, field, format)
  }
  return normalizeAddress(repaired, format)
}

function applyUppercase(field: AddressField, value: string, format: CountryAddressFormat): string {
  return format.uppercase.includes(field) ? value.toLocaleUpperCase() : value
}

/**
 * Tidy what token substitution leaves behind.
 *
 * `%C, %S %Z` with no admin area would otherwise render `Kochi,  682011` — the separator
 * belongs to a field that is not there. Runs of whitespace collapse and orphaned
 * separators at either end are dropped.
 */
function tidy(line: string): string {
  return line
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*,\s*,\s*/g, ', ')
    .replace(/^[\s,\-–]+/, '')
    .replace(/[\s,\-–]+$/, '')
    .trim()
}

/**
 * Render an address using its country's format string.
 *
 * A line whose every field is empty is dropped entirely, including its literal text: a
 * Singapore address with no postal code must not render the bare word `SINGAPORE`. A line
 * with no fields at all is literal and always kept.
 */
export function formatAddress(address: PostalAddress, format: CountryAddressFormat): string {
  const lines: string[] = []
  for (const template of format.format.split('%n')) {
    const tokens = [...template.matchAll(/%([A-Z])/g)].map((match) => match[1] ?? '')
    let rendered = ''
    let anyValue = false
    // Substituted piece by piece rather than by replacement, so the separator that
    // belonged to an absent field goes with it: `%C, %S %Z` with no state renders
    // "Atlanta 30329", not "Atlanta, 30329".
    for (const piece of template.split(/(%[A-Z])/)) {
      if (!piece) continue
      const token = /^%[A-Z]$/.test(piece) ? piece.slice(1) : ''
      if (!token) {
        rendered += piece
        continue
      }
      const field = TOKEN_FIELD[token]
      const value = field ? applyUppercase(field, valueFor(field, address), format) : ''
      if (value) {
        anyValue = true
        rendered += value
      } else {
        rendered = rendered.replace(/[ \t,\-–]+$/, '')
      }
    }
    if (tokens.length > 0 && !anyValue) continue
    // %A can expand to several lines; each is tidied on its own.
    for (const part of rendered.split('\n')) {
      const cleaned = tidy(part)
      if (cleaned) lines.push(cleaned)
    }
  }
  return lines.join('\n')
}

export interface AddressProblem {
  /** These are facility-only additions, not country postal-format fields. */
  field: AddressField | 'country_code' | 'plus_code' | 'geo_point'
  /** `required` · `unsupported` · `postal_code_pattern` · `country_code` · `not_stored` */
  code: string
  message: string
}

/**
 * Anchor a country's postal pattern.
 *
 * The pack's patterns are written to match a whole code, not a substring, so an unanchored
 * test would accept `XX12345XX` for a five-digit country.
 */
function postalCodeMatches(value: string, pattern: string): boolean {
  try {
    return new RegExp(`^(?:${pattern})$`).test(value)
  } catch {
    // A pattern this engine cannot compile must not reject a code the deployment believes
    // is valid; the pack is data, and bad data should not become a data-entry wall.
    return true
  }
}

/**
 * Check an address against its country's rules.
 *
 * Returns problems rather than throwing, so a form can show all of them at once instead of
 * one per submission.
 */
export function validateAddress(address: PostalAddress, format: CountryAddressFormat): AddressProblem[] {
  const problems: AddressProblem[] = []

  if (!/^[A-Z]{3}$/.test(text(address.country_code))) {
    problems.push({
      field: 'country_code',
      code: 'country_code',
      message: 'Country is required, as an ISO 3166-1 alpha-3 code.'
    })
  }

  for (const field of STORED_ADDRESS_FIELDS) {
    const value = valueFor(field, address)
    const label = labelFor(field, format)
    if (!value) {
      if (format.required.includes(field)) {
        problems.push({ field, code: 'required', message: `${label} is required in this country.` })
      }
      continue
    }
    if (!format.fields.includes(field) && !UNIVERSAL_FIELDS.has(field)) {
      // Storing a value the country's format cannot place means it never renders and is
      // never found. Say so at entry rather than losing it quietly.
      problems.push({
        field,
        code: 'unsupported',
        message: `${label} is not part of an address in this country; put it in the street address lines instead.`
      })
      continue
    }
    if (field === 'postal_code' && format.postal_code_pattern && !postalCodeMatches(value, format.postal_code_pattern)) {
      const example = format.postal_code_examples[0]
      problems.push({
        field,
        code: 'postal_code_pattern',
        message: `${label} does not match the format used in this country${example ? ` (for example ${example})` : ''}.`
      })
    }
  }

  const plusProblem = plusCodeProblem(address.plus_code)
  if (plusProblem) {
    problems.push({ field: 'plus_code', code: 'plus_code', message: plusProblem })
  }

  return problems
}

/**
 * The token this country uses for a field: `state`, `prefecture`, `emirate`, `pin`, `zip`,
 * `eircode`, `post_town`, and so on. A stable, closed identifier — not display text.
 *
 * Split out from `labelFor` because it is the translation key. The pack's tokens come from
 * the source dataset in one fixed spelling, so a catalogue can name every one of them; what
 * the operator reads must come from the interface's own language, not from the dataset.
 */
export function labelTokenFor(field: AddressField, format: CountryAddressFormat): string {
  const key = field as LabelledAddressField
  return format.labels[key] || field
}

/**
 * What this country calls a field, in English sentence case.
 *
 * The fallback used wherever there is no translation catalogue to hand — validation
 * messages built in the main process, the server's own rendering, tests. The renderer
 * translates `labelTokenFor` instead, because this returned the dataset's raw lower-case
 * token and put "pin" and "state" on screen as field labels.
 */
export function labelFor(field: AddressField, format: CountryAddressFormat): string {
  const token = labelTokenFor(field, format).replace(/_/g, ' ')
  return token.charAt(0).toUpperCase() + token.slice(1)
}

/** The fields a form should show for this country, in the order the country writes them. */
export function fieldsForForm(format: CountryAddressFormat): AddressField[] {
  const ordered: AddressField[] = []
  for (const match of format.format.matchAll(/%([A-Z])/g)) {
    const field = TOKEN_FIELD[match[1] ?? '']
    if (field && field !== 'recipient' && !ordered.includes(field)) ordered.push(field)
  }
  for (const field of format.fields) {
    if (field !== 'recipient' && !ordered.includes(field)) ordered.push(field)
  }
  return ordered
}

export const isAddressFieldRequired = (field: AddressField, format: CountryAddressFormat): boolean =>
  format.required.includes(field)

/**
 * FHIR R4 `Address`.
 *
 * The mapping is one-to-one by construction — the field set was chosen so it would be —
 * except `sorting_code`, which FHIR has no element for and which therefore travels as an
 * extension rather than being dropped.
 */
export function toFhirAddress(address: PostalAddress, format?: CountryAddressFormat): Record<string, unknown> | null {
  const resource: Record<string, unknown> = {}
  const lines = (address.address_lines ?? []).map(text).filter(Boolean)
  if (lines.length) resource.line = lines
  if (text(address.locality)) resource.city = text(address.locality)
  if (text(address.dependent_locality)) resource.district = text(address.dependent_locality)
  if (text(address.admin_area)) resource.state = text(address.admin_area)
  if (text(address.postal_code)) resource.postalCode = text(address.postal_code)
  if (text(address.country_code)) resource.country = text(address.country_code)

  const rendered = text(address.formatted) || (format ? formatAddress(address, format) : '')
  if (rendered) resource.text = rendered

  const extensions: Array<Record<string, unknown>> = []
  if (text(address.sorting_code)) {
    extensions.push({
        url: 'https://schemas.amrit-amr.org/fhir/StructureDefinition/address-sorting-code',
        valueString: text(address.sorting_code)
    })
  }
  if (text(address.plus_code)) {
    extensions.push({
      url: 'https://schemas.amrit-amr.org/fhir/StructureDefinition/address-plus-code',
      valueString: normalizePlusCode(address.plus_code)
    })
  }
  if (extensions.length) resource.extension = extensions

  return Object.keys(resource).length ? resource : null
}

/**
 * Where a patient lives — the geographic part of an address and nothing else.
 *
 * Surveillance needs to know which place a case belongs to, so that resistance can be
 * mapped, catchments compared and clusters found. It does not need the building. The four
 * fields below are exactly what those questions take; `address_lines` and `organization`
 * are absent by construction, not by convention, because a street address is the single
 * strongest re-identifier a health record can carry and a field that exists will be filled.
 *
 * The postal code earns its place: it is the one sub-city geography that exists in most
 * countries, is written the same way by every clinic in that country, and generalizes
 * cleanly by truncation — which is what makes it safe to export at all. See
 * `generalizeResidence`.
 */
export const RESIDENCE_FIELDS: AddressField[] = ['dependent_locality', 'locality', 'admin_area', 'postal_code']

export interface PatientResidence {
  /** ISO 3166-1 alpha-3. The key into the pack, and the only universally present field. */
  country_code: string
  dependent_locality?: string
  locality?: string
  admin_area?: string
  /** ISO 3166-2, where the country's subdivisions are in the standard. */
  admin_area_code?: string
  postal_code?: string
  /** The reporting unit this residence falls in, for mapping and for scope filters. */
  admin_unit_id?: string | null
  admin_path?: string
}

/** The residence fields this country actually has, in the order it writes them. */
export function residenceFieldsForForm(format: CountryAddressFormat): AddressField[] {
  return fieldsForForm(format).filter((field) => RESIDENCE_FIELDS.includes(field))
}

/**
 * Check a residence against its country's rules.
 *
 * Deliberately weaker than `validateAddress` in one way and stronger in another. Weaker:
 * a country's `required` set is **not** enforced, because a laboratory frequently does not
 * know a patient's town and refusing the record would lose the isolate as well as the
 * geography. Stronger: a street line is refused outright rather than stored.
 */
export function validateResidence(residence: PatientResidence, format: CountryAddressFormat): AddressProblem[] {
  const problems: AddressProblem[] = []
  if (!/^[A-Z]{3}$/.test(text(residence.country_code))) {
    problems.push({
      field: 'country_code',
      code: 'country_code',
      message: 'Country is required, as an ISO 3166-1 alpha-3 code.'
    })
  }

  const carrier = residence as unknown as Record<string, unknown>
  if (Array.isArray(carrier.address_lines) ? carrier.address_lines.length : text(carrier.address_lines)) {
    problems.push({
      field: 'address_lines',
      code: 'not_stored',
      message: 'A street address is not recorded for a patient. Record the town and postal code only.'
    })
  }
  // Refused for the same reason as the street line, and it needs saying out loud because
  // the geographic directory makes it easy: a patient's postal code is deliberately
  // coarsened by `privacy.patient_postal_code_digits`, and a coordinate resolved from it
  // would put back the precision that setting exists to remove.
  if (carrier.geo_point) {
    problems.push({
      field: 'geo_point',
      code: 'not_stored',
      message: 'Coordinates are not recorded for a patient. Geocoding applies to facilities only.'
    })
  }
  if (text(carrier.plus_code)) {
    problems.push({
      field: 'plus_code',
      code: 'not_stored',
      message: 'A Plus Code is not recorded for a patient. Precise location codes apply to facilities only.'
    })
  }

  for (const field of RESIDENCE_FIELDS) {
    const value = text(residence[field as keyof PatientResidence] as string | undefined)
    if (!value) continue
    const label = labelFor(field, format)
    if (!format.fields.includes(field)) {
      problems.push({
        field,
        code: 'unsupported',
        message: `${label} is not part of an address in this country.`
      })
      continue
    }
    if (field === 'postal_code' && format.postal_code_pattern && !postalCodeMatches(value, format.postal_code_pattern)) {
      const example = format.postal_code_examples[0]
      problems.push({
        field,
        code: 'postal_code_pattern',
        message: `${label} does not match the format used in this country${example ? ` (for example ${example})` : ''}.`
      })
    }
  }
  return problems
}

/** Drop empty components and uppercase what the country uppercases. No rendering: a
 * residence is never addressed to, so there is nothing to render it onto. */
export function normalizeResidence(residence: PatientResidence, format: CountryAddressFormat): PatientResidence {
  const normalized: PatientResidence = { country_code: text(residence.country_code).toUpperCase() }
  for (const field of RESIDENCE_FIELDS) {
    const key = field as 'dependent_locality' | 'locality' | 'admin_area' | 'postal_code'
    const value = applyUppercase(field, text(residence[key]), format)
    if (value) normalized[key] = value
  }
  if (text(residence.admin_area_code)) normalized.admin_area_code = text(residence.admin_area_code).toUpperCase()
  if (residence.admin_unit_id) normalized.admin_unit_id = residence.admin_unit_id
  if (text(residence.admin_path)) normalized.admin_path = text(residence.admin_path)
  return normalized
}

/**
 * Coarsen a residence for anything that leaves the deployment.
 *
 * `digits` is the number of leading postal-code characters kept — the deployment's own
 * setting, because what counts as identifying depends on population density and on local
 * law. Zero drops the postal code entirely, which is the right answer for a small country
 * whose codes identify a street.
 *
 * Truncation keeps the code's own separators out of the count, so a UK "SW1A 1AA" at three
 * digits is "SW1", not "SW1A". Nothing else is coarsened here: the town and the
 * administrative unit are what the surveillance is *for*, and suppressing small counts is
 * the k-anonymity floor's job, not this function's.
 */
export function generalizeResidence(
  residence: PatientResidence,
  digits: number
): PatientResidence {
  const generalized: PatientResidence = { ...residence }
  const code = text(residence.postal_code).replace(/[\s-]/g, '')
  if (!code) return generalized
  if (digits <= 0) {
    delete generalized.postal_code
    return generalized
  }
  generalized.postal_code = code.slice(0, digits)
  return generalized
}

/**
 * FHIR R4 `Address` for a residence: `use: home`, and never a street line.
 *
 * Generalize before calling this for anything that leaves the deployment; this function
 * exports what it is given.
 */
export function residenceToFhirAddress(residence: PatientResidence): Record<string, unknown> | null {
  const resource: Record<string, unknown> = { use: 'home', type: 'physical' }
  if (text(residence.locality)) resource.city = text(residence.locality)
  if (text(residence.dependent_locality)) resource.district = text(residence.dependent_locality)
  if (text(residence.admin_area)) resource.state = text(residence.admin_area)
  if (text(residence.postal_code)) resource.postalCode = text(residence.postal_code)
  if (text(residence.country_code)) resource.country = text(residence.country_code)
  return Object.keys(resource).length > 2 ? resource : null
}

/** Drop empty components and refresh `formatted`, so what is stored is what renders. */
export function normalizeAddress(address: PostalAddress, format: CountryAddressFormat): PostalAddress {
  const lines = (address.address_lines ?? []).map(text).filter(Boolean)
  const normalized: PostalAddress = { country_code: text(address.country_code).toUpperCase() }
  if (lines.length) normalized.address_lines = lines
  for (const field of ['dependent_locality', 'locality', 'admin_area', 'postal_code', 'sorting_code', 'organization'] as const) {
    const value = applyUppercase(field, text(address[field]), format)
    if (value) normalized[field] = value
  }
  if (text(address.admin_area_code)) normalized.admin_area_code = text(address.admin_area_code).toUpperCase()
  if (text(address.language_code)) normalized.language_code = text(address.language_code)
  if (address.admin_unit_id) normalized.admin_unit_id = address.admin_unit_id
  const plusCode = normalizePlusCode(address.plus_code)
  if (plusCode) normalized.plus_code = plusCode
  let point = normalizeGeoPoint(address.geo_point)
  const decoded = pointFromPlusCode(
    plusCode,
    point?.source === 'open-location-code' ? point.resolved_at : undefined
  )
  if (decoded && (!point || isAtLeastAsPrecise(decoded.precision, point.precision))) point = decoded
  if (point) normalized.geo_point = point
  const rendered = formatAddress(normalized, format)
  if (rendered) normalized.formatted = rendered
  return normalized
}

/**
 * A resolved coordinate, or nothing.
 *
 * Dropped rather than refused when it is malformed: a point is derived data that can always
 * be resolved again, and losing a facility's whole address because a coordinate arrived
 * wrong would be the wrong trade. A point with no precision is dropped for the same reason
 * precision is stored at all — a coordinate whose exactness is unknown cannot be filtered,
 * and would be plotted as though it were a street address.
 *
 * Mirrors `_clean_geo_point` in `server/amrit_central_server/geo/address.py`.
 */
export function normalizeGeoPoint(value: GeoPoint | undefined): GeoPoint | undefined {
  if (!value || typeof value !== 'object') return undefined
  const latitude = Number(value.latitude)
  const longitude = Number(value.longitude)
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return undefined
  if (!GEO_PRECISIONS.includes(value.precision)) return undefined
  const point: GeoPoint = { latitude, longitude, precision: value.precision, source: text(value.source) }
  if (text(value.resolved_at)) point.resolved_at = text(value.resolved_at)
  return point
}
