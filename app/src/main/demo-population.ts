/**
 * A four-city surveillance network with enough real structure to demonstrate against.
 *
 * `demo-seed.ts` makes one small laboratory for the manual's screenshots. This makes a
 * network: four tertiary hospitals in four metros, ten thousand isolates each, over two
 * years — the volume and the shape a dashboard needs before its trends, its antibiogram
 * and its site comparisons mean anything.
 *
 * The hospitals are generic ("Delhi Metropolitan Teaching Hospital"). No real institution
 * is named, because a screenshot of invented resistance rates attributed to a real
 * hospital is a claim about that hospital.
 *
 * What makes the numbers demonstrable rather than random:
 *
 *  * **Organism mix follows specimen.** Urine is mostly E. coli; blood carries more
 *    Klebsiella and Staphylococcus; respiratory specimens carry the non-fermenters.
 *  * **Resistance follows organism, city, ward and time.** ICU isolates are more resistant
 *    than ward isolates, carbapenem resistance drifts up across the two years, and the
 *    four cities differ enough to compare without any of them looking invented.
 *  * **Panels follow organism.** Vancomycin is not reported for a Gram-negative;
 *    nitrofurantoin only for urine; colistin only where it is a last line.
 *  * **Co-resistance is real.** A carbapenem-resistant isolate is far more likely to be
 *    resistant to everything else, which is what makes an antibiogram look like an
 *    antibiogram instead of independent coin flips.
 *
 * Every record still goes in through `saveRecord`, so the demo set is data the application
 * itself accepts, and every code comes from the packaged catalogue.
 */

import { activeProfile } from './active-profile'
import type { AMRITDatabase } from './database'
import type { IsolateRecord } from '../shared/types'

export interface DemoSite {
  code: string
  name: string
  city: string
  /** ISO 3166-2 code for the state or union territory the city sits in. */
  stateCode: string
  /** Multiplier on this site's baseline resistance. Delhi runs hottest, Chennai coolest. */
  pressure: number
}

/**
 * The country this demonstration pack is for.
 *
 * The network below is four named Indian metros with ISO 3166-2 codes to match, so it is
 * India's pack and nothing else's. Seeding it under another country's profile would file
 * Delhi and Chennai hospitals as that country's, which is why `seedDemoNetwork` refuses.
 * The server's `seed_demo` management command keys its packs by alpha-3 for the same
 * reason: a country with no pack is skipped, never filled with another country's hospitals.
 */
export const DEMO_NETWORK_COUNTRY = Object.freeze({ name: 'India', code: 'IND' })

export const DEMO_SITES: readonly DemoSite[] = Object.freeze([
  { code: 'DEMO-DEL-01', name: 'Delhi Metropolitan Teaching Hospital', city: 'New Delhi', stateCode: 'IN-DL', pressure: 1.12 },
  { code: 'DEMO-MUM-01', name: 'Mumbai Central Teaching Hospital', city: 'Mumbai', stateCode: 'IN-MH', pressure: 1.04 },
  { code: 'DEMO-KOL-01', name: 'Kolkata General Teaching Hospital', city: 'Kolkata', stateCode: 'IN-WB', pressure: 0.98 },
  { code: 'DEMO-CHN-01', name: 'Chennai Government Teaching Hospital', city: 'Chennai', stateCode: 'IN-TN', pressure: 0.9 }
])

export interface Organism {
  code: string
  name: string
  gram: 'negative' | 'positive'
  /** Antimicrobials reported for this organism, in the order a report lists them. */
  panel: readonly string[]
  /** Share of isolates resistant to the class this agent belongs to, before adjustment. */
  base: Readonly<Record<string, number>>
}

/**
 * The agent that stands for the whole class, so class resistance moves together.
 *
 * Exported because `outbreak-simulation.ts` seeds outbreaks whose phenotype is a mechanism
 * rather than a single agent: a carbapenemase-producing clone is resistant to meropenem,
 * imipenem and ertapenem together, and a simulated outbreak that moved only one of them
 * would be a phenotype no laboratory has ever reported.
 */
