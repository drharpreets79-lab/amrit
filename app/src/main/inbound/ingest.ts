/**
 * From a parsed message to a record, or to the quarantine queue.
 *
 * Phase 26. `hl7v2.ts` says what the bytes are, `reconcile.ts` says what the codes mean, and
 * this file decides what happens: file it, merge it, or hold it for a human. Three rules
 * govern all of it.
 *
 * **Nothing is dropped.** A message that cannot be filed is stored verbatim in quarantine
 * with every reason it failed. The plan's wording is "a record with an unmapped organism is
 * not silently dropped", and the silent part is what makes dropping dangerous: a laboratory
 * that sent 400 results and had 40 rejected sees 360 in the list and no gap.
 *
 * **Nothing is guessed.** Every failure below names what was received and what would fix it.
 *
 * **A duplicate merges, and the merge is auditable.** The same specimen resent — because the
 * laboratory added a drug, corrected an identification, or simply retried — must not become
 * two isolates, since two isolates is two cases to every counting and detection path
 * downstream. The merge records what it changed, so "why does this record say meropenem
 * resistant when I reported susceptible" is a question the audit log answers.
 *
 * ## Why an unmapped antibiotic quarantines the whole record
 *
 * The tempting alternative is to file the isolate with the drugs that did map and note the
 * ones that did not. It is rejected here. An isolate filed with 39 of 40 results looks
 * complete to every consumer — the analytics page, the detector, the aggregate outbox — and
 * the missing one is as likely to be the carbapenem as anything else. A quarantined record is
 * visibly incomplete and someone fixes it; a partially filed one is invisibly wrong.
 *
 * Every unmapped code in the message is collected before the decision is taken, so a reviewer
 * gets one queue item listing all of them rather than discovering the next one on each retry.
 */

import type { IsolateRecord } from '../../shared/types'
import type { TerminologySeed } from '../terminology'
import {
  codedElement, component, field, firstSegment, hl7DateToIso, segmentsOf, type Hl7Message
} from './hl7v2'
import { reconcileCode, reconcileInterpretation } from './reconcile'

/** Why a message did not become a record. One per failed code, plus structural failures. */
export interface QuarantineReason {
  /** `unmapped-code`, `missing-field`, `ambiguous-mapping`, `unusable-value`. */
  kind: string
  location: string
  message: string
}

export interface InboundIsolate {
  /** Populated when the message could be reconciled completely. */
  record: IsolateRecord | null
  reasons: QuarantineReason[]
  /**
   * The sender declared this a **correction** of a result it already sent.
   *
   * This changes which existing record the message is matched against, and the distinction is
   * not cosmetic. The ordinary duplicate rule includes the organism, because one specimen
   * growing two organisms is genuinely two isolates and merging them would destroy a
   * polymicrobial culture. But a laboratory that reports *Klebsiella* on Monday and corrects it
   * to *E. coli* on Tuesday is describing one isolate, and treating that as a second one would
   * double-count a case and leave a wrong species on the record forever.
   *
   * Nothing infers this. v2 has a field for it — `OBX-11` result status `C`, and `OBR-25` at
   * the order level — so a correction is something the sender says, not something this node
   * guesses from the fact that two messages disagree.
   */
  corrected: boolean
  /** Identity used for duplicate detection, whether or not the record is fileable. */
  identity: {
    labCode: string
    patientId: string
    specimenNumber: string
    specimenDate: string
  }
  /** The sender's control id, so a quarantined item can be traced to a transmission. */
  controlId: string
}

/** How an accepted message changed the database. */
export interface IngestOutcome {
  status: 'created' | 'merged' | 'quarantined'
  isolateId: number | null
  quarantineId: number | null
  /** Field-level changes a merge applied, for the audit entry and the ACK text. */
  changes: string[]
  reasons: QuarantineReason[]
}

const text = (value: unknown): string => String(value ?? '').trim()

/**
 * Read the sex code a v2 sender uses into what this schema stores.
 *
 * HL7 Table 0001. `A` (ambiguous), `N` (not applicable), `O` (other) and `U` (unknown) all
 * become empty rather than being folded into a value the record does not mean. This is a
 * demographic field on a patient record; inventing a value for it to avoid a blank is not a
 * trade worth making.
 */
function readSex(value: string): string {
  const code = text(value).toUpperCase()
  if (code === 'M' || code === 'MALE') return 'm'
  if (code === 'F' || code === 'FEMALE') return 'f'
  return ''
}

