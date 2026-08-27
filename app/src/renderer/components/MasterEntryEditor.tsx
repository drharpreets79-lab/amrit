import type React from 'react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { CountryProfile, MasterColumn, MasterDefinition, PanelAntibioticMember, PostalAddress, Row } from '../../shared/types'
import type { CountryAddressFormat } from '../../shared/address'
import { AddressFields } from './AddressFields'
import { entryCount, isComposite, memberCode, memberRows, type MasterCatalogues } from './masterOptions'
import { PanelAntibioticsEditor } from './PanelAntibioticsEditor'
import { KeyValueEditor, ObjectListEditor } from './StructuredFields'
import { CountrySelect } from './CountrySelect'
import { Button, CustomSelect, DateInput, FieldGrid, Input, MultiSelect, Switch, Textarea, cx, type MultiOption } from './ui'

const DETAILS = '__details__'

/**
 * A facility's address in a master catalogue, asked for the way its country asks for one.
 *
 * This used to be a textarea of raw JSON labelled "Address". A hospital registry is a
 * configuration screen, but the thing being configured is still a building in a country, and
 * hand-editing `{"locality": …}` is neither an international design nor a usable one.
 */
function MasterAddressField({ column, value, onChange, countryProfile }: {
  column: MasterColumn
  value: unknown
  onChange: (value: unknown) => void
  countryProfile: CountryProfile
}): React.JSX.Element {
  const [format, setFormat] = useState<CountryAddressFormat | null>(null)
  useEffect(() => {
    void window.amrit.addressFormat(countryProfile.country_code).then(setFormat).catch(() => undefined)
  }, [countryProfile.country_code])

  // Stored as JSON on the row, and historically as a free-text blob. An old blob is not
  // parseable into components by any rule that holds worldwide, so it becomes the first
  // street line — the only field it can honestly become — rather than being guessed at.
  const address = useMemo((): PostalAddress => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return { ...(value as PostalAddress), country_code: countryProfile.country_code }
    }
    const text = typeof value === 'string' ? value.trim() : ''
    if (!text) return { country_code: countryProfile.country_code }
    try {
      const parsed = JSON.parse(text) as PostalAddress
      return { ...parsed, country_code: countryProfile.country_code }
    } catch {
      return { country_code: countryProfile.country_code, address_lines: [text] }
    }
  }, [value, countryProfile.country_code])

  if (!format) return <Textarea label={column.label} name={column.key} rows={3} value="" disabled onChange={() => undefined} />
  return <AddressFields
    address={address}
    format={format}
    countryCode={countryProfile.country_code}
    tileUrl={countryProfile.map?.tile_url}
    onChange={onChange}
  />
}

/** Every `whonet_code_values` set a column asks for, fetched once and shared by the form. */
function useCodeSets(codeSets: string[]): Record<string, MultiOption[]> {
  const [sets, setSets] = useState<Record<string, MultiOption[]>>({})
  const wanted = codeSets.join(',')
  useEffect(() => {
    const keys = wanted.split(',').filter((key) => key && key !== COUNTRY_CODE_SET)
    if (!keys.length) return undefined
    let alive = true
    void window.amrit.masters.list('codeValues', { includeInactive: false, limit: 20000 }).then((rows) => {
      if (!alive) return
      const grouped: Record<string, MultiOption[]> = {}
      for (const key of keys) {
        grouped[key] = rows
          .filter((row) => String(row.code_set ?? '') === key)
          .map((row) => ({
            value: String(row.code ?? ''),
            label: String(row.display_label ?? row.description ?? row.code ?? ''),
            hint: String(row.code ?? '')
          }))
          .filter((option) => option.value)
      }
      setSets(grouped)
    }).catch(() => undefined)
    return () => { alive = false }
  }, [wanted])
  return sets
}

/** Sentinel for the one "code set" that is not in the database but in the ISO reference. */
const COUNTRY_CODE_SET = '__country__'

