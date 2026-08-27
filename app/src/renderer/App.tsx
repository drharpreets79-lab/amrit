import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { AppBootstrap, SyncStatus } from '../shared/types'
import { LocaleProvider } from './i18n/provider'
import { Shell, type RouteKey } from './components/Shell'
import { ErrorState, LoadingState } from './components/ui'
import { AIPage } from './pages/AIPage'
import { AnalyticsPage } from './pages/AnalyticsPage'
import { AuditPage } from './pages/AuditPage'
import { BreakpointsPage } from './pages/BreakpointsPage'
import { DashboardPage } from './pages/DashboardPage'
import { DeploymentPage } from './pages/DeploymentPage'
import { ExportsPage } from './pages/ExportsPage'
import { ImportPage } from './pages/ImportPage'
import { LaboratoriesPage } from './pages/LaboratoriesPage'
import { MasterStudioPage } from './pages/MasterStudioPage'
import { OneHealthPage } from './pages/OneHealthPage'
import { RecordsPage } from './pages/RecordsPage'
import { SyncPage } from './pages/SyncPage'

const ROUTES: RouteKey[] = ['dashboard', 'laboratories', 'records', 'imports', 'analytics', 'exports', 'masters', 'breakpoints', 'oneHealth', 'sync', 'ai', 'deployment', 'audit']
const initialRoute = (): RouteKey => { const value = window.location.hash.replace('#/', '') as RouteKey; return ROUTES.includes(value) ? value : 'dashboard' }

export default function App(): React.JSX.Element {
  const { t } = useTranslation('shell')
  const [bootstrap, setBootstrap] = useState<AppBootstrap | null>(null)
  const [route, setRouteState] = useState<RouteKey>(initialRoute)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [collapsed, setCollapsed] = useState(() => window.localStorage.getItem('amrit.sidebar.collapsed') === 'true')
  const [mobileOpen, setMobileOpen] = useState(false)
  const refresh = useCallback(async (): Promise<void> => {
    try { const next = await window.amrit.bootstrap(); setBootstrap(next); setError('') } catch (caught) { setError(caught instanceof Error ? caught.message : t('boot.startFailed')) } finally { setLoading(false) }
  }, [t])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    const hashListener = (): void => setRouteState(initialRoute())
    window.addEventListener('hashchange', hashListener)
    return () => window.removeEventListener('hashchange', hashListener)
  }, [])
  // The stylesheet's brand tokens are defaults; the profile is what the deployment actually
  // looks like. Applied here rather than at build time so a colour change on the settings
  // screen is visible without a restart.
  useEffect(() => {
    const colors = bootstrap?.countryProfile.branding?.colors
    if (!colors) return
    for (const [token, value] of Object.entries(colors)) {
      document.documentElement.style.setProperty(`--brand-${token}`, value)
    }
  }, [bootstrap?.countryProfile])
  useEffect(() => {
    document.title = bootstrap?.countryProfile.branding?.product_name || t('productFallback')
  }, [bootstrap?.countryProfile.branding?.product_name, t])
  const setRoute = (next: RouteKey): void => { setRouteState(next); window.history.replaceState(null, '', `#/${next}`); document.getElementById('main-content')?.scrollTo({ top: 0 }) }
  const setSidebar = (next: boolean): void => { setCollapsed(next); window.localStorage.setItem('amrit.sidebar.collapsed', String(next)) }
  const setSyncStatus = (status: SyncStatus): void => setBootstrap((current) => current ? { ...current, syncStatus: status } : current)
  // The boot screen renders before the country profile is known, so it carries no branding:
  // showing one deployment's emblem while another is resolving would be worse than showing none.
  if (loading) return <div className="boot-screen"><div className="boot-brand"><strong>{t('productFallback')}</strong><span>{t('taglineLong')}</span></div><LoadingState label={t('boot.opening')} /></div>
  if (!bootstrap || error) return <div className="boot-screen"><div className="boot-brand"><strong>{t('productFallback')}</strong></div><ErrorState message={error || t('boot.bootstrapInvalid')} onRetry={() => { setLoading(true); void refresh() }} /></div>
  const page = (() => {
    switch (route) {
      case 'laboratories': return <LaboratoriesPage laboratories={bootstrap.laboratories} currentLab={bootstrap.currentLab} countryProfile={bootstrap.countryProfile} onChanged={refresh} />
      case 'records': return <RecordsPage currentLab={bootstrap.currentLab} onChanged={refresh} />
      case 'imports': return <ImportPage currentLab={bootstrap.currentLab} onChanged={refresh} />
      case 'analytics': return <AnalyticsPage currentLab={bootstrap.currentLab} />
      case 'exports': return <ExportsPage currentLab={bootstrap.currentLab} />
      case 'masters': return <MasterStudioPage definitions={bootstrap.masterDefinitions} currentLab={bootstrap.currentLab} countryProfile={bootstrap.countryProfile} onChanged={refresh} />
      case 'breakpoints': return <BreakpointsPage onChanged={refresh} />
      case 'oneHealth': return <OneHealthPage currentLab={bootstrap.currentLab} />
      case 'sync': return <SyncPage currentLab={bootstrap.currentLab} initialStatus={bootstrap.syncStatus} onStatus={setSyncStatus} />
      case 'ai': return <AIPage />
      case 'deployment': return <DeploymentPage onChanged={refresh} />
      case 'audit': return <AuditPage />
      default: return <DashboardPage bootstrap={bootstrap} onRoute={setRoute} onRefresh={refresh} />
    }
  })()
  return <LocaleProvider profile={bootstrap.countryProfile}>
    <Shell route={route} onRoute={setRoute} laboratory={bootstrap.currentLab} syncStatus={bootstrap.syncStatus} countryProfile={bootstrap.countryProfile} collapsed={collapsed} onCollapsed={setSidebar} mobileOpen={mobileOpen} onMobileOpen={setMobileOpen}>
      {page}
      <footer className="app-footer">
        <span>{t('footer.version', { product: bootstrap.countryProfile.branding?.product_name ?? t('productFallback'), version: bootstrap.appVersion })}</span>
        <span>{t('footer.database')} <span className="path-text">{bootstrap.databasePath}</span></span>
        <span>{t('footer.disclaimer')}</span>
      </footer>
    </Shell>
  </LocaleProvider>
}
