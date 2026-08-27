/**
 * The Farrington aberration-detection algorithm, as ECDC and UKHSA actually run it.
 *
 * This is the strongest non-scan comparator AMRIT can carry and the one a European reviewer
 * will ask about by name, so it is implemented against the reference rather than against a
 * description of it. Every step below — the reference-window construction, the quasi-Poisson
 * fit, the Anscombe reweighting, the trend-retention rule, the 2/3 power-transformed
 * threshold — follows R's `surveillance::algo.farrington`, and
 * `app/tests/detection-farrington.test.ts` asserts agreement against thresholds that package
 * produced. Where this implementation and the reference disagree, this implementation is
 * wrong.
 *
 * ## What it does
 *
 * For each period `t0` under test, take the same period in each of the previous `b` years,
 * with `w` periods either side — so `b * (2w + 1)` reference values, all drawn from the same
 * season in earlier years. Fit a quasi-Poisson log-linear model with a time trend to those
 * values, reweight to stop past outbreaks inflating the baseline, predict what `t0` should
 * have been, and alarm when the observed count exceeds an upper threshold computed on a 2/3
 * power scale — the transformation Farrington used because a Poisson count is skewed and a
 * normal interval on the raw scale is too tight below the mean and too loose above it.
 *
 * ## What it costs, and the constraint that matters most here
 *
 * **It needs years of history.** With the default `b = 5` and weekly periods, the first
 * period it can test is five years into the series; the trend term is dropped entirely below
 * `b = 3`. No corpus AMRIT currently generates is that long — `outbreak-simulation.ts`
 * defaults to 730 days and the Phase 32 factorial is shorter still. That is not a defect in
 * either piece of software, it is a statement about what this method is for: it was built
 * for national notifiable-disease series with decades behind them, and a laboratory that
 * opened eighteen months ago cannot run it. `unavailableReason` says so with the numbers
 * rather than failing quietly, and Phase 33's benchmark has to generate a longer corpus for
 * this arm or exclude it and say which.
 *
 * ## Blind spots
 *
 * Purely temporal: one series, no spatial pooling, so a cluster split across two wards is
 * two half-strength series. Seasonality is handled by *only* looking at the same weeks in
 * previous years, which is a strong assumption — a laboratory whose case mix changed last
 * year has a reference set describing a different laboratory. And the reweighting that
 * protects the baseline from past outbreaks will equally suppress a genuine sustained rise,
 * so a resistance level that has been climbing for three years is progressively absorbed
 * into the baseline and stops alarming. For creeping resistance specifically, the CUSUM in
 * `process-control.ts` is the better instrument, and that difference is the reason both are
 * in the benchmark.
 *
 * Farrington CP, Andrews NJ, Beale AD, Catchpole MA. A statistical algorithm for the early
 * detection of outbreaks of infectious disease. Journal of the Royal Statistical Society A
 * 1996;159:547-563. doi:10.2307/2983331
 *
 * Noufaily A, Enki DG, Farrington P, Garthwaite P, Andrews N, Charlett A. An improved
 * algorithm for outbreak detection in multiple surveillance systems. Statistics in Medicine
 * 2013;32:1206-1222. doi:10.1002/sim.5595 — its negative-binomial threshold and its
 * reweighting cutoff are available here as settings; its ten-level seasonal model is not
 * implemented, and the note below `NOUFAILY_NOT_IMPLEMENTED` says what that means.
 */

import { fitQuasiPoisson, predictStandardError, type GlmFit } from './glm'
import { ALL_LOCATIONS, aggregatePeriods, dayKey, periodEndOffsets, seriesFrom, type DailySeries } from './series'
import { pnorm, qnbinom, qnorm, qpois, twoSidedT } from './statistics'
import type { Detector, DetectorContext, DetectorDescriptor, DetectorRunResult, DetectorSignal } from './types'

const DAY_MS = 86_400_000

