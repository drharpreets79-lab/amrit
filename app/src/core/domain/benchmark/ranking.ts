/**
 * What counts as "more evidence", for each detector, pre-specified.
 *
 * Twelve detectors across four families do not share a scale. A scan statistic reports a
 * log-likelihood ratio and a Monte Carlo p-value; a control chart reports how far past its
 * limit it went; Farrington reports an exceedance probability under a fitted baseline; the
 * Bayesian scan reports a posterior. None of these are interchangeable, and averaging them or
 * comparing them at their default thresholds would compare tuning rather than method — which
 * is exactly what Phase 33 exists to avoid.
 *
 * So each detector declares one **ranking statistic**, higher meaning stronger, and every
 * comparison is made after calibrating each detector's own statistic to a common empirical
 * false-alert rate. The statistic never has to be comparable *across* detectors; it only has
 * to order signals correctly *within* one.
 *
 * ## Why the scan family is ranked by log-likelihood ratio and not by recurrence interval
 *
 * The recurrence interval looks like the natural choice — it is what the interface shows and
 * what an operator acts on. It is the wrong choice here for a reason Phase 32 measured: the
 * Monte Carlo p-value has a floor of `1 / (permutations + 1)`, so the recurrence interval has
 * a ceiling of `permutations + 1`. Every cluster strong enough to hit that floor is reported
 * at the same value, and ranking by it puts the largest outbreak in the grid level with a
 * merely significant one. The benchmark would then be unable to distinguish them at any alert
 * budget tighter than the ceiling.
 *
 * The log-likelihood ratio has no such ceiling, is deterministic given the data, and orders
 * clusters by the strength of evidence the statistic actually found. Ranking by it also makes
 * the benchmark's replication count a *speed* setting rather than a *sensitivity* setting,
 * which is what makes a 960-cell grid affordable at all.
 *
 * The cost, stated plainly: the log-likelihood ratio is uncorrected for the multiple testing
 * the p-value corrects for. Within one detector on one corpus that correction is close to a
 * monotone transformation of the statistic, so the ordering is nearly unchanged — but "nearly"
 * is not "exactly", and a reader comparing these results against a run that thresholded on
 * recurrence interval should expect small differences at the margin.
 */

import {
  BAYESIAN_SCAN_ID, BERNOULLI_PURELY_SPATIAL_ID, BERNOULLI_PURELY_TEMPORAL_ID,
  BERNOULLI_SPACE_TIME_ID, CUSUM_BERNOULLI_ID, CUSUM_POISSON_ID, EWMA_ID, FARRINGTON_ID,
  MULTIVARIATE_ID, PACE_ID, POISSON_PURELY_TEMPORAL_ID, POISSON_SPACE_TIME_ID,
  SPACE_TIME_PERMUTATION_ID, type DetectorSignal
} from '../detection/registry'

export type RankingStatistic = 'log-likelihood-ratio' | 'chart-exceedance' | 'farrington-score'
  | 'posterior' | 'pace-evidence'

/** Which statistic orders each detector's signals. Pre-specified, not inferred at run time. */
export const RANKING_STATISTIC: Readonly<Record<string, RankingStatistic>> = Object.freeze({
  [SPACE_TIME_PERMUTATION_ID]: 'log-likelihood-ratio',
  [BERNOULLI_SPACE_TIME_ID]: 'log-likelihood-ratio',
  [BERNOULLI_PURELY_TEMPORAL_ID]: 'log-likelihood-ratio',
  [BERNOULLI_PURELY_SPATIAL_ID]: 'log-likelihood-ratio',
  [POISSON_SPACE_TIME_ID]: 'log-likelihood-ratio',
  [POISSON_PURELY_TEMPORAL_ID]: 'log-likelihood-ratio',
  [MULTIVARIATE_ID]: 'log-likelihood-ratio',
  [EWMA_ID]: 'chart-exceedance',
  [CUSUM_POISSON_ID]: 'chart-exceedance',
  [CUSUM_BERNOULLI_ID]: 'chart-exceedance',
  [FARRINGTON_ID]: 'farrington-score',
  [BAYESIAN_SCAN_ID]: 'posterior',
  [PACE_ID]: 'pace-evidence'
})

interface ExtendedSignal extends DetectorSignal {
  chart_exceedance?: number
  farrington_score?: number
  posterior_given_outbreak?: number
  posterior_probability?: number
  pace_evidence?: number
}

/**
 * The evidence a signal carries, on its own detector's scale.
 *
 * Returns `null` when the detector is unknown to this table rather than guessing a field.
 * A detector added without a declared ranking statistic must fail loudly here: silently
 * falling back to, say, the log-likelihood ratio would give a control chart a statistic that
 * is always zero and a sensitivity of zero, which reads as a finding about the method.
 */
export function evidenceOf(signal: DetectorSignal): number | null {
  const statistic = RANKING_STATISTIC[signal.detector_id]
  if (!statistic) return null
  const extended = signal as ExtendedSignal
  switch (statistic) {
    case 'log-likelihood-ratio':
      return signal.log_likelihood_ratio
    case 'chart-exceedance':
      return extended.chart_exceedance ?? 0
    case 'farrington-score':
      return extended.farrington_score ?? 0
    case 'posterior':
      return extended.posterior_given_outbreak ?? extended.posterior_probability ?? 0
    // PACE reports signals from two statistics that do not share a scale — a permutation scan's
    // log-likelihood ratio and a Bernoulli scan's — so it standardises each against its own
    // model's Monte Carlo null maxima before reporting one number. Ranking on the raw ratio
    // would order a proportion cluster against a count cluster on a scale neither shares.
    case 'pace-evidence':
      return extended.pace_evidence ?? 0
    default:
      return null
  }
}

/** Every detector the harness knows how to rank. */
export function rankableDetectors(): string[] {
  return Object.keys(RANKING_STATISTIC)
}
