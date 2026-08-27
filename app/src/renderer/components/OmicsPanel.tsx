/* Attachment reloads are keyed to the isolate identity, not to every field edit. */
/* eslint-disable react-hooks/exhaustive-deps */
import type React from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dna, FolderOpen, Paperclip, Trash2 } from 'lucide-react'
import { OMICS_TYPE_OPTIONS, type OmicsRecord } from '../../shared/types'
import { Button, CustomSelect, FieldGrid, InlineNotice, Input, StatusPill, Textarea, formatError } from './ui'

const SEQUENCING_FILTERS = [{ name: 'Omics and sequencing data', extensions: ['fastq', 'fq', 'gz', 'fasta', 'fa', 'fna', 'bam', 'cram', 'sam', 'vcf', 'gff', 'gbk', 'embl', 'mzml', 'mzxml', 'json', 'csv', 'tsv', 'txt', 'zip'] }]

const readableSize = (bytes: number): string => {
  if (!bytes) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

const blank = (isolateId: number): OmicsRecord => ({ isolate_id: isolateId, omics_type: 'wgs' })

/**
 * Omics artefacts for one isolate. The database stores provenance only — size, digest and either
 * a managed copy or a link — so a multi-gigabyte run never lands inside the SQLite file.
 */
export function OmicsPanel({ isolateId, onNotify }: { isolateId?: number; onNotify: (title: string, message: string, tone?: 'error') => void }): React.JSX.Element {
  const { t } = useTranslation('records')
  const [entries, setEntries] = useState<OmicsRecord[]>([])
  const [draft, setDraft] = useState<OmicsRecord | null>(null)
  const [busy, setBusy] = useState(false)
  const load = async (): Promise<void> => {
    if (!isolateId) { setEntries([]); return }
    try { setEntries(await window.amrit.omics.list(isolateId)) } catch (caught) { onNotify('Could not load omics records', formatError(caught), 'error') }
  }
  useEffect(() => { void load() }, [isolateId])

  if (!isolateId) {
    return <InlineNotice tone="info" title={t('omics.saveFirstTitle')}>
      {t('omics.saveFirstBody')}
    </InlineNotice>
  }

  const update = (key: keyof OmicsRecord, value: unknown): void => setDraft((current) => current ? { ...current, [key]: value } as OmicsRecord : current)
  const chooseFile = async (): Promise<void> => {
    const path = await window.amrit.chooseFile({ filters: SEQUENCING_FILTERS })
    if (!path) return
    setBusy(true)
    try {
      const facts = await window.amrit.omics.attach(isolateId, path)
      setDraft((current) => ({ ...(current ?? blank(isolateId)), ...facts }))
    } catch (caught) { onNotify('Could not read the selected file', formatError(caught), 'error') } finally { setBusy(false) }
  }
  const save = async (): Promise<void> => {
    if (!draft) return
    setBusy(true)
    try {
      await window.amrit.omics.save({ ...draft, isolate_id: isolateId })
      onNotify('Omics record saved', draft.file_name || draft.accession || draft.omics_type)
      setDraft(null); await load()
    } catch (caught) { onNotify('Could not save the omics record', formatError(caught), 'error') } finally { setBusy(false) }
  }
  const remove = async (entry: OmicsRecord): Promise<void> => {
    if (!entry.id) return
    const managed = entry.storage_mode === 'copied'
    if (!window.confirm(`Remove ${entry.file_name || entry.accession || 'this omics record'}?${managed ? ' The managed copy inside the AMRIT workspace is deleted; the original file is untouched.' : ' The linked file itself is not deleted.'}`)) return
    try { await window.amrit.omics.delete(entry.id); onNotify('Omics record removed', entry.file_name ?? ''); await load() }
    catch (caught) { onNotify('Could not remove the omics record', formatError(caught), 'error') }
  }

  return <div className="omics-panel">
    {entries.length === 0
      ? <p className="omics-panel__empty">{t('omics.empty')}</p>
      : <ul className="omics-panel__list">{entries.map((entry) => (
        <li key={entry.id}>
          <div className="omics-panel__head">
            <Dna size={17} />
            <div>
              <strong>{OMICS_TYPE_OPTIONS.find((option) => option.value === entry.omics_type)?.label ?? entry.omics_type}</strong>
              <small>{entry.file_name || entry.accession || 'Reference only'}{entry.platform ? ` · ${entry.platform}` : ''}</small>
            </div>
            <StatusPill label={entry.storage_mode === 'copied' ? 'Copied into workspace' : 'Linked in place'} tone={entry.storage_mode === 'copied' ? 'green' : 'blue'} />
            <div className="row-actions">
              {(entry.stored_path || entry.source_path) && <Button variant="ghost" onClick={() => void window.amrit.omics.reveal(entry.id!).catch((caught) => onNotify('Could not reveal the file', formatError(caught), 'error'))}><FolderOpen size={15} /> {t('omics.showFile')}</Button>}
              <Button variant="ghost" className="danger-text" onClick={() => void remove(entry)}><Trash2 size={15} /><span className="sr-only">{t('omics.remove')}</span></Button>
            </div>
          </div>
          <dl className="omics-panel__facts">
            {entry.file_size ? <div><dt>{t('omics.size')}</dt><dd>{readableSize(entry.file_size)}</dd></div> : null}
            {entry.file_format ? <div><dt>{t('omics.format')}</dt><dd>{entry.file_format}</dd></div> : null}
            {entry.sha256 ? <div><dt>{t('omics.sha256')}</dt><dd className="path-text">{entry.sha256.slice(0, 16)}…</dd></div> : null}
            {entry.accession ? <div><dt>{t('omics.accession')}</dt><dd>{entry.accession}{entry.repository ? ` (${entry.repository})` : ''}</dd></div> : null}
            {entry.analysis_tool ? <div><dt>{t('omics.analysis')}</dt><dd>{entry.analysis_tool}{entry.tool_version ? ` ${entry.tool_version}` : ''}{entry.database_version ? ` · db ${entry.database_version}` : ''}</dd></div> : null}
            {entry.quality_metrics ? <div><dt>{t('omics.quality')}</dt><dd>{entry.quality_metrics}</dd></div> : null}
            {entry.result_summary ? <div><dt>{t('omics.result')}</dt><dd>{entry.result_summary}</dd></div> : null}
          </dl>
        </li>
      ))}</ul>}

    {draft
      ? <div className="omics-panel__form">
        <FieldGrid columns={3}>
          <CustomSelect label="Omics type" name="omics-type" value={draft.omics_type} onChange={(value) => update('omics_type', value)} options={OMICS_TYPE_OPTIONS} required />
          <Input label="Platform / instrument" name="omics-platform" value={draft.platform ?? ''} placeholder="Illumina NextSeq 550, ONT MinION, Bruker Biotyper…" onChange={(event) => update('platform', event.target.value)} />
          <Input label="Repository accession" name="omics-accession" value={draft.accession ?? ''} placeholder="SRR…, ERR…, SAMN…" onChange={(event) => update('accession', event.target.value)} />
        </FieldGrid>
        <FieldGrid columns={3}>
          <Input label="Repository" name="omics-repository" value={draft.repository ?? ''} placeholder="NCBI SRA, ENA, local archive" onChange={(event) => update('repository', event.target.value)} />
          <Input label="Analysis tool" name="omics-tool" value={draft.analysis_tool ?? ''} placeholder="AMRFinderPlus, ResFinder, TB-Profiler…" onChange={(event) => update('analysis_tool', event.target.value)} />
          <Input label="Tool / database version" name="omics-tool-version" value={draft.tool_version ?? ''} onChange={(event) => update('tool_version', event.target.value)} />
        </FieldGrid>
        <FieldGrid columns={2}>
          <Input label="Quality metrics" name="omics-quality" value={draft.quality_metrics ?? ''} placeholder="Coverage 62×, N50 210 kb, 43 contigs" onChange={(event) => update('quality_metrics', event.target.value)} />
          <Input label="Result summary" name="omics-result" value={draft.result_summary ?? ''} placeholder="blaNDM-5, blaCTX-M-15; ST147" onChange={(event) => update('result_summary', event.target.value)} />
        </FieldGrid>
        {draft.file_name && <InlineNotice tone={draft.storage_mode === 'copied' ? 'success' : 'info'} title={draft.storage_mode === 'copied' ? t('omics.copiedTitle') : t('omics.linkedTitle')}>
          {t('omics.fileSummary', { name: draft.file_name, size: readableSize(draft.file_size ?? 0), digest: String(draft.sha256 ?? '').slice(0, 16) })}
          {draft.storage_mode === 'linked' && t('omics.linkedNote')}
        </InlineNotice>}
        <Textarea label="Notes" name="omics-notes" rows={2} value={draft.notes ?? ''} onChange={(event) => update('notes', event.target.value)} />
        <div className="omics-panel__actions">
          <Button variant="secondary" disabled={busy} onClick={() => void chooseFile()}><Paperclip size={15} /> {draft.file_name ? t('omics.chooseDifferent') : t('omics.attachFile')}</Button>
          <Button variant="ghost" disabled={busy} onClick={() => setDraft(null)}>{t('omics.cancel')}</Button>
          <Button disabled={busy || !draft.omics_type} onClick={() => void save()}>{busy ? t('omics.working') : t('omics.save')}</Button>
        </div>
      </div>
      : <div className="omics-panel__actions">
        <Button variant="secondary" onClick={() => setDraft(blank(isolateId))}><Dna size={16} /> {t('omics.add')}</Button>
        <Button variant="ghost" disabled={busy} onClick={() => { setDraft(blank(isolateId)); void chooseFile() }}><Paperclip size={16} /> {t('omics.attachFile')}</Button>
      </div>}
  </div>
}