/**
 * What Noufaily 2013 changes that is *not* implemented here.
 *
 * The paper's central change is the seasonal model: instead of taking only the `2w + 1`
 * periods around each anniversary, it uses every period in the baseline and captures season
 * with a ten-level factor, which both enlarges the reference set and lets recent
 * non-anniversary weeks inform the fit. That is a different design matrix and a different
 * reference-set construction, and implementing it half way — the threshold without the
 * seasonal model — would produce numbers that match neither paper.
 *
 * So the two changes that are self-contained are offered as settings and named as such:
 * `thresholdMethod: 'negative-binomial'` is Noufaily's plug-in threshold, and
 * `weightsThreshold: 2.58` is its reweighting cutoff. Selecting both does **not** make this
 * `farringtonFlexible`, and the descriptor does not claim it does.
 */
export const NOUFAILY_NOT_IMPLEMENTED =
  'The ten-level seasonal model of Noufaily 2013 is not implemented. Its negative-binomial '
  + 'threshold and its 2.58 reweighting cutoff are available as settings; selecting them gives '
  + 'Farrington 1996 with two of Noufaily\'s changes, not farringtonFlexible.'

export interface FarringtonSettings {
  /** Days per period. Weekly is what the method is written for. */
  periodDays: number
  /** Years of history used as reference. Below 3 the trend term is never retained. */
  yearsBack: number
  /** Periods either side of each anniversary. */
  windowHalfWidth: number
  /** Periods in a year. 52 for weekly periods; derived from `periodDays` when left null. */
  periodsPerYear: number
  /** One-sided tail probability for the threshold. */
  alpha: number
  /** Fit a time trend, subject to the retention rule. */
  trend: boolean
  /** Down-weight past outbreaks before refitting. */
  reweight: boolean
  /** Anscombe residual above which an observation is down-weighted. 1 is Farrington's. */
  weightsThreshold: number
  /** `power-2/3` is Farrington 1996; `negative-binomial` is Noufaily's plug-in. */
  thresholdMethod: 'power-2/3' | 'negative-binomial'
  /** Cases required in the last `limitPeriods` periods before an alarm may fire. */
  limitCases: number
  limitPeriods: number
  /** Minimum resistant isolates across the series before it is tested at all. */
  minimumTotalCases: number
  historyDays: number
}

export const DEFAULT_FARRINGTON_SETTINGS: FarringtonSettings = Object.freeze({
  periodDays: 7,
  yearsBack: 5,
  windowHalfWidth: 3,
  periodsPerYear: 52,
  // One-sided, and 0.005 rather than 0.01 because `algo.farrington` uses `alpha/2` in its
  // two-sided form: this reproduces the reference package's default threshold exactly.
  alpha: 0.005,
  trend: true,
  reweight: true,
  weightsThreshold: 1,
  thresholdMethod: 'power-2/3',
  limitCases: 5,
  limitPeriods: 4,
  minimumTotalCases: 10,
  historyDays: 2555
})

export interface FarringtonPeriodResult {
  /** Index of the tested period within the aggregated series. */
  index: number
  observed: number
  /** Predicted count for this period from the reference years. */
  expected: number
  /** Upper threshold. An alarm is `observed > threshold`. */
  threshold: number
  /** Overdispersion, floored at 1. Above 1 the counts are more variable than Poisson. */
  dispersion: number
  /** Whether the time trend survived the retention rule for this period. */
  trend: boolean
  /** Exceedance probability of the observed count under the fitted baseline. */
  probability: number
  /** `(observed - expected) / (threshold - expected)`. Above 1 is an alarm. */
  score: number
  alarm: boolean
  referenceValues: number
}

/** Reference period indices for a tested index, most distant year first. */
export function referenceIndices(
  index: number, yearsBack: number, windowHalfWidth: number, periodsPerYear: number
): number[] {
  const out: number[] = []
  for (let year = yearsBack; year >= 1; year -= 1) {
    const anniversary = index - periodsPerYear * year
    for (let offset = -windowHalfWidth; offset <= windowHalfWidth; offset += 1) {
      const candidate = anniversary + offset
      if (candidate >= 0) out.push(candidate)
    }
  }
  return out
}

