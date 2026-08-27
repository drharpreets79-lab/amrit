/**
 * The endpoints, computed by code and never by hand.
 *
 * All five are pre-specified in `docs/expansion/PLAN.md` Phase 33 and none may be dropped
 * after the fact — an endpoint that fails is reported as failing, which is the point of
 * writing it down first.
 *
 * ## Detection delay, and why it costs what it costs
 *
 * Sensitivity, positive predictive value and the accuracy measures can all be read off a
 * single run at the data cut. Detection delay cannot, and the difference is not a detail.
 *
 * A prospective scan reports the window it found *ending at the data cut*. Run it once, on a
 * corpus where the outbreak is still running at that cut, and the interval between the
 * outbreak's first specimen and the signal's end date is the outbreak's age — a property of
 * the corpus, identical for every detector, and worthless as a comparison. The only honest way
 * to measure how long a detector takes to notice is to give it the data as it would actually
 * have arrived: truncate at successive cut dates and ask on which day it first alerts.
 *
 * That multiplies the compute by the number of cuts, which is why `strideDays` exists and why
 * the full grid uses a coarse stride. A coarse stride quantises the delay upward: with a
 * three-day stride a detector that would have alerted on day 4 is recorded at day 6. The
 * quantisation is identical across detectors, so comparisons between them stay fair, and it is
 * reported alongside the delay so an absolute figure is never quoted without it.
 *
 * This is the quantity the WHONET-SaTScan evaluation literature does not report, and the one an
 * infection-prevention team actually experiences. It is worth the compute.
 */

import type { DetectorSignal } from '../detection/registry'
import type { SeededOutbreak } from '../outbreak-simulation'
import { matchAll, unmatchedSignals, type Match } from './matching'

export interface CellOutcome {
  /** Outbreaks in this cell that at least one alerted signal matched. */
  detected: SeededOutbreak[]
  /** Outbreaks no alerted signal matched. */
  missed: SeededOutbreak[]
  matches: Match[]
  /** Alerted signals that matched nothing seeded. */
  falseAlerts: DetectorSignal[]
  alertedSignals: number
}

export function outcomeOf(
  alertedSignals: readonly DetectorSignal[], outbreaks: readonly SeededOutbreak[]
): CellOutcome {
  const matches = matchAll(alertedSignals, outbreaks)
  const detectedIds = new Set(matches.map((match) => match.outbreak.outbreak_id))
  return {
    detected: outbreaks.filter((outbreak) => detectedIds.has(outbreak.outbreak_id)),
    missed: outbreaks.filter((outbreak) => !detectedIds.has(outbreak.outbreak_id)),
    matches,
    falseAlerts: unmatchedSignals(alertedSignals, outbreaks),
    alertedSignals: alertedSignals.length
  }
}

export interface Endpoints {
  /**
   * Whether the arm ran at all.
   *
   * An arm that was unavailable on every cell has no sensitivity, and reporting one as zero
   * would say it failed to detect when it never looked. Farrington is the live case: it needs
   * five years of history and no corpus here has them, so on most grids it does not run. Every
   * proportion below is `null` when this is false.
   */
  ran: boolean
  /** Seeded outbreaks found, over seeded outbreaks presented. `null` when the arm never ran. */
  sensitivity: number | null
  sensitivityNumerator: number
  sensitivityDenominator: number
  /** Wilson 95% interval on the sensitivity, as the paper plan requires of a proportion. */
  sensitivityInterval: [number, number] | null
  /** Alerted signals that matched something seeded, over all alerted signals on seeded cells. */
  positivePredictiveValue: number | null
  /** Alerts per site-year on the null replicates, at the calibrated threshold. */
  falseAlertRate: number
  /** Median days from the outbreak's first specimen to the first alert. Null when never found. */
  medianDetectionDelay: number | null
  detectionDelays: number[]
  /** Of matched signals, the proportion that named the seeded ward rather than the whole site. */
  spatialAccuracy: number | null
  /** Median overlap-over-union of the signal window against the truth window. */
  temporalAccuracy: number | null
}

/**
 * Wilson score interval.
 *
 * Not the normal approximation: at the sensitivities a small grid produces, the normal
 * interval runs below zero and above one, and a confidence interval that includes impossible
 * values is not one.
 */
export function wilson(successes: number, trials: number, z = 1.959963984540054): [number, number] {
  if (trials <= 0) return [0, 0]
  const proportion = successes / trials
  const denominator = 1 + (z * z) / trials
  const centre = proportion + (z * z) / (2 * trials)
  const spread = z * Math.sqrt((proportion * (1 - proportion)) / trials + (z * z) / (4 * trials * trials))
  return [
    Math.max(0, (centre - spread) / denominator),
    Math.min(1, (centre + spread) / denominator)
  ]
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
}

export interface EndpointInput {
  outcomes: readonly CellOutcome[]
  /** One entry per detected outbreak, in days. Misses contribute nothing rather than a zero. */
  detectionDelays: readonly number[]
  /** Alerts per site-year measured on the null replicates at the calibrated threshold. */
  falseAlertRate: number
}