export const CLASS_OF: Readonly<Record<string, string>> = Object.freeze({
  MEM: 'carbapenem', IPM: 'carbapenem', ETP: 'carbapenem',
  CRO: 'cephalosporin', CAZ: 'cephalosporin', FEP: 'cephalosporin',
  CIP: 'fluoroquinolone', LVX: 'fluoroquinolone',
  GEN: 'aminoglycoside', AMK: 'aminoglycoside',
  ERY: 'macrolide', CLI: 'macrolide',
  VAN: 'glycopeptide', TEC: 'glycopeptide'
})

/**
 * Resistance baselines.
 *
 * These are the orders of magnitude Indian tertiary-care surveillance reports: very high
 * third-generation cephalosporin and fluoroquinolone resistance in Enterobacterales,
 * serious carbapenem resistance in Klebsiella and near-total in Acinetobacter, MRSA around
 * two in five, vancomycin-resistant S. aureus absent. They are shaped to be recognisable
 * to a microbiologist looking at the demo, not taken from any one published table.
 */
export const ORGANISMS: readonly Organism[] = [
  {
    code: 'ECO', name: 'Escherichia coli', gram: 'negative',
    panel: ['AMP', 'AMC', 'CRO', 'CAZ', 'FEP', 'TZP', 'ETP', 'MEM', 'CIP', 'LVX', 'GEN', 'AMK', 'SXT', 'NIT', 'FOS', 'COL', 'TGC'],
    base: {
      AMP: 0.86, AMC: 0.52, CRO: 0.70, CAZ: 0.66, FEP: 0.62, TZP: 0.30, ETP: 0.16, MEM: 0.13,
      CIP: 0.72, LVX: 0.68, GEN: 0.44, AMK: 0.12, SXT: 0.63, NIT: 0.09, FOS: 0.06, COL: 0.004, TGC: 0.012
    }
  },
  {
    code: 'KPN', name: 'Klebsiella pneumoniae complex', gram: 'negative',
    panel: ['AMC', 'CRO', 'CAZ', 'FEP', 'TZP', 'ETP', 'MEM', 'IPM', 'CIP', 'LVX', 'GEN', 'AMK', 'SXT', 'COL', 'TGC'],
    base: {
      AMC: 0.70, CRO: 0.74, CAZ: 0.72, FEP: 0.67, TZP: 0.54, ETP: 0.47, MEM: 0.43, IPM: 0.42,
      CIP: 0.72, LVX: 0.68, GEN: 0.55, AMK: 0.34, SXT: 0.67, COL: 0.018, TGC: 0.05
    }
  },
  {
    code: 'ABA', name: 'Acinetobacter baumannii', gram: 'negative',
    panel: ['TZP', 'CAZ', 'FEP', 'MEM', 'IPM', 'CIP', 'LVX', 'GEN', 'AMK', 'SXT', 'MNO', 'COL', 'TGC'],
    base: {
      TZP: 0.80, CAZ: 0.81, FEP: 0.78, MEM: 0.78, IPM: 0.77, CIP: 0.83, LVX: 0.79,
      GEN: 0.79, AMK: 0.72, SXT: 0.78, MNO: 0.38, COL: 0.015, TGC: 0.14
    }
  },
  {
    code: 'PAE', name: 'Pseudomonas aeruginosa', gram: 'negative',
    panel: ['TZP', 'CAZ', 'FEP', 'MEM', 'IPM', 'CIP', 'LVX', 'GEN', 'AMK', 'COL'],
    base: {
      TZP: 0.34, CAZ: 0.32, FEP: 0.30, MEM: 0.33, IPM: 0.36, CIP: 0.39, LVX: 0.37,
      GEN: 0.31, AMK: 0.22, COL: 0.008
    }
  },
  {
    code: 'ECL', name: 'Enterobacter cloacae', gram: 'negative',
    panel: ['CRO', 'CAZ', 'FEP', 'TZP', 'ETP', 'MEM', 'CIP', 'GEN', 'AMK', 'SXT', 'COL', 'TGC'],
    base: {
      CRO: 0.72, CAZ: 0.68, FEP: 0.44, TZP: 0.46, ETP: 0.30, MEM: 0.22,
      CIP: 0.48, GEN: 0.38, AMK: 0.16, SXT: 0.51, COL: 0.01, TGC: 0.03
    }
  },
  {
    code: 'PMI', name: 'Proteus mirabilis', gram: 'negative',
    panel: ['AMP', 'AMC', 'CRO', 'CAZ', 'TZP', 'ETP', 'MEM', 'CIP', 'GEN', 'AMK', 'SXT'],
    base: {
      AMP: 0.71, AMC: 0.38, CRO: 0.52, CAZ: 0.48, TZP: 0.22, ETP: 0.11, MEM: 0.08,
      CIP: 0.63, GEN: 0.41, AMK: 0.14, SXT: 0.58
    }
  },
  {
    code: 'SAT', name: 'Salmonella Typhi', gram: 'negative',
    panel: ['AMP', 'CRO', 'CIP', 'AZM', 'SXT', 'CHL'],
    base: { AMP: 0.09, CRO: 0.02, CIP: 0.83, AZM: 0.03, SXT: 0.08, CHL: 0.06 }
  },
  {
    code: 'SAU', name: 'Staphylococcus aureus', gram: 'positive',
    panel: ['PEN', 'FOX', 'ERY', 'CLI', 'CIP', 'LVX', 'GEN', 'SXT', 'TCY', 'VAN', 'TEC', 'LNZ', 'DAP'],
    base: {
      PEN: 0.94, FOX: 0.44, ERY: 0.54, CLI: 0.40, CIP: 0.48, LVX: 0.45, GEN: 0.32,
      SXT: 0.27, TCY: 0.22, VAN: 0.0, TEC: 0.0, LNZ: 0.002, DAP: 0.002
    }
  },
  {
    code: 'EFM', name: 'Enterococcus faecium', gram: 'positive',
    panel: ['AMP', 'CIP', 'LVX', 'ERY', 'VAN', 'TEC', 'LNZ', 'TCY'],
    base: { AMP: 0.88, CIP: 0.85, LVX: 0.82, ERY: 0.80, VAN: 0.17, TEC: 0.13, LNZ: 0.012, TCY: 0.45 }
  },
  {
    code: 'EFA', name: 'Enterococcus faecalis', gram: 'positive',
    panel: ['AMP', 'CIP', 'LVX', 'ERY', 'VAN', 'TEC', 'LNZ', 'NIT', 'TCY'],
    base: { AMP: 0.09, CIP: 0.48, LVX: 0.44, ERY: 0.62, VAN: 0.04, TEC: 0.03, LNZ: 0.01, NIT: 0.06, TCY: 0.52 }
  },
  {
    code: 'SPN', name: 'Streptococcus pneumoniae', gram: 'positive',
    panel: ['PEN', 'CRO', 'ERY', 'CLI', 'LVX', 'SXT', 'TCY', 'VAN', 'LNZ', 'CHL'],
    base: { PEN: 0.18, CRO: 0.07, ERY: 0.44, CLI: 0.26, LVX: 0.04, SXT: 0.58, TCY: 0.39, VAN: 0.0, LNZ: 0.0, CHL: 0.09 }
  }
]