/**
 * Turn an ORU^R01 into a candidate record plus every reason it might not be one.
 *
 * Pure: no database, no clock, no network. That is what lets the fuzz test run it over
 * millions of mutated messages and lets every branch here be reachable from a unit test.
 */
export function isolateFromMessage(
  message: Hl7Message, seed: TerminologySeed, labCode: string
): InboundIsolate {
  const reasons: QuarantineReason[] = []
  const { delimiters } = message
  const pid = firstSegment(message, 'PID')
  const pv1 = firstSegment(message, 'PV1')
  const spm = firstSegment(message, 'SPM')
  const obr = firstSegment(message, 'OBR')

  // Accepted message types. An ORU^R01 is an observation result; an ADT or an ORM is a
  // different conversation this node does not have, and answering it as though it were a
  // result would file an admission as an isolate.
  const messageType = message.messageType.split(delimiters.component).slice(0, 2).join('^')
  if (messageType && !messageType.startsWith('ORU')) {
    reasons.push({
      kind: 'unsupported-message',
      location: 'MSH-9',
      message: `This node accepts ORU^R01 observation results. The message declares "${messageType}", `
        + 'which carries different information in the same segments. It is held rather than '
        + 'interpreted as a result.'
    })
  }

  // PID-3 is the patient identifier list. PID-2 is the deprecated single id, still sent by
  // older systems, so it is accepted as a fallback rather than requiring a modern sender.
  const patientId = component(pid, 3, 1, delimiters) || field(pid, 2, delimiters)
  const specimenNumber = component(spm, 2, 1, delimiters)
    || component(spm, 3, 1, delimiters)
    || component(obr, 3, 1, delimiters)
  // SPM-17 is the collection date/time; a sender that omits it often puts it on OBR-7.
  const specimenDate = hl7DateToIso(field(spm, 17, delimiters))
    || hl7DateToIso(component(spm, 17, 1, delimiters))
    || hl7DateToIso(field(obr, 7, delimiters))

  if (!patientId) {
    reasons.push({
      kind: 'missing-field',
      location: 'PID-3',
      message: 'The message carries no patient identifier. Without one a result cannot be attributed, '
        + 'and it cannot be checked against records already held, so a resend would duplicate it.'
    })
  }
  if (!specimenDate) {
    reasons.push({
      kind: 'missing-field',
      location: 'SPM-17',
      message: 'The message carries no usable specimen collection date. Every surveillance output '
        + 'bins cases by date, so a record without one cannot be counted; a partial date such as '
        + '"202608" is refused rather than padded, because a fabricated day moves a case into an '
        + 'epidemiological week it did not occur in.'
    })
  }

  // The organism. This is the one code whose absence makes the record meaningless: an AST
  // panel with no species is a column of letters.
  let organismCode = ''
  let organismName = ''
  const organismObx = segmentsOf(message, 'OBX').find((segment) => {
    const identifier = codedElement(segment, 3, delimiters)
    return identifier.code.toUpperCase() === 'ORG'
      || identifier.alternateCode === '11475-1'
      || identifier.text.toLowerCase().includes('organism')
  })
  if (!organismObx) {
    reasons.push({
      kind: 'missing-field',
      location: 'OBX',
      message: 'No OBX identifies an organism. This node looks for OBX-3 of "ORG", the LOINC code '
        + '11475-1 in the alternate triplet, or an observation named for an organism. Without a '
        + 'species there is nothing to attribute a susceptibility result to.'
    })
  } else {
    const value = codedElement(organismObx, 5, delimiters)
    const reconciled = reconcileCode(seed, {
      kind: 'organism',
      code: value.code,
      system: value.system,
      text: value.text,
      location: `OBX[${organismObx.index}]-5`
    })
    if (reconciled.ok) {
      organismCode = reconciled.code
      organismName = reconciled.display || value.text
    } else {
      reasons.push({ kind: 'unmapped-code', location: `OBX[${organismObx.index}]-5`, message: reconciled.reason })
    }
  }

  // The specimen. Unlike the organism, a missing specimen type does not make the record
  // meaningless — the isolate is still a real result — so an absent SPM-4 is tolerated and an
  // *unmappable* one is not, because a code that means something to the sender and something
  // else here is the corruption this phase exists to prevent.
  let specimenCode = ''
  let specimenType = ''
  const specimenCoded = codedElement(spm, 4, delimiters)
  if (specimenCoded.code) {
    const reconciled = reconcileCode(seed, {
      kind: 'specimen',
      code: specimenCoded.code,
      system: specimenCoded.system,
      text: specimenCoded.text,
      location: 'SPM-4'
    })
    if (reconciled.ok) {
      specimenCode = reconciled.code
      specimenType = reconciled.display || specimenCoded.text
    } else {
      reasons.push({ kind: 'unmapped-code', location: 'SPM-4', message: reconciled.reason })
    }
  }

  // Susceptibility results: every OBX that is not the organism one.
  const antibioticResults: Record<string, {
    result: string; measurement: string; method: string; source: string
  }> = {}
  for (const obx of segmentsOf(message, 'OBX')) {
    if (obx === organismObx) continue
    const identifier = codedElement(obx, 3, delimiters)
    if (!identifier.code && !identifier.alternateCode) continue
    // The local triplet first: it is what the sender calls the drug. The alternate triplet is
    // the standard code, tried second, which is the same order the outbound exporter writes.
    const primary = reconcileCode(seed, {
      kind: 'antibiotic',
      code: identifier.code,
      system: identifier.system,
      text: identifier.text,
      location: `OBX[${obx.index}]-3`
    })
    const reconciled = primary.ok || !identifier.alternateCode
      ? primary
      : reconcileCode(seed, {
        kind: 'antibiotic',
        code: identifier.alternateCode,
        system: identifier.alternateSystem,
        text: identifier.alternateText,
        location: `OBX[${obx.index}]-3 (alternate)`
      })
    if (!reconciled.ok) {
      reasons.push({ kind: 'unmapped-code', location: `OBX[${obx.index}]-3`, message: reconciled.reason })
      continue
    }

    // OBX-8 is the abnormal-flags field and is where S/I/R belongs. Senders also put it in
    // OBX-5 as a coded value, so both are read; OBX-8 wins when they disagree, because it is
    // the field the standard defines for it.
    const interpretation = reconcileInterpretation(component(obx, 8, 1, delimiters))
      || reconcileInterpretation(component(obx, 5, 1, delimiters))
    const valueType = field(obx, 2, delimiters).toUpperCase()
    const rawValue = component(obx, 5, 1, delimiters)
    const measurement = valueType === 'NM' || /^[<>=]?\s*[0-9.]+$/.test(rawValue) ? rawValue : ''
    // OBX-6 carries the unit. It disambiguates an MIC from a zone diameter where the method
    // was not otherwise stated — `mm` is a disk diffusion and `mg/L` is an MIC — which is the
    // same distinction Phase 23 fixed on the way out.
    const unit = component(obx, 6, 1, delimiters).toLowerCase()
    const method = reconciled.method === 'mic' ? 'MIC'
      : reconciled.method === 'disk' ? 'DISK'
        : reconciled.method === 'gradient' ? 'ETEST'
          : unit === 'mm' ? 'DISK'
            : unit === 'mg/l' || unit === 'ug/ml' ? 'MIC'
              : ''

    if (!interpretation && !measurement) {
      reasons.push({
        kind: 'unusable-value',
        location: `OBX[${obx.index}]-5`,
        message: `The result for ${reconciled.code} is "${rawValue || 'empty'}"`
          + `${component(obx, 8, 1, delimiters) ? ` with flag "${component(obx, 8, 1, delimiters)}"` : ''}`
          + '. It is neither an S/I/R interpretation this schema stores nor a number, so it is not '
          + 'filed. HL7 SDD and NS are deliberately not folded into S or R: "susceptible at a '
          + 'higher dose" is not "susceptible", and recording it as one overstates the drug.'
      })
      continue
    }
    antibioticResults[reconciled.code] = {
      result: interpretation,
      measurement,
      method,
      // Marks the row's provenance so an operator can tell a typed result from a received one.
      source: 'inbound-hl7'
    }
  }

  // Diagnoses. DG1-3 is the coded element; the system in DG1-2 or the coding-system component.
  const diagnosisCodes: string[] = []
  const diagnosisSystems: string[] = []
  for (const dg1 of segmentsOf(message, 'DG1')) {
    const coded = codedElement(dg1, 3, delimiters)
    if (!coded.code) continue
    diagnosisCodes.push(coded.code)
    // The stored system is the sender's, verbatim. Phase 24's rule is that the record says
    // which classification its code came from, and rewriting a sender's system name here
    // would be this node asserting something the sender did not.
    diagnosisSystems.push(coded.system || field(dg1, 2, delimiters))
  }

  const identity = {
    labCode,
    patientId,
    specimenNumber,
    specimenDate
  }

  // OBR-25 is the order-level result status and OBX-11 the observation-level one. `C` is
  // "record coming over is a correction and thus replaces a final result". Read from either,
  // because senders differ about which level they flag, and never inferred: two messages that
  // merely disagree are not a correction, they may be two organisms from one specimen.
  const corrected = field(obr, 25, delimiters).toUpperCase() === 'C'
    || segmentsOf(message, 'OBX').some((obx) => field(obx, 11, delimiters).toUpperCase() === 'C')

  if (reasons.length > 0) {
    return { record: null, reasons, identity, controlId: message.controlId, corrected }
  }

  const record: IsolateRecord = {
    lab_code: labCode,
    patient_id: patientId,
    specimen_number: specimenNumber,
    specimen_date: specimenDate,
    specimen_type: specimenType,
    specimen_code: specimenCode,
    organism: organismName,
    organism_code: organismCode,
    sex: readSex(field(pid, 8, delimiters)),
    date_of_birth: hl7DateToIso(field(pid, 7, delimiters)),
    location: component(pv1, 3, 1, delimiters),
    location_type: component(pv1, 2, 1, delimiters).toUpperCase() === 'I' ? 'in' : 'out',
    department: component(pv1, 3, 3, delimiters),
    last_name: component(pid, 5, 1, delimiters),
    first_name: component(pid, 5, 2, delimiters),
    admission_date: hl7DateToIso(field(pv1, 44, delimiters)),
    diagnosis_code: diagnosisCodes.join(','),
    diagnosis_system: diagnosisSystems.join(','),
    antibiotic_results: antibioticResults as IsolateRecord['antibiotic_results'],
    record_status: 'final',
    // NTE segments are the sender's own notes. Kept as text, never parsed for meaning.
    notes: segmentsOf(message, 'NTE')
      .map((nte) => field(nte, 3, delimiters)).filter(Boolean).join(' | ')
  }
  return { record, reasons, identity, controlId: message.controlId, corrected }
}

