import type { MasterColumn, MasterOptionSource, Row } from '../../shared/types'
import type { MultiOption } from './ui'

/** Catalogue-backed choices for every `multiselect`/`panelAntibiotics` master column. */
export type MasterCatalogues = Record<MasterOptionSource, MultiOption[]>
export const EMPTY_CATALOGUES: MasterCatalogues = { antibiotics: [], organisms: [], samples: [], genomicMarkers: [] }

/** Columns that get their own full-width editor below the scalar field grid. */
export const isComposite = (column: MasterColumn): boolean =>
  ['multiselect', 'panelAntibiotics', 'panelMarkers', 'objectList', 'keyValue', 'address'].includes(column.type)

/** Composite columns whose contents are worth summarising as a table column. */
export const isMembership = (column: MasterColumn): boolean =>
  ['multiselect', 'panelAntibiotics', 'panelMarkers'].includes(column.type)

/** Composite columns that carry an essential/optional requirement type per member. */
export const isRequirementList = (column: MasterColumn): boolean =>
  column.type === 'panelAntibiotics' || column.type === 'panelMarkers'

const LABEL_KEYS: Record<MasterOptionSource, string[]> = {
  antibiotics: ['name', 'antibiotic_name'],
  organisms: ['organism_name', 'name'],
  samples: ['name', 'specimen_name'],
  genomicMarkers: ['name', 'marker_name']
}

const HINT_KEYS: Record<MasterOptionSource, string[]> = {
  antibiotics: ['class_name', 'who_aware'],
  organisms: ['genus_name', 'organism_type'],
  samples: ['parent_code'],
  genomicMarkers: ['mechanism_class', 'marker_type']
}

const pick = (row: Row, keys: string[]): string => {
  for (const key of keys) { const value = row[key]; if (typeof value === 'string' || typeof value === 'number') return String(value) }
  return ''
}

export const toOptions = (rows: Row[], source: MasterOptionSource): MultiOption[] => rows
  .map((row) => ({ value: String(row.code ?? ''), label: pick(row, LABEL_KEYS[source]) || String(row.code ?? ''), hint: pick(row, HINT_KEYS[source]) }))
  .filter((option) => option.value)

/**
 * A stored list column arrives as an array of objects, or a JSON string from a legacy row.
 * Membership columns are keyed by code; free-form lists (guidance, response codes) are not.
 */
export const memberRows = (value: unknown, { requireCode = true }: { requireCode?: boolean } = {}): Array<Record<string, unknown>> => {
  let raw = value
  if (typeof raw === 'string') { try { raw = JSON.parse(raw) as unknown } catch { return [] } }
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => typeof item === 'string' ? { code: item, name: item, value: item, label: item } : item && typeof item === 'object' ? item as Record<string, unknown> : {})
    .filter((item) => requireCode ? memberCode(item) : Object.keys(item).length > 0)
}

/** How many entries a composite column currently holds, for section badges and validation. */
export const entryCount = (column: MasterColumn, value: unknown): number => {
  if (column.type === 'keyValue') {
    const source = typeof value === 'string' ? (() => { try { return JSON.parse(value) as unknown } catch { return {} } })() : value
    return source && typeof source === 'object' && !Array.isArray(source) ? Object.keys(source).length : 0
  }
  return memberRows(value, { requireCode: isMembership(column) }).length
}

export const memberCode = (item: Record<string, unknown>): string =>
  String(item.code ?? item.antibiotic_code ?? item.organism_code ?? item.specimen_code ?? item.marker_code ?? '').trim()
