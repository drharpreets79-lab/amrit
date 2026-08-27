import { EDITABLE_PROFILE_FIELDS, IRREVERSIBLE_PROFILE_FIELDS } from '../shared/deployment'
import type { CountryProfile } from '../shared/types'
import { countryProfileSchema } from './country-profile'

/**
 * Validation for administrator-supplied deployment settings, mirroring
 * server/amrit_central_server/central/deployment_config.py.
 *
 * The values here are rendered into the application and written into exported FHIR, so
 * the rules are load-bearing rather than cosmetic: only https URLs are accepted, SVG
 * logos are refused outright, and an image is judged by its bytes rather than its name.
 */

/** Formats a renderer will display as an image and nothing else. SVG is an executable document. */
export const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  PNG: 'image/png',
  JPEG: 'image/jpeg',
  WEBP: 'image/webp'
}
export const MAX_LOGO_BYTES = 2 * 1024 * 1024
export const MAX_LOGO_PIXELS = 4096

/** Runtime-editable settings. Anything absent is derived or fixed when the app is built. */
export const EDITABLE_FIELDS = new Set<string>(EDITABLE_PROFILE_FIELDS)

/** Changing these cannot be undone for data already exported. */
export const IRREVERSIBLE_FIELDS = IRREVERSIBLE_PROFILE_FIELDS

export class DeploymentConfigError extends Error {}

/** Identify an image from its leading bytes. */
export function detectImageFormat(data: Uint8Array): string | null {
  const startsWith = (signature: number[]): boolean =>
    signature.every((byte, index) => data[index] === byte)
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'PNG'
  if (startsWith([0xff, 0xd8, 0xff])) return 'JPEG'
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && data.length >= 12) {
    const tag = String.fromCharCode(...data.slice(8, 12))
    return tag === 'WEBP' ? 'WEBP' : null
  }
  return null
}

export function validateLogo(data: Uint8Array, filename = ''): { format: string; contentType: string } {
  if (data.length === 0) throw new DeploymentConfigError('The logo file is empty.')
  if (data.length > MAX_LOGO_BYTES) {
    throw new DeploymentConfigError(
      `The logo is ${Math.round(data.length / 1024)} KB; the limit is ${MAX_LOGO_BYTES / 1024} KB.`
    )
  }
  const head = String.fromCharCode(...data.slice(0, 8)).trim().toLowerCase()
  if (filename.toLowerCase().endsWith('.svg') || head.startsWith('<?xml') || head.startsWith('<svg')) {
    throw new DeploymentConfigError(
      'SVG logos are not accepted. An SVG is an executable document and this image is rendered ' +
      'inside the application. Use a PNG, JPEG or WebP.'
    )
  }
  const format = detectImageFormat(data)
  if (!format || !(format in ALLOWED_IMAGE_TYPES)) {
    throw new DeploymentConfigError('The file is not a PNG, JPEG or WebP image.')
  }
  return { format, contentType: ALLOWED_IMAGE_TYPES[format]! }
}

/** Only absolute https URLs: these are rendered and fetched. */
export function validateHttpsUrl(value: unknown, field: string): string {
  const text = String(value ?? '').trim()
  if (!text) throw new DeploymentConfigError(`${field} is required.`)
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    throw new DeploymentConfigError(`${field} must be an absolute https:// URL.`)
  }
  if (parsed.protocol !== 'https:') {
    throw new DeploymentConfigError(
      `${field} must use https. "${parsed.protocol}" is refused because this value is rendered ` +
      'into the application and into exported FHIR.'
    )
  }
  if (!parsed.host) throw new DeploymentConfigError(`${field} is missing a host.`)
  return text.replace(/\/+$/, '')
}

export function validateUrnPrefix(value: unknown): string {
  const text = String(value ?? '').trim().replace(/:+$/, '')
  if (!/^urn:[a-z0-9][a-z0-9-]*(:[a-z0-9][a-z0-9-]*)*$/.test(text)) {
    throw new DeploymentConfigError('The URN prefix must look like urn:example:amr — lowercase, colon-separated.')
  }
  return text
}