/**
 * Anscombe residuals, standardised by dispersion and leverage.
 *
 * `a = 3/2 * (y^(2/3) mu^(-1/6) - mu^(1/2)) / sqrt(phi (1 - h))`. Anscombe's transformation
 * rather than Pearson's because it is very close to normal for Poisson counts, which is what
 * makes a fixed cutoff meaningful across baselines of different size.
 */
export function anscombeResiduals(
  response: readonly number[], fitted: readonly number[], hat: readonly number[], dispersion: number
): number[] {
  return response.map((y, index) => {
    const mu = fitted[index] as number
    const numerator = 1.5 * (Math.pow(y, 2 / 3) * Math.pow(mu, -1 / 6) - Math.sqrt(mu))
    const denominator = Math.sqrt(dispersion * (1 - (hat[index] as number)))
    return denominator > 0 ? numerator / denominator : 0
  })
}

/**
 * Farrington's weight assignment.
 *
 * Observations with a residual above the cutoff are down-weighted by the inverse square of
 * their residual, and the whole vector is rescaled so the weights sum to the number of
 * observations. The rescaling is what keeps the dispersion estimate on the same footing as
 * an unweighted fit.
 */
export function assignWeights(residuals: readonly number[], threshold: number): number[] {
  let denominator = 0
  for (const residual of residuals) denominator += residual > threshold ? Math.pow(residual, -2) : 1
  const gamma = denominator > 0 ? residuals.length / denominator : 1
  return residuals.map((residual) => residual > threshold ? gamma * Math.pow(residual, -2) : gamma)
}

function designFor(indices: readonly number[], trend: boolean): number[][] {
  return indices.map((index) => trend ? [1, index] : [1])
}

/**
 * Fit, reweight, refit — and carry both dispersions out.
 *
 * `phi` is floored at 1 and is what the threshold uses: Farrington's argument is that counts
 * are never *less* variable than Poisson in practice, and a dispersion below 1 is sampling
 * noise in the estimate rather than evidence of underdispersion.
 *
 * The coefficient test uses the **unfloored** estimate, because that is what R's
 * `summary.glm` does — it recomputes its own dispersion and never sees `model$phi`. The
 * difference is not cosmetic. On the validation series the two disagree about the trend term
 * in four of a hundred and one tested periods, and where they disagree the threshold moves by
 * up to 28%. Flooring here would have produced an implementation that looked right, agreed
 * with the reference on every alarm, and was wrong.
 */
function fitWithReweighting(
  response: readonly number[], indices: readonly number[], trend: boolean, settings: FarringtonSettings
): { fit: GlmFit; phi: number; dispersion: number } | null {
  const design = designFor(indices, trend)
  const initial = fitQuasiPoisson(response, design)
  if (!initial) return null
  if (!settings.reweight) {
    return { fit: initial, phi: Math.max(initial.dispersion, 1), dispersion: initial.dispersion }
  }
  const residuals = anscombeResiduals(response, initial.fitted, initial.hat, Math.max(initial.dispersion, 1))
  const weights = assignWeights(residuals, settings.weightsThreshold)
  const reweighted = fitQuasiPoisson(response, design, { weights })
  if (!reweighted) {
    return { fit: initial, phi: Math.max(initial.dispersion, 1), dispersion: initial.dispersion }
  }
  return { fit: reweighted, phi: Math.max(reweighted.dispersion, 1), dispersion: reweighted.dispersion }
}

/**
 * Test one period against its reference years.
 *
 * Returns `null` when the period cannot be tested — too little history, a reference set that
 * will not support a fit, or a model that did not converge. A period that cannot be tested is
 * not a period with no aberration, and the two must not be conflated.
 */
