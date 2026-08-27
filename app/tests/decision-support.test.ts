// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AMRITDatabase } from '../src/main/database'
import type { IsolateRecord, Row } from '../src/shared/types'

describe('decision-support and import-validation parity', () => {
  let directory: string
  let database: AMRITDatabase

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'amrit-decision-'))
    database = new AMRITDatabase(join(directory, 'amrit.sqlite')).initialize()
    database.saveLab({
      code: 'LAB-1', name: 'Decision Support Laboratory', country: 'India',
      use_dynamic_breakpoints: true, use_intrinsic_resistance_rules: true,
      enabled_expert_rules: ['Interpretation alerts'], default_test_method: 'Disk diffusion'
    })
    database.selectLab('LAB-1')
    database.saveMaster('samples', { code: 'BLOOD', name: 'Blood', system: 'http://snomed.info/sct' })
    database.saveMaster('sampleAliases', { alias_text: 'Whole blood specimen', sample_code: 'BLOOD' })
    database.saveMaster('organisms', {
      code: 'ECOLI', organism_name: 'Escherichia coli', common_name: 'E. coli',
      system: 'http://whonet.org', genus_name: 'Escherichia', family_name: 'Enterobacteriaceae'
    })
    database.saveMaster('antibiotics', { code: 'CIP', name: 'Ciprofloxacin', potency: '5 ug' })
    database.saveMaster('antibiotics', { code: 'AMK', name: 'Amikacin', potency: '30 ug' })
  })

  afterEach(() => {
    database.close()
    rmSync(directory, { recursive: true, force: true })
  })

  const isolate = (overrides: Partial<IsolateRecord> = {}): IsolateRecord => ({
    lab_code: 'LAB-1', patient_id: 'P-1', specimen_number: 'S-1', specimen_date: '2026-08-01',
    specimen_type: 'Blood', specimen_code: 'BLOOD', organism: 'Escherichia coli', organism_code: 'ECOLI',
    record_status: 'final', ast_method: 'Disk diffusion',
    antibiotic_results: { CIP: { result: 'S', measurement: 20, method: 'Disk diffusion', potency: '5 ug' } },
    ...overrides
  })

  it('interprets numeric measurements only from an exact row in the explicitly active set and keeps provenance', () => {
    const raw = database.rawConnectionForTesting()
    const setId = Number(raw.prepare(`INSERT INTO master_breakpoint_sets(
      name,organization,edition,source_url,active
    ) VALUES (?,?,?,?,1)`).run('Validated local CLSI set', 'CLSI', 'M100 Ed36', 'https://clsi.org/example').lastInsertRowid)
    raw.prepare(`INSERT INTO whonet_user_breakpoints(
      guidelines,year,test_method,potency,organism_code,site_of_infection,whonet_abx_code,r_value,s_value,
      active,is_custom,source_set_id
    ) VALUES (?,?,?,?,?,?,?,?,?,1,1,?)`).run(
      'CLSI', 'M100 Ed36', 'Disk diffusion', '5 ug', 'ECOLI', 'bloodstream', 'CIP', '14', '17', setId
    )

    const saved = database.saveRecord(isolate({
      site_of_infection: 'bloodstream',
      antibiotic_results: { CIP: { result: '', measurement: 13, method: 'Disk diffusion', potency: '5 ug' } }
    }))
    const cip = database.getRecord(saved.id)?.antibiotic_results?.CIP
    expect(cip).toMatchObject({ result: 'R', method: 'Disk diffusion', guideline: 'CLSI M100 Ed36', potency: '5 ug' })
    expect(cip?.source).toContain('Validated local CLSI set')
    expect(cip?.source).toContain('M100 Ed36')

    const unmatched = database.saveRecord(isolate({
      patient_id: 'P-2', specimen_number: 'S-2', site_of_infection: 'urinary',
      antibiotic_results: { CIP: { result: '', measurement: 13, method: 'Disk diffusion', potency: '5 ug' } }
    }))
    expect(database.getRecord(unmatched.id)?.antibiotic_results?.CIP?.result).toBe('')
  })

  it('uses the bundled WHONET breakpoint catalogue only when no explicit set is active', () => {
    database.rawConnectionForTesting().prepare(`INSERT INTO whonet_breakpoints(
      guidelines,year,test_method,potency,organism_code,breakpoint_type,whonet_abx_code,r_value,s_value,active
    ) VALUES (?,?,?,?,?,?,?,?,?,1)`).run('CLSI', '2026', 'Disk diffusion', '5 ug', 'ECOLI', 'Human', 'CIP', '14', '17')
    const saved = database.saveRecord(isolate({
      antibiotic_results: { CIP: { result: '', measurement: 13, method: 'Disk diffusion', potency: '5 ug' } }
    }))
    expect(database.getRecord(saved.id)?.antibiotic_results?.CIP).toMatchObject({
      result: 'R', source: expect.stringContaining('Bundled WHONET breakpoint catalogue')
    })
  })

  it('evaluates expected resistance, enabled expert rules and laboratory custom alerts deterministically', () => {
    database.saveMaster('expectedResistance', {
      guideline: 'CLSI', reference_table: 'Local intrinsic rule', organism_code: 'ECOLI', abx_code: 'CIP', active: true
    })
    database.saveMaster('expertRules', {
      rule_code: 'LOCAL-CIP', description: 'Local ciprofloxacin review rule', organism_code: 'ECOLI',
      organism_code_type: 'WHONET_ORG_CODE', rule_criteria: 'CIP=S', affected_antibiotics: 'CIP',
      enabled_by_default: true, active: true
    })
    database.rawConnectionForTesting().prepare(`INSERT INTO lab_custom_alerts(
      lab_code,rule_name,organism_code,organism_name,antibiotic_code,antibiotic_name,trigger_results,
      priority,message,active,sort_order
    ) VALUES (?,?,?,?,?,?,?,?,?,1,1)`).run(
      'LAB-1', 'Local susceptible review', 'ECOLI', 'Escherichia coli', 'CIP', 'Ciprofloxacin', 'S',
      'high', 'Confirm this locally configured phenotype.'
    )

    const saved = database.saveRecord(isolate())
    const row = database.getRecord(saved.id)
    const ruleKeys = (row?.alerts as Array<Record<string, unknown>>).map((item) => String(item.rule_key))
    expect(ruleKeys).toEqual(expect.arrayContaining([
      expect.stringMatching(/^custom:/), expect.stringMatching(/^expected-resistance:/), expect.stringMatching(/^expert:/)
    ]))
    expect(row?.expert_comments).toEqual(expect.arrayContaining([
      expect.stringContaining('Expected resistance'), expect.stringContaining('LOCAL-CIP')
    ]))
  })

  it('canonicalizes import aliases and common organism names through the public preview hook', () => {
    const row: Row = {
      lab_code: 'LAB-1', patient_id: 'P-ALIAS', specimen_number: 'S-ALIAS', specimen_date: '2026-08-01',
      specimen_type: 'Whole blood specimen', organism: 'E. coli', record_status: 'final',
      antibiotic_results: { CIP: { result: 'S' } }
    } as unknown as Row
    const issues = database.validateImportedRow(row, 'LAB-1')
    expect(issues.filter((item) => item.severity === 'error')).toHaveLength(0)
    expect(row).toMatchObject({
      specimen_type: 'Blood', specimen_code: 'BLOOD', specimen_system: 'http://snomed.info/sct',
      organism: 'Escherichia coli', organism_code: 'ECOLI', organism_system: 'http://whonet.org'
    })
  })

  it('rejects incomplete final records and duplicate identities while allowing same-id updates', () => {
    expect(() => database.saveRecord(isolate({ antibiotic_results: {}, ast_not_performed_reason: '' })))
      .toThrow(/AST-not-performed reason/i)
    const first = database.saveRecord(isolate())
    expect(() => database.saveRecord(isolate())).toThrow(/Duplicate isolate identity.*record/i)
    expect(() => database.saveRecord(isolate({ id: first.id, notes: 'Same record updated' }))).not.toThrow()

    const notTested = database.saveRecord(isolate({
      patient_id: 'P-2', specimen_number: 'S-2', antibiotic_results: {}, ast_method: 'Not performed',
      no_ast_reason: 'Culture unavailable for AST.'
    }))
    expect(notTested.id).toBeGreaterThan(first.id)
    expect(database.getRecord(notTested.id)?.ast_not_performed_reason).toBe('Culture unavailable for AST.')
  })

  it('rolls back the complete batch when a later canonical row duplicates an earlier row', () => {
    const before = database.getCounts('LAB-1').isolateCount
    const result = database.commitImport([
      isolate({ patient_id: 'P-BATCH', specimen_number: 'S-BATCH', specimen_type: 'Whole blood specimen', specimen_code: '' }),
      isolate({ patient_id: 'P-BATCH', specimen_number: 'S-BATCH', specimen_type: 'Blood', specimen_code: 'BLOOD' })
    ], 'LAB-1')
    expect(result).toMatchObject({ imported: 0, rolledBack: true, failed: 1 })
    expect(result.errors[0]?.row).toBe(2)
    expect(database.getCounts('LAB-1').isolateCount).toBe(before)
  })

  it('retains hidden historical AST snapshots without reinterpreting them on an update', () => {
    const first = database.saveRecord(isolate({
      antibiotic_results: { CIP: { result: 'S', measurement: 20, guideline: 'Historical 2024', source: 'Stored snapshot' } }
    }))
    database.saveRecord(isolate({
      id: first.id,
      antibiotic_results: { AMK: { result: 'R', measurement: 10, guideline: 'Manual' } }
    }))
    expect(database.getRecord(first.id)?.antibiotic_results).toMatchObject({
      CIP: { result: 'S', guideline: 'Historical 2024', source: 'Stored snapshot' },
      AMK: { result: 'R', guideline: 'Manual' }
    })
  })

  it('matches panels by canonical code and exposes choice/synergy guidance and out-of-panel warnings', () => {
    database.savePanel('LAB-1', {
      panel_name: 'ICMR blood panel', priority: 10,
      organisms: [{ code: 'ECOLI', name: 'Escherichia coli' }], specimens: [{ code: 'BLOOD', name: 'Blood' }],
      antibiotics: [
        { code: 'CIP', name: 'Ciprofloxacin', requirement_type: 'one_of', option_group: 'fluoroquinolone' },
        { code: 'AMK', name: 'Amikacin', requirement_type: 'one_of', option_group: 'fluoroquinolone' }
      ]
    } as unknown as Row)
    database.savePanel('LAB-1', {
      panel_name: 'Conflicting display name', priority: 1,
      organisms: [{ code: 'OTHER', name: 'E. coli' }], antibiotics: [{ code: 'CIP', name: 'Ciprofloxacin' }]
    } as unknown as Row)
    const panels = database.matchPanels({
      labCode: 'LAB-1', organismCode: 'ECOLI', organism: 'E. coli', specimenType: 'Whole blood specimen',
      antibioticResults: { MEM: { result: 'R' } }
    })
    expect(panels).toHaveLength(1)
    expect(panels[0]?.panel_name).toBe('ICMR blood panel')
    expect(panels[0]?.testing_guidance).toContain('Choose one: CIP - Ciprofloxacin OR AMK - Amikacin')
    expect(panels[0]?.testing_warnings).toContain('AST results outside this panel: MEM')
  })

  it('binds a UI-authored breakpoint to a staged configurable set and persists master-defined fields', () => {
    database.saveMaster('breakpoints', {
      guidelines: 'Local', year: '2026', test_method: 'MIC', organism_code: 'ECOLI',
      whonet_abx_code: 'CIP', r_value: '1', s_value: '0.25', active: true
    })
    // Master Studio stages the local set rather than activating it; a complete set is only
    // promoted by an explicit activation, while its individual rows still interpret results.
    const stagedSet = database.listBreakpointSets()[0]
    expect(stagedSet).toMatchObject({ organization: 'Local', edition: 'User configured', active: 0 })
    // Staged rows are inactive, so the default active-only listing does not return them.
    expect(database.listMaster('breakpoints')).toHaveLength(0)
    const customBreakpoint = database.listMaster('breakpoints', { includeInactive: true })[0]
    expect(customBreakpoint?.source_set_id).toBe(stagedSet?.id)

    // Interpretation only ever uses the explicitly activated set.
    database.activateBreakpointSet(Number(stagedSet?.id))
    expect(database.listBreakpointSets()[0]).toMatchObject({ organization: 'Local', active: 1 })

    database.saveMaster('dataFields', {
      field_key: 'ward_outcome', field_label: 'Ward outcome', category: 'Clinical', field_group: 'Patient',
      is_enabled: true
    }, 'LAB-1')
    const saved = database.saveRecord(isolate({
      patient_id: 'P-CUSTOM', specimen_number: 'S-CUSTOM', domain: 'HUMAN', hospital_code: 'H-01',
      hospital_name: 'ICMR Hospital', ward_outcome: 'Recovered',
      antibiotic_results: { CIP: { result: '', measurement: 0.2, method: 'MIC' } }
    }))
    expect(database.getRecord(saved.id)).toMatchObject({
      domain: 'HUMAN', hospital_code: 'H-01', hospital_name: 'ICMR Hospital', ward_outcome: 'Recovered',
      antibiotic_results: { CIP: expect.objectContaining({ result: 'S', guideline: 'Local 2026' }) }
    })
  })
})
