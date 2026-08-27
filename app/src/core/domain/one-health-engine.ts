import type { CountryProfile, Row, Scalar } from '../../shared/types'
import { activeProfile } from './active-profile'

export type OneHealthFieldKind = 'text' | 'number' | 'boolean' | 'datetime' | 'choice'

export interface OneHealthField {
  key: string
  label: string
  kind: OneHealthFieldKind
  required: boolean
  choices?: string[]
  helpText?: string
}

export interface OneHealthModule {
  key: string
  title: string
  domain: 'HUMAN' | 'ANIMAL' | 'ENVIRONMENT'
  eventType: string
  purpose: 'surveillance' | 'stewardship' | 'direct-care' | 'regulatory'
  description: string
  fields: OneHealthField[]
}

export interface OneHealthAlert {
  rule_code: string
  severity: 'medium' | 'high' | 'critical'
  message: string
  ruleset_version: string
}

const field = (
  key: string,
  label: string,
  kind: OneHealthFieldKind = 'text',
  required = false,
  choices?: string[],
  helpText?: string
): OneHealthField => ({ key, label, kind, required, ...(choices ? { choices } : {}), ...(helpText ? { helpText } : {}) })

/**
 * Administrative fields for a country's hierarchy, in level order.
 *
 * Every level uses `admin<N>_code`. Levels 1 and 2 used to be called `state_code` and
 * `district_code`, which put one country's hierarchy into the field names themselves and
 * left a country with three sub-national levels unable to name its third. Labels and the
 * code system still come from the profile, so India reads "State / UT (LGD)" and another
 * country reads its own terms — but only the label varies, never the key.
 *
 * These fields stay optional regardless of the profile. `admin_levels[].required` says a
 * laboratory must be placed at that level; it does not say every One Health event carries
 * it, and many are national or aggregate.
 */
export const ADMIN_FIELD_KEY = (level: number): string => `admin${level}_code`

/**
 * Canonical event envelope this build produces. 2.0 dropped `state_code`/`district_code`
 * in favour of a numbered administrative chain; 1.0 and 1.1 are withdrawn.
 */
export const ONE_HEALTH_SCHEMA_VERSION = '2.0'

export const adminFieldsForProfile = (profile: CountryProfile): OneHealthField[] =>
  [...profile.admin_levels]
    .sort((left, right) => left.level - right.level)
    .map((definition) => field(ADMIN_FIELD_KEY(definition.level), `${definition.label} (${definition.code_system})`))

const common = (): OneHealthField[] => [
  field('facility_id', 'Facility / site ID', 'text', true),
  ...adminFieldsForProfile(activeProfile()),
  field('observed_at', 'Observation date/time', 'datetime', true)
]

