/* The sync subscription is recreated only for a laboratory identity change. */
/* eslint-disable react-hooks/exhaustive-deps */
import type React from 'react'
import { useEffect, useState } from 'react'
import { CheckCircle2, Crosshair, KeyRound, LockKeyhole, MailQuestion, MapPin, Play, PlugZap, RadioTower, RefreshCw, Square, Webhook } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { Laboratory, SyncConfig, SyncStatus } from '../../shared/types'
import { useFormat } from '../i18n/provider'
import { useToast } from '../components/Toast'
import { Button, EmptyState, FieldGrid, HelpDrawer, InlineNotice, Input, PageHeader, Section, StatusPill, Switch, formatError } from '../components/ui'

const DEFAULT_CONFIG: SyncConfig = { serverUrl: '', authToken: '', siteToken: '', pickupToken: '', labCode: '', pollIntervalSeconds: 10, pollTimeoutSeconds: 30, verifyTls: true, autoConfigureToken: true, gpsConsent: false, allowedQueryTypes: ['resistance_rate', 'isolate_count', 'organism_distribution', 'specimen_distribution', 'measure_bundle', 'cluster_scan', 'heartbeat'] }
/** Wire values, never translated; their labels live in the catalogue under the same key. */
const QUERY_TYPES = ['resistance_rate', 'isolate_count', 'organism_distribution', 'specimen_distribution', 'measure_bundle', 'cluster_scan', 'heartbeat'] as const

