/**
 * The daily series the non-scan detectors read.
 *
 * Every detector before Phase 30 was a scan statistic: it enumerates windows over a
 * location-by-time grid and corrects against a Monte Carlo maximum. The process-control and
 * regression detectors do not work that way. They watch **one series through time** and ask
 * whether today departs from what the series itself predicts, which is a different question
 * with different strengths — no permutation, so a decision every day at negligible cost, and
 * no borrowing of strength across locations, so a two-ward cluster is two independent
 * findings or none.
 *
 * Building the series here rather than in each detector is deliberate. Phase 33 compares
 * these against the scan statistics on identical input, and a comparison whose arms disagree
 * about what a day's count *is* measures the aggregation. So: the same location key
 * (`stableLocation`), the same definition of resistant (`R` only, never `I`), the same
 * denominator (`deriveDenominators`), and every day in the study window present — including
 * the days with no isolates at all, because a zero is data and a gap is not.
 *
 * ## Scope, and the `All locations` series
 *
 * Each stream is emitted per location and once more with the locations pooled. The pooled
 * series is not a convenience: a temporal detector run only per ward cannot see a rise that
 * is spread evenly across every ward, which is precisely the case-only scan's documented
 * blind spot, and running the same detector on the pooled series is the cheapest way to
 * cover it. Both are reported, and each signal says which it came from.
 */

import { denominatorsFrom, deriveDenominators } from './denominators'
import type { DenominatorRow, DetectorContext } from './types'

const DAY_MS = 86_400_000

export const ALL_LOCATIONS = 'All locations'

export interface DailySeries {
  organismCode: string
  antibioticCode: string
  location: string
  /** True when this is the pooled series rather than one location's. */
  pooled: boolean
  /** Day 0 is `studyStart`; one entry per day, zeros included. */
  cases: number[]
  tested: number[]
}

export interface SeriesSet {
  studyStart: string
  studyEnd: string
  days: number
  series: DailySeries[]
}

const parseDay = (value: string): number => {
  const parsed = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(parsed) ? Math.round(parsed / DAY_MS) : Number.NaN
}
export const dayKey = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10)

export interface BuildSeriesOptions {
  /** Days of history to keep, counting back from the last day with data. */
  historyDays?: number
  /** Minimum resistant isolates in the whole series before it is worth watching. */
  minimumTotalCases?: number
}

export function buildDailySeries(
  denominators: readonly DenominatorRow[], options: BuildSeriesOptions = {}
): SeriesSet {
  const historyDays = Math.max(30, Math.trunc(options.historyDays ?? 730))
  const minimumTotalCases = Math.max(0, Math.trunc(options.minimumTotalCases ?? 5))

  const rows = denominators.filter((row) => row.antibiotic_code !== '' && row.tested > 0)
  const days = rows.map((row) => parseDay(row.date)).filter(Number.isFinite)
  if (days.length === 0) return { studyStart: '', studyEnd: '', days: 0, series: [] }

  let studyEnd = days[0] as number
  let dataStart = days[0] as number
  for (const day of days) {
    if (day > studyEnd) studyEnd = day
    if (day < dataStart) dataStart = day
  }
  const studyStart = Math.max(dataStart, studyEnd - (historyDays - 1))
  const length = studyEnd - studyStart + 1

  const blank = (): { cases: number[]; tested: number[] } => ({
    cases: Array.from({ length }, () => 0),
    tested: Array.from({ length }, () => 0)
  })
  const buckets = new Map<string, { organismCode: string; antibioticCode: string; location: string; pooled: boolean; cases: number[]; tested: number[] }>()
  const bump = (
    organismCode: string, antibioticCode: string, location: string, pooled: boolean,
    day: number, cases: number, tested: number
  ): void => {
    const key = `${organismCode}${antibioticCode}${location}`
    const bucket = buckets.get(key) ?? { organismCode, antibioticCode, location, pooled, ...blank() }
    bucket.cases[day] = (bucket.cases[day] ?? 0) + cases
    bucket.tested[day] = (bucket.tested[day] ?? 0) + tested
    buckets.set(key, bucket)
  }

  for (const row of rows) {
    const day = parseDay(row.date) - studyStart
    if (!Number.isFinite(day) || day < 0 || day >= length) continue
    bump(row.organism_code, row.antibiotic_code, row.location, false, day, row.resistant, row.tested)
    bump(row.organism_code, row.antibiotic_code, ALL_LOCATIONS, true, day, row.resistant, row.tested)
  }

  const series = [...buckets.values()]
    .filter((bucket) => bucket.cases.reduce((sum, value) => sum + value, 0) >= minimumTotalCases)
    .sort((left, right) => left.organismCode.localeCompare(right.organismCode)
      || left.antibioticCode.localeCompare(right.antibioticCode)
      || Number(right.pooled) - Number(left.pooled)
      || left.location.localeCompare(right.location))

  return { studyStart: dayKey(studyStart), studyEnd: dayKey(studyEnd), days: length, series }
}

/** The series a detector should watch, given whatever the caller had. */
export function seriesFrom(context: DetectorContext, options: BuildSeriesOptions = {}): SeriesSet {
  const denominators = context.denominators?.length
    ? [...context.denominators]
    : context.records?.length ? deriveDenominators(context.records) : denominatorsFrom(context)
  return buildDailySeries(denominators, options)
}

/**
 * Sum a daily series into fixed-length periods, most recent period last.
 *
 * Daily counts of one organism–antibiotic pair in one ward are mostly zero, and a
 * control chart on a series of zeros with an occasional one is a chart of nothing. Weekly
 * aggregation is what the surveillance literature runs these methods on, and it is the
 * default here for the same reason. Partial periods at the **start** are dropped rather than
 * kept short: an under-filled first week would read as an unusually quiet baseline and make
 * everything after it look like an excess.
 */
export function aggregatePeriods(values: readonly number[], periodDays: number): number[] {
  const period = Math.max(1, Math.trunc(periodDays))
  const complete = Math.floor(values.length / period)
  const offset = values.length - complete * period
  const out: number[] = []
  for (let index = 0; index < complete; index += 1) {
    let sum = 0
    for (let day = 0; day < period; day += 1) sum += values[offset + index * period + day] ?? 0
    out.push(sum)
  }
  return out
}

/** The last day of each period produced by `aggregatePeriods`, as an offset into the series. */
export function periodEndOffsets(length: number, periodDays: number): number[] {
  const period = Math.max(1, Math.trunc(periodDays))
  const complete = Math.floor(length / period)
  const offset = length - complete * period
  return Array.from({ length: complete }, (_, index) => offset + index * period + period - 1)
}
