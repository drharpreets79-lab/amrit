/**
 * The Bayesian spatial scan statistic: posterior probability instead of a p-value.
 *
 * Every other scan in this directory answers "how surprising would this cluster be if
 * nothing were happening", and answers it by simulating a thousand replicate datasets. This
 * one answers a different question — "given what I saw, how probable is it that this ward is
 * having an outbreak" — and answers it in closed form. The difference is worth being precise
 * about, because the two are routinely conflated and they support different decisions.
 *
 * A p-value of 0.001 does not mean the ward has a one-in-a-thousand chance of being fine. It
 * means that if nothing were happening, data this extreme would arise once in a thousand
 * datasets. The posterior probability this file computes *is* the quantity people mistakenly
 * read a p-value as, and it is directly comparable across wards, across streams and across
 * days — which is what makes it useful for ranking a morning's signals, and what a p-value
 * corrected against a simulated maximum is not.
 *
 * The cost is that a posterior requires a prior, and the prior is a choice. Nothing in the
 * data sets `priorOutbreak`, the probability that any given region-and-window is an outbreak
 * before looking; it is a judgement about how often outbreaks happen in this deployment, it
 * moves every number this file produces, and a deployment that has never examined it is
 * reading a number it has not chosen. `defaultSettings` states a value and the documentation
 * says it is a default rather than a measurement.
 *
 * ## The model
 *
 * Conjugate Gamma-Poisson, as Neill et al. give it. Under the null, counts everywhere follow
 * `Poisson(q * b_i)` with a single global rate `q ~ Gamma(alpha, beta)`. Under the
 * alternative for region `S`, counts inside `S` follow `Poisson(q_in * b_i)` and outside
 * `Poisson(q_out * b_i)` with independent Gamma priors, and `q_in` is drawn from a prior
 * shifted to favour rates above the baseline. Because Gamma is conjugate to Poisson, each
 * marginal likelihood integrates in closed form:
 *
 *     P(D | q ~ Gamma(a, b)) = (b^a / Gamma(a)) * (Gamma(a + C) / (b + B)^(a + C))
 *
 * with `C` the total count and `B` the total baseline. The posterior over regions is then
 * just the normalised product of prior and marginal likelihood. No randomisation, no
 * replications, no p-value floor tied to a replication count — the failure mode Phase 32
 * measured, where 99 replications silently disable alerting, cannot occur here.
 *
 * ## Baselines, and where this fails
 *
 * `b_i` is the expected count for a cell, and the model is only as good as it. Here it is
 * derived the way the rest of this directory derives an expectation for a case-only method:
 * the product of the location's share of all cases and the day's share of all cases, scaled
 * to the total. That is the same margin-conditioning the space-time permutation scan uses,
 * and it inherits the same blind spot — a rise that is uniform across every location is
 * absorbed into the day margin and leaves nothing to find.
 *
 * The deeper failure is the prior. With `priorOutbreak` set high, everything is probably an
 * outbreak; set low, nothing is; and unlike a p-value there is no convention to fall back on.
 * The posterior is also computed over the regions this implementation enumerates — single
 * locations over trailing windows — so it is a posterior conditional on the outbreak being
 * one of those, and it will confidently rank the best of a bad set.
 *
 * Neill DB, Moore AW, Cooper GF. A Bayesian spatial scan statistic. Advances in Neural
 * Information Processing Systems 2005;18:1003-1010.
 */

import { denominatorsFrom } from './denominators'
import { ALL_LOCATIONS, dayKey } from './series'
import { logGamma } from './statistics'
import type { Detector, DetectorContext, DetectorDescriptor, DetectorRunResult, DetectorSignal } from './types'

const DAY_MS = 86_400_000