export function farringtonAt(
  counts: readonly number[], index: number, raw: Partial<FarringtonSettings> = {}
): FarringtonPeriodResult | null {
  const settings = { ...DEFAULT_FARRINGTON_SETTINGS, ...raw }
  const indices = referenceIndices(index, settings.yearsBack, settings.windowHalfWidth, settings.periodsPerYear)
  if (indices.length < 4) return null
  const response = indices.map((position) => counts[position] ?? 0)
  if (response.reduce((sum, value) => sum + value, 0) <= 0) return null

  let trend = settings.trend
  let fitted = fitWithReweighting(response, indices, trend, settings)
  if (!fitted) return null

  if (trend) {
    // The retention rule, exactly as the reference states it: at least three reference
    // years, a significant coefficient, and a prediction that does not extrapolate above
    // everything the reference set contains. All three, or the trend goes.
    const slope = fitted.fit.coefficients[1] ?? 0
    const standardError = Math.sqrt(Math.max(0,
      fitted.dispersion * ((fitted.fit.covUnscaled[1] as number[])?.[1] ?? 0)))
    const pValue = standardError > 0 && fitted.fit.dfResidual > 0
      ? twoSidedT(slope / standardError, fitted.fit.dfResidual)
      : 1
    const predicted = Math.exp((fitted.fit.coefficients[0] ?? 0) + slope * index)
    const significant = pValue < 0.05
    const enoughYears = settings.yearsBack >= 3
    const noExtrapolation = predicted <= Math.max(...response)
    if (!(enoughYears && significant && noExtrapolation)) {
      trend = false
      fitted = fitWithReweighting(response, indices, false, settings)
      if (!fitted) return null
    }
  }

  const row = trend ? [1, index] : [1]
  const expected = Math.exp(row.reduce((sum, value, position) =>
    sum + value * (fitted.fit.coefficients[position] ?? 0), 0))
  if (!Number.isFinite(expected) || expected <= 0) return null
  const standardErrorLink = predictStandardError(fitted.fit, row, fitted.phi)
  // R predicts on the response scale; by the delta method the standard error there is the
  // link-scale one multiplied by the fitted mean.
  const standardErrorResponse = standardErrorLink * expected

  const observed = counts[index] ?? 0
  let threshold: number
  let probability: number
  if (settings.thresholdMethod === 'negative-binomial') {
    // Noufaily's plug-in: a negative binomial with the fitted mean and the estimated
    // overdispersion, rather than a normal interval on a transformed scale.
    if (fitted.phi > 1) {
      const size = expected / (fitted.phi - 1)
      threshold = qnbinom(1 - settings.alpha, size, expected)
      probability = 1 - pnbinomAt(observed - 1, size, expected)
    } else {
      threshold = qpois(1 - settings.alpha, expected)
      probability = 1 - ppoisAt(observed - 1, expected)
    }
  } else {
    const tau = fitted.phi + (standardErrorResponse * standardErrorResponse) / expected
    const scale = Math.sqrt((4 / 9) * Math.pow(expected, 1 / 3) * tau)
    threshold = Math.pow(Math.pow(expected, 2 / 3) + qnorm(1 - settings.alpha) * scale, 3 / 2)
    probability = 1 - pnorm((Math.pow(observed, 2 / 3) - Math.pow(expected, 2 / 3)) / scale)
  }

  // Farrington's `limit54`: no alarm unless the recent periods carry enough cases at all.
  // Without it, a stream that is almost always zero alarms on a single isolate.
  let recent = 0
  for (let position = Math.max(0, index - settings.limitPeriods + 1); position <= index; position += 1) {
    recent += counts[position] ?? 0
  }
  const enoughCases = recent >= settings.limitCases
  const score = threshold > expected ? (observed - expected) / (threshold - expected) : 0

  return {
    index,
    observed,
    expected,
    threshold,
    dispersion: fitted.phi,
    trend,
    probability,
    score,
    alarm: enoughCases && score > 1,
    referenceValues: indices.length
  }
}

