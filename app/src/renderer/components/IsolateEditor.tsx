/* Effects intentionally key off identity fields so local editor changes do not refetch panels or duplicate checks on every keystroke. */
/* eslint-disable react-hooks/exhaustive-deps */
import type React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Beaker, Dna, MessageSquareText, Plus, ShieldAlert, Trash2 } from 'lucide-react'
import { GENOMIC_RESULT_OPTIONS, IDENTIFICATION_METHOD_OPTIONS, isEssentialRequirement } from '../../shared/types'
import type { AstResult, GenomicResult, IsolateRecord, Row } from '../../shared/types'
import {
  isAddressFieldRequired,
  labelTokenFor,
  residenceFieldsForForm,
  validateResidence,
  type AddressField,
  type CountryAddressFormat,
  type PatientResidence
} from '../../shared/address'
import { OmicsPanel } from './OmicsPanel'
import { Button, Combobox, CustomSelect, DateInput, FieldGrid, InlineNotice, Input, Modal, MultiSelect, Section, Select, StatusPill, formatError, type MultiOption } from './ui'

const stringValue = (row: Row, keys: string[]): string => {
  for (const key of keys) { const value = row[key]; if (typeof value === 'string' || typeof value === 'number') return String(value) }
  return ''
}

const nestedRows = (row: Row | undefined, key: string): Row[] => {
  if (!row) return []
  let raw = (row as Record<string, unknown>)[key]
  if (typeof raw === 'string') { try { raw = JSON.parse(raw) as unknown } catch { return [] } }
  if (!Array.isArray(raw)) return []
  return raw.map((item) => typeof item === 'string' ? { antibiotic_code: item } : item && typeof item === 'object' ? item as Row : {}).filter((item) => Object.keys(item).length > 0)
}

const isTrue = (value: unknown): boolean => value === true || value === 1 || value === '1' || value === 'true'

const supportText = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return String(value ?? '')
  const row = value as Record<string, unknown>
  const message = row.message ?? row.comment ?? row.text ?? row.description
  const rule = row.rule_name ?? row.rule_key
  if (message) return rule ? `${String(rule)}: ${String(message)}` : String(message)
  // An unrecognised shape is read out as labelled values rather than as a JSON blob.
  return Object.entries(row)
    .filter(([, item]) => item != null && item !== '')
    .map(([key, item]) => `${key.replace(/[_-]+/g, ' ')}: ${typeof item === 'object' ? Object.values(item as Record<string, unknown>).join(', ') : String(item)}`)
    .join(' · ')
}

const responseOptions = (row: Row): Array<{ value: string; label: string }> => {
  let raw: unknown = (row as Record<string, unknown>).response_codes ?? (row as Record<string, unknown>).options
  if (typeof raw === 'string') { const source = raw; try { raw = JSON.parse(source) as unknown } catch { raw = source.split(',').map((item: string) => item.trim()).filter(Boolean) } }
  if (!Array.isArray(raw)) return []
  return raw.map((item) => typeof item === 'string' ? { value: item, label: item } : item && typeof item === 'object' ? { value: String((item as Record<string, unknown>).value ?? (item as Record<string, unknown>).code ?? ''), label: String((item as Record<string, unknown>).label ?? (item as Record<string, unknown>).name ?? (item as Record<string, unknown>).value ?? '') } : { value: '', label: '' }).filter((item) => item.value)
}

export interface EditorMasters { antibiotics: Row[]; organisms: Row[]; samples: Row[]; locations: Row[]; domains: Row[]; hospitals: Row[]; dataFields: Row[]; codeValues: Row[]; genomicMarkers: Row[] }

/** The code system a coded value belongs to, from the metadata the catalogue carries. */
const codeMetadata = (row: Row): Record<string, unknown> => {
  const raw = (row as Record<string, unknown>).metadata_json ?? (row as Record<string, unknown>).metadata
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw === 'string' && raw.trim()) { try { return JSON.parse(raw) as Record<string, unknown> } catch { return {} } }
  return {}
}
/**
 * The classifications a diagnosis may be coded in, in the order the picker offers them.
 *
 * Both revisions of ICD are bundled and neither is converted into the other: WHO publishes no
 * mapping between them through its API, so a record stays in the revision it was captured in
 * and `diagnosis_system` says which that was.
 */
const DIAGNOSIS_SYSTEMS: ReadonlyArray<{ url: string; label: string }> = Object.freeze([
  { url: 'http://hl7.org/fhir/sid/icd-10', label: 'ICD-10' },
  { url: 'http://id.who.int/icd/release/11/mms', label: 'ICD-11 MMS' }
])

const diagnosisSystem = (row: Row): string => String(codeMetadata(row).system ?? '')
const diagnosisSystemLabel = (row: Row): string => String(codeMetadata(row).system_label ?? codeMetadata(row).system ?? '')

/**
 * Which entry control a configured data field should get, from its key.
 *
 * The data-field master says what a field is called and how long it may be, not what shape
 * it holds — so a field keyed `outcome_date` used to render as a text box that happily
 * accepted "last tuesday". The key is the only signal available, and it is a reliable one
 * because the standard keys are offered from a list.
 */
const configuredFieldKind = (key: string): 'date' | 'number' | 'text' => {
  if (/(^|_)(date|dob)$/.test(key) || key.endsWith('_date')) return 'date'
  if (/(^|_)(age|count|score|days|hours|dose|weight)(_|$)/.test(key)) return 'number'
  return 'text'
}

/** Only defined context is sent; structured clone would otherwise carry `undefined` values
 * into the main-process filter grammar. */
const definedContext = (context: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(context).filter(([, value]) => value !== undefined && value !== ''))

