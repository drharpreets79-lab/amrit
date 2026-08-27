// @vitest-environment node

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { runOutbreakDetection } from '../src/main/outbreak-detection'
import {
  DEMO_OUTBREAKS,
  acquisitionOffsets,
  agentsForPhenotype,
  factorialDesign,
  simulate,
  type OutbreakSpec
} from '../src/main/outbreak-simulation'
import { DEMO_SITES, ORGANISMS, sequence } from '../src/main/demo-population'
import type { IsolateRecord } from '../src/shared/types'

/**
 * The corpus has to earn its use as a benchmark before any detector is measured on it.
 *
 * Four claims are pinned here. That it is reproducible from its seed, or a benchmark run
 * cannot be repeated. That the ground truth describes what was actually generated, or the
 * answer key is wrong. That a seeded case is indistinguishable from a background case
 * outside the truth file, or every detector is being handed a tell. And that the corpus
 * actually discriminates between methods — the clonal cluster is found, and the proportion
 * shift is not — because a corpus every method scores the same on measures nothing.
 */

const ONE_SITE = DEMO_SITES.slice(0, 1)

/** Small, fast, and still large enough for a scan to have a baseline. */
const SMALL = {
  seed: 4242,
  windowDays: 180,
  backgroundRate: 'low',
  endDate: '2026-08-14',
  sites: ONE_SITE
} as const

