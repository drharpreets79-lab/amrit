// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { AMRITDatabase } from '../src/main/database'
import { animuseProduct, glassProduct, infarmProduct } from '../src/main/one-health-exporters'
import {
  PBKDF2_ITERATIONS,
  OneHealthSession,
  allows,
  auditHash,
  canonicalAuditJson,
  hashPassword,
  verifyPassword
} from '../src/main/one-health-governance'
import type { Row } from '../src/shared/types'

// These exercise India's own geography and exporter output, so they pin the profile
// rather than inheriting whatever AMRIT_COUNTRY_PROFILE the run sets. Without this they
// fail under the TESTLAND matrix for the right reason — no India geo pack is loaded —
// which is a property of the test, not a defect in the code.
const previousProfile = process.env.AMRIT_COUNTRY_PROFILE
beforeAll(() => { process.env.AMRIT_COUNTRY_PROFILE = 'IN' })
afterAll(() => {
  if (previousProfile === undefined) delete process.env.AMRIT_COUNTRY_PROFILE
  else process.env.AMRIT_COUNTRY_PROFILE = previousProfile
})

describe('One Health governance primitives', () => {
  it('matches the Python PBKDF2 format and never embeds plaintext', () => {
    const password = 'correct horse battery staple'
    const encoded = hashPassword(password, Buffer.from('00112233445566778899aabbccddeeff', 'hex'))
    expect(encoded).toBe(`pbkdf2_sha256$${PBKDF2_ITERATIONS}$00112233445566778899aabbccddeeff$a11da2f8b3b7c227534f953328fed51ea9f9857d26b283160bbd5f580b0623d3`)
    expect(encoded).not.toContain(password)
    expect(verifyPassword(password, encoded)).toBe(true)
    expect(verifyPassword('wrong', encoded)).toBe(false)
    expect(verifyPassword(password, 'malformed')).toBe(false)
  })

  it('matches Python canonical audit hashing including ensure_ascii', () => {
    const entry = {
      occurred_at: '2026-01-01T00:00:00+00:00', actor: 'Å-admin', action: 'event.create',
      object_type: 'food', object_id: 'evt-1', details: { roles: ['administrator'], quality_status: 'validated' }
    }
    expect(canonicalAuditJson(entry)).toContain('"actor":"\\u00c5-admin"')
    expect(auditHash('previous', entry)).toBe('60bd66579c9a078dbc16be140217a37340b279dbec08c6fbbe017cc1900d25df')
  })

  it('applies the role matrix and keeps sessions in memory', () => {
    expect(allows(['data-entry'], 'event:create')).toBe(true)
    expect(allows(['data-entry'], 'event:create:regulatory')).toBe(false)
    expect(allows(['steward'], 'action:manage')).toBe(true)
    expect(allows(['auditor'], 'audit:read')).toBe(true)
    const session = new OneHealthSession()
    session.establish({ id: 'u1', username: 'steward', roles: ['steward'] })
    expect(session.current()).toMatchObject({ username: 'steward', roles: ['steward'] })
    session.clear()
    expect(() => session.current()).toThrow(/authentication is required/i)
  })
})

