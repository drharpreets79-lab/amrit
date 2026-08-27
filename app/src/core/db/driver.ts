/**
 * The database seam: what `core/` may assume about SQL, and nothing more.
 *
 * Phase 17. `database.ts` constructs `new DatabaseSync(path)` from `node:sqlite` directly, and
 * `node:sqlite` exists on no phone. This interface is what replaces that construction, and its
 * shape is decided by one fact about the two runtimes it must serve.
 *
 * ## The synchronous/asynchronous decision, taken deliberately
 *
 * `node:sqlite` is **synchronous** and all 4,395 lines of `database.ts` are written that way:
 * `this.db.prepare(sql).get(...)` returns a row, not a promise. `@capacitor-community/sqlite`
 * is Promise-based and cannot be made otherwise — a WebView cannot block.
 *
 * The plan set out three options and recommended the first, and that is what this interface
 * encodes: **`core/` is asynchronous throughout.** Every method here returns a promise, and the
 * desktop adapter wraps its synchronous driver in already-resolved promises, which costs a
 * microtask per query and nothing else.
 *
 * The alternative — a WASM SQLite on mobile so the code could stay synchronous — was rejected
 * for a reason worth writing down: it adds a *second* SQLite implementation to test, with its
 * own persistence story inside a Capacitor WebView, and every bug then has to be reproduced
 * twice. One implementation per platform, one asynchronous seam, is the cheaper long-term
 * position even though it is the larger diff today.
 *
 * ## What is deliberately not here
 *
 * No query builder, no ORM, no migration runner. Those belong above this line, in `core/db/`,
 * where they can be written once. This interface is the smallest surface a platform has to
 * implement to be a place AMRIT can store data.
 */

/** A value SQLite can bind. `Uint8Array` rather than `Buffer`: `Buffer` is a Node type. */
export type SqlValue = string | number | bigint | boolean | null | Uint8Array

export type SqlRow = Record<string, SqlValue>

export interface SqlStatement {
  /** Every matching row. */
  all(...parameters: SqlValue[]): Promise<SqlRow[]>
  /** The first matching row, or `undefined`. */
  get(...parameters: SqlValue[]): Promise<SqlRow | undefined>
  /** Execute for effect. `changes` is rows affected; `lastInsertRowid` is what it says. */
  run(...parameters: SqlValue[]): Promise<{ changes: number; lastInsertRowid: number | bigint }>
}

export interface SqlDriver {
  /**
   * Run SQL with no parameters and no result — schema statements, pragmas, migrations.
   *
   * Separate from `prepare` because a driver may execute several statements in one call here
   * and may not in a prepared statement, and because the migration runner needs exactly this.
   */
  exec(sql: string): Promise<void>

  prepare(sql: string): Promise<SqlStatement>

  /**
   * Run `operation` inside a transaction, committing on return and rolling back on throw.
   *
   * A callback rather than `begin()`/`commit()` methods: a transaction that can be left open
   * by an early return is a transaction that will be, and on mobile an abandoned write lock
   * survives the screen going off.
   */
  transaction<T>(operation: () => Promise<T>): Promise<T>

  /**
   * Copy the database to `destination`, consistently, while it is in use.
   *
   * Backup is not a file copy: a copy taken mid-write is a corrupt database that looks fine
   * until it is restored. Every platform's SQLite has an online-backup primitive; this is it.
   */
  backup(destination: string): Promise<void>

  close(): Promise<void>
}

/** How a platform opens a database. The path is a `PathResolver`'s answer, not a guess. */
export interface SqlDriverFactory {
  open(path: string): Promise<SqlDriver>
}
