/**
 * One contract for every outbreak detector.
 *
 * Before this existed there was one algorithm, called directly from
 * `analysis-engine.ts`, with no seam. Phases 28 to 31 add SaTScan interoperability, the
 * SaTScan models this repository does not have, four non-scan detectors and a new one, and
 * every comparison between them has to be made on identical input with identical
 * bookkeeping. That is what this file is: the shape they all agree on.
 *
 * Two things are deliberately in the contract rather than left to each detector.
 *
 * **A detector declares what it needs.** A Bernoulli or Poisson model cannot run without a
 * denominator, and a circular spatial window cannot run without coordinates. Asking and
 * being told is better than a detector that runs anyway and returns something meaningless:
 * a deployment with no denominator should be told the model is unavailable, not handed a
 * number.
 *
 * **A signal carries the detector that produced it.** A cluster reported without its
 * method is not interpretable — the same ward and the same fortnight mean different things
 * from a case-only scan and from a proportion scan — and once several detectors can run,
 * an unattributed signal is also unreproducible.
 */

import type { OutbreakSignal } from '../outbreak-detection'
import type { AntibioticClassRow } from './phenotype'
import type { IsolateRecord } from '../../../shared/types'

export type DetectorFamily = 'scan' | 'process-control' | 'regression' | 'bayesian' | 'external'

export interface DetectorRequirements {
  /**
   * Needs counts of what was *tested*, not only what was positive.
   *
   * The case-only permutation scan is the one method here that does not, which is both its
   * strength (immune to reporting-effort artefacts) and its blind spot (cannot see a rise
   * that is uniform across locations).
   */
  denominators: boolean
  /** Needs latitude/longitude. Categorical ward islands are not enough for a circular window. */
  coordinates: boolean
  /** Needs at least two locations. A single-laboratory deployment cannot run these. */
  multipleLocations: boolean
}

export interface DetectorDescriptor {
  /** Stable identifier. Stored on every signal, so it must not change once published. */
  id: string
  name: string
  /** The published method, named as its authors name it. */
  method: string
  family: DetectorFamily
  requires: DetectorRequirements
  supports: { prospective: boolean; retrospective: boolean }
  /** What this detector cannot see. Stated up front, not discovered in the field. */
  blindSpot: string
  /** Primary citation, or an empty string for an implementation with no published source. */
  citation: string
}

/**
 * Tested and resistant counts for one date, location and organism–antibiotic pair.
 *
 * `antibiotic_code` is empty for an organism-level row, where `tested` counts isolates of
 * that organism and `resistant` is not meaningful and stays zero.
 */
export interface DenominatorRow {
  date: string
  location: string
  organism_code: string
  antibiotic_code: string
  tested: number
  resistant: number
}

/**
 * Population at risk for one date and location.
 *
 * The denominator the Poisson model needs and no laboratory record carries. An isolate
 * says a specimen was taken; it says nothing about how many patients were there to take it
 * from. `deriveDenominators` cannot produce these and does not pretend to —
 * `describeDenominatorCoverage` names patient-days, admissions and occupied beds as
 * unavailable for exactly this reason. A deployment that wants a rate per patient-day has
 * to supply one from whatever system holds it, and until it does the Poisson detector says
 * so instead of substituting isolate counts and calling the result a rate.
 *
 * `population` is in whatever unit the deployment supplies, stated in `unit`. The scan is
 * scale-free — only the proportion of the total inside a window matters — so the unit never
 * enters the statistic. It is carried so a signal can be read.
 */
export interface PopulationRow {
  date: string
  location: string
  population: number
  /** 'patient-days', 'admissions', 'occupied-beds', or whatever the deployment holds. */
  unit: string
}

export interface DetectorContext {
  /** Patient-level records. Present in the desktop, absent in the portal. */
  records?: readonly IsolateRecord[]
  /**
   * The catalogue's `code`, `class_name` and `subclass_name` columns.
   *
   * PACE (Phase 31) pools agents that share a resistance mechanism, and the mechanism is
   * catalogue data rather than a list in the source — a deployment that adds an agent gets it
   * classified without a code change, and the mapping can be audited against a published
   * source. A detector that needs these and is not given them says so instead of silently
   * falling back to per-agent streams, because that fallback is the control arm wearing
   * another detector's name.
   */
  antibioticClasses?: readonly AntibioticClassRow[]
  /** Pre-aggregated denominators, or derived from `records` when absent. */
  denominators?: readonly DenominatorRow[]
  /** Population at risk. Never derivable from laboratory data; supplied or absent. */
  population?: readonly PopulationRow[]
  settings?: Record<string, unknown>
  /**
   * Seed for every stochastic step.
   *
   * Detectors must derive their randomness from this and from the data, never from the
   * clock: a benchmark that cannot be repeated is not evidence. Absent means the detector
   * derives a seed from the input, which is what the existing scan already does.
   */
  seed?: number
}

export interface DetectorSignal extends OutbreakSignal {
  /** Which detector produced this. A signal without its method is not interpretable. */
  detector_id: string
  /**
   * Isolates tested inside the window. Present only for a model that has a denominator.
   *
   * The proportion fields below are carried rather than left to be recomputed, because
   * `observed / expected` and `proportion / baseline_proportion` are the same number only
   * when the denominator is what the reader assumes it is, and the whole point of these
   * models is that it usually is not.
   */
  tested?: number
  /** Resistant share inside the window. */
  proportion?: number
  /** Resistant share everywhere else in the study window. */
  baseline_proportion?: number
  proportion_ratio?: number
  /** Population at risk inside the window, for the Poisson model, in `population_unit`. */
  population?: number
  population_unit?: string
  /** Streams contributing to a multivariate signal, and which they were. */
  streams?: number
  stream_codes?: string[]
}

export interface DetectorRunResult {
  descriptor: DetectorDescriptor
  settings: Record<string, unknown>
  signals: DetectorSignal[]
  warnings: string[]
  /** Counts and dates a reader needs to judge the run: study window, events, locations. */
  diagnostics: Record<string, string | number | null>
}

export interface Detector {
  descriptor: DetectorDescriptor
  defaultSettings(): Record<string, unknown>
  /**
   * Why this detector cannot run on this input, or `null` when it can.
   *
   * Returning a sentence rather than a boolean, because the operator has to be told what
   * to change — "no denominators available" and "only one location" need different answers.
   */
  unavailableReason(context: DetectorContext): string | null
  run(context: DetectorContext): DetectorRunResult
}
