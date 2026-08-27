/**
 * Generate the FHIR Implementation Guide's reference corpus and examples from the exporter.
 *
 * Phase 25. The corpus is what the official HL7 validator runs against in CI, and it existed
 * before this script did — as two files nothing produced. That is the one shape of drift this
 * IG is supposed to make impossible: the guide's ValueSets are generated from the terminology
 * seed precisely so they cannot disagree with the runtime, and then the corpus those ValueSets
 * are checked against was hand-made. A validator passing a file the product does not emit
 * proves nothing about the product.
 *
 * So every byte here comes out of `createExport`. The records below are inputs, not outputs:
 * change them and the corpus changes, but no resource, coding or segment is written by hand.
 *
 *     npx jiti scripts/generate-reference-corpus.ts           # write the corpus and examples
 *     npx jiti scripts/generate-reference-corpus.ts --check   # fail if they are stale (CI gate)
 *
 * **The clock is pinned, and only the clock.** `utcNow()` reads the real time, so `timestamp`,
 * `issued` and `date` move on every run and a committed corpus would be dirty a second after it
 * was written. Those three fields are rewritten to a fixed instant after the exporter has run.
 * Nothing else is touched — the ids are already deterministic (`deterministicUuid`), and if a
 * code, a unit or a segment changes, `--check` fails, which is the entire point.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildFhirBundle, buildHl7Batch, buildMeasureBundle } from '../src/main/services'
import type { IsolateRecord, Laboratory } from '../src/shared/types'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = resolve(currentDirectory, '..', '..')
const CORPUS = join(REPOSITORY_ROOT, 'fhir-ig', 'reference-corpus')
const EXAMPLES = join(REPOSITORY_ROOT, 'fhir-ig', 'input', 'examples')

/**
 * The instant the corpus is pinned to. Arbitrary, fixed, and in the past relative to nothing —
 * it exists so the files are byte-stable, not to represent a moment anything happened.
 */
const PINNED_INSTANT = '2026-01-06T09:00:00Z'

const laboratory = {
  code: 'LAB01',
  name: 'Reference Laboratory',
  site_group: 'Region A',
  country_code: 'IND'
} as unknown as Laboratory

/**
 * Two isolates, chosen so that between them they exercise every branch the IG profiles
 * constrain — and, deliberately, the branches where AMRIT has nothing to send.
 *
 * The first is fully coded: a coded ICD-10 diagnosis, a specimen group with no SNOMED concept,
 * an MIC and a disk diffusion of different drugs so the two LOINC method variants both appear,
 * and an admission two days before the specimen so `infectionOrigin` says Hospital.
 *
 * The second is where the honest gaps live. Its diagnosis is free text, so a `Condition` is
 * emitted with `code.text` and **no coding** — the property the coded-output test guards, and
 * worth having a receiver-visible example of. Its first agent is ACM, one of the 135 catalogue
 * antimicrobials with no LOINC susceptibility concept, so the observation carries the WHONET
 * coding alone and the bundle carries the tag saying why. Its specimen group does have a SNOMED
 * concept, so the two specimens differ in whether the second coding is present.
 */
const records: IsolateRecord[] = [
  {
    id: 1,
    lab_code: 'LAB01',
    patient_id: 'P-001',
    specimen_number: 'S-001',
    specimen_date: '2026-01-02',
    admission_date: '2025-12-28',
    specimen_type: 'Blood',
    specimen_code: 'BLOOD_STERILE',
    organism: 'Klebsiella pneumoniae',
    organism_code: 'KPN',
    sex: 'f',
    location: 'Medical ICU',
    diagnosis: 'Sepsis',
    diagnosis_code: 'A41.9',
    diagnosis_system: 'http://hl7.org/fhir/sid/icd-10',
    record_status: 'final',
    antibiotic_results: {
      CIP: { result: 'S', measurement: '22', method: 'DISK' },
      COL: { result: 'S', measurement: '1', method: 'MIC' },
      MEM: { result: 'R', measurement: '8', method: 'MIC' }
    }
  },
  {
    id: 2,
    lab_code: 'LAB01',
    patient_id: 'P-002',
    specimen_number: 'S-002',
    specimen_date: '2026-01-05',
    specimen_type: 'Urine',
    specimen_code: 'URINE',
    organism: 'Escherichia coli',
    organism_code: 'ECO',
    sex: 'm',
    location: 'General medicine',
    diagnosis: 'suspected urinary source, not yet coded',
    record_status: 'final',
    antibiotic_results: {
      ACM: { result: 'R' },
      AMP: { result: 'R', measurement: '32', method: 'MIC' }
    }
  },
  // The third isolate exists for one reason: its diagnosis is coded in **ICD-11**, not ICD-10.
  // `Condition.code` is a shared path but the system URI is not, and a corpus that only ever
  // carried ICD-10 would let an ICD-11 deployment fail somewhere no gate was looking. 1G40 is
  // "Sepsis without septic shock", from the WHO-verified cache rather than from memory.
  {
    id: 3,
    lab_code: 'LAB01',
    patient_id: 'P-003',
    specimen_number: 'S-003',
    specimen_date: '2026-01-08',
    admission_date: '2026-01-01',
    specimen_type: 'Blood',
    specimen_code: 'BLOOD_STERILE',
    organism: 'Staphylococcus aureus',
    organism_code: 'SAU',
    sex: 'f',
    location: 'Surgical ICU',
    diagnosis: 'Sepsis without septic shock',
    diagnosis_code: '1G40',
    diagnosis_system: 'http://id.who.int/icd/release/11/mms',
    record_status: 'final',
    antibiotic_results: {
      OXA: { result: 'R', measurement: '4', method: 'MIC' },
      VAN: { result: 'S', measurement: '1', method: 'MIC' }
    }
  }
] as unknown as IsolateRecord[]

