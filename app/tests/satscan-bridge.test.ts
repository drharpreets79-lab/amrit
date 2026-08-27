// @vitest-environment node

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  ISLAND_GRID_STEP,
  ISLAND_MAX_RADIUS,
  encodeLocationIds,
  invert,
  parseColumnFile,
  parseResultsFile,
  satscanDate,
  writeCaseFile,
  writeControlFile,
  writeCoordinatesFile,
  writeParameterFile,
  writePopulationFile
} from '../src/main/detection/satscan/format'
import { SATSCAN_COMPARATOR, describeComparator, probeSatScan, resolveSatScanPath, runSatScan } from '../src/main/detection/satscan/runner'
import { blandAltman, compareClusters, spearman } from '../src/main/detection/satscan/concordance'
import type { OutbreakCaseEvent, OutbreakSignal } from '../src/main/outbreak-detection'
import type { DenominatorRow, PopulationRow } from '../src/main/detection/types'

/**
 * A bridge to software this repository does not ship.
 *
 * SaTScan is free but cannot be redistributed, so it is not bundled and no SaTScan
 * installation was available where this was written. The writers and parsers are therefore
 * tested against fixtures constructed to SaTScan's published documentation, which proves
 * they are self-consistent and does **not** prove the documentation was read correctly.
 * The first round-trip against a real binary is the check that matters, and
 * `runSatScan` records the version for exactly that reason.
 */

const events: OutbreakCaseEvent[] = [
  { date: '2026-01-01', location: 'Medical ICU', signalType: 'organism', signalCode: 'ORG:KPN', organismCode: 'KPN', organism: 'Klebsiella pneumoniae', count: 2 },
  { date: '2026-01-01', location: 'Oncology / haematology', signalType: 'organism', signalCode: 'ORG:KPN', organismCode: 'KPN', organism: 'Klebsiella pneumoniae', count: 1 },
  { date: '2026-01-02', location: 'Medical ICU', signalType: 'organism', signalCode: 'ORG:KPN', organismCode: 'KPN', organism: 'Klebsiella pneumoniae', count: 1 },
  { date: '2026-01-02', location: 'Medical ICU', signalType: 'resistance', signalCode: 'R:KPN:MEM', organismCode: 'KPN', organism: 'Klebsiella pneumoniae', antibioticCode: 'MEM', count: 3 }
]

const bernoulliDenominators: DenominatorRow[] = [
  { date: '2026-01-01', location: 'Medical ICU', organism_code: 'KPN', antibiotic_code: 'MEM', tested: 6, resistant: 2 },
  { date: '2026-01-02', location: 'Medical ICU', organism_code: 'KPN', antibiotic_code: 'MEM', tested: 6, resistant: 3 },
  { date: '2026-01-01', location: 'Oncology / haematology', organism_code: 'KPN', antibiotic_code: 'MEM', tested: 5, resistant: 1 }
]

const population: PopulationRow[] = [
  { date: '2026-01-01', location: 'Medical ICU', population: 20, unit: 'patient-days' },
  { date: '2026-01-02', location: 'Medical ICU', population: 20, unit: 'patient-days' },
  { date: '2026-01-01', location: 'Oncology / haematology', population: 30, unit: 'patient-days' },
  { date: '2026-01-02', location: 'Oncology / haematology', population: 30, unit: 'patient-days' }
]