const buildModules = (): Record<string, OneHealthModule> => ({
  human_quality: {
    key: 'human_quality', title: 'Human laboratory quality', domain: 'HUMAN', eventType: 'human-lab-quality', purpose: 'surveillance',
    description: 'Laboratory contamination, turnaround, rejection, missingness, QC, EQA and downtime indicators.',
    fields: [...common(), field('indicator', 'Indicator', 'choice', true, ['contamination', 'turnaround', 'rejection', 'missingness', 'qc', 'eqa', 'instrument-downtime']),
      field('numerator', 'Numerator', 'number', true), field('denominator', 'Denominator', 'number', true), field('target', 'Target', 'number'),
      field('corrective_action', 'Corrective action')]
  },
  amc: {
    key: 'amc', title: 'Antimicrobial consumption', domain: 'HUMAN', eventType: 'human-amc', purpose: 'stewardship',
    description: 'Antimicrobial quantities, WHO DDD denominators and AWaRe consumption measures.',
    fields: [...common(), field('antimicrobial', 'Antimicrobial', 'text', true), field('atc_code', 'ATC code', 'text', true),
      field('aware_group', 'AWaRe', 'choice', true, ['Access', 'Watch', 'Reserve', 'Not recommended']),
      field('quantity_grams', 'Quantity (g)', 'number', true), field('who_ddd_grams', 'WHO DDD (g)', 'number', true),
      field('bed_days', 'Bed-days', 'number'), field('patient_days', 'Patient-days', 'number'), field('population', 'Population', 'number'),
      field('source', 'Feed/source', 'text', true)]
  },
  stewardship: {
    key: 'stewardship', title: 'Facility stewardship', domain: 'HUMAN', eventType: 'stewardship-review', purpose: 'direct-care',
    description: 'Locally authorised antimicrobial review, indication, culture, time-out and IV-to-oral documentation.',
    fields: [...common(), field('encounter_ref', 'Local encounter reference', 'text', true), field('antimicrobial', 'Antimicrobial', 'text', true),
      field('aware_group', 'AWaRe', 'choice', true, ['Access', 'Watch', 'Reserve', 'Not recommended']), field('indication', 'Indication', 'text', true),
      field('therapy', 'Therapy', 'choice', true, ['empirical', 'targeted', 'prophylaxis']), field('culture_before_antibiotic', 'Culture before antibiotic', 'boolean'),
      field('review_due_at', 'Review/stop date', 'datetime'), field('iv_to_oral_eligible', 'IV-to-oral eligible', 'boolean'),
      field('dot', 'Days of therapy', 'number'), field('lot', 'Length of therapy', 'number'), field('reserve_authorisation', 'Reserve authorisation')]
  },
  ipc_hai: {
    key: 'ipc_hai', title: 'IPC and HAI surveillance', domain: 'HUMAN', eventType: 'ipc-hai', purpose: 'surveillance',
    description: 'Healthcare-associated infection rates, denominator-days, audits, outbreaks and corrective actions.',
    fields: [...common(), field('hai_type', 'HAI type', 'choice', true, ['CLABSI', 'CAUTI', 'VAP', 'SSI', 'other']),
      field('case_count', 'Cases', 'number', true), field('denominator_type', 'Denominator', 'choice', true, ['central-line-days', 'urinary-catheter-days', 'ventilator-days', 'procedures', 'patient-days']),
      field('denominator', 'Denominator value', 'number', true), field('ward', 'Ward/unit'), field('case_definition_version', 'Definition/version', 'text', true),
      field('outbreak_ref', 'Outbreak/cluster reference'), field('audit_type', 'IPC audit', 'choice', false, ['hand-hygiene', 'cleaning', 'self-assessment', 'none']),
      field('audit_score', 'Audit score (%)', 'number'), field('action', 'Action / intervention')]
  },
  veterinary: {
    key: 'veterinary', title: 'Veterinary and fisheries', domain: 'ANIMAL', eventType: 'animal-amu-amr', purpose: 'surveillance',
    description: 'Animal AMR and antimicrobial-use observations across clinical, farm, market, slaughter and aquaculture frames.',
    fields: [...common(), field('host_species', 'Host species', 'text', true), field('production_class', 'Age/production class', 'text', true),
      field('unit_ref', 'Herd/flock/pond surrogate ID', 'text', true), field('production_system', 'Production system'),
      field('sampling_frame', 'Sampling frame', 'choice', true, ['clinical', 'healthy-animal', 'farm', 'slaughter', 'market', 'aquaculture']),
      field('sample_type', 'Sample', 'text', true), field('organism', 'Organism'), field('ast_summary', 'AST summary'),
      field('active_ingredient', 'Active ingredient'), field('quantity_mg', 'Quantity active ingredient (mg)', 'number'),
      field('biomass_kg', 'Population biomass/PCU (kg)', 'number'), field('purpose', 'Treatment purpose'), field('route', 'Route'),
      field('dose', 'Dose'), field('duration_days', 'Duration (days)', 'number'), field('biosecurity_score', 'Biosecurity score', 'number'),
      field('withdrawal_compliant', 'Withdrawal compliant', 'boolean')]
  },
  food: {
    key: 'food', title: 'Food AMR and residues', domain: 'ANIMAL', eventType: 'food-amr-residue', purpose: 'regulatory',
    description: 'Food-chain AMR, residue results, chain of custody, maximum limits and enforcement closure.',
    fields: [...common(), field('sample_id', 'Sample / seal ID', 'text', true), field('commodity', 'Commodity', 'text', true),
      field('production_stage', 'Production stage', 'text', true), field('source_category', 'Establishment/source category', 'text', true),
      field('sampling_programme', 'Sampling programme', 'text', true), field('custody_status', 'Chain of custody', 'choice', true, ['collected', 'sealed', 'in-transit', 'received', 'tested', 'closed']),
      field('organism', 'Organism'), field('ast_summary', 'AST summary'), field('residue_analyte', 'Residue analyte'),
      field('result_value', 'Result', 'number'), field('result_unit', 'Unit'), field('maximum_limit', 'Maximum residue limit', 'number'),
      field('method', 'Method'), field('enforcement_action', 'Enforcement action'), field('closure_status', 'Closure status')]
  },
  environment: {
    key: 'environment', title: 'Environmental AMR', domain: 'ENVIRONMENT', eventType: 'environment-amr-residue', purpose: 'regulatory',
    description: 'Environmental AMR, residue, gene and action-status observations with privacy-aware geospatial precision.',
    fields: [...common(), field('site_ref', 'Site surrogate ID', 'text', true), field('site_type', 'Site type', 'text', true),
      field('matrix', 'Matrix', 'choice', true, ['influent', 'effluent', 'surface-water', 'groundwater', 'soil', 'sludge']),
      field('relation', 'Sampling relation', 'choice', false, ['upstream', 'downstream', 'onsite', 'not-applicable']),
      // Coarsening steps are named by how far the coordinate is blurred, not by an
      // administrative level: "district" means nothing in a country that has none, and the
      // area a district covers varies by orders of magnitude between countries anyway.
      field('geospatial_precision', 'Coordinate precision', 'choice', true, ['exact-restricted', '1-km', '10-km', '100-km', 'admin-unit-only']),
      field('protocol', 'Sampling protocol/version', 'text', true), field('flow_context', 'Flow/context'), field('residue_analyte', 'Antimicrobial residue'),
      field('concentration', 'Concentration', 'number'), field('concentration_unit', 'Unit'), field('organism', 'Organism'),
      field('ast_summary', 'AST summary'), field('resistance_genes', 'Resistance genes'), field('method', 'Method', 'text', true),
      field('detection_limit', 'Method detection limit', 'number'), field('action_status', 'Regulatory/action status')]
  },
  genomics: {
    key: 'genomics', title: 'Reference laboratory and genomics', domain: 'HUMAN', eventType: 'reference-genomics', purpose: 'surveillance',
    description: 'Reference-laboratory referral, sequencing, lineage, determinants and reviewed cluster summaries.',
    fields: [...common(), field('referral_id', 'Referral ID', 'text', true), field('source_sample_ref', 'Source sample reference', 'text', true),
      field('cold_chain_status', 'Packaging/cold-chain', 'text', true), field('received_at', 'Received at', 'datetime'),
      field('phenotypic_confirmation', 'Phenotypic confirmation'), field('sequence_run', 'Sequencing run'), field('quality_metrics', 'Quality metrics'),
      field('pipeline_version', 'Pipeline/version'), field('accession', 'Accession'), field('organism', 'Organism', 'text', true),
      field('lineage', 'Sequence type/lineage'), field('resistance_determinants', 'Resistance determinants'), field('mobile_elements', 'Plasmid/mobile elements'),
      field('cluster_id', 'Cluster ID'), field('distance_threshold', 'Distance threshold', 'number'),
      field('review_status', 'Epidemiologist review', 'choice', true, ['pending', 'confirmed', 'dismissed'])]
  }
})

