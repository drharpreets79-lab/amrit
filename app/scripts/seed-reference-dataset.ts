/**
 * Replace the operational contents of a database with a large, coherent reference dataset.
 *
 * What this is for: exercising the application at a realistic size — analytics, antibiograms,
 * scope filters, exports, the mapping and paging code — against two countries at once, so
 * India-shaped assumptions have somewhere to fail visibly.
 *
 * Two rules it keeps:
 *
 *   - **Reference catalogues are never touched.** Organisms, antimicrobials, specimens,
 *     coded values, expert rules, expected resistance, genomic markers, breakpoints and the
 *     administrative tree all survive. Only operational content — laboratories, isolates,
 *     panels, locations, facilities, events, imports — is cleared.
 *   - **Everything is written through the ordinary application paths.** `saveLab`,
 *     `saveMaster` and `saveRecord` do the writing, so every row here is a row the running
 *     application would accept: same validation, same address rules, same decision support.
 *     Inserting into the tables directly would happily produce records the UI refuses.
 *
 * The facilities are real, named public hospitals with their real cities and postal codes,
 * every one of which resolves in the bundled geographic directory. The clinical content —
 * patients, specimens, results — is synthetic. Resistance rates are set per country and per
 * organism to the broad pattern the published surveillance reports describe (India higher
 * than the United States for Enterobacterales carbapenem resistance, comparable for MRSA);
 * they are plausible teaching data and are not a citable estimate of anything.
 *
 * Usage:
 *   npx jiti scripts/seed-reference-dataset.ts --database "<path>" [--records 10000]
 *   npx jiti scripts/seed-reference-dataset.ts --database "<path>" --dry-run
 */

import { copyFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AMRITDatabase } from '../src/main/database'
import { PACKAGED_CATALOGUE_DATASET, loadPackagedCatalogue } from '../src/main/catalog-seed'
import { isoFallbackPack } from '../src/main/geo-pack'
import type { IsolateRecord } from '../src/shared/types'

const currentDirectory = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Facilities
// ---------------------------------------------------------------------------

interface Facility {
  code: string
  name: string
  countryCode: string
  countryName: string
  lines: string[]
  locality: string
  adminArea: string
  postalCode: string
  /** Wards this site reports from, used for the location master and for records. */
  wards: string[]
}

