/**
 * Phase 31 — PACE.
 *
 * The tests are organised around the claim each one protects. Two matter more than the rest:
 *
 * * **The ablation identity.** PACE with pooling off, one model and the nominal threshold must be
 *   the control arm, signal for signal. If it ever stops being that, every ablation figure in the
 *   paper becomes a comparison between two codebases rather than a measurement of a component.
 * * **Re-ranking is cosmetic.** It must never change which signals exist, their status or their
 *   p-values. The moment it can, the p-values stop meaning what the Methods section says.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_PACE_SETTINGS, PACE_ID, alertThresholdFor, buildPhenotypeIndex, countStreams,
  deriveDenominators, describeDetectors, getDetector, mapRecordsToPhenotypes, phenotypeForAgent,
  runPace, sidak, transmissionPlausibility, type PaceSettings
} from '../src/main/detection/registry'
import { runOutbreakDetection } from '../src/main/outbreak-detection'
import { simulate, type OutbreakSpec } from '../src/main/outbreak-simulation'
import { DEMO_SITES } from '../src/main/demo-population'
import { antibioticClasses } from '../src/main/benchmark/catalogue'
import type { IsolateRecord } from '../src/shared/types'

// The synced copy, as every other detection test reads it, so a fixture change that was not
// run through `tools/sync_shared.py` fails here rather than in CI.
const fixture = JSON.parse(readFileSync(
  resolve(process.cwd(), 'resources/shared/golden-datasets/detector_reference.json'), 'utf8'
)) as {
  detectors: Array<Record<string, unknown>>
  pace: {
    catalogue: Array<{ code: string; class_name: string; subclass_name: string }>
    phenotype_map: Record<string, string | null>
    pooling: {
      records: IsolateRecord[]
      mapped: Array<{ specimen_number: string; antibiotic_results: Record<string, { result: string }> }>
      streams_before: number
      streams_after: number
      denominators: Array<Record<string, unknown>>
    }
    sidak: Array<{ p: number; models: number; combined: number }>
    alert_threshold: Array<{
      target: number; site_years: number; permutations: number
      threshold: number; floored: boolean; ceilinged: boolean
    }>
    plausibility: {
      window_days: number; records: IsolateRecord[]
      score: number; cases_counted: number; admissions_known: number
    }
  }
}

const CLASSES = antibioticClasses()

/** A corpus small enough for a test and large enough to carry a cluster. */
function seededCorpus(spec: OutbreakSpec, windowDays = 180): ReturnType<typeof simulate> {
  return simulate({
    seed: 20260814,
    windowDays,
    backgroundRate: 'medium',
    endDate: '2026-08-14',
    sites: DEMO_SITES.slice(0, 1),
    outbreaks: [spec]
  })
}

const CLONAL: OutbreakSpec = {
  id: 'T-CLONAL', type: 'clonal-multidrug', siteCode: 'DEMO-DEL-01', ward: 'Medical ICU',
  organismCode: 'KPN', phenotypeClass: 'carbapenem', excessCases: 40, durationDays: 21,
  startDaysBeforeEnd: 21
}

describe('phenotype mapping', () => {
  it('maps every agent in the shared fixture to the mechanism both runtimes agree on', () => {
    for (const row of fixture.pace.catalogue) {
      expect(phenotypeForAgent(row)?.id ?? null).toBe(fixture.pace.phenotype_map[row.code] ?? null)
    }
  })

  it('prefers the subclass to the class, because the class is too coarse to be a mechanism', () => {
    // Cephems holds first-generation cephalosporins and fourth-generation ones. They are
    // different mechanisms and pooling them would pool two different outbreaks.
    expect(phenotypeForAgent({ code: 'CRO', class_name: 'Cephems', subclass_name: 'Cephalosporin III' })?.id)
      .toBe('3GC-R')
    expect(phenotypeForAgent({ code: 'FEP', class_name: 'Cephems', subclass_name: 'Cephalosporin IV' })?.id)
      .toBe('4GC-R')
  })

  it('leaves an agent the catalogue does not classify as its own stream', () => {
    // Which is what the case-only scan does with every agent, and is better than pooling it
    // into a class it does not belong to.
    expect(phenotypeForAgent({ code: 'TZP', class_name: 'Beta-lactam+Inhibitors', subclass_name: '' }))
      .toBeNull()
    expect(phenotypeForAgent(undefined)).toBeNull()
  })
})

