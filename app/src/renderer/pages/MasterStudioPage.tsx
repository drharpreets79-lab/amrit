/* Catalogue reloads are deliberately keyed to kind and laboratory scope. */
/* eslint-disable react-hooks/exhaustive-deps */
import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Copy, Database, Edit3, Plus, Power, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { isEssentialRequirement } from '../../shared/types'
import type { CountryProfile, Laboratory, MasterDefinition, MasterKind, Row, Scalar } from '../../shared/types'
import { DataTable, Pager, type TableColumn } from '../components/DataTable'
import { MasterEntryEditor } from '../components/MasterEntryEditor'
import { EMPTY_CATALOGUES, entryCount, isComposite, isMembership, memberCode, memberRows, toOptions, type MasterCatalogues } from '../components/masterOptions'
import { useToast } from '../components/Toast'
import { Button, EmptyState, ErrorState, HelpDrawer, InlineNotice, LoadingState, Modal, PageHeader, SearchInput, StatusPill, Switch, formatError } from '../components/ui'

/** Group names are catalogue keys under `groups.*`; the kinds are wire values. */
const GROUPS: Array<{ label: string; kinds: MasterKind[] }> = [
  { label: 'Microbiology', kinds: ['antibiotics', 'organisms', 'samples', 'sampleAliases', 'panels'] },
  { label: 'Genomics', kinds: ['genomicMarkers'] },
  { label: 'Sites & context', kinds: ['locations', 'domains', 'hospitals', 'admin-units'] },
  { label: 'Data design', kinds: ['dataFields', 'codeValues'] },
  { label: 'Interpretation', kinds: ['expertRules', 'breakpoints', 'qcRanges', 'expectedResistance'] }
]

const scalar = (value: unknown): string | number | boolean | null => Array.isArray(value) || (value && typeof value === 'object') ? JSON.stringify(value, null, 2) : value as Scalar
const activeOf = (row: Row): boolean => !('active' in row) || row.active === true || row.active === 1 || row.active === '1' || row.active === 'true' || row.is_active === true || row.is_active === 1 || row.is_active === '1'

