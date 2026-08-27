import type React from 'react'
import type { ComponentType, ReactNode } from 'react'
import {
  Activity, BarChart3, Bot, Building2, ClipboardList, Database, FileInput, FileOutput,
  FlaskConical, Globe2, HeartPulse, Menu, PanelLeftClose, PanelLeftOpen, RadioTower,
  ScrollText, Settings2, ShieldCheck, TestTubes, X
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { logoSource } from '../../shared/deployment'
import type { CountryProfile, Laboratory, SyncStatus } from '../../shared/types'
import { IconButton, StatusPill, cx } from './ui'

export type RouteKey = 'dashboard' | 'laboratories' | 'records' | 'imports' | 'analytics' | 'exports' | 'masters' | 'breakpoints' | 'oneHealth' | 'sync' | 'ai' | 'audit' | 'deployment'

/** Labels are catalogue keys, not text: the navigation is the first thing a translator sees. */
type NavGroup = 'Workspace' | 'Surveillance' | 'Configuration' | 'Governance'
interface NavItem { key: RouteKey; icon: ComponentType<{ size?: number; strokeWidth?: number }>; group: NavGroup }

const NAV_ITEMS: NavItem[] = [
  { key: 'dashboard', icon: Activity, group: 'Workspace' },
  { key: 'laboratories', icon: Building2, group: 'Workspace' },
  { key: 'records', icon: ClipboardList, group: 'Surveillance' },
  { key: 'imports', icon: FileInput, group: 'Surveillance' },
  { key: 'analytics', icon: BarChart3, group: 'Surveillance' },
  { key: 'exports', icon: FileOutput, group: 'Surveillance' },
  { key: 'oneHealth', icon: HeartPulse, group: 'Surveillance' },
  { key: 'masters', icon: Database, group: 'Configuration' },
  { key: 'breakpoints', icon: TestTubes, group: 'Configuration' },
  { key: 'sync', icon: RadioTower, group: 'Configuration' },
  { key: 'ai', icon: Bot, group: 'Configuration' },
  { key: 'deployment', icon: Globe2, group: 'Governance' },
  { key: 'audit', icon: ScrollText, group: 'Governance' }
]

export function Shell({ route, onRoute, laboratory, syncStatus, countryProfile, collapsed, onCollapsed, mobileOpen, onMobileOpen, children }: {
  route: RouteKey
  onRoute: (route: RouteKey) => void
  laboratory: Laboratory | null
  syncStatus: SyncStatus
  countryProfile: CountryProfile
  collapsed: boolean
  onCollapsed: (collapsed: boolean) => void
  mobileOpen: boolean
  onMobileOpen: (open: boolean) => void
  children: ReactNode
}): React.JSX.Element {
  const { t } = useTranslation('shell')
  const groups = [...new Set(NAV_ITEMS.map((item) => item.group))]
  const branding = countryProfile.branding
  const authority = branding?.authority_name ?? countryProfile.country_name
  // The sidebar is dark. A deployment that supplied a reversed mark gets it placed straight
  // on the navy, which is what "matched to the background" means; one that did not keeps the
  // light plate, because a dark-on-transparent emblem on navy is invisible.
  const reverseLogo = logoSource(branding?.logo_reverse)
  const logo = reverseLogo ?? logoSource(branding?.logo)
  const syncTone = syncStatus.websocket === 'connected' || syncStatus.mode === 'idle' || syncStatus.mode === 'processing' ? 'green' : syncStatus.mode === 'error' || syncStatus.websocket === 'error' ? 'red' : 'neutral'
  return (
    <div className={cx('app-shell', collapsed && 'app-shell--collapsed', mobileOpen && 'app-shell--mobile-open')}>
      {mobileOpen && <button className="mobile-scrim" aria-label={t('closeNavigation')} onClick={() => onMobileOpen(false)} />}
      <aside className="sidebar" aria-label={t('primaryNavigation')}>
        <div className="brand-lockup">
          {logo && <div className={cx('brand-logo-frame', reverseLogo && 'brand-logo-frame--reverse')}><img src={logo} alt={authority} /></div>}
          {!collapsed && <div className="brand-copy"><strong>{branding?.product_name ?? t('productFallback')}</strong><span>{t('tagline')}</span></div>}
          <IconButton label={t('closeNavigation')} className="sidebar__mobile-close" onClick={() => onMobileOpen(false)}><X size={20} /></IconButton>
        </div>
        <nav className="nav-list">
          {groups.map((group) => <div className="nav-group" key={group}>
            {!collapsed && <span className="nav-group__label">{t(`groups.${group}`)}</span>}
            {NAV_ITEMS.filter((item) => item.group === group).map((item) => {
              const Icon = item.icon
              const label = t(`nav.${item.key}`)
              return <button key={item.key} className={cx('nav-item', route === item.key && 'nav-item--active')} aria-current={route === item.key ? 'page' : undefined} title={collapsed ? label : undefined} onClick={() => { onRoute(item.key); onMobileOpen(false) }}><Icon size={19} strokeWidth={1.9} /><span>{label}</span></button>
            })}
          </div>)}
        </nav>
        <div className="sidebar__footer">
          {!collapsed && <div className="privacy-stamp"><ShieldCheck size={17} /><span><strong>{t('localFirst')}</strong><small>{t('aggregateOnlySync')}</small></span></div>}
          <IconButton label={collapsed ? t('expandNavigation') : t('collapseNavigation')} className="collapse-control" onClick={() => onCollapsed(!collapsed)}>{collapsed ? <PanelLeftOpen size={19} /> : <PanelLeftClose size={19} />}</IconButton>
        </div>
      </aside>
      <div className="app-stage">
        <header className="topbar">
          <div className="topbar__left"><IconButton label={t('openNavigation')} className="topbar__menu" onClick={() => onMobileOpen(true)}><Menu size={21} /></IconButton><div className="lab-context"><FlaskConical size={18} /><span><small>{t('activeLaboratory')}</small><strong>{laboratory ? `${laboratory.name} · ${laboratory.code}` : t('notSelected')}</strong></span></div></div>
          <div className="topbar__right"><StatusPill label={syncStatus.websocket === 'connected' ? t('websocketConnected') : syncStatus.mode === 'off' ? t('syncOffline') : syncStatus.mode} tone={syncTone} pulse={syncStatus.mode === 'processing'} /><button className="topbar__settings" onClick={() => onRoute('sync')}><Settings2 size={18} /><span>{t('settings')}</span></button></div>
        </header>
        <main className="content" id="main-content">{children}</main>
      </div>
    </div>
  )
}
