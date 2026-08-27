/**
 * Statistical process control on a resistance series: EWMA and two CUSUMs.
 *
 * These are not scan statistics and should not be read as cheaper ones. A scan enumerates
 * windows over a location-by-time grid and asks which window is least likely under a
 * permutation null; a control chart watches one series and asks whether the process that
 * generated it has shifted. The difference has consequences in both directions.
 *
 * *What they gain.* No Monte Carlo, so a decision costs microseconds rather than the thirty
 * seconds Phase 32 measured for one site at 999 replications — a chart can run on every
 * stream in a laboratory on every day of the year. And they are **sequential**: evidence
 * accumulates across periods instead of being recomputed from scratch, which is why a CUSUM
 * finds a small sustained shift that a window-by-window scan, tuned for a burst, walks past.
 * Creeping resistance is exactly a small sustained shift.
 *
 * *What they lose.* They have no spatial dimension at all. A cluster spread over two wards
 * is two series each carrying half the evidence, and neither may cross its limit — the scan
 * statistics pool that automatically and these cannot. They also correct for no multiplicity
 * whatsoever: a laboratory with 400 streams charting at a nominal 1-in-370 false-alarm rate
 * produces roughly one false alarm per period from the multiplicity alone. Phase 33's
 * matched-empirical-false-alert-rate comparison exists because of this, and comparing these
 * against a scan statistic at their respective nominal thresholds would be meaningless.
 *
 * ## The three charts
 *
 * **EWMA** (Roberts 1959) smooths the series geometrically and flags when the smoothed value
 * leaves limits computed from the in-control mean. Fast, and the smoothing is also its blind
 * spot: a single enormous day is damped by `lambda` and may not cross.
 *
 * **Poisson CUSUM** (Page 1954; Lucas 1985 for the Poisson form) accumulates
 * `max(0, S + x - k)` and signals at `h`. Sensitive to sustained shifts, and *insensitive to
 * where in the window they happened* — a CUSUM says the process has drifted, not when.
 *
 * **Bernoulli CUSUM on the resistant proportion** (Reynolds and Stoumbos 2000) is the form
 * that fits antimicrobial resistance most naturally, and the reason this file exists rather
 * than the count charts alone. It scores each tested isolate by the log-likelihood ratio
 * between an out-of-control resistance proportion and the in-control one, so a ward whose
 * testing volume halves contributes half as much evidence rather than looking like a fall in
 * resistance. The count charts cannot make that distinction.
 *
 * References:
 * - Roberts SW. Control chart tests based on geometric moving averages. Technometrics
 *   1959;1:239-250. doi:10.1080/00401706.1959.10489860
 * - Page ES. Continuous inspection schemes. Biometrika 1954;41:100-115. doi:10.2307/2333009
 * - Lucas JM. Counted data CUSUMs. Technometrics 1985;27:129-144. doi:10.1080/00401706.1985.10488030
 * - Reynolds MR, Stoumbos ZG. A general approach to modeling CUSUM charts for a proportion.
 *   IIE Transactions 2000;32:515-535. doi:10.1080/07408170008963928
 */

import { aggregatePeriods, dayKey, periodEndOffsets, seriesFrom, type DailySeries } from './series'
import type { Detector, DetectorContext, DetectorDescriptor, DetectorRunResult, DetectorSignal } from './types'

const DAY_MS = 86_400_000

export interface ProcessControlSettings {
  /** Days per charted period. Daily counts of one pair in one ward are mostly zero. */
  periodDays: number
  /** Periods used to estimate the in-control mean before charting begins. */
  baselinePeriods: number
  /** Periods of history to read. */
  historyDays: number
  /** EWMA smoothing constant. Small values weight history, large ones weight today. */
  lambda: number
  /** EWMA limit width in standard deviations. */
  limitSigma: number
  /**
   * CUSUM reference value as a multiple of the in-control mean.
   *
   * The shift the chart is tuned to detect. `k` sits halfway between in-control and
   * out-of-control on the log scale; 0.5 means "tuned for a 50% rise".
   */
  cusumShift: number
  /** CUSUM decision interval, in units of the in-control standard deviation. */
  cusumLimit: number
  /** Out-of-control resistant proportion the Bernoulli CUSUM is tuned against. */
  proportionShift: number
  /** Minimum resistant isolates across the whole series before it is charted. */
  minimumTotalCases: number
  /** Minimum in-control mean. A chart on a mean of 0.2 alarms on a single case. */
  minimumBaselineMean: number
}

