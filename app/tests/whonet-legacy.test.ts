import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  fetchAwareGroups,
  loadWhonetMacroLibrary,
  parseDelimitedLine,
  parseMcrText,
  parseRptText,
  parseWhonetTstText
} from '../src/main/whonet-legacy'

describe('WHONET legacy configuration', () => {
  it('uses reviewed AWaRe fallbacks offline and confirms only an official complete response', async () => {
    const offline = await fetchAwareGroups(false)
    expect(offline.loadedFromWho).toBe(false)
    expect(offline.groups.map((group) => group.name)).toEqual(['Access', 'Watch', 'Reserve'])

    const online = await fetchAwareGroups(true, {
      fetchImpl: vi.fn(async () => new Response('<html>Access Watch Reserve 2025</html>', { status: 200 })) as typeof fetch
    })
    expect(online.loadedFromWho).toBe(true)

    const incomplete = await fetchAwareGroups(true, {
      fetchImpl: vi.fn(async () => new Response('<html>Access only</html>', { status: 200 })) as typeof fetch
    })
    expect(incomplete.loadedFromWho).toBe(false)
    expect(incomplete.warning).toMatch(/did not contain all/i)
  })

  it('parses quoted CSV cells without coercing formula-like content', () => {
    expect(parseDelimitedLine('A,"Ward, ICU","a""b",=1+1')).toEqual(['A', 'Ward, ICU', 'a"b', '=1+1'])
  })

  it('normalizes a TST configuration into laboratory-scoped masters', () => {
    const parsed = parseWhonetTstText(`
Laboratory Name=Reference Microbiology Laboratory
Laboratory Types=Human,Animal,Environment
Use dynamic breakpoints=True
Round half dilutions=Yes
Use intrinsic resistance rules=1
Guideline year=2026
Breakpoint types=Clinical|ECOFF
Sites of infection=General|Meningitis
[Institutions]
HOSP,"District Hospital"
[Departments]
MICRO,"Microbiology"
[Wards]
ICU,"Intensive Care, Adult",IN,,MICRO,HOSP
[Antibiotics]
Default Breakpoints=CLSI
Default Test Method=Disk diffusion
CIP_ND5,Ciprofloxacin_disk_5_ug
CIP_NM,Ciprofloxacin_MIC
MEM_ND10,Meropenem_disk_10_ug
[Antibiotic Profiles]
Enterobacterales=CIP_ND5,MEM_ND10 (CIP_NM)
[Data fields]
Patient category,X_PATCAT,20,text,Clinical,human-animal,List
[Expert rules:  Modify antibiotic interpretations]
Interpretation rule=ESBL
[Clinical report format]
Conditional antibiotic reporting=Yes
Print clinical message=No
`, '/tmp/example.TST')

    expect(parsed).toMatchObject({
      laboratory_name: 'Reference Microbiology Laboratory',
      domains: ['human', 'animal', 'environment'],
      whonet_settings: {
        default_guideline: 'CLSI', default_test_method: 'Disk diffusion', guideline_year: '2026',
        enabled_expert_rules: ['ESBL'], conditional_antibiotic_reporting: true, print_clinical_message: false
      }
    })
    expect(parsed.locations).toEqual([expect.objectContaining({
      location_code: 'ICU', location_name: 'Intensive Care, Adult', institution: 'District Hospital', department: 'Microbiology'
    })])
    expect(parsed.antibiotic_settings).toEqual([
      expect.objectContaining({ antibiotic_code: 'CIP', test_code: 'CIP_ND5', disk_potency: '5', include_in_profile: true }),
      expect.objectContaining({ antibiotic_code: 'MEM', test_code: 'MEM_ND10', disk_potency: '10', include_in_profile: true })
    ])
    expect(parsed.profiles[0]).toMatchObject({ name: 'Enterobacterales', antibiotics: [{ code: 'CIP' }, { code: 'MEM' }] })
    expect(parsed.data_fields[0]).toMatchObject({ field_key: 'X_PATCAT', applicable_domains: 'human,animal', include_in_listing: true })
  })
})

describe('WHONET macro and report libraries', () => {
  it('parses supported multi-run MCR and RPT definitions', () => {
    const mcr = parseMcrText(`
Macro name=National AMR summary
BEGIN ANALYSIS
Study=Susceptibility summary (Rows=ORGANISM+SPEC_TYPE, Columns={StatisticsVariables})
Organism=ALL
BEGIN ANALYSIS
Study=Cluster alerts (Rows=LOCATION, Columns=SPEC_DATE BY MONTH)
One per patient, unit=First isolate only
`, '/tmp/National.mcr')
    expect(mcr.macro_name).toBe('National AMR summary')
    expect(mcr.supported).toBe(true)
    expect(mcr.runs).toHaveLength(2)
    expect(mcr.runs[0]?.study.row_variables).toEqual(['ORGANISM', 'SPEC_TYPE'])
    expect(mcr.runs[1]?.settings['One per patient, unit']).toBe('First isolate only')

    const rpt = parseRptText('Report name=Routine bundle\nCore\\Listing.mcr\nAlerts.mcr\n', '/tmp/Routine.rpt')
    expect(rpt).toMatchObject({ report_name: 'Routine bundle', members: ['Core/Listing.mcr', 'Alerts.mcr'] })
  })

  it('imports a nested library deterministically and ignores unrelated files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'amrit-whonet-library-'))
    await mkdir(path.join(root, 'Core'))
    await writeFile(path.join(root, 'Core', 'Listing.mcr'), 'Macro name=Listing\nStudy=Isolate listing summary (Rows=ORGANISM, Columns=[None])\n')
    await writeFile(path.join(root, 'Bundle.rpt'), 'Report name=Bundle\nCore\\Listing.mcr\n')
    await writeFile(path.join(root, 'ignore.txt'), 'not a template')
    const entries = await loadWhonetMacroLibrary(root)
    expect(entries.map((entry) => entry.name)).toEqual(['RPT::Bundle.rpt', 'MCR::Core/Listing.mcr'])
    expect(entries[1]?.config).toMatchObject({ display_name: 'Listing', category_path: 'Core', supported: true })
  })
})
