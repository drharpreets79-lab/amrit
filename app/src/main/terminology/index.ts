/**
 * Loading the terminology seed, and gating it on the deployment's licence position.
 *
 * Phase 22. `service.ts` holds the operations and touches nothing outside itself; this file is
 * the part that reads a file and consults the country profile, which is the same split
 * `catalog-seed.ts` and `detection/` already use.
 *
 * The gate is not new machinery. Phase 10 put `code_systems.<id>.enabled` in the country
 * profile so SNOMED could ship disabled where a deployment has no licence for it, and every
 * vocabulary added since answers to the same switch. What this file adds is the mapping from a
 * FHIR system URL to that switch, and a reason string an operator can act on when the answer
 * is no.
 */

import { readFileSync } from 'node:fs'

import { activeProfile } from '../active-profile'
import { resolveResourcePath } from '../catalog-seed'
import {
  ICD10_SYSTEM, ICD11_SYSTEM, LOINC_SYSTEM, SNOMED_SYSTEM, UCUM_SYSTEM, WHONET_ANTIBIOTIC_SYSTEM,
  WHONET_ORGANISM_SYSTEM, WHONET_SPECIMEN_SYSTEM, type SystemGate, type TerminologySeed
} from './service'

export const TERMINOLOGY_SEED_FILE = 'shared/terminology/terminology-seed.v1.json'

/** FHIR system URL to the `code_systems` key a profile gates it with. */
const LICENCE_IDS: Readonly<Record<string, string>> = Object.freeze({
  [LOINC_SYSTEM]: 'loinc',
  [UCUM_SYSTEM]: 'ucum',
  [SNOMED_SYSTEM]: 'snomed',
  [ICD10_SYSTEM]: 'icd10',
  // CC BY-ND 3.0 IGO. Free to use with attribution, so it ships enabled; gated anyway so a
  // deployment whose counsel objects to the no-derivatives terms can switch it off and get a
  // reason rather than an empty result.
  [ICD11_SYSTEM]: 'icd11'
})

/** Systems AMRIT defines itself. A deployment cannot switch off its own primary code space. */
const LOCAL_SYSTEMS: ReadonlySet<string> = new Set([
  WHONET_ANTIBIOTIC_SYSTEM, WHONET_ORGANISM_SYSTEM, WHONET_SPECIMEN_SYSTEM
])

let cached: TerminologySeed | null = null

export function loadTerminologySeed(explicitPath?: string): TerminologySeed {
  if (cached && !explicitPath) return cached
  const path = explicitPath ?? resolveResourcePath(TERMINOLOGY_SEED_FILE)
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`Terminology seed is missing or unreadable at ${path}: `
      + `${error instanceof Error ? error.message : String(error)}. `
      + 'Run tools/generate_terminology_seed.py and tools/sync_shared.py.')
  }
  const seed = parsed as TerminologySeed
  if (!seed || seed.dataset !== 'amrit-terminology' || typeof seed.contentSha256 !== 'string') {
    throw new Error(`Terminology seed at ${path} is not an AMRIT terminology asset.`)
  }
  if (!explicitPath) cached = seed
  return seed
}

/** Test seam. The seed is cached because a 400 KB parse per export is not free. */
export function resetTerminologyCache(): void {
  cached = null
}

/**
 * The deployment's gate, read from the active country profile.
 *
 * A system with no entry is enabled: the profile lists what needs a decision, and a vocabulary
 * that needs none should not have to be enumerated by every deployment. A system explicitly
 * disabled produces the profile's own licence note where it has one, because that note is the
 * deployment's reason and this file has no better one to offer.
 */
export function profileGate(): SystemGate {
  const configured = activeProfile().code_systems ?? {}
  return (system: string) => {
    if (LOCAL_SYSTEMS.has(system)) return { enabled: true, reason: '' }
    const id = LICENCE_IDS[system]
    if (!id) return { enabled: true, reason: '' }
    const entry = configured[id]
    if (!entry || entry.enabled !== false) return { enabled: true, reason: '' }
    return {
      enabled: false,
      reason: `${id.toLocaleUpperCase()} is disabled in this deployment's country profile`
        + `${entry.licence ? `: ${entry.licence}` : '.'} Codes from ${system} are omitted from output `
        + 'rather than substituted, and the export records that they were omitted.'
    }
  }
}

export * from './service'