describe('outbreak simulation', () => {
  it('is reproducible from its seed, and different at a different seed', () => {
    const first = simulate({ ...SMALL, outbreaks: DEMO_OUTBREAKS.slice(0, 1) })
    const second = simulate({ ...SMALL, outbreaks: DEMO_OUTBREAKS.slice(0, 1) })
    const third = simulate({ ...SMALL, seed: 4243, outbreaks: DEMO_OUTBREAKS.slice(0, 1) })

    expect(JSON.stringify(second.records)).toBe(JSON.stringify(first.records))
    expect(JSON.stringify(second.truth)).toBe(JSON.stringify(first.truth))
    expect(JSON.stringify(third.records)).not.toBe(JSON.stringify(first.records))
  })

  it('does not depend on the day it is run', () => {
    // `endDate` is pinned for exactly this reason. A corpus whose contents move with the
    // wall clock cannot be a fixture, and a benchmark repeated next month would not be a
    // repeat.
    const result = simulate({ ...SMALL, outbreaks: [] })
    expect(result.truth.study_end).toBe('2026-08-14')
    expect(result.truth.study_start).toBe('2026-02-16')
    expect(result.records.at(-1)?.specimen_date?.slice(0, 4)).toBe('2026')
  })

  it('records ground truth that matches what it generated', () => {
    const { records, truth } = simulate({ ...SMALL, outbreaks: DEMO_OUTBREAKS.slice(0, 1) })
    const outbreak = truth.outbreaks[0]
    expect(outbreak).toBeDefined()
    if (!outbreak) return

    const present = new Set(records.map((record) => String(record.specimen_number)))
    for (const specimen of outbreak.case_specimen_numbers) expect(present.has(specimen)).toBe(true)
    expect(outbreak.observed_cases).toBe(outbreak.case_specimen_numbers.length)
    expect(outbreak.case_patient_ids).toHaveLength(outbreak.observed_cases)
    // Every case is a distinct patient. Were they not, the rolling patient-organism
    // de-duplication would collapse the outbreak into one event before any detector saw it.
    expect(new Set(outbreak.case_patient_ids).size).toBe(outbreak.observed_cases)
    expect(truth.total_records).toBe(records.length)

    const cases = records.filter((record) => outbreak.case_specimen_numbers.includes(String(record.specimen_number)))
    for (const record of cases) {
      expect(record.lab_code).toBe(outbreak.site_code)
      expect(record.location).toBe(outbreak.ward)
      expect(record.organism_code).toBe(outbreak.organism_code)
      for (const agent of outbreak.agents) {
        expect((record.antibiotic_results as Record<string, { result: string }>)[agent]?.result).toBe('R')
      }
    }
  })

  it('leaves nothing on a seeded record that marks it as seeded', () => {
    const { records, truth } = simulate({ ...SMALL, outbreaks: DEMO_OUTBREAKS.slice(0, 1) })
    const seeded = new Set(truth.outbreaks[0]?.case_specimen_numbers ?? [])
    const fields = (record: IsolateRecord): string[] => Object.keys(record).sort()

    const seededRecords = records.filter((record) => seeded.has(String(record.specimen_number)))
    const backgroundRecords = records.filter((record) => !seeded.has(String(record.specimen_number)))
    expect(seededRecords.length).toBeGreaterThan(0)
    const shape = fields(backgroundRecords[0] as IsolateRecord)
    for (const record of seededRecords) expect(fields(record)).toEqual(shape)

    // The patient identifier is the one place a tell could hide, so it is checked by shape
    // rather than by trust: it must look like the site's other identifiers.
    for (const record of seededRecords) {
      expect(String(record.patient_id).startsWith(`${String(record.lab_code)}-`)).toBe(true)
    }
  })

  it('holds the resistant count flat for a proportion shift, and lowers the denominator', () => {
    const spec: OutbreakSpec = {
      id: 'PS', type: 'proportion-shift', siteCode: ONE_SITE[0]!.code, ward: 'General medicine',
      organismCode: 'ECO', phenotypeClass: 'cephalosporin',
      excessCases: 12, durationDays: 28, startDaysBeforeEnd: 28
    }
    const before = simulate({ ...SMALL, outbreaks: [] })
    const after = simulate({ ...SMALL, outbreaks: [spec] })

    const inWindow = (record: IsolateRecord): boolean =>
      record.location === 'General medicine' && record.organism_code === 'ECO'
      && String(record.specimen_date) >= (after.truth.outbreaks[0]?.first_specimen_date ?? '9999')
    const fullyResistant = (record: IsolateRecord): boolean =>
      ['CRO', 'CAZ', 'FEP'].every((code) =>
        (record.antibiotic_results as Record<string, { result?: string }>)[code]?.result === 'R')

    const resistantBefore = before.records.filter((r) => inWindow(r) && fullyResistant(r)).length
    const resistantAfter = after.records.filter((r) => inWindow(r) && fullyResistant(r)).length
    const totalBefore = before.records.filter(inWindow).length
    const totalAfter = after.records.filter(inWindow).length

    // The whole point of this arm: resistant cases did not move, so a scan that counts
    // resistant cases has nothing to see. The denominator fell, so the proportion rose.
    expect(resistantAfter).toBe(resistantBefore)
    expect(totalAfter).toBeLessThan(totalBefore)
    expect(after.records.length).toBeLessThan(before.records.length)
  })

  it('adds cases without changing resistance for a pseudo-outbreak', () => {
    const spec: OutbreakSpec = {
      id: 'PO', type: 'pseudo-outbreak', siteCode: ONE_SITE[0]!.code, ward: 'Medical ICU',
      organismCode: 'PAE', phenotypeClass: 'carbapenem',
      excessCases: 20, durationDays: 14, startDaysBeforeEnd: 14
    }
    const { records, truth } = simulate({ ...SMALL, outbreaks: [spec] })
    const outbreak = truth.outbreaks[0]!
    const cases = records.filter((r) => outbreak.case_specimen_numbers.includes(String(r.specimen_number)))
    expect(cases.length).toBeGreaterThan(0)
    // A practice change adds specimens at the ward's ordinary resistance. If every one of
    // them were resistant it would be a transmission cluster wearing a different label.
    const allResistant = cases.every((record) =>
      (record.antibiotic_results as Record<string, { result?: string }>).MEM?.result === 'R')
    expect(allResistant).toBe(false)
  })

  it('reaches the intended cluster size inside the intended duration', () => {
    const random = sequence(11)
    for (const size of [5, 10, 20, 40]) {
      for (const duration of [7, 14, 30]) {
        const offsets = acquisitionOffsets(size, duration, random)
        expect(offsets).toHaveLength(size)
        expect(Math.min(...offsets)).toBe(0)
        expect(Math.max(...offsets)).toBeLessThan(duration)
      }
    }
  })

  it('maps a mechanism onto every agent the organism reports for it', () => {
    const klebsiella = ORGANISMS.find((item) => item.code === 'KPN')!
    expect(agentsForPhenotype(klebsiella, 'carbapenem').sort()).toEqual(['ETP', 'IPM', 'MEM'])
    // Salmonella Typhi reports no carbapenem, so a carbapenem outbreak in it is a
    // specification error and is refused rather than silently seeded on nothing.
    const typhi = ORGANISMS.find((item) => item.code === 'SAT')!
    expect(agentsForPhenotype(typhi, 'carbapenem')).toEqual([])
    expect(() => simulate({
      ...SMALL,
      outbreaks: [{
        type: 'clonal-multidrug', siteCode: ONE_SITE[0]!.code, ward: 'Medical ICU',
        organismCode: 'SAT', phenotypeClass: 'carbapenem',
        excessCases: 5, durationDays: 7, startDaysBeforeEnd: 7
      }]
    })).toThrow(/reports none of that class/)
  })

  it('builds the pre-specified factorial grid, including null replicates', () => {
    const cells = factorialDesign()
    // 5 types x 4 sizes x 3 durations x 3 background rates x 5 replicates, plus 3 x 20 nulls.
    expect(cells.filter((cell) => cell.outbreaks.length)).toHaveLength(5 * 4 * 3 * 3 * 5)
    expect(cells.filter((cell) => !cell.outbreaks.length)).toHaveLength(3 * 20)
    expect(new Set(cells.map((cell) => cell.arm_id)).size).toBe(cells.length)
    expect(new Set(cells.map((cell) => cell.seed)).size).toBe(cells.length)
    // Every seeded outbreak is still running at the data cut, which is the prospective case.
    for (const cell of cells) {
      for (const spec of cell.outbreaks) expect(spec.startDaysBeforeEnd).toBe(spec.durationDays)
    }
  })
})