/** Ten Indian and ten United States public/teaching hospitals, with real postal codes. */
const FACILITIES: Facility[] = [
  { code: 'IN-AIIMS-DEL', name: 'All India Institute of Medical Sciences, New Delhi', countryCode: 'IND', countryName: 'India', lines: ['Department of Microbiology', 'Ansari Nagar East'], locality: 'New Delhi', adminArea: 'Delhi', postalCode: '110029', wards: ['Medical ICU', 'Surgical ICU', 'General Medicine', 'Paediatrics', 'Emergency', 'Nephrology'] },
  { code: 'IN-PGIMER-CHD', name: 'Postgraduate Institute of Medical Education and Research, Chandigarh', countryCode: 'IND', countryName: 'India', lines: ['Department of Medical Microbiology', 'Sector 12'], locality: 'Chandigarh', adminArea: 'Chandigarh', postalCode: '160012', wards: ['Medical ICU', 'Neurosurgery', 'General Medicine', 'Emergency', 'Haematology'] },
  { code: 'IN-CMC-VEL', name: 'Christian Medical College, Vellore', countryCode: 'IND', countryName: 'India', lines: ['Department of Clinical Microbiology', 'Ida Scudder Road'], locality: 'Vellore', adminArea: 'Tamil Nadu', postalCode: '632004', wards: ['Medical ICU', 'General Medicine', 'Paediatrics', 'Surgery', 'Infectious Diseases'] },
  { code: 'IN-TMH-MUM', name: 'Tata Memorial Hospital, Mumbai', countryCode: 'IND', countryName: 'India', lines: ['Department of Microbiology', 'Dr E Borges Road, Parel'], locality: 'Mumbai', adminArea: 'Maharashtra', postalCode: '400012', wards: ['Haemato-oncology', 'Surgical ICU', 'Medical Oncology', 'Bone Marrow Transplant', 'Emergency'] },
  { code: 'IN-SGPGI-LKO', name: 'Sanjay Gandhi Postgraduate Institute of Medical Sciences, Lucknow', countryCode: 'IND', countryName: 'India', lines: ['Department of Microbiology', 'Raebareli Road'], locality: 'Lucknow', adminArea: 'Uttar Pradesh', postalCode: '226014', wards: ['Medical ICU', 'Nephrology', 'Gastroenterology', 'General Medicine', 'Emergency'] },
  { code: 'IN-NIMS-HYD', name: "Nizam's Institute of Medical Sciences, Hyderabad", countryCode: 'IND', countryName: 'India', lines: ['Department of Microbiology', 'Punjagutta'], locality: 'Hyderabad', adminArea: 'Telangana', postalCode: '500082', wards: ['Medical ICU', 'Cardiothoracic ICU', 'General Medicine', 'Nephrology', 'Emergency'] },
  { code: 'IN-SCTIMST-TVM', name: 'Sree Chitra Tirunal Institute for Medical Sciences and Technology, Thiruvananthapuram', countryCode: 'IND', countryName: 'India', lines: ['Department of Microbiology', 'Medical College PO'], locality: 'Thiruvananthapuram', adminArea: 'Kerala', postalCode: '695011', wards: ['Cardiac ICU', 'Neurology', 'Cardiothoracic Surgery', 'General Medicine'] },
  { code: 'IN-IPGMER-KOL', name: 'Institute of Post-Graduate Medical Education and Research, Kolkata', countryCode: 'IND', countryName: 'India', lines: ['Department of Microbiology', '244 AJC Bose Road'], locality: 'Kolkata', adminArea: 'West Bengal', postalCode: '700020', wards: ['Medical ICU', 'General Medicine', 'Paediatrics', 'Surgery', 'Emergency'] },
  { code: 'IN-JIPMER-PDY', name: 'Jawaharlal Institute of Postgraduate Medical Education and Research, Puducherry', countryCode: 'IND', countryName: 'India', lines: ['Department of Microbiology', 'Dhanvantari Nagar'], locality: 'Puducherry', adminArea: 'Pondicherry', postalCode: '605006', wards: ['Medical ICU', 'Neonatal ICU', 'General Medicine', 'Surgery', 'Emergency'] },
  { code: 'IN-SJMC-BLR', name: "St John's Medical College Hospital, Bengaluru", countryCode: 'IND', countryName: 'India', lines: ['Department of Microbiology', 'Sarjapur Road, Koramangala'], locality: 'Bengaluru', adminArea: 'Karnataka', postalCode: '560034', wards: ['Medical ICU', 'General Medicine', 'Paediatrics', 'Obstetrics', 'Emergency'] },

  { code: 'US-MGH-BOS', name: 'Massachusetts General Hospital, Boston', countryCode: 'USA', countryName: 'United States of America', lines: ['Clinical Microbiology Laboratory', '55 Fruit Street'], locality: 'Boston', adminArea: 'Massachusetts', postalCode: '02114', wards: ['Medical ICU', 'Surgical ICU', 'Internal Medicine', 'Emergency Department', 'Oncology'] },
  { code: 'US-JHH-BAL', name: 'The Johns Hopkins Hospital, Baltimore', countryCode: 'USA', countryName: 'United States of America', lines: ['Division of Medical Microbiology', '1800 Orleans Street'], locality: 'Baltimore', adminArea: 'Maryland', postalCode: '21287', wards: ['Medical ICU', 'Transplant', 'Internal Medicine', 'Emergency Department', 'Paediatrics'] },
  { code: 'US-MAYO-ROC', name: 'Mayo Clinic Hospital, Rochester', countryCode: 'USA', countryName: 'United States of America', lines: ['Clinical Microbiology', '1216 Second Street SW'], locality: 'Rochester', adminArea: 'Minnesota', postalCode: '55905', wards: ['Medical ICU', 'Cardiac Surgery', 'Internal Medicine', 'Transplant', 'Emergency Department'] },
  { code: 'US-CCF-CLE', name: 'Cleveland Clinic, Cleveland', countryCode: 'USA', countryName: 'United States of America', lines: ['Department of Laboratory Medicine', '9500 Euclid Avenue'], locality: 'Cleveland', adminArea: 'Ohio', postalCode: '44195', wards: ['Cardiothoracic ICU', 'Medical ICU', 'Internal Medicine', 'Emergency Department'] },
  { code: 'US-UCSF-SFO', name: 'UCSF Medical Center, San Francisco', countryCode: 'USA', countryName: 'United States of America', lines: ['Clinical Laboratories', '505 Parnassus Avenue'], locality: 'San Francisco', adminArea: 'California', postalCode: '94143', wards: ['Medical ICU', 'Internal Medicine', 'Oncology', 'Emergency Department', 'Paediatrics'] },
  { code: 'US-NYP-NYC', name: 'NewYork-Presbyterian / Columbia University Irving Medical Center', countryCode: 'USA', countryName: 'United States of America', lines: ['Clinical Microbiology Service', '622 West 168th Street'], locality: 'New York', adminArea: 'New York', postalCode: '10032', wards: ['Medical ICU', 'Surgical ICU', 'Internal Medicine', 'Emergency Department', 'Neonatal ICU'] },
  { code: 'US-CSMC-LAX', name: 'Cedars-Sinai Medical Center, Los Angeles', countryCode: 'USA', countryName: 'United States of America', lines: ['Department of Pathology and Laboratory Medicine', '8700 Beverly Boulevard'], locality: 'Los Angeles', adminArea: 'California', postalCode: '90048', wards: ['Medical ICU', 'Internal Medicine', 'Cardiology', 'Emergency Department'] },
  { code: 'US-NMH-CHI', name: 'Northwestern Memorial Hospital, Chicago', countryCode: 'USA', countryName: 'United States of America', lines: ['Clinical Microbiology Laboratory', '251 East Huron Street'], locality: 'Chicago', adminArea: 'Illinois', postalCode: '60611', wards: ['Medical ICU', 'Internal Medicine', 'Transplant', 'Emergency Department'] },
  { code: 'US-BJH-STL', name: 'Barnes-Jewish Hospital, St Louis', countryCode: 'USA', countryName: 'United States of America', lines: ['Clinical Microbiology Laboratory', '1 Barnes-Jewish Hospital Plaza'], locality: 'Saint Louis', adminArea: 'Missouri', postalCode: '63110', wards: ['Medical ICU', 'Internal Medicine', 'Surgical ICU', 'Emergency Department'] },
  { code: 'US-CMC-ITH', name: 'Cayuga Medical Center, Ithaca', countryCode: 'USA', countryName: 'United States of America', lines: ['Laboratory Services', '101 Dates Drive'], locality: 'Ithaca', adminArea: 'New York', postalCode: '14850', wards: ['Intensive Care', 'Medical/Surgical', 'Emergency Department', 'Obstetrics'] }
]

