import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

export const MAX_WHONET_TEXT_BYTES = 5 * 1024 * 1024
export const MAX_WHONET_LIBRARY_FILES = 5_000
export const WHO_AWARE_CLASSIFICATION_URL = 'https://www.who.int/publications/i/item/B09489'

export interface AwareGroup {
  name: 'Access' | 'Watch' | 'Reserve'
  description: string
  source_url: string
  edition: string
}

export interface AwareGroupsResult {
  groups: AwareGroup[]
  loadedFromWho: boolean
  warning?: string
}

export const FALLBACK_AWARE_GROUPS: readonly AwareGroup[] = Object.freeze([
  {
    name: 'Access',
    description: 'Antibiotics prioritized for broad availability and appropriate first- or second-choice use.',
    source_url: WHO_AWARE_CLASSIFICATION_URL,
    edition: '2025'
  },
  {
    name: 'Watch',
    description: 'Antibiotics with higher resistance potential whose use should be carefully monitored.',
    source_url: WHO_AWARE_CLASSIFICATION_URL,
    edition: '2025'
  },
  {
    name: 'Reserve',
    description: 'Last-resort antibiotics reserved for selected infections when alternatives are unsuitable.',
    source_url: WHO_AWARE_CLASSIFICATION_URL,
    edition: '2025'
  }
])

export interface WhonetAntibioticSetting {
  antibiotic_code: string
  antibiotic_name: string
  guideline: string
  test_method: string
  disk_potency: string
  test_code: string
  include_in_profile: boolean
  breakpoint_scope: string
  breakpoint_notes: string
  sort_order: number
}

export interface WhonetTstConfiguration {
  source_path: string
  laboratory_name: string
  domains: string[]
  whonet_settings: Record<string, unknown>
  locations: Array<Record<string, unknown>>
  antibiotics: Array<{ code: string; name: string }>
  antibiotic_settings: WhonetAntibioticSetting[]
  profiles: Array<Record<string, unknown>>
  data_fields: Array<Record<string, unknown>>
}

export interface WhonetStudyDefinition {
  raw: string
  study_name: string
  rows_expr: string
  columns_expr: string
  row_variables: string[]
  column_variables: string[]
}

export interface WhonetMcrRun {
  index: number
  settings: Record<string, string>
  study: WhonetStudyDefinition
}

export interface WhonetMcrTemplate {
  kind: 'mcr'
  macro_name: string
  source_path: string
  runs: WhonetMcrRun[]
  supported: boolean
}

export interface WhonetRptTemplate {
  kind: 'rpt'
  report_name: string
  source_path: string
  members: string[]
}

export interface WhonetLibraryEntry {
  name: string
  config: Record<string, unknown>
}

const SUPPORTED_STUDY_PREFIXES = Object.freeze([
  'Isolate listing summary',
  'Isolate alerts',
  'RIS and test measurements',
  'Susceptibility summary',
  'Resistance profiles summary',
  'Cluster alerts'
])

const TST_SECTIONS = Object.freeze([
  'Antibiotics',
  'Wards',
  'Institutions',
  'Departments',
  'Antibiotic Profiles',
  'Data fields',
  'Expert rules:  Modify antibiotic interpretations',
  'Clinical report format'
])

function text(value: unknown): string {
  return String(value ?? '').trim()
}

/**
 * Confirm the current official WHO AWaRe publication is reachable. Category
 * wording remains a reviewed offline asset so a website redesign cannot alter
 * a laboratory master silently.
 */
