import { describe, expect, it } from 'vitest'
import { runDeterministicAnalysis } from '../src/main/analysis-engine'
import type { AnalysisMode, IsolateRecord } from '../src/shared/types'

const records: IsolateRecord[] = [
  {
    id: 1, lab_code: 'LAB', patient_id: 'P1', specimen_number: 'S1', specimen_date: '2026-01-06',
    admission_date: '2026-01-01', location_type: 'in', location: 'ICU', specimen_type: 'Blood',
    organism: 'Staphylococcus aureus', antibiotic_results: { FOX: { result: 'R', measurement: '18 mm' }, VAN: { result: 'S' } }
  },
  {
    id: 2, lab_code: 'LAB', patient_id: 'P2', specimen_number: 'S2', specimen_date: '2026-01-07',
    admission_date: '2026-01-07', location_type: 'in', location: 'ICU', specimen_type: 'Blood',
    organism: 'Staphylococcus aureus', antibiotic_results: { FOX: { result: 'S', measurement: 24 } }
  },
  {
    id: 3, lab_code: 'LAB', patient_id: 'P3', specimen_number: 'S3', specimen_date: '2026-01-08',
    location_type: 'out', location: 'OPD', specimen_type: 'Blood', organism: 'Staphylococcus epidermidis',
    antibiotic_results: { FOX: { result: 'R' } }, alerts: [{ alert_type: 'data_quality' }]
  },
  {
    id: 4, lab_code: 'LAB', patient_id: 'P4', specimen_number: 'S4', specimen_date: '2026-01-09',
    location_type: 'out', location: 'OPD', specimen_type: 'Urine', organism: 'Escherichia coli',
    antibiotic_results: { CIP: { result: 'R' }, CTX: { result: 'I' } }
  },
  {
    id: 5, lab_code: 'LAB', patient_id: 'P5', specimen_number: 'S5', specimen_date: '2026-01-10',
    location_type: 'in', location: 'ICU', specimen_type: 'Blood', organism: 'Staphylococcus aureus',
    antibiotic_results: { FOX: { result: 'R' } }
  }
]

describe('deterministic analysis parity', () => {
  it('generates distinct tables for every advertised mode', () => {
    const modes: AnalysisMode[] = ['ris', 'stewardship', 'unitAntibiogram', 'specimenAntibiogram', 'priorityIndicators', 'dataQuality', 'trends', 'isolateListing', 'summary', 'clusterWatch']
    const signatures = new Set(modes.map((mode) => {
      const result = runDeterministicAnalysis(records, { labCode: 'LAB', mode, antibioticCode: 'FOX' })
      expect(result.title).toBeTruthy()
      expect(result.summaryLines?.length).toBeGreaterThan(0)
      return result.columns?.join('|')
    }))
    expect(signatures.size).toBeGreaterThanOrEqual(8)
  })

  it('preserves tested denominators and Python priority-indicator semantics', () => {
    const ris = runDeterministicAnalysis(records, { labCode: 'LAB', mode: 'ris' })
    expect(ris.byAntibiotic.find((item) => item.code === 'FOX')).toEqual({ code: 'FOX', tested: 4, resistant: 3, percent: 75 })
    const priority = runDeterministicAnalysis(records, { labCode: 'LAB', mode: 'priorityIndicators' })
    expect(priority.rows?.find((row) => row.indicator === 'MRSA among Staphylococcus aureus')).toMatchObject({ numerator: 2, denominator: 3, rate: 66.7 })
  })

  it('stratifies antibiograms and produces antibiotic-specific trends', () => {
    const unit = runDeterministicAnalysis(records, { labCode: 'LAB', mode: 'unitAntibiogram', antibioticCode: 'FOX' })
    expect(unit.rows?.find((row) => row.group === 'ICU')).toMatchObject({ tests: 3, percent_r: 66.7 })
    const trend = runDeterministicAnalysis(records, { labCode: 'LAB', mode: 'trends', antibioticCode: 'FOX' })
    expect(trend.rows).toEqual([{ month: '2026-01', tests: 4, percent_r: 75, percent_i: 0, percent_s: 25 }])
  })

  it('labels contamination and avoids claiming a cluster from a five-day toy cohort', () => {
    const quality = runDeterministicAnalysis(records, { labCode: 'LAB', mode: 'dataQuality' })
    expect(quality.rows?.find((row) => row.metric === 'Possible blood-culture contaminant candidates')).toMatchObject({ value: 1 })
    const cluster = runDeterministicAnalysis(records, { labCode: 'LAB', mode: 'clusterWatch' })
    expect(cluster.clusterFlags).toHaveLength(0)
    expect(cluster.outbreak?.method).toBe('Kulldorff space-time permutation scan statistic')
    expect(cluster.summaryLines?.at(-1)).toContain('not confirmed outbreaks')
  })
})
