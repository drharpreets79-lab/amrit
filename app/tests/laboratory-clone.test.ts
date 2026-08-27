// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AMRITDatabase } from '../src/main/database'
import type { IsolateRecord, Row } from '../src/shared/types'

describe('transactional laboratory configuration clone', () => {
  let directory: string
  let database: AMRITDatabase

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'amrit-lab-clone-'))
    database = new AMRITDatabase(join(directory, 'amrit.sqlite3')).initialize()
    database.saveLab({
      code: 'SOURCE', name: 'Source Laboratory', country: 'India', country_code: 'IND',
      address: { country_code: 'IND', address_lines: ['12 Hospital Road'], locality: 'Ernakulam', admin_area: 'Kerala', postal_code: '682011' },
      site_group: 'Human health',
      default_guideline: 'EUCAST', default_test_method: 'MIC', guideline_year: '2025',
      use_dynamic_breakpoints: false, round_half_dilutions: false, use_intrinsic_resistance_rules: true,
      breakpoint_types: 'Human', sites_of_infection: 'Urinary', enabled_expert_rules: 'RULE-1',
      conditional_antibiotic_reporting: true, print_clinical_message: true
    })
    database.selectLab('SOURCE')
    database.saveMaster('antibiotics', { code: 'AMK', name: 'Amikacin', potency: '30 µg' })
    database.saveMaster('organisms', { code: 'ECO', organism_name: 'Escherichia coli' })
    database.saveMaster('samples', { code: 'URINE', name: 'Urine' })
    database.saveMaster('locations', {
      location_code: 'ICU-1', location_name: 'Medical ICU', location_type: 'ICU', department: 'Medicine',
      institution: 'Source Hospital', active: true, sort_order: 1
    }, 'SOURCE')
    database.saveMaster('dataFields', {
      field_key: 'local_outcome', field_label: 'Local outcome', category: 'clinical', field_group: 'Clinical information',
      field_length: 24, is_enabled: true, include_in_listing: true, applicable_domains: 'human',
      response_codes: ['Recovered', 'Died'], sort_order: 1
    }, 'SOURCE')
    database.savePanel('SOURCE', {
      panel_name: 'Source urine panel', description: 'Locally reviewed panel', priority: 7,
      source_row_key: 'local:urine', source_dataset: 'local-reviewed', source_version: '1', active: true,
      organisms: [{ code: 'ECO', name: 'Escherichia coli' }],
      specimens: [{ code: 'URINE', name: 'Urine', system: 'http://snomed.info/sct' }],
      antibiotics: [{ code: 'AMK', name: 'Amikacin', requirement_type: 'core', notes: 'Local note' }],
      guidance: [{ requirement_type: 'guidance', notes: 'Review locally' }]
    } as unknown as Row)
    database.saveAnalysisMacro('SOURCE', { macro_name: 'Quarterly AMR', config: { mode: 'trends', includeDrafts: false } })
    database.saveImportProfile({
      lab_code: 'SOURCE', profile_name: 'LIS CSV', file_format: 'delimited', delimiter: ',',
      mapping: { PATIENT: 'patient_id', SPECIMEN: 'specimen_number' }, defaults: { record_status: 'draft' }
    })

    const raw = database.rawConnectionForTesting()
    raw.prepare('INSERT INTO lab_domains(lab_code,domain_code) VALUES (?,?)').run('SOURCE', 'HUMAN')
    raw.prepare('INSERT INTO lab_organisms(lab_code,organism_code,organism_name) VALUES (?,?,?)')
      .run('SOURCE', 'ECO', 'Escherichia coli')
    raw.prepare('INSERT INTO lab_antibiotics(lab_code,antibiotic_code,antibiotic_name) VALUES (?,?,?)')
      .run('SOURCE', 'AMK', 'Amikacin')
    raw.prepare(`INSERT INTO lab_antibiotic_settings(
      lab_code,antibiotic_code,guideline,test_method,disk_potency,test_code,include_in_profile,
      breakpoint_scope,breakpoint_notes,sort_order
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run('SOURCE', 'AMK', 'EUCAST', 'MIC', '30 µg', 'AMK_M', 1, 'Urinary', 'Reviewed', 1)
    raw.prepare('INSERT INTO lab_alerts(lab_code,alert_key) VALUES (?,?)').run('SOURCE', 'important_species')
    raw.prepare(`INSERT INTO lab_custom_alerts(
      lab_code,rule_name,organism_code,organism_name,antibiotic_code,antibiotic_name,trigger_results,
      category,alert_type,priority,message,active,sort_order
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'SOURCE', 'AMK review', 'ECO', 'Escherichia coli', 'AMK', 'Amikacin', 'R', 'microbiological',
      'important_resistance', 'high', 'Review resistance', 1, 1
    )
    raw.prepare(`INSERT INTO lab_catalog_seed_state(
      lab_code,source_dataset,source_version
    ) VALUES (?,?,?)`).run('SOURCE', 'source-seed', '9')

    database.saveRecord({
      lab_code: 'SOURCE', patient_id: 'PRIVATE-1', specimen_number: 'SRC-1', specimen_date: '2026-08-01',
      specimen_type: 'Urine', specimen_code: 'URINE', organism: 'Escherichia coli', organism_code: 'ECO',
      record_status: 'final', antibiotic_results: { AMK: { result: 'R' } }
    } as IsolateRecord)
    const profileId = Number((raw.prepare("SELECT id FROM import_profiles WHERE lab_code='SOURCE'").get() as { id: number }).id)
    raw.prepare(`INSERT INTO import_runs(
      lab_code,profile_id,source_path,imported_rows,draft_rows,failed_rows,notes
    ) VALUES (?,?,?,?,?,?,?)`).run('SOURCE', profileId, '/private/source.csv', 1, 0, 0, 'Source history')
  })

  afterEach(() => {
    try { database.close() } catch { /* already closed */ }
    rmSync(directory, { recursive: true, force: true })
  })

  const count = (table: string, labCode: string): number => Number((database.rawConnectionForTesting()
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE lab_code=?`).get(labCode) as { count: number }).count)

  it('copies every selected configuration table while preserving target identity and excluding operational state', () => {
    const raw = database.rawConnectionForTesting()
    const auditsBefore = Number((raw.prepare('SELECT COUNT(*) AS count FROM app_audit_log').get() as { count: number }).count)
    const result = database.cloneLab('source', {
      code: 'TARGET', name: 'Target Laboratory', country: 'Bhutan', country_code: 'BTN',
      address: { country_code: 'BTN', address_lines: ['Norzin Lam'], locality: 'Thimphu' },
      site_group: 'Environment',
      default_guideline: 'CLSI', default_test_method: 'Disk diffusion', guideline_year: '2099'
    })

    expect(result.laboratory).toMatchObject({
      code: 'TARGET', name: 'Target Laboratory', country: 'Bhutan', country_code: 'BTN',
      // Bhutan's format uppercases the locality, so normalisation stores it that way.
      address: { country_code: 'BTN', address_lines: ['Norzin Lam'], locality: 'THIMPHU', formatted: 'Norzin Lam\nTHIMPHU' },
      site_group: 'Environment', default_guideline: 'EUCAST', default_test_method: 'MIC', guideline_year: '2025',
      use_dynamic_breakpoints: false, round_half_dilutions: false, conditional_antibiotic_reporting: true
    })
    expect(result.counts).toMatchObject({
      laboratory: 1, lab_domains: 1, lab_organisms: 1, lab_antibiotics: 1, lab_antibiotic_settings: 1,
      lab_locations: 1, lab_alerts: 1, lab_custom_alerts: 1, lab_data_fields: 1, lab_panels: 1,
      lab_panel_organisms: 1, lab_panel_specimens: 1, lab_panel_antibiotics: 1,
      analysis_macros: 1, import_profiles: 1
    })
    for (const table of [
      'lab_domains', 'lab_organisms', 'lab_antibiotics', 'lab_antibiotic_settings', 'lab_locations', 'lab_alerts',
      'lab_custom_alerts', 'lab_data_fields', 'lab_panels', 'analysis_macros', 'import_profiles'
    ]) expect(count(table, 'TARGET')).toBeGreaterThan(0)

    expect(count('isolates', 'TARGET')).toBe(0)
    expect(count('import_runs', 'TARGET')).toBe(0)
    expect(count('lab_catalog_seed_state', 'TARGET')).toBe(0)
    expect(database.getPreferences().current_lab_code).toBe('SOURCE')
    expect(database.currentLab()?.code).toBe('SOURCE')
    expect(Number((raw.prepare('SELECT COUNT(*) AS count FROM app_audit_log').get() as { count: number }).count))
      .toBe(auditsBefore + 1)
    const audit = raw.prepare("SELECT * FROM app_audit_log WHERE operation='laboratory.clone-config' ORDER BY id DESC LIMIT 1")
      .get() as Record<string, unknown>
    expect(audit.summary).toBe('SOURCE -> TARGET')
    expect(String(audit.details)).toContain('catalogue seed state')
    expect(String(audit.details)).toContain('import profiles')
    expect(JSON.stringify(database.listImportProfiles('TARGET'))).not.toContain('/private/source.csv')
  })

  it('rejects source/target collisions without changing the existing laboratory', () => {
    database.saveLab({ code: 'EXISTS', name: 'Existing Target', country: 'India' })
    const before = database.listAudit(10_000).length
    expect(() => database.cloneLab('SOURCE', { code: 'EXISTS', name: 'Replacement' })).toThrow(/already exists/i)
    expect(() => database.cloneLab('SOURCE', { code: 'source', name: 'Same site' })).toThrow(/must differ/i)
    expect(database.getLab('EXISTS')?.name).toBe('Existing Target')
    expect(count('lab_panels', 'EXISTS')).toBe(0)
    expect(database.listAudit(10_000)).toHaveLength(before)
  })

  it('rolls back the target laboratory and all copied rows when a mid-copy insert fails', () => {
    const raw = database.rawConnectionForTesting()
    raw.exec(`CREATE TRIGGER force_clone_failure BEFORE INSERT ON lab_data_fields
      WHEN NEW.lab_code='FAIL' BEGIN SELECT RAISE(ABORT,'forced clone failure'); END;`)
    const auditsBefore = database.listAudit(10_000).length
    expect(() => database.cloneLab('SOURCE', { code: 'FAIL', name: 'Must Roll Back' }))
      .toThrow(/forced clone failure/i)
    expect(database.getLab('FAIL')).toBeNull()
    for (const table of [
      'lab_domains', 'lab_organisms', 'lab_antibiotics', 'lab_antibiotic_settings', 'lab_locations', 'lab_alerts',
      'lab_custom_alerts', 'lab_data_fields', 'lab_panels', 'analysis_macros', 'import_profiles'
    ]) expect(count(table, 'FAIL')).toBe(0)
    expect(database.listAudit(10_000)).toHaveLength(auditsBefore)
  })
})