export async function fetchAwareGroups(
  networkEnabled: boolean,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<AwareGroupsResult> {
  const fallback = (): AwareGroup[] => FALLBACK_AWARE_GROUPS.map((group) => ({ ...group }))
  if (!networkEnabled) return { groups: fallback(), loadedFromWho: false, warning: 'Network access is off; using the reviewed offline AWaRe groups.' }
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = Math.max(1_000, Math.min(30_000, options.timeoutMs ?? 8_000))
  try {
    const response = await fetchImpl(WHO_AWARE_CLASSIFICATION_URL, {
      headers: { Accept: 'text/html', 'User-Agent': 'AMRIT/2.0' },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow'
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const declaredLength = Number(response.headers.get('content-length') ?? 0)
    if (declaredLength > 2 * 1024 * 1024) throw new Error('response exceeds 2 MB')
    const body = (await response.text()).slice(0, 2 * 1024 * 1024)
    const normalized = body.toLocaleLowerCase()
    if (!['access', 'watch', 'reserve'].every((group) => normalized.includes(group))) {
      throw new Error('official page did not contain all AWaRe group names')
    }
    return { groups: fallback(), loadedFromWho: true }
  } catch (error) {
    return {
      groups: fallback(),
      loadedFromWho: false,
      warning: `WHO publication could not be confirmed; using the reviewed offline AWaRe groups (${error instanceof Error ? error.message : String(error)}).`
    }
  }
}

function booleanValue(value: unknown): boolean {
  return ['true', 'yes', '1', 'on'].includes(text(value).toLocaleLowerCase())
}

function splitKeyValue(line: string): [string, string] {
  const index = line.indexOf('=')
  return index < 0 ? [line.trim(), ''] : [line.slice(0, index).trim(), line.slice(index + 1).trim()]
}

/** Parse one RFC-4180-style line without interpreting formulae or coercing values. */
export function parseDelimitedLine(line: string): string[] {
  const cells: string[] = []
  let value = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === '"') {
      if (quoted && line[index + 1] === '"') { value += '"'; index += 1 } else quoted = !quoted
    } else if (character === ',' && !quoted) {
      cells.push(value.trim())
      value = ''
    } else value += character
  }
  cells.push(value.trim())
  return cells
}

function normalizeDomain(value: unknown): string {
  const normalized = text(value).toLocaleLowerCase()
  if (normalized === 'human') return 'human'
  if (normalized === 'animal') return 'animal'
  if (['veterinary', 'vet'].includes(normalized)) return 'veterinary'
  if (['environment', 'environmental'].includes(normalized)) return 'environment'
  return ''
}

function normalizeLocationType(value: unknown): string {
  const normalized = text(value).toLocaleLowerCase()
  return ['oth', 'other'].includes(normalized) ? 'other' : normalized
}

function antibioticName(displayName: unknown): string {
  const raw = text(displayName)
  const parts = raw.split('_')
  return (parts.length >= 3 ? parts[0] ?? raw : raw).replaceAll('_', ' ').trim()
}

function testMethod(testCode: unknown): string {
  const code = text(testCode).toLocaleUpperCase()
  if (code.includes('_ND')) return 'Disk diffusion'
  if (code.includes('_NM')) return 'MIC'
  if (code.includes('_NE')) return 'Etest'
  return ''
}

function diskPotency(testCode: unknown, displayName: unknown): string {
  const code = text(testCode)
  if (!code.toLocaleUpperCase().includes('_ND')) return ''
  const parts = text(displayName).split('_')
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const candidate = text(parts[index]).replace(/(?:µg|ug)$/i, '').replace('_', '.').trim()
    if (/^\d+(?:\.\d+)?$/.test(candidate)) return candidate
  }
  return text(code.split(/_ND/i)[1]).replaceAll('_', '.').trim()
}

function preferredSettings(
  rows: WhonetAntibioticSetting[],
  defaultMethod: string,
  defaultGuideline: string
): WhonetAntibioticSetting[] {
  const grouped = new Map<string, WhonetAntibioticSetting[]>()
  for (const row of rows) grouped.set(row.antibiotic_code, [...(grouped.get(row.antibiotic_code) ?? []), row])
  return [...grouped.entries()].map(([, candidates]) => {
    const chosen = candidates.find((row) => row.test_method === defaultMethod) ?? candidates[0]
    if (!chosen) throw new Error('WHONET antibiotic group is empty.')
    return { ...chosen, guideline: chosen.guideline || defaultGuideline }
  }).sort((left, right) => left.sort_order - right.sort_order || left.antibiotic_name.localeCompare(right.antibiotic_name))
}