/**
 * The corpus must separate methods, not merely contain outbreaks.
 *
 * These two run the detector the repository already ships. They are not a benchmark — that
 * is Phase 33 — they are the check that the arms mean what the module says they mean.
 */
describe('the corpus discriminates between detectors', () => {
  const scan = (records: IsolateRecord[]) =>
    runOutbreakDetection(records, { analysisType: 'prospective', permutations: 99 })

  it('the case-only scan finds a clonal cluster', () => {
    const { records, truth } = simulate({
      ...SMALL,
      outbreaks: [{
        id: 'CL', type: 'clonal-multidrug', siteCode: ONE_SITE[0]!.code, ward: 'Medical ICU',
        organismCode: 'KPN', phenotypeClass: 'carbapenem',
        excessCases: 24, durationDays: 21, startDaysBeforeEnd: 21
      }]
    })
    expect(truth.outbreaks[0]!.observed_cases).toBeGreaterThan(8)
    const found = scan(records).signals
      .filter((signal) => signal.organism.startsWith('Klebsiella') && signal.location === 'Medical ICU')
    expect(found.length).toBeGreaterThan(0)
  })

  it('the case-only scan is blind to a proportion shift, which is why the arm exists', () => {
    const { records } = simulate({
      ...SMALL,
      outbreaks: [{
        id: 'PS', type: 'proportion-shift', siteCode: ONE_SITE[0]!.code, ward: 'General medicine',
        organismCode: 'ECO', phenotypeClass: 'cephalosporin',
        excessCases: 18, durationDays: 28, startDaysBeforeEnd: 28
      }]
    })
    const found = scan(records).signals
      .filter((signal) => signal.organism.startsWith('Escherichia') && signal.location === 'General medicine')
    // Not a defect in the detector: a case-only method counts resistant cases and the
    // resistant count did not move. Phase 29's Bernoulli model is what should find this,
    // and this assertion is what will prove it did.
    expect(found).toHaveLength(0)
  })
})

/**
 * A golden digest, so a change to the generator shows up as a diff rather than as a
 * benchmark that silently stopped being comparable to the last one.
 */
describe('golden corpus', () => {
  const goldenPath = resolve(process.cwd(), 'tests/fixtures/outbreak-simulation.golden.json')

  it('matches the committed digest', () => {
    // All four sites, because the shipped outbreaks are spread across three of them.
    const { records, truth } = simulate({
      seed: 4242, windowDays: 180, backgroundRate: 'low', endDate: '2026-08-14',
      outbreaks: DEMO_OUTBREAKS
    })
    const digest = createHash('sha256').update(JSON.stringify(records)).digest('hex')
    const actual = {
      generator_version: truth.generator_version,
      seed: truth.seed,
      study_start: truth.study_start,
      study_end: truth.study_end,
      background_rate: truth.background_rate,
      sites: truth.sites,
      background_records: truth.background_records,
      total_records: truth.total_records,
      records_sha256: digest,
      outbreaks: truth.outbreaks.map((outbreak) => ({
        outbreak_id: outbreak.outbreak_id,
        type: outbreak.type,
        ward: outbreak.ward,
        organism_code: outbreak.organism_code,
        agents: outbreak.agents,
        observed_cases: outbreak.observed_cases,
        first_specimen_date: outbreak.first_specimen_date,
        last_specimen_date: outbreak.last_specimen_date
      }))
    }
    if (process.env.AMRIT_UPDATE_GOLDEN) {
      writeFileSync(goldenPath, `${JSON.stringify(actual, null, 2)}\n`)
    }
    expect(actual).toEqual(JSON.parse(readFileSync(goldenPath, 'utf8')))
  })
})
