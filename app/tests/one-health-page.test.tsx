import type React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ToastProvider } from '../src/renderer/components/Toast'
import { OneHealthPage } from '../src/renderer/pages/OneHealthPage'
import type { AMRITApi } from '../src/shared/api'
import type { OneHealthAuthStatus, Row } from '../src/shared/types'

const adminStatus: OneHealthAuthStatus = {
  needsBootstrap: false, authenticated: true,
  identity: { id: 'admin-1', username: 'admin', roles: ['administrator'] },
  expiresAt: '2026-08-11T12:00:00Z'
}

const environmentModule = {
  key: 'environment', title: 'Environmental AMR', domain: 'ENVIRONMENT', event_type: 'environment-amr-residue',
  purpose: 'regulatory', description: 'Environmental AMR and residue capture.',
  fields: [
    { key: 'facility_id', label: 'Facility / site ID', kind: 'choice', required: true, choices: ['LAB-1'] },
    { key: 'observed_at', label: 'Observation date/time', kind: 'datetime', required: true },
    { key: 'site_ref', label: 'Site surrogate ID', kind: 'text', required: true }
  ]
} as unknown as Row

describe('OneHealthPage governance workflow', () => {
  const authStatus = vi.fn<() => Promise<OneHealthAuthStatus>>()
  const bootstrapAdmin = vi.fn<(username: string, password: string) => Promise<OneHealthAuthStatus>>()
  const capture = vi.fn<(module: string, payload: Row) => Promise<Row>>()

  beforeEach(() => {
    vi.clearAllMocks()
    bootstrapAdmin.mockResolvedValue(adminStatus)
    capture.mockResolvedValue({ id: 'event-1', module_key: 'environment' })
    const api = {
      oneHealth: {
        authStatus,
        bootstrapAdmin,
        login: vi.fn(),
        logout: vi.fn(),
        users: vi.fn().mockResolvedValue([]),
        createUser: vi.fn(),
        modules: vi.fn().mockResolvedValue([environmentModule]),
        capture,
        records: vi.fn().mockResolvedValue([]),
        metrics: vi.fn().mockResolvedValue({ total: 0 }),
        enqueue: vi.fn(),
        export: vi.fn(),
        backup: vi.fn(),
        alerts: vi.fn().mockResolvedValue([]),
        reviewAlert: vi.fn(),
        actions: vi.fn().mockResolvedValue([]),
        createAction: vi.fn(),
        updateAction: vi.fn(),
        audit: vi.fn().mockResolvedValue([]),
        verifyAudit: vi.fn(),
        outbox: vi.fn().mockResolvedValue([])
      }
    } as unknown as AMRITApi
    Object.defineProperty(window, 'amrit', { configurable: true, value: api })
  })

  afterEach(() => cleanup())

  function view(): React.JSX.Element {
    return <ToastProvider><OneHealthPage currentLab={{ code: 'LAB-1', name: 'Test laboratory' }} /></ToastProvider>
  }

  it('requires explicit first-admin bootstrap and confirms the password', async () => {
    authStatus.mockResolvedValue({ needsBootstrap: true, authenticated: false, identity: null, expiresAt: null })
    render(view())
    expect(await screen.findByText('Configure the first administrator')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/^Username/), { target: { value: 'national-admin' } })
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: 'a sufficiently long password' } })
    fireEvent.change(screen.getByLabelText(/^Confirm password/), { target: { value: 'a sufficiently long password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create administrator' }))
    await waitFor(() => expect(bootstrapAdmin).toHaveBeenCalledWith('national-admin', 'a sufficiently long password'))
    expect(await screen.findByRole('tab', { name: /Environmental AMR/i })).toBeInTheDocument()
  })

  it('does not offer regulatory capture to a data-entry identity', async () => {
    authStatus.mockResolvedValue({
      needsBootstrap: false, authenticated: true,
      identity: { id: 'entry-1', username: 'entry', roles: ['data-entry'] }, expiresAt: '2026-08-11T12:00:00Z'
    })
    render(view())
    expect(await screen.findByText(/Direct-care and regulatory events require/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Capture event/i })).not.toBeInTheDocument()
  })

  it('uses dynamic module fields and sends no renderer-selected actor', async () => {
    authStatus.mockResolvedValue(adminStatus)
    render(view())
    fireEvent.click(await screen.findByRole('button', { name: /Capture event/i }))
    const dialog = screen.getByRole('dialog', { name: /Capture Environmental AMR event/i })
    fireEvent.change(within(dialog).getByLabelText(/^Site surrogate ID/), { target: { value: 'ENV-SITE-1' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /Validate and save/i }))
    await waitFor(() => expect(capture).toHaveBeenCalledTimes(1))
    expect(capture).toHaveBeenCalledWith('environment', expect.objectContaining({ facility_id: 'LAB-1', site_ref: 'ENV-SITE-1' }))
    expect(capture.mock.calls[0]?.[1]).not.toHaveProperty('actor')
  })
})
