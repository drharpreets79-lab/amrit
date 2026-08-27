import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Geo packs: a country's administrative units, shipped separately from the AMR catalogue.
 *
 * Unlike the packaged catalogue, the loader carries no per-country knowledge. Level
 * definitions and the minimum row counts live inside each pack, so onboarding a country is
 * adding a file rather than editing application code and re-pinning a constant.
 */

export const GEO_PACK_DATASET = 'amrit-geo-pack'
export const GEO_PACK_DIRECTORY = 'shared/geo-packs'
/** Every ISO 3166-1 country's subdivisions, used when a country has no pack of its own. */
export const ISO_FALLBACK_PACK = '_iso3166-2.json'
const MAX_PACK_BYTES = 64 * 1024 * 1024

export interface GeoPackLevel {
  level: number
  key: string
  label: string
  label_plural: string
  code_system: string
}

export interface GeoPackUnit {
  level: number
  code: string
  parent_code: string | null
  name: string
  name_local?: string | null
  unit_type?: string | null
  active?: number
  sort_order?: number
}

export interface GeoPack {
  schemaVersion: number
  dataset: string
  version: string
  countryCode: string
  countryName: string
  levels: GeoPackLevel[]
  minimumCounts: Record<string, number>
  rowCounts: Record<string, number>
  contentSha256: string
  licence?: { name?: string; holder?: string; notes?: string }
  units: GeoPackUnit[]
}

export interface LoadedGeoPack {
  path: string
  pack: GeoPack
}

/** Byte-identical to canonicalJson() in catalog-seed.ts and canonical_bytes() in tools/. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function geoPackDirectories(): string[] {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url))
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  return [...new Set([
    resourcesPath ? resolve(resourcesPath, 'resources', GEO_PACK_DIRECTORY) : '',
    resolve(process.cwd(), 'resources', GEO_PACK_DIRECTORY),
    resolve(moduleDirectory, '../../resources', GEO_PACK_DIRECTORY)
  ].filter(Boolean))]
}

/** Profile ids of the packs shipped with this build, e.g. ['IN']. */
export function availableGeoPacks(): string[] {
  for (const directory of geoPackDirectories()) {
    if (!existsSync(directory)) continue
    return readdirSync(directory)
      .filter((name) => name.endsWith('.json') && !name.startsWith('_'))
      .map((name) => name.slice(0, -'.json'.length))
      .sort()
  }
  return []
}

export function validateGeoPack(value: unknown): GeoPack {
  if (!value || typeof value !== 'object') throw new Error('Geo pack must be a JSON object.')
  const pack = value as GeoPack
  if (pack.schemaVersion !== 1) throw new Error(`Unsupported geo pack schema: ${String(pack.schemaVersion)}`)
  if (pack.dataset !== GEO_PACK_DATASET) throw new Error(`Unexpected geo pack dataset: ${String(pack.dataset)}`)
  if (!/^[A-Z]{3}$/.test(String(pack.countryCode ?? ''))) throw new Error(`Geo pack country code must be ISO 3166-1 alpha-3: ${String(pack.countryCode)}`)
  if (!Array.isArray(pack.levels) || pack.levels.length === 0) throw new Error('Geo pack declares no administrative levels.')
  if (!Array.isArray(pack.units)) throw new Error('Geo pack has no units.')

  const actualHash = sha256(canonicalJson(pack.units))
  if (actualHash !== pack.contentSha256) throw new Error(`Geo pack content hash mismatch for ${pack.countryCode}.`)

  const declaredLevels = new Set(pack.levels.map((level) => Number(level.level)))
  const byLevel = new Map<number, number>()
  const seen = new Set<string>()
  const codesByLevel = new Map<number, Set<string>>()

  for (const unit of pack.units) {
    const level = Number(unit.level)
    const code = String(unit.code ?? '').trim()
    if (!declaredLevels.has(level)) throw new Error(`Geo pack unit uses an undeclared level ${level}.`)
    if (!code) throw new Error(`Geo pack unit at level ${level} is missing a code.`)
    if (!String(unit.name ?? '').trim()) throw new Error(`Geo pack unit ${code} is missing a name.`)
    const key = `${level}:${code}`
    if (seen.has(key)) throw new Error(`Geo pack has a duplicate unit at level ${level}: ${code}`)
    seen.add(key)
    if (!codesByLevel.has(level)) codesByLevel.set(level, new Set())
    codesByLevel.get(level)?.add(code)
    byLevel.set(level, (byLevel.get(level) ?? 0) + 1)
  }

  // Parents are validated after the whole pack is indexed, so ordering inside the file
  // does not matter.
  for (const unit of pack.units) {
    const level = Number(unit.level)
    const parent = unit.parent_code === null || unit.parent_code === undefined ? '' : String(unit.parent_code)
    const minimumLevel = Math.min(...declaredLevels)
    if (level === minimumLevel) {
      if (parent) throw new Error(`Geo pack top-level unit ${unit.code} must not declare a parent.`)
      continue
    }
    if (!parent) throw new Error(`Geo pack unit ${unit.code} at level ${level} has no parent.`)
    if (!codesByLevel.get(level - 1)?.has(parent)) {
      throw new Error(`Geo pack unit ${unit.code} references a parent that is not in the pack: ${parent}`)
    }
  }

  for (const [level, minimum] of Object.entries(pack.minimumCounts ?? {})) {
    const actual = byLevel.get(Number(level)) ?? 0
    if (actual < Number(minimum)) {
      throw new Error(`Geo pack level ${level} is unexpectedly small: ${actual} < ${minimum}`)
    }
  }
  return pack
}