/**
 * One seeded cell's contribution to an arm's endpoints, reduced to the quantities that
 * aggregate.
 *
 * Two things need this. The pre-registered hypothesis is stated on a *subgroup* — clonal
 * multi-drug outbreaks of 20 or fewer excess cases — and a report that carries only the
 * grid-wide endpoints cannot answer it without re-running the grid once per subgroup. And a
 * 960-cell grid with detection delay costs more compute than one process should hold, so the
 * seeded cells are sharded and the shards are pooled afterwards; pooling rows is only sound
 * when every quantity in them is additive, which is why the medians travel as their raw
 * `jaccards` and `delays` rather than as summaries.
 *
 * `endpointsFromRows` over every row of a run returns exactly what `computeEndpoints` returns
 * over the same run's outcomes, and a test asserts it.
 */
export interface CellRow {
  cell: string
  type: string
  excessCases: number
  durationDays: number
  backgroundRate: string
  replicate: number
  /** False when the detector declined this cell; the reason travels alongside. */
  ran: boolean
  reason: string | null
  presented: number
  detected: number
  /** Alerted signals that matched something seeded, de-duplicated by signal. */
  matchedSignals: number
  alertedSignals: number
  matches: number
  localised: number
  jaccards: number[]
  delays: number[]
}

export function rowOf(
  cell: {
    arm_id: string; type: string; excessCases: number; durationDays: number
    backgroundRate: string; replicate: number
  },
  outcome: CellOutcome,
  delays: readonly number[]
): CellRow {
  return {
    cell: cell.arm_id,
    type: cell.type,
    excessCases: cell.excessCases,
    durationDays: cell.durationDays,
    backgroundRate: cell.backgroundRate,
    replicate: cell.replicate,
    ran: true,
    reason: null,
    presented: outcome.detected.length + outcome.missed.length,
    detected: outcome.detected.length,
    matchedSignals: new Set(outcome.matches.map((match) => match.signal.signal_id)).size,
    alertedSignals: outcome.alertedSignals,
    matches: outcome.matches.length,
    localised: outcome.matches.filter((match) => match.localised).length,
    jaccards: outcome.matches.map((match) => match.temporalJaccard),
    delays: [...delays]
  }
}

/** The endpoints of an arbitrary set of cells: a whole run, a shard, or one subgroup. */
export function endpointsFromRows(
  rows: readonly CellRow[], falseAlertRate: number
): Endpoints {
  let detected = 0
  let presented = 0
  let matchedSignals = 0
  let alertedOnSeeded = 0
  let localised = 0
  let totalMatches = 0
  const jaccards: number[] = []
  const delays: number[] = []

  for (const row of rows) {
    if (!row.ran) continue
    detected += row.detected
    presented += row.presented
    alertedOnSeeded += row.alertedSignals
    matchedSignals += row.matchedSignals
    localised += row.localised
    totalMatches += row.matches
    jaccards.push(...row.jaccards)
    delays.push(...row.delays)
  }

  const ran = rows.some((row) => row.ran) && presented > 0
  return {
    ran,
    sensitivity: ran ? detected / presented : null,
    sensitivityNumerator: detected,
    sensitivityDenominator: presented,
    sensitivityInterval: ran ? wilson(detected, presented) : null,
    positivePredictiveValue: ran && alertedOnSeeded > 0 ? matchedSignals / alertedOnSeeded : null,
    falseAlertRate,
    medianDetectionDelay: median(delays),
    detectionDelays: delays,
    spatialAccuracy: totalMatches > 0 ? localised / totalMatches : null,
    temporalAccuracy: median(jaccards)
  }
}

export function computeEndpoints(input: EndpointInput): Endpoints {
  let detected = 0
  let presented = 0
  let matchedSignals = 0
  let alertedOnSeeded = 0
  let localised = 0
  const jaccards: number[] = []

  for (const outcome of input.outcomes) {
    detected += outcome.detected.length
    presented += outcome.detected.length + outcome.missed.length
    alertedOnSeeded += outcome.alertedSignals
    // A signal that matched two seeded outbreaks is one signal, not two: counting matches
    // here would let a detector inflate its own precision by finding one thing twice.
    const matchedSignalIds = new Set(outcome.matches.map((match) => match.signal.signal_id))
    matchedSignals += matchedSignalIds.size
    for (const match of outcome.matches) {
      if (match.localised) localised += 1
      jaccards.push(match.temporalJaccard)
    }
  }

  const totalMatches = input.outcomes.reduce((sum, outcome) => sum + outcome.matches.length, 0)
  const ran = input.outcomes.length > 0 && presented > 0
  return {
    ran,
    sensitivity: ran ? detected / presented : null,
    sensitivityNumerator: detected,
    sensitivityDenominator: presented,
    sensitivityInterval: ran ? wilson(detected, presented) : null,
    positivePredictiveValue: ran && alertedOnSeeded > 0 ? matchedSignals / alertedOnSeeded : null,
    falseAlertRate: input.falseAlertRate,
    medianDetectionDelay: median(input.detectionDelays),
    detectionDelays: [...input.detectionDelays],
    spatialAccuracy: totalMatches > 0 ? localised / totalMatches : null,
    temporalAccuracy: median(jaccards)
  }
}
