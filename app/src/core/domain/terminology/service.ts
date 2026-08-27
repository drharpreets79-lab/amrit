/**
 * The four terminology operations, over a seed and nothing else.
 *
 * Phase 22. Pure: no filesystem, no network, no database. The seed is handed in, which is
 * what lets the same functions answer for the desktop, for a test, and — mirrored in Python —
 * for the portal's HTTP endpoints, without three implementations of `$translate` disagreeing
 * about what a code means.
 *
 * ## Why a code system can be switched off, and what "off" has to mean
 *
 * Phase 10 established per-vocabulary gating in the country profile (`code_systems.<id>.enabled`)
 * because SNOMED CT cannot ship enabled everywhere: it needs a licence that is free in member
 * countries and paid elsewhere. Terminology inherits that mechanism rather than inventing a
 * second one.
 *
 * "Off" means the operation **says the system is disabled**. It does not mean an empty result,
 * and it does not mean falling back to a different system's code. A receiver told "no such code"
 * concludes the code is wrong; a receiver told "this deployment has SNOMED disabled" knows
 * exactly what to do. Silent degradation is how a licence problem becomes a data problem.
 */

export interface TerminologyConcept {
  code: string
  display: string
}

export interface ConceptMapElement {
  source: string
  /** Relationship or method to target code, e.g. `mic`, `disk`, `equivalent`. */
  targets: Record<string, string>
}

export interface TerminologyConceptMap {
  id: string
  sourceSystem: string
  targetSystem: string
  note: string
  elements: ConceptMapElement[]
}

export interface TerminologySeed {
  schemaVersion: number
  dataset: string
  version: string
  contentSha256: string
  provenance: Record<string, unknown>
  codeSystems: Array<{ url: string; name: string; licenceId: string; concepts: number; note: string }>
  concepts: Record<string, TerminologyConcept[]>
  bindings: {
    antibiotic: Record<string, Record<string, string>>
    observation: Record<string, TerminologyConcept>
    units: Record<string, string>
  }
  conceptMaps: TerminologyConceptMap[]
  matchCounts: Record<string, number>
  unmatched: Array<{ code: string; name: string; reason: string }>
}

/** Which systems this deployment may use. Absent means enabled, as everywhere else in the profile. */
export type SystemGate = (system: string) => { enabled: boolean; reason: string }

export const ALL_SYSTEMS_ENABLED: SystemGate = () => ({ enabled: true, reason: '' })

export const LOINC_SYSTEM = 'http://loinc.org'
export const UCUM_SYSTEM = 'http://unitsofmeasure.org'
export const SNOMED_SYSTEM = 'http://snomed.info/sct'
export const ICD10_SYSTEM = 'http://hl7.org/fhir/sid/icd-10'
/** Phase 26. ICD-11 MMS, as WHO's own API names it. */
export const ICD11_SYSTEM = 'http://id.who.int/icd/release/11/mms'
export const WHONET_ANTIBIOTIC_SYSTEM = 'urn:whonet:antibiotic-code'
export const WHONET_ORGANISM_SYSTEM = 'urn:whonet:organism-code'
export const WHONET_SPECIMEN_SYSTEM = 'urn:whonet:specimen-code'

/**
 * The revisions of ICD a record's `diagnosis_system` may name.
 *
 * Both ship as starter value sets and neither is converted into the other: WHO's API
 * publishes no mapping between the revisions, so a deployment's records stay in the
 * revision they were captured in and an export says which one that was.
 */
export const ICD_SYSTEMS: ReadonlySet<string> = new Set([ICD10_SYSTEM, ICD11_SYSTEM])

/** The shape every operation returns: an answer, or a reason there is not one. */
export interface OperationOutcome<T> {
  ok: boolean
  value?: T
  /** Empty when `ok`. A sentence naming what to change when not. */
  reason: string
}

const upper = (value: unknown): string => String(value ?? '').trim().toLocaleUpperCase()

function conceptsOf(seed: TerminologySeed, system: string): TerminologyConcept[] {
  return seed.concepts[system] ?? []
}

/**
 * `$lookup` — what does this code mean?
 *
 * Answers only from the bundled subset. AMRIT bundles the codes it binds to and not the
 * 100,000-concept LOINC release, so "not found here" and "not a LOINC code" are different
 * statements and the reason says which one this is.
 */
