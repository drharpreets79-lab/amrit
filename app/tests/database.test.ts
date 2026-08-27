// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AMRITDatabase } from '../src/main/database'
import type { IsolateRecord, Row } from '../src/shared/types'

describe('AMRITDatabase', () => {
  let directory: string
  let database: AMRITDatabase

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'amrit-electron-db-'))
    database = new AMRITDatabase(join(directory, 'amrit.sqlite')).initialize()
  })

  afterEach(() => {
    try { database.close() } catch { /* already closed by a migration test */ }
    rmSync(directory, { recursive: true, force: true })
  })

  function lab(): void {
    database.saveLab({ code: 'lab-1', name: 'ICMR Test Laboratory', country: 'India' })
    database.selectLab('LAB-1')
    database.saveMaster('samples', { code: 'BLOOD', name: 'Blood' })
    database.saveMaster('organisms', { code: 'ECOLI', organism_name: 'Escherichia coli' })
    database.saveMaster('organisms', { code: 'KPNEU', organism_name: 'Klebsiella pneumoniae' })
  }

  function oneHealthAdmin() {
    return database.bootstrapOneHealthAdmin('oh-admin', 'correct horse battery staple')
  }

  function isolate(overrides: Partial<IsolateRecord> = {}): IsolateRecord {
    return {
      lab_code: 'LAB-1',
      patient_id: 'P-001',
      specimen_number: 'S-001',
      specimen_date: '2026-08-01',
      specimen_type: 'Blood',
      specimen_code: 'BLOOD',
      organism: 'Escherichia coli',
      organism_code: 'ECOLI',
      record_status: 'final',
      antibiotic_results: { AMK: { result: 'R', measurement: 12, method: 'Disk diffusion' } },
      ...overrides
    }
  }

  it('creates the compatible schema, enables safety pragmas and exposes every master kind', () => {
    const raw = database.rawConnectionForTesting()
    expect(Number((raw.prepare('PRAGMA foreign_keys').get() as Record<string, unknown>).foreign_keys)).toBe(1)
    expect(Number((raw.prepare('PRAGMA busy_timeout').get() as Record<string, unknown>).timeout)).toBe(5000)
    const tables = new Set((raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name))
    for (const required of [
      'laboratory', 'isolates', 'isolate_ast_results', 'master_hospitals', 'master_breakpoint_sets',
      'breakpoint_imports', 'app_audit_log', 'national_events', 'national_alerts', 'national_outbox',
      'master_genomic_markers', 'lab_panel_genomic_markers', 'isolate_genomic_results', 'isolate_omics',
      'master_admin_units'
    ]) expect(tables.has(required)).toBe(true)
    expect(database.masterDefinitions().map((item) => item.kind).sort()).toEqual([
      'admin-units', 'antibiotics', 'breakpoints', 'codeValues', 'dataFields', 'domains',
      'expectedResistance', 'expertRules', 'genomicMarkers', 'hospitals', 'locations', 'organisms', 'panels',
      'qcRanges', 'sampleAliases', 'samples'
    ].sort())
    expect(database.listMaster('domains').map((item) => item.code)).toEqual(['HUMAN', 'ANIMAL', 'ENVIRONMENT'])
  })

  it('supports laboratory lifecycle and persistent selection without deleting laboratories with data', () => {
    lab()
    expect(database.currentLab()?.code).toBe('LAB-1')
    expect(database.getPreferences().current_lab_code).toBe('LAB-1')
    database.setLabActive('LAB-1', false)
    expect(database.listLabs()).toHaveLength(0)
    database.setLabActive('LAB-1', true)
    database.saveRecord(isolate())
    expect(() => database.deleteLab('LAB-1')).toThrow(/deactivate it instead/i)
  })

  it('supports explicit unbounded internal reads for complete exports without changing UI defaults', () => {
    lab()
    database.saveRecord(isolate())
    database.saveRecord(isolate({ patient_id: 'P-002', specimen_number: 'S-002' }))
    database.saveRecord(isolate({ patient_id: 'P-003', specimen_number: 'S-003' }))
    expect(database.listRecords({ labCode: 'LAB-1', limit: 1 })).toHaveLength(1)
    expect(database.listRecords({ labCode: 'LAB-1', limit: 1, all: true })).toHaveLength(3)
  })

  it('uses allowlisted configurable masters and protects referenced catalogue records', () => {
    lab()
    database.saveMaster('antibiotics', { code: 'amk', name: 'Amikacin', class_name: 'Aminoglycoside' })
    database.saveMaster('organisms', { code: 'ecoli', organism_name: 'Escherichia coli' })
    database.saveMaster('samples', { code: 'blood', name: 'Blood' })
    database.saveMaster('sampleAliases', { alias_text: 'Whole blood', normalized_alias: '', sample_code: 'BLOOD' })
    database.saveMaster('hospitals', { code: 'h-1', name: 'Test Hospital', domain_code: 'HUMAN' })
    database.saveMaster('locations', {
      location_code: 'icu-1', location_name: 'Medical ICU', location_type: 'ICU', institution: 'Test Hospital'
    }, 'LAB-1')
    database.saveMaster('dataFields', {
      field_key: 'custom_outcome', field_label: 'Outcome', category: 'Clinical', field_group: 'Patient',
      response_codes: ['Recovered', 'Died']
    }, 'LAB-1')
    expect(database.listMaster('antibiotics')[0]?.code).toBe('AMK')
    expect(database.listMaster('sampleAliases')[0]?.normalized_alias).toBe('whole blood')
    expect(database.listMaster('locations', { labCode: 'LAB-1' })[0]?.location_code).toBe('ICU-1')
    database.toggleMaster('antibiotics', 'AMK', false)
    expect(database.listMaster('antibiotics')).toHaveLength(0)
    expect(database.listMaster('antibiotics', { includeInactive: true })[0]?.active).toBe(false)
    database.toggleMaster('antibiotics', 'AMK', true)
    database.saveRecord(isolate())
    expect(() => database.deleteMaster('antibiotics', 'AMK')).toThrow(/used by/i)
  })

  it('matches AST panels by organism code before a conflicting name fallback', () => {
    lab()
    database.savePanel('LAB-1', {
      panel_name: 'Name-only higher priority', priority: 1,
      organisms: [{ code: 'OTHER', name: 'Escherichia coli' }],
      antibiotics: [{ code: 'CIP', name: 'Ciprofloxacin' }]
    } as unknown as Row)
    database.savePanel('LAB-1', {
      panel_name: 'Exact code', priority: 100,
      organisms: [{ code: 'ECOLI', name: 'E. coli' }],
      specimens: [{ code: 'BLOOD', name: 'Blood' }],
      antibiotics: [{ code: 'AMK', name: 'Amikacin' }]
    } as unknown as Row)
    const matches = database.matchPanels({ labCode: 'LAB-1', organismCode: 'ECOLI', organism: 'Escherichia coli', specimenCode: 'BLOOD' })
    expect(matches).toHaveLength(1)
    expect(matches[0]?.panel_name).toBe('Exact code')
    expect((matches[0]?.antibiotics as unknown as Array<{ code: string }>)[0]?.code).toBe('AMK')
  })

  it('atomically replaces AST results, detects duplicate identity and rolls back a failed batch', () => {
    lab()
    database.saveMaster('antibiotics', { code: 'AMK', name: 'Amikacin' })
    const saved = database.saveRecord(isolate())
    const first = database.getRecord(saved.id)
    expect(first?.antibiotic_results).toEqual({
      AMK: expect.objectContaining({ result: 'R', measurement: '12' })
    })
    database.saveRecord(isolate({
      id: saved.id,
      replace_antibiotic_results: true,
      antibiotic_results: { CIP: { result: 'S', measurement: 28 } }
    }))
    expect(database.getRecord(saved.id)?.antibiotic_results).toEqual({
      CIP: expect.objectContaining({ result: 'S', measurement: '28' })
    })
    expect(database.findDuplicate(isolate())).toMatchObject({ id: saved.id })
    const before = database.getCounts('LAB-1').isolateCount
    const result = database.commitImport([
      isolate({ patient_id: 'P-002', specimen_number: 'S-002' }),
      isolate()
    ], 'LAB-1')
    expect(result.rolledBack).toBe(true)
    expect(result.imported).toBe(0)
    expect(database.getCounts('LAB-1').isolateCount).toBe(before)
  })

  it('runs local analyses and exposes aggregate-only sync queries', () => {
    lab()
    database.saveRecord(isolate())
    database.saveRecord(isolate({
      patient_id: 'P-002', specimen_number: 'S-002', organism: 'Klebsiella pneumoniae', organism_code: 'KPNEU',
      antibiotic_results: { AMK: { result: 'S' } }
    }))
    const analysis = database.runAnalysis({ labCode: 'LAB-1', mode: 'summary', antibioticCode: 'AMK' })
    expect(analysis).toMatchObject({ total: 2, resistant: 1, susceptible: 1, resistancePercent: 50 })
    expect(database.executeAggregateQuery('resistance_rate', { lab_code: 'LAB-1', antibiotic_code: 'AMK' }))
      .toMatchObject({ denominator: 2, numerator: 1, rate_percent: 50 })
    expect(database.executeAggregateQuery('organism_distribution', { lab_code: 'LAB-1' })).not.toHaveProperty('rows')
    expect(database.executeAggregateQuery('cluster_scan', { lab_code: 'LAB-1' }))
      .toMatchObject({ schema_version: 1, source_records: 2, deduplication_days: 30 })
    expect(() => database.executeAggregateQuery('patient_listing', { lab_code: 'LAB-1' })).toThrow(/unsupported/i)
  })

  it('stages hash-tracked breakpoint sets inactive and activates only by explicit action', async () => {
    database.saveMaster('antibiotics', { code: 'CIP', name: 'Ciprofloxacin' })
    database.saveMaster('organisms', { code: 'ECOLI', organism_name: 'E. coli' })
    const staged = await database.stageBreakpointSet({
      sourcePath: '/tmp/clsi.xlsb',
      sourceName: 'CLSI toolkit Part B',
      sourceHash: 'a'.repeat(64),
      source: { publisher: 'CLSI', guideline: 'CLSI', edition: 'M100 Ed36', url: 'https://clsi.org/example.xlsb' },
      rows: [{
        guideline: 'CLSI', edition: 'M100 Ed36', test_method: 'MIC', antibiotic_code: '',
        antibiotic_name: 'Ciprofloxacin', organism_code: '', organism_name: 'E. coli',
        susceptible: '≤0.25', intermediate: '0.5', resistant: '≥1', units: 'µg/mL',
        fda_susceptible: '', fda_intermediate: '', fda_resistant: '', clsi_fda_match: 'Yes',
        comments: '', source_sheet: 'MIC'
      }],
      activate: false
    })
    expect(staged).toMatchObject({ imported: 1, skipped: 0 })
    const set = database.listBreakpointSets()[0]
    expect(set?.active).toBe(0)
    const stagedRow = database.rawConnectionForTesting().prepare(
      'SELECT whonet_abx_code,organism_code FROM whonet_user_breakpoints WHERE source_set_id=?'
    ).get(Number(set?.id)) as Record<string, unknown>
    expect(stagedRow).toMatchObject({ whonet_abx_code: 'CIP', organism_code: 'ECOLI' })
    expect(database.getCounts().breakpointCount).toBe(0)
    const activated = database.activateBreakpointSet(Number(set?.id))
    expect(activated.active).toBe(1)
    expect(database.getCounts().breakpointCount).toBe(1)
    const duplicate = await database.stageBreakpointSet({
      sourcePath: '/tmp/clsi.xlsb', sourceName: 'Same', sourceHash: 'a'.repeat(64), source: {}, rows: [], activate: false
    })
    expect(duplicate.errors?.[0]).toMatch(/already staged/i)
    await database.stageBreakpointSet({
      sourcePath: '/tmp/unmapped.xlsx', sourceName: 'Unmapped', sourceHash: 'b'.repeat(64),
      source: { guideline: 'CLSI', edition: 'Review' },
      rows: [{
        guideline: 'CLSI', edition: 'Review', test_method: 'MIC', antibiotic_code: '', antibiotic_name: 'Unknown drug',
        organism_code: '', organism_name: 'Unknown organism', susceptible: '1', intermediate: '', resistant: '4',
        units: 'µg/mL', fda_susceptible: '', fda_intermediate: '', fda_resistant: '', clsi_fda_match: '', comments: '', source_sheet: 'Breakpoints'
      }],
      activate: false
    })
    const unresolved = database.listBreakpointSets().find((row) => row.validation_status === 'needs_mapping_review')
    expect(() => database.activateBreakpointSet(Number(unresolved?.id))).toThrow(/mapping review/i)
  })

  it('captures One Health records, produces aggregate metrics and queues aggregate-only payloads', () => {
    lab()
    const identity = oneHealthAdmin()
    const captured = database.captureOneHealth('environment', {
      facility_id: 'LAB-1', observed_at: '2026-08-01', site_ref: 'SITE-1', site_type: 'Hospital wastewater',
      matrix: 'effluent', geospatial_precision: 'admin-unit-only', protocol: 'ICMR-ENV-1', method: 'LC-MS',
      concentration: 2, detection_limit: 1, quality_status: 'validated', actor: 'renderer-spoof'
    }, identity)
    expect(captured.module_key).toBe('environment')
    expect(captured.actor).toBe('oh-admin')
    expect(JSON.stringify(captured.payload)).not.toContain('renderer-spoof')
    expect(database.oneHealthMetrics('environment')).toMatchObject({ total: 1, validated: 1, open_alerts: 1 })
    const queued = database.enqueueOneHealth('environment', identity)
    expect(queued.status).toBe('pending')
    const payload = JSON.parse(String(queued.payload_json)) as Record<string, unknown>
    expect(payload).toHaveProperty('aggregate')
    expect(JSON.stringify(payload)).not.toContain('Wastewater')
    expect(database.listOneHealthAlerts('environment')).toHaveLength(1)
  })

  it('merges active domain, hospital and lab data-field masters into One Health capture schemas', () => {
    lab()
    const identity = oneHealthAdmin()
    database.saveMaster('hospitals', { code: 'ENV-SITE', name: 'Wastewater Sentinel', domain_code: 'ENVIRONMENT' })
    database.saveMaster('dataFields', {
      field_key: 'monitoring_programme', field_label: 'Monitoring programme', category: 'choice',
      field_group: 'one_health:environment', is_enabled: true,
      response_codes: { choices: ['NARS-Net', 'Local'], required: true }
    }, 'LAB-1')
    const environment = database.oneHealthModules().find((item) => item.key === 'environment')
    const fields = environment?.fields as unknown as Array<Record<string, unknown>>
    expect(fields.find((item) => item.key === 'facility_id')?.choices).toEqual(['LAB-1', 'ENV-SITE'])
    expect(fields.find((item) => item.key === 'monitoring_programme')).toMatchObject({ kind: 'choice', required: true })
    const payload = {
      facility_id: 'LAB-1', observed_at: '2026-08-01', site_ref: 'SITE-1', site_type: 'Hospital wastewater',
      matrix: 'effluent', geospatial_precision: 'admin-unit-only', protocol: 'ICMR-ENV-1', method: 'LC-MS'
    }
    expect(() => database.captureOneHealth('environment', payload, identity)).toThrow(/Monitoring programme is required/)
    expect(database.captureOneHealth('environment', { ...payload, monitoring_programme: 'NARS-Net' }, identity).module_key).toBe('environment')
  })

  it('migrates a minimal legacy Python schema idempotently without losing records', () => {
    database.close()
    const path = join(directory, 'legacy.sqlite')
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE laboratory(code TEXT PRIMARY KEY,name TEXT NOT NULL);
      CREATE TABLE isolates(
        id INTEGER PRIMARY KEY AUTOINCREMENT,patient_id TEXT,specimen_number TEXT,specimen_date TEXT,
        specimen_type TEXT,organism TEXT,antibiotic_results TEXT
      );
      INSERT INTO laboratory(code,name) VALUES ('OLD','Legacy Laboratory');
      INSERT INTO isolates(patient_id,specimen_number,specimen_date,specimen_type,organism,antibiotic_results)
      VALUES ('P1','S1','2026-01-01','Blood','E. coli','{"AMK":{"result":"R"}}');
    `)
    legacy.close()
    database = new AMRITDatabase(path).initialize()
    database.initialize()
    expect(database.getLab('OLD')?.name).toBe('Legacy Laboratory')
    expect(database.getRecord(1)?.antibiotic_results?.AMK?.result).toBe('R')
    const columns = database.rawConnectionForTesting().prepare('PRAGMA table_info(isolates)').all() as Array<{ name: string }>
    expect(columns.map((item) => item.name)).toEqual(expect.arrayContaining(['lab_code', 'organism_code', 'record_status', 'created_at']))
  })
})
