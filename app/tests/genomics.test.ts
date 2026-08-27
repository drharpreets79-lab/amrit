// @vitest-environment node

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AMRITDatabase } from '../src/main/database'
import { attachOmicsFile, omicsFormat, removeStoredOmicsFile } from '../src/main/omics'
import type { IsolateRecord, Row } from '../src/shared/types'

describe('genomic AMR markers and omics artefacts', () => {
  let directory: string
  let database: AMRITDatabase

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'amrit-genomics-'))
    database = new AMRITDatabase(join(directory, 'amrit.sqlite')).initialize()
    database.saveLab({ code: 'LAB-1', name: 'Genomics Laboratory' })
    database.selectLab('LAB-1')
    database.saveMaster('samples', { code: 'BLOOD', name: 'Blood' })
    database.saveMaster('organisms', { code: 'KPN', organism_name: 'Klebsiella pneumoniae' })
    database.saveMaster('antibiotics', { code: 'MEM', name: 'Meropenem' })
  })

  afterEach(() => {
    database.close()
    rmSync(directory, { recursive: true, force: true })
  })

  const isolate = (overrides: Partial<IsolateRecord> = {}): IsolateRecord => ({
    lab_code: 'LAB-1', patient_id: 'P-1', specimen_number: 'S-1', specimen_date: '2026-08-01',
    specimen_code: 'BLOOD', organism_code: 'KPN', record_status: 'final', ...overrides
  })

  it('ships the WHO/ICMR referenced marker catalogue and exposes it as a master kind', () => {
    const markers = database.listMaster('genomicMarkers', { limit: 1000 })
    expect(markers.length).toBeGreaterThan(30)
    const byCode = new Map(markers.map((row) => [String(row.code), row]))
    for (const code of ['BLANDM', 'BLAOXA48', 'MECA', 'VANA', 'MCR', 'RPOB_RIF', 'WGS_ID', 'MALDI_ID']) {
      expect(byCode.has(code)).toBe(true)
    }
    expect(String(byCode.get('BLANDM')?.mechanism_class)).toMatch(/carbapenemase/i)
    // Every seeded marker records where its reporting expectation comes from.
    expect(markers.every((row) => String(row.reporting_standard ?? '').trim().length > 0)).toBe(true)
    expect(markers.every((row) => row.is_custom === false)).toBe(true)
  })

  it('carries genomic markers on a panel with an essential default and returns them from matching', () => {
    database.savePanel('LAB-1', {
      panel_name: 'Carbapenem-resistant Enterobacterales', priority: 1,
      organisms: [{ code: 'KPN', name: 'Klebsiella pneumoniae' }],
      specimens: [{ code: 'BLOOD', name: 'Blood' }],
      antibiotics: [{ code: 'MEM', name: 'Meropenem' }],
      genomic_markers: [
        { code: 'BLANDM', name: 'blaNDM' },
        { code: 'MCR', name: 'mcr-1 to mcr-10', requirement_type: 'optional' }
      ]
    } as unknown as Row)

    const matched = database.matchPanels({ labCode: 'LAB-1', organismCode: 'KPN', specimenCode: 'BLOOD' })
    expect(matched).toHaveLength(1)
    const markers = matched[0]?.genomic_markers as Array<Record<string, unknown>>
    expect(markers.map((marker) => marker.code)).toEqual(['BLANDM', 'MCR'])
    // A prescribed marker is essential unless the panel explicitly relaxes it.
    expect(markers.find((marker) => marker.code === 'BLANDM')?.requirement_type).toBe('core')
    expect(markers.find((marker) => marker.code === 'MCR')?.requirement_type).toBe('optional')
  })

  it('stores genotypic results with their target and reloads them from the normalised table', () => {
    const saved = database.saveRecord(isolate({
      identification_method: 'MALDI-TOF', identification_score: '2.31',
      genomic_results: {
        BLANDM: { result: 'detected', method: 'Xpert Carba-R', target: 'blaNDM-5' },
        MCR: { result: 'not_detected', method: 'PCR' },
        JUNK: { result: 'nonsense-value' as never }
      }
    }))
    const reopened = database.getRecord(saved.id)
    expect(reopened?.identification_method).toBe('MALDI-TOF')
    expect(reopened?.genomic_results?.BLANDM).toMatchObject({ result: 'detected', target: 'blaNDM-5', method: 'Xpert Carba-R' })
    expect(reopened?.genomic_results?.MCR?.result).toBe('not_detected')
    // An unrecognised result is blanked rather than stored as free text.
    expect(reopened?.genomic_results?.JUNK?.result).toBe('')

    const raw = database.rawConnectionForTesting()
    expect((raw.prepare('SELECT COUNT(*) AS count FROM isolate_genomic_results WHERE isolate_id = ?')
      .get(saved.id) as { count: number }).count).toBe(3)
  })

  it('records an omics artefact as metadata plus a managed copy, never as a database blob', async () => {
    const saved = database.saveRecord(isolate({ record_status: 'draft' }))
    const source = join(directory, 'run.fastq.gz')
    writeFileSync(source, 'not-really-compressed-reads')
    const workspace = join(directory, 'workspace')

    const facts = await attachOmicsFile(source, { workspace, labCode: 'LAB-1', isolateId: saved.id })
    expect(facts.file_format).toBe('fastq.gz')
    expect(facts.storage_mode).toBe('copied')
    expect(facts.stored_path).toContain(join('omics', 'LAB-1', String(saved.id)))
    expect(facts.sha256).toHaveLength(64)

    const stored = database.saveOmics({
      ...facts, isolate_id: saved.id, lab_code: 'LAB-1', omics_type: 'wgs',
      platform: 'Illumina NextSeq 550', analysis_tool: 'AMRFinderPlus', result_summary: 'blaNDM-5, blaCTX-M-15'
    })
    expect(Number(stored.file_size)).toBeGreaterThan(0)

    const listed = database.listOmics(saved.id)
    expect(listed).toHaveLength(1)
    expect(String(listed[0]?.result_summary)).toBe('blaNDM-5, blaCTX-M-15')
    expect(database.getRecord(saved.id)?.omics).toHaveLength(1)

    const { storedPath } = database.deleteOmics(Number(stored.id))
    expect(storedPath).toBe(facts.stored_path)
    await removeStoredOmicsFile(storedPath, workspace)
    expect(database.listOmics(saved.id)).toHaveLength(0)
  })

  it('links an oversized artefact instead of copying it, and refuses an unsaved isolate', async () => {
    const saved = database.saveRecord(isolate({ record_status: 'draft' }))
    const source = join(directory, 'large.fasta')
    writeFileSync(source, 'ACGT'.repeat(64))
    const workspace = join(directory, 'workspace')

    const facts = await attachOmicsFile(source, { workspace, labCode: 'LAB-1', isolateId: saved.id, copy: false })
    expect(facts.storage_mode).toBe('linked')
    expect(facts.stored_path).toBe('')
    expect(facts.source_path).toBe(source)
    // A linked original is outside the managed tree and must never be deleted.
    await removeStoredOmicsFile(source, workspace)
    expect(omicsFormat('sample.vcf.gz')).toBe('vcf.gz')

    expect(() => database.saveOmics({ isolate_id: 999_999, omics_type: 'wgs' })).toThrow(/Unknown isolate record/)
    expect(() => database.saveOmics({ isolate_id: saved.id, omics_type: '' })).toThrow(/type of omics data/i)
  })

  it('blocks deleting a marker that a panel or a record still references', () => {
    database.savePanel('LAB-1', {
      panel_name: 'Marker panel', organisms: [{ code: 'KPN', name: 'Klebsiella pneumoniae' }],
      genomic_markers: [{ code: 'BLANDM', name: 'blaNDM' }]
    } as unknown as Row)
    expect(() => database.deleteMaster('genomicMarkers', 'BLANDM')).toThrow()
  })
})
