import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'

import type {
  AnalysisFilters,
  AnalysisResult,
  AstResult,
  DashboardCounts,
  GenomicResult,
  ImportProfile,
  ImportPreview,
  IsolateRecord,
  Laboratory,
  LaboratoryCloneResult,
  MasterColumn,
  MasterColumnPreset,
  MasterDefinition,
  MasterKind,
  MasterObjectField,
  MasterOptionSource,
  Row
} from '../shared/types'
import type { BreakpointRow, BreakpointSource } from './services'
import {
  AGENT_NAME_ALIASES,
  BREAKPOINT_MAPPING_VERSION,
  canonicalAgentKey,
  organismNameForLabel,
  organismScopeForLabel,
  parseAgentLabel,
  speciesScopeCode,
  type AgentLabel
} from './breakpoint-mapping'
import { DecisionSupportEngine, type DecisionIssue } from './decision-support'
import { runDeterministicAnalysis } from './analysis-engine'
import { aggregateOutbreakCases } from './outbreak-detection'
import {
  loadPackagedCatalogue,
  DIAGNOSIS_CODE_DATASET,
  DIAGNOSIS_CODE_FILENAME,
  DIAGNOSIS_CODE_SET,
  GENOMIC_MARKER_DATASET,
  GENOMIC_MARKER_FILENAME,
  PACKAGED_CATALOGUE_DATASET,
  resolveResourcePath,
  type PackagedCatalogueAsset
} from './catalog-seed'
import { activeProfile } from './active-profile'
import { addressFormatFor } from './address-format'
import { getCountryProfile } from './country-profile'
import {
  normalizeAddress,
  normalizeResidence,
  repairUnsupportedAddressFields,
  validateAddress,
  validateResidence,
  type PatientResidence,
  type PostalAddress
} from '../shared/address'
import { loadGeoPack, type GeoPack } from './geo-pack'
import { RETENTION_TARGETS, expiredRowsSql, retentionCutoffDate } from './retention'
import { aggregateIdentifierSystem, laboratoryIdentifierSystem, resistanceMeasureUrn } from './identifiers'
import {
  ADMIN_FIELD_KEY,
  ONE_HEALTH_MODULES,
  ONE_HEALTH_SCHEMA_VERSION,
  calculateOneHealthMetrics,
  createOneHealthAggregate,
  evaluateOneHealthRules,
  oneHealthCatalog,
  scalarMetrics,
  validateOneHealth,
  type OneHealthField,
  type OneHealthModule
} from './one-health-engine'
import {
  auditDetailsDigest,
  auditHash,
  hashPassword,
  normalizeRoles,
  requireCapturePermission,
  requirePermission,
  verifyPassword,
  type OneHealthIdentity,
  type OneHealthRole
} from './one-health-governance'

type SqlValue = string | number | bigint | null | Uint8Array
type DbRow = Record<string, unknown>

export interface MasterListOptions {
  labCode?: string
  query?: string
  includeInactive?: boolean
  limit?: number
}

export interface BatchImportResult {
  imported: number
  drafts: number
  failed: number
  errors: Array<{ row: number; error: string }>
  rolledBack: boolean
}

interface MasterSpec {
  definition: MasterDefinition
  columns: readonly string[]
  searchColumns: readonly string[]
  activeField?: string
  labColumn?: string
  autoKey?: boolean
  protectedCatalogue?: boolean
  jsonColumns?: readonly string[]
}

const text = (key: string, label: string, required = false, hint?: string): MasterColumn => ({
  key,
  label,
  type: 'text',
  required,
  hint
})
const number = (key: string, label: string): MasterColumn => ({ key, label, type: 'number' })
const bool = (key: string, label: string): MasterColumn => ({ key, label, type: 'boolean' })
const textarea = (key: string, label: string): MasterColumn => ({ key, label, type: 'textarea' })
/** ISO 3166-1, picked by name. The alpha-3 is what lands in the column. */
const country = (key: string, label: string, required = true): MasterColumn =>
  ({ key, label, type: 'select', codeSet: '__country__', required, hint: 'ISO 3166-1 alpha-3, chosen by country name.' })
/** A choice drawn from a `whonet_code_values` set, so the stored value is the coded one. */
const coded = (key: string, label: string, codeSet: string, required = false, hint?: string): MasterColumn =>
  ({ key, label, type: 'select', codeSet, required, hint })
/** A free-text column with a starting list, so the common answers are spelled one way. */
const suggested = (key: string, label: string, presets: MasterColumnPreset[], required = false, hint?: string): MasterColumn =>
  ({ key, label, type: 'text', presets, required, hint })
const multiselect = (key: string, label: string, optionSource: MasterOptionSource, hint?: string): MasterColumn =>
  ({ key, label, type: 'multiselect', optionSource, hint })
const panelAntibiotics = (key: string, label: string, hint?: string): MasterColumn =>
  ({ key, label, type: 'panelAntibiotics', optionSource: 'antibiotics', hint })
const objectList = (key: string, label: string, itemLabel: string, fields: MasterObjectField[], hint?: string): MasterColumn =>
  ({ key, label, type: 'objectList', itemLabel, fields, hint })
const keyValue = (key: string, label: string, hint?: string): MasterColumn => ({ key, label, type: 'keyValue', hint })
/** A structured postal address on the country's own field set, not a blob of JSON. */
const address = (key: string, label: string, hint?: string): MasterColumn => ({ key, label, type: 'address', hint })
const panelMarkers = (key: string, label: string, hint?: string): MasterColumn =>
  ({ key, label, type: 'panelMarkers', optionSource: 'genomicMarkers', hint })

const MARKER_TYPE_OPTIONS = [
  { value: 'gene', label: 'Acquired resistance gene' },
  { value: 'mutation', label: 'Target-site mutation' },
  { value: 'assay', label: 'Molecular assay / cartridge' },
  { value: 'typing', label: 'Typing output (MLST, cgMLST, SNP)' },
  { value: 'plasmid', label: 'Plasmid / mobile element' },
  { value: 'identification', label: 'Organism identification' }
]

const MARKER_METHOD_OPTIONS = [
  { value: 'PCR', label: 'PCR' },
  { value: 'Multiplex PCR', label: 'Multiplex PCR' },
  { value: 'Xpert MTB/RIF Ultra', label: 'Xpert MTB/RIF Ultra' },
  { value: 'Xpert Carba-R', label: 'Xpert Carba-R' },
  { value: 'Line probe assay', label: 'Line probe assay (LPA)' },
  { value: 'LAMP', label: 'LAMP' },
  { value: 'Targeted NGS', label: 'Targeted NGS' },
  { value: 'WGS', label: 'Whole-genome sequencing' },
  { value: 'Amplicon sequencing', label: 'Amplicon sequencing (16S)' },
  { value: 'Metagenomics', label: 'Metagenomic sequencing' },
  { value: 'MALDI-TOF', label: 'MALDI-TOF' },
  { value: 'Immunochromatographic', label: 'Lateral flow / immunochromatographic' }
]

/**
 * The data fields a surveillance laboratory usually wants, offered by name.
 *
 * A laboratory adding a field types its own key, and two laboratories typing
 * `patientOutcome` and `patient_outcome` produce two columns that no national aggregation
 * can put together — the field is present in both databases and joinable in neither. So the
 * ones that recur are offered with a settled key, and each brings its label, its grouping
 * and its length along, which is the part that actually stops the drift.
 *
 * Not a closed list: any key can still be typed, and a locally invented field is a normal
 * thing for a laboratory to have. These are the ones worth agreeing on.
 */
const DATA_FIELD_PRESETS: MasterColumnPreset[] = [
  ['patient_outcome', 'Patient outcome', 'clinical', 'Clinical course', 24, 'human'],
  ['outcome_date', 'Outcome date', 'clinical', 'Clinical course', 10, 'human'],
  ['icu_admission', 'ICU admission', 'clinical', 'Clinical course', 8, 'human'],
  ['device_associated', 'Device-associated infection', 'clinical', 'Clinical course', 24, 'human'],
  ['infection_origin', 'Community or hospital acquired', 'clinical', 'Clinical course', 24, 'human'],
  ['prior_antibiotic_use', 'Antimicrobial use before specimen', 'clinical', 'Treatment', 48, 'human,animal'],
  ['empirical_therapy', 'Empirical therapy given', 'clinical', 'Treatment', 48, 'human,animal'],
  ['definitive_therapy', 'Definitive therapy given', 'clinical', 'Treatment', 48, 'human,animal'],
  ['treatment_start_date', 'Treatment start date', 'clinical', 'Treatment', 10, 'human,animal'],
  ['referring_facility', 'Referring facility', 'context', 'Referral', 64, ''],
  ['referral_date', 'Referral date', 'context', 'Referral', 10, ''],
  ['travel_history', 'Travel in the previous 30 days', 'epidemiology', 'Exposure', 64, 'human'],
  ['outbreak_identifier', 'Outbreak or cluster identifier', 'epidemiology', 'Exposure', 32, ''],
  ['contact_with_livestock', 'Contact with livestock', 'epidemiology', 'Exposure', 24, 'human'],
  ['occupation_category', 'Occupation category', 'epidemiology', 'Exposure', 32, 'human'],
  ['sample_collection_time', 'Collection time', 'specimen', 'Specimen handling', 8, ''],
  ['transport_medium', 'Transport medium', 'specimen', 'Specimen handling', 32, ''],
  ['specimen_condition', 'Condition on receipt', 'specimen', 'Specimen handling', 32, ''],
  ['repeat_isolate', 'Repeat isolate from same patient', 'specimen', 'Specimen handling', 8, 'human,animal'],
  ['culture_result', 'Culture result', 'laboratory', 'Laboratory result', 32, ''],
  ['colony_count', 'Colony count', 'laboratory', 'Laboratory result', 16, ''],
  ['gram_stain', 'Gram stain', 'laboratory', 'Laboratory result', 32, ''],
  ['biochemical_profile', 'Biochemical identification profile', 'laboratory', 'Laboratory result', 64, ''],
  ['quality_control_passed', 'Quality control passed', 'laboratory', 'Quality', 8, ''],
  ['technologist_initials', 'Performed by', 'laboratory', 'Quality', 12, ''],
  ['verified_by', 'Verified by', 'laboratory', 'Quality', 12, ''],
  ['report_date', 'Report issued', 'laboratory', 'Quality', 10, ''],
  ['herd_flock_identifier', 'Herd or flock identifier', 'context', 'Animal and environment', 32, 'animal'],
  ['production_stage', 'Production stage', 'context', 'Animal and environment', 32, 'animal,food'],
  ['antimicrobial_use_on_farm', 'Antimicrobial use on the holding', 'epidemiology', 'Animal and environment', 64, 'animal'],
  ['sampling_point', 'Sampling point', 'context', 'Animal and environment', 48, 'environment,food'],
  ['water_source_type', 'Water source type', 'context', 'Animal and environment', 32, 'environment']
].map(([value, label, category, group, length, domains]) => ({
  value: String(value),
  label: `${String(label)} — ${String(value)}`,
  hint: String(category),
  apply: {
    field_label: String(label),
    category: String(category),
    field_group: String(group),
    field_length: Number(length),
    applicable_domains: String(domains)
  }
}))

/** Groupings the seeded catalogue already uses, so a new field joins one rather than
 * inventing a synonym for it. */
const DATA_FIELD_CATEGORIES: MasterColumnPreset[] = [
  'patient', 'specimen', 'laboratory', 'clinical', 'epidemiology', 'context', 'administrative'
].map((value) => ({ value, label: value.charAt(0).toUpperCase() + value.slice(1) }))

/**
 * Whether a catalogue's key column holds a number.
 *
 * Not every key named `id` is one. The administrative-unit tree is keyed by a composite
 * text id — `IND:2:583` — because a unit's identity is its country, level and code, and
 * coercing that to a number produced NaN: saving a unit from Master Studio looked like it
 * worked and then could not be found again. Database-assigned integer keys are exactly the
 * `autoKey` catalogues, so that is the test rather than the column's name.
 */
const isNumericKey = (spec: MasterSpec): boolean => spec.definition.key === 'id' && spec.autoKey === true

/** A lookup key in the type its column actually stores. */
const masterKeyValue = (spec: MasterSpec, key: string | number): SqlValue =>
  isNumericKey(spec) ? Number(key) : String(key)

const definition = (
  kind: MasterKind,
  title: string,
  purpose: string,
  table: string,
  key: string,
  columns: MasterColumn[],
  labScoped = false
): MasterDefinition => ({ kind, title, purpose, table, key, columns, labScoped })

/**
 * This is the only source of dynamic identifiers in the database layer.
 * Callers choose a MasterKind; they can never provide table or column names.
 */
const MASTER_SPECS: Record<MasterKind, MasterSpec> = {
  antibiotics: {
    definition: definition(
      'antibiotics',
      'Antibiotics',
      'Configurable antimicrobial catalogue shared by entry, panels, analysis and export.',
      'master_antibiotics',
      'code',
      [
        text('code', 'Code', true), text('name', 'Name', true), text('class_name', 'Class'),
        text('subclass_name', 'Subclass'), text('who_aware', 'WHO AWaRe'), text('atc_code', 'ATC code'),
        text('potency', 'Disk potency'), text('guidelines', 'Guidelines'), bool('human_flag', 'Human'),
        bool('veterinary_flag', 'Veterinary'), textarea('comments', 'Comments'), bool('active', 'Active'),
        number('sort_order', 'Sort order')
      ]
    ),
    columns: ['code', 'name', 'who_group', 'template_name', 'who_code', 'din_code', 'jac_code', 'eucast_code',
      'user_code', 'guidelines', 'potency', 'atc_code', 'class_name', 'subclass_name', 'prof_class', 'who_aware',
      'human_flag', 'veterinary_flag', 'loinc_sbt', 'loinc_mlc', 'comments', 'active', 'is_custom',
      'source_dataset', 'source_version', 'user_modified', 'sort_order'],
    searchColumns: ['code', 'name', 'class_name', 'who_aware', 'atc_code'],
    activeField: 'active',
    protectedCatalogue: true
  },
  organisms: {
    definition: definition(
      'organisms',
      'Organisms',
      'Taxonomy-aware organism catalogue used for code-first panel matching and surveillance.',
      'master_organisms',
      'code',
      [
        text('code', 'Code', true), text('organism_name', 'Organism', true), text('common_name', 'Common name'),
        text('organism_type', 'Type'), text('snomed_code', 'SNOMED CT'), text('gbif_taxon_id', 'GBIF taxon'),
        text('kingdom', 'Kingdom'), text('family_name', 'Family'), text('genus_name', 'Genus'),
        bool('anaerobe', 'Anaerobe'), bool('common_commensal', 'Common commensal'), bool('active', 'Active'),
        number('sort_order', 'Sort order')
      ]
    ),
    columns: ['code', 'organism_name', 'system', 'concept_code', 'replacement_code', 'taxonomic_status',
      'common_name', 'common_commensal', 'organism_type', 'anaerobe', 'snomed_code', 'snomed_text',
      'gbif_taxon_id', 'kingdom', 'phylum_name', 'class_name', 'order_name', 'family_name', 'genus_name',
      'active', 'is_custom', 'source_dataset', 'source_version', 'user_modified', 'sort_order'],
    searchColumns: ['code', 'organism_name', 'common_name', 'snomed_code', 'genus_name'],
    activeField: 'active',
    protectedCatalogue: true
  },
  samples: {
    definition: definition(
      'samples',
      'Specimens',
      'Standard specimen catalogue with hierarchy and terminology codes.',
      'master_samples',
      'code',
      [text('code', 'Code', true), text('name', 'Name', true), text('parent_code', 'Parent code'),
        text('system', 'Code system'), text('concept_code', 'Concept code'), bool('active', 'Active'),
        number('sort_order', 'Sort order')]
    ),
    columns: ['code', 'name', 'parent_code', 'system', 'concept_code', 'active', 'is_custom',
      'source_dataset', 'source_version', 'user_modified', 'sort_order'],
    searchColumns: ['code', 'name', 'concept_code'],
    activeField: 'active',
    protectedCatalogue: true
  },
  sampleAliases: {
    definition: definition(
      'sampleAliases',
      'Specimen aliases',
      'Maps local specimen labels to a standard specimen without altering source data.',
      'master_sample_aliases',
      'normalized_alias',
      [text('normalized_alias', 'Normalized alias', true), text('alias_text', 'Source label', true),
        text('sample_code', 'Specimen code', true), bool('active', 'Active')]
    ),
    columns: ['normalized_alias', 'alias_text', 'sample_code', 'source_dataset', 'source_version', 'active', 'user_modified'],
    searchColumns: ['normalized_alias', 'alias_text', 'sample_code'],
    activeField: 'active',
    protectedCatalogue: true
  },
  locations: {
    definition: definition(
      'locations',
      'Locations',
      'Laboratory-specific wards, clinics, facilities and collection locations.',
      'lab_locations',
      'location_code',
      [text('location_code', 'Code', true), text('location_name', 'Name', true),
        coded('location_type', 'Type', 'ward_type', true, 'From the configured ward-type code set, so wards group across laboratories.'),
        coded('department', 'Department', 'department'), text('institution', 'Institution'), bool('active', 'Active'),
        number('sort_order', 'Sort order')],
      true
    ),
    columns: ['location_code', 'location_name', 'location_type', 'department', 'institution', 'active', 'is_custom', 'sort_order'],
    searchColumns: ['location_code', 'location_name', 'department', 'institution'],
    activeField: 'active',
    labColumn: 'lab_code'
  },
  domains: {
    definition: definition(
      'domains',
      'One Health domains',
      'Configures human, animal, environmental and locally defined surveillance domains.',
      'master_lab_domains',
      'code',
      [text('code', 'Code', true), text('label', 'Label', true), textarea('description', 'Description'),
        text('colour', 'Colour'), bool('active', 'Active'), number('sort_order', 'Sort order')]
    ),
    columns: ['code', 'label', 'description', 'colour', 'active', 'sort_order'],
    searchColumns: ['code', 'label', 'description'],
    activeField: 'active'
  },
  dataFields: {
    definition: definition(
      'dataFields',
      'Data fields',
      'Controls data-entry visibility, validation groups, response codes and domain applicability.',
      'lab_data_fields',
      'field_key',
      [suggested('field_key', 'Field key', DATA_FIELD_PRESETS, true,
        'Pick a standard field to keep it comparable with other laboratories, or type your own key. Choosing one fills the label, category, group and length below.'),
        text('field_label', 'Label', true), suggested('category', 'Category', DATA_FIELD_CATEGORIES, true),
        text('field_group', 'Group', true), number('field_length', 'Length'), bool('is_enabled', 'Enabled'),
        bool('is_hidden', 'Hidden'), bool('include_in_listing', 'List column'), text('applicable_domains', 'Domains'),
        objectList('response_codes', 'Response codes', 'response code', [
          { key: 'value', label: 'Stored code', placeholder: 'e.g. YES' },
          { key: 'label', label: 'Display label', placeholder: 'e.g. Yes' }
        ], 'Finite choices offered for this field during isolate entry. Leave empty for free text.'),
        number('sort_order', 'Sort order')],
      true
    ),
    columns: ['field_key', 'field_label', 'category', 'field_group', 'field_length', 'is_enabled', 'is_hidden',
      'include_in_listing', 'applicable_domains', 'response_codes', 'is_custom', 'sort_order'],
    searchColumns: ['field_key', 'field_label', 'category', 'field_group'],
    activeField: 'is_enabled',
    labColumn: 'lab_code',
    jsonColumns: ['response_codes']
  },
  hospitals: {
    definition: definition(
      'hospitals',
      'Hospitals and facilities',
      'Configurable reporting facilities linked to geography and One Health domains.',
      'master_hospitals',
      'code',
      [text('code', 'Facility code', true), text('name', 'Facility name', true), text('facility_type', 'Type'),
        text('domain_code', 'Domain'), text('parent_code', 'Parent facility'),
        text('admin_unit_id', 'Administrative unit'), address('address_json', 'Address', 'Asked for the way this country writes an address. A postal code places the facility on the map.'), text('contact', 'Contact'),
        bool('active', 'Active'), number('sort_order', 'Sort order'),
        keyValue('metadata_json', 'Additional metadata', 'Locally defined properties stored with this facility.')]
    ),
    columns: ['code', 'name', 'facility_type', 'domain_code', 'parent_code', 'admin_unit_id',
      'address_json', 'contact', 'active', 'is_custom', 'sort_order', 'metadata_json'],
    searchColumns: ['code', 'name', 'facility_type', 'address_json'],
    activeField: 'active',
    jsonColumns: ['metadata_json', 'address_json']
  },
  'admin-units': {
    definition: definition(
      'admin-units', 'Administrative units',
      'Country-neutral administrative hierarchy of any depth, one entry per level the country defines.',
      'master_admin_units', 'id',
      [text('id', 'Unit id', true), country('country_code', 'Country'),
        number('level', 'Level'), text('parent_id', 'Parent unit'), text('code', 'Code', true),
        text('code_system', 'Code system'), text('name', 'Name', true), text('name_local', 'Local name'),
        text('unit_type', 'Unit type'), text('admin_path', 'Path'),
        text('postal_code', 'Postal codes', false,
          'PIN / ZIP / postal codes this unit covers: one code, several separated by commas, or a prefix such as 682 standing for every code that begins with it. Used to place an address in this unit.'),
        bool('active', 'Active'), number('sort_order', 'Sort order'),
        keyValue('metadata_json', 'Additional metadata', 'Locally defined properties stored with this unit.')]
    ),
    columns: ['id', 'country_code', 'level', 'parent_id', 'code', 'code_system', 'name', 'name_local',
      'unit_type', 'admin_path', 'postal_code', 'active', 'is_custom', 'sort_order', 'metadata_json'],
    searchColumns: ['code', 'name', 'name_local', 'admin_path', 'postal_code'],
    activeField: 'active',
    jsonColumns: ['metadata_json']
  },
  panels: {
    definition: definition(
      'panels', 'AST panels', 'Code-first organism/specimen panels with ordered antimicrobial requirements.',
      'lab_panels', 'id',
      [number('id', 'ID'), text('panel_name', 'Panel name', true), textarea('description', 'Description'),
        number('priority', 'Priority'), bool('no_routine_ast', 'No routine AST'), bool('active', 'Active'),
        multiselect('organisms', 'Organisms', 'organisms', 'Isolate entry shortlists this panel when the recorded organism is one of these.'),
        multiselect('specimens', 'Specimens', 'samples', 'Leave empty to match every specimen for the selected organisms.'),
        panelAntibiotics('antibiotics', 'Antibiotics', 'Essential members are pre-loaded on the isolate entry screen; optional members are offered as add-ons.'),
        panelMarkers('genomic_markers', 'Genomic markers', 'Genotypic AMR tests prescribed with this panel. Markers added here default to essential and are pre-loaded for entry; set a marker to optional to offer it as an add-on instead.'),
        objectList('guidance', 'Testing guidance', 'guidance note', [
          { key: 'notes', label: 'Guidance note', type: 'textarea', placeholder: 'Shown with the panel during isolate entry.' },
          { key: 'requirement_type', label: 'Applies to', type: 'select', options: [
            { value: 'surrogate_selection', label: 'Surrogate selection' }, { value: 'choice_selection', label: 'Choice of agent' },
            { value: 'conditional_report', label: 'Conditional reporting' }, { value: 'synergy', label: 'Synergy testing' },
            { value: 'general', label: 'General note' }
          ] },
          { key: 'source_clause', label: 'Source clause', type: 'textarea', readonly: true }
        ], 'Free-text guidance carried with the panel. The source clause records the published wording it came from.')],
      true
    ),
    columns: ['id', 'panel_name', 'description', 'source_row_key', 'source_dataset', 'source_version',
      'source_context', 'source_text', 'no_routine_ast', 'guidance_json', 'group_metadata_json', 'priority',
      'active', 'user_modified'],
    searchColumns: ['panel_name', 'description', 'source_row_key'], activeField: 'active', labColumn: 'lab_code',
    autoKey: true, jsonColumns: ['guidance_json', 'group_metadata_json']
  },
  expertRules: {
    definition: definition(
      'expertRules', 'Expert rules', 'Configurable interpretive and intrinsic-resistance rules.',
      'whonet_expert_rules', 'id',
      [number('id', 'ID'), text('rule_code', 'Rule code', true), textarea('description', 'Description'),
        text('organism_code', 'Organism code'), textarea('rule_criteria', 'Criteria'),
        textarea('affected_antibiotics', 'Affected antibiotics'), textarea('antibiotic_exceptions', 'Exceptions'),
        bool('enabled_by_default', 'Enabled by default'), bool('active', 'Active')]
    ),
    columns: ['id', 'rule_code', 'description', 'organism_code', 'organism_code_type', 'rule_criteria',
      'affected_antibiotics', 'antibiotic_exceptions', 'enabled_by_default', 'active', 'is_custom', 'source_set_id'],
    searchColumns: ['rule_code', 'description', 'organism_code', 'affected_antibiotics'], activeField: 'active',
    autoKey: true, protectedCatalogue: true
  },
  breakpoints: {
    definition: definition(
      'breakpoints', 'Clinical breakpoints', 'User-configurable CLSI, EUCAST, FDA and local breakpoint rows with provenance.',
      'whonet_user_breakpoints', 'id',
      [number('id', 'ID'), text('guidelines', 'Guideline', true), text('year', 'Edition/year'),
        text('test_method', 'Method', true), text('potency', 'Potency'), text('organism_code', 'Organism code'),
        text('breakpoint_type', 'Breakpoint type'), text('host', 'Host'), text('site_of_infection', 'Site'),
        text('route', 'Route'), text('whonet_abx_code', 'Antibiotic code', true), text('whonet_test', 'Test code'),
        text('r_value', 'R'), text('i_value', 'I'), text('sdd_value', 'SDD'), text('s_value', 'S'),
        text('ecv_ecoff', 'ECV/ECOFF'), textarea('comments', 'Comments'), bool('active', 'Active')]
    ),
    columns: ['id', 'guidelines', 'year', 'test_method', 'potency', 'organism_code', 'organism_code_type',
      'breakpoint_type', 'host', 'site_of_infection', 'route', 'whonet_abx_code', 'whonet_test', 'r_value', 'i_value',
      'sdd_value', 's_value', 'ecv_ecoff', 'comments', 'active', 'is_custom', 'source_set_id', 'source_import_id'],
    searchColumns: ['guidelines', 'year', 'organism_code', 'whonet_abx_code', 'whonet_test'], activeField: 'active',
    autoKey: true, protectedCatalogue: true
  },
  qcRanges: {
    definition: definition(
      'qcRanges', 'Quality-control ranges', 'Master QC ranges by guideline, strain, antimicrobial and method.',
      'whonet_qc_ranges', 'id',
      [number('id', 'ID'), text('guideline', 'Guideline', true), text('year', 'Year'), text('strain', 'QC strain', true),
        text('whonet_org_code', 'Organism code'), text('antibiotic', 'Antibiotic'), text('whonet_abx_code', 'Antibiotic code'),
        text('method', 'Method'), text('medium', 'Medium'), text('minimum', 'Minimum'), text('maximum', 'Maximum'),
        textarea('comments', 'Comments'), bool('active', 'Active')]
    ),
    columns: ['id', 'guideline', 'year', 'strain', 'reference_table', 'whonet_org_code', 'antibiotic',
      'abx_test', 'whonet_abx_code', 'method', 'medium', 'minimum', 'maximum', 'comments', 'active', 'is_custom', 'source_set_id'],
    searchColumns: ['guideline', 'year', 'strain', 'antibiotic', 'whonet_abx_code'], activeField: 'active',
    autoKey: true, protectedCatalogue: true
  },
  expectedResistance: {
    definition: definition(
      'expectedResistance', 'Expected resistance', 'Intrinsic and expected resistance master by organism and antimicrobial.',
      'whonet_expected_resistance', 'id',
      [number('id', 'ID'), text('guideline', 'Guideline'), text('organism_code', 'Organism code', true),
        text('exception_organism_code', 'Exception organism'), text('abx_code', 'Antibiotic code', true),
        textarea('antibiotic_exceptions', 'Antibiotic exceptions'), textarea('comments', 'Comments'), bool('active', 'Active')]
    ),
    columns: ['id', 'guideline', 'reference_table', 'organism_code', 'organism_code_type', 'exception_organism_code',
      'exception_organism_code_type', 'abx_code', 'abx_code_type', 'antibiotic_exceptions', 'comments',
      'active', 'is_custom', 'source_set_id'],
    searchColumns: ['guideline', 'organism_code', 'exception_organism_code', 'abx_code'], activeField: 'active',
    autoKey: true, protectedCatalogue: true
  },
  genomicMarkers: {
    definition: definition(
      'genomicMarkers', 'Genomic AMR markers',
      'Genotypic resistance determinants, molecular assays and typing outputs available to AST panels and isolate entry.',
      'master_genomic_markers', 'code',
      [
        text('code', 'Code', true), text('name', 'Marker', true),
        { key: 'marker_type', label: 'Marker type', type: 'select', options: MARKER_TYPE_OPTIONS },
        text('gene_symbol', 'Gene / locus'), text('mechanism_class', 'Mechanism'),
        text('organism_scope', 'Organism scope'), textarea('predicted_resistance', 'Predicted resistance'),
        text('linked_antibiotic_codes', 'Linked antibiotic codes'),
        { key: 'default_method', label: 'Default method', type: 'select', options: MARKER_METHOD_OPTIONS },
        text('reporting_standard', 'Reporting standard / source'), bool('who_priority', 'WHO priority'),
        bool('active', 'Active'), number('sort_order', 'Sort order')
      ]
    ),
    columns: ['code', 'name', 'marker_type', 'gene_symbol', 'mechanism_class', 'organism_scope',
      'predicted_resistance', 'linked_antibiotic_codes', 'default_method', 'reporting_standard', 'who_priority',
      'active', 'is_custom', 'source_dataset', 'source_version', 'user_modified', 'sort_order'],
    searchColumns: ['code', 'name', 'gene_symbol', 'mechanism_class', 'organism_scope'],
    activeField: 'active'
  },
  codeValues: {
    definition: definition(
      'codeValues', 'Coded values', 'Configurable lookup values used by structured fields and exchange formats.',
      'whonet_code_values', 'id',
      [number('id', 'ID'), text('code_set', 'Code set', true), text('code', 'Code', true),
        text('description', 'Description'), text('display_label', 'Display label'),
        keyValue('metadata_json', 'Metadata', 'Exchange attributes carried with this coded value, such as ISO or WHO region codes.'),
        bool('active', 'Active'), number('sort_order', 'Sort order')]
    ),
    columns: ['id', 'code_set', 'code', 'description', 'display_label', 'metadata_json', 'sort_order', 'active', 'is_custom'],
    searchColumns: ['code_set', 'code', 'description', 'display_label'], activeField: 'active', autoKey: true,
    jsonColumns: ['metadata_json'], protectedCatalogue: true
  }
}

const MASTER_KINDS = Object.freeze(Object.keys(MASTER_SPECS) as MasterKind[])

const ISOLATE_COLUMNS = Object.freeze([
  'lab_code', 'data_file', 'patient_id', 'last_name', 'first_name', 'sex', 'dob', 'age_years', 'location',
  'location_type', 'department', 'institution', 'admission_date', 'patient_type', 'ward_type', 'specimen_number',
  'specimen_date', 'specimen_type', 'specimen_system', 'specimen_code', 'organism', 'organism_system',
  'organism_code', 'diagnosis_system', 'diagnosis_code', 'diagnosis_display', 'antibiotic_panel', 'ast_method',
  'antibiotic_panel_source_key', 'ast_not_performed_reason', 'antibiotic_results', 'alerts', 'expert_comments',
  'patient_residence_json', 'animal_species', 'animal_type', 'market_category', 'specimen_reason',
  'serotype', 'food_category', 'vaccination_status', 'pcr_result', 'reception_date', 'dd_test_date', 'notes',
  'domain', 'hospital_code', 'hospital_name', 'custom_fields_json', 'record_status',
  'identification_method', 'identification_score', 'genomic_results'
])