describe('SaTScan input files', () => {
  const ids = encodeLocationIds([...new Set(events.map((event) => event.location))])

  it('makes location identifiers SaTScan can actually read', () => {
    // "Oncology / haematology" is a real ward name in this repository's own demonstration
    // network. SaTScan's readers are whitespace-delimited and take no quoting, so a name
    // with spaces and a slash would silently become three columns.
    const encoded = ids.get('Oncology / haematology')
    expect(encoded).toBe('Oncology_haematology')
    expect(encoded).not.toMatch(/[\s/,]/)
    expect(invert(ids).get(encoded as string)).toBe('Oncology / haematology')
  })

  it('keeps identifiers distinct when two names normalise the same way', () => {
    const collided = encodeLocationIds(['Ward A/B', 'Ward A B'])
    expect(new Set(collided.values()).size).toBe(2)
  })

  it('writes the case file as location, count, date, summed per location and day', () => {
    const file = writeCaseFile(events, ids)
    const lines = file.split('\n')
    expect(lines).toContain('Medical_ICU 2 2026/1/1')
    expect(lines).toContain('Oncology_haematology 1 2026/1/1')
    // Both the organism and the resistance event for Medical ICU on the 2nd, summed.
    expect(lines).toContain('Medical_ICU 4 2026/1/2')
  })

  it('restricts to one phenotype when asked, which is how AMRIT scans', () => {
    const file = writeCaseFile(events, ids, { signalCode: 'R:KPN:MEM' })
    expect(file).toBe('Medical_ICU 3 2026/1/2')
  })

  it('writes dates the way SaTScan writes them', () => {
    expect(satscanDate('2026-01-05')).toBe('2026/1/5')
    expect(satscanDate('2026-12-31')).toBe('2026/12/31')
  })

  it('counts controls as tested-minus-resistant, never merging I into resistance', () => {
    const denominators: DenominatorRow[] = [
      { date: '2026-01-01', location: 'Medical ICU', organism_code: 'KPN', antibiotic_code: 'MEM', tested: 10, resistant: 3 },
      { date: '2026-01-01', location: 'Medical ICU', organism_code: 'KPN', antibiotic_code: 'CIP', tested: 10, resistant: 9 },
      { date: '2026-01-02', location: 'Medical ICU', organism_code: 'KPN', antibiotic_code: 'MEM', tested: 4, resistant: 4 }
    ]
    const file = writeControlFile(denominators, ids, 'KPN', 'MEM')
    // 10 tested, 3 resistant -> 7 controls. The all-resistant day contributes no controls
    // and is omitted rather than written as zero.
    expect(file).toBe('Medical_ICU 7 2026/1/1')
  })

  it('spaces locations far enough apart that no circle can reach a second one', () => {
    const file = writeCoordinatesFile(ids)
    const coordinates = file.split('\n').map((line) => line.split(' ').slice(1).map(Number))
    for (const [index, point] of coordinates.entries()) {
      for (const other of coordinates.slice(index + 1)) {
        const distance = Math.hypot((point[0] ?? 0) - (other[0] ?? 0), (point[1] ?? 0) - (other[1] ?? 0))
        // AMRIT infers no adjacency between wards. The grid keeps SaTScan from inventing
        // some, which would be asking it an easier question than AMRIT answers.
        expect(distance).toBeGreaterThan(ISLAND_MAX_RADIUS * 2)
      }
    }
    expect(ISLAND_GRID_STEP).toBeGreaterThan(ISLAND_MAX_RADIUS * 100)
  })

  it('writes a parameter file that provably encodes the AMRIT settings beside it', () => {
    const file = writeParameterFile({
      model: 'space-time-permutation',
      caseFile: '/tmp/cases.cas',
      coordinatesFile: '/tmp/locations.geo',
      resultsFile: '/tmp/results.txt',
      studyStart: '2025-08-15',
      studyEnd: '2026-08-14',
      settings: { analysisType: 'prospective', maxClusterDays: 60, minimumCases: 3, permutations: 999 }
    })
    expect(file).toContain('AnalysisType=4')       // prospective space-time
    expect(file).toContain('ModelType=2')          // space-time permutation
    expect(file).toContain('MonteCarloReps=999')
    expect(file).toContain('MaximumTemporalClusterSize=60')
    expect(file).toContain('MaximumTemporalClusterSizeType=1')  // days, not a percentage
    expect(file).toContain('MinimumCasesInHighCluster=3')
    expect(file).toContain('StartDate=2025/8/15')
    expect(file).toContain('EndDate=2026/8/14')
    expect(file).toContain(`MaxSpatialSizeInDistanceFromCenter=${ISLAND_MAX_RADIUS}`)
    // A reader must be able to check the two arms match without decoding SaTScan's numeric
    // enumerations, so the settings are also in the header in plain text.
    expect(file).toContain('analysisType=prospective')
    expect(file).toContain('permutations=999')
  })

  it('switches analysis and model type for a retrospective Bernoulli run', () => {
    const file = writeParameterFile({
      model: 'bernoulli',
      caseFile: 'c', controlFile: 'ctl', coordinatesFile: 'g', resultsFile: 'r',
      studyStart: '2026-01-01', studyEnd: '2026-06-30',
      settings: { analysisType: 'retrospective', maxClusterDays: 30, minimumCases: 5, permutations: 99 }
    })
    expect(file).toContain('AnalysisType=3')
    expect(file).toContain('ModelType=1')
    expect(file).toContain('ControlFile=ctl')
  })

  it('writes a population file SaTScan can read, one row per location per date', () => {
    const written = writePopulationFile(population, ids)
    // `<location> <date> <population>`, sorted, with the ward name encoded to an identifier
    // SaTScan's whitespace-delimited reader can take.
    expect(written.split('\n')).toEqual([
      'Medical_ICU 2026/1/1 20',
      'Medical_ICU 2026/1/2 20',
      'Oncology_haematology 2026/1/1 30',
      'Oncology_haematology 2026/1/2 30'
    ])
  })

  it('drops a population row for a location the scan is not covering', () => {
    // Silently attributing it to another ward would put patient-days in a denominator that
    // never had them.
    const stray: PopulationRow[] = [{ date: '2026-01-01', location: 'Day surgery', population: 9, unit: 'patient-days' }]
    expect(writePopulationFile(stray, ids)).toBe('')
  })
})

