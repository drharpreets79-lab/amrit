/**
 * Phase 26 — the inbound listener, the parser, and what they refuse.
 *
 * This file is organised around the phase's exit criteria rather than around the modules,
 * because the criteria are the claims and a test that does not map to a claim is decoration.
 * Each `describe` names the criterion it discharges.
 *
 * The negative tests carry the weight. An inbound path that files a plausible record from a
 * message it did not understand is worse than no inbound path, because the wrong record is
 * indistinguishable from a right one once it is in the database.
 */

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_LISTENER_CONFIG, InboundService, MllpFramer, MllpListener, buildAck, credentialMatches,
  decodeEscapes, frame, hl7DateToIso, isolateFromBundle, isolateFromMessage, mergeChanges,
  parseHl7Message, profileFailures, reconcileCode, type InboundStore, type QuarantineItem
} from '../src/main/inbound'
import { buildHl7Batch } from '../src/main/services'
import { loadTerminologySeed } from '../src/main/terminology'
import type { IsolateRecord, Laboratory } from '../src/shared/types'

const seed = loadTerminologySeed()
const LAB = 'LAB01'
const CREDENTIAL = 'a-shared-secret-of-sufficient-length'

/** A realistic ORU^R01 from a laboratory information system that is not AMRIT. */
function oruMessage(overrides: {
  patientId?: string
  specimen?: string
  date?: string
  organism?: string
  organismSystem?: string
  organismStatus?: string
  results?: string[]
  credential?: string
  controlId?: string
  type?: string
} = {}): string {
  const {
    patientId = 'P-1001', specimen = 'SP-77', date = '20260114', organism = 'KPN',
    organismSystem = 'WHONET', organismStatus = 'F', credential = CREDENTIAL, controlId = 'MSG0001',
    type = 'ORU^R01', results = [
      'OBX|2|NM|MEM^Meropenem susceptibility^WHONET||8|mg/L||R|||F',
      'OBX|3|NM|CIP^Ciprofloxacin susceptibility^WHONET||22|mm||S|||F'
    ]
  } = overrides
  return [
    `MSH|^~\\&|LIS|CITYLAB|AMRIT|${LAB}|20260114093000|${credential}|${type}|${controlId}|P|2.5.1`,
    `PID|1||${patientId}||Devi^Anita||19850302|F`,
    'PV1|1|I|ICU-2^^Critical Care',
    `SPM|1|${specimen}|${specimen}|BLOOD_STERILE^Blood^WHONET|||||||||||||${date}`,
    `OBR|1|${specimen}|${controlId}|MICRO^Microbiology^L|||${date}`,
    `OBX|1|CWE|ORG^Organism identified^L||${organism}^Klebsiella pneumoniae^${organismSystem}||||||${organismStatus}`,
    ...results
  ].join('\r') + '\r'
}

/** An in-memory store, so merge and quarantine rules are testable without a SQLite file. */
class FakeStore implements InboundStore {
  records: IsolateRecord[] = []
  quarantined: QuarantineItem[] = []
  audit: Array<{ operation: string; status: string; summary: string; details?: Record<string, unknown> }> = []
  private nextId = 1

  findDuplicate(record: IsolateRecord): IsolateRecord | null {
    // Mirrors the database's rule, organism included: one specimen growing two organisms is
    // two isolates, and a fake that ignored species would let a merge test pass against a
    // rule the product does not have.
    return this.records.find((held) =>
      held.lab_code === record.lab_code
      && held.patient_id === record.patient_id
      && held.specimen_number === record.specimen_number
      && held.organism_code === record.organism_code
      && held.id !== record.id) ?? null
  }

  findByIdentity(
    labCode: string, patientId: string, specimenNumber: string, specimenDate: string
  ): IsolateRecord | null {
    if (!labCode || !patientId || !specimenNumber || !specimenDate) return null
    return this.records.find((held) =>
      held.lab_code === labCode
      && held.patient_id === patientId
      && held.specimen_number === specimenNumber
      && held.specimen_date === specimenDate) ?? null
  }

