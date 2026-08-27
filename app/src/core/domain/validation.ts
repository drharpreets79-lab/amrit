import { z } from 'zod'

export const masterKindSchema = z.enum([
  'antibiotics',
  'organisms',
  'samples',
  'sampleAliases',
  'locations',
  'domains',
  'dataFields',
  'hospitals',
  'admin-units',
  'panels',
  'expertRules',
  'breakpoints',
  'qcRanges',
  'expectedResistance',
  'genomicMarkers',
  'codeValues'
])

const shortText = z.string().trim().max(500)
const code = z.string().trim().min(1).max(100)
const scalar = z.union([z.string().max(20_000), z.number().finite(), z.boolean(), z.null()])
const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([scalar, z.array(jsonValue).max(10_000), z.record(z.string().max(250), jsonValue)])
)

/** Structured clone preserves explicitly-undefined properties across IPC. Renderer state
 * routinely carries them for optional context (location type, domain, …); dropping them is
 * equivalent to omitting the key and keeps the payload inside the strict value grammar. */
const withoutUndefined = (value: unknown): unknown => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
  return Object.fromEntries(entries)
}

export const rowSchema = z.preprocess(withoutUndefined, z.record(z.string().max(250), jsonValue))

export const laboratorySchema = z
  .object({ code, name: z.string().trim().min(1).max(300) })
  .catchall(jsonValue)

export const recordSchema = z.preprocess(
  withoutUndefined,
  z
    .object({
      id: z.number().int().positive().optional(),
      lab_code: code,
      record_status: z.enum(['draft', 'final']).optional(),
      antibiotic_results: z.record(z.string().max(100), jsonValue).optional()
    })
    .catchall(jsonValue)
)

export const analysisFiltersSchema = z
  .object({
    labCode: code,
    mode: z.enum(['ris', 'stewardship', 'unitAntibiogram', 'specimenAntibiogram', 'priorityIndicators', 'dataQuality', 'trends', 'isolateListing', 'summary', 'clusterWatch']).optional(),
    periodStart: shortText.optional(),
    periodEnd: shortText.optional(),
    organism: shortText.optional(),
    organisms: z.array(shortText).max(500).optional(),
    specimenType: shortText.optional(),
    specimenTypes: z.array(shortText).max(500).optional(),
    locationType: shortText.optional(),
    antibioticCode: shortText.optional(),
    recordId: z.number().int().positive().optional(),
    includeDrafts: z.boolean().optional(),
    deduplicateMode: z.enum(['firstPatientOrganism', 'allIsolates']).optional(),
    outbreakAnalysisType: z.enum(['prospective', 'retrospective']).optional(),
    outbreakTarget: z.enum(['organism', 'resistance', 'both']).optional(),
    outbreakBaselineDays: z.number().int().min(30).max(3650).optional(),
    outbreakMaxClusterDays: z.number().int().min(1).max(365).optional(),
    outbreakDeduplicationDays: z.number().int().min(0).max(365).optional(),
    outbreakMinimumCases: z.number().int().min(2).max(100).optional(),
    outbreakPermutations: z.number().int().min(19).max(9999).optional(),
    outbreakRecurrenceThresholdDays: z.number().int().min(20).max(100000).optional()
  })
  .strict()

const labAntibioticSettingSchema = z.object({
  antibioticCode: code,
  guideline: z.string().trim().min(1).max(100),
  testMethod: z.string().trim().min(1).max(100),
  diskPotency: shortText.optional(),
  testCode: shortText.optional(),
  includeInProfile: z.boolean(),
  breakpointScope: z.string().trim().min(1).max(200),
  breakpointNotes: z.string().max(5_000).optional(),
  sortOrder: z.number().int().min(0).max(1_000_000)
}).strict()

const labCustomAlertSchema = z.object({
  id: z.number().int().positive().optional(),
  ruleName: z.string().trim().min(1).max(300),
  organismCode: code.optional(),
  organismName: z.string().trim().min(1).max(500),
  antibioticCode: code,
  antibioticName: z.string().trim().min(1).max(500),
  triggerResults: z.string().trim().min(1).max(100),
  category: z.string().trim().min(1).max(100),
  alertType: z.string().trim().min(1).max(100),
  priority: z.string().trim().min(1).max(100),
  message: z.string().max(5_000).optional(),
  active: z.boolean(),
  sortOrder: z.number().int().min(0).max(1_000_000)
}).strict()

