import type { CountryProfile } from '../../shared/types'
import { activeProfile } from './active-profile'

/**
 * FHIR and export identifiers, built from the active country profile.
 *
 * These strings are wire-visible: every FHIR resource and aggregate payload this app
 * emits carries them, and downstream consumers match on them. The India profile
 * reproduces the previously hardcoded values exactly, so existing deployments emit
 * byte-identical output.
 *
 * Mirrors server/amrit_central_server/central/identifiers.py; both read the same profile.
 */

const DEFAULT_BASE_URI = 'https://amrit.invalid'
const DEFAULT_URN_PREFIX = 'urn:amrit'

const namespaceOf = (profile: CountryProfile): { base_uri?: string; urn_prefix?: string } =>
  profile.identifier_namespace ?? {}

export function baseUri(profile: CountryProfile = activeProfile()): string {
  return (namespaceOf(profile).base_uri || DEFAULT_BASE_URI).replace(/\/+$/, '')
}

export function urnPrefix(profile: CountryProfile = activeProfile()): string {
  return (namespaceOf(profile).urn_prefix || DEFAULT_URN_PREFIX).replace(/:+$/, '')
}

export function uri(segments: string[], profile: CountryProfile = activeProfile()): string {
  const path = segments.map((segment) => String(segment).replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')
  return path ? `${baseUri(profile)}/${path}` : baseUri(profile)
}

export function urn(segments: string[], profile: CountryProfile = activeProfile()): string {
  const tail = segments.map((segment) => String(segment).replace(/^:+|:+$/g, '')).filter(Boolean).join(':')
  return tail ? `${urnPrefix(profile)}:${tail}` : urnPrefix(profile)
}

/** Named helpers, so each identifier's shape lives in exactly one place. */
export const aggregateIdentifierSystem = (profile?: CountryProfile): string => urn(['aggregate'], profile ?? activeProfile())
export const laboratoryIdentifierSystem = (profile?: CountryProfile): string => urn(['laboratory'], profile ?? activeProfile())
export const resistanceMeasureUrn = (antibioticCode: string, profile?: CountryProfile): string =>
  urn(['measure', 'resistance-rate', antibioticCode], profile ?? activeProfile())
export const aggregateCodeSystem = (profile?: CountryProfile): string =>
  uri(['CodeSystem', 'aggregate'], profile ?? activeProfile())

/**
 * The canonical URL of an AMRIT profile, for `meta.profile` and for the Implementation Guide.
 *
 * Phase 25. It hangs off the deployment's own base URI rather than a domain this project
 * invented, for the same reason every other identifier does: the software is country-neutral,
 * and a canonical pointing at one country's institute would be wrong everywhere else. A
 * deployment that publishes an IG sets `identifier_namespace.base_uri` and its resources
 * immediately claim conformance to profiles at that address; one that does not gets
 * `https://amrit.invalid`, which is a reserved TLD and therefore visibly not a claim.
 */
export const profileCanonical = (name: string, profile?: CountryProfile): string =>
  uri(['StructureDefinition', name], profile ?? activeProfile())