  saveRecord(record: IsolateRecord): { id: number; alerts: unknown[]; comments: unknown[] } {
    if (record.id) {
      const index = this.records.findIndex((held) => held.id === record.id)
      this.records[index] = { ...record }
      return { id: Number(record.id), alerts: [], comments: [] }
    }
    const id = this.nextId++
    this.records.push({ ...record, id })
    return { id, alerts: [], comments: [] }
  }

  quarantineInbound(item: QuarantineItem): number {
    const id = this.quarantined.length + 1
    this.quarantined.push({ ...item, id })
    return id
  }

  recordAudit(
    operation: string, status: 'ok' | 'error' | 'warning', summary: string,
    details?: Record<string, unknown>
  ): void {
    this.audit.push({ operation, status, summary, details })
  }
}

const serviceWith = (): { service: InboundService; store: FakeStore } => {
  const store = new FakeStore()
  return { service: new InboundService({ labCode: LAB, store, seed }), store }
}

describe('a simulated LIS sends an ORU^R01 and the isolate appears with correct interpretation', () => {
  it('files the record, the organism and both susceptibility results', () => {
    const { service, store } = serviceWith()
    const raw = oruMessage()
    const outcome = service.acceptHl7(parseHl7Message(raw), raw, '127.0.0.1')

    expect(outcome.status).toBe('created')
    const record = store.records[0]
    expect(record?.patient_id).toBe('P-1001')
    expect(record?.organism_code).toBe('KPN')
    expect(record?.specimen_date).toBe('2026-01-14')
    const results = record?.antibiotic_results as Record<string, Record<string, string>>
    // The interpretation is the point: R must arrive as R, not as the string "R" in a value
    // field nobody reads, and not silently dropped because OBX-8 was where it lived.
    expect(results.MEM?.result).toBe('R')
    expect(results.CIP?.result).toBe('S')
    expect(results.MEM?.measurement).toBe('8')
    // OBX-6 disambiguates an MIC from a zone diameter, which is the same distinction Phase 23
    // fixed on the way out. mg/L is an MIC; mm is a disk diffusion.
    expect(results.MEM?.method).toBe('MIC')
    expect(results.CIP?.method).toBe('DISK')
  })

  it('reads AMRIT\'s own exported ORU back, which is the cheapest interoperability test there is', () => {
    // If the product cannot parse what it emits, the two halves disagree about the format and
    // one of them is wrong. This catches that on every commit, for free.
    const lab = { code: LAB, name: 'City Laboratory', country_code: 'IND' } as unknown as Laboratory
    const exported = buildHl7Batch([{
      id: 1, lab_code: LAB, patient_id: 'P-2002', specimen_number: 'SP-9', specimen_date: '2026-02-01',
      specimen_type: 'Blood', specimen_code: 'BLOOD_STERILE', organism: 'Escherichia coli',
      organism_code: 'ECO', organism_system: 'WHONET', sex: 'm',
      antibiotic_results: { MEM: { result: 'S', measurement: '0.5', method: 'MIC' } }
    } as unknown as IsolateRecord], lab)

    const parsed = parseHl7Message(exported.split('\n')[0] ?? '')
    expect(parsed.usable).toBe(true)
    const candidate = isolateFromMessage(parsed, seed, LAB)
    expect(candidate.reasons).toEqual([])
    expect(candidate.record?.organism_code).toBe('ECO')
    expect((candidate.record?.antibiotic_results as Record<string, Record<string, string>>).MEM?.result)
      .toBe('S')
  })

  it('tolerates the segment reordering and Z-segments that make v2 v2', () => {
    // SPM before PID, a Z-segment in the middle, and no PV1 at all. All legal, all common.
    const raw = [
      `MSH|^~\\&|LIS|CITYLAB|AMRIT|${LAB}|20260114093000|${CREDENTIAL}|ORU^R01|Z1|P|2.5.1`,
      'SPM|1|SP-5|SP-5|BLOOD_STERILE^Blood^WHONET|||||||||||||20260114',
      'ZLC|1|a local segment this node has never heard of|and never will',
      'PID|1||P-3003||Kumar^Ravi||19700101|M',
      'OBX|1|CWE|ORG^Organism identified^L||ECO^Escherichia coli^WHONET||||||F',
      'OBX|2|NM|MEM^Meropenem^WHONET||1|mg/L||S|||F'
    ].join('\r')
    const candidate = isolateFromMessage(parseHl7Message(raw), seed, LAB)
    expect(candidate.reasons).toEqual([])
    expect(candidate.record?.patient_id).toBe('P-3003')
    expect(candidate.record?.organism_code).toBe('ECO')
  })
})

