/**
 * Everything `core/` needs from the platform it is running on, in one object.
 *
 * Phase 17. Passing four interfaces through every constructor produces four parameters that are
 * always passed together and occasionally passed in the wrong order. This is that bundle, and it
 * is also the list a new platform has to satisfy — `adapters/node/`, `adapters/electron/` and
 * `adapters/capacitor/` each export one of these and nothing else is required of them.
 */

import type { SqlDriverFactory } from './db/driver'
import type { AssetSource } from './io/assets'
import type { PathResolver } from './paths/resolver'
import type { SecretStore } from './secrets/store'

export interface Platform {
  /** Which platform this is, for diagnostics and for the honest degradation messages. */
  readonly name: 'electron' | 'node' | 'capacitor'
  readonly database: SqlDriverFactory
  readonly assets: AssetSource
  readonly secrets: SecretStore
  readonly paths: PathResolver
}

export type { SqlDriver, SqlDriverFactory, SqlRow, SqlStatement, SqlValue } from './db/driver'
export type { AssetSource } from './io/assets'
export type { PathResolver } from './paths/resolver'
export type { SecretStore } from './secrets/store'
