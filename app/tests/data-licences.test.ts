// @vitest-environment node

import { describe, expect, it } from 'vitest'

import { clearDataLicenceCache, dataLicences, licenceNotices } from '../src/main/data-licences'
import { SNOMED_LICENCE_NOTICE, getCountryProfile, synthesizeProfile } from '../src/main/country-profile'

/**
 * Phase 10 gate: the terms are recorded and reachable from the running application, not
 * only from a file in the repository. A licence obligation nobody can find has not been
 * communicated.
 */
describe('bundled data licences', () => {
  it('ships the manifest with the application', () => {
    clearDataLicenceCache()
    expect(dataLicences().length).toBeGreaterThan(0)
  })

  it('states a source and terms for every dataset', () => {
    for (const entry of dataLicences()) {
      expect(entry.id, 'id').toBeTruthy()
      expect(entry.name, `${entry.id} name`).toBeTruthy()
      expect(entry.source, `${entry.id} source`).toBeTruthy()
      expect(entry.licence, `${entry.id} licence`).toBeTruthy()
      expect(typeof entry.bundled).toBe('boolean')
    }
  })

  it('records SNOMED CT as requiring a licence', () => {
    // It ships enabled, so the obligation is stated rather than assumed away.
    const snomed = dataLicences().find((entry) => entry.id === 'snomed-ct')
    expect(snomed?.bundled).toBe(true)
    expect(snomed?.warn).toBe(true)
    expect(snomed?.licence.toLowerCase()).toContain('licence')
    expect(snomed?.url).toContain('snomed.org')
  })

  /**
   * The distinction that decides what may ship: CLSI's M100 is a paid standard and is only
   * ever linked to, while EUCAST publishes free of charge and permits redistribution, so its
   * table is in the installer. Getting these two the wrong way round is a licensing breach,
   * not a bug, which is why it is asserted rather than left to review.
   */
  it('bundles the freely redistributable breakpoints and never the paid standard', () => {
    const byId = new Map(dataLicences().map((entry) => [entry.id, entry]))
    expect(byId.get('clsi-breakpoints')?.bundled).toBe(false)
    expect(byId.get('clsi-breakpoints')?.licence.toLowerCase()).toContain('paid')
    expect(byId.get('eucast-breakpoints')?.bundled).toBe(true)
    expect(byId.get('eucast-breakpoints')?.licence.toLowerCase()).toContain('free')
    expect(byId.get('eucast-breakpoints')?.attribution_required).toBe(true)
  })

  it('records the ICD-10 starter value set as bundled and attributable', () => {
    const icd = dataLicences().find((entry) => entry.id === 'icd-10-diagnosis')
    expect(icd?.bundled).toBe(true)
    expect(icd?.attribution_required).toBe(true)
    expect(icd?.url).toContain('icd.who.int')
  })

  it('surfaces only the entries that require action as notices', () => {
    const notices = licenceNotices()
    expect(notices.length).toBeGreaterThan(0)
    expect(notices.every((entry) => entry.warn)).toBe(true)
  })

  it('ships SNOMED enabled with the notice on every profile', () => {
    for (const profileId of ['IN', 'TESTLAND']) {
      const snomed = getCountryProfile(profileId).code_systems?.snomed
      expect(snomed?.enabled).toBe(true)
      expect(snomed?.licence).toBe(SNOMED_LICENCE_NOTICE)
    }
    expect(synthesizeProfile('NGA').code_systems?.snomed?.enabled).toBe(true)
  })
})