export function lookup(
  seed: TerminologySeed, system: string, code: string, gate: SystemGate = ALL_SYSTEMS_ENABLED
): OperationOutcome<TerminologyConcept> {
  const gated = gate(system)
  if (!gated.enabled) return { ok: false, reason: gated.reason }
  const wanted = String(code ?? '').trim()
  if (!wanted) return { ok: false, reason: 'No code given.' }
  const concept = conceptsOf(seed, system).find((entry) => entry.code === wanted)
  if (concept) return { ok: true, value: concept, reason: '' }
  if (!seed.concepts[system]) {
    return {
      ok: false,
      reason: `This deployment bundles no concepts for ${system}. Bundled: `
        + `${Object.keys(seed.concepts).join(', ') || 'none'}.`
    }
  }
  return {
    ok: false,
    reason: `${code} is not in the bundled subset of ${system}. AMRIT bundles only the concepts it `
      + 'binds to, so this says the code is unused here, not that it is invalid.'
  }
}

/** `$validate-code` — is this code usable in this deployment? */
export function validateCode(
  seed: TerminologySeed, system: string, code: string, gate: SystemGate = ALL_SYSTEMS_ENABLED
): OperationOutcome<{ code: string; display: string }> {
  const found = lookup(seed, system, code, gate)
  return found.ok
    ? { ok: true, value: { code: found.value?.code ?? code, display: found.value?.display ?? '' }, reason: '' }
    : { ok: false, reason: found.reason }
}

export interface TranslateRequest {
  /** ConceptMap id, or omit to search every map with the right source system. */
  conceptMap?: string
  sourceSystem: string
  code: string
  /** For a map whose targets are method variants: `mic`, `disk`, `plain`, `gradient`, `equivalent`. */
  relationship?: string
}

export interface Translation {
  conceptMap: string
  targetSystem: string
  relationship: string
  code: string
  display: string
}

/**
 * `$translate` — what is this code in another system?
 *
 * A translation with no relationship named returns every target the map holds for the code,
 * because for an antibiotic "the LOINC code" is not one code: an MIC and a disk diffusion of
 * the same drug are different LOINC concepts, and a caller that has not said which method it
 * measured has not asked an answerable question.
 */
export function translate(
  seed: TerminologySeed, request: TranslateRequest, gate: SystemGate = ALL_SYSTEMS_ENABLED
): OperationOutcome<Translation[]> {
  const maps = seed.conceptMaps.filter((map) =>
    (request.conceptMap ? map.id === request.conceptMap : true)
    && map.sourceSystem === request.sourceSystem)
  if (maps.length === 0) {
    return {
      ok: false,
      reason: request.conceptMap
        ? `No ConceptMap '${request.conceptMap}' from ${request.sourceSystem}.`
        : `No ConceptMap translates ${request.sourceSystem}. Available: `
          + `${seed.conceptMaps.map((map) => map.id).join(', ')}.`
    }
  }
  const translations: Translation[] = []
  const blocked: string[] = []
  for (const map of maps) {
    const gated = gate(map.targetSystem)
    if (!gated.enabled) {
      blocked.push(gated.reason)
      continue
    }
    const element = map.elements.find((entry) => upper(entry.source) === upper(request.code))
    if (!element) continue
    for (const [relationship, code] of Object.entries(element.targets)) {
      if (request.relationship && relationship !== request.relationship) continue
      const display = lookup(seed, map.targetSystem, code, ALL_SYSTEMS_ENABLED)
      translations.push({
        conceptMap: map.id,
        targetSystem: map.targetSystem,
        relationship,
        code,
        display: display.value?.display ?? ''
      })
    }
  }
  if (translations.length > 0) return { ok: true, value: translations, reason: '' }
  if (blocked.length > 0) return { ok: false, reason: blocked.join(' ') }
  return {
    ok: false,
    reason: `No mapping for ${request.code}${request.relationship ? ` (${request.relationship})` : ''} in `
      + `${maps.map((map) => map.id).join(', ')}. Unmapped is recorded as unmapped; nothing is guessed.`
  }
}

export interface ExpandRequest {
  system: string
  /** Case-insensitive substring of code or display. Absent returns everything bundled. */
  filter?: string
  count?: number
  offset?: number
}

export interface Expansion {
  system: string
  total: number
  offset: number
  concepts: TerminologyConcept[]
}