export function MasterStudioPage({ definitions, currentLab, countryProfile, onChanged }: { definitions: MasterDefinition[]; currentLab: Laboratory | null; countryProfile: CountryProfile; onChanged: () => Promise<void> }): React.JSX.Element {
  const { t } = useTranslation('masters')
  const { t: tc } = useTranslation('common')
  const { notify } = useToast()
  /**
   * The administrative-unit tab takes the country's own terms for its levels — "States /
   * UTs · Districts" for India, whatever the country calls them elsewhere — so the tab
   * says what the country has rather than what one country happens to have.
   */
  const catalogueTitle = (itemKind: MasterKind, fallback: string): string => {
    if (itemKind !== 'admin-units') return fallback
    const labels = [...countryProfile.admin_levels]
      .sort((left, right) => left.level - right.level)
      .map((definition) => definition.label_plural)
    return labels.length ? labels.join(' · ') : fallback
  }
  const [kind, setKind] = useState<MasterKind>(definitions[0]?.kind ?? 'antibiotics')
  const [rows, setRows] = useState<Row[]>([])
  const [query, setQuery] = useState('')
  const [includeInactive, setIncludeInactive] = useState(false)
  const [editing, setEditing] = useState<Row | null | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [help, setHelp] = useState(false)
  const [page, setPage] = useState(1)
  const [catalogues, setCatalogues] = useState<MasterCatalogues>(EMPTY_CATALOGUES)
  const [invalidKey, setInvalidKey] = useState('')
  const definition = definitions.find((item) => item.kind === kind)
  const load = async (): Promise<void> => {
    if (!definition) return
    setLoading(true); setError('')
    try { setRows(await window.amrit.masters.list(kind, { labCode: definition.labScoped ? currentLab?.code : undefined, includeInactive: true, limit: 5000 })) }
    catch (caught) { setError(formatError(caught)) } finally { setLoading(false) }
  }
  useEffect(() => { setQuery(''); setPage(1); setEditing(undefined); void load() }, [kind, currentLab?.code])
  const needsCatalogues = Boolean(definition?.columns.some(isComposite))
  useEffect(() => {
    if (!needsCatalogues || catalogues.antibiotics.length) return
    let alive = true
    void Promise.all([
      window.amrit.masters.list('antibiotics', { includeInactive: false, limit: 10000 }),
      window.amrit.masters.list('organisms', { includeInactive: false, limit: 10000 }),
      window.amrit.masters.list('samples', { includeInactive: false, limit: 10000 }),
      window.amrit.masters.list('genomicMarkers', { includeInactive: false, limit: 10000 })
    ]).then(([antibiotics, organisms, samples, genomicMarkers]) => {
      if (!alive) return
      setCatalogues({
        antibiotics: toOptions(antibiotics, 'antibiotics'), organisms: toOptions(organisms, 'organisms'),
        samples: toOptions(samples, 'samples'), genomicMarkers: toOptions(genomicMarkers, 'genomicMarkers')
      })
    }).catch((caught) => { if (alive) notify(t('notify.cataloguesFailed'), formatError(caught), 'error') })
    return () => { alive = false }
  }, [needsCatalogues])
  const filtered = useMemo(() => rows.filter((row) => (includeInactive || activeOf(row)) && Object.values(row).some((value) => String(value ?? '').toLowerCase().includes(query.toLowerCase()))), [rows, query, includeInactive])
  const pageSize = 25
  const pageRows = filtered.slice((page - 1) * pageSize, page * pageSize)
  const editorUpdate = (key: string, value: unknown): void => setEditing((current) => current === undefined ? undefined : { ...(current ?? {}), [key]: value as Scalar })
  /** A new entry starts active and takes the next free ordering slot. */
  const blankEntry = (): Row => {
    const draft: Row = { active: true, is_active: 1 }
    for (const column of definition?.columns ?? []) {
      if (column.type !== 'number' || !['priority', 'sort_order'].includes(column.key)) continue
      draft[column.key] = rows.reduce((highest, row) => Math.max(highest, Number(row[column.key] ?? 0)), 0) + (column.key === 'priority' ? 1 : 10)
    }
    return draft
  }
  /** Most panels are variations of one another, so copying beats retyping. */
  const duplicate = (row: Row): void => {
    if (!definition) return
    const copy: Row = { ...row }
    delete copy[definition.key]
    for (const column of definition.columns) {
      const value = copy[column.key]
      if (column.type === 'text' && column.required && typeof value === 'string') copy[column.key] = definition.autoKey ? t('editor.copySuffix', { value }) : ''
    }
    copy.active = true; copy.is_active = 1
    setEditing(copy)
  }
  /** Two panels that share an organism and a specimen both match the same isolate. */
  const overlaps = useMemo(() => {
    if (!definition || !editing) return []
    const membership = definition.columns.filter(isMembership).filter((column) => column.type === 'multiselect')
    if (membership.length === 0) return []
    const draft = membership.map((column) => new Set(memberRows(editing[column.key]).map(memberCode)))
    if (draft.some((codes) => codes.size === 0)) return []
    return rows.filter((row) => {
      if (String(row[definition.key] ?? '') === String(editing[definition.key] ?? '···')) return false
      if (!activeOf(row)) return false
      return membership.every((column, index) => {
        const codes = memberRows(row[column.key]).map(memberCode)
        // An empty membership list is a wildcard: the panel matches every code for it.
        return codes.length === 0 || codes.some((code) => draft[index]!.has(code))
      })
    })
  }, [definition, editing, rows])
  const save = async (again = false): Promise<void> => {
    if (!definition || editing === undefined) return
    setInvalidKey('')
    for (const column of definition.columns) {
      const value = editing?.[column.key]
      if (isComposite(column)) {
        const empty = entryCount(column, value) === 0
        if (column.required && empty) { setInvalidKey(column.key); notify(t('notify.requiredSelection'), column.label, 'error'); return }
        continue
      }
      if (column.required && (value == null || value === '')) { setInvalidKey(column.key); notify(t('notify.requiredField'), column.label, 'error'); return }
      if (column.type === 'json' && typeof value === 'string' && value.trim()) { try { JSON.parse(value) } catch { setInvalidKey(column.key); notify(t('notify.invalidJson'), t('notify.invalidJsonDetail', { label: column.label }), 'error'); return } }
    }
    const normalized: Row = { ...(editing ?? {}) }
    for (const column of definition.columns) if (column.type === 'json' && typeof normalized[column.key] === 'string' && normalized[column.key]) normalized[column.key] = JSON.parse(String(normalized[column.key])) as Record<string, unknown>
    setSaving(true)
    try {
      const saved = await window.amrit.masters.save(kind, normalized, definition.labScoped ? currentLab?.code : undefined)
      // Governance can stage an entry as inactive (custom breakpoints, for one). Reveal
      // inactive rows so the entry the user just saved does not disappear from the table.
      const staged = saved && !activeOf(saved)
      if (staged) setIncludeInactive(true)
      notify(t('notify.saved', { title: definition.title }), staged
        ? t('notify.savedStaged')
        : t('notify.savedActive'))
      await Promise.all([load(), onChanged()])
      setEditing(again ? blankEntry() : undefined)
    }
    catch (caught) { notify(t('notify.saveFailed'), formatError(caught), 'error') } finally { setSaving(false) }
  }
  const remove = async (row: Row): Promise<void> => {
    if (!definition) return
    const key = scalar(row[definition.key]); if (typeof key !== 'string' && typeof key !== 'number') return
    if (!window.confirm(t('notify.confirmDelete', { title: definition.title, key: String(key) }))) return
    try { await window.amrit.masters.delete(kind, key, definition.labScoped ? currentLab?.code : undefined); notify(t('notify.deleted'), String(key)); await Promise.all([load(), onChanged()]) }
    catch (caught) { notify(t('notify.deleteFailed'), formatError(caught), 'error') }
  }
  const toggle = async (row: Row): Promise<void> => {
    if (!definition) return
    const key = scalar(row[definition.key]); if (typeof key !== 'string' && typeof key !== 'number') return
    const next = !activeOf(row)
    try { await window.amrit.masters.toggle(kind, key, next, definition.labScoped ? currentLab?.code : undefined); notify(next ? t('notify.activated') : t('notify.deactivated'), String(key)); await load() }
    catch (caught) { notify(t('notify.toggleFailed'), formatError(caught), 'error') }
  }
  const visibleColumns: Array<TableColumn<Row>> = (definition?.columns.filter((column) => column.type !== 'json' && !isComposite(column)).slice(0, 5) ?? []).map((column) => ({ key: column.key, label: column.label, render: (row) => column.type === 'boolean' ? <StatusPill label={row[column.key] ? t('columns.yes') : t('columns.no')} tone={row[column.key] ? 'green' : 'neutral'} /> : <span>{String(row[column.key] ?? '—')}</span> }))
  for (const column of definition?.columns.filter(isMembership) ?? []) visibleColumns.push({
    key: column.key,
    label: column.label,
    render: (row) => {
      const members = memberRows(row[column.key])
      if (!members.length) return <span className="muted">{t('columns.none')}</span>
      const essential = column.type === 'panelAntibiotics' ? members.filter((member) => isEssentialRequirement(member.requirement_type)).length : members.length
      return <span className="cell-multi"><strong>{members.slice(0, 3).map(memberCode).join(', ')}{members.length > 3 ? ` +${members.length - 3}` : ''}</strong>
        <small>{column.type === 'panelAntibiotics' ? t('columns.essentialOptional', { essential, optional: members.length - essential }) : t('columns.selected', { count: members.length })}</small></span>
    }
  })
  const existingEntry = Boolean(editing && definition && editing[definition.key])
  // A database-assigned key is never typed by hand, so it only clutters the form.
  const editableColumns = (definition?.columns ?? []).filter((column) => !(definition?.autoKey && column.key === definition.key))
  visibleColumns.push({ key: '__status', label: t('columns.status'), render: (row) => <StatusPill label={activeOf(row) ? t('columns.active') : t('columns.inactive')} tone={activeOf(row) ? 'green' : 'neutral'} /> })
  visibleColumns.push({ key: '__actions', label: t('columns.actions'), className: 'table-actions', render: (row) => <div className="row-actions"><Button variant="ghost" onClick={() => setEditing({ ...row })}><Edit3 size={16} /> {t('edit')}</Button><Button variant="ghost" title={t('duplicateTitle', { title: definition?.title.replace(/s$/, '').toLowerCase() ?? t('entry') })} onClick={() => duplicate(row)}><Copy size={16} /> {t('duplicate')}</Button><Button variant="ghost" onClick={() => void toggle(row)}><Power size={16} />{activeOf(row) ? t('disable') : t('enable')}</Button><Button variant="ghost" className="danger-text" onClick={() => void remove(row)}><Trash2 size={16} /><span className="sr-only">{t('deleteEntry')}</span></Button></div> })
  return <>
    <PageHeader eyebrow={t('eyebrow')} title={t('title')} purpose={t('purpose')} actions={definition && <Button disabled={loading || (definition.labScoped && !currentLab)} onClick={() => setEditing(blankEntry())}><Plus size={17} /> {t('add', { title: definition.title.replace(/s$/, '') })}</Button>} onHelp={() => setHelp(true)} />
    <div className="master-layout">
      <aside className="master-nav" aria-label={t('catalogueTypes')}><div className="master-nav__header"><Database size={19} /><span>{t('catalogue')}</span></div>{GROUPS.map((group) => <div key={group.label}><strong>{t(`groups.${group.label}`)}</strong>{group.kinds.map((itemKind) => { const item = definitions.find((candidate) => candidate.kind === itemKind); if (!item) return null; return <button key={itemKind} className={kind === itemKind ? 'active' : undefined} onClick={() => setKind(itemKind)}>{catalogueTitle(itemKind, item.title)}</button> })}</div>)}</aside>
      <div className="master-content">
        {definition ? <>
          <div className="master-heading"><div><span className="eyebrow">{definition.labScoped ? (currentLab ? t('labScopedWith', { code: currentLab.code }) : t('labScoped')) : t('sharedCatalogue')}</span><h2>{definition.title}</h2><p>{definition.purpose}</p></div><StatusPill label={t('entries', { count: rows.length })} tone="blue" /></div>
          {definition.labScoped && !currentLab ? <EmptyState title={t('noLabTitle')} message={t('noLabMessage')} /> : <><div className="toolbar"><SearchInput value={query} onChange={(value) => { setQuery(value); setPage(1) }} placeholder={t('searchPlaceholder', { title: definition.title.toLowerCase() })} /><Switch label={t('includeInactive')} checked={includeInactive} onChange={setIncludeInactive} /></div>{loading ? <LoadingState label={t('loading', { title: definition.title.toLowerCase() })} /> : error ? <ErrorState message={error} onRetry={() => void load()} /> : <><DataTable rows={pageRows} columns={visibleColumns} keyFor={(row, index) => String(row[definition.key] ?? index)} emptyTitle={t('emptyTitle', { title: definition.title.toLowerCase() })} emptyMessage={rows.length ? t('emptyFiltered') : t('emptyNone')} /><Pager page={page} pageCount={Math.ceil(filtered.length / pageSize)} onChange={setPage} /></>}</>}
        </> : <EmptyState title={t('noDefinitionTitle')} message={t('noDefinitionMessage')} />}
      </div>
    </div>
    <Modal open={editing !== undefined} title={existingEntry ? t('editor.editTitle', { title: definition?.title ?? t('editor.masterEntry') }) : t('editor.addTitle', { title: definition?.title ?? t('editor.masterEntry') })} description={definition?.purpose} onClose={() => !saving && setEditing(undefined)} width="large" actions={<><Button variant="secondary" disabled={saving} onClick={() => setEditing(undefined)}>{tc('cancel')}</Button>{!existingEntry && <Button variant="secondary" disabled={saving} onClick={() => void save(true)}>{t('editor.saveAndAdd')}</Button>}<Button disabled={saving} onClick={() => void save()}>{saving ? t('editor.saving') : t('editor.saveEntry')}</Button></>}>
      {definition && editing !== undefined && <MasterEntryEditor
        definition={definition}
        columns={editableColumns}
        value={editing ?? {}}
        catalogues={catalogues}
        countryProfile={countryProfile}
        focusKey={invalidKey}
        onChange={editorUpdate}
        notice={overlaps.length > 0 && <InlineNotice tone="warning" title={t('editor.overlap', { count: overlaps.length })}>
          {t('editor.overlapBody', { names: `${overlaps.slice(0, 4).map((row) => String(row.panel_name ?? row.name ?? row[definition.key])).join('; ')}${overlaps.length > 4 ? t('editor.overlapMore', { count: overlaps.length - 4 }) : ''}` })}
        </InlineNotice>}
      />}
    </Modal>
    <HelpDrawer open={help} title={t('title')} onClose={() => setHelp(false)}><p>{t('help.sourceOfTruth')}</p><h3>{t('help.customTitle')}</h3><p>{t('help.customBody')}</p><h3>{t('help.panelsTitle')}</h3><p>{t('help.panelsBody')}</p><p>{t('help.panelsRequirement')}</p><h3>{t('help.dependenciesTitle')}</h3><p>{t('help.dependenciesBody')}</p></HelpDrawer>
  </>
}
