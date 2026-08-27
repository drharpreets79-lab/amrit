// @vitest-environment node

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { WorkBook, WorkSheet } from 'xlsx'

import { parseEucastTables, parseEucastWorkbook, eucastTableUrl } from '../src/main/services'

/**
 * EUCAST is the one guideline body this software can fetch, because its tables are published
 * free of charge. That makes the parser a clinical component: a wrong number here is a wrong
 * susceptibility report, so what it does with EUCAST's own formatting is pinned down.
 */

/** A rich-text cell exactly as SheetJS presents one: value runs, then a superscript run. */
const footnoted = (value: string, footnote: string): WorkSheet[string] => ({
  t: 's',
  v: `${value}${footnote}`,
  r: `<r><t>${value}</t></r><r><rPr><vertAlign val="superscript"/><sz val="8"/></rPr><t>${footnote}</t></r>`
})
const plain = (value: string): WorkSheet[string] => ({ t: 's', v: value })

function workbookOf(sheets: Record<string, WorkSheet>): WorkBook {
  return { SheetNames: Object.keys(sheets), Sheets: sheets } as WorkBook
}

const table: WorkSheet = {
  '!ref': 'A1:D5',
  A1: plain('Antimicrobial agent'), B1: plain('S ≤'), C1: plain('R >'), D1: plain('Notes'),
  // The value is 2 mg/L carrying footnote 1. Flattened it reads "21".
  A2: plain('Ampicillin-sulbactam'), B2: footnoted('2', '1'), C2: footnoted('8', '1'),
  A3: plain('Meropenem'), B3: plain('2'), C3: plain('8'),
  // "IE" is EUCAST's insufficient-evidence marker, not a threshold.
  A4: plain('Phenoxymethylpenicillin'), B4: plain('IE'), C4: plain('IE'),
  A5: plain('Temocillin'), B5: { t: 'n', v: 8, w: '8' }, C5: { t: 'n', v: 16, w: '16' }
}

const guidance: WorkSheet = {
  '!ref': 'A1:C2',
  A1: plain('Antimicrobial agent'), B1: plain('S ≤'), C1: plain('R >'),
  A2: plain('Antimicrobial agent A'), B2: plain('1'), C2: plain('1')
}

/** One sheet, two drug-class bands, exactly as EUCAST lays an organism table out. */
const bandedSheet: WorkSheet = {
  '!ref': 'A1:G7',
  A1: plain('Penicillins'), B1: plain('MIC breakpoints \n(mg/L)'), E1: plain('Disk content (µg)'),
  F1: plain('Zone diameter breakpoints (mm)'),
  B2: plain('S ≤'), C2: plain('R >'), D2: plain('ATU'), F2: plain('S ≥'), G2: plain('R <'),
  A3: plain('Ampicillin iv'), B3: plain('8'), C3: plain('8'), F3: plain('14'), G3: plain('14'),
  A5: plain('Cephalosporins'), B5: plain('MIC breakpoints \n(mg/L)'), F5: plain('Zone diameter breakpoints (mm)'),
  B6: plain('S ≤'), C6: plain('R >'), F6: plain('S ≥'), G6: plain('R <'),
  A7: plain('Cefepime'), B7: plain('(1)'), C7: plain('4')
}

/** The anaerobe sheet, the one place EUCAST sub-divides a sheet by organism. */
const anaerobeSheet: WorkSheet = {
  '!ref': 'A1:C10',
  A1: plain('Bacteroides spp.'),
  A2: plain('Breakpoints for Bacteroides spp. are also valid for Parabacteroides spp.'),
  A3: plain('Antimicrobial agent'), B3: plain('MIC breakpoints \n(mg/L)'),
  B4: plain('S ≤'), C4: plain('R >'),
  A5: plain('Imipenem'), B5: plain('1'), C5: plain('1'),
  A7: plain('Prevotella spp.'),
  A8: plain('Antimicrobial agent'), B8: plain('MIC breakpoints \n(mg/L)'),
  B9: plain('S ≤'), C9: plain('R >'),
  A10: plain('Imipenem'), B10: plain('0.125'), C10: plain('0.125')
}