/**
 * `ValueSet/$expand` — which codes may go in this field?
 *
 * `total` is the number of matches, not the number returned, so a caller paging a picker knows
 * whether it is looking at everything. That distinction is the whole reason the diagnosis picker
 * in Phase 24 can page a large system without lying about how much it found.
 */
export function expand(
  seed: TerminologySeed, request: ExpandRequest, gate: SystemGate = ALL_SYSTEMS_ENABLED
): OperationOutcome<Expansion> {
  const gated = gate(request.system)
  if (!gated.enabled) return { ok: false, reason: gated.reason }
  const all = conceptsOf(seed, request.system)
  if (all.length === 0 && !seed.concepts[request.system]) {
    return { ok: false, reason: `This deployment bundles no concepts for ${request.system}.` }
  }
  const needle = String(request.filter ?? '').trim().toLocaleLowerCase()
  const matched = needle
    ? all.filter((concept) => concept.code.toLocaleLowerCase().includes(needle)
      || concept.display.toLocaleLowerCase().includes(needle))
    : all
  const offset = Math.max(0, Math.trunc(request.offset ?? 0))
  const count = Math.max(1, Math.min(1000, Math.trunc(request.count ?? 100)))
  return {
    ok: true,
    reason: '',
    value: {
      system: request.system,
      total: matched.length,
      offset,
      concepts: matched.slice(offset, offset + count)
    }
  }
}

export interface AntibioticBinding {
  /** LOINC code for the method actually used, or the method-less code when none was recorded. */
  code: string
  display: string
  /** Which LOINC method variant was chosen: `mic`, `disk`, `gradient` or `plain`. */
  method: string
}

/**
 * The LOINC code for a susceptibility result, chosen by the method the laboratory recorded.
 *
 * The method matters and is not cosmetic: LOINC codes an MIC and a disk diffusion of the same
 * drug as different concepts, because they are different measurements with different units and
 * different breakpoints. A deployment that records no method gets the method-less code, which
 * says what was tested and declines to say how — an honest partial answer rather than a
 * confident wrong one.
 */
export function antibioticBinding(
  seed: TerminologySeed, antibioticCode: string, method: string, gate: SystemGate = ALL_SYSTEMS_ENABLED
): OperationOutcome<AntibioticBinding> {
  const gated = gate(LOINC_SYSTEM)
  if (!gated.enabled) return { ok: false, reason: gated.reason }
  const binding = seed.bindings.antibiotic[upper(antibioticCode)]
  if (!binding) {
    const unmatched = seed.unmatched.find((row) => upper(row.code) === upper(antibioticCode))
    return {
      ok: false,
      reason: unmatched
        ? `${antibioticCode} (${unmatched.name}) has no LOINC susceptibility concept: ${unmatched.reason}`
        : `${antibioticCode} is not in the catalogue this seed was built from.`
    }
  }
  const wanted = upper(method)
  const preference = wanted === 'MIC' ? ['mic', 'plain']
    : wanted === 'DISK' || wanted === 'KB' ? ['disk', 'plain']
      : wanted === 'ETEST' || wanted === 'GRADIENT' ? ['gradient', 'mic', 'plain']
        : ['plain', 'mic', 'disk']
  const chosen = preference.find((key) => typeof binding[key] === 'string' && binding[key] !== '')
  if (!chosen) {
    return { ok: false, reason: `${antibioticCode} has no LOINC concept for method '${method}'.` }
  }
  const code = binding[chosen] as string
  return {
    ok: true,
    reason: '',
    value: { code, method: chosen, display: lookup(seed, LOINC_SYSTEM, code).value?.display ?? '' }
  }
}

/** The UCUM unit a measurement of this method is in, or empty when the method is unknown. */
export function unitFor(seed: TerminologySeed, method: string): string {
  return seed.bindings.units[upper(method)] ?? ''
}

/** What this deployment can say about its terminology, for the licences view and the IG. */
export function describeTerminology(
  seed: TerminologySeed, gate: SystemGate = ALL_SYSTEMS_ENABLED
): Array<{ url: string; name: string; concepts: number; enabled: boolean; reason: string; note: string }> {
  return seed.codeSystems.map((system) => {
    const gated = gate(system.url)
    return {
      url: system.url,
      name: system.name,
      concepts: system.concepts,
      enabled: gated.enabled,
      reason: gated.reason,
      note: system.note
    }
  })
}