describe('the counting rule', () => {
  const index = buildPhenotypeIndex(fixture.pace.catalogue)

  it('makes an isolate resistant to three carbapenems one carbapenem-resistant case', () => {
    const mapped = mapRecordsToPhenotypes(fixture.pace.pooling.records, index, true)
    expect(mapped.map((record) => ({
      specimen_number: record.specimen_number,
      antibiotic_results: record.antibiotic_results
    }))).toEqual(fixture.pace.pooling.mapped)
  })

  it('gives R precedence over I and I over S within one mechanism', () => {
    // A carbapenemase is not outvoted by the two carbapenems that still test susceptible.
    const [pooled] = mapRecordsToPhenotypes([{
      lab_code: 'L', specimen_date: '2026-03-01', organism: 'K', organism_code: 'KPN',
      antibiotic_results: { MEM: { result: 'S' }, IPM: { result: 'R' }, ETP: { result: 'I' } }
    } as unknown as IsolateRecord], index, true)
    expect((pooled?.antibiotic_results as Record<string, { result: string }>)['carbapenem-R']?.result)
      .toBe('R')
    const [intermediate] = mapRecordsToPhenotypes([{
      lab_code: 'L', specimen_date: '2026-03-01', organism: 'K', organism_code: 'KPN',
      antibiotic_results: { MEM: { result: 'S' }, IPM: { result: 'I' } }
    } as unknown as IsolateRecord], index, true)
    expect((intermediate?.antibiotic_results as Record<string, { result: string }>)['carbapenem-R']?.result)
      .toBe('I')
  })

  it('produces the denominators the proportion model reads, row for row', () => {
    // One implementation of the counting rule, not two: the pooling happens on the record and
    // every count downstream is derived from it by the functions that already existed.
    const mapped = mapRecordsToPhenotypes(fixture.pace.pooling.records, index, true)
    expect(deriveDenominators(mapped)).toEqual(fixture.pace.pooling.denominators)
  })

  it('reports how much multiplicity the pooling removed', () => {
    const mapped = mapRecordsToPhenotypes(fixture.pace.pooling.records, index, true)
    expect(countStreams(fixture.pace.pooling.records)).toBe(fixture.pace.pooling.streams_before)
    expect(countStreams(mapped)).toBe(fixture.pace.pooling.streams_after)
    expect(fixture.pace.pooling.streams_after).toBeLessThan(fixture.pace.pooling.streams_before)
  })

  it('returns the records untouched when aggregation is off', () => {
    // The ablation arm must run on the control arm's input rather than on a re-derivation of it.
    const records = fixture.pace.pooling.records
    expect(mapRecordsToPhenotypes(records, index, false)).toBe(records)
  })
})

describe('the combination rule', () => {
  it('matches the shared fixture', () => {
    for (const row of fixture.pace.sidak) {
      expect(Number(sidak(row.p, row.models).toFixed(10))).toBeCloseTo(row.combined, 10)
    }
  })

  it('is the identity over one model', () => {
    // Which is what makes the single-model ablation literally the control arm.
    expect(sidak(0.0123, 1)).toBe(0.0123)
    expect(sidak(0.0123, 0)).toBe(0.0123)
  })

  it('is conservative: two models never give a smaller p than one', () => {
    expect(sidak(0.01, 2)).toBeGreaterThan(0.01)
  })
})

describe('the empirical alert threshold', () => {
  it('matches the shared fixture', () => {
    for (const row of fixture.pace.alert_threshold) {
      const measured = alertThresholdFor(row.target, row.site_years, row.permutations)
      expect(Number(measured.threshold.toFixed(10))).toBeCloseTo(row.threshold, 10)
      expect(measured.floored).toBe(row.floored)
      expect(measured.ceilinged).toBe(row.ceilinged)
    }
  })

  it('spends more of the budget the more data it scanned', () => {
    // A budget is per site-year, so a run covering four site-years may alert four times as
    // often as one covering one.
    expect(alertThresholdFor(1, 0.01, 999).threshold).toBeLessThan(alertThresholdFor(1, 0.04, 999).threshold)
  })

  it('reports the Monte Carlo floor rather than pretending to reach below it', () => {
    const floored = alertThresholdFor(0.01, 0.01, 99)
    expect(floored.floored).toBe(true)
    expect(floored.threshold).toBeCloseTo(1 / 100, 10)
  })
})

