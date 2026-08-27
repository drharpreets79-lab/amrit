/**
 * Phases 23 and 24: what a bundle and an ORU message actually carry once they are coded.
 *
 * The golden test at the bottom is the one that stops a catalogue or seed change altering an
 * export without anyone noticing. The rest assert the properties the phases exist for: a LOINC
 * code chosen by method, a unit on every quantity, a Condition where there is a diagnosis, and
 * — the one that is easiest to get wrong — free text that never becomes a code.
 */

import { describe, expect, it } from 'vitest'

import { buildFhirBundle, buildHl7Batch } from '../src/main/services'
import type { IsolateRecord, Laboratory } from '../src/shared/types'

const lab = { code: 'LAB01', name: 'Reference Laboratory', site_group: '', country_code: 'IND' } as unknown as Laboratory

const baseRecord = {
  id: 1,
  lab_code: 'LAB01',
  patient_id: 'P-001',
  specimen_number: 'S-001',
  specimen_date: '2026-01-02',
  specimen_type: 'Blood',
  specimen_code: 'BLOOD_STERILE',
  organism: 'Klebsiella pneumoniae',
  organism_code: 'KPN',
  sex: 'f',
  location: 'Medical ICU',
  record_status: 'final'
} as unknown as IsolateRecord

const withResults = (results: Record<string, unknown>, extra: Record<string, unknown> = {}): IsolateRecord =>
  ({ ...baseRecord, ...extra, antibiotic_results: results }) as unknown as IsolateRecord

const resourcesOf = (bundle: Record<string, unknown>, type: string): Record<string, unknown>[] =>
  ((bundle.entry as Array<{ resource: Record<string, unknown> }>) ?? [])
    .map((entry) => entry.resource)
    .filter((resource) => resource.resourceType === type)

describe('LOINC on laboratory output', () => {
  it('codes a susceptibility observation by the method that produced it', () => {
    const bundle = buildFhirBundle([
      withResults({ MEM: { result: 'R', measurement: '8', method: 'MIC' } })
    ], lab)
    const observation = resourcesOf(bundle, 'Observation')
      .find((resource) => JSON.stringify(resource).includes('MEM'))
    const codings = (observation?.code as { coding: Array<{ system: string; code: string }> }).coding
    // LOINC first, WHONET second, both always: the first makes it interpretable to a stranger,
    // the second is why a WHONET user can still read it.
    expect(codings[0]).toMatchObject({ system: 'http://loinc.org', code: '6652-2' })
    expect(codings[1]).toMatchObject({ system: 'urn:whonet:antibiotic-code', code: 'MEM' })
  })

  it('uses a different LOINC code for a disk diffusion of the same drug', () => {
    const bundle = buildFhirBundle([
      withResults({ MEM: { result: 'R', measurement: '12', method: 'DISK' } })
    ], lab)
    expect(JSON.stringify(bundle)).toContain('6653-0')
    expect(JSON.stringify(bundle)).not.toContain('6652-2')
  })

  it('gives a quantity its UCUM unit, so an MIC and a zone diameter differ', () => {
    const mic = buildFhirBundle([withResults({ MEM: { result: 'R', measurement: '8', method: 'MIC' } })], lab)
    const disk = buildFhirBundle([withResults({ MEM: { result: 'R', measurement: '8', method: 'DISK' } })], lab)
    const quantityOf = (bundle: Record<string, unknown>): Record<string, unknown> => {
      const observation = resourcesOf(bundle, 'Observation')
        .find((resource) => resource.valueQuantity !== undefined)
      return observation?.valueQuantity as Record<string, unknown>
    }
    expect(quantityOf(mic)).toEqual({ value: 8, unit: 'mg/L', system: 'http://unitsofmeasure.org', code: 'mg/L' })
    expect(quantityOf(disk)).toEqual({ value: 8, unit: 'mm', system: 'http://unitsofmeasure.org', code: 'mm' })
  })

  it('omits the unit rather than guessing one when the method is unknown', () => {
    // The failure this avoids: a receiver doing arithmetic on a number whose unit AMRIT
    // invented. A bare value is honest; a wrong unit is not.
    const bundle = buildFhirBundle([withResults({ MEM: { result: 'R', measurement: '8' } })], lab)
    const observation = resourcesOf(bundle, 'Observation').find((resource) => resource.valueQuantity !== undefined)
    expect(observation?.valueQuantity).toEqual({ value: 8 })
  })

  it('codes the organism observation and the report', () => {
    const bundle = buildFhirBundle([withResults({})], lab)
    const organism = resourcesOf(bundle, 'Observation')[0]
    expect((organism?.code as { coding: Array<{ code: string }> }).coding[0]?.code).toBe('11475-1')
    const report = resourcesOf(bundle, 'DiagnosticReport')[0]
    expect((report?.code as { coding: Array<{ code: string }> }).coding[0]?.code).toBe('18725-2')
  })

  it('says on the bundle when an agent could not be coded', () => {
    // ACM (acetylmidecamycin) has no LOINC susceptibility concept. The export carries the
    // WHONET coding and a tag saying why there is no standard one — an absence a receiver can
    // read is a gap; a silent absence is a mystery.
    const bundle = buildFhirBundle([withResults({ ACM: { result: 'R', method: 'MIC' } })], lab)
    // The tag marks *that* a coding was omitted; the reasons live in an OperationOutcome.
    // They used to travel in Coding.display, which is the display of the code and not a
    // per-message message — publishing the code system let the official validator say so.
    const tags = (bundle.meta as { tag: Array<{ code: string }> } | undefined)?.tag ?? []
    expect(tags.some((tag) => tag.code === 'coding-omitted')).toBe(true)
    const outcome = resourcesOf(bundle, 'OperationOutcome')[0]
    const issues = (outcome?.issue ?? []) as Array<{ details?: { text?: string } }>
    expect(issues.some((issue) => (issue.details?.text ?? '')
      .includes('no LOINC susceptibility concept'))).toBe(true)
  })
})