export interface BayesianScanSettings {
  /** Days of history to read. */
  historyDays: number
  /** Longest window considered, in days. */
  maxClusterDays: number
  /** Prior probability that any one region-and-window is an outbreak. A judgement. */
  priorOutbreak: number
  /**
   * Multiplier on the baseline rate the alternative expects inside a cluster.
   *
   * Neill's `m` values: the alternative is a mixture over several multipliers rather than one,
   * so the model is not committed to a single outbreak size.
   */
  rateMultipliers: number[]
  /** Gamma shape for the baseline rate. Larger is a more confident prior. */
  priorShape: number
  /** Minimum cases inside a region before it is scored. */
  minimumCases: number
  /**
   * Conditional posterior at or above which a region is reported.
   *
   * Applied to `posteriorGivenOutbreak`, not to the unconditional posterior: the latter is
   * diluted by the region count and a fixed threshold on it silently reports nothing once
   * the grid grows, which is what it did before this was separated out.
   */
  reportThreshold: number
  /** Unconditional posterior at or above which a region is an alert rather than a monitor. */
  alertThreshold: number
}

export const DEFAULT_BAYESIAN_SCAN_SETTINGS: BayesianScanSettings = Object.freeze({
  historyDays: 365,
  maxClusterDays: 30,
  // Neill's own default, and stated as a default rather than a measurement: nothing in the
  // data sets it, and a deployment that has not thought about it is reading a number it did
  // not choose.
  priorOutbreak: 0.01,
  rateMultipliers: Object.freeze([1.5, 2, 3]) as unknown as number[],
  priorShape: 1,
  minimumCases: 3,
  reportThreshold: 0.05,
  alertThreshold: 0.5
})

export interface BayesianSignal {
  signal_id: string
  status: 'alert' | 'monitor'
  organism: string
  antibiotic: string
  location: string
  pooled: boolean
  start_date: string
  end_date: string
  days: number
  observed: number
  /** Expected count from the margin-conditioned baseline. */
  expected: number
  /** Posterior probability that this region and window is an outbreak. */
  posterior: number
  /**
   * Posterior over regions, conditional on there being an outbreak somewhere.
   *
   * The quantity that ranks regions, and the one to read first. Neill spreads the outbreak
   * prior across every enumerated region, so with a few thousand regions each starts at
   * around one in a million and the unconditional posterior stays small even for a strong
   * cluster. Conditioning on "an outbreak is happening" removes that dilution and leaves the
   * question an operator is actually asking: given that something is going on, where.
   */
  posteriorGivenOutbreak: number
  /** Log Bayes factor of the alternative against the null for this region. */
  logBayesFactor: number
}

export interface BayesianScanResult {
  method: string
  settings: BayesianScanSettings
  studyStart: string | null
  studyEnd: string | null
  streams: number
  locations: number
  regions: number
  /** Posterior that nothing anywhere is an outbreak. */
  posteriorNull: number
  /** Regions above the reporting threshold, before the cap of 50. */
  signalsFound: number
  signals: BayesianSignal[]
  warnings: string[]
}

const round = (value: number, digits = 4): number => Number(value.toFixed(digits))

