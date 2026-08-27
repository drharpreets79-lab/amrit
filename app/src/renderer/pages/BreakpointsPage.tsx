import type React from 'react'
import { useEffect, useState } from 'react'
import { Check, Download, ExternalLink, FileSpreadsheet, Fingerprint, Plus, RefreshCw, ShieldCheck, Upload } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { BreakpointImportResult, Row } from '../../shared/types'
import { useFormat } from '../i18n/provider'
import { DataTable, type TableColumn } from '../components/DataTable'
import { useToast } from '../components/Toast'
import { Button, CustomSelect, ErrorState, FieldGrid, HelpDrawer, InlineNotice, Input, LoadingState, Modal, PageHeader, Section, StatusPill, Textarea, formatError } from '../components/ui'

const CLSI_TOOLKIT = 'https://clsi.org/resources/breakpoint-implementation-toolkit/'
const CLSI_M100 = 'https://clsi.org/shop/packages/ast-m100-pkg/'
const EUCAST_TABLES = 'https://www.eucast.org/clinical_breakpoints'

const text = (row: Row, ...keys: string[]): string => { for (const key of keys) { const value = row[key]; if (typeof value === 'string' || typeof value === 'number') return String(value) } return '' }
const truthy = (value: unknown): boolean => value === true || value === 1 || value === '1' || value === 'true' || value === 'active'

/**
 * A staged row's organism is either a catalogue code or a named scope, because guidelines
 * write most breakpoints against a group ("Enterobacterales") rather than a species. The
 * raw scope code is readable but ugly, so the name is shown and the code kept in the title.
 */
const organismLabel = (row: Row): string => {
  const code = text(row, 'organism_code')
  if (!code.toUpperCase().startsWith('GROUP:')) return code
  const name = code.replace(/^GROUP:(SPECIES:)?/i, '').replace(/-/g, ' ').toLocaleLowerCase()
  return `${name.charAt(0).toLocaleUpperCase()}${name.slice(1)}`
}

