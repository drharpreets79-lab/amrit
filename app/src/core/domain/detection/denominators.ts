/**
 * The denominator the case-only scan throws away.
 *
 * Kulldorff's space-time permutation statistic was designed for surveillance where no
 * population at risk is available — syndromic reports, notifiable-disease counts — and it
 * conditions on both margins precisely so it does not need one. Antimicrobial resistance
 * is not that setting. Every resistant isolate arrived with a susceptibility test, and the
 * number of isolates *tested* against that agent is a denominator the laboratory already
 * holds. Discarding it is a choice inherited from a different problem.
 *
 * With it, a detector can ask whether the resistant *proportion* rose, which is immune to
 * a change in testing volume and — unlike the case-only method — can see a rise that is
 * uniform across every ward. Phase 29's Bernoulli model and Phase 31's dual-model scan are
 * both built on these rows.
 *
 * ## What counts as tested
 *
 * An isolate is tested against an agent when the record carries an interpretation for it,
 * whatever that interpretation is. `R` counts as resistant. `I` does **not**: current
 * EUCAST defines it as susceptible with increased exposure, and the scan already refuses
 * to merge it into resistance, so counting it here would make the numerator and the
 * denominator disagree about what resistance means.
 *
 * ## What this is not
 *
 * It is not a population at risk. Patient-days and admissions are the denominator a
 * Poisson model wants, and no laboratory record carries them — a deployment that wants the
 * Poisson model has to supply them. This function reports what is derivable from what the
 * application already stores, and `describeDenominatorCoverage` says so out loud rather
 * than letting a caller assume more.
 */

import type { AstResult, IsolateRecord } from '../../../shared/types'
import type { DenominatorRow, DetectorContext } from './types'

const text = (value: unknown): string => String(value ?? '').trim()
const upper = (value: unknown): string => text(value).toLocaleUpperCase()

function isoDate(value: unknown): string | null {
  const raw = text(value)
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null
}

/**
 * The location key every detector agrees on.
 *
 * Exported so that a detector reading records directly — the multivariate scan permutes
 * isolates rather than aggregates — puts an isolate in the same location this function puts
 * its denominator row. Two detectors disagreeing about which ward a case is in would make
 * every comparison between them a comparison of location keys.
 */
export function stableLocation(record: IsolateRecord): string {
  return text(record.location) || text(record.department) || text(record.location_type) || 'Unknown location'
}

/**
 * Tested and resistant counts per date, location, organism and agent.
 *
 * One organism-level row per date/location/organism carries the isolate count, so a
 * detector that wants "how many Klebsiella were seen here that day" does not have to
 * reconstruct it from the agent rows — which would be wrong, because panels differ between
 * isolates and no single agent is tested on all of them.
 */
export function deriveDenominators(records: readonly IsolateRecord[]): DenominatorRow[] {
  const rows = new Map<string, DenominatorRow>()
  const bump = (
    date: string, location: string, organismCode: string, antibioticCode: string,
    tested: number, resistant: number
  ): void => {
    const key = [date, location, organismCode, antibioticCode].join('')
    const current = rows.get(key)
    if (current) {
      current.tested += tested
      current.resistant += resistant
      return
    }
    rows.set(key, { date, location, organism_code: organismCode, antibiotic_code: antibioticCode, tested, resistant })
  }

  for (const record of records) {
    const date = isoDate(record.specimen_date)
    if (!date) continue
    const organismCode = upper(record.organism_code) || upper(record.organism)
    if (!organismCode) continue
    const location = stableLocation(record)
    bump(date, location, organismCode, '', 1, 0)
    const results = (record.antibiotic_results ?? {}) as Record<string, AstResult>
    for (const [rawCode, ast] of Object.entries(results)) {
      const interpretation = upper(ast?.result)
      // An agent with no interpretation was not tested, or its result was not read. Either
      // way it does not belong in a denominator: counting it would dilute the proportion
      // with isolates that could never have been resistant in the data.
      if (interpretation !== 'R' && interpretation !== 'I' && interpretation !== 'S') continue
      bump(date, location, organismCode, upper(rawCode), 1, interpretation === 'R' ? 1 : 0)
    }
  }

  return [...rows.values()].sort((left, right) => left.date.localeCompare(right.date)
    || left.location.localeCompare(right.location)
    || left.organism_code.localeCompare(right.organism_code)
    || left.antibiotic_code.localeCompare(right.antibiotic_code))
}

/**
 * The denominators a detector should scan, given whatever the caller had.
 *
 * Pre-aggregated rows win when supplied, because the portal has those and no records, and
 * because a benchmark that re-derives them per detector would be comparing derivations.
 * Records are the desktop's case and are folded here rather than in each detector, so that
 * every denominator-requiring model sees the same rows from the same input.
 */
export function denominatorsFrom(context: DetectorContext): DenominatorRow[] {
  if (context.denominators?.length) return [...context.denominators]
  if (context.records?.length) return deriveDenominators(context.records)
  return []
}

/** Why a denominator-requiring detector cannot run here, or `null` when it can. */
export function denominatorUnavailableReason(context: DetectorContext): string | null {
  if (context.denominators?.length || context.records?.length) {
    const agentRows = denominatorsFrom(context).filter((row) => row.antibiotic_code !== '' && row.tested > 0)
    if (agentRows.length === 0) {
      return 'No susceptibility results: every isolate would be in the numerator and none in the '
        + 'denominator, so there is no proportion to scan.'
    }
    return null
  }
  return 'No denominators: this model scans the resistant share of what was tested, and needs '
    + 'the tested count as well as the resistant one.'
}

export interface DenominatorCoverage {
  rows: number
  dates: number
  locations: number
  organisms: number
  /** Organism–antibiotic pairs with a denominator, i.e. what a Bernoulli model can scan. */
  testedPairs: number
  totalTested: number
  totalResistant: number
  /** Denominators a laboratory record cannot supply. Named so nobody assumes otherwise. */
  unavailable: string[]
}

export function describeDenominatorCoverage(rows: readonly DenominatorRow[]): DenominatorCoverage {
  const agentRows = rows.filter((row) => row.antibiotic_code !== '')
  return {
    rows: rows.length,
    dates: new Set(rows.map((row) => row.date)).size,
    locations: new Set(rows.map((row) => row.location)).size,
    organisms: new Set(rows.map((row) => row.organism_code)).size,
    testedPairs: new Set(agentRows.map((row) => `${row.organism_code}:${row.antibiotic_code}`)).size,
    totalTested: agentRows.reduce((sum, row) => sum + row.tested, 0),
    totalResistant: agentRows.reduce((sum, row) => sum + row.resistant, 0),
    unavailable: [
      'patient-days',
      'admissions',
      'occupied beds'
    ]
  }
}
