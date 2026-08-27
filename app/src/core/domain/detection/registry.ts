/**
 * Which detectors exist, and which of them can run on this data.
 *
 * Registration rather than a switch statement, so that adding a detector in Phases 28 to 31
 * touches no calling code. The registry is also what the interface reads: an operator
 * picking a method needs to see the ones that cannot run *and why*, not a list silently
 * filtered down to whatever happens to be possible.
 */

import {
  BERNOULLI_PURELY_SPATIAL_ID, BERNOULLI_PURELY_TEMPORAL_ID, BERNOULLI_SPACE_TIME_ID,
  bernoulliPurelySpatialDetector, bernoulliPurelyTemporalDetector, bernoulliSpaceTimeDetector
} from './bernoulli'
import { BAYESIAN_SCAN_ID, bayesianScanDetector } from './bayesian-scan'
import { FARRINGTON_ID, farringtonDetector } from './farrington'
import { MULTIVARIATE_ID, multivariateDetector } from './multivariate'
import { PACE_ID, paceDetector } from './pace'
import {
  CUSUM_BERNOULLI_ID, CUSUM_POISSON_ID, EWMA_ID,
  bernoulliCusumDetector, ewmaDetector, poissonCusumDetector
} from './process-control'
import {
  POISSON_PURELY_TEMPORAL_ID, POISSON_SPACE_TIME_ID,
  poissonPurelyTemporalDetector, poissonSpaceTimeDetector
} from './poisson'
import { spaceTimePermutationDetector, SPACE_TIME_PERMUTATION_ID } from './space-time-permutation'
import type { Detector, DetectorContext, DetectorDescriptor } from './types'

const detectors = new Map<string, Detector>()

export function registerDetector(detector: Detector): void {
  const { id } = detector.descriptor
  const existing = detectors.get(id)
  // A detector id is stored on every signal it has ever produced. Silently replacing one
  // would make old signals attribute to new behaviour, so a collision is refused.
  if (existing && existing !== detector) {
    throw new Error(`Detector id '${id}' is already registered. Ids are stored on signals and must be unique.`)
  }
  detectors.set(id, detector)
}

export function getDetector(id: string): Detector {
  const detector = detectors.get(id)
  if (!detector) {
    throw new Error(`No detector '${id}'. Registered: ${[...detectors.keys()].join(', ') || 'none'}`)
  }
  return detector
}

export function listDetectors(): Detector[] {
  return [...detectors.values()]
}

export function describeDetectors(): DetectorDescriptor[] {
  return listDetectors().map((detector) => detector.descriptor)
}

export interface DetectorAvailability {
  descriptor: DetectorDescriptor
  available: boolean
  /** Empty when available. A sentence the operator can act on when not. */
  reason: string
}

export function detectorAvailability(context: DetectorContext): DetectorAvailability[] {
  return listDetectors().map((detector) => {
    const reason = detector.unavailableReason(context)
    return { descriptor: detector.descriptor, available: reason === null, reason: reason ?? '' }
  })
}

/**
 * The detector a deployment gets when it has expressed no preference.
 *
 * Still the case-only permutation scan after Phase 29, deliberately. It is the control arm
 * of every comparison Phases 28 to 34 make, it is what the WHONET-SaTScan workflow runs, and
 * it is the only model here that needs no denominator — so it is the one that works on every
 * deployment. Changing the default before the benchmark has run would be choosing the winner
 * in advance.
 */
export const DEFAULT_DETECTOR_ID = SPACE_TIME_PERMUTATION_ID

// Registration order is the order an operator sees. Case-only first because it is the
// control and the default; then the proportion models it is missing; then the rate model
// that needs a denominator no laboratory holds; then the combined one.
registerDetector(spaceTimePermutationDetector)
registerDetector(bernoulliSpaceTimeDetector)
registerDetector(bernoulliPurelyTemporalDetector)
registerDetector(bernoulliPurelySpatialDetector)
registerDetector(poissonSpaceTimeDetector)
registerDetector(poissonPurelyTemporalDetector)
registerDetector(multivariateDetector)
// Phase 30: the other families. Process control first because it is the cheapest and runs
// on any deployment, then the regression method that needs years no deployment here has.
registerDetector(ewmaDetector)
registerDetector(poissonCusumDetector)
registerDetector(bernoulliCusumDetector)
registerDetector(farringtonDetector)
registerDetector(bayesianScanDetector)
// Phase 31: the one this repository proposes, registered last so the list an operator reads
// still opens with the method the field runs and the comparison is made against.
registerDetector(paceDetector)

export {
  SPACE_TIME_PERMUTATION_ID,
  BERNOULLI_SPACE_TIME_ID, BERNOULLI_PURELY_TEMPORAL_ID, BERNOULLI_PURELY_SPATIAL_ID,
  POISSON_SPACE_TIME_ID, POISSON_PURELY_TEMPORAL_ID,
  MULTIVARIATE_ID,
  EWMA_ID, CUSUM_POISSON_ID, CUSUM_BERNOULLI_ID,
  FARRINGTON_ID,
  BAYESIAN_SCAN_ID,
  PACE_ID
}
export * from './types'
export {
  deriveDenominators, describeDenominatorCoverage, denominatorsFrom, denominatorUnavailableReason
} from './denominators'
export type { DenominatorCoverage } from './denominators'
export { scanBernoulli, bernoulliLogLikelihoodRatio, DEFAULT_BERNOULLI_SETTINGS } from './bernoulli'
export { scanPoisson, poissonLogLikelihoodRatio, DEFAULT_POISSON_SETTINGS } from './poisson'
export { scanMultivariate, DEFAULT_MULTIVARIATE_SETTINGS } from './multivariate'
export { runProcessControl, DEFAULT_PROCESS_CONTROL_SETTINGS } from './process-control'
export { runFarrington, farringtonAt, requiredPeriods, DEFAULT_FARRINGTON_SETTINGS } from './farrington'
export { buildDailySeries, aggregatePeriods, ALL_LOCATIONS } from './series'
export { scanBayesian, DEFAULT_BAYESIAN_SCAN_SETTINGS } from './bayesian-scan'
export {
  runPace, sidak, alertThresholdFor, transmissionPlausibility, DEFAULT_PACE_SETTINGS
} from './pace'
export type { PaceSettings, PaceSignal, PaceModel } from './pace'
export {
  buildPhenotypeIndex, phenotypeForAgent, mapRecordsToPhenotypes, mapRecordToPhenotypes,
  labelForPhenotype, countStreams
} from './phenotype'
export type { AntibioticClassRow, Phenotype } from './phenotype'