/**
 * What a merge would change, field by field.
 *
 * Only *additive and corrective* changes are proposed, and the distinction matters. A field
 * the existing record has and the incoming message does not is left alone: a sender that
 * omits PV1 on a corrected result must not blank the ward. A field both carry, differing, is
 * an update the sender is entitled to make — a corrected organism identification is the
 * single commonest reason a laboratory resends — and it is recorded.
 *
 * Susceptibility results merge per drug rather than wholesale, so a resend adding one agent
 * does not delete the other thirty-nine.
 */
export function mergeChanges(
  existing: IsolateRecord, incoming: IsolateRecord
): { merged: IsolateRecord; changes: string[] } {
  const changes: string[] = []
  const merged: IsolateRecord = { ...existing }

  const scalarFields = [
    'organism', 'organism_code', 'specimen_type', 'specimen_code', 'specimen_number',
    'specimen_date', 'sex', 'date_of_birth', 'location', 'location_type', 'department',
    'last_name', 'first_name', 'admission_date', 'diagnosis_code', 'diagnosis_system', 'notes'
  ] as const

  for (const key of scalarFields) {
    const next = text(incoming[key])
    if (!next) continue
    const previous = text(existing[key])
    if (previous === next) continue
    merged[key] = next
    changes.push(previous
      ? `${key}: "${previous}" -> "${next}"`
      : `${key}: set to "${next}"`)
  }

  const previousAst = (existing.antibiotic_results ?? {}) as Record<string, Record<string, unknown>>
  const incomingAst = (incoming.antibiotic_results ?? {}) as Record<string, Record<string, unknown>>
  const mergedAst: Record<string, Record<string, unknown>> = { ...previousAst }
  for (const [code, value] of Object.entries(incomingAst)) {
    const before = previousAst[code]
    if (!before) {
      mergedAst[code] = value
      changes.push(`${code}: added ${text(value.result) || text(value.measurement)}`)
      continue
    }
    const beforeResult = text(before.result)
    const afterResult = text(value.result)
    const beforeMeasurement = text(before.measurement)
    const afterMeasurement = text(value.measurement)
    if (beforeResult === afterResult && beforeMeasurement === afterMeasurement) continue
    mergedAst[code] = { ...before, ...value }
    changes.push(`${code}: ${beforeResult || beforeMeasurement || 'blank'} -> `
      + `${afterResult || afterMeasurement || 'blank'}`)
  }
  merged.antibiotic_results = mergedAst as IsolateRecord['antibiotic_results']
  return { merged, changes }
}