export function parseWhonetTstText(source: string, sourcePath = ''): WhonetTstConfiguration {
  const topLevel: Record<string, string> = {}
  const sections = Object.fromEntries(TST_SECTIONS.map((section) => [section, [] as string[]])) as Record<string, string[]>
  let currentSection = ''
  for (const rawLine of String(source ?? '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('[') && line.endsWith(']')) { currentSection = line.slice(1, -1); continue }
    if (currentSection in sections) sections[currentSection]?.push(rawLine)
    else if (line.includes('=')) { const [key, value] = splitKeyValue(line); topLevel[key] = value }
  }

  const codeMap = (section: string): Map<string, string> => new Map((sections[section] ?? []).map(parseDelimitedLine)
    .filter((row) => row.length >= 2 && row[0])
    .map((row) => [text(row[0]).replace(/^"|"$/g, ''), text(row[1]).replace(/^"|"$/g, '')]))
  const institutions = codeMap('Institutions')
  const departments = codeMap('Departments')
  const locations = (sections.Wards ?? []).map(parseDelimitedLine).filter((row) => row.length >= 6).map((row) => {
    const institutionCode = text(row[5]).replace(/^"|"$/g, '')
    const departmentCode = text(row[4]).replace(/^"|"$/g, '')
    return {
      location_name: text(row[1]).replace(/^"|"$/g, ''),
      location_code: text(row[0]).replace(/^"|"$/g, ''),
      location_type: normalizeLocationType(text(row[2]).replace(/^"|"$/g, '')),
      institution: institutions.get(institutionCode) ?? institutionCode,
      department: departments.get(departmentCode) ?? departmentCode,
      active: true
    }
  })

  const antibioticDefaults: Record<string, string> = {}
  const antibioticRows: WhonetAntibioticSetting[] = []
  for (const rawLine of sections.Antibiotics ?? []) {
    const line = rawLine.trim()
    if (line.includes('=')) { const [key, value] = splitKeyValue(line); antibioticDefaults[key] = value; continue }
    const row = parseDelimitedLine(rawLine)
    if (row.length < 2) continue
    const testCode = text(row[0])
    const displayName = text(row[1])
    const antibioticCode = text(testCode.split('_', 1)[0]).toLocaleUpperCase()
    if (!antibioticCode) continue
    antibioticRows.push({
      antibiotic_code: antibioticCode,
      antibiotic_name: antibioticName(displayName),
      guideline: text(antibioticDefaults['Default Breakpoints']) || 'CLSI',
      test_method: testMethod(testCode) || text(antibioticDefaults['Default Test Method']) || 'Disk diffusion',
      disk_potency: diskPotency(testCode, displayName),
      test_code: testCode,
      include_in_profile: false,
      breakpoint_scope: 'General',
      breakpoint_notes: '',
      sort_order: antibioticRows.length + 1
    })
  }
  const defaultGuideline = text(antibioticDefaults['Default Breakpoints']) || 'CLSI'
  const defaultMethod = text(antibioticDefaults['Default Test Method']) || 'Disk diffusion'
  const settings = preferredSettings(antibioticRows, defaultMethod, defaultGuideline)
  const byTest = new Map(antibioticRows.map((row) => [row.test_code, row]))
  const profileCodes = new Set<string>()
  const profiles = (sections['Antibiotic Profiles'] ?? []).filter((line) => line.includes('=')).map((line) => {
    const [name, profileValue] = splitKeyValue(line)
    const [routineRaw = '', supplementalRaw = ''] = profileValue.split('(', 2)
    const routine = routineRaw.split(',').map(text).filter(Boolean)
    const supplemental = supplementalRaw.split(',').map((item) => text(item).replace(/\)+$/, '')).filter(Boolean)
    const members = [...routine, ...supplemental].map((code) => byTest.get(code)).filter((row): row is WhonetAntibioticSetting => Boolean(row))
    const unique = [...new Map(members.map((row) => [row.antibiotic_code, { code: row.antibiotic_code, name: row.antibiotic_name }])).values()]
    for (const item of unique) profileCodes.add(item.code)
    return { name, routine_test_codes: routine, supplemental_test_codes: supplemental, antibiotics: unique }
  })
  for (const setting of settings) setting.include_in_profile = profileCodes.has(setting.antibiotic_code)

  const dataFields = (sections['Data fields'] ?? []).map(parseDelimitedLine).filter((row) => row.length >= 7).map((row) => ({
    field_label: text(row[0]),
    field_key: text(row[1]),
    field_length: Number(text(row[2])) || 20,
    category: text(row[3]) || 'text',
    field_group: text(row[4]) || 'Imported',
    applicable_domains: text(row[5]).split('-').map((item) => normalizeDomain(item)).filter(Boolean).join(','),
    is_enabled: !['no', 'false', '0', 'off'].includes(text(row[6]).toLocaleLowerCase()),
    include_in_listing: text(row[6]).toLocaleLowerCase().includes('list'),
    is_hidden: false,
    is_custom: true
  }))
  const enabledExpertRules = (sections['Expert rules:  Modify antibiotic interpretations'] ?? [])
    .filter((line) => line.includes('='))
    .map(splitKeyValue)
    .filter(([key]) => key === 'Interpretation rule')
    .map(([, value]) => value)
  const clinical: Record<string, string[]> = {}
  for (const line of sections['Clinical report format'] ?? []) {
    if (!line.includes('=')) continue
    const [key, value] = splitKeyValue(line)
    clinical[key] = [...(clinical[key] ?? []), value]
  }
  const domains = text(topLevel['Laboratory Types']).split(',').map(normalizeDomain).filter((value, index, values) => Boolean(value) && values.indexOf(value) === index)
  return {
    source_path: sourcePath,
    laboratory_name: text(topLevel['Laboratory Name']),
    domains,
    whonet_settings: {
      use_dynamic_breakpoints: booleanValue(topLevel['Use dynamic breakpoints'] || 'True'),
      round_half_dilutions: booleanValue(topLevel['Round half dilutions'] || 'True'),
      use_intrinsic_resistance_rules: booleanValue(topLevel['Use intrinsic resistance rules'] || 'True'),
      guideline_year: text(topLevel['Guideline year']),
      breakpoint_types: text(topLevel['Breakpoint types']).split('|').map(text).filter(Boolean),
      sites_of_infection: text(topLevel['Sites of infection']).split('|').map(text).filter(Boolean),
      default_guideline: defaultGuideline,
      default_test_method: defaultMethod,
      enabled_expert_rules: enabledExpertRules,
      conditional_antibiotic_reporting: booleanValue(clinical['Conditional antibiotic reporting']?.[0]),
      print_clinical_message: booleanValue(clinical['Print clinical message']?.[0])
    },
    locations,
    antibiotics: settings.map((row) => ({ code: row.antibiotic_code, name: row.antibiotic_name })),
    antibiotic_settings: settings,
    profiles,
    data_fields: dataFields
  }
}