// ---------------------------------------------------------------------------
// Clinical content
// ---------------------------------------------------------------------------

interface OrganismProfile {
  code: string
  name: string
  /** Specimens this organism is plausibly isolated from, in rough order of frequency. */
  specimens: string[]
  /** Antimicrobials a laboratory would report for it. */
  panel: string[]
  /** Share of all isolates at a site. Weights need not sum to one. */
  weight: number
  /** Carbapenemase-class markers worth testing when it is carbapenem resistant. */
  carbapenemMarkers?: boolean
}

const ENTERO_PANEL = ['AMP', 'AMC', 'TZP', 'CXM', 'CTX', 'CRO', 'CAZ', 'FEP', 'ETP', 'MEM', 'IPM', 'CIP', 'GEN', 'AMK', 'SXT']
const ORGANISMS: OrganismProfile[] = [
  { code: 'ECO', name: 'Escherichia coli', specimens: ['URINE', 'BLOOD_STERILE', 'INTRA_ABDOMINAL_DEEP'], panel: [...ENTERO_PANEL, 'NIT'], weight: 26, carbapenemMarkers: true },
  { code: 'KPN', name: 'Klebsiella pneumoniae complex', specimens: ['BLOOD_STERILE', 'LOWER_RESP', 'URINE'], panel: [...ENTERO_PANEL, 'COL', 'TGC'], weight: 18, carbapenemMarkers: true },
  { code: 'SAU', name: 'Staphylococcus aureus', specimens: ['BLOOD_STERILE', 'DEEP_TISSUE_WOUND'], panel: ['PEN', 'OXA', 'ERY', 'CLI', 'CIP', 'GEN', 'SXT', 'TET', 'VAN', 'LNZ', 'DAP'], weight: 15 },
  { code: 'PAE', name: 'Pseudomonas aeruginosa', specimens: ['LOWER_RESP', 'DEEP_TISSUE_WOUND', 'URINE'], panel: ['TZP', 'CAZ', 'FEP', 'IPM', 'MEM', 'CIP', 'LVX', 'GEN', 'AMK', 'COL'], weight: 11, carbapenemMarkers: true },
  { code: 'ABA', name: 'Acinetobacter baumannii', specimens: ['LOWER_RESP', 'BLOOD_STERILE'], panel: ['IPM', 'MEM', 'CIP', 'LVX', 'GEN', 'AMK', 'SXT', 'COL', 'TGC'], weight: 9, carbapenemMarkers: true },
  { code: 'EFA', name: 'Enterococcus faecalis', specimens: ['URINE', 'BLOOD_STERILE'], panel: ['AMP', 'NIT', 'VAN', 'LNZ', 'TGC'], weight: 6 },
  { code: 'EFM', name: 'Enterococcus faecium', specimens: ['BLOOD_STERILE', 'URINE'], panel: ['AMP', 'VAN', 'LNZ', 'TGC', 'DAP'], weight: 4 },
  { code: 'SPN', name: 'Streptococcus pneumoniae', specimens: ['LOWER_RESP', 'BLOOD_STERILE', 'CSF'], panel: ['PEN', 'CTX', 'ERY', 'CLI', 'LVX', 'SXT', 'TET', 'VAN'], weight: 4 },
  { code: 'PMI', name: 'Proteus mirabilis', specimens: ['URINE'], panel: ENTERO_PANEL, weight: 3 },
  { code: 'SAL', name: 'Salmonella sp.', specimens: ['ENTERIC_STOOL', 'BLOOD_STERILE'], panel: ['AMP', 'CTX', 'CRO', 'CIP', 'AZM', 'SXT'], weight: 2 },
  { code: 'HIN', name: 'Haemophilus influenzae', specimens: ['LOWER_RESP'], panel: ['AMP', 'AMC', 'CTX', 'CIP', 'AZM', 'SXT'], weight: 2 }
]

