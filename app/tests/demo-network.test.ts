// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { setActiveCountryProfile } from '../src/main/active-profile'
import { AMRITDatabase } from '../src/main/database'
import { DEMO_NETWORK_COUNTRY, DEMO_SITES, seedDemoNetwork } from '../src/main/demo-population'
import { indiaProfile, testlandProfile } from './helpers/profile'

/**
 * The demonstration network is one country's pack, not a neutral fixture.
 *
 * Its four sites are named Indian metros carrying ISO 3166-2 codes to match. Seeding it
 * under another country's profile would file Delhi and Chennai hospitals as that
 * country's — geography that is wrong and that nobody asked for. The server's `seed_demo`
 * command already refuses the equivalent; this pins the desktop doing the same.
 */
describe('demonstration network country guard', () => {
  let directory: string
  let database: AMRITDatabase

  // Catalogue seeding is opt-in. Without it the organism and antibiotic masters are empty
  // and every generated isolate is rejected by validation, so the seeder reports zero
  // written and the guard tests below would pass for the wrong reason.
  const seedPath = resolve(process.cwd(), 'resources/catalog-seed.v2.json')

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'amrit-demo-network-'))
    database = new AMRITDatabase(join(directory, 'demo.sqlite3'), {
      seedCatalog: true,
      catalogSeedPath: seedPath
    }).initialize()
  })

  afterEach(() => {
    database.close()
    setActiveCountryProfile(null)
    rmSync(directory, { recursive: true, force: true })
  })

  it('refuses to seed under another country’s profile, and says which two disagree', () => {
    setActiveCountryProfile(testlandProfile)
    expect(() => seedDemoNetwork(database, { recordsPerSite: 1 }))
      .toThrow(new RegExp(`${DEMO_NETWORK_COUNTRY.code}[\\s\\S]*${testlandProfile.country_code}`))
  })

  it('seeds under the pack’s own profile', () => {
    setActiveCountryProfile(indiaProfile)
    const result = seedDemoNetwork(database, { recordsPerSite: 2 })
    expect(result.sites).toHaveLength(DEMO_SITES.length)
    expect(result.written).toBeGreaterThan(0)
  })

  it('seeds under a foreign profile only when explicitly asked to', () => {
    setActiveCountryProfile(testlandProfile)
    const result = seedDemoNetwork(database, { recordsPerSite: 2, allowForeignProfile: true })
    expect(result.written).toBeGreaterThan(0)
  })

  it('files every site under the pack’s country, never the active profile’s', () => {
    setActiveCountryProfile(testlandProfile)
    seedDemoNetwork(database, { recordsPerSite: 1, allowForeignProfile: true })
    for (const site of DEMO_SITES) {
      const lab = database.getLab(site.code) as Record<string, unknown> | undefined
      expect(lab?.country_code).toBe(DEMO_NETWORK_COUNTRY.code)
    }
  })
})
