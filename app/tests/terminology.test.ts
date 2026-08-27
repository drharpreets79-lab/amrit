/**
 * Phase 22 and 23: the terminology service, and the codes it puts on an export.
 *
 * The tests that matter most here are the negative ones. A terminology layer that returns a
 * plausible code when it should return nothing is worse than no terminology layer at all,
 * because the wrong code travels silently into another system's database.
 */

import { describe, expect, it } from 'vitest'

import {
  ALL_SYSTEMS_ENABLED, ICD10_SYSTEM, ICD11_SYSTEM, LOINC_SYSTEM, SNOMED_SYSTEM, UCUM_SYSTEM, antibioticBinding,
  describeTerminology, expand, loadTerminologySeed, lookup, translate, unitFor, validateCode,
  type SystemGate
} from '../src/main/terminology'

const seed = loadTerminologySeed()

/** A deployment that has not licensed SNOMED, which is the common case outside member countries. */
const noSnomed: SystemGate = (system) => system === SNOMED_SYSTEM
  ? { enabled: false, reason: 'SNOMED is disabled in this deployment\'s country profile.' }
  : { enabled: true, reason: '' }

describe('the seed', () => {
  it('carries its provenance, so a code can be traced to where it came from', () => {
    expect(seed.dataset).toBe('amrit-terminology')
    // Two sources are legitimate and the seed must name which one it used. A checkout with a
    // licensed LOINC release reads it locally; one without falls back to the cached
    // terminology-server expansion. Phase 26 checked that the two agree: building from the
    // local 2.82 release reproduced all 264 existing bindings byte for byte and added 16 that
    // LOINC's own synonym list makes reachable, changing no code on any export.
    expect(String(seed.provenance.server)).toMatch(/tx\.fhir\.org|LOINC .* release/)
    expect(String(seed.provenance.expansion)).toMatch(/^LOINC CLASS=ABXBACT/)
    expect(String(seed.contentSha256)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('records every antibiotic it could not code, with the reason', () => {
    // 135 of 399. The number is not the point; the point is that they are enumerated rather
    // than silently absent, because "no LOINC code exists" and "we did not look" are
    // different statements and only one of them is a gap someone can close.
    expect(seed.unmatched.length).toBeGreaterThan(0)
    for (const row of seed.unmatched.slice(0, 5)) {
      expect(row.reason).toMatch(/wrong susceptibility code is a defect/)
    }
    expect(Object.keys(seed.bindings.antibiotic).length + seed.unmatched.length).toBe(399)
  })

  it('does not use the catalogue\'s own LOINC columns', () => {
    // `loinc_mlc` and `loinc_sbt` are minimum *lethal* concentration and serum bactericidal
    // titer. AMRIT measures neither. Meropenem's MLC code is 6651-4 and its MIC code is
    // 6652-2, and binding the first to an MIC result would be wrong on every export.
    const meropenem = seed.bindings.antibiotic.MEM
    expect(meropenem?.mic).toBe('6652-2')
    expect(Object.values(meropenem ?? {})).not.toContain('6651-4')
  })
})

describe('$lookup and $validate-code', () => {
  it('answers from the bundled subset', () => {
    const found = lookup(seed, LOINC_SYSTEM, '6652-2')
    expect(found.ok).toBe(true)
    expect(found.value?.display).toBe('Meropenem [Susceptibility] by Minimum inhibitory concentration (MIC)')
    expect(validateCode(seed, LOINC_SYSTEM, '6652-2').ok).toBe(true)
  })

  it('distinguishes "not bundled here" from "not a code"', () => {
    // AMRIT bundles the concepts it binds to, not the LOINC release, so a real LOINC code it
    // does not use must not be reported as invalid.
    const missing = lookup(seed, LOINC_SYSTEM, '18156-0')
    expect(missing.ok).toBe(false)
    expect(missing.reason).toMatch(/bundled subset/)
    expect(missing.reason).toMatch(/not that it is invalid/)
  })

  it('says which system it has when asked about one it does not', () => {
    const unknown = lookup(seed, 'http://example.org/codes', 'X')
    expect(unknown.ok).toBe(false)
    expect(unknown.reason).toMatch(/bundles no concepts/)
  })
})

describe('$translate', () => {
  it('translates a WHONET antibiotic to LOINC, per method', () => {
    const result = translate(seed, { sourceSystem: 'urn:whonet:antibiotic-code', code: 'MEM' })
    expect(result.ok).toBe(true)
    const byRelationship = Object.fromEntries((result.value ?? []).map((row) => [row.relationship, row.code]))
    expect(byRelationship.mic).toBe('6652-2')
    expect(byRelationship.disk).toBe('6653-0')
    // The same drug, two methods, two codes. A translation that returned "the" LOINC code for
    // meropenem would have to pick one and would be wrong half the time.
    expect(byRelationship.mic).not.toBe(byRelationship.disk)
  })

  it('translates an organism to SNOMED, and refuses when SNOMED is disabled', () => {
    const licensed = translate(seed, { sourceSystem: 'urn:whonet:organism-code', code: 'SAJ' })
    expect(licensed.ok).toBe(true)
    expect(licensed.value?.[0]?.code).toBe('113713009')

    const unlicensed = translate(seed, { sourceSystem: 'urn:whonet:organism-code', code: 'SAJ' }, noSnomed)
    expect(unlicensed.ok).toBe(false)
    // Not an empty result: an empty result reads as "no such organism".
    expect(unlicensed.reason).toMatch(/disabled/)
  })

  it('reports an unmapped code as unmapped rather than guessing a neighbour', () => {
    const result = translate(seed, { sourceSystem: 'urn:whonet:organism-code', code: 'NOT-AN-ORGANISM' })
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/nothing is guessed/)
  })
})

describe('$expand', () => {
  it('reports how many matched, not how many it returned', () => {
    const all = expand(seed, { system: LOINC_SYSTEM, count: 5 })
    expect(all.ok).toBe(true)
    expect(all.value?.concepts).toHaveLength(5)
    expect(all.value?.total).toBeGreaterThan(5)
  })

  it('filters on code or display, case-insensitively', () => {
    const filtered = expand(seed, { system: LOINC_SYSTEM, filter: 'meropenem', count: 50 })
    expect(filtered.ok).toBe(true)
    expect(filtered.value?.total).toBeGreaterThan(0)
    for (const concept of filtered.value?.concepts ?? []) {
      expect(concept.display.toLocaleLowerCase()).toContain('meropenem')
    }
  })

  it('pages without lying about the total', () => {
    const first = expand(seed, { system: UCUM_SYSTEM, count: 1, offset: 0 })
    const second = expand(seed, { system: UCUM_SYSTEM, count: 1, offset: 1 })
    expect(first.value?.total).toBe(second.value?.total)
    expect(first.value?.concepts[0]?.code).not.toBe(second.value?.concepts[0]?.code)
  })
})

describe('choosing a susceptibility code by method', () => {
  it('picks the MIC concept for an MIC and the disk concept for a disk diffusion', () => {
    expect(antibioticBinding(seed, 'MEM', 'MIC').value).toMatchObject({ code: '6652-2', method: 'mic' })
    expect(antibioticBinding(seed, 'MEM', 'DISK').value).toMatchObject({ code: '6653-0', method: 'disk' })
  })

  it('falls back to the method-less concept when no method was recorded', () => {
    // Which says what was tested and declines to say how. That is a weaker statement, not a
    // wrong one, and a legacy import frequently cannot supply more.
    const fallback = antibioticBinding(seed, 'MEM', '')
    expect(fallback.ok).toBe(true)
    expect(fallback.value?.method).toBe('plain')
  })

  it('refuses, with the reason, for an agent LOINC does not code', () => {
    const uncoded = seed.unmatched[0]
    const result = antibioticBinding(seed, String(uncoded?.code), 'MIC')
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/no LOINC susceptibility concept/)
  })

  it('produces nothing at all when LOINC itself is disabled', () => {
    const noLoinc: SystemGate = (system) => system === LOINC_SYSTEM
      ? { enabled: false, reason: 'LOINC is disabled here.' }
      : { enabled: true, reason: '' }
    const result = antibioticBinding(seed, 'MEM', 'MIC', noLoinc)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('LOINC is disabled here.')
  })
})

describe('units', () => {
  it('gives an MIC millgrams per litre and a disk diffusion millimetres', () => {
    // The defect this closes: `valueQuantity: { value: 8 }` made an MIC of 8 mg/L and a zone
    // of 8 mm the same number to every receiver.
    expect(unitFor(seed, 'MIC')).toBe('mg/L')
    expect(unitFor(seed, 'DISK')).toBe('mm')
    expect(unitFor(seed, '')).toBe('')
  })
})

describe('what the deployment can say about its terminology', () => {
  it('lists each system with whether it is enabled and why not', () => {
    const described = describeTerminology(seed, noSnomed)
    expect(described.map((row) => row.url)).toContain(LOINC_SYSTEM)
    for (const row of described) {
      // The gate is reflected per system, not assumed away: with SNOMED disabled the row for
      // SNOMED says so and carries the reason, and every other row stays enabled. A view that
      // reported everything as available would tell an operator their exports carry codings
      // they do not.
      expect(row.enabled).toBe(row.url !== SNOMED_SYSTEM)
      if (!row.enabled) expect(row.reason).toMatch(/disabled/)
      expect(row.concepts).toBeGreaterThan(0)
    }
    expect(describeTerminology(seed, ALL_SYSTEMS_ENABLED).every((row) => row.enabled)).toBe(true)
  })
})

/**
 * Phase 26 — ICD-11 MMS, taken from WHO's own ICD API.
 *
 * The interesting assertion here is the one about *meaning*. The first run of
 * `tools/fetch_icd11.py` verified that all 32 candidate codes existed in WHO's release and
 * reported zero rejections — and nine of them were the wrong concept: `1A09` was labelled
 * Shigellosis and is WHO's category for other Salmonella infections, `CB27` was labelled
 * pyothorax and is pleural effusion, `NE81` was labelled infection-following-a-procedure and
 * is injury or harm arising from a procedure. Every one of those is a valid ICD-11 code, so
 * validation downstream would have passed and a wrong diagnosis would have travelled.
 */
describe('ICD-11 MMS', () => {
  it('bundles WHO\'s own titles, not strings this repository typed', () => {
    const concepts = seed.concepts[ICD11_SYSTEM] ?? []
    expect(concepts.length).toBe(40)
    // WHO's exact title for 1A09. The candidate list originally called this "Shigellosis".
    expect(lookup(seed, ICD11_SYSTEM, '1A09').value?.display).toBe('Infections due to other Salmonella')
    // ...and Shigella's real code, which is a different category entirely.
    expect(lookup(seed, ICD11_SYSTEM, '1A02').value?.display).toBe('Intestinal infections due to Shigella')
  })

  it('carries WHO\'s antimicrobial-resistance block, which is why an AMR product wants ICD-11', () => {
    // ICD-10 answers resistance only with the U82-U88 supplementary codes. MG50-MG54 are
    // first-class findings, and `--children` expands them to the organism-specific codes.
    for (const code of ['MG50', 'MG51', 'MG52', 'MG53', 'MG54']) {
      expect(lookup(seed, ICD11_SYSTEM, code).ok).toBe(true)
    }
    expect(lookup(seed, ICD11_SYSTEM, 'MG51').value?.display)
      .toBe('Finding of gram positive bacteria resistant to antimicrobial drugs')
  })

  it('refuses to translate between the ICD revisions, because WHO publishes no such map', () => {
    // Not "there is no mapping for this code" — there is no ConceptMap at all, by design.
    // ICD-10 A41 and ICD-11 1G40 are not the same extension, and a map asserting they were
    // would put a guess on a patient record where a diagnosis belongs.
    expect(seed.conceptMaps.some((map) =>
      map.sourceSystem === ICD10_SYSTEM || map.targetSystem === ICD11_SYSTEM)).toBe(false)
    const attempted = translate(seed, { sourceSystem: ICD10_SYSTEM, code: 'A41' })
    expect(attempted.ok).toBe(false)
    expect(attempted.reason).toMatch(/No ConceptMap translates/)
  })

  it('is a parallel value set, never a substitute for the other revision', () => {
    // A deployment on ICD-11 gets ICD-11 codes; a deployment on ICD-10 gets ICD-10. Asking
    // one system for the other's code is a miss, not a silent conversion.
    expect(lookup(seed, ICD10_SYSTEM, 'A41').ok).toBe(true)
    expect(lookup(seed, ICD11_SYSTEM, 'A41').ok).toBe(false)
    expect(lookup(seed, ICD10_SYSTEM, '1G40').ok).toBe(false)
    expect(lookup(seed, ICD11_SYSTEM, '1G40').ok).toBe(true)
  })

  it('can be switched off by a deployment that will not accept the no-derivatives terms', () => {
    const noIcd11: SystemGate = (system) => system === ICD11_SYSTEM
      ? { enabled: false, reason: 'ICD-11 is disabled in this deployment\'s country profile.' }
      : { enabled: true, reason: '' }
    const result = lookup(seed, ICD11_SYSTEM, '1G40', noIcd11)
    expect(result.ok).toBe(false)
    // A reason, not an empty result and not an ICD-10 code standing in for it.
    expect(result.reason).toMatch(/disabled/)
    expect(result.value).toBeUndefined()
  })
})

describe('the diagnosis picker\'s systems', () => {
  it('offers only classifications this deployment actually bundles', () => {
    // The picker searches ICD-10 and ICD-11 MMS. A system it offers and the seed does not
    // carry would return an empty page for every query, which reads to an operator as "no
    // such diagnosis" rather than "this deployment has no ICD-11".
    for (const system of ['http://hl7.org/fhir/sid/icd-10', 'http://id.who.int/icd/release/11/mms']) {
      const page = expand(seed, { system, count: 1 })
      expect(page.ok).toBe(true)
      expect(page.value?.total).toBeGreaterThan(0)
    }
  })

  it('pages a classification rather than returning all of it', () => {
    // The property the picker relies on: ask for 40, learn how many matched.
    const page = expand(seed, { system: 'http://hl7.org/fhir/sid/icd-10', filter: 'a', count: 5 })
    expect(page.value?.concepts.length).toBeLessThanOrEqual(5)
    expect(page.value?.total).toBeGreaterThanOrEqual(page.value?.concepts.length ?? 0)
  })
})

describe('SNOMED, and the codes that do not resolve', () => {
  it('bundles descriptions only for concepts a terminology server confirmed', () => {
    const snomed = expand(seed, { system: SNOMED_SYSTEM, count: 1 })
    expect(snomed.ok).toBe(true)
    expect(snomed.value?.total).toBeGreaterThan(2000)
    expect(lookup(seed, SNOMED_SYSTEM, '113713009').value?.display).toBe('Granulicatella adiacens')
  })

  it('excludes the thirteen catalogue references that resolve to nothing', () => {
    // Candida auris is the one that matters: a WHO critical-priority pathogen whose catalogue
    // SNOMED code is in an extension namespace the International Edition does not carry. It
    // still exports under its WHONET code; what it does not carry is a coding that would fail
    // to resolve for the receiver.
    const rejected = (seed as unknown as { rejectedSnomedCodes?: Array<{ snomed: string; localName: string }> })
      .rejectedSnomedCodes ?? []
    expect(rejected.length).toBe(13)
    expect(rejected.some((row) => row.localName.includes('Candida auris'))).toBe(true)
    for (const row of rejected) {
      expect(lookup(seed, SNOMED_SYSTEM, row.snomed).ok).toBe(false)
    }
  })

  it('withholds every SNOMED coding, with a reason, where the deployment has no licence', () => {
    const blocked = expand(seed, { system: SNOMED_SYSTEM, count: 1 }, noSnomed)
    expect(blocked.ok).toBe(false)
    expect(blocked.reason).toMatch(/disabled/)
  })
})