export const ONE_HEALTH_MODULES: Record<string, OneHealthModule> = buildModules()

/**
 * Rebuild the module definitions in place after the active country profile changes.
 *
 * The object identity is preserved because callers hold a direct reference to it.
 * Only the administrative field labels differ between profiles; keys, validation and
 * every other field are identical.
 */
export function rebuildOneHealthModules(): void {
  for (const key of Object.keys(ONE_HEALTH_MODULES)) delete ONE_HEALTH_MODULES[key]
  Object.assign(ONE_HEALTH_MODULES, buildModules())
}

const valueText = (value: unknown): string => String(value ?? '').trim()
const numberValue = (value: unknown): number => {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}
const present = (value: unknown): boolean => value !== null && value !== undefined && valueText(value) !== ''
const truthy = (value: unknown): boolean => value === true || ['true', '1', 'yes', 'on'].includes(valueText(value).toLocaleLowerCase())
const safeRate = (numerator: number, denominator: number, multiplier = 1): number | null => denominator > 0 ? numerator / denominator * multiplier : null

export function oneHealthCatalog(): OneHealthModule[] {
  return Object.values(ONE_HEALTH_MODULES).map((module) => ({ ...module, fields: module.fields.map((item) => ({ ...item, ...(item.choices ? { choices: [...item.choices] } : {}) })) }))
}

export function validateOneHealth(
  moduleKey: string,
  values: Record<string, unknown>,
  configuredFields?: OneHealthField[]
): string[] {
  const module = ONE_HEALTH_MODULES[moduleKey]
  if (!module) return [`Unknown One Health module: ${moduleKey || '(empty)'}`]
  const errors: string[] = []
  for (const item of configuredFields ?? module.fields) {
    const value = values[item.key]
    if (item.required && !present(value)) {
      errors.push(`${item.label} is required`)
      continue
    }
    if (!present(value)) continue
    if (item.kind === 'number') {
      const parsed = Number(value)
      if (!Number.isFinite(parsed)) errors.push(`${item.label} must be numeric`)
      else if (parsed < 0) errors.push(`${item.label} cannot be negative`)
    }
    if (item.kind === 'datetime' && Number.isNaN(Date.parse(valueText(value)))) errors.push(`${item.label} must be an ISO date or date-time`)
    if (item.choices && !item.choices.includes(valueText(value))) errors.push(`${item.label} must be one of: ${item.choices.join(', ')}`)
  }
  return errors
}