export interface Specimen {
  code: string
  name: string
  /** Share of this site's isolates, before seasonal adjustment. */
  share: number
  /** Organism mix for this specimen: organism code to relative weight. */
  organisms: Readonly<Record<string, number>>
}

export const SPECIMENS: readonly Specimen[] = [
  {
    code: 'URINE', name: 'Urine', share: 0.34,
    organisms: { ECO: 52, KPN: 16, EFA: 9, PMI: 6, PAE: 5, ECL: 4, EFM: 4, ABA: 2, SAU: 2 }
  },
  {
    code: 'BLOOD_STERILE', name: 'Blood / normally sterile fluid', share: 0.24,
    organisms: { KPN: 22, ECO: 18, SAU: 16, ABA: 12, PAE: 8, EFM: 7, ECL: 6, EFA: 5, SAT: 4, SPN: 2 }
  },
  {
    code: 'LOWER_RESP', name: 'Lower respiratory tract', share: 0.18,
    organisms: { KPN: 26, ABA: 24, PAE: 20, ECO: 8, SAU: 10, ECL: 7, SPN: 5 }
  },
  {
    code: 'DEEP_TISSUE_WOUND', name: 'Deep tissue / wound / musculoskeletal', share: 0.13,
    organisms: { SAU: 30, ECO: 16, KPN: 14, PAE: 14, ABA: 8, EFA: 8, ECL: 6, PMI: 4 }
  },
  {
    code: 'INTRA_ABDOMINAL_DEEP', name: 'Intra-abdominal / deep sterile specimen', share: 0.06,
    organisms: { ECO: 38, KPN: 20, EFA: 12, ECL: 10, PAE: 8, EFM: 7, SAU: 5 }
  },
  {
    code: 'ENTERIC_STOOL', name: 'Stool / enteric', share: 0.03,
    organisms: { SAT: 62, ECO: 38 }
  },
  {
    code: 'CSF', name: 'Cerebrospinal fluid', share: 0.02,
    organisms: { SPN: 40, KPN: 20, ECO: 16, SAU: 12, ABA: 12 }
  }
]

