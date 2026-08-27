import type { PatientResidence, PostalAddress } from './address.js'

export type { PatientResidence, PostalAddress }

export type Scalar = string | number | boolean | null
/** Nested object arrays are real: hydrated panels carry their organisms, specimens and
 * antibiotic members inline. */
export type Row = Record<string, Scalar | Scalar[] | Record<string, unknown> | Array<Record<string, unknown>>>

export type OneHealthRole = 'administrator' | 'data-entry' | 'reviewer' | 'steward' | 'auditor' | 'sync-agent'

export interface OneHealthIdentity {
  id: string
  username: string
  roles: OneHealthRole[]
}

export interface OneHealthAuthStatus {
  needsBootstrap: boolean
  authenticated: boolean
  identity: OneHealthIdentity | null
  expiresAt: string | null
}

export type OneHealthExportFormat = 'aggregate' | 'glass' | 'animuse' | 'infarm'

export type MasterKind =
  | 'antibiotics'
  | 'organisms'
  | 'samples'
  | 'sampleAliases'
  | 'locations'
  | 'domains'
  | 'dataFields'
  | 'hospitals'
  | 'admin-units'
  | 'panels'
  | 'expertRules'
  | 'breakpoints'
  | 'qcRanges'
  | 'expectedResistance'
  | 'genomicMarkers'
  | 'codeValues'

/** Catalogue a `multiselect`/`panelAntibiotics` column draws its choices from. */
export type MasterOptionSource = 'antibiotics' | 'organisms' | 'samples' | 'genomicMarkers'

/** One editable field inside an `objectList` row. */
export interface MasterObjectField {
  key: string
  label: string
  type?: 'text' | 'number' | 'textarea' | 'select'
  options?: Array<{ value: string; label: string }>
  placeholder?: string
  /** Provenance carried from the source catalogue; shown but not editable. */
  readonly?: boolean
}

/**
 * A ready-made entry offered for a column that is otherwise free text.
 *
 * The point is not to save typing. A data field keyed `patientId` in one laboratory and
 * `patient_id` in the next produces two columns that no analysis can join, so the common
 * ones are offered by name and bring their own label, grouping and length with them.
 * Anything not on the list can still be typed; presets are a default, not a fence.
 */
export interface MasterColumnPreset {
  value: string
  label: string
  hint?: string
  /** Other columns filled in when this preset is taken, unless already set by hand. */
  apply?: Record<string, string | number | boolean>
}

export interface MasterColumn {
  key: string
  label: string
  type: 'text' | 'number' | 'boolean' | 'select' | 'date' | 'textarea' | 'json' | 'multiselect' | 'panelAntibiotics' | 'panelMarkers' | 'objectList' | 'keyValue' | 'address'
  required?: boolean
  readonly?: boolean
  options?: Array<{ value: string; label: string }>
  /** Required by `multiselect` and `panelAntibiotics`; names the master catalogue to offer. */
  optionSource?: MasterOptionSource
  /** Required by `objectList`; describes the editable fields of each row. */
  fields?: MasterObjectField[]
  /** Singular noun used on the add button of `objectList`, e.g. "guidance note". */
  itemLabel?: string
  /** Suggested values for a free-text column, offered as a searchable list. */
  presets?: MasterColumnPreset[]
  /**
   * Names a `whonet_code_values` code set. The editor offers that catalogue as a searchable
   * dropdown and stores the code, so a locally typed spelling never reaches an export.
   */
  codeSet?: string
  hint?: string
}

/** Requirement types treated as pre-configured members of a panel. Everything else is
 * offered to the laboratory as an optional add-on during isolate entry. */
export const ESSENTIAL_REQUIREMENT_TYPES = Object.freeze(['core', 'required', 'essential', 'one_of'])

export const PANEL_REQUIREMENT_TYPES: Array<{ value: string; label: string }> = [
  { value: 'core', label: 'Essential — always tested' },
  { value: 'one_of', label: 'Essential — one of an option group' },
  { value: 'optional', label: 'Optional — added by the centre' },
  { value: 'conditional', label: 'Optional — conditional on findings' },
  { value: 'conditional_report', label: 'Optional — conditional reporting' },
  { value: 'surrogate', label: 'Optional — surrogate agent' },
  { value: 'synergy', label: 'Optional — synergy testing' }
]

export const isEssentialRequirement = (value: unknown): boolean =>
  ESSENTIAL_REQUIREMENT_TYPES.includes(String(value ?? 'core').trim().toLowerCase() || 'core')

export interface PanelAntibioticMember {
  code: string
  name: string
  sort_order?: number
  option_group?: string
  requirement_type?: string
  notes?: string
  source_text?: string
}