export function parseStudyDefinition(value: unknown): WhonetStudyDefinition {
  const raw = text(value)
  const studyName = text(raw.split('(', 1)[0])
  const rowsExpr = text(raw.match(/Rows\s*=\s*([^,)]+(?:\+[^,)]+)*)/i)?.[1])
  const columnsExpr = text(raw.match(/Columns\s*=\s*([^)]+)/i)?.[1])
  return {
    raw,
    study_name: studyName,
    rows_expr: rowsExpr,
    columns_expr: columnsExpr,
    row_variables: rowsExpr.split('+').map(text).filter(Boolean),
    column_variables: columnsExpr.split('+').map(text).filter(Boolean)
  }
}

export function parseMcrText(source: string, sourcePath = ''): WhonetMcrTemplate {
  let current: Record<string, string> = {}
  const runs: Array<Record<string, string>> = []
  let macroName = ''
  for (const rawLine of String(source ?? '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('//')) continue
    if (line.toLocaleUpperCase() === 'BEGIN ANALYSIS') {
      if (current.Study) runs.push({ ...current })
      current = {}
      continue
    }
    if (!line.includes('=')) continue
    const [key, value] = splitKeyValue(line)
    current[key] = value
    if (key.toLocaleLowerCase() === 'macro name') macroName = value
  }
  if (current.Study) runs.push({ ...current })
  const parsedRuns = runs.map((settings, index) => ({ index: index + 1, settings, study: parseStudyDefinition(settings.Study) }))
  return {
    kind: 'mcr',
    macro_name: macroName || path.basename(sourcePath, path.extname(sourcePath)),
    source_path: sourcePath,
    runs: parsedRuns,
    supported: parsedRuns.length > 0 && parsedRuns.every((run) => SUPPORTED_STUDY_PREFIXES.some((prefix) => run.study.study_name.startsWith(prefix)))
  }
}

export function parseRptText(source: string, sourcePath = ''): WhonetRptTemplate {
  let reportName = path.basename(sourcePath, path.extname(sourcePath))
  const members: string[] = []
  for (const rawLine of String(source ?? '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.toLocaleLowerCase().startsWith('report name=')) { reportName = splitKeyValue(line)[1]; continue }
    members.push(line.replaceAll('\\', '/'))
  }
  return { kind: 'rpt', report_name: reportName, source_path: sourcePath, members }
}

async function readWhonetText(filePath: string): Promise<string> {
  const info = await stat(filePath)
  if (!info.isFile()) throw new Error(`WHONET source is not a file: ${filePath}`)
  if (info.size <= 0 || info.size > MAX_WHONET_TEXT_BYTES) throw new Error(`WHONET source must be between 1 byte and ${MAX_WHONET_TEXT_BYTES / 1024 / 1024} MB.`)
  return (await readFile(filePath)).toString('utf8').replace(/^\uFEFF/, '')
}

export async function loadWhonetTst(filePath: string): Promise<WhonetTstConfiguration> {
  if (path.extname(filePath).toLocaleLowerCase() !== '.tst') throw new Error('WHONET configuration must use the .TST extension.')
  return parseWhonetTstText(await readWhonetText(filePath), filePath)
}

async function walkLibrary(rootPath: string, currentPath = rootPath, collected: string[] = []): Promise<string[]> {
  const entries = await readdir(currentPath, { withFileTypes: true })
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const candidate = path.join(currentPath, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) await walkLibrary(rootPath, candidate, collected)
    else if (entry.isFile() && ['.mcr', '.rpt'].includes(path.extname(entry.name).toLocaleLowerCase())) {
      collected.push(candidate)
      if (collected.length > MAX_WHONET_LIBRARY_FILES) throw new Error(`WHONET library exceeds ${MAX_WHONET_LIBRARY_FILES.toLocaleString()} files.`)
    }
  }
  return collected
}

export async function loadWhonetMacroLibrary(rootPath: string): Promise<WhonetLibraryEntry[]> {
  const info = await stat(rootPath)
  if (!info.isDirectory()) throw new Error(`WHONET macro library is not a directory: ${rootPath}`)
  const root = path.resolve(rootPath)
  const files = await walkLibrary(root)
  const entries: WhonetLibraryEntry[] = []
  for (const filePath of files) {
    const rawText = await readWhonetText(filePath)
    const relativePath = path.relative(root, filePath).split(path.sep).join('/')
    const categoryPath = path.dirname(relativePath) === '.' ? '' : path.dirname(relativePath).split(path.sep).join('/')
    if (path.extname(filePath).toLocaleLowerCase() === '.mcr') {
      const parsed = parseMcrText(rawText, filePath)
      entries.push({
        name: `MCR::${relativePath}`,
        config: {
          macro_source: 'whonet_template', template_kind: 'mcr', display_name: parsed.macro_name,
          relative_path: relativePath, category_path: categoryPath, raw_text: rawText,
          parsed_template: parsed, supported: parsed.supported
        }
      })
    } else {
      const parsed = parseRptText(rawText, filePath)
      entries.push({
        name: `RPT::${relativePath}`,
        config: {
          macro_source: 'whonet_report', template_kind: 'rpt', display_name: parsed.report_name,
          relative_path: relativePath, category_path: categoryPath, raw_text: rawText, parsed_report: parsed
        }
      })
    }
  }
  return entries
}