export interface Ward {
  name: string
  type: string
  share: number
  /** Multiplier on resistance. An ICU isolate is not a ward isolate. */
  pressure: number
}

export const WARDS: readonly Ward[] = Object.freeze([
  { name: 'Medical ICU', type: 'ICU', share: 0.16, pressure: 1.35 },
  { name: 'Surgical ICU', type: 'ICU', share: 0.09, pressure: 1.33 },
  { name: 'Neonatal ICU', type: 'ICU', share: 0.06, pressure: 1.28 },
  { name: 'General medicine', type: 'Inpatient', share: 0.22, pressure: 1.0 },
  { name: 'General surgery', type: 'Inpatient', share: 0.13, pressure: 1.02 },
  { name: 'Paediatrics', type: 'Inpatient', share: 0.08, pressure: 0.92 },
  { name: 'Obstetrics and gynaecology', type: 'Inpatient', share: 0.06, pressure: 0.85 },
  { name: 'Nephrology / dialysis', type: 'Inpatient', share: 0.05, pressure: 1.18 },
  { name: 'Oncology / haematology', type: 'Inpatient', share: 0.05, pressure: 1.22 },
  { name: 'Emergency', type: 'Emergency', share: 0.05, pressure: 0.95 },
  { name: 'Outpatient department', type: 'Outpatient', share: 0.05, pressure: 0.7 }
])

/** Deterministic pseudo-randomness: the same demo network every time it is built. */
export function sequence(seed: number): () => number {
  let state = seed % 2147483647
  if (state <= 0) state += 2147483646
  return () => {
    state = (state * 16807) % 2147483647
    return (state - 1) / 2147483646
  }
}

export function pick<T extends { share: number }>(items: readonly T[], roll: number): T {
  let cursor = 0
  for (const item of items) {
    cursor += item.share
    if (roll <= cursor) return item
  }
  return items[items.length - 1] as T
}

export function pickWeighted(weights: Readonly<Record<string, number>>, roll: number): string {
  const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0)
  let cursor = 0
  for (const [key, weight] of Object.entries(weights)) {
    cursor += weight / total
    if (roll <= cursor) return key
  }
  return Object.keys(weights)[0] as string
}

const clamp = (value: number, low = 0.0005, high = 0.985): number => Math.min(high, Math.max(low, value))

/**
 * Keeps the network mean on the published baseline.
 *
 * The ward, city, time and strain factors are all odds ratios above one on average — an
 * ICU runs hotter, a multi-drug-resistant strain much hotter — so applying them raised
 * every rate several points above the baseline it started from. This divides that average
 * back out, so a baseline of 45% carbapenem resistance produces a network that reports
 * about 45%, with the ICUs above it and the outpatient departments below.
 */
export const NETWORK_CALIBRATION = 0.78

