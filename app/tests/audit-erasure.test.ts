// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AMRITDatabase } from '../src/main/database'
import { auditDetailsDigest, auditHash } from '../src/main/one-health-governance'
import type { OneHealthIdentity } from '../src/shared/types'

/**
 * Phase 12 gate: a lawful erasure request and a tamper-evident audit chain must both be
 * satisfiable.
 *
 * Hashing the payload directly would make them mutually exclusive — erasing the data would
 * break every subsequent hash, and the log would become indistinguishable from a tampered
 * one. The chain therefore commits to a digest of the details, and erasure destroys the
 * plaintext while the digest, the position and the timestamps remain.
 */
describe('audit erasure', () => {
  let directory: string
  let database: AMRITDatabase

  const administrator: OneHealthIdentity = {
    id: 'admin-1',
    username: 'administrator',
    roles: ['administrator']
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'amrit-erasure-'))
    database = new AMRITDatabase(join(directory, 'amrit.sqlite3')).initialize()
  })

  afterEach(() => {
    try { database.close() } catch { /* already closed */ }
    rmSync(directory, { recursive: true, force: true })
  })

  const raw = <T>(sql: string, ...params: unknown[]): T[] => {
    const connection = database.rawConnectionForTesting()
    return connection.prepare(sql).all(...(params as never[])) as T[]
  }

  const seedEntries = (): void => {
    database.createOneHealthUser({
      username: 'subject.person',
      password: 'a-long-enough-password',
      roles: ['data-entry']
    }, administrator)
  }

  it('commits the chain to a digest, not to the payload', () => {
    seedEntries()
    const rows = raw<Record<string, unknown>>('SELECT * FROM national_audit_log ORDER BY id')
    expect(rows.length).toBeGreaterThan(0)

    for (const row of rows) {
      const details = JSON.parse(String(row.details_json))
      expect(row.details_digest).toBe(auditDetailsDigest(details))
      // The stored hash is over the digest, so the payload is not needed to verify it.
      const expected = auditHash(String(row.previous_hash ?? ''), {
        occurred_at: String(row.occurred_at),
        actor: String(row.actor),
        action: String(row.action),
        object_type: String(row.object_type),
        object_id: String(row.object_id),
        details_digest: String(row.details_digest)
      })
      expect(row.entry_hash).toBe(expected)
    }
  })

  it('keeps the chain verifiable after an erasure', () => {
    seedEntries()
    expect(database.verifyOneHealthAuditChain(administrator)).toMatchObject({ valid: true })

    const target = raw<Record<string, unknown>>(
      "SELECT * FROM national_audit_log WHERE action = 'user.create' LIMIT 1"
    )[0]
    expect(target).toBeTruthy()

    const result = database.eraseAuditDetails(
      administrator, String(target?.object_type), String(target?.object_id), 'subject erasure request'
    )
    expect(result.erased).toBeGreaterThan(0)

    // The whole point: the log still proves it was not altered.
    expect(database.verifyOneHealthAuditChain(administrator)).toMatchObject({ valid: true })
  })

  it('destroys the payload but keeps the proof that the entry existed', () => {
    seedEntries()
    const before = raw<Record<string, unknown>>(
      "SELECT * FROM national_audit_log WHERE action = 'user.create' LIMIT 1"
    )[0]!
    expect(String(before.details_json)).toContain('subject.person')

    database.eraseAuditDetails(
      administrator, String(before.object_type), String(before.object_id), 'subject erasure request'
    )

    const after = raw<Record<string, unknown>>(
      'SELECT * FROM national_audit_log WHERE id = ?', Number(before.id)
    )[0]!
    // The payload is gone…
    expect(String(after.details_json)).not.toContain('subject.person')
    expect(JSON.parse(String(after.details_json))).toEqual({ erased: true })
    // …and everything that proves the record existed remains.
    expect(after.occurred_at).toBe(before.occurred_at)
    expect(after.actor).toBe(before.actor)
    expect(after.entry_hash).toBe(before.entry_hash)
    expect(after.previous_hash).toBe(before.previous_hash)
    expect(after.details_digest).toBe(before.details_digest)
    expect(after.erased_at).toBeTruthy()
    expect(after.erasure_reason).toBe('subject erasure request')
  })

  it('records the erasure itself, so removal is never silent', () => {
    seedEntries()
    const target = raw<Record<string, unknown>>(
      "SELECT * FROM national_audit_log WHERE action = 'user.create' LIMIT 1"
    )[0]!

    database.eraseAuditDetails(administrator, String(target.object_type), String(target.object_id), 'court order')

    const erasures = raw<Record<string, unknown>>(
      "SELECT * FROM national_audit_log WHERE action = 'audit.erase'"
    )
    expect(erasures).toHaveLength(1)
    expect(JSON.parse(String(erasures[0]?.details_json)).reason).toBe('court order')
    // A silent erasure would be indistinguishable from tampering.
    expect(database.verifyOneHealthAuditChain(administrator)).toMatchObject({ valid: true })
  })

  it('is idempotent and reports what was already erased', () => {
    seedEntries()
    const target = raw<Record<string, unknown>>(
      "SELECT * FROM national_audit_log WHERE action = 'user.create' LIMIT 1"
    )[0]!

    const first = database.eraseAuditDetails(administrator, String(target.object_type), String(target.object_id), 'request')
    const second = database.eraseAuditDetails(administrator, String(target.object_type), String(target.object_id), 'request')

    expect(first.erased).toBeGreaterThan(0)
    expect(second.erased).toBe(0)
    expect(second.alreadyErased).toBe(first.erased)
    expect(database.verifyOneHealthAuditChain(administrator)).toMatchObject({ valid: true })
  })

  it('requires a recorded reason', () => {
    seedEntries()
    expect(() => database.eraseAuditDetails(administrator, 'user', 'whatever', '   '))
      .toThrow(/record why/)
  })

  it('refuses an actor without the permission', () => {
    seedEntries()
    const reviewer: OneHealthIdentity = { id: 'r-1', username: 'reviewer', roles: ['reviewer'] }
    expect(() => database.eraseAuditDetails(reviewer, 'user', 'whatever', 'request'))
      .toThrow(/not permitted/)
  })

  it('still detects a payload rewritten under an untouched entry hash', () => {
    // Moving the chain onto a digest removed the entry hash's own cover for the payload:
    // editing details_json no longer changes the hash the chain checks. Verification binds
    // the payload back to its digest for exactly this case, which is the classic tamper.
    seedEntries()
    const target = raw<Record<string, unknown>>(
      "SELECT * FROM national_audit_log WHERE action = 'user.create' LIMIT 1"
    )[0]!

    const connection = new DatabaseSync(join(directory, 'amrit.sqlite3'))
    connection.prepare('UPDATE national_audit_log SET details_json = ? WHERE id = ?')
      .run('{"roles":["administrator"]}', Number(target.id))
    connection.close()

    const reopened = new AMRITDatabase(join(directory, 'amrit.sqlite3')).initialize()
    try {
      expect(reopened.verifyOneHealthAuditChain(administrator))
        .toMatchObject({ valid: false, broken_at: Number(target.id), reason: 'details digest mismatch' })
    } finally {
      reopened.close()
    }
  })

  it('still detects real tampering after an erasure', () => {
    seedEntries()
    const target = raw<Record<string, unknown>>(
      "SELECT * FROM national_audit_log WHERE action = 'user.create' LIMIT 1"
    )[0]!
    database.eraseAuditDetails(administrator, String(target.object_type), String(target.object_id), 'request')
    expect(database.verifyOneHealthAuditChain(administrator)).toMatchObject({ valid: true })

    // Erasure must not become a way to launder an altered log: changing the digest, the
    // actor or the order still has to be caught.
    const connection = new DatabaseSync(join(directory, 'amrit.sqlite3'))
    connection.prepare('UPDATE national_audit_log SET actor = ? WHERE id = ?')
      .run('someone-else', Number(target.id))
    connection.close()

    const reopened = new AMRITDatabase(join(directory, 'amrit.sqlite3')).initialize()
    try {
      expect(reopened.verifyOneHealthAuditChain(administrator)).toMatchObject({ valid: false })
    } finally {
      reopened.close()
    }
  })
})