describe('malformed and hostile messages are refused and never crash the listener', () => {
  it('refuses a message with no MSH rather than parsing it with assumed delimiters', () => {
    const parsed = parseHl7Message('PID|1||P-1||Nobody\rOBX|1|ST|x||y')
    expect(parsed.usable).toBe(false)
    expect(parsed.issues.some((issue) => issue.message.includes('not MSH'))).toBe(true)
  })

  it('refuses delimiters that are not distinct, because every field boundary would be ambiguous', () => {
    const parsed = parseHl7Message('MSH|^^^^|LIS|C|AMRIT|LAB01|202601140930||ORU^R01|X|P|2.5.1')
    expect(parsed.usable).toBe(false)
    expect(parsed.issues.some((issue) => issue.location === 'MSH-2')).toBe(true)
  })

  it('refuses a version it does not implement instead of producing plausible nonsense', () => {
    const raw = `MSH|^~\\&|LIS|C|AMRIT|${LAB}|202601140930||ORU^R01|X1|P|3.0`
    const parsed = parseHl7Message(raw)
    expect(parsed.usable).toBe(false)
    expect(parsed.issues.some((issue) => issue.location === 'MSH-12')).toBe(true)
  })

  it('caps an oversized message without allocating for it', () => {
    const parsed = parseHl7Message('M'.repeat(2 * 1024 * 1024))
    expect(parsed.usable).toBe(false)
    expect(parsed.issues[0]?.message).toMatch(/the limit is/)
  })

  it('does not let a sender inject segments into the acknowledgement', () => {
    // A control id containing a carriage return and a field separator would, if echoed
    // unescaped, let the sender append its own MSA or ERR to a reply another system trusts.
    const hostile = `MSH|^~\\&|LIS|C|AMRIT|${LAB}|202601140930|${CREDENTIAL}|ORU^R01|`
      + 'EVIL\\F\\MSA\\F\\AA\\F\\forged|P|2.5.1'
    const parsed = parseHl7Message(hostile)
    const ack = buildAck(parsed, { acknowledgement: 'AR', text: 'no', controlId: parsed.controlId })
    const segments = ack.split('\r').filter(Boolean)
    // Exactly MSH, MSA and ERR — the sender's forged MSA is escaped into the field, not a segment.
    expect(segments.map((segment) => segment.slice(0, 3))).toEqual(['MSH', 'MSA', 'ERR'])
  })

  it('survives a fuzz run over mutated real messages without throwing', () => {
    // Deterministic, so a failure is reproducible. The assertion is not that the parser
    // understands the mutants — most are nonsense — but that it always returns a value.
    // A parser that throws forces the listener to choose between crashing and swallowing.
    let state = 0x2f6e2b1
    const random = (): number => {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5
      return Math.abs(state) / 0x7fffffff
    }
    const base = oruMessage()
    let parsed = 0
    for (let iteration = 0; iteration < 4000; iteration += 1) {
      const bytes = [...base]
      const edits = 1 + Math.floor(random() * 12)
      for (let edit = 0; edit < edits; edit += 1) {
        const at = Math.floor(random() * bytes.length)
        const choice = random()
        if (choice < 0.34) bytes[at] = String.fromCharCode(Math.floor(random() * 0x8000))
        else if (choice < 0.67) bytes.splice(at, 1 + Math.floor(random() * 40))
        else bytes.splice(at, 0, ['|', '^', '~', '\\', '&', '\r', '\0', '￿'][Math.floor(random() * 8)] ?? '|')
      }
      const mutant = bytes.join('')
      // Must not throw, and must not hang. Both halves run: the parser, and everything that
      // consumes its output — which is where an undefined field would surface.
      const message = parseHl7Message(mutant)
      expect(Array.isArray(message.issues)).toBe(true)
      if (message.usable) {
        parsed += 1
        const candidate = isolateFromMessage(message, seed, LAB)
        expect(Array.isArray(candidate.reasons)).toBe(true)
      }
    }
    // A fuzz run where nothing parsed would prove only that the mutations were too destructive.
    expect(parsed).toBeGreaterThan(0)
  })

  it('decodes escapes without letting an expansion bomb through', () => {
    const delimiters = { field: '|', component: '^', repetition: '~', escape: '\\', subcomponent: '&' }
    expect(decodeEscapes('a\\F\\b', delimiters)).toBe('a|b')
    expect(decodeEscapes('a\\X41\\b', delimiters)).toBe('aAb')
    // Over the hex cap: kept as text rather than expanded.
    expect(decodeEscapes(`a\\X${'41'.repeat(200)}\\b`, delimiters)).toContain('\\X')
    // Unterminated, and an unknown escape: neither throws, neither deletes the payload.
    expect(decodeEscapes('a\\Fb', delimiters)).toBe('a\\Fb')
    expect(decodeEscapes('a\\Q9\\b', delimiters)).toBe('a\\Q9\\b')
  })

  it('reassembles frames split across packets and discards junk before a start block', () => {
    const framer = new MllpFramer(1024 * 1024)
    const complete = frame('MSH|^~\\&|A')
    expect(framer.push(complete.subarray(0, 4)).messages).toEqual([])
    expect(framer.push(complete.subarray(4)).messages).toEqual(['MSH|^~\\&|A'])
    // A port scanner sending bytes that never start a frame must not grow the buffer.
    const scanner = new MllpFramer(64)
    expect(scanner.push(Buffer.from('GET / HTTP/1.1\r\n\r\n')).overflow).toBe(false)
    expect(scanner.push(Buffer.from('x'.repeat(10_000))).overflow).toBe(false)
  })
})