const SPECIMEN_NAMES: Record<string, string> = {
  URINE: 'Urine',
  BLOOD_STERILE: 'Blood / normally sterile fluid',
  CSF: 'Cerebrospinal fluid',
  LOWER_RESP: 'Lower respiratory tract',
  DEEP_TISSUE_WOUND: 'Deep tissue / wound / musculoskeletal',
  INTRA_ABDOMINAL_DEEP: 'Intra-abdominal / deep sterile specimen',
  ENTERIC_STOOL: 'Stool / enteric'
}

/** ICD-10 category from the seeded diagnosis value set, by specimen. */
const DIAGNOSIS_BY_SPECIMEN: Record<string, [string, string]> = {
  URINE: ['N39.0', 'Urinary tract infection, site not specified'],
  BLOOD_STERILE: ['A41', 'Other sepsis'],
  CSF: ['G00', 'Bacterial meningitis, not elsewhere classified'],
  LOWER_RESP: ['J18', 'Pneumonia, organism unspecified'],
  DEEP_TISSUE_WOUND: ['L03', 'Cellulitis'],
  INTRA_ABDOMINAL_DEEP: ['K65', 'Peritonitis'],
  ENTERIC_STOOL: ['A09', 'Infectious gastroenteritis and colitis, unspecified']
}
const ICD10_SYSTEM = 'http://hl7.org/fhir/sid/icd-10'

/**
 * Non-susceptibility shares by country and antimicrobial class.
 *
 * The broad shape published surveillance describes: Enterobacterales carbapenem and
 * third-generation-cephalosporin resistance far higher in India than in the United States,
 * MRSA comparable in both, colistin resistance low everywhere. Teaching data — plausible,
 * not a citable estimate.
 */
const RESISTANCE: Record<string, Record<string, number>> = {
  IND: { carbapenem: 0.44, cephalosporin3: 0.72, fluoroquinolone: 0.68, aminoglycoside: 0.42, betalactam: 0.82, colistin: 0.04, glycopeptide: 0.06, oxacillin: 0.42, cotrimoxazole: 0.55, other: 0.35 },
  USA: { carbapenem: 0.06, cephalosporin3: 0.16, fluoroquinolone: 0.28, aminoglycoside: 0.11, betalactam: 0.46, colistin: 0.02, glycopeptide: 0.04, oxacillin: 0.38, cotrimoxazole: 0.24, other: 0.18 }
}