const LAB_COLUMNS = Object.freeze([
  'code', 'name', 'country', 'country_code', 'admin_unit_id', 'admin_path', 'timezone',
  'address_json', 'site_group',
  'use_dynamic_breakpoints', 'round_half_dilutions', 'use_intrinsic_resistance_rules', 'guideline_year',
  'breakpoint_types', 'sites_of_infection', 'default_guideline', 'default_test_method', 'enabled_expert_rules',
  'conditional_antibiotic_reporting', 'print_clinical_message', 'active'
])

const LAB_IDENTITY_COLUMNS = Object.freeze([
  'code', 'name', 'country', 'country_code', 'admin_unit_id', 'admin_path', 'timezone',
  'address_json', 'site_group', 'active'
])

const LAB_CONFIGURATION_COLUMNS = Object.freeze([
  'use_dynamic_breakpoints', 'round_half_dilutions', 'use_intrinsic_resistance_rules', 'guideline_year',
  'breakpoint_types', 'sites_of_infection', 'default_guideline', 'default_test_method', 'enabled_expert_rules',
  'conditional_antibiotic_reporting', 'print_clinical_message'
])

const BOOLEAN_COLUMNS = new Set([
  'active', 'is_custom', 'user_modified', 'human_flag', 'veterinary_flag', 'is_union_territory', 'is_enabled',
  'is_hidden', 'include_in_listing', 'no_routine_ast', 'enabled_by_default', 'common_commensal', 'anaerobe',
  'use_dynamic_breakpoints', 'round_half_dilutions', 'use_intrinsic_resistance_rules',
  'conditional_antibiotic_reporting', 'print_clinical_message'
])

const BREAKPOINT_CLINICAL_COLUMNS = [
  'guidelines', 'year', 'test_method', 'potency', 'organism_code', 'organism_code_type',
  'breakpoint_type', 'host', 'site_of_infection', 'route', 'whonet_abx_code', 'whonet_test',
  'r_value', 'i_value', 'sdd_value', 's_value', 'ecv_ecoff'
] as const

const CORE_SCHEMA = String.raw`
CREATE TABLE IF NOT EXISTS app_schema_migrations(
  version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS app_catalog_seed_state(
  dataset TEXT PRIMARY KEY, source_version TEXT NOT NULL, source_hash TEXT NOT NULL,
  source_path TEXT NOT NULL, row_counts_json TEXT NOT NULL, seeded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- address_json is a structured postal address on the ISO 19160-1 field set; see
-- src/shared/address.ts. It answers "where is the building", which is a different question
-- from admin_unit_id's "which reporting unit is this under", and the two are stored apart
-- because a facility's postal town and its reporting district often differ.
CREATE TABLE IF NOT EXISTS laboratory(
  code TEXT PRIMARY KEY, name TEXT NOT NULL, country TEXT, address_json TEXT, site_group TEXT,
  use_dynamic_breakpoints INTEGER NOT NULL DEFAULT 1, round_half_dilutions INTEGER NOT NULL DEFAULT 1,
  use_intrinsic_resistance_rules INTEGER NOT NULL DEFAULT 1, guideline_year TEXT, breakpoint_types TEXT,
  sites_of_infection TEXT, default_guideline TEXT, default_test_method TEXT, enabled_expert_rules TEXT,
  conditional_antibiotic_reporting INTEGER NOT NULL DEFAULT 0, print_clinical_message INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
-- Country-neutral administrative hierarchy of arbitrary depth: one row per unit, at
-- whatever levels the country's profile defines. admin_path is the materialised path of
-- codes ('IND/28/583') so every scope filter is an ASCII prefix match rather than a
-- case-insensitive name comparison.
-- postal_code holds the codes this unit covers: one code, a comma-separated list, or a
-- prefix such as "682" that stands for every code beginning with it. It is what lets an
-- address resolve to a reporting unit in a country with no bundled postal directory, and
-- what a facility form checks the derived placement against.
CREATE TABLE IF NOT EXISTS master_admin_units(
  id TEXT PRIMARY KEY, country_code TEXT NOT NULL, level INTEGER NOT NULL, parent_id TEXT,
  code TEXT NOT NULL, code_system TEXT NOT NULL DEFAULT 'ISO3166-2', name TEXT NOT NULL,
  name_local TEXT, unit_type TEXT, admin_path TEXT NOT NULL, postal_code TEXT,
  active INTEGER NOT NULL DEFAULT 1, is_custom INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0, metadata_json TEXT NOT NULL DEFAULT '{}',
  source_dataset TEXT, source_version TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(parent_id) REFERENCES master_admin_units(id)
);
CREATE TABLE IF NOT EXISTS master_antibiotics(
  code TEXT PRIMARY KEY, name TEXT NOT NULL, who_group TEXT, template_name TEXT, who_code TEXT, din_code TEXT,
  jac_code TEXT, eucast_code TEXT, user_code TEXT, guidelines TEXT, potency TEXT, atc_code TEXT, class_name TEXT,
  subclass_name TEXT, prof_class TEXT, who_aware TEXT, human_flag INTEGER NOT NULL DEFAULT 1,
  veterinary_flag INTEGER NOT NULL DEFAULT 0, loinc_sbt TEXT, loinc_mlc TEXT, comments TEXT,
  active INTEGER NOT NULL DEFAULT 1, is_custom INTEGER NOT NULL DEFAULT 0, source_dataset TEXT, source_version TEXT,
  user_modified INTEGER NOT NULL DEFAULT 0, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS master_location_types(
  code TEXT PRIMARY KEY, label TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS master_lab_domains(
  code TEXT PRIMARY KEY, label TEXT NOT NULL, description TEXT, colour TEXT,
  active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS master_organisms(
  code TEXT PRIMARY KEY, organism_name TEXT NOT NULL, system TEXT, concept_code TEXT, replacement_code TEXT,
  taxonomic_status TEXT, common_name TEXT, common_commensal INTEGER NOT NULL DEFAULT 0, organism_type TEXT,
  anaerobe INTEGER NOT NULL DEFAULT 0, snomed_code TEXT, snomed_text TEXT, gbif_taxon_id TEXT, kingdom TEXT,
  phylum_name TEXT, class_name TEXT, order_name TEXT, family_name TEXT, genus_name TEXT,
  active INTEGER NOT NULL DEFAULT 1, is_custom INTEGER NOT NULL DEFAULT 0, source_dataset TEXT, source_version TEXT,
  user_modified INTEGER NOT NULL DEFAULT 0, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS master_samples(
  code TEXT PRIMARY KEY, name TEXT NOT NULL, parent_code TEXT, system TEXT, concept_code TEXT,
  active INTEGER NOT NULL DEFAULT 1, is_custom INTEGER NOT NULL DEFAULT 0, source_dataset TEXT, source_version TEXT,
  user_modified INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(parent_code) REFERENCES master_samples(code)
);
CREATE TABLE IF NOT EXISTS master_sample_aliases(
  normalized_alias TEXT PRIMARY KEY, alias_text TEXT NOT NULL, sample_code TEXT NOT NULL,
  source_dataset TEXT, source_version TEXT, active INTEGER NOT NULL DEFAULT 1, user_modified INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(sample_code) REFERENCES master_samples(code)
);
CREATE TABLE IF NOT EXISTS master_hospitals(
  code TEXT PRIMARY KEY, name TEXT NOT NULL, facility_type TEXT, domain_code TEXT, parent_code TEXT,
  admin_unit_id TEXT, admin_path TEXT, address_json TEXT, contact TEXT, active INTEGER NOT NULL DEFAULT 1,
  is_custom INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0, metadata_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(domain_code) REFERENCES master_lab_domains(code), FOREIGN KEY(parent_code) REFERENCES master_hospitals(code)
);
CREATE TABLE IF NOT EXISTS lab_antibiotics(
  lab_code TEXT NOT NULL, antibiotic_code TEXT NOT NULL, antibiotic_name TEXT NOT NULL,
  FOREIGN KEY(lab_code) REFERENCES laboratory(code)
);
CREATE TABLE IF NOT EXISTS lab_locations(
  lab_code TEXT NOT NULL, location_name TEXT NOT NULL, location_code TEXT, department TEXT, institution TEXT,
  location_type TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, is_custom INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0, FOREIGN KEY(lab_code) REFERENCES laboratory(code)
);
CREATE TABLE IF NOT EXISTS lab_alerts(
  lab_code TEXT NOT NULL, alert_key TEXT NOT NULL, FOREIGN KEY(lab_code) REFERENCES laboratory(code)
);
CREATE TABLE IF NOT EXISTS lab_custom_alerts(
  id INTEGER PRIMARY KEY AUTOINCREMENT, lab_code TEXT NOT NULL, rule_name TEXT NOT NULL, organism_code TEXT,
  organism_name TEXT NOT NULL, antibiotic_code TEXT NOT NULL, antibiotic_name TEXT NOT NULL,
  trigger_results TEXT NOT NULL DEFAULT 'R', category TEXT NOT NULL DEFAULT 'microbiological',
  alert_type TEXT NOT NULL DEFAULT 'important_resistance', priority TEXT NOT NULL DEFAULT 'medium', message TEXT,
  active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0, FOREIGN KEY(lab_code) REFERENCES laboratory(code)
);
CREATE TABLE IF NOT EXISTS lab_domains(
  lab_code TEXT NOT NULL, domain_code TEXT NOT NULL, FOREIGN KEY(lab_code) REFERENCES laboratory(code)
);
CREATE TABLE IF NOT EXISTS lab_organisms(
  lab_code TEXT NOT NULL, organism_code TEXT NOT NULL, organism_name TEXT NOT NULL,
  FOREIGN KEY(lab_code) REFERENCES laboratory(code)
);
CREATE TABLE IF NOT EXISTS lab_antibiotic_settings(
  lab_code TEXT NOT NULL, antibiotic_code TEXT NOT NULL, guideline TEXT NOT NULL DEFAULT 'CLSI',
  test_method TEXT NOT NULL DEFAULT 'Disk diffusion', disk_potency TEXT, test_code TEXT,
  include_in_profile INTEGER NOT NULL DEFAULT 0, breakpoint_scope TEXT NOT NULL DEFAULT 'General',
  breakpoint_notes TEXT, sort_order INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(lab_code, antibiotic_code),
  FOREIGN KEY(lab_code) REFERENCES laboratory(code)
);
CREATE TABLE IF NOT EXISTS lab_data_fields(
  lab_code TEXT NOT NULL, field_key TEXT NOT NULL, field_label TEXT NOT NULL, category TEXT NOT NULL,
  field_group TEXT NOT NULL, field_length INTEGER NOT NULL DEFAULT 20, is_enabled INTEGER NOT NULL DEFAULT 1,
  is_hidden INTEGER NOT NULL DEFAULT 0, include_in_listing INTEGER NOT NULL DEFAULT 0, applicable_domains TEXT,
  response_codes TEXT, is_custom INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(lab_code, field_key), FOREIGN KEY(lab_code) REFERENCES laboratory(code)
);
CREATE TABLE IF NOT EXISTS lab_panels(
  id INTEGER PRIMARY KEY AUTOINCREMENT, lab_code TEXT NOT NULL, panel_name TEXT NOT NULL, description TEXT,
  source_row_key TEXT, source_dataset TEXT, source_version TEXT, source_context TEXT, source_text TEXT,
  no_routine_ast INTEGER NOT NULL DEFAULT 0, guidance_json TEXT, group_metadata_json TEXT,
  priority INTEGER NOT NULL DEFAULT 100, active INTEGER NOT NULL DEFAULT 1, user_modified INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(lab_code) REFERENCES laboratory(code)
);
CREATE TABLE IF NOT EXISTS lab_catalog_seed_state(
  lab_code TEXT NOT NULL, source_dataset TEXT NOT NULL, source_version TEXT, seeded_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(lab_code, source_dataset),
  FOREIGN KEY(lab_code) REFERENCES laboratory(code)
);
CREATE TABLE IF NOT EXISTS lab_panel_organisms(
  panel_id INTEGER NOT NULL, organism_code TEXT NOT NULL, organism_name TEXT NOT NULL,
  FOREIGN KEY(panel_id) REFERENCES lab_panels(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS lab_panel_specimens(
  panel_id INTEGER NOT NULL, specimen_code TEXT, specimen_name TEXT NOT NULL, specimen_system TEXT,
  FOREIGN KEY(panel_id) REFERENCES lab_panels(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS lab_panel_antibiotics(
  panel_id INTEGER NOT NULL, antibiotic_code TEXT NOT NULL, antibiotic_name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0, option_group TEXT, requirement_type TEXT NOT NULL DEFAULT 'core', notes TEXT,
  source_text TEXT, FOREIGN KEY(panel_id) REFERENCES lab_panels(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS isolates(
  id INTEGER PRIMARY KEY AUTOINCREMENT, lab_code TEXT, data_file TEXT, patient_id TEXT, last_name TEXT, first_name TEXT,
  sex TEXT, dob TEXT, age_years INTEGER, location TEXT, location_type TEXT, department TEXT, institution TEXT,
  admission_date TEXT, patient_type TEXT, ward_type TEXT, specimen_number TEXT, specimen_date TEXT, specimen_type TEXT,
  specimen_system TEXT, specimen_code TEXT, organism TEXT, organism_system TEXT, organism_code TEXT,
  diagnosis_system TEXT, diagnosis_code TEXT, diagnosis_display TEXT, antibiotic_panel TEXT, ast_method TEXT,
  antibiotic_panel_source_key TEXT, ast_not_performed_reason TEXT, antibiotic_results TEXT, alerts TEXT,
  expert_comments TEXT, patient_residence_json TEXT, animal_species TEXT, animal_type TEXT,
  market_category TEXT, specimen_reason TEXT, serotype TEXT, food_category TEXT, vaccination_status TEXT, pcr_result TEXT,
  reception_date TEXT, dd_test_date TEXT, notes TEXT, record_status TEXT DEFAULT 'final',
  domain TEXT, hospital_code TEXT, hospital_name TEXT, custom_fields_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(lab_code) REFERENCES laboratory(code)
);
CREATE TABLE IF NOT EXISTS isolate_ast_results(
  isolate_id INTEGER NOT NULL, antibiotic_code TEXT NOT NULL, result TEXT, measurement TEXT, method TEXT,
  guideline TEXT, potency TEXT, source TEXT, PRIMARY KEY(isolate_id, antibiotic_code),
  FOREIGN KEY(isolate_id) REFERENCES isolates(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS master_genomic_markers(
  code TEXT PRIMARY KEY, name TEXT NOT NULL, marker_type TEXT NOT NULL DEFAULT 'gene', gene_symbol TEXT,
  mechanism_class TEXT, organism_scope TEXT, predicted_resistance TEXT, linked_antibiotic_codes TEXT,
  default_method TEXT, reporting_standard TEXT, who_priority INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1, is_custom INTEGER NOT NULL DEFAULT 0, source_dataset TEXT,
  source_version TEXT, user_modified INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS lab_panel_genomic_markers(
  panel_id INTEGER NOT NULL, marker_code TEXT NOT NULL, marker_name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0, requirement_type TEXT NOT NULL DEFAULT 'core', method TEXT, notes TEXT,
  FOREIGN KEY(panel_id) REFERENCES lab_panels(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS isolate_genomic_results(
  isolate_id INTEGER NOT NULL, marker_code TEXT NOT NULL, result TEXT, method TEXT, target TEXT,
  interpretation TEXT, PRIMARY KEY(isolate_id, marker_code),
  FOREIGN KEY(isolate_id) REFERENCES isolates(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS isolate_omics(
  id INTEGER PRIMARY KEY AUTOINCREMENT, isolate_id INTEGER NOT NULL, lab_code TEXT,
  omics_type TEXT NOT NULL, platform TEXT, file_name TEXT, stored_path TEXT, source_path TEXT,
  file_format TEXT, file_size INTEGER NOT NULL DEFAULT 0, sha256 TEXT,
  storage_mode TEXT NOT NULL DEFAULT 'linked', accession TEXT, repository TEXT, analysis_tool TEXT,
  tool_version TEXT, database_version TEXT, quality_metrics TEXT, result_summary TEXT, notes TEXT,
  recorded_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(isolate_id) REFERENCES isolates(id) ON DELETE CASCADE
);
-- Phase 26. Messages that arrived over the inbound listener and could not be filed.
--
-- The payload is stored verbatim, not as a parsed summary, because the reviewer's job is to
-- work out what the sender meant and a summary is this node's interpretation of exactly the
-- thing that could not be interpreted. reasons_json holds every reason at once, so a
-- reviewer fixes all of them in one pass rather than discovering the next on each resend.
--
-- This is local-node patient data like the isolates table. It never reaches the outbox:
-- the outbox is built from aggregates by a separate path, and nothing here writes to it.
CREATE TABLE IF NOT EXISTS inbound_quarantine(
  id INTEGER PRIMARY KEY AUTOINCREMENT, lab_code TEXT NOT NULL, transport TEXT NOT NULL,
  control_id TEXT, payload TEXT NOT NULL, reasons_json TEXT NOT NULL DEFAULT '[]',
  patient_id TEXT, specimen_number TEXT, specimen_date TEXT, received_from TEXT,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, status TEXT NOT NULL DEFAULT 'held',
  resolved_at TEXT, resolved_note TEXT,
  FOREIGN KEY(lab_code) REFERENCES laboratory(code)
);
CREATE TABLE IF NOT EXISTS import_profiles(
  id INTEGER PRIMARY KEY AUTOINCREMENT, lab_code TEXT NOT NULL, profile_name TEXT NOT NULL,
  source_kind TEXT NOT NULL DEFAULT 'delimited', delimiter TEXT NOT NULL DEFAULT ',', has_header INTEGER NOT NULL DEFAULT 1,
  core_mapping TEXT NOT NULL DEFAULT '{}', antibiotic_mapping TEXT NOT NULL DEFAULT '{}',
  default_values TEXT NOT NULL DEFAULT '{}', notes TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(lab_code, profile_name), FOREIGN KEY(lab_code) REFERENCES laboratory(code)
);
CREATE TABLE IF NOT EXISTS import_runs(
  id INTEGER PRIMARY KEY AUTOINCREMENT, lab_code TEXT NOT NULL, profile_id INTEGER, source_path TEXT,
  imported_rows INTEGER NOT NULL DEFAULT 0, draft_rows INTEGER NOT NULL DEFAULT 0, failed_rows INTEGER NOT NULL DEFAULT 0,
  notes TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(lab_code) REFERENCES laboratory(code),
  FOREIGN KEY(profile_id) REFERENCES import_profiles(id)
);
CREATE TABLE IF NOT EXISTS analysis_macros(
  id INTEGER PRIMARY KEY AUTOINCREMENT, lab_code TEXT NOT NULL, macro_name TEXT NOT NULL, config_json TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(lab_code, macro_name), FOREIGN KEY(lab_code) REFERENCES laboratory(code)
);
CREATE TABLE IF NOT EXISTS app_preferences(pref_key TEXT PRIMARY KEY, pref_value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS whonet_resource_imports(
  dataset_name TEXT PRIMARY KEY, source_path TEXT NOT NULL, source_size INTEGER NOT NULL, source_mtime REAL NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0, imported_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS whonet_code_values(
  id INTEGER PRIMARY KEY AUTOINCREMENT, code_set TEXT NOT NULL, code TEXT NOT NULL, description TEXT,
  display_label TEXT, metadata_json TEXT NOT NULL DEFAULT '{}', sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1, is_custom INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS whonet_field_definitions(
  id INTEGER PRIMARY KEY AUTOINCREMENT, module_name TEXT, field_desc TEXT, field_name TEXT, field_length TEXT,
  field_type TEXT, section_name TEXT, code_file TEXT, code_field TEXT, desc_field TEXT,
  isolate_listing INTEGER NOT NULL DEFAULT 0, human INTEGER NOT NULL DEFAULT 0, animal INTEGER NOT NULL DEFAULT 0,
  food INTEGER NOT NULL DEFAULT 0, feed INTEGER NOT NULL DEFAULT 0, plant INTEGER NOT NULL DEFAULT 0,
  environment INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS whonet_mic_panels(
  id INTEGER PRIMARY KEY AUTOINCREMENT, panel_name TEXT NOT NULL, antibiotic_name TEXT, antibiotic_code TEXT,
  minimum_value TEXT, maximum_value TEXT, sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS whonet_resource_config(config_key TEXT PRIMARY KEY, config_value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS master_breakpoint_sets(
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, organization TEXT NOT NULL, edition TEXT, year TEXT,
  effective_date TEXT, source_url TEXT, source_hash TEXT, source_import_id INTEGER, active INTEGER NOT NULL DEFAULT 0,
  notes TEXT, unmatched_count INTEGER NOT NULL DEFAULT 0, validation_status TEXT NOT NULL DEFAULT 'ready',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(organization, edition, name)
);
CREATE TABLE IF NOT EXISTS breakpoint_imports(
  id INTEGER PRIMARY KEY AUTOINCREMENT, breakpoint_set_id INTEGER, source_name TEXT NOT NULL, source_path TEXT,
  source_url TEXT, source_hash TEXT NOT NULL, source_format TEXT, row_count INTEGER NOT NULL DEFAULT 0,
  imported_rows INTEGER NOT NULL DEFAULT 0, skipped_rows INTEGER NOT NULL DEFAULT 0, errors_json TEXT NOT NULL DEFAULT '[]',
  warnings_json TEXT NOT NULL DEFAULT '[]', unmatched_rows INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'staged',
  mapping_version INTEGER NOT NULL DEFAULT 1, imported_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(breakpoint_set_id) REFERENCES master_breakpoint_sets(id)
);
CREATE TABLE IF NOT EXISTS whonet_breakpoints(
  id INTEGER PRIMARY KEY AUTOINCREMENT, guidelines TEXT, year TEXT, test_method TEXT, potency TEXT,
  organism_code TEXT, organism_code_type TEXT, breakpoint_type TEXT, host TEXT, site_of_infection TEXT,
  whonet_abx_code TEXT, whonet_test TEXT, r_value TEXT, i_value TEXT, sdd_value TEXT, s_value TEXT,
  ecv_ecoff TEXT, ecv_ecoff_tentative TEXT, comments TEXT, active INTEGER NOT NULL DEFAULT 1,
  source_set_id INTEGER, source_import_id INTEGER
);
CREATE TABLE IF NOT EXISTS whonet_qc_ranges(
  id INTEGER PRIMARY KEY AUTOINCREMENT, guideline TEXT, year TEXT, strain TEXT, reference_table TEXT,
  whonet_org_code TEXT, antibiotic TEXT, abx_test TEXT, whonet_abx_code TEXT, method TEXT, medium TEXT,
  minimum TEXT, maximum TEXT, comments TEXT, active INTEGER NOT NULL DEFAULT 1, is_custom INTEGER NOT NULL DEFAULT 0,
  source_set_id INTEGER
);
CREATE TABLE IF NOT EXISTS whonet_expected_resistance(
  id INTEGER PRIMARY KEY AUTOINCREMENT, guideline TEXT, reference_table TEXT, organism_code TEXT,
  organism_code_type TEXT, exception_organism_code TEXT, exception_organism_code_type TEXT, abx_code TEXT,
  abx_code_type TEXT, antibiotic_exceptions TEXT, comments TEXT, active INTEGER NOT NULL DEFAULT 1,
  is_custom INTEGER NOT NULL DEFAULT 0, source_set_id INTEGER
);
CREATE TABLE IF NOT EXISTS whonet_expert_rules(
  id INTEGER PRIMARY KEY AUTOINCREMENT, rule_code TEXT, description TEXT, organism_code TEXT,
  organism_code_type TEXT, rule_criteria TEXT, affected_antibiotics TEXT, antibiotic_exceptions TEXT,
  enabled_by_default INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
  is_custom INTEGER NOT NULL DEFAULT 0, source_set_id INTEGER
);
CREATE TABLE IF NOT EXISTS whonet_user_breakpoints(
  id INTEGER PRIMARY KEY AUTOINCREMENT, guidelines TEXT, year TEXT, test_method TEXT, potency TEXT,
  organism_code TEXT, organism_code_type TEXT, breakpoint_type TEXT, host TEXT, site_of_infection TEXT,
  route TEXT, whonet_abx_code TEXT, whonet_test TEXT, r_value TEXT, i_value TEXT, sdd_value TEXT, s_value TEXT,
  ecv_ecoff TEXT, comments TEXT, active INTEGER NOT NULL DEFAULT 1, is_custom INTEGER NOT NULL DEFAULT 1,
  source_set_id INTEGER, source_import_id INTEGER
);
CREATE TABLE IF NOT EXISTS app_audit_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  operation TEXT NOT NULL, status TEXT NOT NULL, summary TEXT NOT NULL, details TEXT, actor TEXT NOT NULL DEFAULT 'local-operator'
);
CREATE TABLE IF NOT EXISTS national_schema_version(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS national_users(
  id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, roles_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, last_login_at TEXT
);
-- admin_path holds the event's place as a materialised path of codes ('IND/28/583'), and
-- admin_codes_json the same chain with each level's code system. Levels are numbered, not
-- named, so a country with one sub-national level and one with five use the same columns.
CREATE TABLE IF NOT EXISTS national_events(
  id TEXT PRIMARY KEY, schema_version TEXT NOT NULL, module_key TEXT NOT NULL, event_type TEXT NOT NULL,
  purpose TEXT NOT NULL, facility_id TEXT NOT NULL, country_code TEXT, admin_path TEXT,
  admin_codes_json TEXT NOT NULL DEFAULT '[]', observed_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL, actor TEXT NOT NULL, payload_json TEXT NOT NULL, quality_status TEXT NOT NULL DEFAULT 'draft',
  sensitivity TEXT NOT NULL DEFAULT 'restricted', record_version INTEGER NOT NULL DEFAULT 1,
  supersedes_id TEXT, deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS national_actions(
  id TEXT PRIMARY KEY, event_id TEXT, title TEXT NOT NULL, owner TEXT, due_at TEXT, priority TEXT NOT NULL,
  status TEXT NOT NULL, evidence_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY(event_id) REFERENCES national_events(id)
);
CREATE TABLE IF NOT EXISTS national_alerts(
  id TEXT PRIMARY KEY, event_id TEXT, rule_code TEXT NOT NULL, severity TEXT NOT NULL, status TEXT NOT NULL,
  message TEXT NOT NULL, created_at TEXT NOT NULL, reviewed_by TEXT, reviewed_at TEXT,
  FOREIGN KEY(event_id) REFERENCES national_events(id)
);
CREATE TABLE IF NOT EXISTS national_outbox(
  id TEXT PRIMARY KEY, aggregate_key TEXT NOT NULL, payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT,
  created_at TEXT NOT NULL, sent_at TEXT, last_error TEXT, UNIQUE(aggregate_key, payload_hash)
);
CREATE TABLE IF NOT EXISTS national_audit_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
  object_type TEXT NOT NULL, object_id TEXT NOT NULL, details_json TEXT NOT NULL, previous_hash TEXT, entry_hash TEXT NOT NULL,
  -- The chain hashes this digest rather than the details themselves, so the details can be
  -- erased on request while the chain stays verifiable. See eraseAuditDetails.
  details_digest TEXT, erased_at TEXT, erasure_reason TEXT
);
CREATE TABLE IF NOT EXISTS national_terminology_packages(
  id TEXT PRIMARY KEY, package_type TEXT NOT NULL, version TEXT NOT NULL, sha256 TEXT NOT NULL, signature TEXT,
  installed_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0, payload_json TEXT NOT NULL, UNIQUE(package_type, version)
);
CREATE TABLE IF NOT EXISTS national_device_health(
  id TEXT PRIMARY KEY, captured_at TEXT NOT NULL, app_version TEXT, schema_version INTEGER NOT NULL,
  pending_outbox INTEGER NOT NULL, last_sync_at TEXT, status TEXT NOT NULL, details_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS concepts(
  system TEXT NOT NULL, code TEXT NOT NULL, display TEXT NOT NULL, synonyms_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}', active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(system, code)
);
CREATE TABLE IF NOT EXISTS ncbi_taxonomy(
  tax_id TEXT PRIMARY KEY, scientific_name TEXT NOT NULL, rank TEXT, parent_tax_id TEXT, metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS terminology_imports(
  id INTEGER PRIMARY KEY AUTOINCREMENT, source_name TEXT NOT NULL, source_hash TEXT NOT NULL, row_count INTEGER NOT NULL DEFAULT 0,
  imported_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`

