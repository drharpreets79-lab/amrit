import type React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ToastProvider } from '../src/renderer/components/Toast'
import { SyncPage } from '../src/renderer/pages/SyncPage'
import type { AMRITApi } from '../src/shared/api'
import type { Laboratory, SyncConfig, SyncStatus } from '../src/shared/types'

const lab = { code: 'BUTTON-LAB-01', name: 'Button path lab' } as Laboratory
const off: SyncStatus = { mode: 'off', websocket: 'off', lastError: '', tokenConfigured: false }
const config: SyncConfig = {
  serverUrl: 'https://central.example.test', authToken: '', siteToken: '', pickupToken: '',
  labCode: 'stale-code', pollIntervalSeconds: 10, pollTimeoutSeconds: 30,
  verifyTls: true, autoConfigureToken: true, gpsConsent: false,
  allowedQueryTypes: ['isolate_count']
}

describe('SyncPage enrolment controls', () => {
  const requestAccess = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    requestAccess.mockResolvedValue({
      status: 'pending', detail: 'Awaiting administrator approval.', requestedAt: '2026-08-13T12:00:00Z'
    })
    const api = {
      sync: {
        get: vi.fn(async () => ({ config, status: off })),
        save: vi.fn(), start: vi.fn(), stop: vi.fn(), test: vi.fn(), configureToken: vi.fn(),
        requestAccess,
        onStatus: vi.fn(() => () => undefined)
      }
    } as unknown as AMRITApi
    Object.defineProperty(window, 'amrit', { configurable: true, value: api })
  })

  const view = (): React.JSX.Element => (
    <ToastProvider><SyncPage currentLab={lab} initialStatus={off} onStatus={vi.fn()} /></ToastProvider>
  )

  it('sends the active laboratory through Request access and shows the pending decision state', async () => {
    render(view())
    const button = await screen.findByRole('button', { name: /request access/i })
    await waitFor(() => expect(button).toBeEnabled())

    fireEvent.click(button)

    await waitFor(() => expect(requestAccess).toHaveBeenCalledWith(expect.objectContaining({
      serverUrl: 'https://central.example.test', labCode: 'BUTTON-LAB-01'
    })))
    expect((await screen.findAllByText(/Awaiting administrator approval/)).length).toBeGreaterThan(0)
    expect(screen.getByText(/Approval is checked automatically/)).toBeInTheDocument()
  })
})