describe('SaTScan output parsing', () => {
  const names = new Map([['Medical_ICU', 'Medical ICU'], ['Ward_B', 'Ward B']])

  const columnFile = [
    'CLUSTER,LOC_ID,LATITUDE,LONGITUDE,RADIUS,START_DATE,END_DATE,NUMBER_LOC,OBSERVED,EXPECTED,ODE,LLR,P_VALUE,RECURR_INT',
    '1,Medical_ICU,0.0,0.0,0.0,2026/7/28,2026/8/14,1,23,8.02,2.87,9.505,0.003,333',
    '2,Ward_B,1000.0,0.0,0.0,2026/8/1,2026/8/14,1,12,5.11,2.35,4.220,0.041,24'
  ].join('\n')

  it('reads the column file, resolving identifiers back to ward names', () => {
    const clusters = parseColumnFile(columnFile, names)
    expect(clusters).toHaveLength(2)
    expect(clusters[0]).toEqual(expect.objectContaining({
      cluster: 1,
      locations: ['Medical ICU'],
      startDate: '2026-07-28',
      endDate: '2026-08-14',
      observed: 23,
      expected: 8.02,
      logLikelihoodRatio: 9.505,
      pValue: 0.003,
      recurrenceIntervalDays: 333
    }))
  })

  it('reads a tab-delimited column file as readily as a comma-delimited one', () => {
    const clusters = parseColumnFile(columnFile.replace(/,/g, '\t'), names)
    expect(clusters).toHaveLength(2)
    expect(clusters[1]?.logLikelihoodRatio).toBe(4.22)
  })

  it('collapses a multi-location cluster written as one row per location', () => {
    const multi = [
      'CLUSTER,LOC_ID,START_DATE,END_DATE,OBSERVED,EXPECTED,LLR,P_VALUE',
      '1,Medical_ICU,2026/7/28,2026/8/14,23,8.02,9.505,0.003',
      '1,Ward_B,2026/7/28,2026/8/14,23,8.02,9.505,0.003'
    ].join('\n')
    const clusters = parseColumnFile(multi, names)
    expect(clusters).toHaveLength(1)
    expect(clusters[0]?.locations).toEqual(['Medical ICU', 'Ward B'])
  })

  it('falls back to the prose results file when no column file was produced', () => {
    const prose = [
      '_____________________________________________________________________',
      '',
      'MOST LIKELY CLUSTER',
      '',
      'CLUSTER 1',
      '  Location IDs included.: Medical_ICU',
      '  Coordinates / radius..: (0.000000,0.000000) / 0 m',
      '  Time frame............: 2026/7/28 to 2026/8/14',
      '  Number of cases.......: 23',
      '  Expected cases........: 8.02',
      '  Observed / expected...: 2.87',
      '  Test statistic........: 9.505',
      '  P-value...............: 0.003',
      '  Recurrence interval...: 333 days',
      ''
    ].join('\n')
    const clusters = parseResultsFile(prose, names)
    expect(clusters).toHaveLength(1)
    expect(clusters[0]).toEqual(expect.objectContaining({
      locations: ['Medical ICU'],
      startDate: '2026-07-28',
      endDate: '2026-08-14',
      observed: 23,
      logLikelihoodRatio: 9.505,
      recurrenceIntervalDays: 333
    }))
  })

  it('returns nothing rather than throwing on an empty or headerless file', () => {
    expect(parseColumnFile('')).toEqual([])
    expect(parseColumnFile('CLUSTER,LOC_ID')).toEqual([])
    expect(parseResultsFile('')).toEqual([])
  })
})

