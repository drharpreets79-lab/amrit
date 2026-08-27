import type React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ToastProvider } from '../src/renderer/components/Toast'
import { formatError } from '../src/renderer/components/ui'
import { OneHealthPage } from '../src/renderer/pages/OneHealthPage'
import type { AMRITApi } from '../src/shared/api'
import type { Laboratory, OneHealthAuthStatus } from '../src/shared/types'

const lab: Laboratory = { code: 'HARP', name: 'Harpreet' }
const needsBootstrap: OneHealthAuthStatus = { needsBootstrap: true, authenticated: false, identity: null, expiresAt: null }

describe('formatError', () => {
  it('strips the Electron IPC wrapper and rewrites schema text', () => {
    expect(formatError(new Error("Error invoking remote method 'one-health:bootstrap-admin': Error: input: Too small: expected string to have >=12 characters")))
      .toBe('input must be at least 12 characters long.')
    expect(formatError(new Error("Error invoking remote method 'masters:list': Error: input: Invalid option: expected one of \"antibiotics\"")))
      .toBe('input is not one of the accepted values.')
    expect(formatError(new Error("Error invoking remote method 'panels:match': Error: locationType: Invalid input: expected string")))
      .toBe('locationType is required.')
  })

  it('leaves a message written for a person untouched', () => {
    expect(formatError(new Error('Panel 7 is used by 3 isolate record(s); deactivate it instead.')))
      .toBe('Panel 7 is used by 3 isolate record(s); deactivate it instead.')
    expect(formatError(undefined)).toBe('An unexpected error occurred.')
  })
})

describe('OneHealthPage first-administrator credentials', () => {
  const bootstrapAdmin = vi.fn<(username: string, password: string) => Promise<OneHealthAuthStatus>>()

  beforeEach(() => {
    vi.clearAllMocks()
    bootstrapAdmin.mockResolvedValue({ needsBootstrap: false, authenticated: true, identity: { id: '1', username: 'amrit.admin', roles: ['administrator'] }, expiresAt: null })
    const api = {
      oneHealth: {
        authStatus: vi.fn(async () => needsBootstrap),
        bootstrapAdmin,
        modules: vi.fn(async () => []),
        records: vi.fn(async () => []),
        alerts: vi.fn(async () => []),
        actions: vi.fn(async () => []),
        outbox: vi.fn(async () => []),
        audit: vi.fn(async () => []),
        users: vi.fn(async () => [])
      },
      masters: { list: vi.fn(async () => []) }
    } as unknown as AMRITApi
    Object.defineProperty(window, 'amrit', { configurable: true, value: api })
  })

  function view(): React.JSX.Element {
    return <ToastProvider><OneHealthPage currentLab={lab} /></ToastProvider>
  }

  const type = (label: RegExp, value: string): void => {
    fireEvent.change(screen.getByLabelText(label), { target: { value } })
  }

  it('states the length rule and counts characters before anything is submitted', async () => {
    render(view())
    await screen.findByRole('button', { name: /Create administrator/ })

    expect(screen.getByText(/Minimum 12 characters — 0 entered/)).toBeInTheDocument()
    type(/^Password/, 'short')
    // The field swaps its hint for a live count once the value is too short.
    expect(await screen.findByText('5 of 12 characters')).toBeInTheDocument()
  })

  it('refuses a short password locally instead of surfacing a schema rejection', async () => {
    render(view())
    await screen.findByRole('button', { name: /Create administrator/ })

    type(/^Username/, 'amrit.admin')
    type(/^Password/, 'short-pass')
    type(/Confirm password/, 'short-pass')
    fireEvent.click(screen.getByRole('button', { name: /Create administrator/ }))

    expect(await screen.findByText(/at least 12 characters; this one has 10/)).toBeInTheDocument()
    expect(bootstrapAdmin).not.toHaveBeenCalled()
  })

  it('rejects a username the main process would reject, naming the rule', async () => {
    render(view())
    await screen.findByRole('button', { name: /Create administrator/ })

    type(/^Username/, 'ad min!')
    type(/^Password/, 'a-long-enough-password')
    type(/Confirm password/, 'a-long-enough-password')
    fireEvent.click(screen.getByRole('button', { name: /Create administrator/ }))

    expect(await screen.findByText('Check the username')).toBeInTheDocument()
    expect(bootstrapAdmin).not.toHaveBeenCalled()
  })

  it('submits a trimmed username once both rules pass', async () => {
    render(view())
    await screen.findByRole('button', { name: /Create administrator/ })

    type(/^Username/, '  amrit.admin  ')
    type(/^Password/, 'a-long-enough-password')
    type(/Confirm password/, 'a-long-enough-password')
    fireEvent.click(screen.getByRole('button', { name: /Create administrator/ }))

    await waitFor(() => expect(bootstrapAdmin).toHaveBeenCalledWith('amrit.admin', 'a-long-enough-password'))
  })
})