describe('One Health governed repository workflow', () => {
  let directory: string
  let database: AMRITDatabase

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'amrit-one-health-'))
    database = new AMRITDatabase(join(directory, 'governance.sqlite')).initialize()
    database.saveLab({ code: 'LAB-1', name: 'Governed laboratory' })
    database.selectLab('LAB-1')
  })

  afterEach(() => {
    database.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('bootstraps one administrator, authenticates safely and creates role identities', () => {
    const admin = database.bootstrapOneHealthAdmin('national-admin', 'a sufficiently long password')
    expect(admin.roles).toEqual(['administrator'])
    expect(() => database.bootstrapOneHealthAdmin('second-admin', 'another sufficiently long password')).toThrow(/already/i)
    const stored = database.rawConnectionForTesting().prepare('SELECT password_hash FROM national_users WHERE username=?')
      .get('national-admin') as { password_hash: string }
    expect(stored.password_hash).toMatch(/^pbkdf2_sha256\$310000\$/)
    expect(stored.password_hash).not.toContain('sufficiently long')
    expect(database.authenticateOneHealth('national-admin', 'wrong')).toBeNull()
    expect(database.authenticateOneHealth('NATIONAL-ADMIN', 'a sufficiently long password')).toMatchObject({ username: 'national-admin' })
    database.createOneHealthUser({ username: 'reviewer-1', password: 'reviewer password long', roles: ['reviewer'] }, admin)
    expect(database.listOneHealthUsers(admin).map((row) => row.username)).toEqual(['national-admin', 'reviewer-1'])
  })

  it('binds the authenticated actor and reserves direct-care and regulatory capture for stewards', () => {
    const admin = database.bootstrapOneHealthAdmin('admin', 'administrator password')
    database.createOneHealthUser({ username: 'entry', password: 'data entry password', roles: ['data-entry'] }, admin)
    database.createOneHealthUser({ username: 'steward', password: 'steward role password', roles: ['steward'] }, admin)
    const entry = database.authenticateOneHealth('entry', 'data entry password')!
    const steward = database.authenticateOneHealth('steward', 'steward role password')!
    const quality = database.captureOneHealth('human_quality', {
      facility_id: 'LAB-1', observed_at: '2026-08-01', indicator: 'qc', numerator: 1, denominator: 10,
      quality_status: 'draft', actor: 'renderer-spoof'
    }, entry)
    expect(quality.actor).toBe('entry')
    expect(JSON.stringify(quality.payload)).not.toContain('renderer-spoof')
    expect(() => database.captureOneHealth('stewardship', {
      facility_id: 'LAB-1', observed_at: '2026-08-01', encounter_ref: 'E-1', antimicrobial: 'Amikacin',
      aware_group: 'Access', indication: 'Test', therapy: 'empirical', quality_status: 'draft'
    }, entry)).toThrow(/direct-care/i)
    expect(() => database.captureOneHealth('environment', {
      facility_id: 'LAB-1', observed_at: '2026-08-01', site_ref: 'S-1', site_type: 'effluent', matrix: 'effluent',
      geospatial_precision: 'admin-unit-only', protocol: 'P-1', method: 'LC-MS', quality_status: 'draft'
    }, entry)).toThrow(/regulatory/i)
    const environment = database.captureOneHealth('environment', {
      facility_id: 'LAB-1', observed_at: '2026-08-01', site_ref: 'S-1', site_type: 'effluent', matrix: 'effluent',
      geospatial_precision: 'admin-unit-only', protocol: 'P-1', method: 'LC-MS', concentration: 2,
      detection_limit: 1, quality_status: 'validated'
    }, steward)
    expect(environment.actor).toBe('steward')
    expect(environment.quality_status).toBe('validated')
  })

  it('records alert review, action closure evidence and detects audit tampering', () => {
    const admin = database.bootstrapOneHealthAdmin('admin', 'administrator password')
    database.createOneHealthUser({ username: 'steward', password: 'steward role password', roles: ['steward'] }, admin)
    database.createOneHealthUser({ username: 'reviewer', password: 'reviewer role password', roles: ['reviewer'] }, admin)
    const steward = database.authenticateOneHealth('steward', 'steward role password')!
    const reviewer = database.authenticateOneHealth('reviewer', 'reviewer role password')!
    const event = database.captureOneHealth('environment', {
      facility_id: 'LAB-1', observed_at: '2026-08-01', site_ref: 'S-1', site_type: 'effluent', matrix: 'effluent',
      geospatial_precision: 'admin-unit-only', protocol: 'P-1', method: 'LC-MS', concentration: 2,
      detection_limit: 1, quality_status: 'validated'
    }, steward)
    const alert = database.listOneHealthAlerts('environment')[0]!
    const reviewed = database.reviewOneHealthAlert(String(alert.id), { status: 'escalated', note: 'Create corrective action.' }, reviewer)
    expect(reviewed).toMatchObject({ status: 'escalated', reviewed_by: 'reviewer' })
    const action = database.createOneHealthAction({ event_id: String(event.id), title: 'Inspect effluent process', priority: 'high' }, steward)
    expect(() => database.updateOneHealthAction(String(action.id), { status: 'closed' }, steward)).toThrow(/closure evidence/i)
    const closed = database.updateOneHealthAction(String(action.id), { status: 'closed', evidence: 'Corrective maintenance certificate CM-22.' }, steward)
    expect(closed.status).toBe('closed')
    expect(JSON.stringify(closed.evidence)).toContain('CM-22')
    expect(database.verifyOneHealthAuditChain(admin)).toMatchObject({ valid: true })
    database.rawConnectionForTesting().prepare("UPDATE national_audit_log SET details_json='{}' WHERE id=2").run()
    expect(database.verifyOneHealthAuditChain(admin)).toMatchObject({ valid: false, broken_at: 2 })
  })

  it('keeps the UI recent list bounded while reports and aggregates include every event', () => {
    database.bootstrapOneHealthAdmin('admin', 'administrator password')
    const statement = database.rawConnectionForTesting().prepare(`INSERT INTO national_events(
      id,schema_version,module_key,event_type,purpose,facility_id,observed_at,recorded_at,actor,payload_json,quality_status,sensitivity
    ) VALUES (?, '1.0', 'human_quality', 'human-lab-quality', 'surveillance', 'LAB-1', ?, ?, 'admin', ?, 'validated', 'restricted')`)
    for (let index = 0; index < 1_005; index += 1) {
      statement.run(`event-${index}`, `2026-08-${String(index % 28 + 1).padStart(2, '0')}`, '2026-08-01T00:00:00Z',
        JSON.stringify({ facility_id: 'LAB-1', observed_at: '2026-08-01', indicator: `indicator-${index}`, numerator: 1, denominator: 1 }))
    }
    expect(database.listOneHealth('human_quality')).toHaveLength(1_000)
    expect(database.listOneHealthForExport('human_quality')).toHaveLength(1_005)
    expect(database.oneHealthMetrics('human_quality').total).toBe(1_005)
    expect(database.oneHealthAggregate('human_quality').record_count).toBe(1_005)
  })
})