export interface MasterDefinition {
  kind: MasterKind
  title: string
  purpose: string
  table: string
  key: string
  labScoped?: boolean
  /** The key is assigned by the database, so it is never entered or copied by hand. */
  autoKey?: boolean
  columns: MasterColumn[]
}

export interface Laboratory {
  code: string
  name: string
  /** Free-text country name, kept for compatibility. Prefer country_code. */
  country?: string
  /** ISO 3166-1 alpha-3. */
  country_code?: string
  /** Deepest master_admin_units row this laboratory belongs to. */
  admin_unit_id?: string
  /** Materialised path of codes, e.g. "IND/28/583". Scope filters match on this. */
  admin_path?: string
  /** IANA zone. Overrides the country default, which is wrong where a country spans zones. */
  timezone?: string
  /**
   * Where the building is, in the shape that country writes addresses in. Separate from
   * `admin_unit_id`, which is which reporting unit the laboratory belongs to — a facility's
   * postal town and its reporting district are often not the same place.
   */
  address?: PostalAddress
  site_group?: string
  default_guideline?: string
  default_test_method?: string
  guideline_year?: string
  [key: string]: unknown
}

export interface LaboratoryCloneResult {
  laboratory: Laboratory
  sourceCode: string
  counts: Record<string, number>
  copied: string[]
  excluded: string[]
}

export interface LabAntibioticSetting {
  antibioticCode: string
  guideline: string
  testMethod: string
  diskPotency?: string
  testCode?: string
  includeInProfile: boolean
  breakpointScope: string
  breakpointNotes?: string
  sortOrder: number
}

export interface LabCustomAlert {
  id?: number
  ruleName: string
  organismCode?: string
  organismName: string
  antibioticCode: string
  antibioticName: string
  triggerResults: string
  category: string
  alertType: string
  priority: string
  message?: string
  active: boolean
  sortOrder: number
}

export interface LaboratoryConfiguration {
  labCode: string
  domainCodes: string[]
  organismCodes: string[]
  antibioticCodes: string[]
  antibioticSettings: LabAntibioticSetting[]
  alerts: string[]
  customAlerts: LabCustomAlert[]
}

export type LaboratoryConfigurationInput = Omit<LaboratoryConfiguration, 'labCode'>

export interface IsolateRecord {
  id?: number
  lab_code: string
  patient_id?: string
  specimen_number?: string
  specimen_date?: string
  specimen_type?: string
  specimen_code?: string
  organism?: string
  organism_code?: string
  sex?: string
  date_of_birth?: string
  age_years?: number | null
  location?: string
  location_type?: string
  /**
   * Where the patient lives, to the town and postal code — never the street. Kept apart
   * from `location`, which is the ward they were admitted to, and coarsened by
   * `privacy.patient_postal_code_digits` in anything that leaves the deployment.
   */
  patient_residence?: PatientResidence
  admission_date?: string
  /** Human-readable diagnosis text. Derived from `diagnosis_code` when the codes are picked
   * from a catalogue, and free text only where no coded value exists. */
  diagnosis?: string
  /**
   * The coded diagnoses, comma-separated. One isolate frequently has more than one — a
   * urinary source and a sepsis — and recording only the first loses the reason the
   * specimen was taken.
   */
  diagnosis_code?: string
  /** The code system(s) `diagnosis_code` is expressed in, so an export can name them. */
  diagnosis_system?: string
  record_status?: 'draft' | 'final'
  panel_name?: string
  antibiotic_results?: Record<string, AstResult>
  genomic_results?: Record<string, GenomicResult>
  omics?: OmicsRecord[]
  identification_method?: string
  identification_score?: string
  alerts?: unknown[]
  expert_comments?: unknown[]
  [key: string]: unknown
}

/** Genotypic AMR marker result recorded against an isolate. */
export interface GenomicResult {
  result?: 'detected' | 'not_detected' | 'indeterminate' | 'not_tested' | ''
  method?: string
  /** Gene, allele or mutation actually reported, e.g. "blaOXA-181" or "rpoB S450L". */
  target?: string
  interpretation?: string
}

export const GENOMIC_RESULT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'detected', label: 'Detected' },
  { value: 'not_detected', label: 'Not detected' },
  { value: 'indeterminate', label: 'Indeterminate / invalid' },
  { value: 'not_tested', label: 'Not tested' }
]

export const OMICS_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'wgs', label: 'Whole-genome sequencing' },
  { value: 'targeted_ngs', label: 'Targeted NGS panel' },
  { value: 'amplicon_16s', label: '16S rRNA amplicon sequencing' },
  { value: 'metagenomics', label: 'Metagenomic sequencing' },
  { value: 'maldi_tof', label: 'MALDI-TOF spectrum' },
  { value: 'transcriptomics', label: 'Transcriptomics' },
  { value: 'proteomics', label: 'Proteomics' },
  { value: 'metabolomics', label: 'Metabolomics' },
  { value: 'analysis_report', label: 'Analysis report / determinant call' }
]

