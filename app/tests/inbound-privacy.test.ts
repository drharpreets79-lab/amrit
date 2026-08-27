// @vitest-environment node

/**
 * Phase 26 — the privacy boundary, and the quarantine queue against a real database.
 *
 * The plan's exit criterion is "the aggregate outbox is unchanged, proven by the existing PII
 * guard tests". Those tests live on the server and police what the outbox may carry. This file
 * discharges the desktop half of the same claim, and it does it structurally rather than by
 * inspection: inbound patient-level data must land in the local node and reach the federation
 * outbox by no path at all.
 *
 * The distinction matters because "we checked and it does not leak" decays. A future change
 * that made the inbound service enqueue would pass a test that only sampled outbox contents on
 * today's fixtures. Asserting that the outbox is *untouched* by a full inbound cycle — and that
 * the module graph contains no reference from the inbound path to the outbox at all — is a
 * claim that keeps holding.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AMRITDatabase } from '../src/main/database'
import { InboundService, parseHl7Message } from '../src/main/inbound'
import { loadTerminologySeed } from '../src/main/terminology'

const seed = loadTerminologySeed()
const LAB = 'LAB01'
const CREDENTIAL = 'a-shared-secret-of-sufficient-length'
const here = path.dirname(fileURLToPath(import.meta.url))

const message = (
  options: { organism?: string; system?: string; control?: string; status?: string } = {}
): string => {
  const { organism = 'KPN', system = 'WHONET', control = 'MSG1', status = 'F' } = options
  return [
    `MSH|^~\\&|LIS|CITYLAB|AMRIT|${LAB}|20260114093000|${CREDENTIAL}|ORU^R01|${control}|P|2.5.1`,
    'PID|1||P-9001||Devi^Anita||19850302|F',
    'PV1|1|I|ICU-2^^Critical Care',
    'SPM|1|SP-31|SP-31|BLOOD_STERILE^Blood^WHONET|||||||||||||20260114',
    'OBR|1|SP-31|MSG1|MICRO^Microbiology^L|||20260114',
    `OBX|1|CWE|ORG^Organism identified^L||${organism}^Klebsiella pneumoniae^${system}||||||${status}`,
    'OBX|2|NM|MEM^Meropenem^WHONET||8|mg/L||R|||F'
  ].join('\r') + '\r'
}

describe('inbound data lands in the local node and reaches the outbox by no path', () => {
  let directory = ''
  let database: AMRITDatabase

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'amrit-inbound-'))
    database = new AMRITDatabase(path.join(directory, 'amrit.sqlite')).initialize()
    database.saveLab({ code: LAB, name: 'City Laboratory', country: 'India' })
    database.selectLab(LAB)
    // The catalogue's own names, which are also the terminology seed's displays — the seed is
    // generated from this catalogue, so a real deployment's masters and the codes reconciliation
    // resolves to always agree. Inventing shorter names here would make the fixture disagree
    // with the product and test nothing real.
    database.saveMaster('samples', { code: 'BLOOD_STERILE', name: 'Blood / normally sterile fluid' })
    database.saveMaster('organisms', { code: 'KPN', organism_name: 'Klebsiella pneumoniae complex' })
    database.saveMaster('organisms', { code: 'ECO', organism_name: 'Escherichia coli' })
  })

  afterEach(() => {
    database.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('leaves the federation outbox empty after a full inbound cycle', () => {
    const service = new InboundService({ labCode: LAB, store: database, seed })
    const raw = message()
    const outcome = service.acceptHl7(parseHl7Message(raw), raw, '127.0.0.1')
    expect(outcome.status).toBe('created')

    // The isolate is here — this is the local node and that is where patient-level data lives.
    const stored = database.listRecords({ lab_code: LAB })
    expect(stored).toHaveLength(1)
    expect(stored[0]?.patient_id).toBe('P-9001')

    // And the outbox has not been touched. Not "carries no PII" — carries nothing.
    const outbox = database.rawConnectionForTesting()
      .prepare('SELECT COUNT(*) AS total FROM national_outbox').get() as { total: number }
    expect(outbox.total).toBe(0)
  })

  it('does not reach the outbox even from the module graph', () => {
    // A static check, because a runtime one only proves the paths the test happened to take.
    // Nothing under src/main/inbound may name the outbox or the enqueue that writes to it.
    const files = ['index.ts', 'ingest.ts', 'fhir.ts', 'hl7v2.ts', 'mllp.ts', 'reconcile.ts']
    for (const file of files) {
      const source = readFileSync(path.join(here, '..', 'src', 'main', 'inbound', file), 'utf8')
      // Comments explain the boundary, so strip them before looking for a real reference.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      expect(code).not.toMatch(/national_outbox|enqueueOneHealth|enqueue\(/)
    }
  })
})

describe('the quarantine queue, against a real database', () => {
  let directory = ''
  let database: AMRITDatabase

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'amrit-quarantine-'))
    database = new AMRITDatabase(path.join(directory, 'amrit.sqlite')).initialize()
    database.saveLab({ code: LAB, name: 'City Laboratory', country: 'India' })
    database.selectLab(LAB)
    // The catalogue's own names, which are also the terminology seed's displays — the seed is
    // generated from this catalogue, so a real deployment's masters and the codes reconciliation
    // resolves to always agree. Inventing shorter names here would make the fixture disagree
    // with the product and test nothing real.
    database.saveMaster('samples', { code: 'BLOOD_STERILE', name: 'Blood / normally sterile fluid' })
    database.saveMaster('organisms', { code: 'KPN', organism_name: 'Klebsiella pneumoniae complex' })
    database.saveMaster('organisms', { code: 'ECO', organism_name: 'Escherichia coli' })
  })

  afterEach(() => {
    database.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('holds an unmappable message with its payload and every reason', () => {
    const service = new InboundService({ labCode: LAB, store: database, seed })
    const raw = message({ organism: 'XX99', system: 'CITYLAB-LOCAL' })
    const outcome = service.acceptHl7(parseHl7Message(raw), raw, '10.0.0.9')

    expect(outcome.status).toBe('quarantined')
    expect(database.listRecords({ lab_code: LAB })).toHaveLength(0)

    const held = database.listInboundQuarantine(LAB)
    expect(held).toHaveLength(1)
    expect(held[0]?.transport).toBe('hl7v2')
    expect(held[0]?.receivedFrom).toBe('10.0.0.9')
    expect(held[0]?.patientId).toBe('P-9001')
    expect(held[0]?.reasons[0]?.kind).toBe('unmapped-code')
    // Verbatim, because the reviewer's job is to work out what the sender meant and a summary
    // is this node's interpretation of exactly the thing it could not interpret.
    expect(database.inboundQuarantinePayload(Number(held[0]?.id))).toBe(raw)
  })

  it('keeps a resolved item rather than deleting it', () => {
    const service = new InboundService({ labCode: LAB, store: database, seed })
    const raw = message({ organism: 'XX99', system: 'CITYLAB-LOCAL' })
    service.acceptHl7(parseHl7Message(raw), raw, '10.0.0.9')
    const id = Number(database.listInboundQuarantine(LAB)[0]?.id)

    database.resolveInboundQuarantine(id, 'resolved', 'Added the mapping in Master Studio.')
    // Gone from the queue a human works through...
    expect(database.listInboundQuarantine(LAB, 'held')).toHaveLength(0)
    // ...but still on record. A held message is the evidence that justified adding the
    // mapping; deleting it on resolution erases the reason the mapping exists.
    expect(database.listInboundQuarantine(LAB, 'resolved')).toHaveLength(1)
    expect(database.listAudit(50).some((row) => row.operation === 'inbound.quarantine.resolved'))
      .toBe(true)
  })

  it('merges a duplicate arrival in the database and writes what changed', () => {
    const service = new InboundService({ labCode: LAB, store: database, seed })
    const first = message()
    service.acceptHl7(parseHl7Message(first), first, '127.0.0.1')
    // OBX-11 of `C`: the sender declaring this a correction, not a second organism.
    const corrected = message({ organism: 'ECO', control: 'MSG2', status: 'C' })
    const outcome = service.acceptHl7(parseHl7Message(corrected), corrected, '127.0.0.1')

    expect(outcome.status).toBe('merged')
    // One isolate, not two. Two would be two cases to every counting and detection path.
    const stored = database.listRecords({ lab_code: LAB })
    expect(stored).toHaveLength(1)
    expect(stored[0]?.organism_code).toBe('ECO')

    const audit = database.listAudit(50).find((row) => row.operation === 'inbound.merge')
    expect(audit).toBeDefined()
    expect(JSON.stringify(audit?.details)).toContain('organism_code')
  })
})
