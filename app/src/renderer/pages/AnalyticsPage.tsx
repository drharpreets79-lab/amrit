/* Analysis reloads are explicitly scoped to the active laboratory and Run action. */
/* eslint-disable react-hooks/exhaustive-deps */
import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { BarChart3, CalendarRange, RefreshCw, ShieldCheck, TestTube2 } from 'lucide-react'
import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useTranslation } from 'react-i18next'

import type { AnalysisFilters, AnalysisMode, AnalysisResult, Laboratory, Row } from '../../shared/types'
import { useFormat } from '../i18n/provider'
import { DataTable, type TableColumn } from '../components/DataTable'
import { Button, CustomSelect, EmptyState, ErrorState, FieldGrid, HelpDrawer, InlineNotice, Input, LoadingState, PageHeader, PromptModal, Section, Select, StatusPill, formatError } from '../components/ui'

const COLORS = ['#23376D', '#1B75BC', '#F15A29', '#2E7D63', '#8D6E63', '#7B61A8']
const valueOf = (row: Row, keys: string[]): string => { for (const key of keys) { const value = row[key]; if (typeof value === 'string' || typeof value === 'number') return String(value) } return '' }
const defaultStart = (): string => { const date = new Date(); date.setFullYear(date.getFullYear() - 1); return date.toISOString().slice(0, 10) }

/** Wire values; each has `modes.<value>` and `modes.<value>Help` in the catalogue. */
const MODES: AnalysisMode[] = [
  'ris', 'stewardship', 'unitAntibiogram', 'specimenAntibiogram', 'priorityIndicators',
  'dataQuality', 'trends', 'isolateListing', 'summary', 'clusterWatch'
]

