/**
 * Retention policy: profile-driven expiry of row-level operational data.
 *
 * Several jurisdictions cap how long identifiable surveillance data may be kept, and today
 * nothing in this application expires. `profile.privacy.retention_days` sets that cap.
 * Leaving it null retains indefinitely, which is exactly what every existing deployment
 * does now — so adding retention changes nothing until a deployment asks for it.
 *
 * Deliberately NOT purged:
 *
 *  - The One Health audit chain. Deleting entries would break the hash chain and destroy
 *    the evidence that the log is intact. Personal data inside an entry is removed by
 *    `eraseAuditDetails()` instead, which shreds the payload and leaves the chain
 *    verifiable. Retention and tamper-evidence are reconciled there, not here.
 *  - `national_outbox`. It carries aggregates, which are not row-level personal data, and
 *    dropping a queued item would lose a report the central server never received.
 *  - Catalogue, master and configuration data. These describe the deployment, not a person.
 */

export interface RetentionDependent {
  table: string
  /** Column in the dependent table holding the parent row's id. */
  column: string
}

export interface RetentionTarget {
  table: string
  /** Primary-key column, used to select the rows to remove. */
  key: string
  label: string
  /**
   * SQL yielding the row's retention anchor as a `YYYY-MM-DD` string.
   *
   * Always the *latest* of the candidate dates, never the earliest. A record edited last
   * week is in use whatever its specimen date says, and a mistyped or non-ISO specimen date
   * ('01/02/2020', a 1925 typo) sorts below every plausible cutoff — taking the maximum
   * means such a row is held by its `created_at` rather than silently destroyed.
   *
   * Compared on the date prefix alone because these columns mix `CURRENT_TIMESTAMP`
   * ('2026-08-12 09:30:00') with ISO instants ('2026-08-12T09:30:00.000Z'), which do not
   * order against each other below day granularity. Retention in days needs no finer.
   */
  anchor: string
  /** Rows that reference this one and must be removed with it (no ON DELETE CASCADE). */
  dependents?: RetentionDependent[]
}

const dateOf = (column: string): string => `substr(coalesce(${column},''),1,10)`

export const RETENTION_TARGETS: readonly RetentionTarget[] = Object.freeze([
  {
    table: 'isolates',
    key: 'id',
    label: 'Isolate records',
    // AST results, genomic results and omics rows carry ON DELETE CASCADE and go with the
    // isolate; foreign keys are enabled on every connection (see initialize()).
    anchor: `max(${dateOf('created_at')},${dateOf('updated_at')},${dateOf('specimen_date')})`
  },
  {
    table: 'national_events',
    key: 'id',
    label: 'One Health events',
    anchor: `max(${dateOf('recorded_at')},${dateOf('observed_at')})`,
    // Both reference national_events without a cascade, so they are removed explicitly.
    // An alert message and an action's evidence quote the event, so they expire with it.
    dependents: [
      { table: 'national_alerts', column: 'event_id' },
      { table: 'national_actions', column: 'event_id' }
    ]
  }
])

export class RetentionError extends Error {}

/**
 * The date on or after which data is kept. Rows whose anchor is strictly earlier expire.
 *
 * Returns null when retention is unset, which means "keep indefinitely" rather than
 * "expire everything" — the failure mode of the opposite default is unrecoverable.
 */
export function retentionCutoffDate(
  retentionDays: number | null | undefined,
  now: Date = new Date()
): string | null {
  if (retentionDays === null || retentionDays === undefined) return null
  if (!Number.isFinite(retentionDays) || !Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new RetentionError(`Retention must be a whole number of days of at least 1: ${String(retentionDays)}`)
  }
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000)
  if (Number.isNaN(cutoff.getTime())) throw new RetentionError('Retention cutoff is not a valid date')
  return cutoff.toISOString().slice(0, 10)
}

/** Selects the expired rows of one target. Bound parameter: the cutoff date. */
export function expiredRowsSql(target: RetentionTarget): string {
  // An empty anchor means the row carries no usable date at all. It is kept: retention
  // removes data proven to be old, and an undated row proves nothing.
  return `SELECT ${target.key} AS id FROM ${target.table} WHERE ${target.anchor} <> '' AND ${target.anchor} < ?`
}
