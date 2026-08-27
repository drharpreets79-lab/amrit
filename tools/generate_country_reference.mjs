#!/usr/bin/env node
/**
 * Generate shared/country-profiles/reference/countries.json.
 *
 * Two inputs, both already in this repository — nothing is fetched:
 *   1. ISO 3166-1 alpha-3/alpha-2/name/WHO region, from the `country` code set
 *      already bundled in app/resources/catalog-seed.v1.json (252 entries).
 *   2. Locale defaults (locale, timezone, first day of week, numbering system,
 *      text direction, date field order) derived from Node's built-in ICU/CLDR.
 *
 * The result is checked in so both runtimes read identical values and neither
 * needs ICU at runtime — Python has no CLDR of its own.
 *
 * Usage:
 *   node tools/generate_country_reference.mjs
 *   node tools/generate_country_reference.mjs --check
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SEED_PATH = resolve(REPOSITORY_ROOT, 'app/resources/catalog-seed.v1.json')
const OUTPUT_PATH = resolve(REPOSITORY_ROOT, 'shared/country-profiles/reference/countries.json')

/** Fallbacks used when ICU has no data for a region (e.g. Antarctica). */
const FALLBACK = Object.freeze({
  locale: 'en',
  timezone: 'UTC',
  first_day_of_week: 1,
  numbering_system: 'latn',
  text_direction: 'ltr',
  date_input_order: 'DMY'
})

/**
 * ICU still reports several IANA zones under their pre-rename "backward" names, and
 * which name it reports depends on the ICU build. Normalising here keeps this
 * checked-in artifact stable across Node versions and gives downstream code the
 * canonical IANA identifier that Python's zoneinfo expects.
 */
const CANONICAL_TIME_ZONE = Object.freeze({
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Dacca': 'Asia/Dhaka',
  'Asia/Thimbu': 'Asia/Thimphu',
  'Asia/Chungking': 'Asia/Chongqing',
  'Asia/Macao': 'Asia/Macau',
  'Asia/Ulan_Bator': 'Asia/Ulaanbaatar',
  'Europe/Kiev': 'Europe/Kyiv',
  'Europe/Uzhgorod': 'Europe/Kyiv',
  'Europe/Zaporozhye': 'Europe/Kyiv',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'America/Catamarca': 'America/Argentina/Catamarca',
  'America/Cordoba': 'America/Argentina/Cordoba',
  'America/Jujuy': 'America/Argentina/Jujuy',
  'America/Mendoza': 'America/Argentina/Mendoza',
  'America/Godthab': 'America/Nuuk',
  'Africa/Asmera': 'Africa/Asmara',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Pacific/Truk': 'Pacific/Chuuk'
})

function canonicalZone(zone) {
  return CANONICAL_TIME_ZONE[zone] || zone
}

/**
 * The WHONET country code set is not purely ISO 3166-1. It also carries two
 * organisations, and Kosovo under the user-assigned XK/XKX code that ISO has not
 * allocated but that real deployments need. Classify explicitly so the registry can
 * offer countries for selection without offering "World Health Organization" as one.
 */
const NOT_A_COUNTRY = new Set(['WHO', 'FAO'])
const NON_ISO_COUNTRY = new Set(['XKX'])

function iso3166Countries() {
  const seed = JSON.parse(readFileSync(SEED_PATH, 'utf8'))
  const rows = seed.catalogue.codeValues.filter((row) => row.code_set === 'country')
  return rows
    .map((row) => {
      const metadata = JSON.parse(row.metadata_json || '{}')
      const alpha3 = String(row.code)
      return {
        alpha3,
        alpha2: String(metadata.iso2 || ''),
        name: String(row.display_label || row.description || row.code),
        who_region: metadata.who_region ? String(metadata.who_region) : null,
        entry_type: NOT_A_COUNTRY.has(alpha3) ? 'organization' : 'country',
        iso3166_1: !NOT_A_COUNTRY.has(alpha3) && !NON_ISO_COUNTRY.has(alpha3)
      }
    })
    .filter((country) => country.alpha2.length === 2)
    .sort((a, b) => a.alpha3.localeCompare(b.alpha3))
}

/** Most-likely locale for a region, e.g. "IN" -> "hi-Deva-IN" -> "hi-IN". */
function likelyLocale(alpha2) {
  try {
    const maximized = new Intl.Locale(`und-${alpha2}`).maximize()
    return `${maximized.language}-${maximized.region}`
  } catch {
    return FALLBACK.locale
  }
}

function weekStart(alpha2) {
  try {
    const locale = new Intl.Locale(`und-${alpha2}`)
    // Node exposes this as a method on current versions and as a getter on older ones.
    const info = typeof locale.getWeekInfo === 'function' ? locale.getWeekInfo() : locale.weekInfo
    return info && Number.isInteger(info.firstDay) ? info.firstDay : FALLBACK.first_day_of_week
  } catch {
    return FALLBACK.first_day_of_week
  }
}

