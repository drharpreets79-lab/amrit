/* Record and master reloads are deliberately scoped to active laboratory changes. */
/* eslint-disable react-hooks/exhaustive-deps */
import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Download, Edit3, FileCheck2, Filter, Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { IsolateRecord, Laboratory } from '../../shared/types'
import { useFormat } from '../i18n/provider'
import { DataTable, Pager, type TableColumn } from '../components/DataTable'
import { IsolateEditor, type EditorMasters } from '../components/IsolateEditor'
import { useToast } from '../components/Toast'
import { Button, EmptyState, ErrorState, HelpDrawer, InlineNotice, LoadingState, PageHeader, SearchInput, Select, StatusPill, formatError } from '../components/ui'

const EMPTY_MASTERS: EditorMasters = { antibiotics: [], organisms: [], samples: [], locations: [], domains: [], hospitals: [], dataFields: [], codeValues: [], genomicMarkers: [] }

export function RecordsPage({ currentLab, onChanged }: { currentLab: Laboratory | null; onChanged: () => Promise<void> }): React.JSX.Element {
  const { t } = useTranslation('records')
  const format = useFormat()
  const { notify } = useToast()
  const [records, setRecords] = useState<IsolateRecord[]>([])
  const [masters, setMasters] = useState<EditorMasters>(EMPTY_MASTERS)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [page, setPage] = useState(1)
  const [editing, setEditing] = useState<IsolateRecord | null | undefined>(undefined)
  const [editorVersion, setEditorVersion] = useState(0)
  const [saveReview, setSaveReview] = useState<{ id: number; alerts: number; comments: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [truncationWarnings, setTruncationWarnings] = useState<string[]>([])
  const [help, setHelp] = useState(false)
  const load = async (): Promise<void> => {
    if (!currentLab) { setLoading(false); return }
    setLoading(true); setError('')
    try {
      const [items, antibiotics, organisms, samples, locations, domains, hospitals, dataFields, codeValues, genomicMarkers] = await Promise.all([
        window.amrit.records.list({ labCode: currentLab.code, limit: 100000 }),
        window.amrit.masters.list('antibiotics', { includeInactive: false, limit: 10000 }),
        window.amrit.masters.list('organisms', { includeInactive: false, limit: 10000 }),
        window.amrit.masters.list('samples', { includeInactive: false, limit: 10000 }),
        window.amrit.masters.list('locations', { labCode: currentLab.code, includeInactive: false, limit: 10000 }),
        window.amrit.masters.list('domains', { includeInactive: false, limit: 10000 }),
        window.amrit.masters.list('hospitals', { labCode: currentLab.code, includeInactive: false, limit: 10000 }),
        window.amrit.masters.list('dataFields', { labCode: currentLab.code, includeInactive: false, limit: 10000 }),
        window.amrit.masters.list('codeValues', { includeInactive: false, limit: 10000 }),
        window.amrit.masters.list('genomicMarkers', { includeInactive: false, limit: 10000 })
      ])
      setRecords(items); setMasters({ antibiotics, organisms, samples, locations, domains, hospitals, dataFields, codeValues, genomicMarkers })
      const warnings: string[] = []
      if (items.length >= 100000) warnings.push(t('capRecords'))
      for (const [key, rows] of [['antibiotics', antibiotics], ['organisms', organisms], ['specimens', samples], ['locations', locations], ['domains', domains], ['hospitals', hospitals], ['dataFields', dataFields], ['codeValues', codeValues]] as Array<[string, typeof antibiotics]>) if (rows.length >= 10000) warnings.push(t('capMaster', { label: t(`masterLabels.${key}`) }))
      setTruncationWarnings(warnings)
    } catch (caught) { setError(formatError(caught)) } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [currentLab?.code])
  const filtered = useMemo(() => records.filter((record) => (status === 'all' || record.record_status === status) && `${record.patient_id ?? ''} ${record.specimen_number ?? ''} ${record.organism ?? ''} ${record.specimen_type ?? ''}`.toLowerCase().includes(query.toLowerCase())), [records, query, status])
  const pageSize = 50
  const pageRows = filtered.slice((page - 1) * pageSize, page * pageSize)
  const save = async (record: IsolateRecord): Promise<void> => {
    const result = await window.amrit.records.save(record)
    const canonical = await window.amrit.records.get(result.id).catch(() => null)
    const reopened: IsolateRecord = {
      ...record,
      ...canonical,
      id: result.id,
      alerts: canonical?.alerts ?? result.alerts,
      expert_comments: canonical?.expert_comments ?? result.comments
    }
    const alerts = reopened.alerts?.length ?? 0
    const comments = reopened.expert_comments?.length ?? 0
    setEditing(reopened)
    setEditorVersion((version) => version + 1)
    setSaveReview({ id: result.id, alerts, comments })
    notify(record.id ? t('notify.updated') : t('notify.created'), t('notify.savedDetail', { id: result.id, status: record.record_status }))
    await Promise.allSettled([load(), onChanged()])
  }
  const remove = async (record: IsolateRecord): Promise<void> => {
    if (!record.id || !window.confirm(t('notify.confirmDelete', { id: record.id }))) return
    try { await window.amrit.records.delete(record.id); notify(t('notify.deleted'), t('notify.deletedDetail', { id: record.id })); await Promise.all([load(), onChanged()]) }
    catch (caught) { notify(t('notify.deleteFailed'), formatError(caught), 'error') }
  }
  const exportSelected = async (record: IsolateRecord): Promise<void> => {
    if (!record.id || !currentLab) return
    const path = await window.amrit.chooseSave({ defaultPath: `${currentLab.code}_isolate_${record.id}.json`, filters: [{ name: t('notify.isolateJson'), extensions: ['json'] }] })
    if (!path) return
    try { await window.amrit.exports.save('json', { labCode: currentLab.code, recordId: record.id } as never, path); notify(t('notify.exported'), path) }
    catch (caught) { notify(t('notify.exportFailed'), formatError(caught), 'error') }
  }
  const columns: Array<TableColumn<IsolateRecord>> = [
    { key: 'specimen', label: t('columns.specimen'), render: (record) => <div className="table-primary"><strong>{record.specimen_number || t('columns.pendingNumber')}</strong><small>{record.specimen_date ? format.date(record.specimen_date) : t('columns.noDate')} · {record.specimen_type || t('columns.typePending')}</small></div> },
    { key: 'patient', label: t('columns.patient'), render: (record) => <span className="code-label">{record.patient_id || '—'}</span> },
    { key: 'organism', label: t('columns.organism'), render: (record) => <div className="table-primary"><strong>{record.organism || t('columns.notIdentified')}</strong><small>{record.organism_code || t('columns.noCode')}</small></div> },
    { key: 'location', label: t('columns.location'), render: (record) => <span>{record.location || '—'}<small className="cell-subtitle">{record.location_type || ''}</small></span> },
    { key: 'ast', label: t('columns.ast'), render: (record) => <span>{t('columns.astResults', { count: Object.keys(record.antibiotic_results ?? {}).length })}</span> },
    { key: 'status', label: t('columns.status'), render: (record) => <StatusPill label={record.record_status || 'draft'} tone={record.record_status === 'final' ? 'green' : 'orange'} /> },
    { key: 'actions', label: t('columns.actions'), className: 'table-actions', render: (record) => <div className="row-actions"><Button variant="ghost" onClick={(event) => { event.stopPropagation(); setSaveReview(null); setEditing({ ...record }) }}><Edit3 size={16} /> {t('review')}</Button><Button variant="ghost" onClick={(event) => { event.stopPropagation(); void exportSelected(record) }}><Download size={16} /> {t('export')}</Button><Button variant="ghost" className="danger-text" onClick={(event) => { event.stopPropagation(); void remove(record) }}><Trash2 size={16} /><span className="sr-only">{t('deleteRecord')}</span></Button></div> }
  ]
  if (!currentLab) return <><PageHeader eyebrow={t('eyebrow')} title={t('title')} purpose={t('purpose')} onHelp={() => setHelp(true)} /><EmptyState title={t('noLabTitle')} message={t('noLabMessage')} /><HelpDrawer open={help} title={t('title')} onClose={() => setHelp(false)}><p>{t('noLabHelp')}</p></HelpDrawer></>
  if (editing !== undefined) return <><PageHeader eyebrow={editing ? t('editor.recordNumber', { id: editing.id ?? t('editor.draftRecord') }) : t('editor.newRecord')} title={editing ? t('editor.reviewTitle') : t('editor.enterTitle')} purpose={t('editor.purpose')} onHelp={() => setHelp(true)} />{saveReview && editing?.id === saveReview.id && <InlineNotice tone="success" title={t('editor.savedTitle')}>{t('editor.savedBody', { count: saveReview.alerts, comments: saveReview.comments })}</InlineNotice>}<IsolateEditor key={`${editing?.id ?? 'new'}-${editorVersion}`} initial={editing} labCode={currentLab.code} countryCode={currentLab.country_code || currentLab.address?.country_code || ''} masters={masters} defaultMethod={currentLab.default_test_method ?? ''} defaultGuideline={currentLab.default_guideline ?? ''} onSave={save} onCancel={() => { setSaveReview(null); setEditing(undefined) }} /><HelpDrawer open={help} title={t('editor.helpTitle')} onClose={() => setHelp(false)}><p>{t('editor.helpPanels')}</p><p>{t('editor.helpFinalise')}</p></HelpDrawer></>
  return <>
    <PageHeader eyebrow={t('eyebrow')} title={t('title')} purpose={t('purpose')} actions={<Button onClick={() => { setSaveReview(null); setEditing(null) }}><Plus size={17} /> {t('newIsolate')}</Button>} onHelp={() => setHelp(true)} />
    <div className="record-summary-strip"><div><FileCheck2 size={20} /><span><strong>{format.number(records.filter((record) => record.record_status === 'final').length)}</strong><small>{t('final')}</small></span></div><div><Edit3 size={20} /><span><strong>{format.number(records.filter((record) => record.record_status !== 'final').length)}</strong><small>{t('draft')}</small></span></div><div><Filter size={20} /><span><strong>{format.number(filtered.length)}</strong><small>{t('shown')}</small></span></div></div>
    {truncationWarnings.length > 0 && <InlineNotice tone="warning" title={t('capTitle')}>{truncationWarnings.join(' ')}</InlineNotice>}
    <div className="toolbar"><SearchInput value={query} onChange={(value) => { setQuery(value); setPage(1) }} placeholder={t('searchPlaceholder')} /><Select aria-label={t('filterStatus')} value={status} onChange={(event) => { setStatus(event.target.value); setPage(1) }}><option value="all">{t('allStatuses')}</option><option value="draft">{t('draftOnly')}</option><option value="final">{t('finalOnly')}</option></Select><Button variant="secondary" onClick={() => void load()}>{t('refresh')}</Button></div>
    {loading ? <LoadingState label={t('loading')} /> : error ? <ErrorState message={error} onRetry={() => void load()} /> : <><DataTable rows={pageRows} columns={columns} keyFor={(record, index) => record.id ?? index} emptyTitle={t('emptyTitle')} emptyMessage={records.length ? t('emptyFiltered') : t('emptyNone')} /><Pager page={page} pageCount={Math.ceil(filtered.length / pageSize)} onChange={setPage} /></>}
    <HelpDrawer open={help} title={t('title')} onClose={() => setHelp(false)}><p>{t('help.drafts')}</p><h3>{t('help.duplicateTitle')}</h3><p>{t('help.duplicateBody')}</p><h3>{t('help.provenanceTitle')}</h3><p>{t('help.provenanceBody')}</p></HelpDrawer>
  </>
}
