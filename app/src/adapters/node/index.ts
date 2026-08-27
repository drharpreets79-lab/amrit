/**
 * The Node platform: what `core/` gets when it runs on a laptop or in a test.
 *
 * Phase 17. This adapter exists before the Electron and Capacitor ones for a reason the plan
 * states as an exit criterion: **all the existing tests must pass through an adapter, unchanged.**
 * A test suite that runs against Electron cannot run in CI without a display server, and one
 * that runs against the real `node:sqlite` proves the seam works against a real database rather
 * than against a mock that agrees with whatever the code does.
 *
 * It is also what the benchmark harness runs on. Phase 33 generates corpora and runs detectors
 * headlessly; that work has no business booting Electron.
 *
 * ## Synchronous underneath, asynchronous at the seam
 *
 * `node:sqlite` is synchronous. Every method here returns an already-resolved promise, which
 * costs a microtask and buys the one thing that matters: `core/` is written once, in the shape a
 * WebView can also satisfy. The alternative — a synchronous seam here and a second, asynchronous
 * one for mobile — is two seams, two call sites for every query, and two places for a bug.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'

import type { Platform } from '../../core/platform'
import type { SqlDriver, SqlDriverFactory, SqlRow, SqlStatement, SqlValue } from '../../core/db/driver'
import type { AssetSource } from '../../core/io/assets'
import type { PathResolver } from '../../core/paths/resolver'
import type { SecretStore } from '../../core/secrets/store'

/** Where bundled assets live, relative to this file, matching `resolveResourcePath`. */
const RESOURCE_ROOTS = (): string[] => {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url))
  const fromProcess = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  return [
    fromProcess ? resolve(fromProcess, 'resources') : '',
    resolve(process.cwd(), 'resources'),
    resolve(moduleDirectory, '../../../resources')
  ].filter(Boolean)
}

const locate = (name: string): string | null => {
  for (const root of RESOURCE_ROOTS()) {
    const candidate = resolve(root, name)
    if (existsSync(candidate)) return candidate
  }
  return null
}

class NodeStatement implements SqlStatement {
  constructor(private readonly statement: ReturnType<DatabaseSync['prepare']>) {}

  async all(...parameters: SqlValue[]): Promise<SqlRow[]> {
    return this.statement.all(...(parameters as never[])) as unknown as SqlRow[]
  }

  async get(...parameters: SqlValue[]): Promise<SqlRow | undefined> {
    return this.statement.get(...(parameters as never[])) as unknown as SqlRow | undefined
  }

  async run(...parameters: SqlValue[]): Promise<{ changes: number; lastInsertRowid: number | bigint }> {
    const result = this.statement.run(...(parameters as never[]))
    return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid }
  }
}

class NodeSqlDriver implements SqlDriver {
  constructor(private readonly database: DatabaseSync) {}

  async exec(sql: string): Promise<void> {
    this.database.exec(sql)
  }

  async prepare(sql: string): Promise<SqlStatement> {
    return new NodeStatement(this.database.prepare(sql))
  }

  /**
   * `IMMEDIATE`, not deferred: a deferred transaction takes its write lock at the first write,
   * which on a busy database means a reader can be promoted into a lock conflict halfway
   * through work it has already done.
   */
  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = await operation()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      // A rollback that itself throws must not replace the original error, which is the one
      // that says what went wrong.
      try { this.database.exec('ROLLBACK') } catch { /* the original error is the useful one */ }
      throw error
    }
  }

  async backup(destination: string): Promise<void> {
    mkdirSync(dirname(destination), { recursive: true })
    // VACUUM INTO is SQLite's online backup: consistent against concurrent writers, and it
    // compacts. A file copy taken mid-write produces a database that looks fine until restored.
    this.database.exec(`VACUUM INTO '${destination.replace(/'/g, "''")}'`)
  }

  async close(): Promise<void> {
    this.database.close()
  }
}

export const nodeDatabase: SqlDriverFactory = {
  async open(path: string): Promise<SqlDriver> {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    return new NodeSqlDriver(new DatabaseSync(path))
  }
}

export const nodeAssets: AssetSource = {
  async readText(name: string): Promise<string> {
    const path = locate(name)
    if (!path) throw new Error(`Bundled asset '${name}' is missing. Searched: ${RESOURCE_ROOTS().join(', ')}`)
    return readFileSync(path, 'utf8')
  },
  async readBytes(name: string): Promise<Uint8Array> {
    const path = locate(name)
    if (!path) throw new Error(`Bundled asset '${name}' is missing. Searched: ${RESOURCE_ROOTS().join(', ')}`)
    return new Uint8Array(readFileSync(path))
  },
  async readGzipText(name: string): Promise<string> {
    const path = locate(name)
    if (!path) throw new Error(`Bundled asset '${name}' is missing. Searched: ${RESOURCE_ROOTS().join(', ')}`)
    return gunzipSync(readFileSync(path)).toString('utf8')
  },
  async exists(name: string): Promise<boolean> {
    return locate(name) !== null
  },
  async list(prefix: string): Promise<string[]> {
    const path = locate(prefix)
    return path && existsSync(path) ? readdirSync(path).sort() : []
  }
}

/**
 * A secret store for a platform that has no keychain.
 *
 * **It reports `isHardwareBacked: false` and it means it.** This adapter is for tests and for
 * headless runs; a deployment holding a real site token uses Electron's `safeStorage`, the iOS
 * Keychain or the Android Keystore. Saying so in the interface rather than in a comment is what
 * lets a deployment policy refuse to enrol on a platform that cannot protect the credential.
 */
class NodeSecretStore implements SecretStore {
  private readonly values = new Map<string, string>()

  async isAvailable(): Promise<boolean> { return true }
  async isHardwareBacked(): Promise<boolean> { return false }
  async get(key: string): Promise<string | null> { return this.values.get(key) ?? null }
  async set(key: string, value: string): Promise<void> { this.values.set(key, value) }
  async delete(key: string): Promise<void> { this.values.delete(key) }
}

export const nodeSecrets: SecretStore = new NodeSecretStore()

export function nodePaths(root?: string): PathResolver {
  const base = root ?? join(process.env.AMRIT_DATA_DIR || join(homedir(), '.amrit'))
  const ensure = (path: string): string => { mkdirSync(path, { recursive: true }); return path }
  return {
    async dataDirectory(): Promise<string> { return ensure(base) },
    async backupDirectory(): Promise<string> { return ensure(join(base, 'backups')) },
    async exportDirectory(): Promise<string | null> { return ensure(join(base, 'exports')) },
    async logDirectory(): Promise<string> { return ensure(join(base, 'logs')) },
    join(...segments: string[]): string { return join(...segments) }
  }
}

/** The platform a test or a headless run gets. `root` defaults to a temporary directory. */
export function nodePlatform(root?: string): Platform {
  return {
    name: 'node',
    database: nodeDatabase,
    assets: nodeAssets,
    secrets: nodeSecrets,
    paths: nodePaths(root ?? join(tmpdir(), 'amrit-node-platform'))
  }
}
