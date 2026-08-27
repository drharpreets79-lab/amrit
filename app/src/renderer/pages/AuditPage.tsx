import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Clock3, Eye, RefreshCw, SearchCheck, ShieldAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { AuditEntry } from '../../shared/types'
import { useFormat } from '../i18n/provider'
import { DataTable, type TableColumn } from '../components/DataTable'
import { StructuredDetail } from '../components/StructuredFields'
import { Button, EmptyState, ErrorState, HelpDrawer, LoadingState, Modal, PageHeader, SearchInput, Select, StatusPill, formatError } from '../components/ui'

export function AuditPage(): React.JSX.Element {
  const { t } = useTranslation('audit')
  const format = useFormat()
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [selected, setSelected] = useState<AuditEntry | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [help, setHelp] = useState(false)
  const load = async (): Promise<void> => { setLoading(true); setError(''); try { setEntries(await window.amrit.audit.list(2000)) } catch (caught) { setError(formatError(caught)) } finally { setLoading(false) } }
  useEffect(() => { void load() }, [])
  const filtered = useMemo(() => entries.filter((entry) => (status === 'all' || entry.status === status) && `${entry.operation} ${entry.summary} ${entry.details ?? ''}`.toLowerCase().includes(query.toLowerCase())), [entries, query, status])
  const columns: Array<TableColumn<AuditEntry>> = [
    { key: 'timestamp', label: t('columns.time'), render: (entry) => <span className="timestamp"><Clock3 size={15} />{format.dateTime(entry.timestamp)}</span> },
    { key: 'operation', label: t('columns.operation'), render: (entry) => <strong>{entry.operation}</strong> },
    { key: 'summary', label: t('columns.summary') },
    { key: 'status', label: t('columns.outcome'), render: (entry) => <StatusPill label={entry.status} tone={entry.status === 'ok' ? 'green' : entry.status === 'error' ? 'red' : 'orange'} /> },
    { key: 'actions', label: t('columns.details'), className: 'table-actions', render: (entry) => <Button variant="ghost" onClick={() => setSelected(entry)}><Eye size={16} /> {t('inspect')}</Button> }
  ]
  return <>
    <PageHeader eyebrow={t('eyebrow')} title={t('title')} purpose={t('purpose')} actions={<Button variant="secondary" onClick={() => void load()}><RefreshCw size={17} /> {t('refresh')}</Button>} onHelp={() => setHelp(true)} />
    <div className="audit-stats"><article><SearchCheck size={20} /><span><strong>{format.number(entries.length)}</strong><small>{t('loaded')}</small></span></article><article><CheckCircle2 size={20} /><span><strong>{format.number(entries.filter((entry) => entry.status === 'ok').length)}</strong><small>{t('successful')}</small></span></article><article><ShieldAlert size={20} /><span><strong>{format.number(entries.filter((entry) => entry.status !== 'ok').length)}</strong><small>{t('warningsErrors')}</small></span></article></div>
    <div className="toolbar"><SearchInput value={query} onChange={setQuery} placeholder={t('searchPlaceholder')} /><Select aria-label={t('filterStatus')} value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">{t('allOutcomes')}</option><option value="ok">{t('successful')}</option><option value="warning">{t('warnings')}</option><option value="error">{t('errors')}</option></Select><span className="toolbar__count">{t('eventsShown', { count: filtered.length })}</span></div>
    {loading ? <LoadingState label={t('loading')} /> : error ? <ErrorState message={error} onRetry={() => void load()} /> : filtered.length ? <DataTable rows={filtered} columns={columns} keyFor={(entry, index) => `${entry.timestamp}-${entry.operation}-${index}`} caption={t('caption')} /> : <EmptyState title={t('emptyTitle')} message={entries.length ? t('emptyFiltered') : t('emptyNone')} />}
    <Modal open={Boolean(selected)} title={selected?.operation ?? t('event')} description={selected ? format.dateTime(selected.timestamp) : undefined} onClose={() => setSelected(null)} width="medium" actions={<Button onClick={() => setSelected(null)}>{t('close')}</Button>}>
      {selected && <div className="audit-detail"><div><span>{t('columns.outcome')}</span><StatusPill label={selected.status} tone={selected.status === 'ok' ? 'green' : selected.status === 'error' ? 'red' : 'orange'} /></div><div><span>{t('columns.summary')}</span><strong>{selected.summary}</strong></div><div><span>{t('columns.details')}</span><StructuredDetail text={selected.details} /></div></div>}
    </Modal>
    <HelpDrawer open={help} title={t('title')} onClose={() => setHelp(false)}><p>{t('help.recorded')}</p><p>{t('help.retention')}</p></HelpDrawer>
  </>
}

