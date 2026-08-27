/* Import metadata refreshes at deliberate file/profile lifecycle boundaries. */
/* eslint-disable react-hooks/exhaustive-deps */
import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Download, FileSpreadsheet, FolderOpen, History, Upload, XCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { ImportPreview, ImportProfile, Laboratory, Row } from '../../shared/types'
import { useFormat } from '../i18n/provider'
import { DataTable, type TableColumn } from '../components/DataTable'
import { useToast } from '../components/Toast'
import { Button, Combobox, EmptyState, ErrorState, HelpDrawer, InlineNotice, LoadingState, PageHeader, PromptModal, Section, Select, StatusPill, formatError } from '../components/ui'

/** Canonical field names; their display labels live under `targets.*` in the catalogue. */
const CORE_TARGET_FIELDS = [
  '', 'patient_id', 'specimen_number', 'specimen_date', 'specimen_type', 'specimen_code',
  'organism', 'organism_code', 'sex', 'date_of_birth', 'age_years', 'location',
  'location_type', 'admission_date', 'diagnosis', 'diagnosis_code', 'record_status',
  'antibiotic_results'
] as const

export function ImportPage({ currentLab, onChanged }: { currentLab: Laboratory | null; onChanged: () => Promise<void> }): React.JSX.Element {
  const { t } = useTranslation('imports')
  const format = useFormat()
  const { notify } = useToast()
  const [path, setPath] = useState('')
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [history, setHistory] = useState<Row[]>([])
  const [profiles, setProfiles] = useState<ImportProfile[]>([])
  const [profileId, setProfileId] = useState('')
  const [antibiotics, setAntibiotics] = useState<Row[]>([])
  const [delimiter, setDelimiter] = useState('auto')
  const [defaultStatus, setDefaultStatus] = useState('draft')
  const [previewCurrent, setPreviewCurrent] = useState(false)
  const [antibioticCap, setAntibioticCap] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [help, setHelp] = useState(false)
  const [namingProfile, setNamingProfile] = useState(false)
  const previewOptions = (): { delimiter?: string; defaults: Record<string, string> } => ({
    ...(delimiter === 'auto' ? {} : { delimiter }),
    defaults: { record_status: defaultStatus }
  })
  const loadMetadata = async (): Promise<void> => {
    if (!currentLab) return
    try { const [profileItems, historyItems, antibioticItems] = await Promise.all([window.amrit.imports.profiles(currentLab.code), window.amrit.imports.history(currentLab.code), window.amrit.masters.list('antibiotics', { includeInactive: false, limit: 10000 })]); setProfiles(profileItems); setHistory(historyItems.slice(0, 10)); setAntibiotics(antibioticItems); setAntibioticCap(antibioticItems.length >= 10000) } catch { /* Core import remains available if metadata is unavailable. */ }
  }
  useEffect(() => { void loadMetadata() }, [currentLab?.code, preview])
  const pick = async (): Promise<void> => {
    const chosen = await window.amrit.chooseFile({ filters: [{ name: t('fileFilter'), extensions: ['xlsx', 'xls', 'xlsb', 'csv', 'tsv', 'txt'] }] })
    if (!chosen || !currentLab) return
    setPath(chosen); setPreviewCurrent(false); setBusy(true); setError('')
    try {
      const result = await window.amrit.imports.preview(chosen, currentLab.code, {}, previewOptions())
      setPreview(result)
      const guessed: Record<string, string> = {}
      for (const header of result.headers) { const normalized = header.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''); guessed[header] = CORE_TARGET_FIELDS.find((field) => field === normalized) ?? '' }
      setMapping(guessed)
    } catch (caught) { setError(formatError(caught)); setPreview(null) } finally { setBusy(false) }
  }
  const remap = async (): Promise<void> => {
    if (!path || !currentLab) return
    setBusy(true); setError('')
    try { setPreview(await window.amrit.imports.preview(path, currentLab.code, mapping, previewOptions())); setPreviewCurrent(true) } catch (caught) { setPreviewCurrent(false); setError(formatError(caught)) } finally { setBusy(false) }
  }
  const commit = async (): Promise<void> => {
    if (!preview || !previewCurrent || !currentLab || preview.errorCount > 0) return
    setBusy(true)
    try { const result = await window.amrit.imports.commit(preview, currentLab.code); notify(t('notify.completed'), t('notify.completedDetail', { imported: result.imported, drafts: result.drafts })); setPreview(null); setPath(''); await onChanged() }
    catch (caught) { notify(t('notify.failed'), formatError(caught), 'error') } finally { setBusy(false) }
  }
  const applyProfile = (id: string): void => {
    setProfileId(id)
    const profile = profiles.find((item) => String(item.id) === id)
    if (profile) { setMapping(profile.mapping); setDelimiter(profile.delimiter || 'auto'); setDefaultStatus(profile.defaults?.record_status || 'draft') }
    setPreviewCurrent(false)
  }
  const saveProfile = async (profileName: string): Promise<void> => {
    setNamingProfile(false)
    if (!currentLab || !preview) return
    const existing = profiles.find((item) => String(item.id) === profileId)
    try { const saved = await window.amrit.imports.saveProfile({ id: existing?.id, lab_code: currentLab.code, profile_name: profileName, file_format: path.split('.').pop()?.toLowerCase(), delimiter: delimiter === 'auto' ? '' : delimiter, mapping, defaults: { record_status: defaultStatus } }); setProfileId(String(saved.id ?? '')); notify(t('notify.profileSaved'), profileName); await loadMetadata() }
    catch (caught) { notify(t('notify.profileSaveFailed'), formatError(caught), 'error') }
  }
  const deleteProfile = async (): Promise<void> => {
    const profile = profiles.find((item) => String(item.id) === profileId)
    if (!profile?.id || !window.confirm(t('notify.confirmDeleteProfile', { name: profile.profile_name }))) return
    try { await window.amrit.imports.deleteProfile(profile.id); setProfileId(''); notify(t('notify.profileDeleted'), profile.profile_name); await loadMetadata() }
    catch (caught) { notify(t('notify.profileDeleteFailed'), formatError(caught), 'error') }
  }
  const template = async (): Promise<void> => {
    if (!currentLab) return
    const destination = await window.amrit.chooseSave({ defaultPath: `AMRIT_${currentLab.code}_import_template.xlsx`, filters: [{ name: t('workbookFilter'), extensions: ['xlsx'] }] })
    if (!destination) return
    try { await window.amrit.imports.template(destination, currentLab.code); notify(t('notify.templateSaved'), destination) } catch (caught) { notify(t('notify.templateFailed'), formatError(caught), 'error') }
  }
  const mappingTargets = useMemo<Array<readonly [string, string]>>(() => [
    ...CORE_TARGET_FIELDS.map((field) => [field, field ? t(`targets.${field}`) : t('targets.skip')] as const),
    ...antibiotics.flatMap((row) => { const code = String(row.antibiotic_code ?? row.code ?? row.whonet_code ?? '').toUpperCase(); const name = String(row.antibiotic_name ?? row.name ?? code); return code ? [[`antibiotic_results.${code}.result`, t('targets.interpretation', { name, code })], [`antibiotic_results.${code}.measurement`, t('targets.measurement', { name, code })]] as Array<readonly [string, string]> : [] })
  ], [antibiotics, t])
  /** The same targets in the shape the searchable control takes. */
  const mappingOptions = useMemo(
    () => mappingTargets.filter(([value]) => value).map(([value, label]) => ({ value, label, hint: value })),
    [mappingTargets]
  )
  const rowColumns = useMemo<Array<TableColumn<Row>>>(() => {
    if (!preview) return []
    const targets = [...new Set(preview.headers.map((header) => mapping[header]).filter((value): value is string => Boolean(value)))]
    const keys = targets.length ? targets : Object.keys(preview.rows[0] ?? {}).filter((key) => key !== 'antibiotic_results')
    return keys.slice(0, 10).map((key) => ({ key, label: mappingTargets.find(([value]) => value === key)?.[1] ?? key, render: (row) => { const matched = key.match(/^antibiotic_results\.([A-Za-z0-9_-]+)\.(result|measurement)$/); if (!matched) return <span>{String(row[key] ?? '—')}</span>; const ast = row.antibiotic_results as Record<string, Record<string, unknown>> | undefined; return <span>{String(ast?.[matched[1] ?? '']?.[matched[2] ?? ''] ?? '—')}</span> } }))
  }, [preview, mapping, mappingTargets])
  if (!currentLab) return <><PageHeader eyebrow={t('eyebrow')} title={t('title')} purpose={t('purpose')} onHelp={() => setHelp(true)} /><EmptyState title={t('noLabTitle')} message={t('noLabMessage')} /><HelpDrawer open={help} title={t('title')} onClose={() => setHelp(false)}><p>{t('noLabHelp')}</p></HelpDrawer></>
  return <>
    <PageHeader eyebrow={t('eyebrow')} title={t('title')} purpose={t('purpose')} actions={<><Button variant="secondary" onClick={() => void template()}><Download size={17} /> {t('downloadTemplate')}</Button><Button onClick={() => void pick()}><FolderOpen size={17} /> {t('chooseFile')}</Button></>} onHelp={() => setHelp(true)} />
    <InlineNotice tone="info" title={t('destination', { name: currentLab.name })}>{t('destinationBody', { code: currentLab.code })}</InlineNotice>
    {antibioticCap && <InlineNotice tone="warning" title={t('antibioticCapTitle')}>{t('antibioticCapBody')}</InlineNotice>}
    {!path && <div className="drop-zone"><FileSpreadsheet size={35} /><h2>{t('dropTitle')}</h2><p>{t('dropBody')}</p><Button onClick={() => void pick()}><Upload size={17} /> {t('browse')}</Button><span>{t('orTemplate')}</span></div>}
    {path && <Section title={t('selectedSource')} description={path} actions={<Button variant="ghost" onClick={() => { setPath(''); setPreview(null); setPreviewCurrent(false); setMapping({}); setProfileId(''); setError('') }}>{t('changeFile')}</Button>}>
      {busy ? <LoadingState label={t('parsing')} /> : error ? <ErrorState message={error} onRetry={() => void remap()} /> : preview && <>
        <div className="import-scorecard"><div><CheckCircle2 size={21} /><span><strong>{format.number(preview.validCount)}</strong><small>{t('valid')}</small></span></div><div><FileSpreadsheet size={21} /><span><strong>{format.number(preview.draftCount)}</strong><small>{t('draftCandidates')}</small></span></div><div className={preview.errorCount ? 'score-danger' : ''}><XCircle size={21} /><span><strong>{format.number(preview.errorCount)}</strong><small>{t('errors')}</small></span></div></div>
        <div className="mapping-profile-bar"><Select label={t('mappingProfile')} value={profileId} onChange={(event) => applyProfile(event.target.value)}><option value="">{t('noProfile')}</option>{profiles.map((profile) => <option key={profile.id} value={String(profile.id)}>{profile.profile_name}</option>)}</Select><Select label={t('delimiterProfile')} value={delimiter} onChange={(event) => { setDelimiter(event.target.value); setPreviewCurrent(false) }}><option value="auto">{t('autoDetect')}</option><option value=",">{t('comma')}</option><option value="\t">{t('tab')}</option><option value=";">{t('semicolon')}</option><option value="|">{t('pipe')}</option></Select><Select label={t('defaultRowState')} value={defaultStatus} onChange={(event) => { setDefaultStatus(event.target.value); setPreviewCurrent(false) }}><option value="draft">{t('draftUntilValidated')}</option><option value="final">{t('finalWhenPassing')}</option></Select><Button variant="secondary" onClick={() => setNamingProfile(true)}>{t('saveMapping')}</Button><Button variant="ghost" disabled={!profileId} onClick={() => void deleteProfile()}>{t('deleteProfile')}</Button></div>
        <PromptModal open={namingProfile} title={t('profileModalTitle')} description={t('profileModalDescription')} label={t('profileNameLabel')} defaultValue={profiles.find((item) => String(item.id) === profileId)?.profile_name ?? ''} onCancel={() => setNamingProfile(false)} onConfirm={(name) => void saveProfile(name)} />
        <h3 className="subheading">{t('mappingTitle')}</h3><p className="section-intro">{t('mappingIntro')}</p>
        {/* One control per source column, over a list that is the core fields plus two entries for
            every antimicrobial in the catalogue — 800-odd on a full install. Scrolling that for
            each of 60 spreadsheet columns is why mapping a file used to take an afternoon. */}
        <div className="mapping-grid">{preview.headers.map((header) => <label key={header}><span title={header}>{header}</span><Combobox name={`map-${header}`} label={t('mapColumn', { header })} value={mapping[header] ?? ''} options={mappingOptions} placeholder={t('targets.skip')} onChange={(value) => { setMapping((current) => ({ ...current, [header]: value })); setPreviewCurrent(false) }} /></label>)}</div>
        <div className="mapping-actions"><Button variant="secondary" onClick={() => void remap()}>{t('applyMapping')}</Button></div>
        {!previewCurrent && <InlineNotice tone="warning" title={t('revalidateTitle')}>{t('revalidateBody')}</InlineNotice>}
      </>}
    </Section>}
    {preview && !busy && <>
      {preview.issues.length > 0 && <Section title={t('issues.title')} description={t('issues.description')}><div className="issue-list">{preview.issues.slice(0, 100).map((issue, index) => <div key={`${issue.row}-${issue.field}-${index}`}><StatusPill label={issue.severity} tone={issue.severity === 'error' ? 'red' : 'orange'} /><strong>{t('issues.row', { row: issue.row, field: issue.field || t('issues.record') })}</strong><span>{issue.message}</span></div>)}</div>{preview.issues.length > 100 && <p className="muted">{t('issues.truncated', { count: preview.issues.length })}</p>}</Section>}
      <Section title={t('previewTitle')} description={t('previewDescription', { count: Math.min(preview.rows.length, 25) })}><DataTable rows={preview.rows.slice(0, 25)} columns={rowColumns} keyFor={(_, index) => index} /></Section>
      <div className="commit-bar"><div><strong>{previewCurrent ? t('commit.ready') : t('commit.revalidate')}</strong><span>{!previewCurrent ? t('commit.locked') : preview.errorCount ? t('commit.blocking', { count: preview.errorCount }) : t('commit.willWrite', { count: preview.validCount + preview.draftCount })}</span></div><Button disabled={busy || !previewCurrent || preview.errorCount > 0} onClick={() => void commit()}><Upload size={17} /> {t('commit.action')}</Button></div>
    </>}
    <Section title={t('history.title')} description={t('history.description')} actions={<History size={19} />}>
      {history.length ? <div className="history-list">{history.map((entry, index) => { const status = String(entry.status ?? 'ok'); const timestamp = String(entry.imported_at ?? entry.created_at ?? entry.timestamp ?? ''); return <div key={`${timestamp}-${index}`}><StatusPill label={status} tone={status === 'ok' || status === 'completed' ? 'green' : status === 'error' || status === 'failed' ? 'red' : 'orange'} /><span><strong>{String(entry.source_name ?? entry.filename ?? entry.summary ?? t('history.batch'))}</strong><small>{String(entry.details ?? entry.message ?? t('history.counts', { imported: entry.imported_count ?? 0, drafts: entry.draft_count ?? 0 }))}</small></span><time>{timestamp ? format.dateTime(timestamp) : '—'}</time></div> })}</div> : <EmptyState title={t('history.emptyTitle')} message={t('history.emptyMessage')} />}
    </Section>
    <HelpDrawer open={help} title={t('title')} onClose={() => setHelp(false)}><p>{t('help.pipeline')}</p><h3>{t('help.atomicityTitle')}</h3><p>{t('help.atomicityBody')}</p><h3>{t('help.astTitle')}</h3><p>{t('help.astBody')}</p></HelpDrawer>
  </>
}
