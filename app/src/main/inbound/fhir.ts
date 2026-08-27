/**
 * Inbound FHIR: a transaction or collection Bundle, checked before anything is written.
 *
 * Phase 26. This is the other half of the inbound surface, and it produces the same
 * `InboundIsolate` that `ingest.ts` produces from a v2 message — deliberately, so that
 * reconciliation, quarantine, deduplication and merge are one code path with one set of
 * rules. Two ingest paths that each decided separately what "unmapped" meant would drift, and
 * the drift would be invisible until the two disagreed about a patient.
 *
 * ## What "validated against the Phase 25 profiles" means here, exactly
 *
 * The plan says a bundle is validated against the Phase 25 profiles before anything is
 * written. There are two different things that sentence could mean and this file does the
 * one it can honestly claim:
 *
 * - **What runs here**: the constraints the profiles actually state — the fixed codes, the
 *   required cardinalities, the fixed systems — enforced in `profileFailures` below, each one
 *   traceable to a line in `fhir-ig/input/fsh/profiles.fsh`.
 * - **What does not run here**: the full HL7 StructureDefinition engine. That is the official
 *   validator, it is a Java application, and it runs in CI against the reference corpus. It
 *   is not embedded in a listener that must answer a socket in milliseconds, and this file
 *   does not claim its coverage.
 *
 * The distinction is not hedging. A receiver is entitled to know that "we validate against
 * our IG" means the stated invariants and not every derived constraint, and writing it down
 * is cheaper than a deployment discovering it.
 *
 * ## Why the checks are refusals rather than warnings
 *
 * An `Observation` with no `subject` is not a nearly-good result, it is a susceptibility
 * result attached to nobody. Everything below either identifies a patient, a specimen and an
 * organism, or it goes to quarantine.
 */

import {
  ICD_SYSTEMS, LOINC_SYSTEM, UCUM_SYSTEM, WHONET_ANTIBIOTIC_SYSTEM, type TerminologySeed
} from '../terminology'
import type { IsolateRecord } from '../../shared/types'
import type { InboundIsolate, QuarantineReason } from './ingest'
import { reconcileCode, reconcileInterpretation } from './reconcile'

/** The LOINC code the Phase 25 organism profile fixes. */
const ORGANISM_OBSERVATION_CODE = '11475-1'

type Json = Record<string, unknown>

const asObject = (value: unknown): Json | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null
const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : ''

interface Coding {
  system: string
  code: string
  display: string
}

function codings(concept: unknown): Coding[] {
  const object = asObject(concept)
  if (!object) return []
  return asArray(object.coding).map((entry) => {
    const coding = asObject(entry) ?? {}
    return {
      system: text(coding.system),
      code: text(coding.code),
      display: text(coding.display)
    }
  }).filter((coding) => coding.code)
}

function codingIn(concept: unknown, system: string): Coding | null {
  return codings(concept).find((coding) => coding.system === system) ?? null
}

/** An ISO date from a FHIR `dateTime`/`date`, or empty. Never widens a partial date. */
function isoDate(value: unknown): string {
  const raw = text(value)
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw)
  if (!match) return ''
  const [, year, month, day] = match
  const candidate = new Date(`${year}-${month}-${day}T00:00:00Z`)
  if (Number.isNaN(candidate.getTime()) || candidate.getUTCDate() !== Number(day)) return ''
  return `${year}-${month}-${day}`
}

/** `Patient/abc` or a full URL, reduced to the bare id a bundle's entries share. */
function referenceId(value: unknown): string {
  const reference = text(asObject(value)?.reference)
  if (!reference) return ''
  const trimmed = reference.split('?')[0] ?? ''
  return (trimmed.split('/').pop() ?? '').replace(/^urn:uuid:/, '')
}

/**
 * The constraints the Phase 25 profiles state, checked resource by resource.
 *
 * Each entry names the profile line it enforces, so a change to `profiles.fsh` has an obvious
 * counterpart here and the two cannot silently disagree about what the IG requires.
 */