describe('unmapped codes quarantine rather than corrupt', () => {
  it('holds a message whose organism this deployment cannot map, and does not guess', () => {
    const { service, store } = serviceWith()
    const raw = oruMessage({ organism: 'XZ99', organismSystem: 'CITYLAB-LOCAL' })
    const outcome = service.acceptHl7(parseHl7Message(raw), raw, '127.0.0.1')

    expect(outcome.status).toBe('quarantined')
    expect(store.records).toHaveLength(0)
    expect(store.quarantined).toHaveLength(1)
    // Stored verbatim: the reviewer's job is to work out what the sender meant.
    expect(store.quarantined[0]?.payload).toBe(raw)
    expect(store.quarantined[0]?.reasons[0]?.message).toMatch(/no mapping from that system/)
  })

  it('holds rather than filing a partial panel when one agent is unmappable', () => {
    // The tempting alternative is to file the isolate with the drugs that mapped. An isolate
    // filed with one of two results looks complete to every consumer, and the missing one is
    // as likely to be the carbapenem as anything else.
    const { service, store } = serviceWith()
    const raw = oruMessage({
      results: [
        'OBX|2|NM|MEM^Meropenem^WHONET||8|mg/L||R|||F',
        'OBX|3|NM|QQQ^Something this catalogue lacks^WHONET||4|mg/L||R|||F'
      ]
    })
    const outcome = service.acceptHl7(parseHl7Message(raw), raw, '127.0.0.1')
    expect(outcome.status).toBe('quarantined')
    expect(store.records).toHaveLength(0)
  })

  it('lists every unmapped code at once, so a reviewer fixes them in one pass', () => {
    const { service, store } = serviceWith()
    const raw = oruMessage({
      organism: 'ZZ1', organismSystem: 'LOCAL',
      results: [
        'OBX|2|NM|AAA^Unknown one^LOCAL||8|mg/L||R|||F',
        'OBX|3|NM|BBB^Unknown two^LOCAL||4|mg/L||R|||F'
      ]
    })
    service.acceptHl7(parseHl7Message(raw), raw, '127.0.0.1')
    expect(store.quarantined[0]?.reasons.length).toBeGreaterThanOrEqual(3)
  })

  it('refuses a native-looking code the catalogue does not hold', () => {
    // A system name saying "WHONET" does not make the code one.
    const result = reconcileCode(seed, {
      kind: 'organism', code: 'NOPE', system: 'WHONET', text: 'Invented', location: 'OBX[1]-5'
    })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('')
    expect(result.reason).toMatch(/no such code/)
  })

  it('does not resolve a specimen concept to an organism, though both maps target SNOMED', () => {
    // Organism and specimen ConceptMaps both target SNOMED. An inverse index keyed by target
    // system alone would put them in one bucket and file a specimen concept as a species.
    const specimenMap = seed.conceptMaps.find((map) => map.id === 'amrit-specimen-to-snomed')
    const snomedSpecimen = specimenMap?.elements[0]?.targets.equivalent
    expect(snomedSpecimen).toBeTruthy()
    const asOrganism = reconcileCode(seed, {
      kind: 'organism', code: String(snomedSpecimen), system: 'SCT', text: '', location: 'OBX[1]-5'
    })
    expect(asOrganism.ok).toBe(false)
    const asSpecimen = reconcileCode(seed, {
      kind: 'specimen', code: String(snomedSpecimen), system: 'SCT', text: '', location: 'SPM-4'
    })
    expect(asSpecimen.ok).toBe(true)
  })

  it('refuses a partial date rather than padding it into a week it did not happen in', () => {
    expect(hl7DateToIso('202608')).toBe('')
    expect(hl7DateToIso('20260231')).toBe('')  // February has no 31st
    expect(hl7DateToIso('20260114093000')).toBe('2026-01-14')
  })

  it('does not fold SDD or NS into S or R', () => {
    // "Susceptible at a higher dose" is not "susceptible", and recording it as one overstates
    // the drug's usefulness on a record a clinician may read.
    const { service, store } = serviceWith()
    const raw = oruMessage({ results: ['OBX|2|CWE|MEM^Meropenem^WHONET||SDD^Susceptible-dose dependent^HL70078||||||F'] })
    service.acceptHl7(parseHl7Message(raw), raw, '127.0.0.1')
    expect(store.quarantined[0]?.reasons.some((reason) => reason.kind === 'unusable-value')).toBe(true)
  })
})

