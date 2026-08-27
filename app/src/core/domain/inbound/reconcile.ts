/**
 * Turning another system's codes into this one's, or refusing to.
 *
 * Phase 26. The exit criterion is "unmapped codes quarantine rather than corrupt", and the
 * whole file is that sentence made executable. There are exactly three outcomes for an
 * incoming code and no fourth:
 *
 *   - **native** — the sender already speaks WHONET and the code is in the catalogue;
 *   - **mapped** — a Phase 22 ConceptMap relates the sender's system to WHONET, unambiguously;
 *   - **unmapped** — everything else, which quarantines with a reason a human can act on.
 *
 * There is deliberately no fuzzy match, no "closest organism by name", no defaulting to
 * *Escherichia coli* because it is the commonest. A guessed organism is a wrong resistance
 * profile attributed to the wrong species, and it is invisible: the record looks complete.
 *
 * ## The maps run backwards here, and that is the interesting part
 *
 * Phase 22 built ConceptMaps in the direction the *exporter* needs — WHONET → LOINC,
 * WHONET → SNOMED — because outbound is the direction AMRIT had. Inbound needs the inverse,
 * and an inverse is not free:
 *
 *   - **It can be ambiguous.** If two WHONET codes both map to one LOINC code, the inverse of
 *     that LOINC code is two answers, and two answers is not an answer. Those quarantine, with
 *     both candidates named, because picking one is a coin toss with a susceptibility result
 *     riding on it.
 *   - **It must not lose the method.** WHONET `MEM` maps to a different LOINC code per method,
 *     so the inverse of `18943-1` is `MEM` *and* the fact that the sender measured an MIC.
 *     That method is carried out of here, because the unit an MIC is reported in differs from
 *     the unit a zone diameter is reported in and confusing them silently changes the number's
 *     meaning.
 *
 * The inverse is built once from the same seed the exporter reads, so the two directions
 * cannot drift apart: there is one table, read forwards by `services.ts` and backwards here.
 */

import {
  LOINC_SYSTEM, SNOMED_SYSTEM, WHONET_ANTIBIOTIC_SYSTEM, WHONET_ORGANISM_SYSTEM,
  WHONET_SPECIMEN_SYSTEM, lookup, type TerminologySeed
} from '../../../main/terminology'

/** What kind of thing a code is naming. Determines which map is consulted. */
export type CodeKind = 'organism' | 'antibiotic' | 'specimen'

export interface IncomingCode {
  kind: CodeKind
  /** The identifier as sent. */
  code: string
  /** The sender's coding-system name, from a CWE's component 3 — often local, often absent. */
  system: string
  /** The sender's own text for the code, kept for the quarantine reviewer. */
  text: string
  /** Where in the message this came from, for a reviewer: `OBX[3]-3`. */
  location: string
}

export interface Reconciliation {
  ok: boolean
  /** The WHONET code, when `ok`. Never populated on a failure — there is no partial answer. */
  code: string
  display: string
  how: 'native' | 'mapped' | ''
  /**
   * The measurement method the mapping implied, for an antibiotic identified by a
   * method-specific LOINC code: `mic`, `disk`, `gradient`. Empty when the sender's code says
   * nothing about method.
   */
  method: string
  /** Empty when `ok`; otherwise a sentence naming what a human must do. */
  reason: string
}

/**
 * Coding-system names that mean "this is a WHONET code".
 *
 * v2 senders write the system as a short local name rather than a URI. `L` is the standard's
 * own marker for a local coding system and is what this product's own exporter emits, so
 * accepting it is how AMRIT reads its own output. `99WHO` follows v2's `99zzz` convention for
 * locally defined systems.
 */
const normalise = (value: unknown): string => String(value ?? '').trim().toUpperCase()

/**
 * Every name is upper-cased through `normalise`, because every comparison against these sets
 * is.
 *
 * The URI constants are lower-case. Leaving them so meant a FHIR bundle using the canonical
 * `urn:whonet:organism-code` — which is exactly what the Phase 25 profiles require and what
 * AMRIT's own exporter writes — did not match, and quarantined as an unmapped code. The
 * product could not read its own bundles, and the failure looked like a mapping gap rather
 * than like a case-sensitivity bug.
 */
const upperSet = (...names: string[]): ReadonlySet<string> => new Set(names.map(normalise))

const WHONET_SYSTEM_NAMES = upperSet(
  'WHONET', 'L', '99WHONET', '99WHO', 'AMRIT',
  WHONET_ANTIBIOTIC_SYSTEM, WHONET_ORGANISM_SYSTEM, WHONET_SPECIMEN_SYSTEM
)