export function profileFailures(resource: Json, index: number): QuarantineReason[] {
  const failures: QuarantineReason[] = []
  const type = text(resource.resourceType)
  const at = `Bundle.entry[${index}].resource`
  const require = (condition: boolean, kind: string, message: string): void => {
    if (!condition) failures.push({ kind, location: `${at} (${type})`, message })
  }

  if (type === 'Observation') {
    const loinc = codingIn(resource.code, LOINC_SYSTEM)
    const isOrganism = loinc?.code === ORGANISM_OBSERVATION_CODE
    // AmritSusceptibilityObservation / AmritOrganismObservation: status = #final.
    require(text(resource.status) === 'final', 'profile-violation',
      `Observation.status is "${text(resource.status) || 'absent'}"; both AMRIT Observation `
      + 'profiles fix it to "final". A preliminary or amended result is not filed: surveillance '
      + 'counts finalised results, and a preliminary one would be counted then silently revised.')
    // Both profiles: subject 1..1, specimen 1..1.
    require(Boolean(referenceId(resource.subject)), 'profile-violation',
      'Observation.subject is required by both AMRIT Observation profiles. A susceptibility '
      + 'result attached to no patient cannot be filed, counted or corrected.')
    require(Boolean(referenceId(resource.specimen)), 'profile-violation',
      'Observation.specimen is required by both AMRIT Observation profiles. Without it the '
      + 'result cannot be tied to the isolate it describes.')

    if (isOrganism) {
      // AmritOrganismObservation: valueCodeableConcept 1..1.
      require(codings(resource.valueCodeableConcept).length > 0, 'profile-violation',
        'AmritOrganismObservation requires valueCodeableConcept with a coding. An organism named '
        + 'only in free text is not a coded identification and is not promoted to one.')
    } else {
      // AmritSusceptibilityObservation: code.coding contains whonet 1..1.
      require(Boolean(codingIn(resource.code, WHONET_ANTIBIOTIC_SYSTEM)), 'profile-violation',
        `AmritSusceptibilityObservation requires a coding in ${WHONET_ANTIBIOTIC_SYSTEM}. `
        + 'A LOINC code alone does not say which agent in this catalogue was tested.')
      // AmritSusceptibilityObservation: valueQuantity.system = $ucum (exactly).
      const quantity = asObject(resource.valueQuantity)
      if (quantity) {
        require(text(quantity.system) === UCUM_SYSTEM, 'profile-violation',
          `valueQuantity.system is "${text(quantity.system) || 'absent'}"; the profile fixes it to `
          + `${UCUM_SYSTEM}. An unqualified number cannot be told apart from a zone diameter, `
          + 'which is the defect Phase 23 closed on the outbound side.')
        require(Boolean(text(quantity.code)), 'profile-violation',
          'valueQuantity.code is required: mg/L for an MIC, mm for a zone diameter. A quantity '
          + 'with no unit is a number whose meaning depends on a convention the sender did not state.')
      }
    }
  }

  if (type === 'Specimen') {
    // AmritSpecimen: type 1..1, subject 1..1.
    require(codings(resource.type).length > 0, 'profile-violation',
      'AmritSpecimen requires Specimen.type with a coding.')
    require(Boolean(referenceId(resource.subject)), 'profile-violation',
      'AmritSpecimen requires Specimen.subject.')
  }

  if (type === 'Condition') {
    // AmritCondition: subject 1..1.
    require(Boolean(referenceId(resource.subject)), 'profile-violation',
      'AmritCondition requires Condition.subject.')
  }

  return failures
}

/**
 * Read a Bundle into the same shape a v2 message produces.
 *
 * Never throws. A bundle that is not JSON, not a Bundle, or not of an accepted type returns
 * with reasons and no record, exactly as a malformed v2 message does.
 */
