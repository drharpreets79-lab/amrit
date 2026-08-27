import { OpenLocationCode } from 'open-location-code'

import type { GeoPoint } from './geo-directory.js'

const codec = new OpenLocationCode()
const MINIMUM_SIGNIFICANT_LENGTH = 8

/** Canonical spelling for a Plus Code: upper-case and without presentation whitespace. */
export function normalizePlusCode(value: unknown): string {
  return typeof value === 'string' ? value.toUpperCase().replace(/\s+/g, '') : ''
}

/**
 * Decode a full Google Open Location Code without a network request.
 *
 * Short codes are intentionally refused: they need a trustworthy nearby reference point,
 * and guessing that point can silently move a facility to another town. Eight significant
 * characters is the floor; the usual ten-character code is retained exactly as entered.
 */
export function pointFromPlusCode(value: unknown, at?: string): GeoPoint | undefined {
  const code = normalizePlusCode(value)
  if (!code || !codec.isValid(code) || !codec.isFull(code)) return undefined
  const area = codec.decode(code)
  if (area.codeLength < MINIMUM_SIGNIFICANT_LENGTH) return undefined
  return {
    latitude: area.latitudeCenter,
    longitude: area.longitudeCenter,
    precision: 'plus_code',
    source: 'open-location-code',
    resolved_at: at ?? new Date().toISOString()
  }
}

export function plusCodeProblem(value: unknown): string | null {
  const code = normalizePlusCode(value)
  if (!code) return null
  if (!codec.isValid(code)) return 'Plus Code is not a valid Open Location Code.'
  if (!codec.isFull(code)) return 'Use a full Plus Code; a short code can only be resolved with a trusted nearby place.'
  if (codec.decode(code).codeLength < MINIMUM_SIGNIFICANT_LENGTH) {
    return 'Plus Code is too broad to place a facility; use at least eight location characters.'
  }
  return null
}
