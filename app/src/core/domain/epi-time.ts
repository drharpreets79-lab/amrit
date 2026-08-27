import { activeProfile } from './active-profile'

/**
 * Epidemiological weeks and reporting years.
 *
 * Surveillance is reported by week, and "week 5" is not one thing. ISO-8601 weeks start on
 * Monday and week 1 is the one containing the first Thursday; MMWR weeks (US CDC and much
 * of the Americas) start on Sunday and week 1 is the one containing at least four days of
 * the new year. The two disagree by up to a week, and around a year boundary they can
 * disagree about the year as well — so a count filed under one system and read under the
 * other lands in the wrong bucket, silently.
 *
 * Reporting years differ too: India runs April to March, the United States October to
 * September, most countries the calendar year.
 *
 * Everything here works on the calendar date as given. Callers convert an instant to the
 * site's own zone first, because a specimen taken at 23:30 belongs to that day locally, not
 * to whatever day it was in UTC.
 *
 * Mirrors server/amrit_central_server/central/epi_time.py; both must agree exactly.
 */

export type EpiWeekSystem = 'iso' | 'mmwr'

export interface EpiWeek {
  year: number
  week: number
  start: string
  end: string
  system: EpiWeekSystem
}

const MS_PER_DAY = 86_400_000

const asUtcDate = (value: string | Date): Date => {
  if (value instanceof Date) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()))
  }
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!match) throw new Error(`Not an ISO date: ${String(value)}`)
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
}

const iso = (date: Date): string => date.toISOString().slice(0, 10)
const addDays = (date: Date, days: number): Date => new Date(date.getTime() + days * MS_PER_DAY)

/** Start of the week containing `date`, given the weekday the system starts on. */
function weekStart(date: Date, startDay: 0 | 1): Date {
  const offset = (date.getUTCDay() - startDay + 7) % 7
  return addDays(date, -offset)
}

/**
 * ISO-8601: weeks start Monday; week 1 contains the first Thursday of the year, which is
 * the same as saying it contains 4 January.
 */
function isoWeek(date: Date): EpiWeek {
  const start = weekStart(date, 1)
  const thursday = addDays(start, 3)
  const year = thursday.getUTCFullYear()
  const firstThursday = (() => {
    const jan4 = new Date(Date.UTC(year, 0, 4))
    return addDays(weekStart(jan4, 1), 3)
  })()
  const week = Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * MS_PER_DAY)) + 1
  return { year, week, start: iso(start), end: iso(addDays(start, 6)), system: 'iso' }
}

/**
 * MMWR: weeks start Sunday; week 1 is the first week of the year with at least four days
 * in it, which is the week containing 4 January once Sunday-start is applied.
 */
function mmwrWeek(date: Date): EpiWeek {
  const start = weekStart(date, 0)
  const wednesday = addDays(start, 3)
  const year = wednesday.getUTCFullYear()
  const firstStart = (() => {
    const jan4 = new Date(Date.UTC(year, 0, 4))
    return weekStart(jan4, 0)
  })()
  const week = Math.round((start.getTime() - firstStart.getTime()) / (7 * MS_PER_DAY)) + 1
  return { year, week, start: iso(start), end: iso(addDays(start, 6)), system: 'mmwr' }
}

export function epiWeek(
  value: string | Date,
  system: EpiWeekSystem = activeProfile().epi_week_system ?? 'iso'
): EpiWeek {
  const date = asUtcDate(value)
  return system === 'mmwr' ? mmwrWeek(date) : isoWeek(date)
}

/**
 * The reporting year a date falls in, given the month the year starts.
 *
 * Labelled by the year it starts in, which is how India refers to 2026-27 and how the US
 * federal year is named. A start month of 1 is the calendar year.
 */
export function reportingYear(
  value: string | Date,
  startMonth: number = activeProfile().fiscal_year_start_month ?? 1
): { year: number; start: string; end: string; label: string } {
  const month = Math.min(12, Math.max(1, Math.trunc(startMonth)))
  const date = asUtcDate(value)
  const year = date.getUTCMonth() + 1 >= month ? date.getUTCFullYear() : date.getUTCFullYear() - 1
  const start = new Date(Date.UTC(year, month - 1, 1))
  const end = addDays(new Date(Date.UTC(year + 1, month - 1, 1)), -1)
  return {
    year,
    start: iso(start),
    end: iso(end),
    // A year that spans two calendar years is written 2026-27, so a reader cannot mistake
    // it for the calendar year.
    label: month === 1 ? String(year) : `${year}-${String((year + 1) % 100).padStart(2, '0')}`
  }
}

/**
 * The calendar date an instant falls on in a given zone.
 *
 * A specimen recorded at 23:30 belongs to that local day. Bucketing on the UTC date moves
 * it to the next day for every site east of Greenwich and the previous day for some west
 * of it — a systematic error at every day, week and year boundary.
 */
export function localDate(instant: string | Date, timeZone?: string | null): string {
  const date = instant instanceof Date ? instant : new Date(instant)
  if (Number.isNaN(date.getTime())) throw new Error(`Not a valid instant: ${String(instant)}`)
  if (!timeZone) return date.toISOString().slice(0, 10)
  try {
    // en-CA formats as YYYY-MM-DD, which is the shape the rest of the system stores.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(date)
  } catch {
    // An unknown zone must not lose the observation; fall back to UTC.
    return date.toISOString().slice(0, 10)
  }
}

/** The zone to bucket a site's observations in: the site's own, else the country default. */
export function resolveTimeZone(siteTimeZone?: string | null): string | null {
  const profile = activeProfile()
  const site = String(siteTimeZone ?? '').trim()
  if (site) return site
  // A country spanning several zones has no honest default, so this stays null rather than
  // guessing one and mis-stamping every day boundary.
  return profile.timezone ?? null
}
