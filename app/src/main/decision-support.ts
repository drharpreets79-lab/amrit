import type { DatabaseSync } from 'node:sqlite'

import type { AstResult, IsolateRecord, Row } from '../shared/types'
import { organismScopeCodesFor, type OrganismTaxon } from './breakpoint-mapping'

type DbRow = Record<string, unknown>

export interface DecisionIssue {
  severity: 'error' | 'warning'
  field: string
  message: string
}

export interface PreparedRecord {
  record: IsolateRecord
  issues: DecisionIssue[]
}

interface BreakpointCandidate extends DbRow {
  id: number
  guidelines: string
  year: string
  test_method: string
  potency: string
  site_of_infection: string
  organism_code: string
  organism_code_type: string
  route: string
  r_value: string
  i_value: string
  sdd_value: string
  s_value: string
  set_name: string
  set_organization: string
  set_edition: string
  set_source_url: string
}

const text = (value: unknown): string => String(value ?? '').trim()
const code = (value: unknown): string => text(value).toUpperCase()

const IMPORTANT_SPECIES = [
  'salmonella', 'shigella', 'neisseria gonorrhoeae', 'bordetella pertussis',
  'bordetella parapertussis', 'streptococcus pneumoniae'
]
const ENTEROBACTERALES = [
  'escherichia coli', 'klebsiella', 'enterobacter', 'citrobacter', 'serratia',
  'proteus', 'morganella', 'providencia'
]
const GRAM_NEGATIVE = [...ENTEROBACTERALES, 'pseudomonas', 'acinetobacter']

function supportDate(value: unknown): Date | null {
  const raw = text(value)
  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(raw)
  const local = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(raw)
  const year = Number(iso?.[1] ?? local?.[3])
  const month = Number(iso?.[2] ?? local?.[2])
  const day = Number(iso?.[3] ?? local?.[1])
  if (!year || !month || !day) return null
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null
}

function infectionOrigin(record: Record<string, unknown>): 'Hospital' | 'Community' | 'Unknown' {
  const locationType = text(record.location_type).toLocaleLowerCase()
  if (locationType === 'out') return 'Community'
  if (locationType !== 'in') return 'Unknown'
  const admission = supportDate(record.admission_date)
  const specimen = supportDate(record.specimen_date)
  if (!admission || !specimen) return 'Unknown'
  return (specimen.getTime() - admission.getTime()) / 86_400_000 > 2 ? 'Hospital' : 'Community'
}

/** Punctuation-insensitive master key, aligned with the Python panel/import implementation. */
export function normalizeMasterText(value: unknown): string {
  const normalized = text(value)
    .normalize('NFKD')
    .toLocaleLowerCase()
    .replace(/\s*\(organism\)\s*$/i, '')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  const parts = normalized.split(/\s+/).filter(Boolean)
  if (['sample', 'specimen'].includes(parts.at(-1) ?? '')) parts.pop()
  return parts.join(' ')
}

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(text).filter(Boolean)
  const raw = text(value)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) return parsed.map(text).filter(Boolean)
  } catch {
    // Legacy configuration also stores comma-separated values.
  }
  return raw.split(',').map(text).filter(Boolean)
}

function astMap(value: unknown): Record<string, AstResult> {
  let parsed = value
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value) as unknown } catch { parsed = {} }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const output: Record<string, AstResult> = {}
  for (const [rawCode, rawPayload] of Object.entries(parsed as Record<string, unknown>)) {
    if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) continue
    const payload = rawPayload as Record<string, unknown>
    const antibioticCode = code(payload.code ?? rawCode)
    if (!antibioticCode) continue
    const interpretation = code(payload.result)
    output[antibioticCode] = {
      result: (['R', 'I', 'S'].includes(interpretation) ? interpretation : '') as AstResult['result'],
      measurement: (payload.measurement ?? '') as string | number,
      method: text(payload.method),
      guideline: text(payload.guideline),
      potency: text(payload.potency),
      source: text(payload.source)
    }
  }
  return output
}

function populatedAst(results: Record<string, AstResult>): boolean {
  return Object.values(results).some((item) => Boolean(text(item.result) || text(item.measurement)))
}

function normalizeMethod(value: unknown): 'MIC' | 'DISK' | '' {
  const key = normalizeMasterText(value).replace(/\s+/g, '')
  if (['mic', 'brothmicrodilution', 'microdilution', 'gradientdiffusion', 'etest'].includes(key)) return 'MIC'
  if (['disk', 'disc', 'diskdiffusion', 'discdiffusion', 'dd'].includes(key)) return 'DISK'
  return ''
}

function comparableText(value: unknown): string {
  return text(value).toLocaleLowerCase().replace(/[μµ]/g, 'u').replace(/\s+/g, '')
}

