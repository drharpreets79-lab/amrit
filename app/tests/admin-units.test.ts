// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AMRITDatabase } from '../src/main/database'

/**
 * Phase 1 gate: the country-neutral admin-unit tree must appear without disturbing the
 * India LGD masters, on a fresh database and on one created by the previous build.
 */
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

describe('administrative unit tree', () => {
  let directory: string
  let databasePath: string
  let database: AMRITDatabase | null = null

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'amrit-admin-units-'))
    databasePath = join(directory, 'amrit.sqlite3')
  })

  afterEach(() => {
    database?.close()
    database = null
    rmSync(directory, { recursive: true, force: true })
  })

  // Catalogue seeding is opt-in, as in tests/catalog-seed.test.ts. The tree is built from
  // the seeded geography, so these tests need the real packaged asset.
  const seedPath = resolve(process.cwd(), 'resources/catalog-seed.v1.json')

  const open = (): AMRITDatabase => {
    database = new AMRITDatabase(databasePath, { seedCatalog: true, catalogSeedPath: seedPath }).initialize()
    return database
  }

  const rows = <T>(sql: string, ...params: unknown[]): T[] => {
    const raw = new DatabaseSync(databasePath)
    try {
      return raw.prepare(sql).all(...(params as never[])) as T[]
    } finally {
      raw.close()
    }
  }

  it('builds the tree from the packaged India geography on a fresh database', () => {
    open()

    const levels = rows<{ level: number; total: number }>(
      'SELECT level, COUNT(*) AS total FROM master_admin_units GROUP BY level ORDER BY level'
    )
    expect(levels).toEqual([
      { level: 1, total: 36 },
      { level: 2, total: 785 }
    ])

    // The India-shaped tables are gone entirely; the tree is the only geography.
    const legacy = rows<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('master_states', 'master_districts')"
    )
    expect(legacy).toEqual([])

    const [sample] = rows<Record<string, unknown>>(
      "SELECT * FROM master_admin_units WHERE country_code = 'IND' AND level = 2 LIMIT 1"
    )
    expect(sample?.code_system).toBe('LGD')
    // admin_path is the whole point: an ASCII prefix that scope filters can match on.
    expect(String(sample?.admin_path)).toMatch(/^IND\/[^/]+\/[^/]+$/)
    expect(String(sample?.parent_id)).toMatch(/^IND:1:/)
  })

  it('marks union territories without needing an India-specific column', () => {
    open()
    const [unionTerritory] = rows<{ total: number }>(
      "SELECT COUNT(*) AS total FROM master_admin_units WHERE unit_type = 'union_territory'"
    )
    const [state] = rows<{ total: number }>(
      "SELECT COUNT(*) AS total FROM master_admin_units WHERE unit_type = 'state'"
    )
    expect(Number(unionTerritory?.total)).toBeGreaterThan(0)
    expect(Number(state?.total)).toBeGreaterThan(0)
    expect(Number(unionTerritory?.total) + Number(state?.total)).toBe(36)
  })

  it('records the latest schema version and keeps the earlier ones', () => {
    open()
    const versions = rows<{ version: number }>('SELECT version FROM app_schema_migrations ORDER BY version')
    expect(versions.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6])
  })

  /**
   * The upgrade an existing India deployment actually performs: LGD masters populated, no
   * tree, laboratories located by LGD code. Everything must end up in the tree and in a
   * structured address, and the LGD tables must be gone.
   */
  it('lifts a pre-tree database and then retires its LGD geography', () => {
    open()
    database?.close()
    database = null

    const raw = new DatabaseSync(databasePath)
    // Rebuild the shape the previous build wrote.
    raw.exec('DROP TABLE master_admin_units')
    raw.exec(`CREATE TABLE master_states(
      lgd_code TEXT PRIMARY KEY, state_name TEXT NOT NULL, country TEXT NOT NULL DEFAULT 'India',
      is_union_territory INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0)`)
    raw.exec(`CREATE TABLE master_districts(
      lgd_code TEXT PRIMARY KEY, state_lgd_code TEXT NOT NULL, district_name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0)`)
    raw.exec("INSERT INTO master_states(lgd_code, state_name) VALUES ('32', 'Kerala')")
    raw.exec("INSERT INTO master_districts(lgd_code, state_lgd_code, district_name) VALUES ('583', '32', 'Ernakulam')")
    for (const column of ['state_lgd_code', 'state_name', 'district_lgd_code', 'district_name']) {
      raw.exec(`ALTER TABLE laboratory ADD COLUMN ${column} TEXT`)
    }
    raw.exec(`INSERT INTO laboratory(code, name, country, state_lgd_code, state_name, district_lgd_code, district_name)
      VALUES ('OLD01', 'Old Lab', 'India', '32', 'Kerala', '583', 'Ernakulam')`)
    raw.exec('DELETE FROM app_schema_migrations WHERE version >= 3')
    raw.close()

    const db = open()

    // The tree was built from the LGD masters before they were dropped.
    const [unit] = rows<Record<string, unknown>>("SELECT * FROM master_admin_units WHERE id = 'IND:2:583'")
    expect(unit?.name).toBe('Ernakulam')
    expect(unit?.admin_path).toBe('IND/32/583')

    // The laboratory is placed in the tree and its names became a structured address.
    const saved = db.getLab('OLD01')
    expect(saved?.admin_unit_id).toBe('IND:2:583')
    expect(saved?.admin_path).toBe('IND/32/583')
    expect(saved?.address?.admin_area).toBe('Kerala')
    expect(saved?.address?.locality).toBe('Ernakulam')

    // Nothing India-shaped is left to read.
    const laboratoryColumns = rows<{ name: string }>('SELECT name FROM pragma_table_info(?)', 'laboratory')
      .map((row) => row.name)
    expect(laboratoryColumns).not.toContain('state_lgd_code')
    expect(laboratoryColumns).not.toContain('district_name')
    const legacy = rows<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('master_states', 'master_districts')"
    )
    expect(legacy).toEqual([])

    const versions = rows<{ version: number }>('SELECT version FROM app_schema_migrations ORDER BY version')
    expect(versions.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('does not rebuild or duplicate the tree on subsequent opens', () => {
    open()
    const [first] = rows<{ total: number }>('SELECT COUNT(*) AS total FROM master_admin_units')
    database?.close()
    database = null

    open()
    const [second] = rows<{ total: number }>('SELECT COUNT(*) AS total FROM master_admin_units')
    expect(second?.total).toBe(first?.total)
  })

  it('derives the path and country from the unit a laboratory is placed at', () => {
    const db = open()
    const [district] = rows<Record<string, unknown>>(
      "SELECT * FROM master_admin_units WHERE level = 2 AND country_code = 'IND' ORDER BY code LIMIT 1"
    )

    db.saveLab({ code: 'TREE01', name: 'Tree Lab', admin_unit_id: String(district?.id) })
    const saved = db.getLab('TREE01')

    expect(saved?.admin_path).toBe(district?.admin_path)
    expect(saved?.country_code).toBe('IND')
  })

  it('links a laboratory that supplies only an admin_path back to its unit', () => {
    const db = open()
    const [district] = rows<Record<string, unknown>>(
      "SELECT * FROM master_admin_units WHERE level = 2 AND country_code = 'IND' ORDER BY code LIMIT 1"
    )

    db.saveLab({ code: 'PATH01', name: 'Path Lab', admin_path: String(district?.admin_path) })
    const saved = db.getLab('PATH01')

    expect(saved?.admin_unit_id).toBe(district?.id)
    expect(saved?.country_code).toBe('IND')
  })

  it('leaves a laboratory with unknown geography alone rather than guessing', () => {
    const db = open()
    db.saveLab({ code: 'BHUTAN01', name: 'Thimphu Lab', country: 'Bhutan', admin_path: 'BTN/11' })
    const saved = db.getLab('BHUTAN01')

    expect(saved?.admin_unit_id ?? null).toBeNull()
    expect(saved?.country).toBe('Bhutan')
  })

  /**
   * The laboratory editor asks for every administrative unit at once so the picker can be
   * searched offline. That request was refused by the IPC limit, so the picker silently had
   * no units in it — the audit trail was the only place the failure showed.
   */
  it('serves a whole country of units in one request, however many there are', () => {
    open()
    const units = database?.listMaster('admin-units', { includeInactive: false, limit: 100_000 }) ?? []
    expect(units.length).toBeGreaterThan(800)
  })

  it('loads another laboratory country hierarchy on demand and derives its placement', () => {
    const db = open()
    const units = db.reportingUnits('USA')
    expect(units.length).toBeGreaterThan(50)
    expect(units.every((unit) => unit.country_code === 'USA')).toBe(true)

    const saved = db.saveLab({
      code: 'USLAB', name: 'US Laboratory', country: 'United States', country_code: 'USA',
      address: { country_code: 'USA', address_lines: ['1 Main Street'], locality: 'Atlanta', admin_area: 'Georgia', postal_code: '30329' }
    })
    expect(saved.admin_unit_id).toBe('USA:1:US-GA')
    expect(saved.admin_path).toBe('USA/US-GA')
  })

  /**
   * A unit had nowhere to record the postal codes it covers, which is the one piece of
   * geography a clerk reads straight off an envelope. Without it an address can only be
   * placed by matching a town name — and the facility form now derives its reporting unit
   * from the address, so the field is load-bearing rather than decorative.
   */
  it('records the postal codes a unit covers, and offers the field for editing', () => {
    const db = open()
    const column = db.masterDefinitions().find((definition) => definition.kind === 'admin-units')
      ?.columns.find((entry) => entry.key === 'postal_code')
    expect(column?.label).toMatch(/postal/i)
    expect(column?.hint).toMatch(/PIN|ZIP/i)

    db.saveMaster('admin-units', {
      id: 'IND:2:9999', country_code: 'IND', level: 2, parent_id: null, code: 'TESTDIST',
      code_system: 'local', name: 'Test District', admin_path: 'IND/TESTDIST',
      postal_code: '682011, 682012, 6821', active: 1
    })
    const saved = rows<{ postal_code: string }>('SELECT postal_code FROM master_admin_units WHERE id = ?', 'IND:2:9999')
    expect(saved[0]?.postal_code).toBe('682011, 682012, 6821')

    // Searchable, so an operator can find a unit by a code a patient gave them.
    const found = db.listMaster('admin-units', { search: '682012', limit: 10 } as never)
    expect(found.map((row) => String(row.id))).toContain('IND:2:9999')
  })

  it('exposes admin units as a master kind and no longer offers the India-shaped pair', () => {
    const db = open()
    const kinds = db.masterDefinitions().map((definition) => definition.kind)
    expect(kinds).toContain('admin-units')
    expect(kinds).not.toContain('states')
    expect(kinds).not.toContain('districts')

    const units = db.listMaster('admin-units', { search: '', limit: 5 } as never)
    expect(units.length).toBeGreaterThan(0)
  })
})