describe('transmission plausibility', () => {
  it('matches the shared fixture', () => {
    const measured = transmissionPlausibility(
      fixture.pace.plausibility.records, fixture.pace.plausibility.window_days
    )
    expect(measured.score).toBeCloseTo(fixture.pace.plausibility.score, 4)
    expect(measured.cases).toBe(fixture.pace.plausibility.cases_counted)
    expect(measured.admissionsKnown).toBe(fixture.pace.plausibility.admissions_known)
  })

  it('scores cases in different wards as implausible however close in time', () => {
    const apart = transmissionPlausibility([
      { lab_code: 'L', specimen_date: '2026-03-01', admission_date: '2026-02-25', location: 'Ward A' },
      { lab_code: 'L', specimen_date: '2026-03-01', admission_date: '2026-02-25', location: 'Ward B' }
    ] as unknown as IsolateRecord[], 14)
    expect(apart.score).toBe(0)
  })

  it('scores a single case as zero rather than as certain', () => {
    expect(transmissionPlausibility([
      { lab_code: 'L', specimen_date: '2026-03-01', location: 'Ward A' }
    ] as unknown as IsolateRecord[], 14).score).toBe(0)
  })

  it('agrees with comparing every pair, which is what the sweep replaced', () => {
    // The scoring rule is "has at least one ward-mate whose stay overlaps"; the implementation
    // is a sweep because an organism-level signal in a busy ward can carry thousands of
    // isolates. This asserts the optimisation did not change the rule.
    // Deliberately mixed: 36 cases across three wards and two months, so roughly half the cases
    // have a ward-mate and the rest do not. A dense corpus would score 1.0 for every case and
    // pass this vacuously — which is itself the measured behaviour of this metric in a busy
    // ward, recorded in `docs/OUTBREAK_DETECTION.md`.
    const wards = ['Ward A', 'Ward B', 'Ward C']
    const epoch = Date.UTC(2026, 0, 1) / 86_400_000
    const dateFor = (offset: number): string =>
      new Date((epoch + offset) * 86_400_000).toISOString().slice(0, 10)
    const cases: IsolateRecord[] = []
    let state = 20260814
    const next = (): number => {
      state = (state * 1103515245 + 12345) % 2147483648
      return state / 2147483648
    }
    for (let index = 0; index < 36; index += 1) {
      const offset = Math.floor(next() * 60)
      const stay = Math.floor(next() * 3)
      cases.push({
        lab_code: 'L',
        specimen_date: dateFor(offset),
        ...(next() < 0.7 ? { admission_date: dateFor(Math.max(0, offset - stay)) } : {}),
        location: wards[Math.floor(next() * wards.length)] as string
      } as unknown as IsolateRecord)
    }
    const windowDays = 1
    const intervals = cases.map((record) => {
      const specimen = Date.parse(`${String(record.specimen_date)}T00:00:00Z`) / 86_400_000
      const admissionRaw = record.admission_date
        ? Date.parse(`${String(record.admission_date)}T00:00:00Z`) / 86_400_000
        : Number.NaN
      const known = Number.isFinite(admissionRaw) && admissionRaw <= specimen
      return {
        location: String(record.location),
        start: known ? admissionRaw : specimen - windowDays,
        end: known ? specimen : specimen + windowDays
      }
    })
    const pairwise = intervals.filter((interval, index) => intervals.some((other, otherIndex) =>
      otherIndex !== index && other.location === interval.location
      && other.start <= interval.end && other.end >= interval.start)).length
    const measured = transmissionPlausibility(cases, windowDays)
    expect(measured.score).toBeCloseTo(pairwise / intervals.length, 4)
    // A corpus where everything or nothing overlaps would pass this vacuously.
    expect(measured.score).toBeGreaterThan(0)
    expect(measured.score).toBeLessThan(1)
  })
})