describe('the coded diagnosis', () => {
  it('emits a Condition carrying the stored code and system', () => {
    const bundle = buildFhirBundle([withResults({}, {
      diagnosis_code: 'A41.9',
      diagnosis_system: 'http://hl7.org/fhir/sid/icd-10',
      diagnosis: 'Sepsis'
    })], lab)
    const condition = resourcesOf(bundle, 'Condition')[0]
    expect(condition).toBeDefined()
    const code = condition?.code as { coding: Array<{ system: string; code: string; display?: string }>; text: string }
    expect(code.coding[0]).toMatchObject({ system: 'http://hl7.org/fhir/sid/icd-10', code: 'A41.9' })
    expect(code.text).toBe('Sepsis')
    // The report carries it too: R4 gives a DiagnosticReport no reference to a Condition.
    const report = resourcesOf(bundle, 'DiagnosticReport')[0] as Record<string, unknown>
    expect(JSON.stringify(report.conclusionCode)).toContain('A41.9')
  })

  it('splits several diagnoses into several codings', () => {
    const bundle = buildFhirBundle([withResults({}, {
      diagnosis_code: 'A41.9,N39.0',
      diagnosis_system: 'http://hl7.org/fhir/sid/icd-10'
    })], lab)
    const condition = resourcesOf(bundle, 'Condition')[0]
    const coding = (condition?.code as { coding: Array<{ code: string }> }).coding
    expect(coding.map((entry) => entry.code)).toEqual(['A41.9', 'N39.0'])
  })

  it('never turns free text into a code', () => {
    // The rule the phase turns on. A clinician's note is a note.
    const bundle = buildFhirBundle([withResults({}, { diagnosis: 'query sepsis, source unclear' })], lab)
    const condition = resourcesOf(bundle, 'Condition')[0]
    const code = condition?.code as { coding?: unknown; text: string }
    expect(code.coding).toBeUndefined()
    expect(code.text).toBe('query sepsis, source unclear')
    expect(JSON.stringify(resourcesOf(bundle, 'DiagnosticReport')[0])).not.toContain('conclusionCode')
  })

  it('emits no Condition at all when there is no diagnosis', () => {
    expect(resourcesOf(buildFhirBundle([withResults({})], lab), 'Condition')).toHaveLength(0)
  })

  it('sends DG1 in the v2 message, one per diagnosis', () => {
    const message = buildHl7Batch([withResults({}, {
      diagnosis_code: 'A41.9,N39.0',
      diagnosis_system: 'http://hl7.org/fhir/sid/icd-10'
    })], lab)
    const dg1 = message.split('\r').filter((segment) => segment.startsWith('DG1'))
    expect(dg1).toHaveLength(2)
    expect(dg1[0]).toContain('A41.9')
    // I10 is the v2 identifier for ICD-10; the FHIR URL would be meaningless in DG1-3.
    expect(dg1[0]).toContain('I10')
    const order = message.split('\r').map((segment) => segment.split('|')[0])
    expect(order.indexOf('DG1')).toBeGreaterThan(order.indexOf('PV1'))
    expect(order.indexOf('DG1')).toBeLessThan(order.indexOf('OBR'))
  })

  it('sends no DG1 for a free-text diagnosis', () => {
    const message = buildHl7Batch([withResults({}, { diagnosis: 'query sepsis' })], lab)
    expect(message.split('\r').some((segment) => segment.startsWith('DG1'))).toBe(false)
  })
})

describe('the coded bundle is pinned', () => {
  it('matches its golden shape, so a catalogue or seed change cannot alter an export silently', () => {
    const bundle = buildFhirBundle([withResults(
      { MEM: { result: 'R', measurement: '8', method: 'MIC' }, CIP: { result: 'S', measurement: '22', method: 'DISK' } },
      { diagnosis_code: 'A41.9', diagnosis_system: 'http://hl7.org/fhir/sid/icd-10', diagnosis: 'Sepsis' }
    )], lab)
    // Codes rather than the whole document: `timestamp` and `issued` move every run, and a
    // golden test that has to be regenerated for the clock teaches people to regenerate it.
    const codes = JSON.stringify(bundle).match(/"code":"[^"]+"/g) ?? []
    expect([...new Set(codes)].sort()).toEqual([
      '"code":"11475-1"',       // organism identification, LOINC
      '"code":"186-7"',         // ciprofloxacin by disk diffusion, LOINC
      '"code":"18725-2"',       // microbiology report, LOINC
      '"code":"6652-2"',        // meropenem by MIC, LOINC
      '"code":"A41.9"',         // the coded diagnosis
      '"code":"BLOOD_STERILE"', // WHONET specimen
      '"code":"CIP"',           // WHONET antibiotic
      '"code":"KPN"',           // WHONET organism
      '"code":"MB"',            // report category, v2-0074
      '"code":"MEM"',
      '"code":"R"',             // interpretation
      '"code":"S"',
      '"code":"coding-omitted"',
      '"code":"encounter-diagnosis"',
      '"code":"incomplete"',    // OperationOutcome issue code, carrying the omission reasons
      '"code":"laboratory"',
      '"code":"mg/L"',          // UCUM
      '"code":"mm"',
      '"code":"unconfirmed"'
    ].sort())
  })
})
