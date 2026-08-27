// @vitest-environment node

import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { AMRITDatabase } from '../src/main/database'

const shouldRun = process.env.RUN_LEGACY_DB === '1'
const legacyPath = resolve(process.env.AMRIT_LEGACY_DB || '../desktop_app/whonet_replica.db')
const suite = shouldRun ? describe : describe.skip

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

suite('full Python database compatibility', () => {
  const directory = mkdtempSync(join(tmpdir(), 'amrit-legacy-copy-'))
  let database: AMRITDatabase | undefined

  afterAll(() => {
    try { database?.close() } catch { /* already closed */ }
    rmSync(directory, { recursive: true, force: true })
  })

  it('migrates a disposable copy, preserves data and never changes the source file', () => {
    const sourceHash = sha256(legacyPath)
    const copy = join(directory, 'legacy.sqlite3')
    copyFileSync(legacyPath, copy)
    database = new AMRITDatabase(copy).initialize()

    expect(database.listLabs(true).length).toBeGreaterThan(0)
    expect(database.listMaster('antibiotics', { includeInactive: true, limit: 100_000 }).length).toBeGreaterThan(100)
    expect(database.listMaster('organisms', { includeInactive: true, limit: 100_000 }).length).toBeGreaterThan(1_000)
    expect(database.getCounts().isolateCount).toBeGreaterThan(1_000)
    expect(database.masterDefinitions()).toHaveLength(16)
    const foreignKeys = database.rawConnectionForTesting().prepare('PRAGMA foreign_key_check').all()
    expect(foreignKeys).toEqual([])
    expect(sha256(legacyPath)).toBe(sourceHash)
  })
})