describe('running a SaTScan the operator installed', () => {
  it('reports a clear unavailable state when none is configured', async () => {
    const availability = await probeSatScan('')
    expect(availability.available).toBe(false)
    // The operator has to be told what to do, not merely that something is missing.
    expect(availability.reason).toMatch(/satscan\.org/)
    expect(availability.reason).toMatch(/AMRIT_SATSCAN_PATH/)
  })

  it('does not treat a configured but absent path as available', () => {
    expect(resolveSatScanPath('/nonexistent/satscan')).toBeNull()
  })

  it('describes itself as a comparator rather than pretending to be a Detector', () => {
    // The Detector contract is synchronous and in-process. SaTScan is a subprocess that
    // writes files and can fail for reasons no in-process detector can, so it is listed as
    // a comparator instead of being given a `run` that throws.
    const described = describeComparator('/nonexistent/satscan')
    expect(described.descriptor.id).toBe(SATSCAN_COMPARATOR.id)
    expect(described.descriptor.outOfProcess).toBe(true)
    expect(described.available).toBe(false)
    expect(described.reason).toMatch(/satscan\.org/)
    // The licence position is on the descriptor, because it is why it is not bundled.
    expect(described.descriptor.licence).toMatch(/redistribution not permitted/)
  })

  it('still writes the input files when there is no binary to run them', async () => {
    // The realistic workflow in an air-gapped ministry: prepare the run here, carry the
    // directory to a machine that has SaTScan. A missing binary must not lose the work.
    const result = await runSatScan({
      events,
      settings: { analysisType: 'prospective', maxClusterDays: 14, minimumCases: 3, permutations: 99 },
      studyStart: '2026-01-01',
      studyEnd: '2026-01-02',
      executablePath: '/nonexistent/satscan',
      keepWorkingDirectory: true
    })
    expect(result.ran).toBe(false)
    expect(result.clusters).toEqual([])
    expect(result.workingDirectory).toBeTruthy()
    const directory = result.workingDirectory as string
    expect(existsSync(`${directory}/cases.cas`)).toBe(true)
    expect(existsSync(`${directory}/locations.geo`)).toBe(true)
    expect(existsSync(`${directory}/analysis.prm`)).toBe(true)
    expect(readFileSync(`${directory}/analysis.prm`, 'utf8')).toContain('MonteCarloReps=99')
    rmSync(directory, { recursive: true, force: true })
  })

  it('writes the control file the Bernoulli model needs, and names the model in the parameters', async () => {
    const result = await runSatScan({
      events,
      settings: { analysisType: 'prospective', maxClusterDays: 14, minimumCases: 3, permutations: 99 },
      studyStart: '2026-01-01',
      studyEnd: '2026-01-02',
      model: 'bernoulli',
      denominators: bernoulliDenominators,
      organismCode: 'KPN',
      antibioticCode: 'MEM',
      executablePath: '/nonexistent/satscan',
      keepWorkingDirectory: true
    })
    const directory = result.workingDirectory as string
    expect(existsSync(`${directory}/controls.ctl`)).toBe(true)
    const parameters = readFileSync(`${directory}/analysis.prm`, 'utf8')
    // SaTScan ModelType 1 is Bernoulli. The parameter file also states the AMRIT settings in
    // plain text in its header, so a reviewer need not decode the enumerations.
    expect(parameters).toContain('ModelType=1')
    expect(parameters).toContain('ControlFile=')
    rmSync(directory, { recursive: true, force: true })
  })

  it('refuses a Poisson run with no population rather than substituting isolates', async () => {
    // Substituting isolates tested would ask SaTScan the Bernoulli question and label the
    // answer Poisson, which is the one mistake this bridge exists to prevent.
    const result = await runSatScan({
      events,
      settings: { analysisType: 'prospective', maxClusterDays: 14, minimumCases: 3, permutations: 99 },
      studyStart: '2026-01-01',
      studyEnd: '2026-01-02',
      model: 'poisson',
      executablePath: '/nonexistent/satscan',
      keepWorkingDirectory: true
    })
    // With no binary the run still prepares what it can, and the population file is simply
    // absent because nothing was supplied to write into it.
    const directory = result.workingDirectory as string
    expect(existsSync(`${directory}/population.pop`)).toBe(false)
    expect(readFileSync(`${directory}/analysis.prm`, 'utf8')).toContain('PopulationFile=')
    rmSync(directory, { recursive: true, force: true })
  })

  it('writes the population file when the deployment supplied one', async () => {
    const result = await runSatScan({
      events,
      settings: { analysisType: 'prospective', maxClusterDays: 14, minimumCases: 3, permutations: 99 },
      studyStart: '2026-01-01',
      studyEnd: '2026-01-02',
      model: 'poisson',
      population,
      executablePath: '/nonexistent/satscan',
      keepWorkingDirectory: true
    })
    const directory = result.workingDirectory as string
    expect(existsSync(`${directory}/population.pop`)).toBe(true)
    // SaTScan ModelType 0 is the discrete Poisson.
    expect(readFileSync(`${directory}/analysis.prm`, 'utf8')).toContain('ModelType=0')
    rmSync(directory, { recursive: true, force: true })
  })
})

