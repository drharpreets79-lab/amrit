// @vitest-environment node

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { AMRITDatabase } from '../src/main/database'
import type { BreakpointRow } from '../src/main/services'

/**
 * Staging the published EUCAST table against the shipped catalogues.
 *
 * This is the end of the chain the Breakpoint Centre's update button starts: a EUCAST row
 * arrives naming "Amoxicillin oral (uncomplicated UTI only)" for "Enterobacterales", and it
 * has to end up as a code the interpreter can use. When it did not, every row was flagged
 * unmatched and the activation gate — correctly — refused to let the set be used at all.
 */

const seedPath = resolve(process.cwd(), 'resources/catalog-seed.v2.json')
const bundlePath = resolve(process.cwd(), 'resources/breakpoints/eucast-breakpoints.json')

const previousProfile = process.env.AMRIT_COUNTRY_PROFILE
beforeAll(() => { process.env.AMRIT_COUNTRY_PROFILE = 'IN' })
afterAll(() => {
  if (previousProfile === undefined) delete process.env.AMRIT_COUNTRY_PROFILE
  else process.env.AMRIT_COUNTRY_PROFILE = previousProfile
})

describe('EUCAST staging against the shipped catalogues', () => {
  const directories: string[] = []
  const databases: AMRITDatabase[] = []

  const bundled = (): BreakpointRow[] =>
    (JSON.parse(readFileSync(bundlePath, 'utf8')) as { rows: BreakpointRow[] }).rows

  function open(): AMRITDatabase {
    const path = mkdtempSync(join(tmpdir(), 'amrit-breakpoints-'))
    directories.push(path)
    const database = new AMRITDatabase(join(path, 'amrit.sqlite3'), { seedCatalog: true, catalogSeedPath: seedPath }).initialize()
    databases.push(database)
    return database
  }

  async function stage(database: AMRITDatabase, rows: BreakpointRow[], hash = 'e'.repeat(64)) {
    return database.stageBreakpointSet({
      sourcePath: 'https://www.eucast.org/v_15.0_Breakpoint_Tables.xlsx',
      sourceName: 'EUCAST Breakpoint Tables v15.0',
      sourceHash: hash,
      source: { publisher: 'EUCAST', guideline: 'EUCAST', edition: '15.0' },
      rows,
      activate: false
    })
  }

  afterEach(() => {
    for (const database of databases.splice(0)) {
      try { database.close() } catch { /* already closed */ }
    }
    for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
  })

  it('resolves the whole published table without a provisional code', async () => {
    const database = open()
    const rows = bundled()
    expect(rows.length).toBeGreaterThan(500)
    const staged = await stage(database, rows)
    expect(staged.imported).toBe(rows.length)
    // The reported defect: every row unmatched, every row provisional, the set unusable.
    expect(staged.errors ?? []).toEqual([])
    const set = database.listBreakpointSets()[0]
    expect(set).toMatchObject({ unmatched_count: 0, validation_status: 'ready' })
  })

  it('maps a route- and indication-qualified agent onto the catalogue code', async () => {
    const database = open()
    await stage(database, bundled())
    const raw = database.rawConnectionForTesting()
    const amoxicillin = raw.prepare(`SELECT whonet_abx_code,organism_code,organism_code_type,route,site_of_infection
      FROM whonet_user_breakpoints WHERE comments LIKE '%Amoxicillin oral (uncomplicated UTI only)%' AND test_method='MIC'`)
      .all() as Array<Record<string, unknown>>
    expect(amoxicillin.length).toBeGreaterThan(0)
    expect(amoxicillin[0]).toMatchObject({
      whonet_abx_code: 'AMX',
      organism_code: 'GROUP:ENTEROBACTERALES',
      organism_code_type: 'GROUP',
      route: 'oral',
      site_of_infection: 'Uncomplicated urinary tract infection'
    })
  })

  it('narrows a row to the organism the guideline restricted it to', async () => {
    const database = open()
    await stage(database, bundled())
    const raw = database.rawConnectionForTesting()
    const restricted = raw.prepare(`SELECT organism_code FROM whonet_user_breakpoints
      WHERE comments LIKE '%Imipenem, Morganellaceae%' LIMIT 1`).get() as Record<string, unknown> | undefined
    // Widening this row back to the sheet's Enterobacterales would apply a Morganellaceae
    // carbapenem breakpoint to E. coli.
    expect(restricted?.organism_code).toBe('GROUP:MORGANELLACEAE')
  })

  it('still flags a genuinely unknown name for mapping review', async () => {
    const database = open()
    const staged = await stage(database, [{
      guideline: 'EUCAST', edition: '15.0', test_method: 'MIC', antibiotic_code: '',
      antibiotic_name: 'Compound XYZ-1', organism_code: '', organism_name: 'Organism nobody publishes',
      susceptible: '1', intermediate: '', resistant: '4', units: 'mg/L', comments: '', source_sheet: 'Sheet',
      fda_susceptible: '', fda_intermediate: '', fda_resistant: '', clsi_fda_match: ''
    }], 'f'.repeat(64))
    expect(staged.errors?.join(' ')).toMatch(/unmatched antimicrobial/i)
    const set = database.listBreakpointSets()[0]
    expect(set?.validation_status).toBe('needs_mapping_review')
    expect(() => database.activateBreakpointSet(Number(set?.id))).toThrow(/mapping review/i)
  })

  it('refuses a repeat of the same source under the same mapping', async () => {
    const database = open()
    const rows = bundled().slice(0, 20)
    await stage(database, rows)
    const repeat = await stage(database, rows)
    expect(repeat.errors?.[0]).toMatch(/already staged/i)
    expect(database.listBreakpointSets()).toHaveLength(1)
  })

  it('replaces a staging left behind by an older mapping of the same source', async () => {
    const database = open()
    const rows = bundled().slice(0, 20)
    await stage(database, rows)
    const raw = database.rawConnectionForTesting()
    // Exactly the state a laboratory that already pressed "Update EUCAST breakpoints" is in:
    // the edition is staged, under a reading that left its rows unmatched and unusable.
    raw.prepare('UPDATE breakpoint_imports SET mapping_version=1').run()
    const restaged = await stage(database, rows)
    expect(restaged.imported).toBe(rows.length)
    const sets = database.listBreakpointSets()
    expect(sets).toHaveLength(1)
    expect(sets[0]?.name).toBe('EUCAST Breakpoint Tables v15.0')
  })

  it('keeps a set that has ever been activated, however stale its mapping', async () => {
    const database = open()
    const rows = bundled().slice(0, 20)
    await stage(database, rows)
    const first = database.listBreakpointSets()[0]
    database.activateBreakpointSet(Number(first?.id))
    const raw = database.rawConnectionForTesting()
    // Deactivated, so no longer interpreting, but results already carry "breakpoint row N"
    // from it. Dropping those rows would leave a reported result citing nothing.
    raw.prepare("UPDATE breakpoint_imports SET mapping_version=1,status='inactive'").run()
    raw.prepare('UPDATE master_breakpoint_sets SET active=0').run()
    const restaged = await stage(database, rows)
    expect(restaged.imported).toBe(rows.length)
    const sets = database.listBreakpointSets()
    expect(sets).toHaveLength(2)
    expect((raw.prepare('SELECT COUNT(*) AS count FROM whonet_user_breakpoints WHERE source_set_id=?')
      .get(Number(first?.id)) as { count: number }).count).toBe(rows.length)
  })

  it('interprets an isolate through the group its species belongs to', async () => {
    const database = open()
    await stage(database, bundled())
    const set = database.listBreakpointSets()[0]
    database.activateBreakpointSet(Number(set?.id))
    database.saveLab({ code: 'lab-1', name: 'ICMR Test Laboratory', country: 'India', use_dynamic_breakpoints: true })
    database.selectLab('LAB-1')
    const { id } = database.saveRecord({
      lab_code: 'LAB-1', patient_id: 'P-001', specimen_number: 'S-001', specimen_date: '2026-08-01',
      specimen_type: 'Blood / normally sterile fluid', specimen_code: 'BLOOD_STERILE',
      organism: 'Escherichia coli', organism_code: 'ECO', record_status: 'final',
      antibiotic_results: { MEM: { measurement: 0.5, method: 'MIC' } }
    } as never)
    const results = (database.getRecord(id)?.antibiotic_results ?? {}) as Record<string, Record<string, unknown>>
    // EUCAST writes meropenem for Enterobacterales, never for E. coli by name. Before the
    // scope existed there was no row this isolate could ever match.
    expect(results.MEM?.result).toBe('S')
    expect(String(results.MEM?.source)).toMatch(/GROUP:ENTEROBACTERALES/)
  })
})
