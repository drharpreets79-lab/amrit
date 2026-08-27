/**
 * The inbound service: what actually happens to a message that arrives.
 *
 * Phase 26. `mllp.ts` owns the socket, `hl7v2.ts` and `fhir.ts` own the formats,
 * `reconcile.ts` owns the codes, `ingest.ts` owns the shape. This file owns the decision and
 * the write, and it is the only place in the inbound path that touches the database.
 *
 * ## The privacy boundary does not move
 *
 * Inbound patient-level data lands in the **local node only**. Nothing here writes to the
 * federation outbox, and nothing here can: the outbox is built from aggregates by a separate
 * path that `pii_guard.py` polices, and this service has no reference to it. The plan lists
 * "aggregate outbox unchanged, proven by the existing PII guard tests" as an exit criterion,
 * and the proof is structural — there is no code path from here to there — rather than a
 * promise. `inbound-privacy.test.ts` asserts it rather than trusting the paragraph.
 *
 * ## Why the store is an interface rather than the database class
 *
 * `InboundStore` is the four operations this service needs. `AmritDatabase` satisfies it
 * structurally, and so does a fake in a test. That is not ceremony: it means the merge rules,
 * the quarantine rules and the audit content are all testable without a SQLite file, which is
 * what makes it practical to test the cases that matter — the second arrival of the same
 * specimen, the arrival that corrects an organism — instead of only the happy path.
 */

import type { IsolateRecord } from '../../shared/types'
import { loadTerminologySeed, type TerminologySeed } from '../terminology'
import { isolateFromBundle } from './fhir'
import { isolateFromMessage, mergeChanges, type IngestOutcome, type InboundIsolate, type QuarantineReason } from './ingest'
import { type Hl7Message } from './hl7v2'
import type { InboundResult } from './mllp'

export * from './hl7v2'
export * from './mllp'
export * from './reconcile'
export * from './ingest'
export { isolateFromBundle, profileFailures } from './fhir'

/** One item held for a human. Stored verbatim: the reviewer needs the message, not a summary. */
export interface QuarantineItem {
  id?: number
  labCode: string
  /** `hl7v2` or `fhir`. */
  transport: string
  /** The sender's message control id or Bundle.id, for tracing a complaint to a transmission. */
  controlId: string
  /** The message exactly as received. */
  payload: string
  reasons: QuarantineReason[]
  patientId: string
  specimenNumber: string
  specimenDate: string
  receivedFrom: string
  receivedAt?: string
  status?: 'held' | 'resolved' | 'discarded'
}

/** What this service needs from the database, and nothing more. */
export interface InboundStore {
  findDuplicate(record: IsolateRecord): IsolateRecord | null
  /**
   * The record for this patient, specimen and date, whatever organism it names.
   *
   * Used **only** for a message the sender flagged as a correction. `findDuplicate` includes
   * the organism, which is right for ordinary traffic — one specimen growing two organisms is
   * two isolates — and wrong for a corrected identification, which is one isolate whose species
   * changed. Splitting the two lookups is what lets both be correct at once.
   */
  findByIdentity(
    labCode: string, patientId: string, specimenNumber: string, specimenDate: string
  ): IsolateRecord | null
  saveRecord(record: IsolateRecord): { id: number; alerts: unknown[]; comments: unknown[] }
  quarantineInbound(item: QuarantineItem): number
  recordAudit(
    operation: string, status: 'ok' | 'error' | 'warning', summary: string,
    details?: Record<string, unknown>, actor?: string
  ): void
}

export interface InboundServiceOptions {
  labCode: string
  store: InboundStore
  seed?: TerminologySeed
}

export class InboundService {
  private readonly seed: TerminologySeed

  constructor(private readonly options: InboundServiceOptions) {
    this.seed = options.seed ?? loadTerminologySeed()
  }

  /** An HL7 v2 message that has already been parsed and authenticated by the listener. */
  acceptHl7(message: Hl7Message, raw: string, peer: string): IngestOutcome {
    return this.file(
      isolateFromMessage(message, this.seed, this.options.labCode), raw, 'hl7v2', peer
    )
  }

  /** A FHIR Bundle from the HTTP endpoint. */
  acceptBundle(bundle: unknown, raw: string, peer: string): IngestOutcome {
    return this.file(
      isolateFromBundle(bundle, this.seed, this.options.labCode), raw, 'fhir', peer
    )
  }