/** Rewrite the three wall-clock fields, at any depth, and leave everything else alone. */
function pinClock<T>(value: T): T {
  if (Array.isArray(value)) return value.map(pinClock) as unknown as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) =>
      ['timestamp', 'issued', 'date'].includes(key) && typeof entry === 'string'
        ? [key, PINNED_INSTANT]
        : [key, pinClock(entry)])) as unknown as T
  }
  return value
}

/**
 * The v2 message carries the clock in MSH-7 and in the message control id, which also
 * embeds `Date.now()`. Both are replaced positionally rather than by pattern, so a change
 * to any other field cannot be quietly absorbed by a regular expression written to be
 * forgiving.
 */
function pinHl7Clock(message: string): string {
  return message.split('\n').map((entry, index) => entry.split('\r').map((segment) => {
    if (!segment.startsWith('MSH|')) return segment
    const fields = segment.split('|')
    fields[6] = PINNED_INSTANT.replace(/[-:TZ]/g, '').slice(0, 14)
    fields[9] = `LAB01-${index + 1}-REFERENCE`
    return fields.join('|')
  }).join('\r')).join('\n')
}

/** The message control id also appears in OBR-3, which must keep matching MSH-10. */
function pinHl7ControlIds(message: string): string {
  return message.split('\n').map((entry, index) => entry.split('\r').map((segment) => {
    if (!segment.startsWith('OBR|')) return segment
    const fields = segment.split('|')
    fields[3] = `LAB01-${index + 1}-REFERENCE`
    return fields.join('|')
  }).join('\r')).join('\n')
}

const bundle = pinClock(buildFhirBundle(records, laboratory))
const measure = pinClock(buildMeasureBundle(records, laboratory, {
  antibioticCode: 'MEM', periodStart: '2026-01-01', periodEnd: '2026-01-31'
} as never))
const message = pinHl7ControlIds(pinHl7Clock(buildHl7Batch(records, laboratory)))

/**
 * The IG's examples are the two **bundles**, not the resources inside them.
 *
 * The first attempt lifted one instance of each profile out into its own file, to clear the
 * publisher's nine "contains no examples for this profile" warnings. It cleared them and cost
 * seventeen errors: a `DiagnosticReport` outside its bundle has seven `urn:uuid:` references
 * with nothing to resolve against, and the publisher is right to say so.
 *
 * Those dangling references are an artefact of the lifting, not a defect in the export — AMRIT's
 * unit of exchange is a Bundle, and every reference resolves inside one. Publishing loose
 * resources would have traded nine honest warnings for seventeen errors describing a message the
 * product never sends. The warnings stay, with that reason recorded in `ignoreWarnings.txt`.
 */
const files = new Map<string, string>([
  [join(CORPUS, 'diagnostic-bundle.json'), `${JSON.stringify(bundle, null, 1)}\n`],
  [join(CORPUS, 'measure-bundle.json'), `${JSON.stringify(measure, null, 1)}\n`],
  [join(CORPUS, 'oru-r01.hl7'), message],
  [join(EXAMPLES, 'Bundle-amrit-diagnostic-example.json'), `${JSON.stringify(bundle, null, 1)}\n`],
  [join(EXAMPLES, 'Bundle-amrit-measure-example.json'), `${JSON.stringify(measure, null, 1)}\n`]
])

const check = process.argv.includes('--check')
if (check) {
  const stale: string[] = []
  const expected = new Set([...files.keys()])
  for (const path of files.keys()) {
    let actual = ''
    try {
      actual = readFileSync(path, 'utf8')
    } catch {
      stale.push(`${path} (missing)`)
      continue
    }
    if (actual !== files.get(path)) stale.push(path)
  }
  // A file the generator no longer produces is drift too: a profile removed from the IG must
  // not leave its example behind claiming to be current.
  for (const name of readdirSync(EXAMPLES, { withFileTypes: true })) {
    if (name.isFile() && !expected.has(join(EXAMPLES, name.name))) stale.push(`${join(EXAMPLES, name.name)} (orphaned)`)
  }
  if (stale.length > 0) {
    console.error('Reference corpus is stale. Re-run without --check:')
    for (const path of stale) console.error(`  ${path.replace(`${REPOSITORY_ROOT}/`, '')}`)
    process.exit(1)
  }
  console.log(`Reference corpus and IG examples in sync with the exporter (${files.size} files)`)
} else {
  mkdirSync(CORPUS, { recursive: true })
  rmSync(EXAMPLES, { recursive: true, force: true })
  mkdirSync(EXAMPLES, { recursive: true })
  for (const [path, content] of files) writeFileSync(path, content, 'utf8')
  console.log(`wrote ${files.size} files`)
  for (const path of files.keys()) console.log(`  ${path.replace(`${REPOSITORY_ROOT}/`, '')}`)
}
