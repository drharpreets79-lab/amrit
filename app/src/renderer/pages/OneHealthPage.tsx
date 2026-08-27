/* One Health identity and actor binding are enforced again in the main process. */
/* eslint-disable react-hooks/exhaustive-deps */
import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle, Archive, Bird, Building2, CheckCircle2, DatabaseBackup, Download, Dna,
  HeartPulse, KeyRound, Leaf, LogOut, Plus, RefreshCw, Send, ShieldCheck, UserPlus, Users
} from 'lucide-react'
import type {
  Laboratory, OneHealthAuthStatus, OneHealthExportFormat, OneHealthRole, Row
} from '../../shared/types'
import { DataTable, type TableColumn } from '../components/DataTable'
import { useToast } from '../components/Toast'
import {
  Button, CustomSelect, EmptyState, ErrorState, FieldGrid, HelpDrawer, InlineNotice, Input,
  LoadingState, Modal, PageHeader, Section, Select, StatusPill, Switch, Textarea, formatError
} from '../components/ui'

const ALL_ROLES: OneHealthRole[] = ['administrator', 'data-entry', 'reviewer', 'steward', 'auditor', 'sync-agent']
/** Mirrors oneHealthNewPasswordSchema in the main process. */
const MINIMUM_PASSWORD = 12
const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,64}$/

const rowText = (row: Row, ...keys: string[]): string => {
  const nested = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
    ? row.payload as Record<string, unknown> : {}
  for (const key of keys) {
    const direct = row[key]
    if (typeof direct === 'string' || typeof direct === 'number') return String(direct)
    const value = nested[key]
    if (typeof value === 'string' || typeof value === 'number') return String(value)
  }
  return ''
}

const moduleIcon = (definition: Row): typeof Users => {
  const key = rowText(definition, 'key')
  if (key === 'veterinary') return Bird
  if (key === 'food') return Building2
  if (key === 'environment') return Leaf
  if (key === 'amc') return HeartPulse
  if (key === 'ipc_hai') return ShieldCheck
  if (key === 'genomics') return Dna
  return Users
}

interface ModuleField {
  key: string
  label: string
  kind: 'text' | 'number' | 'boolean' | 'datetime' | 'choice'
  required: boolean
  choices?: string[]
  helpText?: string
}

const definitionFields = (definition: Row | undefined): ModuleField[] => {
  if (!definition) return []
  let raw: unknown = (definition as Record<string, unknown>).fields
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw) as unknown } catch { return [] }
  }
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object')).map((item) => ({
    key: String(item.key ?? ''),
    label: String(item.label ?? item.key ?? ''),
    kind: ['text', 'number', 'boolean', 'datetime', 'choice'].includes(String(item.kind))
      ? String(item.kind) as ModuleField['kind'] : 'text',
    required: Boolean(item.required),
    choices: Array.isArray(item.choices) ? item.choices.map(String) : undefined,
    helpText: item.helpText ? String(item.helpText) : undefined
  })).filter((item) => item.key)
}

const hasRole = (status: OneHealthAuthStatus | null, ...roles: OneHealthRole[]): boolean =>
  Boolean(status?.identity?.roles.some((role) => role === 'administrator' || roles.includes(role)))