  /**
   * File, merge, or quarantine.
   *
   * The order is deliberate: quarantine is checked first, so a message that cannot be
   * reconciled is never partially written and then rolled back. A half-written isolate that a
   * later failure removes is a record that existed, was counted by anything watching, and then
   * did not.
   */
  private file(
    candidate: InboundIsolate, raw: string, transport: string, peer: string
  ): IngestOutcome {
    if (!candidate.record || candidate.reasons.length > 0) {
      const quarantineId = this.options.store.quarantineInbound({
        labCode: this.options.labCode,
        transport,
        controlId: candidate.controlId,
        payload: raw,
        reasons: candidate.reasons,
        patientId: candidate.identity.patientId,
        specimenNumber: candidate.identity.specimenNumber,
        specimenDate: candidate.identity.specimenDate,
        receivedFrom: peer,
        status: 'held'
      })
      this.options.store.recordAudit(
        'inbound.quarantine', 'warning',
        `${transport} message ${candidate.controlId || '(no control id)'} held for review`,
        {
          quarantineId,
          peer,
          reasons: candidate.reasons.map((reason) => `${reason.location}: ${reason.message}`)
        },
        `inbound:${peer}`
      )
      return {
        status: 'quarantined',
        isolateId: null,
        quarantineId,
        changes: [],
        reasons: candidate.reasons
      }
    }

    // A correction is matched on identity alone; everything else on the full duplicate rule.
    const existing = candidate.corrected
      ? this.options.store.findByIdentity(
        this.options.labCode, candidate.identity.patientId,
        candidate.identity.specimenNumber, candidate.identity.specimenDate)
        ?? this.options.store.findDuplicate(candidate.record)
      : this.options.store.findDuplicate(candidate.record)
    if (!existing) {
      const saved = this.options.store.saveRecord(candidate.record)
      this.options.store.recordAudit(
        'inbound.create', 'ok', `Isolate ${saved.id} from ${transport} ${candidate.controlId}`,
        { peer, organism: candidate.record.organism_code, transport },
        `inbound:${peer}`
      )
      return { status: 'created', isolateId: saved.id, quarantineId: null, changes: [], reasons: [] }
    }

    const { merged, changes } = mergeChanges(existing, candidate.record)
    // A resend that changes nothing is still recorded, because "the laboratory sent it twice"
    // and "we lost one" look identical in a database that only logs writes.
    if (changes.length === 0) {
      this.options.store.recordAudit(
        'inbound.duplicate', 'ok',
        `Isolate ${existing.id} received again from ${transport} ${candidate.controlId}, no change`,
        { peer, transport }, `inbound:${peer}`
      )
      return {
        status: 'merged', isolateId: Number(existing.id), quarantineId: null, changes: [], reasons: []
      }
    }

    // `replace_antibiotic_results` is set because `mergeChanges` has already done the merge and
    // owns the result. Letting `saveRecord` merge again would union this file's decision with
    // the database's own rule, and two merge rules on one write is how a deleted result comes
    // back.
    const saved = this.options.store.saveRecord({
      ...merged,
      id: existing.id,
      replace_antibiotic_results: true
    } as IsolateRecord)
    this.options.store.recordAudit(
      'inbound.merge', 'ok',
      `Isolate ${saved.id} merged from ${transport} ${candidate.controlId}`,
      { peer, transport, changes, controlId: candidate.controlId, corrected: candidate.corrected },
      `inbound:${peer}`
    )
    return { status: 'merged', isolateId: saved.id, quarantineId: null, changes, reasons: [] }
  }

  /**
   * The acknowledgement text for an outcome.
   *
   * A quarantined message gets `AE`, not `AR`. The distinction is real to a sending system:
   * `AR` means "rejected, do not resend", and `AE` means "an error occurred" — which is the
   * truth, because a quarantined message is one a human may release, and telling the sender to
   * forget it would lose the correction they are about to make.
   */
  static acknowledge(outcome: IngestOutcome, controlId: string): InboundResult {
    if (outcome.status === 'quarantined') {
      const first = outcome.reasons[0]
      return {
        acknowledgement: 'AE',
        text: `Held for review (${outcome.reasons.length} issue`
          + `${outcome.reasons.length === 1 ? '' : 's'})`
          + `${first ? `: ${first.location} ${first.message}` : ''}`,
        controlId
      }
    }
    if (outcome.status === 'merged') {
      return {
        acknowledgement: 'AA',
        text: outcome.changes.length === 0
          ? `Already held as isolate ${outcome.isolateId}; no change.`
          : `Merged into isolate ${outcome.isolateId}: ${outcome.changes.slice(0, 5).join('; ')}`,
        controlId
      }
    }
    return { acknowledgement: 'AA', text: `Filed as isolate ${outcome.isolateId}.`, controlId }
  }
}