interface IsoFallbackFile {
  version: string
  licence?: GeoPack['licence']
  countries: Record<string, { levels: GeoPackLevel[]; units: GeoPackUnit[] }>
}

/**
 * Build a pack for one country from the bundled ISO 3166-2 set.
 *
 * A country with no curated pack used to start with an empty tree and could scope nothing
 * until someone imported units by hand. Its first-level subdivisions — and, where ISO
 * defines them, second-level — now come out of the box, with the standard's own
 * subdivision type as the level label.
 */
export function isoFallbackPack(countryCode: string): GeoPack | null {
  const file = (() => {
    for (const directory of geoPackDirectories()) {
      const candidate = resolve(directory, ISO_FALLBACK_PACK)
      if (existsSync(candidate)) return JSON.parse(readFileSync(candidate, 'utf8')) as IsoFallbackFile
    }
    return null
  })()
  const entry = file?.countries?.[countryCode.toUpperCase()]
  if (!file || !entry) return null

  const units = entry.units
  const pack: GeoPack = {
    schemaVersion: 1,
    dataset: GEO_PACK_DATASET,
    version: file.version,
    countryCode: countryCode.toUpperCase(),
    countryName: countryCode.toUpperCase(),
    levels: entry.levels,
    minimumCounts: {},
    rowCounts: { total: units.length },
    contentSha256: sha256(canonicalJson(units)),
    licence: file.licence,
    units
  }
  return validateGeoPack(pack)
}

/** Load a geo pack by profile id ('IN') or ISO 3166-1 alpha-3, or from an explicit path. */
export function loadGeoPack(profileId: string, explicitPath?: string): LoadedGeoPack | null {
  const candidates = explicitPath
    ? [resolve(explicitPath)]
    : geoPackDirectories().flatMap((directory) => [
      resolve(directory, `${profileId.toUpperCase()}.json`)
    ])
  const path = candidates.find((candidate) => existsSync(candidate))
  if (!path) {
    // No curated pack: fall back to the country's ISO 3166-2 subdivisions.
    if (explicitPath) return null
    const fallback = isoFallbackPack(profileId)
    return fallback ? { path: ISO_FALLBACK_PACK, pack: fallback } : null
  }

  const size = statSync(path).size
  if (size <= 0 || size > MAX_PACK_BYTES) throw new Error(`Geo pack has an invalid size: ${size}`)
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`Geo pack is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { path, pack: validateGeoPack(parsed) }
}