export const DEFAULT_PROCESS_CONTROL_SETTINGS: ProcessControlSettings = Object.freeze({
  periodDays: 7,
  baselinePeriods: 26,
  historyDays: 730,
  // 0.2 is the value the SPC literature reaches for by default and the one hospital
  // infection-surveillance papers use; it detects a one-sigma shift quickly without
  // reacting to a single busy day.
  lambda: 0.2,
  limitSigma: 3,
  cusumShift: 0.5,
  cusumLimit: 4,
  // A rise from a laboratory's own baseline to half again as much. Not a clinical
  // threshold, and no clinical meaning should be read into it.
  proportionShift: 1.5,
  minimumTotalCases: 10,
  minimumBaselineMean: 1
})

export type ProcessControlMethod = 'ewma' | 'cusum-poisson' | 'cusum-bernoulli'

export interface ProcessControlSignal {
  signal_id: string
  status: 'alert' | 'monitor'
  method: ProcessControlMethod
  organism: string
  antibiotic: string
  location: string
  pooled: boolean
  start_date: string
  end_date: string
  /** Periods the chart has been above its limit, including this one. */
  runLength: number
  observed: number
  tested: number
  /** In-control mean per period, estimated from the baseline. */
  baseline: number
  /** The charted statistic: the EWMA value, or the CUSUM sum. */
  statistic: number
  limit: number
  /** How far past the limit, in limit units. Used for ranking, never as a p-value. */
  exceedance: number
}

