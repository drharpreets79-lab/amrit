// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AMRITDatabase } from '../src/main/database'
import { RetentionError, retentionCutoffDate } from '../src/main/retention'
import type { OneHealthIdentity } from '../src/shared/types'

/**
 * Phase 12: `profile.privacy.retention_days` must actually expire row-level data, and must
 * never expire anything a deployment did not ask it to. The dangerous failure here is not
 * "kept too long" — it is a purge that destroys current records, which no backup taken
 * after the fact can undo.
 */
describe('retention purge', () => {
  let directory: string
  let database: AMRITDatabase

  const administrator: OneHealthIdentity = {
    id: 'admin-1',
    username: 'administrator',
    roles: ['administrator']
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'amrit-retention-'))
    database = new AMRITDatabase(join(directory, 'amrit.sqlite3')).initialize()
    // isolates.lab_code is a foreign key, and foreign keys are enforced on every
    // connection — which is what makes the cascade to AST results reliable.
    database.saveLab({ code: 'LAB1', name: 'Retention test laboratory' })
  })

  afterEach(() => {
    try { database.close() } catch { /* already closed */ }
    rmSync(directory, { recursive: true, force: true })
  })

  const connection = () => database.rawConnectionForTesting()

  const insertIsolate = (fields: Record<string, string | null>): number => {
    connection().prepare(
      `INSERT INTO isolates(lab_code, patient_id, specimen_date, created_at, updated_at)
       VALUES (?,?,?,?,?)`
    ).run(
      'LAB1', String(fields.patient_id ?? 'p-1'),
      fields.specimen_date as string | null,
      fields.created_at as string, fields.updated_at as string
    )
    return Number((connection().prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id)
  }

  const isolateIds = (): number[] =>
    (connection().prepare('SELECT id FROM isolates ORDER BY id').all() as Array<{ id: number }>)
      .map((row) => Number(row.id))

  describe('cutoff', () => {
    it('treats an unset period as keep-indefinitely, not delete-everything', () => {
      expect(retentionCutoffDate(null)).toBeNull()
      expect(retentionCutoffDate(undefined)).toBeNull()
    })

    it('refuses a period that is not a whole number of days', () => {
      expect(() => retentionCutoffDate(0)).toThrow(RetentionError)
      expect(() => retentionCutoffDate(-30)).toThrow(RetentionError)
      expect(() => retentionCutoffDate(30.5)).toThrow(RetentionError)
    })

    it('counts back the requested number of days', () => {
      expect(retentionCutoffDate(30, new Date('2026-08-12T00:00:00Z'))).toBe('2026-07-13')
      expect(retentionCutoffDate(365, new Date('2026-08-12T00:00:00Z'))).toBe('2025-08-12')
    })
  })

  it('does nothing at all when the profile sets no retention period', () => {
    insertIsolate({ created_at: '2001-01-01 00:00:00', updated_at: '2001-01-01 00:00:00', specimen_date: '2001-01-01' })
    const result = database.purgeExpiredData(administrator, { dryRun: false, retentionDays: null })
    expect(result).toMatchObject({ applied: false, cutoff: null })
    expect(isolateIds()).toHaveLength(1)
  })

  it('reports without deleting by default', () => {
    insertIsolate({ created_at: '2001-01-01 00:00:00', updated_at: '2001-01-01 00:00:00', specimen_date: '2001-01-01' })
    const result = database.purgeExpiredData(administrator, { retentionDays: 30 })

    expect(result.dryRun).toBe(true)
    expect(result.applied).toBe(false)
    expect(result.removed.find((entry) => entry.table === 'isolates')?.rows).toBe(1)
    // The default must be the safe one: an accidental call cannot destroy data.
    expect(isolateIds()).toHaveLength(1)
  })

  it('removes expired rows and keeps current ones', () => {
    const old = insertIsolate({ created_at: '2001-01-01 00:00:00', updated_at: '2001-01-01 00:00:00', specimen_date: '2001-01-01' })
    const recent = insertIsolate({ created_at: '2026-08-01 00:00:00', updated_at: '2026-08-01 00:00:00', specimen_date: '2026-08-01' })

    database.purgeExpiredData(administrator, {
      dryRun: false, retentionDays: 30, now: new Date('2026-08-12T00:00:00Z')
    })

    expect(isolateIds()).toEqual([recent])
    expect(isolateIds()).not.toContain(old)
  })

  it('keeps a record that was edited recently however old its specimen date', () => {
    // The anchor is the latest of the dates, not the earliest. A 2001 specimen amended last
    // week is in active use, and a purge that took the specimen date alone would destroy it.
    insertIsolate({ created_at: '2001-01-01 00:00:00', updated_at: '2026-08-10 00:00:00', specimen_date: '2001-01-01' })

    database.purgeExpiredData(administrator, {
      dryRun: false, retentionDays: 30, now: new Date('2026-08-12T00:00:00Z')
    })

    expect(isolateIds()).toHaveLength(1)
  })

  it('keeps a record whose specimen date is unparseable rather than reading it as ancient', () => {
    // '01/02/2001' sorts below every ISO cutoff. Taking the maximum against created_at is
    // what stops a mistyped date from silently deleting a current record.
    insertIsolate({ created_at: '2026-08-01 00:00:00', updated_at: '2026-08-01 00:00:00', specimen_date: '01/02/2001' })

    database.purgeExpiredData(administrator, {
      dryRun: false, retentionDays: 30, now: new Date('2026-08-12T00:00:00Z')
    })

    expect(isolateIds()).toHaveLength(1)
  })

  it('keeps an undated record, because nothing proves it is expired', () => {
    connection().prepare(
      'INSERT INTO isolates(lab_code, patient_id, specimen_date, created_at, updated_at) VALUES (?,?,NULL,NULL,NULL)'
    ).run('LAB1', 'p-undated')

    database.purgeExpiredData(administrator, {
      dryRun: false, retentionDays: 30, now: new Date('2026-08-12T00:00:00Z')
    })

    expect(isolateIds()).toHaveLength(1)
  })

  it('removes an expired event with its alerts and actions', () => {
    connection().prepare(
      `INSERT INTO national_events(id, schema_version, module_key, event_type, purpose, facility_id,
        observed_at, recorded_at, actor, payload_json)
       VALUES ('e-old','1.1','human','case','surveillance','F1','2001-01-01','2001-01-01','tester','{}')`
    ).run()
    connection().prepare(
      `INSERT INTO national_alerts(id, event_id, rule_code, severity, status, message, created_at)
       VALUES ('a-old','e-old','R1','high','open','stale','2001-01-01')`
    ).run()
    connection().prepare(
      `INSERT INTO national_actions(id, event_id, title, priority, status, created_at, updated_at)
       VALUES ('act-old','e-old','follow up','high','open','2001-01-01','2001-01-01')`
    ).run()

    const result = database.purgeExpiredData(administrator, {
      dryRun: false, retentionDays: 30, now: new Date('2026-08-12T00:00:00Z')
    })

    expect(result.removed.find((entry) => entry.table === 'national_events')?.rows).toBe(1)
    for (const table of ['national_events', 'national_alerts', 'national_actions']) {
      const rows = connection().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
      expect({ table, rows: Number(rows.n) }).toEqual({ table, rows: 0 })
    }
  })

  it('leaves the audit chain intact and verifiable', () => {
    insertIsolate({ created_at: '2001-01-01 00:00:00', updated_at: '2001-01-01 00:00:00', specimen_date: '2001-01-01' })
    database.purgeExpiredData(administrator, {
      dryRun: false, retentionDays: 30, now: new Date('2026-08-12T00:00:00Z')
    })

    // The chain is evidence that the log was not altered; a retention job must never be a
    // way to quietly shorten it.
    expect(database.verifyOneHealthAuditChain(administrator)).toMatchObject({ valid: true })
    const entries = connection()
      .prepare("SELECT * FROM national_audit_log WHERE action = 'retention.purge'")
      .all() as Array<Record<string, unknown>>
    expect(entries).toHaveLength(1)
    expect(JSON.parse(String(entries[0]?.details_json))).toMatchObject({ retention_days: 30, dry_run: false })
  })

  it('records a purge that removed nothing', () => {
    // Evidence that the obligation is being met is the run, not the deletions.
    const result = database.purgeExpiredData(administrator, {
      dryRun: false, retentionDays: 30, now: new Date('2026-08-12T00:00:00Z')
    })
    expect(result.applied).toBe(true)
    const entries = connection()
      .prepare("SELECT COUNT(*) AS n FROM national_audit_log WHERE action = 'retention.purge'")
      .get() as { n: number }
    expect(Number(entries.n)).toBe(1)
  })

  it('refuses an actor without the permission', () => {
    const reviewer: OneHealthIdentity = { id: 'r-1', username: 'reviewer', roles: ['reviewer'] }
    expect(() => database.purgeExpiredData(reviewer, { retentionDays: 30 })).toThrow(/not permitted/)
  })
})