function numericMeasurement(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const raw = text(value).replace(',', '.')
  if (!/^(?:[<>]=?|[≤≥])?\s*[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(raw)) return null
  const parsed = Number(raw.replace(/^(?:[<>]=?|[≤≥])\s*/, ''))
  return Number.isFinite(parsed) ? parsed : null
}

function numericBreakpoint(value: unknown): number | null {
  const raw = text(value).replace(',', '.')
  const match = raw.match(/[+-]?(?:\d+(?:\.\d+)?|\.\d+)/)
  if (!match) return null
  const parsed = Number(match[0])
  return Number.isFinite(parsed) ? parsed : null
}

function thresholdsKey(row: BreakpointCandidate): string {
  return [row.r_value, row.i_value, row.sdd_value, row.s_value].map(text).join('|')
}

function interpretMeasurement(
  measurement: number,
  method: 'MIC' | 'DISK',
  row: BreakpointCandidate
): AstResult['result'] | null {
  const susceptible = numericBreakpoint(row.s_value)
  const resistant = numericBreakpoint(row.r_value)
  if (susceptible === null && resistant === null) return null
  // A guideline states the two thresholds as relations, and the relations are what decide the
  // boundary values. EUCAST heads its columns "S <=" and "R >" for a dilution and "S >=" and
  // "R <" for a zone, which `parseEucastWorkbook` matches literally. So a table with S and R
  // equal is not a contradiction: it is the ordinary case of an agent with **no intermediate
  // category**, where S <= x and R > x partition the scale between them. Rejecting it left 419
  // of the 545 bundled EUCAST MIC rows unable to interpret anything at all.
  if (susceptible !== null && resistant !== null) {
    if (method === 'MIC' && susceptible > resistant) return null
    if (method === 'DISK' && susceptible < resistant) return null
  }
  if (method === 'MIC') {
    if (susceptible !== null && measurement <= susceptible) return 'S'
    // Strictly greater. "R > 8" makes an MIC of exactly 8 intermediate, not resistant, and the
    // difference falls on the modal value of the dilution series rather than in the tail — which
    // is why Study A found it against WHONET's engine on meropenem at 8 mg/L and ciprofloxacin
    // at 0.5 mg/L, and why it moves a resistance rate rather than a handful of isolates.
    if (resistant !== null && measurement > resistant) return 'R'
  } else {
    if (susceptible !== null && measurement >= susceptible) return 'S'
    // Strictly less, for the same reason: "R < 16" makes a 16 mm zone intermediate.
    if (resistant !== null && measurement < resistant) return 'R'
  }
  // A middle category is defensible only when both outer thresholds are explicitly present.
  return susceptible !== null && resistant !== null ? 'I' : null
}

function criterionValue(record: Record<string, unknown>, results: Record<string, AstResult>, key: string): string {
  const normalized = code(key)
  if (results[normalized]) return code(results[normalized]?.result)
  const direct = record[key] ?? record[key.toLocaleLowerCase()] ?? record[normalized.toLocaleLowerCase()]
  return code(direct)
}

function criterionTermMatches(record: Record<string, unknown>, results: Record<string, AstResult>, rawTerm: string): boolean {
  const match = rawTerm.trim().match(/^([A-Za-z0-9_+-]+)\s*=\s*([A-Za-z0-9_+.-]+)$/)
  if (!match) return false
  const actual = criterionValue(record, results, match[1] ?? '')
  const expected = code(match[2])
  if (expected === 'NS') return actual === 'R' || actual === 'I'
  if (expected === '+') return ['+', 'POS', 'POSITIVE', 'P', 'TRUE', '1'].includes(actual)
  if (expected === '-') return ['-', 'NEG', 'NEGATIVE', 'N', 'FALSE', '0'].includes(actual)
  return actual === expected
}

/** Restricted boolean grammar: OR groups containing AND equality terms. No executable expressions. */
export function ruleCriteriaMatch(record: IsolateRecord, criteria: unknown): boolean {
  const expression = text(criteria)
  if (!expression) return false
  const source = record as Record<string, unknown>
  const results = astMap(source.antibiotic_results)
  return expression.split(/\s+OR\s+/i).some((orGroup) =>
    orGroup.split(/\s+AND\s+/i).every((term) => criterionTermMatches(source, results, term))
  )
}

function panelGuidance(panel: Record<string, unknown>): string[] {
  const antibiotics = Array.isArray(panel.antibiotics)
    ? panel.antibiotics as Array<Record<string, unknown>>
    : []
  const lines: string[] = []
  const handled = new Set<number>()
  const drug = (item: Record<string, unknown>): string => {
    const drugCode = code(item.code ?? item.antibiotic_code)
    const name = text(item.name ?? item.antibiotic_name)
    return name && name !== drugCode ? `${drugCode} - ${name}` : drugCode || name
  }
  antibiotics.forEach((item, index) => {
    if (handled.has(index)) return
    const requirement = normalizeMasterText(item.requirement_type || 'core').replace(/ /g, '_')
    const group = text(item.option_group || item.choice_group)
    const sourceText = text(item.source_text || item.source_clause)
    if (requirement === 'one_of' || group) {
      const members = antibiotics
        .map((member, memberIndex) => ({ member, memberIndex }))
        .filter(({ member, memberIndex }) => !handled.has(memberIndex) && (
          group
            ? text(member.option_group || member.choice_group) === group
            : normalizeMasterText(member.requirement_type) === 'one of' && text(member.source_text || member.source_clause) === sourceText
        ))
      if (members.length > 1) {
        members.forEach(({ memberIndex }) => handled.add(memberIndex))
        lines.push(`Choose one: ${members.map(({ member }) => drug(member)).join(' OR ')}`)
        return
      }
    }
    if (requirement === 'synergy') {
      const members = antibiotics
        .map((member, memberIndex) => ({ member, memberIndex }))
        .filter(({ member, memberIndex }) => !handled.has(memberIndex) &&
          normalizeMasterText(member.requirement_type) === 'synergy' &&
          text(member.source_text || member.source_clause) === sourceText)
      members.forEach(({ memberIndex }) => handled.add(memberIndex))
      lines.push(`Synergy pair (test together): ${members.map(({ member }) => drug(member)).join(' + ')}`)
      return
    }
    handled.add(index)
    const prefixes: Record<string, string> = {
      screen: 'Screen', conditional: 'Conditional', conditional_follow_up: 'Conditional follow-up',
      conditional_report: 'Test for conditional reporting', surrogate: 'Surrogate/local option'
    }
    const base = prefixes[requirement] ? `${prefixes[requirement]}: ${drug(item)}` : drug(item)
    lines.push(text(item.notes) ? `${base} (${text(item.notes)})` : base)
  })
  const rawGuidance = Array.isArray(panel.guidance) ? panel.guidance : []
  for (const item of rawGuidance as Array<Record<string, unknown>>) {
    const guidance = text(item.notes || item.source_text)
    if (guidance) lines.push(`${text(item.requirement_type || 'Guidance').replace(/_/g, ' ')}: ${guidance}`)
  }
  if (panel.no_routine_ast && antibiotics.length === 0) {
    lines.unshift('Routine therapeutic AST is not recommended for this configured organism/specimen context.')
  }
  return lines
}

export function enrichPanelGuidance(panel: Row, results?: unknown): Row {
  const source = panel as Record<string, unknown>
  const antibiotics = Array.isArray(source.antibiotics)
    ? source.antibiotics as Array<Record<string, unknown>>
    : []
  const allowed = new Set(antibiotics.map((item) => code(item.code ?? item.antibiotic_code)).filter(Boolean))
  const outside = Object.entries(astMap(results)).filter(([antibioticCode, payload]) =>
    !allowed.has(antibioticCode) && Boolean(text(payload.result) || text(payload.measurement))
  ).map(([antibioticCode]) => antibioticCode).sort()
  const warnings: string[] = []
  if (outside.length) {
    warnings.push(source.no_routine_ast && allowed.size === 0
      ? `Guidance-only panel cannot retain routine AST results: ${outside.join(', ')}`
      : `AST results outside this panel: ${outside.join(', ')}`)
  }
  return {
    ...panel,
    testing_guidance: panelGuidance(source),
    testing_warnings: warnings
  } as Row
}

export class DecisionSupportEngine {
  constructor(private readonly db: DatabaseSync) {}

  prepare(input: IsolateRecord): PreparedRecord {
    const record = structuredClone(input) as IsolateRecord
    const issues: DecisionIssue[] = []
    const source = record as Record<string, unknown>
    source.lab_code = code(source.lab_code)
    source.record_status = source.record_status === 'draft' ? 'draft' : 'final'
    if (!text(source.ast_not_performed_reason) && text(source.no_ast_reason)) {
      source.ast_not_performed_reason = text(source.no_ast_reason)
    }
    const strict = source.record_status === 'final'
    const severity = strict ? 'error' : 'warning'

    this.canonicalizeSample(source, issues, severity)
    this.canonicalizeOrganism(source, issues, severity)
    source.antibiotic_results = astMap(source.antibiotic_results)
    this.applyPanel(source, issues)
    this.interpretAst(source, issues)
    this.validateRequired(source, issues)

    if (strict && !issues.some((issue) => issue.severity === 'error')) {
      const evaluated = this.evaluateSupport(source as IsolateRecord)
      source.alerts = evaluated.alerts
      source.expert_comments = evaluated.comments
    } else if (!strict) {
      source.alerts = []
      source.expert_comments = []
    }
    return { record: source as IsolateRecord, issues }
  }

  private canonicalizeSample(
    record: Record<string, unknown>,
    issues: DecisionIssue[],
    severity: DecisionIssue['severity']
  ): void {
    const rawCode = code(record.specimen_code)
    const rawName = text(record.specimen_type)
    const byCode = rawCode
      ? this.db.prepare('SELECT * FROM master_samples WHERE code=? AND COALESCE(active,1)=1').get(rawCode) as DbRow | undefined
      : undefined
    const normalizedName = normalizeMasterText(rawName)
    let byName: DbRow | undefined
    if (normalizedName) {
      let alias = this.db.prepare(`SELECT s.* FROM master_sample_aliases a JOIN master_samples s ON s.code=a.sample_code
        WHERE a.normalized_alias=? AND COALESCE(a.active,1)=1 AND COALESCE(s.active,1)=1 LIMIT 1`).get(normalizedName) as DbRow | undefined
      if (!alias) {
        const aliases = this.db.prepare(`SELECT a.normalized_alias,a.alias_text,s.* FROM master_sample_aliases a
          JOIN master_samples s ON s.code=a.sample_code WHERE COALESCE(a.active,1)=1 AND COALESCE(s.active,1)=1`).all() as DbRow[]
        alias = aliases.find((item) => [item.normalized_alias, item.alias_text]
          .some((value) => normalizeMasterText(value) === normalizedName))
      }
      byName = alias ?? this.db.prepare(`SELECT * FROM master_samples WHERE COALESCE(active,1)=1 AND
        (LOWER(TRIM(code))=? OR LOWER(TRIM(name))=?) ORDER BY sort_order,code LIMIT 1`)
        .get(normalizedName, normalizedName) as DbRow | undefined
      if (!byName) {
        const candidates = this.db.prepare('SELECT * FROM master_samples WHERE COALESCE(active,1)=1 ORDER BY sort_order,code').all() as DbRow[]
        byName = candidates.find((item) => [item.code, item.name].some((value) => normalizeMasterText(value) === normalizedName))
      }
    }
    if (rawCode && !byCode) issues.push({ severity, field: 'specimen_code', message: `Unknown or inactive specimen code: ${rawCode}` })
    if (rawName && !byName) issues.push({ severity, field: 'specimen_type', message: `Unknown or inactive specimen master value: ${rawName}` })
    if (byCode && byName && code(byCode.code) !== code(byName.code)) {
      issues.push({ severity: 'error', field: 'specimen_code', message: 'Specimen name and specimen code refer to different active master records.' })
      return
    }
    const resolved = byCode ?? byName
    if (resolved) {
      record.specimen_type = text(resolved.name)
      record.specimen_code = code(resolved.code)
      record.specimen_system = text(resolved.system)
    }
  }

  private canonicalizeOrganism(
    record: Record<string, unknown>,
    issues: DecisionIssue[],
    severity: DecisionIssue['severity']
  ): void {
    const rawCode = code(record.organism_code)
    const rawName = text(record.organism)
    const byCode = rawCode
      ? this.db.prepare('SELECT * FROM master_organisms WHERE code=? AND COALESCE(active,1)=1').get(rawCode) as DbRow | undefined
      : undefined
    const normalizedName = normalizeMasterText(rawName)
    let byName: DbRow | undefined
    if (normalizedName) {
      const candidates = this.db.prepare('SELECT * FROM master_organisms WHERE COALESCE(active,1)=1 ORDER BY sort_order,code').all() as DbRow[]
      byName = candidates.find((item) => [item.code, item.organism_name, item.common_name]
        .some((value) => normalizeMasterText(value) === normalizedName))
    }
    if (rawCode && !byCode) issues.push({ severity, field: 'organism_code', message: `Unknown or inactive organism code: ${rawCode}` })
    if (rawName && !byName) issues.push({ severity, field: 'organism', message: `Unknown or inactive organism master value: ${rawName}` })
    if (byCode && byName && code(byCode.code) !== code(byName.code)) {
      issues.push({ severity: 'error', field: 'organism_code', message: 'Organism name and organism code refer to different active master records.' })
      return
    }
    const resolved = byCode ?? byName
    if (resolved) {
      record.organism = text(resolved.organism_name)
      record.organism_code = code(resolved.code)
      record.organism_system = text(resolved.system)
      record.genus_name = text(resolved.genus_name)
      record.family_name = text(resolved.family_name)
    }
  }

  private applyPanel(record: Record<string, unknown>, issues: DecisionIssue[]): void {
    const lab = code(record.lab_code)
    const selectedName = text(record.antibiotic_panel ?? record.panel_name)
    const panels = this.matchPanels({
      labCode: lab,
      organismCode: record.organism_code,
      organism: record.organism,
      specimenCode: record.specimen_code,
      specimenType: record.specimen_type,
      antibioticResults: record.antibiotic_results
    })
    const selected = selectedName
      ? panels.find((panel) => normalizeMasterText(panel.panel_name) === normalizeMasterText(selectedName))
      : panels[0]
    if (selectedName && !selected) {
      const configured = this.db.prepare(`SELECT id FROM lab_panels WHERE lab_code=? AND LOWER(TRIM(panel_name))=LOWER(TRIM(?))
        AND COALESCE(active,1)=1`).get(lab, selectedName)
      issues.push({ severity: 'error', field: 'antibiotic_panel', message: configured
        ? 'Selected panel does not match the canonical organism and specimen.'
        : 'Selected panel is not active for this laboratory.' })
      return
    }
    if (!selected) return
    record.antibiotic_panel = text(selected.panel_name)
    record.panel_name = text(selected.panel_name)
    record.antibiotic_panel_source_key = text(selected.source_row_key)
    const warnings = Array.isArray(selected.testing_warnings) ? selected.testing_warnings.map(text) : []
    for (const message of warnings) {
      issues.push({
        severity: selected.no_routine_ast ? 'error' : 'warning',
        field: 'antibiotic_results',
        message
      })
    }
    const antibiotics = Array.isArray(selected.antibiotics) ? selected.antibiotics as unknown[] : []
    if (selected.no_routine_ast && antibiotics.length === 0) {
      record.ast_method = 'Not performed'
      record.ast_not_performed_reason = text(record.ast_not_performed_reason) ||
        'Routine therapeutic AST not recommended by the configured guidance-only panel.'
    }
  }

  matchPanels(context: Record<string, unknown>): Row[] {
    const lab = code(context.labCode ?? context.lab_code)
    if (!lab) return []
    const sample = this.canonicalContextSample(context)
    const organism = this.canonicalContextOrganism(context)
    const panels = this.db.prepare(`SELECT * FROM lab_panels WHERE lab_code=? AND COALESCE(active,1)=1
      ORDER BY priority,panel_name,id`).all(lab) as DbRow[]
    const hydrated = panels.map((panel) => this.hydratePanel(panel))
    const candidates = hydrated.filter((panel) => {
      const source = panel as Record<string, unknown>
      const organisms = source.organisms as Array<Record<string, unknown>>
      const specimens = source.specimens as Array<Record<string, unknown>>
      const organismMatches = organism.code
        ? organisms.some((item) => code(item.code) === organism.code)
        : Boolean(organism.name && organisms.some((item) => normalizeMasterText(item.name) === organism.name))
      if (!organismMatches) return false
      if (specimens.length === 0) return true
      return sample.code
        ? specimens.some((item) => code(item.code) === sample.code)
        : Boolean(sample.name && specimens.some((item) => normalizeMasterText(item.name) === sample.name))
    })
    return candidates
      .sort((left, right) => Number(left.priority ?? 100) - Number(right.priority ?? 100) ||
        text(left.panel_name).localeCompare(text(right.panel_name)) || Number(left.id) - Number(right.id))
      .map((panel) => enrichPanelGuidance(panel, context.antibioticResults ?? context.antibiotic_results))
  }

  private canonicalContextSample(context: Record<string, unknown>): { code: string; name: string } {
    const suppliedCode = code(context.specimenCode ?? context.specimen_code)
    if (suppliedCode) {
      const row = this.db.prepare('SELECT code,name FROM master_samples WHERE code=? AND COALESCE(active,1)=1').get(suppliedCode) as DbRow | undefined
      return { code: row ? code(row.code) : suppliedCode, name: row ? normalizeMasterText(row.name) : '' }
    }
    const suppliedName = normalizeMasterText(context.specimenType ?? context.specimen_type)
    if (!suppliedName) return { code: '', name: '' }
    let alias = this.db.prepare(`SELECT s.code,s.name FROM master_sample_aliases a JOIN master_samples s ON s.code=a.sample_code
      WHERE a.normalized_alias=? AND COALESCE(a.active,1)=1 AND COALESCE(s.active,1)=1 LIMIT 1`).get(suppliedName) as DbRow | undefined
    if (!alias) {
      const aliases = this.db.prepare(`SELECT a.normalized_alias,a.alias_text,s.code,s.name FROM master_sample_aliases a
        JOIN master_samples s ON s.code=a.sample_code WHERE COALESCE(a.active,1)=1 AND COALESCE(s.active,1)=1`).all() as DbRow[]
      alias = aliases.find((item) => [item.normalized_alias, item.alias_text]
        .some((value) => normalizeMasterText(value) === suppliedName))
    }
    if (alias) return { code: code(alias.code), name: normalizeMasterText(alias.name) }
    const rows = this.db.prepare('SELECT code,name FROM master_samples WHERE COALESCE(active,1)=1').all() as DbRow[]
    const row = rows.find((item) => [item.code, item.name].some((value) => normalizeMasterText(value) === suppliedName))
    return { code: row ? code(row.code) : '', name: row ? normalizeMasterText(row.name) : suppliedName }
  }

  private canonicalContextOrganism(context: Record<string, unknown>): { code: string; name: string } {
    const suppliedCode = code(context.organismCode ?? context.organism_code)
    if (suppliedCode) {
      const row = this.db.prepare('SELECT code,organism_name FROM master_organisms WHERE code=? AND COALESCE(active,1)=1').get(suppliedCode) as DbRow | undefined
      return { code: row ? code(row.code) : suppliedCode, name: row ? normalizeMasterText(row.organism_name) : '' }
    }
    const suppliedName = normalizeMasterText(context.organism ?? context.organismName)
    if (!suppliedName) return { code: '', name: '' }
    const rows = this.db.prepare('SELECT code,organism_name,common_name FROM master_organisms WHERE COALESCE(active,1)=1').all() as DbRow[]
    const row = rows.find((item) => [item.code, item.organism_name, item.common_name]
      .some((value) => normalizeMasterText(value) === suppliedName))
    return { code: row ? code(row.code) : '', name: row ? normalizeMasterText(row.organism_name) : suppliedName }
  }

  private hydratePanel(panel: DbRow): Row {
    const id = Number(panel.id)
    const organisms = this.db.prepare(`SELECT organism_code AS code,organism_name AS name FROM lab_panel_organisms
      WHERE panel_id=? ORDER BY organism_name,organism_code`).all(id) as DbRow[]
    const specimens = this.db.prepare(`SELECT specimen_code AS code,specimen_name AS name,specimen_system AS system
      FROM lab_panel_specimens WHERE panel_id=? ORDER BY specimen_name,specimen_code`).all(id) as DbRow[]
    const antibiotics = this.db.prepare(`SELECT antibiotic_code AS code,antibiotic_name AS name,sort_order,option_group,
      requirement_type,notes,source_text FROM lab_panel_antibiotics WHERE panel_id=? ORDER BY sort_order,antibiotic_name`).all(id) as DbRow[]
    const genomicMarkers = this.db.prepare(`SELECT marker_code AS code,marker_name AS name,sort_order,
      requirement_type,method,notes FROM lab_panel_genomic_markers WHERE panel_id=? ORDER BY sort_order,marker_name`).all(id) as DbRow[]
    let guidance: unknown = []
    try { guidance = JSON.parse(text(panel.guidance_json) || '[]') } catch { guidance = [] }
    return { ...panel, active: Boolean(panel.active), no_routine_ast: Boolean(panel.no_routine_ast), organisms, specimens, antibiotics, genomic_markers: genomicMarkers, guidance } as unknown as Row
  }

  private interpretAst(record: Record<string, unknown>, issues: DecisionIssue[]): void {
    const lab = this.db.prepare('SELECT * FROM laboratory WHERE code=?').get(code(record.lab_code)) as DbRow | undefined
    if (!lab || !lab.use_dynamic_breakpoints) return
    const organism = code(record.organism_code)
    if (!organism) return
    // A guideline writes most of its rows against a group, not a species, so the isolate is
    // resolved to every scope it belongs to before any row is looked at. Without this an
    // imported EUCAST set matches nothing an ordinary laboratory ever enters.
    const taxon = this.db.prepare('SELECT code,organism_name,genus_name,family_name,order_name FROM master_organisms WHERE UPPER(TRIM(code))=?')
      .get(organism) as OrganismTaxon | undefined
    const scopeCodes = taxon ? organismScopeCodesFor(taxon).map(code) : []
    const organismCodes = [...new Set([organism, ...scopeCodes])]
    const organismPlaceholders = organismCodes.map(() => '?').join(',')
    const results = astMap(record.antibiotic_results)
    for (const [antibioticCode, payload] of Object.entries(results)) {
      // Explicit interpretations, including historical snapshots, are never re-rendered.
      if (text(payload.result)) continue
      if (!text(payload.measurement)) continue
      const measurement = numericMeasurement(payload.measurement)
      if (measurement === null) {
        issues.push({ severity: 'warning', field: `${antibioticCode}.measurement`, message: 'Measurement is not numeric; no breakpoint interpretation was applied.' })
        continue
      }
      const method = normalizeMethod(payload.method || record.ast_method || lab.default_test_method)
      if (!method) {
        issues.push({ severity: 'warning', field: `${antibioticCode}.method`, message: 'A recognized MIC or disk-diffusion method is required for interpretation.' })
        continue
      }
      const site = comparableText(record.site_of_infection ?? record.infection_site)
      const potency = comparableText(payload.potency)
      const activeSet = this.db.prepare('SELECT id FROM master_breakpoint_sets WHERE active=1 ORDER BY id LIMIT 1').get()
      let rows: BreakpointCandidate[]
      if (activeSet) {
        rows = this.db.prepare(`SELECT b.*,s.name AS set_name,s.organization AS set_organization,
          s.edition AS set_edition,s.source_url AS set_source_url FROM whonet_user_breakpoints b
          JOIN master_breakpoint_sets s ON s.id=b.source_set_id
          WHERE s.active=1 AND b.active=1 AND UPPER(TRIM(b.organism_code)) IN (${organismPlaceholders})
            AND UPPER(TRIM(b.whonet_abx_code))=? ORDER BY b.id`)
          .all(...organismCodes, antibioticCode) as unknown as BreakpointCandidate[]
      } else {
        const preferredGuideline = normalizeMasterText(lab.default_guideline)
        const preferredTypes = new Set(parseJsonArray(lab.breakpoint_types).map(normalizeMasterText))
        rows = (this.db.prepare(`SELECT b.*,
          'Bundled WHONET breakpoint catalogue' AS set_name,
          COALESCE(NULLIF(b.guidelines,''),'WHONET') AS set_organization,
          b.year AS set_edition,'' AS set_source_url
          FROM whonet_breakpoints b WHERE COALESCE(b.active,1)=1
            AND UPPER(TRIM(b.organism_code))=? AND UPPER(TRIM(b.whonet_abx_code))=?
          ORDER BY b.id`).all(organism, antibioticCode) as unknown as BreakpointCandidate[]).filter((row) => {
          if (preferredGuideline && normalizeMasterText(row.guidelines) !== preferredGuideline) return false
          return !preferredTypes.size || !text(row.breakpoint_type) || preferredTypes.has(normalizeMasterText(row.breakpoint_type))
        })
      }
      const matches = rows.filter((row) => {
        if (normalizeMethod(row.test_method) !== method) return false
        const breakpointSite = comparableText(row.site_of_infection)
        const breakpointPotency = comparableText(row.potency)
        if (breakpointSite && breakpointSite !== site) return false
        if (breakpointPotency && breakpointPotency !== potency) return false
        return true
      })
      if (!matches.length) {
        issues.push({ severity: 'warning', field: `${antibioticCode}.result`, message: 'No exact row in the explicitly active breakpoint set matched organism, antimicrobial, method, site and potency; interpretation was left blank.' })
        continue
      }
      // A row written for this species beats one written for a group it belongs to: EUCAST
      // publishes both ("Meropenem" for Enterobacterales, "Meropenem, Morganellaceae") and
      // the species row is the one that means this organism.
      const speciesRows = matches.filter((row) => code(row.organism_code) === organism)
      const scoped = speciesRows.length ? speciesRows : matches
      const maxSpecificity = Math.max(...scoped.map((row) => Number(Boolean(text(row.site_of_infection))) + Number(Boolean(text(row.potency)))))
      const specific = scoped.filter((row) => Number(Boolean(text(row.site_of_infection))) + Number(Boolean(text(row.potency))) === maxSpecificity)
      // Route is not recorded against an isolate, so a route-free row is preferred and
      // route-specific rows are only left to compete when there is no other row at all.
      const routeFree = specific.filter((row) => !text(row.route))
      const mostSpecific = routeFree.length ? routeFree : specific
      if (new Set(mostSpecific.map(thresholdsKey)).size > 1) {
        const routes = [...new Set(mostSpecific.map((row) => text(row.route)).filter(Boolean))]
        issues.push({
          severity: 'warning', field: `${antibioticCode}.result`,
          message: routes.length
            ? `The active breakpoint set holds different thresholds per route of administration (${routes.join(', ')}), which this record does not state; interpretation was left blank.`
            : 'Conflicting equally specific rows exist in the active breakpoint set; interpretation was left blank.'
        })
        continue
      }
      const breakpoint = mostSpecific[0]
      if (!breakpoint) continue
      const interpretation = interpretMeasurement(measurement, method, breakpoint)
      if (!interpretation) {
        issues.push({ severity: 'warning', field: `${antibioticCode}.result`, message: 'The matched breakpoint row lacks a complete, internally consistent threshold for this measurement; interpretation was left blank.' })
        continue
      }
      const guideline = [text(breakpoint.guidelines), text(breakpoint.year || breakpoint.set_edition)].filter(Boolean).join(' ')
      const sourceParts = [
        `Active breakpoint set "${text(breakpoint.set_name)}"`,
        text(breakpoint.set_organization), text(breakpoint.set_edition),
        `breakpoint row ${Number(breakpoint.id)}`,
        code(breakpoint.organism_code_type) === 'GROUP' ? `organism scope ${text(breakpoint.organism_code)}` : '',
        text(breakpoint.set_source_url)
      ].filter(Boolean)
      // Intrinsic resistance decides the category, it does not merely comment on it.
      //
      // An organism intrinsically resistant to an agent is resistant whatever the plate says:
      // Klebsiella pneumoniae is ampicillin-resistant, and a low MIC against it means the test
      // is uninformative, not that the drug works. WHONET's engine reports `R*` for exactly
      // these pairs. AMRIT held the same catalogue — 1,024 expected-resistance rows, K.
      // pneumoniae against ampicillin among them — and consulted it only in `evaluateSupport`,
      // which raises an alert, runs solely on final records, and never touched the category. So
      // a draft record, an import preview and an aggregate all carried "susceptible" for a
      // combination no laboratory should ever report as susceptible. Study A found this by
      // measuring against WHONET rather than by any test here.
      const intrinsic = this.intrinsicResistance(organism, antibioticCode, lab)
      results[antibioticCode] = {
        ...payload,
        result: intrinsic ? 'R' : interpretation,
        method: method === 'MIC' ? 'MIC' : 'Disk diffusion',
        guideline,
        potency: text(breakpoint.potency) || text(payload.potency),
        source: intrinsic
          // The measured category is kept in the provenance rather than discarded, because the
          // gap between it and the reported R is the signal that identification or the panel
          // needs review, and it is what the expected-resistance alert is raised from.
          ? `${sourceParts.join('; ')}; intrinsic resistance applied (${intrinsic}); `
            + `measured category ${interpretation}`
          : sourceParts.join('; ')
      }
    }
    record.antibiotic_results = results
  }

  /**
   * The expected-resistance definition that makes this organism-antimicrobial pair resistant
   * by nature, or null.
   *
   * Exceptions are honoured in both directions, matching `evaluateSupport`: a row can name an
   * organism it does not apply to and a list of antimicrobials it does not cover, and either
   * exempts the pair. Off unless the laboratory has enabled intrinsic-resistance rules, because
   * a deployment that has deliberately turned them off must not have them applied silently.
   */
  private intrinsicResistance(
    organismCode: string, antibioticCode: string, lab: DbRow | undefined
  ): string | null {
    if (!lab || !lab.use_intrinsic_resistance_rules) return null
    if (!organismCode || !antibioticCode) return null
    const rows = this.db.prepare(`SELECT * FROM whonet_expected_resistance
      WHERE COALESCE(active,1)=1 AND UPPER(TRIM(organism_code))=? AND UPPER(TRIM(abx_code))=?
      ORDER BY id`).all(organismCode, antibioticCode) as DbRow[]
    for (const row of rows) {
      if (code(row.exception_organism_code) === organismCode) continue
      if (parseJsonArray(row.antibiotic_exceptions).map(code).includes(antibioticCode)) continue
      return text(row.reference_table) || text(row.guideline) || 'expected-resistance definition'
    }
    return null
  }

  private validateRequired(record: Record<string, unknown>, issues: DecisionIssue[]): void {
    if (record.record_status !== 'final') return
    const required: Array<[string, string]> = [
      ['patient_id', 'Patient ID is required for a final record.'],
      ['specimen_date', 'Specimen date is required for a final record.'],
      ['specimen_type', 'Specimen type is required for a final record.'],
      ['organism', 'Organism is required for a final record.']
    ]
    for (const [field, message] of required) {
      if (!text(record[field])) issues.push({ severity: 'error', field, message })
    }
    // A genotype-only workflow is legitimate — a cartridge NAAT or sequencing result can be the
    // only susceptibility evidence for an isolate — so a reported marker satisfies this rule too.
    const genomic = record.genomic_results
    const reportedMarker = Boolean(genomic && typeof genomic === 'object' && !Array.isArray(genomic) &&
      Object.values(genomic as Record<string, unknown>).some((entry) =>
        Boolean(entry) && typeof entry === 'object' && text((entry as Record<string, unknown>).result)))
    if (!populatedAst(astMap(record.antibiotic_results)) && !reportedMarker && !text(record.ast_not_performed_reason)) {
      issues.push({
        severity: 'error',
        field: 'antibiotic_results',
        message: 'A final record requires at least one AST result/measurement, a reported genotypic marker, or an explicit AST-not-performed reason.'
      })
    }
  }

  private evaluateSupport(record: IsolateRecord): { alerts: Row[]; comments: string[] } {
    const source = record as Record<string, unknown>
    const labCode = code(source.lab_code)
    const organismCode = code(source.organism_code)
    const organismName = normalizeMasterText(source.organism)
    const results = astMap(source.antibiotic_results)
    const alerts: Row[] = []
    const comments: string[] = []
    const alert = (
      ruleKey: string,
      ruleName: string,
      message: string,
      priority = 'medium',
      alertType = 'other',
      category = 'microbiological'
    ): void => {
      alerts.push({ rule_key: ruleKey, rule_name: ruleName, category, alert_type: alertType, priority, message })
    }

    const enabledAlerts = new Set((this.db.prepare('SELECT alert_key FROM lab_alerts WHERE lab_code=? ORDER BY alert_key').all(labCode) as DbRow[])
      .map((row) => text(row.alert_key)))
    const resultFor = (antibioticCode: string): string => code(results[antibioticCode]?.result)
    if (enabledAlerts.has('missing_origin') && infectionOrigin(source) === 'Unknown') {
      alert('missing_origin', 'Infection origin unavailable',
        'Infection origin could not be determined from location type and admission date.',
        'medium', 'data_quality', 'quality_assurance')
    }
    if (enabledAlerts.has('repeat_isolate') && text(source.patient_id) && text(source.organism)) {
      const prior = this.db.prepare(`SELECT id FROM isolates WHERE lab_code=? AND
        LOWER(TRIM(COALESCE(patient_id,'')))=LOWER(TRIM(?)) AND
        LOWER(TRIM(COALESCE(organism,'')))=LOWER(TRIM(?)) AND COALESCE(record_status,'final')<>'draft'
        AND (? IS NULL OR id<>?) ORDER BY id LIMIT 1`).get(
        labCode, text(source.patient_id), text(source.organism), source.id ? Number(source.id) : null, source.id ? Number(source.id) : null
      )
      if (prior) alert('repeat_isolate', 'Repeat isolate',
        `Repeat isolate detected for patient ${text(source.patient_id)} and organism ${text(source.organism)}.`,
        'low', 'repeat_isolate')
    }
    if (enabledAlerts.has('important_species') && IMPORTANT_SPECIES.some((item) => organismName.includes(item))) {
      alert('important_species', 'Important species',
        `Important species detected: ${text(source.organism)}. Review surveillance and public health follow-up requirements.`,
        'high', 'important_species')
    }
    if (enabledAlerts.has('quality_control') && normalizeMasterText(source.specimen_type) === 'quality control') {
      alert('quality_control', 'Quality control isolate', 'Quality control isolate detected.',
        'low', 'quality_control', 'quality_assurance')
    }
    if (enabledAlerts.has('invalid_data')) {
      const specimen = supportDate(source.specimen_date)
      const admission = supportDate(source.admission_date)
      const reception = supportDate(source.reception_date)
      const testDate = supportDate(source.dd_test_date)
      const chronology: Array<[Date | null, string]> = [
        [admission && specimen && admission > specimen ? admission : null, 'Admission date occurs after the specimen date. Review the record chronology.'],
        [reception && specimen && reception < specimen ? reception : null, 'Reception date occurs before the specimen date. Review the record chronology.'],
        [testDate && specimen && testDate < specimen ? testDate : null, 'DD test date occurs before the specimen date. Review the record chronology.']
      ]
      for (const [invalid, message] of chronology) {
        if (invalid) alert('invalid_data', 'Invalid surveillance chronology', message,
          'high', 'data_quality', 'quality_assurance')
      }
    }
    if (enabledAlerts.has('mrsa') && organismName.includes('staphylococcus aureus') && resultFor('FOX') === 'R') {
      alert('mrsa', 'Possible MRSA', 'Possible MRSA: cefoxitin result is resistant.', 'high', 'infection_control', 'clinical')
    }
    if (enabledAlerts.has('pneumo_penicillin') && organismName.includes('streptococcus pneumoniae') && ['R', 'I'].includes(resultFor('PEN'))) {
      alert('pneumo_penicillin', 'Penicillin non-susceptible pneumococcus', 'Possible penicillin non-susceptible Streptococcus pneumoniae detected.', 'high', 'important_resistance')
    }
    if (enabledAlerts.has('carbapenem') && ['IPM', 'MEM', 'ETP'].some((item) => ['R', 'I'].includes(resultFor(item)))) {
      alert('carbapenem', 'Carbapenem non-susceptibility', 'Possible carbapenem non-susceptible isolate detected. Review confirmation and referral requirements.', 'high', 'important_resistance')
    }
    if (enabledAlerts.has('vancomycin') && ['R', 'I'].includes(resultFor('VAN'))) {
      alert('vancomycin', 'Vancomycin non-susceptibility', 'Possible vancomycin-resistant isolate detected.', 'high', 'infection_control', 'clinical')
    }
    if (enabledAlerts.has('low_frequency')) {
      const history = (this.db.prepare(`SELECT id,antibiotic_results FROM isolates WHERE lab_code=? AND
        LOWER(TRIM(COALESCE(organism,'')))=LOWER(TRIM(?)) AND COALESCE(record_status,'final')<>'draft'`)
        .all(labCode, text(source.organism)) as DbRow[]).filter((row) => !source.id || Number(row.id) !== Number(source.id))
      if (history.length >= 20) {
        for (const [antibioticCode, payload] of Object.entries(results)) {
          const currentResult = code(payload.result)
          if (!['R', 'I', 'S'].includes(currentResult)) continue
          let tested = 0; let resistant = 0; let susceptible = 0
          for (const row of history) {
            const prior = code(astMap(row.antibiotic_results)[antibioticCode]?.result)
            if (!['R', 'I', 'S'].includes(prior)) continue
            tested += 1
            if (prior === 'R') resistant += 1
            if (prior === 'S') susceptible += 1
          }
          if (tested >= 20 && currentResult === 'R' && resistant / tested < 0.05) {
            alert('low_frequency', 'Low-frequency result',
              `Low-frequency alert (*): ${text(source.organism)} resistant to ${antibioticCode} is uncommon in this laboratory's historical data.`,
              'medium', 'statistical', 'quality_assurance')
          }
          if (tested >= 20 && currentResult === 'S' && susceptible / tested < 0.05) {
            alert('low_frequency', 'Low-frequency result',
              `Low-frequency alert (#): ${text(source.organism)} susceptible to ${antibioticCode} is uncommon in this laboratory's historical data.`,
              'medium', 'statistical', 'quality_assurance')
          }
          if (tested > 0 && tested / history.length < 0.05) {
            alert('low_frequency', 'Low-frequency test',
              `Low-frequency alert (+): ${antibioticCode} is not frequently tested for ${text(source.organism)} in this laboratory's historical data.`,
              'medium', 'statistical', 'quality_assurance')
          }
        }
      }
    }

    const customRules = this.db.prepare(`SELECT * FROM lab_custom_alerts WHERE lab_code=? AND COALESCE(active,1)=1
      ORDER BY sort_order,id`).all(labCode) as DbRow[]
    for (const rule of customRules) {
      const ruleCode = code(rule.organism_code)
      const organismMatches = ruleCode && organismCode
        ? ruleCode === organismCode
        : normalizeMasterText(rule.organism_name) === organismName
      if (!organismMatches) continue
      const antibioticCode = code(rule.antibiotic_code)
      const triggers = new Set(text(rule.trigger_results || 'R').toUpperCase().split(/[^RIS]+/).filter(Boolean).flatMap((item) => item.length > 1 ? [...item] : item))
      const result = resultFor(antibioticCode)
      if (!result || !triggers.has(result)) continue
      const name = text(rule.rule_name) || 'Custom alert'
      const message = text(rule.message) || `${text(source.organism)} matched local alert rule '${name}' for ${antibioticCode} with result ${result}.`
      alert(`custom:${Number(rule.id) || normalizeMasterText(name)}`, name, message, text(rule.priority) || 'medium',
        text(rule.alert_type) || 'important_resistance', text(rule.category) || 'microbiological')
    }

    const lab = this.db.prepare('SELECT * FROM laboratory WHERE code=?').get(labCode) as DbRow | undefined
    if (lab && Boolean(lab.use_intrinsic_resistance_rules)) {
      for (const [antibioticCode, payload] of Object.entries(results)) {
        if (!text(payload.result)) continue
        const rows = this.db.prepare(`SELECT * FROM whonet_expected_resistance WHERE COALESCE(active,1)=1
          AND UPPER(TRIM(organism_code))=? AND UPPER(TRIM(abx_code))=? ORDER BY id`).all(organismCode, antibioticCode) as DbRow[]
        for (const row of rows) {
          if (code(row.exception_organism_code) === organismCode) continue
          if (parseJsonArray(row.antibiotic_exceptions).map(code).includes(antibioticCode)) continue
          const descriptor = text(row.comments) || text(row.reference_table) || 'configured expected-resistance definition'
          comments.push(`Expected resistance: ${text(source.organism)} / ${antibioticCode} matches ${descriptor} (${text(row.guideline) || 'configured guideline'}).`)
          if (code(payload.result) !== 'R') {
            alert(`expected-resistance:${Number(row.id)}`, 'Expected resistance discrepancy',
              `${text(source.organism)} is configured as expected resistant to ${antibioticCode}, but the recorded interpretation is ${code(payload.result)}. Review identification and AST.`,
              'high', 'important_resistance')
          }
        }
      }
    }

    const enabledRules = new Set(parseJsonArray(lab?.enabled_expert_rules).map((item) => normalizeMasterText(item)))
    const expertRules = this.db.prepare(`SELECT * FROM whonet_expert_rules WHERE COALESCE(active,1)=1
      ORDER BY rule_code,id`).all() as DbRow[]
    const groupCodes = new Set([
      organismCode,
      ...parseJsonArray(source.organism_group_codes).map(code),
      code(source.genus_code), code(source.family_code), code(source.serovar_group)
    ].filter(Boolean))
    for (const rule of expertRules) {
      const enabled = Boolean(rule.enabled_by_default) || enabledRules.has('all') || enabledRules.has('interpretation alerts') ||
        enabledRules.has(normalizeMasterText(rule.rule_code)) || enabledRules.has(normalizeMasterText(rule.description))
      if (!enabled) continue
      const expectedOrganism = code(rule.organism_code)
      if (expectedOrganism && !groupCodes.has(expectedOrganism)) continue
      if (!ruleCriteriaMatch(record, rule.rule_criteria)) continue
      const ruleCode = text(rule.rule_code) || `RULE-${Number(rule.id)}`
      const description = text(rule.description) || `Configured expert rule ${ruleCode}`
      const affected = text(rule.affected_antibiotics)
      const exception = text(rule.antibiotic_exceptions)
      comments.push([`${ruleCode}: ${description}`, affected ? `Affected: ${affected}` : '', exception ? `Exceptions: ${exception}` : ''].filter(Boolean).join('. '))
      alert(`expert:${Number(rule.id)}`, ruleCode, description, 'high', 'expert_rule')
    }

    if (organismName.includes('staphylococcus aureus') && ['R', 'I'].includes(resultFor('FOX'))) {
      comments.push('MRSA phenotype suspected. Consider reporting beta-lactam activity with caution and review local infection-control guidance.')
    }
    if (organismName.includes('staphylococcus aureus') && resultFor('ERY') === 'R' && ['S', 'I'].includes(resultFor('CLI'))) {
      comments.push('Erythromycin-resistant but clindamycin-susceptible pattern may indicate inducible clindamycin resistance; consider a D-test before routine reporting.')
    }
    if (ENTEROBACTERALES.some((item) => organismName.includes(item)) && ['CTX', 'CRO', 'CAZ', 'ATM'].some((item) => ['R', 'I'].includes(resultFor(item)))) {
      comments.push('Third-generation cephalosporin or aztreonam non-susceptibility in Enterobacterales may indicate ESBL or AmpC production. Review confirmatory testing rules.')
    }
    if (GRAM_NEGATIVE.some((item) => organismName.includes(item)) && ['IPM', 'MEM', 'ETP'].some((item) => ['R', 'I'].includes(resultFor(item)))) {
      comments.push('Carbapenem non-susceptibility may indicate carbapenemase or other major resistance mechanisms. Consider confirmatory testing or referral.')
    }
    if (organismName.includes('enterococcus') && ['R', 'I'].includes(resultFor('VAN'))) {
      comments.push('Vancomycin non-susceptible Enterococcus requires urgent review because VRE has important treatment and infection-control implications.')
    }
    if (organismName.includes('salmonella') && ['R', 'I'].includes(resultFor('CIP'))) {
      comments.push('Fluoroquinolone non-susceptibility in Salmonella may affect empiric and definitive treatment choices. Review national guidance.')
    }
    if (organismName.includes('streptococcus pneumoniae') && ['R', 'I'].includes(resultFor('PEN'))) {
      comments.push('Penicillin non-susceptible pneumococcus should be interpreted with organism-specific breakpoint context and infection site in mind.')
    }

    const uniqueAlerts = [...new Map(alerts.map((item) => [`${String(item.rule_key)}|${String(item.message)}`, item])).values()]
    return { alerts: uniqueAlerts, comments: [...new Set(comments)] }
  }
}