const LEGACY_COLUMNS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  laboratory: {
    country: 'TEXT', country_code: 'TEXT', admin_unit_id: 'TEXT', admin_path: 'TEXT', timezone: 'TEXT',
    address_json: 'TEXT',
    site_group: 'TEXT', use_dynamic_breakpoints: 'INTEGER NOT NULL DEFAULT 1',
    round_half_dilutions: 'INTEGER NOT NULL DEFAULT 1', use_intrinsic_resistance_rules: 'INTEGER NOT NULL DEFAULT 1',
    guideline_year: 'TEXT', breakpoint_types: 'TEXT', sites_of_infection: 'TEXT', default_guideline: 'TEXT',
    default_test_method: 'TEXT', enabled_expert_rules: 'TEXT', conditional_antibiotic_reporting: 'INTEGER NOT NULL DEFAULT 0',
    print_clinical_message: 'INTEGER NOT NULL DEFAULT 0', active: 'INTEGER NOT NULL DEFAULT 1', updated_at: 'TEXT'
  },
  master_hospitals: { admin_unit_id: 'TEXT', admin_path: 'TEXT', address_json: 'TEXT' },
  master_admin_units: { postal_code: 'TEXT' },
  national_events: { country_code: 'TEXT', admin_path: 'TEXT', admin_codes_json: "TEXT NOT NULL DEFAULT '[]'" },
  // Lets an audit entry keep proving what it covered after its details are erased.
  national_audit_log: { details_digest: 'TEXT', erased_at: 'TEXT', erasure_reason: 'TEXT' },
  isolates: Object.fromEntries(ISOLATE_COLUMNS.filter((column) => column !== 'lab_code').map((column) => [column,
    ['age_years'].includes(column) ? 'INTEGER' : column === 'record_status' ? "TEXT DEFAULT 'final'" : 'TEXT'])) as Record<string, string>,
  master_antibiotics: {
    who_group: 'TEXT', template_name: 'TEXT', who_code: 'TEXT', din_code: 'TEXT', jac_code: 'TEXT', eucast_code: 'TEXT',
    user_code: 'TEXT', guidelines: 'TEXT', potency: 'TEXT', atc_code: 'TEXT', class_name: 'TEXT', subclass_name: 'TEXT',
    prof_class: 'TEXT', who_aware: 'TEXT', human_flag: 'INTEGER NOT NULL DEFAULT 1',
    veterinary_flag: 'INTEGER NOT NULL DEFAULT 0', loinc_sbt: 'TEXT', loinc_mlc: 'TEXT', comments: 'TEXT',
    active: 'INTEGER NOT NULL DEFAULT 1', is_custom: 'INTEGER NOT NULL DEFAULT 0', source_dataset: 'TEXT', source_version: 'TEXT',
    user_modified: 'INTEGER NOT NULL DEFAULT 0', updated_at: 'TEXT', sort_order: 'INTEGER NOT NULL DEFAULT 0'
  },
  master_organisms: {
    system: 'TEXT', concept_code: 'TEXT', replacement_code: 'TEXT', taxonomic_status: 'TEXT', common_name: 'TEXT',
    common_commensal: 'INTEGER NOT NULL DEFAULT 0', organism_type: 'TEXT', anaerobe: 'INTEGER NOT NULL DEFAULT 0',
    snomed_code: 'TEXT', snomed_text: 'TEXT', gbif_taxon_id: 'TEXT', kingdom: 'TEXT', phylum_name: 'TEXT',
    class_name: 'TEXT', order_name: 'TEXT', family_name: 'TEXT', genus_name: 'TEXT', active: 'INTEGER NOT NULL DEFAULT 1',
    is_custom: 'INTEGER NOT NULL DEFAULT 0', source_dataset: 'TEXT', source_version: 'TEXT',
    user_modified: 'INTEGER NOT NULL DEFAULT 0', updated_at: 'TEXT', sort_order: 'INTEGER NOT NULL DEFAULT 0'
  },
  master_lab_domains: { description: 'TEXT', colour: 'TEXT', active: 'INTEGER NOT NULL DEFAULT 1', sort_order: 'INTEGER NOT NULL DEFAULT 0' },
  master_sample_aliases: { active: 'INTEGER NOT NULL DEFAULT 1', user_modified: 'INTEGER NOT NULL DEFAULT 0' },
  lab_locations: {
    location_code: 'TEXT', department: 'TEXT', institution: 'TEXT', active: 'INTEGER NOT NULL DEFAULT 1',
    is_custom: 'INTEGER NOT NULL DEFAULT 1', sort_order: 'INTEGER NOT NULL DEFAULT 0'
  },
  lab_panels: {
    source_row_key: 'TEXT', source_dataset: 'TEXT', source_version: 'TEXT', source_context: 'TEXT', source_text: 'TEXT',
    no_routine_ast: 'INTEGER NOT NULL DEFAULT 0', guidance_json: 'TEXT', group_metadata_json: 'TEXT',
    priority: 'INTEGER NOT NULL DEFAULT 100', active: 'INTEGER NOT NULL DEFAULT 1',
    user_modified: 'INTEGER NOT NULL DEFAULT 0', updated_at: 'TEXT'
  },
  lab_panel_antibiotics: {
    sort_order: 'INTEGER NOT NULL DEFAULT 0', option_group: 'TEXT', requirement_type: "TEXT NOT NULL DEFAULT 'core'",
    notes: 'TEXT', source_text: 'TEXT'
  },
  import_profiles: { updated_at: 'TEXT' },
  master_breakpoint_sets: {
    unmatched_count: 'INTEGER NOT NULL DEFAULT 0', validation_status: "TEXT NOT NULL DEFAULT 'ready'"
  },
  breakpoint_imports: {
    warnings_json: "TEXT NOT NULL DEFAULT '[]'", unmatched_rows: 'INTEGER NOT NULL DEFAULT 0',
    mapping_version: 'INTEGER NOT NULL DEFAULT 1'
  },
  whonet_code_values: { active: 'INTEGER NOT NULL DEFAULT 1', is_custom: 'INTEGER NOT NULL DEFAULT 0' },
  whonet_breakpoints: { active: 'INTEGER NOT NULL DEFAULT 1', source_set_id: 'INTEGER', source_import_id: 'INTEGER' },
  whonet_qc_ranges: { active: 'INTEGER NOT NULL DEFAULT 1', is_custom: 'INTEGER NOT NULL DEFAULT 0', source_set_id: 'INTEGER' },
  whonet_expected_resistance: { active: 'INTEGER NOT NULL DEFAULT 1', is_custom: 'INTEGER NOT NULL DEFAULT 0', source_set_id: 'INTEGER' },
  whonet_expert_rules: { active: 'INTEGER NOT NULL DEFAULT 1', is_custom: 'INTEGER NOT NULL DEFAULT 0', source_set_id: 'INTEGER' },
  whonet_user_breakpoints: {
    active: 'INTEGER NOT NULL DEFAULT 1', is_custom: 'INTEGER NOT NULL DEFAULT 1', source_set_id: 'INTEGER',
    source_import_id: 'INTEGER', route: 'TEXT'
  }
}

function asDbRow(value: unknown): DbRow {
  return (value ?? {}) as DbRow
}

function scalar(value: unknown): SqlValue {
  if (value === undefined || value === null) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || value instanceof Uint8Array) return value
  return JSON.stringify(value)
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value !== 'string') return value as T
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function normalKey(value: unknown): string {
  return String(value ?? '').trim().toUpperCase()
}

const GENOMIC_RESULTS = ['detected', 'not_detected', 'indeterminate', 'not_tested'] as const

/** Normalises genotypic marker results to the stored vocabulary, dropping unusable entries. */
function compactGenomic(value: unknown): Record<string, GenomicResult> {
  const parsed = typeof value === 'string' ? parseJson<Record<string, GenomicResult>>(value, {}) : value
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const output: Record<string, GenomicResult> = {}
  for (const [rawCode, rawResult] of Object.entries(parsed as Record<string, unknown>)) {
    if (!rawResult || typeof rawResult !== 'object' || Array.isArray(rawResult)) continue
    const item = rawResult as Record<string, unknown>
    const code = normalKey(item.code ?? rawCode)
    if (!code) continue
    const result = String(item.result ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')
    output[code] = {
      result: (GENOMIC_RESULTS as readonly string[]).includes(result) ? result as GenomicResult['result'] : '',
      method: String(item.method ?? ''), target: String(item.target ?? ''),
      interpretation: String(item.interpretation ?? '')
    }
  }
  return output
}

function normalText(value: unknown): string {
  return String(value ?? '').trim().toLocaleLowerCase()
}

function isoNow(): string {
  return new Date().toISOString()
}

function safeLimit(value: unknown, fallback = 500): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(100_000, Math.trunc(parsed)))
}

function validatedUsername(value: unknown): string {
  const username = String(value ?? '').trim()
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(username)) {
    throw new Error('Username must be 3-64 characters using letters, numbers, dot, underscore or hyphen.')
  }
  return username
}

function validatedPassword(value: unknown): string {
  const password = String(value ?? '')
  if (password.length < 12 || password.length > 1_024) {
    throw new Error('Password must contain 12-1,024 characters.')
  }
  return password
}

function identityActor(identity: OneHealthIdentity): string {
  const username = validatedUsername(identity.username)
  if (!String(identity.id ?? '').trim() || !identity.roles.length) throw new Error('Authenticated One Health identity is invalid.')
  return username
}

function legacyElectronAuditHash(previousHash: string, row: DbRow, details: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify({
    previousHash,
    occurredAt: String(row.occurred_at),
    actor: String(row.actor),
    action: String(row.action),
    objectType: String(row.object_type),
    objectId: String(row.object_id),
    details
  })).digest('hex')
}

export interface AMRITDatabaseOptions {
  /** Enable the PII-free packaged catalogue for a genuinely empty installation. */
  seedCatalog?: boolean
  /** Test/development override; production resolves the electron-builder resource. */
  catalogSeedPath?: string
  /** Test/development override for the packaged genomic-marker reference catalogue. */
  genomicMarkerSeedPath?: string
  /** Test/development override for the starter diagnosis value set. */
  diagnosisCodeSeedPath?: string
}

export class AMRITDatabase {
  readonly databasePath: string
  private readonly db: DatabaseSync
  private readonly decisionSupport: DecisionSupportEngine
  private readonly catalogSeedEnabled: boolean
  private readonly catalogSeedPath?: string
  private readonly genomicMarkerSeedPath: string
  private readonly diagnosisCodeSeedPath: string
  private packagedCatalogue?: PackagedCatalogueAsset
  private initialized = false
  private transactionDepth = 0

  constructor(databasePath: string, options: AMRITDatabaseOptions = {}) {
    if (!String(databasePath ?? '').trim()) throw new Error('A database path is required.')
    this.databasePath = databasePath === ':memory:' ? databasePath : resolve(databasePath)
    if (this.databasePath !== ':memory:') mkdirSync(dirname(this.databasePath), { recursive: true })
    this.db = new DatabaseSync(this.databasePath)
    this.decisionSupport = new DecisionSupportEngine(this.db)
    this.catalogSeedEnabled = options.seedCatalog === true
    this.catalogSeedPath = options.catalogSeedPath
    this.genomicMarkerSeedPath = options.genomicMarkerSeedPath ?? resolveResourcePath(GENOMIC_MARKER_FILENAME)
    this.diagnosisCodeSeedPath = options.diagnosisCodeSeedPath ?? resolveResourcePath(DIAGNOSIS_CODE_FILENAME)
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
  }

  initialize(): this {
    if (this.initialized) return this
    this.migrate()
    this.seedPackagedCatalogue()
    this.seedGeoPack()
    this.seedGenomicMarkers()
    this.seedDiagnosisCodes()
    this.seedMinimumMasters()
    // migrate() lifts an existing database's LGD masters into the admin-unit tree, but a
    // database seeded by an older build has geography only in those legacy tables. Run it
    // again here so both paths end with the same tree; it is a no-op once populated.
    this.transaction(() => this.backfillAdminUnitsFromLgd())
    this.initialized = true
    return this
  }

  close(): void {
    this.db.close()
  }

  private ensureReady(): void {
    if (!this.initialized) this.initialize()
  }