describe('named One Health reporting projections', () => {
  const animal: Row = {
    id: 'a1', facility_id: 'VET-1', observed_at: '2026-08-01', quality_status: 'validated',
    payload: { host_species: 'Poultry', production_class: 'Broiler', sample_type: 'Cloacal swab', organism: 'E. coli', ast_summary: 'CIP:R', active_ingredient: 'ciprofloxacin', quantity_mg: 500, biomass_kg: 100, route: 'oral', purpose: 'treatment', sampling_frame: 'farm' }
  }
  const food: Row = {
    id: 'f1', facility_id: 'FOOD-1', observed_at: '2026-08-02', quality_status: 'validated',
    payload: { commodity: 'Chicken', sample_id: 'S-1', organism: 'Salmonella', ast_summary: 'AMP:R', sampling_programme: 'National' }
  }

  it('names and shapes WHO GLASS, WOAH ANIMUSE and FAO InFARM JSON', () => {
    expect(glassProduct([animal])).toMatchObject({ profile: 'WHO-GLASS-compatible/1.0', records: [{ laboratory: 'VET-1', organism: 'E. coli' }] })
    expect(animuseProduct([animal])).toMatchObject({ profile: 'WOAH-ANIMUSE-aligned/1.0', records: [{ country: 'IND', species: 'Poultry', quantity_mg: 500 }] })
    expect(infarmProduct([animal], [food])).toMatchObject({ profile: 'FAO-InFARM-compatible/1.0', records: [{ sector: 'animal' }, { sector: 'food' }] })
  })
})
