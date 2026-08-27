import { describe, expect, it } from 'vitest'

import {
  aggregateOutbreakCases,
  buildOutbreakCaseEvents,
  runOutbreakDetection
} from '../src/main/outbreak-detection'
import type { IsolateRecord } from '../src/shared/types'

const iso = (day: number): string => new Date(Date.UTC(2025, 0, 1 + day)).toISOString().slice(0, 10)

function syntheticRecords(): IsolateRecord[] {
  const records: IsolateRecord[] = []
  let id = 1
  for (let day = 0; day < 120; day += 1) {
    records.push({
      id: id++, lab_code: 'LAB', patient_id: `E-${day}`, specimen_date: iso(day),
      organism: 'Escherichia coli', organism_code: 'ECO', location: ['Ward A', 'Ward B', 'ICU'][day % 3],
      antibiotic_results: { MEM: { result: day % 20 === 0 ? 'R' : 'S' } }
    })
    records.push({
      id: id++, lab_code: 'LAB', patient_id: `K-${day}`, specimen_date: iso(day),
      organism: 'Klebsiella pneumoniae', organism_code: 'KPN', location: ['Ward B', 'Ward A', 'ICU'][day % 3],
      antibiotic_results: { MEM: { result: day % 12 === 0 ? 'R' : 'S' } }
    })
  }
  for (let day = 115; day < 120; day += 1) {
    for (let patient = 0; patient < 5; patient += 1) {
      records.push({
        id: id++, lab_code: 'LAB', patient_id: `OUTBREAK-${day}-${patient}`, specimen_date: iso(day),
        organism: 'Klebsiella pneumoniae', organism_code: 'KPN', location: 'ICU',
        antibiotic_results: { MEM: { result: 'R' } }
      })
    }
  }
  return records
}

describe('WHONET-compatible outbreak detection', () => {
  it('detects injected ongoing organism and resistance clusters with maximum-statistic correction', () => {
    const result = runOutbreakDetection(syntheticRecords(), {
      analysisType: 'prospective', target: 'both', baselineDays: 120, maxClusterDays: 14,
      minimumCases: 3, permutations: 99, recurrenceThresholdDays: 50
    })
    expect(result.method).toMatch(/space-time permutation/i)
    expect(result.signals.some((signal) => signal.organism === 'Klebsiella pneumoniae'
      && signal.location === 'ICU' && signal.status === 'alert')).toBe(true)
    expect(result.signals.every((signal) => signal.p_value <= 0.05)).toBe(true)
    const resistance = runOutbreakDetection(syntheticRecords(), {
      analysisType: 'prospective', target: 'resistance', baselineDays: 120, maxClusterDays: 14,
      minimumCases: 3, permutations: 99, recurrenceThresholdDays: 50
    })
    expect(resistance.signals.some((signal) => signal.antibiotic === 'MEM'
      && signal.location === 'ICU')).toBe(true)
  })

  it('uses rolling episode de-duplication instead of deleting later episodes forever', () => {
    const repeated: IsolateRecord[] = [0, 10, 45].map((day, index) => ({
      id: index + 1, lab_code: 'LAB', patient_id: 'P1', specimen_date: iso(day),
      organism: 'Escherichia coli', organism_code: 'ECO', location: 'Ward A',
      antibiotic_results: { CIP: { result: 'R' } }
    }))
    const built = buildOutbreakCaseEvents(repeated, { target: 'organism', deduplicationDays: 30 })
    expect(built.events).toHaveLength(2)
    expect(built.repeatEventsExcluded).toBe(1)
  })

  it('emits aggregate-only portal rows', () => {
    const aggregate = aggregateOutbreakCases(syntheticRecords(), 30)
    expect(aggregate.rows.length).toBeGreaterThan(0)
    expect(JSON.stringify(aggregate)).not.toMatch(/patient_id|specimen_number|location|ward/i)
    expect(aggregate.rows.every((row) => row.count > 0 && /^\d{4}-\d{2}-\d{2}$/.test(row.date))).toBe(true)
  })
})