describe('EUCAST breakpoint parsing', () => {
  it('drops footnote superscripts instead of reading them as digits', () => {
    const { rows } = parseEucastTables(workbookOf({ Enterobacterales: table }), '15.0')
    const sulbactam = rows.find((row) => row.antibiotic_name === 'Ampicillin-sulbactam' && row.test_method === 'MIC')
    // The bug this guards: "2" + superscript "1" flattening to 21 mg/L, a tenfold error in
    // the number that decides whether an isolate is reported susceptible.
    expect(sulbactam?.susceptible).toBe('2')
    expect(sulbactam?.resistant).toBe('8')
  })

  it('reads plain and numeric cells unchanged', () => {
    const { rows } = parseEucastTables(workbookOf({ Enterobacterales: table }), '15.0')
    expect(rows.find((row) => row.antibiotic_name === 'Meropenem')?.susceptible).toBe('2')
    expect(rows.find((row) => row.antibiotic_name === 'Temocillin')?.resistant).toBe('16')
  })

  it('refuses insufficient-evidence markers as breakpoints', () => {
    const { rows } = parseEucastTables(workbookOf({ Enterobacterales: table }), '15.0')
    expect(rows.some((row) => row.antibiotic_name === 'Phenoxymethylpenicillin')).toBe(false)
  })

  it('skips the guidance sheet, whose worked examples use invented agents', () => {
    const { rows } = parseEucastTables(workbookOf({ Enterobacterales: table, Guidance: guidance }), '15.0')
    expect(rows.some((row) => /Antimicrobial agent A/.test(row.antibiotic_name))).toBe(false)
    expect(rows.every((row) => row.organism_name === 'Enterobacterales')).toBe(true)
  })

  it('carries the organism group, guideline and units onto every row', () => {
    const { rows } = parseEucastTables(workbookOf({ Enterobacterales: table }), '15.0')
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.guideline).toBe('EUCAST')
      expect(row.edition).toBe('15.0')
      expect(row.organism_name).toBe('Enterobacterales')
      expect(row.units).toBe(row.test_method === 'MIC' ? 'mg/L' : 'mm')
    }
  })

  it('reports rather than invents when no table is recognised', () => {
    const { rows, errors } = parseEucastTables(workbookOf({ Notes: { '!ref': 'A1:A1', A1: plain('Read me') } }), '15.0')
    expect(rows).toHaveLength(0)
    expect(errors.join(' ')).toMatch(/no eucast breakpoint table/i)
  })

  it('reads every band on a sheet, not only the first', () => {
    const { rows } = parseEucastTables(workbookOf({ Enterobacterales: bandedSheet }), '15.0')
    expect(rows.find((row) => row.antibiotic_name === 'Ampicillin iv' && row.test_method === 'MIC')?.susceptible).toBe('8')
    // Reading one band only left everything below it unparsed, so the second class was lost.
    expect(rows.find((row) => row.antibiotic_name === 'Cefepime')?.resistant).toBe('4')
  })

  it('never stores a repeated class heading as an antimicrobial', () => {
    const { rows } = parseEucastTables(workbookOf({ Enterobacterales: bandedSheet }), '15.0')
    // "Cephalosporins" carried "MIC breakpoints (mg/L)" where a threshold belongs and was
    // staged as a breakpoint, which is what produced the unmatched-antimicrobial warnings.
    expect(rows.some((row) => ['Penicillins', 'Cephalosporins'].includes(row.antibiotic_name))).toBe(false)
    expect(rows.every((row) => /^\d+(\.\d+)?$/.test(row.susceptible || row.resistant))).toBe(true)
  })

  it('keeps a bracketed threshold as its number and says so in the comment', () => {
    const { rows } = parseEucastTables(workbookOf({ Enterobacterales: bandedSheet }), '15.0')
    const cefepime = rows.find((row) => row.antibiotic_name === 'Cefepime' && row.test_method === 'MIC')
    expect(cefepime?.susceptible).toBe('1')
    expect(cefepime?.comments).toMatch(/brackets/i)
  })

  it('attributes each anaerobe band to its own organism', () => {
    const { rows } = parseEucastTables(workbookOf({ 'Anaerobic bacteria': anaerobeSheet }), '15.0')
    const imipenem = rows.filter((row) => row.antibiotic_name === 'Imipenem')
    // Both bands are Imipenem at different thresholds. Filing them under one organism gave
    // the same organism four contradictory carbapenem breakpoints.
    expect(imipenem.map((row) => `${row.organism_name}:${row.susceptible}`).sort())
      .toEqual(['Bacteroides spp.:1', 'Prevotella spp.:0.125'].sort())
  })

  it('names the section the row came from', () => {
    const { rows } = parseEucastTables(workbookOf({ Enterobacterales: bandedSheet }), '15.0')
    expect(rows.find((row) => row.antibiotic_name === 'Ampicillin iv')?.comments).toMatch(/EUCAST section: Penicillins/)
  })

  it('builds the published table URL for an edition', () => {
    expect(eucastTableUrl('15.0')).toBe(
      'https://www.eucast.org/fileadmin/src/media/PDFs/EUCAST_files/Breakpoint_tables/v_15.0_Breakpoint_Tables.xlsx'
    )
  })
})

/**
 * The bundled extract and the in-application parser must agree, because one is generated by
 * `tools/fetch_eucast_breakpoints.py` and the other runs when the update button is pressed.
 * Two readings of the same publication that disagree is a defect whichever one is right.
 */
describe('bundled EUCAST extract', () => {
  const bundled = resolve(__dirname, '../resources/breakpoints/eucast-breakpoints.json')

  it.skipIf(!existsSync(bundled))('is internally consistent and free of placeholder agents', () => {
    const payload = JSON.parse(readFileSync(bundled, 'utf8')) as {
      version: string
      attribution: string
      rows: Array<{ antibiotic_name: string; organism_name: string; susceptible: string; resistant: string; units: string }>
    }
    expect(payload.rows.length).toBeGreaterThan(100)
    expect(payload.attribution).toMatch(/EUCAST/)
    expect(payload.rows.some((row) => /^Antimicrobial agent/i.test(row.antibiotic_name))).toBe(false)
    expect(payload.rows.some((row) => row.organism_name === 'Guidance')).toBe(false)
    for (const row of payload.rows) {
      expect(row.antibiotic_name.trim()).not.toBe('')
      expect(row.organism_name.trim()).not.toBe('')
      expect(row.susceptible || row.resistant).toBeTruthy()
    }
  })

  it.skipIf(!existsSync(bundled))('agrees with the in-application parser on the same publication', () => {
    // Only runs where a maintainer has the source workbook next to the extract; the point is
    // that the Python generator and the TypeScript reader are one implementation in two
    // languages, and drift between them is caught rather than shipped.
    const workbookPath = resolve(__dirname, '../resources/breakpoints/eucast-source.xlsx')
    if (!existsSync(workbookPath)) return
    const payload = JSON.parse(readFileSync(bundled, 'utf8')) as { version: string; rows: unknown[] }
    const parsed = parseEucastWorkbook(readFileSync(workbookPath), payload.version)
    expect(parsed.rows.length).toBe(payload.rows.length)
  })
})