export interface ProcessControlResult {
  method: string
  chart: ProcessControlMethod
  settings: ProcessControlSettings
  studyStart: string
  studyEnd: string
  series: number
  charted: number
  /**
   * Signals before the reporting cap.
   *
   * Reported separately because the cap is 50 and these charts can produce hundreds: a run
   * that says "50 signals" when it found 600 has hidden the one number that matters. On a
   * seeded corpus with no outbreak in it, 241 charted series produced far more than 50, and
   * that measurement is the argument for Phase 33's matched-false-alert-rate comparison.
   */
  signalsFound: number
  signals: ProcessControlSignal[]
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

/**
 * The EWMA recursion and its time-varying limits.
 *
 * `z[t] = lambda * x[t] + (1 - lambda) * z[t-1]`, starting from the in-control mean, with
 * limits `mean +/- L * sigma * sqrt(lambda / (2 - lambda) * (1 - (1 - lambda)^(2t)))`. The
 * `(1 - (1 - lambda)^(2t))` term is the exact variance of the smoothed statistic rather than
 * its asymptote, which matters: using the asymptotic width makes the first few periods far
 * too wide and a chart that cannot alarm early is not a fast detector.
 */
export function ewmaChart(
  values: readonly number[], mean: number, sigma: number, lambda: number, limitSigma: number
): { z: number[]; upper: number[] } {
  const z: number[] = []
  const upper: number[] = []
  let current = mean
  for (let index = 0; index < values.length; index += 1) {
    current = lambda * (values[index] ?? 0) + (1 - lambda) * current
    z.push(current)
    const variance = (lambda / (2 - lambda)) * (1 - Math.pow(1 - lambda, 2 * (index + 1)))
    upper.push(mean + limitSigma * sigma * Math.sqrt(variance))
  }
  return { z, upper }
}

/**
 * Page's one-sided upper CUSUM: `S[t] = max(0, S[t-1] + x[t] - k)`.
 *
 * For counts, `k` is the reference value. Lucas's Poisson form puts it at
 * `(mu1 - mu0) / ln(mu1 / mu0)`, which is where the log-likelihood ratio between the two
 * means changes sign — that is the value this uses, rather than the arithmetic midpoint
 * often quoted, because the arithmetic midpoint is only correct for a normal mean.
 */
export function cusumChart(values: readonly number[], reference: number): number[] {
  const sums: number[] = []
  let current = 0
  for (const value of values) {
    current = Math.max(0, current + value - reference)
    sums.push(current)
  }
  return sums
}

export function poissonReference(inControl: number, shift: number): number {
  const outOfControl = inControl * (1 + shift)
  if (inControl <= 0 || outOfControl <= inControl) return inControl
  return (outOfControl - inControl) / Math.log(outOfControl / inControl)
}

/**
 * Bernoulli CUSUM on the resistant proportion.
 *
 * Each period contributes the log-likelihood ratio of its observed resistant-among-tested
 * under `p1` against `p0`, accumulated and floored at zero. Written per period rather than
 * per isolate because the series is already aggregated, and the two are identical: the
 * log-likelihood ratio of a period is the sum of its isolates' ratios.
 */
export function bernoulliCusum(
  cases: readonly number[], tested: readonly number[], p0: number, p1: number
): number[] {
  const sums: number[] = []
  const caseWeight = Math.log(p1 / p0)
  const controlWeight = Math.log((1 - p1) / (1 - p0))
  let current = 0
  for (let index = 0; index < cases.length; index += 1) {
    const resistant = cases[index] ?? 0
    const controls = Math.max(0, (tested[index] ?? 0) - resistant)
    current = Math.max(0, current + resistant * caseWeight + controls * controlWeight)
    sums.push(current)
  }
  return sums
}

export interface ProcessControlOptions {
  context: DetectorContext
  chart: ProcessControlMethod
  settings?: Partial<ProcessControlSettings>
  organismNames?: Readonly<Record<string, string>>
}

function boundSettings(raw: Partial<ProcessControlSettings> = {}): ProcessControlSettings {
  const clampInt = (value: number | undefined, low: number, high: number, fallback: number): number =>
    Math.max(low, Math.min(high, Math.trunc(value ?? fallback)))
  const clamp = (value: number | undefined, low: number, high: number, fallback: number): number =>
    Math.max(low, Math.min(high, value ?? fallback))
  const d = DEFAULT_PROCESS_CONTROL_SETTINGS
  return {
    periodDays: clampInt(raw.periodDays, 1, 90, d.periodDays),
    baselinePeriods: clampInt(raw.baselinePeriods, 4, 520, d.baselinePeriods),
    historyDays: clampInt(raw.historyDays, 60, 3650, d.historyDays),
    lambda: clamp(raw.lambda, 0.01, 1, d.lambda),
    limitSigma: clamp(raw.limitSigma, 1, 6, d.limitSigma),
    cusumShift: clamp(raw.cusumShift, 0.05, 5, d.cusumShift),
    cusumLimit: clamp(raw.cusumLimit, 0.5, 20, d.cusumLimit),
    proportionShift: clamp(raw.proportionShift, 1.05, 10, d.proportionShift),
    minimumTotalCases: clampInt(raw.minimumTotalCases, 1, 10_000, d.minimumTotalCases),
    minimumBaselineMean: clamp(raw.minimumBaselineMean, 0.01, 1000, d.minimumBaselineMean)
  }
}

const parseDay = (value: string): number => Math.round(Date.parse(`${value}T00:00:00Z`) / DAY_MS)

export function runProcessControl(options: ProcessControlOptions): ProcessControlResult {
  const settings = boundSettings(options.settings)
  const chart = options.chart
  const names = options.organismNames ?? {}
  const built = seriesFrom(options.context, {
    historyDays: settings.historyDays, minimumTotalCases: settings.minimumTotalCases
  })

  const empty = (warning: string): ProcessControlResult => ({
    method: METHOD_NAMES[chart], chart, settings,
    studyStart: built.studyStart, studyEnd: built.studyEnd,
    series: built.series.length, charted: 0, signalsFound: 0, signals: [], warnings: [warning]
  })
  if (built.series.length === 0) {
    return empty('No series with enough resistant isolates to chart.')
  }

  const studyStartDay = parseDay(built.studyStart)
  const offsets = periodEndOffsets(built.days, settings.periodDays)
  if (offsets.length <= settings.baselinePeriods) {
    return empty(`Only ${offsets.length} complete periods of history and ${settings.baselinePeriods} are `
      + 'needed for the baseline, so no period can be charted. Lengthen the history, shorten the period, '
      + 'or lower the baseline requirement — and note that a shorter baseline is a noisier one.')
  }

  const signals: ProcessControlSignal[] = []
  let charted = 0
  for (const series of built.series) {
    const cases = aggregatePeriods(series.cases, settings.periodDays)
    const tested = aggregatePeriods(series.tested, settings.periodDays)
    const baselineCases = cases.slice(0, settings.baselinePeriods)
    const baselineTested = tested.slice(0, settings.baselinePeriods)
    const baselineMean = baselineCases.reduce((sum, value) => sum + value, 0) / settings.baselinePeriods

    if (chart === 'cusum-bernoulli') {
      const totalTested = baselineTested.reduce((sum, value) => sum + value, 0)
      const totalCases = baselineCases.reduce((sum, value) => sum + value, 0)
      // A baseline proportion of 0 or 1 leaves no log-likelihood ratio to compute; a
      // proportion the shift would push past 1 leaves none either.
      const p0 = totalTested > 0 ? totalCases / totalTested : 0
      const p1 = Math.min(0.999, p0 * settings.proportionShift)
      if (p0 <= 0 || p0 >= 0.999 || p1 <= p0) continue
      charted += 1
      const sums = bernoulliCusum(cases, tested, p0, p1)
      collect(series, sums, settings.cusumLimit, baselineMean, cases, tested, offsets, studyStartDay, chart, names, signals, settings)
      continue
    }

    if (baselineMean < settings.minimumBaselineMean) continue
    charted += 1
    if (chart === 'ewma') {
      // Poisson: the variance of a count is its mean, so the standard deviation is its root.
      const sigma = Math.sqrt(baselineMean)
      const { z, upper } = ewmaChart(cases, baselineMean, sigma, settings.lambda, settings.limitSigma)
      collect(series, z, upper, baselineMean, cases, tested, offsets, studyStartDay, chart, names, signals, settings)
    } else {
      const reference = poissonReference(baselineMean, settings.cusumShift)
      const sums = cusumChart(cases, reference)
      collect(series, sums, settings.cusumLimit * Math.sqrt(baselineMean), baselineMean, cases, tested, offsets, studyStartDay, chart, names, signals, settings)
    }
  }

  signals.sort((left, right) => right.exceedance - left.exceedance || right.observed - left.observed)

  const warnings: string[] = [
    `${signals.length} signals from ${charted} charted series. A control chart corrects for no `
    + 'multiplicity: every stream and every location is charted independently, so the count grows '
    + 'with the number of streams whether or not anything changed. Compare against a scan statistic '
    + 'at a matched empirical false-alert rate, never at matched nominal limits.'
  ]
  if (offsets.length - settings.baselinePeriods < 8) {
    warnings.push(`Only ${offsets.length - settings.baselinePeriods} periods are charted after the baseline. `
      + 'A control chart is a sequential method and is weakest at the start of its run.')
  }

  return {
    method: METHOD_NAMES[chart], chart, settings,
    studyStart: built.studyStart, studyEnd: built.studyEnd,
    series: built.series.length, charted,
    signalsFound: signals.length,
    signals: signals.slice(0, 50), warnings
  }
}

const METHOD_NAMES: Readonly<Record<ProcessControlMethod, string>> = Object.freeze({
  ewma: 'EWMA control chart on period counts',
  'cusum-poisson': 'Poisson CUSUM on period counts',
  'cusum-bernoulli': 'Bernoulli CUSUM on the resistant proportion'
})

/**
 * Turn a charted statistic into signals, one per run above the limit.
 *
 * One signal per *run*, not per period. A CUSUM that stays above its decision interval for
 * six weeks is one event, and reporting it six times would bury everything else — which is
 * the failure mode Phase 32 measured on the per-agent scan, in a different guise.
 */
function collect(
  series: DailySeries, statistic: readonly number[], limit: number | readonly number[],
  baseline: number, cases: readonly number[], tested: readonly number[],
  offsets: readonly number[], studyStartDay: number, chart: ProcessControlMethod,
  names: Readonly<Record<string, string>>, into: ProcessControlSignal[],
  settings: ProcessControlSettings
): void {
  const limitAt = (index: number): number => typeof limit === 'number' ? limit : (limit[index] ?? Infinity)
  let runStart: number | null = null
  const flush = (endIndex: number): void => {
    if (runStart === null) return
    const start = runStart
    runStart = null
    // The baseline periods are used to fit the chart and are not charted themselves: a
    // method judged against a baseline that includes the period it is judging will find an
    // excess wherever the baseline happens to be low.
    if (start < settings.baselinePeriods) return
    let observed = 0
    let testedTotal = 0
    let peak = 0
    let peakLimit = Infinity
    for (let index = start; index <= endIndex; index += 1) {
      observed += cases[index] ?? 0
      testedTotal += tested[index] ?? 0
      const value = statistic[index] ?? 0
      if (value - limitAt(index) > peak - peakLimit || peak === 0) {
        peak = value
        peakLimit = limitAt(index)
      }
    }
    const startDay = (offsets[start] ?? 0) - (settings.periodDays - 1)
    const endDay = offsets[endIndex] ?? 0
    into.push({
      signal_id: fnv1a([chart, series.organismCode, series.antibioticCode, series.location, start, endIndex].join('|'))
        .toString(16).padStart(8, '0'),
      // A chart has no p-value, so `alert` cannot mean "past a recurrence interval". It
      // means the run is at least two periods long: a single period above the limit is what
      // a chart does roughly once every `1/alpha` periods by construction, and a sustained
      // run is the thing these methods are actually good at.
      status: endIndex - start >= 1 ? 'alert' : 'monitor',
      method: chart,
      organism: names[series.organismCode] ?? series.organismCode,
      antibiotic: series.antibioticCode,
      location: series.location,
      pooled: series.pooled,
      start_date: dayKey(studyStartDay + startDay),
      end_date: dayKey(studyStartDay + endDay),
      runLength: endIndex - start + 1,
      observed,
      tested: testedTotal,
      baseline: round(baseline, 2),
      statistic: round(peak),
      limit: round(peakLimit),
      exceedance: peakLimit > 0 ? round(peak / peakLimit, 2) : 0
    })
  }

  for (let index = 0; index < statistic.length; index += 1) {
    const above = (statistic[index] ?? 0) > limitAt(index)
    if (above && runStart === null) runStart = index
    if (!above && runStart !== null) flush(index - 1)
  }
  if (runStart !== null) flush(statistic.length - 1)
}

// ---------------------------------------------------------------------------------
// Registration

export const EWMA_ID = 'ewma'
export const CUSUM_POISSON_ID = 'cusum-poisson'
export const CUSUM_BERNOULLI_ID = 'cusum-bernoulli'

const DESCRIPTORS: Readonly<Record<ProcessControlMethod, DetectorDescriptor>> = Object.freeze({
  ewma: Object.freeze({
    id: EWMA_ID,
    name: 'EWMA control chart',
    method: 'Exponentially weighted moving average on period counts',
    family: 'process-control',
    requires: Object.freeze({ denominators: false, coordinates: false, multipleLocations: false }),
    supports: Object.freeze({ prospective: true, retrospective: true }),
    blindSpot: 'Has no spatial dimension: a cluster spread over two wards is two half-strength '
      + 'series and may cross no limit, where a scan statistic pools them. The smoothing that makes '
      + 'it stable also damps a single very large period, and it corrects for no multiplicity at all.',
    citation: 'Roberts SW. Control chart tests based on geometric moving averages. Technometrics '
      + '1959;1:239-250. doi:10.1080/00401706.1959.10489860'
  }),
  'cusum-poisson': Object.freeze({
    id: CUSUM_POISSON_ID,
    name: 'Poisson CUSUM',
    method: 'Page cumulative sum on period counts, Lucas Poisson reference value',
    family: 'process-control',
    requires: Object.freeze({ denominators: false, coordinates: false, multipleLocations: false }),
    supports: Object.freeze({ prospective: true, retrospective: true }),
    blindSpot: 'Says the process has shifted, not when: the accumulated sum carries no information '
      + 'about where in the run the change began, so the reported window is the run above the limit '
      + 'and not the outbreak. Counts only, so a rise in testing volume reads as a rise in resistance.',
    citation: 'Page ES. Continuous inspection schemes. Biometrika 1954;41:100-115. doi:10.2307/2333009; '
      + 'Lucas JM. Counted data CUSUMs. Technometrics 1985;27:129-144. doi:10.1080/00401706.1985.10488030'
  }),
  'cusum-bernoulli': Object.freeze({
    id: CUSUM_BERNOULLI_ID,
    name: 'Bernoulli CUSUM on the resistant proportion',
    method: 'Reynolds-Stoumbos Bernoulli cumulative sum on resistant-among-tested',
    family: 'process-control',
    requires: Object.freeze({ denominators: true, coordinates: false, multipleLocations: false }),
    supports: Object.freeze({ prospective: true, retrospective: true }),
    blindSpot: 'Inherits every CUSUM limitation — no spatial pooling, no multiplicity correction, no '
      + 'statement of when the shift began — and adds a dependence on the baseline proportion being '
      + 'stable. A laboratory that changed its testing panel mid-series has changed p0 underneath the '
      + 'chart, and the chart cannot tell that from a change in resistance.',
    citation: 'Reynolds MR, Stoumbos ZG. A general approach to modeling CUSUM charts for a proportion. '
      + 'IIE Transactions 2000;32:515-535. doi:10.1080/07408170008963928'
  })
})

function toDetectorSignal(signal: ProcessControlSignal, detectorId: string): DetectorSignal {
  const expected = round(signal.baseline * signal.runLength, 2)
  return {
    signal_id: signal.signal_id,
    status: signal.status,
    signal_type: 'Resistance phenotype',
    organism: signal.organism,
    antibiotic: signal.antibiotic,
    scope: signal.pooled ? 'All-location temporal cluster' : 'Location cluster',
    location: signal.location,
    start_date: signal.start_date,
    end_date: signal.end_date,
    days: signal.runLength,
    observed: signal.observed,
    expected,
    excess: round(signal.observed - expected, 2),
    observed_expected_ratio: expected > 0 ? round(signal.observed / expected, 2) : 0,
    // A control chart produces no likelihood ratio and no p-value, and inventing one so the
    // fields line up would be worse than leaving them empty. `exceedance` is what ranks these
    // signals, and Phase 33 compares them at a matched empirical false-alert rate rather than
    // by pretending the two families share a scale.
    log_likelihood_ratio: 0,
    p_value: 0,
    recurrence_interval_days: 0,
    detector_id: detectorId,
    ...(signal.tested > 0 ? { tested: signal.tested } : {}),
    chart_statistic: signal.statistic,
    chart_limit: signal.limit,
    chart_exceedance: signal.exceedance
  } as DetectorSignal
}

function processControlDetector(chart: ProcessControlMethod): Detector {
  const descriptor = DESCRIPTORS[chart]
  return {
    descriptor,

    defaultSettings(): Record<string, unknown> {
      return { ...DEFAULT_PROCESS_CONTROL_SETTINGS }
    },

    unavailableReason(context: DetectorContext): string | null {
      if (!context.records?.length && !context.denominators?.length) {
        return 'No data: these charts watch a daily series of resistant isolates through time.'
      }
      if (chart === 'cusum-bernoulli') {
        const rows = context.denominators?.length ? context.denominators : null
        if (rows && !rows.some((row) => row.antibiotic_code !== '' && row.tested > 0)) {
          return 'No tested counts: the proportion CUSUM charts resistant-among-tested and needs the '
            + 'denominator as well as the numerator.'
        }
      }
      return null
    },

    run(context: DetectorContext): DetectorRunResult {
      const result = runProcessControl({
        context, chart, settings: (context.settings ?? {}) as Partial<ProcessControlSettings>
      })
      return {
        descriptor,
        settings: { ...result.settings },
        signals: result.signals.map((signal) => toDetectorSignal(signal, descriptor.id)),
        warnings: [...result.warnings],
        diagnostics: {
          method: result.method,
          chart: result.chart,
          study_start: result.studyStart || null,
          study_end: result.studyEnd || null,
          series: result.series,
          charted: result.charted,
          signals_found: result.signalsFound,
          period_days: result.settings.periodDays,
          baseline_periods: result.settings.baselinePeriods,
          // There is no such thing here, and saying so is better than omitting the field and
          // letting a reader assume the chart is comparable to a scan on its own scale.
          maximum_reachable_recurrence_interval: 0
        }
      }
    }
  }
}

export const ewmaDetector = processControlDetector('ewma')
export const poissonCusumDetector = processControlDetector('cusum-poisson')
export const bernoulliCusumDetector = processControlDetector('cusum-bernoulli')
