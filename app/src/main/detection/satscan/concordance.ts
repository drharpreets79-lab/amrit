/**
 * Arm 1 of Study B: do AMRIT and SaTScan find the same clusters?
 *
 * `paper/AMRIT_paper_phasewise_plan.md` specifies the endpoints — the proportion of
 * SaTScan's significant clusters recovered, agreement in log-likelihood ratio by Spearman
 * rho and Bland–Altman, and agreement in p-value and recurrence interval. This computes
 * them, so the paper's table comes from one command rather than from a spreadsheet nobody
 * can re-run.
 *
 * ## Matching rule
 *
 * The plan's: two clusters match when the location set is identical and the time windows
 * overlap. Identical rather than overlapping location sets, because a cluster over a
 * different ward is a different finding however similar its statistics; overlapping rather
 * than identical windows, because the two implementations enumerate candidate windows in
 * the same way but tie-break differently, and demanding identical dates would count a
 * one-day difference as a disagreement.
 *
 * ## What agreement can and cannot mean here
 *
 * The log-likelihood ratio is deterministic given the input, so a disagreement in it is a
 * real difference in the statistic. The p-value and the recurrence interval are Monte
 * Carlo estimates from two different generators, so they differ by simulation noise even
 * when the implementations are identical — which is why the plan asks for ten runs, and why
 * a p-value difference is only evidence of a problem when it is larger than that noise.
 */

import type { OutbreakSignal } from '../../../core/domain/outbreak-detection'
import type { SatScanCluster } from './format'

export interface ClusterPair {
  amrit: OutbreakSignal
  satscan: SatScanCluster
  /** Days between the two reported start dates. Zero when they agree exactly. */
  startDateDeltaDays: number
  endDateDeltaDays: number
  llrDelta: number
  pValueDelta: number
}

export interface ConcordanceReport {
  amritClusters: number
  satscanClusters: number
  matched: number
  /** Of SaTScan's clusters, the share AMRIT also reported. The plan's headline number. */
  satscanRecovered: number
  amritOnly: OutbreakSignal[]
  satscanOnly: SatScanCluster[]
  pairs: ClusterPair[]
  /** Spearman rank correlation of the log-likelihood ratio across matched pairs. */
  llrSpearman: number | null
  /** Bland–Altman on the log-likelihood ratio: mean difference and limits of agreement. */
  llrBlandAltman: { bias: number; lowerLimit: number; upperLimit: number; sd: number } | null
  pValueSpearman: number | null
  notes: string[]
}

const DAY_MS = 86_400_000
const day = (value: string): number => {
  const parsed = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(parsed) ? parsed / DAY_MS : Number.NaN
}

function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  const [a0, a1, b0, b1] = [day(aStart), day(aEnd), day(bStart), day(bEnd)]
  if ([a0, a1, b0, b1].some(Number.isNaN)) return false
  return a0 <= b1 && b0 <= a1
}

function sameLocations(signal: OutbreakSignal, cluster: SatScanCluster): boolean {
  // AMRIT's all-location temporal cluster has no counterpart in a SaTScan run configured
  // with island coordinates: SaTScan cannot form a cluster spanning every location when the
  // spatial window cannot reach a second one. Excluded from matching and counted in the
  // notes, rather than being reported as a disagreement it is not.
  if (signal.scope !== 'Location cluster') return false
  const theirs = new Set(cluster.locations.map((value) => value.trim()))
  return theirs.size === 1 && theirs.has(signal.location.trim())
}

/** Spearman rank correlation. Ties get the average rank, which matters on small samples. */
export function spearman(left: readonly number[], right: readonly number[]): number | null {
  if (left.length !== right.length || left.length < 3) return null
  const rank = (values: readonly number[]): number[] => {
    const order = values.map((value, index) => ({ value, index }))
      .sort((a, b) => a.value - b.value)
    const ranks = Array.from({ length: values.length }, () => 0)
    let position = 0
    while (position < order.length) {
      let end = position
      while (end + 1 < order.length && order[end + 1]!.value === order[position]!.value) end += 1
      const averageRank = (position + end) / 2 + 1
      for (let index = position; index <= end; index += 1) ranks[order[index]!.index] = averageRank
      position = end + 1
    }
    return ranks
  }
  const a = rank(left)
  const b = rank(right)
  const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length
  const meanA = mean(a)
  const meanB = mean(b)
  let covariance = 0
  let varianceA = 0
  let varianceB = 0
  for (let index = 0; index < a.length; index += 1) {
    const da = (a[index] as number) - meanA
    const db = (b[index] as number) - meanB
    covariance += da * db
    varianceA += da * da
    varianceB += db * db
  }
  if (varianceA === 0 || varianceB === 0) return null
  return Number((covariance / Math.sqrt(varianceA * varianceB)).toFixed(4))
}