export function IsolateEditor({ initial, labCode, countryCode, masters, onSave, onCancel, defaultMethod = '', defaultGuideline = '' }: { initial?: IsolateRecord | null; labCode: string; countryCode: string; masters: EditorMasters; onSave: (record: IsolateRecord) => Promise<void>; onCancel: () => void; defaultMethod?: string; defaultGuideline?: string }): React.JSX.Element {
  const { t } = useTranslation('records')
  const { t: ta } = useTranslation('address')
  const [record, setRecord] = useState<IsolateRecord>(() => ({ lab_code: labCode, record_status: 'draft', specimen_date: new Date().toISOString().slice(0, 10), antibiotic_results: {}, ...initial }))
  const [panels, setPanels] = useState<Row[]>([])
  const [selectedPanelKey, setSelectedPanelKey] = useState('')
  const [duplicate, setDuplicate] = useState<IsolateRecord | null>(null)
  const [matching, setMatching] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const firstResult = Object.values(initial?.antibiotic_results ?? {})[0]
  const [method, setMethod] = useState(() => String(initial?.ast_method ?? '') || String(firstResult?.method ?? '') || defaultMethod || 'Disk diffusion')
  const [guideline, setGuideline] = useState(() => String(firstResult?.guideline ?? '') || defaultGuideline || 'CLSI')
  const [picking, setPicking] = useState(false)
  const [draftCodes, setDraftCodes] = useState<string[]>([])
  const [pickingMarkers, setPickingMarkers] = useState(false)
  const [markerDraft, setMarkerDraft] = useState<string[]>([])
  const update = (key: string, value: unknown): void => setRecord((current) => ({ ...current, [key]: value }))
  /** Anything the isolate table has no column for. Persisted verbatim as `custom_fields`. */
  const updateCustom = (key: string, value: unknown): void => setRecord((current) => {
    const existing = (current.custom_fields && typeof current.custom_fields === 'object' ? current.custom_fields : {}) as Record<string, unknown>
    const next = { ...existing }
    if (String(value ?? '').trim()) next[key] = value
    else delete next[key]
    return { ...current, custom_fields: next, [key]: value }
  })
  const uncodedDiagnosis = String(record.diagnosis_note ?? '')

  /**
   * Dates that cannot be in the future, and two pairs that cannot disagree.
   *
   * A specimen dated next March, an admission after the specimen it produced, and an age
   * that contradicts the date of birth are all things this form used to accept in silence
   * and an analysis had to discover months later. They are caught where they are entered.
   */
  const today = new Date().toISOString().slice(0, 10)
  const derivedAge = useMemo(() => {
    const born = String(record.date_of_birth ?? '')
    const reference = String(record.specimen_date ?? '') || today
    if (!/^\d{4}-\d{2}-\d{2}$/.test(born) || !/^\d{4}-\d{2}-\d{2}$/.test(reference)) return null
    const years = (Date.parse(reference) - Date.parse(born)) / (365.2425 * 24 * 60 * 60 * 1000)
    return years < 0 || years > 130 ? null : Math.floor(years)
  }, [record.date_of_birth, record.specimen_date, today])
  const ageConflict = derivedAge !== null && record.age_years != null
    && Math.abs(Number(record.age_years) - derivedAge) > 1
  const admissionAfterSpecimen = Boolean(record.admission_date && record.specimen_date
    && String(record.admission_date) > String(record.specimen_date))

  /**
   * The residence form for this deployment's country: which of the four geographic fields
   * exist, what the country calls each — pin, ZIP, eircode — and the order it writes them.
   * Nothing about it is written here, so a deployment in any country gets its own form.
   */
  const [addressFormat, setAddressFormat] = useState<CountryAddressFormat | null>(null)
  useEffect(() => {
    if (!countryCode) return
    void window.amrit.addressFormat(countryCode).then(setAddressFormat).catch(() => undefined)
  }, [countryCode])
  const residence: PatientResidence = record.patient_residence ?? { country_code: countryCode }
  const updateResidence = (field: AddressField, value: string): void => {
    const next: PatientResidence = { ...residence, country_code: residence.country_code || countryCode }
    const key = field as 'dependent_locality' | 'locality' | 'admin_area' | 'postal_code'
    if (value.trim()) next[key] = value
    else delete next[key]
    update('patient_residence', next)
  }
  const residenceProblems = useMemo(
    () => (record.patient_residence && addressFormat ? validateResidence(record.patient_residence, addressFormat) : []),
    [record.patient_residence, addressFormat]
  )
  const organismOptions = masters.organisms.map((row) => ({ value: stringValue(row, ['organism_code', 'code', 'org_code']), label: stringValue(row, ['organism_name', 'name', 'organism']) })).filter((item) => item.value)
  const sampleOptions = masters.samples.map((row) => ({ value: stringValue(row, ['specimen_code', 'sample_code', 'code']), label: stringValue(row, ['specimen_name', 'sample_name', 'name']) })).filter((item) => item.value)
  const locationOptions = masters.locations.map((row) => ({ value: stringValue(row, ['location_type', 'code', 'location_code']), label: stringValue(row, ['display_name', 'name', 'location_type']) })).filter((item) => item.value)
  const domainOptions = masters.domains.map((row) => ({ value: stringValue(row, ['domain_code', 'code', 'key']), label: stringValue(row, ['domain_name', 'name', 'label', 'display_name']) })).filter((item) => item.value)
  const hospitalOptions = masters.hospitals.map((row) => ({ value: stringValue(row, ['hospital_code', 'facility_code', 'code']), label: stringValue(row, ['hospital_name', 'facility_name', 'name']) })).filter((item) => item.value)
  const codedOptions = (sets: string[], fallback: Array<{ value: string; label: string }>): Array<{ value: string; label: string }> => {
    const configured = masters.codeValues.filter((row) => sets.includes(stringValue(row, ['code_set', 'set', 'category']))).map((row) => ({ value: stringValue(row, ['code', 'value']), label: stringValue(row, ['display_label', 'description', 'label', 'code']) })).filter((item) => item.value)
    return configured.length ? configured : fallback
  }
  const methodOptions = codedOptions(['ast_method', 'test_method'], [{ value: 'Disk diffusion', label: 'Disk diffusion (zone, mm)' }, { value: 'MIC', label: 'MIC — broth microdilution (mg/L)' }, { value: 'Gradient strip', label: 'E-test / gradient strip (MIC, mg/L)' }, { value: 'Agar dilution', label: 'Agar dilution (MIC, mg/L)' }, { value: 'Automated', label: 'Automated system' }])
  const markerMethodOptions = codedOptions(['genomic_method', 'molecular_method'], [
    { value: 'PCR', label: 'PCR' }, { value: 'Multiplex PCR', label: 'Multiplex PCR' },
    { value: 'Xpert Carba-R', label: 'Xpert Carba-R' }, { value: 'Xpert MTB/RIF Ultra', label: 'Xpert MTB/RIF Ultra' },
    { value: 'Line probe assay', label: 'Line probe assay (LPA)' }, { value: 'LAMP', label: 'LAMP' },
    { value: 'Targeted NGS', label: 'Targeted NGS' }, { value: 'WGS', label: 'Whole-genome sequencing' },
    { value: 'Immunochromatographic', label: 'Lateral flow / immunochromatographic' }
  ])
  const measurementHint = (value: string): string => /mic|dilution|gradient|e-?test/i.test(value) ? 'MIC mg/L' : /disk|disc|diffus/i.test(value) ? 'Zone mm' : 'Zone / MIC'
  const guidelineOptions = codedOptions(['ast_guideline', 'guideline'], [{ value: 'CLSI', label: 'CLSI' }, { value: 'EUCAST', label: 'EUCAST' }, { value: 'National', label: 'National' }])
  const noAstOptions = codedOptions(['no_ast_reason'], [{ value: 'No routine AST indicated', label: 'No routine AST indicated' }, { value: 'Organism not viable', label: 'Organism not viable' }, { value: 'Insufficient specimen', label: 'Insufficient specimen' }, { value: 'Referred to another laboratory', label: 'Referred to another laboratory' }])
  /**
   * Sex, from the configured catalogue rather than four hard-coded letters.
   *
   * The seeded set carries the veterinary categories as well — entire, castrated,
   * lactating — which a One Health deployment recording animal isolates needs and which a
   * literal f/m/u list silently refuses.
   */
  const sexOptions = codedOptions(['sex_category'], [{ value: 'f', label: t('editor.female') }, { value: 'm', label: t('editor.male') }, { value: 'u', label: t('editor.unknownSex') }])
  /**
   * Diagnosis as codes, not prose.
   *
   * This was a free-text box beside a free-text "diagnosis code", which is unanalysable by
   * construction: "UTI", "uti" and "urinary tract infection" are three strings and one
   * syndrome, and nothing downstream can group them. It is now a catalogue selection, and
   * it is multiple because one isolate genuinely carries more than one diagnosis — a
   * urinary source and a sepsis — and keeping only the first throws away why the specimen
   * was taken. The code system travels with each code, so an ICD-10 deployment and a
   * SNOMED CT one export correctly from the same field.
   */
  const starterDiagnoses: MultiOption[] = useMemo(() => masters.codeValues
    .filter((row) => stringValue(row, ['code_set', 'set', 'category']) === 'diagnosis')
    .map((row) => ({
      value: stringValue(row, ['code', 'value']),
      label: stringValue(row, ['description', 'display_label', 'label']) || stringValue(row, ['code']),
      hint: diagnosisSystemLabel(row)
    }))
    .filter((option) => option.value), [masters.codeValues])

  /**
   * Codes found by searching the bundled classification, beyond the starter set.
   *
   * Phase 24. The starter set is what a deployment sees first because it is the syndromes AMR
   * surveillance reports on; it was never meant to be the only codes available. Typing searches
   * the whole bundled classification in the main process — where the terminology seed already
   * is — and what comes back is appended *after* the starter set, so the common answer stays at
   * the top and the long tail is reachable.
   *
   * Searching in the main process rather than shipping the classification into the page is the
   * point: the renderer would otherwise hold thousands of codes it filters once and discards.
   */
  const [searchedDiagnoses, setSearchedDiagnoses] = useState<MultiOption[]>([])
  const diagnosisSearch = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchDiagnoses = (query: string): void => {
    if (diagnosisSearch.current) clearTimeout(diagnosisSearch.current)
    const needle = query.trim()
    if (needle.length < 2) { setSearchedDiagnoses([]); return }
    // Debounced: one request per pause, not one per keystroke.
    diagnosisSearch.current = setTimeout(() => {
      // Optional-chained and caught: the starter set is always there, so a preload without
      // this bridge — an older build, or a test harness — degrades to the catalogue selection
      // rather than throwing inside a keystroke handler.
      const search = window.amrit?.terminology?.expand
      if (!search) return
      void Promise.all(DIAGNOSIS_SYSTEMS.map(async (system) => {
        const result = await search(system.url, needle, 40).catch(() => null)
        return result?.ok
          ? (result.value?.concepts ?? []).map((concept) => ({
            value: concept.code, label: concept.display, hint: system.label
          }))
          : []
      })).then((pages) => setSearchedDiagnoses(pages.flat()))
    }, 200)
  }

  const diagnosisOptions: MultiOption[] = useMemo(() => {
    const seen = new Set(starterDiagnoses.map((option) => option.value))
    return [...starterDiagnoses, ...searchedDiagnoses.filter((option) => {
      if (seen.has(option.value)) return false
      seen.add(option.value)
      return true
    })]
  }, [starterDiagnoses, searchedDiagnoses])
  const diagnosisCodes = useMemo(
    () => String(record.diagnosis_code ?? '').split(',').map((code) => code.trim()).filter(Boolean),
    [record.diagnosis_code]
  )
  const setDiagnosisCodes = (codes: string[]): void => {
    const chosen = codes.map((code) => ({ code, option: diagnosisOptions.find((item) => item.value === code) }))
    // The system comes from the catalogue row where there is one, and from the classification
    // the search found it in otherwise. A code with no system recorded is not given one: it
    // would be a guess about which revision a diagnosis was coded in.
    const systems = [...new Set([
      ...masters.codeValues
        .filter((row) => codes.includes(stringValue(row, ['code', 'value'])) && stringValue(row, ['code_set']) === 'diagnosis')
        .map((row) => diagnosisSystem(row)),
      ...chosen.map((item) => DIAGNOSIS_SYSTEMS.find((system) => system.label === item.option?.hint)?.url ?? '')
    ].filter(Boolean))]
    setRecord((current) => ({
      ...current,
      diagnosis_code: codes.join(', '),
      // The text is regenerated from the catalogue rather than kept in step by hand, so a
      // record can never carry a code that says one thing and a label that says another.
      diagnosis: chosen.map((item) => item.option?.label ?? item.code).join('; '),
      diagnosis_system: systems.join(', ')
    }))
  }
  const selectedPanel = useMemo(() => panels.find((row) => String(row.id ?? row.panel_name ?? row.name ?? '') === selectedPanelKey), [panels, selectedPanelKey])
  const selectedPanelAntibiotics = useMemo(() => nestedRows(selectedPanel, 'antibiotics'), [selectedPanel])
  const antibioticLookup = useMemo(() => new Map([...masters.antibiotics, ...selectedPanelAntibiotics].map((row) => [stringValue(row, ['antibiotic_code', 'drug_code', 'code', 'whonet_code']), stringValue(row, ['antibiotic_name', 'drug_name', 'name'])])), [masters.antibiotics, selectedPanelAntibiotics])
  const catalogueOptions: MultiOption[] = useMemo(() => masters.antibiotics
    .map((row) => ({ value: stringValue(row, ['antibiotic_code', 'code', 'whonet_code']), label: stringValue(row, ['antibiotic_name', 'name']) || stringValue(row, ['antibiotic_code', 'code']), hint: stringValue(row, ['class_name', 'who_aware']) }))
    .filter((option) => option.value), [masters.antibiotics])
  /** Essential members are pre-loaded; optional members stay available as add-ons. */
  const essentialMembers = useMemo(() => selectedPanelAntibiotics.filter((row) => isEssentialRequirement(row.requirement_type)), [selectedPanelAntibiotics])
  const optionalMembers = useMemo(() => selectedPanelAntibiotics.filter((row) => !isEssentialRequirement(row.requirement_type)), [selectedPanelAntibiotics])
  const panelCodes = useMemo(() => essentialMembers.map((row) => stringValue(row, ['antibiotic_code', 'drug_code', 'code'])).filter(Boolean), [essentialMembers])
  const optionalCodes = useMemo(() => optionalMembers.map((row) => stringValue(row, ['antibiotic_code', 'drug_code', 'code'])).filter(Boolean), [optionalMembers])
  const optionGroups = useMemo(() => new Map(selectedPanelAntibiotics.map((row) => [stringValue(row, ['antibiotic_code', 'drug_code', 'code']), stringValue(row, ['option_group'])])), [selectedPanelAntibiotics])
  /* Genotypic AMR markers prescribed by the panel follow the same essential/optional split. */
  const panelMarkers = useMemo(() => nestedRows(selectedPanel, 'genomic_markers'), [selectedPanel])
  const markerLookup = useMemo(() => new Map([...masters.genomicMarkers, ...panelMarkers].map((row) => [
    stringValue(row, ['marker_code', 'code']), stringValue(row, ['marker_name', 'name'])
  ])), [masters.genomicMarkers, panelMarkers])
  const markerMeta = useMemo(() => new Map(masters.genomicMarkers.map((row) => [stringValue(row, ['code']), row])), [masters.genomicMarkers])
  const essentialMarkerCodes = useMemo(() => panelMarkers.filter((row) => isEssentialRequirement(row.requirement_type))
    .map((row) => stringValue(row, ['marker_code', 'code'])).filter(Boolean), [panelMarkers])
  const optionalMarkerCodes = useMemo(() => panelMarkers.filter((row) => !isEssentialRequirement(row.requirement_type))
    .map((row) => stringValue(row, ['marker_code', 'code'])).filter(Boolean), [panelMarkers])
  const markerCodes = useMemo(() => [...new Set([...essentialMarkerCodes, ...Object.keys(record.genomic_results ?? {})])], [essentialMarkerCodes, record.genomic_results])
  const pendingMarkers = useMemo(() => optionalMarkerCodes.filter((code) => !markerCodes.includes(code)), [optionalMarkerCodes, markerCodes])
  const markerOptions: MultiOption[] = useMemo(() => masters.genomicMarkers
    .map((row) => ({ value: stringValue(row, ['code']), label: stringValue(row, ['name']) || stringValue(row, ['code']), hint: stringValue(row, ['mechanism_class', 'marker_type']) }))
    .filter((option) => option.value), [masters.genomicMarkers])
  const requirementOf = useMemo(() => new Map(selectedPanelAntibiotics.map((row) => [stringValue(row, ['antibiotic_code', 'drug_code', 'code']), stringValue(row, ['requirement_type']) || 'core'])), [selectedPanelAntibiotics])
  const astCodes = useMemo(() => [...new Set([...panelCodes, ...Object.keys(record.antibiotic_results ?? {})])], [panelCodes, record.antibiotic_results])
  const pendingOptional = useMemo(() => optionalCodes.filter((code) => !astCodes.includes(code)), [optionalCodes, astCodes])
  /**
   * What a panel prescribes, said in full.
   *
   * The genomic markers are counted here as well as the antibiotics. A panel that
   * prescribes a carbapenemase PCR alongside its disks used to describe itself purely in
   * antibiotics, so the marker arrived unannounced further down the form — or, when it was
   * optional, was never noticed at all.
   */
  const panelSummary = (panel: Row): string => {
    const members = nestedRows(panel, 'antibiotics')
    const essential = members.filter((row) => isEssentialRequirement(row.requirement_type)).length
    const markers = nestedRows(panel, 'genomic_markers')
    const parts = [`${essential} essential`]
    if (members.length - essential) parts.push(`${members.length - essential} optional`)
    if (markers.length) parts.push(`${markers.length} genomic marker${markers.length === 1 ? '' : 's'}`)
    return parts.join(' · ')
  }
  const configurableFields = useMemo(() => {
    const builtIn = new Set(['patient_id', 'specimen_number', 'specimen_date', 'specimen_type', 'specimen_code', 'organism', 'organism_code', 'sex', 'date_of_birth', 'age_years', 'location', 'location_type', 'admission_date', 'diagnosis', 'diagnosis_code', 'record_status', 'panel_name', 'antibiotic_results', 'domain', 'hospital_code', 'hospital_name'])
    const domain = String(record.domain ?? '').toLowerCase()
    return masters.dataFields.filter((row) => {
      const key = stringValue(row, ['field_key', 'key', 'code'])
      if (!key || builtIn.has(key) || ('is_enabled' in row && !isTrue(row.is_enabled)) || isTrue(row.is_hidden)) return false
      const applicable = stringValue(row, ['applicable_domains', 'domains']).toLowerCase().split(',').map((item) => item.trim()).filter(Boolean)
      return !domain || !applicable.length || applicable.includes(domain)
    }).sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0))
  }, [masters.dataFields, record.domain])
  useEffect(() => {
    if (!record.organism_code && !record.specimen_code && !record.location_type) { setPanels([]); setSelectedPanelKey(''); return }
    let alive = true; setMatching(true); setError('')
    window.amrit.panels.match(definedContext({ labCode, organismCode: record.organism_code, organism: record.organism, specimenCode: record.specimen_code, specimenType: record.specimen_type, locationType: record.location_type, domain: record.domain })).then((rows) => { if (!alive) return; setPanels(rows); const preferred = rows.find((row) => stringValue(row, ['panel_name', 'name']) === record.panel_name) ?? rows[0]; const key = preferred ? String(preferred.id ?? preferred.panel_name ?? preferred.name ?? '') : ''; setSelectedPanelKey(key); if (preferred) update('panel_name', stringValue(preferred, ['panel_name', 'name'])) }).catch((caught) => { if (alive) { setPanels([]); setError(formatError(caught)) } }).finally(() => { if (alive) setMatching(false) })
    return () => { alive = false }
  }, [labCode, record.organism_code, record.specimen_code, record.location_type, record.domain])
  useEffect(() => {
    if (!record.patient_id || !record.specimen_number) { setDuplicate(null); return }
    const timeout = window.setTimeout(() => { void window.amrit.records.duplicate(record).then((match) => { if (!initial?.id || match?.id !== initial.id) setDuplicate(match) }).catch(() => undefined) }, 350)
    return () => window.clearTimeout(timeout)
  }, [record.patient_id, record.specimen_number, record.specimen_date, record.specimen_code, record.specimen_type, record.organism_code, record.organism, initial?.id])
  const astUpdate = (code: string, value: AstResult): void => update('antibiotic_results', { ...(record.antibiotic_results ?? {}), [code]: value })
  const astRemove = (code: string): void => { const next = { ...(record.antibiotic_results ?? {}) }; delete next[code]; update('antibiotic_results', next) }
  const addCodes = (codes: string[]): void => {
    const next = { ...(record.antibiotic_results ?? {}) }
    for (const code of codes) if (!next[code]) next[code] = { result: '', method, guideline }
    update('antibiotic_results', next)
  }
  const applyMethod = (next: string): void => {
    setMethod(next); update('ast_method', next)
    update('antibiotic_results', Object.fromEntries(Object.entries(record.antibiotic_results ?? {}).map(([code, value]) => [code, { ...value, method: next }])))
  }
  /** Guideline has no record-level column; it is provenance carried on each stored result. */
  const applyGuideline = (next: string): void => {
    setGuideline(next)
    update('antibiotic_results', Object.fromEntries(Object.entries(record.antibiotic_results ?? {}).map(([code, value]) => [code, { ...value, guideline: next }])))
  }
  const markerUpdate = (code: string, value: GenomicResult): void => update('genomic_results', { ...(record.genomic_results ?? {}), [code]: value })
  const markerRemove = (code: string): void => { const next = { ...(record.genomic_results ?? {}) }; delete next[code]; update('genomic_results', next) }
  const addMarkers = (codes: string[]): void => {
    const next = { ...(record.genomic_results ?? {}) }
    for (const code of codes) if (!next[code]) next[code] = { result: '', method: String(markerMeta.get(code)?.default_method ?? '') }
    update('genomic_results', next)
  }
  const openMarkerPicker = (): void => { setMarkerDraft(markerCodes.filter((code) => !essentialMarkerCodes.includes(code))); setPickingMarkers(true) }
  const confirmMarkerPicker = (): void => {
    const current = record.genomic_results ?? {}
    const kept: Record<string, GenomicResult> = Object.fromEntries(Object.entries(current).filter(([code]) => essentialMarkerCodes.includes(code) || markerDraft.includes(code)))
    for (const code of markerDraft) if (!kept[code]) kept[code] = { result: '', method: String(markerMeta.get(code)?.default_method ?? '') }
    update('genomic_results', kept); setPickingMarkers(false)
  }
  /** The picker manages additions only; panel-essential members cannot be removed from the record. */
  const openPicker = (): void => { setDraftCodes(astCodes.filter((code) => !panelCodes.includes(code))); setPicking(true) }
  const confirmPicker = (): void => {
    const current = record.antibiotic_results ?? {}
    const kept: Record<string, AstResult> = Object.fromEntries(Object.entries(current).filter(([code]) => panelCodes.includes(code) || draftCodes.includes(code)))
    for (const code of draftCodes) if (!kept[code]) kept[code] = { result: '', method, guideline }
    update('antibiotic_results', kept); setPicking(false)
  }
  const submit = async (status: 'draft' | 'final'): Promise<void> => {
    setError('')
    if (!record.specimen_number?.trim()) { setError('Specimen number is required.'); return }
    const astEntered = Object.values(record.antibiotic_results ?? {}).some((item) => Boolean(item.result || item.measurement !== undefined && item.measurement !== ''))
      || Object.values(record.genomic_results ?? {}).some((item) => Boolean(item.result))
    if (status === 'final' && (!record.patient_id?.trim() || !record.specimen_date || !(record.specimen_code || record.specimen_type) || !(record.organism_code || record.organism))) { setError('Final records require patient identifier, specimen date/type and organism. Save as draft if these are not yet available.'); return }
    if (status === 'final' && !astEntered && !String(record.no_ast_reason ?? '').trim()) { setError('Enter at least one AST result, report a genotypic marker, or select a documented no-AST reason before finalising.'); return }
    setSaving(true)
    try { await onSave({ ...record, record_status: status }) } catch (caught) { setError(formatError(caught)) } finally { setSaving(false) }
  }
  return <div className="record-editor">
    {duplicate && <InlineNotice tone="warning" title={t('editor.duplicateTitle')}>{t('editor.duplicateBody', { id: duplicate.id })}</InlineNotice>}
    {error && <InlineNotice tone="danger" title="Record not saved">{error}</InlineNotice>}
    <Section title="Specimen identity" description="Minimum coded identity used for duplicate detection and downstream exports.">
      <FieldGrid columns={3}><Input label="Patient identifier" required value={record.patient_id ?? ''} onChange={(event) => update('patient_id', event.target.value)} hint="Local identifier; avoid direct names." /><Input label="Specimen number" required value={record.specimen_number ?? ''} onChange={(event) => update('specimen_number', event.target.value)} /><DateInput label="Specimen date" name="specimen_date" required max={today} value={record.specimen_date ?? ''} onChange={(value) => update('specimen_date', value)} /></FieldGrid>
      <FieldGrid columns={3}><CustomSelect label="Specimen type" name="specimen_code" value={record.specimen_code ?? ''} onChange={(value) => { const selected = sampleOptions.find((item) => item.value === value); update('specimen_code', value); update('specimen_type', selected?.label ?? value) }} options={sampleOptions} /><CustomSelect label="Organism" name="organism_code" value={record.organism_code ?? ''} onChange={(value) => { const selected = organismOptions.find((item) => item.value === value); update('organism_code', value); update('organism', selected?.label ?? value) }} options={organismOptions} /><CustomSelect label="Location type" name="location_type" value={record.location_type ?? ''} onChange={(value) => update('location_type', value)} options={locationOptions} /></FieldGrid>
      <FieldGrid columns={3}><CustomSelect label="One Health domain" name="record-domain" value={String(record.domain ?? '')} onChange={(value) => update('domain', value)} options={domainOptions.length ? domainOptions : [{ value: 'human', label: 'Human' }, { value: 'animal', label: 'Animal' }, { value: 'environment', label: 'Environment' }]} /><CustomSelect label="Hospital / facility" name="hospital-code" value={String(record.hospital_code ?? '')} onChange={(value) => { const selected = hospitalOptions.find((item) => item.value === value); update('hospital_code', value); update('hospital_name', selected?.label ?? value) }} options={hospitalOptions} /><Input label="Location / ward" value={record.location ?? ''} onChange={(event) => update('location', event.target.value)} /></FieldGrid>
      <FieldGrid columns={3}><CustomSelect label="Sex" name="record-sex" value={(record.sex ?? '').toLowerCase()} onChange={(value) => update('sex', value)} options={sexOptions} placeholder={t('editor.notRecorded')} /><DateInput label="Date of birth" name="date_of_birth" max={today} value={record.date_of_birth ?? ''} onChange={(value) => update('date_of_birth', value)} hint={derivedAge === null ? undefined : t('editor.ageFromBirthDate', { count: derivedAge })} /><Input label="Age in years" type="number" min={0} max={130} value={record.age_years ?? ''} onChange={(event) => update('age_years', event.target.value ? Number(event.target.value) : null)} /></FieldGrid>
      {ageConflict && <InlineNotice tone="warning" title={t('editor.ageConflictTitle')}>{t('editor.ageConflictBody', { entered: Number(record.age_years), derived: derivedAge })}</InlineNotice>}
      <FieldGrid columns={2}><DateInput label="Admission date" name="admission_date" max={today} value={record.admission_date ?? ''} onChange={(value) => update('admission_date', value)} error={admissionAfterSpecimen ? t('editor.admissionAfterSpecimen') : undefined} /><Input label="Diagnosis (uncoded detail)" value={uncodedDiagnosis} hint={t('editor.uncodedDiagnosisHint')} onChange={(event) => updateCustom('diagnosis_note', event.target.value)} /></FieldGrid>
      <MultiSelect label="Diagnosis" name="diagnosis-codes" values={diagnosisCodes} options={diagnosisOptions} onChange={setDiagnosisCodes} onQueryChange={searchDiagnoses}
        hint={diagnosisOptions.length ? t('editor.diagnosisHint') : t('editor.diagnosisEmptyHint')}
        emptyLabel={t('editor.diagnosisEmpty')} placeholder={t('editor.diagnosisPlaceholder')} />
    </Section>
    {addressFormat && <Section title="Patient residence" description="Where the patient lives, to the town and postal code. The fields, their local names and their order come from this country's address rules; a street address is deliberately not recorded, and the postal code is coarsened before it leaves this computer.">
      <FieldGrid columns={3}>{residenceFieldsForForm(addressFormat).map((field) => {
        const key = field as 'dependent_locality' | 'locality' | 'admin_area' | 'postal_code'
        const problem = residenceProblems.find((item) => item.field === field)
        // The pack's own token — `pin`, `eircode`, `emirate` — is the translation key, not
        // display text. Rendering it directly is how "pin" reached the screen as a label.
        const token = labelTokenFor(field, addressFormat)
        const examples = addressFormat.postal_code_examples.slice(0, 2)
        return <Input
          key={field}
          label={ta(`labels.${token}`, { defaultValue: token.replace(/_/g, ' ') })}
          name={`residence-${field}`}
          value={String(residence[key] ?? '')}
          onChange={(event) => updateResidence(field, event.target.value)}
          error={problem?.message}
          hint={field === 'postal_code' && examples.length
            ? ta('postalCodeExample', { example: examples.join(', ') })
            : isAddressFieldRequired(field, addressFormat) ? 'Usually written in this country.' : undefined}
        />
      })}</FieldGrid>
    </Section>}
    {configurableFields.length > 0 && <Section title="Configured laboratory fields" description="Enabled, visible and domain-applicable fields from the laboratory data-field master. A field with response codes is a coded dropdown; one whose key names a date opens a calendar."><FieldGrid columns={2}>{configurableFields.map((field) => {
      const key = stringValue(field, ['field_key', 'key', 'code'])
      const label = stringValue(field, ['field_label', 'label', 'name']) || key
      const raw = record[key]
      const value = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : ''
      // Response codes declared on the field win; failing that a code set of the same name
      // is used, which is what makes the 2,710 seeded coded values reachable at entry
      // instead of sitting in the catalogue unused behind a free-text box.
      const options = responseOptions(field)
      const coded = options.length ? options : codedOptions([key], [])
      if (coded.length) return <CustomSelect key={key} label={label} name={`configured-${key}`} value={value} onChange={(next) => updateCustom(key, next)} options={coded} />
      const kind = configuredFieldKind(key)
      if (kind === 'date') return <DateInput key={key} label={label} name={`configured-${key}`} value={value} onChange={(next) => updateCustom(key, next)} />
      return <Input key={key} label={label} type={kind === 'number' ? 'number' : 'text'} maxLength={Number(field.field_length ?? 255)} value={value} onChange={(event) => updateCustom(key, event.target.value)} />
    })}</FieldGrid></Section>}
    <Section title="Antimicrobial susceptibility testing" description={matching ? 'Matching configured panels…' : panels.length ? `${panels.length} panel match${panels.length === 1 ? '' : 'es'} for this organism and specimen; the selected panel pre-loads ${panelCodes.length} essential antibiotic${panelCodes.length === 1 ? '' : 's'}${optionalCodes.length ? ` and offers ${optionalCodes.length} optional` : ''}.` : 'No panel matched this organism and specimen. Add antibiotics from the configurable master catalogue.'} actions={<Button variant="secondary" onClick={openPicker}><Plus size={16} /> {t('editor.addAntibiotics')}</Button>}>
      <FieldGrid columns={2}>
        <CustomSelect label="Test method" name="ast-default-method" value={method} onChange={applyMethod} options={methodOptions} hint="Applied to every row in this record and to antibiotics added below." />
        <CustomSelect label="Interpretive guideline" name="ast-default-guideline" value={guideline} onChange={applyGuideline} options={guidelineOptions} hint="Stored with each result as interpretation provenance." />
      </FieldGrid>
      {panels.length > 0 && <div className="panel-picker"><Combobox label="Matched AST panel" name="matched-panel" value={selectedPanelKey} placeholder={t('editor.noMatchedPanel')} onChange={(key) => { setSelectedPanelKey(key); const next = panels.find((row) => String(row.id ?? row.panel_name ?? row.name ?? '') === key); update('panel_name', next ? stringValue(next, ['panel_name', 'name']) : '') }} options={panels.map((item, index) => ({ value: String(item.id ?? item.panel_name ?? item.name ?? ''), label: stringValue(item, ['panel_name', 'name']) || `Panel ${index + 1}`, hint: panelSummary(item) }))} />{selectedPanel && <p>
        {/* What the panel prescribes, in front of the operator rather than inside the
            dropdown they have just closed — a panel's genomic markers are otherwise met for
            the first time three sections further down. */}
        <strong>{panelSummary(selectedPanel)}</strong>
        {' · '}{stringValue(selectedPanel, ['description', 'guidance']) || 'Panel antibiotics remain editable for this record.'}
      </p>}</div>}
      {pendingOptional.length > 0 && <div className="optional-members"><span className="field__label">{t('editor.optionalAntibiotics')}</span><div className="optional-members__chips">{pendingOptional.map((code) => <button type="button" className="chip chip--add" key={code} onClick={() => addCodes([code])}><Plus size={13} /><span>{antibioticLookup.get(code) || code}</span><small>{requirementOf.get(code) || 'optional'}</small></button>)}<Button variant="ghost" onClick={() => addCodes(pendingOptional)}>{t('editor.addAllOptional')}</Button></div></div>}
      {astCodes.length ? <div className="ast-grid"><div className="ast-grid__head"><span>{t('editor.antibiotic')}</span><span>{t('editor.measurement')}</span><span>{t('editor.interpretation')}</span><span>{t('editor.method')}</span><span>{t('editor.guideline')}</span><span /></div>{astCodes.map((code) => {
        const result = record.antibiotic_results?.[code] ?? { result: '', method, guideline }
        const requirement = requirementOf.get(code)
        const provenance = panelCodes.includes(code) ? `panel · ${requirement === 'one_of' ? 'essential, one of a group' : 'essential'}` : optionalCodes.includes(code) ? `panel · optional (${requirement})` : antibioticLookup.has(code) ? 'added for this record' : 'historical retained'
        const group = optionGroups.get(code)
        return <div className="ast-grid__row" key={code}><div><strong>{antibioticLookup.get(code) || code}</strong><small>{code} · {provenance}{group ? ` · group ${group.split(':').pop()}` : ''}</small></div><Input aria-label={`${code} measurement`} value={String(result.measurement ?? '')} placeholder={measurementHint(result.method ?? method)} onChange={(event) => astUpdate(code, { ...result, measurement: event.target.value })} /><Select aria-label={`${code} interpretation`} value={result.result ?? ''} onChange={(event) => astUpdate(code, { ...result, result: event.target.value as AstResult['result'] })}><option value="">{t('editor.pending')}</option><option value="S">{t('editor.susceptible')}</option><option value="I">{t('editor.intermediate')}</option><option value="R">{t('editor.resistant')}</option></Select><CustomSelect label="" name={`${code}-method`} value={result.method ?? method} onChange={(value) => astUpdate(code, { ...result, method: value })} options={methodOptions} /><CustomSelect label="" name={`${code}-guideline`} value={result.guideline ?? guideline} onChange={(value) => astUpdate(code, { ...result, guideline: value })} options={guidelineOptions} /><Button variant="ghost" className="danger-text" disabled={panelCodes.includes(code)} title={panelCodes.includes(code) ? 'Essential panel members cannot be removed' : undefined} onClick={() => astRemove(code)}><Trash2 size={16} /><span className="sr-only">{t('editor.clear', { code })}</span></Button></div>
      })}</div> : <div className="ast-empty"><Beaker size={25} /><strong>{t('editor.noAntibioticsTitle')}</strong><span>{t('editor.noAntibioticsBody')}</span></div>}
      <CustomSelect label="Documented no-AST reason" name="no-ast-reason" value={String(record.no_ast_reason ?? '')} onChange={(value) => update('no_ast_reason', value)} options={noAstOptions} placeholder="Not applicable — AST entered" />
      <InlineNotice tone="info" title={t('editor.interpretationSafetyTitle')}>{t('editor.interpretationSafetyBody')}</InlineNotice>
    </Section>
    <Section title="Genotypic AMR markers" description={panelMarkers.length
      ? `This panel prescribes ${essentialMarkerCodes.length} essential genomic test${essentialMarkerCodes.length === 1 ? '' : 's'}${optionalMarkerCodes.length ? ` and offers ${optionalMarkerCodes.length} optional` : ''}.`
      : 'Molecular and sequencing-based resistance determinants. Add markers from the configurable genomic catalogue, or prescribe them on the panel in Master Studio.'}
    actions={<Button variant="secondary" onClick={openMarkerPicker}><Dna size={16} /> {t('editor.addMarkers')}</Button>}>
      {pendingMarkers.length > 0 && <div className="optional-members"><span className="field__label">{t('editor.optionalMarkers')}</span><div className="optional-members__chips">{pendingMarkers.map((code) => <button type="button" className="chip chip--add" key={code} onClick={() => addMarkers([code])}><Plus size={13} /><span>{markerLookup.get(code) || code}</span></button>)}<Button variant="ghost" onClick={() => addMarkers(pendingMarkers)}>{t('editor.addAllOptional')}</Button></div></div>}
      {markerCodes.length ? <div className="marker-grid"><div className="marker-grid__head"><span>{t('editor.marker')}</span><span>{t('editor.result')}</span><span>{t('editor.targetAllele')}</span><span>{t('editor.method')}</span><span /></div>{markerCodes.map((code) => {
        const value = record.genomic_results?.[code] ?? { result: '', method: String(markerMeta.get(code)?.default_method ?? '') }
        const meta = markerMeta.get(code)
        const essential = essentialMarkerCodes.includes(code)
        return <div className="marker-grid__row" key={code}>
          <div><strong>{markerLookup.get(code) || code}</strong><small>{code} · {essential ? 'panel · essential' : optionalMarkerCodes.includes(code) ? 'panel · optional' : 'added for this record'}{meta?.mechanism_class ? ` · ${String(meta.mechanism_class)}` : ''}</small></div>
          <Select aria-label={`${code} result`} value={String(value.result ?? '')} onChange={(event) => markerUpdate(code, { ...value, result: event.target.value as GenomicResult['result'] })}>
            <option value="">{t('editor.pending')}</option>
            {GENOMIC_RESULT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </Select>
          <Input aria-label={`${code} target`} value={String(value.target ?? '')} placeholder={meta?.marker_type === 'mutation' ? 'e.g. rpoB S450L' : 'e.g. blaOXA-181'} onChange={(event) => markerUpdate(code, { ...value, target: event.target.value })} />
          <CustomSelect label="" name={`${code}-marker-method`} value={String(value.method ?? '')} onChange={(next) => markerUpdate(code, { ...value, method: next })} options={markerMethodOptions} />
          <Button variant="ghost" className="danger-text" disabled={essential} title={essential ? 'Essential panel markers cannot be removed' : undefined} onClick={() => markerRemove(code)}><Trash2 size={16} /><span className="sr-only">{t('editor.clear', { code })}</span></Button>
        </div>
      })}</div> : <div className="ast-empty"><Dna size={25} /><strong>{t('editor.noMarkersTitle')}</strong><span>{t('editor.noMarkersBody')}</span></div>}
      {markerCodes.some((code) => record.genomic_results?.[code]?.result === 'detected') && <InlineNotice tone="warning" title={t('editor.genotypeTitle')}>
        {t('editor.genotypeBody')}
      </InlineNotice>}
    </Section>
    <Section title="Organism identification and omics" description="How this isolate was identified, and the sequencing or spectrometry artefacts held for it.">
      <FieldGrid columns={3}>
        <CustomSelect label="Identification method" name="identification-method" value={String(record.identification_method ?? '')} onChange={(value) => update('identification_method', value)} options={IDENTIFICATION_METHOD_OPTIONS} />
        <Input label="Identification score / confidence" value={String(record.identification_score ?? '')} placeholder="MALDI-TOF 2.31, 99.4% 16S identity" onChange={(event) => update('identification_score', event.target.value)} />
        <Input label="Panel in use" value={record.panel_name ?? ''} disabled />
      </FieldGrid>
      <OmicsPanel isolateId={initial?.id} onNotify={(title, message, tone) => setError(tone === 'error' ? `${title}: ${message}` : '')} />
    </Section>
    <Modal open={pickingMarkers} title="Add genotypic markers to this record" description="Search the configurable genomic AMR catalogue. Markers the panel marks essential stay in the record and are not listed here." width="large" onClose={() => setPickingMarkers(false)} actions={<><Button variant="secondary" onClick={() => setPickingMarkers(false)}>{t('editor.cancel')}</Button><Button onClick={confirmMarkerPicker}>{t('editor.applySelection')}</Button></>}>
      <div className="picker-summary"><StatusPill label={`${essentialMarkerCodes.length} essential from panel`} tone="green" /><StatusPill label={`${markerDraft.length} additional selected`} tone="blue" /></div>
      <MultiSelect label="Additional markers" name="marker-picker" values={markerDraft} options={markerOptions.filter((option) => !essentialMarkerCodes.includes(option.value))} onChange={setMarkerDraft} emptyLabel="No additional marker selected." />
    </Modal>
    <Modal open={picking} title="Add antibiotics to this record" description="Search the configurable antimicrobial catalogue. Essential panel members stay in the record and are not listed here." width="large" onClose={() => setPicking(false)} actions={<><Button variant="secondary" onClick={() => setPicking(false)}>{t('editor.cancel')}</Button><Button onClick={confirmPicker}>{t('editor.applySelection')}</Button></>}>
      <div className="picker-summary"><StatusPill label={`${panelCodes.length} essential from panel`} tone="green" /><StatusPill label={`${draftCodes.length} additional selected`} tone="blue" /></div>
      <MultiSelect label="Additional antibiotics" name="ast-picker" values={draftCodes} options={catalogueOptions.filter((option) => !panelCodes.includes(option.value))} onChange={setDraftCodes} emptyLabel="No additional antibiotic selected." />
    </Modal>
    {(Array.isArray(record.alerts) && record.alerts.length > 0) && <Section title="Expert alerts" description="Deterministic local rules requiring review; they do not replace laboratory authorisation."><div className="alert-list">{record.alerts.map((alert, index) => <div key={index}><ShieldAlert size={18} /><span>{supportText(alert)}</span></div>)}</div></Section>}
    {(Array.isArray(record.expert_comments) && record.expert_comments.length > 0) && <Section title="Interpretive comments" description="Comments generated from the configured breakpoint and expert-rule context stored with this record."><div className="alert-list">{record.expert_comments.map((comment, index) => <div key={index}><MessageSquareText size={18} /><span>{supportText(comment)}</span></div>)}</div></Section>}
    <div className="record-editor__actions"><Button variant="ghost" onClick={onCancel}>{t('editor.cancel')}</Button><Button variant="secondary" disabled={saving} onClick={() => void submit('draft')}>{t('editor.saveDraft')}</Button><Button disabled={saving || Boolean(duplicate)} onClick={() => void submit('final')}>{saving ? 'Saving…' : 'Validate & finalise'}</Button>{duplicate && <span className="action-warning"><AlertTriangle size={16} /> {t('editor.resolveDuplicate')}</span>}</div>
  </div>
}
