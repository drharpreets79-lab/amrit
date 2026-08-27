/**
 * The location seam: where this platform keeps things.
 *
 * Phase 17. `paths.ts` calls `app.getPath('userData')`, which is Electron. Android has an app
 * data directory, iOS a container, a test run a temporary directory — and the differences are
 * not cosmetic: on iOS, files in the wrong directory are backed up to iCloud, and a database of
 * patient records must not be.
 *
 * `exportDirectory` is separate from `dataDirectory` for the same reason it is separate in the
 * product: an export is a file a human takes somewhere, and on a phone that is a share sheet
 * rather than a folder. A platform that has no such place says so by returning null, and the
 * caller offers sharing instead of writing.
 */

export interface PathResolver {
  /** Where the database and its journals live. Never synchronised, never backed up to a cloud. */
  dataDirectory(): Promise<string>
  /** Where backups are written. May be the same volume; must survive an application update. */
  backupDirectory(): Promise<string>
  /** Where an export lands, or null on a platform where the user chooses per file. */
  exportDirectory(): Promise<string | null>
  /** Where logs are written. */
  logDirectory(): Promise<string>
  /** Join path segments the way this platform spells them. */
  join(...segments: string[]): string
}