export const IDENTIFICATION_METHOD_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'Biochemical', label: 'Conventional biochemical' },
  { value: 'Automated ID', label: 'Automated ID system' },
  { value: 'MALDI-TOF', label: 'MALDI-TOF mass spectrometry' },
  { value: '16S rRNA sequencing', label: '16S rRNA gene sequencing' },
  { value: 'WGS', label: 'Whole-genome sequencing' },
  { value: 'Metagenomics', label: 'Metagenomic sequencing' },
  { value: 'PCR', label: 'Species-specific PCR' }
]

/** An omics artefact linked to an isolate. Payloads live on disk, never inside the database. */
export interface OmicsRecord {
  id?: number
  isolate_id: number
  lab_code?: string
  omics_type: string
  platform?: string
  file_name?: string
  /** Managed copy inside the workspace, when the file was copied in. */
  stored_path?: string
  /** Where the operator selected the file from. */
  source_path?: string
  file_format?: string
  file_size?: number
  sha256?: string
  storage_mode?: 'copied' | 'linked'
  accession?: string
  repository?: string
  analysis_tool?: string
  tool_version?: string
  database_version?: string
  quality_metrics?: string
  result_summary?: string
  notes?: string
  recorded_at?: string
}

export interface AstResult {
  result?: 'R' | 'I' | 'S' | ''
  measurement?: string | number
  method?: string
  guideline?: string
  potency?: string
  source?: string
}

export interface DashboardCounts {
  laboratoryCount: number
  antibioticCount: number
  organismCount: number
  panelCount: number
  locationCount: number
  isolateCount: number
  draftCount: number
  finalCount: number
  breakpointCount: number
}

export interface ImportPreview {
  headers: string[]
  rows: Row[]
  issues: Array<{ row: number; severity: 'error' | 'warning'; field: string; message: string }>
  validCount: number
  draftCount: number
  errorCount: number
  sourcePath: string
}

export interface ImportProfile {
  id?: number
  lab_code: string
  profile_name: string
  file_format?: string
  delimiter?: string
  mapping: Record<string, string>
  defaults?: Record<string, string>
  updated_at?: string
}

export type AnalysisMode =
  | 'ris'
  | 'stewardship'
  | 'unitAntibiogram'
  | 'specimenAntibiogram'
  | 'priorityIndicators'
  | 'dataQuality'
  | 'trends'
  | 'isolateListing'
  | 'summary'
  | 'clusterWatch'

export type DeduplicateMode = 'firstPatientOrganism' | 'allIsolates'

export interface AnalysisFilters {
  labCode: string
  mode?: AnalysisMode
  periodStart?: string
  periodEnd?: string
  organism?: string
  organisms?: string[]
  specimenType?: string
  specimenTypes?: string[]
  locationType?: string
  antibioticCode?: string
  recordId?: number
  includeDrafts?: boolean
  deduplicateMode?: DeduplicateMode
  outbreakAnalysisType?: 'prospective' | 'retrospective'
  outbreakTarget?: 'organism' | 'resistance' | 'both'
  outbreakBaselineDays?: number
  outbreakMaxClusterDays?: number
  outbreakDeduplicationDays?: number
  outbreakMinimumCases?: number
  outbreakPermutations?: number
  outbreakRecurrenceThresholdDays?: number
}

export interface AnalysisResult {
  mode?: AnalysisMode
  title?: string
  total: number
  resistant: number
  intermediate: number
  susceptible: number
  resistancePercent: number
  byOrganism: Array<{ label: string; value: number }>
  bySpecimen: Array<{ label: string; value: number }>
  byMonth: Array<{ label: string; value: number }>
  byAntibiotic: Array<{ code: string; tested: number; resistant: number; percent: number }>
  dataQuality: Array<{ label: string; value: number }>
  columns?: string[]
  rows?: Row[]
  summaryLines?: string[]
  clusterFlags?: Row[]
  outbreak?: import('../main/outbreak-detection').OutbreakScanResult
  cohort: {
    sourceCount: number
    includedCount: number
    repeatIsolatesExcluded: number
    truncated: boolean
    deduplicateMode: DeduplicateMode
    selectedOrganisms: string[]
    selectedSpecimenTypes: string[]
  }
}

