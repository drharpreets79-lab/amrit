/**
 * Write the four-city demonstration network into a database file.
 *
 * Run against a copy first. This opens the database directly, without Electron, so it can
 * be pointed at the application's own store or at a throwaway file:
 *
 *     pnpm demo:network -- --database "$HOME/Library/Application Support/AMRIT/data/amrit.sqlite3"
 *     pnpm demo:network -- --database /tmp/demo.sqlite3 --records 500
 *     pnpm demo:network -- --database /tmp/demo.sqlite3 --no-outbreaks
 *
 * `--records` is per site and defaults to ten thousand, so the default run writes forty
 * thousand isolates across four laboratories.
 *
 * ## Outbreaks
 *
 * By default the network carries the three outbreaks in `DEMO_OUTBREAKS`, because a
 * demonstration whose outbreak page is empty teaches an operator that the page does not
 * work. They are seeded through `outbreak-simulation.ts`, which models transmission rather
 * than inflating a count, and the ground truth is written next to the database as
 * `<database>.outbreak-truth.json` so anyone can check what the detector was supposed to
 * find. Nothing on a record marks it as seeded; the truth file is the only key.
 *
 * `--no-outbreaks` produces the plain background, which is what the network was before.
 */

import { writeFileSync } from 'node:fs'

import { AMRITDatabase } from '../src/main/database'
import { DEMO_SITES, DEMO_NETWORK_COUNTRY, seedDemoNetwork } from '../src/main/demo-population'
import { DEMO_OUTBREAKS, simulate } from '../src/main/outbreak-simulation'
import type { IsolateRecord } from '../src/shared/types'

function argument(name: string, fallback = ''): string {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback
}

const databasePath = argument('database')
if (!databasePath) {
  console.error('Pass --database <path to amrit.sqlite3>. Copy the file first if it is a live one.')
  process.exit(2)
}

const records = Number(argument('records', '10000'))
if (!Number.isFinite(records) || records < 1) {
  console.error('--records must be a positive number of isolates per site.')
  process.exit(2)
}
const withOutbreaks = !process.argv.includes('--no-outbreaks')
const endDate = argument('end-date') || new Date().toISOString().slice(0, 10)
const windowDays = Number(argument('window-days', '730'))

process.env.AMRIT_COUNTRY_PROFILE ??= 'IN'

const started = Date.now()
const elapsed = (): string => ((Date.now() - started) / 1000).toFixed(0)
const database = new AMRITDatabase(databasePath, { seedCatalog: true }).initialize()

console.log(`Seeding ${records} isolates per site into ${databasePath}`)
const result = seedDemoNetwork(database, {
  recordsPerSite: records,
  windowDays,
  onProgress: (site, written, failed) => {
    console.log(`  ${site.code} ${site.name}: ${written} written, ${failed} skipped (${elapsed()}s elapsed)`)
  }
})
console.log(`Background: ${result.written} isolates written, ${result.failed} skipped, ${elapsed()}s.`)

if (withOutbreaks) {
  // Only the additive outbreaks are layered onto the background above: the conversion
  // types rewrite records the generator itself produced, and rewriting the demonstration
  // network's own rows after the fact would make the ground truth a claim about data this
  // script did not create. The factorial corpus (`pnpm outbreak:corpus`) carries all five.
  const additive = DEMO_OUTBREAKS.filter((spec) => spec.type !== 'proportion-shift' && spec.type !== 'system-wide-rise')
  const simulated = simulate({
    seed: 20260814,
    windowDays,
    endDate,
    backgroundRate: 'low',
    outbreaks: additive
  })
  const seededNumbers = new Set(simulated.truth.outbreaks.flatMap((outbreak) => outbreak.case_specimen_numbers))
  const cases = simulated.records.filter((record) => seededNumbers.has(String(record.specimen_number)))

  let written = 0
  let failed = 0
  const bySite = new Map<string, IsolateRecord[]>()
  for (const record of cases) {
    const key = String(record.lab_code)
    bySite.set(key, [...(bySite.get(key) ?? []), record])
  }
  for (const [siteCode, siteCases] of bySite) {
    database.selectLab(siteCode)
    for (const record of siteCases) {
      try {
        database.saveRecord(record)
        written += 1
      } catch {
        failed += 1
      }
    }
  }
  const truthPath = `${databasePath}.outbreak-truth.json`
  writeFileSync(truthPath, `${JSON.stringify({
    ...simulated.truth,
    note: 'Outbreak cases layered onto the demonstration network. background_records here counts the '
      + "simulator's own background, which was discarded; the network's background came from seedDemoNetwork.",
    country: DEMO_NETWORK_COUNTRY.code,
    network_sites: DEMO_SITES.map((site) => site.code),
    outbreaks: simulated.truth.outbreaks.map((outbreak) => ({ ...outbreak, seeded_into_database: true }))
  }, null, 2)}\n`)
  console.log(`Outbreaks: ${written} cases written, ${failed} skipped. Ground truth at ${truthPath}`)
  for (const outbreak of simulated.truth.outbreaks) {
    console.log(`  ${outbreak.outbreak_id} ${outbreak.type} ${outbreak.site_code} / ${outbreak.ward}: `
      + `${outbreak.organism_code} [${outbreak.agents.join(', ')}] ${outbreak.observed_cases} cases, `
      + `${outbreak.first_specimen_date} to ${outbreak.last_specimen_date}`)
  }
}

database.close()
console.log(`Done in ${elapsed()}s.`)
