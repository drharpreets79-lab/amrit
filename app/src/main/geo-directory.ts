import { existsSync, readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { GeoDirectoryShard, PlaceCandidate, ResolveResult } from '../shared/geo-directory.js'
import { placesNamed, placesForPostalCode, resolve as resolveInShard } from '../shared/geo-directory.js'

/**
 * Loads the bundled geographic directory, one country at a time.
 *
 * Built by `tools/generate_geo_directory.py` and checked in. The whole world is bundled —
 * 247 gzipped shards, about 21 MB — but only the deployment's own country is ever read, and
 * once read it stays in memory: a laboratory registers facilities in one country, and
 * decompressing a megabyte on every keystroke would make the postal-code field feel broken.
 *
 * Resolution happens here rather than in the renderer on purpose. India's shard is 1.7 MB
 * compressed and rather more expanded; handing it across IPC so the form could search it
 * would move that cost onto every window.
 *
 * A missing shard is not an error. A deployment may delete shards it does not need, and a
 * country may have no directory at all — in both cases the address form keeps working and
 * simply cannot place the facility on a map.
 */

export const GEO_DIRECTORY_RESOURCE = 'shared/geo-directory'

function candidatePaths(relative: string): string[] {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url))
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  return [
    resourcesPath ? resolve(resourcesPath, 'resources', relative) : '',
    resolve(process.cwd(), 'resources', relative),
    resolve(moduleDirectory, '../../resources', relative)
  ].filter(Boolean)
}

/** `null` is a cached "this country has no shard", so a miss is looked up once, not always. */
const shards = new Map<string, GeoDirectoryShard | null>()

export function geoDirectoryFor(countryCode: string): GeoDirectoryShard | null {
  const key = String(countryCode ?? '').trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(key)) return null
  const cached = shards.get(key)
  if (cached !== undefined) return cached

  for (const directory of candidatePaths(GEO_DIRECTORY_RESOURCE)) {
    const path = resolve(directory, `${key}.json.gz`)
    if (!existsSync(path)) continue
    try {
      const shard = JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) as GeoDirectoryShard
      shards.set(key, shard)
      return shard
    } catch {
      // A corrupt or truncated shard must not stop a laboratory recording its address. It
      // is cached as absent so the failure costs one read rather than one per keystroke.
      break
    }
  }
  shards.set(key, null)
  return null
}

export interface GeoLookupResult extends ResolveResult {
  /** False when this country has no shard bundled at all, as opposed to no match. */
  available: boolean
}

const UNAVAILABLE: GeoLookupResult = {
  point: null,
  candidates: [],
  postalCodeUnknown: false,
  countryHasNoPostalDirectory: true,
  available: false
}

/** Everything the address form needs about one typed postal code, in one call. */
export function lookupPostalCode(countryCode: string, postalCode: string, subdivisionCode?: string): GeoLookupResult {
  const shard = geoDirectoryFor(countryCode)
  if (!shard) return UNAVAILABLE
  return { ...resolveInShard(shard, { postalCode, subdivisionCode }), available: true }
}

/** Places matching a typed town name. The route for countries with no postal system. */
export function lookupLocality(countryCode: string, query: string, limit?: number): PlaceCandidate[] {
  const shard = geoDirectoryFor(countryCode)
  return shard ? placesNamed(shard, query, limit) : []
}

/** Whether a country has any postal codes here, so a form can say why it is not asking. */
export function hasPostalDirectory(countryCode: string): boolean {
  const shard = geoDirectoryFor(countryCode)
  return Boolean(shard && Object.keys(shard.postalCodes).length > 0)
}

/** Test seam, and the hook a shard-removing deployment needs after changing the folder. */
export function resetGeoDirectoryCache(): void {
  shards.clear()
}

export { placesForPostalCode }