describe('registration', () => {
  it('describes PACE the way both runtimes agree it should be described', () => {
    const described = describeDetectors().find((descriptor) => descriptor.id === PACE_ID)
    expect(described).toEqual(fixture.detectors.find((entry) => entry.id === PACE_ID))
    expect(described?.citation).toBe('')
  })

  it('refuses to run without records, because pooling needs the isolate', () => {
    expect(getDetector(PACE_ID).unavailableReason({ denominators: [] }))
      .toMatch(/No records/)
  })

  it('refuses to pool without a catalogue rather than silently becoming the control arm', () => {
    const reason = getDetector(PACE_ID).unavailableReason({
      records: fixture.pace.pooling.records
    })
    expect(reason).toMatch(/No antibiotic catalogue/)
    // Turning the component off deliberately is allowed; falling back to it silently is not.
    expect(getDetector(PACE_ID).unavailableReason({
      records: fixture.pace.pooling.records,
      settings: { aggregatePhenotypes: false }
    })).toBeNull()
  })

  it('defaults to all four components on', () => {
    expect(DEFAULT_PACE_SETTINGS.aggregatePhenotypes).toBe(true)
    expect(DEFAULT_PACE_SETTINGS.models).toBe('dual')
    expect(DEFAULT_PACE_SETTINGS.calibrateThreshold).toBe(true)
    expect(DEFAULT_PACE_SETTINGS.rerankByPlausibility).toBe(true)
  })
})

describe('the ablation identity', () => {
  // The claim every ablation figure rests on. PACE calls the same kernel the control calls;
  // with the components off there is nothing left to differ, and if this ever fails the
  // ablation is measuring two codebases rather than four components.
  const corpus = seededCorpus(CLONAL, 120)
  const control = runOutbreakDetection([...corpus.records], { permutations: 49 })
  const ablate = (extra: Partial<PaceSettings>): ReturnType<typeof runPace> => runPace({
    records: corpus.records,
    antibioticClasses: CLASSES,
    settings: {
      permutations: 49, aggregatePhenotypes: false, models: 'case-only',
      calibrateThreshold: false, ...extra
    },
    seed: 1
  })

  it('is the control arm, signal for signal and in the same order, with every component off', () => {
    const ablated = ablate({ rerankByPlausibility: false })
    expect(ablated.signals).toHaveLength(control.signals.length)
    for (const [index, signal] of control.signals.entries()) {
      const mirrored = ablated.signals[index]
      expect(mirrored?.signal_id).toBe(signal.signal_id)
      expect(mirrored?.status).toBe(signal.status)
      expect(mirrored?.p_value).toBe(signal.p_value)
      expect(mirrored?.log_likelihood_ratio).toBe(signal.log_likelihood_ratio)
      expect(mirrored?.observed).toBe(signal.observed)
      expect(mirrored?.location).toBe(signal.location)
      expect(mirrored?.start_date).toBe(signal.start_date)
      expect(mirrored?.end_date).toBe(signal.end_date)
    }
  })

  it('reports the same signals in a different order when only re-ranking is left on', () => {
    // Re-ranking is the one component that is allowed to change the output with everything else
    // off, and all it may change is the order. Same signals, same statistics, same statuses.
    const reranked = ablate({})
    const identity = (signal: { signal_id: string; p_value: number; status: string }): string =>
      `${signal.signal_id}|${signal.p_value}|${signal.status}`
    expect(new Set(reranked.signals.map(identity)))
      .toEqual(new Set(control.signals.map(identity)))
  })
})