export const ONE_HEALTH_RULESET_VERSION = '2026.1'

export function evaluateOneHealthRules(moduleKey: string, values: Record<string, unknown>): OneHealthAlert[] {
  const alerts: OneHealthAlert[] = []
  const add = (rule_code: string, severity: OneHealthAlert['severity'], message: string): void => {
    alerts.push({ rule_code, severity, message, ruleset_version: ONE_HEALTH_RULESET_VERSION })
  }
  if (moduleKey === 'stewardship') {
    if (values.aware_group === 'Reserve' && !present(values.reserve_authorisation)) add('AMS-RESERVE-AUTH', 'high', 'Reserve antimicrobial lacks documented authorisation.')
    if (!present(values.review_due_at)) add('AMS-TIMEOUT', 'medium', 'Antibiotic review/stop date is not documented.')
  } else if (moduleKey === 'ipc_hai') {
    const denominator = numberValue(values.denominator)
    const cases = numberValue(values.case_count)
    if (denominator > 0 && (cases / denominator) * 1000 >= 5) add('IPC-RATE-SIGNAL', 'high', 'HAI rate is at or above 5 per 1,000 denominator-days/procedures; review locally.')
  } else if (moduleKey === 'food') {
    if (present(values.result_value) && present(values.maximum_limit) && Number(values.result_value) > Number(values.maximum_limit)) add('FOOD-MRL-EXCEED', 'critical', 'Residue result exceeds recorded maximum limit.')
    if (!['received', 'tested', 'closed'].includes(valueText(values.custody_status))) add('FOOD-CUSTODY-OPEN', 'medium', 'Chain of custody has not reached laboratory receipt.')
  } else if (moduleKey === 'environment') {
    if (present(values.concentration) && present(values.detection_limit) && Number(values.concentration) >= Number(values.detection_limit)) add('ENV-RESIDUE-DETECTED', 'medium', 'Residue concentration is at or above method detection limit.')
  } else if (moduleKey === 'genomics' && present(values.cluster_id) && values.review_status === 'confirmed') {
    add('GEN-CONFIRMED-CLUSTER', 'critical', 'Confirmed genomic cluster requires epidemiological action.')
  } else if (moduleKey === 'human_quality') {
    const denominator = Number(values.denominator)
    const numerator = Number(values.numerator)
    const target = Number(values.target)
    if (denominator > 0 && Number.isFinite(target) && (numerator / denominator) * 100 > target) add('HLAB-QUALITY-TARGET', 'high', 'Laboratory quality indicator exceeds recorded target.')
  }
  return alerts
}

function asRow(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Row
}

function metricRows(rows: Array<Record<string, unknown>>): Record<string, unknown> {
  return { observations: rows.length }
}