  private transaction<T>(operation: () => T): T {
    if (this.transactionDepth > 0) return operation()
    this.db.exec('BEGIN IMMEDIATE')
    this.transactionDepth += 1
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    } finally {
      this.transactionDepth -= 1
    }
  }

  private tableColumns(table: string): Set<string> {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as DbRow[]
    return new Set(rows.map((row) => String(row.name)))
  }

  private tableExists(table: string): boolean {
    const row = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
    return Boolean(row)
  }

  private ensureLegacyColumns(): void {
    for (const [table, definitions] of Object.entries(LEGACY_COLUMNS)) {
      const columns = this.tableColumns(table)
      for (const [name, sqlType] of Object.entries(definitions)) {
        if (!columns.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${sqlType}`)
      }
    }
    const isolateColumns = this.tableColumns('isolates')
    if (!isolateColumns.has('lab_code')) this.db.exec('ALTER TABLE isolates ADD COLUMN lab_code TEXT')
    if (!isolateColumns.has('created_at')) this.db.exec('ALTER TABLE isolates ADD COLUMN created_at TEXT')
    if (!isolateColumns.has('updated_at')) this.db.exec('ALTER TABLE isolates ADD COLUMN updated_at TEXT')
  }

  private migrate(): void {
    this.transaction(() => {
      this.db.exec(CORE_SCHEMA)
      this.ensureLegacyColumns()
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_inbound_quarantine_status ON inbound_quarantine(lab_code, status, received_at);
        CREATE INDEX IF NOT EXISTS idx_isolates_lab_date ON isolates(lab_code, specimen_date, id);
        CREATE INDEX IF NOT EXISTS idx_isolates_batch_patient ON isolates(lab_code, patient_id);
        CREATE INDEX IF NOT EXISTS idx_isolate_ast_code ON isolate_ast_results(antibiotic_code, result);
        CREATE INDEX IF NOT EXISTS idx_lab_panels_active ON lab_panels(lab_code, active, priority);
        CREATE INDEX IF NOT EXISTS idx_panel_org_code ON lab_panel_organisms(panel_id, organism_code);
        CREATE INDEX IF NOT EXISTS idx_panel_specimen_code ON lab_panel_specimens(panel_id, specimen_code);
        CREATE INDEX IF NOT EXISTS idx_whonet_breakpoints_abx ON whonet_breakpoints(whonet_abx_code);
        CREATE INDEX IF NOT EXISTS idx_whonet_breakpoints_org ON whonet_breakpoints(organism_code);
        CREATE INDEX IF NOT EXISTS idx_whonet_user_breakpoints_abx ON whonet_user_breakpoints(whonet_abx_code);
        CREATE INDEX IF NOT EXISTS idx_whonet_qc_ranges_abx ON whonet_qc_ranges(whonet_abx_code);
        CREATE INDEX IF NOT EXISTS idx_whonet_expected_resistance_abx ON whonet_expected_resistance(abx_code);
        CREATE INDEX IF NOT EXISTS idx_whonet_expert_rules_code ON whonet_expert_rules(rule_code);
        CREATE INDEX IF NOT EXISTS idx_whonet_code_values_set ON whonet_code_values(code_set, code);
        CREATE INDEX IF NOT EXISTS idx_national_events_module_date ON national_events(module_key, observed_at);
        CREATE INDEX IF NOT EXISTS idx_national_events_facility ON national_events(facility_id, module_key);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_unit_key ON master_admin_units(country_code, level, code);
        CREATE INDEX IF NOT EXISTS idx_admin_unit_parent ON master_admin_units(parent_id);
        CREATE INDEX IF NOT EXISTS idx_admin_unit_path ON master_admin_units(admin_path);
      `)
      this.backfillAdminUnitsFromLgd()
      this.retireLegacyGeography()
      this.liftPatientResidence()
      this.db.prepare('INSERT OR IGNORE INTO app_schema_migrations(version, name) VALUES (?, ?)').run(1, 'electron-compatible-core')
      this.db.prepare('INSERT OR IGNORE INTO app_schema_migrations(version, name) VALUES (?, ?)').run(2, 'pii-free-packaged-catalogue')
      this.db.prepare('INSERT OR IGNORE INTO app_schema_migrations(version, name) VALUES (?, ?)').run(3, 'country-neutral-admin-units')
      this.db.prepare('INSERT OR IGNORE INTO app_schema_migrations(version, name) VALUES (?, ?)').run(4, 'universal-postal-address')
      this.db.prepare('INSERT OR IGNORE INTO app_schema_migrations(version, name) VALUES (?, ?)').run(5, 'patient-residence')
      this.db.prepare('INSERT OR IGNORE INTO app_schema_migrations(version, name) VALUES (?, ?)').run(6, 'inbound-quarantine')
      this.db.prepare('INSERT OR IGNORE INTO national_schema_version(version, applied_at) VALUES (?, ?)').run(1, isoNow())
    })
  }

  /**
   * Projects the India LGD state/district masters into the country-neutral tree.
   *
   * Runs only when master_admin_units is empty and the LGD masters are still present and
   * populated, so it is a one-time lift on a database upgrading from before the tree
   * existed, and a no-op on every database created since. `retireLegacyGeography` drops
   * the LGD tables immediately afterwards, so this reads them exactly once.
   */
  private backfillAdminUnitsFromLgd(): void {
    if (!this.tableExists('master_states')) return
    const existing = this.db.prepare('SELECT COUNT(*) AS total FROM master_admin_units').get() as DbRow
    if (Number(existing?.total ?? 0) > 0) return

    const states = this.db.prepare('SELECT * FROM master_states ORDER BY sort_order, lgd_code').all() as DbRow[]
    if (states.length === 0) return

    const districts = this.tableExists('master_districts')
      ? (this.db.prepare('SELECT * FROM master_districts ORDER BY sort_order, lgd_code').all() as DbRow[])
      : []
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO master_admin_units(
        id, country_code, level, parent_id, code, code_system, name, name_local, unit_type,
        admin_path, active, is_custom, sort_order, metadata_json, source_dataset)
      VALUES (?, ?, ?, ?, ?, 'LGD', ?, NULL, ?, ?, ?, 0, ?, '{}', 'lgd-backfill')
    `)

    // Everything in the LGD masters is Indian by construction: master_states.country
    // defaults to 'India' and there has never been a way to enter another country's
    // geography here.
    const countryCode = 'IND'
    const stateIdFor = (lgdCode: string): string => `${countryCode}:1:${lgdCode}`

    for (const state of states) {
      const code = String(state.lgd_code ?? '').trim()
      if (!code) continue
      insert.run(
        stateIdFor(code), countryCode, 1, null, code, String(state.state_name ?? code),
        Number(state.is_union_territory ?? 0) === 1 ? 'union_territory' : 'state',
        `${countryCode}/${code}`, Number(state.active ?? 1), Number(state.sort_order ?? 0)
      )
    }

    const knownStates = new Set(states.map((state) => String(state.lgd_code ?? '').trim()))
    for (const district of districts) {
      const code = String(district.lgd_code ?? '').trim()
      const parentCode = String(district.state_lgd_code ?? '').trim()
      // A district whose state is missing would violate the foreign key. Skipping keeps
      // the migration total rather than aborting the whole upgrade over one orphan row;
      // the LGD table still holds it, so nothing is lost.
      if (!code || !knownStates.has(parentCode)) continue
      insert.run(
        `${countryCode}:2:${code}`, countryCode, 2, stateIdFor(parentCode), code,
        String(district.district_name ?? code), 'district',
        `${countryCode}/${parentCode}/${code}`, Number(district.active ?? 1), Number(district.sort_order ?? 0)
      )
    }
  }

  /**
   * Migration 4 — removes the last India-shaped geography from the database.
   *
   * Until now `laboratory` and `master_hospitals` located a facility with an LGD state code
   * and an LGD district code, and `national_events` carried `state_code`/`district_code`.
   * Those are one country's two administrative levels written into the schema: a country
   * with three sub-national levels could not express the third, and a country with one had
   * a column called "district" it could never fill.
   *
   * Everything moves to the shape that works anywhere:
   *
   *   - the LGD codes become `admin_unit_id` + `admin_path` into the country-neutral tree;
   *   - the level-1 and level-2 *names* and the free-text `address` blob become a
   *     structured postal address, which is a different question and is now stored as one;
   *   - event geography becomes `admin_path` + `admin_codes_json`, numbered by level.
   *
   * Runs once, ordered after `backfillAdminUnitsFromLgd` so the tree exists before anything
   * is linked to it. Every step is guarded on the old column still being present, so it is
   * a no-op on a database created after this migration.
   */
  private retireLegacyGeography(): void {
    const laboratoryColumns = this.tableColumns('laboratory')
    if (laboratoryColumns.has('state_lgd_code')) {
      this.liftFacilityGeography('laboratory', 'code')
      this.dropColumns('laboratory', ['state_lgd_code', 'state_name', 'district_lgd_code', 'district_name'])
    }

    const hospitalColumns = this.tableColumns('master_hospitals')
    if (hospitalColumns.has('state_lgd_code')) {
      this.liftFacilityGeography('master_hospitals', 'code')
      this.dropColumns('master_hospitals', ['state_lgd_code', 'district_lgd_code'])
    }
    if (this.tableColumns('master_hospitals').has('address')) {
      // The old free-text blob becomes the first street line: it is the only field it can
      // honestly become, since no parsing rule for an arbitrary address holds worldwide.
      this.db.prepare(`
        UPDATE master_hospitals
           SET address_json = json_object('country_code', ?, 'address_lines', json_array(address))
         WHERE COALESCE(address, '') <> '' AND COALESCE(address_json, '') = ''
      `).run(this.profileCountryCode())
      this.dropColumns('master_hospitals', ['address'])
    }

    if (this.tableColumns('national_events').has('state_code')) {
      this.liftEventGeography()
      this.dropColumns('national_events', ['state_code', 'district_code'])
    }

    // Dropped last: the lifts above read them. Districts first — it references states.
    for (const table of ['master_districts', 'master_states']) {
      if (this.tableExists(table)) this.db.exec(`DROP TABLE ${table}`)
    }
  }

  /**
   * Migration 5 — a patient's place becomes a structured residence.
   *
   * `patient_state` and `patient_municipality` were two free-text columns named after one
   * country's tiers, and between them they could not record the one geography that exists
   * almost everywhere and is written identically by every clinic in a country: the postal
   * code. They become `patient_residence_json` on the same field set laboratories use,
   * minus the street: `admin_area`, `locality`, `dependent_locality`, `postal_code`.
   *
   * The two old values are the country's level-1 and level-2 names, so they lift into
   * `admin_area` and `locality` unchanged. Nothing is invented — a row that had no
   * geography still has none, and the postal code starts empty until someone records one.
   */
  private liftPatientResidence(): void {
    const columns = this.tableColumns('isolates')
    if (!columns.has('patient_state') && !columns.has('patient_municipality')) return

    const country = this.profileCountryCode()
    const rows = this.db.prepare(
      "SELECT id, patient_state, patient_municipality FROM isolates " +
      "WHERE COALESCE(patient_state, '') <> '' OR COALESCE(patient_municipality, '') <> ''"
    ).all() as DbRow[]
    const update = this.db.prepare(
      "UPDATE isolates SET patient_residence_json = ? WHERE id = ? AND COALESCE(patient_residence_json, '') = ''"
    )
    for (const row of rows) {
      const residence: Record<string, unknown> = { country_code: country }
      const adminArea = String(row.patient_state ?? '').trim()
      const locality = String(row.patient_municipality ?? '').trim()
      if (adminArea) residence.admin_area = adminArea
      if (locality) residence.locality = locality
      update.run(JSON.stringify(residence), Number(row.id ?? 0))
    }
    this.dropColumns('isolates', ['patient_state', 'patient_municipality'])
  }

  /** The deployment's country, for rows that predate any country being recorded. */
  private profileCountryCode(): string {
    return String(activeProfile().country_code || 'ZZZ').toUpperCase()
  }

  /**
   * Links one facility table's LGD codes to the administrative tree and moves the names
   * it was carrying into a structured address.
   *
   * The deepest code present wins, so a facility placed at district level lands on the
   * district and one placed only at state level lands on the state. A code with no unit in
   * the tree leaves the row unlinked rather than inventing one; the address still carries
   * the names, so nothing that was recorded is lost.
   */
  private liftFacilityGeography(table: string, keyColumn: string): void {
    const country = this.profileCountryCode()
    const columns = this.tableColumns(table)
    const hasNames = columns.has('state_name')
    const rows = this.db.prepare(`SELECT * FROM ${table}`).all() as DbRow[]
    const unit = this.db.prepare('SELECT id, admin_path FROM master_admin_units WHERE country_code = ? AND level = ? AND code = ?')
    const update = this.db.prepare(
      `UPDATE ${table} SET admin_unit_id = COALESCE(admin_unit_id, ?), admin_path = COALESCE(NULLIF(admin_path, ''), ?), ` +
      `address_json = CASE WHEN COALESCE(address_json, '') = '' THEN ? ELSE address_json END WHERE ${keyColumn} = ?`
    )

    for (const row of rows) {
      const stateCode = String(row.state_lgd_code ?? '').trim()
      const districtCode = String(row.district_lgd_code ?? '').trim()
      const resolved = (districtCode ? asDbRow(unit.get(country, 2, districtCode)) : {}) as DbRow
      const fallback = (!resolved.id && stateCode ? asDbRow(unit.get(country, 1, stateCode)) : {}) as DbRow
      const linked = resolved.id ? resolved : fallback

      const address: Record<string, unknown> = { country_code: country }
      if (hasNames) {
        const adminArea = String(row.state_name ?? '').trim()
        const locality = String(row.district_name ?? '').trim()
        if (adminArea) address.admin_area = adminArea
        if (locality) address.locality = locality
      }
      const carriesAddress = Object.keys(address).length > 1

      update.run(
        linked.id ? String(linked.id) : null,
        linked.admin_path ? String(linked.admin_path) : null,
        carriesAddress ? JSON.stringify(address) : null,
        String(row[keyColumn] ?? '')
      )
    }
  }

  /**
   * Rewrites stored event geography from two named columns into a numbered chain.
   *
   * `state_code` becomes level 1 and `district_code` level 2 — the only reading those two
   * columns ever had — and `admin_path` is assembled from whichever the tree can resolve,
   * so events stay filterable by the same prefix match everything else uses.
   */
  private liftEventGeography(): void {
    const country = this.profileCountryCode()
    const rows = this.db.prepare(
      "SELECT id, state_code, district_code FROM national_events WHERE COALESCE(state_code, '') <> '' OR COALESCE(district_code, '') <> ''"
    ).all() as DbRow[]
    if (!rows.length) return

    const unit = this.db.prepare('SELECT admin_path, code_system FROM master_admin_units WHERE country_code = ? AND level = ? AND code = ?')
    const update = this.db.prepare(
      'UPDATE national_events SET country_code = ?, admin_path = ?, admin_codes_json = ? WHERE id = ?'
    )

    for (const row of rows) {
      const chain: Array<{ level: number; code: string; code_system?: string }> = []
      let path: string | null = null
      for (const [level, value] of [[1, row.state_code], [2, row.district_code]] as const) {
        const code = String(value ?? '').trim()
        if (!code) continue
        const found = asDbRow(unit.get(country, level, code))
        chain.push({ level, code, ...(found.code_system ? { code_system: String(found.code_system) } : {}) })
        if (found.admin_path) path = String(found.admin_path)
      }
      update.run(country, path, JSON.stringify(chain), String(row.id ?? ''))
    }
  }

  /**
   * Drops columns, or fails the upgrade.
   *
   * `ALTER TABLE ... DROP COLUMN` needs SQLite 3.35 or later, which every better-sqlite3
   * build in use has. There is deliberately no fallback: the obvious one — rebuilding the
   * table from a `CREATE TABLE ... AS SELECT` — silently discards primary keys, foreign
   * keys and defaults, so an upgrade that "succeeded" would leave a laboratory table with
   * no primary key. Refusing is recoverable; quietly losing the constraints is not.
   */
  private dropColumns(table: string, columns: string[]): void {
    const present = this.tableColumns(table)
    const targets = columns.filter((column) => present.has(column))
    if (!targets.length) return
    try {
      for (const column of targets) this.db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`)
    } catch (error) {
      throw new Error(
        `Could not drop ${targets.join(', ')} from ${table}: ${(error as Error).message}. ` +
        'This upgrade needs SQLite 3.35 or later; the database has not been changed.'
      )
    }
  }

  /**
   * Tops up the packaged genomic-marker reference catalogue. Unlike the main catalogue seed this
   * runs on existing databases too, because the markers are a new reference set rather than
   * starter content; INSERT OR IGNORE leaves any locally edited row untouched.
   */
  private seedGenomicMarkers(): void {
    const columns = ['code', 'name', 'marker_type', 'gene_symbol', 'mechanism_class', 'organism_scope',
      'predicted_resistance', 'linked_antibiotic_codes', 'default_method', 'reporting_standard', 'who_priority',
      'active', 'is_custom', 'source_dataset', 'source_version', 'sort_order'] as const
    let asset: { version?: string; markers?: Array<Record<string, unknown>> }
    try {
      asset = JSON.parse(readFileSync(this.genomicMarkerSeedPath, 'utf8')) as typeof asset
    } catch {
      return
    }
    const markers = Array.isArray(asset.markers) ? asset.markers : []
    if (!markers.length) return
    const version = String(asset.version ?? 'v1')
    const seeded = asDbRow(this.db.prepare('SELECT source_version FROM app_catalog_seed_state WHERE dataset = ?')
      .get(GENOMIC_MARKER_DATASET))
    if (String(seeded.source_version ?? '') === version) return
    this.transaction(() => {
      this.insertSeedRows('master_genomic_markers', columns, markers.map((marker) => ({
        ...marker, active: 1, is_custom: 0, source_dataset: GENOMIC_MARKER_DATASET, source_version: version
      })))
      this.db.prepare(`INSERT INTO app_catalog_seed_state(dataset,source_version,source_hash,source_path,row_counts_json)
        VALUES (?,?,?,?,?)
        ON CONFLICT(dataset) DO UPDATE SET source_version=excluded.source_version,
          source_hash=excluded.source_hash, row_counts_json=excluded.row_counts_json`).run(
        GENOMIC_MARKER_DATASET, version,
        createHash('sha256').update(JSON.stringify(markers)).digest('hex'),
        this.genomicMarkerSeedPath, JSON.stringify({ master_genomic_markers: markers.length })
      )
      this.recordAudit('catalogue.genomic-markers', 'ok', `${markers.length} markers (${version})`)
    })
  }

  /**
   * Tops up the starter diagnosis value set, the same way the genomic markers are topped up.
   *
   * Diagnosis was a free-text box, which is unanalysable by construction: "UTI", "uti",
   * "Urinary tract infection" and "urosepsis?" are four strings and one syndrome. Seeding a
   * coded set gives the field something to be a dropdown over. It is small, and the notice
   * in the file says so — a deployment with a national value set or a SNOMED CT licence
   * should load that instead, which is why the rows go into the ordinary editable code-value
   * catalogue rather than anywhere privileged.
   *
   * Each row carries its code system in metadata, so an ICD-10 row and a SNOMED CT row can
   * sit in the same set and still export as the right `system`.
   */
  private seedDiagnosisCodes(): void {
    const columns = ['code_set', 'code', 'description', 'display_label', 'metadata_json',
      'active', 'is_custom', 'sort_order'] as const
    let asset: { version?: string; system?: string; system_label?: string; source?: string; codes?: Array<Record<string, unknown>> }
    try {
      asset = JSON.parse(readFileSync(this.diagnosisCodeSeedPath, 'utf8')) as typeof asset
    } catch {
      return
    }
    const codes = Array.isArray(asset.codes) ? asset.codes : []
    if (!codes.length) return
    const version = String(asset.version ?? 'v1')
    const seeded = asDbRow(this.db.prepare('SELECT source_version FROM app_catalog_seed_state WHERE dataset = ?')
      .get(DIAGNOSIS_CODE_DATASET))
    if (String(seeded.source_version ?? '') === version) return
    const system = String(asset.system ?? '')
    const systemLabel = String(asset.system_label ?? '')
    this.transaction(() => {
      this.insertSeedRows('whonet_code_values', columns, codes.map((entry) => {
        const code = String(entry.code ?? '')
        const description = String(entry.description ?? code)
        return {
          code_set: DIAGNOSIS_CODE_SET,
          code,
          description,
          // Both parts are in the label because a clinician searches by words and a coder
          // searches by code, and this control filters over whatever is written here.
          display_label: `${code} — ${description}`,
          metadata_json: JSON.stringify({ system, system_label: systemLabel, source: String(asset.source ?? '') }),
          active: 1,
          is_custom: 0,
          sort_order: Number(entry.sort_order ?? 0)
        }
      }))
      this.db.prepare(`INSERT INTO app_catalog_seed_state(dataset,source_version,source_hash,source_path,row_counts_json)
        VALUES (?,?,?,?,?)
        ON CONFLICT(dataset) DO UPDATE SET source_version=excluded.source_version,
          source_hash=excluded.source_hash, row_counts_json=excluded.row_counts_json`).run(
        DIAGNOSIS_CODE_DATASET, version,
        createHash('sha256').update(JSON.stringify(codes)).digest('hex'),
        this.diagnosisCodeSeedPath, JSON.stringify({ whonet_code_values: codes.length })
      )
      this.recordAudit('catalogue.diagnosis-codes', 'ok', `${codes.length} ${systemLabel || 'diagnosis'} codes (${version})`)
    })
  }

  private catalogueAsset(): PackagedCatalogueAsset {
    if (!this.packagedCatalogue) this.packagedCatalogue = loadPackagedCatalogue(this.catalogSeedPath).asset
    return this.packagedCatalogue
  }

  /**
   * A seed is automatic only for a database with no user, laboratory, isolate,
   * import, or pre-existing catalogue content. Existing databases are left alone.
   */
  private isFreshCatalogueDatabase(): boolean {
    const tables = [
      'laboratory', 'isolates', 'import_runs', 'master_antibiotics', 'master_organisms', 'master_samples',
      'master_sample_aliases', 'master_admin_units', 'whonet_code_values',
      'whonet_field_definitions', 'whonet_mic_panels', 'whonet_expected_resistance', 'whonet_expert_rules'
    ] as const
    return tables.every((table) => Number(asDbRow(this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).count ?? 0) === 0)
  }

  private insertSeedRows(table: string, columns: readonly string[], rows: readonly Record<string, unknown>[]): void {
    const statement = this.db.prepare(
      `INSERT OR IGNORE INTO ${table}(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`
    )
    for (const row of rows) statement.run(...columns.map((column) => scalar(row[column])))
  }

  private seedPackagedCatalogue(): void {
    if (!this.catalogSeedEnabled) return
    const existing = this.db.prepare('SELECT 1 FROM app_catalog_seed_state WHERE dataset = ?').get(PACKAGED_CATALOGUE_DATASET)
    if (existing || !this.isFreshCatalogueDatabase()) return
    const asset = this.catalogueAsset()
    this.transaction(() => {
      // Geography is no longer part of the catalogue; it arrives from the country's geo
      // pack in seedGeoPack() below.
      this.insertSeedRows('master_antibiotics', [
        'code', 'name', 'who_group', 'template_name', 'who_code', 'din_code', 'jac_code', 'eucast_code',
        'user_code', 'guidelines', 'potency', 'atc_code', 'class_name', 'subclass_name', 'prof_class', 'who_aware',
        'human_flag', 'veterinary_flag', 'loinc_sbt', 'loinc_mlc', 'comments', 'active', 'is_custom',
        'source_dataset', 'source_version', 'user_modified', 'sort_order'
      ], asset.catalogue.antibiotics)
      this.insertSeedRows('master_organisms', [
        'code', 'organism_name', 'system', 'concept_code', 'replacement_code', 'taxonomic_status', 'common_name',
        'common_commensal', 'organism_type', 'anaerobe', 'snomed_code', 'snomed_text', 'gbif_taxon_id', 'kingdom',
        'phylum_name', 'class_name', 'order_name', 'family_name', 'genus_name', 'active', 'is_custom',
        'source_dataset', 'source_version', 'user_modified', 'sort_order'
      ], asset.catalogue.organisms)
      this.insertSeedRows('master_samples', [
        'code', 'name', 'parent_code', 'system', 'concept_code', 'active', 'is_custom', 'source_dataset',
        'source_version', 'user_modified', 'sort_order'
      ], asset.catalogue.samples)
      this.insertSeedRows('master_sample_aliases', [
        'normalized_alias', 'alias_text', 'sample_code', 'source_dataset', 'source_version', 'active', 'user_modified'
      ], asset.catalogue.sampleAliases)
      this.insertSeedRows('whonet_code_values', [
        'code_set', 'code', 'description', 'display_label', 'metadata_json', 'sort_order', 'active', 'is_custom'
      ], asset.catalogue.codeValues)
      this.insertSeedRows('whonet_field_definitions', [
        'module_name', 'field_desc', 'field_name', 'field_length', 'field_type', 'section_name', 'code_file',
        'code_field', 'desc_field', 'isolate_listing', 'human', 'animal', 'food', 'feed', 'plant', 'environment', 'sort_order'
      ], asset.catalogue.fieldDefinitions)
      this.insertSeedRows('whonet_mic_panels', [
        'panel_name', 'antibiotic_name', 'antibiotic_code', 'minimum_value', 'maximum_value', 'sort_order'
      ], asset.catalogue.micPanels)
      this.insertSeedRows('whonet_expected_resistance', [
        'guideline', 'reference_table', 'organism_code', 'organism_code_type', 'exception_organism_code',
        'exception_organism_code_type', 'abx_code', 'abx_code_type', 'antibiotic_exceptions', 'comments', 'active', 'is_custom'
      ], asset.catalogue.expectedResistance)
      this.insertSeedRows('whonet_expert_rules', [
        'rule_code', 'description', 'organism_code', 'organism_code_type', 'rule_criteria', 'affected_antibiotics',
        'antibiotic_exceptions', 'enabled_by_default', 'active', 'is_custom'
      ], asset.catalogue.expertRules)
      this.insertSeedRows('whonet_resource_config', ['config_key', 'config_value'], asset.catalogue.resourceConfig)
      this.db.prepare(`INSERT INTO app_catalog_seed_state(
        dataset,source_version,source_hash,source_path,row_counts_json
      ) VALUES (?,?,?,?,?)`).run(
        asset.dataset, asset.version, asset.contentSha256, 'resources/catalog-seed.v1.json', JSON.stringify(asset.rowCounts)
      )
      this.db.prepare(`INSERT INTO app_audit_log(operation,status,summary,details)
        VALUES ('catalogue.seed','ok',?,?)`).run(
        `${asset.dataset} ${asset.version}`,
        JSON.stringify({ contentSha256: asset.contentSha256, rowCounts: asset.rowCounts, piiClassification: asset.piiClassification })
      )
    })
  }

  /**
   * Seed the administrative tree from the active country's geo pack.
   *
   * Runs only while master_admin_units is empty, so it never disturbs units a deployment
   * has imported or edited.
   */
  private seedGeoPack(): void {
    if (!this.catalogSeedEnabled) return
    const existing = this.db.prepare('SELECT COUNT(*) AS total FROM master_admin_units').get() as DbRow
    if (Number(existing?.total ?? 0) > 0) return

    const profile = activeProfile()
    const loaded = loadGeoPack(profile.profile_id) ?? loadGeoPack(profile.country_code)
    if (!loaded) return

    this.applyGeoPack(loaded.pack)
  }

  /** Ensure the selected laboratory country's reporting hierarchy exists locally. */
  private ensureGeoPackForCountry(countryCode: string): void {
    if (!this.catalogSeedEnabled) return
    const country = countryCode.trim().toUpperCase()
    if (!/^[A-Z]{3}$/.test(country)) return
    const existing = this.db.prepare(
      'SELECT 1 FROM master_admin_units WHERE country_code = ? LIMIT 1'
    ).get(country)
    if (existing) return

    let profileId = country
    try { profileId = getCountryProfile(country).profile_id } catch { /* no profile: try ISO fallback */ }
    const loaded = loadGeoPack(profileId) ?? loadGeoPack(country)
    if (loaded) this.applyGeoPack(loaded.pack)
  }

  /** Administrative units for one laboratory country, loading its bundled pack on demand. */
  reportingUnits(countryCode: string): Row[] {
    this.ensureReady()
    const country = countryCode.trim().toUpperCase()
    this.ensureGeoPackForCountry(country)
    return this.db.prepare(`SELECT * FROM master_admin_units
      WHERE country_code = ? AND COALESCE(active, 1) = 1
      ORDER BY level, sort_order, name`).all(country) as Row[]
  }

  /** Add or refresh the selected country's bundled reporting hierarchy after a switch. */
  seedActiveGeoPack(): { countryCode: string; units: number } | null {
    this.ensureReady()
    const profile = activeProfile()
    const loaded = loadGeoPack(profile.profile_id) ?? loadGeoPack(profile.country_code)
    if (!loaded) return null
    this.applyGeoPack(loaded.pack, { update: true })
    return { countryCode: loaded.pack.countryCode, units: loaded.pack.units.length }
  }

  /**
   * Load a geo pack at runtime, so a country can add or extend its administrative units
   * without a new build. Existing units are updated in place and nothing is deleted, so a
   * pack that adds a deeper level leaves the units already in use untouched.
   */
  importGeoPack(path: string): { countryCode: string; units: number } {
    this.ensureReady()
    const loaded = loadGeoPack('', path)
    if (!loaded) throw new Error(`Geo pack not found: ${path}`)
    this.applyGeoPack(loaded.pack, { update: true })
    return { countryCode: loaded.pack.countryCode, units: loaded.pack.units.length }
  }

  private applyGeoPack(pack: GeoPack, options: { update?: boolean } = {}): void {
    const insertUnit = this.db.prepare(options.update
      ? `INSERT INTO master_admin_units(
        id, country_code, level, parent_id, code, code_system, name, name_local, unit_type,
        admin_path, active, is_custom, sort_order, metadata_json, source_dataset, source_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, '{}', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, name_local = excluded.name_local, unit_type = excluded.unit_type,
        admin_path = excluded.admin_path, active = excluded.active, sort_order = excluded.sort_order,
        source_dataset = excluded.source_dataset, source_version = excluded.source_version,
        updated_at = CURRENT_TIMESTAMP`
      : `
      INSERT OR IGNORE INTO master_admin_units(
        id, country_code, level, parent_id, code, code_system, name, name_local, unit_type,
        admin_path, active, is_custom, sort_order, metadata_json, source_dataset, source_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, '{}', ?, ?)
    `)
    const codeSystemFor = (level: number): string =>
      pack.levels.find((definition) => Number(definition.level) === level)?.code_system ?? 'ISO3166-2'
    const idFor = (level: number, code: string): string => `${pack.countryCode}:${level}:${code}`
    const pathByLevelCode = new Map<string, string>()

    this.transaction(() => {
      // Shallowest level first so a parent always exists before its children.
      for (const unit of [...pack.units].sort((left, right) => Number(left.level) - Number(right.level))) {
        const level = Number(unit.level)
        const code = String(unit.code)
        const parentCode = unit.parent_code === null || unit.parent_code === undefined ? '' : String(unit.parent_code)
        const parentPath = parentCode ? pathByLevelCode.get(`${level - 1}:${parentCode}`) : undefined
        const adminPath = parentPath ? `${parentPath}/${code}` : `${pack.countryCode}/${code}`
        pathByLevelCode.set(`${level}:${code}`, adminPath)
        insertUnit.run(
          idFor(level, code), pack.countryCode, level, parentCode ? idFor(level - 1, parentCode) : null,
          code, codeSystemFor(level), String(unit.name), unit.name_local ?? null, unit.unit_type ?? null,
          adminPath, Number(unit.active ?? 1), Number(unit.sort_order ?? 0), pack.dataset, pack.version
        )
      }

    })
  }

  /** Attach the packaged AST panels only to a newly created laboratory. */
  private seedLaboratoryCatalogue(labCode: string): void {
    if (!this.catalogSeedEnabled) return
    const globalSeed = this.db.prepare('SELECT 1 FROM app_catalog_seed_state WHERE dataset = ?')
      .get(PACKAGED_CATALOGUE_DATASET)
    const labSeed = this.db.prepare('SELECT 1 FROM lab_catalog_seed_state WHERE lab_code = ? AND source_dataset = ?')
      .get(labCode, 'simple_ast_list_2026')
    if (!globalSeed || labSeed) return
    const asset = this.catalogueAsset()
    const organismCodes = new Set<string>()
    const antibioticCodes = new Set<string>()
    for (const panel of asset.catalogue.panels) {
      for (const row of (panel.organisms ?? []) as Array<Record<string, unknown>>) organismCodes.add(normalKey(row.code))
      for (const row of (panel.antibiotics ?? []) as Array<Record<string, unknown>>) antibioticCodes.add(normalKey(row.code))
    }
    const addOrganism = this.db.prepare(`INSERT INTO lab_organisms(lab_code,organism_code,organism_name)
      SELECT ?,?,organism_name FROM master_organisms WHERE code=? AND NOT EXISTS(
        SELECT 1 FROM lab_organisms WHERE lab_code=? AND organism_code=?)`)
    for (const code of [...organismCodes].sort()) addOrganism.run(labCode, code, code, labCode, code)
    const addAntibiotic = this.db.prepare(`INSERT INTO lab_antibiotics(lab_code,antibiotic_code,antibiotic_name)
      SELECT ?,?,name FROM master_antibiotics WHERE code=? AND NOT EXISTS(
        SELECT 1 FROM lab_antibiotics WHERE lab_code=? AND antibiotic_code=?)`)
    for (const code of [...antibioticCodes].sort()) addAntibiotic.run(labCode, code, code, labCode, code)
    const addAntibioticSetting = this.db.prepare(`INSERT OR IGNORE INTO lab_antibiotic_settings(
      lab_code,antibiotic_code,guideline,test_method,disk_potency,test_code,include_in_profile,
      breakpoint_scope,breakpoint_notes,sort_order
    ) SELECT ?,code,'CLSI','Disk diffusion',potency,code,0,'General','',sort_order
      FROM master_antibiotics WHERE code=?`)
    for (const code of [...antibioticCodes].sort()) addAntibioticSetting.run(labCode, code)
    const addDomain = this.db.prepare(`INSERT INTO lab_domains(lab_code,domain_code)
      SELECT ?,code FROM master_lab_domains WHERE code=? AND NOT EXISTS(
        SELECT 1 FROM lab_domains WHERE lab_code=? AND domain_code=?)`)
    for (const code of ['HUMAN', 'ANIMAL', 'ENVIRONMENT']) addDomain.run(labCode, code, labCode, code)
    this.insertSeedRows('lab_data_fields', [
      'lab_code', 'field_key', 'field_label', 'category', 'field_group', 'field_length', 'is_enabled', 'is_hidden',
      'include_in_listing', 'applicable_domains', 'response_codes', 'is_custom', 'sort_order'
    ], asset.catalogue.labDataFields.map((row) => ({ ...row, lab_code: labCode })))

    const addPanel = this.db.prepare(`INSERT INTO lab_panels(
      lab_code,panel_name,description,source_row_key,source_dataset,source_version,source_context,source_text,
      no_routine_ast,guidance_json,group_metadata_json,priority,active,user_modified
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0)`)
    const addPanelOrganism = this.db.prepare(
      'INSERT INTO lab_panel_organisms(panel_id,organism_code,organism_name) VALUES (?,?,?)'
    )
    const addPanelSpecimen = this.db.prepare(
      'INSERT INTO lab_panel_specimens(panel_id,specimen_code,specimen_name,specimen_system) VALUES (?,?,?,?)'
    )
    const addPanelAntibiotic = this.db.prepare(`INSERT INTO lab_panel_antibiotics(
      panel_id,antibiotic_code,antibiotic_name,sort_order,option_group,requirement_type,notes,source_text
    ) VALUES (?,?,?,?,?,?,?,?)`)
    let insertedPanels = 0
    for (const panel of asset.catalogue.panels) {
      const sourceRowKey = String(panel.source_row_key)
      const panelName = String(panel.panel_name)
      const conflict = this.db.prepare(`SELECT 1 FROM lab_panels WHERE lab_code=? AND
        (source_dataset=? AND source_row_key=? OR LOWER(TRIM(panel_name))=LOWER(TRIM(?))) LIMIT 1`)
        .get(labCode, String(panel.source_dataset), sourceRowKey, panelName)
      if (conflict) continue
      const panelId = Number(addPanel.run(
        labCode, panelName, scalar(panel.description), sourceRowKey, scalar(panel.source_dataset),
        scalar(panel.source_version), scalar(panel.source_context), scalar(panel.source_text),
        panel.no_routine_ast ? 1 : 0, JSON.stringify(panel.guidance ?? []),
        JSON.stringify(panel.group_metadata ?? []), Number(panel.priority ?? 100), panel.active === 0 ? 0 : 1
      ).lastInsertRowid)
      for (const row of (panel.organisms ?? []) as Array<Record<string, unknown>>) {
        addPanelOrganism.run(panelId, normalKey(row.code), String(row.name ?? row.organism_name ?? row.code))
      }
      for (const row of (panel.specimens ?? []) as Array<Record<string, unknown>>) {
        addPanelSpecimen.run(panelId, normalKey(row.code), String(row.name ?? row.specimen_name ?? row.code), scalar(row.system))
      }
      for (const [index, row] of ((panel.antibiotics ?? []) as Array<Record<string, unknown>>).entries()) {
        addPanelAntibiotic.run(
          panelId, normalKey(row.code), String(row.name ?? row.antibiotic_name ?? row.code),
          Number(row.sort_order ?? index), scalar(row.option_group), String(row.requirement_type ?? 'core'),
          scalar(row.notes), scalar(row.source_text)
        )
      }
      insertedPanels += 1
    }
    const panelVersion = String(asset.catalogue.panels[0]?.source_version ?? asset.version)
    this.db.prepare(`INSERT INTO lab_catalog_seed_state(
      lab_code,source_dataset,source_version,seeded_at,updated_at
    ) VALUES (?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).run(labCode, 'simple_ast_list_2026', panelVersion)
    this.recordAudit('catalogue.lab-seed', 'ok', `${labCode}: ${insertedPanels} AST panels`, {
      dataset: 'simple_ast_list_2026', version: panelVersion,
      organisms: organismCodes.size, antibiotics: antibioticCodes.size, dataFields: asset.catalogue.labDataFields.length,
      domains: 3
    })
  }

  private seedMinimumMasters(): void {
    this.transaction(() => {
      const domain = this.db.prepare(
        'INSERT OR IGNORE INTO master_lab_domains(code,label,description,colour,active,sort_order) VALUES (?,?,?,?,1,?)'
      )
      // Domain colours come from the country profile's palette; India keeps its exact
      // brand hexes, and another deployment gets its own without a code change.
      const palette = activeProfile().branding?.colors ?? {}
      domain.run('HUMAN', 'Human health', 'Human clinical and community AMR surveillance.', palette.blue ?? '#1B75BC', 10)
      domain.run('ANIMAL', 'Animal health', 'Veterinary, livestock and companion-animal surveillance.', palette.orange ?? '#F15A29', 20)
      domain.run('ENVIRONMENT', 'Environment', 'Water, soil, wastewater and environmental surveillance.', palette.navy ?? '#23376D', 30)
      const locationType = this.db.prepare(
        'INSERT OR IGNORE INTO master_location_types(code,label,active,sort_order) VALUES (?,?,1,?)'
      )
      locationType.run('INPATIENT', 'Inpatient', 10)
      locationType.run('OUTPATIENT', 'Outpatient', 20)
      locationType.run('ICU', 'Intensive care', 30)
    })
  }

  getBootstrapData(labCode?: string): {
    databasePath: string
    currentLab: Laboratory | null
    laboratories: Laboratory[]
    counts: DashboardCounts
    masterDefinitions: MasterDefinition[]
  } {
    this.ensureReady()
    const selected = labCode ? this.getLab(labCode) : this.currentLab()
    return {
      databasePath: this.databasePath,
      currentLab: selected,
      laboratories: this.listLabs(),
      counts: this.getCounts(selected?.code),
      masterDefinitions: this.masterDefinitions()
    }
  }

  listLabs(includeInactive = false): Laboratory[] {
    this.ensureReady()
    const sql = `SELECT * FROM laboratory${includeInactive ? '' : ' WHERE COALESCE(active, 1) = 1'} ORDER BY name, code`
    return (this.db.prepare(sql).all() as DbRow[]).map((row) => this.hydrateLab(row))
  }

  getLab(code: string): Laboratory | null {
    this.ensureReady()
    const row = this.db.prepare('SELECT * FROM laboratory WHERE code = ?').get(normalKey(code))
    return row ? this.hydrateLab(asDbRow(row)) : null
  }

  private hydrateLab(row: DbRow): Laboratory {
    const hydrated: Record<string, unknown> = { ...row }
    for (const column of LAB_COLUMNS) {
      if (BOOLEAN_COLUMNS.has(column) && column in hydrated) hydrated[column] = Boolean(hydrated[column])
    }
    // The address is stored as one JSON column and read back as the structured object
    // every caller works with; a column that fails to parse is dropped rather than
    // surfaced as a string, which would fail type checks far away from the cause.
    delete hydrated.address_json
    const stored = String(row.address_json ?? '').trim()
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as PostalAddress
        if (parsed && typeof parsed === 'object') hydrated.address = parsed
      } catch {
        // Leave `address` absent.
      }
    }
    return hydrated as Laboratory
  }

  /**
   * Derives `admin_path` and `country_code` from the administrative unit a facility is
   * placed at, so no caller assembles a path by hand and the two can never disagree.
   *
   * A row may also arrive with only an `admin_path` — an importer working from a pack, for
   * instance — and is linked back to the unit that path belongs to.
   */
  private applyAdminUnitLinkage(data: Record<string, SqlValue>): void {
    const unitId = String(data.admin_unit_id ?? '').trim()
    if (unitId) {
      const unit = this.db.prepare('SELECT * FROM master_admin_units WHERE id = ?').get(unitId) as DbRow | undefined
      if (!unit) return
      data.admin_path = String(unit.admin_path ?? '')
      data.country_code = String(unit.country_code ?? '')
      return
    }

    const path = String(data.admin_path ?? '').trim()
    if (path) {
      const match = this.db
        .prepare('SELECT * FROM master_admin_units WHERE admin_path = ? LIMIT 1')
        .get(path) as DbRow | undefined
      if (!match) return
      data.admin_unit_id = String(match.id ?? '')
      if (!String(data.country_code ?? '').trim()) data.country_code = String(match.country_code ?? '')
      return
    }
    this.deriveAdminUnitFromAddress(data)
  }

  /**
   * Work out the reporting unit from the address, when nothing else supplied one.
   *
   * The facility form stopped asking for the administrative hierarchy — the address answers
   * it, and asking twice was producing sites filed under one state and addressed in another.
   * That derivation cannot live only in the form: the importer, the sync client and the
   * dataset seeder all write laboratories too, and a laboratory with no `admin_unit_id`
   * silently drops out of every scope filter and regional roll-up. So it happens here, where
   * every writer passes.
   *
   * Matched on the postal code first, because that is the precise answer where a unit
   * records the codes it covers; then on the locality, then on the administrative area,
   * deepest level first so a district beats the state containing it. No match leaves the
   * placement empty rather than guessing — an unplaced laboratory is visible, a
   * wrongly-placed one is not.
   */
  private deriveAdminUnitFromAddress(data: Record<string, SqlValue>): void {
    const address = parseJson<PostalAddress | null>(data.address_json, null)
    if (!address) return
    const country = String(data.country_code ?? address.country_code ?? '').trim().toUpperCase()
    if (!country) return
    this.ensureGeoPackForCountry(country)
    const units = this.db.prepare(`SELECT id, admin_path, name, postal_code, level
      FROM master_admin_units WHERE country_code = ? AND COALESCE(active, 1) = 1
      ORDER BY level DESC`).all(country) as DbRow[]
    if (!units.length) return

    const postalCode = String(address.postal_code ?? '').trim().toUpperCase()
    const locality = String(address.locality ?? '').trim().toLowerCase()
    const adminArea = String(address.admin_area ?? '').trim().toLowerCase()
    const named = (unit: DbRow): string => String(unit.name ?? '').trim().toLowerCase()
    /** A unit's `postal_code` is one code, a comma-separated list, or a covering prefix. */
    const coversPostalCode = (unit: DbRow): boolean => {
      if (!postalCode) return false
      return String(unit.postal_code ?? '')
        .split(/[,;]/)
        .map((entry) => entry.trim().toUpperCase())
        .filter(Boolean)
        .some((entry) => entry === postalCode || postalCode.startsWith(entry))
    }

    const match = units.find(coversPostalCode)
      ?? (locality ? units.find((unit) => named(unit) === locality) : undefined)
      ?? (adminArea ? units.find((unit) => named(unit) === adminArea) : undefined)
    if (!match) return
    data.admin_unit_id = String(match.id ?? '')
    data.admin_path = String(match.admin_path ?? '')
  }

  /**
   * Validates and normalises an address against its country's rules before storing it.
   *
   * Validation happens here rather than only in the form, because the form is not the only
   * writer — the sync client and the importer save laboratories too, and an address that
   * cannot be rendered in its own country is a defect wherever it came from. `formatted` is
   * always recomputed, so what is stored is what renders.
   */
  private normalizedAddressJson(value: unknown, source: Record<string, unknown>): string | null {
    if (!value || typeof value !== 'object') return null
    const address = value as PostalAddress
    const countryCode = String(address.country_code || source.country_code || activeProfile().country_code || '').toUpperCase()
    const format = addressFormatFor(countryCode)
    const candidate = repairUnsupportedAddressFields({ ...address, country_code: countryCode }, format)
    const problems = validateAddress(candidate, format)
    if (problems.length) {
      throw new Error(`Address is not valid for ${countryCode}: ${problems.map((problem) => problem.message).join(' ')}`)
    }
    return JSON.stringify(normalizeAddress(candidate, format))
  }

  saveLab(lab: Laboratory): Laboratory {
    this.ensureReady()
    const source = lab as Record<string, unknown>
    const code = normalKey(source.code)
    const name = String(source.name ?? '').trim()
    if (!code) throw new Error('Laboratory code is required.')
    if (!name) throw new Error('Laboratory name is required.')
    const data: Record<string, SqlValue> = { code, name }
    for (const column of LAB_COLUMNS) {
      if (column === 'code' || column === 'name' || column === 'address_json' || source[column] === undefined) continue
      data[column] = scalar(source[column])
    }
    if (data.active === undefined) data.active = 1
    if (source.address !== undefined) data.address_json = this.normalizedAddressJson(source.address, source)
    this.applyAdminUnitLinkage(data)
    this.transaction(() => {
      const exists = Boolean(this.db.prepare('SELECT 1 FROM laboratory WHERE code = ?').get(code))
      if (exists) {
        const columns = Object.keys(data).filter((column) => column !== 'code')
        this.db.prepare(`UPDATE laboratory SET ${columns.map((column) => `${column} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE code = ?`)
          .run(...columns.map((column) => data[column] ?? null), code)
      } else {
        const columns = Object.keys(data)
        this.db.prepare(`INSERT INTO laboratory(${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
          .run(...columns.map((column) => data[column] ?? null))
        this.seedLaboratoryCatalogue(code)
      }
      this.recordAudit('laboratory.save', 'ok', `${code}: ${name}`, { code, created: !exists })
    })
    return this.getLab(code) as Laboratory
  }

  /**
   * Create a new laboratory identity and copy configuration from another site.
   * Operational/history tables and application-wide state are intentionally out
   * of scope. The operation is one transaction, including its audit record.
   */
  cloneLab(sourceCode: string, targetLab: Laboratory): LaboratoryCloneResult {
    this.ensureReady()
    const source = normalKey(sourceCode)
    const targetSource = targetLab as Record<string, unknown>
    const target = normalKey(targetSource.code)
    const targetName = String(targetSource.name ?? '').trim()
    if (!source) throw new Error('Source laboratory code is required.')
    if (!target) throw new Error('Target laboratory code is required.')
    if (!targetName) throw new Error('Target laboratory name is required.')
    if (source === target) throw new Error('Target laboratory code must differ from the source laboratory.')
    const sourceRow = this.db.prepare('SELECT * FROM laboratory WHERE code = ?').get(source) as DbRow | undefined
    if (!sourceRow) throw new Error(`Unknown source laboratory: ${source}`)
    if (this.db.prepare('SELECT 1 FROM laboratory WHERE code = ?').get(target)) {
      throw new Error(`Laboratory code already exists: ${target}`)
    }

    const copied = [
      'laboratory AST settings', 'domains', 'organisms', 'antibiotics and AST settings', 'locations',
      'alerts and custom alert rules', 'data fields', 'AST panels and panel members', 'analysis macros', 'import profiles'
    ]
    const excluded = [
      'isolates and AST results', 'import runs/history', 'audit history', 'current laboratory selection and preferences',
      'credentials and tokens', 'catalogue seed state', 'One Health events, alerts, actions and outbox'
    ]
    const counts: Record<string, number> = { laboratory: 0 }

    this.transaction(() => {
      const laboratory: Record<string, SqlValue> = { code: target, name: targetName }
      for (const column of LAB_IDENTITY_COLUMNS) {
        if (column === 'code' || column === 'name') continue
        // The address is the new laboratory's own; it is never copied from the source,
        // because two laboratories at one address is the exception, not the default.
        if (column === 'address_json') laboratory[column] = this.normalizedAddressJson(targetSource.address, targetSource)
        else if (column === 'active') laboratory[column] = targetSource[column] === undefined ? 1 : scalar(targetSource[column])
        else laboratory[column] = scalar(targetSource[column])
      }
      for (const column of LAB_CONFIGURATION_COLUMNS) laboratory[column] = scalar(sourceRow[column])
      const labColumns = Object.keys(laboratory)
      this.db.prepare(`INSERT INTO laboratory(${labColumns.join(',')}) VALUES (${labColumns.map(() => '?').join(',')})`)
        .run(...labColumns.map((column) => laboratory[column] ?? null))
      counts.laboratory = 1

      const copyScoped = (table: string, columns: readonly string[]): number => Number(this.db.prepare(
        `INSERT INTO ${table}(lab_code,${columns.join(',')}) SELECT ?,${columns.join(',')} FROM ${table} WHERE lab_code=?`
      ).run(target, source).changes)
      counts.lab_domains = copyScoped('lab_domains', ['domain_code'])
      counts.lab_organisms = copyScoped('lab_organisms', ['organism_code', 'organism_name'])
      counts.lab_antibiotics = copyScoped('lab_antibiotics', ['antibiotic_code', 'antibiotic_name'])
      counts.lab_antibiotic_settings = copyScoped('lab_antibiotic_settings', [
        'antibiotic_code', 'guideline', 'test_method', 'disk_potency', 'test_code', 'include_in_profile',
        'breakpoint_scope', 'breakpoint_notes', 'sort_order'
      ])
      counts.lab_locations = copyScoped('lab_locations', [
        'location_name', 'location_code', 'department', 'institution', 'location_type', 'active', 'is_custom', 'sort_order'
      ])
      counts.lab_alerts = copyScoped('lab_alerts', ['alert_key'])
      counts.lab_custom_alerts = copyScoped('lab_custom_alerts', [
        'rule_name', 'organism_code', 'organism_name', 'antibiotic_code', 'antibiotic_name', 'trigger_results',
        'category', 'alert_type', 'priority', 'message', 'active', 'sort_order'
      ])
      counts.lab_data_fields = copyScoped('lab_data_fields', [
        'field_key', 'field_label', 'category', 'field_group', 'field_length', 'is_enabled', 'is_hidden',
        'include_in_listing', 'applicable_domains', 'response_codes', 'is_custom', 'sort_order'
      ])
      counts.analysis_macros = copyScoped('analysis_macros', ['macro_name', 'config_json'])
      counts.import_profiles = copyScoped('import_profiles', [
        'profile_name', 'source_kind', 'delimiter', 'has_header', 'core_mapping', 'antibiotic_mapping',
        'default_values', 'notes'
      ])

      counts.lab_panels = 0
      counts.lab_panel_organisms = 0
      counts.lab_panel_specimens = 0
      counts.lab_panel_antibiotics = 0
      const panelColumns = [
        'panel_name', 'description', 'source_row_key', 'source_dataset', 'source_version', 'source_context', 'source_text',
        'no_routine_ast', 'guidance_json', 'group_metadata_json', 'priority', 'active', 'user_modified'
      ] as const
      const sourcePanels = this.db.prepare(`SELECT id,${panelColumns.join(',')} FROM lab_panels
        WHERE lab_code=? ORDER BY id`).all(source) as DbRow[]
      const insertPanel = this.db.prepare(`INSERT INTO lab_panels(lab_code,${panelColumns.join(',')})
        VALUES (?,${panelColumns.map(() => '?').join(',')})`)
      const panelChildren = [
        ['lab_panel_organisms', ['organism_code', 'organism_name']],
        ['lab_panel_specimens', ['specimen_code', 'specimen_name', 'specimen_system']],
        ['lab_panel_antibiotics', ['antibiotic_code', 'antibiotic_name', 'sort_order', 'option_group', 'requirement_type', 'notes', 'source_text']]
      ] as const
      for (const panel of sourcePanels) {
        const sourcePanelId = Number(panel.id)
        const targetPanelId = Number(insertPanel.run(
          target, ...panelColumns.map((column) => scalar(panel[column]))
        ).lastInsertRowid)
        counts.lab_panels += 1
        for (const [table, columns] of panelChildren) {
          const result = this.db.prepare(`INSERT INTO ${table}(panel_id,${columns.join(',')})
            SELECT ?,${columns.join(',')} FROM ${table} WHERE panel_id=?`).run(targetPanelId, sourcePanelId)
          counts[table] = (counts[table] ?? 0) + Number(result.changes)
        }
      }

      this.recordAudit('laboratory.clone-config', 'ok', `${source} -> ${target}`, {
        sourceCode: source, targetCode: target, counts, copied, excluded
      })
    })
    return { laboratory: this.getLab(target) as Laboratory, sourceCode: source, counts, copied, excluded }
  }

  setLabActive(code: string, active: boolean): Laboratory {
    this.ensureReady()
    const normalized = normalKey(code)
    const result = this.db.prepare('UPDATE laboratory SET active = ?, updated_at = CURRENT_TIMESTAMP WHERE code = ?')
      .run(active ? 1 : 0, normalized)
    if (Number(result.changes) !== 1) throw new Error(`Unknown laboratory: ${normalized}`)
    if (!active && this.getPreferences().current_lab_code === normalized) {
      this.savePreferences({ current_lab_code: '' })
    }
    this.recordAudit('laboratory.activation', 'ok', `${normalized} ${active ? 'activated' : 'deactivated'}`)
    return this.getLab(normalized) as Laboratory
  }

  deleteLab(code: string): void {
    this.ensureReady()
    const normalized = normalKey(code)
    const lab = this.getLab(normalized)
    if (!lab) throw new Error(`Unknown laboratory: ${normalized}`)
    const isolates = Number(asDbRow(this.db.prepare('SELECT COUNT(*) AS count FROM isolates WHERE lab_code = ?').get(normalized)).count ?? 0)
    const imports = Number(asDbRow(this.db.prepare('SELECT COUNT(*) AS count FROM import_runs WHERE lab_code = ?').get(normalized)).count ?? 0)
    if (isolates || imports) {
      throw new Error(`Laboratory ${normalized} has ${isolates} isolate record(s) and ${imports} import run(s); deactivate it instead.`)
    }
    this.transaction(() => {
      const panelIds = (this.db.prepare('SELECT id FROM lab_panels WHERE lab_code = ?').all(normalized) as DbRow[])
        .map((row) => Number(row.id))
      for (const id of panelIds) {
        this.db.prepare('DELETE FROM lab_panel_antibiotics WHERE panel_id = ?').run(id)
        this.db.prepare('DELETE FROM lab_panel_specimens WHERE panel_id = ?').run(id)
        this.db.prepare('DELETE FROM lab_panel_organisms WHERE panel_id = ?').run(id)
      }
      for (const table of ['lab_panels', 'lab_catalog_seed_state', 'lab_antibiotic_settings', 'lab_antibiotics',
        'lab_locations', 'lab_alerts', 'lab_custom_alerts', 'lab_domains', 'lab_organisms', 'lab_data_fields',
        'analysis_macros', 'import_profiles'] as const) {
        this.db.prepare(`DELETE FROM ${table} WHERE lab_code = ?`).run(normalized)
      }
      this.db.prepare('DELETE FROM laboratory WHERE code = ?').run(normalized)
      if (this.getPreferences().current_lab_code === normalized) {
        this.db.prepare("DELETE FROM app_preferences WHERE pref_key = 'current_lab_code'").run()
      }
      this.recordAudit('laboratory.delete', 'warning', `${normalized}: ${lab.name}`)
    })
  }

  selectLab(code: string): Laboratory {
    this.ensureReady()
    const normalized = normalKey(code)
    const lab = this.getLab(normalized)
    if (!lab) throw new Error(`Unknown laboratory: ${normalized}`)
    if (lab.active === false) throw new Error(`Laboratory ${normalized} is inactive.`)
    this.savePreferences({ current_lab_code: normalized })
    this.recordAudit('laboratory.select', 'ok', `${normalized}: ${lab.name}`)
    return lab
  }

  currentLab(): Laboratory | null {
    this.ensureReady()
    const selected = this.getPreferences().current_lab_code
    if (selected) {
      const lab = this.getLab(selected)
      if (lab?.active !== false) return lab
    }
    return this.listLabs()[0] ?? null
  }

  getPreferences(): Record<string, string> {
    this.ensureReady()
    const rows = this.db.prepare('SELECT pref_key, pref_value FROM app_preferences ORDER BY pref_key').all() as DbRow[]
    return Object.fromEntries(rows.map((row) => [String(row.pref_key), String(row.pref_value ?? '')]))
  }

  savePreferences(values: Record<string, string>): void {
    this.ensureReady()
    const statement = this.db.prepare(`
      INSERT INTO app_preferences(pref_key, pref_value) VALUES (?, ?)
      ON CONFLICT(pref_key) DO UPDATE SET pref_value = excluded.pref_value
    `)
    this.transaction(() => {
      for (const [key, value] of Object.entries(values)) {
        if (!/^[a-z][a-z0-9_.-]{0,79}$/i.test(key)) throw new Error(`Invalid preference key: ${key}`)
        statement.run(key, String(value ?? ''))
      }
    })
  }

  masterDefinitions(): MasterDefinition[] {
    return MASTER_KINDS.map((kind) => {
      const spec = MASTER_SPECS[kind]
      // The renderer needs to know a database-assigned key so it can hide the field and
      // strip it when duplicating an entry.
      return { ...structuredClone(spec.definition), autoKey: Boolean(spec.autoKey) }
    })
  }

  listMaster(kind: MasterKind, options: MasterListOptions = {}): Row[] {
    this.ensureReady()
    const spec = this.masterSpec(kind)
    if (kind === 'panels') return this.listPanels(this.resolveLabCode(options.labCode), options.includeInactive) as Row[]
    const conditions: string[] = []
    const params: SqlValue[] = []
    if (spec.labColumn) {
      conditions.push(`${spec.labColumn} = ?`)
      params.push(this.resolveLabCode(options.labCode))
    }
    if (!options.includeInactive && spec.activeField) conditions.push(`COALESCE(${spec.activeField}, 1) = 1`)
    const query = String(options.query ?? '').trim()
    if (query && spec.searchColumns.length) {
      conditions.push(`(${spec.searchColumns.map((column) => `LOWER(COALESCE(CAST(${column} AS TEXT), '')) LIKE ?`).join(' OR ')})`)
      for (let index = 0; index < spec.searchColumns.length; index += 1) params.push(`%${query.toLocaleLowerCase()}%`)
    }
    const key = spec.definition.key
    const order = spec.columns.includes('sort_order')
      ? `sort_order, ${spec.searchColumns[1] ?? spec.searchColumns[0] ?? key}, ${key}`
      : `${spec.searchColumns[1] ?? spec.searchColumns[0] ?? key}, ${key}`
    const sql = `SELECT * FROM ${spec.definition.table}${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ?`
    params.push(safeLimit(options.limit))
    const rows = this.db.prepare(sql).all(...params) as DbRow[]
    return rows.map((row) => this.hydrateMasterRow(spec, row))
  }

  private ensureLocalCustomBreakpointProvenance(): { setId: number; importId: number } {
    const existing = this.db.prepare(`SELECT bs.id,bs.source_import_id FROM master_breakpoint_sets bs
      WHERE bs.organization='Local' AND bs.edition='User configured' AND bs.active=0
        AND bs.validation_status='ready' AND COALESCE(bs.unmatched_count,0)=0
        AND bs.notes LIKE 'AMRIT Master Studio local custom staging.%'
      ORDER BY bs.id DESC LIMIT 1`).get()
    let setId = Number(asDbRow(existing).id ?? 0)
    let importId = Number(asDbRow(existing).source_import_id ?? 0)
    if (!setId) {
      const baseName = 'Local custom breakpoints - staged'
      let setName = baseName
      let suffix = 1
      while (this.db.prepare(`SELECT 1 FROM master_breakpoint_sets
        WHERE organization='Local' AND edition='User configured' AND name=?`).get(setName)) {
        suffix += 1
        setName = `${baseName} ${suffix}`
      }
      setId = Number(this.db.prepare(`INSERT INTO master_breakpoint_sets(
        name,organization,edition,active,notes,unmatched_count,validation_status
      ) VALUES (?,'Local','User configured',0,
        'AMRIT Master Studio local custom staging. Review, then activate the complete set explicitly.',0,'ready')`)
        .run(setName).lastInsertRowid)
    }
    if (!importId || !this.db.prepare('SELECT 1 FROM breakpoint_imports WHERE id=? AND breakpoint_set_id=?').get(importId, setId)) {
      const sourceHash = createHash('sha256').update(`amrit-master-studio-local-custom-v1:${setId}`).digest('hex')
      importId = Number(this.db.prepare(`INSERT INTO breakpoint_imports(
        breakpoint_set_id,source_name,source_path,source_hash,source_format,metadata_json,status
      ) VALUES (?,'AMRIT Master Studio local custom entries','amrit://master-studio',?,'manual',?,'staged')`)
        .run(setId, sourceHash, JSON.stringify({ provenance: 'local-manual-entry', version: 1, pii: false }))
        .lastInsertRowid)
      this.db.prepare('UPDATE master_breakpoint_sets SET source_import_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .run(importId, setId)
    }
    return { setId, importId }
  }

  private refreshLocalBreakpointImport(setId: number, importId: number): void {
    const count = Number(asDbRow(this.db.prepare(
      'SELECT COUNT(*) AS count FROM whonet_user_breakpoints WHERE source_set_id=? AND source_import_id=?'
    ).get(setId, importId)).count ?? 0)
    this.db.prepare(`UPDATE breakpoint_imports SET row_count=?,imported_rows=?,skipped_rows=0,
      errors_json='[]',warnings_json='[]',unmatched_rows=0,status='staged' WHERE id=?`)
      .run(count, count, importId)
    this.db.prepare(`UPDATE master_breakpoint_sets SET active=0,unmatched_count=0,
      validation_status='ready',updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(setId)
  }

  saveMaster(kind: MasterKind, row: Row, labCode?: string): Row {
    this.ensureReady()
    if (kind === 'panels') return this.savePanel(this.resolveLabCode(labCode), row) as Row
    const spec = this.masterSpec(kind)
    const source = row as Record<string, unknown>
    const data: Record<string, SqlValue> = {}
    for (const column of spec.columns) {
      if (source[column] === undefined || (column === spec.definition.key && spec.autoKey && !source[column])) continue
      const value = spec.jsonColumns?.includes(column) && typeof source[column] !== 'string'
        ? JSON.stringify(source[column] ?? {})
        : source[column]
      data[column] = scalar(value)
    }
    if (kind === 'sampleAliases' && !String(data.normalized_alias ?? '').trim()) {
      data.normalized_alias = normalText(data.alias_text).replace(/\s+/g, ' ')
    }
    const keyName = spec.definition.key
    if (!spec.autoKey || data[keyName] !== undefined) {
      if (isNumericKey(spec)) data[keyName] = Number(data[keyName])
      else if (keyName === 'normalized_alias') data[keyName] = normalText(data[keyName]).replace(/\s+/g, ' ')
      else if (kind === 'dataFields') data[keyName] = normalText(data[keyName]).replace(/[^a-z0-9_.-]+/g, '_')
      else data[keyName] = normalKey(data[keyName])
    }
    for (const column of spec.definition.columns.filter((item) => item.required)) {
      const value = data[column.key]
      if (value === null || value === undefined || String(value).trim() === '') throw new Error(`${column.label} is required.`)
    }
    if (spec.columns.includes('active') && data.active === undefined) data.active = 1
    if (spec.columns.includes('is_custom') && data.is_custom === undefined) data.is_custom = 1
    if (spec.columns.includes('user_modified')) data.user_modified = 1
    let breakpointExisting: DbRow | undefined
    let restageBreakpoint = false
    let breakpointStatusReason = ''
    if (kind === 'breakpoints') {
      breakpointExisting = source.id
        ? this.db.prepare('SELECT * FROM whonet_user_breakpoints WHERE id=?').get(Number(source.id)) as DbRow | undefined
        : undefined
      if (breakpointExisting && Number(breakpointExisting.is_custom ?? 0) !== 1) {
        throw new Error('Imported breakpoint rows are read-only. Stage a revised source or create a local custom row.')
      }
      const unsafeEdit = Boolean(breakpointExisting && BREAKPOINT_CLINICAL_COLUMNS.some((column) =>
        source[column] !== undefined && String(scalar(source[column]) ?? '').trim() !== String(breakpointExisting?.[column] ?? '').trim()
      ))
      const wasActive = Number(breakpointExisting?.active ?? 0) === 1
      const requestedDeactivation = wasActive && (source.active === false || source.active === 0)
      delete data.source_set_id
      delete data.source_import_id
      data.is_custom = 1
      if (!breakpointExisting) {
        data.active = 0
        restageBreakpoint = true
        breakpointStatusReason = 'new custom row'
      } else if (wasActive && unsafeEdit) {
        data.active = 0
        restageBreakpoint = true
        breakpointStatusReason = 'interpretation-affecting edit'
      } else {
        data.active = requestedDeactivation ? 0 : Number(breakpointExisting.active ?? 0)
        data.source_set_id = scalar(breakpointExisting.source_set_id)
        data.source_import_id = scalar(breakpointExisting.source_import_id)
        if (!data.source_set_id || !data.source_import_id) {
          data.active = 0
          restageBreakpoint = true
          breakpointStatusReason = 'missing provenance repaired'
        }
      }
    }
    const scopedLab = spec.labColumn ? this.resolveLabCode(labCode) : undefined
    let resolvedKey: SqlValue | undefined = data[keyName]
    this.transaction(() => {
      let stagedProvenance: { setId: number; importId: number } | undefined
      if (kind === 'breakpoints' && restageBreakpoint) {
        stagedProvenance = this.ensureLocalCustomBreakpointProvenance()
        data.source_set_id = stagedProvenance.setId
        data.source_import_id = stagedProvenance.importId
      }
      const conditions = [`${keyName} = ?`]
      const keyParams: SqlValue[] = [resolvedKey ?? null]
      if (spec.labColumn) {
        conditions.unshift(`${spec.labColumn} = ?`)
        keyParams.unshift(scopedLab as string)
      }
      const exists = resolvedKey !== undefined && Boolean(
        this.db.prepare(`SELECT 1 FROM ${spec.definition.table} WHERE ${conditions.join(' AND ')} LIMIT 1`).get(...keyParams)
      )
      if (exists) {
        const columns = Object.keys(data).filter((column) => column !== keyName)
        if (columns.length) {
          this.db.prepare(`UPDATE ${spec.definition.table} SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE ${conditions.join(' AND ')}`)
            .run(...columns.map((column) => data[column] ?? null), ...keyParams)
        }
      } else {
        const insertData = { ...data }
        if (spec.labColumn) insertData[spec.labColumn] = scopedLab as string
        const columns = Object.keys(insertData)
        const result = this.db.prepare(`INSERT INTO ${spec.definition.table}(${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
          .run(...columns.map((column) => insertData[column] ?? null))
        if (spec.autoKey && resolvedKey === undefined) resolvedKey = result.lastInsertRowid
      }
      if (stagedProvenance) this.refreshLocalBreakpointImport(stagedProvenance.setId, stagedProvenance.importId)
      this.recordAudit(`master.${kind}.save`, restageBreakpoint ? 'warning' : 'ok', String(resolvedKey ?? ''), {
        labCode: scopedLab,
        ...(kind === 'breakpoints' ? {
          active: Number(data.active ?? 0) === 1,
          governance: restageBreakpoint ? `staged inactive: ${breakpointStatusReason}` : 'status and provenance preserved',
          sourceSetId: data.source_set_id,
          sourceImportId: data.source_import_id
        } : {})
      })
    })
    return this.getMaster(kind, resolvedKey as SqlValue, scopedLab)
  }

  toggleMaster(kind: MasterKind, key: string | number, active: boolean, labCode?: string): void {
    this.ensureReady()
    if (kind === 'breakpoints' && active) {
      throw new Error('Breakpoint rows cannot be activated individually. Review and activate their complete breakpoint set.')
    }
    const spec = this.masterSpec(kind)
    if (!spec.activeField) throw new Error(`${spec.definition.title} does not support activation.`)
    const params: SqlValue[] = [active ? 1 : 0]
    const conditions: string[] = []
    if (spec.labColumn) {
      conditions.push(`${spec.labColumn} = ?`)
      params.push(this.resolveLabCode(labCode))
    }
    conditions.push(`${spec.definition.key} = ?`)
    params.push(masterKeyValue(spec, key))
    const result = this.db.prepare(`UPDATE ${spec.definition.table} SET ${spec.activeField} = ? WHERE ${conditions.join(' AND ')}`).run(...params)
    if (Number(result.changes) !== 1) throw new Error(`Unknown ${kind} record: ${String(key)}`)
    this.recordAudit(`master.${kind}.activation`, 'ok', `${String(key)} ${active ? 'activated' : 'deactivated'}`)
  }

  deleteMaster(kind: MasterKind, key: string | number, labCode?: string): void {
    this.ensureReady()
    if (kind === 'panels') {
      this.deletePanel(Number(key), this.resolveLabCode(labCode))
      return
    }
    const spec = this.masterSpec(kind)
    const scopedLab = spec.labColumn ? this.resolveLabCode(labCode) : undefined
    const existing = this.getMaster(kind, masterKeyValue(spec, key), scopedLab)
    const references = this.masterReferenceCount(kind, key, scopedLab)
    if (references > 0) throw new Error(`${spec.definition.title} record ${String(key)} is used by ${references} record(s); deactivate it instead.`)
    if (spec.protectedCatalogue && spec.activeField && existing.is_custom !== true && existing.is_custom !== 1) {
      this.toggleMaster(kind, key, false, scopedLab)
      return
    }
    const params: SqlValue[] = []
    const conditions: string[] = []
    if (spec.labColumn) {
      conditions.push(`${spec.labColumn} = ?`)
      params.push(scopedLab as string)
    }
    conditions.push(`${spec.definition.key} = ?`)
    params.push(masterKeyValue(spec, key))
    this.transaction(() => {
      this.db.prepare(`DELETE FROM ${spec.definition.table} WHERE ${conditions.join(' AND ')}`).run(...params)
      this.recordAudit(`master.${kind}.delete`, 'warning', String(key), { labCode: scopedLab })
    })
  }

  private masterSpec(kind: MasterKind): MasterSpec {
    if (!MASTER_KINDS.includes(kind)) throw new Error(`Unknown master kind: ${String(kind)}`)
    return MASTER_SPECS[kind]
  }

  private resolveLabCode(labCode?: string): string {
    const normalized = normalKey(labCode || this.currentLab()?.code)
    if (!normalized || !this.getLab(normalized)) throw new Error('Select a valid laboratory first.')
    return normalized
  }

  private hydrateMasterRow(spec: MasterSpec, row: DbRow): Row {
    const hydrated: Record<string, unknown> = { ...row }
    for (const column of spec.columns) {
      if (BOOLEAN_COLUMNS.has(column) && column in hydrated) hydrated[column] = Boolean(hydrated[column])
      if (spec.jsonColumns?.includes(column)) hydrated[column] = parseJson(hydrated[column], {})
    }
    return hydrated as Row
  }

  private getMaster(kind: MasterKind, key: SqlValue, labCode?: string): Row {
    const spec = this.masterSpec(kind)
    const params: SqlValue[] = []
    const conditions: string[] = []
    if (spec.labColumn) {
      conditions.push(`${spec.labColumn} = ?`)
      params.push(this.resolveLabCode(labCode))
    }
    conditions.push(`${spec.definition.key} = ?`)
    params.push(key)
    const row = this.db.prepare(`SELECT * FROM ${spec.definition.table} WHERE ${conditions.join(' AND ')} LIMIT 1`).get(...params)
    if (!row) throw new Error(`Unable to find saved ${kind} record ${String(key)}.`)
    return this.hydrateMasterRow(spec, asDbRow(row))
  }

  private masterReferenceCount(kind: MasterKind, key: string | number, labCode?: string): number {
    const normalized = String(key)
    const count = (sql: string, ...params: SqlValue[]): number =>
      Number(asDbRow(this.db.prepare(sql).get(...params)).count ?? 0)
    switch (kind) {
      case 'antibiotics':
        return count('SELECT COUNT(*) AS count FROM isolate_ast_results WHERE antibiotic_code = ?', normalized) +
          count('SELECT COUNT(*) AS count FROM lab_panel_antibiotics WHERE antibiotic_code = ?', normalized)
      case 'organisms':
        return count('SELECT COUNT(*) AS count FROM isolates WHERE organism_code = ?', normalized) +
          count('SELECT COUNT(*) AS count FROM lab_panel_organisms WHERE organism_code = ?', normalized)
      case 'samples':
        return count('SELECT COUNT(*) AS count FROM isolates WHERE specimen_code = ?', normalized) +
          count('SELECT COUNT(*) AS count FROM lab_panel_specimens WHERE specimen_code = ?', normalized) +
          count('SELECT COUNT(*) AS count FROM master_sample_aliases WHERE sample_code = ?', normalized) +
          count('SELECT COUNT(*) AS count FROM master_samples WHERE parent_code = ?', normalized)
      case 'admin-units':
        // A unit is in use if anything sits under it or points at it. Child units count,
        // so removing a level-1 unit with descendants is blocked rather than orphaning them.
        return count('SELECT COUNT(*) AS count FROM master_admin_units WHERE parent_id = ?', normalized) +
          count('SELECT COUNT(*) AS count FROM laboratory WHERE admin_unit_id = ?', normalized) +
          count('SELECT COUNT(*) AS count FROM master_hospitals WHERE admin_unit_id = ?', normalized)
      case 'domains':
        return count('SELECT COUNT(*) AS count FROM lab_domains WHERE domain_code = ?', normalized) +
          count('SELECT COUNT(*) AS count FROM master_hospitals WHERE domain_code = ?', normalized)
      case 'hospitals':
        return count('SELECT COUNT(*) AS count FROM master_hospitals WHERE parent_code = ?', normalized)
      case 'locations': {
        const lab = this.resolveLabCode(labCode)
        const location = this.getMaster('locations', normalized, lab)
        return count(`SELECT COUNT(*) AS count FROM isolates WHERE lab_code = ? AND
          (location = ? OR (TRIM(COALESCE(location, '')) = '' AND institution = ?))`,
        lab, String(location.location_name ?? ''), String(location.institution ?? ''))
      }
      case 'genomicMarkers':
        return count('SELECT COUNT(*) AS count FROM isolate_genomic_results WHERE marker_code = ?', normalized) +
          count('SELECT COUNT(*) AS count FROM lab_panel_genomic_markers WHERE marker_code = ?', normalized)
      case 'sampleAliases':
      case 'dataFields':
      case 'expertRules':
      case 'breakpoints':
      case 'qcRanges':
      case 'expectedResistance':
      case 'codeValues':
        return 0
      case 'panels':
        return count(`SELECT COUNT(*) AS count FROM isolates i JOIN lab_panels p
          ON p.lab_code = i.lab_code AND p.panel_name = i.antibiotic_panel WHERE p.id = ?`, Number(key))
    }
  }

  listPanels(labCode: string, includeInactive = false): Row[] {
    this.ensureReady()
    const lab = this.resolveLabCode(labCode)
    const rows = this.db.prepare(`SELECT * FROM lab_panels WHERE lab_code = ?
      ${includeInactive ? '' : 'AND COALESCE(active, 1) = 1'} ORDER BY priority, panel_name, id`).all(lab) as DbRow[]
    return rows.map((row) => this.hydratePanel(row))
  }

  private hydratePanel(row: DbRow): Row {
    const id = Number(row.id)
    const organisms = (this.db.prepare(`SELECT organism_code AS code, organism_name AS name
      FROM lab_panel_organisms WHERE panel_id = ? ORDER BY organism_name, organism_code`).all(id) as DbRow[])
    const specimens = (this.db.prepare(`SELECT specimen_code AS code, specimen_name AS name, specimen_system AS system
      FROM lab_panel_specimens WHERE panel_id = ? ORDER BY specimen_name, specimen_code`).all(id) as DbRow[])
    const antibiotics = (this.db.prepare(`SELECT antibiotic_code AS code, antibiotic_name AS name, sort_order,
      option_group, requirement_type, notes, source_text FROM lab_panel_antibiotics
      WHERE panel_id = ? ORDER BY sort_order, antibiotic_name, antibiotic_code`).all(id) as DbRow[])
    const genomicMarkers = (this.db.prepare(`SELECT marker_code AS code, marker_name AS name, sort_order,
      requirement_type, method, notes FROM lab_panel_genomic_markers
      WHERE panel_id = ? ORDER BY sort_order, marker_name, marker_code`).all(id) as DbRow[])
    return {
      ...row,
      active: Boolean(row.active),
      no_routine_ast: Boolean(row.no_routine_ast),
      user_modified: Boolean(row.user_modified),
      guidance: parseJson(row.guidance_json, {}),
      group_metadata: parseJson(row.group_metadata_json, {}),
      organisms,
      specimens,
      antibiotics,
      genomic_markers: genomicMarkers
    } as unknown as Row
  }

  savePanel(labCode: string, panel: Row): Row {
    this.ensureReady()
    const lab = this.resolveLabCode(labCode)
    const source = panel as Record<string, unknown>
    const panelName = String(source.panel_name ?? source.name ?? '').trim()
    if (!panelName) throw new Error('Panel name is required.')
    let panelId = Number(source.id || 0)
    const asArray = (value: unknown): Array<Record<string, unknown>> => {
      const parsed = typeof value === 'string' ? parseJson<unknown[]>(value, []) : value
      return Array.isArray(parsed)
        ? parsed.map((item) => typeof item === 'string' ? { code: item, name: item } : (item as Record<string, unknown>))
        : []
    }
    const organisms = asArray(source.organisms)
    const specimens = asArray(source.specimens)
    const antibiotics = asArray(source.antibiotics)
    const genomicMarkers = asArray(source.genomic_markers ?? source.genomicMarkers)
    this.transaction(() => {
      if (panelId) {
        const owned = this.db.prepare('SELECT 1 FROM lab_panels WHERE id = ? AND lab_code = ?').get(panelId, lab)
        if (!owned) throw new Error(`Panel ${panelId} does not belong to ${lab}.`)
        this.db.prepare(`UPDATE lab_panels SET panel_name = ?, description = ?, source_row_key = ?, source_dataset = ?,
          source_version = ?, source_context = ?, source_text = ?, no_routine_ast = ?, guidance_json = ?,
          group_metadata_json = ?, priority = ?, active = ?, user_modified = 1, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND lab_code = ?`).run(
          panelName, scalar(source.description), scalar(source.source_row_key), scalar(source.source_dataset),
          scalar(source.source_version), scalar(source.source_context), scalar(source.source_text),
          source.no_routine_ast ? 1 : 0,
          JSON.stringify(source.guidance ?? parseJson(source.guidance_json, {})),
          JSON.stringify(source.group_metadata ?? parseJson(source.group_metadata_json, {})),
          Number(source.priority ?? 100), source.active === false ? 0 : 1, panelId, lab
        )
      } else {
        const result = this.db.prepare(`INSERT INTO lab_panels(
          lab_code,panel_name,description,source_row_key,source_dataset,source_version,source_context,source_text,
          no_routine_ast,guidance_json,group_metadata_json,priority,active,user_modified
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(
          lab, panelName, scalar(source.description), scalar(source.source_row_key), scalar(source.source_dataset),
          scalar(source.source_version), scalar(source.source_context), scalar(source.source_text),
          source.no_routine_ast ? 1 : 0,
          JSON.stringify(source.guidance ?? parseJson(source.guidance_json, {})),
          JSON.stringify(source.group_metadata ?? parseJson(source.group_metadata_json, {})),
          Number(source.priority ?? 100), source.active === false ? 0 : 1
        )
        panelId = Number(result.lastInsertRowid)
      }
      this.db.prepare('DELETE FROM lab_panel_organisms WHERE panel_id = ?').run(panelId)
      this.db.prepare('DELETE FROM lab_panel_specimens WHERE panel_id = ?').run(panelId)
      this.db.prepare('DELETE FROM lab_panel_antibiotics WHERE panel_id = ?').run(panelId)
      this.db.prepare('DELETE FROM lab_panel_genomic_markers WHERE panel_id = ?').run(panelId)
      const insertOrganism = this.db.prepare(
        'INSERT INTO lab_panel_organisms(panel_id,organism_code,organism_name) VALUES (?,?,?)'
      )
      for (const item of organisms) {
        const code = normalKey(item.code ?? item.organism_code)
        const name = String(item.name ?? item.organism_name ?? code).trim()
        if (code || name) insertOrganism.run(panelId, code, name)
      }
      const insertSpecimen = this.db.prepare(
        'INSERT INTO lab_panel_specimens(panel_id,specimen_code,specimen_name,specimen_system) VALUES (?,?,?,?)'
      )
      for (const item of specimens) {
        const code = normalKey(item.code ?? item.specimen_code)
        const name = String(item.name ?? item.specimen_name ?? code).trim()
        if (code || name) insertSpecimen.run(panelId, code || null, name, scalar(item.system ?? item.specimen_system))
      }
      const insertAntibiotic = this.db.prepare(`INSERT INTO lab_panel_antibiotics(
        panel_id,antibiotic_code,antibiotic_name,sort_order,option_group,requirement_type,notes,source_text
      ) VALUES (?,?,?,?,?,?,?,?)`)
      antibiotics.forEach((item, index) => {
        const code = normalKey(item.code ?? item.antibiotic_code)
        const name = String(item.name ?? item.antibiotic_name ?? code).trim()
        if (code || name) insertAntibiotic.run(
          panelId, code, name, Number(item.sort_order ?? index), scalar(item.option_group),
          String(item.requirement_type ?? 'core'), scalar(item.notes), scalar(item.source_text)
        )
      })
      const insertMarker = this.db.prepare(`INSERT INTO lab_panel_genomic_markers(
        panel_id,marker_code,marker_name,sort_order,requirement_type,method,notes
      ) VALUES (?,?,?,?,?,?,?)`)
      genomicMarkers.forEach((item, index) => {
        const code = normalKey(item.code ?? item.marker_code)
        const name = String(item.name ?? item.marker_name ?? code).trim()
        // A prescribed genomic test belongs to the panel's essential set unless explicitly relaxed.
        if (code || name) insertMarker.run(
          panelId, code, name, Number(item.sort_order ?? index), String(item.requirement_type ?? 'core'),
          scalar(item.method), scalar(item.notes)
        )
      })
      this.recordAudit('panel.save', 'ok', `${panelId}: ${panelName}`, { labCode: lab })
    })
    return this.hydratePanel(asDbRow(this.db.prepare('SELECT * FROM lab_panels WHERE id = ?').get(panelId)))
  }

  deletePanel(panelId: number, labCode?: string): void {
    this.ensureReady()
    const lab = this.resolveLabCode(labCode)
    const panel = this.db.prepare('SELECT panel_name FROM lab_panels WHERE id = ? AND lab_code = ?').get(panelId, lab)
    if (!panel) throw new Error(`Unknown panel ${panelId} for ${lab}.`)
    const used = Number(asDbRow(this.db.prepare(`SELECT COUNT(*) AS count FROM isolates
      WHERE lab_code = ? AND antibiotic_panel = ?`).get(lab, scalar(asDbRow(panel).panel_name))).count ?? 0)
    if (used) throw new Error(`Panel ${panelId} is used by ${used} isolate record(s); deactivate it instead.`)
    this.transaction(() => {
      this.db.prepare('DELETE FROM lab_panel_antibiotics WHERE panel_id = ?').run(panelId)
      this.db.prepare('DELETE FROM lab_panel_genomic_markers WHERE panel_id = ?').run(panelId)
      this.db.prepare('DELETE FROM lab_panel_specimens WHERE panel_id = ?').run(panelId)
      this.db.prepare('DELETE FROM lab_panel_organisms WHERE panel_id = ?').run(panelId)
      this.db.prepare('DELETE FROM lab_panels WHERE id = ? AND lab_code = ?').run(panelId, lab)
      this.recordAudit('panel.delete', 'warning', `${panelId}: ${String(asDbRow(panel).panel_name)}`, { labCode: lab })
    })
  }

  matchPanels(context: Record<string, unknown>): Row[] {
    this.ensureReady()
    const lab = this.resolveLabCode(String(context.labCode ?? context.lab_code ?? ''))
    return this.decisionSupport.matchPanels({ ...context, labCode: lab })
  }

  listRecords(filters: Record<string, unknown> = {}): IsolateRecord[] {
    this.ensureReady()
    const conditions: string[] = []
    const params: SqlValue[] = []
    const lab = String(filters.labCode ?? filters.lab_code ?? '').trim()
    if (lab) {
      conditions.push('lab_code = ?')
      params.push(normalKey(lab))
    }
    if (filters.includeDrafts === false || filters.include_drafts === false) conditions.push("COALESCE(record_status, 'final') <> 'draft'")
    const equals: Array<[string, unknown]> = [
      ['organism_code', filters.organismCode ?? filters.organism_code],
      ['specimen_code', filters.specimenCode ?? filters.specimen_code],
      ['location_type', filters.locationType ?? filters.location_type],
      ['record_status', filters.status ?? filters.record_status]
    ]
    for (const [column, value] of equals) {
      if (String(value ?? '').trim()) {
        conditions.push(`LOWER(TRIM(COALESCE(${column}, ''))) = LOWER(TRIM(?))`)
        params.push(String(value))
      }
    }
    const organisms = Array.isArray(filters.organisms)
      ? [...new Set(filters.organisms.map(normalText).filter(Boolean))]
      : []
    if (!organisms.length && String(filters.organism ?? '').trim()) {
      conditions.push("LOWER(COALESCE(organism, '')) LIKE ?")
      params.push(`%${String(filters.organism).trim().toLocaleLowerCase()}%`)
    }
    if (organisms.length) {
      const placeholders = organisms.map(() => '?').join(',')
      conditions.push(`(LOWER(TRIM(COALESCE(organism, ''))) IN (${placeholders}) OR LOWER(TRIM(COALESCE(organism_code, ''))) IN (${placeholders}))`)
      params.push(...organisms, ...organisms)
    }
    const specimenTypes = Array.isArray(filters.specimenTypes)
      ? [...new Set(filters.specimenTypes.map(normalText).filter(Boolean))]
      : []
    if (!specimenTypes.length && String(filters.specimenType ?? filters.specimen_type ?? '').trim()) {
      conditions.push("LOWER(COALESCE(specimen_type, '')) LIKE ?")
      params.push(`%${String(filters.specimenType ?? filters.specimen_type).trim().toLocaleLowerCase()}%`)
    }
    if (specimenTypes.length) {
      const placeholders = specimenTypes.map(() => '?').join(',')
      conditions.push(`(LOWER(TRIM(COALESCE(specimen_type, ''))) IN (${placeholders}) OR LOWER(TRIM(COALESCE(specimen_code, ''))) IN (${placeholders}))`)
      params.push(...specimenTypes, ...specimenTypes)
    }
    const periodStart = String(filters.periodStart ?? filters.period_start ?? '').trim()
    const periodEnd = String(filters.periodEnd ?? filters.period_end ?? '').trim()
    if (periodStart) { conditions.push("date(COALESCE(NULLIF(specimen_date, ''), created_at)) >= date(?)"); params.push(periodStart) }
    if (periodEnd) { conditions.push("date(COALESCE(NULLIF(specimen_date, ''), created_at)) <= date(?)"); params.push(periodEnd) }
    const query = String(filters.query ?? '').trim()
    if (query) {
      conditions.push(`(LOWER(COALESCE(patient_id, '')) LIKE ? OR LOWER(COALESCE(specimen_number, '')) LIKE ?
        OR LOWER(COALESCE(organism, '')) LIKE ?)`)
      const pattern = `%${query.toLocaleLowerCase()}%`
      params.push(pattern, pattern, pattern)
    }
    const includeAll = filters.all === true
    const sql = `SELECT * FROM isolates${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY COALESCE(NULLIF(specimen_date, ''), created_at) DESC, id DESC${includeAll ? '' : ' LIMIT ?'}`
    if (!includeAll) params.push(safeLimit(filters.limit, 2_000))
    return (this.db.prepare(sql).all(...params) as DbRow[]).map((row) => this.hydrateRecord(row))
  }

  getRecord(id: number): IsolateRecord | null {
    this.ensureReady()
    const row = this.db.prepare('SELECT * FROM isolates WHERE id = ?').get(id)
    return row ? this.hydrateRecord(asDbRow(row)) : null
  }

  private hydrateRecord(row: DbRow): IsolateRecord {
    const hydrated: Record<string, unknown> = { ...row }
    let antibioticResults = parseJson<Record<string, AstResult>>(row.antibiotic_results, {})
    const normalized = this.db.prepare(`SELECT antibiotic_code,result,measurement,method,guideline,potency,source
      FROM isolate_ast_results WHERE isolate_id = ? ORDER BY antibiotic_code`).all(Number(row.id)) as DbRow[]
    if (normalized.length) {
      antibioticResults = Object.fromEntries(normalized.map((item) => [String(item.antibiotic_code), {
        result: String(item.result ?? '') as AstResult['result'], measurement: item.measurement as string,
        method: item.method as string, guideline: item.guideline as string, potency: item.potency as string,
        source: item.source as string
      }]))
    }
    hydrated.antibiotic_results = antibioticResults
    let genomicResults = parseJson<Record<string, GenomicResult>>(row.genomic_results, {})
    const markerRows = this.db.prepare(`SELECT marker_code,result,method,target,interpretation
      FROM isolate_genomic_results WHERE isolate_id = ? ORDER BY marker_code`).all(Number(row.id)) as DbRow[]
    if (markerRows.length) {
      genomicResults = Object.fromEntries(markerRows.map((item) => [String(item.marker_code), {
        result: String(item.result ?? '') as GenomicResult['result'], method: String(item.method ?? ''),
        target: String(item.target ?? ''), interpretation: String(item.interpretation ?? '')
      }]))
    }
    hydrated.genomic_results = genomicResults
    hydrated.omics = this.listOmics(Number(row.id))
    hydrated.alerts = parseJson(row.alerts, [])
    hydrated.expert_comments = parseJson(row.expert_comments, [])
    hydrated.date_of_birth = row.dob
    hydrated.diagnosis = row.diagnosis_display
    hydrated.panel_name = row.antibiotic_panel
    const customFields = parseJson<Record<string, unknown>>(row.custom_fields_json, {})
    hydrated.custom_fields = customFields
    for (const [key, value] of Object.entries(customFields)) {
      if (!(key in hydrated)) hydrated[key] = value
    }
    hydrated.no_ast_reason = row.ast_not_performed_reason
    // Read back as the structured object every caller works with. A column that fails to
    // parse is dropped rather than surfaced as a string, which would fail a type check far
    // away from the cause.
    delete hydrated.patient_residence_json
    const storedResidence = String(row.patient_residence_json ?? '').trim()
    if (storedResidence) {
      try {
        const parsed = JSON.parse(storedResidence) as PatientResidence
        if (parsed && typeof parsed === 'object') hydrated.patient_residence = parsed
      } catch {
        // Leave `patient_residence` absent.
      }
    }
    return hydrated as IsolateRecord
  }

  saveRecord(record: IsolateRecord): { id: number; alerts: unknown[]; comments: unknown[] } {
    this.ensureReady()
    const source = record as Record<string, unknown>
    const existing = source.id ? this.getRecord(Number(source.id)) : null
    const preserveHistorical = source.replace_antibiotic_results !== true
    const antibioticResults = preserveHistorical && existing
      ? { ...(existing.antibiotic_results ?? {}), ...(record.antibiotic_results ?? {}) }
      : (record.antibiotic_results ?? {})
    const prepared = this.decisionSupport.prepare({ ...record, antibiotic_results: antibioticResults })
    const errors = prepared.issues.filter((issue) => issue.severity === 'error')
    if (errors.length) throw new Error(errors.map((issue) => `${issue.field}: ${issue.message}`).join('; '))
    const duplicate = this.findDuplicate(prepared.record)
    if (duplicate) throw new Error(`Duplicate isolate identity already exists as record ${duplicate.id}.`)
    const result = this.transaction(() => this.writeRecord(prepared.record))
    this.recordAudit('isolate.save', 'ok', `Isolate ${result.id}`, {
      labCode: prepared.record.lab_code,
      status: prepared.record.record_status ?? 'final',
      warnings: prepared.issues.filter((issue) => issue.severity === 'warning').map((issue) => issue.message)
    })
    return result
  }

  /** Public, non-writing validation/canonicalization hook used by the import preview pipeline. */
  validateImportedRow(row: Row, labCode?: string): DecisionIssue[] {
    this.ensureReady()
    const source = row as Record<string, unknown>
    const prepared = this.decisionSupport.prepare({
      ...(source as IsolateRecord),
      lab_code: this.resolveLabCode(labCode ?? String(source.lab_code ?? ''))
    })
    for (const key of Object.keys(source)) delete source[key]
    Object.assign(source, prepared.record)
    const issues = [...prepared.issues]
    const duplicate = this.findDuplicate(prepared.record)
    if (duplicate) {
      issues.push({
        severity: 'error',
        field: 'specimen_number',
        message: `Matches existing isolate record ${duplicate.id}; the row was not imported again.`
      })
    }
    return issues
  }

  /**
   * Validates and normalises a patient's residence before storing it.
   *
   * Same reasoning as `normalizedAddressJson` for laboratories — the form is not the only
   * writer, so the rule lives where the write happens — with one difference: an invalid
   * residence does **not** refuse the isolate. Losing an AST result because a clerk typed a
   * postal code the pattern rejects would be a worse outcome than storing the record
   * without that field, so the offending component is dropped and the rest is kept.
   */
  private normalizedResidenceJson(value: unknown, source: Record<string, unknown>): string | null {
    if (!value || typeof value !== 'object') return null
    const residence = value as PatientResidence
    const countryCode = String(residence.country_code || source.country_code || activeProfile().country_code || '').toUpperCase()
    const candidate: PatientResidence = { ...residence, country_code: countryCode }
    const format = addressFormatFor(countryCode)
    for (const problem of validateResidence(candidate, format)) {
      if (problem.field === 'country_code') return null
      delete (candidate as unknown as Record<string, unknown>)[problem.field]
    }
    const normalized = normalizeResidence(candidate, format)
    return Object.keys(normalized).length > 1 ? JSON.stringify(normalized) : null
  }

  private writeRecord(record: IsolateRecord): { id: number; alerts: unknown[]; comments: unknown[] } {
    const source = record as Record<string, unknown>
    const lab = this.resolveLabCode(String(source.lab_code ?? ''))
    const suppliedCustom = source.custom_fields && typeof source.custom_fields === 'object' && !Array.isArray(source.custom_fields)
      ? source.custom_fields as Record<string, unknown>
      : parseJson<Record<string, unknown>>(source.custom_fields_json, {})
    const customFields: Record<string, unknown> = { ...suppliedCustom }
    const configurableFields = this.db.prepare(`SELECT field_key FROM lab_data_fields
      WHERE lab_code=? AND COALESCE(is_enabled,1)=1 ORDER BY sort_order,field_key`).all(lab) as DbRow[]
    for (const row of configurableFields) {
      const field = String(row.field_key ?? '').trim()
      if (field && !ISOLATE_COLUMNS.includes(field) && source[field] !== undefined) customFields[field] = source[field]
    }
    const data: Record<string, SqlValue> = {}
    for (const column of ISOLATE_COLUMNS) {
      let value = source[column]
      if (column === 'lab_code') value = lab
      if (column === 'dob' && value === undefined) value = source.date_of_birth
      if (column === 'diagnosis_display' && value === undefined) value = source.diagnosis
      if (column === 'antibiotic_panel' && value === undefined) value = source.panel_name
      if (column === 'ast_not_performed_reason' && value === undefined) value = source.no_ast_reason
      if (column === 'custom_fields_json') value = JSON.stringify(customFields)
      if (column === 'patient_residence_json') value = this.normalizedResidenceJson(source.patient_residence, source)
      if (column === 'antibiotic_results') value = JSON.stringify(this.compactAst(source.antibiotic_results))
      if (column === 'genomic_results') value = JSON.stringify(compactGenomic(source.genomic_results))
      if (column === 'alerts') value = JSON.stringify(Array.isArray(source.alerts) ? source.alerts : [])
      if (column === 'expert_comments') value = JSON.stringify(Array.isArray(source.expert_comments) ? source.expert_comments : [])
      if (column === 'record_status' && !value) value = 'final'
      data[column] = scalar(value)
    }
    let id = Number(source.id || 0)
    if (id) {
      const exists = this.db.prepare('SELECT 1 FROM isolates WHERE id = ?').get(id)
      if (!exists) throw new Error(`Unknown isolate record: ${id}`)
      const columns = Object.keys(data)
      this.db.prepare(`UPDATE isolates SET ${columns.map((column) => `${column} = ?`).join(', ')},
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...columns.map((column) => data[column] ?? null), id)
    } else {
      const columns = Object.keys(data)
      const result = this.db.prepare(`INSERT INTO isolates(${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
        .run(...columns.map((column) => data[column] ?? null))
      id = Number(result.lastInsertRowid)
    }
    this.db.prepare('DELETE FROM isolate_ast_results WHERE isolate_id = ?').run(id)
    const insertAst = this.db.prepare(`INSERT INTO isolate_ast_results(
      isolate_id,antibiotic_code,result,measurement,method,guideline,potency,source
    ) VALUES (?,?,?,?,?,?,?,?)`)
    const ast = this.compactAst(source.antibiotic_results)
    for (const [code, value] of Object.entries(ast)) {
      insertAst.run(id, code, scalar(value.result), value.measurement === undefined ? null : String(value.measurement), scalar(value.method),
        scalar(value.guideline), scalar(value.potency), scalar(value.source))
    }
    this.db.prepare('DELETE FROM isolate_genomic_results WHERE isolate_id = ?').run(id)
    const insertMarker = this.db.prepare(`INSERT INTO isolate_genomic_results(
      isolate_id,marker_code,result,method,target,interpretation
    ) VALUES (?,?,?,?,?,?)`)
    for (const [code, value] of Object.entries(compactGenomic(source.genomic_results))) {
      insertMarker.run(id, code, scalar(value.result), scalar(value.method), scalar(value.target), scalar(value.interpretation))
    }
    return {
      id,
      alerts: Array.isArray(source.alerts) ? source.alerts : [],
      comments: Array.isArray(source.expert_comments) ? source.expert_comments : []
    }
  }

  /** Omics artefacts recorded against one isolate, newest first. */
  listOmics(isolateId: number): Row[] {
    return this.db.prepare(`SELECT * FROM isolate_omics WHERE isolate_id = ?
      ORDER BY recorded_at DESC, id DESC`).all(Number(isolateId)) as Row[]
  }

  /**
   * Records an omics artefact. Sequencing output is never inlined into the database: the row
   * carries the size, digest and either a managed copy or a link to where the file lives.
   */
  saveOmics(entry: Record<string, unknown>): Row {
    this.ensureReady()
    const isolateId = Number(entry.isolate_id ?? entry.isolateId ?? 0)
    if (!isolateId) throw new Error('An omics record must belong to a saved isolate.')
    if (!this.db.prepare('SELECT 1 FROM isolates WHERE id = ?').get(isolateId)) throw new Error(`Unknown isolate record: ${isolateId}`)
    const omicsType = String(entry.omics_type ?? entry.omicsType ?? '').trim()
    if (!omicsType) throw new Error('Select the type of omics data before saving.')
    const columns = ['isolate_id', 'lab_code', 'omics_type', 'platform', 'file_name', 'stored_path', 'source_path',
      'file_format', 'file_size', 'sha256', 'storage_mode', 'accession', 'repository', 'analysis_tool',
      'tool_version', 'database_version', 'quality_metrics', 'result_summary', 'notes']
    const data: Record<string, SqlValue> = {}
    for (const column of columns) data[column] = scalar(entry[column])
    data.isolate_id = isolateId
    data.omics_type = omicsType
    data.file_size = Number(entry.file_size ?? 0)
    data.storage_mode = String(entry.storage_mode ?? (entry.stored_path ? 'copied' : 'linked'))
    const id = Number(entry.id ?? 0)
    if (id) {
      const owned = this.db.prepare('SELECT 1 FROM isolate_omics WHERE id = ? AND isolate_id = ?').get(id, isolateId)
      if (!owned) throw new Error(`Omics record ${id} does not belong to isolate ${isolateId}.`)
      this.db.prepare(`UPDATE isolate_omics SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE id = ?`)
        .run(...columns.map((column) => data[column] ?? null), id)
      this.recordAudit('omics.update', 'ok', `${id}: ${omicsType}`, { isolateId })
      return asDbRow(this.db.prepare('SELECT * FROM isolate_omics WHERE id = ?').get(id)) as Row
    }
    const inserted = this.db.prepare(`INSERT INTO isolate_omics(${columns.join(',')})
      VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map((column) => data[column] ?? null))
    const newId = Number(inserted.lastInsertRowid)
    this.recordAudit('omics.add', 'ok', `${newId}: ${omicsType}`, { isolateId, storageMode: data.storage_mode })
    return asDbRow(this.db.prepare('SELECT * FROM isolate_omics WHERE id = ?').get(newId)) as Row
  }

  omicsEntry(id: number): Row {
    this.ensureReady()
    const row = this.db.prepare('SELECT * FROM isolate_omics WHERE id = ?').get(Number(id))
    if (!row) throw new Error(`Unknown omics record: ${id}`)
    return asDbRow(row) as Row
  }

  /** Returns the managed copy path, if any, so the caller can remove it from disk. */
  deleteOmics(id: number): { storedPath: string } {
    this.ensureReady()
    const row = asDbRow(this.db.prepare('SELECT * FROM isolate_omics WHERE id = ?').get(Number(id)))
    if (!row.id) throw new Error(`Unknown omics record: ${id}`)
    this.db.prepare('DELETE FROM isolate_omics WHERE id = ?').run(Number(id))
    this.recordAudit('omics.delete', 'warning', `${id}: ${String(row.omics_type ?? '')}`, { isolateId: row.isolate_id })
    return { storedPath: String(row.storage_mode) === 'copied' ? String(row.stored_path ?? '') : '' }
  }

  private compactAst(value: unknown): Record<string, AstResult> {
    const parsed = typeof value === 'string' ? parseJson<Record<string, AstResult>>(value, {}) : value
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const output: Record<string, AstResult> = {}
    for (const [rawCode, rawResult] of Object.entries(parsed as Record<string, unknown>)) {
      if (!rawResult || typeof rawResult !== 'object' || Array.isArray(rawResult)) continue
      const code = normalKey((rawResult as Record<string, unknown>).code ?? rawCode)
      if (!code) continue
      const item = rawResult as Record<string, unknown>
      const result = normalKey(item.result)
      output[code] = {
        result: (['R', 'I', 'S'].includes(result) ? result : '') as AstResult['result'],
        measurement: (item.measurement ?? '') as string | number,
        method: String(item.method ?? ''), guideline: String(item.guideline ?? ''),
        potency: String(item.potency ?? ''), source: String(item.source ?? '')
      }
    }
    return output
  }

  deleteRecord(id: number): void {
    this.ensureReady()
    const row = this.db.prepare('SELECT lab_code FROM isolates WHERE id = ?').get(id)
    if (!row) throw new Error(`Unknown isolate record: ${id}`)
    this.transaction(() => {
      this.db.prepare('DELETE FROM isolate_ast_results WHERE isolate_id = ?').run(id)
      this.db.prepare('DELETE FROM isolates WHERE id = ?').run(id)
      this.recordAudit('isolate.delete', 'warning', `Isolate ${id}`, { labCode: asDbRow(row).lab_code })
    })
  }

  findDuplicate(record: IsolateRecord): IsolateRecord | null {
    this.ensureReady()
    const lab = normalKey(record.lab_code)
    const patientId = String(record.patient_id ?? '').trim()
    const specimenNumber = String(record.specimen_number ?? '').trim()
    const specimenDate = String(record.specimen_date ?? '').trim()
    const specimenCode = normalKey(record.specimen_code)
    const specimenType = String(record.specimen_type ?? '').trim()
    const organismCode = normalKey(record.organism_code)
    const organism = String(record.organism ?? '').trim()
    if (!lab || !patientId || !organism || (!specimenNumber && !specimenDate)) return null
    const conditions = ['lab_code = ?', "LOWER(TRIM(COALESCE(patient_id, ''))) = LOWER(TRIM(?))"]
    const params: SqlValue[] = [lab, patientId]
    if (organismCode) {
      conditions.push(`(UPPER(TRIM(COALESCE(organism_code, ''))) = ? OR
        (TRIM(COALESCE(organism_code, '')) = '' AND LOWER(TRIM(COALESCE(organism, ''))) = LOWER(TRIM(?))))`)
      params.push(organismCode, organism)
    } else {
      conditions.push("LOWER(TRIM(COALESCE(organism, ''))) = LOWER(TRIM(?))")
      params.push(organism)
    }
    if (specimenNumber) {
      conditions.push("LOWER(TRIM(COALESCE(specimen_number, ''))) = LOWER(TRIM(?))")
      params.push(specimenNumber)
    } else {
      conditions.push("TRIM(COALESCE(specimen_number, '')) = ''", "COALESCE(specimen_date, '') = ?")
      params.push(specimenDate)
      if (specimenCode) {
        conditions.push(`(UPPER(TRIM(COALESCE(specimen_code, ''))) = ? OR
          (TRIM(COALESCE(specimen_code, '')) = '' AND LOWER(TRIM(COALESCE(specimen_type, ''))) = LOWER(TRIM(?))))`)
        params.push(specimenCode, specimenType)
      } else {
        conditions.push("LOWER(TRIM(COALESCE(specimen_type, ''))) = LOWER(TRIM(?))")
        params.push(specimenType)
      }
    }
    if (record.id) { conditions.push('id <> ?'); params.push(record.id) }
    const row = this.db.prepare(`SELECT * FROM isolates WHERE ${conditions.join(' AND ')} ORDER BY id LIMIT 1`).get(...params)
    return row ? this.hydrateRecord(asDbRow(row)) : null
  }

  /**
   * Hold an inbound message a human must look at. Phase 26.
   *
   * Returns the queue id so the audit entry, and the acknowledgement the sender receives, can
   * both name the same item — which is what makes "the message I sent at 14:02 was rejected"
   * a question with an answer.
   */
  quarantineInbound(item: {
    labCode: string
    transport: string
    controlId: string
    payload: string
    reasons: Array<{ kind: string; location: string; message: string }>
    patientId: string
    specimenNumber: string
    specimenDate: string
    receivedFrom: string
    status?: string
  }): number {
    this.ensureReady()
    const result = this.db.prepare(`INSERT INTO inbound_quarantine(
      lab_code, transport, control_id, payload, reasons_json, patient_id, specimen_number,
      specimen_date, received_from, status
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      this.resolveLabCode(item.labCode), item.transport, item.controlId || null,
      // Capped. A sender that frames a megabyte of nonsense should not be able to fill the
      // database with it one held message at a time; the listener's own cap is the first
      // line, and this is the second.
      String(item.payload ?? '').slice(0, 256 * 1024),
      JSON.stringify(item.reasons ?? []), item.patientId || null, item.specimenNumber || null,
      item.specimenDate || null, item.receivedFrom || null, item.status ?? 'held'
    )
    return Number(result.lastInsertRowid)
  }

  /** The queue, newest first. `status` defaults to what still needs a human. */
  listInboundQuarantine(labCode?: string, status: string = 'held', limit = 200): Array<{
    id: number
    transport: string
    controlId: string
    reasons: Array<{ kind: string; location: string; message: string }>
    patientId: string
    specimenNumber: string
    specimenDate: string
    receivedFrom: string
    receivedAt: string
    status: string
  }> {
    this.ensureReady()
    const conditions: string[] = []
    const params: SqlValue[] = []
    if (labCode) { conditions.push('lab_code = ?'); params.push(this.resolveLabCode(labCode)) }
    if (status) { conditions.push('status = ?'); params.push(status) }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.db.prepare(
      `SELECT * FROM inbound_quarantine ${where} ORDER BY received_at DESC, id DESC LIMIT ?`
    ).all(...params, limit) as DbRow[]
    return rows.map((row) => ({
      id: Number(row.id),
      transport: String(row.transport ?? ''),
      controlId: String(row.control_id ?? ''),
      reasons: parseJson<Array<{ kind: string; location: string; message: string }>>(row.reasons_json, []),
      patientId: String(row.patient_id ?? ''),
      specimenNumber: String(row.specimen_number ?? ''),
      specimenDate: String(row.specimen_date ?? ''),
      receivedFrom: String(row.received_from ?? ''),
      receivedAt: String(row.received_at ?? ''),
      status: String(row.status ?? 'held')
    }))
  }

  /** The message as it arrived, for the reviewer who has to work out what the sender meant. */
  inboundQuarantinePayload(id: number): string {
    this.ensureReady()
    const row = this.db.prepare('SELECT payload FROM inbound_quarantine WHERE id = ?').get(id)
    return row ? String(asDbRow(row).payload ?? '') : ''
  }

  /**
   * Close a queue item.
   *
   * Deliberately does **not** delete it. A held message is the evidence that a laboratory sent
   * something this node could not read, and the record of that is what justifies adding the
   * mapping. Deleting on resolution would erase the reason the mapping exists.
   */
  resolveInboundQuarantine(id: number, status: 'resolved' | 'discarded', note = ''): void {
    this.ensureReady()
    const row = this.db.prepare('SELECT lab_code FROM inbound_quarantine WHERE id = ?').get(id)
    if (!row) throw new Error(`Unknown quarantine item: ${id}`)
    this.transaction(() => {
      this.db.prepare(
        'UPDATE inbound_quarantine SET status = ?, resolved_at = ?, resolved_note = ? WHERE id = ?'
      ).run(status, isoNow(), note.slice(0, 1000) || null, id)
      this.recordAudit(`inbound.quarantine.${status}`, 'ok', `Quarantine item ${id}`, {
        labCode: asDbRow(row).lab_code, note: note || undefined
      })
    })
  }

  /**
   * The isolate for one patient, specimen and date, whatever organism it names. Phase 26.
   *
   * Deliberately *not* `findDuplicate` with the organism dropped. `findDuplicate` is the rule
   * for ordinary traffic and includes the organism on purpose: one specimen growing two
   * organisms is two isolates, and a rule that ignored species would merge a polymicrobial
   * culture into one record and lose an organism.
   *
   * This looser lookup exists for exactly one caller — an inbound message the sender flagged
   * as a correction (v2 OBR-25 or OBX-11 of `C`). There, the species is the thing being
   * corrected, so matching on it would create a second isolate and leave the wrong species
   * standing. Nothing else may use it, which is why it names its purpose rather than being a
   * general-purpose finder.
   */
  findByIdentity(
    labCode: string, patientId: string, specimenNumber: string, specimenDate: string
  ): IsolateRecord | null {
    this.ensureReady()
    const lab = normalKey(labCode)
    const patient = String(patientId ?? '').trim()
    // Identity needs all three. A "correction" with no specimen number could match any of a
    // patient's isolates, and overwriting an arbitrary one is worse than filing a duplicate.
    if (!lab || !patient || !specimenNumber || !specimenDate) return null
    const row = this.db.prepare(`SELECT * FROM isolates
      WHERE lab_code = ?
        AND LOWER(TRIM(COALESCE(patient_id, ''))) = LOWER(TRIM(?))
        AND LOWER(TRIM(COALESCE(specimen_number, ''))) = LOWER(TRIM(?))
        AND COALESCE(specimen_date, '') = ?
      ORDER BY id LIMIT 1`).get(lab, patient, String(specimenNumber).trim(), specimenDate)
    return row ? this.hydrateRecord(asDbRow(row)) : null
  }

  commitImport(preview: ImportPreview | IsolateRecord[], labCode: string): BatchImportResult {
    this.ensureReady()
    const lab = this.resolveLabCode(labCode)
    const rows = Array.isArray(preview) ? preview : preview.rows
    let currentRow = 0
    let drafts = 0
    try {
      this.transaction(() => {
        rows.forEach((raw, index) => {
          currentRow = index + 1
          const prepared = this.decisionSupport.prepare({ ...(raw as Record<string, unknown>), lab_code: lab } as IsolateRecord)
          const errors = prepared.issues.filter((issue) => issue.severity === 'error')
          if (errors.length) throw new Error(errors.map((issue) => `${issue.field}: ${issue.message}`).join('; '))
          if (this.findDuplicate(prepared.record)) throw new Error('Duplicate isolate identity already exists.')
          if ((prepared.record.record_status ?? 'final') === 'draft') drafts += 1
          this.writeRecord(prepared.record)
        })
        const sourcePath = Array.isArray(preview) ? '' : preview.sourcePath
        this.db.prepare(`INSERT INTO import_runs(lab_code,source_path,imported_rows,draft_rows,failed_rows,notes)
          VALUES (?,?,?,?,0,?)`).run(lab, sourcePath, rows.length, drafts, 'Electron atomic import')
        this.recordAudit('import.commit', 'ok', `${rows.length} row(s) imported`, { labCode: lab, drafts, sourcePath })
      })
      return { imported: rows.length, drafts, failed: 0, errors: [], rolledBack: false }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.recordAudit('import.commit', 'error', 'Atomic import rolled back', { labCode: lab, row: currentRow, error: message })
      return { imported: 0, drafts: 0, failed: 1, errors: [{ row: currentRow, error: message }], rolledBack: true }
    }
  }

  getCounts(labCode?: string): DashboardCounts {
    this.ensureReady()
    const lab = normalKey(labCode)
    const labClause = lab ? ' WHERE lab_code = ?' : ''
    const labParams: SqlValue[] = lab ? [lab] : []
    const count = (sql: string, ...params: SqlValue[]): number =>
      Number(asDbRow(this.db.prepare(sql).get(...params)).count ?? 0)
    return {
      laboratoryCount: count('SELECT COUNT(*) AS count FROM laboratory WHERE COALESCE(active, 1) = 1'),
      antibioticCount: count('SELECT COUNT(*) AS count FROM master_antibiotics WHERE COALESCE(active, 1) = 1'),
      organismCount: count('SELECT COUNT(*) AS count FROM master_organisms WHERE COALESCE(active, 1) = 1'),
      panelCount: count(`SELECT COUNT(*) AS count FROM lab_panels${lab ? ' WHERE lab_code = ? AND COALESCE(active, 1) = 1' : ' WHERE COALESCE(active, 1) = 1'}`, ...labParams),
      locationCount: count(`SELECT COUNT(*) AS count FROM lab_locations${lab ? ' WHERE lab_code = ? AND COALESCE(active, 1) = 1' : ' WHERE COALESCE(active, 1) = 1'}`, ...labParams),
      isolateCount: count(`SELECT COUNT(*) AS count FROM isolates${labClause}`, ...labParams),
      draftCount: count(`SELECT COUNT(*) AS count FROM isolates${lab ? " WHERE lab_code = ? AND COALESCE(record_status, 'final') = 'draft'" : " WHERE COALESCE(record_status, 'final') = 'draft'"}`, ...labParams),
      finalCount: count(`SELECT COUNT(*) AS count FROM isolates${lab ? " WHERE lab_code = ? AND COALESCE(record_status, 'final') <> 'draft'" : " WHERE COALESCE(record_status, 'final') <> 'draft'"}`, ...labParams),
      breakpointCount: count(`SELECT COUNT(*) AS count FROM whonet_user_breakpoints ub
        LEFT JOIN master_breakpoint_sets bs ON bs.id = ub.source_set_id
        WHERE COALESCE(ub.active, 1) = 1 AND (ub.source_set_id IS NULL OR bs.active = 1)`)
    }
  }

  runAnalysis(filters: AnalysisFilters): AnalysisResult {
    this.ensureReady()
    const records = filters.recordId
      ? [this.getRecord(filters.recordId)].filter((item): item is IsolateRecord => Boolean(item))
      : this.listRecords({
        labCode: filters.labCode,
        includeDrafts: filters.includeDrafts ?? false,
        organism: filters.organism,
        organisms: filters.organisms,
        specimenType: filters.specimenType,
        specimenTypes: filters.specimenTypes,
        locationType: filters.locationType,
        periodStart: filters.periodStart,
        periodEnd: filters.periodEnd,
        limit: 100_000
      })
    return runDeterministicAnalysis(records, filters, { truncated: !filters.recordId && records.length >= 100_000 })
  }

  recordAudit(
    operation: string,
    status: 'ok' | 'error' | 'warning',
    summary: string,
    details?: Record<string, unknown>,
    actor = 'local-operator'
  ): void {
    this.db.prepare(`INSERT INTO app_audit_log(timestamp,operation,status,summary,details,actor)
      VALUES (?,?,?,?,?,?)`).run(isoNow(), operation, status, summary.slice(0, 1000),
      details ? JSON.stringify(details) : null, actor)
  }

  listAudit(limit = 200): Array<{
    timestamp: string
    operation: string
    status: 'ok' | 'error' | 'warning'
    summary: string
    details?: string
  }> {
    this.ensureReady()
    return (this.db.prepare(`SELECT timestamp,operation,status,summary,details FROM app_audit_log
      ORDER BY id DESC LIMIT ?`).all(safeLimit(limit, 200)) as DbRow[]).map((row) => ({
      timestamp: String(row.timestamp),
      operation: String(row.operation),
      status: String(row.status) as 'ok' | 'error' | 'warning',
      summary: String(row.summary),
      ...(row.details ? { details: String(row.details) } : {})
    }))
  }

  executeAggregateQuery(queryType: string, filters: Record<string, unknown> = {}): Record<string, unknown> {
    this.ensureReady()
    const supported = new Set(['resistance_rate', 'isolate_count', 'organism_distribution',
      'specimen_distribution', 'measure_bundle', 'cluster_scan', 'heartbeat'])
    const type = String(queryType ?? '').trim().toLocaleLowerCase()
    if (!supported.has(type)) throw new Error(`Unsupported aggregate query type: ${type || '(empty)'}`)
    const lab = this.resolveLabCode(String(filters.lab_code ?? filters.labCode ?? ''))
    if (type === 'heartbeat') return { ok: true, lab_code: lab, timestamp: isoNow() }
    const records = this.listRecords({
      labCode: lab,
      includeDrafts: false,
      organism: filters.organism,
      specimenType: filters.specimen_type ?? filters.specimenType,
      locationType: filters.location_type ?? filters.locationType,
      periodStart: filters.period_start ?? filters.periodStart,
      periodEnd: filters.period_end ?? filters.periodEnd,
      limit: 100_000
    })
    if (type === 'isolate_count') return { count: records.length }
    if (type === 'cluster_scan') {
      const requested = Number(filters.deduplication_days ?? filters.deduplicationDays ?? 30)
      return aggregateOutbreakCases(records, Number.isFinite(requested) ? Math.max(0, Math.min(365, Math.trunc(requested))) : 30)
    }
    if (type === 'organism_distribution' || type === 'specimen_distribution') {
      const organismMode = type === 'organism_distribution'
      const buckets: Record<string, number> = {}
      const bucket_codings: Record<string, Record<string, string>> = {}
      for (const record of records) {
        const label = String(organismMode ? record.organism : record.specimen_type).trim() || 'Unknown'
        buckets[label] = (buckets[label] ?? 0) + 1
        const code = String(organismMode ? record.organism_code : record.specimen_code).trim()
        if (code && !bucket_codings[label]) bucket_codings[label] = {
          system: String(organismMode ? record.organism_system ?? 'urn:whonet:organism-code' : record.specimen_system ?? 'urn:whonet:specimen-code'),
          code,
          display: label
        }
      }
      return { total: records.length, buckets, bucket_codings }
    }
    const antibioticCode = normalKey(filters.antibiotic_code ?? filters.antibioticCode)
    if (!antibioticCode) throw new Error(`${type} query requires antibiotic_code.`)
    let denominator = 0
    let numerator = 0
    const byOrigin: Record<string, { denominator: number; numerator: number }> = {}
    for (const record of records) {
      const result = normalKey(record.antibiotic_results?.[antibioticCode]?.result)
      if (!['R', 'I', 'S'].includes(result)) continue
      denominator += 1
      if (result === 'R') numerator += 1
      const origin = this.infectionOrigin(record)
      const bucket = byOrigin[origin] ?? { denominator: 0, numerator: 0 }
      bucket.denominator += 1
      if (result === 'R') bucket.numerator += 1
      byOrigin[origin] = bucket
    }
    const aggregate = {
      antibiotic_code: antibioticCode,
      denominator,
      numerator,
      rate_percent: denominator ? Number(((numerator / denominator) * 100).toFixed(2)) : 0,
      by_origin: byOrigin
    }
    if (type === 'resistance_rate') return aggregate
    const labDetails = this.getLab(lab) as Laboratory
    return {
      resourceType: 'Bundle',
      type: 'collection',
      timestamp: isoNow(),
      identifier: { system: aggregateIdentifierSystem(), value: randomUUID() },
      entry: [{ resource: {
        resourceType: 'MeasureReport',
        id: randomUUID(),
        status: 'complete',
        type: 'summary',
        measure: resistanceMeasureUrn(antibioticCode),
        date: isoNow(),
        period: { start: String(filters.period_start ?? filters.periodStart ?? ''), end: String(filters.period_end ?? filters.periodEnd ?? '') },
        reporter: { identifier: { system: laboratoryIdentifierSystem(), value: lab }, display: labDetails.name },
        group: [{ code: { text: antibioticCode }, population: [
          { code: { text: 'tested' }, count: denominator },
          { code: { text: 'resistant' }, count: numerator }
        ], measureScore: { value: aggregate.rate_percent, unit: '%' } }]
      }}]
    }
  }

  private infectionOrigin(record: IsolateRecord): string {
    const type = normalText(record.location_type)
    if (type.includes('outpatient') || type.includes('community')) return 'Community'
    const admission = Date.parse(String(record.admission_date ?? ''))
    const specimen = Date.parse(String(record.specimen_date ?? ''))
    if (Number.isFinite(admission) && Number.isFinite(specimen)) {
      return specimen - admission >= 48 * 60 * 60 * 1000 ? 'Hospital' : 'Community'
    }
    return type.includes('inpatient') || type.includes('icu') ? 'Hospital' : 'Unknown'
  }

  listImportProfiles(labCode: string): ImportProfile[] {
    this.ensureReady()
    const lab = this.resolveLabCode(labCode)
    return (this.db.prepare('SELECT * FROM import_profiles WHERE lab_code = ? ORDER BY profile_name, id').all(lab) as DbRow[])
      .map((row) => ({
        id: Number(row.id),
        lab_code: String(row.lab_code),
        profile_name: String(row.profile_name),
        file_format: String(row.source_kind ?? 'delimited'),
        delimiter: String(row.delimiter ?? ','),
        mapping: {
          ...parseJson<Record<string, string>>(row.core_mapping, {}),
          ...parseJson<Record<string, string>>(row.antibiotic_mapping, {})
        },
        defaults: parseJson<Record<string, string>>(row.default_values, {}),
        updated_at: String(row.updated_at ?? row.created_at ?? '')
      }))
  }

  saveImportProfile(profile: ImportProfile): ImportProfile {
    this.ensureReady()
    const source = profile as ImportProfile & { antibiotic_mapping?: Record<string, string>; notes?: string; has_header?: boolean }
    const lab = this.resolveLabCode(source.lab_code)
    const name = String(source.profile_name ?? '').trim()
    if (!name) throw new Error('Import profile name is required.')
    let id = Number(source.id || 0)
    this.transaction(() => {
      if (id) {
        const result = this.db.prepare(`UPDATE import_profiles SET profile_name=?,source_kind=?,delimiter=?,has_header=?,
          core_mapping=?,antibiotic_mapping=?,default_values=?,notes=?,updated_at=CURRENT_TIMESTAMP
          WHERE id=? AND lab_code=?`).run(
          name, source.file_format || 'delimited', source.delimiter || ',', source.has_header === false ? 0 : 1,
          JSON.stringify(source.mapping ?? {}), JSON.stringify(source.antibiotic_mapping ?? {}),
          JSON.stringify(source.defaults ?? {}), scalar(source.notes), id, lab
        )
        if (Number(result.changes) !== 1) throw new Error(`Unknown import profile: ${id}`)
      } else {
        const result = this.db.prepare(`INSERT INTO import_profiles(
          lab_code,profile_name,source_kind,delimiter,has_header,core_mapping,antibiotic_mapping,default_values,notes
        ) VALUES (?,?,?,?,?,?,?,?,?)`).run(
          lab, name, source.file_format || 'delimited', source.delimiter || ',', source.has_header === false ? 0 : 1,
          JSON.stringify(source.mapping ?? {}), JSON.stringify(source.antibiotic_mapping ?? {}),
          JSON.stringify(source.defaults ?? {}), scalar(source.notes)
        )
        id = Number(result.lastInsertRowid)
      }
      this.recordAudit('import.profile.save', 'ok', `${id}: ${name}`, { labCode: lab })
    })
    return this.listImportProfiles(lab).find((item) => item.id === id) as ImportProfile
  }

  deleteImportProfile(id: number): void {
    this.ensureReady()
    const row = this.db.prepare('SELECT lab_code,profile_name FROM import_profiles WHERE id = ?').get(id)
    if (!row) throw new Error(`Unknown import profile: ${id}`)
    this.transaction(() => {
      this.db.prepare('UPDATE import_runs SET profile_id = NULL WHERE profile_id = ?').run(id)
      this.db.prepare('DELETE FROM import_profiles WHERE id = ?').run(id)
      this.recordAudit('import.profile.delete', 'warning', `${id}: ${String(asDbRow(row).profile_name)}`, {
        labCode: asDbRow(row).lab_code
      })
    })
  }

  listImportHistory(labCode: string, limit = 100): Row[] {
    this.ensureReady()
    const lab = this.resolveLabCode(labCode)
    return this.db.prepare(`SELECT ir.*,ip.profile_name FROM import_runs ir
      LEFT JOIN import_profiles ip ON ip.id=ir.profile_id WHERE ir.lab_code=? ORDER BY ir.id DESC LIMIT ?`)
      .all(lab, safeLimit(limit, 100)) as Row[]
  }

  listAnalysisMacros(labCode: string): Row[] {
    this.ensureReady()
    const lab = this.resolveLabCode(labCode)
    return (this.db.prepare('SELECT * FROM analysis_macros WHERE lab_code=? ORDER BY macro_name,id').all(lab) as DbRow[])
      .map((row) => ({ ...row, config: parseJson(row.config_json, {}) } as unknown as Row))
  }

  saveAnalysisMacro(labCode: string, macro: Row): Row {
    this.ensureReady()
    const lab = this.resolveLabCode(labCode)
    const source = macro as Record<string, unknown>
    const name = String(source.macro_name ?? source.name ?? '').trim()
    if (!name) throw new Error('Analysis macro name is required.')
    const config = source.config ?? parseJson(source.config_json, {})
    let id = Number(source.id || 0)
    this.transaction(() => {
      if (id) {
        const result = this.db.prepare('UPDATE analysis_macros SET macro_name=?,config_json=? WHERE id=? AND lab_code=?')
          .run(name, JSON.stringify(config), id, lab)
        if (Number(result.changes) !== 1) throw new Error(`Unknown analysis macro: ${id}`)
      } else {
        const existing = this.db.prepare('SELECT id FROM analysis_macros WHERE lab_code=? AND macro_name=?').get(lab, name)
        if (existing) {
          id = Number(asDbRow(existing).id)
          this.db.prepare('UPDATE analysis_macros SET config_json=? WHERE id=?').run(JSON.stringify(config), id)
        } else {
          id = Number(this.db.prepare('INSERT INTO analysis_macros(lab_code,macro_name,config_json) VALUES (?,?,?)')
            .run(lab, name, JSON.stringify(config)).lastInsertRowid)
        }
      }
      this.recordAudit('analysis.macro.save', 'ok', `${id}: ${name}`, { labCode: lab })
    })
    return this.listAnalysisMacros(lab).find((item) => Number(item.id) === id) as Row
  }

  deleteAnalysisMacro(id: number): void {
    this.ensureReady()
    const row = this.db.prepare('SELECT lab_code,macro_name FROM analysis_macros WHERE id=?').get(id)
    if (!row) throw new Error(`Unknown analysis macro: ${id}`)
    this.db.prepare('DELETE FROM analysis_macros WHERE id=?').run(id)
    this.recordAudit('analysis.macro.delete', 'warning', `${id}: ${String(asDbRow(row).macro_name)}`, {
      labCode: asDbRow(row).lab_code
    })
  }

  async stageBreakpointSet(input: {
    sourcePath: string
    sourceName: string
    sourceHash: string
    source: BreakpointSource
    rows: BreakpointRow[]
    activate: false
  }): Promise<{ imported: number; skipped: number; errors?: string[] }> {
    this.ensureReady()
    if (input.activate !== false) throw new Error('Breakpoint imports must be staged inactive and activated explicitly.')
    const hash = String(input.sourceHash ?? '').trim().toLocaleLowerCase()
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('A valid SHA-256 source hash is required.')
    // The same file read by the same mapping is a repeat and is refused. The same file read
    // by a newer mapping is not: it produces different codes, and a laboratory that staged
    // an edition under an older reading has to be able to stage it again.
    const priorImports = this.db.prepare('SELECT id,breakpoint_set_id,mapping_version,status FROM breakpoint_imports WHERE source_hash=?')
      .all(hash) as DbRow[]
    if (priorImports.some((item) => Number(item.mapping_version ?? 1) >= BREAKPOINT_MAPPING_VERSION)) {
      return { imported: 0, skipped: input.rows.length, errors: ['This exact source hash is already staged.'] }
    }
    const organization = String(input.source.publisher || input.source.guideline || 'Local').trim()
    const edition = String(input.source.edition || '').trim()
    const baseName = String(input.sourceName || 'Breakpoint set').trim()
    // Named after any superseded set has been dropped below, so a re-read of the same
    // source reclaims its own name instead of accumulating hash-suffixed copies.
    let setName = baseName
    const errors: string[] = []
    const warnings: string[] = []
    let imported = 0
    let unmatchedRows = 0
    const provisionalCode = (kind: 'ABX' | 'ORG', name: string): string => {
      const token = name.normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase().slice(0, 32) || 'UNNAMED'
      const suffix = createHash('sha256').update(`${kind}:${normalText(name)}`).digest('hex').slice(0, 8).toUpperCase()
      return `CLSI_NAME:${kind}:${token}:${suffix}`
    }
    const antibioticByName = this.db.prepare(`SELECT code FROM master_antibiotics
      WHERE LOWER(TRIM(name))=LOWER(TRIM(?)) ORDER BY COALESCE(active,1) DESC,is_custom ASC,code LIMIT 1`)
    const organismByName = this.db.prepare(`SELECT code FROM master_organisms
      WHERE LOWER(TRIM(organism_name))=LOWER(TRIM(?)) ORDER BY COALESCE(active,1) DESC,is_custom ASC,code LIMIT 1`)
    // Punctuation is the only difference between a guideline's "Amoxicillin-clavulanic
    // acid" and the catalogue's "Amoxicillin/Clavulanic acid", so the catalogue is indexed
    // once by a punctuation-free key rather than compared string by string per row.
    const antibioticsByKey = new Map<string, string>()
    for (const item of this.db.prepare('SELECT code,name FROM master_antibiotics ORDER BY COALESCE(active,1) DESC,is_custom ASC,code').all() as DbRow[]) {
      const key = canonicalAgentKey(String(item.name ?? ''))
      if (key && !antibioticsByKey.has(key)) antibioticsByKey.set(key, String(item.code ?? ''))
    }
    const lookupAntibiotic = (name: string): string => {
      const trimmed = String(name ?? '').trim()
      if (!trimmed) return ''
      const exact = antibioticByName.get(trimmed)
      if (exact) return String(asDbRow(exact).code)
      const key = canonicalAgentKey(trimmed)
      const alias = AGENT_NAME_ALIASES[key]
      return antibioticsByKey.get(key) ?? (alias ? antibioticsByKey.get(canonicalAgentKey(alias)) ?? '' : '')
    }
    const resolveAntibioticCode = (row: BreakpointRow, label: AgentLabel): { code: string; provisional: boolean } => {
      if (String(row.antibiotic_code ?? '').trim()) return { code: normalKey(row.antibiotic_code), provisional: false }
      const matched = lookupAntibiotic(row.antibiotic_name) || lookupAntibiotic(label.base)
      if (matched) return { code: matched, provisional: false }
      return { code: provisionalCode('ABX', row.antibiotic_name), provisional: true }
    }
    /**
     * The organism a row applies to: a catalogue code where the catalogue has one, and
     * otherwise a named scope.
     *
     * A guideline writes its rows against groups — "Enterobacterales", "Coagulase-negative
     * staphylococci", "Enterobacterales except Morganellaceae" — and against species the
     * local catalogue may not carry. Coding those as provisional left every row of every
     * EUCAST edition unmatched, which held the activation gate shut for ever. A scope code
     * is not a guess: it carries a membership rule that decides, at interpretation time,
     * whether an isolate is inside it.
     */
    const resolveOrganismCode = (row: BreakpointRow, label: AgentLabel): {
      code: string
      codeType: string
      provisional: boolean
      scopeName: string
    } => {
      if (String(row.organism_code ?? '').trim() && !label.restriction) {
        return { code: normalKey(row.organism_code), codeType: 'WHONET', provisional: false, scopeName: '' }
      }
      // A restriction appended to the agent ("Meropenem, P. aeruginosa") narrows the sheet's
      // organism, so it wins over it. Widening back to the sheet would apply a
      // species breakpoint to a whole order.
      const target = label.restriction || String(row.organism_name ?? '')
      // The catalogue's own spelling first: a laboratory that files E. coli under that name
      // must not have its row diverted to a scope. The synonym is only a fallback.
      const alias = organismNameForLabel(target)
      const matched = organismByName.get(target) ?? (alias ? organismByName.get(alias) : undefined)
      if (matched) return { code: String(asDbRow(matched).code), codeType: 'WHONET', provisional: false, scopeName: '' }
      const scope = organismScopeForLabel(target)
      if (scope) return { code: scope.code, codeType: 'GROUP', provisional: false, scopeName: scope.name }
      // A named species the catalogue has not got yet is still a definite scope: it matches
      // that species and nothing else, the day the laboratory adds it.
      if (alias) return { code: speciesScopeCode(alias), codeType: 'GROUP', provisional: false, scopeName: alias }
      return { code: provisionalCode('ORG', target), codeType: 'text', provisional: true, scopeName: '' }
    }
    this.transaction(() => {
      // A superseded staging of the same file is dropped rather than left beside the new
      // one, so nobody has to choose between two sets of the same edition.
      //
      // Only a set that was never activated is dropped. `status` is 'staged' until an
      // activation moves it to 'active' and then 'inactive', so a set that has ever
      // interpreted a result keeps its rows: those results cite the row they came from, and
      // deleting it would leave a report pointing at a breakpoint that no longer exists.
      for (const prior of priorImports) {
        const priorSetId = Number(prior.breakpoint_set_id ?? 0)
        if (!priorSetId || String(prior.status ?? 'staged') !== 'staged') continue
        const priorSet = asDbRow(this.db.prepare('SELECT id,name,active FROM master_breakpoint_sets WHERE id=?').get(priorSetId))
        if (!priorSet.id || Number(priorSet.active ?? 0) === 1) continue
        this.db.prepare('DELETE FROM whonet_user_breakpoints WHERE source_set_id=?').run(priorSetId)
        this.db.prepare('DELETE FROM breakpoint_imports WHERE id=?').run(Number(prior.id))
        this.db.prepare('DELETE FROM master_breakpoint_sets WHERE id=?').run(priorSetId)
        this.recordAudit('breakpoint.restage', 'warning',
          `${String(priorSet.name)}: replaced by a re-read of the same source`,
          { sourceHash: hash, priorSetId, priorMappingVersion: Number(prior.mapping_version ?? 1) })
      }
      const colliding = this.db.prepare(`SELECT 1 FROM master_breakpoint_sets
        WHERE organization=? AND COALESCE(edition,'')=? AND name=?`).get(organization, edition, baseName)
      if (colliding) setName = `${baseName} [${hash.slice(0, 8)}]`
      const setId = Number(this.db.prepare(`INSERT INTO master_breakpoint_sets(
        name,organization,edition,year,source_url,source_hash,active,notes
      ) VALUES (?,?,?,?,?,?,0,?)`).run(
        setName, organization, edition, edition.match(/\b(19|20)\d{2}\b/)?.[0] ?? '',
        scalar(input.source.url), hash, `Staged from ${input.sourcePath}`
      ).lastInsertRowid)
      const importId = Number(this.db.prepare(`INSERT INTO breakpoint_imports(
        breakpoint_set_id,source_name,source_path,source_url,source_hash,source_format,row_count,
        imported_rows,skipped_rows,errors_json,warnings_json,unmatched_rows,metadata_json,status,mapping_version
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'staged',?)`).run(
        setId, baseName, input.sourcePath, scalar(input.source.url), hash,
        input.sourcePath.split('.').pop()?.toLocaleLowerCase() ?? '', input.rows.length, 0, 0, '[]', '[]', 0,
        JSON.stringify(input.source), BREAKPOINT_MAPPING_VERSION
      ).lastInsertRowid)
      const insert = this.db.prepare(`INSERT INTO whonet_user_breakpoints(
        guidelines,year,test_method,potency,organism_code,organism_code_type,breakpoint_type,host,
        site_of_infection,route,whonet_abx_code,whonet_test,r_value,i_value,sdd_value,s_value,ecv_ecoff,comments,
        active,is_custom,source_set_id,source_import_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,?,?)`)
      input.rows.forEach((row, index) => {
        const label = parseAgentLabel(row.antibiotic_name)
        const resolvedAntibiotic = resolveAntibioticCode(row, label)
        const resolvedOrganism = resolveOrganismCode(row, label)
        const antibiotic = resolvedAntibiotic.code
        const organism = resolvedOrganism.code
        if (!antibiotic || !organism || (!row.susceptible && !row.intermediate && !row.resistant)) {
          errors.push(`Row ${index + 1}: antimicrobial, organism and at least one S/I/R value are required.`)
          return
        }
        const provisionalParts = [
          resolvedAntibiotic.provisional ? `antimicrobial "${row.antibiotic_name}"` : '',
          resolvedOrganism.provisional ? `organism "${label.restriction || row.organism_name}"` : ''
        ].filter(Boolean)
        if (provisionalParts.length) {
          unmatchedRows += 1
          warnings.push(`Row ${index + 1}: unmatched ${provisionalParts.join(' and ')}; assigned provisional namespaced code pending master mapping.`)
        }
        const comments = [
          row.antibiotic_name ? `Antimicrobial: ${row.antibiotic_name}` : '',
          row.organism_name ? `Organism: ${row.organism_name}` : '',
          resolvedOrganism.scopeName ? `Scope: ${resolvedOrganism.scopeName}` : '',
          label.restriction ? `Restricted by the guideline to: ${label.restriction}` : '',
          label.route ? `Route: ${label.route === 'iv' ? 'intravenous' : 'oral'}` : '',
          label.notes.length ? `Guideline qualifier: ${label.notes.join('; ')}` : '',
          provisionalParts.length ? `VALIDATION WARNING: provisional code(s) ${antibiotic}, ${organism}; review before activation` : '',
          row.units ? `Units: ${row.units}` : '',
          row.fda_susceptible || row.fda_intermediate || row.fda_resistant
            ? `FDA S/I/R: ${row.fda_susceptible || '-'} / ${row.fda_intermediate || '-'} / ${row.fda_resistant || '-'}` : '',
          row.clsi_fda_match ? `CLSI-FDA match: ${row.clsi_fda_match}` : '', row.comments || '',
          row.source_sheet ? `Sheet: ${row.source_sheet}` : ''
        ].filter(Boolean).join('; ')
        insert.run(
          row.guideline || input.source.guideline || 'CLSI', row.edition || edition, row.test_method || 'MIC', null,
          organism, resolvedOrganism.codeType, label.breakpointType, null, label.site || null, label.route || null,
          antibiotic, antibiotic, row.resistant || null, row.intermediate || null, null, row.susceptible || null, null,
          comments, setId, importId
        )
        imported += 1
      })
      this.db.prepare(`UPDATE breakpoint_imports SET imported_rows=?,skipped_rows=?,errors_json=?,warnings_json=?,unmatched_rows=? WHERE id=?`)
        .run(imported, input.rows.length - imported, JSON.stringify(errors), JSON.stringify(warnings), unmatchedRows, importId)
      this.db.prepare(`UPDATE master_breakpoint_sets SET source_import_id=?,unmatched_count=?,validation_status=? WHERE id=?`)
        .run(importId, unmatchedRows, unmatchedRows ? 'needs_mapping_review' : 'ready', setId)
      this.recordAudit('breakpoint.stage', 'ok', `${setName}: ${imported} row(s) staged inactive`, {
        sourceHash: hash, skipped: input.rows.length - imported, unmatchedRows, setId, importId
      })
    })
    const notices = [...errors, ...warnings]
    return { imported, skipped: input.rows.length - imported, ...(notices.length ? { errors: notices } : {}) }
  }

  listBreakpointSets(): Row[] {
    this.ensureReady()
    return this.db.prepare(`SELECT bs.*,bi.status AS import_status,bi.imported_rows,bi.skipped_rows,bi.imported_at,
      (SELECT COUNT(*) FROM whonet_user_breakpoints ub WHERE ub.source_set_id=bs.id) AS breakpoint_count
      FROM master_breakpoint_sets bs LEFT JOIN breakpoint_imports bi ON bi.id=bs.source_import_id
      ORDER BY bs.active DESC,bs.created_at DESC,bs.id DESC`).all() as Row[]
  }

  activateBreakpointSet(id: number): Row {
    this.ensureReady()
    const set = this.db.prepare('SELECT * FROM master_breakpoint_sets WHERE id=?').get(id)
    if (!set) throw new Error(`Unknown breakpoint set: ${id}`)
    const breakpointSet = asDbRow(set)
    const validationStatus = String(breakpointSet.validation_status ?? 'ready')
    const unmatchedCount = Number(breakpointSet.unmatched_count ?? 0)
    if (validationStatus !== 'ready' || unmatchedCount > 0) {
      throw new Error(`Breakpoint set requires mapping review before activation (${unmatchedCount} unmatched row(s), status ${validationStatus}).`)
    }
    const rowCount = Number(asDbRow(this.db.prepare(
      'SELECT COUNT(*) AS count FROM whonet_user_breakpoints WHERE source_set_id=?'
    ).get(id)).count ?? 0)
    if (!rowCount) throw new Error('An empty breakpoint set cannot be activated.')
    this.transaction(() => {
      this.db.prepare('UPDATE master_breakpoint_sets SET active=0,updated_at=CURRENT_TIMESTAMP').run()
      this.db.prepare('UPDATE master_breakpoint_sets SET active=1,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(id)
      this.db.prepare('UPDATE whonet_user_breakpoints SET active=0 WHERE source_set_id IS NOT NULL').run()
      this.db.prepare('UPDATE whonet_user_breakpoints SET active=1 WHERE source_set_id=?').run(id)
      this.db.prepare("UPDATE breakpoint_imports SET status='inactive' WHERE breakpoint_set_id<>?").run(id)
      this.db.prepare("UPDATE breakpoint_imports SET status='active' WHERE breakpoint_set_id=?").run(id)
      this.recordAudit('breakpoint.activate', 'warning', `${id}: ${String(breakpointSet.name)}`, {
        organization: breakpointSet.organization, edition: breakpointSet.edition, rowCount
      })
    })
    return this.listBreakpointSets().find((row) => Number(row.id) === id) as Row
  }

  hasOneHealthUsers(): boolean {
    this.ensureReady()
    return Number(asDbRow(this.db.prepare('SELECT COUNT(*) AS count FROM national_users').get()).count ?? 0) > 0
  }

  bootstrapOneHealthAdmin(usernameInput: string, passwordInput: string): OneHealthIdentity {
    this.ensureReady()
    const username = validatedUsername(usernameInput)
    const password = validatedPassword(passwordInput)
    let identity: OneHealthIdentity | undefined
    this.transaction(() => {
      const count = Number(asDbRow(this.db.prepare('SELECT COUNT(*) AS count FROM national_users').get()).count ?? 0)
      if (count !== 0) throw new Error('The first One Health administrator has already been configured.')
      const id = randomUUID()
      const roles: OneHealthRole[] = ['administrator']
      this.db.prepare(`INSERT INTO national_users(
        id,username,password_hash,roles_json,active,created_at,last_login_at
      ) VALUES (?,?,?,?,1,?,?)`).run(id, username, hashPassword(password), JSON.stringify(roles), isoNow(), isoNow())
      this.recordNationalAudit(username, 'user.bootstrap', 'user', id, { roles })
      this.recordAudit('one-health.user.bootstrap', 'ok', `${username}: first administrator`, { roles }, username)
      identity = { id, username, roles }
    })
    return identity as OneHealthIdentity
  }

  createOneHealthUser(
    input: { username: string; password: string; roles: string[] },
    identity: OneHealthIdentity
  ): Row {
    this.ensureReady()
    requirePermission(identity, 'users:manage')
    const actor = identityActor(identity)
    const username = validatedUsername(input.username)
    const password = validatedPassword(input.password)
    const roles = normalizeRoles(input.roles)
    if (!roles.length || roles.length !== new Set(input.roles.map((role) => role.trim().toLocaleLowerCase())).size) {
      throw new Error('Select one or more supported roles.')
    }
    if (this.db.prepare('SELECT 1 FROM national_users WHERE username=? COLLATE NOCASE').get(username)) {
      throw new Error(`One Health username already exists: ${username}`)
    }
    const id = randomUUID()
    this.transaction(() => {
      this.db.prepare(`INSERT INTO national_users(
        id,username,password_hash,roles_json,active,created_at,last_login_at
      ) VALUES (?,?,?,?,1,?,NULL)`).run(id, username, hashPassword(password), JSON.stringify(roles), isoNow())
      this.recordNationalAudit(actor, 'user.create', 'user', id, { roles, username })
      this.recordAudit('one-health.user.create', 'ok', `${username}: ${roles.join(', ')}`, { roles }, actor)
    })
    return this.listOneHealthUsers(identity).find((row) => row.id === id) as Row
  }

  listOneHealthUsers(identity: OneHealthIdentity): Row[] {
    this.ensureReady()
    requirePermission(identity, 'users:manage')
    return (this.db.prepare(`SELECT id,username,roles_json,active,created_at,last_login_at
      FROM national_users ORDER BY active DESC,username`).all() as DbRow[]).map((row) => ({
      id: String(row.id),
      username: String(row.username),
      roles: parseJson<string[]>(row.roles_json, []),
      active: Boolean(row.active),
      created_at: String(row.created_at),
      last_login_at: row.last_login_at === null ? null : String(row.last_login_at)
    }))
  }

  authenticateOneHealth(usernameInput: string, passwordInput: string): OneHealthIdentity | null {
    this.ensureReady()
    const username = String(usernameInput ?? '').trim()
    const password = String(passwordInput ?? '')
    if (!username || !password) return null
    const row = this.db.prepare('SELECT * FROM national_users WHERE username=? COLLATE NOCASE AND active=1').get(username)
    if (!row) return null
    const user = asDbRow(row)
    if (!verifyPassword(password, String(user.password_hash ?? ''))) return null
    const roles = normalizeRoles(parseJson<string[]>(user.roles_json, []))
    if (!roles.length) return null
    this.db.prepare('UPDATE national_users SET last_login_at=? WHERE id=?').run(isoNow(), scalar(user.id))
    return { id: String(user.id), username: String(user.username), roles }
  }

  private configuredOneHealthFields(module: OneHealthModule): OneHealthField[] {
    const fields = module.fields.map((item) => ({
      ...item,
      ...(item.choices ? { choices: [...item.choices] } : {})
    }))
    const byKey = new Map(fields.map((item) => [item.key, item]))
    const lab = this.currentLab()?.code
    if (lab) {
      const overrides = this.db.prepare(`SELECT * FROM lab_data_fields WHERE lab_code=? AND
        LOWER(TRIM(field_group)) IN (?,?) ORDER BY sort_order,field_key`).all(
        lab, `one_health:${module.key}`, `one-health:${module.key}`
      ) as DbRow[]
      for (const row of overrides) {
        const fieldKey = String(row.field_key ?? '').trim()
        if (!fieldKey) continue
        const existing = byKey.get(fieldKey)
        if ((!row.is_enabled || row.is_hidden) && !existing?.required) {
          if (existing) byKey.delete(fieldKey)
          continue
        }
        const response = parseJson<unknown>(row.response_codes, [])
        const metadata = response && typeof response === 'object' && !Array.isArray(response)
          ? response as Record<string, unknown>
          : {}
        const responseChoices = Array.isArray(response)
          ? response.map(String).filter(Boolean)
          : Array.isArray(metadata.choices) ? metadata.choices.map(String).filter(Boolean) : undefined
        const configuredKind = normalText(metadata.kind ?? row.category)
        const kind = ['text', 'number', 'boolean', 'datetime', 'choice'].includes(configuredKind)
          ? configuredKind as OneHealthField['kind']
          : responseChoices?.length ? 'choice' : existing?.kind ?? 'text'
        const configured: OneHealthField = {
          key: fieldKey,
          label: String(row.field_label ?? existing?.label ?? fieldKey),
          kind,
          required: existing?.required ?? metadata.required === true,
          ...(responseChoices?.length ? { choices: responseChoices } : existing?.choices ? { choices: [...existing.choices] } : {}),
          ...(metadata.helpText ? { helpText: String(metadata.helpText) } : existing?.helpText ? { helpText: existing.helpText } : {})
        }
        byKey.set(fieldKey, configured)
      }
    }
    const facilityField = byKey.get('facility_id')
    if (facilityField) {
      const configuredFacilities = (this.db.prepare(`SELECT code FROM master_hospitals WHERE COALESCE(active,1)=1
        AND (domain_code=? OR TRIM(COALESCE(domain_code,''))='') ORDER BY sort_order,name,code`).all(module.domain) as DbRow[])
        .map((row) => normalKey(row.code)).filter(Boolean)
      if (lab) configuredFacilities.unshift(normalKey(lab))
      const choices = [...new Set(configuredFacilities)]
      if (choices.length) byKey.set('facility_id', { ...facilityField, kind: 'choice', choices })
    }
    return [...byKey.values()]
  }

  oneHealthModules(): Row[] {
    this.ensureReady()
    const domains = new Map((this.db.prepare(`SELECT code,label,description,colour,active,sort_order
      FROM master_lab_domains ORDER BY sort_order,label,code`).all() as DbRow[]).map((row) => [normalKey(row.code), row]))
    return oneHealthCatalog().flatMap((module) => {
      const domain = domains.get(module.domain)
      if (!domain || !domain.active) return []
      return [{
        key: module.key,
        title: module.title,
        domain: module.domain,
        domain_label: String(domain.label ?? module.domain),
        domain_colour: String(domain.colour ?? ''),
        event_type: module.eventType,
        purpose: module.purpose,
        description: module.description,
        schema_version: '1.0',
        fields: this.configuredOneHealthFields(module) as unknown as Record<string, unknown>
      } as Row]
    })
  }

  /**
   * The administrative chain an event was captured at, from its `admin<N>_code` fields.
   *
   * Levels are read from the active profile rather than assumed, so a country with one
   * sub-national level and a country with five both produce a correct chain. `admin_path`
   * comes from the deepest level the tree can resolve; an unresolvable code is still
   * carried in the chain, because the code the operator entered is the record and a gap in
   * the tree must not silently delete it.
   */
  private eventAdminChain(source: Record<string, unknown>): {
    country_code: string
    admin_path: string | null
    admin_codes: Array<{ level: number; code: string; code_system?: string }>
  } {
    const profile = activeProfile()
    const country = String(profile.country_code || '').toUpperCase()
    const unit = this.db.prepare(
      'SELECT admin_path, code_system FROM master_admin_units WHERE country_code = ? AND level = ? AND code = ?'
    )
    const chain: Array<{ level: number; code: string; code_system?: string }> = []
    let path: string | null = null

    for (const definition of [...profile.admin_levels].sort((left, right) => left.level - right.level)) {
      const code = String(source[ADMIN_FIELD_KEY(definition.level)] ?? '').trim()
      if (!code) continue
      const found = asDbRow(unit.get(country, definition.level, code))
      chain.push({ level: definition.level, code, code_system: String(found.code_system ?? definition.code_system) })
      if (found.admin_path) path = String(found.admin_path)
    }
    return { country_code: country, admin_path: path, admin_codes: chain }
  }

  captureOneHealth(module: string, payload: Row, identity: OneHealthIdentity): Row {
    this.ensureReady()
    const definition = ONE_HEALTH_MODULES[module]
    if (!definition) throw new Error(`Unknown One Health module: ${module}`)
    const actor = identityActor(identity)
    requireCapturePermission(identity, definition.purpose)
    if (!this.oneHealthModules().some((item) => item.key === module)) {
      throw new Error(`One Health domain ${definition.domain} is inactive or unavailable.`)
    }
    const source = { ...(payload as Record<string, unknown>) }
    const facility = normalKey(source.facility_id ?? this.currentLab()?.code)
    source.facility_id = facility
    const validationErrors = validateOneHealth(module, source, this.configuredOneHealthFields(definition))
    if (validationErrors.length) throw new Error(validationErrors.join('; '))
    const observed = String(source.observed_at)
    const id = randomUUID()
    const now = isoNow()
    const quality = String(source.quality_status ?? 'validated')
    if (!['draft', 'validated', 'rejected'].includes(quality)) throw new Error(`Unsupported quality status: ${quality}`)
    if (quality !== 'draft') requirePermission(identity, 'event:review')
    const sensitivity = String(source.sensitivity ?? 'restricted')
    if (!['restricted', 'internal', 'aggregate-only'].includes(sensitivity)) {
      throw new Error(`Unsupported sensitivity: ${sensitivity}`)
    }
    delete source.actor
    delete source.quality_status
    delete source.sensitivity
    delete source.alert_message
    delete source.alert_rule
    delete source.alert_severity
    this.transaction(() => {
      const place = this.eventAdminChain(source)
      this.db.prepare(`INSERT INTO national_events(
        id,schema_version,module_key,event_type,purpose,facility_id,country_code,admin_path,admin_codes_json,observed_at,recorded_at,
        actor,payload_json,quality_status,sensitivity
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, ONE_HEALTH_SCHEMA_VERSION, module, definition.eventType, definition.purpose, facility,
        place.country_code, place.admin_path, JSON.stringify(place.admin_codes), observed, now,
        actor, JSON.stringify(source), quality, sensitivity
      )
      this.recordNationalAudit(actor, 'event.create', module, id, { quality_status: quality, roles: identity.roles })
      for (const alert of evaluateOneHealthRules(module, source)) {
        const alertId = randomUUID()
        this.db.prepare(`INSERT INTO national_alerts(
          id,event_id,rule_code,severity,status,message,created_at
        ) VALUES (?,?,?,?,?,?,?)`).run(
          alertId, id, alert.rule_code, alert.severity, 'open', alert.message, now
        )
        this.recordNationalAudit('rules-engine', 'alert.create', 'alert', alertId, {
          event_id: id, module, ruleset_version: alert.ruleset_version
        })
      }
      this.recordAudit('one-health.capture', 'ok', `${module}: ${id}`, { facility, quality }, actor)
    })
    return this.listOneHealth(module).find((row) => row.id === id) as Row
  }

  listOneHealth(module?: string, limit = 1_000): Row[] {
    this.ensureReady()
    const conditions = ['deleted_at IS NULL']
    const params: SqlValue[] = []
    if (module) {
      if (!ONE_HEALTH_MODULES[module]) throw new Error(`Unknown One Health module: ${module}`)
      conditions.push('module_key=?')
      params.push(module)
    }
    params.push(safeLimit(limit, 1_000))
    return this.hydrateOneHealthEvents(this.db.prepare(`SELECT * FROM national_events WHERE ${conditions.join(' AND ')}
      ORDER BY observed_at DESC,recorded_at DESC LIMIT ?`).all(...params) as DbRow[])
  }

  /** Complete internal/reporting read. UI callers use listOneHealth's bounded recent view. */
  listOneHealthForExport(module?: string): Row[] {
    this.ensureReady()
    const conditions = ['deleted_at IS NULL']
    const params: SqlValue[] = []
    if (module) {
      if (!ONE_HEALTH_MODULES[module]) throw new Error(`Unknown One Health module: ${module}`)
      conditions.push('module_key=?')
      params.push(module)
    }
    return this.hydrateOneHealthEvents(this.db.prepare(`SELECT * FROM national_events WHERE ${conditions.join(' AND ')}
      ORDER BY observed_at DESC,recorded_at DESC`).all(...params) as DbRow[])
  }

  private hydrateOneHealthEvents(rows: DbRow[]): Row[] {
    return rows.map((row) => ({ ...row, payload: parseJson(row.payload_json, {}) } as unknown as Row))
  }

  oneHealthMetrics(module: string): Row {
    this.ensureReady()
    if (!ONE_HEALTH_MODULES[module]) throw new Error(`Unknown One Health module: ${module}`)
    const totals = asDbRow(this.db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN quality_status='validated' THEN 1 ELSE 0 END) AS validated,
      SUM(CASE WHEN quality_status='draft' THEN 1 ELSE 0 END) AS drafts,
      COUNT(DISTINCT facility_id) AS facilities,
      MAX(observed_at) AS latest FROM national_events WHERE module_key=? AND deleted_at IS NULL`).get(module))
    const alerts = Number(asDbRow(this.db.prepare(`SELECT COUNT(*) AS count FROM national_alerts a
      JOIN national_events e ON e.id=a.event_id WHERE e.module_key=? AND a.status='open'`).get(module)).count ?? 0)
    const payloads = this.listOneHealthForExport(module).map((event) => {
      const payload = event.payload
      return payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : {}
    })
    return {
      module,
      total: Number(totals.total ?? 0),
      validated: Number(totals.validated ?? 0),
      drafts: Number(totals.drafts ?? 0),
      facilities: Number(totals.facilities ?? 0),
      open_alerts: alerts,
      latest: String(totals.latest ?? ''),
      ...scalarMetrics(calculateOneHealthMetrics(module, payloads))
    }
  }

  oneHealthAggregate(module: string): Row {
    this.ensureReady()
    const metrics = this.oneHealthMetrics(module)
    const events = this.listOneHealthForExport(module)
    const facilityId = this.currentLab()?.code
    return {
      ...createOneHealthAggregate(module, facilityId, events),
      aggregate: metrics
    } as Row
  }

  enqueueOneHealth(module: string, identity: OneHealthIdentity): Row {
    this.ensureReady()
    requirePermission(identity, 'exchange:update')
    const actor = identityActor(identity)
    const payload = this.oneHealthAggregate(module)
    const metrics = this.oneHealthMetrics(module)
    const encoded = JSON.stringify(payload)
    const hash = createHash('sha256').update(encoded).digest('hex')
    const aggregateKey = `${module}:${String(metrics.latest || 'none')}`
    const existing = this.db.prepare('SELECT * FROM national_outbox WHERE aggregate_key=? AND payload_hash=?')
      .get(aggregateKey, hash)
    if (existing) return asDbRow(existing) as Row
    const id = randomUUID()
    this.transaction(() => {
      this.db.prepare(`INSERT INTO national_outbox(
        id,aggregate_key,payload_json,payload_hash,status,attempts,created_at
      ) VALUES (?,?,?,?,'pending',0,?)`).run(id, aggregateKey, encoded, hash, isoNow())
      this.recordNationalAudit(actor, 'outbox.enqueue', 'aggregate', id, { module, payload_hash: hash })
      this.recordAudit('one-health.enqueue', 'ok', `${module}: aggregate ${id}`, { payloadHash: hash }, actor)
    })
    return asDbRow(this.db.prepare('SELECT * FROM national_outbox WHERE id=?').get(id)) as Row
  }

  createOneHealthAction(input: Row, identity: OneHealthIdentity): Row {
    this.ensureReady()
    requirePermission(identity, 'action:manage')
    const actor = identityActor(identity)
    const title = String(input.title ?? '').trim()
    if (!title || title.length > 500) throw new Error('Action title must contain 1-500 characters.')
    const eventId = String(input.event_id ?? '').trim() || null
    if (eventId && !this.db.prepare('SELECT 1 FROM national_events WHERE id=? AND deleted_at IS NULL').get(eventId)) {
      throw new Error(`Unknown One Health event: ${eventId}`)
    }
    const priority = String(input.priority ?? 'medium')
    if (!['low', 'medium', 'high', 'critical'].includes(priority)) throw new Error(`Unsupported action priority: ${priority}`)
    const dueAt = String(input.due_at ?? '').trim() || null
    if (dueAt && Number.isNaN(Date.parse(dueAt))) throw new Error('Action due date must be an ISO date or date-time.')
    const owner = String(input.owner ?? '').trim().slice(0, 200) || actor
    const evidenceText = String(input.evidence ?? '').trim()
    if (evidenceText.length > 4_000) throw new Error('Action evidence cannot exceed 4,000 characters.')
    const id = randomUUID()
    const now = isoNow()
    const evidence = evidenceText ? [{ at: now, actor, evidence: evidenceText }] : []
    this.transaction(() => {
      this.db.prepare(`INSERT INTO national_actions(
        id,event_id,title,owner,due_at,priority,status,evidence_json,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,'open',?,?,?)`).run(
        id, eventId, title, owner, dueAt, priority, JSON.stringify(evidence), now, now
      )
      this.recordNationalAudit(actor, 'action.create', 'action', id, { event_id: eventId, owner, priority })
      this.recordAudit('one-health.action.create', 'ok', `${id}: ${title}`, { eventId, owner, priority }, actor)
    })
    return this.listOneHealthActions(undefined, identity).find((row) => row.id === id) as Row
  }

  updateOneHealthAction(
    idInput: string,
    input: { status: string; evidence?: string },
    identity: OneHealthIdentity
  ): Row {
    this.ensureReady()
    requirePermission(identity, 'action:manage')
    const actor = identityActor(identity)
    const id = String(idInput ?? '').trim()
    const status = String(input.status ?? '').trim().toLocaleLowerCase()
    if (!['open', 'in-progress', 'blocked', 'closed', 'cancelled'].includes(status)) {
      throw new Error(`Unsupported action status: ${status || '(empty)'}`)
    }
    const evidenceText = String(input.evidence ?? '').trim()
    if (evidenceText.length > 4_000) throw new Error('Action evidence cannot exceed 4,000 characters.')
    if (status === 'closed' && !evidenceText) throw new Error('Closure evidence is required before an action can be closed.')
    const existing = this.db.prepare('SELECT * FROM national_actions WHERE id=?').get(id)
    if (!existing) throw new Error(`Unknown One Health action: ${id}`)
    const evidence = parseJson<Array<Record<string, unknown>>>(asDbRow(existing).evidence_json, [])
    if (evidenceText) evidence.push({ at: isoNow(), actor, evidence: evidenceText })
    this.transaction(() => {
      this.db.prepare('UPDATE national_actions SET status=?,evidence_json=?,updated_at=? WHERE id=?')
        .run(status, JSON.stringify(evidence), isoNow(), id)
      this.recordNationalAudit(actor, 'action.update', 'action', id, { status, evidence_added: Boolean(evidenceText) })
      this.recordAudit('one-health.action.update', 'ok', `${id}: ${status}`, { evidenceAdded: Boolean(evidenceText) }, actor)
    })
    return this.listOneHealthActions(undefined, identity).find((row) => row.id === id) as Row
  }

  listOneHealthActions(module: string | undefined, identity: OneHealthIdentity): Row[] {
    this.ensureReady()
    requirePermission(identity, 'event:read')
    const params: SqlValue[] = []
    const moduleClause = module ? 'WHERE e.module_key=?' : ''
    if (module) {
      if (!ONE_HEALTH_MODULES[module]) throw new Error(`Unknown One Health module: ${module}`)
      params.push(module)
    }
    return (this.db.prepare(`SELECT a.*,e.module_key,e.facility_id FROM national_actions a
      LEFT JOIN national_events e ON e.id=a.event_id ${moduleClause}
      ORDER BY CASE a.status WHEN 'open' THEN 0 WHEN 'in-progress' THEN 1 WHEN 'blocked' THEN 2 ELSE 3 END,
      CASE a.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,a.updated_at DESC`)
      .all(...params) as DbRow[]).map((row) => ({
        ...row,
        evidence: parseJson<Array<Record<string, unknown>>>(row.evidence_json, [])
      } as unknown as Row))
  }

  reviewOneHealthAlert(
    idInput: string,
    input: { status: string; note?: string },
    identity: OneHealthIdentity
  ): Row {
    this.ensureReady()
    requirePermission(identity, 'event:review')
    const actor = identityActor(identity)
    const id = String(idInput ?? '').trim()
    const status = String(input.status ?? '').trim().toLocaleLowerCase()
    if (!['reviewed', 'dismissed', 'escalated'].includes(status)) {
      throw new Error(`Unsupported alert review status: ${status || '(empty)'}`)
    }
    const note = String(input.note ?? '').trim()
    if (note.length > 4_000) throw new Error('Alert review note cannot exceed 4,000 characters.')
    const alert = this.db.prepare('SELECT * FROM national_alerts WHERE id=?').get(id)
    if (!alert) throw new Error(`Unknown One Health alert: ${id}`)
    const now = isoNow()
    this.transaction(() => {
      this.db.prepare('UPDATE national_alerts SET status=?,reviewed_by=?,reviewed_at=? WHERE id=?')
        .run(status, actor, now, id)
      this.recordNationalAudit(actor, 'alert.review', 'alert', id, { status, note })
      this.recordAudit('one-health.alert.review', 'ok', `${id}: ${status}`, { note: note || undefined }, actor)
    })
    return asDbRow(this.db.prepare(`SELECT a.*,e.module_key,e.facility_id FROM national_alerts a
      JOIN national_events e ON e.id=a.event_id WHERE a.id=?`).get(id)) as Row
  }

  listOneHealthAudit(identity: OneHealthIdentity, limit = 500): Row[] {
    this.ensureReady()
    requirePermission(identity, 'audit:read')
    return (this.db.prepare('SELECT * FROM national_audit_log ORDER BY id DESC LIMIT ?')
      .all(safeLimit(limit, 500)) as DbRow[]).map((row) => ({
        ...row,
        details: parseJson<Record<string, unknown>>(row.details_json, {})
      } as unknown as Row))
  }

  verifyOneHealthAuditChain(identity: OneHealthIdentity): Row {
    this.ensureReady()
    requirePermission(identity, 'audit:read')
    let previousHash = ''
    let entries = 0
    for (const row of this.db.prepare('SELECT * FROM national_audit_log ORDER BY id').all() as DbRow[]) {
      entries += 1
      const storedPrevious = String(row.previous_hash ?? '')
      if (storedPrevious !== previousHash) {
        return { valid: false, entries, broken_at: Number(row.id), reason: 'previous hash mismatch' }
      }
      const details = parseJson<Record<string, unknown>>(row.details_json, {})
      const entry = {
        occurred_at: String(row.occurred_at), actor: String(row.actor), action: String(row.action),
        object_type: String(row.object_type), object_id: String(row.object_id), details
      }
      // Entries written before erasure support hashed the details directly; both forms
      // must keep verifying, or upgrading would appear to be tampering.
      const digest = String(row.details_digest ?? '') || auditDetailsDigest(details)
      const withDigest = auditHash(previousHash, {
        occurred_at: String(row.occurred_at), actor: String(row.actor), action: String(row.action),
        object_type: String(row.object_type), object_id: String(row.object_id), details_digest: digest
      })
      const canonical = auditHash(previousHash, entry)
      const legacy = legacyElectronAuditHash(previousHash, row, details)
      const stored = String(row.entry_hash ?? '')
      if (stored !== withDigest && stored !== canonical && stored !== legacy) {
        return { valid: false, entries, broken_at: Number(row.id), reason: 'entry hash mismatch' }
      }
      // The chain commits to the digest, so the entry hash alone would not notice the
      // details being rewritten underneath it. Binding the payload back to its digest is
      // what keeps "the details were altered" detectable now that they are not hashed
      // directly. An erased entry is exempt because destroying that payload is the point;
      // the erasure itself is a chained `audit.erase` entry, so it cannot happen silently.
      const storedDigest = String(row.details_digest ?? '')
      if (storedDigest && !String(row.erased_at ?? '') && auditDetailsDigest(details) !== storedDigest) {
        return { valid: false, entries, broken_at: Number(row.id), reason: 'details digest mismatch' }
      }
      previousHash = stored
    }
    return { valid: true, entries, broken_at: null, reason: null, head_hash: previousHash || null }
  }

  listOneHealthAlerts(module?: string, status = 'open'): Row[] {
    this.ensureReady()
    const conditions = ['1=1']
    const params: SqlValue[] = []
    if (module) { conditions.push('e.module_key=?'); params.push(module) }
    if (status) { conditions.push('a.status=?'); params.push(status) }
    return this.db.prepare(`SELECT a.*,e.module_key,e.facility_id FROM national_alerts a
      JOIN national_events e ON e.id=a.event_id WHERE ${conditions.join(' AND ')}
      ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,a.created_at DESC`)
      .all(...params) as Row[]
  }

  listOneHealthOutbox(limit = 500): Row[] {
    this.ensureReady()
    return this.db.prepare(`SELECT * FROM national_outbox ORDER BY
      CASE status WHEN 'pending' THEN 0 WHEN 'retry' THEN 1 ELSE 2 END,created_at DESC LIMIT ?`)
      .all(safeLimit(limit, 500)) as Row[]
  }

  markOneHealthOutboxSent(id: string): void {
    this.ensureReady()
    const result = this.db.prepare("UPDATE national_outbox SET status='sent',sent_at=?,last_error=NULL WHERE id=?")
      .run(isoNow(), id)
    if (Number(result.changes) !== 1) throw new Error(`Unknown outbox item: ${id}`)
  }

  markOneHealthOutboxFailure(id: string, error: string, retryAt?: string): void {
    this.ensureReady()
    const result = this.db.prepare(`UPDATE national_outbox SET status='retry',attempts=attempts+1,
      next_attempt_at=?,last_error=? WHERE id=?`).run(scalar(retryAt), String(error).slice(0, 1000), id)
    if (Number(result.changes) !== 1) throw new Error(`Unknown outbox item: ${id}`)
  }

  private recordNationalAudit(
    actor: string,
    action: string,
    objectType: string,
    objectId: string,
    details: Record<string, unknown>
  ): void {
    const previous = this.db.prepare('SELECT entry_hash FROM national_audit_log ORDER BY id DESC LIMIT 1').get()
    const previousHash = String(asDbRow(previous).entry_hash ?? '')
    const occurredAt = isoNow()
    const detailsJson = JSON.stringify(details)
    // The chain commits to a digest of the details rather than to the details themselves.
    // Erasure can then destroy the plaintext and leave the chain verifiable: what the entry
    // proves afterwards is that it existed, when, by whom, and that nothing was altered —
    // not what it said. Hashing the plaintext would make an erasure request and a
    // tamper-evident log mutually exclusive.
    const detailsDigest = auditDetailsDigest(details)
    const entryHash = auditHash(previousHash, {
      occurred_at: occurredAt,
      actor,
      action,
      object_type: objectType,
      object_id: objectId,
      details_digest: detailsDigest
    })
    this.db.prepare(`INSERT INTO national_audit_log(
      occurred_at,actor,action,object_type,object_id,details_json,previous_hash,entry_hash,details_digest
    ) VALUES (?,?,?,?,?,?,?,?,?)`).run(
      occurredAt, actor, action, objectType, objectId, detailsJson, previousHash, entryHash, detailsDigest
    )
  }

  /**
   * Erase the details of every audit entry naming a subject, keeping the chain verifiable.
   *
   * Crypto-shredding rather than deletion: the row, its position, its timestamp, its actor
   * and its digest all remain, so the log still proves the sequence was not altered. Only
   * the payload goes. Removing the rows outright would break every subsequent hash and
   * destroy the evidence that the log is intact.
   *
   * The erasure is itself an audited action, so a later reader can see that data was
   * removed, when, and why — a silent erasure would be indistinguishable from tampering.
   */
  eraseAuditDetails(
    identity: OneHealthIdentity,
    objectType: string,
    objectId: string,
    reason: string
  ): { erased: number; alreadyErased: number } {
    this.ensureReady()
    requirePermission(identity, 'users:manage')
    const justification = String(reason ?? '').trim()
    if (!justification) throw new Error('An erasure must record why it was performed.')

    // Erasure records are excluded from erasure. They name the same subject, so a repeat
    // request would shred the very record proving data was removed — and their payload is
    // counts and a justification, not the subject's data, so there is nothing to erase.
    const rows = this.db
      .prepare(`SELECT id, details_json, details_digest, erased_at FROM national_audit_log
        WHERE object_type = ? AND object_id = ? AND action <> 'audit.erase'`)
      .all(objectType, objectId) as DbRow[]
    if (!rows.length) return { erased: 0, alreadyErased: 0 }

    let erased = 0
    let alreadyErased = 0
    const erasedAt = isoNow()
    this.transaction(() => {
      for (const row of rows) {
        if (String(row.erased_at ?? '')) { alreadyErased += 1; continue }
        // Backfill the digest for an entry written before the chain committed to one, so
        // the row stays verifiable through its original hash after the payload is gone.
        const digest = String(row.details_digest ?? '')
          || auditDetailsDigest(parseJson<Record<string, unknown>>(String(row.details_json ?? '{}'), {}))
        this.db.prepare(`UPDATE national_audit_log
          SET details_json = ?, details_digest = ?, erased_at = ?, erasure_reason = ?
          WHERE id = ?`).run(
          JSON.stringify({ erased: true }), digest, erasedAt, justification, Number(row.id)
        )
        erased += 1
      }
    })

    this.recordNationalAudit(
      identity.username, 'audit.erase', objectType, objectId,
      { erased, already_erased: alreadyErased, reason: justification }
    )
    return { erased, alreadyErased }
  }

  /**
   * Remove row-level data older than the profile's retention period.
   *
   * Reports what it would remove when `dryRun` is set, so an administrator sees the effect
   * before an irreversible deletion. A purge is not recoverable from within the application
   * — take a backup first; `backupTo()` exists for exactly this.
   *
   * Returns `{ applied: false }` when the profile sets no retention period, which is the
   * default and means data is kept indefinitely.
   */
  purgeExpiredData(
    identity: OneHealthIdentity,
    options: { dryRun?: boolean; retentionDays?: number | null; now?: Date } = {}
  ): { applied: boolean; dryRun: boolean; retentionDays: number | null; cutoff: string | null; removed: Row[] } {
    this.ensureReady()
    requirePermission(identity, 'users:manage')
    const dryRun = options.dryRun !== false
    const retentionDays = options.retentionDays !== undefined
      ? options.retentionDays
      : activeProfile().privacy?.retention_days ?? null
    const cutoff = retentionCutoffDate(retentionDays, options.now ?? new Date())
    if (cutoff === null) {
      return { applied: false, dryRun, retentionDays: null, cutoff: null, removed: [] }
    }

    const removed: Row[] = []
    const purge = (): void => {
      for (const target of RETENTION_TARGETS) {
        const ids = (this.db.prepare(expiredRowsSql(target)).all(cutoff) as DbRow[]).map((row) => row.id as SqlValue)
        removed.push({ table: target.table, label: target.label, rows: ids.length } as unknown as Row)
        if (dryRun || !ids.length) continue
        // Chunked so a long-retained database does not build a statement with tens of
        // thousands of placeholders, which SQLite refuses.
        for (let index = 0; index < ids.length; index += 500) {
          const chunk = ids.slice(index, index + 500)
          const placeholders = chunk.map(() => '?').join(',')
          for (const dependent of target.dependents ?? []) {
            this.db.prepare(`DELETE FROM ${dependent.table} WHERE ${dependent.column} IN (${placeholders})`).run(...chunk)
          }
          this.db.prepare(`DELETE FROM ${target.table} WHERE ${target.key} IN (${placeholders})`).run(...chunk)
        }
      }
    }
    if (dryRun) purge()
    else this.transaction(purge)

    const total = removed.reduce((sum, entry) => sum + Number((entry as unknown as DbRow).rows ?? 0), 0)
    const summary = { retention_days: retentionDays, cutoff, dry_run: dryRun, total, tables: removed }
    // Audited whether or not anything was removed: "the purge ran and found nothing" is
    // itself the evidence a retention obligation is being met.
    this.recordNationalAudit(identity.username, 'retention.purge', 'retention', cutoff, summary)
    this.recordAudit(
      'retention.purge', dryRun ? 'ok' : 'warning',
      `${dryRun ? 'Would remove' : 'Removed'} ${total} row(s) recorded before ${cutoff}`,
      summary, identity.username
    )
    return { applied: !dryRun, dryRun, retentionDays, cutoff, removed }
  }

  async backupTo(destination: string): Promise<{ path: string; sha256: string }> {
    this.ensureReady()
    const target = resolve(destination)
    if (target === this.databasePath) throw new Error('Backup destination must differ from the live database.')
    mkdirSync(dirname(target), { recursive: true })
    this.db.exec('PRAGMA wal_checkpoint(PASSIVE)')
    await sqliteBackup(this.db, target)
    const hash = createHash('sha256').update(await readFile(target)).digest('hex')
    this.recordAudit('database.backup', 'ok', target, { sha256: hash })
    return { path: target, sha256: hash }
  }

  rawConnectionForTesting(): DatabaseSync {
    return this.db
  }
}

export default AMRITDatabase