const CLASS_OF: Record<string, string> = {
  MEM: 'carbapenem', IPM: 'carbapenem', ETP: 'carbapenem',
  CTX: 'cephalosporin3', CRO: 'cephalosporin3', CAZ: 'cephalosporin3', FEP: 'cephalosporin3', CXM: 'cephalosporin3',
  CIP: 'fluoroquinolone', LVX: 'fluoroquinolone',
  GEN: 'aminoglycoside', AMK: 'aminoglycoside',
  AMP: 'betalactam', AMC: 'betalactam', TZP: 'betalactam', PEN: 'betalactam',
  COL: 'colistin', VAN: 'glycopeptide', OXA: 'oxacillin', SXT: 'cotrimoxazole'
}

/** Carbapenemase genes by region — blaNDM predominates in South Asia, blaKPC in the US. */
const CARBAPENEMASE: Record<string, Array<{ code: string; share: number }>> = {
  IND: [{ code: 'BLANDM', share: 0.55 }, { code: 'BLAOXA48', share: 0.28 }, { code: 'BLAKPC', share: 0.07 }, { code: 'BLAVIM', share: 0.05 }],
  USA: [{ code: 'BLAKPC', share: 0.62 }, { code: 'BLANDM', share: 0.14 }, { code: 'BLAOXA48', share: 0.12 }, { code: 'BLAVIM', share: 0.05 }]
}

const IDENTIFICATION = ['MALDI-TOF', 'Automated biochemical', '16S rRNA sequencing', 'Conventional biochemical']
const LOCATION_TYPES = ['Inpatient', 'ICU', 'Outpatient', 'Emergency']

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

/** The same dataset every run, so a screenshot and a bug report describe the same rows. */
function sequence(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

const pick = <T>(random: () => number, items: readonly T[]): T => items[Math.floor(random() * items.length) % items.length]!

function weighted(random: () => number, items: OrganismProfile[]): OrganismProfile {
  const total = items.reduce((sum, item) => sum + item.weight, 0)
  let roll = random() * total
  for (const item of items) {
    roll -= item.weight
    if (roll <= 0) return item
  }
  return items[items.length - 1]!
}

const isoDate = (daysAgo: number): string => {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() - daysAgo)
  return date.toISOString().slice(0, 10)
}

