/* Recent activity reloads only when the active laboratory changes or the user refreshes. */
/* eslint-disable react-hooks/exhaustive-deps */
import type React from 'react'
import { useEffect, useState } from 'react'
import { Activity, ArrowRight, Building2, ClipboardCheck, Database, FileInput, ShieldCheck, TestTubes } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { AppBootstrap, AuditEntry, IsolateRecord } from '../../shared/types'
import { useFormat } from '../i18n/provider'
import type { RouteKey } from '../components/Shell'
import { Button, EmptyState, ErrorState, HelpDrawer, LoadingState, PageHeader, Section, StatusPill, formatError } from '../components/ui'

function StatCard({ label, value, detail, icon: Icon, tone = 'blue' }: { label: string; value: number; detail: string; icon: typeof Activity; tone?: 'blue' | 'orange' | 'navy' | 'green' }): React.JSX.Element {
  const format = useFormat()
  return <article className={`stat-card stat-card--${tone}`}><div className="stat-card__icon"><Icon size={22} /></div><div><span>{label}</span><strong>{format.number(value)}</strong><small>{detail}</small></div></article>
}

export function DashboardPage({ bootstrap, onRoute, onRefresh }: { bootstrap: AppBootstrap; onRoute: (route: RouteKey) => void; onRefresh: () => Promise<void> }): React.JSX.Element {
  const { t } = useTranslation('dashboard')
  const format = useFormat()
  const [records, setRecords] = useState<IsolateRecord[]>([])
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [help, setHelp] = useState(false)
  const load = async (): Promise<void> => {
    setLoading(true); setError('')
    try {
      const [recentRecords, recentAudit] = await Promise.all([
        window.amrit.records.list(bootstrap.currentLab ? { labCode: bootstrap.currentLab.code, limit: 6 } : { limit: 6 }),
        window.amrit.audit.list(6)
      ])
      setRecords(recentRecords); setAudit(recentAudit)
    } catch (caught) { setError(formatError(caught)) } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [bootstrap.currentLab?.code])
  const counts = bootstrap.counts
  return <>
    <PageHeader eyebrow={t('eyebrow')} title={t('title')} purpose={t('purpose')} onHelp={() => setHelp(true)} actions={<Button variant="secondary" onClick={() => void Promise.all([load(), onRefresh()])}>{t('refresh')}</Button>} />
    {!bootstrap.currentLab && <Section><div className="onboarding-banner"><div><span className="eyebrow">{t('onboarding.eyebrow')}</span><h2>{t('onboarding.title')}</h2><p>{t('onboarding.body')}</p></div><Button onClick={() => onRoute('laboratories')}>{t('onboarding.action')} <ArrowRight size={17} /></Button></div></Section>}
    <div className="stat-grid">
      <StatCard label={t('stats.isolates')} value={counts.isolateCount} detail={t('stats.isolatesDetail', { final: format.number(counts.finalCount), draft: format.number(counts.draftCount) })} icon={ClipboardCheck} tone="navy" />
      <StatCard label={t('stats.antibiotics')} value={counts.antibioticCount} detail={t('stats.antibioticsDetail')} icon={TestTubes} />
      <StatCard label={t('stats.organisms')} value={counts.organismCount} detail={t('stats.organismsDetail')} icon={Activity} tone="orange" />
      <StatCard label={t('stats.breakpoints')} value={counts.breakpointCount} detail={t('stats.breakpointsDetail')} icon={ShieldCheck} tone="green" />
    </div>
    <div className="dashboard-grid">
      <Section title={t('workflow.title')} description={t('workflow.description')}>
        <div className="workflow-list">
          <button onClick={() => onRoute('records')}><span className="workflow-list__icon workflow-list__icon--orange"><ClipboardCheck size={20} /></span><span><strong>{t('workflow.drafts', { count: counts.draftCount })}</strong><small>{t('workflow.draftsDetail')}</small></span><ArrowRight size={18} /></button>
          <button onClick={() => onRoute('imports')}><span className="workflow-list__icon"><FileInput size={20} /></span><span><strong>{t('workflow.import')}</strong><small>{t('workflow.importDetail')}</small></span><ArrowRight size={18} /></button>
          <button onClick={() => onRoute('masters')}><span className="workflow-list__icon workflow-list__icon--navy"><Database size={20} /></span><span><strong>{t('workflow.panels', { count: counts.panelCount })}</strong><small>{t('workflow.panelsDetail')}</small></span><ArrowRight size={18} /></button>
          <button onClick={() => onRoute('laboratories')}><span className="workflow-list__icon workflow-list__icon--green"><Building2 size={20} /></span><span><strong>{t('workflow.laboratories', { count: counts.laboratoryCount })}</strong><small>{t('workflow.laboratoriesDetail')}</small></span><ArrowRight size={18} /></button>
        </div>
      </Section>
      <Section title={t('readiness.title')} description={t('readiness.description')}>
        <div className="readiness-list">
          <div><span><i className="readiness-dot readiness-dot--ok" />{t('readiness.database')}</span><StatusPill label={t('readiness.ready')} tone="green" /></div>
          <div><span><i className={`readiness-dot ${bootstrap.currentLab ? 'readiness-dot--ok' : 'readiness-dot--warn'}`} />{t('readiness.labContext')}</span><StatusPill label={bootstrap.currentLab ? t('readiness.selected') : t('readiness.required')} tone={bootstrap.currentLab ? 'green' : 'orange'} /></div>
          <div><span><i className={`readiness-dot ${bootstrap.syncStatus.tokenConfigured ? 'readiness-dot--ok' : 'readiness-dot--warn'}`} />{t('readiness.token')}</span><StatusPill label={bootstrap.syncStatus.tokenConfigured ? t('readiness.configured') : t('readiness.notConfigured')} tone={bootstrap.syncStatus.tokenConfigured ? 'green' : 'neutral'} /></div>
          <div><span><i className={`readiness-dot ${bootstrap.syncStatus.websocket === 'connected' ? 'readiness-dot--ok' : 'readiness-dot--idle'}`} />{t('readiness.websocket')}</span><StatusPill label={bootstrap.syncStatus.websocket} tone={bootstrap.syncStatus.websocket === 'connected' ? 'green' : 'neutral'} /></div>
        </div>
        <Button variant="secondary" className="full-width" onClick={() => onRoute('sync')}>{t('readiness.reviewSync')}</Button>
      </Section>
    </div>
    <div className="dashboard-grid dashboard-grid--equal">
      <Section title={t('activity.title')} description={t('activity.description')} actions={<Button variant="ghost" onClick={() => onRoute('records')}>{t('activity.viewAll')}</Button>}>
        {loading ? <LoadingState label={t('activity.loading')} /> : error ? <ErrorState message={error} onRetry={() => void load()} /> : records.length ? <div className="activity-list">{records.map((record, index) => <button key={record.id ?? index} onClick={() => onRoute('records')}><span className="activity-list__badge">{(record.organism_code || record.organism || '?').slice(0, 3).toUpperCase()}</span><span><strong>{record.organism || t('activity.organismPending')}</strong><small>{record.specimen_number || t('activity.noSpecimenNumber')} · {record.specimen_type || t('activity.specimenPending')}</small></span><StatusPill label={record.record_status || 'draft'} tone={record.record_status === 'final' ? 'green' : 'orange'} /></button>)}</div> : <EmptyState title={t('activity.emptyTitle')} message={t('activity.emptyMessage')} action={<Button onClick={() => onRoute('records')}>{t('activity.emptyAction')}</Button>} />}
      </Section>
      <Section title={t('audit.title')} description={t('audit.description')} actions={<Button variant="ghost" onClick={() => onRoute('audit')}>{t('audit.viewTrail')}</Button>}>
        {loading ? <LoadingState label={t('audit.loading')} /> : audit.length ? <div className="audit-mini-list">{audit.map((entry, index) => <div key={`${entry.timestamp}-${index}`}><i className={`audit-dot audit-dot--${entry.status}`} /><span><strong>{entry.operation}</strong><small>{entry.summary}</small></span><time>{format.dateTime(entry.timestamp)}</time></div>)}</div> : <EmptyState title={t('audit.emptyTitle')} message={t('audit.emptyMessage')} />}
      </Section>
    </div>
    <HelpDrawer open={help} title={t('help.title')} onClose={() => setHelp(false)}><p>{t('help.intro')}</p><h3>{t('help.sequenceTitle')}</h3><ol><li>{t('help.step1')}</li><li>{t('help.step2')}</li><li>{t('help.step3')}</li><li>{t('help.step4')}</li></ol><p>{t('help.outro')}</p></HelpDrawer>
  </>
}