export function OneHealthPage({ currentLab }: { currentLab: Laboratory | null }): React.JSX.Element {
  const { t } = useTranslation('oneHealth')
  const { notify } = useToast()
  const [auth, setAuth] = useState<OneHealthAuthStatus | null>(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [credentials, setCredentials] = useState({ username: '', password: '', confirm: '' })
  const [moduleRows, setModuleRows] = useState<Row[]>([])
  const [module, setModule] = useState('')
  const [records, setRecords] = useState<Row[]>([])
  const [metrics, setMetrics] = useState<Row>({})
  const [alerts, setAlerts] = useState<Row[]>([])
  const [actions, setActions] = useState<Row[]>([])
  const [outbox, setOutbox] = useState<Row[]>([])
  const [auditRows, setAuditRows] = useState<Row[]>([])
  const [auditVerification, setAuditVerification] = useState<Row | null>(null)
  const [modulesLoading, setModulesLoading] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [captureOpen, setCaptureOpen] = useState(false)
  const [payload, setPayload] = useState<Row>({
    observed_at: new Date().toISOString().slice(0, 16), quality_status: 'draft', sensitivity: 'restricted',
    facility_id: currentLab?.code ?? ''
  })
  const [exportFormat, setExportFormat] = useState<OneHealthExportFormat>('aggregate')
  const [help, setHelp] = useState(false)
  const [userOpen, setUserOpen] = useState(false)
  const [users, setUsers] = useState<Row[]>([])
  const [newUser, setNewUser] = useState<{ username: string; password: string; roles: OneHealthRole[] }>({
    username: '', password: '', roles: ['data-entry']
  })
  const [actionOpen, setActionOpen] = useState(false)
  const [actionForm, setActionForm] = useState<Row>({ title: '', event_id: '', owner: '', due_at: '', priority: 'medium', evidence: '' })
  const [actionUpdate, setActionUpdate] = useState<Row | null>(null)
  const [alertReview, setAlertReview] = useState<Row | null>(null)
  const [reviewForm, setReviewForm] = useState({ status: 'reviewed' as 'reviewed' | 'dismissed' | 'escalated', note: '' })

  const isAdministrator = hasRole(auth, 'administrator')
  const canRead = hasRole(auth, 'data-entry', 'reviewer', 'steward', 'auditor')
  const canReview = hasRole(auth, 'reviewer', 'steward')
  const canManageActions = hasRole(auth, 'steward')
  const canReadMetrics = hasRole(auth, 'reviewer', 'steward', 'auditor')
  const canExchange = hasRole(auth, 'steward', 'sync-agent')
  const canAudit = hasRole(auth, 'auditor')

  const availableModules = useMemo(() => {
    const unique = new Map<string, Row>()
    for (const row of moduleRows) {
      const key = rowText(row, 'key')
      if (key && !unique.has(key)) unique.set(key, row)
    }
    return [...unique.values()]
  }, [moduleRows])
  const definition = availableModules.find((row) => rowText(row, 'key') === module)
  const fields = useMemo(() => definitionFields(definition), [definition])
  const sensitivePurpose = ['direct-care', 'regulatory'].includes(rowText(definition ?? {}, 'purpose'))
  const canCapture = hasRole(auth, 'steward') || (hasRole(auth, 'data-entry') && !sensitivePurpose)

  const loadAuth = async (): Promise<void> => {
    setAuthLoading(true)
    try { setAuth(await window.amrit.oneHealth.authStatus()) }
    catch (caught) { setError(formatError(caught)) }
    finally { setAuthLoading(false) }
  }

  const loadModules = async (): Promise<void> => {
    setModulesLoading(true); setError('')
    try {
      const rows = await window.amrit.oneHealth.modules()
      setModuleRows(rows)
      const keys = rows.map((row) => rowText(row, 'key')).filter(Boolean)
      setModule((current) => keys.includes(current) ? current : keys[0] ?? '')
    } catch (caught) { setError(formatError(caught)) }
    finally { setModulesLoading(false) }
  }

  const loadDetails = async (): Promise<void> => {
    if (!module || !auth?.authenticated) return
    setLoading(true); setError('')
    try {
      const [items, metricValues, alertItems, actionItems, queued, audits] = await Promise.all([
        canRead ? window.amrit.oneHealth.records(module) : Promise.resolve([]),
        canReadMetrics ? window.amrit.oneHealth.metrics(module) : Promise.resolve({}),
        canRead ? window.amrit.oneHealth.alerts(module) : Promise.resolve([]),
        canRead ? window.amrit.oneHealth.actions() : Promise.resolve([]),
        canExchange ? window.amrit.oneHealth.outbox() : Promise.resolve([]),
        canAudit ? window.amrit.oneHealth.audit(20) : Promise.resolve([])
      ])
      setRecords(items); setMetrics(metricValues); setAlerts(alertItems); setActions(actionItems); setOutbox(queued); setAuditRows(audits)
    } catch (caught) { setError(formatError(caught)) }
    finally { setLoading(false) }
  }

  useEffect(() => { void loadAuth() }, [])
  useEffect(() => { if (auth?.authenticated) void loadModules() }, [auth?.authenticated])
  useEffect(() => {
    if (module && auth?.authenticated) {
      setPayload({
        observed_at: new Date().toISOString().slice(0, 16), quality_status: 'draft', sensitivity: 'restricted',
        facility_id: currentLab?.code ?? ''
      })
      void loadDetails()
    }
  }, [module, auth?.authenticated])
  useEffect(() => {
    setPayload((current) => ({ ...current, facility_id: current.facility_id || currentLab?.code || '' }))
  }, [currentLab?.code])

  const authenticate = async (): Promise<void> => {
    // The main process enforces these; checking here turns a raw schema rejection into a
    // message that says what to type.
    const username = credentials.username.trim()
    if (!USERNAME_PATTERN.test(username)) {
      notify(t('toast.checkUsername'), t('toast.checkUsernameBody'), 'error'); return
    }
    if (auth?.needsBootstrap) {
      if (credentials.password.length < MINIMUM_PASSWORD) {
        notify(t('toast.passwordShort'), t('toast.passwordShortFirst', { minimum: MINIMUM_PASSWORD, entered: credentials.password.length }), 'error'); return
      }
      if (credentials.password !== credentials.confirm) {
        notify(t('toast.passwordsDiffer'), t('toast.passwordsDifferBody'), 'error'); return
      }
    } else if (!credentials.password) {
      notify(t('toast.passwordRequired'), t('toast.passwordRequiredBody'), 'error'); return
    }
    try {
      const status = auth?.needsBootstrap
        ? await window.amrit.oneHealth.bootstrapAdmin(username, credentials.password)
        : await window.amrit.oneHealth.login(username, credentials.password)
      setAuth(status); setCredentials({ username: '', password: '', confirm: '' })
      notify(auth?.needsBootstrap ? t('toast.administratorConfigured') : t('toast.signedIn'), t('toast.actor', { actor: status.identity?.username ?? '' }))
    } catch (caught) { notify(t('toast.authFailed'), formatError(caught), 'error') }
  }

  const logout = async (): Promise<void> => {
    setAuth(await window.amrit.oneHealth.logout())
    setRecords([]); setMetrics({}); setAlerts([]); setActions([]); setOutbox([]); setAuditRows([]); setAuditVerification(null)
  }

  const capture = async (): Promise<void> => {
    if (!module || !rowText(payload, 'observed_at') || !rowText(payload, 'facility_id')) {
      notify(t('toast.requiredMissing'), t('toast.requiredMissingBody'), 'error'); return
    }
    try {
      await window.amrit.oneHealth.capture(module, payload)
      notify(t('toast.eventSaved'), t('toast.eventSavedBody', { module: rowText(definition ?? {}, 'title') || module, actor: auth?.identity?.username ?? t('toast.eventActorFallback') }))
      setCaptureOpen(false); await loadDetails()
    } catch (caught) { notify(t('toast.eventSaveFailed'), formatError(caught), 'error') }
  }

  const enqueue = async (): Promise<void> => {
    if (!module) return
    try {
      const queued = await window.amrit.oneHealth.enqueue(module)
      notify(t('toast.aggregateQueued'), String(queued.aggregate_key ?? t('toast.aggregateQueuedBody')))
      await loadDetails()
    } catch (caught) { notify(t('toast.aggregateFailed'), formatError(caught), 'error') }
  }

  const exportModule = async (): Promise<void> => {
    if (!module) return
    const path = await window.amrit.chooseSave({
      defaultPath: `AMRIT_${exportFormat}_${exportFormat === 'infarm' ? 'animal-food' : module}.json`,
      filters: [{ name: 'Structured JSON', extensions: ['json'] }]
    })
    if (!path) return
    try {
      await window.amrit.oneHealth.export(exportFormat, module, path)
      notify(t('toast.exportSaved'), `${exportFormat.toUpperCase()} · ${path}`)
    } catch (caught) { notify(t('toast.exportFailed'), formatError(caught), 'error') }
  }

  const backup = async (): Promise<void> => {
    const path = await window.amrit.chooseSave({
      defaultPath: `AMRIT_backup_${new Date().toISOString().slice(0, 10)}.sqlite3`,
      filters: [{ name: 'SQLite database backup', extensions: ['sqlite3', 'db'] }]
    })
    if (!path) return
    try {
      const result = await window.amrit.oneHealth.backup(path)
      notify(t('toast.backupCreated'), `${result.path} · SHA-256 ${result.sha256.slice(0, 16)}…`)
    } catch (caught) { notify(t('toast.backupFailed'), formatError(caught), 'error') }
  }

  const openUsers = async (): Promise<void> => {
    try { setUsers(await window.amrit.oneHealth.users()); setUserOpen(true) }
    catch (caught) { notify(t('toast.usersFailed'), formatError(caught), 'error') }
  }

  const createUser = async (): Promise<void> => {
    const username = newUser.username.trim()
    if (!USERNAME_PATTERN.test(username)) {
      notify(t('toast.checkUsername'), t('toast.checkUsernameBody'), 'error'); return
    }
    if (newUser.password.length < MINIMUM_PASSWORD) {
      notify(t('toast.passwordShort'), t('toast.passwordShortNew', { minimum: MINIMUM_PASSWORD, entered: newUser.password.length }), 'error'); return
    }
    if (newUser.roles.length === 0) {
      notify(t('toast.roleRequired'), t('toast.roleRequiredBody'), 'error'); return
    }
    try {
      await window.amrit.oneHealth.createUser({ ...newUser, username })
      setUsers(await window.amrit.oneHealth.users())
      setNewUser({ username: '', password: '', roles: ['data-entry'] })
      notify(t('toast.userCreated'), t('toast.userCreatedBody'))
    } catch (caught) { notify(t('toast.userCreateFailed'), formatError(caught), 'error') }
  }

  const createAction = async (): Promise<void> => {
    try {
      await window.amrit.oneHealth.createAction(actionForm)
      setActionOpen(false)
      setActionForm({ title: '', event_id: '', owner: '', due_at: '', priority: 'medium', evidence: '' })
      await loadDetails()
      notify(t('toast.actionCreated'), t('toast.actionCreatedBody'))
    } catch (caught) { notify(t('toast.actionCreateFailed'), formatError(caught), 'error') }
  }

  const updateAction = async (): Promise<void> => {
    if (!actionUpdate) return
    try {
      await window.amrit.oneHealth.updateAction(rowText(actionUpdate, 'id'), {
        status: rowText(actionUpdate, 'next_status') || rowText(actionUpdate, 'status'),
        evidence: rowText(actionUpdate, 'new_evidence') || undefined
      })
      setActionUpdate(null); await loadDetails(); notify(t('toast.actionUpdated'), t('toast.actionUpdatedBody'))
    } catch (caught) { notify(t('toast.actionUpdateFailed'), formatError(caught), 'error') }
  }

  const reviewAlert = async (): Promise<void> => {
    if (!alertReview) return
    try {
      await window.amrit.oneHealth.reviewAlert(rowText(alertReview, 'id'), reviewForm)
      setAlertReview(null); setReviewForm({ status: 'reviewed', note: '' }); await loadDetails()
      notify(t('toast.alertReviewed'), t('toast.alertReviewedBody'))
    } catch (caught) { notify(t('toast.alertReviewFailed'), formatError(caught), 'error') }
  }

  const verifyAudit = async (): Promise<void> => {
    try {
      const result = await window.amrit.oneHealth.verifyAudit()
      setAuditVerification(result)
      notify(result.valid === true ? t('toast.auditVerified') : t('toast.auditProblem'), result.valid === true
        ? t('toast.auditIntact', { count: Number(result.entries) }) : t('toast.auditBroken', { entry: String(result.broken_at) }), result.valid === true ? 'success' : 'error')
    } catch (caught) { notify(t('toast.auditVerifyFailed'), formatError(caught), 'error') }
  }

  const recordColumns: Array<TableColumn<Row>> = [
    { key: 'event', label: 'Event', render: (row) => <div className="table-primary"><strong>{rowText(row, 'site_ref', 'sample_id', 'facility_id') || 'Local event'}</strong><small>{rowText(row, 'observed_at') || 'No date'}</small></div> },
    { key: 'sample', label: 'Sample / activity', render: (row) => <span>{rowText(row, 'sample_type', 'indicator', 'event_type') || '—'}</span> },
    { key: 'organism', label: 'Organism / indicator', render: (row) => <span>{rowText(row, 'organism', 'antimicrobial', 'indicator') || 'Pending'}</span> },
    { key: 'facility', label: 'Facility', render: (row) => <span className="code-label">{rowText(row, 'facility_id') || '—'}</span> },
    { key: 'actor', label: 'Actor', render: (row) => <span>{rowText(row, 'actor') || '—'}</span> },
    { key: 'status', label: 'Quality', render: (row) => { const status = rowText(row, 'quality_status') || 'draft'; return <StatusPill label={status} tone={status === 'validated' ? 'green' : status === 'rejected' ? 'red' : 'orange'} /> } }
  ]
  const metricItems = Object.entries(metrics).filter(([, value]) => typeof value === 'string' || typeof value === 'number').slice(0, 6)

  if (authLoading) return <><PageHeader eyebrow={t('eyebrow')} title={t('title')} purpose={t('purposeLoading')} /><LoadingState label={t('loadingIdentity')} /></>

  if (!auth?.authenticated) return <>
    <PageHeader eyebrow={t('eyebrow')} title={t('title')} purpose={t('purposeSignIn')} onHelp={() => setHelp(true)} />
    <Section title={auth?.needsBootstrap ? 'Configure the first administrator' : 'Sign in to One Health'} description={auth?.needsBootstrap
      ? 'No local One Health user exists. Create the first administrator once; no default password is installed.'
      : 'The actor is held in the main process and attached to every governed mutation.'}>
      <div className="auth-form">
        <InlineNotice tone="info" title={t('identityNotice.title')}>{t('identityNotice.body')}</InlineNotice>
        <FieldGrid columns={2}>
          <Input label={t('fields.username')} name="oh-username" autoComplete="username" hint={auth?.needsBootstrap ? t('fields.usernameHint') : undefined} required value={credentials.username} onChange={(event) => setCredentials((current) => ({ ...current, username: event.target.value }))} />
          <Input label={t('fields.password')} name="oh-password" type="password" autoComplete={auth?.needsBootstrap ? 'new-password' : 'current-password'} minLength={auth?.needsBootstrap ? MINIMUM_PASSWORD : 1} required value={credentials.password} onChange={(event) => setCredentials((current) => ({ ...current, password: event.target.value }))}
            hint={auth?.needsBootstrap ? `Minimum ${MINIMUM_PASSWORD} characters — ${credentials.password.length} entered.` : undefined}
            error={auth?.needsBootstrap && credentials.password.length > 0 && credentials.password.length < MINIMUM_PASSWORD ? `${credentials.password.length} of ${MINIMUM_PASSWORD} characters` : undefined} />
          {auth?.needsBootstrap && <Input label={t('fields.confirmPassword')} name="oh-confirm" type="password" autoComplete="new-password" minLength={MINIMUM_PASSWORD} required value={credentials.confirm} onChange={(event) => setCredentials((current) => ({ ...current, confirm: event.target.value }))}
            error={credentials.confirm.length > 0 && credentials.confirm !== credentials.password ? t('fields.doesNotMatch') : undefined} />}
        </FieldGrid>
        <Button onClick={() => void authenticate()}><KeyRound size={17} /> {auth?.needsBootstrap ? t('buttons.createAdministrator') : t('buttons.signIn')}</Button>
      </div>
    </Section>
    {error && <ErrorState message={error} onRetry={() => void loadAuth()} />}
    <HelpDrawer open={help} title={t('help.governanceTitle')} onClose={() => setHelp(false)}><p>{t('help.governanceBody')}</p></HelpDrawer>
  </>

  return <>
    <PageHeader eyebrow={t('eyebrow')} title={t('title')} purpose={t('purpose')} actions={<>
      <StatusPill label={`${auth.identity?.username ?? ''} · ${auth.identity?.roles.join(', ') ?? ''}`} tone="blue" />
      {isAdministrator && <Button variant="secondary" onClick={() => void openUsers()}><UserPlus size={17} /> {t('buttons.users')}</Button>}
      {isAdministrator && <Button variant="secondary" onClick={() => void backup()}><DatabaseBackup size={17} /> {t('buttons.backup')}</Button>}
      <Button variant="ghost" onClick={() => void logout()}><LogOut size={17} /> {t('buttons.signOut')}</Button>
    </>} onHelp={() => setHelp(true)} />
    {modulesLoading ? <LoadingState label={t('loadingModules')} /> : error && !module ? <ErrorState message={error} onRetry={() => void loadModules()} /> : !availableModules.length ? <EmptyState title={t('modules.emptyTitle')} message={t('modules.emptyMessage')} /> : <>
      <div className="domain-tabs" role="tablist" aria-label={t('modules.tabsLabel')}>{availableModules.map((item) => {
        const key = rowText(item, 'key'); const Icon = moduleIcon(item); const domain = rowText(item, 'domain').toLowerCase()
        return <button role="tab" aria-selected={module === key} className={module === key ? 'active' : undefined} key={key} onClick={() => setModule(key)}><span className={`domain-icon domain-icon--${domain === 'animal' ? 'orange' : domain === 'environment' ? 'green' : 'blue'}`}><Icon size={21} /></span><span><strong>{rowText(item, 'title') || key}</strong><small>{rowText(item, 'description', 'purpose')}</small></span></button>
      })}</div>
      {sensitivePurpose && !canCapture && <InlineNotice tone="warning" title={t('sensitiveCapture.title')}>{t('sensitiveCapture.body')}</InlineNotice>}
      <div className="one-health-actions">
        <Select aria-label={t('exports.label')} value={exportFormat} onChange={(event) => setExportFormat(event.target.value as OneHealthExportFormat)}>
          <option value="aggregate">{t('exports.aggregate')}</option><option value="glass">{t('exports.glass')}</option>
          <option value="animuse">{t('exports.animuse')}</option><option value="infarm">{t('exports.infarm')}</option>
        </Select>
        <Button variant="secondary" onClick={() => void loadDetails()}><RefreshCw size={16} /> {t('buttons.refresh')}</Button>
        {(canRead || canReadMetrics) && <Button variant="secondary" onClick={() => void exportModule()}><Download size={16} /> {t('buttons.export')}</Button>}
        {canExchange && <Button variant="secondary" onClick={() => void enqueue()}><Send size={16} /> {t('buttons.enqueue')}</Button>}
        {canCapture && <Button onClick={() => setCaptureOpen(true)}><Plus size={17} /> {t('buttons.captureEvent')}</Button>}
      </div>
      {loading ? <LoadingState label={t('loadingModule')} /> : error ? <ErrorState message={error} onRetry={() => void loadDetails()} /> : <>
        {canReadMetrics && <div className="one-health-metrics">{metricItems.map(([key, value]) => <article key={key}><span>{key.replace(/_/g, ' ')}</span><strong>{String(value ?? '—')}</strong><small>{t('metrics.locallyCalculated')}</small></article>)}</div>}
        <div className="one-health-grid">
          <Section title={rowText(definition ?? {}, 'title') || module} description={rowText(definition ?? {}, 'description', 'purpose') || 'Locally captured events.'} actions={<StatusPill label={`${records.length} records`} tone="blue" />}>
            {canRead ? <DataTable rows={records.slice(0, 100)} columns={recordColumns} keyFor={(row, index) => String(row.id ?? index)} emptyTitle={t('records.emptyTitle')} emptyMessage={t('records.emptyMessage')} /> : <EmptyState title={t('records.noAccessTitle')} message={t('records.noAccessMessage')} />}
          </Section>
          <Section title={t('alerts.sectionTitle')} description={t('alerts.sectionDescription')}>
            {alerts.length ? <div className="one-health-alerts">{alerts.slice(0, 12).map((alert, index) => <div key={String(alert.id ?? index)}><AlertTriangle size={18} /><span><strong>{rowText(alert, 'rule_code') || t('alerts.fallbackRule')}</strong><small>{rowText(alert, 'message') || t('alerts.fallbackMessage')}</small></span><StatusPill label={rowText(alert, 'severity') || 'open'} tone="orange" />{canReview && <Button variant="ghost" onClick={() => setAlertReview(alert)}>{t('alerts.review')}</Button>}</div>)}</div> : <EmptyState title={t('alerts.emptyTitle')} message={t('alerts.emptyMessage')} />}
          </Section>
        </div>
        {canRead && <Section title={t('actions.sectionTitle')} description={t('actions.sectionDescription')} actions={canManageActions && <Button variant="secondary" onClick={() => setActionOpen(true)}><Plus size={16} /> {t('actions.add')}</Button>}>
          {actions.length ? <div className="outbox-list">{actions.slice(0, 30).map((item, index) => <div key={String(item.id ?? index)}><CheckCircle2 size={17} /><span><strong>{rowText(item, 'title') || t('actions.fallbackTitle')}</strong><small>{rowText(item, 'owner') || t('actions.unassigned')} · {rowText(item, 'updated_at')}</small></span><StatusPill label={rowText(item, 'status') || 'open'} tone={rowText(item, 'status') === 'closed' ? 'green' : 'orange'} />{canManageActions && <Button variant="ghost" onClick={() => setActionUpdate({ ...item, next_status: rowText(item, 'status'), new_evidence: '' })}>{t('actions.update')}</Button>}</div>)}</div> : <EmptyState title={t('actions.emptyTitle')} message={t('actions.emptyMessage')} />}
        </Section>}
        {canExchange && <Section title={t('outbox.sectionTitle')} description={t('outbox.sectionDescription')}>
          {outbox.length ? <div className="outbox-list">{outbox.slice(0, 20).map((item, index) => <div key={String(item.id ?? index)}><Archive size={17} /><span><strong>{rowText(item, 'aggregate_key') || t('outbox.fallbackKey')}</strong><small>{rowText(item, 'created_at') || t('outbox.pendingTimestamp')}</small></span><StatusPill label={rowText(item, 'status') || 'queued'} tone={rowText(item, 'status') === 'sent' ? 'green' : 'orange'} /></div>)}</div> : <EmptyState title={t('outbox.emptyTitle')} message={t('outbox.emptyMessage')} />}
        </Section>}
        {canAudit && <Section title={t('audit.sectionTitle')} description={t('audit.sectionDescription')} actions={<Button variant="secondary" onClick={() => void verifyAudit()}><ShieldCheck size={16} /> {t('audit.verify')}</Button>}>
          {auditVerification && <InlineNotice tone={auditVerification.valid === true ? 'success' : 'danger'} title={auditVerification.valid === true ? 'Chain intact' : 'Verification failed'}>{auditVerification.valid === true ? `${String(auditVerification.entries)} linked entries verified.` : `Break at entry ${String(auditVerification.broken_at)}: ${String(auditVerification.reason)}`}</InlineNotice>}
          {auditRows.length ? <div className="outbox-list">{auditRows.slice(0, 10).map((item, index) => <div key={String(item.id ?? index)}><ShieldCheck size={17} /><span><strong>{rowText(item, 'action')} · {rowText(item, 'actor')}</strong><small>{rowText(item, 'occurred_at')} · {rowText(item, 'object_type')}</small></span></div>)}</div> : <EmptyState title={t('audit.emptyTitle')} message={t('audit.emptyMessage')} />}
        </Section>}
      </>}
    </>}

    <Modal open={captureOpen} title={t('modals.captureTitle', { module: rowText(definition ?? {}, 'title') || t('modals.captureFallback') })} description={t('modals.captureDescription', { eventType: rowText(definition ?? {}, 'event_type'), actor: auth.identity?.username ?? '' })} onClose={() => setCaptureOpen(false)} width="large" actions={<><Button variant="secondary" onClick={() => setCaptureOpen(false)}>{t('modals.cancel')}</Button><Button onClick={() => void capture()}>{t('modals.validateAndSave')}</Button></>}>
      <FieldGrid columns={2}>{fields.map((field) => {
        const value = payload[field.key]
        if (field.kind === 'boolean') return <Switch key={field.key} checked={value === true || value === 'true' || value === 1} onChange={(next) => setPayload((row) => ({ ...row, [field.key]: next }))} label={field.label} description={field.helpText} />
        if (field.kind === 'choice') return <CustomSelect key={field.key} label={field.label} name={`oh-${field.key}`} required={field.required} value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''} onChange={(next) => setPayload((row) => ({ ...row, [field.key]: next }))} options={(field.choices ?? []).map((choice) => ({ value: choice, label: choice }))} hint={field.helpText} />
        return <Input key={field.key} label={field.label} required={field.required} type={field.kind === 'number' ? 'number' : field.kind === 'datetime' ? 'datetime-local' : 'text'} min={field.kind === 'number' ? 0 : undefined} step={field.kind === 'number' ? 'any' : undefined} value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''} hint={field.helpText} onChange={(event) => setPayload((row) => ({ ...row, [field.key]: field.kind === 'number' && event.target.value !== '' ? Number(event.target.value) : event.target.value }))} />
      })}</FieldGrid>
      <FieldGrid columns={2}><CustomSelect label={t('fields.qualityStatus')} name="oh-quality" value={rowText(payload, 'quality_status')} onChange={(value) => setPayload((row) => ({ ...row, quality_status: value }))} options={(canReview ? ['draft', 'validated', 'rejected'] : ['draft']).map((value) => ({ value, label: value }))} hint={canReview ? t('hints.reviewerStatus') : t('hints.draftStatus')} /><CustomSelect label={t('fields.sensitivity')} name="oh-sensitivity" value={rowText(payload, 'sensitivity') || 'restricted'} onChange={(value) => setPayload((row) => ({ ...row, sensitivity: value }))} options={[{ value: 'restricted', label: t('sensitivityOptions.restricted') }, { value: 'internal', label: t('sensitivityOptions.internal') }, { value: 'aggregate-only', label: t('sensitivityOptions.aggregateOnly') }]} /></FieldGrid>
    </Modal>

    <Modal open={userOpen} title={t('modals.usersTitle')} description={t('modals.usersDescription')} onClose={() => setUserOpen(false)} width="large" actions={<><Button variant="secondary" onClick={() => setUserOpen(false)}>{t('modals.close')}</Button><Button onClick={() => void createUser()}>{t('modals.createUser')}</Button></>}>
      <FieldGrid columns={2}><Input label={t('fields.username')} value={newUser.username} onChange={(event) => setNewUser((current) => ({ ...current, username: event.target.value }))} /><Input label={t('fields.temporaryPassword')} type="password" minLength={MINIMUM_PASSWORD} value={newUser.password} onChange={(event) => setNewUser((current) => ({ ...current, password: event.target.value }))} hint={t('hints.temporaryPassword', { minimum: MINIMUM_PASSWORD, entered: newUser.password.length })} error={newUser.password.length > 0 && newUser.password.length < MINIMUM_PASSWORD ? t('hints.moreNeeded', { count: MINIMUM_PASSWORD - newUser.password.length }) : undefined} /></FieldGrid>
      <div className="field-grid field-grid--3">{ALL_ROLES.map((role) => <Switch key={role} label={role} checked={newUser.roles.includes(role)} onChange={(checked) => setNewUser((current) => ({ ...current, roles: checked ? [...current.roles, role] : current.roles.filter((item) => item !== role) }))} />)}</div>
      <div className="outbox-list">{users.map((user, index) => <div key={String(user.id ?? index)}><Users size={17} /><span><strong>{rowText(user, 'username')}</strong><small>{Array.isArray(user.roles) ? user.roles.join(', ') : ''} · {user.active === true ? 'active' : 'inactive'}</small></span></div>)}</div>
    </Modal>

    <Modal open={actionOpen} title={t('modals.createActionTitle')} description={t('modals.createActionDescription')} onClose={() => setActionOpen(false)} actions={<><Button variant="secondary" onClick={() => setActionOpen(false)}>{t('modals.cancel')}</Button><Button onClick={() => void createAction()}>{t('modals.createAction')}</Button></>}>
      <Input label={t('fields.actionTitle')} required value={rowText(actionForm, 'title')} onChange={(event) => setActionForm((current) => ({ ...current, title: event.target.value }))} />
      <CustomSelect label={t('fields.linkedEvent')} name="oh-action-event" value={rowText(actionForm, 'event_id')} onChange={(value) => setActionForm((current) => ({ ...current, event_id: value }))} options={records.map((record) => ({ value: rowText(record, 'id'), label: `${rowText(record, 'observed_at')} · ${rowText(record, 'facility_id')}` }))} placeholder={t('fields.noLinkedEvent')} />
      <FieldGrid columns={2}><Input label={t('fields.owner')} value={rowText(actionForm, 'owner')} onChange={(event) => setActionForm((current) => ({ ...current, owner: event.target.value }))} /><Input label={t('fields.dueDate')} type="date" value={rowText(actionForm, 'due_at')} onChange={(event) => setActionForm((current) => ({ ...current, due_at: event.target.value }))} /></FieldGrid>
      <CustomSelect label={t('fields.priority')} name="oh-action-priority" value={rowText(actionForm, 'priority')} onChange={(value) => setActionForm((current) => ({ ...current, priority: value }))} options={['low', 'medium', 'high', 'critical'].map((value) => ({ value, label: value }))} />
      <Textarea label={t('fields.initialEvidence')} value={rowText(actionForm, 'evidence')} onChange={(event) => setActionForm((current) => ({ ...current, evidence: event.target.value }))} />
    </Modal>

    <Modal open={Boolean(actionUpdate)} title={t('modals.updateActionTitle')} description={rowText(actionUpdate ?? {}, 'title')} onClose={() => setActionUpdate(null)} actions={<><Button variant="secondary" onClick={() => setActionUpdate(null)}>{t('modals.cancel')}</Button><Button onClick={() => void updateAction()}>{t('modals.saveUpdate')}</Button></>}>
      <CustomSelect label={t('fields.status')} name="oh-action-status" value={rowText(actionUpdate ?? {}, 'next_status')} onChange={(value) => setActionUpdate((current) => current ? { ...current, next_status: value } : current)} options={['open', 'in-progress', 'blocked', 'closed', 'cancelled'].map((value) => ({ value, label: value }))} />
      <Textarea label={t('fields.evidence')} required={rowText(actionUpdate ?? {}, 'next_status') === 'closed'} value={rowText(actionUpdate ?? {}, 'new_evidence')} onChange={(event) => setActionUpdate((current) => current ? { ...current, new_evidence: event.target.value } : current)} hint={t('hints.closureEvidence')} />
    </Modal>

    <Modal open={Boolean(alertReview)} title={t('modals.reviewAlertTitle')} description={rowText(alertReview ?? {}, 'message')} onClose={() => setAlertReview(null)} actions={<><Button variant="secondary" onClick={() => setAlertReview(null)}>{t('modals.cancel')}</Button><Button onClick={() => void reviewAlert()}>{t('modals.recordReview')}</Button></>}>
      <CustomSelect label={t('fields.decision')} name="oh-alert-review" value={reviewForm.status} onChange={(value) => setReviewForm((current) => ({ ...current, status: value as typeof current.status }))} options={[{ value: 'reviewed', label: t('reviewOptions.reviewed') }, { value: 'dismissed', label: t('reviewOptions.dismissed') }, { value: 'escalated', label: t('reviewOptions.escalated') }]} />
      <Textarea label={t('fields.reviewNote')} value={reviewForm.note} onChange={(event) => setReviewForm((current) => ({ ...current, note: event.target.value }))} />
    </Modal>

    <HelpDrawer open={help} title={t('help.title')} onClose={() => setHelp(false)}><p>{t('help.actorBody')}</p><h3>{t('help.federationHeading')}</h3><p>{t('help.federationBody')}</p><h3>{t('help.actionsHeading')}</h3><p>{t('help.actionsBody')}</p></HelpDrawer>
  </>
}
