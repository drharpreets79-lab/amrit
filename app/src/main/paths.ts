import { app } from 'electron'
import { access, copyFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

export interface DatabaseLocation {
  path: string
  migratedFrom?: string
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate)
    return true
  } catch {
    return false
  }
}

function legacyCandidates(): string[] {
  const candidates = [
    process.env.AMRIT_LEGACY_DB,
    path.resolve(process.cwd(), '../desktop_app/whonet_replica.db'),
    path.resolve(process.cwd(), 'desktop_app/whonet_replica.db'),
    path.resolve(app.getAppPath(), '../desktop_app/whonet_replica.db'),
    path.resolve(app.getAppPath(), '../../desktop_app/whonet_replica.db')
  ].filter((value): value is string => Boolean(value))
  return [...new Set(candidates)]
}

/** Resolve a private writable database. The Python database is copied once and
 * is never opened for mutation by Electron. */
export async function resolveDatabaseLocation(): Promise<DatabaseLocation> {
  const override = process.env.AMRIT_DATABASE_PATH
  if (override) {
    await mkdir(path.dirname(path.resolve(override)), { recursive: true })
    return { path: path.resolve(override) }
  }

  const dataDirectory = path.join(app.getPath('userData'), 'data')
  const destination = path.join(dataDirectory, 'amrit.sqlite3')
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 })
  if (await exists(destination)) return { path: destination }

  for (const source of legacyCandidates()) {
    if (path.resolve(source) === path.resolve(destination) || !(await exists(source))) continue
    await copyFile(source, destination)
    return { path: destination, migratedFrom: source }
  }
  return { path: destination }
}
