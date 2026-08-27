// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { addressFormatFor } from '../src/main/address-format'
import { AMRITDatabase } from '../src/main/database'
import { setActiveCountryProfile } from '../src/main/active-profile'
import {
  RESIDENCE_FIELDS,
  generalizeResidence,
  normalizeResidence,
  residenceFieldsForForm,
  residenceToFhirAddress,
  validateResidence,
  type PatientResidence
} from '../src/shared/address'
import { buildFhirBundle, createWhonetCsv, parseImportPreview, patientPostalCodeDigits } from '../src/main/services'
import { indiaProfile } from './helpers/profile'
import { writeFileSync } from 'node:fs'

/**
 * A patient's place, on the same field set laboratories use minus the street.
 *
 * Two claims are being pinned here. First, that the postal code — the one sub-city
 * geography most countries share — is captured, validated and exportable at all, which it
 * was not before. Second, that it never leaves the deployment at full precision unless the
 * deployment says so.
 */
describe('what a residence may hold', () => {
  const india = addressFormatFor('IND')

  it('is the geographic fields and nothing else', () => {
    expect(RESIDENCE_FIELDS).toEqual(['dependent_locality', 'locality', 'admin_area', 'postal_code'])
    expect(RESIDENCE_FIELDS).not.toContain('address_lines')
    expect(RESIDENCE_FIELDS).not.toContain('organization')
    expect(RESIDENCE_FIELDS).not.toContain('recipient')
  })

  it('refuses a street address rather than storing one', () => {
    const problems = validateResidence(
      { country_code: 'IND', address_lines: ['12 Hospital Road'] } as unknown as PatientResidence,
      india
    )
    expect(problems.map((problem) => problem.code)).toContain('not_stored')
  })

  it('does not enforce the country\'s required set, because a lab often does not know it', () => {
    // India requires locality and admin_area on a *postal* address. A record with only a
    // postal code is still a record worth keeping.
    expect(validateResidence({ country_code: 'IND', postal_code: '682011' }, india)).toEqual([])
  })

  it('still validates the postal code against the country pattern', () => {
    const problems = validateResidence({ country_code: 'IND', postal_code: 'NOT-A-PIN' }, india)
    expect(problems.map((problem) => problem.code)).toEqual(['postal_code_pattern'])
  })

  it('offers the country\'s own fields under the country\'s own names', () => {
    // India writes the town and the code together, then the state under them.
    expect(residenceFieldsForForm(india)).toEqual(['locality', 'postal_code', 'admin_area'])
    // The United Arab Emirates has no postal code and no town on an address at all.
    expect(residenceFieldsForForm(addressFormatFor('ARE'))).toEqual(['admin_area'])
    expect(residenceFieldsForForm(addressFormatFor('IRL'))).toEqual([
      'dependent_locality',
      'locality',
      'admin_area',
      'postal_code'
    ])
  })

  it('applies the country\'s uppercasing and drops empties', () => {
    expect(normalizeResidence({ country_code: 'ind', locality: ' Kochi ', admin_area: '' }, india)).toEqual({
      country_code: 'IND',
      locality: 'KOCHI'
    })
  })
})

describe('coarsening a residence for anything that leaves', () => {
  it('keeps the leading characters the deployment asks for', () => {
    const residence: PatientResidence = { country_code: 'IND', locality: 'KOCHI', postal_code: '682011' }
    expect(generalizeResidence(residence, 3).postal_code).toBe('682')
    expect(generalizeResidence(residence, 6).postal_code).toBe('682011')
    // Asking for more than the code has keeps the code rather than padding it.
    expect(generalizeResidence(residence, 12).postal_code).toBe('682011')
  })

  it('drops the code entirely at zero', () => {
    const generalized = generalizeResidence({ country_code: 'SGP', postal_code: '169608' }, 0)
    expect('postal_code' in generalized).toBe(false)
  })

  it('counts characters, not separators', () => {
    // A UK outward code is "SW1A"; three characters of it must not become "SW1 " or "SW1A".
    expect(generalizeResidence({ country_code: 'GBR', postal_code: 'SW1A 1AA' }, 3).postal_code).toBe('SW1')
  })

  it('leaves the town and the area alone — suppression is the k-anonymity floor\'s job', () => {
    const generalized = generalizeResidence(
      { country_code: 'IND', locality: 'KOCHI', admin_area: 'Kerala', postal_code: '682011' },
      3
    )
    expect(generalized.locality).toBe('KOCHI')
    expect(generalized.admin_area).toBe('Kerala')
  })

  it('exports as a FHIR home address, never with a street line', () => {
    const resource = residenceToFhirAddress({ country_code: 'IND', locality: 'KOCHI', postal_code: '682' })
    expect(resource).toEqual({ use: 'home', type: 'physical', city: 'KOCHI', postalCode: '682', country: 'IND' })
    expect(resource && 'line' in resource).toBe(false)
  })

  it('reads the deployment\'s setting, defaulting conservatively', () => {
    setActiveCountryProfile({ ...indiaProfile, privacy: { ...indiaProfile.privacy, patient_postal_code_digits: 0 } })
    expect(patientPostalCodeDigits()).toBe(0)
    setActiveCountryProfile({ ...indiaProfile, privacy: { ...indiaProfile.privacy, patient_postal_code_digits: null } })
    expect(patientPostalCodeDigits()).toBe(3)
    setActiveCountryProfile(indiaProfile)
  })
})

