/**
 * Turning an address into a place on a map.
 *
 * A postal code is the one piece of geography an operator already knows and can be relied
 * on to type. It is the input this resolver is built around — but it is not, on its own, a
 * mechanism that works everywhere, and the design does not pretend otherwise:
 *
 *   - roughly half the countries in ISO 3166-1 have no postal system at all, so a form that
 *     insists on one cannot be filled in in Angola, Fiji or much of sub-Saharan Africa;
 *   - several countries publish only a truncated code — Ireland, Malta, Chile, China,
 *     Argentina, Brazil — so the code identifies a region, not an address;
 *   - where codes *are* point-precise, a coordinate derived from one identifies a building.
 *
 * So a postal code is the first of three routes to a coordinate, not the only one, and every
 * point carries the precision it was resolved at. A map that plots an area centroid as
 * though it were a street address is worse than a map with a gap in it.
 *
 * Nothing here is ever applied to a patient's residence. See `RESIDENCE_FIELDS` in
 * `address.ts`: a patient has a town and a coarsened postal code, and giving that a
 * coordinate would undo the coarsening. Facilities only.
 *
 * The shape of the data is `tools/generate_geo_directory.py`'s output, and this file mirrors
 * `server/amrit_central_server/geo/directory.py` function for function so a facility resolves
 * to the same point in both products.
 */

/**
 * How exact a coordinate is. Stored with the point, never inferred later.
 *
 * `device` is a facility's own reading, sent with consent from the installation itself, and
 * outranks anything derived from an address. `manual` is a coordinate somebody typed, which
 * is also treated as authoritative: they knew something the directory does not.
 */
export const GEO_PRECISIONS = ['device', 'manual', 'plus_code', 'postal_area', 'locality', 'subdivision', 'country'] as const
export type GeoPrecision = (typeof GEO_PRECISIONS)[number]

/** Ordered best to worst, so a better answer can replace a worse one and never the reverse. */
const PRECISION_RANK: Record<GeoPrecision, number> = {
  device: 0, manual: 0, plus_code: 1, postal_area: 2, locality: 3, subdivision: 4, country: 5
}

export interface GeoPoint {
  latitude: number
  longitude: number
  precision: GeoPrecision
  /** The dataset this came from, or `manual`. Recorded so a point can be re-derived. */
  source: string
  /** ISO 8601. A directory is a snapshot; a point that predates a boundary change shows it. */
  resolved_at?: string
}

/** One place the directory could mean. Shown to the operator, who chooses. */
export interface PlaceCandidate {
  locality: string
  admin_area: string
  dependent_locality?: string
  postal_code?: string
  latitude: number
  longitude: number
  precision: GeoPrecision
  source: string
}

/** One country's slice of the directory, as read from `<ALPHA3>.json.gz`. */
export interface GeoDirectoryShard {
  schemaVersion: number
  alpha2: string
  alpha3: string
  /** Pooled strings; every index below points in here. */
  names: string[]
  /** postal code -> [placeIndex, admin1Index, admin2Index, latitude, longitude, accuracy] */
  postalCodes: Record<string, Array<[number, number, number, number, number, number | null]>>
  /** [nameIndex, admin1Code, admin2Index, latitude, longitude, population] */
  localities: Array<[number, string, number, number, number, number]>
  /** ISO 3166-2 code -> [latitude, longitude] */
  subdivisionCentroids: Record<string, [number, number]>
  countryCentroid: [number, number] | null
}

export const POSTAL_SOURCE = 'geonames-postal'
export const LOCALITY_SOURCE = 'geonames-cities500'
export const SUBDIVISION_SOURCE = 'geonames-subdivision-centroid'

/**
 * Normalise a postal code for lookup.
 *
 * Upper-cased and stripped of the separators people type but directories do not store — the
 * space in `EC1Y 8SY`, the hyphen in `22162-1010`. Both spellings must find the same row, or
 * the operator is told their own country's postal code does not exist.
 */
export function normalizePostalCode(code: string): string {
  return code.trim().toUpperCase().replace(/[\s\-.]/g, '')
}

/**
 * The shortest code the directory holds, so a prefix search knows when to stop.
 *
 * Two characters is the floor regardless: matching one character of a postcode would place
 * a facility somewhere in a whole postal region and call it an address.
 */
const MINIMUM_PREFIX = 2

/** The directory's own key for a code, since it stores them in the source's spelling. */
function postalIndex(shard: GeoDirectoryShard): Map<string, string> {
  const index = new Map<string, string>()
  for (const code of Object.keys(shard.postalCodes)) index.set(normalizePostalCode(code), code)
  return index
}

/**
 * The directory key for a typed code, allowing for a directory that stores only a prefix.
 *
 * For copyright reasons GeoNames carries only the outward part of a code for the United
 * Kingdom, Canada, the Netherlands and Ireland, and truncated codes for Chile, China,
 * Argentina, Brazil and Malta. Without this, a London operator typing a perfectly valid
 * `EC1Y 8SY` is told their own postcode does not exist — the directory holds `EC1Y`.
 *
 * The longest stored prefix wins, so a country with full codes is unaffected: its exact
 * code is found on the first attempt and no prefix is ever consulted.
 */
function directoryKeyFor(shard: GeoDirectoryShard, typed: string): string | null {
  const index = cachedPostalIndex(shard)
  const normalized = normalizePostalCode(typed)
  for (let length = normalized.length; length >= MINIMUM_PREFIX; length -= 1) {
    const key = index.get(normalized.slice(0, length))
    if (key) return key
  }
  return null
}

const indexCache = new WeakMap<GeoDirectoryShard, Map<string, string>>()

