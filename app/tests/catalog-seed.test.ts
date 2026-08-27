// @vitest-environment node

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { loadPackagedCatalogue, PACKAGED_CATALOGUE_DATASET } from '../src/main/catalog-seed'
import { AMRITDatabase } from '../src/main/database'

const seedPath = resolve(process.cwd(), 'resources/catalog-seed.v2.json')
const diagnosisSeedPath = resolve(process.cwd(), 'resources/diagnosis-codes.v1.json')

/** Rows the starter diagnosis value set adds to `whonet_code_values`. */
const diagnosisSeedCount = (): number =>
  (JSON.parse(readFileSync(diagnosisSeedPath, 'utf8')) as { codes: unknown[] }).codes.length

// These exercise India's own geography and exporter output, so they pin the profile
// rather than inheriting whatever AMRIT_COUNTRY_PROFILE the run sets. Without this they
// fail under the TESTLAND matrix for the right reason — no India geo pack is loaded —
// which is a property of the test, not a defect in the code.
const previousProfile = process.env.AMRIT_COUNTRY_PROFILE
beforeAll(() => { process.env.AMRIT_COUNTRY_PROFILE = 'IN' })
afterAll(() => {
  if (previousProfile === undefined) delete process.env.AMRIT_COUNTRY_PROFILE
  else process.env.AMRIT_COUNTRY_PROFILE = previousProfile
})