export interface SyncConfig {
  serverUrl: string
  authToken: string
  siteToken: string
  /**
   * Proof that this installation is the one that asked to be registered.
   *
   * Returned once when access is requested, and presented later to collect the bearer token
   * the administrator approved. It exists so a laboratory needs no shared enrolment secret to
   * enrol: knowing a lab code gets an attacker nothing, because collecting that lab's token
   * requires the secret handed only to whoever filed the request.
   */
  pickupToken: string
  labCode: string
  pollIntervalSeconds: number
  pollTimeoutSeconds: number
  verifyTls: boolean
  autoConfigureToken: boolean
  gpsConsent: boolean
  gpsLatitude?: number
  gpsLongitude?: number
  /**
   * Where the coordinates came from. `device` means this computer's own location service
   * answered; `manual` means somebody typed them. The server records it, because a
   * hand-typed coordinate and a device fix are different evidence about where a site is.
   */
  gpsSource?: 'device' | 'manual' 
  allowedQueryTypes: string[]
}

export interface SyncStatus {
  mode: 'off' | 'connecting' | 'idle' | 'processing' | 'error'
  websocket: 'off' | 'connecting' | 'connected' | 'error'
  lastError: string
  lastHeartbeat?: string
  tokenConfigured: boolean
}

export interface AuditEntry {
  timestamp: string
  operation: string
  status: 'ok' | 'error' | 'warning'
  summary: string
  details?: string
}

export interface BreakpointImportResult {
  imported: number
  skipped: number
  errors: string[]
  sourceName: string
  sourceHash: string
  edition?: string
}

/**
 * The outcome of pulling the published EUCAST table.
 *
 * `origin` matters to the operator: `network` means the deployment now holds what
 * eucast.org publishes today, `bundled` means the network was unreachable and the table
 * that shipped with this build was installed instead. A clinical laboratory has to be able
 * to tell those two apart before it interprets anything.
 */
export interface BreakpointUpdateResult extends BreakpointImportResult {
  origin: 'network' | 'bundled'
  /** Set when the fetch failed and the bundled table was used instead. */
  fetchError?: string
}

/** One ISO 3166-1 country, as a form offers it. */
export interface CountryOption {
  /** ISO 3166-1 alpha-3. What is stored, everywhere. */
  alpha3: string
  /** ISO 3166-1 alpha-2, for the formats and services that speak it. */
  alpha2: string
  name: string
  who_region: string | null
}

export interface AppBootstrap {
  databasePath: string
  migratedFrom?: string
  currentLab: Laboratory | null
  laboratories: Laboratory[]
  counts: DashboardCounts
  masterDefinitions: MasterDefinition[]
  syncStatus: SyncStatus
  appVersion: string
  countryProfile: CountryProfile
}

/** One level of a country's sub-national hierarchy, outermost first. */
export interface AdminLevelDefinition {
  level: number
  key: string
  label: string
  label_plural: string
  /** Authority for the codes at this level: ISO3166-2, LGD, GeoNames, FIPS, … */
  code_system: string
  required: boolean
}

/**
 * The single source of country-varying behaviour, shared with the server.
 * Contract: shared/country-profiles/profile.schema.json.
 */
export interface CountryProfile {
  schema_version: 1
  profile_id: string
  source?: 'curated' | 'synthesized' | 'fallback'

  /** ISO 3166-1 alpha-3. This is what exporters emit. */
  country_code: string
  country_code_2?: string
  country_name: string
  who_region?: string | null

  locale?: string
  fallback_locales?: string[]
  text_direction?: 'ltr' | 'rtl'
  /** CLDR numbering system. Drives display AND input normalisation. */
  numbering_system?: string
  /** Canonical IANA identifier. Null when the country spans several zones. */
  timezone?: string | null
  timezone_ambiguous?: boolean
  /** Display calendar only — storage is always ISO-8601 Gregorian UTC. */
  calendar?: 'gregory' | 'buddhist' | 'ethiopic' | 'islamic' | 'islamic-umalqura' | 'nepali' | 'persian' | 'roc'
  date_input_order?: 'DMY' | 'MDY' | 'YMD'
  first_day_of_week?: number
  epi_week_system?: 'iso' | 'mmwr'
  fiscal_year_start_month?: number

  admin_levels: AdminLevelDefinition[]

  identifier_namespace?: { base_uri: string; urn_prefix: string }
  branding?: {
    product_name: string
    app_id?: string
    authority_name: string
    logo?: string | null
    /** The same mark reversed, for the dark sidebar. Absent means "use a plate instead". */
    logo_reverse?: string | null
    colors?: Record<string, string>
  }
  guidelines?: { default: string; available: string[]; national_body?: string | null }
  code_systems?: Record<string, { enabled: boolean; licence?: string | null }>
  banned_identifier_keys?: string[]
  privacy?: {
    k_anonymity_floor?: number
    /** Leading characters of a patient's postal code kept on export; 0 drops it. */
    patient_postal_code_digits?: number | null
    retention_days?: number | null
    residency_note?: string | null
  }
  map?: { center?: [number, number] | null; zoom?: number; tile_url?: string | null }
  reporting_frameworks?: string[]
}