describe('PACE on a seeded corpus', () => {
  const corpus = seededCorpus(CLONAL)
  const result = runPace({
    records: corpus.records, antibioticClasses: CLASSES, settings: { permutations: 49 }, seed: 1
  })

  it('pools the panel into mechanisms and says by how much', () => {
    expect(Number(result.diagnostics.streams_after_aggregation))
      .toBeLessThan(Number(result.diagnostics.streams_before_aggregation))
  })

  it('reports the seeded mechanism as one stream at the seeded ward', () => {
    // The claim is deliberately weaker than "names it first", because measurement said so: on a
    // 120-day and a 365-day corpus PACE ranks `carbapenem-R` first, and on a 180-day one it
    // ranks it eighth behind the cephalosporin streams. The seeded strain really is
    // co-resistant — the simulator forces that — so the cephalosporin cluster is not a false
    // signal, and asserting a rank that holds on two corpora out of three would be choosing the
    // corpus. What holds everywhere is that the mechanism is reported, as one stream, in the
    // right ward. See `docs/OUTBREAK_DETECTION.md`.
    const carbapenem = result.signals.filter((signal) =>
      signal.phenotype.toLocaleUpperCase() === 'CARBAPENEM-R')
    expect(carbapenem.length).toBeGreaterThan(0)
    expect(carbapenem.some((signal) => signal.location === 'Medical ICU')).toBe(true)
  })

  it('reports fewer signals for one outbreak than the per-agent scan does', () => {
    // Measured at 16 against 22 on a 120-day corpus, 14 against 18 at 180 days and 10 against
    // 18 at 365. This is the multiplicity the pooling removes, and it is the mechanism the
    // superiority hypothesis rests on.
    const control = runOutbreakDetection([...corpus.records], { permutations: 49 })
    expect(result.signals.length).toBeLessThan(control.signals.length)
  })

  it('carries both models\' p-values and says which saw the cluster', () => {
    const seen = result.signals.filter((signal) => signal.pace_models.length > 1)
    for (const signal of result.signals) {
      expect(signal.pace_models.length).toBeGreaterThan(0)
      if (signal.pace_models.includes('case-only')) expect(signal.p_case_only).not.toBeNull()
      if (signal.pace_models.includes('proportion')) expect(signal.p_proportion).not.toBeNull()
    }
    // Not an assertion about how many: only that the field means what it says when it is set.
    for (const signal of seen) {
      expect(signal.p_case_only).not.toBeNull()
      expect(signal.p_proportion).not.toBeNull()
    }
  })

  it('re-ranks without changing which signals exist, their status or their p-values', () => {
    const unranked = runPace({
      records: corpus.records, antibioticClasses: CLASSES,
      settings: { permutations: 49, rerankByPlausibility: false }, seed: 1
    })
    const key = (signal: { signal_id: string; status: string; p_value: number }): string =>
      `${signal.signal_id}|${signal.status}|${signal.p_value}`
    expect(new Set(result.signals.map(key))).toEqual(new Set(unranked.signals.map(key)))
    expect(result.signals.every((signal) => signal.transmission_plausibility !== null)).toBe(true)
    expect(unranked.signals.every((signal) => signal.transmission_plausibility === null)).toBe(true)
  })

  it('never lets plausibility promote a monitor past an alert', () => {
    const statuses = result.signals.map((signal) => signal.status)
    const firstMonitor = statuses.indexOf('monitor')
    if (firstMonitor >= 0) {
      expect(statuses.slice(firstMonitor).every((status) => status === 'monitor')).toBe(true)
    }
  })

  it('reports the alert budget it spent and the recurrence interval that implies', () => {
    expect(result.diagnostics.alert_threshold_rule).toMatch(/per site-year/)
    expect(Number(result.diagnostics.implied_recurrence_interval_days)).toBeGreaterThan(0)
  })
})

describe('the dual model', () => {
  it('sees a proportion shift the case-only arm is blind to by construction', () => {
    // Phase 32 built this arm so the resistant *count* does not move and the denominator falls
    // instead. A case-only scan counts resistant cases, so it has nothing to find; the
    // proportion arm does. The corpus needs a ward busy enough to leave a denominator above
    // `minimumTested` after the removal, which is why this runs at the high background rate.
    const corpus = simulate({
      seed: 20260814, windowDays: 365, backgroundRate: 'high', endDate: '2026-08-14',
      sites: [DEMO_SITES.find((site) => site.code === 'DEMO-KOL-01') as (typeof DEMO_SITES)[number]],
      outbreaks: [{
        id: 'T-SHIFT', type: 'proportion-shift', siteCode: 'DEMO-KOL-01', ward: 'General medicine',
        organismCode: 'ECO', phenotypeClass: 'cephalosporin', excessCases: 60, durationDays: 28,
        startDaysBeforeEnd: 28
      }]
    })
    const dual = runPace({
      records: corpus.records, antibioticClasses: CLASSES, settings: { permutations: 49 }, seed: 1
    })
    const found = dual.signals.filter((signal) => signal.pace_models.includes('proportion')
      && signal.location === 'General medicine' && signal.organism.startsWith('Escherichia'))
    expect(found.length).toBeGreaterThan(0)

    const caseOnly = runPace({
      records: corpus.records, antibioticClasses: CLASSES,
      settings: { permutations: 49, models: 'case-only' }, seed: 1
    })
    expect(caseOnly.signals.filter((signal) => signal.location === 'General medicine'
      && signal.organism.startsWith('Escherichia'))).toHaveLength(0)
  }, 120_000)
})