export const laboratoryConfigurationSchema = z.object({
  domainCodes: z.array(code).max(100),
  organismCodes: z.array(code).max(10_000),
  antibioticCodes: z.array(code).max(10_000),
  antibioticSettings: z.array(labAntibioticSettingSchema).max(10_000),
  alerts: z.array(z.string().trim().min(1).max(200)).max(1_000),
  customAlerts: z.array(labCustomAlertSchema).max(1_000)
}).strict()

export const syncConfigSchema = z
  .object({
    serverUrl: z.string().trim().url().max(2_000),
    authToken: z.string().max(20_000),
    siteToken: z.string().max(20_000),
    pickupToken: z.string().max(20_000),
    labCode: code,
    pollIntervalSeconds: z.number().int().min(5).max(86_400),
    pollTimeoutSeconds: z.number().int().min(5).max(600),
    verifyTls: z.boolean(),
    autoConfigureToken: z.boolean(),
    gpsConsent: z.boolean(),
    gpsLatitude: z.number().min(-90).max(90).optional(),
    gpsLongitude: z.number().min(-180).max(180).optional(),
    gpsSource: z.enum(['device', 'manual']).optional(),
    allowedQueryTypes: z.array(z.enum(['resistance_rate', 'isolate_count', 'organism_distribution', 'specimen_distribution', 'measure_bundle', 'cluster_scan', 'heartbeat'])).max(7)
  })
  .strict()

export const fileOptionsSchema = z
  .object({
    filters: z
      .array(z.object({ name: z.string().max(100), extensions: z.array(z.string().regex(/^[a-zA-Z0-9]+$/)).max(20) }))
      .max(20)
      .optional()
  })
  .strict()
  .optional()

export const saveOptionsSchema = z
  .object({
    defaultPath: z.string().min(1).max(4_096),
    filters: z
      .array(z.object({ name: z.string().max(100), extensions: z.array(z.string().regex(/^[a-zA-Z0-9]+$/)).max(20) }))
      .max(20)
      .optional()
  })
  .strict()

export const pathSchema = z.string().min(1).max(4_096)
export const idSchema = z.number().int().positive()
export const codeSchema = code
export const scalarKeySchema = z.union([code, z.number().int()])
export const filtersSchema = z.preprocess(withoutUndefined, z.record(z.string().max(100), jsonValue))
export const preferencesSchema = z.record(z.string().max(200), z.string().max(20_000))
export const sourceSchema = z.record(z.string().max(100), z.string().max(2_000)).optional()
export const importProfileSchema = z
  .object({
    id: z.number().int().positive().optional(),
    lab_code: code,
    profile_name: z.string().trim().min(1).max(200),
    file_format: shortText.optional(),
    delimiter: z.string().max(10).optional(),
    mapping: z.record(z.string().max(500), z.string().max(500)),
    defaults: z.record(z.string().max(200), z.string().max(2_000)).optional(),
    updated_at: shortText.optional()
  })
  .strict()
export const modelNameSchema = z.string().trim().min(1).max(300).regex(/^[A-Za-z0-9._:/-]+$/)
export const moduleKeySchema = z.string().trim().min(1).max(100).regex(/^[a-z0-9_-]+$/i)
export const importPreviewSchema = z
  .object({
    headers: z.array(z.string().max(500)).max(512),
    rows: z.array(rowSchema).max(50_000),
    issues: z
      .array(z.object({
        row: z.number().int().nonnegative(),
        severity: z.enum(['error', 'warning']),
        field: z.string().max(500),
        message: z.string().max(5_000)
      }))
      .max(200_000),
    validCount: z.number().int().nonnegative(),
    draftCount: z.number().int().nonnegative(),
    errorCount: z.number().int().nonnegative(),
    sourcePath: pathSchema
  })
  .strict()

export function assertHttpUrl(value: string, allowLocalHttp = false): URL {
  const url = new URL(value)
  const local = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(allowLocalHttp && local && url.protocol === 'http:')) {
    throw new Error('Only HTTPS endpoints are permitted; HTTP is limited to loopback services.')
  }
  return url
}
