/**
 * The benchmark harness: one command, every detector, every endpoint.
 *
 * Phase 33 of `docs/expansion/PLAN.md`. What it exists to prevent is a comparison made at each
 * detector's default threshold, which measures tuning rather than method — see
 * `calibration.ts` for what replaces that, and `ranking.ts` for why each detector is ranked by
 * its own statistic.
 */

export { calibrate, alerted, siteYearsOf, SIGNAL_CAP_PER_CELL, type Calibration } from './calibration'
export { computeEndpoints, outcomeOf, median, wilson, type CellOutcome, type Endpoints } from './endpoints'
export { matchSignal, matchAll, unmatchedSignals, isPooled, type Match } from './matching'
export { evidenceOf, rankableDetectors, RANKING_STATISTIC, type RankingStatistic } from './ranking'
export {
  runBenchmark, armsFor, paceAblationArms, detectionDelay, sitesRequiredFor, BENCHMARK_SETTINGS,
  type BenchmarkArm, type BenchmarkOptions, type BenchmarkReport, type ArmResult
} from './harness'
export { antibioticClasses } from './catalogue'