export function calculateOneHealthMetrics(moduleKey: string, inputRows: Array<Record<string, unknown>>): Record<string, unknown> {
  const rows = inputRows.map((row) => asRow(row))
  if (moduleKey === 'amc') {
    let totalGrams = 0; let ddds = 0; let bedDays = 0; let patientDays = 0; let population = 0; let accessDdds = 0
    for (const row of rows) {
      const grams = numberValue(row.quantity_grams); const dddGrams = numberValue(row.who_ddd_grams)
      const rowDdds = dddGrams > 0 ? grams / dddGrams : 0
      totalGrams += grams; ddds += rowDdds; bedDays += numberValue(row.bed_days); patientDays += numberValue(row.patient_days); population += numberValue(row.population)
      if (row.aware_group === 'Access') accessDdds += rowDdds
    }
    return { quantity_grams: totalGrams, ddd: ddds, ddd_per_100_bed_days: safeRate(ddds, bedDays, 100), ddd_per_100_patient_days: safeRate(ddds, patientDays, 100), ddd_per_1000_inhabitants_day: safeRate(ddds, population * 365, 1000), access_share_percent: safeRate(accessDdds, ddds, 100) }
  }
  if (moduleKey === 'stewardship') {
    const aware: Record<string, number> = { Access: 0, Watch: 0, Reserve: 0, 'Not recommended': 0, Unknown: 0 }
    let cultureBefore = 0; let reviewDocumented = 0; let dot = 0; let lot = 0
    for (const row of rows) {
      const group = valueText(row.aware_group) || 'Unknown'; aware[group] = (aware[group] ?? 0) + 1
      if (truthy(row.culture_before_antibiotic)) cultureBefore += 1
      if (present(row.review_due_at)) reviewDocumented += 1
      dot += numberValue(row.dot); lot += numberValue(row.lot)
    }
    return { reviews: rows.length, dot, lot, culture_before_percent: safeRate(cultureBefore, rows.length, 100), review_documented_percent: safeRate(reviewDocumented, rows.length, 100), aware_counts: aware }
  }
  if (moduleKey === 'ipc_hai') {
    const byHaiType: Record<string, { cases: number; denominator: number; rate_per_1000?: number | null }> = {}
    for (const row of rows) {
      const type = valueText(row.hai_type) || 'other'; const bucket = byHaiType[type] ?? { cases: 0, denominator: 0 }
      bucket.cases += numberValue(row.case_count); bucket.denominator += numberValue(row.denominator); byHaiType[type] = bucket
    }
    for (const bucket of Object.values(byHaiType)) bucket.rate_per_1000 = safeRate(bucket.cases, bucket.denominator, 1000)
    return { by_hai_type: byHaiType }
  }
  if (moduleKey === 'veterinary') {
    let quantityMg = 0; let biomassKg = 0
    for (const row of rows) { quantityMg += numberValue(row.quantity_mg); biomassKg += numberValue(row.biomass_kg) }
    return { quantity_mg: quantityMg, biomass_kg: biomassKg, mg_per_pcu_kg: safeRate(quantityMg, biomassKg) }
  }
  if (moduleKey === 'food') {
    let tested = 0; let exceedances = 0; let closed = 0
    for (const row of rows) {
      if (present(row.result_value)) tested += 1
      if (present(row.result_value) && present(row.maximum_limit) && Number(row.result_value) > Number(row.maximum_limit)) exceedances += 1
      if (row.custody_status === 'closed') closed += 1
    }
    return { samples: rows.length, residue_results: tested, limit_exceedances: exceedances, chain_closed_percent: safeRate(closed, rows.length, 100) }
  }
  if (moduleKey === 'environment') {
    let genePositive = 0; let openActions = 0; const concentrations: number[] = []
    for (const row of rows) {
      if (present(row.resistance_genes)) genePositive += 1
      if (present(row.action_status) && !['closed', 'resolved'].includes(valueText(row.action_status).toLocaleLowerCase())) openActions += 1
      if (present(row.concentration) && Number.isFinite(Number(row.concentration))) concentrations.push(Number(row.concentration))
    }
    return { samples: rows.length, gene_positive: genePositive, open_actions: openActions, mean_residue_concentration: concentrations.length ? concentrations.reduce((sum, value) => sum + value, 0) / concentrations.length : null }
  }
  if (moduleKey === 'genomics') {
    const clusters: Record<string, number> = {}; let confirmed = 0
    for (const row of rows) {
      if (present(row.cluster_id)) { const cluster = valueText(row.cluster_id); clusters[cluster] = (clusters[cluster] ?? 0) + 1 }
      if (row.review_status === 'confirmed') confirmed += 1
    }
    return { referrals: rows.length, clusters, confirmed }
  }
  if (moduleKey === 'human_quality') {
    const indicatorPercent: Record<string, number | null> = {}
    for (const row of rows) indicatorPercent[valueText(row.indicator) || 'unknown'] = safeRate(numberValue(row.numerator), numberValue(row.denominator), 100)
    return { indicator_percent: indicatorPercent, observations: rows.length }
  }
  return metricRows(rows)
}

export function createOneHealthAggregate(moduleKey: string, facilityId: string | undefined, events: Row[]): Record<string, unknown> {
  const module = ONE_HEALTH_MODULES[moduleKey]
  if (!module) throw new Error(`Unknown One Health module: ${moduleKey}`)
  const payloads = events.map((event) => {
    const payload = event.payload
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : event as Record<string, unknown>
  })
  return {
    contract: 'national-amr-data-product/1.0',
    module: moduleKey,
    domain: module.domain,
    facility_id: facilityId ?? null,
    generated_at: new Date().toISOString(),
    record_count: events.length,
    metrics: calculateOneHealthMetrics(moduleKey, payloads),
    quality: { status: 'provisional', schema_version: '1.0', ruleset_version: ONE_HEALTH_RULESET_VERSION }
  }
}

export function scalarMetrics(metrics: Record<string, unknown>): Row {
  const result: Row = {}
  for (const [metricKey, value] of Object.entries(metrics)) {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) result[metricKey] = value as Scalar
    else result[metricKey] = value as Record<string, unknown>
  }
  return result
}
