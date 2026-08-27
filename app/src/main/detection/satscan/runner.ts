/**
 * Run a SaTScan the operator installed, or say clearly that there is none.
 *
 * SaTScan is free software but its distribution terms do not permit redistribution, so it
 * is not bundled and never will be. The operator installs it and points AMRIT at the batch
 * executable. An absent binary is an ordinary, reportable state — the comparison is simply
 * unavailable — and never a crash, because most deployments will not have it and the rest
 * of the analysis has to keep working.
 *
 * The binary's version is recorded on every run. `paper/AMRIT_paper_phasewise_plan.md`
 * requires it for Study B, and it is also the only way a concordance result stays
 * interpretable after SaTScan changes.
 */

import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { OutbreakCaseEvent, OutbreakSettings } from '../../../core/domain/outbreak-detection'
import {
  encodeLocationIds,
  invert,
  parseColumnFile,
  parseResultsFile,
  writeCaseFile,
  writeControlFile,
  writePopulationFile,
  writeCoordinatesFile,
  writeParameterFile,
  type SatScanCluster,
  type SatScanModel
} from './format'
import type { DenominatorRow, PopulationRow } from '../../../core/domain/detection/types'

const run = promisify(execFile)

/**
 * SaTScan is described but deliberately **not** registered as a `Detector`.
 *
 * The registry's contract is synchronous and in-process, which is what an embedded
 * algorithm is. SaTScan is a subprocess: it writes files, may take minutes, and can fail
 * for reasons no in-process detector can — a missing binary, a version whose output format
 * moved. Forcing it into the same interface would mean either making every detector async
 * for the sake of one, or giving this one a `run` that throws. It is a comparator, and it
 * says so.
 *
 * The descriptor exists so the interface can list it alongside the detectors with an honest
 * reason when it is not configured, rather than the operator wondering whether AMRIT knows
 * SaTScan exists.
 */
export const SATSCAN_COMPARATOR = Object.freeze({
  id: 'satscan-external',
  name: 'SaTScan (installed separately)',
  method: 'Kulldorff scan statistics, as implemented by SaTScan',
  family: 'external' as const,
  outOfProcess: true,
  blindSpot: 'Whatever the configured model\'s blind spot is. AMRIT writes an island coordinates '
    + 'file, so a run driven from here cannot form a cluster spanning more than one location.',
  citation: 'Kulldorff M and Information Management Services, Inc. SaTScan: software for the spatial '
    + 'and space-time scan statistics. https://www.satscan.org/',
  licence: 'Free to use, redistribution not permitted. Not bundled; the operator installs it.'
})

export interface ComparatorAvailability {
  descriptor: typeof SATSCAN_COMPARATOR
  available: boolean
  reason: string
}

/**
 * Synchronous availability, for a list the interface renders without awaiting a subprocess.
 *
 * Says only whether a binary is configured and present. Whether it *runs* needs
 * `probeSatScan`, which executes it.
 */
export function describeComparator(configured?: string): ComparatorAvailability {
  const path = resolveSatScanPath(configured)
  return {
    descriptor: SATSCAN_COMPARATOR,
    available: path !== null,
    reason: path
      ? ''
      : 'No SaTScan executable configured. SaTScan is free but cannot be redistributed, so it is '
        + 'not bundled: install it from satscan.org and set AMRIT_SATSCAN_PATH to the batch executable.'
  }
}

/** Where the operator's SaTScan lives. Explicit setting first, then the environment. */
export function resolveSatScanPath(configured?: string): string | null {
  const candidate = (configured ?? process.env.AMRIT_SATSCAN_PATH ?? '').trim()
  if (!candidate) return null
  return existsSync(candidate) ? candidate : null
}

export interface SatScanAvailability {
  available: boolean
  path: string | null
  version: string | null
  reason: string
}

export async function probeSatScan(configured?: string): Promise<SatScanAvailability> {
  const path = resolveSatScanPath(configured)
  if (!path) {
    return {
      available: false,
      path: null,
      version: null,
      reason: 'No SaTScan executable configured. SaTScan is free but cannot be redistributed, '
        + 'so it is not bundled: install it from satscan.org and set AMRIT_SATSCAN_PATH to the '
        + 'batch executable.'
    }
  }
  try {
    const { stdout, stderr } = await run(path, ['--version'], { timeout: 30_000 })
    const output = `${stdout}${stderr}`.trim()
    const version = /v?\d+\.\d+(\.\d+)?/.exec(output)?.[0] ?? output.split('\n')[0] ?? 'unknown'
    return { available: true, path, version, reason: '' }
  } catch (error) {
    return {
      available: false,
      path,
      version: null,
      reason: `SaTScan at ${path} could not be run: ${(error as Error).message}`
    }
  }
}

export interface SatScanRunOptions {
  events: readonly OutbreakCaseEvent[]
  settings: Pick<OutbreakSettings, 'analysisType' | 'maxClusterDays' | 'minimumCases' | 'permutations'>
  studyStart: string
  studyEnd: string
  model?: SatScanModel
  /** Restrict to one phenotype, which is how AMRIT scans: one series per signal code. */
  signalCode?: string
  /** Required by the Bernoulli model; ignored otherwise. */
  denominators?: readonly DenominatorRow[]
  /** Required by the Poisson model; ignored otherwise. Never derivable from isolates. */
  population?: readonly PopulationRow[]
  organismCode?: string
  antibioticCode?: string
  executablePath?: string
  /** Keep the working directory for inspection instead of deleting it. */
  keepWorkingDirectory?: boolean
  timeoutMs?: number
}

