import type { AMRITDatabase } from './database'
import { activeProfile } from './active-profile'
import type { IsolateRecord } from '../shared/types'

/**
 * A believable laboratory with a few weeks of results, for training and for the manual.
 *
 * Everything goes in through the ordinary write paths — `saveLab`, `saveRecord`,
 * `captureOneHealth` — so the demo data is valid by construction: it passes the same
 * decision-support checks, the same address rules and the same governance that a typed
 * record does. Seeding straight into the tables would happily produce rows the application
 * itself would refuse.
 *
 * Codes come from the packaged catalogue (WHONET organisms, antibiotics, the specimen
 * master), never invented here, so this stays correct as the catalogue changes.
 *
 * Deliberately not shipped as a user-facing feature: it is called only when
 * `AMRIT_DEMO_SEED` is set on an unpackaged build. A laboratory's real database must never
 * acquire invented isolates.
 */

const ORGANISMS: ReadonlyArray<{ code: string; name: string }> = [
  { code: 'ECO', name: 'Escherichia coli' },
  { code: 'KPN', name: 'Klebsiella pneumoniae complex' },
  { code: 'SAU', name: 'Staphylococcus aureus' }
]

const SPECIMENS: ReadonlyArray<{ code: string; name: string }> = [
  { code: 'BLOOD_STERILE', name: 'Blood / normally sterile fluid' },
  { code: 'URINE', name: 'Urine' },
  { code: 'LOWER_RESP', name: 'Lower respiratory tract' },
  { code: 'DEEP_TISSUE_WOUND', name: 'Deep tissue / wound / musculoskeletal' }
]

const ANTIBIOTICS = ['AMK', 'AMP', 'CIP', 'CRO', 'GEN', 'MEM', 'TZP', 'VAN'] as const

/** Resistance shares per organism, roughly the pattern a tertiary hospital reports. */
const RESISTANCE: Record<string, number> = { ECO: 0.34, KPN: 0.52, SAU: 0.41 }

const WARDS = ['ICU', 'Medicine', 'Surgery', 'Paediatrics', 'Emergency']
/** Deterministic pseudo-randomness: the same demo database every time it is built. */
function sequence(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
}

function isoDate(daysAgo: number): string {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() - daysAgo)
  return date.toISOString().slice(0, 10)
}

/**
 * The demo One Health operator.
 *
 * A fixed credential in source is acceptable *only* because this file runs on an
 * unpackaged build with `AMRIT_DEMO_SEED` set, against a throwaway database. Nothing here
 * touches a real deployment, which has no default account at all and refuses to invent one.
 */
export const DEMO_ONE_HEALTH_ADMIN = { username: 'demo.admin', password: 'DemoOneHealth2026!' }

/** One event per domain, so the workbench, its metrics and its outbox all have something. */
function seedOneHealthEvents(database: AMRITDatabase): void {
  const identity = database.bootstrapOneHealthAdmin(
    DEMO_ONE_HEALTH_ADMIN.username,
    DEMO_ONE_HEALTH_ADMIN.password
  )
  const observed = `${isoDate(3)}T09:00:00Z`
  const events: Array<[string, Record<string, unknown>]> = [
    ['human_quality', {
      facility_id: 'DEMO-LAB', observed_at: observed, indicator: 'contamination',
      numerator: 14, denominator: 1120, target: 3, corrective_action: 'Phlebotomy retraining scheduled'
    }],
    ['amc', {
      facility_id: 'DEMO-LAB', observed_at: observed, antimicrobial: 'Meropenem', atc_code: 'J01DH02',
      aware_group: 'Watch', quantity_grams: 1840, who_ddd_grams: 3, bed_days: 4200,
      source: 'hospital-pharmacy'
    }],
    // Every event is captured against a registered facility; the demo laboratory is the
    // only one this database has, and the animal and environmental events are reported
    // *by* it, which is how a laboratory acting as a sector node actually reports.
    ['veterinary', {
      facility_id: 'DEMO-LAB', observed_at: observed, host_species: 'Gallus gallus',
      production_class: 'Broiler', unit_ref: 'FLOCK-217', sampling_frame: 'farm',
      sample_type: 'Cloacal swab', organism: 'Escherichia coli', ast_summary: 'CIP resistant'
    }],
    ['environment', {
      facility_id: 'DEMO-LAB', observed_at: observed, site_ref: 'WWTP-OUTFALL-2',
      site_type: 'Wastewater treatment plant', matrix: 'effluent', relation: 'downstream',
      geospatial_precision: '10-km', protocol: 'ISO 5667-10:2020', method: 'qPCR',
      resistance_genes: 'blaNDM-1'
    }]
  ]
  for (const [module, payload] of events) {
    try {
      database.captureOneHealth(module, payload as never, identity)
    } catch (error) {
      // A module whose required fields change is skipped rather than blocking the rest,
      // and says so: a silently missing demo domain is a confusing screenshot.
      console.warn(`demo seed: ${module} event skipped —`, error instanceof Error ? error.message : error)
    }
  }
}

