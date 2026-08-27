import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The packaged catalogue is the internationally standard AMR reference data only. Country
 * geography moved out to shared/geo-packs (see geo-pack.ts), because while the two shared
 * one hash-pinned file no country other than India could be onboarded without regenerating
 * India's seed.
 */
export const PACKAGED_CATALOGUE_DATASET = 'amrit-core-catalogue'
export const PACKAGED_CATALOGUE_FILENAME = 'catalog-seed.v2.json'
export const PACKAGED_CATALOGUE_VERSION = '2026.2'
export const PACKAGED_CATALOGUE_CONTENT_SHA256 = '463599d0af1f754d4a7c678f521a73896090f942fe500ff2bc70c31f6cced3ff'

/**
 * The pre-split asset, still accepted for one release so an installation that has been
 * only partially updated still boots. Its geography is dropped in memory; the geo pack is
 * the source of truth for administrative units.
 */
const LEGACY_CATALOGUE_DATASET = 'icmr-amrit-packaged-catalogue'
const LEGACY_CATALOGUE_FILENAME = 'catalog-seed.v1.json'
const LEGACY_CATALOGUE_VERSION = '2026.1'
const LEGACY_CATALOGUE_CONTENT_SHA256 = '636aa33673184389ae10f76cc8ecb721da7d3c0ba3e51103e3463b3bd7730f10'
const LEGACY_GEO_COLLECTIONS = ['states', 'districts'] as const

type SeedRow = Record<string, unknown>

export interface PackagedCatalogue {
  antibiotics: SeedRow[]
  codeValues: SeedRow[]
  expectedResistance: SeedRow[]
  expertRules: SeedRow[]
  fieldDefinitions: SeedRow[]
  labDataFields: SeedRow[]
  micPanels: SeedRow[]
  organisms: SeedRow[]
  panels: SeedRow[]
  resourceConfig: SeedRow[]
  sampleAliases: SeedRow[]
  samples: SeedRow[]
}

export interface PackagedCatalogueAsset {
  schemaVersion: number
  dataset: string
  version: string
  contentSha256: string
  piiClassification: string
  rowCounts: Record<keyof PackagedCatalogue, number>
  sources: Array<{ path: string; sha256: string; bytes: number; rows: number }>
  catalogue: PackagedCatalogue
}

export interface LoadedPackagedCatalogue {
  path: string
  asset: PackagedCatalogueAsset
}

const MINIMUM_COUNTS: Readonly<Record<keyof PackagedCatalogue, number>> = Object.freeze({
  antibiotics: 300,
  codeValues: 100,
  expectedResistance: 500,
  expertRules: 1,
  fieldDefinitions: 500,
  labDataFields: 15,
  micPanels: 1,
  organisms: 2_000,
  panels: 40,
  resourceConfig: 1,
  sampleAliases: 20,
  samples: 5
})

const PROHIBITED_KEYS = new Set([
  'patient_id', 'first_name', 'last_name', 'dob', 'address', 'contact', 'auth_token', 'site_token', 'api_key',
  'laboratory', 'isolates', 'hospitals'
])

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

function assertPiiFree(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertPiiFree)
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (PROHIBITED_KEYS.has(key)) throw new Error(`Packaged catalogue contains a forbidden key: ${key}`)
    assertPiiFree(nested)
  }
}

function requiredText(row: SeedRow, key: string, collection: string): string {
  const value = String(row[key] ?? '').trim()
  if (!value) throw new Error(`Packaged catalogue ${collection} row is missing ${key}.`)
  return value
}

function assertUnique(rows: SeedRow[], key: string, collection: string): Set<string> {
  const values = new Set<string>()
  for (const row of rows) {
    const value = requiredText(row, key, collection)
    if (values.has(value)) throw new Error(`Packaged catalogue ${collection} has duplicate ${key}: ${value}`)
    values.add(value)
  }
  return values
}

/**
 * Adapt a pre-split v1 asset by dropping its geography.
 *
 * The remaining collections are byte-identical to the ones the splitter wrote, so the v2
 * content hash recomputes exactly. Anything else is a corrupted or tampered file and must
 * still fail.
 */
function adaptLegacyAsset(asset: PackagedCatalogueAsset & { catalogue: Record<string, unknown> }): PackagedCatalogueAsset {
  const actualHash = sha256(canonicalJson(asset.catalogue))
  if (actualHash !== asset.contentSha256) throw new Error('Packaged catalogue content hash mismatch.')
  if (actualHash !== LEGACY_CATALOGUE_CONTENT_SHA256) throw new Error('Packaged catalogue does not match the reviewed application manifest.')

  const catalogue: Record<string, unknown> = { ...asset.catalogue }
  const rowCounts: Record<string, number> = { ...(asset.rowCounts as unknown as Record<string, number>) }
  for (const collection of LEGACY_GEO_COLLECTIONS) {
    delete catalogue[collection]
    delete rowCounts[collection]
  }
  return {
    ...asset,
    schemaVersion: 2,
    dataset: PACKAGED_CATALOGUE_DATASET,
    version: PACKAGED_CATALOGUE_VERSION,
    contentSha256: sha256(canonicalJson(catalogue)),
    rowCounts: rowCounts as unknown as PackagedCatalogueAsset['rowCounts'],
    catalogue: catalogue as unknown as PackagedCatalogue
  }
}