/** Names a sender may use for LOINC and SNOMED, including the v2 table abbreviations. */
const LOINC_NAMES = upperSet('LN', 'LOINC', LOINC_SYSTEM)
const SNOMED_NAMES = upperSet('SCT', 'SNM', 'SNOMED', 'SNOMEDCT', SNOMED_SYSTEM)

/** The WHONET system URL a kind of code lives in. */
function nativeSystemFor(kind: CodeKind): string {
  if (kind === 'organism') return WHONET_ORGANISM_SYSTEM
  if (kind === 'specimen') return WHONET_SPECIMEN_SYSTEM
  return WHONET_ANTIBIOTIC_SYSTEM
}

/** The ConceptMap that relates a kind of code to a foreign system. */
function mapIdFor(kind: CodeKind): string {
  if (kind === 'organism') return 'amrit-organism-to-snomed'
  if (kind === 'specimen') return 'amrit-specimen-to-snomed'
  return 'amrit-antibiotic-to-loinc'
}

interface InverseEntry {
  /** WHONET codes this foreign code maps back to. More than one means ambiguous. */
  sources: string[]
  /** The relationship the forward map recorded, e.g. `mic` — the method, for antibiotics. */
  relationship: string
}

interface InverseMap {
  targetSystem: string
  /** foreign code -> what it came from. */
  byCode: Map<string, InverseEntry>
}

/**
 * ConceptMap id -> its inverse.
 *
 * Keyed by **map**, not by target system, and that is a correctness requirement rather than a
 * structural preference. `amrit-organism-to-snomed` and `amrit-specimen-to-snomed` both target
 * SNOMED, so a single index keyed by target system would put organism concepts and specimen
 * concepts in one bucket — and an inbound SNOMED specimen code could then resolve to an
 * organism, filing a blood culture as a species. Each map is inverted into its own table and
 * only the map for the kind of code being reconciled is consulted.
 */
type InverseIndex = Map<string, InverseMap>

const inverseCache = new WeakMap<TerminologySeed, InverseIndex>()

/**
 * Invert every ConceptMap in the seed, once per seed.
 *
 * Cached against the seed object rather than rebuilt per message: a 264-antibiotic map
 * inverted on every inbound OBX would be the listener's hot path, and the seed is immutable
 * once loaded.
 */
export function inverseIndex(seed: TerminologySeed): InverseIndex {
  const cached = inverseCache.get(seed)
  if (cached) return cached

  const index: InverseIndex = new Map()
  for (const map of seed.conceptMaps) {
    const inverted: InverseMap = { targetSystem: map.targetSystem, byCode: new Map() }
    index.set(map.id, inverted)
    for (const element of map.elements) {
      for (const [relationship, target] of Object.entries(element.targets)) {
        const key = normalise(target)
        if (!key) continue
        const existing = inverted.byCode.get(key)
        if (!existing) {
          inverted.byCode.set(key, { sources: [element.source], relationship })
          continue
        }
        // A second WHONET code arriving at the same foreign code is the ambiguity this
        // structure exists to record rather than resolve.
        if (!existing.sources.includes(element.source)) existing.sources.push(element.source)
      }
    }
  }
  inverseCache.set(seed, index)
  return index
}

/**
 * Which foreign system a sender's system name refers to, or empty if this node has no idea.
 *
 * "No idea" is a real and common answer — a laboratory information system usually sends its
 * own internal codes under its own name — and it is not an error here. It is the reason
 * quarantine exists.
 */
function resolveSystem(system: string): string {
  const name = normalise(system)
  if (LOINC_NAMES.has(name)) return LOINC_SYSTEM
  if (SNOMED_NAMES.has(name)) return SNOMED_SYSTEM
  return ''
}

/**
 * Reconcile one incoming code to the WHONET code space.
 *
 * Never throws and never guesses. The `reason` on a failure is written for the person who
 * will open the quarantine queue, so it says what was received and what would fix it, not
 * that a lookup returned null.
 */