/**
 * Adjust a resistance rate on the odds scale, not by multiplying it.
 *
 * Multiplying looked simpler and was wrong: the same ICU and city factors that move a 45%
 * carbapenem rate a few points also multiplied a 2% colistin rate into 7%, and pushed
 * ceftriaxone from a plausible 78% to 90%. On the odds scale one modifier means one thing
 * — "this ward runs about a third higher odds of resistance" — whatever the baseline is,
 * so last-line agents stay rare and high rates stay in range.
 */
export function adjustedRate(base: number, ...oddsRatios: number[]): number {
  if (base <= 0) return 0
  const odds = base / (1 - base)
  const adjusted = oddsRatios.reduce((carried, ratio) => carried * ratio, odds)
  return clamp(adjusted / (1 + adjusted))
}

/**
 * A MIC that agrees with the interpretation.
 *
 * A demo where the number and the letter disagree is worse than no number: the first thing
 * a microbiologist does is read the MIC and check it against the S/I/R beside it.
 */
export function micFor(result: string, random: () => number): string {
  const doublings = [0.03, 0.06, 0.125, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256]
  const index = result === 'R'
    ? 9 + Math.floor(random() * 5)
    : result === 'I' ? 7 + Math.floor(random() * 2) : Math.floor(random() * 7)
  return String(doublings[Math.min(doublings.length - 1, index)])
}

export interface DemoNetworkOptions {
  /** Isolates per site. Ten thousand each is the demonstration set. */
  recordsPerSite?: number
  /** How far back the two-year window reaches, in days. */
  windowDays?: number
  seed?: number
  /** Called after each site, for progress on a run that writes tens of thousands of rows. */
  onProgress?: (site: DemoSite, written: number, failed: number) => void
  /**
   * Seed the pack even though the active profile is for another country.
   *
   * For tests and for someone who genuinely wants India's demonstration data on a
   * differently-configured installation. It has to be asked for, because the alternative —
   * silently relabelling Delhi as somewhere else — publishes wrong geography.
   */
  allowForeignProfile?: boolean
}

export interface DemoNetworkResult {
  sites: Array<{ code: string; written: number; failed: number }>
  written: number
  failed: number
}

/**
 * Build the demonstration network.
 *
 * Existing laboratories are left alone; a site whose code is already present is refreshed
 * rather than duplicated, and its records are added to whatever is already there.
 */