describe('a residence through the database', () => {
  let directory = ''
  let database: AMRITDatabase | null = null
  const path = (): string => join(directory, 'residence.sqlite3')

  const open = (): AMRITDatabase => {
    database = new AMRITDatabase(path()).initialize()
    database.saveLab({ code: 'LAB1', name: 'Test lab', country_code: 'IND' })
    database.selectLab('LAB1')
    database.saveMaster('samples', { code: 'BLOOD', name: 'Blood' })
    database.saveMaster('organisms', { code: 'ECOLI', organism_name: 'Escherichia coli' })
    return database
  }

  beforeEach(() => {
    setActiveCountryProfile(indiaProfile)
    directory = mkdtempSync(join(tmpdir(), 'amrit-residence-'))
  })
  afterEach(() => {
    database?.close()
    database = null
    rmSync(directory, { recursive: true, force: true })
  })

  const record = (residence: PatientResidence | undefined): Record<string, unknown> => ({
    lab_code: 'LAB1',
    patient_id: 'P1',
    specimen_number: 'S1',
    specimen_date: '2026-02-01',
    specimen_type: 'Blood',
    specimen_code: 'BLOOD',
    organism: 'Escherichia coli',
    organism_code: 'ECOLI',
    record_status: 'final',
    antibiotic_results: { MEM: { result: 'R' } },
    ...(residence ? { patient_residence: residence } : {})
  })

  it('stores and reads back the structured residence', () => {
    const db = open()
    const saved = db.saveRecord(record({ country_code: 'IND', locality: 'Kochi', admin_area: 'Kerala', postal_code: '682011' }) as never)
    const [read] = db.listRecords({ labCode: 'LAB1' })
    expect(saved.id).toBeGreaterThan(0)
    expect(read?.patient_residence).toEqual({
      country_code: 'IND',
      locality: 'KOCHI',
      admin_area: 'Kerala',
      postal_code: '682011'
    })
  })

  it('keeps the isolate when one component is unusable, rather than refusing the result', () => {
    const db = open()
    db.saveRecord(record({ country_code: 'IND', locality: 'Kochi', postal_code: 'NOT-A-PIN' }) as never)
    const [read] = db.listRecords({ labCode: 'LAB1' })
    expect(read?.patient_residence).toEqual({ country_code: 'IND', locality: 'KOCHI' })
  })

  /**
   * The upgrade an existing deployment performs: two free-text columns named after one
   * country's tiers become one structured residence, and the columns go.
   */
  it('lifts patient_state and patient_municipality, then drops them', () => {
    const legacy = new DatabaseSync(path())
    legacy.exec(`
      CREATE TABLE isolates(
        id INTEGER PRIMARY KEY AUTOINCREMENT, lab_code TEXT NOT NULL, patient_id TEXT, specimen_number TEXT,
        specimen_date TEXT, patient_state TEXT, patient_municipality TEXT
      );
      INSERT INTO isolates(lab_code, patient_id, specimen_number, specimen_date, patient_state, patient_municipality)
      VALUES ('LAB1', 'P1', 'S1', '2026-02-01', 'Kerala', 'Ernakulam'),
             ('LAB1', 'P2', 'S2', '2026-02-02', NULL, NULL);
    `)
    legacy.close()

    database = new AMRITDatabase(path()).initialize()
    const connection = database.rawConnectionForTesting()
    const columns = (connection.prepare('PRAGMA table_info(isolates)').all() as Array<{ name: string }>).map((row) => row.name)
    expect(columns).toContain('patient_residence_json')
    expect(columns).not.toContain('patient_state')
    expect(columns).not.toContain('patient_municipality')

    const rows = connection.prepare('SELECT patient_id, patient_residence_json FROM isolates ORDER BY patient_id')
      .all() as Array<{ patient_id: string; patient_residence_json: string | null }>
    expect(JSON.parse(String(rows[0]?.patient_residence_json))).toEqual({
      country_code: 'IND',
      admin_area: 'Kerala',
      locality: 'Ernakulam'
    })
    // Nothing is invented for a row that never had geography.
    expect(rows[1]?.patient_residence_json).toBeNull()

    const versions = (connection.prepare('SELECT version FROM app_schema_migrations ORDER BY version').all() as Array<{ version: number }>)
      .map((row) => row.version)
    expect(versions).toContain(5)
  })
})

