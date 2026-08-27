/**
 * The detector this repository already had, registered rather than hardcoded.
 *
 * This is an adapter and nothing more. `outbreak-detection.ts` is untouched, and it stays
 * the implementation: it is the control arm of every comparison Phases 28 to 34 make, and
 * a control arm that was rewritten while being wrapped is not a control. The parity test
 * asserts the signals coming out of here are byte-identical to calling
 * `runOutbreakDetection` directly.
 */

import {
  DEFAULT_OUTBREAK_SETTINGS,
  runOutbreakDetection,
  type OutbreakSettings
} from '../outbreak-detection'
import type { Detector, DetectorContext, DetectorDescriptor, DetectorRunResult } from './types'

export const SPACE_TIME_PERMUTATION_ID = 'space-time-permutation'

export const spaceTimePermutationDescriptor: DetectorDescriptor = Object.freeze({
  id: SPACE_TIME_PERMUTATION_ID,
  name: 'Space-time permutation scan',
  method: 'Kulldorff space-time permutation scan statistic',
  family: 'scan',
  requires: Object.freeze({ denominators: false, coordinates: false, multipleLocations: true }),
  supports: Object.freeze({ prospective: true, retrospective: true }),
  blindSpot: 'Conditions on the location and time margins, so a rise that is uniform across '
    + 'every location leaves no interaction to find. The all-location category scan covers '
    + 'part of that case and not all of it.',
  citation: 'Kulldorff M, et al. A Space-Time Permutation Scan Statistic for Disease Outbreak '
    + 'Detection. PLOS Medicine 2005;2:e59. doi:10.1371/journal.pmed.0020059'
})

function settingsFrom(raw: Record<string, unknown> | undefined): Partial<OutbreakSettings> {
  const merged: Record<string, unknown> = {}
  for (const key of Object.keys(DEFAULT_OUTBREAK_SETTINGS)) {
    if (raw && raw[key] !== undefined) merged[key] = raw[key]
  }
  return merged as Partial<OutbreakSettings>
}

export const spaceTimePermutationDetector: Detector = {
  descriptor: spaceTimePermutationDescriptor,

  defaultSettings(): Record<string, unknown> {
    return { ...DEFAULT_OUTBREAK_SETTINGS }
  },

  unavailableReason(context: DetectorContext): string | null {
    if (!context.records?.length) return 'No records: this detector scans patient-level isolates.'
    return null
  },

  run(context: DetectorContext): DetectorRunResult {
    const records = [...(context.records ?? [])]
    const settings = settingsFrom(context.settings)
    const result = runOutbreakDetection(records, settings)
    return {
      descriptor: spaceTimePermutationDescriptor,
      settings: { ...result.settings },
      signals: result.signals.map((signal) => ({ ...signal, detector_id: SPACE_TIME_PERMUTATION_ID })),
      warnings: [...result.warnings],
      diagnostics: {
        method: result.method,
        analysis_type: result.analysisType,
        study_start: result.studyStart,
        study_end: result.studyEnd,
        input_records: result.inputRecords,
        eligible_events: result.eligibleEvents,
        locations: result.locations,
        signals_tested: result.signalsTested,
        invalid_date_records: result.invalidDateRecords,
        repeat_events_excluded: result.repeatEventsExcluded,
        maximum_possible_cluster_days: result.maximumPossibleClusterDays,
        // The p-value floor is 1/(permutations+1), so this is the largest recurrence
        // interval the run can produce. Below the configured alert threshold, no alert can
        // fire at any cluster size — which is not obvious from the settings screen.
        maximum_reachable_recurrence_interval: result.settings.permutations + 1
      }
    }
  }
}