export function AnalyticsPage({ currentLab }: { currentLab: Laboratory | null }): React.JSX.Element {
  const { t } = useTranslation('analytics')
  const format = useFormat()
  const [filters, setFilters] = useState<AnalysisFilters>({
    labCode: currentLab?.code ?? '', mode: 'ris', periodStart: defaultStart(), periodEnd: new Date().toISOString().slice(0, 10),
    outbreakAnalysisType: 'prospective', outbreakTarget: 'both', outbreakBaselineDays: 365,
    outbreakMaxClusterDays: 60, outbreakDeduplicationDays: 30, outbreakMinimumCases: 3,
    outbreakPermutations: 999, outbreakRecurrenceThresholdDays: 365
  })
  const [result, setResult] = useState<AnalysisResult | null>(null)
  const [organisms, setOrganisms] = useState<Row[]>([])
  const [samples, setSamples] = useState<Row[]>([])
  const [antibiotics, setAntibiotics] = useState<Row[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [help, setHelp] = useState(false)
  const [macros, setMacros] = useState<Row[]>([])
  const [macroId, setMacroId] = useState('')
  const [namingMacro, setNamingMacro] = useState(false)
  const [masterWarning, setMasterWarning] = useState('')
  useEffect(() => {
    setFilters((current) => ({ ...current, labCode: currentLab?.code ?? '' }))
    if (!currentLab) return
    void Promise.all([window.amrit.masters.list('organisms', { limit: 10000 }), window.amrit.masters.list('samples', { limit: 10000 }), window.amrit.masters.list('antibiotics', { limit: 10000 }), window.amrit.analysis.macros(currentLab.code)]).then(([org, specimen, antibiotic, macroItems]) => { setOrganisms(org); setSamples(specimen); setAntibiotics(antibiotic); setMacros(macroItems); setMasterWarning([org.length >= 10000 ? t('masterNames.organisms') : '', specimen.length >= 10000 ? t('masterNames.specimens') : '', antibiotic.length >= 10000 ? t('masterNames.antibiotics') : ''].filter(Boolean).join(', ')) }).catch(() => undefined)
  }, [currentLab?.code])
  const run = async (): Promise<void> => {
    if (!currentLab) return
    setLoading(true); setError('')
    try { setResult(await window.amrit.analysis.run({ ...filters, labCode: currentLab.code })) } catch (caught) { setError(formatError(caught)) } finally { setLoading(false) }
  }
  useEffect(() => { if (currentLab) void run() }, [currentLab?.code])
  const update = (key: keyof AnalysisFilters, value: string): void => setFilters((current) => ({ ...current, [key]: value || undefined }))
  const updateNumber = (key: keyof AnalysisFilters, value: string): void => {
    const parsed = Number(value)
    setFilters((current) => ({ ...current, [key]: Number.isFinite(parsed) ? Math.trunc(parsed) : undefined }))
  }
  const applyMacro = (id: string): void => {
    setMacroId(id)
    const macro = macros.find((item) => String(item.id) === id)
    if (!macro) return
    const raw = macro.config ?? macro.config_json ?? macro.filters ?? macro.filter_json
    try { const parsed = typeof raw === 'string' ? JSON.parse(raw) as Partial<AnalysisFilters> : raw as Partial<AnalysisFilters>; setFilters((current) => ({ ...current, ...parsed, labCode: current.labCode })) } catch { /* Keep a malformed legacy macro visible without applying it. */ }
  }
  const saveMacro = async (name: string): Promise<void> => {
    if (!currentLab) return
    setNamingMacro(false); setError('')
    try {
      const saved = await window.amrit.analysis.saveMacro(currentLab.code, { name, macro_name: name, config: JSON.stringify(filters) })
      setMacros(await window.amrit.analysis.macros(currentLab.code)); setMacroId(String(saved.id ?? ''))
    } catch (caught) { setError(formatError(caught)) }
  }
  const deleteMacro = async (): Promise<void> => {
    const macro = macros.find((item) => String(item.id) === macroId); const id = Number(macro?.id)
    if (!id || !window.confirm(t('macro.confirmDelete', { name: String(macro?.name ?? macro?.macro_name ?? '') }))) return
    await window.amrit.analysis.deleteMacro(id); setMacroId(''); if (currentLab) setMacros(await window.amrit.analysis.macros(currentLab.code))
  }
  const organismOptions = useMemo(() => organisms.map((row) => ({ value: valueOf(row, ['organism_code', 'code']), label: valueOf(row, ['organism_name', 'name']) })).filter((item) => item.value), [organisms])
  const sampleOptions = useMemo(() => samples.map((row) => ({ value: valueOf(row, ['specimen_code', 'sample_code', 'code']), label: valueOf(row, ['specimen_name', 'sample_name', 'name']) })).filter((item) => item.value), [samples])
  const antibioticOptions = useMemo(() => antibiotics.map((row) => ({ value: valueOf(row, ['antibiotic_code', 'code']), label: valueOf(row, ['antibiotic_name', 'name']) })).filter((item) => item.value), [antibiotics])
  const antibioticColumns: Array<TableColumn<AnalysisResult['byAntibiotic'][number]>> = [
    { key: 'code', label: t('byAntibiotic.antibiotic'), render: (row) => <strong className="code-label">{row.code}</strong> },
    { key: 'tested', label: t('byAntibiotic.tested') }, { key: 'resistant', label: t('byAntibiotic.resistant') },
    { key: 'percent', label: t('byAntibiotic.resistance'), render: (row) => <div className="resistance-cell"><div><i style={{ width: `${Math.min(row.percent, 100)}%` }} /></div><strong>{format.percent(row.percent)}%</strong></div> }
  ]
  if (!currentLab) return <><PageHeader eyebrow={t('eyebrow')} title={t('title')} purpose={t('purpose')} onHelp={() => setHelp(true)} /><EmptyState title={t('noLabTitle')} message={t('noLabMessage')} /><HelpDrawer open={help} title={t('title')} onClose={() => setHelp(false)}><p>{t('noLabHelp')}</p></HelpDrawer></>
  return <>
    <PageHeader eyebrow={t('eyebrow')} title={t('title')} purpose={t('purpose')} actions={<Button onClick={() => void run()} disabled={loading}><RefreshCw size={17} className={loading ? 'spin' : ''} /> {t('run')}</Button>} onHelp={() => setHelp(true)} />
    {masterWarning && <InlineNotice tone="warning" title={t('capTitle')}>{t('capBody', { names: masterWarning })}</InlineNotice>}
    <Section title={t('cohortTitle')} description={t('cohortDescription')}>
      <div className="analysis-mode-bar"><Select label={t('modeLabel')} value={filters.mode ?? 'ris'} onChange={(event) => update('mode', event.target.value)}>{MODES.map((mode) => <option key={mode} value={mode}>{t(`modes.${mode}`)}</option>)}</Select><div><strong>{t(`modes.${filters.mode ?? 'ris'}`)}</strong><span>{t(`modes.${filters.mode ?? 'ris'}Help`)}</span></div></div>
      <div className="macro-bar"><Select label={t('macro.label')} value={macroId} onChange={(event) => applyMacro(event.target.value)}><option value="">{t('macro.none')}</option>{macros.map((macro, index) => <option key={String(macro.id ?? index)} value={String(macro.id ?? '')}>{String(macro.name ?? macro.macro_name ?? t('macro.fallbackName', { index: index + 1 }))}</option>)}</Select><Button variant="secondary" onClick={() => setNamingMacro(true)}>{t('macro.saveCurrent')}</Button><Button variant="ghost" disabled={!macroId} onClick={() => void deleteMacro()}>{t('macro.delete')}</Button></div>
    <PromptModal open={namingMacro} title={t('macro.modalTitle')} description={t('macro.modalDescription')} label={t('macro.nameLabel')} placeholder={t('macro.namePlaceholder')} onCancel={() => setNamingMacro(false)} onConfirm={(name) => void saveMacro(name)} />
      <FieldGrid columns={4}><Input label={t('filters.periodStart')} type="date" value={filters.periodStart ?? ''} onChange={(event) => update('periodStart', event.target.value)} /><Input label={t('filters.periodEnd')} type="date" value={filters.periodEnd ?? ''} onChange={(event) => update('periodEnd', event.target.value)} /><CustomSelect label={t('filters.organism')} name="analysis-organism" value={filters.organism ?? ''} onChange={(value) => update('organism', value)} options={organismOptions} placeholder={t('filters.allOrganisms')} /><CustomSelect label={t('filters.specimen')} name="analysis-specimen" value={filters.specimenType ?? ''} onChange={(value) => update('specimenType', value)} options={sampleOptions} placeholder={t('filters.allSpecimens')} /></FieldGrid>
      <FieldGrid columns={2}><CustomSelect label={t('filters.antibiotic')} name="analysis-antibiotic" value={filters.antibioticCode ?? ''} onChange={(value) => update('antibioticCode', value)} options={antibioticOptions} placeholder={t('filters.allAntibiotics')} /><CustomSelect label={t('filters.locationType')} name="analysis-location" value={filters.locationType ?? ''} onChange={(value) => update('locationType', value)} options={[{ value: 'IN', label: t('filters.inpatient') }, { value: 'OUT', label: t('filters.outpatient') }, { value: 'ICU', label: t('filters.icu') }, { value: 'ER', label: t('filters.emergency') }]} placeholder={t('filters.allLocations')} /></FieldGrid>
      {filters.mode === 'clusterWatch' && <div className="outbreak-settings">
        <InlineNotice tone="warning" title={t('outbreak.reviewGateTitle')}>{t('outbreak.reviewGateBody')}</InlineNotice>
        <FieldGrid columns={4}>
          <Select label={t('outbreak.analysisType')} value={filters.outbreakAnalysisType ?? 'prospective'} onChange={(event) => update('outbreakAnalysisType', event.target.value)}><option value="prospective">{t('outbreak.prospective')}</option><option value="retrospective">{t('outbreak.retrospective')}</option></Select>
          <Select label={t('outbreak.target')} value={filters.outbreakTarget ?? 'both'} onChange={(event) => update('outbreakTarget', event.target.value)}><option value="both">{t('outbreak.both')}</option><option value="organism">{t('outbreak.organism')}</option><option value="resistance">{t('outbreak.resistance')}</option></Select>
          <Input label={t('outbreak.baselineDays')} type="number" min="30" max="3650" value={filters.outbreakBaselineDays ?? 365} onChange={(event) => updateNumber('outbreakBaselineDays', event.target.value)} />
          <Input label={t('outbreak.maxClusterDays')} type="number" min="1" max="365" value={filters.outbreakMaxClusterDays ?? 60} onChange={(event) => updateNumber('outbreakMaxClusterDays', event.target.value)} />
        </FieldGrid>
        <FieldGrid columns={4}>
          <Input label={t('outbreak.deduplicationDays')} type="number" min="0" max="365" value={filters.outbreakDeduplicationDays ?? 30} onChange={(event) => updateNumber('outbreakDeduplicationDays', event.target.value)} />
          <Input label={t('outbreak.minimumCases')} type="number" min="2" max="100" value={filters.outbreakMinimumCases ?? 3} onChange={(event) => updateNumber('outbreakMinimumCases', event.target.value)} />
          <Select label={t('outbreak.permutations')} value={String(filters.outbreakPermutations ?? 999)} onChange={(event) => updateNumber('outbreakPermutations', event.target.value)}><option value="99">{t('outbreak.permutationExploratory')}</option><option value="999">{t('outbreak.permutationStandard')}</option><option value="9999">{t('outbreak.permutationHighPrecision')}</option></Select>
          <Input label={t('outbreak.recurrenceThreshold')} type="number" min="20" max="100000" value={filters.outbreakRecurrenceThresholdDays ?? 365} onChange={(event) => updateNumber('outbreakRecurrenceThresholdDays', event.target.value)} />
        </FieldGrid>
        <p className="field-hint">{t('outbreak.methodHint')}</p>
      </div>}
    </Section>
    {loading ? <LoadingState label={t('calculating')} /> : error ? <ErrorState message={error} onRetry={() => void run()} /> : !result || result.total === 0 ? <EmptyState title={t('emptyTitle')} message={t('emptyMessage')} /> : <>
      <div className="stat-grid analytics-stats"><article className="metric-card"><CalendarRange size={20} /><span><small>{t('stats.cohort')}</small><strong>{format.number(result.total)}</strong></span></article><article className="metric-card metric-card--red"><ShieldCheck size={20} /><span><small>{t('stats.resistant')}</small><strong>{format.number(result.resistant)}</strong></span></article><article className="metric-card metric-card--orange"><TestTube2 size={20} /><span><small>{t('stats.intermediate')}</small><strong>{format.number(result.intermediate)}</strong></span></article><article className="metric-card metric-card--blue"><BarChart3 size={20} /><span><small>{t('stats.resistance')}</small><strong>{format.percent(result.resistancePercent)}%</strong></span></article></div>
      <div className="analytics-grid">
        <Section title={t('charts.interpretationTitle')} description={t('charts.interpretationDescription')}><div className="chart chart--pie"><ResponsiveContainer width="100%" height={280}><PieChart><Pie data={[{ label: t('charts.resistant'), value: result.resistant }, { label: t('charts.intermediate'), value: result.intermediate }, { label: t('charts.susceptible'), value: result.susceptible }]} dataKey="value" nameKey="label" innerRadius={68} outerRadius={100} paddingAngle={2}>{COLORS.slice(2, 5).map((color) => <Cell key={color} fill={color} />)}</Pie><Tooltip /><Legend /></PieChart></ResponsiveContainer><div className="chart-centre"><strong>{format.percent(result.resistancePercent)}%</strong><span>{t('charts.resistantCaption')}</span></div></div></Section>
        <Section title={t('charts.monthlyTitle')} description={t('charts.monthlyDescription')}><div className="chart"><ResponsiveContainer width="100%" height={280}><LineChart data={result.byMonth}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="label" tick={{ fontSize: 12 }} /><YAxis allowDecimals={false} tick={{ fontSize: 12 }} /><Tooltip /><Line type="monotone" dataKey="value" name={t('charts.isolates')} stroke="#1B75BC" strokeWidth={3} dot={{ fill: '#23376D', r: 3 }} /></LineChart></ResponsiveContainer></div></Section>
        <Section title={t('charts.organismsTitle')} description={t('charts.organismsDescription')}><div className="chart"><ResponsiveContainer width="100%" height={300}><BarChart data={result.byOrganism.slice(0, 10)} layout="vertical" margin={{ left: 24 }}><CartesianGrid strokeDasharray="3 3" horizontal={false} /><XAxis type="number" allowDecimals={false} /><YAxis type="category" dataKey="label" width={120} tick={{ fontSize: 11 }} /><Tooltip /><Bar dataKey="value" name={t('charts.isolates')} fill="#23376D" radius={[0, 4, 4, 0]} /></BarChart></ResponsiveContainer></div></Section>
        <Section title={t('charts.specimensTitle')} description={t('charts.specimensDescription')}><div className="chart"><ResponsiveContainer width="100%" height={300}><BarChart data={result.bySpecimen.slice(0, 10)}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="label" tick={{ fontSize: 11 }} /><YAxis allowDecimals={false} /><Tooltip /><Bar dataKey="value" name={t('charts.isolates')} fill="#1B75BC" radius={[4, 4, 0, 0]} /></BarChart></ResponsiveContainer></div></Section>
      </div>
      <Section title={t('byAntibiotic.title')} description={t('byAntibiotic.description')}><DataTable rows={result.byAntibiotic} columns={antibioticColumns} keyFor={(row) => row.code} emptyTitle={t('byAntibiotic.emptyTitle')} emptyMessage={t('byAntibiotic.emptyMessage')} /></Section>
      <Section title={t('quality.title')} description={t('quality.description')}><div className="quality-grid">{result.dataQuality.map((item) => <div key={item.label}><span>{item.label}</span><StatusPill label={String(item.value)} tone={item.value ? 'orange' : 'green'} /></div>)}</div></Section>
      {result.summaryLines?.length ? <Section title={result.title || t('summaryTitle')} description={t('summaryDescription')}><ul className="summary-lines">{result.summaryLines.map((line, index) => <li key={index}>{line}</li>)}</ul></Section> : null}
      {result.rows?.length && filters.mode !== 'clusterWatch' ? <Section title={t('detailTitle', { mode: filters.mode ? t(`modes.${filters.mode}`) : t('analysis') })} description={t('detailDescription')}><DataTable rows={result.rows} columns={(result.columns ?? Object.keys(result.rows[0] ?? {})).map((key) => ({ key, label: key.replace(/_/g, ' ').replace(/^./, (letter) => letter.toUpperCase()) }))} keyFor={(_, index) => index} /></Section> : null}
      {filters.mode === 'clusterWatch' && result.outbreak?.warnings.map((warning) => <InlineNotice key={warning} tone="warning" title={t('outbreak.dataWarning')}>{warning}</InlineNotice>)}
      {result.clusterFlags?.length ? <Section title={t('clusterTitle')} description={t('clusterDescription')}><DataTable rows={result.clusterFlags} columns={(result.columns ?? Object.keys(result.clusterFlags[0] ?? {})).map((key) => ({ key, label: key.replace(/_/g, ' ') }))} keyFor={(row, index) => String(row.signal_id ?? index)} /></Section> : null}
    </>}
    <HelpDrawer open={help} title={t('title')} onClose={() => setHelp(false)}><p>{t('help.descriptive')}</p><h3>{t('help.inclusionTitle')}</h3><p>{t('help.inclusionBody')}</p></HelpDrawer>
  </>
}