describe('duplicate arrival merges auditably', () => {
  it('merges a resend that adds an agent rather than creating a second isolate', () => {
    const { service, store } = serviceWith()
    const first = oruMessage()
    service.acceptHl7(parseHl7Message(first), first, '127.0.0.1')

    const second = oruMessage({
      controlId: 'MSG0002',
      results: [
        'OBX|2|NM|MEM^Meropenem^WHONET||8|mg/L||R|||F',
        'OBX|3|NM|CIP^Ciprofloxacin^WHONET||22|mm||S|||F',
        'OBX|4|NM|AMK^Amikacin^WHONET||4|mg/L||S|||F'
      ]
    })
    const outcome = service.acceptHl7(parseHl7Message(second), second, '127.0.0.1')

    expect(outcome.status).toBe('merged')
    expect(store.records).toHaveLength(1)
    const results = store.records[0]?.antibiotic_results as Record<string, unknown>
    // The added agent is present and the original two survive: a resend adding one drug must
    // not delete the others.
    expect(Object.keys(results).sort()).toEqual(['AMK', 'CIP', 'MEM'])
    expect(outcome.changes.some((change) => change.startsWith('AMK'))).toBe(true)
  })

  it('records what a corrected identification changed, in the audit log', () => {
    const { service, store } = serviceWith()
    const first = oruMessage()
    service.acceptHl7(parseHl7Message(first), first, '127.0.0.1')
    // OBX-11 of `C` — the sender saying "this replaces the result I already sent". Without it
    // a different organism is a second isolate, which is right for a polymicrobial culture.
    const corrected = oruMessage({
      organism: 'ECO', controlId: 'MSG0003',
      organismStatus: 'C',
      results: ['OBX|2|NM|MEM^Meropenem^WHONET||8|mg/L||R|||C']
    })
    const outcome = service.acceptHl7(parseHl7Message(corrected), corrected, '127.0.0.1')

    expect(outcome.status).toBe('merged')
    expect(store.records[0]?.organism_code).toBe('ECO')
    const entry = store.audit.find((row) => row.operation === 'inbound.merge')
    expect(entry).toBeDefined()
    // "Why does this record say E. coli when I reported Klebsiella" is a question the audit
    // log has to answer, with the old value, the new value and the transmission it came from.
    expect(String((entry?.details as { changes: string[] }).changes.join(' ')))
      .toContain('organism_code: "KPN" -> "ECO"')
    expect((entry?.details as { controlId: string }).controlId).toBe('MSG0003')
  })

  it('records an identical resend rather than passing over it silently', () => {
    const { service, store } = serviceWith()
    const raw = oruMessage()
    service.acceptHl7(parseHl7Message(raw), raw, '127.0.0.1')
    const outcome = service.acceptHl7(parseHl7Message(raw), raw, '127.0.0.1')
    expect(outcome.status).toBe('merged')
    expect(outcome.changes).toEqual([])
    // "The laboratory sent it twice" and "we lost one" look identical in a log that only
    // records writes.
    expect(store.audit.some((row) => row.operation === 'inbound.duplicate')).toBe(true)
  })

  it('does not blank a field the resend omits', () => {
    const existing = {
      lab_code: LAB, patient_id: 'P', location: 'ICU-2', organism_code: 'KPN', organism: 'Klebsiella'
    } as unknown as IsolateRecord
    const { merged, changes } = mergeChanges(existing, {
      lab_code: LAB, patient_id: 'P', organism_code: 'KPN', organism: 'Klebsiella'
    } as unknown as IsolateRecord)
    // A sender that omits PV1 on a corrected result must not erase the ward.
    expect(merged.location).toBe('ICU-2')
    expect(changes).toEqual([])
  })
})