/** Every IANA zone the country uses, canonicalised and sorted. */
function timeZones(alpha2) {
  try {
    const locale = new Intl.Locale(`und-${alpha2}`)
    const zones = typeof locale.getTimeZones === 'function' ? locale.getTimeZones() : locale.timeZones
    if (!Array.isArray(zones) || zones.length === 0) return []
    return [...new Set(zones.map(canonicalZone))].sort()
  } catch {
    return []
  }
}

function textDirection(locale) {
  try {
    const parsed = new Intl.Locale(locale)
    const info = typeof parsed.getTextInfo === 'function' ? parsed.getTextInfo() : parsed.textInfo
    return info && info.direction === 'rtl' ? 'rtl' : FALLBACK.text_direction
  } catch {
    return FALLBACK.text_direction
  }
}

function numberingSystem(locale) {
  try {
    return new Intl.NumberFormat(locale).resolvedOptions().numberingSystem || FALLBACK.numbering_system
  } catch {
    return FALLBACK.numbering_system
  }
}

/** Order of day/month/year in the locale's numeric date format: DMY | MDY | YMD. */
function dateInputOrder(locale) {
  try {
    const parts = new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric'
    }).formatToParts(new Date(Date.UTC(2026, 2, 4)))
    const order = parts
      .filter((part) => part.type === 'day' || part.type === 'month' || part.type === 'year')
      .map((part) => part.type.charAt(0).toUpperCase())
      .join('')
    return ['DMY', 'MDY', 'YMD'].includes(order) ? order : FALLBACK.date_input_order
  } catch {
    return FALLBACK.date_input_order
  }
}

function build() {
  const countries = iso3166Countries().map((country) => {
    const locale = likelyLocale(country.alpha2)
    const zones = timeZones(country.alpha2)
    return {
      ...country,
      locale,
      // Single-zone countries get a usable default. Multi-zone countries deliberately
      // get none: any pick would be arbitrary (the US zone list starts at America/Adak),
      // and a wrong country-level zone mis-stamps specimen dates at day boundaries.
      // timezone_ambiguous forces an explicit choice at setup and per site.
      timezone: zones.length === 1 ? zones[0] : null,
      timezone_ambiguous: zones.length !== 1,
      timezones: zones,
      first_day_of_week: weekStart(country.alpha2),
      numbering_system: numberingSystem(locale),
      text_direction: textDirection(locale),
      date_input_order: dateInputOrder(locale)
    }
  })

  return {
    schema_version: 1,
    description:
      'ISO 3166-1 country list with CLDR-derived locale defaults. Generated by ' +
      'tools/generate_country_reference.mjs from app/resources/catalog-seed.v1.json ' +
      'and the ICU data built into Node. Do not edit by hand.',
    generated_with: { node: process.version, icu_locale: new Intl.DateTimeFormat().resolvedOptions().locale },
    count: countries.length,
    countries
  }
}

function serialize(payload) {
  return `${JSON.stringify(payload, null, 2)}\n`
}

function main() {
  const check = process.argv.includes('--check')
  const payload = build()
  // The Node version is recorded for provenance but must not cause spurious drift.
  const comparable = (value) => {
    const { generated_with, ...rest } = value
    return serialize(rest)
  }

  if (check) {
    let existing
    try {
      existing = JSON.parse(readFileSync(OUTPUT_PATH, 'utf8'))
    } catch {
      console.error(`missing or unreadable: ${OUTPUT_PATH}\nrun: node tools/generate_country_reference.mjs`)
      process.exit(1)
    }
    if (comparable(existing) !== comparable(payload)) {
      console.error(
        `${OUTPUT_PATH} is out of date\nrun: node tools/generate_country_reference.mjs`
      )
      process.exit(1)
    }
    console.log(`country reference up to date (${payload.count} countries)`)
    return
  }

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true })
  writeFileSync(OUTPUT_PATH, serialize(payload), 'utf8')
  const selectable = payload.countries.filter((c) => c.entry_type === 'country')
  const iso = selectable.filter((c) => c.iso3166_1).length
  const rtl = selectable.filter((c) => c.text_direction === 'rtl').length
  const ambiguous = selectable.filter((c) => c.timezone_ambiguous).length
  const nonLatin = selectable.filter((c) => c.numbering_system !== 'latn').length
  console.log(
    `wrote ${OUTPUT_PATH}\n  ${payload.count} entries · ${selectable.length} selectable ` +
      `(${iso} ISO 3166-1) · ${rtl} RTL · ${nonLatin} non-Latin numbering · ` +
      `${ambiguous} needing an explicit time zone`
  )
}

main()