export function reconcileCode(seed: TerminologySeed, incoming: IncomingCode): Reconciliation {
  const failure = (reason: string): Reconciliation =>
    ({ ok: false, code: '', display: '', how: '', method: '', reason })

  const code = String(incoming.code ?? '').trim()
  if (!code) {
    return failure(`${incoming.location} carries no ${incoming.kind} code`
      + `${incoming.text ? ` (the sender's text was "${incoming.text}")` : ''}. A record cannot be `
      + 'filed against a blank code, and the sender\'s free text is not promoted to one.')
  }

  const nativeSystem = nativeSystemFor(incoming.kind)
  const senderSystem = normalise(incoming.system)

  // 1. The sender already speaks WHONET. Still verified against the catalogue: a system name
  //    saying "WHONET" does not make the code one, and an unrecognised code claiming to be
  //    native is exactly as unfileable as an unrecognised foreign one.
  if (!senderSystem || WHONET_SYSTEM_NAMES.has(senderSystem)) {
    const found = lookup(seed, nativeSystem, code.toUpperCase())
    if (found.ok) {
      return {
        ok: true, code: code.toUpperCase(), display: found.value?.display ?? '',
        how: 'native', method: '', reason: ''
      }
    }
    if (senderSystem) {
      return failure(`${incoming.location} sends ${incoming.kind} code "${code}" as a WHONET code `
        + `(system "${incoming.system}"), and this deployment's catalogue has no such code. `
        + `The sender's text was "${incoming.text || 'none'}". Either the code is a typo, or this `
        + 'catalogue needs the entry added in Master Studio before the record can be filed.')
    }
    // No system named at all: fall through and try the maps before giving up, because a
    // sender that omits the system may still be sending a LOINC or SNOMED identifier.
  }

  // 2. A system this node knows, mapped through the inverted Phase 22 ConceptMap **for this
  //    kind of code**. Consulting only that map is what stops a SNOMED specimen concept
  //    resolving to an organism, since both maps target SNOMED.
  const foreignSystem = resolveSystem(incoming.system)
  const inverted = inverseIndex(seed).get(mapIdFor(incoming.kind))
  // A sender that names a system this node recognises must name the one this map targets. A
  // LOINC code offered as an organism is not looked up in the organism map at all: it is
  // unmapped, which is the truth, rather than a miss that reads like an unknown code.
  const systemAgrees = !foreignSystem || !inverted || foreignSystem === inverted.targetSystem
  const entry = systemAgrees ? inverted?.byCode.get(normalise(code)) : undefined
  if (entry) {
    if (entry.sources.length > 1) {
      return failure(`${incoming.location} sends ${incoming.kind} code "${code}" in `
        + `${inverted?.targetSystem}, which this deployment's ConceptMap relates to `
        + `${entry.sources.length} different WHONET codes (${entry.sources.slice(0, 6).join(', ')}). `
        + 'The mapping is ambiguous in this direction, so no code is chosen. A reviewer must say '
        + 'which one the sender means, or the sender must send the WHONET code directly.')
    }
    const source = entry.sources[0] as string
    const found = lookup(seed, nativeSystem, source)
    return {
      ok: true,
      code: source,
      display: found.value?.display ?? '',
      how: 'mapped',
      // Only meaningful for antibiotics, whose forward map keys targets by method. `equivalent`
      // is the organism and specimen maps' relationship and says nothing about method.
      method: incoming.kind === 'antibiotic' && entry.relationship !== 'equivalent'
        ? entry.relationship
        : '',
      reason: ''
    }
  }

  // 3. Unmapped. Named precisely, because "could not map code" sends a reviewer to read the
  //    raw message and this sends them to the mapping table.
  const systemText = incoming.system
    ? `coding system "${incoming.system}"`
    : 'no coding system (the sender left the CWE\'s third component empty)'
  return failure(`${incoming.location} sends ${incoming.kind} code "${code}" in ${systemText}`
    + `${incoming.text ? `, described as "${incoming.text}"` : ''}. This deployment has no mapping `
    + `from that system to its ${incoming.kind} codes, so the code is not translated and not `
    + 'guessed. Add the mapping, or ask the sending system to send WHONET codes'
    + `${foreignSystem ? '' : ', or to name its coding system so a mapping can be written for it'}.`)
}

/** An S/I/R interpretation as this codebase stores it, or empty if the sender said something else. */
export function reconcileInterpretation(value: string): '' | 'S' | 'I' | 'R' {
  const text = normalise(value)
  if (!text) return ''
  // HL7 Table 0078. `SDD` (susceptible dose-dependent) and `NS` (non-susceptible) are real
  // values this schema has no column for; they are deliberately not folded into S or R, since
  // "susceptible at a higher dose" is not "susceptible" and mapping it there would overstate
  // the drug's usefulness. They return empty and the raw value quarantines.
  if (text === 'S' || text === 'SUSCEPTIBLE') return 'S'
  if (text === 'I' || text === 'INTERMEDIATE') return 'I'
  if (text === 'R' || text === 'RESISTANT') return 'R'
  return ''
}
