/**
 * When a signal counts as having found a seeded outbreak.
 *
 * Written down before any detector was run against it, because a matching rule chosen after
 * seeing which rule favours which detector is not a matching rule, it is a result.
 *
 * ## The rule
 *
 * A signal matches a seeded outbreak when all three hold:
 *
 * 1. **Organism.** The signal names the outbreak's organism. Matched on the WHONET code where
 *    the signal carries one and on the display name otherwise, because the detectors differ in
 *    which they report and neither is more correct.
 * 2. **Time.** The signal's window overlaps the outbreak's specimen window by at least one day.
 *    Overlap rather than containment: a prospective scan reports the window it found, the
 *    outbreak is still running at the data cut, and demanding identical dates would score a
 *    one-day difference as a miss.
 * 3. **Place.** The signal names the outbreak's ward, **or** it is an all-location signal.
 *
 * ## Why an all-location signal is allowed to match, and what that costs
 *
 * This is the judgement call in the rule and it goes against the instinct. Four of the twelve
 * detectors have no spatial dimension at all — the control charts and Farrington watch one
 * series through time — and a rule requiring the correct ward would score them at zero
 * sensitivity by construction. That is not a finding about those methods; it is the matching
 * rule reporting its own shape back.
 *
 * So sensitivity admits the pooled signal, and **spatial accuracy is reported separately**: of
 * the signals that matched, the proportion that named the seeded ward rather than the whole
 * site. A detector that finds every outbreak but can never say where scores full sensitivity
 * and zero spatial accuracy, and both numbers appear in the table. Collapsing them into one
 * would hide exactly the trade-off an infection-prevention team cares about.
 *
 * ## What is deliberately not in the rule
 *
 * The antibiotic. A clonal outbreak expresses across every agent its mechanism affects and the
 * detectors legitimately differ about which one to name — Phase 32 measured the case-only scan
 * naming amikacin for a carbapenem outbreak. Requiring the agent would score a detector on
 * which co-resistant agent it happened to rank first, which is not what any of these methods
 * claims to determine.
 */

import type { DetectorSignal } from '../detection/registry'
import type { SeededOutbreak } from '../outbreak-simulation'
import { ALL_LOCATIONS } from '../detection/series'

const DAY_MS = 86_400_000
const day = (value: string): number => Math.round(Date.parse(`${value}T00:00:00Z`) / DAY_MS)

/** Location strings a detector uses for "everywhere", across the two runtimes. */
const POOLED_LOCATIONS: ReadonlySet<string> = new Set([ALL_LOCATIONS, 'All sites', 'All organisms'])

export function isPooled(signal: DetectorSignal): boolean {
  return POOLED_LOCATIONS.has(signal.location) || signal.scope === 'All-location temporal cluster'
}

export interface Match {
  signal: DetectorSignal
  outbreak: SeededOutbreak
  /** True when the signal named the seeded ward rather than matching as an all-location signal. */
  localised: boolean
  /** Days of overlap between the signal window and the outbreak's specimen window. */
  overlapDays: number
  /** Overlap divided by the union of the two windows. 1 is an exact window. */
  temporalJaccard: number
}

const normalise = (value: string): string => value.trim().toLocaleUpperCase()

function organismMatches(signal: DetectorSignal, outbreak: SeededOutbreak): boolean {
  const reported = normalise(signal.organism)
  if (!reported) return false
  return reported === normalise(outbreak.organism_code) || reported === normalise(outbreak.organism)
}

/** The match between one signal and one outbreak, or `null` when the rule is not satisfied. */
export function matchSignal(signal: DetectorSignal, outbreak: SeededOutbreak): Match | null {
  if (!organismMatches(signal, outbreak)) return null

  const truthStart = outbreak.first_specimen_date ? day(outbreak.first_specimen_date) : null
  const truthEnd = outbreak.last_specimen_date ? day(outbreak.last_specimen_date) : null
  if (truthStart === null || truthEnd === null) return null
  const signalStart = day(signal.start_date)
  const signalEnd = day(signal.end_date)
  if (!Number.isFinite(signalStart) || !Number.isFinite(signalEnd)) return null

  const overlapStart = Math.max(truthStart, signalStart)
  const overlapEnd = Math.min(truthEnd, signalEnd)
  const overlapDays = overlapEnd - overlapStart + 1
  if (overlapDays < 1) return null

  const pooled = isPooled(signal)
  const localised = normalise(signal.location) === normalise(outbreak.ward)
  // `system-wide-rise` seeds every ward and records the ward as `All wards`, so a pooled
  // signal is the correct localisation for it rather than a concession.
  const wardIsEverywhere = normalise(outbreak.ward) === normalise('All wards')
  if (!localised && !pooled && !wardIsEverywhere) return null

  const unionStart = Math.min(truthStart, signalStart)
  const unionEnd = Math.max(truthEnd, signalEnd)
  const unionDays = unionEnd - unionStart + 1

  return {
    signal,
    outbreak,
    localised: localised || (wardIsEverywhere && pooled),
    overlapDays,
    temporalJaccard: unionDays > 0 ? overlapDays / unionDays : 0
  }
}

/** Every match between a set of signals and a set of seeded outbreaks. */
export function matchAll(
  signals: readonly DetectorSignal[], outbreaks: readonly SeededOutbreak[]
): Match[] {
  const matches: Match[] = []
  for (const signal of signals) {
    for (const outbreak of outbreaks) {
      const match = matchSignal(signal, outbreak)
      if (match) matches.push(match)
    }
  }
  return matches
}

/** Signals that matched no seeded outbreak. These are the false alerts on a seeded cell. */
export function unmatchedSignals(
  signals: readonly DetectorSignal[], outbreaks: readonly SeededOutbreak[]
): DetectorSignal[] {
  return signals.filter((signal) => !outbreaks.some((outbreak) => matchSignal(signal, outbreak)))
}