export interface SatScanRunResult {
  ran: boolean
  reason: string
  version: string | null
  clusters: SatScanCluster[]
  workingDirectory: string | null
  /** The exact parameter file used, so a reviewer can check the two arms agree. */
  parameterFile: string
  stdout: string
}

export async function runSatScan(options: SatScanRunOptions): Promise<SatScanRunResult> {
  const availability = await probeSatScan(options.executablePath)
  const model = options.model ?? 'space-time-permutation'
  const locations = [...new Set(options.events
    .filter((event) => !options.signalCode || event.signalCode === options.signalCode)
    .map((event) => event.location))]
  const ids = encodeLocationIds(locations)
  const directory = mkdtempSync(join(tmpdir(), 'amrit-satscan-'))
  const paths = {
    cases: join(directory, 'cases.cas'),
    controls: join(directory, 'controls.ctl'),
    coordinates: join(directory, 'locations.geo'),
    population: join(directory, 'population.pop'),
    results: join(directory, 'results.txt'),
    parameters: join(directory, 'analysis.prm')
  }
  const needsControls = model === 'bernoulli'
  const needsPopulation = model === 'poisson'
  const parameterFile = writeParameterFile({
    model,
    caseFile: paths.cases,
    ...(needsControls ? { controlFile: paths.controls } : {}),
    ...(needsPopulation ? { populationFile: paths.population } : {}),
    coordinatesFile: paths.coordinates,
    resultsFile: paths.results,
    studyStart: options.studyStart,
    studyEnd: options.studyEnd,
    settings: options.settings
  })

  // A failed run keeps its working directory: the inputs are what someone needs to see to
  // work out why. Only the one path that fails before writing anything cleans up after
  // itself.
  const cleanup = (): void => {
    if (!options.keepWorkingDirectory) rmSync(directory, { recursive: true, force: true })
  }

  if (!availability.available) {
    // Still write the files. A deployment without SaTScan installed can hand the directory
    // to someone who has it, which is the realistic workflow in an air-gapped ministry.
    writeFileSync(paths.cases, writeCaseFile(options.events, ids, options.signalCode ? { signalCode: options.signalCode } : {}))
    writeFileSync(paths.coordinates, writeCoordinatesFile(ids))
    writeFileSync(paths.parameters, parameterFile)
    if (needsControls && options.denominators) {
      writeFileSync(paths.controls, writeControlFile(
        options.denominators, ids, options.organismCode ?? '', options.antibioticCode ?? ''
      ))
    }
    if (needsPopulation && options.population) {
      writeFileSync(paths.population, writePopulationFile(options.population, ids))
    }
    return {
      ran: false,
      reason: availability.reason,
      version: null,
      clusters: [],
      workingDirectory: directory,
      parameterFile,
      stdout: ''
    }
  }

  try {
    writeFileSync(paths.cases, writeCaseFile(options.events, ids, options.signalCode ? { signalCode: options.signalCode } : {}))
    writeFileSync(paths.coordinates, writeCoordinatesFile(ids))
    writeFileSync(paths.parameters, parameterFile)
    if (needsControls) {
      if (!options.denominators?.length) {
        cleanup()
        return {
          ran: false,
          reason: 'The Bernoulli model needs controls, and no denominators were supplied.',
          version: availability.version,
          clusters: [],
          workingDirectory: null,
          parameterFile,
          stdout: ''
        }
      }
      writeFileSync(paths.controls, writeControlFile(
        options.denominators, ids, options.organismCode ?? '', options.antibioticCode ?? ''
      ))
    }
    if (needsPopulation) {
      if (!options.population?.length) {
        cleanup()
        return {
          ran: false,
          // The one denominator no laboratory record carries. Substituting isolates tested
          // would ask SaTScan the Bernoulli question and label the answer Poisson.
          reason: 'The Poisson model needs a population at risk, and none was supplied.',
          version: availability.version,
          clusters: [],
          workingDirectory: null,
          parameterFile,
          stdout: ''
        }
      }
      writeFileSync(paths.population, writePopulationFile(options.population, ids))
    }

    const { stdout } = await run(availability.path as string, [paths.parameters], {
      timeout: options.timeoutMs ?? 900_000,
      maxBuffer: 64 * 1024 * 1024
    })

    // The column file is delimited and stable; the prose report is laid out for a human and
    // its wording has moved between versions. Prefer the first, fall back to the second.
    const columnCandidates = ['results.col.txt', 'results.col', 'results.col.csv']
    let clusters: SatScanCluster[] = []
    const names = invert(ids)
    for (const candidate of columnCandidates) {
      const candidatePath = join(directory, candidate)
      if (!existsSync(candidatePath)) continue
      clusters = parseColumnFile(readFileSync(candidatePath, 'utf8'), names)
      if (clusters.length) break
    }
    if (!clusters.length && existsSync(paths.results)) {
      clusters = parseResultsFile(readFileSync(paths.results, 'utf8'), names)
    }

    return {
      ran: true,
      reason: '',
      version: availability.version,
      clusters,
      workingDirectory: options.keepWorkingDirectory ? directory : null,
      parameterFile,
      stdout
    }
  } catch (error) {
    return {
      ran: false,
      reason: `SaTScan run failed: ${(error as Error).message}`,
      version: availability.version,
      clusters: [],
      workingDirectory: directory,
      parameterFile,
      stdout: ''
    }
  }
}