function MasterField({ column, value, onChange, onApply, catalogues, codeSets, countryProfile }: { column: MasterColumn; value: unknown; onChange: (value: unknown) => void; onApply: (patch: Record<string, unknown>) => void; catalogues: MasterCatalogues; codeSets: Record<string, MultiOption[]>; countryProfile: CountryProfile }): React.JSX.Element {
  const common = { label: column.label, required: column.required, name: column.key, disabled: column.readonly }
  const asText = typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  if (column.type === 'address') {
    return <MasterAddressField column={column} value={value} onChange={onChange} countryProfile={countryProfile} />
  }
  /**
   * A country column is answered by name and stored as the ISO alpha-3, in a master
   * catalogue exactly as it is on the laboratory screen. One control, one stored shape.
   */
  if (column.codeSet === COUNTRY_CODE_SET) {
    return <CountrySelect label={column.label} name={column.key} value={asText} required={column.required}
      hint={column.hint} disabled={column.readonly} onChange={(selection) => onChange(selection.alpha3)} />
  }
  if (column.codeSet) {
    return <CustomSelect {...common} hint={column.hint} value={asText} onChange={onChange}
      options={codeSets[column.codeSet] ?? []} />
  }
  if (column.type === 'date') {
    return <DateInput {...common} hint={column.hint} value={asText} onChange={onChange} />
  }
  /**
   * A suggested column is free text with a list attached. Taking one of the suggestions
   * also fills whatever it declares — label, category, length — but only where the operator
   * has left a blank, because an entry being edited already has answers worth keeping.
   */
  if (column.presets?.length) {
    return <CustomSelect {...common} hint={column.hint} value={asText}
      options={column.presets.map((preset) => ({ value: preset.value, label: preset.label, hint: preset.hint }))}
      onChange={(next) => {
        const preset = column.presets?.find((item) => item.value === next)
        if (preset?.apply) onApply({ [column.key]: next, ...preset.apply })
        else onChange(next)
      }} />
  }
  if (column.type === 'multiselect') {
    const options = catalogues[column.optionSource ?? 'antibiotics']
    const labels = new Map(options.map((option) => [option.value, option.label]))
    const current = memberRows(value)
    return <MultiSelect label={column.label} hint={column.hint} name={column.key} options={options} values={current.map(memberCode)}
      onChange={(codes) => {
        const existing = new Map(current.map((item) => [memberCode(item), item]))
        onChange(codes.map((code) => existing.get(code) ?? { code, name: labels.get(code) ?? code }))
      }} />
  }
  if (column.type === 'panelAntibiotics' || column.type === 'panelMarkers') {
    const markers = column.type === 'panelMarkers'
    const members = memberRows(value).map((item) => ({
      code: memberCode(item), name: String(item.name ?? item.antibiotic_name ?? item.marker_name ?? memberCode(item)),
      sort_order: Number(item.sort_order ?? 0), option_group: String(item.option_group ?? ''),
      requirement_type: String(item.requirement_type ?? 'core'), notes: String(item.notes ?? ''),
      source_text: item.source_text == null ? undefined : String(item.source_text)
    })) satisfies PanelAntibioticMember[]
    return <PanelAntibioticsEditor label={column.label} hint={column.hint} name={column.key} members={members}
      itemLabel={markers ? 'genomic marker' : 'antibiotic'} showOptionGroup={!markers}
      options={catalogues[column.optionSource ?? 'antibiotics']} onChange={(next) => onChange(next)} />
  }
  if (column.type === 'objectList') return <ObjectListEditor label={column.label} hint={column.hint} name={column.key}
    fields={column.fields ?? []} itemLabel={column.itemLabel} rows={memberRows(value, { requireCode: false })} onChange={onChange} />
  if (column.type === 'keyValue') return <KeyValueEditor label={column.label} hint={column.hint} name={column.key} value={value} onChange={onChange} />
  if (column.type === 'boolean') return <Switch checked={value === true || value === 1 || value === '1' || value === 'true'} onChange={onChange} label={column.label} description={column.required ? 'Required configuration flag' : undefined} disabled={column.readonly} />
  if (column.type === 'select') return <CustomSelect {...common} value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''} onChange={onChange} options={column.options ?? []} />
  if (column.type === 'textarea' || column.type === 'json') return <Textarea {...common} rows={column.type === 'json' ? 6 : 3} value={value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2)} hint={column.type === 'json' ? 'Valid JSON object or array.' : column.hint} onChange={(event) => onChange(event.target.value)} />
  return <Input {...common} type={column.type === 'number' ? 'number' : 'text'} hint={column.hint} value={value == null ? '' : String(value)} onChange={(event) => onChange(column.type === 'number' ? event.target.value === '' ? null : Number(event.target.value) : event.target.value)} />
}

/**
 * Sectioned editor for one master entry: a rail of steps on the left, the selected step's
 * fields on the right. Catalogues with nothing but scalar columns keep the plain single-pane
 * form — a one-item rail would be noise.
 */