function ppoisAt(k: number, lambda: number): number {
  return k < 0 ? 0 : qpoisCdf(k, lambda)
}
function qpoisCdf(k: number, lambda: number): number {
  let term = Math.exp(-lambda)
  let sum = term
  for (let index = 1; index <= Math.floor(k); index += 1) {
    term *= lambda / index
    sum += term
  }
  return Math.min(1, sum)
}
function pnbinomAt(k: number, size: number, mu: number): number {
  if (k < 0) return 0
  const probability = size / (size + mu)
  let term = Math.exp(size * Math.log(probability))
  let sum = term
  for (let index = 1; index <= Math.floor(k); index += 1) {
    term *= (size + index - 1) / index * (1 - probability)
    sum += term
  }
  return Math.min(1, sum)
}

// ---------------------------------------------------------------------------------
// Detector

export interface FarringtonSignal {
  signal_id: string
  status: 'alert' | 'monitor'
  organism: string
  antibiotic: string
  location: string
  pooled: boolean
  start_date: string
  end_date: string
  observed: number
  expected: number
  threshold: number
  dispersion: number
  trend: boolean
  probability: number
  score: number
  referenceValues: number
}

export interface FarringtonResult {
  method: string
  settings: FarringtonSettings
  studyStart: string
  studyEnd: string
  series: number
  tested: number
  periodsTested: number
  signals: FarringtonSignal[]
  warnings: string[]
}

const round = (value: number, digits = 3): number => Number(value.toFixed(digits))