describe('the listener is off by default and refuses to start without a credential', () => {
  it('is disabled in the default configuration', () => {
    expect(DEFAULT_LISTENER_CONFIG.enabled).toBe(false)
    expect(DEFAULT_LISTENER_CONFIG.host).toBe('127.0.0.1')
    expect(DEFAULT_LISTENER_CONFIG.credential).toBe('')
  })

  it('refuses to start with no credential', async () => {
    const listener = new MllpListener(
      { ...DEFAULT_LISTENER_CONFIG, enabled: true, credential: '' },
      () => ({ acknowledgement: 'AA', text: '', controlId: '' })
    )
    await expect(listener.start()).rejects.toThrow(/no credential/)
    expect(listener.listening).toBe(false)
  })

  it('refuses a credential too short to be worth having', () => {
    const refusals = MllpListener.refusals({
      ...DEFAULT_LISTENER_CONFIG, enabled: true, credential: 'short'
    })
    expect(refusals.some((refusal) => refusal.includes('At least 16'))).toBe(true)
  })

  it('refuses a wildcard bind, and a network bind with no allowlist', () => {
    expect(MllpListener.refusals({
      ...DEFAULT_LISTENER_CONFIG, enabled: true, credential: CREDENTIAL, host: '0.0.0.0'
    }).some((refusal) => refusal.includes('wildcard bind'))).toBe(true)

    expect(MllpListener.refusals({
      ...DEFAULT_LISTENER_CONFIG, enabled: true, credential: CREDENTIAL, host: '10.0.0.5'
    }).some((refusal) => refusal.includes('empty peer allowlist'))).toBe(true)

    // Named interface plus an allowlist is the configuration a deployment must reach on purpose.
    expect(MllpListener.refusals({
      ...DEFAULT_LISTENER_CONFIG, enabled: true, credential: CREDENTIAL,
      host: '10.0.0.5', allowedPeers: ['10.0.0.9']
    })).toEqual([])
  })

  it('starting a disabled listener does nothing rather than failing', async () => {
    const listener = new MllpListener(
      { ...DEFAULT_LISTENER_CONFIG, credential: '' },
      () => ({ acknowledgement: 'AA', text: '', controlId: '' })
    )
    await expect(listener.start()).resolves.toBeUndefined()
    expect(listener.listening).toBe(false)
  })

  it('compares the credential in constant time and rejects a length-prefix guess', () => {
    expect(credentialMatches(CREDENTIAL, CREDENTIAL)).toBe(true)
    expect(credentialMatches('', CREDENTIAL)).toBe(false)
    expect(credentialMatches(CREDENTIAL.slice(0, -1), CREDENTIAL)).toBe(false)
    expect(credentialMatches(`${CREDENTIAL}x`, CREDENTIAL)).toBe(false)
    // No credential configured must never match, including against an empty MSH-8.
    expect(credentialMatches('', '')).toBe(false)
  })
})

