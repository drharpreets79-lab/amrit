/**
 * Locale-correct display of dates, numbers and sort order.
 *
 * Until now these went through the host's `toLocaleString` defaults, which means the
 * operating system's locale decided how a surveillance figure was written — not the country
 * this deployment serves. Everything here is driven by the profile instead.
 *
 * Storage is unaffected: values stay ISO-8601 Gregorian UTC on the wire and in the database.
 * A Bikram Sambat or Jalali date is a rendering of the same instant, never a stored value.
 */
import type { CountryProfile } from '../../shared/types'

export interface Formatters {
  /** The BCP 47 tag actually used, including the calendar and numbering extensions. */
  locale: string
  date(value: string | number | Date | null | undefined): string
  dateTime(value: string | number | Date | null | undefined): string
  number(value: number | null | undefined, options?: Intl.NumberFormatOptions): string
  percent(value: number | null | undefined, fractionDigits?: number): string
  /** For sorting names the user typed. Byte order is wrong in every non-ASCII script. */
  compare(left: string, right: string): number
}

/**
 * Build the BCP 47 tag with the profile's calendar and numbering system attached.
 *
 * These are Unicode extensions rather than separate options so one tag carries the whole
 * intent, and so an unsupported combination degrades to the locale's own default instead of
 * throwing in the middle of a render.
 */
export function localeTag(profile: Pick<CountryProfile, 'locale' | 'calendar' | 'numbering_system'>): string {
  const base = profile.locale || 'en'
  const extensions: string[] = []
  if (profile.calendar && profile.calendar !== 'gregory') extensions.push(`ca-${profile.calendar}`)
  if (profile.numbering_system && profile.numbering_system !== 'latn') extensions.push(`nu-${profile.numbering_system}`)
  return extensions.length ? `${base}-u-${extensions.join('-')}` : base
}

const toDate = (value: string | number | Date | null | undefined): Date | null => {
  if (value === null || value === undefined || value === '') return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function createFormatters(profile: CountryProfile): Formatters {
  const locale = localeTag(profile)
  // A country spanning several zones leaves this null; the host zone is then the honest
  // default, and Phase 9 resolves it per site.
  const timeZone = profile.timezone ?? undefined
  const safe = <T>(build: () => T, fallback: () => T): T => {
    try {
      return build()
    } catch {
      // An ICU build without this calendar or numbering system must not break a screen.
      return fallback()
    }
  }

  const dateFormat = safe(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone }),
    () => new Intl.DateTimeFormat('en', { dateStyle: 'medium' })
  )
  const dateTimeFormat = safe(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone }),
    () => new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' })
  )
  const numberFormat = safe(() => new Intl.NumberFormat(locale), () => new Intl.NumberFormat('en'))
  const collator = safe(
    () => new Intl.Collator(profile.locale || 'en', { sensitivity: 'base', numeric: true }),
    () => new Intl.Collator('en', { sensitivity: 'base', numeric: true })
  )

  return {
    locale,
    date: (value) => { const date = toDate(value); return date ? dateFormat.format(date) : '' },
    dateTime: (value) => { const date = toDate(value); return date ? dateTimeFormat.format(date) : '' },
    number: (value, options) => {
      if (value === null || value === undefined || Number.isNaN(value)) return ''
      return options
        ? safe(() => new Intl.NumberFormat(locale, options).format(value), () => String(value))
        : numberFormat.format(value)
    },
    percent: (value, fractionDigits = 1) => {
      if (value === null || value === undefined || Number.isNaN(value)) return ''
      return safe(
        () => new Intl.NumberFormat(locale, {
          minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits
        }).format(value),
        () => value.toFixed(fractionDigits)
      )
    },
    compare: (left, right) => collator.compare(left, right)
  }
}
