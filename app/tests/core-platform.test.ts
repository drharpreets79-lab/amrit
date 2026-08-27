// @vitest-environment node

/**
 * Phase 17: the platform seam, exercised against a real database and real bundled assets.
 *
 * The point of testing an adapter rather than a mock: a mock agrees with whatever the interface
 * says, and the question here is whether a real SQLite and a real filesystem can satisfy the
 * shape a WebView will also have to satisfy. A transaction that does not roll back, or a backup
 * that is a file copy, passes against a mock and loses data against a database.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { nodeAssets, nodeDatabase, nodePaths, nodePlatform, nodeSecrets } from '../src/adapters/node'

const workspace = mkdtempSync(join(tmpdir(), 'amrit-core-'))
afterAll(() => rmSync(workspace, { recursive: true, force: true }))

describe('the SQL seam', () => {
  it('prepares, runs and reads back through the interface', async () => {
    const driver = await nodeDatabase.open(join(workspace, 'seam.sqlite3'))
    await driver.exec('CREATE TABLE isolate(id INTEGER PRIMARY KEY, organism TEXT)')
    const insert = await driver.prepare('INSERT INTO isolate(organism) VALUES (?)')
    const written = await insert.run('KPN')
    expect(written.changes).toBe(1)
    const row = await (await driver.prepare('SELECT organism FROM isolate WHERE id = ?')).get(Number(written.lastInsertRowid))
    expect(row?.organism).toBe('KPN')
    await driver.close()
  })

  it('rolls back on a throw and keeps the original error', async () => {
    // The failure this catches: a transaction wrapper whose rollback throws, replacing the
    // error that says what actually went wrong with one about the rollback.
    const driver = await nodeDatabase.open(join(workspace, 'rollback.sqlite3'))
    await driver.exec('CREATE TABLE t(v TEXT)')
    await expect(driver.transaction(async () => {
      await (await driver.prepare('INSERT INTO t(v) VALUES (?)')).run('written')
      throw new Error('the caller failed')
    })).rejects.toThrow('the caller failed')
    const remaining = await (await driver.prepare('SELECT count(*) AS n FROM t')).get()
    expect(Number(remaining?.n)).toBe(0)
    await driver.close()
  })

  it('commits what a transaction returns', async () => {
    const driver = await nodeDatabase.open(join(workspace, 'commit.sqlite3'))
    await driver.exec('CREATE TABLE t(v TEXT)')
    const result = await driver.transaction(async () => {
      await (await driver.prepare('INSERT INTO t(v) VALUES (?)')).run('kept')
      return 'done'
    })
    expect(result).toBe('done')
    expect(Number((await (await driver.prepare('SELECT count(*) AS n FROM t')).get())?.n)).toBe(1)
    await driver.close()
  })

  it('backs up to a readable database rather than copying a file', async () => {
    const driver = await nodeDatabase.open(join(workspace, 'source.sqlite3'))
    await driver.exec('CREATE TABLE t(v TEXT)')
    await (await driver.prepare('INSERT INTO t(v) VALUES (?)')).run('backed up')
    const destination = join(workspace, 'nested', 'backup.sqlite3')
    await driver.backup(destination)
    await driver.close()

    const restored = await nodeDatabase.open(destination)
    const row = await (await restored.prepare('SELECT v FROM t')).get()
    expect(row?.v).toBe('backed up')
    await restored.close()
  })
})

describe('the asset seam', () => {
  it('reads a bundled asset the product actually ships', async () => {
    const seed = JSON.parse(await nodeAssets.readText('shared/terminology/terminology-seed.v1.json'))
    expect(seed.dataset).toBe('amrit-terminology')
  })

  it('says an absent asset is absent rather than throwing at the caller', async () => {
    expect(await nodeAssets.exists('shared/terminology/terminology-seed.v1.json')).toBe(true)
    expect(await nodeAssets.exists('shared/nothing-here.json')).toBe(false)
    await expect(nodeAssets.readText('shared/nothing-here.json')).rejects.toThrow(/is missing/)
  })

  it('decompresses a gzip shard, because a WebView has no node:zlib', async () => {
    const shards = await nodeAssets.list('shared/geo-directory')
    const gzipped = shards.find((name) => name.endsWith('.gz'))
    if (!gzipped) return
    const text = await nodeAssets.readGzipText(`shared/geo-directory/${gzipped}`)
    expect(text.length).toBeGreaterThan(0)
  })
})

describe('the secret and path seams', () => {
  it('stores and clears a secret, and admits it is not hardware-backed', async () => {
    // The admission is the point: a deployment policy that cannot tell a Secure Enclave from a
    // process-memory map cannot refuse to enrol on the second.
    expect(await nodeSecrets.isAvailable()).toBe(true)
    expect(await nodeSecrets.isHardwareBacked()).toBe(false)
    await nodeSecrets.set('site-token', 'abc')
    expect(await nodeSecrets.get('site-token')).toBe('abc')
    await nodeSecrets.delete('site-token')
    expect(await nodeSecrets.get('site-token')).toBeNull()
  })

  it('keeps data, backups, exports and logs apart', async () => {
    const paths = nodePaths(join(workspace, 'paths'))
    const [data, backups, exports, logs] = await Promise.all([
      paths.dataDirectory(), paths.backupDirectory(), paths.exportDirectory(), paths.logDirectory()
    ])
    expect(new Set([data, backups, exports, logs]).size).toBe(4)
  })

  it('assembles a platform a headless run can use', async () => {
    const platform = nodePlatform(join(workspace, 'platform'))
    expect(platform.name).toBe('node')
    expect(await platform.assets.exists('shared/terminology/terminology-seed.v1.json')).toBe(true)
  })
})