export function validateOverrides(overrides: Record<string, unknown>): Record<string, unknown> {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new DeploymentConfigError('Deployment settings must be an object.')
  }
  const unknown = Object.keys(overrides).filter((key) => !EDITABLE_FIELDS.has(key))
  if (unknown.length) throw new DeploymentConfigError(`Unknown setting(s): ${unknown.sort().join(', ')}.`)

  const cleaned = JSON.parse(JSON.stringify(overrides)) as Record<string, unknown>

  const branding = cleaned.branding as Record<string, unknown> | undefined
  if (branding && 'app_id' in branding) {
    throw new DeploymentConfigError(
      'The application id is fixed when the application is built and signed, and cannot be changed here.'
    )
  }
  for (const [name, colour] of Object.entries((branding?.colors ?? {}) as Record<string, unknown>)) {
    if (!/^#[0-9A-Fa-f]{6}$/.test(String(colour))) {
      throw new DeploymentConfigError(`Colour "${name}" must be a six-digit hex value like #1B75BC.`)
    }
  }

  const namespace = cleaned.identifier_namespace as Record<string, unknown> | undefined
  if (namespace) {
    namespace.base_uri = validateHttpsUrl(namespace.base_uri, 'Base URI')
    namespace.urn_prefix = validateUrnPrefix(namespace.urn_prefix)
  }

  const map = cleaned.map as Record<string, unknown> | undefined
  if (map?.tile_url) map.tile_url = validateHttpsUrl(map.tile_url, 'Map tile URL')

  return cleaned
}

/** Layer overrides over a resolved profile, one level deep per field. */
export function applyOverrides(profile: CountryProfile, overrides: Record<string, unknown>): CountryProfile {
  const merged: Record<string, unknown> = JSON.parse(JSON.stringify(profile))
  for (const [field, value] of Object.entries(overrides ?? {})) {
    const existing = merged[field]
    merged[field] = value && typeof value === 'object' && !Array.isArray(value) &&
      existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as object), ...(value as object) }
      : value
  }
  // The result must satisfy the same contract a checked-in profile does, so the settings
  // screen cannot produce a profile the rest of the app would reject.
  return countryProfileSchema.parse(merged)
}

/**
 * Store the re-encoded image as a data URI rather than a path.
 *
 * Nothing the uploader supplied is ever served back: these are bytes this codebase
 * produced. It also means no new file-serving route, which is where the equivalent
 * server-side feature would otherwise leak an executable content type.
 */
export function logoDataUri(reencoded: Uint8Array, contentType: string): string {
  if (!reencoded.length) throw new DeploymentConfigError('The logo could not be re-encoded.')
  let binary = ''
  for (const byte of reencoded) binary += String.fromCharCode(byte)
  return `data:${contentType};base64,${btoa(binary)}`
}

/**
 * Reduce a whole profile document to the fields a deployment may override.
 *
 * This is the import half of the export/import handoff: one ministry exports its effective
 * profile and a second deployment adopts it. Build-time fields are dropped rather than
 * refused, because an exported profile legitimately carries the exporting deployment's
 * `app_id` and that value cannot apply to this installation.
 */
export function overridesFromProfile(document: Record<string, unknown>): Record<string, unknown> {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new DeploymentConfigError('A profile document must be a JSON object.')
  }
  const overrides: Record<string, unknown> = {}
  for (const field of EDITABLE_FIELDS) {
    if (document[field] !== undefined) overrides[field] = document[field]
  }
  const branding = overrides.branding as Record<string, unknown> | undefined
  if (branding && 'app_id' in branding) {
    const { app_id: _appId, ...rest } = branding
    overrides.branding = rest
  }
  if (!Object.keys(overrides).length) {
    throw new DeploymentConfigError('That document carries no settings this deployment can adopt.')
  }
  return validateOverrides(overrides)
}

export function irreversibleChanges(
  current: Record<string, unknown>,
  proposed: Record<string, unknown>
): string[] {
  return IRREVERSIBLE_FIELDS.filter(
    (field) => JSON.stringify(current?.[field]) !== JSON.stringify(proposed?.[field])
  )
}