export function isolateFromBundle(
  bundle: unknown, seed: TerminologySeed, labCode: string
): InboundIsolate {
  const reasons: QuarantineReason[] = []
  const identity = { labCode, patientId: '', specimenNumber: '', specimenDate: '' }
  // R4's own word for it: `Observation.status = corrected` means "the result has been
  // modified subsequent to being final". The v2 path reads OBR-25/OBX-11 for the same thing.
  // Note the Phase 25 profile fixes status to `final`, so a corrected bundle fails that check
  // and is held for review rather than applied silently — which is the conservative order:
  // a human confirms a correction that would overwrite a finalised species.
  let corrected = false
  const nothing = (controlId = ''): InboundIsolate =>
    ({ record: null, reasons, identity, controlId, corrected })

  const root = asObject(bundle)
  if (!root) {
    reasons.push({ kind: 'malformed', location: 'Bundle', message: 'The payload is not a JSON object.' })
    return nothing()
  }
  if (text(root.resourceType) !== 'Bundle') {
    reasons.push({
      kind: 'malformed',
      location: 'Bundle.resourceType',
      message: `The payload is a "${text(root.resourceType) || 'resource with no resourceType'}", `
        + 'not a Bundle. This endpoint accepts a transaction or collection Bundle.'
    })
    return nothing()
  }
  const bundleType = text(root.type)
  if (bundleType !== 'transaction' && bundleType !== 'collection') {
    reasons.push({
      kind: 'unsupported-bundle',
      location: 'Bundle.type',
      message: `Bundle.type is "${bundleType || 'absent'}". This endpoint accepts "transaction" and `
        + '"collection". A searchset or history bundle is a response to a query, not a submission, '
        + 'and filing one would store another server\'s search results as observations.'
    })
    return nothing(text(root.id))
  }

  const controlId = text(root.id)
  const entries = asArray(root.entry)
  if (entries.length === 0) {
    reasons.push({ kind: 'malformed', location: 'Bundle.entry', message: 'The bundle has no entries.' })
    return nothing(controlId)
  }

  // Index by id so references resolve. `fullUrl` is what a transaction bundle uses for
  // intra-bundle references, and the resource's own id is what a collection tends to carry.
  const byId = new Map<string, Json>()
  const resources: Json[] = []
  entries.forEach((entry, index) => {
    const wrapper = asObject(entry)
    const resource = asObject(wrapper?.resource)
    if (!resource) {
      reasons.push({
        kind: 'malformed',
        location: `Bundle.entry[${index}]`,
        message: 'The entry carries no resource.'
      })
      return
    }
    resources.push(resource)
    if (text(resource.resourceType) === 'Observation' && text(resource.status) === 'corrected') {
      corrected = true
    }
    const fullUrl = text(wrapper?.fullUrl).replace(/^urn:uuid:/, '')
    const id = text(resource.id)
    if (id) byId.set(id, resource)
    if (fullUrl) byId.set(fullUrl.split('/').pop() ?? fullUrl, resource)
    reasons.push(...profileFailures(resource, index))
  })

  const of = (type: string): Json[] => resources.filter((entry) => text(entry.resourceType) === type)
  const patient = of('Patient')[0] ?? null
  const specimen = of('Specimen')[0] ?? null

  if (!patient) {
    reasons.push({
      kind: 'missing-field',
      location: 'Bundle',
      message: 'The bundle contains no Patient. A result cannot be attributed or deduplicated '
        + 'without one.'
    })
  }
  if (!specimen) {
    reasons.push({
      kind: 'missing-field',
      location: 'Bundle',
      message: 'The bundle contains no Specimen. The specimen identifier and collection date are '
        + 'what make a resend the same isolate rather than a second one.'
    })
  }

  // Patient identifier: the first identifier with a value. `Patient.id` is deliberately not
  // used as a fallback — a server-assigned resource id is not a patient's identifier in the
  // sending laboratory, and treating it as one would deduplicate against the wrong key.
  const patientId = asArray(patient?.identifier)
    .map((entry) => text(asObject(entry)?.value)).find(Boolean) ?? ''
  const specimenNumber = asArray(specimen?.identifier)
    .map((entry) => text(asObject(entry)?.value)).find(Boolean)
    ?? text(specimen?.accessionIdentifier ? asObject(specimen.accessionIdentifier)?.value : '')
  const collection = asObject(specimen?.collection)
  const specimenDate = isoDate(collection?.collectedDateTime)
    || isoDate(asObject(collection?.collectedPeriod)?.start)

  if (patient && !patientId) {
    reasons.push({
      kind: 'missing-field',
      location: 'Patient.identifier',
      message: 'The Patient carries no identifier. Patient.id is not used in its place: a resource '
        + 'id assigned by the sending server is not the identifier this laboratory knows the '
        + 'patient by, and deduplicating on it would merge the wrong records.'
    })
  }
  if (specimen && !specimenDate) {
    reasons.push({
      kind: 'missing-field',
      location: 'Specimen.collection.collectedDateTime',
      message: 'The Specimen carries no usable collection date. A partial date is refused rather '
        + 'than padded, because every surveillance output bins by date.'
    })
  }

  identity.patientId = patientId
  identity.specimenNumber = specimenNumber ?? ''
  identity.specimenDate = specimenDate

  // The organism, from the Observation the profile fixes to LOINC 11475-1.
  let organismCode = ''
  let organismName = ''
  const observations = of('Observation')
  const organismObservation = observations.find(
    (entry) => codingIn(entry.code, LOINC_SYSTEM)?.code === ORGANISM_OBSERVATION_CODE
  )
  if (!organismObservation) {
    reasons.push({
      kind: 'missing-field',
      location: 'Bundle',
      message: `No Observation carries the organism code ${ORGANISM_OBSERVATION_CODE}, which `
        + 'AmritOrganismObservation fixes. Without a species there is nothing to attribute a '
        + 'susceptibility result to.'
    })
  } else {
    const value = codings(organismObservation.valueCodeableConcept)[0]
    const reconciled = reconcileCode(seed, {
      kind: 'organism',
      code: value?.code ?? '',
      system: value?.system ?? '',
      text: value?.display ?? '',
      location: 'Observation.valueCodeableConcept'
    })
    if (reconciled.ok) {
      organismCode = reconciled.code
      organismName = reconciled.display || (value?.display ?? '')
    } else {
      reasons.push({
        kind: 'unmapped-code',
        location: 'Observation.valueCodeableConcept',
        message: reconciled.reason
      })
    }
  }

  // The specimen type.
  let specimenCode = ''
  let specimenType = ''
  const specimenCoding = codings(specimen?.type)[0]
  if (specimenCoding) {
    const reconciled = reconcileCode(seed, {
      kind: 'specimen',
      code: specimenCoding.code,
      system: specimenCoding.system,
      text: specimenCoding.display,
      location: 'Specimen.type'
    })
    if (reconciled.ok) {
      specimenCode = reconciled.code
      specimenType = reconciled.display || specimenCoding.display
    } else {
      reasons.push({ kind: 'unmapped-code', location: 'Specimen.type', message: reconciled.reason })
    }
  }

  // Susceptibility results.
  const antibioticResults: Record<string, {
    result: string; measurement: string; method: string; source: string
  }> = {}
  for (const observation of observations) {
    if (observation === organismObservation) continue
    const whonet = codingIn(observation.code, WHONET_ANTIBIOTIC_SYSTEM)
    const loinc = codingIn(observation.code, LOINC_SYSTEM)
    const chosen = whonet ?? loinc ?? codings(observation.code)[0]
    if (!chosen) continue
    const reconciled = reconcileCode(seed, {
      kind: 'antibiotic',
      code: chosen.code,
      system: chosen.system,
      text: chosen.display,
      location: 'Observation.code'
    })
    if (!reconciled.ok) {
      reasons.push({ kind: 'unmapped-code', location: 'Observation.code', message: reconciled.reason })
      continue
    }
    const quantity = asObject(observation.valueQuantity)
    const measurement = quantity && typeof quantity.value === 'number' ? String(quantity.value) : ''
    const unit = text(quantity?.code).toLowerCase()
    const interpretationCoding = codings(asArray(observation.interpretation)[0])[0]
    const interpretation = reconcileInterpretation(interpretationCoding?.code ?? '')
      || reconcileInterpretation(codings(observation.valueCodeableConcept)[0]?.code ?? '')
    const method = reconciled.method === 'mic' ? 'MIC'
      : reconciled.method === 'disk' ? 'DISK'
        : reconciled.method === 'gradient' ? 'ETEST'
          : unit === 'mm' ? 'DISK'
            : unit === 'mg/l' || unit === 'ug/ml' ? 'MIC'
              : ''
    if (!interpretation && !measurement) {
      reasons.push({
        kind: 'unusable-value',
        location: 'Observation.value[x]',
        message: `The result for ${reconciled.code} carries neither an S/I/R interpretation this `
          + 'schema stores nor a numeric value, so it is not filed.'
      })
      continue
    }
    antibioticResults[reconciled.code] = { result: interpretation, measurement, method, source: 'inbound-fhir' }
  }

  // Diagnoses. The stored system is the sender's own, which is how a deployment on ICD-11
  // keeps its ICD-11 codes rather than having them relabelled as ICD-10.
  const diagnosisCodes: string[] = []
  const diagnosisSystems: string[] = []
  for (const condition of of('Condition')) {
    for (const coding of codings(condition.code)) {
      diagnosisCodes.push(coding.code)
      diagnosisSystems.push(coding.system)
      if (coding.system && !ICD_SYSTEMS.has(coding.system)) {
        // Not a failure: a national classification is legitimate and Phase 24 stores whatever
        // system the record carries. Worth recording so a reviewer sees what arrived.
        reasons.push({
          kind: 'unrecognised-system',
          location: 'Condition.code.coding.system',
          message: `The diagnosis code "${coding.code}" is in "${coding.system}", which is neither `
            + 'ICD-10 nor ICD-11. It is stored with its own system rather than relabelled, but it '
            + 'is held for review because this deployment cannot check it against a value set.'
        })
      }
    }
  }

  if (reasons.length > 0) return nothing(controlId)

  const name = asObject(asArray(patient?.name)[0])
  const record: IsolateRecord = {
    lab_code: labCode,
    patient_id: patientId,
    specimen_number: specimenNumber ?? '',
    specimen_date: specimenDate,
    specimen_type: specimenType,
    specimen_code: specimenCode,
    organism: organismName,
    organism_code: organismCode,
    sex: text(patient?.gender) === 'male' ? 'm' : text(patient?.gender) === 'female' ? 'f' : '',
    date_of_birth: isoDate(patient?.birthDate),
    last_name: text(name?.family),
    first_name: text(asArray(name?.given)[0]),
    diagnosis_code: diagnosisCodes.join(','),
    diagnosis_system: diagnosisSystems.join(','),
    antibiotic_results: antibioticResults as IsolateRecord['antibiotic_results'],
    record_status: 'final'
  }
  return { record, reasons, identity, controlId, corrected }
}