describe('the FHIR ingest endpoint', () => {
  const bundleOf = (entries: unknown[], type = 'transaction'): Record<string, unknown> => ({
    resourceType: 'Bundle', id: 'B1', type, entry: entries.map((resource) => ({ resource }))
  })
  const patient = {
    resourceType: 'Patient', id: 'pat1', identifier: [{ value: 'P-4004' }],
    name: [{ family: 'Rao', given: ['Sita'] }], gender: 'female', birthDate: '1990-05-06'
  }
  const specimen = {
    resourceType: 'Specimen', id: 'spec1', identifier: [{ value: 'SP-12' }],
    subject: { reference: 'Patient/pat1' },
    type: { coding: [{ system: 'urn:whonet:specimen-code', code: 'BLOOD_STERILE' }] },
    collection: { collectedDateTime: '2026-03-04' }
  }
  const organism = {
    resourceType: 'Observation', id: 'obs1', status: 'final',
    code: { coding: [{ system: 'http://loinc.org', code: '11475-1' }] },
    subject: { reference: 'Patient/pat1' }, specimen: { reference: 'Specimen/spec1' },
    valueCodeableConcept: { coding: [{ system: 'urn:whonet:organism-code', code: 'ECO' }] }
  }
  const susceptibility = {
    resourceType: 'Observation', id: 'obs2', status: 'final',
    code: { coding: [{ system: 'urn:whonet:antibiotic-code', code: 'MEM' }] },
    subject: { reference: 'Patient/pat1' }, specimen: { reference: 'Specimen/spec1' },
    valueQuantity: { value: 2, system: 'http://unitsofmeasure.org', code: 'mg/L' },
    interpretation: [{ coding: [{ code: 'R' }] }]
  }

  it('files a well-formed transaction bundle', () => {
    const { service, store } = serviceWith()
    const bundle = bundleOf([patient, specimen, organism, susceptibility])
    const outcome = service.acceptBundle(bundle, JSON.stringify(bundle), '127.0.0.1')
    expect(outcome.status).toBe('created')
    expect(store.records[0]?.organism_code).toBe('ECO')
    expect((store.records[0]?.antibiotic_results as Record<string, Record<string, string>>).MEM?.result)
      .toBe('R')
  })

  it('refuses a searchset, which is a query response rather than a submission', () => {
    const { service } = serviceWith()
    const bundle = bundleOf([patient], 'searchset')
    const outcome = service.acceptBundle(bundle, '{}', '127.0.0.1')
    expect(outcome.status).toBe('quarantined')
    expect(outcome.reasons[0]?.message).toMatch(/searchset|accepts "transaction"/)
  })

  it('enforces the profile constraints before anything is written', () => {
    // status must be final; subject and specimen are 1..1; valueQuantity.system is fixed.
    expect(profileFailures({ ...susceptibility, status: 'preliminary' }, 0)
      .some((failure) => failure.message.includes('fix it to "final"'))).toBe(true)
    expect(profileFailures({ ...susceptibility, subject: undefined }, 0)
      .some((failure) => failure.message.includes('subject'))).toBe(true)
    expect(profileFailures({
      ...susceptibility, valueQuantity: { value: 2, system: 'http://example.org/units', code: 'mg/L' }
    }, 0).some((failure) => failure.message.includes('unitsofmeasure.org'))).toBe(true)
    expect(profileFailures(susceptibility, 0)).toEqual([])
  })

  it('does not use Patient.id as a patient identifier', () => {
    // A server-assigned resource id is not the identifier the laboratory knows the patient by,
    // and deduplicating on it would merge the wrong records.
    const bundle = bundleOf([
      { ...patient, identifier: [] }, specimen, organism, susceptibility
    ])
    const candidate = isolateFromBundle(bundle, seed, LAB)
    expect(candidate.record).toBeNull()
    expect(candidate.reasons.some((reason) => reason.location === 'Patient.identifier')).toBe(true)
  })

  it('is never handed a non-object without saying so', () => {
    for (const payload of [null, 'a string', 42, [], undefined]) {
      const candidate = isolateFromBundle(payload, seed, LAB)
      expect(candidate.record).toBeNull()
      expect(candidate.reasons.length).toBeGreaterThan(0)
    }
  })

  it('stores an ICD-11 diagnosis under its own system rather than relabelling it', () => {
    const condition = {
      resourceType: 'Condition', id: 'cond1', subject: { reference: 'Patient/pat1' },
      code: { coding: [{ system: 'http://id.who.int/icd/release/11/mms', code: '1G40' }] }
    }
    const bundle = bundleOf([patient, specimen, organism, susceptibility, condition])
    const candidate = isolateFromBundle(bundle, seed, LAB)
    expect(candidate.reasons).toEqual([])
    expect(candidate.record?.diagnosis_code).toBe('1G40')
    expect(candidate.record?.diagnosis_system).toBe('http://id.who.int/icd/release/11/mms')
  })
})

describe('the acknowledgement a sender receives', () => {
  it('says AE for a held message, not AR, because AR means do not resend', () => {
    const held = InboundService.acknowledge(
      { status: 'quarantined', isolateId: null, quarantineId: 3, changes: [],
        reasons: [{ kind: 'unmapped-code', location: 'OBX[1]-5', message: 'no mapping' }] },
      'MSG1'
    )
    expect(held.acknowledgement).toBe('AE')
    expect(held.text).toContain('Held for review')
  })

  it('names the isolate it filed or merged into', () => {
    expect(InboundService.acknowledge(
      { status: 'created', isolateId: 7, quarantineId: null, changes: [], reasons: [] }, 'M'
    ).text).toContain('isolate 7')
    expect(InboundService.acknowledge(
      { status: 'merged', isolateId: 7, quarantineId: null, changes: ['AMK: added S'], reasons: [] }, 'M'
    ).text).toContain('AMK')
  })
})