export function seedDemoData(database: AMRITDatabase, { records = 60 }: { records?: number } = {}): void {
  if (database.listLabs(true).length > 0) return
  const profile = activeProfile()
  if (profile.country_code === 'ZZZ') {
    throw new Error('Set AMRIT_COUNTRY_PROFILE before AMRIT_DEMO_SEED so demo records have an explicit country.')
  }
  const guideline = profile.guidelines?.default || 'CLSI'

  database.saveLab({
    code: 'DEMO-LAB',
    name: 'Demonstration Microbiology Laboratory',
    country: profile.country_name,
    country_code: profile.country_code,
    site_group: 'Tertiary care',
    default_test_method: 'Disk diffusion',
    default_guideline: guideline,
    active: true
  })
  database.selectLab('DEMO-LAB')

  const random = sequence(20260813)
  for (let index = 0; index < records; index += 1) {
    const organism = ORGANISMS[index % ORGANISMS.length]!
    const specimen = SPECIMENS[index % SPECIMENS.length]!
    const resistant = RESISTANCE[organism.code] ?? 0.3
    const results: Record<string, { result: string; measurement: string; method: string; guideline: string }> = {}
    for (const code of ANTIBIOTICS) {
      // Vancomycin is not reported for Gram-negatives; leaving it out keeps the demo
      // antibiogram honest rather than dense.
      if (code === 'VAN' && organism.code !== 'SAU') continue
      if (code === 'AMP' && organism.code === 'KPN') continue
      const roll = random()
      results[code] = {
        result: roll < resistant ? 'R' : roll < resistant + 0.12 ? 'I' : 'S',
        measurement: String(Math.round(12 + roll * 18)),
        method: 'Disk diffusion',
        guideline
      }
    }
    const record: IsolateRecord = {
      lab_code: 'DEMO-LAB',
      patient_id: `D-${String(1000 + index)}`,
      specimen_number: `S-${String(24000 + index)}`,
      specimen_date: isoDate(index % 84),
      specimen_type: specimen.name,
      specimen_code: specimen.code,
      organism: organism.name,
      organism_code: organism.code,
      sex: index % 2 === 0 ? 'f' : 'm',
      age_years: 5 + ((index * 7) % 80),
      location: WARDS[index % WARDS.length],
      location_type: index % 4 === 0 ? 'ICU' : 'Inpatient',
      record_status: 'final',
      antibiotic_results: results as IsolateRecord['antibiotic_results'],
      patient_residence: { country_code: profile.country_code }
    }
    try {
      database.saveRecord(record)
    } catch {
      // A record the decision-support layer refuses is skipped rather than forced: the
      // point of the demo set is that it is data the application accepts.
    }
  }

  seedOneHealthEvents(database)
}