function fnv1a(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * Log marginal likelihood of `count` events with total baseline `baseline`, under a
 * `Gamma(shape, rate)` prior on the Poisson rate.
 *
 * `log P(D) = shape*log(rate) - logGamma(shape) + logGamma(shape + count) - (shape + count)*log(rate + baseline)`
 *
 * The terms in the data that do not depend on the region — the factorials — cancel in every
 * ratio taken here, so they are omitted throughout rather than computed and divided away.
 */
export function logMarginalLikelihood(count: number, baseline: number, shape: number, rate: number): number {
  if (baseline < 0 || count < 0) return Number.NEGATIVE_INFINITY
  return shape * Math.log(rate) - logGamma(shape) + logGamma(shape + count)
    - (shape + count) * Math.log(rate + baseline)
}

interface Region {
  streamKey: string
  organismCode: string
  antibioticCode: string
  location: string
  pooled: boolean
  start: number
  end: number
  observed: number
  expected: number
  logLikelihood: number
}

const parseDay = (value: string): number => {
  const parsed = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(parsed) ? Math.round(parsed / DAY_MS) : Number.NaN
}

function boundSettings(raw: Partial<BayesianScanSettings> = {}): BayesianScanSettings {
  const d = DEFAULT_BAYESIAN_SCAN_SETTINGS
  const clampInt = (value: number | undefined, low: number, high: number, fallback: number): number =>
    Math.max(low, Math.min(high, Math.trunc(value ?? fallback)))
  const multipliers = (raw.rateMultipliers ?? d.rateMultipliers)
    .filter((value) => Number.isFinite(value) && value > 1)
  return {
    historyDays: clampInt(raw.historyDays, 30, 3650, d.historyDays),
    maxClusterDays: clampInt(raw.maxClusterDays, 1, 365, d.maxClusterDays),
    priorOutbreak: Math.max(1e-6, Math.min(0.5, raw.priorOutbreak ?? d.priorOutbreak)),
    rateMultipliers: multipliers.length > 0 ? multipliers : [...d.rateMultipliers],
    priorShape: Math.max(0.01, Math.min(100, raw.priorShape ?? d.priorShape)),
    minimumCases: clampInt(raw.minimumCases, 1, 1000, d.minimumCases),
    reportThreshold: Math.max(0, Math.min(1, raw.reportThreshold ?? d.reportThreshold)),
    alertThreshold: Math.max(0, Math.min(1, raw.alertThreshold ?? d.alertThreshold))
  }
}

export interface BayesianScanOptions {
  context: DetectorContext
  settings?: Partial<BayesianScanSettings>
  organismNames?: Readonly<Record<string, string>>
}

export function scanBayesian(options: BayesianScanOptions): BayesianScanResult {
  const settings = boundSettings(options.settings)
  const names = options.organismNames ?? {}
  const denominators = denominatorsFrom(options.context)
  const rows = denominators.filter((row) => row.antibiotic_code !== '' && row.resistant > 0)

  const empty = (warning: string): BayesianScanResult => ({
    method: 'Neill Bayesian spatial scan statistic', settings,
    studyStart: null, studyEnd: null, streams: 0, locations: 0, regions: 0,
    posteriorNull: 1, signalsFound: 0, signals: [], warnings: [warning]
  })
  const days = rows.map((row) => parseDay(row.date)).filter(Number.isFinite)
  if (days.length === 0) return empty('No resistant isolates to scan.')

  let studyEnd = days[0] as number
  let dataStart = days[0] as number
  for (const day of days) {
    if (day > studyEnd) studyEnd = day
    if (day < dataStart) dataStart = day
  }
  const studyStart = Math.max(dataStart, studyEnd - (settings.historyDays - 1))
  const length = studyEnd - studyStart + 1
  const bounded = rows.filter((row) => parseDay(row.date) >= studyStart)
  if (bounded.length === 0) return empty('No resistant isolates inside the study window.')

  // One grid per organism-antibiotic stream: counts by location and day.
  interface Stream {
    organismCode: string
    antibioticCode: string
    byLocation: Map<string, number[]>
    total: number
  }
  const streams = new Map<string, Stream>()
  const locations = new Set<string>()
  for (const row of bounded) {
    const day = parseDay(row.date) - studyStart
    if (day < 0 || day >= length) continue
    const key = `${row.organism_code}:${row.antibiotic_code}`
    const stream = streams.get(key)
      ?? { organismCode: row.organism_code, antibioticCode: row.antibiotic_code, byLocation: new Map(), total: 0 }
    const series = stream.byLocation.get(row.location) ?? Array.from({ length }, () => 0)
    series[day] = (series[day] ?? 0) + row.resistant
    stream.byLocation.set(row.location, series)
    stream.total += row.resistant
    streams.set(key, stream)
    locations.add(row.location)
  }

  const regions: Region[] = []
  for (const [streamKey, stream] of streams) {
    if (stream.total < settings.minimumCases) continue
    // Margin-conditioned baseline, the same expectation the permutation scan uses: a cell's
    // expected count is its location's share of the stream times its day's share.
    const locationTotals = new Map<string, number>()
    const dayTotals = Array.from({ length }, () => 0)
    for (const [location, series] of stream.byLocation) {
      let sum = 0
      for (let day = 0; day < length; day += 1) {
        sum += series[day] ?? 0
        dayTotals[day] = (dayTotals[day] as number) + (series[day] ?? 0)
      }
      locationTotals.set(location, sum)
    }

    const candidates: Array<{ location: string; pooled: boolean; series: number[]; share: number }> = []
    for (const [location, series] of stream.byLocation) {
      candidates.push({ location, pooled: false, series, share: (locationTotals.get(location) ?? 0) / stream.total })
    }
    // The pooled region covers the case a per-location scan cannot: a rise present in every
    // ward at once. Its baseline share is 1 by construction, so only the time margin
    // distinguishes it — which is exactly why it is weak, and why it is reported separately.
    const pooledSeries = Array.from({ length }, (_, day) => dayTotals[day] as number)
    candidates.push({ location: ALL_LOCATIONS, pooled: true, series: pooledSeries, share: 1 })

    for (const candidate of candidates) {
      for (let end = length - 1; end === length - 1; end -= 1) {
        let observed = 0
        for (let days = 1; days <= settings.maxClusterDays && days <= length; days += 1) {
          const start = end - days + 1
          observed += candidate.series[start] ?? 0
          if (observed < settings.minimumCases) continue
          let dayShare = 0
          for (let day = start; day <= end; day += 1) dayShare += (dayTotals[day] as number)
          const expected = candidate.pooled
            ? dayShare
            : candidate.share * dayShare
          if (expected <= 0) continue
          regions.push({
            streamKey,
            organismCode: stream.organismCode,
            antibioticCode: stream.antibioticCode,
            location: candidate.location,
            pooled: candidate.pooled,
            start,
            end,
            observed,
            expected,
            logLikelihood: 0
          })
        }
      }
    }
  }

  if (regions.length === 0) return empty('No region carried enough cases to score.')

  // Null: one global rate over everything, with a Gamma(shape, shape) prior centred at 1
  // because the baselines are already expected counts rather than populations.
  const shape = settings.priorShape
  const totalObserved = [...streams.values()].reduce((sum, stream) => sum + stream.total, 0)
  const totalExpected = totalObserved
  const logNull = logMarginalLikelihood(totalObserved, totalExpected, shape, shape)

  // Alternative: for each region and each multiplier, the inside rate is drawn from a prior
  // centred on that multiple of the baseline and the outside from the null prior.
  const priorPerRegion = settings.priorOutbreak / regions.length
  const logPriorNull = Math.log(Math.max(1e-300, 1 - settings.priorOutbreak))
  const logPriorRegion = Math.log(Math.max(1e-300, priorPerRegion / settings.rateMultipliers.length))

  const scored = regions.map((region) => {
    const outsideObserved = totalObserved - region.observed
    const outsideExpected = Math.max(1e-9, totalExpected - region.expected)
    let best = Number.NEGATIVE_INFINITY
    const perMultiplier: number[] = []
    for (const multiplier of settings.rateMultipliers) {
      // Gamma(shape, shape/multiplier) has mean `multiplier`: the alternative expects the
      // inside rate to be that many times the baseline, without fixing it there.
      const inside = logMarginalLikelihood(region.observed, region.expected, shape, shape / multiplier)
      const outside = logMarginalLikelihood(outsideObserved, outsideExpected, shape, shape)
      const value = inside + outside
      perMultiplier.push(value)
      if (value > best) best = value
    }
    // Sum over multipliers in log space, since the alternative is a mixture over them.
    const total = perMultiplier.reduce((sum, value) => sum + Math.exp(value - best), 0)
    return { region, logLikelihood: best + Math.log(total) + logPriorRegion }
  })

  // Normalise prior*likelihood across the null and every region, in log space.
  const terms = [logNull + logPriorNull, ...scored.map((item) => item.logLikelihood)]
  let maximum = Number.NEGATIVE_INFINITY
  for (const term of terms) if (term > maximum) maximum = term
  let denominator = 0
  for (const term of terms) denominator += Math.exp(term - maximum)
  const posteriorOf = (term: number): number => Math.exp(term - maximum) / denominator

  const posteriorNull = posteriorOf(logNull + logPriorNull)
  // Conditional on an outbreak existing: renormalise over the regions alone. This is the
  // ranking quantity, and separating it from the unconditional posterior is what stops a
  // large region grid from silently suppressing every signal.
  let regionMaximum = Number.NEGATIVE_INFINITY
  for (const item of scored) if (item.logLikelihood > regionMaximum) regionMaximum = item.logLikelihood
  let regionDenominator = 0
  for (const item of scored) regionDenominator += Math.exp(item.logLikelihood - regionMaximum)

  const ranked = scored.map(({ region, logLikelihood }) => ({
    region,
    posterior: posteriorOf(logLikelihood),
    posteriorGivenOutbreak: Math.exp(logLikelihood - regionMaximum) / regionDenominator,
    logLikelihood
  }))
  const signalsFound = ranked.filter((item) => item.posteriorGivenOutbreak >= settings.reportThreshold).length
  const signals = ranked
    .filter((item) => item.posteriorGivenOutbreak >= settings.reportThreshold)
    .sort((left, right) => right.posteriorGivenOutbreak - left.posteriorGivenOutbreak)
    // Overlapping windows over the same region are the same finding reported at different
    // lengths; keep the most probable and drop the rest, as every other scan here does.
    .filter((item, index, all) => !all.slice(0, index).some((earlier) =>
      earlier.region.streamKey === item.region.streamKey
      && earlier.region.location === item.region.location
      && item.region.start <= earlier.region.end && item.region.end >= earlier.region.start))
    .slice(0, 50)
    .map(({ region, posterior, posteriorGivenOutbreak, logLikelihood }): BayesianSignal => ({
      signal_id: fnv1a([region.streamKey, region.location, region.start, region.end].join('|'))
        .toString(16).padStart(8, '0'),
      status: posterior >= settings.alertThreshold ? 'alert' : 'monitor',
      organism: names[region.organismCode] ?? region.organismCode,
      antibiotic: region.antibioticCode,
      location: region.location,
      pooled: region.pooled,
      start_date: dayKey(studyStart + region.start),
      end_date: dayKey(studyStart + region.end),
      days: region.end - region.start + 1,
      observed: region.observed,
      expected: round(region.expected, 2),
      posterior: round(posterior),
      posteriorGivenOutbreak: round(posteriorGivenOutbreak),
      logBayesFactor: round(logLikelihood - logPriorRegion - logNull, 3)
    }))

  const warnings: string[] = [
    `The posterior depends on a prior this data did not set: ${settings.priorOutbreak} is the `
    + 'probability that any one region and window is an outbreak before looking. Every probability '
    + 'below moves with it, and a deployment that has not chosen it is reading a default.',
    'These are posterior probabilities, not p-values, and the two are not interchangeable. A '
    + 'posterior is conditional on the outbreak being one of the regions enumerated here — single '
    + 'locations over trailing windows — so it will rank the best of a bad set confidently.'
  ]
  if (locations.size < 2) {
    warnings.push('Only one location: every region is the same ward and the scan reduces to a '
      + 'temporal comparison.')
  }

  return {
    method: 'Neill Bayesian spatial scan statistic',
    settings,
    studyStart: dayKey(studyStart),
    studyEnd: dayKey(studyEnd),
    streams: streams.size,
    locations: locations.size,
    regions: regions.length,
    posteriorNull: round(posteriorNull),
    signalsFound,
    signals,
    warnings
  }
}

// ---------------------------------------------------------------------------------
// Registration

export const BAYESIAN_SCAN_ID = 'bayesian-spatial-scan'

export const bayesianScanDescriptor: DetectorDescriptor = Object.freeze({
  id: BAYESIAN_SCAN_ID,
  name: 'Bayesian spatial scan',
  method: 'Neill Gamma-Poisson Bayesian spatial scan statistic',
  family: 'bayesian',
  requires: Object.freeze({ denominators: false, coordinates: false, multipleLocations: false }),
  supports: Object.freeze({ prospective: true, retrospective: false }),
  blindSpot: 'Its answer moves with a prior the data does not set, and unlike a p-value there is no '
    + 'convention to fall back on. It uses the same margin-conditioned baseline as the permutation '
    + 'scan and so inherits that blind spot: a rise uniform across every location is absorbed into '
    + 'the time margin. And the posterior is conditional on the outbreak being one of the regions '
    + 'enumerated, so it ranks the best of a bad set with the same confidence as a good one.',
  citation: 'Neill DB, Moore AW, Cooper GF. A Bayesian spatial scan statistic. Advances in Neural '
    + 'Information Processing Systems 2005;18:1003-1010.'
})

export const bayesianScanDetector: Detector = {
  descriptor: bayesianScanDescriptor,

  defaultSettings(): Record<string, unknown> {
    return { ...DEFAULT_BAYESIAN_SCAN_SETTINGS, rateMultipliers: [...DEFAULT_BAYESIAN_SCAN_SETTINGS.rateMultipliers] }
  },

  unavailableReason(context: DetectorContext): string | null {
    if (!context.records?.length && !context.denominators?.length) {
      return 'No data: this scan ranks regions by posterior probability and needs resistant counts.'
    }
    return null
  },

  run(context: DetectorContext): DetectorRunResult {
    const result = scanBayesian({
      context, settings: (context.settings ?? {}) as Partial<BayesianScanSettings>
    })
    const signals: DetectorSignal[] = result.signals.map((signal) => ({
      signal_id: signal.signal_id,
      status: signal.status,
      signal_type: 'Resistance phenotype',
      organism: signal.organism,
      antibiotic: signal.antibiotic,
      scope: signal.pooled ? 'All-location temporal cluster' : 'Location cluster',
      location: signal.location,
      start_date: signal.start_date,
      end_date: signal.end_date,
      days: signal.days,
      observed: signal.observed,
      expected: signal.expected,
      excess: round(signal.observed - signal.expected, 2),
      observed_expected_ratio: signal.expected > 0 ? round(signal.observed / signal.expected, 2) : 0,
      // The log Bayes factor is the closest thing here to a log-likelihood ratio and is
      // reported in that field so a table can be read; it is not one, and it is not
      // comparable to the scan statistics' values.
      log_likelihood_ratio: signal.logBayesFactor,
      // Deliberately zero. A posterior is not a p-value and putting `1 - posterior` here
      // would invite exactly the misreading this file's comment warns about.
      p_value: 0,
      recurrence_interval_days: 0,
      detector_id: BAYESIAN_SCAN_ID,
      posterior_probability: signal.posterior,
      posterior_given_outbreak: signal.posteriorGivenOutbreak
    } as DetectorSignal))
    return {
      descriptor: bayesianScanDescriptor,
      settings: { ...result.settings },
      signals,
      warnings: [...result.warnings],
      diagnostics: {
        method: result.method,
        study_start: result.studyStart,
        study_end: result.studyEnd,
        streams: result.streams,
        locations: result.locations,
        regions: result.regions,
        posterior_null: result.posteriorNull,
        signals_found: result.signalsFound,
        prior_outbreak: result.settings.priorOutbreak,
        // No replications and therefore no ceiling: the failure Phase 32 found, where a low
        // replication count silently disables alerting, cannot arise in this family.
        maximum_reachable_recurrence_interval: 0
      }
    }
  }
}