const shiftDate = (date: string, days: number): string => {
  const parsed = new Date(`${date}T00:00:00Z`)
  parsed.setUTCDate(parsed.getUTCDate() + days)
  return parsed.toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Wipe
// ---------------------------------------------------------------------------

/**
 * Operational tables, emptied. Reference catalogues are absent from this list on purpose —
 * organisms, antimicrobials, specimens, coded values, the administrative tree, expert rules,
 * expected resistance, genomic markers and breakpoints all stay exactly as they are.
 *
 * Ordered children-before-parents so foreign keys hold throughout.
 */
const OPERATIONAL_TABLES = [
  'isolate_ast_results', 'isolate_genomic_results', 'isolates',
  'lab_panel_antibiotics', 'lab_panel_genomic_markers', 'lab_panel_organisms', 'lab_panel_specimens', 'lab_panels',
  'lab_locations', 'lab_data_fields', 'lab_antibiotic_settings', 'lab_custom_alerts',
  'lab_domains', 'lab_organisms', 'lab_antibiotics', 'lab_alerts',
  'import_history', 'import_profiles', 'import_batches',
  'analysis_macros', 'omics_records', 'lab_catalog_seed_state',
  'national_events', 'national_alerts', 'national_actions', 'national_outbox',
  'master_hospitals',
  'laboratory'
]

function wipeOperational(database: AMRITDatabase): Record<string, number> {
  const raw = database.rawConnectionForTesting()
  const present = new Set((raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
    .map((row) => row.name))
  const removed: Record<string, number> = {}
  raw.exec('PRAGMA foreign_keys = OFF')
  raw.exec('BEGIN IMMEDIATE')
  try {
    for (const table of OPERATIONAL_TABLES) {
      if (!present.has(table)) continue
      const before = Number((raw.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c)
      if (!before) continue
      raw.prepare(`DELETE FROM ${table}`).run()
      removed[table] = before
    }
    // The selected-laboratory pointer would otherwise name a site that no longer exists.
    if (present.has('app_preferences')) {
      raw.prepare("DELETE FROM app_preferences WHERE pref_key = 'current_lab_code'").run()
    }
    raw.exec('COMMIT')
  } catch (error) {
    raw.exec('ROLLBACK')
    throw error
  } finally {
    raw.exec('PRAGMA foreign_keys = ON')
  }
  return removed
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/**
 * Make sure both countries have an administrative tree.
 *
 * India's arrives with the packaged geo pack; the United States has none until asked for,
 * and without it every American laboratory resolves to no reporting unit and drops out of
 * every regional roll-up. The ISO 3166-2 fallback gives one level of states, which is what
 * the standard covers.
 */
function ensureAdminUnits(database: AMRITDatabase, countryCodes: string[]): Record<string, number> {
  const raw = database.rawConnectionForTesting()
  const added: Record<string, number> = {}
  for (const countryCode of countryCodes) {
    const existing = Number((raw.prepare('SELECT COUNT(*) AS c FROM master_admin_units WHERE country_code = ?')
      .get(countryCode) as { c: number }).c)
    if (existing > 0) { added[countryCode] = 0; continue }
    const pack = isoFallbackPack(countryCode)
    if (!pack) { added[countryCode] = 0; continue }
    const path = join(tmpdir(), `amrit-geo-${countryCode}-${process.pid}.json`)
    writeFileSync(path, JSON.stringify(pack), 'utf8')
    try {
      added[countryCode] = database.importGeoPack(path).units
    } finally {
      unlinkSync(path)
    }
  }
  return added
}

/**
 * Record that the packaged catalogue is present, when it is present but unrecorded.
 *
 * A new laboratory gets its starting configuration — AST panels, data fields, the organism
 * and antimicrobial selections — from `seedLaboratoryCatalogue`, which refuses to run unless
 * `app_catalog_seed_state` says the packaged catalogue was seeded. A database populated by
 * migration or by an earlier build holds the catalogue without holding that marker, so every
 * laboratory created in it comes up with no panels at all and every isolate matches nothing.
 *
 * The marker is written only when the catalogue tables really are populated, and it records
 * the asset actually on disk. It asserts what is true rather than unlocking a shortcut.
 */
function recordCatalogueState(database: AMRITDatabase, catalogSeedPath: string): boolean {
  const raw = database.rawConnectionForTesting()
  const marked = raw.prepare('SELECT 1 FROM app_catalog_seed_state WHERE dataset = ?')
    .get(PACKAGED_CATALOGUE_DATASET)
  if (marked) return false
  const organisms = Number((raw.prepare('SELECT COUNT(*) AS c FROM master_organisms').get() as { c: number }).c)
  const antibiotics = Number((raw.prepare('SELECT COUNT(*) AS c FROM master_antibiotics').get() as { c: number }).c)
  if (!organisms || !antibiotics) return false
  const { asset } = loadPackagedCatalogue(catalogSeedPath)
  raw.prepare(`INSERT INTO app_catalog_seed_state(dataset, source_version, source_hash, source_path, row_counts_json)
    VALUES (?, ?, ?, ?, ?)`).run(
    PACKAGED_CATALOGUE_DATASET, String(asset.version), String(asset.contentSha256), catalogSeedPath,
    JSON.stringify({ master_organisms: organisms, master_antibiotics: antibiotics })
  )
  return true
}

function seedFacilities(database: AMRITDatabase): void {
  for (const facility of FACILITIES) {
    database.saveLab({
      code: facility.code,
      name: facility.name,
      country: facility.countryName,
      country_code: facility.countryCode,
      address: {
        country_code: facility.countryCode,
        address_lines: facility.lines,
        locality: facility.locality,
        admin_area: facility.adminArea,
        postal_code: facility.postalCode
      },
      site_group: 'Human health',
      default_guideline: facility.countryCode === 'IND' ? 'CLSI' : 'CLSI',
      default_test_method: 'Disk diffusion',
      guideline_year: String(new Date().getFullYear()),
      active: true
    })

    // The same building as a reporting facility, so `hospital_code` on a record resolves to
    // a row rather than dangling as free text.
    database.saveMaster('hospitals', {
      code: facility.code,
      name: facility.name,
      facility_type: 'Tertiary care hospital',
      domain_code: 'human',
      address_json: {
        country_code: facility.countryCode,
        address_lines: facility.lines,
        locality: facility.locality,
        admin_area: facility.adminArea,
        postal_code: facility.postalCode
      },
      active: 1,
      sort_order: 0
    })

    for (const [index, ward] of facility.wards.entries()) {
      database.saveMaster('locations', {
        location_code: `${facility.code}-W${index + 1}`,
        location_name: ward,
        location_type: /ICU|Intensive/i.test(ward) ? 'icu' : /Emergency/i.test(ward) ? 'eme' : 'inp',
        department: 'int',
        institution: facility.name,
        active: 1,
        sort_order: (index + 1) * 10
      }, facility.code)
    }
  }
}

interface SeedCounts { records: number; refused: number }

function seedRecords(database: AMRITDatabase, total: number): SeedCounts {
  const random = sequence(20260813)
  const perSite = Math.floor(total / FACILITIES.length)
  const remainder = total - perSite * FACILITIES.length
  let records = 0
  let refused = 0

  for (const [siteIndex, facility] of FACILITIES.entries()) {
    const target = perSite + (siteIndex < remainder ? 1 : 0)
    const rates = RESISTANCE[facility.countryCode] ?? RESISTANCE.USA!
    const genes = CARBAPENEMASE[facility.countryCode] ?? CARBAPENEMASE.USA!

    for (let index = 0; index < target; index += 1) {
      const organism = weighted(random, ORGANISMS)
      const specimenCode = pick(random, organism.specimens)
      const specimenDate = isoDate(Math.floor(random() * 730))
      const admissionOffset = Math.floor(random() * 12) + 1
      const ageYears = Math.min(98, Math.max(0, Math.floor(random() * 88) + 1))
      const ward = pick(random, facility.wards)
      const [diagnosisCode, diagnosisText] = DIAGNOSIS_BY_SPECIMEN[specimenCode] ?? ['B99', 'Other and unspecified infectious diseases']

      // Results. Each agent's non-susceptibility comes from its class rate for this
      // country, nudged per isolate so a site is not uniformly resistant.
      const bias = 0.75 + random() * 0.5
      const results: Record<string, { result: string; measurement: string; method: string; guideline: string }> = {}
      let carbapenemResistant = false
      for (const code of organism.panel) {
        const rate = Math.min(0.96, (rates[CLASS_OF[code] ?? 'other'] ?? rates.other!) * bias)
        const roll = random()
        const result = roll < rate ? 'R' : roll < rate + 0.1 ? 'I' : 'S'
        if (result === 'R' && CLASS_OF[code] === 'carbapenem') carbapenemResistant = true
        results[code] = {
          result,
          // Zone diameters, since the method is disk diffusion: resistant isolates give
          // small zones, susceptible ones large. Kept inside plausible physical bounds.
          measurement: String(result === 'R' ? 6 + Math.floor(random() * 8) : result === 'I' ? 14 + Math.floor(random() * 4) : 18 + Math.floor(random() * 14)),
          method: 'Disk diffusion',
          guideline: 'CLSI'
        }
      }

      // A carbapenem-resistant Gram-negative gets the molecular test a laboratory would
      // actually order, and the gene distribution follows the region.
      const genomic: Record<string, { result: string; method: string; target?: string }> = {}
      if (carbapenemResistant && organism.carbapenemMarkers) {
        let roll = random()
        let detected = ''
        for (const gene of genes) {
          roll -= gene.share
          if (roll <= 0) { detected = gene.code; break }
        }
        for (const gene of genes) {
          genomic[gene.code] = {
            result: gene.code === detected ? 'detected' : 'not_detected',
            method: 'Multiplex PCR'
          }
        }
      }

      const record: IsolateRecord = {
        lab_code: facility.code,
        patient_id: `${facility.code}-P${String(100000 + Math.floor(random() * 899999))}`,
        specimen_number: `${facility.code}-${specimenDate.replace(/-/g, '')}-${String(index + 1).padStart(5, '0')}`,
        specimen_date: specimenDate,
        specimen_code: specimenCode,
        specimen_type: SPECIMEN_NAMES[specimenCode] ?? specimenCode,
        organism_code: organism.code,
        organism: organism.name,
        sex: random() < 0.49 ? 'f' : 'm',
        date_of_birth: shiftDate(specimenDate, -(ageYears * 365 + Math.floor(random() * 365))),
        age_years: ageYears,
        location: ward,
        location_type: /ICU|Intensive/i.test(ward) ? 'ICU' : /Emergency/i.test(ward) ? 'Emergency' : pick(random, LOCATION_TYPES),
        admission_date: shiftDate(specimenDate, -admissionOffset),
        diagnosis_code: diagnosisCode,
        diagnosis: diagnosisText,
        diagnosis_system: ICD10_SYSTEM,
        domain: 'human',
        hospital_code: facility.code,
        hospital_name: facility.name,
        identification_method: pick(random, IDENTIFICATION),
        identification_score: `${(1.9 + random() * 0.5).toFixed(2)}`,
        ast_method: 'Disk diffusion',
        record_status: 'final',
        antibiotic_results: results as IsolateRecord['antibiotic_results'],
        ...(Object.keys(genomic).length ? { genomic_results: genomic as IsolateRecord['genomic_results'] } : {}),
        // The patient's town and postal code, never a street: the same coarsening the
        // application enforces everywhere else.
        patient_residence: {
          country_code: facility.countryCode,
          locality: facility.locality,
          admin_area: facility.adminArea,
          postal_code: facility.postalCode
        },
        notes: `Isolated at ${facility.name}; reported from ${ward}.`
      }

      try {
        database.saveRecord(record)
        records += 1
      } catch (error) {
        refused += 1
        if (refused <= 5) console.warn('  refused:', error instanceof Error ? error.message : error)
      }
    }
  }
  return { records, refused }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function argument(name: string, fallback = ''): string {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? String(process.argv[index + 1] ?? fallback) : fallback
}

function main(): void {
  const databasePath = argument('database')
  if (!databasePath) throw new Error('--database <path> is required')
  if (!existsSync(databasePath)) throw new Error(`No database at ${databasePath}`)
  const total = Number(argument('records', '10000'))
  const dryRun = process.argv.includes('--dry-run')

  const backup = `${databasePath}.before-reference-seed-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`
  if (!dryRun) {
    copyFileSync(databasePath, backup)
    console.log(`Backup written: ${backup}`)
  }

  // `seedCatalog` is what unlocks the per-laboratory catalogue — panels, data fields, the
  // organism and antimicrobial selections a new site starts with. The global catalogue is
  // already seeded and its guard returns early, so this adds nothing to the reference
  // tables; without it every laboratory here would come up with no AST panels at all.
  const database = new AMRITDatabase(databasePath, {
    seedCatalog: true,
    catalogSeedPath: resolve(currentDirectory, '../resources/catalog-seed.v2.json')
  }).initialize()
  const raw = database.rawConnectionForTesting()
  const count = (table: string): number =>
    Number((raw.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c)

  console.log('\nBefore:')
  for (const table of ['laboratory', 'isolates', 'master_hospitals', 'lab_panels', 'master_organisms', 'master_antibiotics', 'master_samples', 'master_admin_units']) {
    console.log(`  ${table.padEnd(20)} ${count(table)}`)
  }
  if (dryRun) { console.log('\n--dry-run: nothing written.'); database.close(); return }

  console.log('\nClearing operational data…')
  for (const [table, rows] of Object.entries(wipeOperational(database))) console.log(`  ${table.padEnd(24)} -${rows}`)

  console.log('\nAdministrative units…')
  for (const [country, added] of Object.entries(ensureAdminUnits(database, ['IND', 'USA']))) {
    console.log(`  ${country} ${added ? `+${added}` : 'already present'}`)
  }

  const catalogSeedPath = resolve(currentDirectory, '../resources/catalog-seed.v2.json')
  if (recordCatalogueState(database, catalogSeedPath)) {
    console.log('\nPackaged catalogue was present but unrecorded; state written so laboratories get their panels.')
  }

  console.log('\nFacilities…')
  seedFacilities(database)
  database.selectLab(FACILITIES[0]!.code)
  console.log(`  ${FACILITIES.length} laboratories, ${FACILITIES.length} hospital records`)

  console.log(`\nRecords (target ${total})…`)
  const started = Date.now()
  const { records, refused } = seedRecords(database, total)
  console.log(`  ${records} written, ${refused} refused, ${((Date.now() - started) / 1000).toFixed(1)}s`)

  console.log('\nAfter:')
  for (const table of ['laboratory', 'isolates', 'isolate_ast_results', 'master_hospitals', 'master_organisms', 'master_antibiotics', 'master_samples', 'master_admin_units']) {
    console.log(`  ${table.padEnd(22)} ${count(table)}`)
  }
  database.close()
}

main()