describe('PII-free packaged catalogue seed', () => {
  const directories: string[] = []
  const databases: AMRITDatabase[] = []

  function directory(): string {
    const path = mkdtempSync(join(tmpdir(), 'amrit-catalogue-'))
    directories.push(path)
    return path
  }

  function open(path: string, seedCatalog = true, catalogSeedPath = seedPath): AMRITDatabase {
    const database = new AMRITDatabase(path, { seedCatalog, catalogSeedPath }).initialize()
    databases.push(database)
    return database
  }

  afterEach(() => {
    for (const database of databases.splice(0)) {
      try { database.close() } catch { /* already closed */ }
    }
    for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
  })

  it('validates provenance, exact row counts and PII-free referential integrity', () => {
    const loaded = loadPackagedCatalogue(seedPath)
    expect(loaded.asset).toMatchObject({
      schemaVersion: 2,
      dataset: PACKAGED_CATALOGUE_DATASET,
      version: '2026.2',
      piiClassification: expect.stringContaining('no patient')
    })
    expect(loaded.asset.sources.length).toBeGreaterThanOrEqual(20)
    expect(loaded.asset.rowCounts).toMatchObject({
      antibiotics: 399,
      organisms: 2380,
      samples: 8,
      sampleAliases: 38,
      panels: 43,
      labDataFields: 23
    })
  })

  it('rejects a modified static asset before opening a transaction', () => {
    const dir = directory()
    const tampered = join(dir, 'catalog-seed.v2.json')
    const parsed = JSON.parse(readFileSync(seedPath, 'utf8')) as Record<string, unknown>
    const catalogue = parsed.catalogue as Record<string, Array<Record<string, unknown>>>
    const firstAntibiotic = catalogue.antibiotics?.[0]
    if (firstAntibiotic) firstAntibiotic.name = 'Tampered'
    writeFileSync(tampered, JSON.stringify(parsed))
    expect(() => loadPackagedCatalogue(tampered)).toThrow(/content hash mismatch/i)
  })

  it('seeds only terminology into a truly empty install, then attaches panels to a new lab', () => {
    const loaded = loadPackagedCatalogue(seedPath).asset
    const dir = directory()
    const database = open(join(dir, 'amrit.sqlite3'))
    const raw = database.rawConnectionForTesting()
    const count = (table: string): number => Number((raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count)

    expect(count('master_antibiotics')).toBe(loaded.rowCounts.antibiotics)
    expect(count('master_organisms')).toBe(loaded.rowCounts.organisms)
    expect(count('master_samples')).toBe(loaded.rowCounts.samples)
    expect(count('master_sample_aliases')).toBe(loaded.rowCounts.sampleAliases)
    // Geography now arrives from the geo pack rather than the catalogue.
    expect(count('master_admin_units')).toBe(36 + 785)
    // The packaged catalogue's coded values plus the starter diagnosis value set, which is
    // topped up separately so it also reaches databases that predate it.
    expect(count('whonet_code_values')).toBe(loaded.rowCounts.codeValues + diagnosisSeedCount())
    expect(count("whonet_code_values WHERE code_set = 'diagnosis'")).toBe(diagnosisSeedCount())
    expect(count('whonet_field_definitions')).toBe(loaded.rowCounts.fieldDefinitions)
    expect(count('whonet_expected_resistance')).toBe(loaded.rowCounts.expectedResistance)
    expect(count('whonet_expert_rules')).toBe(loaded.rowCounts.expertRules)
    expect(count('laboratory')).toBe(0)
    expect(count('isolates')).toBe(0)
    expect(count('master_hospitals')).toBe(0)
    expect(count('lab_panels')).toBe(0)

    const state = raw.prepare('SELECT * FROM app_catalog_seed_state').get() as Record<string, unknown>
    expect(state).toMatchObject({ dataset: PACKAGED_CATALOGUE_DATASET, source_version: '2026.2' })
    expect(state.source_hash).toBe(loaded.contentSha256)

    database.saveLab({ code: 'fresh', name: 'Fresh ICMR Laboratory', country: 'India' })
    expect(count('lab_panels')).toBe(loaded.rowCounts.panels)
    const referencedOrganisms = new Set(loaded.catalogue.panels.flatMap((panel) =>
      (panel.organisms as Array<Record<string, unknown>>).map((row) => String(row.code))))
    const referencedAntibiotics = new Set(loaded.catalogue.panels.flatMap((panel) =>
      (panel.antibiotics as Array<Record<string, unknown>>).map((row) => String(row.code))))
    expect(count('lab_organisms')).toBe(referencedOrganisms.size)
    expect(count('lab_antibiotics')).toBe(referencedAntibiotics.size)
    expect(count('lab_antibiotic_settings')).toBe(referencedAntibiotics.size)
    expect(count('lab_data_fields')).toBe(loaded.rowCounts.labDataFields)
    expect(count('lab_domains')).toBe(3)
    expect(count('lab_catalog_seed_state')).toBe(1)
  })

  it('is idempotent and never overwrites local master or panel edits', () => {
    const dir = directory()
    const path = join(dir, 'amrit.sqlite3')
    let database = open(path)
    database.saveLab({ code: 'EDIT', name: 'Editing Laboratory' })
    const originalPanels = database.listMaster('panels', { labCode: 'EDIT', includeInactive: true, limit: 100_000 })
    expect(originalPanels).toHaveLength(43)
    database.saveMaster('antibiotics', { code: 'AMK', name: 'Locally named amikacin', active: true })
    database.toggleMaster('organisms', 'ECO', false)
    database.savePanel('EDIT', { ...originalPanels[0], panel_name: 'Locally edited panel' })
    database.close()
    databases.splice(databases.indexOf(database), 1)

    database = open(path)
    database.initialize()
    expect(database.listMaster('antibiotics', { query: 'Locally named amikacin', limit: 100_000 })[0]?.name)
      .toBe('Locally named amikacin')
    expect(database.listMaster('organisms', { query: 'ECO', includeInactive: true, limit: 100_000 })
      .find((row) => row.code === 'ECO')?.active).toBe(false)
    const panels = database.listMaster('panels', { labCode: 'EDIT', includeInactive: true, limit: 100_000 })
    expect(panels).toHaveLength(43)
    expect(panels.some((panel) => panel.panel_name === 'Locally edited panel' && panel.user_modified === true)).toBe(true)
    const raw = database.rawConnectionForTesting()
    // Scoped to the packaged catalogue: the genomic-marker reference set is a separate dataset
    // that deliberately tops up existing databases.
    expect((raw.prepare("SELECT COUNT(*) AS count FROM app_catalog_seed_state WHERE dataset = 'amrit-core-catalogue'")
      .get() as { count: number }).count).toBe(1)
    expect((raw.prepare('SELECT COUNT(*) AS count FROM lab_catalog_seed_state').get() as { count: number }).count).toBe(1)
  })

  it('does not add catalogue rows or panels to an existing user database', () => {
    const dir = directory()
    const path = join(dir, 'existing.sqlite3')
    let database = open(path, false)
    database.saveLab({ code: 'USER', name: 'Existing User Laboratory' })
    database.saveMaster('antibiotics', { code: 'OWN', name: 'User-defined antimicrobial' })
    database.close()
    databases.splice(databases.indexOf(database), 1)

    database = open(path, true)
    expect(database.listMaster('antibiotics', { includeInactive: true, limit: 100_000 })).toHaveLength(1)
    expect(database.listMaster('panels', { labCode: 'USER', includeInactive: true, limit: 100_000 })).toHaveLength(0)
    const raw = database.rawConnectionForTesting()
    expect((raw.prepare("SELECT COUNT(*) AS count FROM app_catalog_seed_state WHERE dataset = 'icmr-amrit-packaged-catalogue'")
      .get() as { count: number }).count).toBe(0)
    // The genomic-marker reference catalogue is a top-up: it does reach an existing database,
    // without touching the user's own antibiotics, organisms or panels.
    expect((raw.prepare("SELECT COUNT(*) AS count FROM app_catalog_seed_state WHERE dataset = 'amrit-genomic-markers'")
      .get() as { count: number }).count).toBe(1)
    expect(database.listMaster('genomicMarkers', { limit: 1000 }).length).toBeGreaterThan(30)
    expect(database.getLab('USER')?.name).toBe('Existing User Laboratory')
  })

  it('still accepts the pre-split v1 asset and drops its geography in memory', () => {
    // A partially updated installation may still have only catalog-seed.v1.json on disk.
    const legacyPath = resolve(process.cwd(), 'resources/catalog-seed.v1.json')
    const loaded = loadPackagedCatalogue(legacyPath)

    expect(loaded.asset.dataset).toBe(PACKAGED_CATALOGUE_DATASET)
    expect(loaded.asset.version).toBe('2026.2')
    expect(loaded.asset.schemaVersion).toBe(2)
    // The geography is gone; the AMR catalogue is untouched.
    expect((loaded.asset.catalogue as unknown as Record<string, unknown>).states).toBeUndefined()
    expect((loaded.asset.catalogue as unknown as Record<string, unknown>).districts).toBeUndefined()
    expect(loaded.asset.rowCounts.antibiotics).toBe(399)
    // Adapting it reproduces exactly the hash the splitter pinned for v2.
    expect(loaded.asset.contentSha256).toBe(
      JSON.parse(readFileSync(seedPath, 'utf8')).contentSha256
    )
  })
})