export function seedDemoNetwork(database: AMRITDatabase, options: DemoNetworkOptions = {}): DemoNetworkResult {
  const configured = activeProfile().country_code
  if (!options.allowForeignProfile && configured !== DEMO_NETWORK_COUNTRY.code) {
    throw new Error(
      `This demonstration network is ${DEMO_NETWORK_COUNTRY.name}'s pack (${DEMO_NETWORK_COUNTRY.code}), `
      + `and the active profile is ${configured}. Seeding it here would file `
      + `${DEMO_NETWORK_COUNTRY.name} hospitals as ${configured}'s. Set AMRIT_COUNTRY_PROFILE=IN, `
      + 'or pass allowForeignProfile to seed it anyway.'
    )
  }
  const perSite = Math.max(1, Math.trunc(options.recordsPerSite ?? 10_000))
  const windowDays = Math.max(30, Math.trunc(options.windowDays ?? 730))
  const random = sequence(options.seed ?? 20260814)
  const today = new Date()
  const result: DemoNetworkResult = { sites: [], written: 0, failed: 0 }

  for (const [siteIndex, site] of DEMO_SITES.entries()) {
    database.saveLab({
      code: site.code,
      name: site.name,
      country: DEMO_NETWORK_COUNTRY.name,
      country_code: DEMO_NETWORK_COUNTRY.code,
      site_group: 'Human health',
      default_guideline: 'CLSI',
      default_test_method: 'MIC',
      active: true
    } as never)
    database.selectLab(site.code)

    let written = 0
    let failed = 0
    for (let index = 0; index < perSite; index += 1) {
      const daysAgo = Math.floor(random() * windowDays)
      const specimenDate = new Date(today.getTime() - daysAgo * 86_400_000)
      const month = specimenDate.getUTCMonth()
      // Monsoon months carry more enteric and urinary disease; the seasonal lift is what
      // makes the volume chart look like a year rather than a flat line.
      const monsoon = month >= 5 && month <= 8
      const seasonal = SPECIMENS.map((item): Specimen => ({
        code: item.code,
        name: item.name,
        organisms: item.organisms,
        share: item.code === 'ENTERIC_STOOL' || item.code === 'URINE'
          ? item.share * (monsoon ? 1.35 : 0.92)
          : item.share
      }))
      const specimen = pick(seasonal, random())
      const organismCode = pickWeighted(specimen.organisms, random())
      const organism = ORGANISMS.find((item) => item.code === organismCode)
      if (!organism) continue
      const ward = pick(WARDS, random())

      // Resistance rises across the window, faster for the carbapenems than for anything
      // else, which is the trend a national programme is watching for.
      const yearsBack = daysAgo / 365
      const drift = 1 + 0.18 * (1 - yearsBack / (windowDays / 365))
      // One isolate is resistant or susceptible as a whole far more often than agent by
      // agent: a multi-drug-resistant strain drags its whole panel with it. About one in
      // six isolates carries that trait, which is what puts a recognisable MDR tail on
      // every antibiogram instead of scattering resistance evenly.
      const strainPressure = random() < 0.17 ? 2.2 + random() * 1.4 : 0.55 + random() * 0.35

      const results: Record<string, { result: string; measurement: string; method: string; guideline: string }> = {}
      const classRolls: Record<string, number> = {}
      for (const code of organism.panel) {
        if (code === 'NIT' && specimen.code !== 'URINE') continue
        if (code === 'FOS' && specimen.code !== 'URINE') continue
        const baseRate = organism.base[code] ?? 0.2
        // The carbapenems are the class a national programme watches, so they drift faster
        // than the rest rather than at the same rate as everything else.
        const carbapenemLift = CLASS_OF[code] === 'carbapenem' ? drift * 1.15 : drift
        const rate = adjustedRate(baseRate, site.pressure, ward.pressure, carbapenemLift, strainPressure, NETWORK_CALIBRATION)
        // Agents of one class move together: an isolate resistant to meropenem is not
        // independently susceptible to imipenem.
        const className = CLASS_OF[code]
        const roll = className
          ? (classRolls[className] ??= random()) * 0.75 + random() * 0.25
          : random()
        const interpretation = roll < rate ? 'R' : roll < rate + 0.07 ? 'I' : 'S'
        results[code] = {
          result: interpretation,
          measurement: micFor(interpretation, random),
          method: 'MIC',
          guideline: 'CLSI'
        }
      }

      const female = random() < 0.47
      const record: IsolateRecord = {
        lab_code: site.code,
        patient_id: `${site.code}-P${String(100_000 + siteIndex * 25_000 + Math.floor(random() * 24_000))}`,
        specimen_number: `${site.code}-S${String(index + 1).padStart(6, '0')}`,
        specimen_date: specimenDate.toISOString().slice(0, 10),
        specimen_type: specimen.name,
        specimen_code: specimen.code,
        organism: organism.name,
        organism_code: organism.code,
        sex: female ? 'f' : 'm',
        age_years: ward.name === 'Neonatal ICU'
          ? 0
          : ward.name === 'Paediatrics' ? Math.floor(random() * 14) : 16 + Math.floor(random() * 74),
        location: ward.name,
        location_type: ward.type,
        record_status: 'final',
        antibiotic_results: results as IsolateRecord['antibiotic_results'],
        patient_residence: { country_code: 'IND', admin_codes: [{ level: 1, code: site.stateCode }] }
      } as IsolateRecord
      try {
        database.saveRecord(record)
        written += 1
      } catch {
        // A record the decision-support layer refuses is skipped rather than forced: the
        // point of a demonstration set is that it is data the application accepts.
        failed += 1
      }
    }
    result.sites.push({ code: site.code, written, failed })
    result.written += written
    result.failed += failed
    options.onProgress?.(site, written, failed)
  }
  return result
}