export function blandAltman(differences: readonly number[]): { bias: number; lowerLimit: number; upperLimit: number; sd: number } | null {
  if (differences.length < 2) return null
  const bias = differences.reduce((sum, value) => sum + value, 0) / differences.length
  const variance = differences.reduce((sum, value) => sum + (value - bias) ** 2, 0) / (differences.length - 1)
  const sd = Math.sqrt(variance)
  const round = (value: number): number => Number(value.toFixed(4))
  return { bias: round(bias), sd: round(sd), lowerLimit: round(bias - 1.96 * sd), upperLimit: round(bias + 1.96 * sd) }
}

export function compareClusters(
  amritSignals: readonly OutbreakSignal[],
  satscanClusters: readonly SatScanCluster[]
): ConcordanceReport {
  const pairs: ClusterPair[] = []
  const usedSatscan = new Set<number>()
  const usedAmrit = new Set<number>()

  // Greedy on the strongest SaTScan cluster first, so a one-to-many overlap is resolved the
  // same way every run rather than by input order.
  const ordered = [...satscanClusters]
    .map((cluster, index) => ({ cluster, index }))
    .sort((left, right) => right.cluster.logLikelihoodRatio - left.cluster.logLikelihoodRatio)

  for (const { cluster, index: satIndex } of ordered) {
    let best: { index: number; delta: number } | null = null
    for (const [amritIndex, signal] of amritSignals.entries()) {
      if (usedAmrit.has(amritIndex)) continue
      if (!sameLocations(signal, cluster)) continue
      if (!overlaps(signal.start_date, signal.end_date, cluster.startDate, cluster.endDate)) continue
      const delta = Math.abs(day(signal.start_date) - day(cluster.startDate))
        + Math.abs(day(signal.end_date) - day(cluster.endDate))
      if (!best || delta < best.delta) best = { index: amritIndex, delta }
    }
    if (!best) continue
    const signal = amritSignals[best.index] as OutbreakSignal
    usedAmrit.add(best.index)
    usedSatscan.add(satIndex)
    pairs.push({
      amrit: signal,
      satscan: cluster,
      startDateDeltaDays: day(signal.start_date) - day(cluster.startDate),
      endDateDeltaDays: day(signal.end_date) - day(cluster.endDate),
      llrDelta: Number((signal.log_likelihood_ratio - cluster.logLikelihoodRatio).toFixed(4)),
      pValueDelta: Number((signal.p_value - cluster.pValue).toFixed(4))
    })
  }

  const notes: string[] = []
  const allLocation = amritSignals.filter((signal) => signal.scope !== 'Location cluster').length
  if (allLocation) {
    notes.push(`${allLocation} AMRIT all-location temporal cluster(s) excluded from matching: a SaTScan `
      + 'run with island coordinates cannot form a cluster spanning every location, so there is nothing '
      + 'to match them against. This is a difference in what was asked, not a disagreement about an answer.')
  }
  if (pairs.length < 3) {
    notes.push('Fewer than three matched pairs: rank correlation is not computed, and any agreement '
      + 'statistic over this many clusters would be describing noise.')
  }
  notes.push('p-value and recurrence-interval differences include Monte Carlo noise from two different '
    + 'generators. Only a difference larger than that noise is evidence of a real disagreement; the paper '
    + 'protocol repeats the comparison across ten runs for this reason.')

  return {
    amritClusters: amritSignals.length,
    satscanClusters: satscanClusters.length,
    matched: pairs.length,
    satscanRecovered: satscanClusters.length ? Number((pairs.length / satscanClusters.length).toFixed(4)) : 0,
    amritOnly: amritSignals.filter((_, index) => !usedAmrit.has(index)),
    satscanOnly: satscanClusters.filter((_, index) => !usedSatscan.has(index)),
    pairs,
    llrSpearman: spearman(
      pairs.map((pair) => pair.amrit.log_likelihood_ratio),
      pairs.map((pair) => pair.satscan.logLikelihoodRatio)
    ),
    llrBlandAltman: blandAltman(pairs.map((pair) => pair.llrDelta)),
    pValueSpearman: spearman(
      pairs.map((pair) => pair.amrit.p_value),
      pairs.map((pair) => pair.satscan.pValue)
    ),
    notes
  }
}