export function SyncPage({ currentLab, initialStatus, onStatus }: { currentLab: Laboratory | null; initialStatus: SyncStatus; onStatus: (status: SyncStatus) => void }): React.JSX.Element {
  const { t } = useTranslation('sync')
  const format = useFormat()
  const { notify } = useToast()
  const [config, setConfig] = useState<SyncConfig>({ ...DEFAULT_CONFIG, labCode: currentLab?.code ?? '' })
  const [status, setStatus] = useState(initialStatus)
  const [busy, setBusy] = useState('')
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [accessRequest, setAccessRequest] = useState<{ status: 'pending' | 'registered' | 'failed'; detail: string; requestedAt: string } | null>(null)
  const [help, setHelp] = useState(false)
  const [locating, setLocating] = useState(false)
  const [locationSupport, setLocationSupport] = useState<{ supported: boolean; detail: string } | null>(null)
  const [locationNotice, setLocationNotice] = useState<
    { tone: 'success' | 'warning' | 'danger'; title: string; detail: string; canOpenSettings: boolean } | null
  >(null)
  useEffect(() => {
    void window.amrit.sync.get().then((response) => { setConfig({ ...response.config, labCode: currentLab?.code ?? response.config.labCode }); setStatus(response.status); onStatus(response.status) }).catch((caught) => notify(t('notify.loadFailed'), formatError(caught), 'error'))
    const unsubscribe = window.amrit.sync.onStatus((next) => { setStatus(next); onStatus(next) })
    void window.amrit.sync.locationSupport?.().then(setLocationSupport).catch(() => setLocationSupport(null))
    return unsubscribe
  }, [currentLab?.code])
  const update = <K extends keyof SyncConfig>(key: K, value: SyncConfig[K]): void => setConfig((current) => ({ ...current, [key]: value }))
  const save = async (): Promise<void> => {
    setBusy('save')
    try { setConfig(await window.amrit.sync.save({ ...config, labCode: currentLab?.code ?? config.labCode })); notify(t('notify.saved'), t('notify.savedDetail')) }
    catch (caught) { notify(t('notify.saveFailed'), formatError(caught), 'error') } finally { setBusy('') }
  }
  const test = async (): Promise<void> => {
    setBusy('test'); setTestResult(null)
    try { const result = await window.amrit.sync.test({ ...config, labCode: currentLab?.code ?? config.labCode }); setTestResult(result); notify(result.ok ? t('notify.testPassed') : t('notify.testFailed'), result.message, result.ok ? 'success' : 'error') }
    catch (caught) { const message = formatError(caught); setTestResult({ ok: false, message }); notify(t('notify.testFailed'), message, 'error') } finally { setBusy('') }
  }
  const configureToken = async (): Promise<void> => {
    setBusy('token')
    try { setConfig(await window.amrit.sync.configureToken({ ...config, labCode: currentLab?.code ?? config.labCode })); notify(t('notify.tokenConfigured'), t('notify.tokenConfiguredDetail')); const response = await window.amrit.sync.get(); setStatus(response.status); onStatus(response.status) }
    catch (caught) { notify(t('notify.tokenFailed'), formatError(caught), 'error') } finally { setBusy('') }
  }
  /**
   * Ask the central server to register this laboratory.
   *
   * Nothing about the request grants access: an administrator there approves or declines it,
   * and only then does collecting a token succeed. Reported as a notice rather than a silent
   * state change, because "waiting for someone else" is the whole answer at this point.
   */
  const requestAccess = async (): Promise<void> => {
    setBusy('request'); setAccessRequest(null)
    try {
      const result = await window.amrit.sync.requestAccess({ ...config, labCode: currentLab?.code ?? config.labCode })
      setAccessRequest(result)
      notify(result.status === 'pending' ? t('notify.accessRequested') : t('notify.accessAlreadyRegistered'), result.detail, result.status === 'pending' ? 'info' : 'success')
    }
    // A failure is not a pending request. Reporting it as one told a laboratory it was
    // waiting for an administrator who had never been sent anything, and the portal queue
    // stayed empty with nothing to explain why.
    catch (caught) { const message = formatError(caught); setAccessRequest({ status: 'failed', detail: message, requestedAt: '' }); notify(t('notify.accessRequestFailed'), message, 'error') }
    finally { setBusy('') }
  }
  const start = async (): Promise<void> => {
    setBusy('start')
    try { const next = await window.amrit.sync.start({ ...config, labCode: currentLab?.code ?? config.labCode }); setStatus(next); onStatus(next); if (next.mode === 'error') notify(t('notify.startFailed'), next.lastError || t('notify.startFailedDetail'), 'error'); else notify(t('notify.started'), t('notify.startedDetail')) }
    catch (caught) { notify(t('notify.couldNotStart'), formatError(caught), 'error') } finally { setBusy('') }
  }
  const stop = async (): Promise<void> => {
    setBusy('stop')
    try { const next = await window.amrit.sync.stop(); setStatus(next); onStatus(next); notify(t('notify.stopped'), t('notify.stoppedDetail')) }
    catch (caught) { notify(t('notify.couldNotStop'), formatError(caught), 'error') } finally { setBusy('') }
  }
  /**
   * Ask this computer where it is.
   *
   * The operating system decides whether to answer: location services can be switched off
   * for the whole machine or refused to this application, and a laboratory computer in a
   * basement may simply not know. None of those is an error to argue with — each one gets
   * the remedy that fits, and the coordinates stay typeable by hand throughout, because a
   * site that knows its own coordinates should never have to negotiate with a permission
   * dialog to enter them.
   */
  const detectLocation = async (): Promise<void> => {
    if (!navigator.geolocation) {
      setLocationNotice({ tone: 'warning', title: t('location.unavailable'), detail: t('location.unavailableDetail'), canOpenSettings: false })
      return
    }
    setLocating(true)
    setLocationNotice(null)
    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 })
      })
      const latitude = Number(position.coords.latitude.toFixed(6))
      const longitude = Number(position.coords.longitude.toFixed(6))
      setConfig((current) => ({ ...current, gpsLatitude: latitude, gpsLongitude: longitude, gpsSource: 'device' }))
      setLocationNotice({
        tone: 'success',
        title: t('location.detected'),
        detail: t('location.detectedDetail', {
          latitude, longitude, accuracy: Math.round(position.coords.accuracy || 0)
        }),
        canOpenSettings: false
      })
    } catch (caught) {
      // `GeolocationPositionError` is not an `Error`, so the generic formatter rendered
      // every failure as "An unexpected error occurred" — hiding both the code that says
      // which failure it is and Chromium's own sentence saying why.
      const failure = caught as GeolocationPositionError | undefined
      const denied = failure?.code === 1
      const reason = String(failure?.message ?? '').trim()
      const platformDetail = locationSupport && !locationSupport.supported ? locationSupport.detail : ''
      setLocationNotice({
        tone: denied ? 'warning' : 'danger',
        title: denied ? t('location.denied') : t('location.failed'),
        detail: denied
          ? t('location.deniedDetail')
          : [platformDetail || t('location.failedDetail'), reason ? t('location.reported', { reason }) : ''].filter(Boolean).join(' '),
        canOpenSettings: denied
      })
    } finally {
      setLocating(false)
    }
  }
  /** Take the operator to the operating system's own location switch. */
  const openLocationSettings = async (): Promise<void> => {
    try {
      const result = await window.amrit.sync.openLocationSettings()
      setLocationNotice({
        tone: result.opened ? 'success' : 'warning',
        title: result.opened ? t('location.settingsOpened') : t('location.settingsUnavailable'),
        detail: result.detail,
        canOpenSettings: false
      })
    } catch (caught) {
      notify(t('location.failed'), formatError(caught), 'error')
    }
  }
  /**
   * A typed coordinate is the operator's, so it stops being the device's.
   *
   * The source travels with the heartbeat, and a hand-corrected coordinate reported as a
   * device fix would be a claim about how the number was obtained that is not true.
   */
  const setCoordinate = (key: 'gpsLatitude' | 'gpsLongitude', raw: string): void => {
    const value = raw ? Number(raw) : undefined
    setConfig((current) => ({ ...current, [key]: value, gpsSource: 'manual' }))
  }
  const toggleQuery = (value: string, checked: boolean): void => update('allowedQueryTypes', checked ? [...new Set([...config.allowedQueryTypes, value])] : config.allowedQueryTypes.filter((item) => item !== value))
  const running = status.mode !== 'off' && status.mode !== 'error'
  if (!currentLab) return <><PageHeader eyebrow={t('eyebrow')} title={t('title')} purpose={t('purpose')} onHelp={() => setHelp(true)} /><EmptyState title={t('noLabTitle')} message={t('noLabMessage')} /><HelpDrawer open={help} title={t('title')} onClose={() => setHelp(false)}><p>{t('noLabHelp')}</p></HelpDrawer></>
  return <>
    <PageHeader eyebrow={t('eyebrow')} title={t('title')} purpose={t('purpose')} actions={<>{running ? <Button variant="danger" disabled={Boolean(busy)} onClick={() => void stop()}><Square size={16} /> {t('stopSync')}</Button> : <Button disabled={Boolean(busy)} onClick={() => void start()}><Play size={16} /> {t('startSync')}</Button>}</>} onHelp={() => setHelp(true)} />
    <div className="sync-status-grid"><article><RadioTower size={22} /><div><span>{t('status.longPoll')}</span><strong>{status.mode}</strong><small>{status.lastHeartbeat ? t('status.heartbeat', { time: format.dateTime(status.lastHeartbeat) }) : t('status.noHeartbeat')}</small></div><StatusPill label={status.mode} tone={status.mode === 'idle' || status.mode === 'processing' ? 'green' : status.mode === 'error' ? 'red' : 'neutral'} pulse={status.mode === 'processing'} /></article><article><Webhook size={22} /><div><span>{t('status.websocket')}</span><strong>{status.websocket}</strong><small>{t('status.websocketDetail')}</small></div><StatusPill label={status.websocket} tone={status.websocket === 'connected' ? 'green' : status.websocket === 'error' ? 'red' : 'neutral'} /></article><article><KeyRound size={22} /><div><span>{t('status.credential')}</span><strong>{status.tokenConfigured ? t('status.configured') : t('status.notConfigured')}</strong><small>{t('status.credentialDetail')}</small></div><StatusPill label={status.tokenConfigured ? t('status.ready') : t('status.required')} tone={status.tokenConfigured ? 'green' : 'orange'} /></article></div>
    {status.lastError && <InlineNotice tone="danger" title={t('status.lastError')}>{status.lastError}</InlineNotice>}
    <div className="sync-layout">
      <div>
        <Section title={t('connection.title')} description={t('connection.description')}>
          <Input label={t('connection.serverUrl')} type="url" required value={config.serverUrl} placeholder="https://amrit.example.org" onChange={(event) => update('serverUrl', event.target.value)} />
          <FieldGrid columns={3}><Input label={t('connection.labCode')} value={currentLab.code} disabled hint={t('connection.labCodeHint')} /><Input label={t('connection.authToken')} type="password" autoComplete="off" value={config.authToken} placeholder={status.tokenConfigured ? t('connection.storedSecurely') : t('connection.optionalBootstrap')} onChange={(event) => update('authToken', event.target.value)} hint={t('connection.authTokenHint')} /><Input label={t('connection.siteToken')} type="password" autoComplete="off" value={config.siteToken} placeholder={config.siteToken ? t('connection.storedSecurely') : t('connection.optionalSite')} onChange={(event) => update('siteToken', event.target.value)} hint={t('connection.siteTokenHint')} /></FieldGrid>
          <FieldGrid columns={2}><Input label={t('connection.pollInterval')} type="number" min={2} max={3600} value={config.pollIntervalSeconds} onChange={(event) => update('pollIntervalSeconds', Number(event.target.value))} /><Input label={t('connection.pollTimeout')} type="number" min={5} max={300} value={config.pollTimeoutSeconds} onChange={(event) => update('pollTimeoutSeconds', Number(event.target.value))} /></FieldGrid>
          <Switch checked={config.verifyTls} onChange={(value) => update('verifyTls', value)} label={t('connection.verifyTls')} description={t('connection.verifyTlsDetail')} />
          <Switch checked={config.autoConfigureToken} onChange={(value) => update('autoConfigureToken', value)} label={t('connection.autoToken')} description={t('connection.autoTokenDetail')} />
          <div className="form-actions"><Button variant="secondary" disabled={Boolean(busy)} onClick={() => void save()}>{busy === 'save' ? t('connection.saving') : t('connection.saveSettings')}</Button><Button variant="secondary" disabled={Boolean(busy) || !config.serverUrl} onClick={() => void test()}><PlugZap size={16} />{busy === 'test' ? t('connection.testing') : t('connection.testConnection')}</Button><Button variant="secondary" disabled={Boolean(busy) || !config.serverUrl} onClick={() => void requestAccess()}><MailQuestion size={16} />{busy === 'request' ? t('connection.requesting') : t('connection.requestAccess')}</Button><Button variant="ghost" disabled={Boolean(busy) || !config.serverUrl} onClick={() => void configureToken()}><RefreshCw size={16} />{status.tokenConfigured ? t('connection.rotateToken') : t('connection.collectToken')}</Button></div>
          {accessRequest && <InlineNotice
            tone={accessRequest.status === 'failed' ? 'danger' : accessRequest.status === 'pending' ? 'warning' : 'success'}
            title={accessRequest.status === 'failed' ? t('connection.requestFailed') : accessRequest.status === 'pending' ? t('connection.awaitingApproval') : t('connection.alreadyRegistered')}>
            {accessRequest.detail}{accessRequest.status === 'pending' ? ` ${t('connection.awaitingApprovalNext')}` : ''}
          </InlineNotice>}
          {testResult && <InlineNotice tone={testResult.ok ? 'success' : 'danger'} title={testResult.ok ? t('connection.verified') : t('connection.failed')}>{testResult.message}</InlineNotice>}
        </Section>
        <Section title={t('allowlist.title')} description={t('allowlist.description')}><div className="query-allowlist">{QUERY_TYPES.map((type) => <label key={type}><input type="checkbox" checked={config.allowedQueryTypes.includes(type)} onChange={(event) => toggleQuery(type, event.target.checked)} /><span><strong>{t(`allowlist.${type}`)}</strong><small>{t(`allowlist.${type}Detail`)}</small></span></label>)}</div></Section>
      </div>
      <div>
        <Section title={t('privacy.title')} description={t('privacy.description')}><div className="privacy-contract"><div><CheckCircle2 size={18} /><span><strong>{t('privacy.aggregateTitle')}</strong><small>{t('privacy.aggregateBody')}</small></span></div><div><CheckCircle2 size={18} /><span><strong>{t('privacy.allowlistTitle')}</strong><small>{t('privacy.allowlistBody')}</small></span></div><div><CheckCircle2 size={18} /><span><strong>{t('privacy.criteriaTitle')}</strong><small>{t('privacy.criteriaBody')}</small></span></div><div><CheckCircle2 size={18} /><span><strong>{t('privacy.auditedTitle')}</strong><small>{t('privacy.auditedBody')}</small></span></div><div><LockKeyhole size={18} /><span><strong>{t('privacy.credentialsTitle')}</strong><small>{t('privacy.credentialsBody')}</small></span></div></div></Section>
        <Section title={t('location.title')} description={t('location.description')}>
          <Switch checked={config.gpsConsent} onChange={(value) => update('gpsConsent', value)} label={t('location.consent')} description={t('location.consentDetail')} />
          {config.gpsConsent && <>
            <div className="location-actions">
              <Button variant="secondary" disabled={locating} onClick={() => void detectLocation()}
                title={locationSupport && !locationSupport.supported ? locationSupport.detail : undefined}>
                <Crosshair size={16} /> {locating ? t('location.detecting') : t('location.detect')}
              </Button>
              {config.gpsLatitude !== undefined && config.gpsLongitude !== undefined &&
                <StatusPill label={config.gpsSource === 'device' ? t('location.sourceDevice') : t('location.sourceManual')} tone="neutral" />}
            </div>
            {!locationNotice && locationSupport && !locationSupport.supported &&
              <InlineNotice tone="info" title={t('location.notAvailableHere')}>{locationSupport.detail}</InlineNotice>}
            {locationNotice && <InlineNotice tone={locationNotice.tone} title={locationNotice.title}>
              {locationNotice.detail}
              {locationNotice.canOpenSettings && <> <Button variant="ghost" onClick={() => void openLocationSettings()}>{t('location.openSettings')}</Button></>}
            </InlineNotice>}
            <FieldGrid columns={2}>
              <Input label={t('location.latitude')} type="number" step="any" min={-90} max={90} value={config.gpsLatitude ?? ''}
                onChange={(event) => setCoordinate('gpsLatitude', event.target.value)} />
              <Input label={t('location.longitude')} type="number" step="any" min={-180} max={180} value={config.gpsLongitude ?? ''}
                onChange={(event) => setCoordinate('gpsLongitude', event.target.value)} />
            </FieldGrid>
            <p className="muted">{t('location.coordinatesOptional')}</p>
          </>}
          <div className="gps-note"><MapPin size={17} /><span>{t('location.note')}</span></div>
        </Section>
      </div>
    </div>
    <HelpDrawer open={help} title={t('title')} onClose={() => setHelp(false)}><p>{t('help.channels')}</p><h3>{t('help.tokenTitle')}</h3><p>{t('help.tokenBody')}</p><h3>{t('help.offlineTitle')}</h3><p>{t('help.offlineBody')}</p></HelpDrawer>
  </>
}