export function MasterEntryEditor({ definition, columns, value, catalogues, countryProfile, notice, focusKey, onChange }: {
  definition: MasterDefinition
  columns: MasterColumn[]
  value: Row
  catalogues: MasterCatalogues
  /** Needed by `address` columns: which fields this country's addresses have. */
  countryProfile: CountryProfile
  notice?: ReactNode
  /** Column that failed validation; its section is opened so the field is visible. */
  focusKey?: string
  onChange: (key: string, next: unknown) => void
}): React.JSX.Element {
  const { t } = useTranslation('common')
  const codeSets = useCodeSets(useMemo(
    () => [...new Set(columns.map((column) => column.codeSet).filter((key): key is string => Boolean(key)))],
    [columns]
  ))
  /**
   * Filling several columns from one choice, without clobbering answers already given.
   *
   * The column the operator touched is always written; the rest of the preset only lands
   * where the entry is still blank, so re-picking a field key on an entry someone has
   * already labelled does not silently undo their labelling.
   */
  const applyPreset = (patch: Record<string, unknown>, key: string): void => {
    for (const [column, next] of Object.entries(patch)) {
      if (column !== key && value[column] != null && value[column] !== '') continue
      onChange(column, next)
    }
  }
  const { details, composites, sections } = useMemo(() => {
    const scalars = columns.filter((column) => !isComposite(column))
    const nested = columns.filter(isComposite)
    return {
      details: scalars,
      composites: nested,
      sections: [
        ...(scalars.length ? [{ id: DETAILS, label: 'Details', columns: scalars }] : []),
        ...nested.map((column) => ({ id: column.key, label: column.label, columns: [column] }))
      ]
    }
  }, [columns])
  const [active, setActive] = useState(sections[0]?.id ?? DETAILS)
  useEffect(() => { setActive((current) => sections.some((section) => section.id === current) ? current : sections[0]?.id ?? DETAILS) }, [sections])
  useEffect(() => {
    if (!focusKey) return
    const owner = sections.find((section) => section.columns.some((column) => column.key === focusKey))
    if (owner) setActive(owner.id)
  }, [focusKey, sections])

  const render = (column: MasterColumn): React.JSX.Element =>
    <MasterField key={column.key} column={column} value={value[column.key]} catalogues={catalogues} codeSets={codeSets}
      countryProfile={countryProfile} onChange={(next) => onChange(column.key, next)}
      onApply={(patch) => applyPreset(patch, column.key)} />

  if (composites.length === 0) {
    return <>
      {notice}
      <FieldGrid columns={details.length > 5 ? 2 : 1}>{details.map(render)}</FieldGrid>
    </>
  }

  const current = sections.find((section) => section.id === active) ?? sections[0]!
  const missing = (column: MasterColumn): boolean => Boolean(column.required) &&
    (isComposite(column) ? entryCount(column, value[column.key]) === 0 : value[column.key] == null || value[column.key] === '')
  return (
    <div className="entry-editor">
      <nav className="entry-editor__nav" aria-label={`${definition.title} sections`}>
        {sections.map((section) => {
          const composite = section.columns.find(isComposite)
          const incomplete = section.columns.some(missing)
          return <button key={section.id} type="button" className={cx('entry-editor__step', active === section.id && 'active')}
            aria-current={active === section.id ? 'step' : undefined} onClick={() => setActive(section.id)}>
            <span>{section.label}</span>
            {composite ? <small>{t('editor.selected', { count: entryCount(composite, value[composite.key]) })}</small> : <small>{t('editor.namePriorityStatus')}</small>}
            {incomplete && <i aria-label="Required" />}
          </button>
        })}
      </nav>
      <div className="entry-editor__pane">
        {notice}
        {current.id === DETAILS
          ? <FieldGrid columns={current.columns.length > 5 ? 2 : 1}>{current.columns.map(render)}</FieldGrid>
          : current.columns.map(render)}
        <div className="entry-editor__steps">
          <Button variant="ghost" disabled={sections[0]?.id === current.id} onClick={() => setActive(sections[sections.findIndex((section) => section.id === current.id) - 1]!.id)}>{t('editor.back')}</Button>
          <Button variant="ghost" disabled={sections[sections.length - 1]?.id === current.id} onClick={() => setActive(sections[sections.findIndex((section) => section.id === current.id) + 1]!.id)}>{t('editor.next')}</Button>
        </div>
      </div>
    </div>
  )
}
