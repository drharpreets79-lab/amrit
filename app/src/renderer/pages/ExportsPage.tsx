import type React from 'react'
import { useState } from 'react'
import { Braces, CheckCircle2, Download, FileJson2, FileSpreadsheet, Network, ScrollText } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { AnalysisFilters, Laboratory } from '../../shared/types'
import { useToast } from '../components/Toast'
import { Button, EmptyState, FieldGrid, HelpDrawer, InlineNotice, Input, PageHeader, Section, formatError } from '../components/ui'

/** Title and description come from the catalogue; the id, extension and icon do not translate. */
const formats = [
  { id: 'whonet' as const, extension: 'csv', icon: FileSpreadsheet },
  { id: 'fhir' as const, extension: 'json', icon: Braces },
  { id: 'hl7' as const, extension: 'hl7', icon: Network },
  { id: 'measure' as const, extension: 'json', icon: FileJson2 },
  { id: 'csv' as const, extension: 'csv', icon: FileSpreadsheet },
  { id: 'json' as const, extension: 'json', icon: ScrollText }
]

export function ExportsPage({ currentLab }: { currentLab: Laboratory | null }): React.JSX.Element {
  const { t } = useTranslation('exports')
  const { notify } = useToast()
  const [filters, setFilters] = useState<AnalysisFilters>({ labCode: currentLab?.code ?? '', periodStart: '', periodEnd: '' })
  const [busy, setBusy] = useState<string | null>(null)
  const [lastPath, setLastPath] = useState('')
  const [help, setHelp] = useState(false)
  const save = async (format: typeof formats[number]): Promise<void> => {
    if (!currentLab) return
    const title = t(`formats.${format.id}.title`)
    const path = await window.amrit.chooseSave({ defaultPath: `${currentLab.code}_${format.id}_export.${format.extension}`, filters: [{ name: title, extensions: [format.extension] }] })
    if (!path) return
    setBusy(format.id)
    try { const saved = await window.amrit.exports.save(format.id, { ...filters, labCode: currentLab.code }, path); setLastPath(saved); notify(t('saved', { format: title }), saved) }
    catch (caught) { notify(t('failed', { format: title }), formatError(caught), 'error') } finally { setBusy(null) }
  }
  if (!currentLab) return <><PageHeader eyebrow={t('eyebrow')} title={t('title')} purpose={t('purpose')} onHelp={() => setHelp(true)} /><EmptyState title={t('noLabTitle')} message={t('noLabMessage')} /><HelpDrawer open={help} title={t('title')} onClose={() => setHelp(false)}><p>{t('noLabHelp')}</p></HelpDrawer></>
  return <>
    <PageHeader eyebrow={t('eyebrow')} title={t('title')} purpose={t('purpose')} onHelp={() => setHelp(true)} />
    <Section title={t('cohortTitle')} description={t('cohortDescription')}><FieldGrid columns={2}><Input label={t('periodStart')} type="date" value={filters.periodStart ?? ''} onChange={(event) => setFilters((current) => ({ ...current, periodStart: event.target.value || undefined }))} /><Input label={t('periodEnd')} type="date" value={filters.periodEnd ?? ''} onChange={(event) => setFilters((current) => ({ ...current, periodEnd: event.target.value || undefined }))} /></FieldGrid></Section>
    <div className="export-grid">{formats.map((format) => { const Icon = format.icon; return <article className="export-card" key={format.id}><div className="export-card__icon"><Icon size={24} /></div><div><h2>{t(`formats.${format.id}.title`)}</h2><p>{t(`formats.${format.id}.description`)}</p><span>.{format.extension}</span></div><Button variant="secondary" disabled={busy !== null} onClick={() => void save(format)}><Download size={16} />{busy === format.id ? t('generating') : t('saveExport')}</Button></article> })}</div>
    {lastPath && <InlineNotice tone="success" title={t('lastSaved')}><span className="path-text">{lastPath}</span></InlineNotice>}
    <Section title={t('safeguards.title')} description={t('safeguards.description')}><div className="safeguard-grid"><div><CheckCircle2 size={19} /><span><strong>{t('safeguards.codedTitle')}</strong><small>{t('safeguards.codedBody')}</small></span></div><div><CheckCircle2 size={19} /><span><strong>{t('safeguards.astTitle')}</strong><small>{t('safeguards.astBody')}</small></span></div><div><CheckCircle2 size={19} /><span><strong>{t('safeguards.cohortTitle')}</strong><small>{t('safeguards.cohortBody')}</small></span></div></div></Section>
    <HelpDrawer open={help} title={t('title')} onClose={() => setHelp(false)}><p>{t('help.formats')}</p><p>{t('help.aggregate')}</p></HelpDrawer>
  </>
}
