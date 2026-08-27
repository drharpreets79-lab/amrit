import type React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ToastProvider } from '../src/renderer/components/Toast'
import { SyncPage } from '../src/renderer/pages/SyncPage'
import type { AMRITApi } from '../src/shared/api'
import type { Laboratory, SyncConfig, SyncStatus } from '../src/shared/types'

/**
 * Where a laboratory says it is.
 *
 * The coordinates place a site on the national map, so they are worth reading from the
 * computer rather than transcribing off a phone. But the operating system decides whether
 * to answer, and a laboratory that knows its own coordinates must never have to win a
 * permission dialog to enter them — so the two routes are tested together: the device fix,
 * and the hand-typed override that takes precedence over it.
 */
describe('SyncPage location', () => {
  const get = vi.fn<() => Promise<{ config: SyncConfig; status: SyncStatus }>>()
  const save = vi.fn<(config: SyncConfig) => Promise<SyncConfig>>()
  const openLocationSettings = vi.fn<() => Promise<{ opened: boolean; detail: string }>>()
  const locationSupport = vi.fn<() => Promise<{ platform: string; packaged: boolean; supported: boolean; detail: string }>>()
  const onStatus = vi.fn()

  const lab: Laboratory = { code: 'LAB01', name: 'Test laboratory' } as Laboratory
  const status: SyncStatus = { mode: 'off', websocket: 'off', lastError: '', tokenConfigured: false }
  const baseConfig: SyncConfig = {
    serverUrl: 'https://central.example.org', authToken: '', siteToken: '', pickupToken: '', labCode: 'LAB01',
    pollIntervalSeconds: 10, pollTimeoutSeconds: 30, verifyTls: true, autoConfigureToken: true,
    gpsConsent: true, allowedQueryTypes: ['isolate_count']
  }

  function grantPosition(latitude: number, longitude: number, accuracy = 12): void {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: (resolve: PositionCallback) =>
          resolve({ coords: { latitude, longitude, accuracy }, timestamp: Date.now() } as GeolocationPosition)
      }
    })
  }

  function refusePosition(code: number): void {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: (_resolve: PositionCallback, reject?: PositionErrorCallback) =>
          reject?.({ code, message: 'refused' } as GeolocationPositionError)
      }
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    get.mockResolvedValue({ config: baseConfig, status })
    save.mockImplementation(async (config) => config)
    openLocationSettings.mockResolvedValue({ opened: true, detail: 'Allow location for this application, then try again.' })
    locationSupport.mockResolvedValue({ platform: 'darwin', packaged: true, supported: true, detail: '' })
    const api = {
      sync: {
        get, save, openLocationSettings, locationSupport,
        start: vi.fn(), stop: vi.fn(), test: vi.fn(), configureToken: vi.fn(), requestAccess: vi.fn(),
        onStatus: vi.fn(() => () => undefined)
      }
    } as unknown as AMRITApi
    Object.defineProperty(window, 'amrit', { configurable: true, value: api })
  })

  const view = (): React.JSX.Element =>
    <ToastProvider><SyncPage currentLab={lab} initialStatus={status} onStatus={onStatus} /></ToastProvider>

  it('fills both coordinates from this computer and says where they came from', async () => {
    grantPosition(28.5672, 77.21)
    render(view())
    fireEvent.click(await screen.findByRole('button', { name: /use this computer’s location/i }))

    await waitFor(() => expect(screen.getByLabelText(/^Latitude/)).toHaveValue(28.5672))
    expect(screen.getByLabelText(/^Longitude/)).toHaveValue(77.21)
    expect(screen.getByText('From this computer', { selector: '.status-pill' })).toBeInTheDocument()
  })

  it('offers the operating system settings when location is refused, and keeps the fields typeable', async () => {
    refusePosition(1)
    render(view())
    fireEvent.click(await screen.findByRole('button', { name: /use this computer’s location/i }))

    await screen.findByText(/would not share its location/i)
    fireEvent.click(screen.getByRole('button', { name: /open location settings/i }))
    await waitFor(() => expect(openLocationSettings).toHaveBeenCalled())

    // Refusal is not a dead end: the coordinates can still be typed.
    const latitude = screen.getByLabelText(/^Latitude/)
    fireEvent.change(latitude, { target: { value: '19.0017' } })
    expect(latitude).toHaveValue(19.0017)
  })

  it('reports a position that could not be determined without blaming the operator', async () => {
    refusePosition(2)
    render(view())
    fireEvent.click(await screen.findByRole('button', { name: /use this computer’s location/i }))

    await screen.findByText(/location could not be read/i)
    expect(screen.queryByRole('button', { name: /open location settings/i })).not.toBeInTheDocument()
  })

  it('repeats what the computer said instead of calling it an unexpected error', async () => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: (_resolve: PositionCallback, reject?: PositionErrorCallback) =>
          // Chromium's own words when it has no provider to ask. A `GeolocationPositionError`
          // is not an `Error`, and the generic formatter used to swallow exactly this.
          reject?.({ code: 2, message: 'Network location provider at \'https://www.googleapis.com/\' : No response received.' } as GeolocationPositionError)
      }
    })
    render(view())
    fireEvent.click(await screen.findByRole('button', { name: /use this computer’s location/i }))

    await screen.findByText(/network location provider/i)
    expect(screen.queryByText(/unexpected error/i)).not.toBeInTheDocument()
  })

  it('says a development build cannot read Core Location before the button is pressed', async () => {
    locationSupport.mockResolvedValue({
      platform: 'darwin', packaged: false, supported: false,
      detail: 'This is a development build. macOS only reads a location for the packaged application.'
    })
    render(view())

    await screen.findByText(/not available here/i)
    expect(screen.getByText(/development build/i)).toBeInTheDocument()
    // The fields are still there, because typing the coordinates always works.
    expect(screen.getByLabelText(/^Latitude/)).toBeInTheDocument()
  })

  it('marks a hand-edited coordinate as entered by hand, not as a device fix', async () => {
    grantPosition(28.5672, 77.21)
    render(view())
    fireEvent.click(await screen.findByRole('button', { name: /use this computer’s location/i }))
    await waitFor(() => expect(screen.getByText('From this computer', { selector: '.status-pill' })).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText(/^Latitude/), { target: { value: '28.6' } })

    // The source travels with the heartbeat; reporting a corrected number as a device fix
    // would be a false claim about how it was obtained.
    expect(screen.getByText('Entered by hand', { selector: '.status-pill' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(save.mock.calls[0]![0]).toMatchObject({ gpsSource: 'manual', gpsLatitude: 28.6 })
  })

  it('says so when the build has no location service at all', async () => {
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: undefined })
    render(view())
    fireEvent.click(await screen.findByRole('button', { name: /use this computer’s location/i }))

    await screen.findByText(/no location service on this computer/i)
  })

  it('hides the whole location section until consent is given', async () => {
    get.mockResolvedValue({ config: { ...baseConfig, gpsConsent: false }, status })
    render(view())
    await screen.findByRole('heading', { name: /optional location sharing/i })
    expect(screen.queryByRole('button', { name: /use this computer’s location/i })).not.toBeInTheDocument()
  })
})