describe('a residence on the way out', () => {
  beforeEach(() => setActiveCountryProfile(indiaProfile))

  const row = {
    lab_code: 'LAB1',
    patient_id: 'P1',
    specimen_number: 'S1',
    specimen_date: '2026-02-01',
    specimen_type: 'Blood',
    organism: 'Escherichia coli',
    organism_code: 'ECO',
    date_of_birth: '1980-04-02',
    antibiotic_results: { MEM: { result: 'R' } },
    patient_residence: { country_code: 'IND', locality: 'KOCHI', admin_area: 'Kerala', postal_code: '682011' }
  } as never

  const lab = { code: 'LAB1', name: 'Test lab', country_code: 'IND' } as never

  it('coarsens the postal code in a FHIR bundle', () => {
    const bundle = buildFhirBundle([row], lab) as { entry: Array<{ resource: Record<string, unknown> }> }
    const patient = bundle.entry.map((item) => item.resource).find((resource) => resource.resourceType === 'Patient')
    const address = (patient?.address as Array<Record<string, unknown>>)[0]
    expect(address?.postalCode).toBe('682')
    expect(address?.city).toBe('KOCHI')
    expect(address && 'line' in address).toBe(false)
  })

  it('coarsens it in a CSV export too — a spreadsheet leaves the building as surely as a bundle', () => {
    const csv = createWhonetCsv([row])
    const [headers, values] = csv.split('\n')
    const index = (headers ?? '').split(',').indexOf('Patient postal code')
    expect(index).toBeGreaterThan(-1)
    expect((values ?? '').split(',')[index]).toBe('682')
    expect(csv).not.toContain('682011')
  })

  it('drops the code entirely when the deployment sets zero', () => {
    setActiveCountryProfile({ ...indiaProfile, privacy: { ...indiaProfile.privacy, patient_postal_code_digits: 0 } })
    const bundle = buildFhirBundle([row], lab) as { entry: Array<{ resource: Record<string, unknown> }> }
    const patient = bundle.entry.map((item) => item.resource).find((resource) => resource.resourceType === 'Patient')
    const address = (patient?.address as Array<Record<string, unknown>>)[0]
    expect(address && 'postalCode' in address).toBe(false)
    expect(address?.city).toBe('KOCHI')
    setActiveCountryProfile(indiaProfile)
  })
})

describe('importing a residence', () => {
  let directory = ''
  beforeEach(() => {
    setActiveCountryProfile(indiaProfile)
    directory = mkdtempSync(join(tmpdir(), 'amrit-residence-import-'))
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  it('recognises the postal code under whatever the source file calls it', async () => {
    const file = join(directory, 'isolates.csv')
    writeFileSync(
      file,
      'Patient ID,Specimen number,Specimen date,Specimen type,Organism,PIN Code,City,State\n' +
        'P1,S1,2026-02-01,Blood,Escherichia coli,682011,Kochi,Kerala\n',
      'utf8'
    )
    const preview = await parseImportPreview(file, 'LAB1')
    expect(preview.rows[0]?.patient_residence).toEqual({
      postal_code: '682011',
      locality: 'Kochi',
      admin_area: 'Kerala'
    })
    // The loose columns are folded in, not left beside the structured value.
    expect(preview.rows[0]?.patient_postal_code).toBeUndefined()
  })
})