export function BreakpointsPage({ onChanged }: { onChanged: () => Promise<void> }): React.JSX.Element {
  const { t } = useTranslation('breakpoints')
  const { t: tc } = useTranslation('common')
  const format = useFormat()
  const { notify } = useToast()
  const [sets, setSets] = useState<Row[]>([])
  const [breakpoints, setBreakpoints] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [result, setResult] = useState<BreakpointImportResult | null>(null)
  const [busy, setBusy] = useState('')
  const [help, setHelp] = useState(false)
  const [customOpen, setCustomOpen] = useState(false)
  const [eucast, setEucast] = useState<{ installed: string | null; installedRows: number; bundled: string | null; sourceUrl: string; licence: string } | null>(null)
  const [custom, setCustom] = useState<Row>({ guidelines: 'CLSI', year: String(new Date().getFullYear()), test_method: 'Disk diffusion', breakpoint_type: 'Clinical', organism_code: '', whonet_abx_code: '', r_value: '', i_value: '', s_value: '', comments: '', active: false })
  const load = async (): Promise<void> => {
    setLoading(true); setError('')
    try {
      const [setRows, bpRows, eucastStatus] = await Promise.all([
        window.amrit.breakpoints.sets(),
        window.amrit.masters.list('breakpoints', { includeInactive: true, limit: 5000 }),
        window.amrit.breakpoints.eucastStatus().catch(() => null)
      ])
      setSets(setRows); setBreakpoints(bpRows); setEucast(eucastStatus)
    }
    catch (caught) { setError(formatError(caught)) } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])
  /**
   * The one guideline body this software can fetch for the operator.
   *
   * EUCAST publishes free of charge and permits redistribution with attribution; CLSI's
   * M100 is a paid standard, so its card next to this one offers a link and an import and
   * nothing more. What arrives is staged, not activated — the same review gate every other
   * import goes through, because a table nobody has checked against the local antimicrobial
   * catalogue must not start interpreting results.
   */
  const updateEucast = async (): Promise<void> => {
    setBusy('eucast')
    try {
      const outcome = await window.amrit.breakpoints.updateEucast()
      setResult(outcome)
      notify(
        outcome.origin === 'network' ? t('notify.eucastUpdated') : t('notify.eucastBundled'),
        t('notify.eucastDetail', { count: outcome.imported, edition: outcome.edition || '—' }),
        outcome.origin === 'network' ? 'success' : 'info'
      )
      await load()
    }
    catch (caught) { notify(t('notify.eucastFailed'), formatError(caught), 'error') } finally { setBusy('') }
  }
  const chooseAndImport = async (): Promise<void> => {
    const path = await window.amrit.chooseFile({ filters: [{ name: t('sources.workbookFilter'), extensions: ['xlsx', 'xlsb', 'xls'] }] })
    if (!path) return
    setBusy('upload')
    try { const imported = await window.amrit.breakpoints.import(path, { access: 'user-upload', status: 'staged' }); setResult(imported); notify(t('notify.staged'), t('notify.stagedDetail', { count: imported.imported })); await load() }
    catch (caught) { notify(t('notify.importFailed'), formatError(caught), 'error') } finally { setBusy('') }
  }
  const download = async (): Promise<void> => {
    setBusy('download')
    try { const response = await window.amrit.breakpoints.download(); if (response.result) setResult(response.result); notify(t('notify.downloaded'), response.path); await load() }
    catch (caught) { notify(t('notify.downloadFailed'), formatError(caught), 'error') } finally { setBusy('') }
  }
  const activate = async (row: Row): Promise<void> => {
    const id = Number(row.id); if (!id) return
    const label = text(row, 'name', 'source_name', 'edition') || t('notify.setName', { id })
    const validation = text(row, 'validation_status')
    const unmatched = Number(row.unmatched_count ?? 0)
    if (validation !== 'ready' || unmatched > 0) { notify(t('notify.activationBlocked'), validation !== 'ready' ? t('notify.notReady', { status: validation || t('notify.notReviewed') }) : t('notify.unmatchedBlocked', { count: unmatched }), 'error'); return }
    if (!window.confirm(t('notify.confirmActivate', { label }))) return
    try { await window.amrit.breakpoints.activate(id); notify(t('notify.activated'), label); await Promise.all([load(), onChanged()]) }
    catch (caught) { notify(t('notify.activateFailed'), formatError(caught), 'error') }
  }
  const saveCustom = async (): Promise<void> => {
    if (!text(custom, 'organism_code').trim() || !text(custom, 'whonet_abx_code').trim()) { notify(t('notify.requiredMissing'), t('notify.requiredDetail'), 'error'); return }
    if (![custom.r_value, custom.i_value, custom.s_value].some((value) => String(value ?? '').trim())) { notify(t('notify.thresholdRequired'), t('notify.thresholdDetail'), 'error'); return }
    try { await window.amrit.masters.save('breakpoints', { ...custom, active: false }); notify(t('notify.customSaved'), t('notify.customSavedDetail')); setCustomOpen(false); await Promise.all([load(), onChanged()]) }
    catch (caught) { notify(t('notify.customFailed'), formatError(caught), 'error') }
  }
  const activeSets = sets.filter((row) => truthy(row.active ?? row.is_active) || text(row, 'status') === 'active')
  const setColumns: Array<TableColumn<Row>> = [
    { key: 'source', label: t('sets.source'), render: (row) => <div className="table-primary"><strong>{text(row, 'name', 'source_name', 'guideline') || t('sets.importedSet')}</strong><small>{text(row, 'edition', 'year') || t('sets.editionMissing')}</small></div> },
    { key: 'status', label: t('sets.status'), render: (row) => { const active = truthy(row.active ?? row.is_active) || text(row, 'status') === 'active'; return <StatusPill label={active ? t('sets.active') : text(row, 'status') || t('sets.staged')} tone={active ? 'green' : 'orange'} /> } },
    { key: 'count', label: t('sets.rows'), render: (row) => <span>{text(row, 'row_count', 'imported_count', 'breakpoint_count') || '—'}</span> },
    { key: 'validation', label: t('sets.validation'), render: (row) => { const unmatched = Number(row.unmatched_count ?? 0); const status = text(row, 'validation_status') || 'not_reviewed'; return <div className="table-primary"><StatusPill label={status.replace(/_/g, ' ')} tone={status === 'ready' ? 'green' : 'orange'} /><small>{t('sets.unmatched', { count: unmatched })}</small></div> } },
    { key: 'hash', label: t('sets.provenance'), render: (row) => <span className="hash"><Fingerprint size={15} />{text(row, 'source_hash', 'sha256').slice(0, 16) || t('sets.noHash')}{text(row, 'source_hash', 'sha256') ? '…' : ''}</span> },
    { key: 'created', label: t('sets.importedAt'), render: (row) => { const date = text(row, 'imported_at', 'created_at'); return <span>{date ? format.dateTime(date) : '—'}</span> } },
    { key: 'actions', label: t('sets.actions'), className: 'table-actions', render: (row) => { const active = truthy(row.active ?? row.is_active) || text(row, 'status') === 'active'; const blocked = text(row, 'validation_status') !== 'ready' || Number(row.unmatched_count ?? 0) > 0; return <Button variant={active ? 'ghost' : 'secondary'} disabled={active || blocked} title={blocked ? t('sets.blockedTitle') : undefined} onClick={() => void activate(row)}>{active ? <Check size={16} /> : <ShieldCheck size={16} />}{active ? t('sets.active') : blocked ? t('sets.reviewRequired') : t('sets.activate')}</Button> } }
  ]
  const previewColumns: Array<TableColumn<Row>> = [
    { key: 'guidelines', label: t('preview.guideline') }, { key: 'year', label: t('preview.edition') }, { key: 'test_method', label: t('preview.method') },
    { key: 'organism_code', label: t('preview.organism'), render: (row) => <span title={text(row, 'organism_code')}>{organismLabel(row)}</span> },
    { key: 'whonet_abx_code', label: t('preview.antibiotic') },
    { key: 'scope', label: t('preview.scope'), render: (row) => <span>{[text(row, 'site_of_infection'), text(row, 'route')].filter(Boolean).join(' · ') || '—'}</span> },
    { key: 'r_value', label: t('preview.r') }, { key: 'i_value', label: t('preview.i') }, { key: 's_value', label: t('preview.s') }
  ]
  return <>
    <PageHeader eyebrow={t('eyebrow')} title={t('title')} purpose={t('purpose')} actions={<><Button variant="secondary" onClick={() => setCustomOpen(true)}><Plus size={17} /> {t('customRow')}</Button><Button variant="secondary" disabled={Boolean(busy)} onClick={() => void chooseAndImport()}><Upload size={17} /> {t('uploadWorkbook')}</Button><Button disabled={Boolean(busy)} onClick={() => void download()}><Download size={17} /> {t('downloadToolkit')}</Button></>} onHelp={() => setHelp(true)} />
    <InlineNotice tone="warning" title={t('boundaryTitle')}>{t('boundaryBody')}</InlineNotice>
    <div className="breakpoint-source-grid">
      <article><div className="source-card__brand source-card__brand--eucast">EUCAST</div><div>
        <h2>{t('sources.eucastTitle')}</h2>
        <p>{t('sources.eucastBody')}</p>
        <p className="muted">{eucast?.installed
          ? t('sources.eucastInstalled', { edition: eucast.installed, count: eucast.installedRows })
          : t('sources.eucastNotInstalled')}</p>
        <div>
          <Button disabled={Boolean(busy)} onClick={() => void updateEucast()}><RefreshCw size={15} /> {busy === 'eucast' ? t('sources.eucastUpdating') : t('sources.eucastUpdate')}</Button>
          <Button variant="ghost" onClick={() => void window.amrit.openExternal(EUCAST_TABLES)}>{t('sources.eucastOpen')} <ExternalLink size={15} /></Button>
        </div>
      </div></article>
      <article><div className="source-card__brand source-card__brand--clsi">CLSI</div><div><h2>{t('sources.toolkitTitle')}</h2><p>{t('sources.toolkitBody')}</p><div><Button variant="ghost" onClick={() => void window.amrit.openExternal(CLSI_TOOLKIT)}>{t('sources.openToolkit')} <ExternalLink size={15} /></Button><Button variant="ghost" onClick={() => void window.amrit.openExternal(CLSI_M100)}>{t('sources.accessM100')} <ExternalLink size={15} /></Button></div></div></article>
      <article><FileSpreadsheet size={28} /><div><h2>{t('sources.workbookTitle')}</h2><p>{t('sources.workbookBody')}</p><Button variant="ghost" onClick={() => void chooseAndImport()}>{t('sources.chooseWorkbook')} <Upload size={15} /></Button></div></article>
    </div>
    {result && <Section title={t('staging.title')} description={t('staging.description')}><div className="import-result"><div><span>{t('staging.source')}</span><strong>{result.sourceName}</strong></div><div><span>{t('staging.hash')}</span><strong className="hash-value">{result.sourceHash}</strong></div><div><span>{t('staging.edition')}</span><strong>{result.edition || t('staging.notDeclared')}</strong></div><div><span>{t('staging.imported')}</span><strong>{format.number(result.imported)}</strong></div><div><span>{t('staging.skipped')}</span><strong>{format.number(result.skipped)}</strong></div></div>{result.errors.length > 0 && <div className="issue-list">{result.errors.map((issue, index) => <div key={index}><StatusPill label="error" tone="red" /><span>{issue}</span></div>)}</div>}</Section>}
    <Section title={t('sets.title')} description={t('sets.description', { count: activeSets.length })}>
      {loading ? <LoadingState label={t('sets.loading')} /> : error ? <ErrorState message={error} onRetry={() => void load()} /> : <DataTable rows={sets} columns={setColumns} keyFor={(row, index) => String(row.id ?? index)} emptyTitle={t('sets.emptyTitle')} emptyMessage={t('sets.emptyMessage')} />}
    </Section>
    <Section title={t('preview.title')} description={t('preview.description', { shown: format.number(Math.min(100, breakpoints.length)), total: format.number(breakpoints.length) })}><DataTable rows={breakpoints.slice(0, 100)} columns={previewColumns} keyFor={(row, index) => String(row.id ?? index)} emptyTitle={t('preview.emptyTitle')} emptyMessage={t('preview.emptyMessage')} /></Section>
    <Modal open={customOpen} title={t('custom.title')} description={t('custom.description')} onClose={() => setCustomOpen(false)} width="large" actions={<><Button variant="secondary" onClick={() => setCustomOpen(false)}>{tc('cancel')}</Button><Button onClick={() => void saveCustom()}>{t('custom.save')}</Button></>}>
      <FieldGrid columns={3}><CustomSelect label={t('custom.guideline')} name="bp-guideline" value={String(custom.guidelines ?? '')} onChange={(value) => setCustom((row) => ({ ...row, guidelines: value }))} options={[{ value: 'CLSI', label: 'CLSI' }, { value: 'EUCAST', label: 'EUCAST' }, { value: 'National', label: t('custom.national') }]} /><Input label={t('custom.year')} value={String(custom.year ?? '')} onChange={(event) => setCustom((row) => ({ ...row, year: event.target.value }))} /><CustomSelect label={t('custom.testMethod')} name="bp-method" value={String(custom.test_method ?? '')} onChange={(value) => setCustom((row) => ({ ...row, test_method: value }))} options={[{ value: 'Disk diffusion', label: t('custom.diskDiffusion') }, { value: 'MIC', label: 'MIC — broth microdilution' }, { value: 'Gradient strip', label: 'Gradient strip (E-test)' }, { value: 'Agar dilution', label: 'Agar dilution' }, { value: 'Automated', label: 'Automated system' }]} /></FieldGrid>
      <FieldGrid columns={3}><Input label={t('custom.organismCode')} required value={String(custom.organism_code ?? '')} onChange={(event) => setCustom((row) => ({ ...row, organism_code: event.target.value }))} /><Input label={t('custom.antibioticCode')} required value={String(custom.whonet_abx_code ?? '')} onChange={(event) => setCustom((row) => ({ ...row, whonet_abx_code: event.target.value }))} /><Input label={t('custom.potency')} value={String(custom.potency ?? '')} onChange={(event) => setCustom((row) => ({ ...row, potency: event.target.value }))} /></FieldGrid>
      <FieldGrid columns={3}><Input label={t('custom.resistant')} value={String(custom.r_value ?? '')} onChange={(event) => setCustom((row) => ({ ...row, r_value: event.target.value }))} /><Input label={t('custom.intermediate')} value={String(custom.i_value ?? '')} onChange={(event) => setCustom((row) => ({ ...row, i_value: event.target.value }))} /><Input label={t('custom.susceptible')} value={String(custom.s_value ?? '')} onChange={(event) => setCustom((row) => ({ ...row, s_value: event.target.value }))} /></FieldGrid>
      <Textarea label={t('custom.comments')} rows={3} value={String(custom.comments ?? '')} onChange={(event) => setCustom((row) => ({ ...row, comments: event.target.value }))} />
    </Modal>
    <HelpDrawer open={help} title={t('title')} onClose={() => setHelp(false)}><p>{t('help.licensing')}</p><h3>{t('help.workflowTitle')}</h3><ol><li>{t('help.step1')}</li><li>{t('help.step2')}</li><li>{t('help.step3')}</li><li>{t('help.step4')}</li></ol><p>{t('help.outro')}</p></HelpDrawer>
  </>
}