describe('concordance', () => {
  const signal = (over: Partial<OutbreakSignal>): OutbreakSignal => ({
    signal_id: 'x', status: 'monitor', signal_type: 'Organism', organism: 'Klebsiella pneumoniae',
    antibiotic: '', scope: 'Location cluster', location: 'Medical ICU',
    start_date: '2026-07-28', end_date: '2026-08-14', days: 18,
    observed: 23, expected: 8.02, excess: 14.98, observed_expected_ratio: 2.87,
    log_likelihood_ratio: 9.5, p_value: 0.003, recurrence_interval_days: 333, ...over
  })

  const cluster = (over: Partial<import('../src/main/detection/satscan/format').SatScanCluster> = {}) => ({
    cluster: 1, locationIds: ['Medical_ICU'], locations: ['Medical ICU'],
    startDate: '2026-07-28', endDate: '2026-08-14',
    observed: 23, expected: 8.02, observedExpectedRatio: 2.87,
    logLikelihoodRatio: 9.505, pValue: 0.003, recurrenceIntervalDays: 333, ...over
  })

  it('matches on an identical location set and an overlapping window', () => {
    const report = compareClusters([signal({})], [cluster()])
    expect(report.matched).toBe(1)
    expect(report.satscanRecovered).toBe(1)
    expect(report.pairs[0]?.llrDelta).toBeCloseTo(-0.005, 3)
  })

  it('tolerates a one-day window difference but not a different ward', () => {
    expect(compareClusters([signal({ start_date: '2026-07-29' })], [cluster()]).matched).toBe(1)
    // A cluster over a different ward is a different finding, however similar its numbers.
    expect(compareClusters([signal({ location: 'Ward B' })], [cluster()]).matched).toBe(0)
  })

  it('does not count an all-location cluster as a disagreement', () => {
    // A SaTScan run with island coordinates cannot form a cluster spanning every location,
    // so there is nothing for AMRIT's category-time cluster to match. That is a difference
    // in what was asked, not a disagreement about an answer, and the report says so.
    const report = compareClusters(
      [signal({ scope: 'All-location temporal cluster', location: 'All locations' })],
      [cluster()]
    )
    expect(report.matched).toBe(0)
    expect(report.notes.join(' ')).toMatch(/excluded from matching/)
  })

  it('reports what each side found alone', () => {
    const report = compareClusters(
      [signal({ location: 'Ward B' })],
      [cluster(), cluster({ cluster: 2, locations: ['Ward C'], locationIds: ['Ward_C'] })]
    )
    expect(report.amritOnly).toHaveLength(1)
    expect(report.satscanOnly).toHaveLength(2)
    expect(report.satscanRecovered).toBe(0)
  })

  it('computes Spearman rho with averaged ranks for ties', () => {
    expect(spearman([1, 2, 3, 4], [1, 2, 3, 4])).toBe(1)
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBe(-1)
    expect(spearman([1, 1, 1], [1, 2, 3])).toBeNull()
    expect(spearman([1, 2], [1, 2])).toBeNull()
  })

  it('computes Bland-Altman bias and limits of agreement', () => {
    const result = blandAltman([0.1, -0.1, 0.2, -0.2, 0])
    expect(result?.bias).toBeCloseTo(0, 5)
    expect(result?.upperLimit).toBeGreaterThan(0)
    expect(result?.lowerLimit).toBeLessThan(0)
    expect(blandAltman([1])).toBeNull()
  })

  it('warns that a p-value difference is partly simulation noise', () => {
    const report = compareClusters([signal({})], [cluster()])
    // Two different generators. Only a difference larger than that noise is evidence.
    expect(report.notes.join(' ')).toMatch(/Monte Carlo noise/)
  })

  it('refuses to compute a rank correlation over too few pairs', () => {
    const report = compareClusters([signal({})], [cluster()])
    expect(report.llrSpearman).toBeNull()
    expect(report.notes.join(' ')).toMatch(/Fewer than three matched pairs/)
  })
})