function cachedPostalIndex(shard: GeoDirectoryShard): Map<string, string> {
  let index = indexCache.get(shard)
  if (!index) { index = postalIndex(shard); indexCache.set(shard, index) }
  return index
}

/**
 * Every place a postal code covers.
 *
 * More than one is normal, not an error: a code frequently spans several villages, and
 * choosing between them is the operator's call, not this function's. Empty means the code is
 * not in this snapshot of the directory — which is a warning, never a refusal, because codes
 * are issued faster than any directory is republished.
 */
export function placesForPostalCode(shard: GeoDirectoryShard, code: string): PlaceCandidate[] {
  const key = directoryKeyFor(shard, code)
  if (!key) return []
  return (shard.postalCodes[key] ?? []).map(([place, admin1, admin2, latitude, longitude]) => ({
    locality: shard.names[place] ?? '',
    admin_area: shard.names[admin1] ?? '',
    dependent_locality: shard.names[admin2] || undefined,
    postal_code: key,
    latitude,
    longitude,
    precision: 'postal_area' as const,
    source: POSTAL_SOURCE
  }))
}

/**
 * Places whose name starts with, or contains, what has been typed.
 *
 * The answer for a country with no postal system, and the fallback for a code the directory
 * has not caught up with. Ranked by population, because when two towns share a name the
 * larger one is the likelier intent — and both are offered regardless.
 */
export function placesNamed(shard: GeoDirectoryShard, query: string, limit = 12): PlaceCandidate[] {
  const needle = query.trim().toLocaleLowerCase()
  if (needle.length < 2) return []
  const scored: Array<{ candidate: PlaceCandidate; population: number; rank: number }> = []
  for (const [nameIndex, , admin2Index, latitude, longitude, population] of shard.localities) {
    const name = shard.names[nameIndex] ?? ''
    const folded = name.toLocaleLowerCase()
    const rank = folded === needle ? 0 : folded.startsWith(needle) ? 1 : folded.includes(needle) ? 2 : -1
    if (rank < 0) continue
    scored.push({
      candidate: {
        locality: name,
        admin_area: shard.names[admin2Index] ?? '',
        latitude,
        longitude,
        precision: 'locality',
        source: LOCALITY_SOURCE
      },
      population,
      rank
    })
  }
  scored.sort((left, right) => left.rank - right.rank || right.population - left.population)
  return scored.slice(0, limit).map((entry) => entry.candidate)
}

/** The centre of an ISO 3166-2 subdivision, for a country the finer routes cannot serve. */
export function subdivisionPoint(shard: GeoDirectoryShard, isoCode: string): GeoPoint | null {
  const centroid = shard.subdivisionCentroids[isoCode.trim().toUpperCase()]
  if (!centroid) return null
  return { latitude: centroid[0], longitude: centroid[1], precision: 'subdivision', source: SUBDIVISION_SOURCE }
}

export function countryPoint(shard: GeoDirectoryShard): GeoPoint | null {
  if (!shard.countryCentroid) return null
  return {
    latitude: shard.countryCentroid[0],
    longitude: shard.countryCentroid[1],
    precision: 'country',
    source: SUBDIVISION_SOURCE
  }
}

export function pointFromCandidate(candidate: PlaceCandidate, at = new Date().toISOString()): GeoPoint {
  return {
    latitude: candidate.latitude,
    longitude: candidate.longitude,
    precision: candidate.precision,
    source: candidate.source,
    resolved_at: at
  }
}

/** True when `next` is at least as exact as `current`, so a resolve never coarsens a point. */
export function isAtLeastAsPrecise(next: GeoPrecision, current: GeoPrecision | undefined): boolean {
  if (!current) return true
  return PRECISION_RANK[next] <= PRECISION_RANK[current]
}

export interface ResolveRequest {
  postalCode?: string
  locality?: string
  /** ISO 3166-2 code of the reporting unit, used only when nothing finer resolves. */
  subdivisionCode?: string
}

export interface ResolveResult {
  /** The single best point, or null when the directory cannot place this address at all. */
  point: GeoPoint | null
  /** Everything the postal code or the typed town could have meant, for the operator to pick. */
  candidates: PlaceCandidate[]
  /** True when a postal code was given and this country's directory does not list it. */
  postalCodeUnknown: boolean
  /** True when this country has no postal directory at all, so the code proves nothing. */
  countryHasNoPostalDirectory: boolean
}

/**
 * Best effort, in one call, with everything the caller needs to explain the answer.
 *
 * Deliberately does not choose between several places sharing a postal code when they are
 * far apart: it returns them all and points at the first. Silently picking one and calling it
 * the facility's location is how a laboratory ends up plotted in the wrong district with
 * nothing on screen to suggest it.
 */
export function resolve(shard: GeoDirectoryShard, request: ResolveRequest): ResolveResult {
  const hasPostalDirectory = Object.keys(shard.postalCodes).length > 0
  const typedCode = (request.postalCode ?? '').trim()
  const byCode = typedCode ? placesForPostalCode(shard, typedCode) : []
  const byName = byCode.length === 0 && request.locality ? placesNamed(shard, request.locality) : []
  const candidates = byCode.length ? byCode : byName

  const best = candidates[0]
    ? pointFromCandidate(candidates[0])
    : (request.subdivisionCode ? subdivisionPoint(shard, request.subdivisionCode) : null) ?? countryPoint(shard)

  return {
    point: best,
    candidates,
    postalCodeUnknown: Boolean(typedCode) && hasPostalDirectory && byCode.length === 0,
    countryHasNoPostalDirectory: !hasPostalDirectory
  }
}
