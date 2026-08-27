// @vitest-environment node

import { describe, expect, it } from 'vitest'

import { withCountryProfile } from '../src/main/active-profile'
import { epiWeek, localDate, reportingYear, resolveTimeZone } from '../src/main/epi-time'
import { indiaProfile, testlandProfile } from './helpers/profile'

/**
 * Phase 9 gate: these functions decide which bucket a surveillance count lands in, so a
 * disagreement of one week or one day is a wrong published figure, not a display quirk.
 */
describe('epidemiological time', () => {
  describe('ISO-8601 weeks', () => {
    it('places 4 January in week 1 whatever weekday it falls on', () => {
      for (const year of [2021, 2022, 2023, 2024, 2025, 2026]) {
        expect(epiWeek(`${year}-01-04`, 'iso').week).toBe(1)
      }
    })

    it('runs Monday to Sunday', () => {
      const week = epiWeek('2026-03-04', 'iso') // a Wednesday
      expect(week.start).toBe('2026-03-02')
      expect(week.end).toBe('2026-03-08')
      expect(new Date(`${week.start}T00:00:00Z`).getUTCDay()).toBe(1)
    })

    it('assigns the last days of a year to the next ISO year when the week belongs there', () => {
      // 2019-12-30 is a Monday and falls in ISO week 1 of 2020.
      const week = epiWeek('2019-12-30', 'iso')
      expect(week.year).toBe(2020)
      expect(week.week).toBe(1)
    })

    it('reports a 53-week year where one exists', () => {
      expect(epiWeek('2020-12-31', 'iso')).toMatchObject({ year: 2020, week: 53 })
    })
  })

  describe('MMWR weeks', () => {
    it('runs Sunday to Saturday', () => {
      const week = epiWeek('2026-03-04', 'mmwr')
      expect(week.start).toBe('2026-03-01')
      expect(week.end).toBe('2026-03-07')
      expect(new Date(`${week.start}T00:00:00Z`).getUTCDay()).toBe(0)
    })

    it('starts week 1 on the published date for known years', () => {
      // Published MMWR calendars: week 1 of 2026 begins 2026-01-04.
      expect(epiWeek('2026-01-04', 'mmwr')).toMatchObject({ year: 2026, week: 1 })
      // Week 1 of 2021 begins 2021-01-03.
      expect(epiWeek('2021-01-03', 'mmwr')).toMatchObject({ year: 2021, week: 1 })
    })
  })

  describe('the two systems disagree, which is the whole point', () => {
    it('buckets the same date into different weeks', () => {
      // A Sunday: ISO keeps it in the outgoing Monday-start week, MMWR starts a new one.
      // The week *numbers* can still coincide, so the bucket boundary is what matters.
      const isoWeek = epiWeek('2026-03-01', 'iso')
      const mmwr = epiWeek('2026-03-01', 'mmwr')
      expect(isoWeek.start).not.toBe(mmwr.start)
      expect(isoWeek.end).not.toBe(mmwr.end)
    })

    it('assigns some dates to a different week number, not merely a different start', () => {
      // Rather than assert a hand-picked date, scan a few years and require that the two
      // systems genuinely disagree on (year, week) somewhere. A count filed under one and
      // read under the other lands in the wrong bucket on every such date.
      const disagreements: string[] = []
      for (let day = Date.UTC(2019, 0, 1); day <= Date.UTC(2026, 11, 31); day += 86_400_000) {
        const date = new Date(day).toISOString().slice(0, 10)
        const a = epiWeek(date, 'iso')
        const b = epiWeek(date, 'mmwr')
        if (a.year !== b.year || a.week !== b.week) disagreements.push(date)
      }
      expect(disagreements.length).toBeGreaterThan(0)
      // Every disagreement must be a real one, so spot-check the first.
      const sample = disagreements[0] as string
      expect(epiWeek(sample, 'iso').start).not.toBe(epiWeek(sample, 'mmwr').start)
    })

    it('is taken from the profile rather than assumed', () => {
      const underIndia = withCountryProfile(indiaProfile, () => epiWeek('2026-03-01'))
      const underTestland = withCountryProfile(testlandProfile, () => epiWeek('2026-03-01'))
      expect(underIndia.system).toBe('iso')
      expect(underTestland.system).toBe('mmwr')
      expect(underIndia.start).not.toBe(underTestland.start)
    })
  })

  describe('reporting years', () => {
    it('treats a January start as the calendar year', () => {
      expect(reportingYear('2026-03-04', 1)).toMatchObject({ year: 2026, start: '2026-01-01', end: '2026-12-31', label: '2026' })
    })

    it('runs April to March for India', () => {
      expect(reportingYear('2026-03-31', 4)).toMatchObject({ year: 2025, start: '2025-04-01', end: '2026-03-31', label: '2025-26' })
      expect(reportingYear('2026-04-01', 4)).toMatchObject({ year: 2026, start: '2026-04-01', end: '2027-03-31', label: '2026-27' })
    })

    it('runs October to September for a United States federal year', () => {
      expect(reportingYear('2026-09-30', 10)).toMatchObject({ year: 2025, label: '2025-26' })
      expect(reportingYear('2026-10-01', 10)).toMatchObject({ year: 2026, label: '2026-27' })
    })

    it('comes from the profile when not given', () => {
      expect(withCountryProfile(indiaProfile, () => reportingYear('2026-03-31')).label).toBe('2025-26')
      expect(withCountryProfile(testlandProfile, () => reportingYear('2026-09-30')).label).toBe('2025-26')
    })
  })

  describe('local calendar date', () => {
    it('keeps a late-evening observation on its own local day', () => {
      // 23:30 in Kolkata is 18:00 UTC the same day; bucketing on UTC would be right here…
      expect(localDate('2026-03-04T18:00:00Z', 'Asia/Kolkata')).toBe('2026-03-04')
      // …but 23:30 local is the next UTC day, and the observation still belongs to the 4th.
      expect(localDate('2026-03-04T18:30:00Z', 'Asia/Kolkata')).toBe('2026-03-05')
      expect(localDate('2026-03-04T23:30:00+05:30', 'Asia/Kolkata')).toBe('2026-03-04')
    })

    it('differs by a day across zones for the same instant', () => {
      const instant = '2026-03-05T02:00:00Z'
      expect(localDate(instant, 'Pacific/Auckland')).toBe('2026-03-05')
      expect(localDate(instant, 'America/Los_Angeles')).toBe('2026-03-04')
    })

    it('falls back to UTC for an unknown zone rather than losing the observation', () => {
      expect(localDate('2026-03-04T18:30:00Z', 'Not/AZone')).toBe('2026-03-04')
      expect(localDate('2026-03-04T18:30:00Z', null)).toBe('2026-03-04')
    })
  })

  describe('time zone resolution', () => {
    it("prefers the site's own zone", () => {
      withCountryProfile(indiaProfile, () => {
        expect(resolveTimeZone('Asia/Kolkata')).toBe('Asia/Kolkata')
        expect(resolveTimeZone('America/New_York')).toBe('America/New_York')
      })
    })

    it('falls back to the country default when the site has none', () => {
      withCountryProfile(indiaProfile, () => expect(resolveTimeZone('')).toBe('Asia/Kolkata'))
    })

    it('returns null for a country spanning several zones rather than guessing', () => {
      const multiZone = { ...indiaProfile, timezone: null, timezone_ambiguous: true }
      withCountryProfile(multiZone, () => expect(resolveTimeZone(null)).toBeNull())
    })
  })

  it('rejects a value that is not a date rather than bucketing it somewhere', () => {
    expect(() => epiWeek('not a date')).toThrow(/Not an ISO date/)
    expect(() => localDate('not an instant', 'UTC')).toThrow(/Not a valid instant/)
  })
})
