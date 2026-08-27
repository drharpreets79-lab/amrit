// @vitest-environment node

import { describe, expect, it } from 'vitest'

import {
  organismScopeCodesFor,
  organismScopeForLabel,
  organismScopeMatches,
  parseAgentLabel,
  speciesScopeCode,
  ORGANISM_SCOPES
} from '../src/main/breakpoint-mapping'

/**
 * A guideline names an agent and an organism differently from the catalogues. Everything
 * that decides whether a published breakpoint reaches an isolate — or wrongly reaches one —
 * is decided here, so the readings are pinned down rather than left to a regression.
 */

const scope = (code: string) => ORGANISM_SCOPES.find((item) => item.code === code)!

describe('breakpoint label parsing', () => {
  it('separates the agent from its route', () => {
    expect(parseAgentLabel('Amoxicillin iv')).toMatchObject({ base: 'Amoxicillin', route: 'iv' })
    expect(parseAgentLabel('Cefuroxime oral')).toMatchObject({ base: 'Cefuroxime', route: 'oral' })
  })

  it('leaves an agent whose name merely ends in a word alone', () => {
    expect(parseAgentLabel('Fusidic acid')).toMatchObject({ base: 'Fusidic acid', route: '' })
    expect(parseAgentLabel('Nalidixic acid (screen only)')).toMatchObject({ base: 'Nalidixic acid', route: '' })
  })

  it('reads an indication that names a site as the row site', () => {
    expect(parseAgentLabel('Amoxicillin oral (uncomplicated UTI only)')).toMatchObject({
      base: 'Amoxicillin', route: 'oral', site: 'Uncomplicated urinary tract infection'
    })
    expect(parseAgentLabel('Meropenem (meningitis)').site).toBe('Meningitis')
  })

  it('leaves the ordinary row unsited when the indication is an exclusion', () => {
    // "Indications other than meningitis" is the general row. Tying it to a site would stop
    // it matching any record at all.
    const label = parseAgentLabel('Meropenem (indications other than meningitis)')
    expect(label.site).toBe('')
    expect(label.notes).toContain('indications other than meningitis')
  })

  it('marks a screening row as screening rather than clinical', () => {
    expect(parseAgentLabel('Cefoxitin (screen only)')).toMatchObject({ base: 'Cefoxitin', breakpointType: 'Screening' })
    expect(parseAgentLabel('Meropenem').breakpointType).toBe('Clinical')
  })

  it('keeps the organism restriction the guideline appends after a comma', () => {
    expect(parseAgentLabel('Imipenem, Enterobacterales except Morganellaceae').restriction)
      .toBe('Enterobacterales except Morganellaceae')
    expect(parseAgentLabel('Cefazolin (infections originating from the urinary tract), E. coli and Klebsiella spp. (except K. aerogenes)'))
      .toMatchObject({ base: 'Cefazolin', site: 'Urinary tract', restriction: 'E. coli and Klebsiella spp. (except K. aerogenes)' })
  })

  it('does not split on a comma inside the agent name itself', () => {
    // The comma here belongs to a bracketed exception, not to a restriction.
    expect(parseAgentLabel('Nitrofurantoin (uncomplicated UTI only), E. faecalis').base).toBe('Nitrofurantoin')
    expect(parseAgentLabel('Piperacillin-tazobactam').restriction).toBe('')
  })

  it('reads the line breaks EUCAST leaves inside a cell', () => {
    expect(parseAgentLabel('Amikacin, \nCoagulase-negative staphylococci'))
      .toMatchObject({ base: 'Amikacin', restriction: 'Coagulase-negative staphylococci' })
  })
})

describe('organism scopes', () => {
  const ecoli = { code: 'ECO', organism_name: 'Escherichia coli', genus_name: 'Escherichia', family_name: 'Enterobacteriaceae', order_name: 'Enterobacterales' }
  const morganella = { code: 'MMO', organism_name: 'Morganella morganii', genus_name: 'Morganella', family_name: 'Enterobacteriaceae', order_name: 'Enterobacterales' }
  const saureus = { code: 'SAU', organism_name: 'Staphylococcus aureus', genus_name: 'Staphylococcus', family_name: 'Staphylococcaceae', order_name: 'Bacillales' }
  const shominis = { code: 'SHO', organism_name: 'Staphylococcus hominis', genus_name: 'Staphylococcus', family_name: 'Staphylococcaceae', order_name: 'Bacillales' }

  it('resolves the label a guideline writes on its sheet', () => {
    expect(organismScopeForLabel('Enterobacterales')?.code).toBe('GROUP:ENTEROBACTERALES')
    expect(organismScopeForLabel('Coagulase-negative staphylococci')?.code).toBe('GROUP:CONS')
    expect(organismScopeForLabel('Something nobody publishes')).toBeUndefined()
  })

  it('puts an organism inside the scopes it belongs to', () => {
    expect(organismScopeMatches(scope('GROUP:ENTEROBACTERALES'), ecoli)).toBe(true)
    expect(organismScopeMatches(scope('GROUP:ENTEROBACTERALES'), saureus)).toBe(false)
    expect(organismScopeMatches(scope('GROUP:CONS'), shominis)).toBe(true)
  })

  it('honours the exceptions a guideline writes into a scope', () => {
    // A Morganella is an Enterobacterales but not one of the rows written "except
    // Morganellaceae"; applying that row to it would report the wrong carbapenem result.
    expect(organismScopeMatches(scope('GROUP:ENTEROBACTERALES-NOT-MORGANELLACEAE'), ecoli)).toBe(true)
    expect(organismScopeMatches(scope('GROUP:ENTEROBACTERALES-NOT-MORGANELLACEAE'), morganella)).toBe(false)
    expect(organismScopeMatches(scope('GROUP:MORGANELLACEAE'), morganella)).toBe(true)
    expect(organismScopeMatches(scope('GROUP:CONS'), saureus)).toBe(false)
  })

  it('never places an isolate in a non-species-related scope', () => {
    // EUCAST's PK/PD table is deliberately not about any organism.
    expect(organismScopeMatches(scope('GROUP:PKPD'), ecoli)).toBe(false)
    expect(organismScopeCodesFor(ecoli)).not.toContain('GROUP:PKPD')
  })

  it('matches a subspecies to its species scope', () => {
    const achromobacter = { code: 'AXY', organism_name: 'Achromobacter xylosoxidans ss. xylosoxidans', genus_name: 'Achromobacter' }
    expect(organismScopeCodesFor(achromobacter)).toContain(speciesScopeCode('Achromobacter xylosoxidans'))
  })

  it('lists every scope an organism is in, species scope included', () => {
    const codes = organismScopeCodesFor(ecoli)
    expect(codes).toContain('GROUP:ENTEROBACTERALES')
    expect(codes).toContain('GROUP:ECOLI-CKOSERI')
    expect(codes).toContain('GROUP:SPECIES:ESCHERICHIA-COLI')
  })
})