function validateAsset(value: unknown): PackagedCatalogueAsset {
  if (!value || typeof value !== 'object') throw new Error('Packaged catalogue must be a JSON object.')
  let asset = value as PackagedCatalogueAsset
  if (asset.schemaVersion === 1 && asset.dataset === LEGACY_CATALOGUE_DATASET && asset.version === LEGACY_CATALOGUE_VERSION) {
    asset = adaptLegacyAsset(asset as PackagedCatalogueAsset & { catalogue: Record<string, unknown> })
  }
  if (asset.schemaVersion !== 2) throw new Error(`Unsupported packaged catalogue schema: ${String(asset.schemaVersion)}`)
  if (asset.dataset !== PACKAGED_CATALOGUE_DATASET) throw new Error(`Unexpected packaged catalogue dataset: ${String(asset.dataset)}`)
  if (asset.version !== PACKAGED_CATALOGUE_VERSION) throw new Error(`Unexpected packaged catalogue version: ${String(asset.version)}`)
  if (!/^[a-f0-9]{64}$/.test(String(asset.contentSha256 ?? ''))) throw new Error('Packaged catalogue content hash is invalid.')
  if (!Array.isArray(asset.sources) || asset.sources.length < 5) throw new Error('Packaged catalogue provenance is incomplete.')
  if (!asset.catalogue || typeof asset.catalogue !== 'object') throw new Error('Packaged catalogue payload is missing.')

  for (const [key, minimum] of Object.entries(MINIMUM_COUNTS) as Array<[keyof PackagedCatalogue, number]>) {
    const rows = asset.catalogue[key]
    if (!Array.isArray(rows)) throw new Error(`Packaged catalogue collection is missing: ${key}`)
    if (rows.length !== Number(asset.rowCounts?.[key])) throw new Error(`Packaged catalogue row count mismatch: ${key}`)
    if (rows.length < minimum) throw new Error(`Packaged catalogue collection is unexpectedly small: ${key}`)
  }
  const actualHash = sha256(canonicalJson(asset.catalogue))
  if (actualHash !== asset.contentSha256) throw new Error('Packaged catalogue content hash mismatch.')
  if (actualHash !== PACKAGED_CATALOGUE_CONTENT_SHA256) throw new Error('Packaged catalogue does not match the reviewed application manifest.')
  assertPiiFree(asset.catalogue)

  const antibiotics = assertUnique(asset.catalogue.antibiotics, 'code', 'antibiotics')
  const organisms = assertUnique(asset.catalogue.organisms, 'code', 'organisms')
  const samples = assertUnique(asset.catalogue.samples, 'code', 'samples')
  assertUnique(asset.catalogue.sampleAliases, 'normalized_alias', 'sampleAliases')
  assertUnique(asset.catalogue.panels, 'source_row_key', 'panels')
  for (const alias of asset.catalogue.sampleAliases) {
    if (!samples.has(requiredText(alias, 'sample_code', 'sampleAliases'))) {
      throw new Error(`Packaged specimen alias references an unknown sample: ${String(alias.sample_code)}`)
    }
  }
  for (const panel of asset.catalogue.panels) {
    for (const item of (panel.organisms ?? []) as SeedRow[]) {
      if (!organisms.has(requiredText(item, 'code', 'panel organisms'))) {
        throw new Error(`Packaged panel references an unknown organism: ${String(item.code)}`)
      }
    }
    for (const item of (panel.specimens ?? []) as SeedRow[]) {
      if (!samples.has(requiredText(item, 'code', 'panel specimens'))) {
        throw new Error(`Packaged panel references an unknown specimen: ${String(item.code)}`)
      }
    }
    for (const item of (panel.antibiotics ?? []) as SeedRow[]) {
      if (!antibiotics.has(requiredText(item, 'code', 'panel antibiotics'))) {
        throw new Error(`Packaged panel references an unknown antibiotic: ${String(item.code)}`)
      }
    }
  }
  return asset
}

function candidatePaths(explicitPath?: string): string[] {
  if (explicitPath) return [resolve(explicitPath)]
  const moduleDirectory = dirname(fileURLToPath(import.meta.url))
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  // The v1 filename is searched last so a partially updated installation still boots.
  return [...new Set([PACKAGED_CATALOGUE_FILENAME, LEGACY_CATALOGUE_FILENAME].flatMap((filename) => [
    resourcesPath ? resolve(resourcesPath, 'resources', filename) : '',
    resolve(process.cwd(), 'resources', filename),
    resolve(moduleDirectory, '../../resources', filename)
  ].filter(Boolean)))]
}

export const GENOMIC_MARKER_DATASET = 'amrit-genomic-markers'
export const GENOMIC_MARKER_FILENAME = 'genomic-markers.v1.json'

/** The starter diagnosis value set. Small on purpose; see the notice inside the file. */
export const DIAGNOSIS_CODE_DATASET = 'amrit-diagnosis-codes'
export const DIAGNOSIS_CODE_FILENAME = 'diagnosis-codes.v1.json'
/** The `whonet_code_values` set every diagnosis catalogue row belongs to. */
export const DIAGNOSIS_CODE_SET = 'diagnosis'

/** First existing location of a packaged resource, or the last candidate for the error path. */
export function resolveResourcePath(filename: string): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url))
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const candidates = [...new Set([
    resourcesPath ? resolve(resourcesPath, 'resources', filename) : '',
    resolve(process.cwd(), 'resources', filename),
    resolve(moduleDirectory, '../../resources', filename)
  ].filter(Boolean))]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[candidates.length - 1] ?? filename
}

export function loadPackagedCatalogue(explicitPath?: string): LoadedPackagedCatalogue {
  const candidates = candidatePaths(explicitPath)
  const path = candidates.find((candidate) => existsSync(candidate))
  if (!path) throw new Error(`Packaged catalogue asset is missing (${candidates.join(', ')}). Reinstall AMRIT.`)
  const size = statSync(path).size
  if (size <= 0 || size > 16 * 1024 * 1024) throw new Error(`Packaged catalogue asset has an invalid size: ${size}`)
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`Packaged catalogue asset is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { path, asset: validateAsset(parsed) }
}