function fnv1a(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function boundSettings(raw: Partial<FarringtonSettings> = {}): FarringtonSettings {
  const d = DEFAULT_FARRINGTON_SETTINGS
  const clampInt = (value: number | undefined, low: number, high: number, fallback: number): number =>
    Math.max(low, Math.min(high, Math.trunc(value ?? fallback)))
  const periodDays = clampInt(raw.periodDays, 1, 90, d.periodDays)
  return {
    periodDays,
    yearsBack: clampInt(raw.yearsBack, 1, 20, d.yearsBack),
    windowHalfWidth: clampInt(raw.windowHalfWidth, 0, 26, d.windowHalfWidth),
    // Derived from the period length rather than trusted from the caller, because a
    // mismatch between the two silently compares the wrong season.
    periodsPerYear: Math.max(1, Math.round(365.25 / periodDays)),
    alpha: Math.max(1e-6, Math.min(0.2, raw.alpha ?? d.alpha)),
    trend: raw.trend !== false,
    reweight: raw.reweight !== false,
    weightsThreshold: Math.max(0.1, Math.min(10, raw.weightsThreshold ?? d.weightsThreshold)),
    thresholdMethod: raw.thresholdMethod === 'negative-binomial' ? 'negative-binomial' : 'power-2/3',
    limitCases: clampInt(raw.limitCases, 0, 1000, d.limitCases),
    limitPeriods: clampInt(raw.limitPeriods, 1, 52, d.limitPeriods),
    minimumTotalCases: clampInt(raw.minimumTotalCases, 1, 10_000, d.minimumTotalCases),
    historyDays: clampInt(raw.historyDays, 365, 7300, d.historyDays)
  }
}

const parseDay = (value: string): number => Math.round(Date.parse(`${value}T00:00:00Z`) / DAY_MS)

/** Periods of history the settings require before any period can be tested. */
export function requiredPeriods(settings: FarringtonSettings): number {
  return settings.periodsPerYear * settings.yearsBack + settings.windowHalfWidth + 1
}

export function runFarrington(context: DetectorContext, raw: Partial<FarringtonSettings> = {}): FarringtonResult {
  const settings = boundSettings(raw)
  const built = seriesFrom(context, {
    historyDays: settings.historyDays, minimumTotalCases: settings.minimumTotalCases
  })
  const empty = (warning: string): FarringtonResult => ({
    method: 'Farrington quasi-Poisson aberration detection', settings,
    studyStart: built.studyStart, studyEnd: built.studyEnd,
    series: built.series.length, tested: 0, periodsTested: 0, signals: [], warnings: [warning]
  })
  if (built.series.length === 0) return empty('No series with enough resistant isolates to test.')

  const offsets = periodEndOffsets(built.days, settings.periodDays)
  const needed = requiredPeriods(settings)
  if (offsets.length < needed) {
    const haveYears = (offsets.length / settings.periodsPerYear).toFixed(1)
    return empty(`Farrington needs ${settings.yearsBack} years of history before it can test a single `
      + `period — ${needed} periods of ${settings.periodDays} days — and this series has ${offsets.length} `
      + `(${haveYears} years). The method compares each period against the same period in previous years, `
      + 'so there is nothing to compare against. Lower `yearsBack` at the cost of the trend term, which is '
      + 'dropped entirely below three years, or use a temporal detector that does not need a seasonal '
      + 'reference: the CUSUM and EWMA charts need only a baseline.')
  }

  const studyStartDay = parseDay(built.studyStart)
  const signals: FarringtonSignal[] = []
  let tested = 0
  let periodsTested = 0
  for (const series of built.series) {
    const counts = aggregatePeriods(series.cases, settings.periodDays)
    tested += 1
    for (let index = needed - 1; index < counts.length; index += 1) {
      const result = farringtonAt(counts, index, settings)
      if (!result) continue
      periodsTested += 1
      if (!result.alarm) continue
      const endDay = offsets[index] ?? 0
      const startDay = endDay - (settings.periodDays - 1)
      signals.push({
        signal_id: fnv1a(['farrington', series.organismCode, series.antibioticCode, series.location, index]
          .join('|')).toString(16).padStart(8, '0'),
        // A Farrington alarm has an exceedance probability, so `alert` can mean something
        // sharper than "past the threshold": below one in a thousand under the fitted
        // baseline. Everything else that crossed is worth watching and is not an alert.
        status: result.probability < 0.001 ? 'alert' : 'monitor',
        organism: series.organismCode,
        antibiotic: series.antibioticCode,
        location: series.location,
        pooled: series.pooled,
        start_date: dayKey(studyStartDay + startDay),
        end_date: dayKey(studyStartDay + endDay),
        observed: result.observed,
        expected: round(result.expected, 2),
        threshold: round(result.threshold, 2),
        dispersion: round(result.dispersion, 2),
        trend: result.trend,
        probability: Number(result.probability.toPrecision(3)),
        score: round(result.score, 2),
        referenceValues: result.referenceValues
      })
    }
  }
  signals.sort((left, right) => right.score - left.score || right.observed - left.observed)

  const warnings: string[] = [
    'Farrington tests each series independently and corrects for no multiplicity across series '
    + 'or locations. Compare against a scan statistic at a matched empirical false-alert rate.',
    'The reweighting that stops a past outbreak inflating the baseline equally suppresses a genuine '
    + 'sustained rise: a resistance level climbing for several years is progressively absorbed into '
    + 'the reference set and stops alarming.'
  ]
  if (settings.yearsBack < 3) {
    warnings.push(`With ${settings.yearsBack} reference years the time trend is never retained — the `
      + 'reference rule requires at least three — so this is the intercept-only form of the method.')
  }
  if (settings.thresholdMethod === 'negative-binomial') warnings.push(NOUFAILY_NOT_IMPLEMENTED)

  return {
    method: 'Farrington quasi-Poisson aberration detection',
    settings,
    studyStart: built.studyStart,
    studyEnd: built.studyEnd,
    series: built.series.length,
    tested,
    periodsTested,
    signals: signals.slice(0, 50),
    warnings
  }
}

export const FARRINGTON_ID = 'farrington'

export const farringtonDescriptor: DetectorDescriptor = Object.freeze({
  id: FARRINGTON_ID,
  name: 'Farrington aberration detection',
  method: 'Farrington 1996 quasi-Poisson regression on seasonal reference periods',
  family: 'regression',
  requires: Object.freeze({ denominators: false, coordinates: false, multipleLocations: false }),
  supports: Object.freeze({ prospective: true, retrospective: true }),
  blindSpot: 'Needs years of history: with five reference years no period inside the first five years '
    + 'can be tested at all, and no corpus this repository generates is that long. Purely temporal, so a '
    + 'cluster split across two wards is two half-strength series. And its reweighting suppresses a '
    + 'sustained rise as readily as a past outbreak, so creeping resistance is absorbed into the '
    + 'baseline rather than detected.',
  citation: 'Farrington CP, Andrews NJ, Beale AD, Catchpole MA. A statistical algorithm for the early '
    + 'detection of outbreaks of infectious disease. Journal of the Royal Statistical Society A '
    + '1996;159:547-563. doi:10.2307/2983331'
})

export const farringtonDetector: Detector = {
  descriptor: farringtonDescriptor,

  defaultSettings(): Record<string, unknown> {
    return { ...DEFAULT_FARRINGTON_SETTINGS }
  },

  unavailableReason(context: DetectorContext): string | null {
    if (!context.records?.length && !context.denominators?.length) {
      return 'No data: this method tests a periodic series against the same periods in previous years.'
    }
    const settings = boundSettings((context.settings ?? {}) as Partial<FarringtonSettings>)
    const built = seriesFrom(context, {
      historyDays: settings.historyDays, minimumTotalCases: settings.minimumTotalCases
    })
    if (built.days === 0) return 'No series with enough resistant isolates to test.'
    const available = Math.floor(built.days / settings.periodDays)
    const needed = requiredPeriods(settings)
    if (available < needed) {
      return `Only ${(built.days / 365.25).toFixed(1)} years of history and this method needs `
        + `${settings.yearsBack} before it can test a single period: it compares each period against the `
        + 'same period in previous years, and there are no previous years here. EWMA and the CUSUM charts '
        + 'need a baseline rather than a seasonal reference and can run on this data.'
    }
    return null
  },

  run(context: DetectorContext): DetectorRunResult {
    const result = runFarrington(context, (context.settings ?? {}) as Partial<FarringtonSettings>)
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
      days: result.settings.periodDays,
      observed: signal.observed,
      expected: signal.expected,
      excess: round(signal.observed - signal.expected, 2),
      observed_expected_ratio: signal.expected > 0 ? round(signal.observed / signal.expected, 2) : 0,
      // No likelihood ratio: this is a regression threshold, not a scan. The exceedance
      // probability is a genuine p-value under the fitted baseline and is reported as one;
      // it is not corrected for testing every period of every series, and the warnings say so.
      log_likelihood_ratio: 0,
      p_value: signal.probability,
      recurrence_interval_days: 0,
      detector_id: FARRINGTON_ID,
      farrington_threshold: signal.threshold,
      farrington_dispersion: signal.dispersion,
      farrington_trend: signal.trend,
      farrington_score: signal.score
    } as DetectorSignal))
    return {
      descriptor: farringtonDescriptor,
      settings: { ...result.settings },
      signals,
      warnings: [...result.warnings],
      diagnostics: {
        method: result.method,
        study_start: result.studyStart || null,
        study_end: result.studyEnd || null,
        series: result.series,
        series_tested: result.tested,
        periods_tested: result.periodsTested,
        period_days: result.settings.periodDays,
        years_back: result.settings.yearsBack,
        threshold_method: result.settings.thresholdMethod,
        required_periods: requiredPeriods(result.settings),
        maximum_reachable_recurrence_interval: 0
      }
    }
  }
}

export { ALL_LOCATIONS }
export type { DailySeries }
